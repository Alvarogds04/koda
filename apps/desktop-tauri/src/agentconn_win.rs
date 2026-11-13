//! #306 (Windows, W1) — the connection half of the island-agent client over a
//! NAMED PIPE. Same contract as `agentconn.rs` (keep in sync), different gate:
//!
//! * `session.json` lives under `%LOCALAPPDATA%\Koda\runtime` (or an
//!   `KODA_ISLAND_DIR` override INSIDE that canonical protected root); before
//!   reading it the island root, the runtime directory AND THE FILE ITSELF are
//!   verified by owner and DACL — the file must be strictly owner-only (as the
//!   native `abito-private-session` helper writes it), bounded and a plain
//!   non-reparse regular file — node cannot set ACLs, so we check them.
//! * Squat guard: before the token is sent, `GetNamedPipeServerProcessId` must equal
//!   the pid recorded in `session.json` AND that process must run as OUR user.
//! * Reads never block inside `ReadFile` (they poll `PeekNamedPipe`): a synchronous
//!   pipe handle serialises ReadFile and WriteFile, so a blocked read would deadlock
//!   every command write.
//! Everything fails closed.
use crate::agentclient::{parse_ui_command, ClientState, CommandError, FrameBuffer, Reason, Session, UiCommand};
use crate::chatclient::{ChatCommand, ChatState, CommandError as ChatCommandError};
use crate::winpolicy;
use serde_json::Value;
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, PeekNamedPipe};

const HELLO_WAIT: Duration = Duration::from_secs(3);

/// K2-13 (S20): the ONE `telegram_session` reply of this connection, handed to the host on the reader thread BEFORE the
/// new view is published so it reaches the OS keychain first (keep in sync with `agentconn.rs`, the unix twin).
pub type SessionSink = Arc<dyn Fn(&str) + Send + Sync>;
const POLL: Duration = Duration::from_millis(10);
/// Windows FILE_ATTRIBUTE_REPARSE_POINT: any name surrogate (symlink,
/// junction, mount point) is never a plain session file.
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
/// Bounded session file, parity with the daemon's own 4096-byte reader.
const MAX_SESSION_FILE: u64 = 4096;

/// The reader's exit guard, shared shape for both connections (keep in sync with the
/// unix `agentconn.rs`): a reader may wipe the writer and report the loss only when
/// its OWN flag is still false AND its connection epoch is still the current one — an
/// old reader can then never touch a newer connection.
fn reader_may_finalize(stop: &AtomicBool, epochs: &AtomicU64, epoch: u64) -> bool {
    !stop.load(Ordering::SeqCst) && epochs.load(Ordering::SeqCst) == epoch
}

pub struct AgentConn {
    state: Arc<Mutex<ClientState>>,
    writer: Arc<Mutex<Option<Arc<Pipe>>>>,
    /// The CURRENT connection's stop flag, replaced on every connect. A reader keeps
    /// its own clone, which is never reset — a reconnect's new flag can never revive
    /// an old reader.
    stop: Mutex<Arc<AtomicBool>>,
    /// Monotone connection generation: an old reader whose epoch is no longer current
    /// may never touch the writer or the state of a newer connection.
    epoch: Arc<AtomicU64>,
    changed: Arc<dyn Fn(Value) + Send + Sync>,
    /// K2-13 (S20): where a `telegram_session` reply goes (the keychain, through the host).
    session_sink: SessionSink,
}

/// `<island>/runtime/session.json` for the configured island root.
pub fn session_path(island_root: &Path) -> PathBuf {
    island_root.join("runtime").join("session.json")
}

/// Island root: an `KODA_ISLAND_DIR` override INSIDE the canonical protected
/// `%LOCALAPPDATA%\Koda` root, or that root itself (`winpolicy::island_root`).
/// `home` is unused here.
pub fn island_root(env_dir: Option<&str>, _home: Option<&str>) -> Option<PathBuf> {
    winpolicy::island_root(env_dir, std::env::var("LOCALAPPDATA").ok().as_deref())
}

// ---- tokens / SIDs / ACL verdicts: REUSED from `winipc::ffi` (T2) -----------

use crate::winipc::ffi::{current_user_sid, directory_private, process_alive, process_user_sid};

// ---- the pipe ------------------------------------------------------------------------

/// A connected pipe client. Reads poll `PeekNamedPipe`, writes are plain `WriteFile`.
struct Pipe { file: File, closed: AtomicBool }
impl Pipe {
    fn handle(&self) -> HANDLE { self.file.as_raw_handle() as HANDLE }
    /// Bytes available, `Ok(None)` when the peer is gone.
    fn available(&self) -> Option<u32> {
        let mut avail = 0u32;
        let ok = unsafe { PeekNamedPipe(self.handle(), std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut avail, std::ptr::null_mut()) };
        (ok != 0).then_some(avail)
    }
    /// 0 = EOF, `TimedOut` after `wait`. Never blocks in ReadFile.
    fn read_timeout(&self, out: &mut [u8], wait: Duration) -> std::io::Result<usize> {
        let end = Instant::now() + wait;
        loop {
            if self.closed.load(Ordering::SeqCst) { return Ok(0) }
            match self.available() {
                None => return Ok(0),
                Some(n) if n > 0 => return (&self.file).read(out),
                Some(_) if Instant::now() >= end => return Err(std::io::ErrorKind::TimedOut.into()),
                Some(_) => std::thread::sleep(POLL),
            }
        }
    }
    fn write_all(&self, bytes: &[u8]) -> std::io::Result<()> { (&self.file).write_all(bytes) }
    fn close(&self) { self.closed.store(true, Ordering::SeqCst) }
}

/// Open the daemon pipe and prove who is on the other end BEFORE any byte (the token) is sent.
fn connect_verified(session: &Session) -> Result<Pipe, Reason> {
    let file = std::fs::OpenOptions::new().read(true).write(true).open(&session.endpoint).map_err(|_| Reason::NoDaemon)?;
    let mut server = 0u32;
    if unsafe { GetNamedPipeServerProcessId(file.as_raw_handle() as HANDLE, &mut server) } == 0 || server != session.pid {
        return Err(Reason::Refused);
    }
    let (mine, theirs) = (current_user_sid().ok_or(Reason::Refused)?, process_user_sid(server).ok_or(Reason::Refused)?);
    if mine != theirs { return Err(Reason::Refused) }
    Ok(Pipe { file, closed: AtomicBool::new(false) })
}

/// The session file must be a bounded regular non-reparse file with an
/// EXPLICIT owner-only DACL of its own (as the native session helper writes
/// it), inside a private runtime directory and island root, and the recorded
/// daemon must be alive. Wider ACLs on our own file are refused, never trusted.
fn read_session(path: &Path) -> Result<Session, Reason> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| Reason::NoDaemon)?;
    // symlink_metadata: is_file() is false for symlinks, so links never pass.
    if !meta.file_type().is_file() { return Err(Reason::BadSession) }
    if meta.len() > MAX_SESSION_FILE { return Err(Reason::BadSession) }
    {
        use std::os::windows::fs::MetadataExt as _;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(Reason::BadSession);
        }
    }
    let me = current_user_sid().ok_or(Reason::BadSession)?;
    let runtime = path.parent().ok_or(Reason::BadSession)?;
    let root = runtime.parent().ok_or(Reason::BadSession)?;
    // Island root and runtime directory: private (owner, SYSTEM, Administrators).
    if !directory_private(runtime, &me, false) || !directory_private(root, &me, false) {
        return Err(Reason::BadSession);
    }
    // The file itself: strictly owner-only (owner + no other ACE at all).
    if !directory_private(path, &me, true) {
        return Err(Reason::BadSession);
    }
    let text = std::fs::read_to_string(path).map_err(|_| Reason::BadSession)?;
    let session = Session::parse(&text).map_err(|_| Reason::BadSession)?;
    if !process_alive(session.pid) { return Err(Reason::NoDaemon) }
    Ok(session)
}

/// Read-only native status proof for the already-shipped session helper.
/// Uses the same ACL, live-pid and server-pid/SID gates as the island BEFORE
/// sending a token. Sends only hello; no refresh/commands, cleanup or writes.
pub fn verify_session(island_root: &Path) -> Result<(), Reason> {
    let session = read_session(&session_path(island_root))?;
    let pipe = connect_verified(&session)?;
    pipe.write_all(session.hello().as_bytes()).map_err(|_| Reason::Refused)?;
    let mut buffer = FrameBuffer::default();
    let mut chunk = [0u8; 4096];
    let deadline = Instant::now() + HELLO_WAIT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let n = pipe.read_timeout(&mut chunk, remaining).map_err(|_| Reason::Refused)?;
        if n == 0 { return Err(Reason::Refused); }
        let frames = buffer.push(&chunk[..n]).map_err(|_| Reason::Refused)?;
        if let Some(first) = frames.first() {
            return if first.get("type").and_then(Value::as_str) == Some("ready") {
                Ok(())
            } else { Err(Reason::Refused) };
        }
        if Instant::now() >= deadline { return Err(Reason::Refused); }
    }
}

impl AgentConn {
    pub fn new(changed: impl Fn(Value) + Send + Sync + 'static) -> AgentConn {
        AgentConn {
            state: Arc::new(Mutex::new(ClientState::disconnected(Reason::NoDaemon))),
            writer: Arc::new(Mutex::new(None)),
            stop: Mutex::new(Arc::new(AtomicBool::new(false))),
            epoch: Arc::new(AtomicU64::new(0)),
            changed: Arc::new(changed),
            session_sink: Arc::new(|_: &str| {}),
        }
    }

    pub fn startup_failed(&self, reason: crate::daemonhost::StartupFailure) {
        let mut state = ClientState::disconnected(Reason::NoDaemon);
        state.note_startup_failure(reason);
        self.set(state);
    }

    pub fn view(&self) -> Value {
        serde_json::to_value(&*self.state.lock().expect("agent state lock")).unwrap_or(Value::Null)
    }

    fn set(&self, s: ClientState) {
        let view = serde_json::to_value(&s).unwrap_or(Value::Null);
        *self.state.lock().expect("agent state lock") = s;
        (self.changed)(view);
    }

    pub fn connect(&self, island_root: &Path) {
        self.close();
        let session = match read_session(&session_path(island_root)) {
            Ok(s) => s,
            Err(reason) => return self.set(ClientState::disconnected(reason)),
        };
        let pipe = match connect_verified(&session) {
            Ok(p) => Arc::new(p),
            Err(reason) => return self.set(ClientState::disconnected(reason)),
        };
        if pipe.write_all(session.hello().as_bytes()).is_err() {
            crate::failure::report("island", "agent-refused", crate::failure::Reason::AgentRefused, None);
            return self.set(ClientState::disconnected(Reason::Refused));
        }
        // Same handshake discipline as the unix `agentconn.rs` (keep in sync): the burst
        // after `ready` reaches the fold, oversized/malformed lines are skipped, and only
        // a handshake whose FIRST frame is not `ready` is refused.
        let mut buf = FrameBuffer::default();
        let mut chunk = [0u8; 4096];
        let deadline = Instant::now() + HELLO_WAIT;
        let after_ready: Vec<Value>;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match pipe.read_timeout(&mut chunk, left) {
                Ok(0) | Err(_) => {
                    crate::failure::report("island", "agent-no-answer", crate::failure::Reason::AgentNoAnswer, None);
                    return self.set(ClientState::disconnected(Reason::Refused));
                }
                Ok(n) => {
                    let (frames, _skipped) = buf.push_lenient(&chunk[..n]);
                    if frames.is_empty() {
                        if Instant::now() >= deadline {
                            crate::failure::report("island", "agent-no-answer", crate::failure::Reason::AgentNoAnswer, None);
                            return self.set(ClientState::disconnected(Reason::Refused));
                        }
                        continue;
                    }
                    if frames[0].get("type").and_then(Value::as_str) != Some("ready") {
                        return self.set(ClientState::disconnected(Reason::Refused));
                    }
                    after_ready = frames;
                    // the `ready` frame itself folds too (its carried state): apply ignores it where there is nothing to fold
                    break;
                }
            }
        }
        let stop = Arc::new(AtomicBool::new(false));
        *self.stop.lock().expect("agent stop lock") = stop.clone();
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        *self.writer.lock().expect("agent writer lock") = Some(pipe.clone());
        self.set(ClientState::connected());
        self.spawn_reader(pipe, buf, after_ready, stop, self.epoch.clone(), epoch);
        let _ = self.send(&UiCommand::Refresh);
    }

    fn spawn_reader(&self, reader: Arc<Pipe>, mut buf: FrameBuffer, pending: Vec<Value>, stop: Arc<AtomicBool>, epochs: Arc<AtomicU64>, epoch: u64) {
        let (state, changed, writer, sink) = (self.state.clone(), self.changed.clone(), self.writer.clone(), self.session_sink.clone());
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            // the handshake burst: frames that arrived in the same read as `ready`
            if !pending.is_empty() {
                let (emit, session) = {
                    let mut st = state.lock().expect("agent state lock");
                    let before = serde_json::to_value(&*st).unwrap_or(Value::Null);
                    for f in &pending {
                        let _ = st.apply(f);
                    }
                    let after = serde_json::to_value(&*st).unwrap_or(Value::Null);
                    ((before != after).then_some(after), st.take_session())
                };
                if let Some(session) = session {
                    sink(&session);
                }
                if let Some(view) = emit {
                    changed(view);
                }
            }
            loop {
                if stop.load(Ordering::SeqCst) { return }
                match reader.read_timeout(&mut chunk, Duration::from_millis(500)) {
                    Ok(0) => break,
                    Ok(n) => {
                        let (frames, skipped) = buf.push_lenient(&chunk[..n]);
                        if skipped > 0 {
                            // one log line per noisy read, never per byte: oversized and
                            // malformed lines were skipped, the connection stays up
                            crate::failure::report("island", "agent-frame-skipped", crate::failure::Reason::Manual, None);
                        }
                        if frames.is_empty() {
                            continue;
                        }
                        // emit the view only when at least one complete frame CHANGED the
                        // state — bursts coalesce into one emission, idle reads into none
                        let (emit, session) = {
                            let mut st = state.lock().expect("agent state lock");
                            let before = serde_json::to_value(&*st).unwrap_or(Value::Null);
                            for f in &frames {
                                let _ = st.apply(f);
                            }
                            let after = serde_json::to_value(&*st).unwrap_or(Value::Null);
                            ((before != after).then_some(after), st.take_session())
                        };
                        if let Some(session) = session {
                            sink(&session);
                        }
                        if let Some(view) = emit {
                            changed(view);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                    Err(_) => break,
                }
            }
            if reader_may_finalize(&stop, &epochs, epoch) {
                *writer.lock().expect("agent writer lock") = None;
                crate::failure::report("island", "agent-lost", crate::failure::Reason::AgentLost, None);
                let lost = ClientState::disconnected(Reason::Lost);
                let view = serde_json::to_value(&lost).unwrap_or(Value::Null);
                *state.lock().expect("agent state lock") = lost;
                changed(view);
            }
        });
    }

    pub fn send(&self, cmd: &UiCommand) -> Result<(), CommandError> {
        let lines = match cmd {
            UiCommand::Refresh => cmd.refresh_lines(),
            UiCommand::View => return Ok(()),
            UiCommand::Account(_) => return Err(CommandError),
            other => vec![other.line()],
        };
        let guard = self.writer.lock().expect("agent writer lock");
        let pipe = guard.as_ref().ok_or(CommandError)?;
        for line in lines {
            if pipe.write_all(line.as_bytes()).is_err() { return Err(CommandError) }
        }
        Ok(())
    }

    pub fn command(&self, payload: &Value) -> Result<Value, CommandError> {
        let cmd = parse_ui_command(payload)?;
        if matches!(cmd, UiCommand::View) { return Ok(self.view()) }
        self.send(&cmd)?;
        Ok(self.view())
    }

    pub fn close(&self) {
        self.stop.lock().expect("agent stop lock").store(true, Ordering::SeqCst);
        if let Some(p) = self.writer.lock().expect("agent writer lock").take() { p.close(); }
    }
}

impl Drop for AgentConn {
    fn drop(&mut self) { self.close(); }
}

// ---- K2-05 T4 U2: the SECOND connection (the chat) --------------------------------

/// The island's chat connection over the named pipe: a SECOND connection to the
/// same daemon (the settings window keeps its own through `AgentConn`; the daemon
/// allows 2 clients, PROTOCOL.md). Same contract as the unix `agentconn.rs`
/// `ChatConn` (keep in sync), folding frames into [`ChatState`] through its OWN
/// callback and sending only the closed chat command set ([`ChatCommand`],
/// window-gated at parse time).
pub struct ChatConn {
    state: Arc<Mutex<ChatState>>,
    writer: Arc<Mutex<Option<Arc<Pipe>>>>,
    /// The CURRENT connection's stop flag, replaced on every connect: an old reader
    /// keeps its own flag, which is never reset. Same contract as the unix `agentconn.rs`.
    stop: Mutex<Arc<AtomicBool>>,
    /// Monotone connection generation: an old reader can never touch a newer connection.
    epoch: Arc<AtomicU64>,
    changed: Arc<dyn Fn(Value) + Send + Sync>,
}

impl ChatConn {
    pub fn new(changed: impl Fn(Value) + Send + Sync + 'static) -> ChatConn {
        ChatConn {
            state: Arc::new(Mutex::new(ChatState::disconnected(Reason::NoDaemon))),
            writer: Arc::new(Mutex::new(None)),
            stop: Mutex::new(Arc::new(AtomicBool::new(false))),
            epoch: Arc::new(AtomicU64::new(0)),
            changed: Arc::new(changed),
        }
    }

    pub fn view(&self) -> Value {
        serde_json::to_value(&*self.state.lock().expect("chat state lock")).unwrap_or(Value::Null)
    }

    fn set(&self, s: ChatState) {
        let view = serde_json::to_value(&s).unwrap_or(Value::Null);
        *self.state.lock().expect("chat state lock") = s;
        (self.changed)(view);
    }

    /// (Re)connect from the session file: the same verified session.json / pipe
    /// / server-pid-and-SID gates as `AgentConn::connect`, then the handshake.
    /// Same handshake discipline as the unix `agentconn.rs` (keep in sync): the
    /// burst after `ready` reaches the fold, oversized/malformed lines are skipped.
    pub fn connect(&self, island_root: &Path) {
        self.close();
        let session = match read_session(&session_path(island_root)) {
            Ok(s) => s,
            Err(reason) => return self.set(ChatState::disconnected(reason)),
        };
        let pipe = match connect_verified(&session) {
            Ok(p) => Arc::new(p),
            Err(reason) => return self.set(ChatState::disconnected(reason)),
        };
        if pipe.write_all(session.hello().as_bytes()).is_err() {
            crate::failure::report("island", "agent-refused", crate::failure::Reason::AgentRefused, None);
            return self.set(ChatState::disconnected(Reason::Refused));
        }
        let mut buf = FrameBuffer::default();
        let mut chunk = [0u8; 4096];
        let deadline = Instant::now() + HELLO_WAIT;
        let after_ready: Vec<Value>;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match pipe.read_timeout(&mut chunk, left) {
                Ok(0) | Err(_) => {
                    crate::failure::report("island", "agent-no-answer", crate::failure::Reason::AgentNoAnswer, None);
                    return self.set(ChatState::disconnected(Reason::Refused));
                }
                Ok(n) => {
                    let (frames, _skipped) = buf.push_lenient(&chunk[..n]);
                    if frames.is_empty() {
                        if Instant::now() >= deadline {
                            crate::failure::report("island", "agent-no-answer", crate::failure::Reason::AgentNoAnswer, None);
                            return self.set(ChatState::disconnected(Reason::Refused));
                        }
                        continue;
                    }
                    if frames[0].get("type").and_then(Value::as_str) != Some("ready") {
                        return self.set(ChatState::disconnected(Reason::Refused));
                    }
                    after_ready = frames;
                    // the `ready` frame itself folds too (its carried state): apply ignores it where there is nothing to fold
                    break;
                }
            }
        }
        let stop = Arc::new(AtomicBool::new(false));
        *self.stop.lock().expect("chat stop lock") = stop.clone();
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        *self.writer.lock().expect("chat writer lock") = Some(pipe.clone());
        self.set(ChatState::connected());
        self.spawn_reader(pipe, buf, after_ready, stop, self.epoch.clone(), epoch);
        // the late client asks for the newest history page and the agent status once
        // it has handshook (the `ready` state may already be stale)
        let _ = self.send_line(&ChatCommand::History.line());
        let _ = self.send_line(&ChatCommand::Status.line());
    }

    fn spawn_reader(&self, reader: Arc<Pipe>, mut buf: FrameBuffer, pending: Vec<Value>, stop: Arc<AtomicBool>, epochs: Arc<AtomicU64>, epoch: u64) {
        let (state, changed, writer) = (self.state.clone(), self.changed.clone(), self.writer.clone());
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            // the handshake burst: frames that arrived in the same read as `ready`
            if !pending.is_empty() {
                // L3 (U2 re-verify): the fold bumps `ChatState::revision` only when the view
                // changed, so the emit decision is one integer comparison — the whole chat
                // state is serialized at most once per read, never twice. Keep in sync with
                // the unix `agentconn.rs`.
                let emit = {
                    let mut st = state.lock().expect("chat state lock");
                    let before = st.revision();
                    for f in &pending {
                        st.apply(f);
                    }
                    (st.revision() != before).then(|| serde_json::to_value(&*st).unwrap_or(Value::Null))
                };
                if let Some(view) = emit {
                    changed(view);
                }
            }
            loop {
                if stop.load(Ordering::SeqCst) { return }
                match reader.read_timeout(&mut chunk, Duration::from_millis(500)) {
                    Ok(0) => break,
                    Ok(n) => {
                        let (frames, skipped) = buf.push_lenient(&chunk[..n]);
                        if skipped > 0 {
                            // one log line per noisy read, never per byte: oversized and
                            // malformed lines were skipped, the connection stays up
                            crate::failure::report("island", "agent-frame-skipped", crate::failure::Reason::Manual, None);
                        }
                        if frames.is_empty() {
                            continue;
                        }
                        // emit the view only when at least one complete frame CHANGED the
                        // state — bursts coalesce into one emission, idle reads into none.
                        // L3 (U2 re-verify): the change signal is `ChatState::revision`,
                        // bumped by every fold that changes the view; the whole state is
                        // serialized at most ONCE per read, only on an actual change. Keep
                        // in sync with the unix `agentconn.rs`.
                        let emit = {
                            let mut st = state.lock().expect("chat state lock");
                            let before = st.revision();
                            for f in &frames {
                                st.apply(f);
                            }
                            (st.revision() != before).then(|| serde_json::to_value(&*st).unwrap_or(Value::Null))
                        };
                        if let Some(view) = emit {
                            changed(view);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                    Err(_) => break,
                }
            }
            if reader_may_finalize(&stop, &epochs, epoch) {
                *writer.lock().expect("chat writer lock") = None;
                crate::failure::report("island", "agent-lost", crate::failure::Reason::AgentLost, None);
                let lost = ChatState::disconnected(Reason::Lost);
                let view = serde_json::to_value(&lost).unwrap_or(Value::Null);
                *state.lock().expect("chat state lock") = lost;
                changed(view);
            }
        });
    }

    fn send_line(&self, line: &str) -> Result<(), ChatCommandError> {
        let guard = self.writer.lock().expect("chat writer lock");
        let pipe = guard.as_ref().ok_or(ChatCommandError)?;
        pipe.write_all(line.as_bytes()).map_err(|_| ChatCommandError)
    }

    /// Parse one chat command for the given caller window (the gate lives in the
    /// parser: only the exact main island window may chat) and send its wire line.
    pub fn command(&self, caller: &str, payload: &Value) -> Result<Value, ChatCommandError> {
        let cmd = {
            let state = self.state.lock().expect("chat state lock");
            state.command(caller, payload)?
        };
        if self.send_line(&cmd.line()).is_err() {
            // U4b verifier F3: a line that never left is no answer: un-mark it (keep in sync)
            self.state.lock().expect("chat state lock").unsent(&cmd);
            return Err(ChatCommandError);
        }
        Ok(self.view())
    }

    pub fn close(&self) {
        self.stop.lock().expect("chat stop lock").store(true, Ordering::SeqCst);
        if let Some(p) = self.writer.lock().expect("chat writer lock").take() { p.close(); }
    }
}

impl Drop for ChatConn {
    fn drop(&mut self) { self.close(); }
}

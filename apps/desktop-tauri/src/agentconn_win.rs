//! #306 (Windows, W1) — the connection half of the island-agent client over a
//! NAMED PIPE. Same contract as `agentconn.rs` (keep in sync), different gate:
//!
//! * `session.json` lives under `%LOCALAPPDATA%\Abito\runtime` (or an
//!   `ABITO_ISLAND_DIR` override INSIDE that canonical protected root); before
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
use crate::winpolicy;
use serde_json::Value;
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, PeekNamedPipe};

const HELLO_WAIT: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(10);
/// Windows FILE_ATTRIBUTE_REPARSE_POINT: any name surrogate (symlink,
/// junction, mount point) is never a plain session file.
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
/// Bounded session file, parity with the daemon's own 4096-byte reader.
const MAX_SESSION_FILE: u64 = 4096;

pub struct AgentConn {
    state: Arc<Mutex<ClientState>>,
    writer: Arc<Mutex<Option<Arc<Pipe>>>>,
    stop: Arc<AtomicBool>,
    changed: Arc<dyn Fn(Value) + Send + Sync>,
}

/// `<island>/runtime/session.json` for the configured island root.
pub fn session_path(island_root: &Path) -> PathBuf {
    island_root.join("runtime").join("session.json")
}

/// Island root: an `ABITO_ISLAND_DIR` override INSIDE the canonical protected
/// `%LOCALAPPDATA%\Abito` root, or that root itself (`winpolicy::island_root`).
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
            stop: Arc::new(AtomicBool::new(false)),
            changed: Arc::new(changed),
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
        let mut buf = FrameBuffer::default();
        let mut chunk = [0u8; 4096];
        let deadline = Instant::now() + HELLO_WAIT;
        let first = loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match pipe.read_timeout(&mut chunk, left) {
                Ok(0) | Err(_) => {
                    crate::failure::report("island", "agent-no-answer", crate::failure::Reason::AgentNoAnswer, None);
                    return self.set(ClientState::disconnected(Reason::Refused));
                }
                Ok(n) => match buf.push(&chunk[..n]) {
                    Ok(frames) if !frames.is_empty() => break frames,
                    Ok(_) => continue,
                    Err(_) => return self.set(ClientState::disconnected(Reason::Refused)),
                },
            }
        };
        if first[0].get("type").and_then(Value::as_str) != Some("ready") {
            return self.set(ClientState::disconnected(Reason::Refused));
        }
        self.stop.store(false, Ordering::SeqCst);
        *self.writer.lock().expect("agent writer lock") = Some(pipe.clone());
        self.set(ClientState::connected());
        self.spawn_reader(pipe, buf);
        let _ = self.send(&UiCommand::Refresh);
    }

    fn spawn_reader(&self, reader: Arc<Pipe>, mut buf: FrameBuffer) {
        let (state, changed, stop, writer) = (self.state.clone(), self.changed.clone(), self.stop.clone(), self.writer.clone());
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                if stop.load(Ordering::SeqCst) { return }
                match reader.read_timeout(&mut chunk, Duration::from_millis(500)) {
                    Ok(0) => break,
                    Ok(n) => match buf.push(&chunk[..n]) {
                        Ok(frames) => {
                            let view = {
                                let mut st = state.lock().expect("agent state lock");
                                for f in &frames { let _ = st.apply(f); }
                                serde_json::to_value(&*st).unwrap_or(Value::Null)
                            };
                            changed(view);
                        }
                        Err(_) => break,
                    },
                    Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                    Err(_) => break,
                }
            }
            if !stop.load(Ordering::SeqCst) {
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
        self.stop.store(true, Ordering::SeqCst);
        if let Some(p) = self.writer.lock().expect("agent writer lock").take() { p.close(); }
    }
}

impl Drop for AgentConn {
    fn drop(&mut self) { self.close(); }
}

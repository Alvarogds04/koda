//! #306 — the connection half of the island-agent client: read `session.json`,
//! connect to the daemon's Unix socket, handshake, fold server frames into
//! [`ClientState`] and send the closed command set. One reader thread; the state is
//! shared behind a mutex and a callback tells the host when it changed.
//!
//! The daemon is NOT started here (that is the MCP/daemon spawner unit, not this one):
//! when no daemon is running the state is `no_daemon` and the UI says so honestly.
use crate::agentclient::{parse_ui_command, ClientState, CommandError, FrameBuffer, Reason, Session, UiCommand};
use crate::chatclient::{ChatCommand, ChatState, CommandError as ChatCommandError};
use serde_json::Value;
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const HELLO_WAIT: Duration = Duration::from_secs(3);

/// The reader's exit guard, shared shape for both connections: a reader may wipe the
/// writer and report the loss only when its OWN flag is still false AND its connection
/// epoch is still the current one. An old reader can then never touch a newer
/// connection, even when a reconnect reset a flag it shares by accident.
fn reader_may_finalize(stop: &AtomicBool, epochs: &AtomicU64, epoch: u64) -> bool {
    !stop.load(Ordering::SeqCst) && epochs.load(Ordering::SeqCst) == epoch
}

pub struct AgentConn {
    state: Arc<Mutex<ClientState>>,
    writer: Arc<Mutex<Option<UnixStream>>>,
    /// The CURRENT connection's stop flag, replaced on every connect. A reader keeps
    /// its own clone, which is never reset — a reconnect's new flag can never revive
    /// an old reader.
    stop: Mutex<Arc<AtomicBool>>,
    /// Monotone connection generation: an old reader whose epoch is no longer current
    /// may never touch the writer or the state of a newer connection.
    epoch: Arc<AtomicU64>,
    /// Told whenever the state moves, HANDED the new view: a callback must never need to re-lock
    /// anything the caller may hold (the host once re-locked its own slot here and deadlocked).
    changed: Arc<dyn Fn(Value) + Send + Sync>,
}

/// `<island>/runtime/session.json` for the configured island root.
pub fn session_path(island_root: &Path) -> PathBuf {
    island_root.join("runtime").join("session.json")
}

/// Island root: `ABITO_ISLAND_DIR` (absolute) or `~/.abito-island`.
pub fn island_root(env_dir: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    if let Some(d) = env_dir.filter(|d| !d.is_empty()) {
        return d.starts_with('/').then(|| PathBuf::from(d));
    }
    home.filter(|h| h.starts_with('/')).map(|h| Path::new(h).join(".abito-island"))
}

/// The session file must be OURS, a regular file, not group/world accessible.
fn read_session(path: &Path) -> Result<Session, Reason> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| Reason::NoDaemon)?;
    if !meta.file_type().is_file() || meta.file_type().is_symlink() || meta.mode() & 0o077 != 0 || meta.uid() != unsafe_uid() {
        return Err(Reason::BadSession);
    }
    let text = std::fs::read_to_string(path).map_err(|_| Reason::BadSession)?;
    let session = Session::parse(&text).map_err(|_| Reason::BadSession)?;
    // the recorded daemon must still be alive; a stale file is "no daemon", never a hang
    if !pid_exists(session.pid) {
        return Err(Reason::NoDaemon);
    }
    Ok(session)
}

#[cfg(target_os = "linux")]
fn unsafe_uid() -> u32 {
    std::fs::metadata("/proc/self").map(|m| m.uid()).unwrap_or(u32::MAX)
}
#[cfg(target_os = "macos")]
fn unsafe_uid() -> u32 {
    // SAFETY: getuid has no preconditions.
    unsafe { libc::getuid() }
}

#[cfg(target_os = "linux")]
fn pid_exists(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}
/// macOS has no /proc: signal 0 probes existence. EPERM means it exists (another user's process);
/// anything else, including a pid that does not fit a pid_t, means "no daemon".
#[cfg(target_os = "macos")]
fn pid_exists(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    if pid <= 0 { return false }
    // SAFETY: signal 0 sends nothing; it only checks the target.
    unsafe { libc::kill(pid, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}

impl AgentConn {
    pub fn new(changed: impl Fn(Value) + Send + Sync + 'static) -> AgentConn {
        AgentConn {
            state: Arc::new(Mutex::new(ClientState::disconnected(Reason::NoDaemon))),
            writer: Arc::new(Mutex::new(None)),
            stop: Mutex::new(Arc::new(AtomicBool::new(false))),
            epoch: Arc::new(AtomicU64::new(0)),
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

    /// (Re)connect from the session file. Returns the resulting connection state name.
    pub fn connect(&self, island_root: &Path) {
        self.close();
        let session = match read_session(&session_path(island_root)) {
            Ok(s) => s,
            Err(reason) => return self.set(ClientState::disconnected(reason)),
        };
        let mut stream = match UnixStream::connect(&session.endpoint) {
            Ok(s) => s,
            Err(_) => return self.set(ClientState::disconnected(Reason::NoDaemon)),
        };
        let _ = stream.set_write_timeout(Some(HELLO_WAIT));
        if stream.write_all(session.hello().as_bytes()).is_err() {
            crate::failure::report("island", "agent-refused", crate::failure::Reason::AgentRefused, None);
            return self.set(ClientState::disconnected(Reason::Refused));
        }
        // the daemon answers `ready` — and may already follow it with state frames in the
        // SAME write. Every complete line after the handshake must reach the fold: the
        // pending ask registered on only 27/30 connects was lost exactly here. Oversized
        // or malformed lines are skipped (lenient), the connection stays up; only a
        // handshake whose FIRST frame is not `ready` is refused.
        let _ = stream.set_read_timeout(Some(HELLO_WAIT));
        let deadline = Instant::now() + HELLO_WAIT;
        let mut buf = FrameBuffer::default();
        let mut chunk = [0u8; 4096];
        let after_ready: Vec<Value>;
        loop {
            if Instant::now() >= deadline {
                crate::failure::report("island", "agent-no-answer", crate::failure::Reason::AgentNoAnswer, None);
                return self.set(ClientState::disconnected(Reason::Refused));
            }
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => {
                    crate::failure::report("island", "agent-no-answer", crate::failure::Reason::AgentNoAnswer, None);
                    return self.set(ClientState::disconnected(Reason::Refused));
                }
                Ok(n) => {
                    let (frames, _skipped) = buf.push_lenient(&chunk[..n]);
                    if frames.is_empty() {
                        continue; // only noise so far: keep waiting for the handshake
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
        let reader = match stream.try_clone() {
            Ok(r) => r,
            Err(_) => return self.set(ClientState::disconnected(Reason::Lost)),
        };
        *self.writer.lock().expect("agent writer lock") = Some(stream);
        self.set(ClientState::connected());
        self.spawn_reader(reader, buf, after_ready, stop, self.epoch.clone(), epoch);
        let _ = self.send(&UiCommand::Refresh);
    }

    fn spawn_reader(&self, mut reader: UnixStream, mut buf: FrameBuffer, pending: Vec<Value>, stop: Arc<AtomicBool>, epochs: Arc<AtomicU64>, epoch: u64) {
        let (state, changed, writer) = (self.state.clone(), self.changed.clone(), self.writer.clone());
        let _ = reader.set_read_timeout(Some(Duration::from_millis(500)));
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            // the handshake burst: frames that arrived in the same read as `ready`
            if !pending.is_empty() {
                let emit = {
                    let mut st = state.lock().expect("agent state lock");
                    let before = serde_json::to_value(&*st).unwrap_or(Value::Null);
                    for f in &pending {
                        let _ = st.apply(f);
                    }
                    let after = serde_json::to_value(&*st).unwrap_or(Value::Null);
                    (before != after).then_some(after)
                };
                if let Some(view) = emit {
                    changed(view);
                }
            }
            loop {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                match reader.read(&mut chunk) {
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
                        let emit = {
                            let mut st = state.lock().expect("agent state lock");
                            let before = serde_json::to_value(&*st).unwrap_or(Value::Null);
                            for f in &frames {
                                let _ = st.apply(f);
                            }
                            let after = serde_json::to_value(&*st).unwrap_or(Value::Null);
                            (before != after).then_some(after)
                        };
                        if let Some(view) = emit {
                            changed(view);
                        }
                    }
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
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

    /// Send one validated command (local commands are handled by the caller).
    pub fn send(&self, cmd: &UiCommand) -> Result<(), CommandError> {
        let lines = match cmd {
            UiCommand::Refresh => cmd.refresh_lines(),
            UiCommand::View => return Ok(()),
            UiCommand::Account(_) => return Err(CommandError), // local store only, never daemon wire
            other => vec![other.line()],
        };
        let mut guard = self.writer.lock().expect("agent writer lock");
        let stream = guard.as_mut().ok_or(CommandError)?;
        for line in lines {
            if stream.write_all(line.as_bytes()).is_err() {
                return Err(CommandError);
            }
        }
        Ok(())
    }

    pub fn command(&self, payload: &Value) -> Result<Value, CommandError> {
        let cmd = parse_ui_command(payload)?;
        if matches!(cmd, UiCommand::View) {
            return Ok(self.view());
        }
        self.send(&cmd)?;
        Ok(self.view())
    }

    pub fn close(&self) {
        self.stop.lock().expect("agent stop lock").store(true, Ordering::SeqCst);
        if let Some(w) = self.writer.lock().expect("agent writer lock").take() {
            let _ = w.shutdown(std::net::Shutdown::Both);
        }
    }
}

impl Drop for AgentConn {
    fn drop(&mut self) {
        self.close();
    }
}

// ---- K2-05 T4 U2: the SECOND connection (the chat) --------------------------------

/// The island's chat connection: a SECOND connection to the same daemon endpoint
/// (the settings window keeps its own through `AgentConn`; the daemon allows 2
/// clients, PROTOCOL.md). It reuses the session.json / hello / reader-thread
/// machinery of [`AgentConn`] unchanged, but folds frames into [`ChatState`]
/// through its OWN callback, and sends only the closed chat command set
/// ([`ChatCommand`], window-gated at parse time).
pub struct ChatConn {
    state: Arc<Mutex<ChatState>>,
    writer: Arc<Mutex<Option<UnixStream>>>,
    /// The CURRENT connection's stop flag, replaced on every connect: an old reader
    /// keeps its own flag, which is never reset. Same contract as `AgentConn`.
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

    /// (Re)connect from the session file: read session.json, connect the second
    /// socket, handshake, then fold `ready`-and-onward frames into the chat view.
    /// Same handshake discipline as `AgentConn::connect` (keep in sync): the burst
    /// after `ready` reaches the fold, oversized/malformed lines are skipped.
    pub fn connect(&self, island_root: &Path) {
        self.close();
        let session = match read_session(&session_path(island_root)) {
            Ok(s) => s,
            Err(reason) => return self.set(ChatState::disconnected(reason)),
        };
        let mut stream = match UnixStream::connect(&session.endpoint) {
            Ok(s) => s,
            Err(_) => return self.set(ChatState::disconnected(Reason::NoDaemon)),
        };
        let _ = stream.set_write_timeout(Some(HELLO_WAIT));
        if stream.write_all(session.hello().as_bytes()).is_err() {
            crate::failure::report("island", "agent-refused", crate::failure::Reason::AgentRefused, None);
            return self.set(ChatState::disconnected(Reason::Refused));
        }
        let _ = stream.set_read_timeout(Some(HELLO_WAIT));
        let deadline = Instant::now() + HELLO_WAIT;
        let mut buf = FrameBuffer::default();
        let mut chunk = [0u8; 4096];
        let after_ready: Vec<Value>;
        loop {
            if Instant::now() >= deadline {
                crate::failure::report("island", "agent-no-answer", crate::failure::Reason::AgentNoAnswer, None);
                return self.set(ChatState::disconnected(Reason::Refused));
            }
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => {
                    crate::failure::report("island", "agent-no-answer", crate::failure::Reason::AgentNoAnswer, None);
                    return self.set(ChatState::disconnected(Reason::Refused));
                }
                Ok(n) => {
                    let (frames, _skipped) = buf.push_lenient(&chunk[..n]);
                    if frames.is_empty() {
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
        let reader = match stream.try_clone() {
            Ok(r) => r,
            Err(_) => return self.set(ChatState::disconnected(Reason::Lost)),
        };
        *self.writer.lock().expect("chat writer lock") = Some(stream);
        self.set(ChatState::connected());
        self.spawn_reader(reader, buf, after_ready, stop, self.epoch.clone(), epoch);
        // the late client asks for the newest history page and the agent status once
        // it has handshook (the `ready` state may already be stale)
        let _ = self.send_line(&ChatCommand::History.line());
        let _ = self.send_line(&ChatCommand::Status.line());
    }

    fn spawn_reader(&self, mut reader: UnixStream, mut buf: FrameBuffer, pending: Vec<Value>, stop: Arc<AtomicBool>, epochs: Arc<AtomicU64>, epoch: u64) {
        let (state, changed, writer) = (self.state.clone(), self.changed.clone(), self.writer.clone());
        let _ = reader.set_read_timeout(Some(Duration::from_millis(500)));
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            // the handshake burst: frames that arrived in the same read as `ready`
            if !pending.is_empty() {
                // L3 (U2 re-verify): the fold bumps `ChatState::revision` only when the view
                // changed, so the emit decision is one integer comparison — the whole chat
                // state is serialized at most once per read, never twice.
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
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                match reader.read(&mut chunk) {
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
                        // serialized at most ONCE per read, only on an actual change.
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
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
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
        let mut guard = self.writer.lock().expect("chat writer lock");
        let stream = guard.as_mut().ok_or(ChatCommandError)?;
        stream.write_all(line.as_bytes()).map_err(|_| ChatCommandError)
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
        if let Some(w) = self.writer.lock().expect("chat writer lock").take() {
            let _ = w.shutdown(std::net::Shutdown::Both);
        }
    }
}

impl Drop for ChatConn {
    fn drop(&mut self) {
        self.close();
    }
}

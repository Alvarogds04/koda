//! #306 — the connection half of the island-agent client: read `session.json`,
//! connect to the daemon's Unix socket, handshake, fold server frames into
//! [`ClientState`] and send the closed command set. One reader thread; the state is
//! shared behind a mutex and a callback tells the host when it changed.
//!
//! The daemon is NOT started here (that is the MCP/daemon spawner unit, not this one):
//! when no daemon is running the state is `no_daemon` and the UI says so honestly.
use crate::agentclient::{parse_ui_command, ClientState, CommandError, FrameBuffer, Reason, Session, UiCommand};
use serde_json::Value;
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const HELLO_WAIT: Duration = Duration::from_secs(3);

pub struct AgentConn {
    state: Arc<Mutex<ClientState>>,
    writer: Arc<Mutex<Option<UnixStream>>>,
    stop: Arc<AtomicBool>,
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
        // the daemon answers `ready` or closes without detail
        let _ = stream.set_read_timeout(Some(HELLO_WAIT));
        let mut buf = FrameBuffer::default();
        let mut chunk = [0u8; 4096];
        let first = loop {
            match stream.read(&mut chunk) {
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
        let reader = match stream.try_clone() {
            Ok(r) => r,
            Err(_) => return self.set(ClientState::disconnected(Reason::Lost)),
        };
        *self.writer.lock().expect("agent writer lock") = Some(stream);
        self.set(ClientState::connected());
        self.spawn_reader(reader, buf);
        let _ = self.send(&UiCommand::Refresh);
    }

    fn spawn_reader(&self, mut reader: UnixStream, mut buf: FrameBuffer) {
        let (state, changed, stop, writer) = (self.state.clone(), self.changed.clone(), self.stop.clone(), self.writer.clone());
        let _ = reader.set_read_timeout(Some(Duration::from_millis(500)));
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => match buf.push(&chunk[..n]) {
                        Ok(frames) => {
                            let view = {
                                let mut st = state.lock().expect("agent state lock");
                                for f in &frames {
                                    let _ = st.apply(f);
                                }
                                serde_json::to_value(&*st).unwrap_or(Value::Null)
                            };
                            changed(view);
                        }
                        Err(_) => break,
                    },
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
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
        self.stop.store(true, Ordering::SeqCst);
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

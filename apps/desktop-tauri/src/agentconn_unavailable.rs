//! #306 — the connection half of the island-agent client. This target has no
//! reachable daemon endpoint yet, so its honest state is `no_daemon`.

use crate::agentclient::{parse_ui_command, ClientState, CommandError, Reason, UiCommand};
use crate::chatclient::{ChatState, CommandError as ChatCommandError};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub struct AgentConn {
    state: Arc<Mutex<ClientState>>,
    changed: Arc<dyn Fn(Value) + Send + Sync>,
}

/// `<island>/runtime/session.json` for the configured island root.
// keep in sync with agentconn.rs
pub fn session_path(island_root: &Path) -> PathBuf {
    island_root.join("runtime").join("session.json")
}

/// Island root: `KODA_ISLAND_DIR` (absolute) or `~/.koda`.
// keep in sync with agentconn.rs
pub fn island_root(env_dir: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    if let Some(d) = env_dir.filter(|d| !d.is_empty()) {
        return d.starts_with('/').then(|| PathBuf::from(d));
    }
    home.filter(|h| h.starts_with('/')).map(|h| Path::new(h).join(".koda"))
}

impl AgentConn {
    pub fn new(changed: impl Fn(Value) + Send + Sync + 'static) -> AgentConn {
        AgentConn {
            state: Arc::new(Mutex::new(ClientState::disconnected(Reason::NoDaemon))),
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

    fn set(&self, state: ClientState) {
        let view = serde_json::to_value(&state).unwrap_or(Value::Null);
        *self.state.lock().expect("agent state lock") = state;
        (self.changed)(view);
    }

    /// (Re)connect from the session file. Returns the resulting connection state name.
    /// With no reachable daemon endpoint on this non-Linux target, `no_daemon` is the truthful state.
    pub fn connect(&self, island_root: &Path) {
        let _ = island_root;
        self.set(ClientState::disconnected(Reason::NoDaemon));
    }

    /// Send one validated command (local commands are handled by the caller).
    pub fn send(&self, command: &UiCommand) -> Result<(), CommandError> {
        match command {
            UiCommand::View => Ok(()),
            _ => Err(CommandError),
        }
    }

    pub fn command(&self, payload: &Value) -> Result<Value, CommandError> {
        let command = parse_ui_command(payload)?;
        if matches!(command, UiCommand::View) {
            return Ok(self.view());
        }
        self.send(&command)?;
        Ok(self.view())
    }

    pub fn close(&self) {}
}

// ---- K2-05 T4 U2: the SECOND connection (the chat) --------------------------------

/// The island's chat connection. This target has no reachable daemon endpoint,
/// so its honest state is `no_daemon` and nothing can ever be sent.
pub struct ChatConn {
    state: Arc<Mutex<ChatState>>,
    changed: Arc<dyn Fn(Value) + Send + Sync>,
}

impl ChatConn {
    pub fn new(changed: impl Fn(Value) + Send + Sync + 'static) -> ChatConn {
        ChatConn {
            state: Arc::new(Mutex::new(ChatState::disconnected(Reason::NoDaemon))),
            changed: Arc::new(changed),
        }
    }

    pub fn view(&self) -> Value {
        serde_json::to_value(&*self.state.lock().expect("chat state lock")).unwrap_or(Value::Null)
    }

    fn set(&self, state: ChatState) {
        let view = serde_json::to_value(&state).unwrap_or(Value::Null);
        *self.state.lock().expect("chat state lock") = state;
        (self.changed)(view);
    }

    /// (Re)connect from the session file. With no reachable daemon endpoint on
    /// this target, `no_daemon` is the truthful state.
    pub fn connect(&self, island_root: &Path) {
        let _ = island_root;
        self.set(ChatState::disconnected(Reason::NoDaemon));
    }

    /// Parse one chat command for the given caller window (the gate lives in the
    /// parser) and send its wire line. Nothing is reachable here: commands fail.
    pub fn command(&self, caller: &str, payload: &Value) -> Result<Value, ChatCommandError> {
        let state = self.state.lock().expect("chat state lock");
        let _cmd = state.command(caller, payload)?;
        Err(ChatCommandError)
    }

    pub fn close(&self) {}
}

impl Drop for ChatConn {
    fn drop(&mut self) { self.close(); }
}

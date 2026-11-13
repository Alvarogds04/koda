//! The loopback MCP endpoint with the one tool «screenshot my window» (S1, S5, S6, S3).
//!
//! Adapted from Gentle Dot `computer/{mcp,server}.rs`, MIT: JSON-RPC over streamable HTTP, a bearer
//! token fresh per launch compared in constant time, `POST /mcp` only, notifications answered 202.
//! Unlike Gentle Dot's twelve tools, Koda has exactly one, and it never acts on the desktop.
use super::blocklist;
use super::session::Session;
use base64::Engine as _;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use subtle::ConstantTimeEq;

/// The tool name. The agent sees it as `mcp__computer__screenshot_my_window` (server id `computer`).
pub const TOOL: &str = "screenshot_my_window";
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

pub const NOT_ALLOWED: &str = "The user did not allow Koda to look at their window. Nothing was captured.";
pub const TURNED_OFF: &str = "Looking at the user's window is turned off in Koda's settings. Nothing was captured. \
Tell the user they can turn it on in Ajustes → Chat → «Dejar que Koda vea mi ventana».";
const NO_WINDOW: &str = "Koda found no other window to look at. Ask the user to bring the window they mean to the front and try again.";

/// The window the capture would take.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub app_id: String,
    pub app: String,
    pub title: String,
    /// The OS handle the backend captures by: X11 window id, `HWND`, `CGWindowID`, extension window id.
    pub handle: u64,
}

/// One captured window, PNG encoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shot {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureError {
    /// No window other than Koda's own.
    NoWindow,
    /// The OS did not give the screen permission (S2).
    PermissionMissing,
    /// This system cannot capture a window (too old, no backend).
    Unsupported(String),
    Failed(String),
}

/// What the host can do on this OS: choose the window (through `contextwin`, never the island) and capture it.
pub trait Desktop: Send + Sync {
    fn pick_target(&self) -> Result<Target, CaptureError>;
    fn capture(&self, target: &Target) -> Result<Shot, CaptureError>;
}

/// The consent prompt (S6).
pub trait Dialogs: Send + Sync {
    fn ask_grant(&self) -> bool;
}

pub struct HttpRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub authorization: Option<&'a str>,
    pub body: &'a str,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HttpReply {
    pub status: u16,
    pub body: Option<Value>,
}

pub struct Helper {
    desktop: Arc<dyn Desktop>,
    dialogs: Arc<dyn Dialogs>,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    token: String,
    session: Mutex<Session>,
}

/// 32 random bytes, hex encoded. Lives only in memory and in the daemon's private 0600 projection.
pub fn new_token() -> String {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 32];
    ring::rand::SystemRandom::new().fill(&mut bytes).expect("the OS random source is unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn reply(status: u16, id: Value, outcome: Result<Value, (i64, String)>) -> HttpReply {
    let body = match outcome {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err((code, message)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
    };
    HttpReply { status, body: Some(body) }
}

fn tool_error(message: &str) -> Value {
    json!({"isError": true, "content": [{"type": "text", "text": message}]})
}

/// What to tell the user when the capture failed, in terms of what is missing and how to fix it (S2).
pub fn error_message(error: &CaptureError) -> String {
    match error {
        CaptureError::NoWindow => NO_WINDOW.into(),
        CaptureError::PermissionMissing => {
            #[cfg(target_os = "macos")]
            let fix = "Open System Settings → Privacy & Security → Screen Recording, turn Koda on, and quit and reopen Koda. \
macOS asks again after every Koda update.";
            #[cfg(not(target_os = "macos"))]
            let fix = "Grant the screen permission to Koda in your system's privacy settings.";
            format!("Koda does not have the screen recording permission, so it cannot see the window. {fix} Then ask again.")
        }
        CaptureError::Unsupported(why) => format!("This system cannot capture a window: {why}"),
        CaptureError::Failed(why) => format!("The capture failed: {why}"),
    }
}

impl Helper {
    pub fn new(
        desktop: Arc<dyn Desktop>,
        dialogs: Arc<dyn Dialogs>,
        now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
        enabled: Arc<dyn Fn() -> bool + Send + Sync>,
        token: String,
    ) -> Self {
        Helper { desktop, dialogs, now_ms, enabled, token, session: Mutex::new(Session::default()) }
    }

    fn authorized(&self, header: Option<&str>) -> bool {
        let Some((scheme, token)) = header.and_then(|h| h.trim().split_once(' ')) else { return false };
        scheme.eq_ignore_ascii_case("bearer") && bool::from(token.trim().as_bytes().ct_eq(self.token.as_bytes()))
    }

    pub fn handle(&self, request: &HttpRequest<'_>) -> HttpReply {
        if !self.authorized(request.authorization) {
            return reply(401, Value::Null, Err((-32001, "Unauthorized".into())));
        }
        if request.path != "/mcp" {
            return HttpReply { status: 404, body: None };
        }
        if request.method != "POST" {
            return HttpReply { status: 405, body: None };
        }
        let Ok(message) = serde_json::from_str::<Value>(request.body) else {
            return reply(400, Value::Null, Err((-32700, "Parse error".into())));
        };
        let id = message.get("id").cloned();
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return reply(400, id.unwrap_or(Value::Null), Err((-32600, "Invalid request".into())));
        };
        let Some(id) = id else { return HttpReply { status: 202, body: None } };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let outcome = match method {
            "initialize" => {
                let asked = params.get("protocolVersion").and_then(Value::as_str);
                let version = PROTOCOL_VERSIONS.iter().copied().find(|v| Some(*v) == asked).unwrap_or(PROTOCOL_VERSIONS[0]);
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "koda-window", "version": env!("CARGO_PKG_VERSION")},
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools": [tool_definition()]})),
            "tools/call" => self.call(&params),
            _ => Err((-32601, format!("Method not found: {method}"))),
        };
        reply(200, id, outcome)
    }

    fn call(&self, params: &Value) -> Result<Value, (i64, String)> {
        if params.get("name").and_then(Value::as_str) != Some(TOOL) {
            return Err((-32602, "Unknown tool".into()));
        }
        Ok(self.screenshot())
    }

    fn screenshot(&self) -> Value {
        // S3: with the option off nothing is asked and nothing is captured.
        if !(self.enabled)() {
            return tool_error(TURNED_OFF);
        }
        // S6: the consent session. Held across the prompt so two calls ask once.
        {
            let mut session = self.session.lock().unwrap_or_else(|e| e.into_inner());
            let now = (self.now_ms)();
            if !session.is_active(now) {
                if !self.dialogs.ask_grant() {
                    return tool_error(NOT_ALLOWED);
                }
                session.grant((self.now_ms)());
            }
        }
        let target = match self.desktop.pick_target() {
            Ok(target) => target,
            Err(error) => return tool_error(&error_message(&error)),
        };
        // S5: refuse sensitive apps before any pixel is read.
        if let Some(label) = blocklist::blocked_reason(&target.app_id, &target.app) {
            return tool_error(&format!("Koda does not look at {label}: it can show passwords or system prompts. Nothing was captured."));
        }
        match self.desktop.capture(&target) {
            Ok(shot) => json!({"content": [
                {"type": "image", "data": base64::engine::general_purpose::STANDARD.encode(&shot.png), "mimeType": "image/png"},
                {"type": "text", "text": json!({"frontApp": target.app, "title": target.title, "imageWidth": shot.width, "imageHeight": shot.height}).to_string()},
            ]}),
            Err(error) => tool_error(&error_message(&error)),
        }
    }
}

fn tool_definition() -> Value {
    json!({
        "name": TOOL,
        "description": "Take a picture of the window the user was just looking at (never Koda itself) so you can answer questions about what it shows. Use it only when the user asks about their window or screen. The user may be asked to allow it, and some apps (password managers, system settings) are always refused.",
        "inputSchema": {"type": "object", "properties": {}},
    })
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;

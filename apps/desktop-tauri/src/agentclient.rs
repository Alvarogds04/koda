//! #306 — client of the island agent protocol `island-agent/1` (the daemon of
//! `apps/desktop-daemon`), PURE part: session handoff, frame codec, the closed set
//! of commands the settings UI may issue, the allowlisted view state, and the
//! explicit Abito-owned account store (local filesystem only).
//!
//! Security model (the reason this lives in Rust, not in the WebView):
//! - the per-launch TOKEN and the socket ENDPOINT never leave this module: `Session`
//!   redacts the token in `Debug`, and `ClientState` (the only thing serialized to the
//!   UI) has no field that could carry either;
//! - the UI can only send the commands of [`parse_ui_command`] (no `send`, no `abort`,
//!   no `settings_set`, no `local_account_create`: nothing that reaches the chat or
//!   the engine);
//! - daemon API keys travel as `auth_reply` values only; local `abito_account_*`
//!   commands persist validated keys in Abito's private config file. Neither path
//!   echoes credentials in public state or Debug, or forwards local keys to the daemon;
//! - server frames are folded into allowlisted fields; unknown or malformed frames are
//!   ignored (never forwarded raw).
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fmt;

#[cfg(test)]
#[path = "agentclient_tests.rs"]
mod tests;

#[cfg(all(test, unix))] // the tests exercise unix file modes
#[path = "provider_accounts_tests.rs"]
mod provider_accounts_tests;

pub const PROTOCOL: &str = "island-agent/1";
/// #360: the live agent sessions frame schema (the client folds only this one).
pub const SESSIONS_SCHEMA: &str = "abito-sessions/view/1";
pub const MAX_SESSION_BYTES: usize = 4096;
pub const MAX_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_REPLY_CHARS: usize = 4096;

// ---- K2-13 «Hoy»: the daemon's own closed vocabularies (PROTOCOL.md, «Minikodas and «Hoy» frames») ----
/// An item id is the daemon's uuid: lowercase hex in the 8-4-4-4-12 shape.
const MAX_HOY_ITEMS: usize = 100;
const MAX_HOY_TEXT: usize = 4000;
const HOY_KINDS: [&str; 3] = ["result", "proposal", "error"];
const HOY_STATUSES: [&str; 3] = ["pending", "approved", "rejected"];
const HOY_ACTIONS: [&str; 3] = ["buy", "sell", "send"];
/// S19: where the text of a video result came from. The daemon does not send it yet; when it does, only these two
/// closed values reach the page (the island draws its chip with the row, and nothing when it is absent).
const HOY_PROVENANCE: [&str; 2] = ["youtube_subtitles", "local_transcription"];

// ---- K2-13 Telegram + transcription setting (S7, S10, S16, S18, S20; PROTOCOL.md «Telegram frames» and
// «Transcription setting») ------------------------------------------------------------------------------------
/// The four states the daemon may report. Anything else is not a status and changes nothing.
const TELEGRAM_STATES: [&str; 4] = ["disconnected", "awaiting_code", "awaiting_password", "connected"];
/// PROTOCOL.md: the account name is capped at 80 chars and the username is `[A-Za-z0-9_]{1,32}`.
const TELEGRAM_NAME_MAX: usize = 80;
const TELEGRAM_USERNAME_MAX: usize = 32;
/// The daemon's own bounds (protocol.cjs TELEGRAM_LIMITS). The island refuses BEFORE the socket, so a payload the
/// daemon would reject never leaves the WebView.
const TELEGRAM_API_ID_MAX: u64 = 2_147_483_647;
const TELEGRAM_CODE_MAX: usize = 32;
const TELEGRAM_PASSWORD_MAX: usize = 1024;
/// A session string is printable ASCII and bounded (`isCarriableSession` in the daemon).
const TELEGRAM_SESSION_MAX: usize = 4096;
const TRANSCRIPTION_MODES: [&str; 2] = ["local-parakeet", "remote"];
const TRANSCRIPTION_LANGUAGES: [&str; 7] = ["es", "en", "fr", "de", "it", "pt", "ca"];
const TRANSCRIPTION_MODEL_MAX: usize = 200;

/// PROTOCOL.md «Client → server»: `apiHash` is exactly 32 lowercase hex.
fn api_hash_ok(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// E.164 as the daemon validates it: `+`, a non-zero first digit and 7–15 digits in total.
fn phone_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 8 && b.len() <= 16 && b[0] == b'+' && (b'1'..=b'9').contains(&b[1]) && b[1..].iter().all(u8::is_ascii_digit)
}
/// The session contract the daemon and the island share: non-empty, printable ASCII, bounded. A value that cannot ever
/// have been exported by the daemon is not one the island may hand back or store.
pub fn carriable_session(s: &str) -> bool {
    !s.is_empty() && s.len() <= TELEGRAM_SESSION_MAX && s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}
/// A transcription setting's remote account id: `[a-z0-9][a-z0-9._-]{0,63}` (transcribe-setting.cjs ACCOUNT_ID).
fn transcription_account_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 64 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
}

fn hoy_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
}
/// The Unicode `Cf` (format) ranges of Unicode 16.0, in one table: bidi overrides and isolates, zero-width joiners and
/// spaces, soft hyphens, word joiners, tag characters, interlinear annotations and the Egyptian / musical format controls.
/// Rust's `char::is_control` is `Cc` only, so the format characters have to be named here (F2: the first version listed
/// just U+200B-200F, 202A-202E, 2066-2069 and FEFF and let the rest through).
const FORMAT_RANGES: [(u32, u32); 22] = [
    (0x00ad, 0x00ad),
    (0x0600, 0x0605),
    (0x061c, 0x061c),
    (0x06dd, 0x06dd),
    (0x070f, 0x070f),
    (0x0890, 0x0891),
    (0x08e2, 0x08e2),
    (0x180e, 0x180e),
    (0x200b, 0x200f),
    (0x202a, 0x202e),
    (0x2060, 0x2064),
    (0x2066, 0x206f),
    (0xfeff, 0xfeff),
    (0xfff9, 0xfffb),
    (0x110bd, 0x110bd),
    (0x110cd, 0x110cd),
    (0x13430, 0x1343f),
    (0x1bca0, 0x1bca3),
    (0x1d173, 0x1d17a),
    (0xe0001, 0xe0001),
    (0xe0020, 0xe007f),
    // Zl / Zp (line and paragraph separators): not Cc, not Cf, and just as able to reflow or hide a row
    (0x2028, 0x2029),
];
/// True for a character «Hoy» must not carry: the whole `Cf` set above, the two separators, and any `Cc` control.
fn hoy_denied(c: char) -> bool {
    if c.is_control() {
        return true;
    }
    let cp = c as u32;
    FORMAT_RANGES.iter().any(|(lo, hi)| cp >= *lo && cp <= *hi)
}
/// «Hoy» text is untrusted (it comes from models and Telegram posts). Control characters, every Unicode format character
/// and U+2028/U+2029 go, so nothing on the page can reverse, hide or reflow what it says.
fn hoy_text(v: &Value, key: &str, max: usize) -> Value {
    v.get(key)
        .and_then(Value::as_str)
        .map(|s| Value::from(s.chars().filter(|c| !hoy_denied(*c)).take(max).collect::<String>()))
        .unwrap_or(Value::Null)
}
fn closed_cell(v: &Value, key: &str, allowed: &'static [&'static str]) -> Option<&'static str> {
    let raw = v.get(key).and_then(Value::as_str)?;
    allowed.iter().copied().find(|a| *a == raw)
}
fn iso_cell(v: &Value, key: &str) -> Value {
    match v.get(key).and_then(Value::as_str) {
        Some(s) if !s.is_empty() && s.len() <= 40 && !has_control(s) => Value::from(s),
        _ => Value::Null,
    }
}

// ---- session.json ----------------------------------------------------------------------
pub struct Session {
    pub endpoint: String,
    pub pid: u32,
    token: String,
}

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session").field("endpoint", &self.endpoint).field("pid", &self.pid).field("token", &"<redacted>").finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionError;

fn has_control(s: &str) -> bool {
    s.chars().any(char::is_control)
}

impl Session {
    pub fn parse(text: &str) -> Result<Session, SessionError> {
        if text.len() > MAX_SESSION_BYTES {
            return Err(SessionError);
        }
        let v: Value = serde_json::from_str(text).map_err(|_| SessionError)?;
        let o = v.as_object().ok_or(SessionError)?;
        if o.get("protocol").and_then(Value::as_str) != Some(PROTOCOL) {
            return Err(SessionError);
        }
        let token = o.get("token").and_then(Value::as_str).filter(|t| !t.is_empty() && t.len() <= 512 && !has_control(t)).ok_or(SessionError)?;
        let endpoint = o.get("endpoint").and_then(Value::as_str).ok_or(SessionError)?;
        if !endpoint_ok(endpoint) {
            return Err(SessionError);
        }
        let pid = o.get("pid").and_then(Value::as_u64).filter(|p| *p > 0 && *p <= u64::from(u32::MAX)).ok_or(SessionError)?;
        Ok(Session { endpoint: endpoint.to_owned(), pid: pid as u32, token: token.to_owned() })
    }

    /// The `hello` line for the handshake (the ONLY place the token is read).
    pub fn hello(&self) -> String {
        hello_line(&self.token)
    }
}

/// `<runtime>/p-XXXXXX/s`: absolute, normalized, no control bytes, exact leaf shape.
fn endpoint_ok(e: &str) -> bool {
    // Windows: the daemon listens on a named pipe, never on a path.
    if cfg!(windows) { return crate::winpolicy::pipe_endpoint_ok(e) }
    if !e.starts_with('/') || e.len() > 107 || has_control(e) {
        return false;
    }
    let parts: Vec<&str> = e.split('/').skip(1).collect();
    if parts.len() < 3 || parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
        return false;
    }
    let n = parts.len();
    let dir = parts[n - 2];
    parts[n - 1] == "s" && dir.len() == 8 && dir.starts_with("p-") && dir[2..].bytes().all(|b| b.is_ascii_alphanumeric())
}

pub fn hello_line(token: &str) -> String {
    format!("{{\"type\":\"hello\",\"protocol\":\"{PROTOCOL}\",\"token\":{}}}\n", serde_json::to_string(token).unwrap_or_default())
}

// ---- frame codec -------------------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    TooLarge,
    Malformed,
}

#[derive(Default)]
pub struct FrameBuffer {
    pending: Vec<u8>,
    /// Lenient-read state: a line already past the daemon's own frame bound with no LF
    /// in sight is discarded as it arrives, until the next newline ends it.
    discarding: bool,
}

impl FrameBuffer {
    /// Feed bytes; returns the complete frames (objects) found. LF is the only separator.
    /// STRICT: an oversized or malformed line is a protocol error, never a skip. This is NOT
    /// the handshake path — both connections (the unix [`crate::agentconn`] and the Windows
    /// mirror) handshake AND read with [`FrameBuffer::push_lenient`] — the strict variant
    /// only serves callers that must fail closed on any noise (the Windows native status
    /// proof `agentconn_win::verify_session`, which answers a single hello→ready).
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, FrameError> {
        self.pending.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(at) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=at).collect();
            if line.len() > MAX_FRAME_BYTES + 1 {
                return Err(FrameError::TooLarge);
            }
            let v: Value = serde_json::from_slice(&line[..line.len() - 1]).map_err(|_| FrameError::Malformed)?;
            if !v.is_object() {
                return Err(FrameError::Malformed);
            }
            out.push(v);
        }
        if self.pending.len() > MAX_FRAME_BYTES {
            return Err(FrameError::TooLarge);
        }
        Ok(out)
    }

    /// Feed bytes on the read path (handshake AND post-handshake: `agentconn.rs:160`/`:368`
    /// and their Windows mirror use it for both): an oversized line (a hooks broadcast
    /// up to the daemon's own 1 MiB history bound) or a malformed JSON line is SKIPPED —
    /// counted, never buffered past its bound, never fatal — so the connection stays up.
    /// Returns the complete frames found and how many lines were skipped.
    pub fn push_lenient(&mut self, bytes: &[u8]) -> (Vec<Value>, u64) {
        let mut out = Vec::new();
        let mut skipped = 0u64;
        let mut rest = bytes;
        if self.discarding {
            // bounded discard: bytes flow through, only the next newline ends the skip
            match rest.iter().position(|b| *b == b'\n') {
                Some(at) => {
                    self.discarding = false;
                    rest = &rest[at + 1..];
                    skipped += 1;
                }
                None => return (out, skipped),
            }
        }
        self.pending.extend_from_slice(rest);
        while let Some(at) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=at).collect();
            if line.len() > MAX_FRAME_BYTES + 1 {
                skipped += 1; // already drained: the oversized bytes were never kept
                continue;
            }
            match serde_json::from_slice::<Value>(&line[..line.len() - 1]) {
                Ok(v) if v.is_object() => out.push(v),
                _ => skipped += 1, // malformed JSON or not an object
            }
        }
        if self.pending.len() > MAX_FRAME_BYTES {
            // no LF and already past the daemon's own bound: the eventual line can only
            // be oversized — stop buffering it, discard until the next newline
            self.pending.clear();
            self.discarding = true;
        }
        (out, skipped)
    }
}

// ---- the closed command set ---------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandError;

pub enum UiCommand {
    /// Local: read the current state.
    View,
    /// Local-only Abito account configuration, never daemon wire.
    Account(AccountCommand),
    /// Local: ask the daemon for every list again.
    Refresh,
    Wire(String),
    /// An answer to an `auth_prompt`; the value may be a secret and is redacted from Debug.
    AuthReply { flow_id: String, prompt_id: String, value: String },
}

impl fmt::Debug for UiCommand {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UiCommand::View => f.write_str("View"),
            UiCommand::Account(_) => f.write_str("Account(<redacted>)"),
            UiCommand::Refresh => f.write_str("Refresh"),
            UiCommand::Wire(w) => f.debug_tuple("Wire").field(w).finish(),
            UiCommand::AuthReply { flow_id, prompt_id, .. } => f
                .debug_struct("AuthReply").field("flow_id", flow_id).field("prompt_id", prompt_id).field("value", &"<redacted>").finish(),
        }
    }
}

fn ordered(fields: &[(&str, &str)]) -> String {
    let body: Vec<String> = fields.iter().map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), serde_json::to_string(v).unwrap_or_default())).collect();
    format!("{{{}}}\n", body.join(","))
}

impl UiCommand {
    /// The wire line (empty for the local commands).
    pub fn line(&self) -> String {
        match self {
            UiCommand::Wire(w) => w.clone(),
            UiCommand::AuthReply { flow_id, prompt_id, value } => ordered(&[("type", "auth_reply"), ("flowId", flow_id), ("promptId", prompt_id), ("value", value)]),
            _ => String::new(),
        }
    }

    /// The five list requests a refresh sends.
    pub fn refresh_lines(&self) -> Vec<String> {
        ["providers_list", "accounts_list", "profiles_list", "connectors_list", "settings_get"].iter().map(|t| ordered(&[("type", t)])).collect()
    }
}

fn strict_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 64 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
}
/// Mirror of the daemon's `validateCustomBaseUrl` (protocol.cjs): `https`, or `http` only for a literal
/// loopback address (127.0.0.0/8, [::1]); plain host[:port] and `/segment` path, no userinfo, query,
/// fragment, escapes, dot segments or numeric-host shorthand. The daemon validates again: this is the
/// first of two gates, never the only one.
fn custom_base_url_ok(raw: &str) -> bool {
    if raw.is_empty() || raw.len() > 200 || !raw.is_ascii() { return false; }
    let (https, rest) = if let Some(r) = raw.strip_prefix("https://") { (true, r) } else if let Some(r) = raw.strip_prefix("http://") { (false, r) } else { return false };
    let (authority, path) = match rest.find('/') { Some(i) => (&rest[..i], &rest[i..]), None => (rest, "") };
    let (host, port) = if authority.starts_with('[') {
        let Some(end) = authority.find(']') else { return false };
        let host = &authority[..=end];
        if host.len() < 4 || !host[1..end].bytes().all(|c| c.is_ascii_hexdigit() || c == b':') { return false; }
        match &authority[end + 1..] { "" => (host, None), t if t.starts_with(':') => (host, Some(&t[1..])), _ => return false }
    } else {
        match authority.split_once(':') { Some((h, p)) => (h, Some(p)), None => (authority, None) }
    };
    if !host.starts_with('[') {
        let b = host.as_bytes();
        if b.is_empty() || !b[0].is_ascii_alphanumeric() || !b[b.len() - 1].is_ascii_alphanumeric()
            || !b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-')) { return false; }
    }
    if let Some(p) = port {
        if p.is_empty() || p.len() > 5 || !p.bytes().all(|c| c.is_ascii_digit()) || !matches!(p.parse::<u32>(), Ok(1..=65535)) { return false; }
    }
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    if !trimmed.is_empty() {
        for seg in trimmed.strip_prefix('/').unwrap_or("\0").split('/') {
            if seg.is_empty() || seg == "." || seg == ".." || !seg.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'~' | b'-')) { return false; }
        }
    }
    let host_lc = host.to_ascii_lowercase();
    if !https {
        let loopback = host_lc == "[::1]" || {
            let parts: Vec<&str> = host_lc.split('.').collect();
            parts.len() == 4 && parts[0] == "127" && parts.iter().all(|x| !x.is_empty() && x.len() <= 3 && x.bytes().all(|c| c.is_ascii_digit()) && (*x == "0" || !x.starts_with('0')) && x.parse::<u16>().is_ok_and(|n| n <= 255))
        };
        if !loopback { return false; }
    }
    // The WHATWG parse must leave the host exactly as written (lowercased): rejects 127.1, 0x7f.1, decimal IPs.
    let Ok(url) = tauri::Url::parse(raw) else { return false };
    url.username().is_empty() && url.password().is_none() && url.query().is_none() && url.fragment().is_none() && url.host_str() == Some(host_lc.as_str())
}
fn flow_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b':'))
}
/// Labels that travel to the daemon are measured as the daemon does (JS string length = UTF-16 units),
/// so Rust never accepts a label the daemon would refuse. Local-only names keep `label_ok`.
fn wire_label_ok(s: &str) -> bool {
    !s.trim().is_empty() && s.encode_utf16().count() <= 80 && !has_control(s)
}
fn label_ok(s: &str) -> bool {
    !s.trim().is_empty() && s.chars().count() <= 80 && !has_control(s)
}

pub fn parse_ui_command(payload: &Value) -> Result<UiCommand, CommandError> {
    let map: &Map<String, Value> = payload.as_object().ok_or(CommandError)?;
    let action = map.get("action").and_then(Value::as_str).ok_or(CommandError)?;
    let get = |k: &str| map.get(k).and_then(Value::as_str).ok_or(CommandError);
    let exact = |n: usize| if map.len() == n { Ok(()) } else { Err(CommandError) };
    let wire = |fields: &[(&str, &str)]| Ok(UiCommand::Wire(ordered(fields)));
    match action {
        "abito_account_save" | "abito_account_create" | "abito_account_endpoint_set" => parse_account(payload).map(UiCommand::Account),
        "view" => exact(1).map(|_| UiCommand::View),
        "refresh" => exact(1).map(|_| UiCommand::Refresh),
        // #310: one click connects a code agent. The id is an allowlist, so nothing the page sends can
        // name a path, a command or any other agent; the daemon does the install (with a backup).
        "agents_list" => {
            exact(1)?;
            wire(&[("type", "agents_list")])
        }
        // #414: the connected providers' catalogue for Ajustes → Modelos. Metadata only: the
        // engine answers with a `models` frame, folded into a bounded closed view below; no
        // provider filter, no inference, no credential ever travels.
        "models_list" => {
            exact(1)?;
            wire(&[("type", "models_list")])
        }
        // #360: the live agent sessions ticker. Read-only metadata only: the engine answers
        // with a `sessions` frame, folded into a bounded closed view below; no command line,
        // no path, no pid ever travels.
        "sessions_list" => {
            exact(1)?;
            wire(&[("type", "sessions_list")])
        }
        // #436 T6.5 (R4): the daemon's read-only hooks preview. One closed ask, no fields; the
        // engine answers with a `hooks` frame, folded into a bounded closed view below. There is
        // deliberately NO hooks_install / hooks_remove here: installing or removing from the UI
        // is out of scope, so the page has no way to even ask.
        "hooks_preview" => {
            exact(1)?;
            wire(&[("type", "hooks_preview")])
        }
        // K2-13 T6b-1 (S3/L17): «Hoy» is read-only to ask for, and a proposal is decided by its ID ALONE. `exact(2)`
        // is the PIN gate: the human removed it (L17), so a payload carrying `pin` — or any other stray field — is not
        // a command at all and never reaches the socket. The id must be the daemon's lowercase uuid.
        "hoy_list" => {
            exact(1)?;
            wire(&[("type", "hoy_list")])
        }
        "hoy_approve" | "hoy_reject" => {
            exact(2)?;
            let id = get("id")?;
            if !hoy_id(id) {
                return Err(CommandError);
            }
            wire(&[("type", action), ("id", id)])
        }
        "agent_connect" => {
            // The plan the human SAW travels back with the click; the engine previews again and refuses to apply
            // a different one. Optional (absent = the engine applies a fresh preview), and exactly 64 lowercase hex.
            let id = get("agentId")?;
            if !AGENT_IDS.contains(&id) {
                return Err(CommandError);
            }
            match map.get("plan_hash") {
                None => {
                    exact(2)?;
                    wire(&[("type", "agent_connect"), ("agentId", id)])
                }
                Some(h) => {
                    exact(3)?;
                    let hash = h.as_str().ok_or(CommandError)?;
                    if !plan_hash_ok(hash) {
                        return Err(CommandError);
                    }
                    wire(&[("type", "agent_connect"), ("agentId", id), ("plan_hash", hash)])
                }
            }
        }
        "agent_disconnect" => {
            exact(2)?; // a disconnect carries no plan: the engine previews the REMOVE plan itself
            let id = get("agentId")?;
            if !AGENT_IDS.contains(&id) {
                return Err(CommandError);
            }
            wire(&[("type", "agent_disconnect"), ("agentId", id)])
        }
        "connectors_list" | "settings_get" | "profile_deactivate" => {
            exact(1)?;
            wire(&[("type", action)])
        }
        // HU-041: the reviewed custom (LiteLLM / OpenAI-compatible) gateway. Name and Base URL only: the API key
        // travels the existing auth_start api_key / auth_reply path, never here. Same URL rule as the daemon.
        "custom_account_create" => {
            exact(3)?;
            let (label, url) = (get("label")?, get("baseUrl")?);
            if !wire_label_ok(label) || !custom_base_url_ok(url) {
                return Err(CommandError);
            }
            wire(&[("type", "custom_account_create"), ("label", label), ("baseUrl", url)])
        }
        "custom_endpoint_set" => {
            exact(3)?;
            let (id, url) = (get("accountId")?, get("baseUrl")?);
            if !strict_id(id) || !custom_base_url_ok(url) {
                return Err(CommandError);
            }
            wire(&[("type", "custom_endpoint_set"), ("accountId", id), ("baseUrl", url)])
        }
        "custom_models_refresh" => {
            exact(2)?;
            let id = get("accountId")?;
            if !strict_id(id) {
                return Err(CommandError);
            }
            wire(&[("type", "custom_models_refresh"), ("accountId", id)])
        }
        "account_create" => {
            exact(3)?;
            let (provider, label) = (get("provider")?, get("label")?);
            if !strict_id(provider) || !wire_label_ok(label) {
                return Err(CommandError);
            }
            wire(&[("type", "account_create"), ("provider", provider), ("label", label)])
        }
        "auth_start" => {
            exact(3)?;
            let (id, method) = (get("accountId")?, get("method")?);
            if !strict_id(id) || !matches!(method, "oauth" | "api_key") {
                return Err(CommandError);
            }
            wire(&[("type", "auth_start"), ("accountId", id), ("method", method)])
        }
        "auth_cancel" => {
            exact(2)?;
            let f = get("flowId")?;
            if !flow_id(f) {
                return Err(CommandError);
            }
            wire(&[("type", "auth_cancel"), ("flowId", f)])
        }
        "auth_reply" => {
            exact(4)?;
            let (f, p, v) = (get("flowId")?, get("promptId")?, get("value")?);
            if !flow_id(f) || !flow_id(p) || v.is_empty() || v.chars().count() > MAX_REPLY_CHARS || has_control(v) {
                return Err(CommandError);
            }
            Ok(UiCommand::AuthReply { flow_id: f.into(), prompt_id: p.into(), value: v.into() })
        }
        "account_logout" | "account_remove" => {
            exact(2)?;
            let id = get("accountId")?;
            if !strict_id(id) {
                return Err(CommandError);
            }
            wire(&[("type", action), ("accountId", id)])
        }
        "profile_select" => {
            exact(2)?;
            let id = get("id")?;
            if !strict_id(id) {
                return Err(CommandError);
            }
            wire(&[("type", "profile_select"), ("id", id)])
        }
        // K2-13 (S10/S20): the Telegram verbs Ajustes uses. The api id, the api hash, the phone, the code and the
        // password are validated here with the daemon's own rules and then travel in ONE line; none of them is stored in
        // this client (the state, the events and the logs never see them) and the session only ever comes back in the
        // `telegram_session` reply the fold parks for the host.
        "telegram_status" | "telegram_logout" | "transcription_get" => {
            exact(1)?;
            wire(&[("type", action)])
        }
        "telegram_login_start" => {
            exact(4)?;
            let api_id = map.get("apiId").and_then(Value::as_u64).filter(|n| (1..=TELEGRAM_API_ID_MAX).contains(n)).ok_or(CommandError)?;
            let (api_hash, phone) = (get("apiHash")?, get("phone")?);
            if !api_hash_ok(api_hash) || !phone_ok(phone) {
                return Err(CommandError);
            }
            Ok(UiCommand::Wire(format!(
                "{{\"type\":\"telegram_login_start\",\"apiId\":{api_id},\"apiHash\":{},\"phone\":{}}}\n",
                serde_json::to_string(api_hash).unwrap_or_default(),
                serde_json::to_string(phone).unwrap_or_default()
            )))
        }
        "telegram_login_code" => {
            exact(2)?;
            let code = get("code")?;
            if code.is_empty() || code.chars().count() > TELEGRAM_CODE_MAX || has_control(code) {
                return Err(CommandError);
            }
            wire(&[("type", "telegram_login_code"), ("code", code)])
        }
        "telegram_login_password" => {
            // The 2FA password is never stored, never logged and cleared from the page right after the round trip; only the
            // daemon's bound (1–1024 chars) and the absence of control characters are enforced here.
            exact(2)?;
            let password = get("password")?;
            if password.is_empty() || password.chars().count() > TELEGRAM_PASSWORD_MAX || has_control(password) {
                return Err(CommandError);
            }
            wire(&[("type", "telegram_login_password"), ("password", password)])
        }
        "telegram_session_restore" => {
            // The island's start-up hand-off of a session it already holds in the keychain. The session must satisfy the
            // daemon's carry contract BEFORE it goes on the wire, and the api id/api hash are its pair.
            exact(4)?;
            let api_id = map.get("apiId").and_then(Value::as_u64).filter(|n| (1..=TELEGRAM_API_ID_MAX).contains(n)).ok_or(CommandError)?;
            let (api_hash, session) = (get("apiHash")?, get("session")?);
            if !api_hash_ok(api_hash) || !carriable_session(session) {
                return Err(CommandError);
            }
            Ok(UiCommand::Wire(format!(
                "{{\"type\":\"telegram_session_restore\",\"apiId\":{api_id},\"apiHash\":{},\"session\":{}}}\n",
                serde_json::to_string(api_hash).unwrap_or_default(),
                serde_json::to_string(session).unwrap_or_default()
            )))
        }
        "transcription_set" => {
            // K2-13 (S7/S18): the setting is validated exactly as the daemon validates it (transcribe-setting.cjs), so a
            // frame it would refuse never leaves the WebView. Parakeet is the ONLY local mode: `local-whisper-turbo` is
            // not in the closed set, and an unknown key inside the setting refuses the whole command.
            exact(2)?;
            let setting = map.get("setting").and_then(Value::as_object).ok_or(CommandError)?;
            let mode = setting.get("mode").and_then(Value::as_str).and_then(|m| TRANSCRIPTION_MODES.iter().copied().find(|x| *x == m)).ok_or(CommandError)?;
            let language = match setting.get("language") {
                None => "es",
                Some(v) => v.as_str().and_then(|l| TRANSCRIPTION_LANGUAGES.iter().copied().find(|x| *x == l)).ok_or(CommandError)?,
            };
            let mut folded = serde_json::Map::new();
            folded.insert("mode".into(), Value::from(mode));
            folded.insert("language".into(), Value::from(language));
            match (mode, setting.get("remote")) {
                ("remote", Some(remote)) => {
                    let remote = remote.as_object().ok_or(CommandError)?;
                    if remote.len() != 2 || !remote.contains_key("accountId") || !remote.contains_key("model") {
                        return Err(CommandError);
                    }
                    let account = remote.get("accountId").and_then(Value::as_str).filter(|a| transcription_account_ok(a)).ok_or(CommandError)?;
                    let model = remote.get("model").and_then(Value::as_str).filter(|m| {
                        !m.trim().is_empty() && m.chars().count() <= TRANSCRIPTION_MODEL_MAX && !has_control(m)
                    }).ok_or(CommandError)?;
                    folded.insert("remote".into(), json!({"accountId": account, "model": model}));
                }
                ("local-parakeet", None) => {}
                // a remote without its account, or a local mode carrying one, is not a setting
                _ => return Err(CommandError),
            }
            // exactly `action` + `setting` at the top level, and no key inside the setting beyond the three allowed ones
            if setting.keys().any(|k| !matches!(k.as_str(), "mode" | "language" | "remote")) {
                return Err(CommandError);
            }
            let line = json!({"type": "transcription_set", "setting": Value::Object(folded)});
            Ok(UiCommand::Wire(format!("{}\n", serde_json::to_string(&line).map_err(|_| CommandError)?)))
        }
        _ => Err(CommandError),
    }
}

// ---- the view state the UI sees -----------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    NoDaemon,
    BadSession,
    Refused,
    Lost,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClientState {
    connection: String,
    providers: Vec<Value>,
    accounts: Vec<Value>,
    profiles: Value,
    auth: Value,
    connectors: Value,
    /// The engine's last refusal of a command: a code from its closed set and a counter, so the
    /// page can tell "an error arrived AFTER my command" without parsing any text.
    last_error: Value,
    /// The engine's `agents` frame, folded to a flat closed view (None until it speaks).
    agents: Value,
    /// #414: the engine's `models` frame (the connected providers' catalogue), folded to a
    /// bounded closed view (null until the engine answers a `models_list` ask).
    models: Value,
    /// #360: the engine's `sessions` frame (live agent sessions), folded to a bounded
    /// closed view (null until the engine answers a `sessions_list` ask).
    sessions: Value,
    /// #436 T6.5: the engine's `hooks` frame (the read-only hooks preview), folded to a
    /// bounded closed view (null until the engine answers a `hooks_preview` ask).
    hooks: Value,
    /// K2-13 T6b-1: the daemon's «Hoy» frame, folded to a bounded closed view
    /// (`{items, truncated}`, null until the daemon answers a `hoy_list` ask). The island renders
    /// these rows as plain text: nothing here is markup, and no field is invented.
    hoy: Value,
    /// K2-05 boot order (Gentle Dot `agent_state`): the engine's status from the daemon's
    /// `ready`/`agent_state` frames, closed set (`ready|starting|restarting|stopped|unavailable`);
    /// null until the daemon says so. The daemon answers before its engine is ready.
    engine: Value,
    /// K2-13 (S10): the daemon's `telegram_status`, folded to a bounded closed view
    /// (`{state, account?, notice?, retryAfterMinutes?}`, null until the daemon speaks). It never carries the phone,
    /// the api hash, the code, the password or the session.
    telegram: Value,
    /// K2-13 (S7/S18): the daemon's `transcription` setting, folded to a closed view
    /// (`{setting, ffmpeg, local}`), null until the daemon answers.
    transcription: Value,
    /// K2-13 (S20): the ONE `telegram_session` reply of this connection. It is a CREDENTIAL and is deliberately NOT
    /// serialised: `#[serde(skip)]` is the boundary that keeps it out of every `agent:state` event, so the WebView can
    /// only ever learn that a session arrived. The host drains it with [`ClientState::take_session`] and stores it in
    /// the OS keychain.
    #[serde(skip)]
    session: Option<String>,
}

/// A plan hash from the engine: exactly 64 lowercase hex characters.
pub fn plan_hash_ok(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// The closed template the engine prints for a plan: plain text, one line, bounded, no markup.
fn plan_summary_ok(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= 400 && !s.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | '`'))
}

/// HU-015: folds the two frames the daemon-free route prints (`agents-direct.cjs`) through the SAME closed rules as
/// the engine's own frames (`ClientState::apply`), and publishes them under their OWN keys so a frame pushed by the
/// daemon (`agents`/`hooks`) can never overwrite them. `None` when either frame does not fold into a list.
pub fn fold_direct(output: &Value) -> Option<Value> {
    let mut state = ClientState::connected();
    state.apply(output.get("agents")?).ok()?;
    state.apply(output.get("hooks")?).ok()?;
    if !state.agents.is_array() || !state.hooks.is_array() {
        return None;
    }
    Some(json!({"agentsRuntime": "ok", "directAgents": state.agents, "directHooks": state.hooks}))
}

/// The code agents the island can connect (the installers exist for these).
/// `statusline` (plan-usage relay) is the notify-only Claude Code integration the daemon
/// installs with the same preview / hash / backup flow (L32e). K2-03 removed the
/// weekly-summary integration: its id is no longer a closed agent id.
pub const AGENT_IDS: [&str; 6] = ["pi", "claude-code", "codex", "copilot-cli", "opencode", "statusline"];

/// #436 T6.5: the six hook clients the daemon's `hooks` frame may name (its own closed
/// list). Wider than AGENT_IDS on purpose: the page shows their state, and installs
/// nothing (read-only preview, UI install/remove is out of scope).
pub const HOOK_IDS: [&str; 6] = ["claude-code", "codex", "gemini-cli", "copilot-cli", "opencode", "amp"];
const HOOK_MECHANISMS: [&str; 2] = ["harness", "artifact"];
const HOOK_DETAILS: [&str; 10] = ["config_invalid", "not_writable", "backup_failed", "plan_changed", "audit_unavailable", "install_failed", "foreign_file", "unsafe_target", "unexpected_content", "unsupported_platform"];

fn clip(v: &Value, key: &str, max: usize) -> Value {
    v.get(key).and_then(Value::as_str).map(|s| Value::from(s.chars().filter(|c| !c.is_control()).take(max).collect::<String>())).unwrap_or(Value::Null)
}
fn https(v: &Value, key: &str) -> Value {
    match v.get(key).and_then(Value::as_str) {
        Some(u) if u.starts_with("https://") && u.len() <= 2000 && !has_control(u) => Value::from(u),
        _ => Value::Null,
    }
}

impl ClientState {
    fn new(connection: &str) -> ClientState {
        ClientState {
            connection: connection.into(),
            providers: vec![],
            accounts: vec![],
            profiles: json!({"profiles": [], "active": null}),
            auth: json!({"flowId": null, "prompt": null, "event": null, "last": null}),
            connectors: json!({"state": "loading", "items": []}),
            last_error: json!({"code": null, "n": 0}),
            agents: Value::Null,
            models: Value::Null,
            sessions: Value::Null,
            hooks: Value::Null,
            hoy: Value::Null,
            engine: Value::Null,
            telegram: Value::Null,
            transcription: Value::Null,
            session: None,
        }
    }
    /// Take the `telegram_session` this connection received, if any. Only the host calls this: the value goes to the OS
    /// keychain and never back into a view, an event or a log.
    pub fn take_session(&mut self) -> Option<String> {
        self.session.take()
    }
    /// Whether a `telegram_session` is waiting to be stored. The view says so as a boolean, never as the value.
    pub fn has_pending_session(&self) -> bool {
        self.session.is_some()
    }
    /// #490: the closed live-sessions view (`{rows, truncated}`, `Null` until the engine answers). The ONE
    /// accessor the phone link reads, so what the island shows and what the phone gets cannot drift apart.
    pub fn sessions_view(&self) -> &Value {
        &self.sessions
    }
    pub fn connected() -> ClientState {
        ClientState::new("connected")
    }
    pub fn disconnected(reason: Reason) -> ClientState {
        ClientState::new(match reason {
            Reason::NoDaemon => "no_daemon",
            Reason::BadSession => "bad_session",
            Reason::Refused => "refused",
            Reason::Lost => "lost",
        })
    }

    /// Local startup diagnostic in the existing error channel; never free text,
    /// paths, credentials or daemon wire errors. Connection stays `no_daemon`.
    pub fn note_startup_failure(&mut self, reason: crate::daemonhost::StartupFailure) {
        self.last_error = json!({"code": reason.code(), "n": 1});
    }

    pub fn note_connectors_error(&mut self, code: &str) {
        let state = if code == "unavailable" { "unavailable" } else { "failed" };
        self.connectors = json!({"state": state, "items": []});
    }

    /// Fold one server frame in. Unknown or malformed frames change nothing.
    pub fn apply(&mut self, frame: &Value) -> Result<(), ()> {
        let Some(t) = frame.get("type").and_then(Value::as_str) else { return Ok(()) };
        let items = |key: &str| frame.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        match t {
            "ready" | "agent_state" => {
                // K2-05 boot order: `ready` carries the state nested under "state"; `agent_state` flat.
                let s = frame.get("state").filter(|s| s.is_object()).unwrap_or(frame);
                self.engine = s.get("status").and_then(Value::as_str)
                    .filter(|s| matches!(*s, "ready" | "starting" | "restarting" | "stopped" | "unavailable"))
                    .map(Value::from).unwrap_or(Value::Null);
            }
            "providers" => {
                self.providers = items("providers").iter().take(100).map(|p| json!({
                    "id": clip(p, "id", 64), "name": clip(p, "name", 120), "configured": p.get("configured").and_then(Value::as_bool).unwrap_or(false),
                    "methods": p.get("methods").and_then(Value::as_array).map(|m| m.iter().filter_map(Value::as_str).filter(|x| matches!(*x, "oauth" | "api_key")).collect::<Vec<_>>()).unwrap_or_default(),
                })).collect();
            }
            "accounts" => {
                self.accounts = items("accounts").iter().take(100).map(account_view).collect();
            }
            "account" => {
                if let Some(a) = frame.get("account") {
                    let v = account_view(a);
                    match self.accounts.iter_mut().find(|x| x["accountId"] == v["accountId"]) {
                        Some(slot) => *slot = v,
                        None => self.accounts.push(v),
                    }
                }
            }
            "profiles" => {
                self.profiles = json!({
                    "profiles": items("profiles").iter().take(64).map(|p| json!({"id": clip(p, "id", 64), "label": clip(p, "label", 80), "provider": clip(p, "provider", 64), "modelId": clip(p, "modelId", 200)})).collect::<Vec<_>>(),
                    "active": clip(frame, "active", 64),
                });
            }
            "auth_started" => {
                self.auth = json!({"flowId": clip(frame, "flowId", 128), "prompt": null, "event": null, "last": null});
            }
            "auth_prompt" => {
                let options: Vec<Value> = items("options").iter().take(20).map(|o| json!({"id": clip(o, "id", 128), "label": clip(o, "label", 200)})).collect();
                self.auth["prompt"] = json!({
                    "flowId": clip(frame, "flowId", 128), "promptId": clip(frame, "promptId", 128), "accountId": clip(frame, "accountId", 64),
                    "kind": clip(frame, "kind", 32), "message": clip(frame, "message", 1000), "placeholder": clip(frame, "placeholder", 200),
                    "secret": frame.get("secret").and_then(Value::as_bool).unwrap_or(false), "options": options,
                });
            }
            "auth_event" => {
                self.auth["event"] = json!({
                    "kind": clip(frame, "kind", 32), "message": clip(frame, "message", 1000), "instructions": clip(frame, "instructions", 1000),
                    "userCode": clip(frame, "userCode", 100), "url": https(frame, "url"), "verificationUri": https(frame, "verificationUri"),
                });
            }
            "auth_done" => {
                self.auth["prompt"] = Value::Null;
                self.auth["event"] = Value::Null;
                self.auth["last"] = json!({
                    "accountId": clip(frame, "accountId", 64), "ok": frame.get("ok").and_then(Value::as_bool).unwrap_or(false),
                    "cancelled": frame.get("cancelled").and_then(Value::as_bool).unwrap_or(false), "message": clip(frame, "message", 300),
                });
            }
            "connectors" => {
                let rows: Vec<Value> = items("connectors").iter().take(128).map(|c| json!({
                    "id": clip(c, "id", 64), "label": clip(c, "label", 128), "mode": clip(c, "mode", 32),
                    "enabled": c.get("enabled").and_then(Value::as_bool).unwrap_or(false), "configured": c.get("configured").and_then(Value::as_bool).unwrap_or(false),
                    "status": c.get("status").map(|s| clip(s, "state", 32)).unwrap_or(Value::Null),
                })).collect();
                self.connectors = json!({"state": "ready", "items": rows});
            }
            "agents" => {
                // Only the three known ids, one entry each (the first wins), a closed state and a closed
                // detail. No name, path or hook line from the engine is ever forwarded to the page.
                let Some(list) = frame.get("agents").and_then(Value::as_array) else { return Ok(()) };
                let mut seen: Vec<&str> = Vec::new();
                let mut out: Vec<Value> = Vec::new();
                for a in list.iter().take(64) {
                    let Some(id) = a.get("id").and_then(Value::as_str).and_then(|i| AGENT_IDS.iter().copied().find(|k| *k == i)) else { continue };
                    if seen.contains(&id) {
                        continue;
                    }
                    seen.push(id);
                    let state = match a.get("state").and_then(Value::as_str) {
                        Some(x @ ("not_connected" | "connected" | "outdated" | "working" | "unavailable" | "error")) => x,
                        _ => "error",
                    };
                    let detail = match a.get("detail").and_then(Value::as_str) {
                        Some(d @ ("config_invalid" | "not_writable" | "backup_failed" | "plan_changed" | "audit_unavailable" | "install_failed" | "unsupported_platform" | "unsafe_target" | "install_unverified" | "foreign_extension" | "unsafe_folder")) => json!(d),
                        _ => Value::Null,
                    };
                    // the plan exists only for a state that offers a button, and only when BOTH parts look like ours
                    let offers = matches!(state, "not_connected" | "outdated") || (state == "error" && detail == json!("plan_changed"));
                    let hash = a.get("plan_hash").and_then(Value::as_str).filter(|h| plan_hash_ok(h));
                    let summary = a.get("summary").and_then(Value::as_str).filter(|t| plan_summary_ok(t));
                    let (plan_hash, plan_summary) = match (offers, hash, summary) {
                        (true, Some(h), Some(t)) => (json!(h), json!(t)),
                        _ => (Value::Null, Value::Null),
                    };
                    // HU-047: the refused folder travels only with its closed reason and only for that detail (the user's own path, bounded).
                    let folder = a.get("folder").and_then(Value::as_str).filter(|f| detail == json!("unsafe_folder") && !f.is_empty() && f.chars().count() <= 400 && !has_control(f));
                    let folder_reason = a.get("folder_reason").and_then(Value::as_str).filter(|r| matches!(*r, "writable" | "foreign_owner" | "acl"));
                    let (folder, folder_reason) = match (folder, folder_reason) { (Some(f), Some(r)) => (json!(f), json!(r)), _ => (Value::Null, Value::Null) };
                    let mut entry = json!({
                        "id": id, "state": state, "backup": a.get("backup").and_then(Value::as_bool).unwrap_or(false), "detail": detail,
                        "plan_hash": plan_hash, "summary": plan_summary,
                        "reviewable": a.get("reviewable").and_then(Value::as_bool).unwrap_or(true),
                        "trust_review": a.get("trust_review").and_then(Value::as_bool).unwrap_or(false),
                    });
                    if !folder.is_null() { entry["folder"] = folder; entry["folder_reason"] = folder_reason; }
                    out.push(entry);

                }
                self.agents = Value::Array(out);
            }
            "hoy" => {
                // K2-13 T6b-1 (S2/S3/S5): «Hoy» is what the DAEMON stored, folded row by row. A row is rebuilt field
                // by field and anything off the closed vocabulary DROPS the row (never sanitised into a lie); text
                // loses control + bidi characters; a `proposal` without a real action and target cannot exist. What
                // never reaches the page: any other field the frame carried, and any row past the 100-item cap.
                let Some(list) = frame.get("items").and_then(Value::as_array) else { return Ok(()) };
                let truncated = frame.get("truncated").and_then(Value::as_bool).unwrap_or(false);
                let mut items: Vec<Value> = Vec::new();
                for i in list.iter().take(MAX_HOY_ITEMS) {
                    let Some(kind) = closed_cell(i, "kind", &HOY_KINDS) else { continue };
                    let Some(status) = closed_cell(i, "status", &HOY_STATUSES) else { continue };
                    let (Some(id), Some(minikoda)) = (
                        i.get("id").and_then(Value::as_str).filter(|s| hoy_id(s)),
                        i.get("minikoda").and_then(Value::as_str).filter(|s| strict_id(s)),
                    ) else { continue };
                    let mut row = json!({
                        "id": id, "minikoda": minikoda, "kind": kind, "status": status,
                        "text": hoy_text(i, "text", MAX_HOY_TEXT), "createdAt": iso_cell(i, "createdAt"),
                    });
                    if kind == "proposal" {
                        let (Some(action), target) = (closed_cell(i, "action", &HOY_ACTIONS), hoy_text(i, "target", 200)) else { continue };
                        if !target.is_string() { continue; }
                        row["action"] = json!(action);
                        row["target"] = target;
                    }
                    if let Some(p) = closed_cell(i, "provenance", &HOY_PROVENANCE) { row["provenance"] = json!(p); }
                    if let Value::String(d) = iso_cell(i, "decidedAt") { row["decidedAt"] = json!(d); }
                    items.push(row);
                }
                self.hoy = json!({"items": items, "truncated": truncated});
            }
            "hoy_decided" | "hoy_approved" => {
                // One decision, folded in place: the daemon said so (never the click). A decision for a row we do not
                // hold invents nothing; `hoy_approved` is the ONE execution record, so it means `approved`; `pending` is
                // a status and never a decision (F3).
                let (Some(id), Some(status)) = (frame.get("id").and_then(Value::as_str).filter(|s| hoy_id(s)),
                    if t == "hoy_approved" { Some("approved") } else { closed_cell(frame, "status", &["approved", "rejected"]) })
                else { return Ok(()) };
                let Some(list) = self.hoy.get_mut("items").and_then(Value::as_array_mut) else { return Ok(()) };
                for row in list.iter_mut() {
                    if row.get("id").and_then(Value::as_str) != Some(id) || row.get("kind").and_then(Value::as_str) != Some("proposal") { continue; }
                    // a decision is FINAL: only a pending row can be decided, and a second frame never re-decides it.
                    // The execution record of the SAME decision may still arrive and stamp its time.
                    let current = row.get("status").and_then(Value::as_str);
                    if current == Some("pending") { row["status"] = json!(status); }
                    else if current != Some(status) { continue; }
                    if let Value::String(at) = iso_cell(frame, "executedAt") { row["decidedAt"] = json!(at); }
                }
            }
            "models" => {
                // #414: the connected providers' catalogue, a bounded closed view: only rows with a
                // slug-shaped provider and id survive, names are clipped text, and nothing else the
                // frame carried (no endpoint, no pricing, no raw provider payload) reaches the page.
                let Some(list) = frame.get("models").and_then(Value::as_array) else { return Ok(()) };
                let slug = |s: &str| {
                    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/' | b':'))
                };
                self.models = Value::Array(list.iter().take(2000).filter_map(|m| {
                    let provider = clip(m, "provider", 64);
                    let id = clip(m, "id", 200);
                    let (Some(provider), Some(id)) = (provider.as_str(), id.as_str()) else { return None };
                    if !slug(provider) || !slug(id) {
                        return None;
                    }
                    Some(json!({
                        "provider": provider, "id": id, "name": clip(m, "name", 200),
                        "reasoning": m.get("reasoning").and_then(Value::as_bool).unwrap_or(false),
                        "contextWindow": m.get("contextWindow").and_then(Value::as_i64).unwrap_or(0),
                    }))
                }).collect());
            }
            "sessions" => {
                // #360: the live agent sessions' closed projection. A foreign schema, a malformed
                // frame or a row off-vocabulary changes nothing; rows are rebuilt field by field
                // and the 64-row cap is the client's too. Nothing but the five closed fields and
                // the frame's own truncation flag ever reaches the page: no command line, no path,
                // no pid.
                if frame.get("schema").and_then(Value::as_str) != Some(SESSIONS_SCHEMA) { return Ok(()); }
                let Some(truncated) = frame.get("truncated").and_then(Value::as_bool) else { return Ok(()) };
                let Some(list) = frame.get("sessions").and_then(Value::as_array) else { return Ok(()) };
                let kinds = ["pi", "claude-code", "codex", "opencode", "gemini"];
                let states = ["running", "sleeping", "stopped", "zombie", "unknown"];
                // derived anonymous id: s- + exactly 8 lowercase hex (never a raw pid)
                let derived_id = |s: &str| s.len() == 10 && s.starts_with("s-") && s[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
                // A cell is None when the field is absent or null (honest unknown) and the ROW is
                // dropped when a present cell is invalid: never sanitized into a lie.
                let cell = |r: &Value, key: &str, max: usize| -> Option<Option<String>> {
                    match r.get(key) {
                        None | Some(Value::Null) => Some(None),
                        Some(v) => match v.as_str() {
                            Some(s) if !s.is_empty() && s.chars().count() <= max && !s.contains('/') && !s.chars().any(|c| c.is_control()) => Some(Some(s.to_string())),
                            _ => None,
                        },
                    }
                };
                let rows: Vec<Value> = list.iter().take(64).filter_map(|r| {
                    let (Some(id), Some(kind), Some(state), Some(cwd), Some(origin)) = (
                        r.get("id").and_then(Value::as_str).filter(|s| derived_id(s)),
                        r.get("kind").and_then(Value::as_str).filter(|k| kinds.contains(k)),
                        r.get("state").and_then(Value::as_str).filter(|s| states.contains(s)),
                        cell(r, "cwd", 64),
                        cell(r, "origin", 32),
                    ) else { return None };
                    let mut row = json!({"id": id, "kind": kind, "cwd": cwd, "state": state, "origin": origin});
                    if let Some(tools) = r.get("tools").and_then(session_tools_view) { row["tools"] = tools; }
                    Some(row)
                }).collect();
                let mut view = json!({"rows": rows, "truncated": truncated});
                // The real number of sessions when the list was cut: only when truncated and only a
                // sane integer (at least the rows kept, at most the scanner's bound); else absent.
                if truncated {
                    if let Some(total) = frame.get("total").and_then(Value::as_u64).filter(|t| (rows.len() as u64..=4096).contains(t)) {
                        view["total"] = json!(total);
                    }
                }
                self.sessions = view;
            }
            "hooks" => {
                // #436 T6.5: the read-only hooks preview, folded like the sessions arm: rows are
                // rebuilt field by field, a present cell off its closed vocabulary drops the ROW
                // (never sanitized into a lie), the first entry wins per id and the 8-row cap is
                // the client's too. What never reaches the page: the daemon's name, paths, diffs,
                // plan hashes and the install/remove plans themselves.
                let Some(list) = frame.get("clients").and_then(Value::as_array) else { return Ok(()) };
                let mut seen: Vec<&str> = Vec::new();
                let mut out: Vec<Value> = Vec::new();
                for c in list.iter().take(8) {
                    let (Some(id), Some(state), Some(mechanism)) = (
                        c.get("id").and_then(Value::as_str).and_then(|i| HOOK_IDS.iter().copied().find(|k| *k == i)),
                        c.get("state").and_then(Value::as_str).filter(|s| matches!(*s, "not_connected" | "connected" | "outdated" | "working" | "unavailable" | "error")),
                        c.get("mechanism").and_then(Value::as_str).filter(|m| HOOK_MECHANISMS.contains(m)),
                    ) else { continue };
                    if seen.contains(&id) { continue; }
                    seen.push(id);
                    let detail = c.get("detail").and_then(Value::as_str).filter(|d| HOOK_DETAILS.contains(d));
                    out.push(json!({
                        "id": id, "state": state, "mechanism": mechanism, "detail": detail,
                        "backup": c.get("backup").and_then(Value::as_bool).unwrap_or(false),
                    }));
                }
                self.hooks = Value::Array(out);
            }
            "telegram_status" => {
                // K2-13 (S10/S20): the public account state, rebuilt field by field. Nothing else the frame carried reaches
                // the page, and there is no phone, api hash, code, password or session in it by construction.
                let Some(state) = closed_cell(frame, "state", &TELEGRAM_STATES) else { return Ok(()) };
                let mut view = json!({"state": state});
                if let Some(account) = frame.get("account").filter(|a| a.is_object()) {
                    let name = clip(account, "name", TELEGRAM_NAME_MAX);
                    let username = match account.get("username").and_then(Value::as_str) {
                        Some(u) if !u.is_empty() && u.len() <= TELEGRAM_USERNAME_MAX && u.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') => Value::from(u),
                        _ => Value::Null,
                    };
                    if name.is_string() {
                        view["account"] = json!({"name": name, "username": username});
                    }
                }
                // Koda's own Spanish sentence (the daemon writes it; Telegram's raw text never travels).
                if let Some(notice) = frame.get("notice").and_then(Value::as_str).filter(|n| !n.is_empty() && n.chars().count() <= 300 && !has_control(n)) {
                    view["notice"] = json!(notice);
                }
                if let Some(m) = frame.get("retryAfterMinutes").and_then(Value::as_u64).filter(|m| (1..=1440).contains(m)) {
                    view["retryAfterMinutes"] = json!(m);
                }
                self.telegram = view;
            }
            "telegram_session" => {
                // S20: this frame is the ONLY carrier of the session, and it is a reply to our own login. It is parked for the
                // host (which stores it in the OS keychain) and NEVER folded into the view: the page must not be able to read
                // a credential, not even out of a state event.
                let Some(session) = frame.get("session").and_then(Value::as_str).filter(|s| carriable_session(s)) else { return Ok(()) };
                self.session = Some(session.to_owned());
            }
            "transcription" => {
                // K2-13 (S7/S18): the global setting plus whether the bundled tools are there. A frame whose mode, language,
                // remote or tool state is off the closed vocabulary changes nothing (never sanitised into a lie).
                let Some(setting) = frame.get("setting").filter(|s| s.is_object()) else { return Ok(()) };
                let Some(mode) = closed_cell(setting, "mode", &TRANSCRIPTION_MODES) else { return Ok(()) };
                let language = closed_cell(setting, "language", &TRANSCRIPTION_LANGUAGES);
                let mut folded = json!({"mode": mode, "language": language});
                if mode == "remote" {
                    let Some(remote) = setting.get("remote").filter(|r| r.is_object()) else { return Ok(()) };
                    let Some(account) = remote.get("accountId").and_then(Value::as_str).filter(|a| transcription_account_ok(a)) else { return Ok(()) };
                    let Some(model) = remote.get("model").and_then(Value::as_str).filter(|m| {
                        !m.trim().is_empty() && m.chars().count() <= TRANSCRIPTION_MODEL_MAX && !has_control(m)
                    }) else { return Ok(()) };
                    folded["remote"] = json!({"accountId": account, "model": model});
                }
                let tool = |key: &str| closed_cell(frame, key, &["available", "unavailable"]);
                let (Some(ffmpeg), Some(local)) = (tool("ffmpeg"), tool("local")) else { return Ok(()) };
                self.transcription = json!({"setting": folded, "ffmpeg": ffmpeg, "local": local});
            }
            "error" => {
                // the daemon's closed code set (anything else reads as plain `failed`), never free text
                let code = match frame.get("code").and_then(Value::as_str) {
                    Some(c @ ("bad_request" | "busy" | "not_busy" | "unavailable" | "rate_limited" | "unknown_ask" | "failed" | "store_not_private"
                        | "paused" | "unknown_minikoda" | "not_active" | "not_pending" | "exists" | "limit" | "model_unavailable" | "unknown_item"
                        // K2-13 Telegram (S10/S20): the daemon's closed set; each code has a sentence of ours in the page.
                        | "telegram_unavailable" | "telegram_already_connected" | "telegram_not_awaiting_code" | "telegram_not_awaiting_password"
                        | "telegram_credentials_invalid" | "telegram_code_invalid" | "telegram_password_invalid" | "telegram_password_required"
                        | "telegram_flood_wait" | "telegram_session_invalid" | "telegram_cancelled" | "telegram_login_other_connection"
                        | "telegram_failed" | "telegram_not_connected" | "telegram_channel_invalid")) => c,
                    _ => "failed",
                };
                let n = self.last_error["n"].as_u64().unwrap_or(0) + 1;
                self.last_error = json!({"code": code, "n": n});
                if frame.get("code").and_then(Value::as_str) == Some("unavailable") && self.connectors["state"] == "loading" {
                    self.note_connectors_error("unavailable");
                }
            }
            _ => {}
        }
        Ok(())
    }
}

fn account_view(a: &Value) -> Value {
    let mut v = json!({
        "accountId": clip(a, "accountId", 64), "label": clip(a, "label", 80), "provider": clip(a, "provider", 64),
        "authMethod": match a.get("authMethod").and_then(Value::as_str) { Some(m @ ("oauth" | "api_key")) => m, _ => "none" },
        "configured": a.get("configured").and_then(Value::as_bool).unwrap_or(false),
    });
    if a.get("local").and_then(Value::as_bool) == Some(true) {
        v["local"] = json!(true);
    }
    v
}

// ---- Abito-owned accounts (never daemon frames) ---------------------------------------
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AccountConfig {
    nombre: String,
    base_url: String,
    api: String,
    compat: std::collections::BTreeMap<String, bool>,
    models: Vec<String>,
    default_model: String,
    // Legacy disk input / write-only command input. Never persist a credential.
    #[serde(default, skip_serializing)]
    api_key: Option<String>,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AccountRecord {
    account_id: String, provider: String, config: AccountConfig,
    #[serde(default)]
    credential_ref: Option<String>,
}

fn shared_credential_ref(id: &str) -> Option<&'static str> {
    match id {
        "key-anthropic" => Some("anthropic-api-key"),
        "key-google" => Some("google-api-key"),
        "key-openai" => Some("openai-api-key"),
        "key-openrouter" => Some("openrouter-api-key"),
        "key-nan" => Some("nan-api-key"),
        "key-opencodego" => Some("opencode-go-api-key"),
        _ => None,
    }
}
fn credential_ref(id: &str) -> String {
    shared_credential_ref(id).map(str::to_owned).unwrap_or_else(|| format!("account-{id}"))
}
fn owned_reference(reference: &str) -> bool {
    reference.strip_prefix("account-").is_some_and(|id| strict_id(id) && !id.starts_with("key-"))
        || reference.strip_prefix("account-").and_then(|s| s.rsplit_once('-')).is_some_and(|(id, suffix)| {
            strict_id(id) && !id.starts_with("key-") && hex_suffix(suffix)
        })
}
fn hex_suffix(s: &str) -> bool {
    s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn account_reference_ok(id: &str, reference: &str) -> bool {
    if let Some(shared) = shared_credential_ref(id) { return reference == shared; }
    let legacy = format!("account-{id}");
    !id.starts_with("key-") && (reference == legacy || reference.strip_prefix(&format!("{legacy}-")).is_some_and(hex_suffix))
}
fn new_owned_reference(id: &str) -> Result<String, crate::bridge::BridgeError> {
    #[cfg(target_os = "linux")]
    {
        use ring::rand::SecureRandom;
        let mut bytes = [0u8; 4];
        ring::rand::SystemRandom::new().fill(&mut bytes).map_err(|_| account_error("save_failed"))?;
        return Ok(format!("account-{id}-{:08x}", u32::from_be_bytes(bytes)));
    }
    // Other targets have no directly declared RNG. This is a uniqueness token,
    // not a secret; the caller also checks journal, live refs and keychain collisions.
    #[cfg(not(target_os = "linux"))]
    {
        use std::hash::{Hash, Hasher};
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos().hash(&mut hash);
        std::process::id().hash(&mut hash);
        NEXT.fetch_add(1, Ordering::Relaxed).hash(&mut hash);
        Ok(format!("account-{id}-{:08x}", hash.finish() as u32))
    }
}
fn valid_account_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 4096 && !key.chars().any(char::is_whitespace) && !has_control(key)
}

pub struct AccountCommand { action: String, record: AccountRecord, keep_key: bool }
impl fmt::Debug for AccountCommand {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("AccountCommand(<redacted>)") }
}

pub fn is_account_action(payload: &Value) -> bool {
    matches!(payload.get("action").and_then(Value::as_str), Some("abito_account_save" | "abito_account_create" | "abito_account_endpoint_set" | "abito_account_remove"))
}

fn account_url(raw: &str, local: bool) -> bool {
    // Reject before URL normalization: Unicode/IDN, encoded authority, credentials,
    // whitespace, backslashes and browser-specific host spellings are never repaired.
    if raw.len() > 2048 || !raw.is_ascii() || raw.bytes().any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        || raw.contains(['\\', '@', '?', '#']) { return false; }
    let prefix = if local { "http://" } else { "https://" };
    let Some(rest) = raw.strip_prefix(prefix) else { return false };
    let authority = rest.split('/').next().unwrap_or("");
    if authority.is_empty() || authority.contains('%') { return false; }
    let Ok(url) = tauri::Url::parse(raw) else { return false };
    let Some(host) = url.host_str() else { return false };
    if !url.username().is_empty() || url.password().is_some() || url.port() == Some(0) { return false; }
    // A canonical authority prevents numeric shorthand, trailing dots and empty ports.
    let canonical = match url.port() { Some(p) => format!("{host}:{p}"), None => host.to_string() };
    let default_port = if local { ":80" } else { ":443" };
    if authority != canonical && !(url.port().is_none() && authority == format!("{host}{default_port}")) { return false; }
    if local { return matches!(host, "localhost" | "127.0.0.1" | "[::1]"); }
    if host == "localhost" || host.ends_with(".localhost") { return false; }
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<std::net::IpAddr>() {
        // IPv6 classification does not unwrap IPv4-mapped loopback/unspecified addresses.
        let ip = match ip {
            std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped().map(std::net::IpAddr::V4).unwrap_or(ip),
            other => other,
        };
        return !ip.is_loopback() && !ip.is_unspecified();
    }
    host.len() <= 253 && host.split('.').all(|label| {
        !label.is_empty() && label.len() <= 63 && !label.starts_with("xn--")
            && !label.starts_with('-') && !label.ends_with('-')
            && label.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    })
}

fn parse_account(payload: &Value) -> Result<AccountCommand, CommandError> {
    let map = payload.as_object().ok_or(CommandError)?;
    if map.len() != 4 || !is_account_action(payload) { return Err(CommandError); }
    let account_id = map.get("accountId").and_then(Value::as_str).filter(|s| strict_id(s)).ok_or(CommandError)?;
    let provider = map.get("provider").and_then(Value::as_str).filter(|s| strict_id(s)).ok_or(CommandError)?;
    let config = map.get("config").and_then(Value::as_object).ok_or(CommandError)?;
    let keep_key = !config.contains_key("apiKey");
    if !keep_key && shared_credential_ref(account_id).is_some() { return Err(CommandError); }
    let config: AccountConfig = serde_json::from_value(Value::Object(config.clone())).map_err(|_| CommandError)?;
    let local = matches!(provider, "ollama" | "lmstudio");
    // HU-041: 'custom' is created/edited only through the daemon's reviewed custom_* gateway (see parse_ui_command).
    if provider == "custom" { return Err(CommandError); }
    if !label_ok(&config.nombre) || !account_url(&config.base_url, local)
        || !matches!(config.api.as_str(), "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai")
        || config.compat.len() > 16 || config.compat.keys().any(|s| s.is_empty() || s.len() > 64 || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
        || config.models.is_empty() || config.models.len() > 64
        || config.models.iter().any(|s| s.is_empty() || s.len() > 200 || s.trim() != s || has_control(s))
        || !config.models.contains(&config.default_model)
        || config.api_key.as_ref().is_some_and(|s| !valid_account_key(s)) {
        return Err(CommandError);
    }
    let unique: std::collections::HashSet<_> = config.models.iter().collect();
    if unique.len() != config.models.len() { return Err(CommandError); }
    Ok(AccountCommand { action: map["action"].as_str().unwrap().into(),
        record: AccountRecord { account_id: account_id.into(), provider: provider.into(), config,
            credential_ref: Some(credential_ref(account_id)) }, keep_key })
}

/// Single host-owned store, protected by SettingsHost's transaction mutex.
/// The disk representation is deliberately NOT Debug or a public response.
pub struct AccountStore {
    path: std::path::PathBuf,
    records: Vec<AccountRecord>,
    pending_cleanup: Vec<String>,
    secrets: std::sync::Arc<dyn crate::secrets::SecretStore + Send + Sync>,
}
impl AccountStore {
    pub fn load(path: std::path::PathBuf, secrets: std::sync::Arc<dyn crate::secrets::SecretStore + Send + Sync>) -> Result<Self, crate::bridge::BridgeError> {
        use std::io::Read;
        let mut records = Vec::new();
        let mut pending_cleanup = Vec::new();
        match std::fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err(account_error("store_unavailable")),
            Ok(meta) => {
                if !private_account_file(&meta) { return Err(account_error("store_unavailable")); }
                let mut options = std::fs::OpenOptions::new(); options.read(true);
                #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NOFOLLOW); }
                let file = options.open(&path).map_err(|_| account_error("store_unavailable"))?;
                if !file.metadata().is_ok_and(|m| private_account_file(&m)) { return Err(account_error("store_unavailable")); }
                let mut bytes = Vec::new();
                file.take(1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| account_error("store_unavailable"))?;
                if bytes.len() > 1024 * 1024 { return Err(account_error("store_unavailable")); }
                let disk: AccountDisk = serde_json::from_slice(&bytes).map_err(|_| account_error("store_unavailable"))?;
                if disk.version != 1 || disk.accounts.len() > 64 || disk.pending_cleanup.len() > 64 { return Err(account_error("store_unavailable")); }
                pending_cleanup = disk.pending_cleanup;
                let mut ids = std::collections::HashSet::new();
                for record in disk.accounts {
                    if record.credential_ref.as_ref().is_some_and(|r| !account_reference_ok(&record.account_id, r))
                        || record.config.api_key.as_ref().is_some_and(|k| !valid_account_key(k)) {
                        return Err(account_error("store_unavailable"));
                    }
                    // Serialization intentionally omits the legacy key. Validate all records
                    // before touching the keychain, retaining migration input only in memory.
                    let payload = json!({"action":"abito_account_create", "accountId":record.account_id,
                        "provider":record.provider,"config":record.config});
                    let mut parsed = parse_account(&payload).map_err(|_| account_error("store_unavailable"))?;
                    if !ids.insert(parsed.record.account_id.clone()) { return Err(account_error("store_unavailable")); }
                    parsed.record.credential_ref = record.credential_ref.or_else(|| {
                        if record.config.api_key.is_some() { Some(credential_ref(&record.account_id)) }
                        else { shared_credential_ref(&record.account_id).map(str::to_owned) }
                    });
                    parsed.record.config.api_key = record.config.api_key;
                    records.push(parsed.record);
                }
            }
        }
        let mut seen = std::collections::HashSet::new();
        if pending_cleanup.iter().any(|r| !owned_reference(r) || !seen.insert(r.clone())
            || records.iter().any(|a| a.credential_ref.as_ref() == Some(r))) {
            return Err(account_error("store_unavailable"));
        }
        let mut store = Self { path, records, pending_cleanup, secrets };
        let migrating = store.records.iter().any(|r| r.config.api_key.is_some());
        if migrating {
            for record in &store.records {
                if let Some(key) = &record.config.api_key {
                    let reference = record.credential_ref.as_deref().expect("validated reference");
                    let shared = shared_credential_ref(&record.account_id).is_some();
                    let existing = if shared {
                        store.secrets.read(reference).map_err(|_| account_error("keychain_unavailable"))?
                    } else { None };
                    if existing.is_none() {
                        store.secrets.write(reference, key).map_err(|_| account_error("keychain_unavailable"))?;
                    }
                }
            }
            // No file write (not even a temporary file) until EVERY secret is safe.
            store.persist(&store.records, &store.pending_cleanup).map_err(|_| account_error("save_failed"))?;
            for record in &mut store.records { record.config.api_key = None; }
        }
        store.sweep();
        Ok(store)
    }
    // Only journaled, unreferenced owned entries are eligible. Failed deletion or
    // persistence retains the intent for an idempotent retry on the next load.
    fn sweep(&mut self) {
        for reference in self.pending_cleanup.clone() {
            if self.records.iter().any(|r| r.credential_ref.as_ref() == Some(&reference)) { continue; }
            if self.secrets.delete(&reference).is_ok() {
                let next: Vec<_> = self.pending_cleanup.iter().filter(|r| **r != reference).cloned().collect();
                if self.persist(&self.records, &next).is_ok() { self.pending_cleanup = next; }
            }
        }
    }
    fn commit(&mut self, records: Vec<AccountRecord>, pending: Vec<String>) -> Result<(), crate::bridge::BridgeError> {
        if pending.len() > 64 { return Err(account_error("save_failed")); }
        self.persist(&records, &pending).map_err(|_| account_error("save_failed"))?;
        self.records = records;
        self.pending_cleanup = pending;
        Ok(())
    }
    fn cleanup(&mut self, reference: Option<String>) -> Result<(), crate::bridge::BridgeError> {
        if let Some(reference) = reference {
            self.secrets.delete(&reference).map_err(|_| account_error("keychain_unavailable"))?;
            let pending = self.pending_cleanup.iter().filter(|r| **r != reference).cloned().collect();
            self.commit(self.records.clone(), pending)?;
        }
        Ok(())
    }
    pub fn view(&self) -> Value {
        let accounts: Vec<_> = self.records.iter().map(|r| json!({
            "accountId":r.account_id,"provider":r.provider,"hasCredential":r.credential_ref.as_deref()
                .and_then(|key| self.secrets.read(key).ok().flatten()).is_some_and(|key| !key.is_empty()),
            "config":{"nombre":r.config.nombre,"baseUrl":r.config.base_url,"api":r.config.api,
                "compat":r.config.compat,"models":r.config.models,"defaultModel":r.config.default_model}
        })).collect();
        json!({"accounts":accounts})
    }
    fn remove(&mut self, account_id: &str, publish: impl FnOnce(Value)) -> Result<Value, crate::bridge::BridgeError> {
        let at = self.records.iter().position(|r| r.account_id == account_id).ok_or_else(|| account_error("account_missing"))?;
        let owned_ref = self.records[at].credential_ref.clone().filter(|r| owned_reference(r));
        let mut next = self.records.clone(); next.remove(at);
        let mut pending = self.pending_cleanup.clone();
        if let Some(reference) = &owned_ref { pending.push(reference.clone()); }
        self.commit(next, pending)?;
        self.cleanup(owned_ref)?;
        let snapshot = self.view();
        publish(snapshot.clone());
        Ok(snapshot)
    }
    pub fn command(&mut self, payload: &Value, publish: impl FnOnce(Value)) -> Result<Value, crate::bridge::BridgeError> {
        if payload.get("action").and_then(Value::as_str) == Some("abito_account_remove") {
            // closed schema: exactly {action, accountId}
            let map = payload.as_object().filter(|m| m.len() == 2);
            let id = map.and_then(|m| m.get("accountId")).and_then(Value::as_str).filter(|s| strict_id(s));
            return match id { Some(id) => self.remove(id, publish), None => Err(account_error("invalid_account")) };
        }
        let mut command = parse_account(payload).map_err(|_| account_error("invalid_account"))?;
        let at = self.records.iter().position(|r| r.account_id == command.record.account_id);
        if command.action == "abito_account_create" && at.is_some() { return Err(account_error("account_exists")); }
        if command.action != "abito_account_create" && at.is_none() { return Err(account_error("account_missing")); }
        if at.is_none() && self.records.len() >= 64 { return Err(account_error("account_limit")); }
        if let Some(at) = at {
            if self.records[at].provider != command.record.provider { return Err(account_error("account_identity")); }
        }
        let old_ref = at.and_then(|i| self.records[i].credential_ref.clone());
        let changed_key = !command.keep_key;
        let new_key = command.record.config.api_key.take();
        command.record.credential_ref = if command.keep_key {
            old_ref.clone().or_else(|| shared_credential_ref(&command.record.account_id).map(str::to_owned))
        } else { None };
        if let Some(key) = new_key {
            // Persist intent BEFORE writing a fresh key. Never overwrite a live entry,
            // including on the unlikely 32-bit suffix collision.
            let reference = loop {
                let r = new_owned_reference(&command.record.account_id)?;
                if !self.pending_cleanup.contains(&r) && !self.records.iter().any(|a| a.credential_ref.as_ref() == Some(&r))
                    && self.secrets.read(&r).map_err(|_| account_error("keychain_unavailable"))?.is_none() { break r; }
            };
            let mut pending = self.pending_cleanup.clone(); pending.push(reference.clone());
            self.commit(self.records.clone(), pending)?;
            self.secrets.write(&reference, &key).map_err(|_| account_error("keychain_unavailable"))?;
            command.record.credential_ref = Some(reference);
        }
        let mut pending = self.pending_cleanup.clone();
        if let Some(reference) = &command.record.credential_ref { pending.retain(|r| r != reference); }
        let retired = old_ref.filter(|r| changed_key && owned_reference(r));
        if let Some(reference) = &retired { pending.push(reference.clone()); }
        let mut next = self.records.clone();
        match at { Some(at) => next[at] = command.record, None => next.push(command.record) }
        self.commit(next, pending)?;
        self.cleanup(retired)?;
        let snapshot = self.view();
        publish(snapshot.clone());
        Ok(snapshot)
    }
    fn persist(&self, records: &[AccountRecord], pending_cleanup: &[String]) -> std::io::Result<()> {
        use std::io::{Error, ErrorKind, Write};
        let denied = || Error::new(ErrorKind::PermissionDenied, "account store unavailable");
        let parent = self.path.parent().ok_or_else(denied)?;
        std::fs::create_dir_all(parent)?;
        let dir_meta = std::fs::symlink_metadata(parent)?;
        if !dir_meta.is_dir() || dir_meta.file_type().is_symlink() { return Err(denied()); }
        match std::fs::symlink_metadata(&self.path) {
            Ok(meta) if !private_account_file(&meta) => return Err(denied()),
            Err(e) if e.kind() != ErrorKind::NotFound => return Err(e),
            _ => {},
        }
        let bytes = serde_json::to_vec(&AccountDisk { version: 1, accounts: records.to_vec(), pending_cleanup: pending_cleanup.to_vec() }).map_err(|_| denied())?;
        if bytes.len() > 1024 * 1024 { return Err(denied()); }
        let tmp = parent.join(".accounts.json.pending");
        let mut options = std::fs::OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600).custom_flags(libc::O_NOFOLLOW); }
        // Non-Unix has no reviewed restrictive ACL implementation yet: fail closed.
        #[cfg(not(unix))] { return Err(denied()); }
        let mut file = options.open(&tmp)?; // never delete another writer's obstruction
        let result = (|| {
            if !private_account_file(&file.metadata()?) { return Err(denied()); }
            file.write_all(&bytes)?; file.sync_all()?;
            std::fs::rename(&tmp, &self.path)?;
            // Durability: without this a crash can bring the pre-migration (plaintext) file back after the keys moved.
            std::fs::File::open(parent)?.sync_all()
        })();
        if result.is_err() { let _ = std::fs::remove_file(&tmp); }
        result
    }
    pub fn guard(label: &str, url: &str, rate: &mut crate::bridge::RateLimiter, now: u128) -> Result<(), crate::bridge::BridgeError> {
        crate::bridge::sender_ok(label, url)?;
        rate.check(now)
    }
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct AccountDisk {
    version: u32, accounts: Vec<AccountRecord>,
    #[serde(default, rename = "pendingCleanup")]
    pending_cleanup: Vec<String>,
}
fn private_account_file(meta: &std::fs::Metadata) -> bool {
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        meta.is_file() && !meta.file_type().is_symlink() && meta.mode() & 0o777 == 0o600
            && meta.uid() == unsafe { libc::geteuid() } && meta.nlink() == 1
    }
    #[cfg(not(unix))] { let _ = meta; false }
}
fn account_error(code: &str) -> crate::bridge::BridgeError {
    crate::bridge::BridgeError { code: code.into(), message: if code == "keychain_unavailable" {
        "El llavero del sistema no está disponible; las claves siguen donde estaban. Desbloquéalo o instala un servicio de secretos y reintenta."
    } else {
        "No se pudo guardar la cuenta. Revisá los datos y la URL (HTTPS remota o HTTP de loopback local)."
    }.into() }
}

// Additive internal-Pi tool stream. Malformed streams stay unavailable; session
// discovery itself remains useful. Rebuild every field, never carry arguments.
fn session_tools_view(raw: &Value) -> Option<Value> {
    let total = raw.get("total")?.as_u64().filter(|n| *n <= 4096)?;
    let steps = raw.get("steps")?.as_array()?;
    if steps.len() != total.min(20) as usize { return None; }
    let steps: Option<Vec<Value>> = steps.iter().enumerate().map(|(i, step)| {
        let index = step.get("index")?.as_u64()?;
        let name = step.get("name")?.as_str()?;
        let state = step.get("state")?.as_str()?;
        if index != total - steps.len() as u64 + i as u64 + 1 || name.is_empty() || name.len() > 64
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
            || !matches!(state, "running" | "done" | "error") { return None; }
        Some(json!({"index":index,"name":name,"state":state}))
    }).collect();
    let mut tools = json!({"total":total,"steps":steps?});
    if let Some(epoch) = raw.get("epoch") {
        tools["epoch"] = json!(epoch.as_u64().filter(|n| *n <= 9_007_199_254_740_991)?);
    }
    Some(tools)
}

//! K2-05 T4 U2 — the island chat client of the daemon protocol `island-agent/1`
//! (the daemon of `apps/desktop-daemon`), PURE part: the closed set of chat
//! commands the island may issue, and the allowlisted view state the chat
//! serializes to the UI.
//!
//! Separate from `agentclient.rs` on purpose: the settings window keeps its own
//! connection (`agentconn`) and its command gate (`parse_ui_command`) must never
//! widen to chat verbs. The chat never touches `ClientState` or that parser.
//!
//! Security model (the same discipline as `agentclient.rs`):
//! - the per-launch TOKEN and the socket ENDPOINT never enter this module: the
//!   transport keeps them in `agentconn`'s `Session`; `ChatState` (the only type
//!   serialized to the UI) has no field that could carry either;
//! - chat commands are accepted ONLY from the exact main island window:
//!   [`ChatState::command`] takes the caller's window label and refuses
//!   everything else (the settings window keeps its own connection, and its gate
//!   offers no chat verbs), so the Tauri command cannot forget the check;
//! - an answer must name an ask this client received in an `ask` frame and has
//!   not resolved, and for a `select` ask it must be one of the SHOWN options —
//!   the page can never invent an ask id or an option;
//! - server frames are folded into allowlisted fields; unknown frames, unknown
//!   keys and off-vocabulary values change nothing (never forwarded raw);
//! - attachments are NOT in this unit (decision 2a adds daemon-side uploads in a
//!   later unit): the command set and the view have no attachment field yet, so
//!   there is no dead code and no half-open path. The single extension point is
//!   [`history_message_view`], where the daemon's attachment chips would fold.
use crate::agentclient::Reason;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::cell::Cell;
use std::time::Instant;

#[cfg(test)]
#[path = "chatclient_tests.rs"]
mod tests;

// ---- daemon limits (apps/desktop-daemon/src/protocol.cjs LIMITS / HISTORY_EMIT) ----
/// `LIMITS.maxTextChars`: the largest `send`/`steer` text the daemon accepts,
/// measured in UTF-16 code units like the daemon's JS `String.length`.
pub const MAX_TEXT_CHARS: usize = 64 * 1024;
/// `LIMITS.maxAnswerChars`: the largest `ui_response` `value`.
pub const MAX_ANSWER_CHARS: usize = 8 * 1024;
/// `LIMITS.maxIdChars`: the bound for ask ids, page ids and message ids.
pub const MAX_ID_CHARS: usize = 128;
/// `HISTORY_EMIT.maxMessages` = Gentle Dot's page size: one history page never exceeds this.
pub const HISTORY_PAGE: usize = 100;
/// The accumulated chat log's bound (finished messages; the oldest fall off).
pub const MAX_MESSAGES: usize = 500;
/// The last toasts the view keeps (newest last).
pub const MAX_TOASTS: usize = 5;
/// The pending asks the client tracks (the daemon caps them at 16; past the bound new asks are not registered).
pub const MAX_ASKS: usize = 16;
/// How many assistant messages may stream at once before the oldest is dropped (a memory guard).
pub const MAX_STREAM_MESSAGES: usize = 8;
/// One streamed message's text ceiling (UTF-16 units), a defensive memory guard.
pub const MAX_STREAM_CHARS: usize = 300_000;
/// The ONLY window label whose commands may chat: the main island window.
pub const CHAT_WINDOW_LABEL: &str = "main";

/// RED scaffold: the island's own chat rate limit (real gate comes with GREEN).
pub const CHAT_FRAMES_PER_MINUTE: u32 = 120;
/// The daemon's inbound client-frame bound (`LIMITS.maxFrameBytes`, measured in bytes
/// after JSON escaping): a serialized line the daemon would reject — it KILLS the
/// connection for any line over this — is refused by the island, never sent.
pub const MAX_CLIENT_LINE_BYTES: usize = 256 * 1024;

/// The daemon's page-id grammar for `get_earlier` (`HISTORY_BEFORE` =
/// `/^s(0|[1-9]\d*)-(0|[1-9]\d*)$/`): `s<file>-<turn>`, canonical — no leading zeros
/// anywhere (`s0-0` is a real page, `s01` and `s0-01` never match the daemon).
fn page_id_ok(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_ID_CHARS || bytes[0] != b's' { return false; }
    let mut parts = bytes[1..].split(|b| *b == b'-');
    let (Some(file), Some(turn), None) = (parts.next(), parts.next(), parts.next()) else { return false };
    let canonical = |p: &[u8]| match p {
        [b'0'] => true,
        [] | [b'0', ..] => false,
        rest => rest.iter().all(|b| b.is_ascii_digit()),
    };
    canonical(file) && canonical(turn)
}

/// The daemon's `SAFE_ID` (ask ids, call ids): `[A-Za-z0-9_.:-]{1,128}`.
fn safe_id_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= MAX_ID_CHARS && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b':' | b'-'))
}

/// JS `String.length`: the daemon measures text in UTF-16 code units.
fn utf16_len(s: &str) -> usize { s.encode_utf16().count() }

/// The daemon's `clip`: strips most control characters, then cuts at `max`
/// UTF-16 units, never between the two halves of a surrogate pair.
fn clip_utf16(s: &str, max: usize) -> String {
    let clean: String = s.chars().filter(|c| !c.is_control() || matches!(c, '\t' | '\n' | '\r')).collect();
    let mut out = String::new();
    let mut used = 0usize;
    for c in clean.chars() {
        let units = c.len_utf16();
        if used + units > max { break; }
        out.push(c);
        used += units;
    }
    out
}

/// Exact-key JSON line builder, same discipline as `agentclient.rs`'s `ordered`.
fn ordered(fields: &[(&str, &str)]) -> String {
    let body: Vec<String> = fields
        .iter()
        .map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), serde_json::to_string(v).unwrap_or_default()))
        .collect();
    format!("{{{}}}\n", body.join(","))
}

// ---- the closed command set ---------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandError;

/// One answer to an `ask`, matching the daemon's `buildUiResponse` surface.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatAnswer {
    /// A `select`/`input` answer: one of the shown options, or free input text.
    Value(String),
    /// A `confirm` answer: the closed boolean.
    Confirmed(bool),
    /// Cancel the ask (always valid, for every kind).
    Cancelled,
}

impl ChatAnswer {
    fn wire(&self, id: &str) -> String {
        match self {
            ChatAnswer::Value(v) => ordered(&[("type", "ui_response"), ("id", id), ("value", v)]),
            // the boolean and the cancellation must travel as bare JSON literals, never quoted strings
            ChatAnswer::Confirmed(b) => format!("{{\"type\":\"ui_response\",\"id\":{},\"confirmed\":{}}}\n", serde_json::to_string(id).unwrap_or_default(), b),
            ChatAnswer::Cancelled => format!("{{\"type\":\"ui_response\",\"id\":{},\"cancelled\":true}}\n", serde_json::to_string(id).unwrap_or_default()),
        }
    }
}
/// The closed set of chat commands. Parsed ONLY through [`ChatState::command`],
/// which gates on the caller's window label first.
#[derive(Debug, Clone, PartialEq)]
pub enum ChatCommand {
    /// Prompt the agent. `client_request_id` is the island's own correlation id:
    /// it never travels on the wire. The daemon has NO request-id dedupe — every
    /// `send` opens a turn — so an answer is tied to the shared session, not to a
    /// client request id; the id exists so the page can match its own replies.
    Send { text: String, client_request_id: String },
    Steer { text: String },
    Abort,
    UiResponse { ask_id: String, answer: ChatAnswer },
    History,
    Earlier { before: String },
    Status,
}

impl ChatCommand {
    /// The wire line. `client_request_id` deliberately never appears.
    pub fn line(&self) -> String {
        match self {
            ChatCommand::Send { text, .. } => ordered(&[("type", "send"), ("text", text)]),
            ChatCommand::Steer { text } => ordered(&[("type", "steer"), ("text", text)]),
            ChatCommand::Abort => ordered(&[("type", "abort")]),
            ChatCommand::UiResponse { ask_id, answer } => answer.wire(ask_id),
            ChatCommand::History => ordered(&[("type", "get_history")]),
            ChatCommand::Earlier { before } => ordered(&[("type", "get_earlier"), ("before", before)]),
            ChatCommand::Status => ordered(&[("type", "status")]),
        }
    }
}

/// One daemon `ask`: the closed fields the island is allowed to show and answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChatAsk {
    pub id: String,
    pub kind: String,
    pub title: String,
    /// The shown options: display-clean (control characters stripped). Serialized.
    pub options: Vec<String>,
    /// The EXACT strings the ask frame carried, position-matched to `options`:
    /// an answer travels as received — control characters are stripped for display
    /// only, never in the answer (the daemon matches its pending ask against what
    /// it sent). Never serialized.
    #[serde(skip)]
    wire_options: Vec<String>,
}

/// An assistant message still streaming, keyed by the daemon's message id.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StreamMessage {
    pub id: String,
    pub text: String,
}

/// The daemon's recognized error codes (anything else folds to `failed`).
const ERROR_CODES: [&str; 15] = [
    "bad_request", "busy", "not_busy", "unavailable", "rate_limited", "unknown_ask", "paused", "failed",
    "unknown_proposal", "digest_mismatch", "needs_setup", "signin_failed", "store_not_private", "conversations_off",
    "interrupted",
];

/// The allowlisted, serializable chat view. The ONLY type that ever reaches the
/// UI. No field can carry the token or the endpoint.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatState {
    connection: String,
    /// The folded `agent_state` frame: busy/status/paused only.
    agent: Value,
    /// The chat log: history pages replace it, `earlier` pages prepend, finished
    /// streams append. Bounded by `MAX_MESSAGES`.
    messages: Vec<Value>,
    /// Assistant messages still streaming, in first-seen order.
    streaming: Vec<StreamMessage>,
    /// The newest pending ask (the one the UI answers), or null.
    pending_ask: Value,
    /// Every pending ask, for answer validation. Never serialized.
    #[serde(skip_serializing)]
    asks: Vec<ChatAsk>,
    /// The daemon's last `error` frame: a closed code plus a counter.
    last_error: Value,
    /// The last bounded toasts (newest last).
    toasts: Vec<Value>,
    /// The `queue` frame's counts.
    queue: Value,
    /// Whether the daemon says older pages exist (`history`/`earlier` frames).
    has_earlier: bool,
    /// Live activities waiting for their message to finish. Never serialized.
    #[serde(skip_serializing)]
    pending_activities: Vec<Value>,
    /// Whether the newest end of the log was trimmed by an `earlier` prepend at the
    /// cap (U4 reloads the latest via `history` when the user scrolls back down).
    newer_trimmed: bool,
    /// The island's own chat-command rate window (well below the daemon's 240
    /// frames/minute drop, which KILLS the connection). Never serialized.
    #[serde(skip)]
    pub(crate) rate_window: Cell<Option<Instant>>,
    #[serde(skip)]
    pub(crate) rate_count: Cell<u32>,
    /// L3 (U2 re-verify): the cheap change signal for the reader. Bumped by every
    /// fold that changes the serialized view, never otherwise; never serialized
    /// itself, so bumping it cannot churn the view. The connection readers
    /// (`agentconn.rs`/`agentconn_win.rs`, keep in sync) compare this counter before
    /// and after a read's frames instead of serializing the whole chat state twice
    /// per read to decide whether to emit.
    #[serde(skip)]
    revision: u64,
}

impl ChatState {
    fn new(connection: &str) -> ChatState {
        ChatState {
            connection: connection.into(),
            agent: json!({"busy": false, "status": null, "paused": false}),
            messages: vec![],
            streaming: vec![],
            pending_ask: Value::Null,
            asks: vec![],
            last_error: json!({"code": null, "n": 0}),
            toasts: vec![],
            queue: json!({"steering": 0, "followUp": 0}),
            has_earlier: false,
            pending_activities: vec![],
            newer_trimmed: false,
            rate_window: Cell::new(None),
            rate_count: Cell::new(0),
            revision: 0,
        }
    }

    pub fn connected() -> ChatState { ChatState::new("connected") }

    pub fn disconnected(reason: Reason) -> ChatState {
        ChatState::new(match reason {
            Reason::NoDaemon => "no_daemon",
            Reason::BadSession => "bad_session",
            Reason::Refused => "refused",
            Reason::Lost => "lost",
        })
    }

    /// The pending asks (transport-free surface for the Tauri command).
    pub fn asks(&self) -> &[ChatAsk] { &self.asks }

    /// The change signal (L3): monotonically bumped by every fold that changes the
    /// serialized view. The connection readers compare it before/after folding a
    /// read's frames instead of serializing the whole state twice per read.
    pub(crate) fn revision(&self) -> u64 { self.revision }

    /// The newest pending ask, or None. The daemon can hold up to 16; the UI
    /// answers the newest (the one the user is looking at).
    pub fn pending_ask(&self) -> Option<&ChatAsk> { self.asks.last() }

    /// Parse and dispatch one UI command for the given caller window. The label
    /// is part of the API on purpose: only the exact main island window may chat
    /// (the settings window keeps its own connection, and its gate offers no
    /// chat verbs), so the Tauri command cannot forget the check. A command that
    /// parses is also the island's own rate-limit budget: only sendable commands
    /// consume it (refused ones are never sent), and the limit stays well below
    /// the daemon's own 240 frames/minute drop.
    pub fn command(&self, caller: &str, payload: &Value) -> Result<ChatCommand, CommandError> {
        if caller != CHAT_WINDOW_LABEL { return Err(CommandError); }
        let cmd = parse_chat_command(&self.asks, payload)?;
        const WINDOW: std::time::Duration = std::time::Duration::from_secs(60);
        let now = Instant::now();
        match self.rate_window.get() {
            Some(start) if now.duration_since(start) < WINDOW => {
                let next = self.rate_count.get() + 1;
                if next > CHAT_FRAMES_PER_MINUTE { return Err(CommandError); }
                self.rate_count.set(next);
            }
            _ => {
                self.rate_window.set(Some(now));
                self.rate_count.set(1);
            }
        }
        Ok(cmd)
    }

    /// Fold one server frame in. Unknown or malformed frames change nothing. Every
    /// branch reports whether the fold CHANGED the serialized view; `apply` bumps
    /// the `revision` counter exactly then, so the connection readers can decide
    /// whether to emit with one integer comparison instead of serializing the whole
    /// state twice per read (L3, U2 re-verify).
    pub fn apply(&mut self, frame: &Value) {
        let Some(t) = frame.get("type").and_then(Value::as_str) else { return };
        let changed = match t {
            // `agent_state` updates the status live; `ready` carried the same state at
            // handshake time (nested under "state"). One closed status set.
            "ready" | "agent_state" => {
                let s = frame.get("state").filter(|s| s.is_object()).unwrap_or(frame);
                let status = s.get("status").and_then(Value::as_str).filter(|s| matches!(*s, "ready" | "restarting" | "stopped" | "starting" | "unavailable"));
                let agent = json!({
                    "busy": s.get("busy").and_then(Value::as_bool).unwrap_or(false),
                    "status": status,
                    "paused": s.get("paused").and_then(Value::as_bool).unwrap_or(false),
                });
                let mut changed = false;
                if self.agent != agent {
                    self.agent = agent;
                    changed = true;
                }
                // a stopped or restarting engine can never finish a half-streamed message:
                // drop it honestly instead of showing a tail that will never close
                if matches!(status, Some("stopped" | "restarting")) && !self.streaming.is_empty() {
                    self.streaming.clear();
                    changed = true;
                }
                changed
            }
            "message_delta" => {
                let (Some(id), Some(text)) = (id_field(frame, "messageId"), str_field(frame, "text")) else { return };
                if text.is_empty() { return; }
                if let Some(slot) = self.streaming.iter_mut().find(|s| s.id == id) {
                    // A delta at the stream-text cap can clip back to the EXACT same string:
                    // the bounded text changed only when its UTF-16 length moved (appends
                    // grow it, the cap cut keeps at least the old clean prefix).
                    let before = utf16_len(slot.text.as_str());
                    let mut acc = std::mem::take(&mut slot.text);
                    push_bounded(&mut acc, text, MAX_STREAM_CHARS);
                    let after = utf16_len(acc.as_str());
                    slot.text = acc;
                    after != before
                } else {
                    if self.streaming.len() >= MAX_STREAM_MESSAGES { self.streaming.remove(0); }
                    let mut acc = String::new();
                    push_bounded(&mut acc, text, MAX_STREAM_CHARS);
                    self.streaming.push(StreamMessage { id: id.to_owned(), text: acc });
                    true
                }
            }
            "message_done" => {
                let Some(id) = id_field(frame, "messageId") else { return };
                let landed = match self.streaming.iter().position(|s| s.id == id) {
                    Some(at) => self.streaming.remove(at).text,
                    None => {
                        // a done for an id the island never streamed: land it honestly empty, once
                        let key = json!(id);
                        if self.messages.iter().any(|m| m["id"] == key) { return; }
                        String::new()
                    }
                };
                if self.messages.len() >= MAX_MESSAGES { self.messages.remove(0); }
                let activities = std::mem::take(&mut self.pending_activities);
                self.messages.push(json!({"id": id, "role": "assistant", "text": landed, "activities": activities}));
                true
            }
            "activity" => self.fold_activity(frame),
            "history" => self.fold_history(frame, false),
            "earlier" => self.fold_history(frame, true),
            "ask" => {
                let Some(ask) = ask_view(frame) else { return };
                if self.asks.len() >= MAX_ASKS { return; } // past the bound: never registered, never answerable
                let pending = serde_json::to_value(&ask).unwrap_or(Value::Null);
                let changed = self.pending_ask != pending;
                self.pending_ask = pending;
                self.asks.push(ask);
                changed
            }
            "ask_resolved" => {
                let Some(id) = id_field(frame, "id") else { return };
                self.asks.retain(|a| a.id != id);
                let pending = self.asks.last().map(|a| serde_json::to_value(a).unwrap_or(Value::Null)).unwrap_or(Value::Null);
                let changed = self.pending_ask != pending;
                self.pending_ask = pending;
                changed
            }
            "toast" => {
                let Some(message) = frame.get("message").and_then(Value::as_str) else { return };
                let Some(level) = frame.get("level").and_then(Value::as_str).filter(|l| matches!(*l, "info" | "warning" | "error")) else { return };
                if self.toasts.len() >= MAX_TOASTS { self.toasts.remove(0); }
                self.toasts.push(json!({"level": level, "message": clip_utf16(message, 300)}));
                true
            }
            "queue" => {
                let count = |k: &str| frame.get(k).and_then(Value::as_u64).unwrap_or(0).min(100);
                let queue = json!({"steering": count("steering"), "followUp": count("followUp")});
                let changed = self.queue != queue;
                self.queue = queue;
                changed
            }
            "error" => {
                let code = match frame.get("code").and_then(Value::as_str) {
                    Some(c) if ERROR_CODES.contains(&c) => c,
                    _ => "failed",
                };
                let n = self.last_error["n"].as_u64().unwrap_or(0) + 1;
                self.last_error = json!({"code": code, "n": n});
                true
            }
            _ => false,
        };
        if changed {
            self.revision = self.revision.wrapping_add(1);
        }
    }

    /// Live activities pair running→done/failed by the engine's `callId`. The view has
    /// ONE closed status set — the daemon's history vocabulary (`running`/`done`/`failed`,
    /// protocol.cjs `ACTIVITY_STATUSES`); its live activity frames spell the failure
    /// state `error`, which folds to `failed` here. An off-vocabulary state, or a
    /// done/error with no prior running entry, is dropped — never guessed. The finished
    /// entries attach to the next completed message (`message_done`). Returns whether
    /// the fold changed the view (L3).
    fn fold_activity(&mut self, frame: &Value) -> bool {
        let Some(name) = str_field(frame, "name") else { return false };
        let Some(state) = frame.get("state").and_then(Value::as_str).filter(|s| matches!(*s, "running" | "done" | "error" | "failed")) else { return false };
        let state = if state == "error" { "failed" } else { state };
        let Some(call_id) = id_field(frame, "callId").filter(|c| safe_id_ok(c)) else { return false };
        let title = clip_utf16(name, 64);
        match state {
            "running" => {
                let entry = json!({"id": call_id, "kind": "other", "title": title, "status": "running"});
                match self.pending_activities.iter().position(|a| a["id"] == json!(call_id)) {
                    Some(at) => {
                        if self.pending_activities[at] == entry { return false; }
                        self.pending_activities[at] = entry;
                        true
                    }
                    None => {
                        if self.pending_activities.len() >= HISTORY_PAGE { self.pending_activities.remove(0); }
                        self.pending_activities.push(entry);
                        true
                    }
                }
            }
            // done/failed completes the paired running entry; an unpaired one is dropped
            _ => {
                if let Some(at) = self.pending_activities.iter().position(|a| a["id"] == json!(call_id)) {
                    if self.pending_activities[at]["status"] == json!(state) { return false; }
                    self.pending_activities[at]["status"] = json!(state);
                    true
                } else {
                    false
                }
            }
        }
    }

    /// Fold a `history` (replace) or `earlier` (prepend + dedupe by id) page. Returns
    /// whether the fold changed the view (L3).
    fn fold_history(&mut self, frame: &Value, earlier: bool) -> bool {
        let Some(page) = frame.get("messages").and_then(Value::as_array) else { return false };
        let messages: Vec<Value> = page.iter().take(HISTORY_PAGE).filter_map(history_message_view).collect();
        let has_earlier = frame.get("hasEarlier").and_then(Value::as_bool).unwrap_or(false);
        let mut changed = self.has_earlier != has_earlier;
        self.has_earlier = has_earlier;
        if earlier {
            let mut fresh = Vec::with_capacity(messages.len());
            for m in messages {
                let id = m["id"].clone();
                let known = self.messages.iter().any(|x| x["id"] == id) || fresh.iter().any(|x: &Value| x["id"] == id);
                if !known { fresh.push(m); }
            }
            let fresh_len = fresh.len();
            let mut all = fresh;
            all.append(&mut self.messages);
            // NEVER drop what was just loaded: when the prepend pushes the view over the
            // cap, the NEWEST end is trimmed (the user scrolled to the OLDEST message;
            // U4 reloads the latest via `history` when they scroll back down) and the
            // view says so. Trimming the oldest instead made every earlier page vanish.
            // NOTE: `append` MOVES the old messages out of `self.messages`, so the exact
            // old content only exists inside `all` from here on: the change decision is
            // made from what was prepended/trimmed, never by comparing against the
            // emptied field.
            let excess = all.len().saturating_sub(MAX_MESSAGES);
            if excess > 0 {
                all.truncate(all.len() - excess);
                self.newer_trimmed = true;
            }
            self.messages = all;
            if fresh_len > 0 || excess > 0 {
                changed = true;
            }
        } else {
            if self.messages != messages {
                self.messages = messages;
                changed = true;
            }
            // a fresh page is the whole truth: a half-streamed message can never
            // finish against it, and the newest end is present again
            if !self.streaming.is_empty() {
                self.streaming.clear();
                changed = true;
            }
            if !self.pending_activities.is_empty() {
                self.pending_activities.clear();
                changed = true;
            }
            if self.newer_trimmed {
                self.newer_trimmed = false;
                changed = true;
            }
        }
        changed
    }
}

/// A string field as the daemon sent it (no length gate: callers clip).
fn str_field<'a>(frame: &'a Value, key: &str) -> Option<&'a str> {
    frame.get(key).and_then(Value::as_str)
}

/// An id-shaped field bounded by the daemon's `LIMITS.maxIdChars` (UTF-16 units).
fn id_field<'a>(frame: &'a Value, key: &str) -> Option<&'a str> {
    frame.get(key).and_then(Value::as_str).filter(|s| utf16_len(s) <= MAX_ID_CHARS)
}

fn push_bounded(acc: &mut String, text: &str, max: usize) {
    acc.push_str(text);
    if utf16_len(acc) > max { *acc = clip_utf16(acc, max); }
}

/// The closed rebuild of one `ask` frame. A malformed ask (bad id shape, unknown
/// kind, non-string options) is dropped entirely: it never becomes answerable.
fn ask_view(frame: &Value) -> Option<ChatAsk> {
    let id = id_field(frame, "id").filter(|i| safe_id_ok(i))?;
    let kind = frame.get("kind").and_then(Value::as_str).filter(|k| matches!(*k, "select" | "confirm" | "input"))?;
    let title = frame.get("title").and_then(Value::as_str).map(|t| clip_utf16(t, 300)).unwrap_or_default();
    // The daemon's own option clip (LIMITS.maxOptionChars = 200) bounds every option it
    // sends; anything longer or non-string is a malformed ask: dropped entirely, never
    // answerable. Both lists stay position-aligned: shown (display-clean) and exact.
    let mut options = Vec::new();
    let mut wire_options = Vec::new();
    if kind == "select" {
        for o in frame.get("options").and_then(Value::as_array)?.iter().take(50) {
            let raw = o.as_str().filter(|r| utf16_len(r) <= 200)?;
            options.push(clip_utf16(raw, 200));
            wire_options.push(raw.to_owned());
        }
    }
    Some(ChatAsk { id: id.to_owned(), kind: kind.to_owned(), title, options, wire_options })
}

/// The closed rebuild of one history message (the daemon already allowlisted its
/// own side; this is the client's mirror). The attachment chips the daemon may
/// send are deliberately NOT folded yet: attachments arrive with decision 2a's
/// daemon-side uploads in a later unit, and this function is the one place to
/// add them.
fn history_message_view(m: &Value) -> Option<Value> {
    let id = id_field(m, "id")?;
    let role = m.get("role").and_then(Value::as_str).filter(|r| matches!(*r, "user" | "assistant"))?;
    let text = m.get("text").and_then(Value::as_str).map(|t| clip_utf16(t, MAX_TEXT_CHARS)).unwrap_or_default();
    let activities: Vec<Value> = m.get("activities").and_then(Value::as_array).map(|list| {
        list.iter().take(HISTORY_PAGE).filter_map(|a| {
            let id = str_field(a, "id")?;
            let kind = a.get("kind").and_then(Value::as_str).filter(|k| matches!(*k, "read" | "edit" | "run" | "search" | "memory" | "delegate" | "other"))?;
            let title = a.get("title").and_then(Value::as_str).map(|t| clip_utf16(t, 300))?;
            let status = a.get("status").and_then(Value::as_str).filter(|s| matches!(*s, "running" | "done" | "failed"))?;
            Some(json!({"id": id, "kind": kind, "title": title, "status": status}))
        }).collect()
    }).unwrap_or_default();
    let mut view = json!({"id": id, "role": role, "text": text, "activities": activities});
    // the daemon's own booleans, allowlisted: `earlier` marks rows the engine loaded
    // from older chain files; `clipped` says the daemon cut the text (protocol.cjs
    // historyMessageDto). True only — never a string or a number.
    if m.get("earlier").and_then(Value::as_bool) == Some(true) { view["earlier"] = json!(true); }
    if m.get("clipped").and_then(Value::as_bool) == Some(true) { view["clipped"] = json!(true); }
    Some(view)
}

// ---- command parsing (window-gated) -------------------------------------------------------

/// Parse one chat command for an already-verified main-window caller. `asks` is
/// the current pending-ask list: an answer must name one of these asks, and a
/// select answer must be one of its SHOWN options.
fn parse_chat_command(asks: &[ChatAsk], payload: &Value) -> Result<ChatCommand, CommandError> {
    let map: &Map<String, Value> = payload.as_object().ok_or(CommandError)?;
    let action = map.get("action").and_then(Value::as_str).ok_or(CommandError)?;
    let text_of = |max: usize| -> Result<String, CommandError> {
        let t = map.get("text").and_then(Value::as_str).ok_or(CommandError)?;
        if utf16_len(t) > max || t.trim().is_empty() { return Err(CommandError); }
        Ok(t.to_owned())
    };
    let exact = |n: usize| if map.len() == n { Ok(()) } else { Err(CommandError) };
    let cmd = match action {
        "chat_send" => {
            exact(3)?;
            let text = text_of(MAX_TEXT_CHARS)?;
            let id = map.get("clientRequestId").and_then(Value::as_str).filter(|i| safe_id_ok(i)).ok_or(CommandError)?;
            ChatCommand::Send { text, client_request_id: id.to_owned() }
        }
        "chat_steer" => {
            exact(2)?;
            ChatCommand::Steer { text: text_of(MAX_TEXT_CHARS)? }
        }
        "chat_abort" => exact(1).map(|_| ChatCommand::Abort)?,
        "chat_history" => exact(1).map(|_| ChatCommand::History)?,
        "chat_status" => exact(1).map(|_| ChatCommand::Status)?,
        "chat_earlier" => {
            exact(2)?;
            let before = map.get("before").and_then(Value::as_str).filter(|b| page_id_ok(b)).ok_or(CommandError)?;
            ChatCommand::Earlier { before: before.to_owned() }
        }
        "chat_ui_response" => {
            exact(3)?;
            let ask_id = map.get("askId").and_then(Value::as_str).filter(|i| safe_id_ok(i)).ok_or(CommandError)?;
            let ask = asks.iter().find(|a| a.id == ask_id).ok_or(CommandError)?;
            let answer = match map.get("answer") {
                Some(Value::Null) => ChatAnswer::Cancelled,
                Some(Value::Bool(b)) => {
                    // a confirm ask takes the closed boolean; no other kind does
                    if ask.kind != "confirm" { return Err(CommandError); }
                    ChatAnswer::Confirmed(*b)
                }
                Some(Value::String(v)) => {
                    if utf16_len(v) > MAX_ANSWER_CHARS { return Err(CommandError); }
                    match ask.kind.as_str() {
                        // a select answer must be one of the SHOWN options; the wire
                        // carries the EXACT string the ask frame received (position-
                        // matched), never a display-stripped rewrite
                        "select" => {
                            let Some(at) = ask.options.iter().position(|o| o == v) else { return Err(CommandError) };
                            let Some(exact) = ask.wire_options.get(at) else { return Err(CommandError) };
                            ChatAnswer::Value(exact.clone())
                        }
                        "input" => ChatAnswer::Value(v.clone()),
                        _ => return Err(CommandError),
                    }
                }
                _ => return Err(CommandError),
            };
            ChatCommand::UiResponse { ask_id: ask_id.to_owned(), answer }
        }
        _ => return Err(CommandError),
    };
    // the daemon drops the connection for any client line over its inbound byte bound
    // (server.cjs measures the raw line): measure the SERIALIZED line in bytes, after
    // JSON escaping, and refuse locally anything the daemon would reject
    if cmd.line().len() > MAX_CLIENT_LINE_BYTES { return Err(CommandError); }
    Ok(cmd)
}

// ---- K2-05 T4 U3: the island chat host's route to the daemon engine ------------------------
//
// The island page keeps its closed `chat::Command` verb set and its `chat:state` shape (the
// keys of `chat.rs` Conversation::view + `chatlane.rs` Lane::view); `ChatHost` routes those
// verbs to the daemon through a `ChatLink` (production: `agentconn::ChatConn`) and projects
// the daemon's `ChatState` back into that shape. Pure and transport-free so the unit tests and
// `tests/chat_daemon.rs` drive the SAME code the Tauri command runs.
//
// Ownership: one continuous chat (L3/L4/L11) — `new`/`new_with`/`list`/`restore` are refused
// with a fixed `conversations_off`; attachments are refused until the uploads unit. The window
// gate stays where U2 put it: every command that reaches the daemon goes through
// `ChatLink::command(caller, …)` with the caller's REAL window label.

/// The ONE continuous conversation the island projects. Constant within and across
/// launches, so the page never resets its view (and it passes `chat.rs`'s id shape).
pub const CHAT_CONVERSATION_ID: &str = "c-koda";

/// Grace after a submit before a quiet engine (not busy, nothing streamed) reads as a
/// finished turn: the daemon's optimistic `busy` broadcast is still in flight.
pub const PENDING_SETTLE_MS: u64 = 1_500;

/// Minimum gap between two status reads sent for page views.
const STATUS_GAP_MS: u64 = 2_000;
/// How long a `history` page request waits for the daemon's answer frame.
const HISTORY_WAIT_MS: u64 = 3_000;
/// How long a newest-page refresh waits before answering with what the island has.
const REFRESH_WAIT_MS: u64 = 1_000;
/// First turn number handed out; earlier pages count DOWN from here, new turns UP, so
/// the page's numeric `t-<n>` order (chat-view.js mergeHistory) is the chat order.
const TURN_BASE: u64 = 1_000_000_000;
/// Submitted turns kept by the host (the daemon's own history is the long-term record).
const MAX_PENDING: usize = 200;

fn chat_err(code: &str, message: &str, retryable: bool) -> crate::chat::ChatError {
    crate::chat::ChatError { code: code.into(), safe_message: message.into(), retryable }
}

/// The fixed refusal of every conversation-list verb: one continuous chat.
pub fn conversations_off() -> crate::chat::ChatError {
    chat_err("conversations_off", "Koda tiene un solo chat continuo.", false)
}

/// The fixed refusal of a submit with attachments (daemon-side uploads come later).
pub fn attachments_off() -> crate::chat::ChatError {
    chat_err("attachments_unavailable", "Los archivos adjuntos todavía no están disponibles en este chat.", false)
}

fn engine_unavailable() -> crate::chat::ChatError {
    chat_err("engine_unavailable", "El motor de Koda no está disponible todavía.", true)
}

fn send_refused() -> crate::chat::ChatError {
    chat_err("send_refused", "No se pudo enviar el pedido al motor de Koda.", true)
}

fn history_unavailable() -> crate::chat::ChatError {
    chat_err("history_unavailable", "No se pudo cargar el historial anterior.", true)
}

/// One closed sentence per daemon error code; never the daemon's own text.
fn daemon_error_message(code: &str) -> &'static str {
    match code {
        "busy" => "El motor de Koda está atendiendo otro mensaje; probá de nuevo en un momento.",
        "unavailable" => "El motor de Koda no está disponible.",
        "paused" => "El chat está en pausa; reanudalo en Ajustes.",
        "rate_limited" => "Demasiados mensajes seguidos; esperá un momento.",
        "interrupted" => "Se interrumpió el turno.",
        "needs_setup" | "signin_failed" => "La cuenta del motor de Koda necesita atención en Ajustes.",
        _ => "No se pudo completar la respuesta.",
    }
}

/// The transport the host routes through. `command` takes the caller's window label: the
/// U2 gate in [`ChatState::command`] refuses anything but the main island window.
pub trait ChatLink {
    fn view(&self) -> Value;
    fn command(&self, caller: &str, payload: &Value) -> Result<Value, CommandError>;
}

impl ChatLink for crate::agentconn::ChatConn {
    fn view(&self) -> Value {
        crate::agentconn::ChatConn::view(self)
    }
    fn command(&self, caller: &str, payload: &Value) -> Result<Value, CommandError> {
        crate::agentconn::ChatConn::command(self, caller, payload)
    }
}

/// What `chat_action` does after the route.
#[derive(Debug, Clone, PartialEq)]
pub enum Routed {
    /// Answer with the projected `chat:state` view.
    View,
    /// A local island verb (open/back/height): the host's window code handles it.
    Local,
    /// Answer with this value as is.
    Answer(Value),
}

#[derive(Debug, Clone, PartialEq)]
enum TurnEnd {
    /// The engine went quiet after the turn (a reply landed, or the settle grace passed).
    Completed,
    Cancelled,
    Error(String),
}

/// A turn the island submitted. The daemon never echoes the prompt back, so the host shows
/// it until the daemon's own history carries the same text (then that turn takes over,
/// keeping this turn's number).
#[derive(Debug, Clone)]
struct Pending {
    num: u64,
    client_request_id: String,
    text: String,
    submitted_ms: u64,
    /// The last non-empty reply seen (kept across a connection reset that drops the live
    /// messages from the island's view).
    reply: String,
    /// The daemon error-frame counter already accounted for.
    err_seen: u64,
    ended: Option<TurnEnd>,
}

#[derive(Default)]
struct HostInner {
    pending: Vec<Pending>,
    /// Daemon history message id (`s<file>-<turn>`) → turn number.
    num_by_id: std::collections::HashMap<String, u64>,
    id_by_num: std::collections::HashMap<u64, String>,
    next_up: u64,
    next_down: u64,
    /// Live (streamed, not yet in history) assistant message id → owning pending turn
    /// number; 0 = it predates every island submission.
    live_owner: std::collections::HashMap<String, u64>,
    /// Bumped on every projection: the page's `staleSnapshot` guard compares it.
    generation: u64,
    /// Whether the last projection had an active (thinking/streaming) turn.
    live: bool,
    /// When the last status line was sent for a view/check.
    last_status_ms: Option<u64>,
}

/// The island's chat host: one per app, shared by the Tauri command and the event emitter.
pub struct ChatHost {
    inner: std::sync::Mutex<HostInner>,
}

impl Default for ChatHost {
    fn default() -> Self {
        ChatHost::new()
    }
}

fn is_history_id(id: &str) -> bool {
    id.starts_with('s') && page_id_ok(id)
}

fn chat_connected(chat: &Value) -> bool {
    chat.get("connection").and_then(Value::as_str) == Some("connected")
}

fn chat_busy(chat: &Value) -> bool {
    chat.pointer("/agent/busy").and_then(Value::as_bool).unwrap_or(false)
}

fn chat_messages(chat: &Value) -> Vec<Value> {
    chat.get("messages").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// The messages still streaming, as (daemon message id, text so far).
fn live_streams(chat: &Value) -> Vec<(String, String)> {
    chat.get("streaming")
        .and_then(Value::as_array)
        .map(|s| {
            s.iter()
                .filter_map(|m| Some((m.get("id")?.as_str()?.to_owned(), m.get("text")?.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

fn error_counter(chat: &Value) -> (u64, String) {
    let n = chat.pointer("/lastError/n").and_then(Value::as_u64).unwrap_or(0);
    let code = chat.pointer("/lastError/code").and_then(Value::as_str).unwrap_or("failed").to_owned();
    (n, code)
}

fn join_reply(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_owned(),
        (_, true) => a.to_owned(),
        _ => format!("{a}\n\n{b}"),
    }
}

/// `availability` and `producer` from the REAL daemon/engine state. `availability.state`
/// keeps the page's closed vocabulary (ready/busy/blocked/unavailable/unchecked);
/// `producer.pi` is connected/ready/busy/unavailable. No sentence names the engine vendor.
fn availability_and_producer(chat: &Value) -> (Value, Value) {
    let note = "Chat con el motor de Koda.";
    let pair = |state: &str, message: &str, producer: &str| {
        (json!({"state": state, "message": message}), json!({"pi": producer, "note": note}))
    };
    if !chat_connected(chat) {
        return pair("unavailable", "El motor de Koda no está disponible todavía.", "unavailable");
    }
    let status = chat.pointer("/agent/status").and_then(Value::as_str);
    let paused = chat.pointer("/agent/paused").and_then(Value::as_bool).unwrap_or(false);
    match status {
        Some("restarting" | "stopped" | "unavailable") => {
            pair("unavailable", "El motor de Koda se está reiniciando; probá de nuevo en unos segundos.", "unavailable")
        }
        Some("ready") if paused => pair("blocked", "El chat está en pausa; reanudalo en Ajustes.", "ready"),
        Some("ready") if chat_busy(chat) => pair("busy", "El motor de Koda está respondiendo.", "busy"),
        Some("ready") => pair("ready", "El motor de Koda está listo.", "ready"),
        _ => pair("unchecked", "El motor de Koda está arrancando.", "connected"),
    }
}

fn turn_view(num: u64, user_text: &str, reply: &str, state: &str, error: Value, seq: u64) -> Value {
    json!({
        "turn_id": format!("t-{num}"),
        "request_id": Value::Null,
        "state": state,
        "seq": seq,
        "user_text": user_text,
        "reply": reply,
        "finish_reason": Value::Null,
        "error": error,
        "trimmed_turns": 0,
        "profile_id": Value::Null,
        "profile_revision": Value::Null,
        "attachments": [],
    })
}

impl HostInner {
    fn alloc_up(&mut self) -> u64 {
        if self.next_up == 0 {
            self.next_up = TURN_BASE;
            self.next_down = TURN_BASE - 1;
        }
        let n = self.next_up;
        self.next_up += 1;
        n
    }

    fn alloc_down(&mut self) -> u64 {
        if self.next_up == 0 {
            self.next_up = TURN_BASE;
            self.next_down = TURN_BASE - 1;
        }
        let n = self.next_down.max(1);
        self.next_down = n.saturating_sub(1);
        n
    }

    fn bind(&mut self, id: &str, num: u64) {
        self.num_by_id.insert(id.to_owned(), num);
        self.id_by_num.insert(num, id.to_owned());
    }

    /// Number every daemon history message: the ones before the first already-known id
    /// count DOWN (an earlier page), the ones after count UP (new turns); a new user
    /// message whose text is a submitted turn's text takes that turn's number.
    fn number_history(&mut self, messages: &[Value]) {
        let ids: Vec<(&str, &str, &str)> = messages
            .iter()
            .filter_map(|m| {
                let id = m.get("id").and_then(Value::as_str)?;
                is_history_id(id).then_some((
                    id,
                    m.get("role").and_then(Value::as_str).unwrap_or(""),
                    m.get("text").and_then(Value::as_str).unwrap_or(""),
                ))
            })
            .collect();
        let first_known = ids.iter().position(|(id, _, _)| self.num_by_id.contains_key(*id));
        let split = first_known.unwrap_or(0);
        for (id, _, _) in ids[..split].iter().rev() {
            let n = self.alloc_down();
            self.bind(id, n);
        }
        for (id, role, text) in &ids[split..] {
            if self.num_by_id.contains_key(*id) {
                continue;
            }
            let claimed = (*role == "user")
                .then(|| self.pending.iter().position(|p| p.text.trim() == text.trim()))
                .flatten();
            let n = match claimed {
                Some(at) => self.pending.remove(at).num,
                None => self.alloc_up(),
            };
            self.bind(id, n);
        }
    }

    /// The `chat:state` conversation projection; also advances the submitted turns'
    /// lifecycle (terminal states are kept, never resurrected).
    fn project(&mut self, chat: &Value, now_ms: u64) -> Value {
        self.generation += 1;
        let seq = self.generation;
        let messages = chat_messages(chat);
        self.number_history(&messages);
        let connected = chat_connected(chat);
        let busy = chat_busy(chat);
        let (err_n, err_code) = error_counter(chat);

        // live output (landed assistant messages not yet in the daemon's history, and
        // messages still streaming), each owned by the newest submission that preceded it
        // (0 = it predates every submission on this island)
        let streams = live_streams(chat);
        let present: std::collections::HashSet<&str> = messages
            .iter()
            .filter_map(|m| m.get("id").and_then(Value::as_str))
            .chain(streams.iter().map(|(id, _)| id.as_str()))
            .collect();
        self.live_owner.retain(|id, _| present.contains(id.as_str()));
        let newest = self.pending.last().map(|p| p.num).unwrap_or(0);
        // (owner, text, still streaming)
        let mut live: Vec<(u64, String, bool)> = Vec::new();
        for m in &messages {
            let Some(id) = m.get("id").and_then(Value::as_str) else { continue };
            if is_history_id(id) || m.get("role").and_then(Value::as_str) != Some("assistant") {
                continue;
            }
            let owner = *self.live_owner.entry(id.to_owned()).or_insert(newest);
            live.push((owner, m.get("text").and_then(Value::as_str).unwrap_or("").to_owned(), false));
        }
        for (id, text) in &streams {
            let owner = *self.live_owner.entry(id.clone()).or_insert(newest);
            live.push((owner, text.clone(), true));
        }
        let owned = |owner: u64| -> (String, bool) {
            let parts: Vec<&str> = live.iter().filter(|l| l.0 == owner).map(|l| l.1.as_str()).collect();
            (parts.join("\n\n"), live.iter().any(|l| l.0 == owner && l.2))
        };

        // history turns
        let mut turns: Vec<(u64, String, String, &'static str, Value)> = Vec::new();
        for m in &messages {
            let Some(id) = m.get("id").and_then(Value::as_str).filter(|i| is_history_id(i)) else { continue };
            let text = m.get("text").and_then(Value::as_str).unwrap_or("");
            match m.get("role").and_then(Value::as_str) {
                Some("user") => {
                    let num = self.num_by_id.get(id).copied().unwrap_or(0);
                    turns.push((num, text.to_owned(), String::new(), "completed", Value::Null));
                }
                Some("assistant") => {
                    // a leading assistant message with no user message before it is not a turn
                    if let Some(last) = turns.last_mut() {
                        last.2 = join_reply(&last.2, text);
                    }
                }
                _ => {}
            }
        }

        // live output nobody on this island submitted (a turn in flight when the island
        // connected): it continues the newest history turn when no submission came after it
        let (orphan, orphan_streaming) = owned(0);
        if let Some(last) = turns.last_mut().filter(|_| self.pending.is_empty()) {
            last.2 = join_reply(&last.2, &orphan);
            if busy && orphan_streaming {
                last.3 = "streaming";
            } else if busy && orphan.is_empty() && last.2.is_empty() {
                last.3 = "thinking";
            }
        }

        // submitted turns
        let count = self.pending.len();
        for (i, p) in self.pending.iter_mut().enumerate() {
            let is_last = i + 1 == count;
            let (reply, streaming) = owned(p.num);
            // the turn's own output, also after it ended: a cancelled turn's held tail
            // still lands (the daemon flushes it once), and only this turn owns it
            if !reply.is_empty() {
                p.reply = reply;
            }
            let mut state: &'static str = "completed";
            if p.ended.is_none() {
                if !is_last {
                    // the daemon runs one turn at a time: a later submission settled this one
                    p.ended = Some(TurnEnd::Completed);
                } else if !connected {
                    p.ended = Some(TurnEnd::Error("unavailable".into()));
                } else if err_n > p.err_seen && p.reply.is_empty() && !streaming {
                    // an error frame after the submit, and nothing produced: the send failed
                    p.ended = Some(TurnEnd::Error(err_code.clone()));
                } else if busy && streaming {
                    state = "streaming";
                } else if busy || (p.reply.is_empty() && now_ms.saturating_sub(p.submitted_ms) < PENDING_SETTLE_MS) {
                    // with nothing yet, the settle grace covers the optimistic busy in flight
                    state = "thinking";
                } else {
                    // the engine is quiet: terminal, so a later busy (another client's turn)
                    // never resurrects it; a stream the engine never closed ends here too
                    p.ended = Some(TurnEnd::Completed);
                }
            }
            let error = match &p.ended {
                Some(TurnEnd::Error(code)) => {
                    state = "error";
                    json!({"code": code, "safe_message": daemon_error_message(code), "retryable": true})
                }
                Some(TurnEnd::Cancelled) => {
                    state = "cancelled";
                    Value::Null
                }
                Some(TurnEnd::Completed) | None => Value::Null,
            };
            turns.push((p.num, p.text.clone(), p.reply.clone(), state, error));
        }

        turns.sort_by_key(|t| t.0);
        let active = turns
            .last()
            .filter(|t| matches!(t.3, "thinking" | "streaming"))
            .map(|t| json!(format!("t-{}", t.0)))
            .unwrap_or(Value::Null);
        self.live = !active.is_null();
        let history_before = if chat.get("hasEarlier").and_then(Value::as_bool) == Some(true) {
            messages
                .first()
                .and_then(|m| m.get("id")?.as_str())
                .and_then(|id| self.num_by_id.get(id))
                .map(|n| json!(n))
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let (availability, producer) = availability_and_producer(chat);
        let turns: Vec<Value> = turns.into_iter().map(|(n, u, r, s, e)| turn_view(n, &u, &r, s, e, seq)).collect();
        json!({
            "conversation_id": CHAT_CONVERSATION_ID,
            "active_turn": active,
            "turns": turns,
            "evicted": 0,
            "queue_note": Value::Null,
            "availability": availability,
            "history_before": history_before,
            "history_skipped": 0,
            "history_problem": Value::Null,
            "history_persisted": true,
            "conversation_specialist": Value::Null,
            "target": Value::Null,
            "producer": producer,
        })
    }
}

fn wait_view(link: &dyn ChatLink, wait_ms: u64, done: impl Fn(&Value) -> bool) -> (Value, bool) {
    let end = Instant::now() + std::time::Duration::from_millis(wait_ms);
    loop {
        let v = link.view();
        if done(&v) {
            return (v, true);
        }
        if Instant::now() >= end {
            return (v, false);
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

impl ChatHost {
    pub fn new() -> ChatHost {
        ChatHost { inner: std::sync::Mutex::new(HostInner::default()) }
    }

    /// Whether a turn was live at the last projection: the host keeps re-publishing while
    /// it is, because a submitted turn's settle grace ends by time, not by a frame.
    pub fn has_live(&self) -> bool {
        self.inner.lock().expect("chat host lock").live
    }

    /// The `chat:state` conversation keys over the daemon's chat view (`ChatLink::view`).
    pub fn project(&self, chat: &Value, now_ms: u64) -> Value {
        self.inner.lock().expect("chat host lock").project(chat, now_ms)
    }

    /// Route one page verb (already parsed by `chat::parse_command`) for the caller window.
    pub fn route(&self, link: &dyn ChatLink, caller: &str, cmd: &crate::chat::Command, now_ms: u64) -> Result<Routed, crate::chat::ChatError> {
        use crate::chat::Command;
        match cmd {
            Command::View | Command::Check => {
                // the engine's real state: a status read through the gated parser, at most
                // once per STATUS_GAP_MS (the daemon also pushes every change, and each
                // line spends the chat's own per-minute budget); a refused or offline
                // status never fails the view itself
                let due = {
                    let mut inner = self.inner.lock().expect("chat host lock");
                    let due = inner.last_status_ms.is_none_or(|t| now_ms.saturating_sub(t) >= STATUS_GAP_MS);
                    if due {
                        inner.last_status_ms = Some(now_ms);
                    }
                    due
                };
                if due {
                    let _ = link.command(caller, &json!({"action": "chat_status"}));
                }
                Ok(Routed::View)
            }
            Command::Open | Command::Back | Command::Height { .. } => Ok(Routed::Local),
            Command::New | Command::NewWith { .. } | Command::List | Command::Restore { .. } => Err(conversations_off()),
            Command::Submit { text, client_request_id, attachments } => {
                if !attachments.is_empty() {
                    return Err(attachments_off());
                }
                self.submit(link, caller, text, client_request_id, now_ms)
            }
            Command::Cancel { turn_id } => self.cancel(link, caller, turn_id, now_ms),
            Command::History { conversation_id, before } => {
                if conversation_id != CHAT_CONVERSATION_ID {
                    return Err(crate::chat::ChatError::invalid_input("Pedido de chat inválido."));
                }
                self.history(link, caller, *before, now_ms)
            }
        }
    }

    fn submit(&self, link: &dyn ChatLink, caller: &str, text: &str, client_request_id: &str, now_ms: u64) -> Result<Routed, crate::chat::ChatError> {
        let text = crate::chat::validate_text(text)?;
        let before = link.view();
        {
            let mut inner = self.inner.lock().expect("chat host lock");
            if let Some(p) = inner.pending.iter().find(|p| p.client_request_id == client_request_id) {
                return Ok(Routed::Answer(json!({"turn_id": format!("t-{}", p.num), "duplicate": true})));
            }
            let current = inner.project(&before, now_ms);
            if !current["active_turn"].is_null() || chat_busy(&before) {
                return Err(crate::chat::ChatError::queue_full());
            }
        }
        if !chat_connected(&before) {
            return Err(engine_unavailable());
        }
        let payload = json!({"action": "chat_send", "text": text, "clientRequestId": client_request_id});
        let mut inner = self.inner.lock().expect("chat host lock");
        link.command(caller, &payload).map_err(|_| send_refused())?;
        // live output already on screen never becomes this turn's reply
        let owner = inner.pending.last().map(|p| p.num).unwrap_or(0);
        let earlier_live: Vec<String> = chat_messages(&before)
            .iter()
            .filter_map(|m| m.get("id").and_then(Value::as_str).filter(|i| !is_history_id(i)).map(str::to_owned))
            .chain(live_streams(&before).into_iter().map(|(id, _)| id))
            .collect();
        for id in earlier_live {
            inner.live_owner.entry(id).or_insert(owner);
        }
        let num = inner.alloc_up();
        let (err_seen, _) = error_counter(&before);
        inner.pending.push(Pending {
            num,
            client_request_id: client_request_id.to_owned(),
            text,
            submitted_ms: now_ms,
            reply: String::new(),
            err_seen,
            ended: None,
        });
        if inner.pending.len() > MAX_PENDING {
            inner.pending.remove(0);
        }
        Ok(Routed::Answer(json!({"turn_id": format!("t-{num}"), "duplicate": false})))
    }

    fn cancel(&self, link: &dyn ChatLink, caller: &str, turn_id: &str, now_ms: u64) -> Result<Routed, crate::chat::ChatError> {
        let view = link.view();
        let mut inner = self.inner.lock().expect("chat host lock");
        let current = inner.project(&view, now_ms);
        if current["active_turn"].as_str() != Some(turn_id) {
            return Ok(Routed::Answer(json!({"cancelled": false})));
        }
        link.command(caller, &json!({"action": "chat_abort"})).map_err(|_| send_refused())?;
        if let Some(p) = inner.pending.last_mut().filter(|p| format!("t-{}", p.num) == turn_id && p.ended.is_none()) {
            p.ended = Some(TurnEnd::Cancelled);
        }
        Ok(Routed::Answer(json!({"cancelled": true})))
    }

    fn history(&self, link: &dyn ChatLink, caller: &str, before: Option<u64>, now_ms: u64) -> Result<Routed, crate::chat::ChatError> {
        let start = link.view();
        let (err_before, _) = error_counter(&start);
        let Some(n) = before else {
            link.command(caller, &json!({"action": "chat_history"})).map_err(|_| send_refused())?;
            let (v, _) = wait_view(link, REFRESH_WAIT_MS, |v| v.get("messages") != start.get("messages") || error_counter(v).0 > err_before);
            let p = self.project(&v, now_ms);
            return Ok(Routed::Answer(json!({"conversation_id": CHAT_CONVERSATION_ID, "turns": p["turns"], "before": p["history_before"], "skipped": 0})));
        };
        let cursor = self
            .inner
            .lock()
            .expect("chat host lock")
            .id_by_num
            .get(&n)
            .cloned()
            .filter(|id| page_id_ok(id))
            .ok_or_else(|| crate::chat::ChatError::invalid_input("Pedido de chat inválido."))?;
        link.command(caller, &json!({"action": "chat_earlier", "before": cursor})).map_err(|_| send_refused())?;
        let first_id = |v: &Value| v.pointer("/messages/0/id").and_then(Value::as_str).map(str::to_owned);
        let first_before = first_id(&start);
        let earlier_flag = |v: &Value| v.get("hasEarlier").and_then(Value::as_bool);
        let flag_before = earlier_flag(&start);
        // the page arrived when the oldest message or the has-earlier flag moved (an empty
        // or fully-known page only flips the flag), or the daemon answered an error
        let (v, arrived) = wait_view(link, HISTORY_WAIT_MS, |v| {
            first_id(v) != first_before || earlier_flag(v) != flag_before || error_counter(v).0 > err_before
        });
        if !arrived || error_counter(&v).0 > err_before {
            return Err(history_unavailable());
        }
        let p = self.project(&v, now_ms);
        let older: Vec<Value> = p["turns"]
            .as_array()
            .map(|ts| {
                ts.iter()
                    .filter(|t| t["turn_id"].as_str().and_then(|id| id.strip_prefix("t-")?.parse::<u64>().ok()).is_some_and(|k| k < n))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        Ok(Routed::Answer(json!({"conversation_id": CHAT_CONVERSATION_ID, "turns": older, "before": p["history_before"], "skipped": 0})))
    }
}

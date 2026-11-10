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

/// The daemon's page-id grammar for `get_earlier` (`HISTORY_BEFORE`): `s<file>-<turn>`.
fn page_id_ok(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_ID_CHARS || bytes[0] != b's' { return false; }
    let mut parts = bytes[1..].split(|b| *b == b'-');
    let (Some(file), Some(turn), None) = (parts.next(), parts.next(), parts.next()) else { return false };
    !file.is_empty() && !turn.is_empty() && file.iter().all(|b| b.is_ascii_digit()) && turn.iter().all(|b| b.is_ascii_digit())
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
    /// it never travels on the wire (the daemon de-dupes `send` on its side and
    /// ties the answer to the shared session, not to a client request id).
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
    pub options: Vec<String>,
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

    /// The newest pending ask, or None. The daemon can hold up to 16; the UI
    /// answers the newest (the one the user is looking at).
    pub fn pending_ask(&self) -> Option<&ChatAsk> { self.asks.last() }

    /// Parse and dispatch one UI command for the given caller window. The label
    /// is part of the API on purpose: only the exact main island window may chat
    /// (the settings window keeps its own connection, and its gate offers no
    /// chat verbs), so the Tauri command cannot forget the check.
    pub fn command(&self, caller: &str, payload: &Value) -> Result<ChatCommand, CommandError> {
        if caller != CHAT_WINDOW_LABEL { return Err(CommandError); }
        parse_chat_command(&self.asks, payload)
    }

    /// Fold one server frame in. Unknown or malformed frames change nothing.
    pub fn apply(&mut self, frame: &Value) {
        let Some(t) = frame.get("type").and_then(Value::as_str) else { return };
        match t {
            "agent_state" => {
                // a closed status set; anything else reads as the honest null
                let status = frame.get("status").and_then(Value::as_str).filter(|s| matches!(*s, "ready" | "restarting" | "stopped" | "starting" | "unavailable"));
                self.agent = json!({
                    "busy": frame.get("busy").and_then(Value::as_bool).unwrap_or(false),
                    "status": status,
                    "paused": frame.get("paused").and_then(Value::as_bool).unwrap_or(false),
                });
            }
            "message_delta" => {
                let (Some(id), Some(text)) = (id_field(frame, "messageId"), str_field(frame, "text")) else { return };
                if text.is_empty() { return; }
                if let Some(slot) = self.streaming.iter_mut().find(|s| s.id == id) {
                    let mut acc = std::mem::take(&mut slot.text);
                    push_bounded(&mut acc, text, MAX_STREAM_CHARS);
                    slot.text = acc;
                } else {
                    if self.streaming.len() >= MAX_STREAM_MESSAGES { self.streaming.remove(0); }
                    let mut acc = String::new();
                    push_bounded(&mut acc, text, MAX_STREAM_CHARS);
                    self.streaming.push(StreamMessage { id: id.to_owned(), text: acc });
                }
            }
            "message_done" => {
                let Some(id) = id_field(frame, "messageId") else { return };
                let text = match self.streaming.iter().position(|s| s.id == id) {
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
                self.messages.push(json!({"id": id, "role": "assistant", "text": text, "activities": activities}));
            }
            "activity" => self.fold_activity(frame),
            "history" => self.fold_history(frame, false),
            "earlier" => self.fold_history(frame, true),
            "ask" => {
                let Some(ask) = ask_view(frame) else { return };
                if self.asks.len() >= MAX_ASKS { return; } // past the bound: never registered, never answerable
                self.pending_ask = serde_json::to_value(&ask).unwrap_or(Value::Null);
                self.asks.push(ask);
            }
            "ask_resolved" => {
                let Some(id) = id_field(frame, "id") else { return };
                self.asks.retain(|a| a.id != id);
                self.pending_ask = self.asks.last().map(|a| serde_json::to_value(a).unwrap_or(Value::Null)).unwrap_or(Value::Null);
            }
            "toast" => {
                let Some(message) = frame.get("message").and_then(Value::as_str) else { return };
                let Some(level) = frame.get("level").and_then(Value::as_str).filter(|l| matches!(*l, "info" | "warning" | "error")) else { return };
                if self.toasts.len() >= MAX_TOASTS { self.toasts.remove(0); }
                self.toasts.push(json!({"level": level, "message": clip_utf16(message, 300)}));
            }
            "queue" => {
                let count = |k: &str| frame.get(k).and_then(Value::as_u64).unwrap_or(0).min(100);
                self.queue = json!({"steering": count("steering"), "followUp": count("followUp")});
            }
            "error" => {
                let code = match frame.get("code").and_then(Value::as_str) {
                    Some(c) if ERROR_CODES.contains(&c) => c,
                    _ => "failed",
                };
                let n = self.last_error["n"].as_u64().unwrap_or(0) + 1;
                self.last_error = json!({"code": code, "n": n});
            }
            _ => {}
        }
    }

    /// Live activities pair running→done/error by the engine's `callId`. An
    /// off-vocabulary state, or a done/error with no prior running entry, is
    /// dropped — never guessed. The finished entries attach to the next
    /// completed message (`message_done`).
    fn fold_activity(&mut self, frame: &Value) {
        let Some(name) = str_field(frame, "name") else { return };
        let Some(state) = frame.get("state").and_then(Value::as_str).filter(|s| matches!(*s, "running" | "done" | "error")) else { return };
        let Some(call_id) = id_field(frame, "callId").filter(|c| safe_id_ok(c)) else { return };
        let title = clip_utf16(name, 64);
        match state {
            "running" => {
                let entry = json!({"id": call_id, "kind": "other", "title": title, "status": "running"});
                match self.pending_activities.iter().position(|a| a["id"] == json!(call_id)) {
                    Some(at) => self.pending_activities[at] = entry,
                    None => {
                        if self.pending_activities.len() >= HISTORY_PAGE { self.pending_activities.remove(0); }
                        self.pending_activities.push(entry);
                    }
                }
            }
            // done/error completes the paired running entry; an unpaired one is dropped
            _ => {
                if let Some(at) = self.pending_activities.iter().position(|a| a["id"] == json!(call_id)) {
                    self.pending_activities[at]["status"] = json!(state);
                }
            }
        }
    }

    /// Fold a `history` (replace) or `earlier` (prepend + dedupe by id) page.
    fn fold_history(&mut self, frame: &Value, earlier: bool) {
        let Some(page) = frame.get("messages").and_then(Value::as_array) else { return };
        let messages: Vec<Value> = page.iter().take(HISTORY_PAGE).filter_map(history_message_view).collect();
        self.has_earlier = frame.get("hasEarlier").and_then(Value::as_bool).unwrap_or(false);
        if earlier {
            let mut fresh = Vec::with_capacity(messages.len());
            for m in messages {
                let id = m["id"].clone();
                let known = self.messages.iter().any(|x| x["id"] == id) || fresh.iter().any(|x: &Value| x["id"] == id);
                if !known { fresh.push(m); }
            }
            let mut all = fresh;
            all.append(&mut self.messages);
            // keep the newest bound: the oldest of the merged log fall off
            let excess = all.len().saturating_sub(MAX_MESSAGES);
            all.drain(..excess);
            self.messages = all;
        } else {
            self.messages = messages;
            self.pending_activities.clear();
        }
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
    let options = match frame.get("options").and_then(Value::as_array) {
        Some(opts) if kind == "select" => opts.iter().take(50).filter_map(|o| o.as_str().map(|o| clip_utf16(o, 200))).collect(),
        _ => vec![],
    };
    Some(ChatAsk { id: id.to_owned(), kind: kind.to_owned(), title, options })
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
    Some(json!({"id": id, "role": role, "text": text, "activities": activities}))
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
    match action {
        "chat_send" => {
            exact(3)?;
            let text = text_of(MAX_TEXT_CHARS)?;
            let id = map.get("clientRequestId").and_then(Value::as_str).filter(|i| safe_id_ok(i)).ok_or(CommandError)?;
            Ok(ChatCommand::Send { text, client_request_id: id.to_owned() })
        }
        "chat_steer" => {
            exact(2)?;
            Ok(ChatCommand::Steer { text: text_of(MAX_TEXT_CHARS)? })
        }
        "chat_abort" => exact(1).map(|_| ChatCommand::Abort),
        "chat_history" => exact(1).map(|_| ChatCommand::History),
        "chat_status" => exact(1).map(|_| ChatCommand::Status),
        "chat_earlier" => {
            exact(2)?;
            let before = map.get("before").and_then(Value::as_str).filter(|b| page_id_ok(b)).ok_or(CommandError)?;
            Ok(ChatCommand::Earlier { before: before.to_owned() })
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
                        // a select answer must be one of the SHOWN options
                        "select" if ask.options.iter().any(|o| o == v) => ChatAnswer::Value(v.clone()),
                        "input" => ChatAnswer::Value(v.clone()),
                        _ => return Err(CommandError),
                    }
                }
                _ => return Err(CommandError),
            };
            Ok(ChatCommand::UiResponse { ask_id: ask_id.to_owned(), answer })
        }
        _ => Err(CommandError),
    }
}

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
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

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

/// K2-05 T4 U3 F5: a chat command this client sent that still waits for its answer. The
/// daemon answers an `error` frame ONLY to the client whose command failed (never a
/// broadcast), but it carries no request id: the island attributes each error to the
/// OLDEST waiting command whose daemon handler can emit that code (server.cjs `handle`).
#[derive(Debug, Clone, Copy, PartialEq)]
enum Awaiting {
    /// A `send` the daemon has not accepted yet (no optimistic busy seen).
    Send,
    /// The accepted send's turn (busy seen); `output` = the engine produced something.
    Turn { output: bool },
    /// The turn went quiet with no output: an `engine.request` rejection answers `failed`
    /// right after the busy reset (server.cjs send), so it can still claim that one code.
    Settled,
    /// A `get_history` (false) / `get_earlier` (true) read.
    Read(bool),
    /// A `ui_response`.
    Answer,
    /// A `steer`/`abort` (silent on success).
    Control,
}

impl Awaiting {
    /// Whether the daemon handler of this command can answer `code` (server.cjs `handle`;
    /// `failed`/`rate_limited` are the generic answers every command can get).
    fn can_answer(self, code: &str) -> bool {
        match self {
            Awaiting::Send | Awaiting::Turn { .. } => matches!(code, "bad_request" | "paused" | "unavailable" | "busy" | "failed" | "rate_limited"),
            Awaiting::Settled => code == "failed",
            Awaiting::Read(_) => matches!(code, "unavailable" | "failed" | "rate_limited"),
            Awaiting::Answer => matches!(code, "unknown_ask" | "bad_request" | "unavailable" | "failed" | "rate_limited"),
            Awaiting::Control => matches!(code, "unavailable" | "busy" | "not_busy" | "failed" | "store_not_private" | "paused" | "bad_request" | "rate_limited"),
        }
    }

    /// How long an entry may wait before it can no longer claim an error.
    fn ttl(self) -> Duration {
        match self {
            Awaiting::Send | Awaiting::Turn { .. } => Duration::from_secs(600),
            Awaiting::Settled => Duration::from_secs(10),
            Awaiting::Read(_) | Awaiting::Answer | Awaiting::Control => Duration::from_secs(30),
        }
    }

    fn of(cmd: &ChatCommand) -> Option<Awaiting> {
        match cmd {
            ChatCommand::Send { .. } => Some(Awaiting::Send),
            ChatCommand::Steer { .. } | ChatCommand::Abort => Some(Awaiting::Control),
            ChatCommand::UiResponse { .. } => Some(Awaiting::Answer),
            ChatCommand::History => Some(Awaiting::Read(false)),
            ChatCommand::Earlier { .. } => Some(Awaiting::Read(true)),
            // `status` never fails on the daemon (its answer is a plain agent_state)
            ChatCommand::Status => None,
        }
    }
}

/// The waiting-command ledger's bound (the island's own rate limit keeps it far below).
const MAX_AWAITING: usize = 32;

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
    /// F5: the commands this client sent that still wait for an answer (see [`Awaiting`]).
    /// Interior mutability because [`ChatState::command`] takes `&self` (the transport parses
    /// and sends under the state lock). Never serialized.
    #[serde(skip)]
    awaiting: RefCell<VecDeque<(Awaiting, Instant)>>,
    /// F5: the errors correlated to this client's own `send` or its turn (code + counter).
    /// Unlike `lastError`, an error answering a history read, an ask answer or a
    /// steer/abort never moves it: only this one may end a thinking turn.
    turn_error: Value,
    /// R3: the requested history/earlier pages answered or refused (counters): a page
    /// request waits for THIS event, never for a fixed delay or a visible change.
    reads: Value,
    /// B1 (U4 verifier): the `get_earlier` reads alone (answered/refused). A newest-page
    /// answer (the reload after deep paging, a settle refresh) that lands while an
    /// `earlier` read waits must never be taken for the earlier page.
    earlier_reads: Value,
    /// F4: whether a newest-history page arrived on this connection (until then the
    /// island keeps showing the last known chat instead of an empty one).
    history_loaded: bool,
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
            awaiting: RefCell::new(VecDeque::new()),
            turn_error: json!({"code": null, "n": 0}),
            reads: json!({"answered": 0, "failed": 0}),
            earlier_reads: json!({"answered": 0, "failed": 0}),
            history_loaded: false,
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
        // F5: the command now waits for its answer (a new send also retires a settled turn:
        // the daemon runs one turn at a time, so a late `failed` can no longer be the old one's)
        if let Some(kind) = Awaiting::of(&cmd) {
            let mut awaiting = self.awaiting.borrow_mut();
            if kind == Awaiting::Send {
                awaiting.retain(|(k, _)| *k != Awaiting::Settled);
            }
            if awaiting.len() >= MAX_AWAITING {
                awaiting.pop_front();
            }
            awaiting.push_back((kind, now));
        }
        Ok(cmd)
    }

    /// F5: attribute one error frame to the OLDEST waiting command that can answer it.
    fn attribute_error(&mut self, code: &str) -> Option<Awaiting> {
        let now = Instant::now();
        let awaiting = self.awaiting.get_mut();
        awaiting.retain(|(k, at)| now.duration_since(*at) < k.ttl());
        let at = awaiting.iter().position(|(k, _)| k.can_answer(code))?;
        awaiting.remove(at).map(|(k, _)| k)
    }

    /// Bump one counter of a `{…, "n"}`-style object.
    fn bump(v: &mut Value, key: &str) {
        let n = v[key].as_u64().unwrap_or(0) + 1;
        v[key] = json!(n);
    }

    /// F5: the agent's busy flag moved — accepted sends become their turn; a quiet engine
    /// retires the turn (with output) or leaves it settled (no output: a late `failed`).
    fn ledger_busy(&mut self, busy: bool) {
        let awaiting = self.awaiting.get_mut();
        if busy {
            for (k, _) in awaiting.iter_mut() {
                if *k == Awaiting::Send {
                    *k = Awaiting::Turn { output: false };
                }
            }
        } else {
            let now = Instant::now();
            awaiting.retain(|(k, _)| !matches!(k, Awaiting::Turn { output: true } | Awaiting::Control));
            for (k, at) in awaiting.iter_mut() {
                if *k == (Awaiting::Turn { output: false }) {
                    *k = Awaiting::Settled;
                    *at = now;
                }
            }
        }
    }

    fn ledger_output(&mut self) {
        for (k, _) in self.awaiting.get_mut().iter_mut() {
            if let Awaiting::Turn { output } = k {
                *output = true;
            }
        }
    }

    /// R3: a requested page arrived (the oldest waiting read of that kind is answered; an
    /// unsolicited `history` broadcast after a rotation can only answer a newest-page read).
    fn ledger_read_answered(&mut self, earlier: bool) -> bool {
        let awaiting = self.awaiting.get_mut();
        match awaiting.iter().position(|(k, _)| *k == Awaiting::Read(earlier)) {
            Some(at) => {
                awaiting.remove(at);
                Self::bump(&mut self.reads, "answered");
                if earlier {
                    Self::bump(&mut self.earlier_reads, "answered");
                }
                true
            }
            None => false,
        }
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
                self.ledger_busy(agent["busy"] == json!(true));
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
                self.ledger_output();
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
                self.ledger_output();
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
            "activity" => {
                self.ledger_output();
                self.fold_activity(frame)
            }
            "history" | "earlier" => {
                let answered = frame.get("messages").and_then(Value::as_array).is_some() && self.ledger_read_answered(t == "earlier");
                let loaded = t == "history" && frame.get("messages").and_then(Value::as_array).is_some() && !self.history_loaded;
                if loaded {
                    self.history_loaded = true;
                }
                self.fold_history(frame, t == "earlier") | answered | loaded
            }
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
                let awaiting = self.awaiting.get_mut();
                if let Some(at) = awaiting.iter().position(|(k, _)| *k == Awaiting::Answer) {
                    awaiting.remove(at);
                }
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
                match self.attribute_error(code) {
                    Some(Awaiting::Send | Awaiting::Turn { .. } | Awaiting::Settled) => {
                        let n = self.turn_error["n"].as_u64().unwrap_or(0) + 1;
                        self.turn_error = json!({"code": code, "n": n});
                    }
                    Some(Awaiting::Read(earlier)) => {
                        Self::bump(&mut self.reads, "failed");
                        if earlier {
                            Self::bump(&mut self.earlier_reads, "failed");
                        }
                    }
                    _ => {}
                }
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
        let mut changed = false;
        // B1 (U4 verifier): the stored messages are ALWAYS one contiguous run of the daemon's
        // history. An `earlier` page ends right before its cursor (`before`): it continues the
        // store only when that cursor is a message the store holds. A page for a cursor the
        // store does not hold (deep paging after the newest page was reloaded) is NOT
        // prepended across the gap: it replaces the store, whose newest end is then missing.
        let before = frame.get("before").and_then(Value::as_str).filter(|b| is_history_id(b));
        let holds_history = self.messages.iter().any(|m| m["id"].as_str().is_some_and(is_history_id));
        let disjoint = earlier && holds_history && before.is_some_and(|b| !self.messages.iter().any(|m| m["id"].as_str() == Some(b)));
        if earlier {
            if disjoint {
                // the stored history run is dropped (it does not touch the page); the live
                // (not yet recorded) messages stay after it, and the view says its newest
                // end is missing (the host reloads it with `history`)
                self.messages.retain(|m| !m["id"].as_str().is_some_and(is_history_id));
                self.newer_trimmed = true;
                changed = true;
            }
            let messages_first = messages.first().and_then(|m| m["id"].as_str()).map(str::to_owned);
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
            // `hasEarlier` speaks of what lies before THIS page: it is the store's flag only
            // when the page reaches the store's oldest end (a page the store already held
            // from further back never says «nothing older» for the whole store)
            let oldest = self.messages.iter().filter_map(|m| m["id"].as_str()).find(|i| is_history_id(i));
            let reaches = match messages_first.as_deref() {
                Some(first) => oldest == Some(first),
                None => before.is_some() && oldest == before,
            };
            if reaches && self.has_earlier != has_earlier {
                self.has_earlier = has_earlier;
                changed = true;
            }
        } else {
            if self.has_earlier != has_earlier {
                self.has_earlier = has_earlier;
                changed = true;
            }
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
/// The longest a `history` page request waits for the daemon's answer frame (R3: the wait
/// ends on the answer itself — `reads` moves — this is only the give-up bound).
const HISTORY_WAIT_MS: u64 = 3_000;
/// F6: the most turns one `chat:state` projection (and one history page answer) carries:
/// the visible window; everything older stays reachable through `history_before` paging.
pub const WINDOW_TURNS: usize = 50;
/// F4: the island's own memory of how settled turns ended (cancelled / interrupted /
/// a reply the daemon's record lacks), kept once the daemon's history carries them.
/// F6-edge (U4 verifier): no separate count bound — an entry lives exactly as long as its
/// turn's number binding (`num_by_id`), so a deep, old cancelled turn never reads as
/// completed; a plain completed turn with no reply of its own needs no entry at all.
/// B2 (U4 verifier): the most extra `get_earlier` reads one page request makes when a
/// daemon page held no whole turn (a lone reply), before handing the page a cursor.
const MAX_EXTRA_READS: usize = 16;
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
    /// A daemon refusal (closed code) or `interrupted` (the daemon or the engine went away
    /// mid-turn: the turn really ran, so its partial text is kept and the daemon's record
    /// of it may still carry the prompt).
    Error(String),
}

impl TurnEnd {
    /// F1: only a turn the engine may have recorded can take over a daemon history message.
    /// A refused send never reached the engine: it never claims one (the same text sent
    /// again is ANOTHER turn, and the refusal stays visible).
    fn may_be_recorded(end: &Option<TurnEnd>) -> bool {
        !matches!(end, Some(TurnEnd::Error(code)) if code != "interrupted")
    }
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
    /// The correlated turn-error counter (`turnError.n`) already accounted for.
    err_seen: u64,
    ended: Option<TurnEnd>,
    /// The daemon history message that recorded this prompt is bound to `num`; the turn
    /// keeps rendering from here until it ends, then the history turn takes over.
    bound: bool,
}

/// What the island knew of a settled turn the daemon's history now carries (F4).
#[derive(Debug, Clone)]
struct Settled {
    state: &'static str,
    error: Value,
    reply: String,
}

/// One projected turn: (number, user text, reply, state, error).
type Row = (u64, String, String, &'static str, Value);

#[derive(Default)]
struct HostInner {
    pending: Vec<Pending>,
    /// Daemon history message id (`s<file>-<turn>`) → turn number.
    num_by_id: std::collections::HashMap<String, u64>,
    id_by_num: std::collections::BTreeMap<u64, String>,
    next_up: u64,
    next_down: u64,
    /// Live (streamed, not yet in history) assistant message id → owning pending turn
    /// number; 0 = it predates every island submission.
    live_owner: std::collections::HashMap<String, u64>,
    /// F4: how settled island turns ended, by turn number (F6-edge: kept while the turn is
    /// in the store; a completed turn the record fully carries has no entry).
    settled: std::collections::BTreeMap<u64, Settled>,
    /// F1-edge: the numbers of island turns that claimed a history message (only those can
    /// raise the claim floor; pruned below the oldest still-pending turn).
    claimed: std::collections::BTreeSet<u64>,
    /// F4: the last daemon history the island saw on a loaded connection (shown while the
    /// daemon is down or a fresh connection has no page yet), its has-earlier flag, and a
    /// cheap signature so an unchanged page is not copied again.
    known: Vec<Value>,
    known_has_earlier: bool,
    known_sig: (usize, String, String),
    /// F6: a turn settled — the daemon's own record is asked for once the engine is quiet.
    refresh_due: bool,
    /// Whether the last projection saw a connected, quiet engine (no busy, no stream).
    quiet: bool,
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

/// `s<file>-<index>` → (file, index) for a history id.
fn history_pos(id: &str) -> Option<(u64, u64)> {
    let (file, index) = id.strip_prefix('s')?.split_once('-')?;
    Some((file.parse().ok()?, index.parse().ok()?))
}

/// B1 (U4 verifier): whether history message `next` directly follows `prev` in the daemon's
/// record (the next index of the same session file, or the first of the next one).
fn follows(prev: &str, next: &str) -> bool {
    match (history_pos(prev), history_pos(next)) {
        (Some((pf, pi)), Some((nf, ni))) => (nf == pf && ni == pi + 1) || (nf == pf + 1 && ni == 1),
        _ => false,
    }
}

fn msg_id(m: &Value) -> Option<&str> {
    m.get("id").and_then(Value::as_str)
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

/// F5: the errors correlated to the island's own send / turn (never a read's, an ask
/// answer's or a steer's).
fn turn_error_counter(chat: &Value) -> (u64, String) {
    let n = chat.pointer("/turnError/n").and_then(Value::as_u64).unwrap_or(0);
    let code = chat.pointer("/turnError/code").and_then(Value::as_str).unwrap_or("failed").to_owned();
    (n, code)
}

/// R3: (answered, refused) requested history pages.
fn reads_counter(chat: &Value) -> (u64, u64) {
    let get = |k: &str| chat.pointer(&format!("/reads/{k}")).and_then(Value::as_u64).unwrap_or(0);
    (get("answered"), get("failed"))
}

/// B1: (answered, refused) `get_earlier` reads only.
fn earlier_reads_counter(chat: &Value) -> (u64, u64) {
    let get = |k: &str| chat.pointer(&format!("/earlierReads/{k}")).and_then(Value::as_u64).unwrap_or(0);
    (get("answered"), get("failed"))
}

/// B1: (answered, refused) newest-page (`get_history`) reads only.
fn history_reads_counter(chat: &Value) -> (u64, u64) {
    let (a, f) = reads_counter(chat);
    let (ea, ef) = earlier_reads_counter(chat);
    (a.saturating_sub(ea), f.saturating_sub(ef))
}

/// The oldest daemon history message the chat view holds (where its contiguous run starts).
fn oldest_history_id(chat: &Value) -> Option<String> {
    chat.get("messages")?.as_array()?.iter().filter_map(msg_id).find(|i| is_history_id(i)).map(str::to_owned)
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

fn turn_view(num: u64, user_text: &str, reply: &str, state: &str, error: &Value, seq: u64) -> Value {
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

fn end_error(code: &str) -> Value {
    json!({"code": code, "safe_message": daemon_error_message(code), "retryable": true})
}

/// The full, ordered turn list of one view (before the F6 window).
struct Turns {
    rows: Vec<Row>,
    has_earlier: bool,
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
    /// message whose text is a submitted turn's text takes that turn's number — unless
    /// that turn was refused (F1: it never reached the engine) or is already bound.
    /// `older_when_unknown`: a view whose newest end was trimmed (F3) holds only OLDER
    /// messages, so a batch with no known id counts down instead of up.
    fn number_history(&mut self, messages: &[Value], older_when_unknown: bool) {
        let ids: Vec<(&str, &str, &str)> = messages
            .iter()
            .filter_map(|m| {
                let id = msg_id(m)?;
                is_history_id(id).then_some((
                    id,
                    m.get("role").and_then(Value::as_str).unwrap_or(""),
                    m.get("text").and_then(Value::as_str).unwrap_or(""),
                ))
            })
            .collect();
        let first_known = ids.iter().position(|(id, _, _)| self.num_by_id.contains_key(*id));
        let split = first_known.unwrap_or(if older_when_unknown { ids.len() } else { 0 });
        for (id, _, _) in ids[..split].iter().rev() {
            let n = self.alloc_down();
            self.bind(id, n);
        }
        // F1-edge (U4 verifier): claims follow the send order. The daemon records one turn at
        // a time, so once the record carries an island turn `m`, no island turn sent before
        // `m` (a smaller number) can own a LATER record: the newest island turn seen so far in
        // the record is the floor a claiming turn must be above. (A message another client
        // sent never raises it: its number says nothing about the island's send order.)
        let mut floor = 0u64;
        for (id, role, text) in &ids[split..] {
            if let Some(&n) = self.num_by_id.get(*id) {
                if *role == "user" && self.claimed.contains(&n) {
                    floor = floor.max(n);
                }
                continue;
            }
            let claimed = (*role == "user")
                .then(|| {
                    self.pending
                        .iter()
                        .position(|p| !p.bound && p.num > floor && TurnEnd::may_be_recorded(&p.ended) && p.text.trim() == text.trim())
                })
                .flatten();
            let n = match claimed {
                Some(at) => {
                    self.pending[at].bound = true;
                    let n = self.pending[at].num;
                    self.claimed.insert(n);
                    floor = floor.max(n);
                    n
                }
                None => self.alloc_up(),
            };
            self.bind(id, n);
        }
    }

    /// F4: the history the projection shows. A loaded connection's own page is the truth
    /// (and becomes the last known chat); a lost connection, or a fresh one with no page
    /// yet, keeps showing the last known history plus whatever live output the view has.
    /// F3: a view whose newest end was trimmed by deep paging is not the chat's newest end:
    /// the projection keeps the last known history until the reloaded newest page lands
    /// (`raw` = a history page answer, which reads the trimmed view as it is).
    fn shown_messages(&mut self, chat: &Value, raw: bool) -> (Vec<Value>, bool) {
        let trimmed = chat.get("newerTrimmed").and_then(Value::as_bool) == Some(true);
        let loaded = chat_connected(chat) && chat.get("historyLoaded").and_then(Value::as_bool) == Some(true) && (raw || !trimmed);
        let view = chat.get("messages").and_then(Value::as_array);
        if raw && trimmed {
            let messages = view.cloned().unwrap_or_default();
            let has_earlier = chat.get("hasEarlier").and_then(Value::as_bool) == Some(true);
            return (messages, has_earlier);
        }
        if loaded {
            let messages = view.cloned().unwrap_or_default();
            let has_earlier = chat.get("hasEarlier").and_then(Value::as_bool) == Some(true);
            let history = || messages.iter().filter(|m| msg_id(m).is_some_and(is_history_id));
            let sig = (
                history().count(),
                history().next().and_then(msg_id).unwrap_or("").to_owned(),
                history().next_back().and_then(msg_id).unwrap_or("").to_owned(),
            );
            if sig != self.known_sig {
                self.known = history().cloned().collect();
                self.known_sig = sig;
            }
            self.known_has_earlier = has_earlier;
            return (messages, has_earlier);
        }
        let mut messages = self.known.clone();
        messages.extend(view.into_iter().flatten().filter(|m| !msg_id(m).is_some_and(is_history_id)).cloned());
        (messages, self.known_has_earlier)
    }

    /// Every turn of the view, in chat order, and the submitted turns' lifecycle (terminal
    /// states are kept, never resurrected).
    fn turns(&mut self, chat: &Value, now_ms: u64, raw: bool) -> Turns {
        let trimmed = chat.get("newerTrimmed").and_then(Value::as_bool) == Some(true);
        if trimmed && !raw {
            // the trimmed view's older ids still get their (downward) numbers
            self.number_history(&chat_messages(chat), true);
        }
        let (messages, has_earlier) = self.shown_messages(chat, raw);
        self.number_history(&messages, raw && trimmed);
        let connected = chat_connected(chat);
        let busy = chat_busy(chat);
        let engine_down = matches!(chat.pointer("/agent/status").and_then(Value::as_str), Some("restarting" | "stopped" | "unavailable"));
        let (err_n, err_code) = turn_error_counter(chat);

        // live output (landed assistant messages not yet in the daemon's history, and
        // messages still streaming), each owned by the newest submission that preceded it
        // (0 = it predates every submission on this island)
        let streams = live_streams(chat);
        self.quiet = connected && !busy && streams.is_empty();
        let present: std::collections::HashSet<&str> =
            messages.iter().filter_map(msg_id).chain(streams.iter().map(|(id, _)| id.as_str())).collect();
        self.live_owner.retain(|id, _| present.contains(id.as_str()));
        let newest = self.pending.last().map(|p| p.num).unwrap_or(0);
        // (owner, text, still streaming)
        let mut live: Vec<(u64, String, bool)> = Vec::new();
        for m in &messages {
            let Some(id) = msg_id(m) else { continue };
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

        // submitted turns: advance the lifecycle
        let count = self.pending.len();
        let mut live_state: Option<(u64, &'static str)> = None;
        let mut settled_now = false;
        for (i, p) in self.pending.iter_mut().enumerate() {
            let (reply, streaming) = owned(p.num);
            // the turn's own output, also after it ended: a cancelled turn's held tail
            // still lands (the daemon flushes it once), and only this turn owns it
            if !reply.is_empty() {
                p.reply = reply;
            }
            if p.ended.is_some() {
                continue;
            }
            let end = if i + 1 != count {
                // the daemon runs one turn at a time: a later submission settled this one
                Some(TurnEnd::Completed)
            } else if !connected {
                // F4: the daemon went away mid-turn: interrupted, never completed
                Some(TurnEnd::Error("interrupted".into()))
            } else if err_n > p.err_seen && p.reply.is_empty() && !streaming {
                // F5: an error correlated to THIS send, and nothing produced: the send failed
                Some(TurnEnd::Error(err_code.clone()))
            } else if engine_down {
                // F4: the engine restarted or stopped under the turn
                Some(TurnEnd::Error("interrupted".into()))
            } else if busy && streaming {
                live_state = Some((p.num, "streaming"));
                None
            } else if busy || (p.reply.is_empty() && now_ms.saturating_sub(p.submitted_ms) < PENDING_SETTLE_MS) {
                // with nothing yet, the settle grace covers the optimistic busy in flight
                live_state = Some((p.num, "thinking"));
                None
            } else {
                // the engine is quiet: terminal, so a later busy (another client's turn)
                // never resurrects it; a stream the engine never closed ends here too
                Some(TurnEnd::Completed)
            };
            if matches!(end, Some(TurnEnd::Completed)) {
                settled_now = true;
            }
            p.ended = end;
        }
        if settled_now {
            self.refresh_due = true;
        }

        // a settled turn the daemon's history now carries: the history turn takes over,
        // and the island keeps how it really ended (F4: cancelled / interrupted / the reply)
        let mut keep = Vec::with_capacity(self.pending.len());
        for p in std::mem::take(&mut self.pending) {
            match (&p.ended, p.bound) {
                (Some(end), true) => {
                    let (state, error) = match end {
                        TurnEnd::Completed => ("completed", Value::Null),
                        TurnEnd::Cancelled => ("cancelled", Value::Null),
                        TurnEnd::Error(code) => ("error", end_error(code)),
                    };
                    if state != "completed" || !p.reply.is_empty() {
                        self.settled.insert(p.num, Settled { state, error, reply: p.reply });
                    }
                }
                _ => keep.push(p),
            }
        }
        self.pending = keep;
        // F1-edge: a claimed number below every pending turn can no longer stop a claim
        match self.pending.iter().map(|p| p.num).min() {
            Some(min) => self.claimed.retain(|n| *n >= min),
            None => self.claimed.clear(),
        }

        // history turns (a still-pending bound turn renders from its pending entry)
        let mut rows: Vec<Row> = Vec::new();
        // B1: the history id the last row's messages end with — a reply attaches to the turn
        // before it ONLY when it directly follows it in the daemon's record, never across a
        // discontinuity (a leading reply whose prompt is not shown is not a turn)
        let mut prev_id: Option<&str> = None;
        for m in &messages {
            let Some(id) = msg_id(m).filter(|i| is_history_id(i)) else { continue };
            let text = m.get("text").and_then(Value::as_str).unwrap_or("");
            let contiguous = prev_id.is_some_and(|p| follows(p, id));
            prev_id = Some(id);
            match m.get("role").and_then(Value::as_str) {
                Some("user") => {
                    let num = self.num_by_id.get(id).copied().unwrap_or(0);
                    if self.pending.iter().any(|p| p.num == num) {
                        rows.push((0, String::new(), String::new(), "skip", Value::Null));
                    } else {
                        rows.push((num, text.to_owned(), String::new(), "completed", Value::Null));
                    }
                }
                Some("assistant") if contiguous => {
                    if let Some(last) = rows.last_mut() {
                        last.2 = join_reply(&last.2, text);
                    }
                }
                _ => {}
            }
        }
        rows.retain(|r| r.3 != "skip");
        for row in rows.iter_mut() {
            if let Some(s) = self.settled.get_mut(&row.0) {
                row.3 = s.state;
                row.4 = s.error.clone();
                if row.2.is_empty() {
                    row.2 = s.reply.clone();
                } else {
                    // F6-edge: the daemon's record carries the reply now: the island's copy
                    // is no longer needed (only the small end state is kept)
                    s.reply = String::new();
                }
            }
            if self.settled.get(&row.0).is_some_and(|s| s.state == "completed" && s.reply.is_empty()) {
                // a completed turn the record fully carries needs no entry at all
                self.settled.remove(&row.0);
            }
        }

        // live output nobody on this island submitted (a turn in flight when the island
        // connected): it continues the newest history turn when no submission came after it
        let (orphan, orphan_streaming) = owned(0);
        if let Some(last) = rows.last_mut().filter(|_| self.pending.is_empty()) {
            last.2 = join_reply(&last.2, &orphan);
            if busy && orphan_streaming {
                last.3 = "streaming";
            } else if busy && orphan.is_empty() && last.2.is_empty() {
                last.3 = "thinking";
            }
        }

        for p in &self.pending {
            let (state, error) = match &p.ended {
                Some(TurnEnd::Error(code)) => ("error", end_error(code)),
                Some(TurnEnd::Cancelled) => ("cancelled", Value::Null),
                Some(TurnEnd::Completed) => ("completed", Value::Null),
                None => (live_state.filter(|(n, _)| *n == p.num).map(|(_, s)| s).unwrap_or("thinking"), Value::Null),
            };
            rows.push((p.num, p.text.clone(), p.reply.clone(), state, error));
        }
        rows.sort_by_key(|r| r.0);
        Turns { rows, has_earlier }
    }

    /// The `chat:state` conversation projection: the newest `WINDOW_TURNS` turns plus the
    /// paging cursor (F6: never every turn ever seen).
    fn project(&mut self, chat: &Value, now_ms: u64) -> Value {
        self.generation += 1;
        let seq = self.generation;
        let Turns { rows, has_earlier } = self.turns(chat, now_ms, false);
        let active = rows
            .last()
            .filter(|t| matches!(t.3, "thinking" | "streaming"))
            .map(|t| json!(format!("t-{}", t.0)))
            .unwrap_or(Value::Null);
        self.live = !active.is_null();
        let window = &rows[rows.len().saturating_sub(WINDOW_TURNS)..];
        let history_before = match window.first() {
            Some(first) if rows.len() > window.len() || has_earlier => json!(first.0),
            _ => Value::Null,
        };
        let (availability, producer) = availability_and_producer(chat);
        let turns: Vec<Value> = window.iter().map(|(n, u, r, s, e)| turn_view(*n, u, r, s, e, seq)).collect();
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

    /// F6/R3: a turn settled — once the engine is quiet, ask the daemon for its own record
    /// (one `get_history`, exactly once per settle; a failed line is retried next time).
    /// `caller` is the window whose verb triggered it, or the main island window for the
    /// host's own refresh (a fixed, read-only line the page never shapes).
    fn refresh_if_due(&self, link: &dyn ChatLink, caller: &str) {
        let due = {
            let mut inner = self.inner.lock().expect("chat host lock");
            let due = inner.refresh_due && inner.quiet;
            if due {
                inner.refresh_due = false;
            }
            due
        };
        if due && link.command(caller, &json!({"action": "chat_history"})).is_err() {
            self.inner.lock().expect("chat host lock").refresh_due = true;
        }
    }

    /// Route one page verb (already parsed by `chat::parse_command`) for the caller window.
    pub fn route(&self, link: &dyn ChatLink, caller: &str, cmd: &crate::chat::Command, now_ms: u64) -> Result<Routed, crate::chat::ChatError> {
        use crate::chat::Command;
        match cmd {
            Command::View | Command::Check => {
                self.refresh_if_due(link, caller);
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
                self.refresh_if_due(link, caller);
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

    /// R1: the «a turn is running» check and the send are ONE critical section (the host
    /// lock is held from the duplicate check to the recorded turn), so two concurrent
    /// submits can never both pass the check and both reach the daemon.
    fn submit(&self, link: &dyn ChatLink, caller: &str, text: &str, client_request_id: &str, now_ms: u64) -> Result<Routed, crate::chat::ChatError> {
        let text = crate::chat::validate_text(text)?;
        let mut inner = self.inner.lock().expect("chat host lock");
        if let Some(p) = inner.pending.iter().find(|p| p.client_request_id == client_request_id) {
            return Ok(Routed::Answer(json!({"turn_id": format!("t-{}", p.num), "duplicate": true})));
        }
        let before = link.view();
        let current = inner.project(&before, now_ms);
        if !current["active_turn"].is_null() || chat_busy(&before) {
            return Err(crate::chat::ChatError::queue_full());
        }
        if !chat_connected(&before) {
            return Err(engine_unavailable());
        }
        let payload = json!({"action": "chat_send", "text": text, "clientRequestId": client_request_id});
        link.command(caller, &payload).map_err(|_| send_refused())?;
        // live output already on screen never becomes this turn's reply
        let owner = inner.pending.last().map(|p| p.num).unwrap_or(0);
        let earlier_live: Vec<String> = chat_messages(&before)
            .iter()
            .filter_map(|m| msg_id(m).filter(|i| !is_history_id(i)).map(str::to_owned))
            .chain(live_streams(&before).into_iter().map(|(id, _)| id))
            .collect();
        for id in earlier_live {
            inner.live_owner.entry(id).or_insert(owner);
        }
        let num = inner.alloc_up();
        let (err_seen, _) = turn_error_counter(&before);
        inner.pending.push(Pending {
            num,
            client_request_id: client_request_id.to_owned(),
            text,
            submitted_ms: now_ms,
            reply: String::new(),
            err_seen,
            ended: None,
            bound: false,
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
            inner.refresh_due = true;
        }
        Ok(Routed::Answer(json!({"cancelled": true})))
    }

    /// A history page for the page. `None` = the newest window; `Some(n)` = up to
    /// `WINDOW_TURNS` turns older than turn `n`, read from the daemon before the oldest
    /// message the island knows for that turn. Both wait for the daemon's ANSWER (R3: the
    /// `reads` counters), never a fixed delay. F3: when the earlier page pushed the view
    /// over its cap (the newest end trimmed), the newest page is reloaded right after the
    /// answer, so the live chat never loses its latest turns.
    fn history(&self, link: &dyn ChatLink, caller: &str, before: Option<u64>, now_ms: u64) -> Result<Routed, crate::chat::ChatError> {
        let Some(n) = before else {
            // B1: only a NEWEST-page answer ends this wait (an earlier page never does)
            let start = link.view();
            let (answered, failed) = history_reads_counter(&start);
            link.command(caller, &json!({"action": "chat_history"})).map_err(|_| send_refused())?;
            let (v, arrived) = wait_view(link, HISTORY_WAIT_MS, |v| {
                let (a, f) = history_reads_counter(v);
                a > answered || f > failed
            });
            if !arrived || history_reads_counter(&v).1 > failed {
                return Err(history_unavailable());
            }
            let p = self.project(&v, now_ms);
            return Ok(Routed::Answer(json!({"conversation_id": CHAT_CONVERSATION_ID, "turns": p["turns"], "before": p["history_before"], "skipped": 0})));
        };
        // the daemon cursor: the first history message the island bound at or after turn n
        // (turn n's own prompt: the page ends exactly where the shown window starts)
        let mut cursor = {
            let inner = self.inner.lock().expect("chat host lock");
            inner.id_by_num.range(n..).map(|(_, id)| id.clone()).find(|id| page_id_ok(id))
        };
        let mut v = link.view();
        let mut reads = 0;
        let (older, more, seq) = loop {
            if let Some(c) = cursor.take() {
                // B1: wait for THIS read's answer: an `earlier` answer (or refusal) only; the
                // newest-page reload or a settle refresh landing meanwhile never ends the wait
                let (answered, failed) = earlier_reads_counter(&v);
                link.command(caller, &json!({"action": "chat_earlier", "before": c})).map_err(|_| send_refused())?;
                let (next, arrived) = wait_view(link, HISTORY_WAIT_MS, |x| {
                    let (a, f) = earlier_reads_counter(x);
                    a > answered || f > failed
                });
                if !arrived || earlier_reads_counter(&next).1 > failed {
                    return Err(history_unavailable());
                }
                v = next;
                reads += 1;
            }
            let mut inner = self.inner.lock().expect("chat host lock");
            inner.generation += 1;
            let seq = inner.generation;
            let Turns { rows, has_earlier } = inner.turns(&v, now_ms, true);
            let older: Vec<Row> = rows.into_iter().filter(|r| r.0 < n).collect();
            // B2: a daemon page that held no whole turn (a lone reply whose prompt is on the
            // page before) is never handed to the page as an empty answer with no cursor: the
            // next page is read right away, from where the island's record now starts
            if older.is_empty() && has_earlier && reads > 0 && reads <= MAX_EXTRA_READS {
                drop(inner);
                cursor = oldest_history_id(&v);
                if cursor.is_some() {
                    continue;
                }
                inner = self.inner.lock().expect("chat host lock");
            }
            drop(inner);
            let more = older.len() > WINDOW_TURNS || has_earlier;
            let older = older[older.len().saturating_sub(WINDOW_TURNS)..].to_vec();
            break (older, more, seq);
        };
        let before = match older.first() {
            Some(first) if more => json!(first.0),
            // B2: hasEarlier with no turn to anchor on: the cursor stays where it was asked
            None if more => json!(n),
            _ => Value::Null,
        };
        if v.get("newerTrimmed").and_then(Value::as_bool) == Some(true) {
            // F3: reload the newest page (a failure only delays it to the next settle)
            let _ = link.command(caller, &json!({"action": "chat_history"}));
        }
        let turns: Vec<Value> = older.iter().map(|(n, u, r, s, e)| turn_view(*n, u, r, s, e, seq)).collect();
        Ok(Routed::Answer(json!({"conversation_id": CHAT_CONVERSATION_ID, "turns": turns, "before": before, "skipped": 0})))
    }
}

// ---- F7 + R2: the production feed -----------------------------------------------------------

/// The island chat's feed: the host plus the LAST view the connection reader handed over.
/// The reader serializes the chat state once per changing read (U2 L3) and hands that view
/// to [`ChatFeed::reader_callback`]; everything the keeper and the `chat:state` publisher
/// need is read from it — the whole state is never serialized again to ask «connected?»
/// or to project (F7).
pub struct ChatFeed {
    host: ChatHost,
    latest: std::sync::Mutex<Value>,
    link: std::sync::OnceLock<std::sync::Weak<dyn ChatLink + Send + Sync>>,
    emit: Box<dyn Fn(Value) + Send + Sync>,
}

fn wall_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl ChatFeed {
    /// `emit` receives every projection the reader triggers (production: `chat:state`).
    pub fn new(emit: impl Fn(Value) + Send + Sync + 'static) -> std::sync::Arc<ChatFeed> {
        let off = serde_json::to_value(ChatState::disconnected(Reason::NoDaemon)).unwrap_or(Value::Null);
        std::sync::Arc::new(ChatFeed { host: ChatHost::new(), latest: std::sync::Mutex::new(off), link: std::sync::OnceLock::new(), emit: Box::new(emit) })
    }

    /// The connection the host's own refresh goes through (weak: the connection owns the
    /// reader callback, which owns this feed).
    pub fn bind(&self, link: std::sync::Weak<dyn ChatLink + Send + Sync>) {
        let _ = self.link.set(link);
    }

    pub fn host(&self) -> &ChatHost {
        &self.host
    }

    /// THE production reader callback (`chathost::start_conn` passes exactly this to
    /// `ChatConn::new`): keep the handed-over view, project it, ask for the daemon's record
    /// when a turn just settled (F6), emit the projection.
    pub fn reader_callback(feed: &std::sync::Arc<ChatFeed>) -> impl Fn(Value) + Send + Sync + 'static {
        let feed = std::sync::Arc::downgrade(feed);
        move |view| {
            if let Some(feed) = feed.upgrade() {
                *feed.latest.lock().expect("chat feed lock") = view;
                let projection = feed.publish(wall_ms());
                (feed.emit)(projection);
            }
        }
    }

    /// Whether the last handed-over view is connected (the keeper's question; no
    /// serialization).
    pub fn connected(&self) -> bool {
        chat_connected(&self.latest.lock().expect("chat feed lock"))
    }

    /// The projection of the last handed-over view (no refresh side effect).
    pub fn project(&self, now_ms: u64) -> Value {
        let latest = self.latest.lock().expect("chat feed lock");
        self.host.project(&latest, now_ms)
    }

    /// Project the last handed-over view and, when a turn settled and the engine is quiet,
    /// send the host's own history refresh (the keeper calls this while a turn is live,
    /// because a submitted turn's settle grace ends by time, not by a frame).
    pub fn publish(&self, now_ms: u64) -> Value {
        let projection = self.project(now_ms);
        if let Some(link) = self.link.get().and_then(std::sync::Weak::upgrade) {
            self.host.refresh_if_due(&*link, CHAT_WINDOW_LABEL);
        }
        projection
    }
}

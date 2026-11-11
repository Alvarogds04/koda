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

/// The island's own chat rate limit (well below the daemon's 240 frames/minute drop).
pub const CHAT_FRAMES_PER_MINUTE: u32 = 120;
/// The part of that budget only send/steer/abort/answer may spend: history paging and
/// status reads stop short of it, so paging can never make a send be refused.
pub const CHAT_FRAMES_RESERVED: u32 = 20;
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
    /// The engine cycle (`busyStarts`) the message started in: the host tells the island's
    /// own turn's output from another client's by it (S2 follow-ups B2/F6).
    pub turn: u64,
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
    /// A `get_history` (false) / `get_earlier` (true) read, with the engine cycles counted
    /// (`busyStarts`) and the busy flag when it was sent (B2: what its page can prove).
    Read(bool, u64, bool),
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
            Awaiting::Read(..) => matches!(code, "unavailable" | "failed" | "rate_limited"),
            Awaiting::Answer => matches!(code, "unknown_ask" | "bad_request" | "unavailable" | "failed" | "rate_limited"),
            Awaiting::Control => matches!(code, "unavailable" | "busy" | "not_busy" | "failed" | "store_not_private" | "paused" | "bad_request" | "rate_limited"),
        }
    }

    /// How long an entry may wait before it can no longer claim an error.
    fn ttl(self) -> Duration {
        match self {
            Awaiting::Send | Awaiting::Turn { .. } => Duration::from_secs(600),
            Awaiting::Settled => Duration::from_secs(10),
            Awaiting::Read(..) | Awaiting::Answer | Awaiting::Control => Duration::from_secs(30),
        }
    }

    fn of(cmd: &ChatCommand) -> Option<Awaiting> {
        match cmd {
            ChatCommand::Send { .. } => Some(Awaiting::Send),
            ChatCommand::Steer { .. } | ChatCommand::Abort => Some(Awaiting::Control),
            ChatCommand::UiResponse { .. } => Some(Awaiting::Answer),
            ChatCommand::History => Some(Awaiting::Read(false, 0, false)),
            ChatCommand::Earlier { .. } => Some(Awaiting::Read(true, 0, false)),
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
    /// Whether the daemon says older pages exist before the newest page (`history`).
    has_earlier: bool,
    /// Live activities waiting for their message to finish. Never serialized.
    #[serde(skip_serializing)]
    pending_activities: Vec<Value>,
    /// The last `earlier` page, whole (`{before, messages, hasEarlier}`), for the host's
    /// read that asked for it (Gentle Dot's model: an earlier page never enters the newest
    /// view; the host turns it into older turns from its own messages). One page at most.
    earlier_page: Value,
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
    /// S2 follow-ups (B2/F6): how many engine cycles started on this connection (every
    /// `busy` false → true, the island's own sends and other clients' alike). Every live
    /// message is stamped with the cycle it started in.
    busy_starts: u64,
    /// `busyStarts` when the last newest page (`history`) was folded: the cycles started
    /// after it are the turns the island's known record does not carry yet.
    history_starts: u64,
    /// Whether that newest page was folded while the engine was busy (a cycle in flight: its
    /// prompt may or may not be in it yet, so the page proves nothing about that cycle).
    history_busy: bool,
    /// B2: `busyStarts` and the busy flag when the read that page answered was SENT. The daemon
    /// reads the page after it receives the read, so the page holds the prompt of every cycle
    /// counted then, unless one was still running (busy): the host counts the cycles a send's
    /// known record may lack from here, never from a late fold.
    history_asked_starts: u64,
    history_asked_busy: bool,
    /// This connection's identity (process-unique): the cycle counters above restart with
    /// every connection, so the host only compares them within one.
    conn: u64,
}

/// The next connection identity handed out by [`ChatState::new`].
static NEXT_CONN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

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
            earlier_page: Value::Null,
            rate_window: Cell::new(None),
            rate_count: Cell::new(0),
            revision: 0,
            awaiting: RefCell::new(VecDeque::new()),
            turn_error: json!({"code": null, "n": 0}),
            reads: json!({"answered": 0, "failed": 0}),
            earlier_reads: json!({"answered": 0, "failed": 0}),
            history_loaded: false,
            busy_starts: 0,
            history_starts: 0,
            history_busy: false,
            history_asked_starts: 0,
            history_asked_busy: false,
            conn: NEXT_CONN.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
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
        // B2 residual: the newest-page read right before a send belongs with the send — it may
        // use the reserved budget, but never the last slot, which stays the send's own
        let presend = cmd == ChatCommand::History && payload.get("presend") == Some(&Value::Bool(true));
        const WINDOW: std::time::Duration = std::time::Duration::from_secs(60);
        let now = Instant::now();
        match self.rate_window.get() {
            Some(start) if now.duration_since(start) < WINDOW => {
                let next = self.rate_count.get() + 1;
                let read = matches!(cmd, ChatCommand::History | ChatCommand::Earlier { .. } | ChatCommand::Status);
                let limit = if presend {
                    CHAT_FRAMES_PER_MINUTE - 1
                } else if read {
                    CHAT_FRAMES_PER_MINUTE - CHAT_FRAMES_RESERVED
                } else {
                    CHAT_FRAMES_PER_MINUTE
                };
                if next > limit { return Err(CommandError); }
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
            // B2: a read remembers the engine cycles when it was sent (what its page can prove)
            let kind = match kind {
                Awaiting::Read(earlier, ..) => Awaiting::Read(earlier, self.busy_starts, self.agent["busy"] == json!(true)),
                other => other,
            };
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
    /// Returns the engine cycles and busy flag when that read was sent (B2).
    fn ledger_read_answered(&mut self, earlier: bool) -> Option<(u64, bool)> {
        let awaiting = self.awaiting.get_mut();
        let at = awaiting.iter().position(|(k, _)| matches!(k, Awaiting::Read(e, ..) if *e == earlier))?;
        let asked = match awaiting.remove(at) {
            Some((Awaiting::Read(_, starts, busy), _)) => (starts, busy),
            _ => (0, true),
        };
        Self::bump(&mut self.reads, "answered");
        if earlier {
            Self::bump(&mut self.earlier_reads, "answered");
        }
        Some(asked)
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
                if agent["busy"] == json!(true) && self.agent["busy"] != json!(true) {
                    self.busy_starts += 1;
                    changed = true;
                }
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
                    self.streaming.push(StreamMessage { id: id.to_owned(), text: acc, turn: self.busy_starts });
                    true
                }
            }
            "message_done" => {
                let Some(id) = id_field(frame, "messageId") else { return };
                self.ledger_output();
                let (landed, turn) = match self.streaming.iter().position(|s| s.id == id) {
                    Some(at) => {
                        let s = self.streaming.remove(at);
                        (s.text, s.turn)
                    }
                    None => {
                        // a done for an id the island never streamed: land it honestly empty, once
                        let key = json!(id);
                        if self.messages.iter().any(|m| m["id"] == key) { return; }
                        (String::new(), self.busy_starts)
                    }
                };
                if self.messages.len() >= MAX_MESSAGES { self.messages.remove(0); }
                let activities = std::mem::take(&mut self.pending_activities);
                self.messages.push(json!({"id": id, "role": "assistant", "text": landed, "activities": activities, "turn": turn}));
                true
            }
            "activity" => {
                self.ledger_output();
                self.fold_activity(frame)
            }
            "history" | "earlier" => {
                let paged = frame.get("messages").and_then(Value::as_array).is_some();
                let asked = if paged { self.ledger_read_answered(t == "earlier") } else { None };
                let loaded = t == "history" && paged && !self.history_loaded;
                if loaded {
                    self.history_loaded = true;
                }
                self.fold_history(frame, t == "earlier", asked) | asked.is_some() | loaded
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
                    Some(Awaiting::Read(earlier, ..)) => {
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

    /// Fold a `history` page (replaces the newest view, Gentle Dot's `history`) or an
    /// `earlier` page (kept whole for the read that asked for it; it never enters the newest
    /// view, so no store can ever hold two runs with a gap between them). Returns whether the
    /// fold changed the view (L3).
    fn fold_history(&mut self, frame: &Value, earlier: bool, asked: Option<(u64, bool)>) -> bool {
        let Some(page) = frame.get("messages").and_then(Value::as_array) else { return false };
        let messages: Vec<Value> = page.iter().take(HISTORY_PAGE).filter_map(history_message_view).collect();
        let has_earlier = frame.get("hasEarlier").and_then(Value::as_bool).unwrap_or(false);
        if earlier {
            // a page that names no cursor cannot answer any read: ignored
            let Some(before) = frame.get("before").and_then(Value::as_str).filter(|b| is_history_id(b)) else { return false };
            let page = json!({"before": before, "messages": messages, "hasEarlier": has_earlier});
            if self.earlier_page == page {
                return false;
            }
            self.earlier_page = page;
            return true;
        }
        let mut changed = false;
        let busy = self.agent["busy"] == json!(true);
        if self.history_starts != self.busy_starts || self.history_busy != busy {
            self.history_starts = self.busy_starts;
            self.history_busy = busy;
            changed = true;
        }
        // B2: an unsolicited page (the connect read, a rotation broadcast) is read by the daemon
        // right before it is sent: as fresh as its fold
        let (asked_starts, asked_busy) = asked.unwrap_or((self.busy_starts, busy));
        if self.history_asked_starts != asked_starts || self.history_asked_busy != asked_busy {
            self.history_asked_starts = asked_starts;
            self.history_asked_busy = asked_busy;
            changed = true;
        }
        if self.has_earlier != has_earlier {
            self.has_earlier = has_earlier;
            changed = true;
        }
        if self.messages != messages {
            self.messages = messages;
            changed = true;
        }
        // a fresh page is the whole truth: a half-streamed message can never finish against it
        if !self.streaming.is_empty() {
            self.streaming.clear();
            changed = true;
        }
        if !self.pending_activities.is_empty() {
            self.pending_activities.clear();
            changed = true;
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
        "chat_history" => {
            // `presend: true` = the read right before a send (its own budget class, see `command`)
            if !(map.len() == 2 && map.get("presend") == Some(&Value::Bool(true))) {
                exact(1)?;
            }
            ChatCommand::History
        }
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
/// F6: the most turns one `chat:state` projection carries (the visible window); everything
/// older is reached through `history_before` paging, one daemon page per request.
pub const WINDOW_TURNS: usize = 50;
/// Turn numbers (S2 paging redesign, Gentle Dot's model): a history turn is numbered by the
/// daemon's OWN id of its first message (`s<file>-<index>` → file·2^28 + index + 1), so the
/// same turn has the same number on every page, pass and connection. Island turns (sent,
/// not yet in the record) count up from `LIVE_BASE`, above every history number; the record
/// takes such a turn over under the SAME number (`claimed`).
const FILE_SHIFT: u32 = 28;
const LIVE_BASE: u64 = 1 << 52;
/// Island turn numbers a history prompt keeps, and their end states (F4/F6-edge).
const MAX_CLAIMED: usize = 4_096;
/// Cursors handed out whose daemon page started with lone replies (the run's head): those
/// replies complete the turn the next earlier page ends with.
const MAX_HEADS: usize = 64;
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
/// it until the daemon's own history carries the same text (then that history prompt takes
/// the turn over under the SAME number: `claims`).
#[derive(Debug, Clone)]
struct Pending {
    num: u64,
    client_request_id: String,
    text: String,
    submitted_ms: u64,
    /// N1: whether the send went out. A turn is shown (thinking, cancellable) from the moment the
    /// user submits, also while the pre-send read waits; its settle grace starts at the send.
    sent: bool,
    /// Every prompt at or before this record position was recorded before the send (a lower
    /// bound: the newest position the host had seen at send time); an unrecorded turn sorts
    /// right after it, and B2 moves it up only with cycle evidence (see `place_turns`).
    after: u64,
    /// B2 residual: the newest page the island held on the send's connection with EXACTLY the
    /// engine cycles up to `h0` (folded on a quiet engine), as `(its newest position, h0)`. The
    /// prompts after that position are the cycles after `h0`, in record order, so the turn's own
    /// prompt is counted, not guessed by text, whether or not the pre-send read arrived.
    base: Option<(u64, u64)>,
    /// B2: `after` was placed by cycle counting (exact): the latest-twin fallback is off.
    placed: bool,
    /// The connection it was sent on and its engine cycle count (`busyStarts`) then: the
    /// turn's own cycle is the next one, so output of a later cycle is never its own (F6).
    conn: u64,
    starts: u64,
    /// Whether a page showed the prompt this turn took over (false = bound by its lone reply,
    /// so the island keeps the prompt text until a newest page carries it: B1).
    seen_prompt: bool,
    /// The last non-empty reply seen (kept across a connection reset that drops the live
    /// messages from the island's view).
    reply: String,
    /// The correlated turn-error counter (`turnError.n`) already accounted for.
    err_seen: u64,
    ended: Option<TurnEnd>,
    /// A daemon history prompt took this turn over; it keeps rendering from here until it
    /// ends, then the history turn takes over.
    bound: bool,
}

/// What the island knew of a settled turn the daemon's history now carries (F4).
#[derive(Debug, Clone)]
struct Settled {
    state: &'static str,
    error: Value,
    reply: String,
    /// B1: the prompt text while no newest page carried the prompt (its lone reply did).
    user: String,
}

/// One projected turn, with its place in the record: `(prompt position, 0, 0)` for a record
/// turn, `(position seen at send, 1, number)` for an island turn the record does not carry.
#[derive(Debug, Clone)]
struct Row {
    order: (u64, u8, u64),
    num: u64,
    user: String,
    reply: String,
    state: &'static str,
    error: Value,
}

#[derive(Default)]
struct HostInner {
    pending: Vec<Pending>,
    next_live: u64,
    /// History prompt id → the island turn number it took over (bounded, oldest first out).
    claims: std::collections::HashMap<String, u64>,
    claim_order: VecDeque<String>,
    /// Live (streamed, not yet in history) assistant message id → owning pending turn
    /// number; 0 = it predates every island submission.
    live_owner: std::collections::HashMap<String, u64>,
    /// F4: how settled island turns ended, by turn number (lives as long as its claim).
    settled: std::collections::BTreeMap<u64, Settled>,
    /// Cursors handed out for daemon pages that held only a lone reply: that reply completes
    /// the turn the next earlier page ends with (cursor id, reply text; bounded).
    heads: VecDeque<(String, String)>,
    /// The newest record position seen in a history page.
    max_seen: u64,
    /// B2 residual: the last newest page whose read was sent on a quiet engine, as (connection, its
    /// newest record position, the engine cycles counted on that connection when the read was
    /// sent): it held at least the prompts of those cycles.
    base: Option<(u64, u64, u64)>,
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
    /// F6: the (connection, cycle count) the last catch-up read was asked for: a cycle the
    /// known record does not carry (another client's turn) is read once the engine is quiet.
    asked_starts: Option<(u64, u64)>,
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

/// A history id's place in the daemon's record (`file·2^28 + index + 1`, never 0): the turn
/// number of the turn it starts, and the page cursor that ends right before it. `None` off
/// the grammar.
fn record_pos(id: &str) -> Option<u64> {
    let (file, index) = history_pos(id)?;
    (index + 1 < 1 << FILE_SHIFT && file < LIVE_BASE >> FILE_SHIFT).then_some((file << FILE_SHIFT) + index + 1)
}

/// The daemon id at a record position (the inverse of [`record_pos`]).
fn record_id(pos: u64) -> Option<String> {
    let index = (pos & ((1 << FILE_SHIFT) - 1)).checked_sub(1)?;
    (pos < LIVE_BASE).then(|| format!("s{}-{index}", pos >> FILE_SHIFT))
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

fn msg_role(m: &Value) -> &str {
    m.get("role").and_then(Value::as_str).unwrap_or("")
}

fn msg_text(m: &Value) -> &str {
    m.get("text").and_then(Value::as_str).unwrap_or("")
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

/// The messages still streaming, as (daemon message id, text so far, engine cycle).
fn live_streams(chat: &Value) -> Vec<(String, String, u64)> {
    let starts = busy_starts(chat);
    chat.get("streaming")
        .and_then(Value::as_array)
        .map(|s| {
            s.iter()
                .filter_map(|m| Some((m.get("id")?.as_str()?.to_owned(), m.get("text")?.as_str()?.to_owned(), msg_turn(m, starts))))
                .collect()
        })
        .unwrap_or_default()
}

/// The engine cycles started on the view's connection (`busyStarts`).
fn busy_starts(chat: &Value) -> u64 {
    chat.get("busyStarts").and_then(Value::as_u64).unwrap_or(0)
}

/// The view's connection identity (`conn`).
fn chat_conn(chat: &Value) -> u64 {
    chat.get("conn").and_then(Value::as_u64).unwrap_or(0)
}

/// Whether the view is a connected one whose own newest page arrived.
fn chat_loaded(chat: &Value) -> bool {
    chat_connected(chat) && chat.get("historyLoaded").and_then(Value::as_bool) == Some(true)
}

/// `busyStarts` when the view's newest page was folded (`historyStarts`).
fn history_starts(chat: &Value) -> u64 {
    chat.get("historyStarts").and_then(Value::as_u64).unwrap_or(0)
}

/// Whether the view's newest page carries every engine cycle that already started and
/// ended (folded on a quiet engine, after the last cycle began).
fn history_current(chat: &Value) -> bool {
    busy_starts(chat) <= history_starts(chat) && chat.get("historyBusy").and_then(Value::as_bool) != Some(true)
}

/// The engine cycle a live message started in (`fallback` when unstamped).
fn msg_turn(m: &Value, fallback: u64) -> u64 {
    m.get("turn").and_then(Value::as_u64).unwrap_or(fallback)
}

/// B1: the daemon id of the prompt right before a history reply (the reply's own file, the
/// index before it); None for the first message of a file (its prompt is in the file before).
fn prompt_before(id: &str) -> Option<String> {
    let (file, index) = history_pos(id)?;
    (index >= 2).then(|| format!("s{file}-{}", index - 1))
}

/// B1: whether a recorded reply is the reply the island streamed for its own turn (the record
/// may hold a clipped prefix of it; control characters are display-stripped on both sides).
fn same_reply(live: &str, recorded: &Value) -> bool {
    let clean = |t: &str| t.chars().filter(|c| !c.is_control() || matches!(c, '\t' | '\n' | '\r')).collect::<String>();
    let (live, text) = (clean(live), clean(msg_text(recorded)));
    let (live, text) = (live.trim_end(), text.trim_end());
    if text.is_empty() {
        return false;
    }
    let clipped = recorded.get("clipped").and_then(Value::as_bool) == Some(true) || utf16_len(text) + 1 >= MAX_TEXT_CHARS;
    live == text || (clipped && live.starts_with(text))
}

/// F5: the errors correlated to the island's own send / turn (never a read's, an ask
/// answer's or a steer's).
fn turn_error_counter(chat: &Value) -> (u64, String) {
    let n = chat.pointer("/turnError/n").and_then(Value::as_u64).unwrap_or(0);
    let code = chat.pointer("/turnError/code").and_then(Value::as_str).unwrap_or("failed").to_owned();
    (n, code)
}

/// R3: (answered, refused) requested pages of one kind: `earlierReads`, or every read.
fn reads_counter(chat: &Value, kind: &str) -> (u64, u64) {
    let get = |k: &str| chat.pointer(&format!("/{kind}/{k}")).and_then(Value::as_u64).unwrap_or(0);
    (get("answered"), get("failed"))
}

/// B1: (answered, refused) newest-page (`get_history`) reads only.
fn history_reads_counter(chat: &Value) -> (u64, u64) {
    let (a, f) = reads_counter(chat, "reads");
    let (ea, ef) = reads_counter(chat, "earlierReads");
    (a.saturating_sub(ea), f.saturating_sub(ef))
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

fn turn_view(row: &Row, seq: u64) -> Value {
    json!({
        "turn_id": format!("t-{}", row.num),
        "request_id": Value::Null,
        "state": row.state,
        "seq": seq,
        "user_text": row.user,
        "reply": row.reply,
        "finish_reason": Value::Null,
        "error": row.error,
        "trimmed_turns": 0,
        "profile_id": Value::Null,
        "profile_revision": Value::Null,
        "attachments": [],
    })
}

fn end_error(code: &str) -> Value {
    json!({"code": code, "safe_message": daemon_error_message(code), "retryable": true})
}

fn end_view(end: &TurnEnd) -> (&'static str, Value) {
    match end {
        TurnEnd::Completed => ("completed", Value::Null),
        TurnEnd::Cancelled => ("cancelled", Value::Null),
        TurnEnd::Error(code) => ("error", end_error(code)),
    }
}

/// The row state of a bound island turn still running (rendered where its prompt was
/// recorded, from what the island saw).
const LIVE_ROW: &str = "live";

impl HostInner {
    fn alloc_live(&mut self) -> u64 {
        self.next_live = self.next_live.max(LIVE_BASE) + 1;
        self.next_live
    }

    fn claim(&mut self, id: &str, num: u64) {
        self.claims.insert(id.to_owned(), num);
        self.claim_order.push_back(id.to_owned());
        while self.claim_order.len() > MAX_CLAIMED {
            if let Some(n) = self.claim_order.pop_front().and_then(|old| self.claims.remove(&old)) {
                self.settled.remove(&n);
            }
        }
    }

    /// B2 residual: advance each sent turn's floor past the prompts its known cycles prove were
    /// recorded before its send, from the record alone (no pre-send read needed). The prompts after
    /// the turn's base position are the cycles after the base's count, in record order, so the
    /// first `starts - h0` of them are other cycles that ran before the send; when fewer are on
    /// the page, every prompt on it is one of those. `from_start` = the page begins the record.
    /// A cycle that recorded no prompt only moves the floor further (the turn then never claims:
    /// shown twice rather than under another client's prompt).
    fn place_turns(&mut self, messages: &[Value], from_start: bool) {
        let record: Vec<(u64, &str, bool)> = messages
            .iter()
            .filter_map(|m| msg_id(m).and_then(|id| record_pos(id).map(|p| (p, id, msg_role(m) == "user"))))
            .collect();
        let (Some(&(first, first_id, _)), Some(&(newest, _, _))) = (record.first(), record.last()) else { return };
        for p in self.pending.iter_mut().filter(|p| p.sent && !p.bound) {
            let Some((base, h0)) = p.base else { continue };
            let reaches = from_start || first <= base || record_id(base).is_some_and(|b| follows(&b, first_id));
            if !reaches || newest < base {
                continue;
            }
            let before_send = p.starts.saturating_sub(h0) as usize;
            let mut prompts = record.iter().filter(|(pos, _, user)| *user && *pos > base).map(|(pos, _, _)| *pos);
            let floor = match before_send {
                0 => base,
                n => prompts.nth(n - 1).unwrap_or(newest),
            };
            p.after = p.after.max(floor);
            p.placed = true;
        }
    }

    /// Order-aware claims (F1/F1-edge): a history prompt recorded after an island turn was
    /// sent takes that turn over when its text is the turn's text — unless the turn was
    /// refused (it never reached the engine) or is already bound. The daemon records one
    /// turn at a time, so once the record carries island turn `m`, no island turn sent
    /// before `m` can own a LATER record (the floor). B2: `after` is the record position
    /// before which every prompt was recorded before the send (see `place_turns`); a turn with
    /// no cycle evidence (no quiet page on its connection) claims the LATEST identical prompt
    /// after it, because its send came after any prompt it could not see.
    fn claim_prompts(&mut self, messages: &[Value], from_start: bool) {
        self.place_turns(messages, from_start);
        let mut floor = 0u64;
        for m in messages {
            let Some(id) = msg_id(m).filter(|_| msg_role(m) == "user") else { continue };
            let Some(pos) = record_pos(id) else { continue };
            if let Some(&n) = self.claims.get(id) {
                floor = floor.max(n);
                continue;
            }
            let text = msg_text(m).trim();
            // an unplaced turn's prompt is at or before the floor of the next island turn sent
            // after it (whose own prompt may be any later twin)
            let bound = |at: usize| self.pending[at + 1..].iter().find(|q| q.sent).map(|q| q.after).unwrap_or(u64::MAX);
            let later_twin = |limit: u64| {
                messages.iter().any(|o| {
                    msg_role(o) == "user" && msg_text(o).trim() == text && msg_id(o).and_then(record_pos).is_some_and(|q| q > pos && q <= limit)
                })
            };
            let at = (0..self.pending.len()).find(|&at| {
                let p = &self.pending[at];
                !p.bound
                    && p.sent
                    && p.num > floor
                    && pos > p.after
                    && TurnEnd::may_be_recorded(&p.ended)
                    && p.text.trim() == text
                    && (p.placed || (pos <= bound(at) && !later_twin(bound(at))))
            });
            if let Some(at) = at {
                self.pending[at].bound = true;
                self.pending[at].seen_prompt = true;
                let n = self.pending[at].num;
                self.claim(id, n);
                floor = n;
            }
        }
    }

    /// B1: a newest page that starts with a lone reply (its prompt is the message right before
    /// the page) whose text is the reply the island streamed for one of its own turns: that
    /// turn took the prompt over (bound by its reply, the prompt text is the island's own).
    fn claim_lone_head(&mut self, messages: &[Value]) {
        let Some(head) = messages.iter().find(|m| msg_id(m).and_then(record_pos).is_some()) else { return };
        if msg_role(head) != "assistant" {
            return;
        }
        let Some(prompt) = msg_id(head).and_then(prompt_before) else { return };
        let Some(pos) = record_pos(&prompt) else { return };
        if self.claims.contains_key(&prompt) {
            return;
        }
        let at = self.pending.iter().position(|p| {
            !p.bound && p.sent && pos > p.after && TurnEnd::may_be_recorded(&p.ended) && same_reply(&p.reply, head)
        });
        if let Some(at) = at {
            self.pending[at].bound = true;
            let n = self.pending[at].num;
            self.claim(&prompt, n);
        }
    }

    /// One daemon page → its turns in record order, and the cursor of the page before it.
    /// Ids are the daemon's own (a turn's number is its prompt's record position, or the
    /// island number its prompt took over), so a turn has the same id on every page. A page
    /// starting with a lone reply (its prompt is on the page before) leaves it out and hands
    /// back the cursor of its first prompt, so the next page carries the whole turn; a page
    /// that is ONLY a lone reply hands back that reply's own cursor and keeps the reply for
    /// the page before (`heads`). `answered` = the cursor this page answered: a lone reply
    /// kept for it completes the page's last turn.
    fn page_rows(&mut self, messages: &[Value], has_earlier: bool, answered: Option<&str>) -> (Vec<Row>, Option<u64>) {
        let record: Vec<(&Value, &str, u64)> =
            messages.iter().filter_map(|m| msg_id(m).and_then(|id| record_pos(id).map(|p| (m, id, p)))).collect();
        let first_prompt = record.iter().position(|(m, _, _)| msg_role(m) == "user");
        // B1: the newest page starts with the lone reply of a turn the island took over: that
        // turn stays on the page (its prompt text is the island's own), with this one reply,
        // and the page before ends right before its prompt
        let head_turn = record
            .first()
            .filter(|(m, _, _)| answered.is_none() && msg_role(m) == "assistant")
            .and_then(|(m, id, pos)| {
                let num = *self.claims.get(&prompt_before(id)?)?;
                let pending = self.pending.iter().find(|p| p.bound && p.num == num);
                let user = match pending {
                    Some(p) => p.text.clone(),
                    None => self.settled.get(&num).map(|s| s.user.clone()).filter(|u| !u.is_empty())?,
                };
                Some((num, user, msg_text(m).to_owned(), pos - 1))
            });
        let cursor = match (first_prompt, record.first()) {
            _ if head_turn.is_some() => has_earlier.then(|| head_turn.as_ref().map(|h| h.3)).flatten(),
            (Some(at), _) => has_earlier.then_some(record[at].2),
            (None, Some((_, id, pos))) if has_earlier => {
                let lone: Vec<&str> = record.iter().map(|(m, _, _)| msg_text(m)).collect();
                self.heads.retain(|(h, _)| h != id);
                self.heads.push_back(((*id).to_owned(), lone.join("\n\n")));
                if self.heads.len() > MAX_HEADS {
                    self.heads.pop_front();
                }
                Some(*pos)
            }
            _ => None,
        };
        let live: std::collections::HashMap<u64, &Pending> = self.pending.iter().filter(|p| p.bound).map(|p| (p.num, p)).collect();
        // a bound island turn still in `pending` renders from what the island saw (its end, if
        // any): its reply is already whole, so the record's copy is never added to it
        let island_row = |p: &Pending, order: (u64, u8, u64)| {
            let (state, error) = p.ended.as_ref().map(end_view).unwrap_or((LIVE_ROW, Value::Null));
            Row { order, num: p.num, user: p.text.clone(), reply: p.reply.clone(), state, error }
        };
        let mut rows: Vec<Row> = Vec::new();
        if let Some((num, user, reply, pos)) = head_turn {
            rows.push(match live.get(&num) {
                Some(p) => island_row(p, (pos, 0, 0)),
                None => Row { order: (pos, 0, 0), num, user, reply, state: "completed", error: Value::Null },
            });
        }
        let mut prev: Option<(&str, bool)> = None; // (id, is a prompt)
        for (m, id, pos) in record.iter().skip(first_prompt.unwrap_or(record.len())) {
            let after_prompt = prev.is_some_and(|(p, prompt)| prompt && follows(p, id));
            prev = Some((id, msg_role(m) == "user"));
            match msg_role(m) {
                "user" => {
                    let num = self.claims.get(*id).copied().unwrap_or(*pos);
                    if answered.is_none() {
                        // B1: a newest page carries this prompt: the island no longer keeps its text
                        if let Some(s) = self.settled.get_mut(&num) {
                            s.user = String::new();
                        }
                    }
                    let row = match live.get(&num) {
                        Some(p) => island_row(p, (*pos, 0, 0)),
                        None => Row { order: (*pos, 0, 0), num, user: msg_text(m).to_owned(), reply: String::new(), state: "completed", error: Value::Null },
                    };
                    rows.push(row);
                }
                "assistant" if after_prompt => {
                    if let Some(last) = rows.last_mut().filter(|r| !live.contains_key(&r.num)) {
                        last.reply = join_reply(&last.reply, msg_text(m));
                    }
                }
                _ => {}
            }
        }
        // the lone reply kept for the answered cursor completes the page's last turn — unless
        // that turn is the island's own still in `pending`, whose reply already holds it (B1)
        if let (Some(answered), Some((_, last_id, _)), Some((_, true))) = (answered, record.last(), prev) {
            let head = self.heads.iter().find(|(h, _)| h == answered).map(|(_, text)| text.clone());
            if let (Some(text), true, Some(last)) = (head, follows(last_id, answered), rows.last_mut().filter(|r| !live.contains_key(&r.num))) {
                last.reply = join_reply(&last.reply, &text);
            }
        }
        for row in rows.iter_mut() {
            let Some(s) = self.settled.get_mut(&row.num) else { continue };
            row.state = s.state;
            row.error = s.error.clone();
            if row.reply.is_empty() {
                row.reply = s.reply.clone();
            } else {
                // F6-edge: the record carries the reply now: only the end state is kept
                s.reply = String::new();
            }
            if s.state == "completed" && s.reply.is_empty() && s.user.is_empty() {
                self.settled.remove(&row.num);
            }
        }
        (rows, cursor)
    }

    /// The island turns the shown record does not carry: in the window (`live`), the running
    /// one, last; anywhere, the ended unrecorded ones (a refused send) where they were sent,
    /// when that is within `[lo, hi)` of the record. `shown` = numbers already rendered.
    fn island_rows(&self, lo: u64, hi: u64, live: Option<Option<(u64, &'static str)>>, shown: &[u64]) -> Vec<Row> {
        self.pending
            .iter()
            .filter(|p| !shown.contains(&p.num))
            .filter_map(|p| {
                let (order, state, error) = match (&p.ended, live) {
                    (None, Some(state)) => {
                        let state = state.filter(|(n, _)| *n == p.num).map(|(_, s)| s).unwrap_or("thinking");
                        ((u64::MAX, 1, p.num), state, Value::Null)
                    }
                    (Some(end), _) if !p.bound && (lo..hi).contains(&p.after) => {
                        let (state, error) = end_view(end);
                        ((p.after, 1, p.num), state, error)
                    }
                    _ => return None,
                };
                Some(Row { order, num: p.num, user: p.text.clone(), reply: p.reply.clone(), state, error })
            })
            .collect()
    }

    /// F4: the history the projection shows. A loaded connection's own page is the truth
    /// (and becomes the last known chat); a lost connection, or a fresh one with no page
    /// yet, keeps showing the last known history plus whatever live output the view has.
    fn shown_messages(&mut self, chat: &Value) -> (Vec<Value>, bool) {
        let loaded = chat_connected(chat) && chat.get("historyLoaded").and_then(Value::as_bool) == Some(true);
        let view = chat.get("messages").and_then(Value::as_array);
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

    /// The newest turns of the view, in record order, and the cursor of the page before
    /// them; advances the submitted turns' lifecycle (terminal states are kept, never
    /// resurrected).
    fn window(&mut self, chat: &Value, now_ms: u64) -> (Vec<Row>, Option<u64>) {
        let (messages, has_earlier) = self.shown_messages(chat);
        let mut newest_pos = 0;
        for m in &messages {
            if let Some(pos) = msg_id(m).and_then(record_pos) {
                newest_pos = newest_pos.max(pos);
            }
        }
        self.max_seen = self.max_seen.max(newest_pos);
        let conn = chat_conn(chat);
        let loaded = chat_loaded(chat);
        let starts_now = busy_starts(chat);
        // B2 residual: a newest page whose read was sent on a quiet engine holds the prompt of every
        // cycle counted then (and maybe later ones: counting from there can only raise a send's
        // floor, never lower it): the base a send counts its own cycle from
        if loaded && chat.get("historyAskedBusy").and_then(Value::as_bool) == Some(false) {
            let asked = chat.get("historyAskedStarts").and_then(Value::as_u64).unwrap_or(u64::MAX);
            self.base = Some((conn, newest_pos, asked));
        }
        self.claim_prompts(&messages, !has_earlier);
        self.claim_lone_head(&messages);
        let connected = chat_connected(chat);
        let busy = chat_busy(chat);
        let engine_down = matches!(chat.pointer("/agent/status").and_then(Value::as_str), Some("restarting" | "stopped" | "unavailable"));
        let (err_n, err_code) = turn_error_counter(chat);

        // live output (landed assistant messages not yet in the daemon's history, and
        // messages still streaming), each owned by the newest submission that preceded it
        // (0 = it predates every submission on this island)
        let streams = live_streams(chat);
        self.quiet = connected && !busy && streams.is_empty();
        // F6: an engine cycle the known record does not carry (another client's turn, or the
        // island's own) is read once the engine is quiet, so that turn shows where it was recorded
        if self.quiet && loaded && !history_current(chat) && self.asked_starts != Some((conn, starts_now)) {
            self.asked_starts = Some((conn, starts_now));
            self.refresh_due = true;
        }
        let present: std::collections::HashSet<&str> =
            messages.iter().filter_map(msg_id).chain(streams.iter().map(|(id, _, _)| id.as_str())).collect();
        self.live_owner.retain(|id, _| present.contains(id.as_str()));
        // F6: live output belongs to the newest island turn only when it started in that turn's
        // own engine cycle (the first one after its send) while the turn was running (or was
        // cancelled: its held tail still lands); output of a later cycle is another client's (a
        // turn whose send has not gone out yet owns nothing)
        let newest = self.pending.last().filter(|p| p.sent && p.conn == conn && matches!(p.ended, None | Some(TurnEnd::Cancelled))).map(|p| (p.num, p.starts));
        let owner_of = |cycle: u64| newest.filter(|(_, starts)| cycle <= starts + 1).map(|(num, _)| num).unwrap_or(0);
        // (owner, text, still streaming)
        let mut live: Vec<(u64, String, bool)> = Vec::new();
        for m in &messages {
            let Some(id) = msg_id(m) else { continue };
            if is_history_id(id) || msg_role(m) != "assistant" {
                continue;
            }
            let owner = *self.live_owner.entry(id.to_owned()).or_insert_with(|| owner_of(msg_turn(m, starts_now)));
            live.push((owner, msg_text(m).to_owned(), false));
        }
        for (id, text, cycle) in &streams {
            let owner = *self.live_owner.entry(id.clone()).or_insert_with(|| owner_of(*cycle));
            live.push((owner, text.clone(), true));
        }
        let owned = |owner: u64| -> (String, bool) {
            // an empty message (a tool call with no text) adds no paragraph
            let parts: Vec<&str> = live.iter().filter(|l| l.0 == owner && !l.1.is_empty()).map(|l| l.1.as_str()).collect();
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
            if !p.sent {
                // N1: the pre-send read is still in flight: the turn is sending (thinking,
                // cancellable); its settle grace starts only when the send goes out
                live_state = Some((p.num, "thinking"));
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
                    let (state, error) = end_view(end);
                    // B1: bound by its lone reply, the prompt text is the island's own until a
                    // newest page carries the prompt
                    let user = if p.seen_prompt { String::new() } else { p.text };
                    if state != "completed" || !p.reply.is_empty() || !user.is_empty() {
                        self.settled.insert(p.num, Settled { state, error, reply: p.reply, user });
                    }
                }
                _ => keep.push(p),
            }
        }
        self.pending = keep;

        let (mut rows, cursor) = self.page_rows(&messages, has_earlier, None);
        for row in rows.iter_mut().filter(|r| r.state == LIVE_ROW) {
            row.state = live_state.filter(|(n, _)| *n == row.num).map(|(_, s)| s).unwrap_or("thinking");
        }
        // live output nobody on this island submitted (a turn in flight when the island
        // connected): it continues the newest history turn only when that turn's prompt is the
        // last message of the record (F6: never a turn whose reply is already recorded — another
        // client's turn shows when its record arrives)
        let (orphan, orphan_streaming) = owned(0);
        let last_prompt = messages
            .iter()
            .rev()
            .find(|m| msg_id(m).is_some_and(is_history_id))
            .filter(|m| msg_role(m) == "user")
            .and_then(msg_id)
            .and_then(record_pos);
        // (and never an island turn: its own output is owned by number, another cycle's is not its)
        if let Some(last) = rows.last_mut().filter(|r| r.order.1 == 0 && r.num < LIVE_BASE && Some(r.order.0) == last_prompt) {
            last.reply = join_reply(&last.reply, &orphan);
            if busy && orphan_streaming {
                last.state = "streaming";
            } else if busy && orphan.is_empty() && last.reply.is_empty() {
                last.state = "thinking";
            }
        }
        let shown: Vec<u64> = rows.iter().map(|r| r.num).collect();
        rows.extend(self.island_rows(cursor.unwrap_or(0), u64::MAX, Some(live_state), &shown));
        rows.sort_by_key(|r| r.order);
        // F6: the newest WINDOW_TURNS turns, cut at a record turn (its prompt is the cursor)
        let mut cut = rows.len().saturating_sub(WINDOW_TURNS);
        while cut > 0 && rows[cut].order.1 != 0 {
            cut -= 1;
        }
        if cut == 0 {
            return (rows, cursor);
        }
        let cursor = Some(rows[cut].order.0);
        (rows.split_off(cut), cursor)
    }

    /// The `chat:state` conversation projection: the newest `WINDOW_TURNS` turns plus the
    /// paging cursor (F6: never every turn ever seen).
    fn project(&mut self, chat: &Value, now_ms: u64) -> Value {
        self.generation += 1;
        let seq = self.generation;
        let (rows, cursor) = self.window(chat, now_ms);
        let active = rows
            .last()
            .filter(|t| matches!(t.state, "thinking" | "streaming"))
            .map(|t| json!(format!("t-{}", t.num)))
            .unwrap_or(Value::Null);
        self.live = !active.is_null();
        let (availability, producer) = availability_and_producer(chat);
        let turns: Vec<Value> = rows.iter().map(|r| turn_view(r, seq)).collect();
        json!({
            "conversation_id": CHAT_CONVERSATION_ID,
            "active_turn": active,
            "turns": turns,
            "evicted": 0,
            "queue_note": Value::Null,
            "availability": availability,
            "history_before": cursor,
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
    fn refresh_if_due(&self, link: &dyn ChatLink, caller: &str) -> bool {
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
            return false;
        }
        due
    }

    /// B2: before a send, the island's record should carry every engine cycle that already ran
    /// (another client's turn, the island's own last one). At most ONE newest-page read (or the
    /// wait for the one the settle refresh just sent), bounded by `HISTORY_WAIT_MS`. The read is
    /// `presend`: it spends the reserve that belongs to the send, so the island's own read budget
    /// never refuses it. A refused or late read never blocks the send and never decides a claim:
    /// the turn's floor is counted from its engine cycles (`place_turns`).
    fn catch_up(&self, link: &dyn ChatLink, caller: &str, sent: bool) {
        let v = link.view();
        if !chat_loaded(&v) || chat_busy(&v) || history_current(&v) {
            return;
        }
        let (answered, failed) = history_reads_counter(&v);
        if !sent && link.command(caller, &json!({"action": "chat_history", "presend": true})).is_err() {
            return;
        }
        let _ = wait_view(link, HISTORY_WAIT_MS, |v| {
            let (a, f) = history_reads_counter(v);
            a > answered || f > failed || history_current(v)
        });
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
                let started = Instant::now();
                let reserved = self.reserve(link, text, client_request_id, now_ms)?;
                let Some(num) = reserved else {
                    return Ok(Routed::Answer(self.duplicate(client_request_id)));
                };
                let sent = self.refresh_if_due(link, caller);
                self.catch_up(link, caller, sent);
                // N1: the settle grace starts when the send actually goes out
                let sent_ms = now_ms + started.elapsed().as_millis() as u64;
                self.send(link, caller, num, sent_ms)
            }
            Command::Cancel { turn_id } => self.cancel(link, caller, turn_id, now_ms),
            Command::History { conversation_id, before } => {
                if conversation_id != CHAT_CONVERSATION_ID {
                    return Err(crate::chat::ChatError::invalid_input("Pedido de chat inválido."));
                }
                match before {
                    None => self.newest(link, caller, now_ms),
                    Some(n) => self.earlier(link, caller, *n),
                }
            }
        }
    }

    fn duplicate(&self, client_request_id: &str) -> Value {
        let inner = self.inner.lock().expect("chat host lock");
        let num = inner.pending.iter().find(|p| p.client_request_id == client_request_id).map(|p| p.num).unwrap_or(0);
        json!({"turn_id": format!("t-{num}"), "duplicate": true})
    }

    /// R1: the «a turn is running» check and the turn's reservation are ONE critical section
    /// (under the host lock), so two concurrent submits can never both pass the check: the
    /// reserved turn is the active one from here (N1: shown as thinking, cancellable, while the
    /// pre-send read waits). `None` = this request id is already a turn.
    fn reserve(&self, link: &dyn ChatLink, text: &str, client_request_id: &str, now_ms: u64) -> Result<Option<u64>, crate::chat::ChatError> {
        let text = crate::chat::validate_text(text)?;
        let mut inner = self.inner.lock().expect("chat host lock");
        if inner.pending.iter().any(|p| p.client_request_id == client_request_id) {
            return Ok(None);
        }
        let before = link.view();
        let current = inner.project(&before, now_ms);
        if !current["active_turn"].is_null() || chat_busy(&before) {
            return Err(crate::chat::ChatError::queue_full());
        }
        if !chat_connected(&before) {
            return Err(engine_unavailable());
        }
        let num = inner.alloc_live();
        let after = inner.max_seen;
        inner.pending.push(Pending {
            num,
            client_request_id: client_request_id.to_owned(),
            text,
            submitted_ms: now_ms,
            sent: false,
            after,
            base: None,
            placed: false,
            conn: chat_conn(&before),
            starts: busy_starts(&before),
            seen_prompt: false,
            reply: String::new(),
            err_seen: 0,
            ended: None,
            bound: false,
        });
        if inner.pending.len() > MAX_PENDING {
            inner.pending.remove(0);
        }
        // N1: the keeper re-publishes while a turn is live, so the page shows this one (thinking,
        // cancellable) while the pre-send read waits
        inner.live = true;
        Ok(Some(num))
    }

    /// Send the reserved turn `num` (unless it was cancelled while the pre-send read waited). The
    /// engine's state is checked again under the host lock: a turn that cannot be sent is taken
    /// back (the page keeps the draft and shows the refusal), never invented.
    fn send(&self, link: &dyn ChatLink, caller: &str, num: u64, sent_ms: u64) -> Result<Routed, crate::chat::ChatError> {
        let mut inner = self.inner.lock().expect("chat host lock");
        let Some(at) = inner.pending.iter().position(|p| p.num == num) else {
            return Err(send_refused());
        };
        let turn = json!({"turn_id": format!("t-{num}"), "duplicate": false});
        if inner.pending[at].ended.is_some() {
            // cancelled before it went out: nothing reached the engine
            return Ok(Routed::Answer(turn));
        }
        let before = link.view();
        // (the projection can retire settled turns: the reserved one is looked up again)
        inner.project(&before, sent_ms);
        let Some(at) = inner.pending.iter().position(|p| p.num == num) else {
            return Err(send_refused());
        };
        let refused = if !chat_connected(&before) {
            Some(engine_unavailable())
        } else if chat_busy(&before) {
            Some(crate::chat::ChatError::queue_full())
        } else {
            let payload = json!({"action": "chat_send", "text": inner.pending[at].text, "clientRequestId": inner.pending[at].client_request_id});
            link.command(caller, &payload).err().map(|_| send_refused())
        };
        if let Some(e) = refused {
            inner.pending.remove(at);
            return Err(e);
        }
        // live output already on screen never becomes this turn's reply
        let owner = inner.pending.iter().rev().find(|p| p.sent).map(|p| p.num).unwrap_or(0);
        let earlier_live: Vec<String> = chat_messages(&before)
            .iter()
            .filter_map(|m| msg_id(m).filter(|i| !is_history_id(i)).map(str::to_owned))
            .chain(live_streams(&before).into_iter().map(|(id, _, _)| id))
            .collect();
        for id in earlier_live {
            inner.live_owner.entry(id).or_insert(owner);
        }
        let (conn, starts) = (chat_conn(&before), busy_starts(&before));
        // B2 residual: the newest quiet page on this connection with no more cycles than the send
        // saw: the cycles between it and the send are counted, not read
        let base = inner.base.filter(|(c, _, h)| *c == conn && *h <= starts).map(|(_, pos, h)| (pos, h));
        let after = inner.max_seen;
        let p = &mut inner.pending[at];
        p.sent = true;
        p.submitted_ms = sent_ms;
        p.after = p.after.max(after);
        p.base = base;
        p.conn = conn;
        p.starts = starts;
        p.err_seen = turn_error_counter(&before).0;
        Ok(Routed::Answer(turn))
    }

    fn cancel(&self, link: &dyn ChatLink, caller: &str, turn_id: &str, now_ms: u64) -> Result<Routed, crate::chat::ChatError> {
        let view = link.view();
        let mut inner = self.inner.lock().expect("chat host lock");
        let current = inner.project(&view, now_ms);
        if current["active_turn"].as_str() != Some(turn_id) {
            return Ok(Routed::Answer(json!({"cancelled": false})));
        }
        // N1: a turn still waiting for its pre-send read never reached the engine: nothing to abort
        let unsent = inner.pending.last().is_some_and(|p| format!("t-{}", p.num) == turn_id && !p.sent);
        if !unsent {
            link.command(caller, &json!({"action": "chat_abort"})).map_err(|_| send_refused())?;
        }
        if let Some(p) = inner.pending.last_mut().filter(|p| format!("t-{}", p.num) == turn_id && p.ended.is_none()) {
            p.ended = Some(TurnEnd::Cancelled);
            inner.refresh_due = true;
        }
        Ok(Routed::Answer(json!({"cancelled": true})))
    }

    /// The newest page: one `get_history`, answered with the window it projects (B1: only a
    /// NEWEST-page answer ends this wait, never an earlier page).
    fn newest(&self, link: &dyn ChatLink, caller: &str, now_ms: u64) -> Result<Routed, crate::chat::ChatError> {
        let (answered, failed) = history_reads_counter(&link.view());
        link.command(caller, &json!({"action": "chat_history"})).map_err(|_| history_unavailable())?;
        let (v, arrived) = wait_view(link, HISTORY_WAIT_MS, |v| {
            let (a, f) = history_reads_counter(v);
            a > answered || f > failed
        });
        if !arrived || history_reads_counter(&v).1 > failed {
            return Err(history_unavailable());
        }
        let p = self.project(&v, now_ms);
        Ok(Routed::Answer(json!({"conversation_id": CHAT_CONVERSATION_ID, "turns": p["turns"], "before": p["history_before"], "skipped": 0})))
    }

    /// An earlier page (Gentle Dot's `get_earlier`): exactly ONE daemon read with the cursor
    /// the page passed back (a record position this host handed out), answered with that
    /// page's turns and the daemon's own next cursor. Nothing is stored or windowed: the page
    /// is turned into turns from its own messages, so a newest page or a reconnect landing
    /// meanwhile cannot shift it, and a page holding no whole turn still advances.
    fn earlier(&self, link: &dyn ChatLink, caller: &str, before: u64) -> Result<Routed, crate::chat::ChatError> {
        let id = record_id(before).ok_or_else(|| crate::chat::ChatError::invalid_input("Pedido de chat inválido."))?;
        let (answered, failed) = reads_counter(&link.view(), "earlierReads");
        link.command(caller, &json!({"action": "chat_earlier", "before": id})).map_err(|_| history_unavailable())?;
        let (v, arrived) = wait_view(link, HISTORY_WAIT_MS, |v| {
            let (a, f) = reads_counter(v, "earlierReads");
            f > failed || (a > answered && v.pointer("/earlierPage/before").and_then(Value::as_str) == Some(id.as_str()))
        });
        if !arrived || reads_counter(&v, "earlierReads").1 > failed {
            return Err(history_unavailable());
        }
        let messages = chat_messages(&v["earlierPage"]);
        let has_earlier = v.pointer("/earlierPage/hasEarlier").and_then(Value::as_bool) == Some(true);
        let mut inner = self.inner.lock().expect("chat host lock");
        inner.generation += 1;
        let seq = inner.generation;
        inner.claim_prompts(&messages, !has_earlier);
        let (mut rows, cursor) = inner.page_rows(&messages, has_earlier, Some(&id));
        for row in rows.iter_mut().filter(|r| r.state == LIVE_ROW) {
            row.state = "thinking";
        }
        let shown: Vec<u64> = rows.iter().map(|r| r.num).collect();
        rows.extend(inner.island_rows(cursor.unwrap_or(0), before, None, &shown));
        rows.sort_by_key(|r| r.order);
        let turns: Vec<Value> = rows.iter().map(|r| turn_view(r, seq)).collect();
        Ok(Routed::Answer(json!({"conversation_id": CHAT_CONVERSATION_ID, "turns": turns, "before": cursor, "skipped": 0})))
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

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
//! - attachments (K2-05, decision 2a, Gentle Dot's model): a file reaches the DAEMON as
//!   `upload` chunks over this same connection and is stored in the engine workspace;
//!   the daemon answers the last chunk with an opaque id (`a-<16 hex>`) issued to this
//!   client only. A `send` names files by those ids only — never a path, never a name —
//!   and the island stores nothing itself.
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
/// K2-05 attachments: the island's own budget for `upload` chunks (the daemon drops a client
/// past 720 a minute; chunks never spend the chat budget above, so paging and sends keep theirs).
pub const UPLOAD_FRAMES_PER_MINUTE: u32 = 600;
/// K2-05 attachments: the daemon's `LIMITS.maxUploadChunkChars` (base64 text of one chunk).
pub const MAX_UPLOAD_CHUNK_CHARS: usize = 192 * 1024;
/// File bytes per chunk: exactly one maximal base64 chunk.
pub const UPLOAD_CHUNK_BYTES: usize = MAX_UPLOAD_CHUNK_CHARS / 4 * 3;
/// Gentle Dot's `ATTACHMENT_LIMITS.fileBytes` (uploads.cjs): 25 MB per file.
pub const MAX_UPLOAD_FILE_BYTES: usize = 25 * 1024 * 1024;
/// The daemon's `LIMITS.maxUploadNameChars`.
pub const MAX_UPLOAD_NAME_CHARS: usize = 255;
/// The daemon's `LIMITS.maxAttachments` (Gentle Dot's files per message).
pub const MAX_SEND_ATTACHMENTS: usize = 10;
/// The upload answers the view keeps (newest last).
pub const MAX_UPLOAD_ANSWERS: usize = 32;
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

/// The daemon's `REQUEST_ID` (send/steer correlation, Gentle Dot's `send{requestId}`): `[A-Za-z0-9_-]{1,64}`.
fn request_id_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 64 && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}

/// A fresh wire request id for one send/steer: random (the daemon ignores a repeated id, also
/// across island runs), in the daemon's grammar. Never the page's own `client_request_id`.
pub fn fresh_request_id() -> String {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 16];
    if ring::rand::SystemRandom::new().fill(&mut bytes).is_err() {
        // no system randomness: still unique within this process and across runs
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        return format!("i{nanos:x}-{:x}-{:x}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    }
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("i{hex}")
}

/// The daemon's own opaque id of one stored upload (`uploads.cjs` `UPLOAD_ID`): `a-` + 16 lowercase hex.
pub fn upload_id_ok(s: &str) -> bool {
    s.len() == 18 && s.starts_with("a-") && s[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Standard base64 text as the daemon accepts it (`BASE64`, length a multiple of 4).
fn base64_ok(s: &str) -> bool {
    let b = s.as_bytes();
    let pad = b.iter().rev().take_while(|c| **c == b'=').count();
    !b.is_empty() && b.len().is_multiple_of(4) && pad <= 2
        && b[..b.len() - pad].iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/'))
}

/// One attachment chip as the daemon describes a stored file (`{name,size,mime}`), allowlisted.
fn chip_view(a: &Value) -> Option<Value> {
    let name = a.get("name").and_then(Value::as_str).filter(|n| !n.is_empty() && utf16_len(n) <= 128 && !n.chars().any(char::is_control))?;
    let size = a.get("size").and_then(Value::as_u64)?;
    let mime = a.get("mime").and_then(Value::as_str).filter(|m| m.len() <= 64 && !m.chars().any(char::is_control))?;
    Some(json!({"name": name, "size": size, "mime": mime}))
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
    /// Prompt the agent. `client_request_id` is the page's own correlation id: it never travels
    /// on the wire. `request_id` does (Gentle Dot's `send{requestId}`): the daemon ignores a
    /// repeated one and echoes it, to this client only, on the `user_message` of the prompt the
    /// engine recorded for this send — the ONLY way an island turn binds to its record.
    Send { text: String, client_request_id: String, request_id: String, attachments: Vec<String> },
    /// K2-05 attachments: one base64 chunk of one file, in order (the daemon's `upload`).
    Upload { request_id: String, name: String, size: u64, offset: u64, data: String },
    /// K2-05 attachments: the user removed an unsent file (the daemon deletes it).
    Discard { id: String },
    Steer { text: String, request_id: String },
    Abort,
    UiResponse { ask_id: String, answer: ChatAnswer },
    History,
    Earlier { before: String },
    Status,
}

impl ChatCommand {
    /// The wire line. `client_request_id` deliberately never appears; `request_id` does.
    pub fn line(&self) -> String {
        match self {
            ChatCommand::Send { text, request_id, attachments, .. } if attachments.is_empty() => ordered(&[("type", "send"), ("text", text), ("requestId", request_id)]),
            ChatCommand::Send { text, request_id, attachments, .. } => {
                let head = ordered(&[("type", "send"), ("text", text), ("requestId", request_id)]);
                format!("{},\"attachments\":{}}}\n", &head[..head.len() - 2], serde_json::to_string(attachments).unwrap_or_default())
            }
            ChatCommand::Upload { request_id, name, size, offset, data } => format!(
                "{{\"type\":\"upload\",\"requestId\":{},\"name\":{},\"size\":{size},\"offset\":{offset},\"data\":{}}}\n",
                serde_json::to_string(request_id).unwrap_or_default(),
                serde_json::to_string(name).unwrap_or_default(),
                serde_json::to_string(data).unwrap_or_default(),
            ),
            ChatCommand::Discard { id } => ordered(&[("type", "upload_discard"), ("id", id)]),
            ChatCommand::Steer { text, request_id } => ordered(&[("type", "steer"), ("text", text), ("requestId", request_id)]),
            ChatCommand::Abort => ordered(&[("type", "abort")]),
            ChatCommand::UiResponse { ask_id, answer } => answer.wire(ask_id),
            ChatCommand::History => ordered(&[("type", "get_history")]),
            ChatCommand::Earlier { before } => ordered(&[("type", "get_earlier"), ("before", before)]),
            ChatCommand::Status => ordered(&[("type", "status")]),
        }
    }
}

/// K2-05 U4b: the daemon's bound of a confirm's `message` (server.cjs ASK_MESSAGE_CHARS).
pub const MAX_ASK_MESSAGE_CHARS: usize = 2000;
/// K2-05 U4b: the daemon's bound of an input's `placeholder` (server.cjs ASK_PLACEHOLDER_CHARS).
pub const MAX_ASK_PLACEHOLDER_CHARS: usize = 200;

/// One daemon `ask`: the closed fields the island is allowed to show and answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChatAsk {
    pub id: String,
    pub kind: String,
    pub title: String,
    /// The shown options: display-clean (control characters stripped). Serialized.
    pub options: Vec<String>,
    /// K2-05 U4b: what the user approves (a confirm's details, Gentle Dot `Ask.message`):
    /// harness text the daemon already white-labelled; display-clean and bounded here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// K2-05 U4b: an input's hint (Gentle Dot `Ask.placeholder`), white-labelled by the daemon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
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
    /// The record id of the prompt this message answers: the last `user_message` the daemon
    /// announced in this engine run (None before any, or after the run settled). The host gives
    /// the output to the island turn bound to that id, never by counting or by text.
    pub prompt: Option<String>,
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
            Awaiting::Send | Awaiting::Turn { .. } => matches!(code, "bad_request" | "paused" | "unavailable" | "busy" | "failed" | "rate_limited" | "attachment_not_found" | "message_too_large"),
            Awaiting::Settled => code == "failed",
            Awaiting::Read(_) => matches!(code, "unavailable" | "failed" | "rate_limited"),
            Awaiting::Answer => matches!(code, "unknown_ask" | "bad_request" | "unavailable" | "failed" | "rate_limited"),
            Awaiting::Control => matches!(code, "unavailable" | "busy" | "not_busy" | "failed" | "store_not_private" | "paused" | "bad_request" | "rate_limited"),
        }
    }

    /// How long an entry may wait before it can no longer claim an error. K2-05 boot follow-up F4:
    /// a newest-page read may be HELD by the daemon while its engine starts (`HISTORY_HOLD_MS`), so
    /// it waits longer than that hold; an earlier-page read is never held.
    fn ttl(self) -> Duration {
        match self {
            Awaiting::Send | Awaiting::Turn { .. } => Duration::from_secs(600),
            Awaiting::Settled => Duration::from_secs(10),
            Awaiting::Read(false) => Duration::from_millis(HISTORY_HOLD_MS) + Duration::from_secs(30),
            Awaiting::Read(true) | Awaiting::Answer | Awaiting::Control => Duration::from_secs(30),
        }
    }

    fn of(cmd: &ChatCommand) -> Option<Awaiting> {
        match cmd {
            ChatCommand::Send { .. } => Some(Awaiting::Send),
            ChatCommand::Steer { .. } | ChatCommand::Abort => Some(Awaiting::Control),
            ChatCommand::UiResponse { .. } => Some(Awaiting::Answer),
            ChatCommand::History => Some(Awaiting::Read(false)),
            ChatCommand::Earlier { .. } => Some(Awaiting::Read(true)),
            // `status` never fails on the daemon (its answer is a plain agent_state); an upload's
            // answer (uploaded or its error) names its own requestId and folds into `uploads`
            ChatCommand::Status | ChatCommand::Upload { .. } | ChatCommand::Discard { .. } => None,
        }
    }
}

/// The waiting-command ledger's bound (the island's own rate limit keeps it far below).
const MAX_AWAITING: usize = 32;
/// The `user_message` records the view keeps (newest last): the host binds its turns from them.
pub const MAX_RECORDED: usize = 64;

/// The daemon's recognized error codes (anything else folds to `failed`).
const ERROR_CODES: [&str; 20] = [
    "bad_request", "busy", "not_busy", "unavailable", "rate_limited", "unknown_ask", "paused", "failed",
    "unknown_proposal", "digest_mismatch", "needs_setup", "signin_failed", "store_not_private", "conversations_off",
    "interrupted",
    // K2-05 attachments (uploads.cjs refusals)
    "file_too_large", "message_too_large", "too_many_files", "upload_failed", "attachment_not_found",
];

/// The allowlisted, serializable chat view. The ONLY type that ever reaches the
/// UI. No field can carry the token or the endpoint.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatState {
    connection: String,
    /// The folded `agent_state` frame: busy/status/paused and the engine's model identity (or null).
    agent: Value,
    /// The chat log: history pages replace it, `earlier` pages prepend, finished
    /// streams append. Bounded by `MAX_MESSAGES`.
    messages: Vec<Value>,
    /// Assistant messages still streaming, in first-seen order.
    streaming: Vec<StreamMessage>,
    /// The newest pending ask (the one the UI answers), or null.
    pending_ask: Value,
    /// Every pending ask (K2-05 U4b: serialized, so the chat shows one card per ask; bounded by
    /// `MAX_ASKS`), and the list answers are validated against.
    asks: Vec<ChatAsk>,
    /// K2-05 U4b: the asks whose answer this client sent and the daemon has not resolved yet:
    /// an ask is answered ONCE (a second answer is refused before the wire). A daemon refusal of
    /// that answer frees it again. Interior mutability because [`ChatState::command`] takes
    /// `&self`; bounded by `MAX_ASKS` (only pending asks can be in it).
    answering: RefCell<Vec<String>>,
    /// K2-05 U4b verifier F2: the asks whose answer from THIS client the daemon accepted (it resolved
    /// the ask while this client's answer was in flight), newest last, bounded by `MAX_ASKS`. The
    /// page shows an outcome only for these; an ask resolved any other way just goes away.
    answered: Vec<String>,
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
    /// F5: the commands this client sent that still wait for an answer (see [`Awaiting`]), with
    /// the wire `requestId` a send/steer carried (review F6: a daemon error naming it answers it).
    /// Interior mutability because [`ChatState::command`] takes `&self` (the transport parses
    /// and sends under the state lock). Never serialized.
    #[serde(skip)]
    awaiting: RefCell<VecDeque<(Awaiting, Instant, Option<String>)>>,
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
    /// K2-05 bind by id: the prompts the daemon announced as recorded on this connection
    /// (`user_message`, Gentle Dot bridge.ts onMessageStart), as `{id, requestId?}`, newest last
    /// (bounded). `requestId` is present only on this client's own requests.
    recorded: Vec<Value>,
    /// The record id of the last `user_message` of the running engine run (stamps live
    /// messages); cleared when the engine goes quiet. Never serialized itself.
    #[serde(skip)]
    prompt: Option<String>,
    /// K2-05 attachments: the daemon's answers to this client's uploads, newest last (bounded):
    /// `{requestId, attachment:{id,name,size,mime}}` or `{requestId, code}`. Never a path.
    uploads: Vec<Value>,
    /// The uploads this client started and the daemon has not answered (their requestIds).
    #[serde(skip)]
    upload_requests: RefCell<VecDeque<String>>,
    /// The island's own upload-chunk budget window (separate from the chat budget).
    #[serde(skip)]
    pub(crate) upload_window: Cell<Option<Instant>>,
    #[serde(skip)]
    pub(crate) upload_count: Cell<u32>,
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
            answering: RefCell::new(vec![]),
            answered: vec![],
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
            recorded: vec![],
            prompt: None,
            uploads: vec![],
            upload_requests: RefCell::new(VecDeque::new()),
            upload_window: Cell::new(None),
            upload_count: Cell::new(0),
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
        // K2-05 U4b: an ask is answered once — checked before the budget, so a refused repeat
        // spends nothing and never reaches the wire
        if let ChatCommand::UiResponse { ask_id, .. } = &cmd {
            if self.answering.borrow().iter().any(|a| a == ask_id) { return Err(CommandError); }
        }
        const WINDOW: std::time::Duration = std::time::Duration::from_secs(60);
        let now = Instant::now();
        // K2-05 attachments: an upload chunk spends its OWN budget (the daemon counts it apart too)
        if let ChatCommand::Upload { request_id, offset, .. } = &cmd {
            match self.upload_window.get() {
                Some(start) if now.duration_since(start) < WINDOW => {
                    let next = self.upload_count.get() + 1;
                    if next > UPLOAD_FRAMES_PER_MINUTE { return Err(CommandError); }
                    self.upload_count.set(next);
                }
                _ => {
                    self.upload_window.set(Some(now));
                    self.upload_count.set(1);
                }
            }
            if *offset == 0 {
                let mut started = self.upload_requests.borrow_mut();
                started.retain(|r| r != request_id);
                if started.len() >= MAX_UPLOAD_ANSWERS { started.pop_front(); }
                started.push_back(request_id.clone());
            }
            return Ok(cmd);
        }
        match self.rate_window.get() {
            Some(start) if now.duration_since(start) < WINDOW => {
                let next = self.rate_count.get() + 1;
                let read = matches!(cmd, ChatCommand::History | ChatCommand::Earlier { .. } | ChatCommand::Status);
                let limit = if read { CHAT_FRAMES_PER_MINUTE - CHAT_FRAMES_RESERVED } else { CHAT_FRAMES_PER_MINUTE };
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
            let mut awaiting = self.awaiting.borrow_mut();
            if kind == Awaiting::Send {
                awaiting.retain(|(k, _, _)| *k != Awaiting::Settled);
            }
            if awaiting.len() >= MAX_AWAITING {
                awaiting.pop_front();
            }
            // the third slot names the command: a send/steer's wire requestId, an answer's ask id
            let request = match &cmd {
                ChatCommand::Send { request_id, .. } | ChatCommand::Steer { request_id, .. } => Some(request_id.clone()),
                ChatCommand::UiResponse { ask_id, .. } => Some(ask_id.clone()),
                _ => None,
            };
            awaiting.push_back((kind, now, request));
        }
        if let ChatCommand::UiResponse { ask_id, .. } = &cmd {
            let mut answering = self.answering.borrow_mut();
            if answering.len() >= MAX_ASKS { answering.remove(0); }
            answering.push(ask_id.clone());
        }
        Ok(cmd)
    }

    /// F5: attribute one error frame to the OLDEST waiting command that can answer it. K2-05 F3: a
    /// send whose turn went quiet with no output (`Settled`) only claims an error no command sent
    /// AFTER that quiet can answer: the daemon writes a send's rejection in the same tick as the
    /// busy reset, so a later `failed` answers the later command (a refused catch-up read).
    /// Review F6: an error that names a send/steer (`requestId`, the daemon echoes it to the sender)
    /// answers exactly that command, whatever arrived in between; one naming nothing waiting is
    /// nobody's. Only an unnamed error (a daemon that does not echo it, or a frame-level refusal)
    /// is guessed by order.
    /// K2-05 U4b: also returns what the claimed entry names (an answer's ask id); an answer is never
    /// claimed by a `requestId` (its slot holds an ask id, not a request).
    fn attribute_error(&mut self, code: &str, request: Option<&str>) -> Option<(Awaiting, Option<String>)> {
        let now = Instant::now();
        // K2-05 boot follow-up F4: while the engine starts or restarts the daemon HOLDS a newest-page
        // read (server.cjs whenReady) until it is ready, stops, or `HISTORY_HOLD_MS` ran out, so an
        // error meanwhile answers some other command, never that read. The island's clock started
        // before the daemon's, so a read the daemon gave up on is always past the hold here.
        let starting = matches!(self.agent.get("status").and_then(Value::as_str), Some("starting" | "restarting"));
        let hold = Duration::from_millis(HISTORY_HOLD_MS);
        let held = |k: &Awaiting, at: &Instant| *k == Awaiting::Read(false) && starting && now.duration_since(*at) < hold && code != "rate_limited";
        let awaiting = self.awaiting.get_mut();
        awaiting.retain(|(k, at, _)| now.duration_since(*at) < k.ttl());
        if let Some(request) = request {
            let at = awaiting.iter().position(|(k, _, r)| *k != Awaiting::Answer && r.as_deref() == Some(request) && k.can_answer(code))?;
            return awaiting.remove(at).map(|(k, _, r)| (k, r));
        }
        let mut at = awaiting.iter().position(|(k, sent, _)| k.can_answer(code) && !held(k, sent))?;
        if let (Awaiting::Settled, quiet, _) = awaiting[at] {
            if let Some(later) = awaiting.iter().position(|(k, sent, _)| *k != Awaiting::Settled && *sent >= quiet && k.can_answer(code) && !held(k, sent)) {
                at = later;
            }
        }
        awaiting.remove(at).map(|(k, _, r)| (k, r))
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
            for (k, _, _) in awaiting.iter_mut() {
                if *k == Awaiting::Send {
                    *k = Awaiting::Turn { output: false };
                }
            }
        } else {
            let now = Instant::now();
            awaiting.retain(|(k, _, _)| !matches!(k, Awaiting::Turn { output: true } | Awaiting::Control));
            for (k, at, _) in awaiting.iter_mut() {
                if *k == (Awaiting::Turn { output: false }) {
                    *k = Awaiting::Settled;
                    *at = now;
                }
            }
        }
    }

    fn ledger_output(&mut self) {
        for (k, _, _) in self.awaiting.get_mut().iter_mut() {
            if let Awaiting::Turn { output } = k {
                *output = true;
            }
        }
    }

    /// R3: a requested page arrived (the oldest waiting read of that kind is answered; an
    /// unsolicited `history` broadcast after a rotation can only answer a newest-page read).
    fn ledger_read_answered(&mut self, earlier: bool) -> bool {
        let awaiting = self.awaiting.get_mut();
        let Some(at) = awaiting.iter().position(|(k, _, _)| *k == Awaiting::Read(earlier)) else { return false };
        awaiting.remove(at);
        Self::bump(&mut self.reads, "answered");
        if earlier {
            Self::bump(&mut self.earlier_reads, "answered");
        }
        true
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
                let mut agent = json!({
                    "busy": s.get("busy").and_then(Value::as_bool).unwrap_or(false),
                    "status": status,
                    "paused": s.get("paused").and_then(Value::as_bool).unwrap_or(false),
                });
                // K2-05 U5c: the engine's own model identity (daemon `get_state`), closed fields only;
                // the key exists only while one is known (the existing shape is otherwise untouched)
                let model = engine_model(s.get("model"));
                if !model.is_null() {
                    agent["model"] = model;
                }
                let mut changed = false;
                // a quiet engine ends the run: the next run's output answers the next prompt
                if agent["busy"] != json!(true) {
                    self.prompt = None;
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
                    self.streaming.push(StreamMessage { id: id.to_owned(), text: acc, prompt: self.prompt.clone() });
                    true
                }
            }
            "message_done" => {
                let Some(id) = id_field(frame, "messageId") else { return };
                self.ledger_output();
                let (landed, prompt) = match self.streaming.iter().position(|s| s.id == id) {
                    Some(at) => {
                        let s = self.streaming.remove(at);
                        (s.text, s.prompt)
                    }
                    None => {
                        // a done for an id the island never streamed: land it honestly empty, once
                        let key = json!(id);
                        if self.messages.iter().any(|m| m["id"] == key) { return; }
                        (String::new(), self.prompt.clone())
                    }
                };
                if self.messages.len() >= MAX_MESSAGES { self.messages.remove(0); }
                let activities = std::mem::take(&mut self.pending_activities);
                self.messages.push(json!({"id": id, "role": "assistant", "text": landed, "activities": activities, "prompt": prompt}));
                true
            }
            "activity" => {
                self.ledger_output();
                self.fold_activity(frame)
            }
            "history" | "earlier" => {
                let paged = frame.get("messages").and_then(Value::as_array).is_some();
                let asked = paged && self.ledger_read_answered(t == "earlier");
                let loaded = t == "history" && paged && !self.history_loaded;
                if loaded {
                    self.history_loaded = true;
                }
                self.fold_history(frame, t == "earlier") | asked | loaded
            }
            "uploaded" => {
                // K2-05 attachments: the daemon stored one of this client's files (by its requestId)
                let Some(rid) = str_field(frame, "requestId").filter(|r| request_id_ok(r)) else { return };
                let Some(attachment) = frame.get("attachment").and_then(|a| {
                    let id = a.get("id").and_then(Value::as_str).filter(|i| upload_id_ok(i))?;
                    let mut chip = chip_view(a)?;
                    chip["id"] = json!(id);
                    Some(chip)
                }) else { return };
                if !self.take_upload_request(rid) { return; }
                self.push_upload(json!({"requestId": rid, "attachment": {"id": attachment["id"], "name": attachment["name"], "size": attachment["size"], "mime": attachment["mime"]}}));
                true
            }
            "user_message" => {
                // K2-05 bind by id: a prompt the engine recorded, by the daemon's own record id; the
                // requestId only when it was this client's request (anything off-grammar: dropped)
                let Some(id) = id_field(frame, "messageId").filter(|i| is_history_id(i)) else { return };
                let mut entry = json!({"id": id});
                match frame.get("requestId") {
                    None => {}
                    Some(Value::String(r)) if request_id_ok(r) => entry["requestId"] = json!(r),
                    Some(_) => return,
                }
                self.prompt = Some(id.to_owned());
                if self.recorded.len() >= MAX_RECORDED {
                    self.recorded.remove(0);
                }
                self.recorded.push(entry);
                true
            }
            "ask" => {
                let Some(ask) = ask_view(frame) else { return };
                // K2-05 U4b (Gentle Dot store.ts): an ask already pending is never added twice
                if self.asks.iter().any(|a| a.id == ask.id) { return; }
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
                // the answer that resolved it (this client's, when it sent one) waits no more. U4b
                // verifier F4: only THAT ask's record — another ask's pending answer keeps its own
                let mine = awaiting.iter().position(|(k, _, r)| *k == Awaiting::Answer && r.as_deref() == Some(id));
                if let Some(at) = mine {
                    awaiting.remove(at);
                }
                // U4b verifier F2: resolved while this client's answer was in flight = accepted.
                // K2-05 R1-001: ONLY when the daemon says so (`answered:true`, sent just to the
                // client whose answer closed the ask). A plain `ask_resolved` means another
                // client's answer, a cancel or the 120 s expiry closed it: the card goes away and
                // this client's discarded answer is never presented as sent.
                let accepted = frame.get("answered").and_then(Value::as_bool) == Some(true) && !self.answered.iter().any(|a| a == id);
                if accepted {
                    if self.answered.len() >= MAX_ASKS { self.answered.remove(0); }
                    self.answered.push(id.to_owned());
                }
                self.forget_ask(id) || accepted
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
                // review F6: the request the daemon says this error answers (off-grammar: unnamed)
                let request = frame.get("requestId").and_then(Value::as_str).filter(|r| request_id_ok(r));
                // K2-05 attachments: a refused upload of this client: its answer, never a turn error
                if let Some(rid) = request.filter(|r| self.upload_requests.borrow().iter().any(|u| u == r)) {
                    let rid = rid.to_owned();
                    self.take_upload_request(&rid);
                    self.push_upload(json!({"requestId": rid, "code": code}));
                    self.revision = self.revision.wrapping_add(1);
                    return;
                }
                match self.attribute_error(code, request) {
                    // K2-05 U4b: the daemon refused this client's answer: `unknown_ask` = it no longer
                    // holds the ask (the card goes away); any other refusal frees it for a retry.
                    // R1-001: a discarded answer never keeps a mark either (never both frames, but
                    // an `answered` mark must not outlive the daemon's own refusal).
                    Some((Awaiting::Answer, Some(ask_id))) => {
                        if code == "unknown_ask" {
                            self.answered.retain(|a| *a != ask_id);
                            self.forget_ask(&ask_id);
                        } else {
                            self.answering.get_mut().retain(|a| *a != ask_id);
                        }
                    }
                    Some((Awaiting::Send | Awaiting::Turn { .. } | Awaiting::Settled, _)) => {
                        let n = self.turn_error["n"].as_u64().unwrap_or(0) + 1;
                        self.turn_error = json!({"code": code, "n": n});
                    }
                    Some((Awaiting::Read(earlier), _)) => {
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

    /// K2-05 attachments: an upload this client started is answered (once).
    fn take_upload_request(&mut self, rid: &str) -> bool {
        let started = self.upload_requests.get_mut();
        let Some(at) = started.iter().position(|r| r == rid) else { return false };
        started.remove(at);
        true
    }

    fn push_upload(&mut self, entry: Value) {
        if self.uploads.len() >= MAX_UPLOAD_ANSWERS { self.uploads.remove(0); }
        self.uploads.push(entry);
    }

    /// K2-05 U4b verifier F3: the wire write of a command [`ChatState::command`] accepted failed (the
    /// daemon stopped reading, the connection is going away): an answer is un-marked and stops
    /// waiting, so the ask can be answered again. The transports call this on a failed write.
    pub(crate) fn unsent(&mut self, cmd: &ChatCommand) {
        let ChatCommand::UiResponse { ask_id, .. } = cmd else { return };
        let awaiting = self.awaiting.get_mut();
        if let Some(at) = awaiting.iter().rposition(|(k, _, r)| *k == Awaiting::Answer && r.as_deref() == Some(ask_id.as_str())) {
            awaiting.remove(at);
        }
        let answering = self.answering.get_mut();
        let before = answering.len();
        answering.retain(|a| a != ask_id);
        if answering.len() != before {
            self.revision = self.revision.wrapping_add(1);
        }
    }

    /// K2-05 U4b: an ask is gone (resolved, or the daemon no longer holds it): it leaves the
    /// pending list, its in-flight answer mark and the newest-ask view. Returns whether the view
    /// changed.
    fn forget_ask(&mut self, id: &str) -> bool {
        let before = self.asks.len();
        self.asks.retain(|a| a.id != id);
        let answering = self.answering.get_mut();
        let was_answering = answering.len();
        answering.retain(|a| a != id);
        let pending = self.asks.last().map(|a| serde_json::to_value(a).unwrap_or(Value::Null)).unwrap_or(Value::Null);
        let changed = self.pending_ask != pending || self.asks.len() != before || answering.len() != was_answering;
        self.pending_ask = pending;
        changed
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
    fn fold_history(&mut self, frame: &Value, earlier: bool) -> bool {
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
    // K2-05 U4b: the optional details (the daemon white-labels and bounds them; mirrored here):
    // display-clean, bounded, anything but a non-empty string is no detail; a placeholder only
    // on an input
    let detail = |key: &str, max: usize| frame.get(key).and_then(Value::as_str).map(|t| clip_utf16(t, max)).filter(|t| !t.is_empty());
    let message = detail("message", MAX_ASK_MESSAGE_CHARS);
    let placeholder = if kind == "input" { detail("placeholder", MAX_ASK_PLACEHOLDER_CHARS) } else { None };
    Some(ChatAsk { id: id.to_owned(), kind: kind.to_owned(), title, options, message, placeholder, wire_options })
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
    // K2-05 attachments (Gentle Dot splitAttachments): the chips of the files a prompt carried
    let chips: Vec<Value> = m.get("attachments").and_then(Value::as_array).map(|list| list.iter().take(16).filter_map(chip_view).collect()).unwrap_or_default();
    if !chips.is_empty() { view["attachments"] = json!(chips); }
    Some(view)
}

// ---- command parsing (window-gated) -------------------------------------------------------

/// Parse one chat command for an already-verified main-window caller. `asks` is
/// the current pending-ask list: an answer must name one of these asks, and a
/// select answer must be one of its SHOWN options.
/// The wire `requestId` every send/steer carries (the daemon's grammar).
fn request_id_of(map: &Map<String, Value>) -> Result<String, CommandError> {
    map.get("requestId").and_then(Value::as_str).filter(|r| request_id_ok(r)).map(str::to_owned).ok_or(CommandError)
}

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
            // K2-05 attachments: 1..10 distinct daemon ids (never a path); with files the text may be empty
            let attachments: Vec<String> = match map.get("attachments") {
                None => { exact(4)?; vec![] }
                Some(Value::Array(ids)) => {
                    exact(5)?;
                    if ids.is_empty() || ids.len() > MAX_SEND_ATTACHMENTS { return Err(CommandError); }
                    let ids: Vec<String> = ids.iter().map(|i| i.as_str().filter(|i| upload_id_ok(i)).map(str::to_owned).ok_or(CommandError)).collect::<Result<_, _>>()?;
                    if ids.iter().enumerate().any(|(n, i)| ids[..n].contains(i)) { return Err(CommandError); }
                    ids
                }
                Some(_) => return Err(CommandError),
            };
            let text = if attachments.is_empty() {
                text_of(MAX_TEXT_CHARS)?
            } else {
                let t = map.get("text").and_then(Value::as_str).ok_or(CommandError)?;
                if utf16_len(t) > MAX_TEXT_CHARS { return Err(CommandError); }
                t.to_owned()
            };
            let id = map.get("clientRequestId").and_then(Value::as_str).filter(|i| safe_id_ok(i)).ok_or(CommandError)?;
            ChatCommand::Send { text, client_request_id: id.to_owned(), request_id: request_id_of(map)?, attachments }
        }
        "chat_upload" => {
            exact(6)?;
            let request_id = request_id_of(map)?;
            let name = map.get("name").and_then(Value::as_str).filter(|n| !n.is_empty() && utf16_len(n) <= MAX_UPLOAD_NAME_CHARS && !n.contains('\0')).ok_or(CommandError)?;
            let size = map.get("size").and_then(Value::as_u64).filter(|n| *n < (1u64 << 53)).ok_or(CommandError)?;
            let offset = map.get("offset").and_then(Value::as_u64).filter(|o| *o <= size).ok_or(CommandError)?;
            let data = map.get("data").and_then(Value::as_str).ok_or(CommandError)?;
            let shaped = if data.is_empty() { size == 0 } else { data.len() <= MAX_UPLOAD_CHUNK_CHARS && base64_ok(data) };
            if !shaped { return Err(CommandError); }
            ChatCommand::Upload { request_id, name: name.to_owned(), size, offset, data: data.to_owned() }
        }
        "chat_upload_discard" => {
            exact(2)?;
            let id = map.get("id").and_then(Value::as_str).filter(|i| upload_id_ok(i)).ok_or(CommandError)?;
            ChatCommand::Discard { id: id.to_owned() }
        }
        "chat_steer" => {
            exact(3)?;
            ChatCommand::Steer { text: text_of(MAX_TEXT_CHARS)?, request_id: request_id_of(map)? }
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
/// K2-05 boot follow-up F4: how long the daemon HOLDS a `get_history` while its engine starts or
/// restarts (server.cjs `readyWaitMs`, Gentle Dot bridge.ts `READY_TIMEOUT_MS`).
const HISTORY_HOLD_MS: u64 = 60_000;
/// F6: the most turns one `chat:state` projection carries (the visible window); everything
/// older is reached through `history_before` paging, one daemon page per request.
pub const WINDOW_TURNS: usize = 50;
/// Turn numbers (S2 paging redesign, Gentle Dot's model): a history turn is numbered by the
/// daemon's OWN id of its first message (`s<file>-<index>` → file·2^28 + index + 1), so the
/// same turn has the same number on every page, pass and connection. Island turns count up
/// from `LIVE_BASE`, above every history number; once the daemon names the record of an island
/// send (`user_message` with its `requestId`), that record keeps the island number (`claims`).
const FILE_SHIFT: u32 = 28;
const LIVE_BASE: u64 = 1 << 52;
/// Island turn numbers a record id keeps, and their end states (F4/F6-edge).
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

/// K2-05 attachments: one closed Spanish sentence per upload refusal (the daemon's codes, Gentle
/// Dot's limits: 25 MB per file, 50 MB per message; 5 files, the number the page allows and the
/// daemon's uploads.cjs ATTACHMENT_LIMITS.files counts).
pub fn upload_error(code: &str) -> crate::chat::ChatError {
    let (code, message) = match code {
        "file_too_large" => ("file_too_large", "El archivo es demasiado grande: hasta 25 MB por archivo."),
        "message_too_large" => ("message_too_large", "Los archivos juntos son demasiado grandes: hasta 50 MB por mensaje."),
        "too_many_files" => ("too_many_files", "Demasiados archivos: hasta 5 por mensaje."),
        "attachment_not_found" => ("attachment_not_found", "Un archivo adjunto ya no está disponible; adjuntalo de nuevo."),
        "rate_limited" => ("rate_limited", "Demasiados archivos seguidos; esperá un momento."),
        "unavailable" => ("engine_unavailable", "El motor de Koda no está disponible todavía."),
        _ => ("upload_failed", "No se pudo guardar el archivo; probá de nuevo."),
    };
    chat_err(code, message, code != "file_too_large")
}

/// The last path segment of a file name, without control characters (the daemon sanitizes again).
fn display_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control()).collect();
    let mut out = String::new();
    for c in clean.chars() {
        if utf16_len(&out) + c.len_utf16() > MAX_UPLOAD_NAME_CHARS { break; }
        out.push(c);
    }
    if out.trim().is_empty() { "archivo".to_owned() } else { out }
}

fn engine_unavailable() -> crate::chat::ChatError {
    chat_err("engine_unavailable", "El motor de Koda no está disponible todavía.", true)
}

fn send_refused() -> crate::chat::ChatError {
    chat_err("send_refused", "No se pudo enviar el pedido al motor de Koda.", true)
}

/// K2-05 U4b: the question is no longer open (answered elsewhere, expired, or never received).
fn ask_closed() -> crate::chat::ChatError {
    chat_err("ask_closed", "Esa pregunta ya no está abierta.", false)
}

/// K2-05 U4b: this island already sent an answer to that question.
fn ask_answered() -> crate::chat::ChatError {
    chat_err("ask_answered", "Esa pregunta ya se respondió.", false)
}

/// K2-05 U4b: the answer does not fit the question (an option never shown, a text for a yes/no),
/// or it could not be sent.
fn answer_refused() -> crate::chat::ChatError {
    chat_err("answer_refused", "No se pudo enviar la respuesta.", true)
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
    /// mid-turn: the turn really ran, so its partial text is kept).
    Error(String),
}

/// A turn the island submitted. It binds to the daemon's record ONLY through the `user_message`
/// the daemon sends back with this send's own `requestId` (Gentle Dot bridge.ts onMessageStart):
/// from then on that record id names it on every page, pass and connection (`claims`). Nothing
/// is counted and no text is compared. A send the engine never recorded (refused, failed, cut
/// before recording) never binds: it ends with its error and stays where it was sent.
#[derive(Debug, Clone)]
struct Pending {
    num: u64,
    client_request_id: String,
    /// The `requestId` its send carried on the wire (fresh per send).
    request_id: String,
    text: String,
    /// K2-05 attachments: the chips of the files it sent (`{name,size,mime}`), shown on its row.
    chips: Vec<Value>,
    /// The daemon ids of those files: once the engine recorded this send they are spent, and the
    /// host forgets their chips (`bind_recorded`).
    attachment_ids: Vec<String>,
    /// When the send went out (the settle grace runs from here).
    submitted_ms: u64,
    /// NEW-2: where the turn shows while the record does not name it: right after the newest record
    /// position the island knew when it sent (every history page and every announced prompt count,
    /// so it is never lower than any earlier island turn's: island turns keep their send order).
    after: u64,
    /// The record id of its prompt, once the daemon announced it with this send's `requestId` (or,
    /// K2-05 F2, by the fallback below when no announcement ever named it).
    record: Option<String>,
    /// F2: the live message ids already on screen when it was sent (never its output).
    seen: Vec<String>,
    /// F2: the live messages it owns while it never bound (no `user_message` named it): the output
    /// of nobody's prompt that arrived while it was the island's turn in flight (bounded).
    took: Vec<String>,
    /// The last non-empty reply seen (kept across a connection reset that drops the live
    /// messages from the island's view).
    reply: String,
    /// The correlated turn-error counter (`turnError.n`) already accounted for.
    err_seen: u64,
    ended: Option<TurnEnd>,
}

/// What the island knew of a settled turn the daemon's history now carries (F4).
#[derive(Debug, Clone)]
struct Settled {
    state: &'static str,
    error: Value,
    reply: String,
    /// B1: the prompt text, kept until a newest page carries the prompt itself.
    user: String,
    /// K2-05 attachments: its chips, kept with the prompt text.
    chips: Vec<Value>,
}

/// One projected turn, with its place in the record: `(prompt position, 0, 0)` for a record
/// turn, `(position, 1, number)` for an island turn the shown record does not carry.
#[derive(Debug, Clone)]
struct Row {
    order: (u64, u8, u64),
    num: u64,
    user: String,
    /// K2-05 attachments: the chips of the files its prompt carried.
    chips: Vec<Value>,
    reply: String,
    state: &'static str,
    error: Value,
}

#[derive(Default)]
struct HostInner {
    pending: Vec<Pending>,
    next_live: u64,
    /// Record id → the island turn number it names (bounded, oldest first out).
    claims: std::collections::HashMap<String, u64>,
    claim_order: VecDeque<String>,
    /// F4: how settled island turns ended, by turn number (lives as long as its claim).
    settled: std::collections::BTreeMap<u64, Settled>,
    /// Cursors handed out for daemon pages that held only a lone reply: that reply completes
    /// the turn the next earlier page ends with (cursor id, reply text; bounded).
    heads: VecDeque<(String, String)>,
    /// The newest record position the island knows (history pages and announced prompts).
    max_known: u64,
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
    /// F6: the newest announced record position a catch-up read was asked for: a prompt the
    /// daemon announced that the known record does not carry (another client's turn) is read
    /// once, when the engine is quiet.
    asked_record: Option<u64>,
    /// The refused newest-page reads already seen on the view's connection, the earliest time a
    /// refused catch-up read may be asked again (once per `STATUS_GAP_MS`), and how many times it
    /// was for the newest announced record (at most `MAX_CATCH_UP_RETRIES`: never a loop).
    reads_failed_seen: u64,
    retry_after_ms: u64,
    retries: u32,
    /// K2-05 attachments: the chips of the files the daemon stored for this island and not sent
    /// yet, by the daemon's id (bounded): a submit shows them on its row.
    uploaded: VecDeque<(String, Value)>,
    /// K2-05 boot follow-up F3: the engine status the last projection of THIS connection saw (None on
    /// a fresh connection, before any status, or while disconnected).
    engine_status: Option<String>,
}

/// F2: the live messages one unbound island turn may own.
const MAX_TOOK: usize = 64;

/// How many times a refused catch-up read is asked again for the same announced record.
const MAX_CATCH_UP_RETRIES: u32 = 3;

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

/// K2-05 attachments: the chips a history message carries (already allowlisted by the fold).
fn msg_chips(m: &Value) -> Vec<Value> {
    m.get("attachments").and_then(Value::as_array).cloned().unwrap_or_default()
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

/// The messages still streaming, as (daemon message id, text so far, the record id of the prompt
/// it answers).
fn live_streams(chat: &Value) -> Vec<(String, String, Option<String>)> {
    chat.get("streaming")
        .and_then(Value::as_array)
        .map(|s| {
            s.iter()
                .filter_map(|m| Some((m.get("id")?.as_str()?.to_owned(), m.get("text")?.as_str()?.to_owned(), msg_prompt(m).map(str::to_owned))))
                .collect()
        })
        .unwrap_or_default()
}

/// F2: the ids of the live messages in a view (landed but not in history yet, or still streaming).
fn live_ids(chat: &Value) -> Vec<String> {
    let landed = chat_messages(chat).into_iter().filter_map(|m| msg_id(&m).filter(|id| !is_history_id(id)).map(str::to_owned));
    landed.chain(live_streams(chat).into_iter().map(|(id, _, _)| id)).collect()
}

/// The record id of the prompt a live message answers (`prompt`), if the daemon announced one.
fn msg_prompt(m: &Value) -> Option<&str> {
    m.get("prompt").and_then(Value::as_str)
}

/// The prompts the daemon announced as recorded on the view's connection (`recorded`), as
/// (record id, this client's own requestId when it was its request), oldest first.
fn recorded(chat: &Value) -> Vec<(String, Option<String>)> {
    chat.get("recorded")
        .and_then(Value::as_array)
        .map(|r| {
            r.iter()
                .filter_map(|e| Some((e.get("id")?.as_str()?.to_owned(), e.get("requestId").and_then(Value::as_str).map(str::to_owned))))
                .collect()
        })
        .unwrap_or_default()
}

/// K2-05 U4b: the pending asks of a connected view as the page shows them (closed fields; the
/// list is already bounded by `MAX_ASKS`), each with whether this island is answering it.
fn asks_view(chat: &Value) -> Value {
    if !chat_connected(chat) {
        return json!([]);
    }
    let answering = chat.get("answering").and_then(Value::as_array).cloned().unwrap_or_default();
    let list = chat.get("asks").and_then(Value::as_array).cloned().unwrap_or_default();
    Value::Array(
        list.iter()
            .take(MAX_ASKS)
            .filter_map(|a| {
                let id = a.get("id")?.as_str()?;
                let field = |k: &str| a.get(k).filter(|v| v.is_string()).cloned().unwrap_or(Value::Null);
                Some(json!({
                    "id": id,
                    "kind": a.get("kind")?.as_str()?,
                    "title": a.get("title").and_then(Value::as_str).unwrap_or(""),
                    "message": field("message"),
                    "placeholder": field("placeholder"),
                    "options": a.get("options").filter(|o| o.is_array()).cloned().unwrap_or(json!([])),
                    "answering": answering.iter().any(|x| x.as_str() == Some(id)),
                }))
            })
            .collect(),
    )
}

/// U4b verifier F2: the asks whose answer from this island the daemon accepted (a connected view
/// only; bounded by `MAX_ASKS`, ids in the daemon's grammar).
fn answered_view(chat: &Value) -> Value {
    if !chat_connected(chat) {
        return json!([]);
    }
    let list = chat.get("answered").and_then(Value::as_array).cloned().unwrap_or_default();
    Value::Array(list.into_iter().filter(Value::is_string).take(MAX_ASKS).collect())
}

/// K2-05 U4b: whether a view holds that pending ask / is answering it.
fn ask_state(chat: &Value, ask_id: &str) -> (bool, bool) {
    let has = |key: &str, f: &dyn Fn(&Value) -> bool| chat.get(key).and_then(Value::as_array).is_some_and(|l| l.iter().any(f));
    (
        chat_connected(chat) && has("asks", &|a: &Value| a.get("id").and_then(Value::as_str) == Some(ask_id)),
        has("answering", &|a: &Value| a.as_str() == Some(ask_id)),
    )
}

/// Whether the view is a connected one whose own newest page arrived.
fn chat_loaded(chat: &Value) -> bool {
    chat_connected(chat) && chat.get("historyLoaded").and_then(Value::as_bool) == Some(true)
}

/// B1: the daemon id of the prompt right before a history reply (the reply's own file, the
/// index before it); None for the first message of a file (its prompt is in the file before).
fn prompt_before(id: &str) -> Option<String> {
    let (file, index) = history_pos(id)?;
    (index >= 2).then(|| format!("s{file}-{}", index - 1))
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
/// keeps the page's closed vocabulary (ready/busy/blocked/unavailable/starting/restarting);
/// `producer.pi` is connected/ready/busy/unavailable. No sentence names the engine vendor.
/// K2-05 boot order = Gentle Dot (store.ts agentState starts at "starting"; ChatSurface
/// statusText «Starting the assistant…» / «The assistant is restarting…»): an engine that is
/// starting or restarting is a wait, never a downed model; sends stay refused until ready.
/// K2-05 U5c: the engine's model as the closed identity the page may show: `provider`, `id`, `name`,
/// plain strings of at most 128 chars without control characters; `null` when there is no usable `id`.
fn engine_model(raw: Option<&Value>) -> Value {
    let Some(obj) = raw.and_then(Value::as_object) else { return Value::Null };
    let text = |key: &str| {
        obj.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty() && t.chars().count() <= 128 && !t.chars().any(char::is_control))
    };
    let Some(id) = text("id") else { return Value::Null };
    let mut out = serde_json::Map::new();
    if let Some(provider) = text("provider") {
        out.insert("provider".into(), json!(provider));
    }
    out.insert("id".into(), json!(id));
    if let Some(name) = text("name") {
        out.insert("name".into(), json!(name));
    }
    Value::Object(out)
}

/// The model line of the projection: only while the engine is ready (a stopped, restarting or
/// unreachable engine answers with nothing, so a stale name is never shown).
fn engine_model_view(chat: &Value) -> Value {
    if !chat_connected(chat) || chat.pointer("/agent/status").and_then(Value::as_str) != Some("ready") {
        return Value::Null;
    }
    chat.pointer("/agent/model").cloned().unwrap_or(Value::Null)
}

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
        Some("restarting") => pair("restarting", "Koda se está reiniciando… abriendo tu conversación.", "unavailable"),
        Some("stopped" | "unavailable") => {
            pair("unavailable", "El motor de Koda se detuvo; probá de nuevo en unos segundos.", "unavailable")
        }
        Some("ready") if paused => pair("blocked", "El chat está en pausa; reanudalo en Ajustes.", "ready"),
        Some("ready") if chat_busy(chat) => pair("busy", "El motor de Koda está respondiendo.", "busy"),
        Some("ready") => pair("ready", "El motor de Koda está listo.", "ready"),
        _ => pair("starting", "Koda está arrancando… abriendo tu conversación.", "connected"),
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
        "attachments": row.chips,
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

    /// K2-05 bind by id: the daemon announced the prompts the engine recorded (`user_message`);
    /// the one carrying an island send's own `requestId` IS that turn's record, and nothing else
    /// ever binds a turn (Gentle Dot store.ts appends the recorded user message by its id).
    fn bind_recorded(&mut self, chat: &Value) {
        for (id, request) in recorded(chat) {
            let Some(pos) = record_pos(&id) else { continue };
            self.max_known = self.max_known.max(pos);
            let Some(request) = request else { continue };
            if self.claims.contains_key(&id) {
                continue;
            }
            let Some(at) = self.pending.iter().position(|p| p.record.is_none() && p.request_id == request) else { continue };
            self.pending[at].record = Some(id.clone());
            let num = self.pending[at].num;
            self.claim(&id, num);
            // the engine took the send: its files are spent on the daemon, their chips live on its row
            let spent = std::mem::take(&mut self.pending[at].attachment_ids);
            self.uploaded.retain(|(u, _)| !spent.contains(u));
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
                let pending = self.pending.iter().find(|p| p.record.is_some() && p.num == num);
                let (user, chips) = match pending {
                    Some(p) => (p.text.clone(), p.chips.clone()),
                    None => self.settled.get(&num).filter(|s| !s.user.is_empty() || !s.chips.is_empty()).map(|s| (s.user.clone(), s.chips.clone()))?,
                };
                Some((num, user, chips, msg_text(m).to_owned(), pos - 1))
            });
        let cursor = match (first_prompt, record.first()) {
            _ if head_turn.is_some() => has_earlier.then(|| head_turn.as_ref().map(|h| h.4)).flatten(),
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
        let live: std::collections::HashMap<u64, &Pending> = self.pending.iter().filter(|p| p.record.is_some()).map(|p| (p.num, p)).collect();
        // a bound island turn still in `pending` renders from what the island saw (its end, if
        // any): its reply is already whole, so the record's copy is never added to it
        let island_row = |p: &Pending, order: (u64, u8, u64)| {
            let (state, error) = p.ended.as_ref().map(end_view).unwrap_or((LIVE_ROW, Value::Null));
            Row { order, num: p.num, user: p.text.clone(), chips: p.chips.clone(), reply: p.reply.clone(), state, error }
        };
        let mut rows: Vec<Row> = Vec::new();
        if let Some((num, user, chips, reply, pos)) = head_turn {
            rows.push(match live.get(&num) {
                Some(p) => island_row(p, (pos, 0, 0)),
                None => Row { order: (pos, 0, 0), num, user, chips, reply, state: "completed", error: Value::Null },
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
                            s.chips = vec![];
                        }
                    }
                    let row = match live.get(&num) {
                        Some(p) => island_row(p, (*pos, 0, 0)),
                        None => Row { order: (*pos, 0, 0), num, user: msg_text(m).to_owned(), chips: msg_chips(m), reply: String::new(), state: "completed", error: Value::Null },
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
            if s.state == "completed" && s.reply.is_empty() && s.user.is_empty() && s.chips.is_empty() {
                self.settled.remove(&row.num);
            }
        }
        (rows, cursor)
    }

    /// The island turns the shown record does not carry: in the window (`live`), the running
    /// one, last; anywhere, the ended ones where they belong, when that is within `[lo, hi)` of the
    /// record: a bound turn at its own record position, an unbound one (a refused send) right after
    /// what the island knew when it sent (NEW-2). `shown` = numbers already rendered.
    fn island_rows(&self, lo: u64, hi: u64, live: Option<Option<(u64, &'static str)>>, shown: &[u64]) -> Vec<Row> {
        self.pending
            .iter()
            .filter(|p| !shown.contains(&p.num))
            .filter_map(|p| {
                let at = p.record.as_deref().and_then(record_pos).unwrap_or(p.after);
                let (order, state, error) = match (&p.ended, live) {
                    (None, Some(state)) => {
                        let state = state.filter(|(n, _)| *n == p.num).map(|(_, s)| s).unwrap_or("thinking");
                        ((u64::MAX, 1, p.num), state, Value::Null)
                    }
                    (Some(end), _) if (lo..hi).contains(&at) => {
                        let (state, error) = end_view(end);
                        ((at, 1, p.num), state, error)
                    }
                    _ => return None,
                };
                Some(Row { order, num: p.num, user: p.text.clone(), chips: p.chips.clone(), reply: p.reply.clone(), state, error })
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
        let newest_pos = messages.iter().filter_map(|m| msg_id(m).and_then(record_pos)).max().unwrap_or(0);
        self.max_known = self.max_known.max(newest_pos);
        self.bind_recorded(chat);
        let connected = chat_connected(chat);
        let busy = chat_busy(chat);
        let status = chat.pointer("/agent/status").and_then(Value::as_str).filter(|_| connected);
        let engine_down = matches!(status, Some("restarting" | "stopped" | "unavailable"));
        let (err_n, err_code) = turn_error_counter(chat);
        // K2-05 boot follow-up F3 (Koda deviation, reason «empty chat after a long boot»): Gentle Dot's
        // UI asks for history only when it connects (client.ts:72) and its daemon broadcasts models,
        // not history, when the engine becomes ready (bridge.ts:1176-1186), so a boot longer than the
        // daemon's 60 s history hold leaves the chat empty there too. The island asks for the newest
        // page again when THIS connection sees the engine go from not ready to ready (a fresh
        // connection's first status never does: its own connect-time read covers it).
        if status == Some("ready") && matches!(self.engine_status.as_deref(), Some("starting" | "restarting" | "stopped" | "unavailable")) {
            self.refresh_due = true;
        }
        self.engine_status = status.map(str::to_owned);

        // live output (landed assistant messages not yet in the daemon's history, and messages
        // still streaming), each owned by the island turn its prompt's record id names; output
        // of any other prompt (another client's, or one the island did not see) is nobody's here
        let streams = live_streams(chat);
        self.quiet = connected && !busy && streams.is_empty();
        // F6: a prompt the daemon announced that the known record does not carry yet (another
        // client's turn) is read once the engine is quiet, so that turn shows where it was recorded
        let announced = recorded(chat).iter().filter_map(|(id, _)| record_pos(id)).max().unwrap_or(0);
        let failed = history_reads_counter(chat).1;
        if failed > self.reads_failed_seen && announced > newest_pos && self.asked_record == Some(announced) && self.retries < MAX_CATCH_UP_RETRIES {
            // the catch-up read was refused: ask again, later, a bounded number of times
            self.asked_record = None;
            self.retries += 1;
            self.retry_after_ms = now_ms.saturating_add(STATUS_GAP_MS);
        }
        self.reads_failed_seen = failed;
        if self.quiet && chat_loaded(chat) && announced > newest_pos && self.asked_record != Some(announced) && now_ms >= self.retry_after_ms {
            if self.asked_record.is_some_and(|asked| asked < announced) {
                self.retries = 0;
            }
            self.asked_record = Some(announced);
            self.refresh_due = true;
        }
        // (message id, text, still streaming, the prompt it answers)
        let mut outputs: Vec<(String, String, bool, Option<String>)> = Vec::new();
        for m in &messages {
            let Some(id) = msg_id(m) else { continue };
            if is_history_id(id) || msg_role(m) != "assistant" {
                continue;
            }
            outputs.push((id.to_owned(), msg_text(m).to_owned(), false, msg_prompt(m).map(str::to_owned)));
        }
        for (id, text, prompt) in &streams {
            outputs.push((id.clone(), text.clone(), true, prompt.clone()));
        }
        // K2-05 F2: the island's turn in flight that no `user_message` named (an older daemon, or an
        // announcement that lost its requestId) owns the new output of nobody's island prompt.
        // Review F3: only output that can be its own. While the engine runs and a prompt the island
        // did not name was announced after its send, that run may be another client's (the island's
        // send then answers `busy`): the turn waits. Once the run is quiet and nothing refused the
        // send, the run's first announced prompt after the send was the island's (the daemon runs
        // one prompt at a time, recorded first): only its output (or output naming no prompt, an
        // older daemon's) is taken; a later prompt of that run (a steer) is never the island's.
        let claims = &self.claims;
        let first_after = |p: &Pending| {
            recorded(chat).into_iter().map(|(id, _)| id).find(|id| record_pos(id).is_some_and(|pos| pos > p.after) && !claims.contains_key(id))
        };
        if let Some(p) = self.pending.last().filter(|p| p.ended.is_none() && p.record.is_none()) {
            let run = first_after(p);
            let p = self.pending.last_mut().expect("the last pending turn");
            if err_n > p.err_seen {
                // an error correlated to this send: the daemon refused it, so nothing it took was its own
                p.took.clear();
                p.reply.clear();
            }
            for (id, _, _, prompt) in outputs.iter().filter(|_| err_n <= p.err_seen) {
                let claimed = prompt.as_deref().is_some_and(|r| claims.contains_key(r));
                let own_run = match prompt.as_deref() {
                    None => !busy || run.is_none(),
                    Some(r) => !busy && run.as_deref() == Some(r),
                };
                if own_run && !claimed && !p.seen.contains(id) && !p.took.contains(id) && p.took.len() < MAX_TOOK {
                    p.took.push(id.clone());
                }
            }
        }
        let owners: std::collections::HashMap<&str, u64> =
            self.pending.iter().filter_map(|p| p.record.as_deref().map(|r| (r, p.num))).collect();
        let owner_of = |id: &str, prompt: Option<&str>| {
            prompt
                .and_then(|p| owners.get(p))
                .copied()
                .or_else(|| self.pending.iter().find(|p| p.took.iter().any(|t| t == id)).map(|p| p.num))
                .unwrap_or(0)
        };
        // (owner, text, still streaming, the prompt it answers)
        let live: Vec<(u64, String, bool, Option<String>)> =
            outputs.into_iter().map(|(id, text, streaming, prompt)| (owner_of(&id, prompt.as_deref()), text, streaming, prompt)).collect();
        // the output an island turn owns (`owner` > 0), or (`owner` 0) the output of no island turn
        // that answers `prompt` or names no prompt at all
        let owned = |owner: u64, prompt: Option<&str>| -> (String, bool) {
            let mine = |l: &&(u64, String, bool, Option<String>)| {
                l.0 == owner && (owner != 0 || l.3.is_none() || l.3.as_deref() == prompt)
            };
            // an empty message (a tool call with no text) adds no paragraph
            let parts: Vec<&str> = live.iter().filter(mine).filter(|l| !l.1.is_empty()).map(|l| l.1.as_str()).collect();
            (parts.join("\n\n"), live.iter().filter(mine).any(|l| l.2))
        };

        // submitted turns: advance the lifecycle
        let count = self.pending.len();
        let mut live_state: Option<(u64, &'static str)> = None;
        let mut settled_now = false;
        for (i, p) in self.pending.iter_mut().enumerate() {
            // a bound turn's output, or (F2) what an unbound one took
            let (reply, streaming) = owned(p.num, None);
            // the turn's own output, also after it ended: a cancelled turn's held tail still
            // lands (the daemon flushes it once), and only this turn owns it
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
        // K2-05 F2 fallback, ONLY for a turn no `user_message` ever named: once it ended after taking
        // output (the engine ran it, so it recorded its prompt), it is the first unclaimed recorded
        // prompt after its send position with its own text, so it is never drawn beside that row.
        // Review F4: a turn interrupted before any `user_message` reached the island (the connection
        // or the engine went away) took nothing, but the engine may have recorded it: the daemon ran
        // nothing else while it was idle at the send, so it is the FIRST prompt recorded after its
        // send position — when that prompt has its own text and no island turn holds it. Any other
        // first prompt (another client's) is never taken: the turn stays where it was sent.
        for i in 0..self.pending.len() {
            let p = &self.pending[i];
            let interrupted = matches!(&p.ended, Some(TurnEnd::Error(code)) if code == "interrupted");
            if p.record.is_some() || p.ended.is_none() || (p.took.is_empty() && !interrupted) {
                continue;
            }
            let after = |m: &&Value| msg_role(m) == "user" && msg_id(m).filter(|id| is_history_id(id)).and_then(record_pos).is_some_and(|pos| pos > p.after);
            let fits = |m: &Value| msg_text(m) == p.text && msg_id(m).is_some_and(|id| !self.claims.contains_key(id));
            let found = if p.took.is_empty() {
                messages.iter().find(after).filter(|m| fits(m))
            } else {
                messages.iter().filter(after).find(|m| fits(m))
            }
            .and_then(msg_id)
            .map(str::to_owned);
            if let Some(id) = found {
                let num = p.num;
                self.pending[i].record = Some(id.clone());
                self.claim(&id, num);
            }
        }
        // a settled turn whose record the shown history has reached: the record turn takes over,
        // and the island keeps how it really ended (F4: cancelled / interrupted / the reply)
        let mut keep = Vec::with_capacity(self.pending.len());
        for p in std::mem::take(&mut self.pending) {
            let reached = p.record.as_deref().and_then(record_pos).is_some_and(|pos| pos <= newest_pos);
            match (&p.ended, reached) {
                (Some(end), true) => {
                    let (state, error) = end_view(end);
                    self.settled.insert(p.num, Settled { state, error, reply: p.reply, user: p.text, chips: p.chips });
                }
                _ => keep.push(p),
            }
        }
        self.pending = keep;

        let (mut rows, cursor) = self.page_rows(&messages, has_earlier, None);
        for row in rows.iter_mut().filter(|r| r.state == LIVE_ROW) {
            row.state = live_state.filter(|(n, _)| *n == row.num).map(|(_, s)| s).unwrap_or("thinking");
        }
        // live output of no island turn (a turn in flight when the island connected): it continues
        // the newest history turn only when that turn's prompt is the last message of the record
        // and the output answers it (or names no prompt) — F6: never a turn whose reply is already
        // recorded; another client's turn shows when its record arrives
        let last_prompt_id = messages
            .iter()
            .rev()
            .find(|m| msg_id(m).is_some_and(is_history_id))
            .filter(|m| msg_role(m) == "user")
            .and_then(msg_id)
            .map(str::to_owned);
        let last_prompt = last_prompt_id.as_deref().and_then(record_pos);
        let (orphan, orphan_streaming) = owned(0, last_prompt_id.as_deref());
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
            // K2-05 U5c: the model the ENGINE answers with, read-only (never chosen here); null while unknown
            "engine_model": engine_model_view(chat),
            "target": Value::Null,
            "producer": producer,
            // K2-05 U4b: the agent's pending questions (Gentle Dot `asks`), one card each
            "asks": asks_view(chat),
            // U4b verifier F2: the asks whose answer from this island the daemon accepted
            "answered_asks": answered_view(chat),
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
                if let Some(dup) = self.duplicate(client_request_id) {
                    return Ok(Routed::Answer(dup));
                }
                self.refresh_if_due(link, caller);
                self.submit(link, caller, text, client_request_id, attachments, now_ms)
            }
            Command::Discard { id } => {
                // K2-05 attachments: the user removed an unsent file: the daemon deletes it (only an
                // id it issued to this island can name one); the chip leaves the host's memory
                self.inner.lock().expect("chat host lock").uploaded.retain(|(u, _)| u != id);
                link.command(caller, &json!({"action": "chat_upload_discard", "id": id})).map_err(|_| send_refused())?;
                Ok(Routed::Answer(json!({"discarded": true})))
            }
            Command::Cancel { turn_id } => self.cancel(link, caller, turn_id, now_ms),
            Command::Answer { ask_id, answer } => Self::answer(link, caller, ask_id, answer),
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

    /// The page's own repeat of a submit it already made: the same turn, never a second send.
    fn duplicate(&self, client_request_id: &str) -> Option<Value> {
        let inner = self.inner.lock().expect("chat host lock");
        let num = inner.pending.iter().find(|p| p.client_request_id == client_request_id).map(|p| p.num)?;
        Some(json!({"turn_id": format!("t-{num}"), "duplicate": true}))
    }

    /// R1: the «a turn is running» check, the send and the turn's reservation are ONE critical
    /// section (under the host lock), so two concurrent submits can never both reach the daemon,
    /// and no turn is ever visible before its send went out (NEW-2: nothing to cancel unsent).
    /// The send carries a fresh `requestId`: the daemon echoes it on the `user_message` of the
    /// prompt the engine records for it, and only that binds the turn. A send the island cannot
    /// make is refused here (the page keeps the draft and shows the refusal), never invented.
    fn submit(&self, link: &dyn ChatLink, caller: &str, text: &str, client_request_id: &str, attachments: &[String], now_ms: u64) -> Result<Routed, crate::chat::ChatError> {
        // K2-05 attachments (Gentle Dot parseClientMessage): a message with files may have no text
        let text = if !attachments.is_empty() && text.trim().is_empty() { String::new() } else { crate::chat::validate_text(text)? };
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
        let request_id = fresh_request_id();
        let mut payload = json!({"action": "chat_send", "text": text, "clientRequestId": client_request_id, "requestId": request_id});
        if !attachments.is_empty() {
            payload["attachments"] = json!(attachments);
        }
        link.command(caller, &payload).map_err(|_| send_refused())?;
        // the chips stay known until the engine records this send (`bind_recorded`) or the user
        // removes the file: a send the daemon refused never spent its files, so a resend of the same
        // ids shows them again on its row
        let chips: Vec<Value> = attachments.iter().filter_map(|id| inner.uploaded.iter().find(|(u, _)| u == id).map(|(_, c)| c.clone())).collect();
        let num = inner.alloc_live();
        let after = inner.max_known;
        inner.pending.push(Pending {
            num,
            client_request_id: client_request_id.to_owned(),
            request_id,
            text,
            chips,
            attachment_ids: attachments.to_vec(),
            submitted_ms: now_ms,
            after,
            record: None,
            seen: live_ids(&before),
            took: vec![],
            reply: String::new(),
            err_seen: turn_error_counter(&before).0,
            ended: None,
        });
        if inner.pending.len() > MAX_PENDING {
            inner.pending.remove(0);
        }
        // the keeper re-publishes while a turn is live (its settle grace ends by time)
        inner.live = true;
        Ok(Routed::Answer(json!({"turn_id": format!("t-{num}"), "duplicate": false})))
    }

    /// K2-05 attachments (L11 2a, Gentle Dot's `POST /upload` over the island socket): sends one
    /// file the user picked, dropped or pasted to the DAEMON, in base64 chunks through the chat
    /// client (its window gate, its own upload budget), and waits — at most `wait_ms` after the
    /// last chunk — for the daemon's answer. Returns the stored file as its chip shows it plus the
    /// daemon's opaque id (`{id,name,size,mime}`); never a path. The island stores nothing. Blocks:
    /// callers run it off the main thread, never under the host lock.
    pub fn upload(&self, link: &dyn ChatLink, caller: &str, raw_name: &str, bytes: &[u8], wait_ms: u64) -> Result<Value, crate::chat::ChatError> {
        use base64::Engine as _;
        if !chat_connected(&link.view()) {
            return Err(engine_unavailable());
        }
        if bytes.len() > MAX_UPLOAD_FILE_BYTES {
            return Err(upload_error("file_too_large"));
        }
        let name = display_name(raw_name);
        let request_id = fresh_request_id();
        let answer = |view: &Value| -> Option<Value> {
            view.get("uploads").and_then(Value::as_array)?.iter().rev().find(|u| u["requestId"] == json!(request_id)).cloned()
        };
        let parts: Vec<&[u8]> = if bytes.is_empty() { vec![&[][..]] } else { bytes.chunks(UPLOAD_CHUNK_BYTES).collect() };
        let mut offset = 0u64;
        let mut got = None;
        for part in parts {
            let data = base64::engine::general_purpose::STANDARD.encode(part);
            let payload = json!({"action": "chat_upload", "requestId": request_id, "name": name, "size": bytes.len() as u64, "offset": offset, "data": data});
            let view = link.command(caller, &payload).map_err(|_| if offset == 0 { send_refused() } else { upload_error("rate_limited") })?;
            offset += part.len() as u64;
            // a refusal answers early (the daemon ignores the rest of a refused upload)
            if let Some(a) = answer(&view) {
                got = Some(a);
                break;
            }
        }
        let deadline = Instant::now() + Duration::from_millis(wait_ms);
        while got.is_none() {
            let view = link.view();
            got = answer(&view);
            if got.is_some() { break; }
            if !chat_connected(&view) { return Err(engine_unavailable()); }
            if Instant::now() >= deadline { return Err(upload_error("upload_failed")); }
            std::thread::sleep(Duration::from_millis(20));
        }
        let got = got.unwrap_or(Value::Null);
        if let Some(code) = got.get("code").and_then(Value::as_str) {
            return Err(upload_error(code));
        }
        let attachment = got.get("attachment").cloned().filter(|a| a.get("id").and_then(Value::as_str).is_some_and(upload_id_ok)).ok_or_else(|| upload_error("upload_failed"))?;
        let id = attachment["id"].as_str().unwrap_or_default().to_owned();
        let chip = json!({"name": attachment["name"], "size": attachment["size"], "mime": attachment["mime"]});
        let mut inner = self.inner.lock().expect("chat host lock");
        inner.uploaded.retain(|(u, _)| *u != id);
        if inner.uploaded.len() >= MAX_UPLOAD_ANSWERS { inner.uploaded.pop_front(); }
        inner.uploaded.push_back((id, chip));
        Ok(attachment)
    }

    /// K2-05 U4b: one answer to a pending ask, as ONE `ui_response` through the chat client (its
    /// window gate, its ask/option validation, its answered-once mark and the reserved send budget).
    /// The refusal says why: the question is gone, it was already answered here, or the answer does
    /// not fit it. The typed value travels exactly as the page sent it (never rewritten).
    fn answer(link: &dyn ChatLink, caller: &str, ask_id: &str, answer: &crate::chat::AskAnswer) -> Result<Routed, crate::chat::ChatError> {
        use crate::chat::AskAnswer;
        let why = |view: &Value| match ask_state(view, ask_id) {
            (false, _) => ask_closed(),
            (true, true) => ask_answered(),
            (true, false) => answer_refused(),
        };
        let before = link.view();
        if !matches!(ask_state(&before, ask_id), (true, false)) {
            return Err(why(&before));
        }
        let value = match answer {
            AskAnswer::Value(v) => json!(v),
            AskAnswer::Confirmed(b) => json!(b),
            AskAnswer::Cancelled => Value::Null,
        };
        match link.command(caller, &json!({"action": "chat_ui_response", "askId": ask_id, "answer": value})) {
            Ok(_) => Ok(Routed::Answer(json!({"answered": true}))),
            // a concurrent answer won the state lock, or the ask closed meanwhile: say which
            Err(_) => Err(why(&link.view())),
        }
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
        inner.bind_recorded(&v);
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

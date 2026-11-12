//! Unit U1 — the island chat contract, pure (no I/O, no window system).
//!
//! The subset of `abito.chat.v1` (docs/abito-features.md §2) that a LOCAL
//! model behind the loopback llama.cpp router can honestly produce today:
//! native-assigned ids, one turn per conversation, monotonic `seq`, plain-text
//! deltas, terminal `completed`/`cancelled`/`error`, typed safe errors, bounded
//! draft/response/cache, and visible history trimming against the context
//! budget (never a bigger context allocation).
//!
//! Not here, on purpose: the Pi chat producer. The desktop has none yet, so
//! this conversation talks to the selected local model only (chatlane.rs);
//! `waiting_approval` exists in the state machine because the contract names
//! it, but nothing in this unit can enter it (no producer emits proposals).
//! A future Pi adapter plugs in at the same `Event` boundary.

use std::collections::VecDeque;

use serde::Serialize;
use serde_json::{json, Value};

/// Draft limit: Unicode scalar values (contract: ≤8,000).
pub const DRAFT_MAX_SCALARS: usize = 8_000;
/// Streamed response limit (contract: ≤32,000); reaching it ends the turn
/// with `finish_reason: limit`, never with another automatic request.
pub const RESPONSE_MAX_SCALARS: usize = 32_000;
/// Presentation cache: ≤100 turns or 256 KiB of text, whichever first.
/// Eviction is presentation-only; #341 persists history independently.
pub const CACHE_MAX_TURNS: usize = 100;
pub const CACHE_MAX_BYTES: usize = 256 * 1024;

/// Turn states, exactly the contract strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnState {
    Queued,
    Thinking,
    Streaming,
    WaitingApproval,
    Completed,
    Cancelled,
    Error,
}

impl TurnState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            TurnState::Completed | TurnState::Cancelled | TurnState::Error
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Stop,
    Limit,
    Cancelled,
}

/// `chat.error`: a code, a safe message, retryable. Never a raw provider
/// body, header, key or URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatError {
    pub code: String,
    pub safe_message: String,
    pub retryable: bool,
}

impl ChatError {
    fn new(code: &str, safe_message: &str, retryable: bool) -> Self {
        ChatError {
            code: code.to_string(),
            safe_message: safe_message.to_string(),
            retryable,
        }
    }
    pub fn invalid_input(why: &str) -> Self {
        Self::new("invalid_input", why, false)
    }
    pub fn local_model_unavailable() -> Self {
        Self::new(
            "local_model_unavailable",
            "El modelo local no responde: el chat no está disponible. No se usó ningún otro modelo.",
            true,
        )
    }
    pub fn queue_full() -> Self {
        Self::new(
            "queue_full",
            "Ya hay una respuesta en curso. Esperá o cancelala antes de enviar otra.",
            true,
        )
    }
    pub fn inference_error() -> Self {
        Self::new(
            "inference_error",
            "El modelo local devolvió un error. No se reintentó ni se usó otro modelo.",
            true,
        )
    }
    pub fn stream_gap() -> Self {
        Self::new(
            "stream_gap",
            "La respuesta llegó incompleta o mal formada. No se reintentó.",
            true,
        )
    }
    pub fn context_limit() -> Self {
        Self::new(
            "context_limit",
            "El mensaje no entra en el contexto del modelo elegido. Acortalo.",
            false,
        )
    }
    pub fn profile_missing() -> Self {
        Self::new(
            "profile_missing",
            "No hay un modelo local elegido para conversar.",
            false,
        )
    }
    /// The resource gate refused (U2): the message names what to do.
    pub fn resource_authorization_required(safe_message: &str) -> Self {
        Self::new("resource_authorization_required", safe_message, true)
    }
    /// #343: an attachment the page referenced no longer resolves.
    pub fn attachment_unavailable() -> Self {
        Self::new(
            "attachment_unavailable",
            "Hay un archivo adjunto que ya no está disponible. Quitálo del mensaje y volvé a enviar.",
            false,
        )
    }
    /// #343: the chosen local model cannot read images (no vision modality).
    pub fn vision_unsupported() -> Self {
        Self::new(
            "attachment_vision_unsupported",
            "El modelo elegido no puede leer imágenes. Quitá los adjuntos de imagen y volvé a enviar.",
            false,
        )
    }
}

/// Validate and normalize a draft: CRLF/CR → LF, no control characters other
/// than LF and TAB (C0, DEL and C1 are refused), non-blank, ≤8,000 scalars.
pub fn validate_text(text: &str) -> Result<String, ChatError> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.chars().count() > DRAFT_MAX_SCALARS {
        return Err(ChatError::invalid_input(
            "El mensaje supera los 8.000 caracteres.",
        ));
    }
    if normalized
        .chars()
        .any(|c| c != '\n' && c != '\t' && (c.is_control()))
    {
        return Err(ChatError::invalid_input(
            "El mensaje contiene caracteres de control.",
        ));
    }
    if normalized.trim().is_empty() {
        return Err(ChatError::invalid_input("El mensaje está vacío."));
    }
    Ok(normalized)
}

/// The page's own idempotency token: 8..=64 of `[A-Za-z0-9_-]`.
pub fn valid_client_request_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The profile a turn is frozen to (no halfway swap on selection change).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProfileRef {
    pub profile_id: String,
    pub revision: u64,
    pub lane_id: String,
}

/// #343 — one file attached to a turn: the id the page references, the
/// sanitized display name, the detected MIME type, the byte size and the
/// generated name it was stored under in the island's uploads directory
/// (metadata only — the content lives on disk, read back at prompt build).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub file: String,
}

/// Attachments accepted on one turn (submit parsing and the page agree).
pub const MAX_ATTACHMENTS_PER_TURN: usize = 5;

/// An attachment id the page may reference: `a-` + 16 lowercase hex chars.
pub fn valid_attachment_id(id: &str) -> bool {
    id.len() == 18
        && id.starts_with("a-")
        && id[2..].bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// #418 — bounds of the #371 transcript cards (the page caps the same scalars).
pub const MAX_TOOL_CALLS: usize = 64;
pub const MAX_APPROVALS: usize = 32;
pub const TOOL_NAME_MAX: usize = 64;
pub const TOOL_SUMMARY_MAX: usize = 240;
pub const APPROVAL_OPERATION_MAX: usize = 80;
const EVENT_ID_MAX: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolState {
    Running,
    Done,
    Failed,
}

/// One tool call as the turn shows it: an id, a bounded name, a state and an
/// optional one-line summary. Never arguments, results, paths or env.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub state: ToolState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Approved,
    Denied,
    Expired,
}

/// The decision taken on one #338 proposal card, recorded on the turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApprovalDecision {
    pub request_id: String,
    pub operation: String,
    pub decision: Decision,
}

fn safe_token(s: &str, max: usize) -> bool {
    (1..=max).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// One plain line: no control characters, non-blank, ≤ `max` scalars.
fn plain_line(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control)
}

impl ToolCall {
    pub fn valid(&self) -> bool {
        safe_token(&self.call_id, EVENT_ID_MAX)
            && safe_token(&self.name, TOOL_NAME_MAX)
            && self.summary.as_deref().is_none_or(|s| plain_line(s, TOOL_SUMMARY_MAX))
    }
}

impl ApprovalDecision {
    pub fn valid(&self) -> bool {
        safe_token(&self.request_id, EVENT_ID_MAX) && plain_line(&self.operation, APPROVAL_OPERATION_MAX)
    }
}

/// `chat.accepted`: queued work, not completion and not approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Accepted {
    pub turn_id: String,
    pub request_id: String,
    pub lane_id: String,
    pub profile_id: String,
    pub profile_revision: u64,
    /// True when this is the same accepted turn for a repeated client id.
    pub duplicate: bool,
}

/// One producer event, applied with a monotonic `seq` (1, 2, 3, …).
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Thinking,
    Delta(String),
    WaitingApproval,
    /// #418: a tool call started or finished (upsert by `call_id`).
    ToolCall(ToolCall),
    /// #418: the decision taken on a #338 proposal during this turn.
    Approval(ApprovalDecision),
    Complete(FinishReason),
    Error(ChatError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    Ok,
    /// The delta crossed the response limit: kept up to the limit, turn
    /// completed with `finish_reason: limit`.
    Truncated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    UnknownTurn,
    Regressing,
    Gap,
    AfterTerminal,
    InvalidTransition,
    /// #418: an unsafe or over-bound tool/approval payload.
    Invalid,
}

#[derive(Debug, Clone)]
pub struct Turn {
    pub turn_id: String,
    pub request_id: String,
    pub client_request_id: String,
    pub user_text: String,
    pub reply: String,
    pub state: TurnState,
    pub seq: u64,
    pub finish: Option<FinishReason>,
    pub error: Option<ChatError>,
    pub profile: ProfileRef,
    /// Older turns left out of this turn's prompt (shown in the UI).
    pub trimmed_turns: usize,
    /// #343: files attached to THIS turn (metadata; content on disk).
    pub attachments: Vec<Attachment>,
    /// #418: tool-call receipts (empty for plain turns; never serialized then).
    pub tool_calls: Vec<ToolCall>,
    /// #418: approval decisions taken during the turn.
    pub approvals: Vec<ApprovalDecision>,
}

impl Turn {
    fn bytes(&self) -> usize {
        self.user_text.len() + self.reply.len()
    }
}

/// The bounded active context of one conversation. #341 stores history separately.
#[derive(Debug)]
pub struct Conversation {
    id: String,
    turns: VecDeque<Turn>,
    next: u64,
    evicted: usize,
}

impl Conversation {
    pub fn new(id: &str) -> Self {
        Conversation {
            id: id.to_string(),
            turns: VecDeque::new(),
            next: 0,
            evicted: 0,
        }
    }

    /// Restore the newest page; older presentation pages never enlarge model context.
    pub fn restore(id: &str, turns: Vec<Turn>) -> Self {
        let next = turns.iter().filter_map(|t| t.turn_id.strip_prefix("t-")?.parse::<u64>().ok()).max().unwrap_or(0);
        let mut convo = Self { id: id.into(), turns: turns.into(), next, evicted: 0 };
        convo.enforce_cache();
        convo
    }

    /// Project a bounded disk page without applying the active model-context cache.
    pub fn project_history(id: &str, turns: Vec<Turn>) -> Value {
        Self { id: id.into(), turns: turns.into(), next: 0, evicted: 0 }.view()
    }

    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn len(&self) -> usize {
        self.turns.len()
    }
    pub fn is_empty(&self) -> bool {
        self.turns.is_empty()
    }
    pub fn evicted(&self) -> usize {
        self.evicted
    }
    pub fn bytes(&self) -> usize {
        self.turns.iter().map(Turn::bytes).sum()
    }
    pub fn turn(&self, turn_id: &str) -> Option<&Turn> {
        self.turns.iter().find(|t| t.turn_id == turn_id)
    }
    fn turn_mut(&mut self, turn_id: &str) -> Option<&mut Turn> {
        self.turns.iter_mut().find(|t| t.turn_id == turn_id)
    }
    /// The running (non-terminal) turn, if any.
    pub fn active(&self) -> Option<&Turn> {
        self.turns.back().filter(|t| !t.state.is_terminal())
    }

    /// #343: every attachment referenced by the turns currently in memory
    /// (bounded by the presentation cache) — used to resolve file contents
    /// once per prompt instead of once per message.
    pub fn attachments(&self) -> Vec<Attachment> {
        self.turns.iter().flat_map(|t| t.attachments.iter().cloned()).collect()
    }

    /// `chat.submit`: native assigns `turn_id`/`request_id`; a repeated
    /// client id returns the SAME accepted turn (never a second job); a
    /// running turn refuses a new one (`queue_full`, one turn per
    /// conversation in V1).
    pub fn submit(
        &mut self,
        text: &str,
        client_request_id: &str,
        profile: &ProfileRef,
    ) -> Result<Accepted, ChatError> {
        self.submit_with_attachments(text, client_request_id, profile, Vec::new())
    }

    /// #343 — same contract as [`submit`] with file attachments: the page
    /// references attachments by id; the metadata was already validated and
    /// stored by the attach commands (Rust owns the files, the page never
    /// sends content or paths). A running turn still refuses; attachments
    /// never change ids or the duplicate rule.
    pub fn submit_with_attachments(
        &mut self,
        text: &str,
        client_request_id: &str,
        profile: &ProfileRef,
        attachments: Vec<Attachment>,
    ) -> Result<Accepted, ChatError> {
        if !valid_client_request_id(client_request_id) {
            return Err(ChatError::invalid_input("Identificador de envío inválido."));
        }
        if let Some(t) = self
            .turns
            .iter()
            .find(|t| t.client_request_id == client_request_id)
        {
            return Ok(Self::accepted(t, true));
        }
        if self.active().is_some() {
            return Err(ChatError::queue_full());
        }
        let text = validate_text(text)?;
        self.next += 1;
        let turn = Turn {
            turn_id: format!("t-{}", self.next),
            request_id: format!("{}/r-{}", self.id, self.next),
            client_request_id: client_request_id.to_string(),
            user_text: text,
            reply: String::new(),
            state: TurnState::Queued,
            seq: 0,
            finish: None,
            error: None,
            profile: profile.clone(),
            trimmed_turns: 0,
            attachments,
            tool_calls: Vec::new(),
            approvals: Vec::new(),
        };
        let accepted = Self::accepted(&turn, false);
        self.turns.push_back(turn);
        self.enforce_cache();
        Ok(accepted)
    }

    /// The accepted turn for a client id the page already used, if any.
    pub fn lookup(&self, client_request_id: &str) -> Option<Accepted> {
        self.turns
            .iter()
            .find(|t| t.client_request_id == client_request_id)
            .map(|t| Self::accepted(t, true))
    }

    fn accepted(t: &Turn, duplicate: bool) -> Accepted {
        Accepted {
            turn_id: t.turn_id.clone(),
            request_id: t.request_id.clone(),
            lane_id: t.profile.lane_id.clone(),
            profile_id: t.profile.profile_id.clone(),
            profile_revision: t.profile.revision,
            duplicate,
        }
    }

    /// Apply one producer event. Rejected events change nothing.
    pub fn apply(&mut self, turn_id: &str, seq: u64, event: Event) -> Result<Applied, Reject> {
        let turn = self.turn_mut(turn_id).ok_or(Reject::UnknownTurn)?;
        if turn.state.is_terminal() {
            return Err(Reject::AfterTerminal);
        }
        if seq <= turn.seq {
            return Err(Reject::Regressing);
        }
        if seq != turn.seq + 1 {
            return Err(Reject::Gap);
        }
        let mut outcome = Applied::Ok;
        match event {
            Event::Thinking => match turn.state {
                TurnState::Queued | TurnState::Thinking => turn.state = TurnState::Thinking,
                _ => return Err(Reject::InvalidTransition),
            },
            Event::Delta(text) => match turn.state {
                TurnState::Queued | TurnState::Thinking | TurnState::Streaming => {
                    let have = turn.reply.chars().count();
                    let room = RESPONSE_MAX_SCALARS.saturating_sub(have);
                    if text.chars().count() > room {
                        turn.reply.extend(text.chars().take(room));
                        turn.state = TurnState::Completed;
                        turn.finish = Some(FinishReason::Limit);
                        outcome = Applied::Truncated;
                    } else {
                        turn.reply.push_str(&text);
                        turn.state = TurnState::Streaming;
                    }
                }
                _ => return Err(Reject::InvalidTransition),
            },
            Event::WaitingApproval => match turn.state {
                TurnState::Thinking | TurnState::Streaming => {
                    turn.state = TurnState::WaitingApproval
                }
                _ => return Err(Reject::InvalidTransition),
            },
            Event::ToolCall(call) => {
                if !call.valid() {
                    return Err(Reject::Invalid);
                }
                match turn.tool_calls.iter().position(|c| c.call_id == call.call_id) {
                    Some(i) => {
                        if turn.tool_calls[i].state != ToolState::Running {
                            return Err(Reject::InvalidTransition);
                        }
                        turn.tool_calls[i] = call;
                    }
                    None if turn.tool_calls.len() >= MAX_TOOL_CALLS => return Err(Reject::Invalid),
                    None => turn.tool_calls.push(call),
                }
            }
            Event::Approval(item) => {
                if !item.valid() || turn.approvals.len() >= MAX_APPROVALS {
                    return Err(Reject::Invalid);
                }
                if turn.approvals.iter().any(|a| a.request_id == item.request_id) {
                    return Err(Reject::InvalidTransition);
                }
                turn.approvals.push(item);
            }
            Event::Complete(reason) => {
                turn.state = if reason == FinishReason::Cancelled {
                    TurnState::Cancelled
                } else {
                    TurnState::Completed
                };
                turn.finish = Some(reason);
            }
            Event::Error(error) => {
                turn.state = TurnState::Error;
                turn.error = Some(error);
            }
        }
        turn.seq = seq;
        self.enforce_cache();
        Ok(outcome)
    }

    /// `chat.cancel`: terminal, later deltas are discarded. Returns whether a
    /// running turn was cancelled (never creates a turn).
    pub fn cancel(&mut self, turn_id: &str) -> bool {
        match self.turn_mut(turn_id) {
            Some(turn) if !turn.state.is_terminal() => {
                turn.state = TurnState::Cancelled;
                turn.finish = Some(FinishReason::Cancelled);
                true
            }
            _ => false,
        }
    }

    /// Drop the oldest TERMINAL turns until both bounds hold. The active
    /// turn is never evicted.
    fn enforce_cache(&mut self) {
        while self.turns.len() > CACHE_MAX_TURNS || self.bytes() > CACHE_MAX_BYTES {
            match self.turns.front() {
                Some(front) if front.state.is_terminal() => {
                    self.turns.pop_front();
                    self.evicted += 1;
                }
                _ => break,
            }
        }
    }


    /// Plain-data projection for the WebView (`chat:state`). The page's own
    /// client request ids are not echoed back.
    pub fn view(&self) -> Value {
        let turns: Vec<Value> = self
            .turns
            .iter()
            .map(|t| {
                let mut v = json!({
                    "turn_id": t.turn_id,
                    "request_id": t.request_id,
                    "state": t.state,
                    "seq": t.seq,
                    "user_text": t.user_text,
                    "reply": t.reply,
                    "finish_reason": t.finish,
                    "error": t.error,
                    "trimmed_turns": t.trimmed_turns,
                    "profile_id": t.profile.profile_id,
                    "profile_revision": t.profile.revision,
                    "attachments": t.attachments,
                });
                if !t.tool_calls.is_empty() {
                    v["tool_calls"] = json!(t.tool_calls);
                }
                if !t.approvals.is_empty() {
                    v["approvals"] = json!(t.approvals);
                }
                v
            })
            .collect();
        json!({
            "conversation_id": self.id,
            "active_turn": self.active().map(|t| t.turn_id.clone()),
            "turns": turns,
            "evicted": self.evicted,
        })
    }
}

#[cfg(test)]
#[path = "chat_tests.rs"]
mod tests;

// --- chat_action IPC payload --------------------------------------------------

/// Whole serialized `chat_action` payload cap (8,000 scalars × 4 bytes +
/// JSON overhead). Checked before any field is read.
pub const CHAT_COMMAND_MAX_BYTES: usize = 33 * 1024;

/// The closed set of things the WebView may ask the chat lane. There is no
/// endpoint, model, alias, key or approval field: Rust owns all of those.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Read the current conversation projection.
    View,
    /// Overview → chat view (same island, native window grows to the chat).
    Open,
    /// Chat view → overview (draft stays in page memory).
    Back,
    /// S10 (L35): the page reports the chat height it wants (Coucou's `chatPromptHeight`, which grows with the message count).
    /// The number is untrusted: Rust clamps it to Coucou's 240..300 and to the work area (`Core::plan_chat_height`).
    Height { height: i32 },
    /// Re-read the local model's availability (metadata only, no inference).
    Check,
    New,
    /// S6 (#503): start a conversation with exactly this specialist (`None` = Abito), the same role
    /// switch a restored conversation performs. Only an id travels; instructions and model stay in Rust.
    NewWith { specialist_id: Option<String> },
    List,
    Restore { conversation_id: String },
    History { conversation_id: String, before: Option<u64> },
    Submit {
        text: String,
        client_request_id: String,
        /// #343: attachment ids the page references (metadata already stored
        /// by the attach commands; content is resolved in Rust at submit).
        attachments: Vec<String>,
    },
    Cancel {
        turn_id: String,
    },
    /// K2-05 U4b: answer one of the agent's questions (Gentle Dot `ui_response`). Only the
    /// ask's id and the answer travel; whether the ask is pending, its kind and its shown
    /// options are checked by the chat client against what the daemon sent.
    Answer { ask_id: String, answer: AskAnswer },
    /// K2-05 attachments: the user removed a file before sending it; only the daemon's opaque id
    /// (`a-<16 hex>`) travels, and the daemon deletes the unsent file it issued to this island.
    Discard { id: String },
}

/// K2-05 U4b: one answer to an agent question — exactly one of a select/input `value`, a
/// confirm's `confirmed` boolean, or `cancelled` (skip the question).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskAnswer {
    Value(String),
    Confirmed(bool),
    Cancelled,
}

/// K2-05 U4b: the daemon's bound of an answer `value` (`LIMITS.maxAnswerChars`, UTF-16 units).
pub const ANSWER_MAX_UNITS: usize = 8 * 1024;

/// K2-05 U4b: the daemon's ask-id grammar (`SAFE_ID`: `[A-Za-z0-9_.:-]{1,128}`).
fn valid_ask_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b':' | b'-'))
}

/// K2-05 U4b: an answer value is the user's own text, sent as typed (never rewritten): bounded
/// in UTF-16 units like the daemon, and free of control characters other than tab and newline
/// (the same rule as a draft). Empty is a valid answer.
fn valid_answer_value(v: &str) -> bool {
    v.encode_utf16().count() <= ANSWER_MAX_UNITS
        && !v.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
}

fn valid_turn_id(id: &str) -> bool {
    id.len() <= 24
        && id
            .strip_prefix("t-")
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// S6 (#503): the SHAPE of a specialist id (the specialists store, in the binary crate, owns the
/// full rule and decides whether it exists): 1..=32 of `a-z 0-9 . - _`, not starting with a symbol.
fn specialist_id_shape(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty() && b.len() <= 32 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'-' | b'_'))
}

/// Validate a `chat_action` payload: size cap first, a JSON object, an
/// action in the closed set and EXACTLY that action's keys.
pub fn parse_command(payload: &Value) -> Result<Command, ChatError> {
    let bad = || ChatError::invalid_input("Pedido de chat inválido.");
    if serde_json::to_vec(payload).map_or(true, |b| b.len() > CHAT_COMMAND_MAX_BYTES) {
        return Err(bad());
    }
    let map = payload.as_object().ok_or_else(bad)?;
    let action = map.get("action").and_then(Value::as_str).ok_or_else(bad)?;
    let keys = |expected: &[&str]| {
        map.len() == expected.len() && expected.iter().all(|k| map.contains_key(*k))
    };
    let text_of = |key: &str| map.get(key).and_then(Value::as_str).map(str::to_string);
    match action {
        "view" if keys(&["action"]) => Ok(Command::View),
        "open" if keys(&["action"]) => Ok(Command::Open),
        "back" if keys(&["action"]) => Ok(Command::Back),
        "height" if keys(&["action", "height"]) => {
            let height = map.get("height").and_then(Value::as_i64).and_then(|n| i32::try_from(n).ok()).ok_or_else(bad)?;
            Ok(Command::Height { height })
        }
        "check" if keys(&["action"]) => Ok(Command::Check),
        "new" if keys(&["action"]) => Ok(Command::New),
        "new_with" if keys(&["action", "specialist_id"]) => {
            let specialist_id = match map.get("specialist_id") {
                Some(Value::Null) => None,
                Some(Value::String(id)) if specialist_id_shape(id) => Some(id.clone()),
                _ => return Err(bad()),
            };
            Ok(Command::NewWith { specialist_id })
        }
        "list" if keys(&["action"]) => Ok(Command::List),
        "restore" if keys(&["action", "conversation_id"]) => {
            let conversation_id = text_of("conversation_id").filter(|id| crate::conversations::valid_id(id)).ok_or_else(bad)?;
            Ok(Command::Restore { conversation_id })
        }
        "history" if keys(&["action", "conversation_id", "before"]) => {
            let conversation_id = text_of("conversation_id").filter(|id| crate::conversations::valid_id(id)).ok_or_else(bad)?;
            let before = match map.get("before") {
                Some(Value::Null) => None,
                Some(n) => Some(n.as_u64().filter(|n| *n > 0).ok_or_else(bad)?),
                None => return Err(bad()),
            };
            Ok(Command::History { conversation_id, before })
        }
        "submit" if keys(&["action", "text", "client_request_id"])
            || keys(&["action", "text", "client_request_id", "attachments"]) =>
        {
            let text = text_of("text").ok_or_else(bad)?;
            let client_request_id = text_of("client_request_id")
                .filter(|id| valid_client_request_id(id))
                .ok_or_else(bad)?;
            let attachments = match map.get("attachments") {
                None => Vec::new(),
                Some(Value::Array(items)) => {
                    if items.len() > MAX_ATTACHMENTS_PER_TURN {
                        return Err(bad());
                    }
                    let mut ids: Vec<String> = Vec::with_capacity(items.len());
                    for item in items {
                        let id = item
                            .as_str()
                            .filter(|id| valid_attachment_id(id))
                            .ok_or_else(bad)?;
                        if ids.iter().any(|seen| seen == id) {
                            return Err(bad()); // the same file twice is a mistake, not a feature
                        }
                        ids.push(id.to_string());
                    }
                    ids
                }
                Some(_) => return Err(bad()),
            };
            Ok(Command::Submit {
                text,
                client_request_id,
                attachments,
            })
        }
        "answer" if keys(&["action", "ask_id", "value"]) || keys(&["action", "ask_id", "confirmed"]) || keys(&["action", "ask_id", "cancelled"]) => {
            let ask_id = text_of("ask_id").filter(|id| valid_ask_id(id)).ok_or_else(bad)?;
            let answer = match (map.get("value"), map.get("confirmed"), map.get("cancelled")) {
                (Some(Value::String(v)), None, None) if valid_answer_value(v) => AskAnswer::Value(v.clone()),
                (None, Some(Value::Bool(b)), None) => AskAnswer::Confirmed(*b),
                (None, None, Some(Value::Bool(true))) => AskAnswer::Cancelled,
                _ => return Err(bad()),
            };
            Ok(Command::Answer { ask_id, answer })
        }
        "discard" if keys(&["action", "id"]) => {
            let id = text_of("id").filter(|id| valid_attachment_id(id)).ok_or_else(bad)?;
            Ok(Command::Discard { id })
        }
        "cancel" if keys(&["action", "turn_id"]) => {
            let turn_id = text_of("turn_id")
                .filter(|id| valid_turn_id(id))
                .ok_or_else(bad)?;
            Ok(Command::Cancel { turn_id })
        }
        _ => Err(bad()),
    }
}

//! Pure Pi question round trip (QP.1), separate from the unchanged v1 protocol.
//!
//! All limits apply to JSON BODY bytes, excluding the framing newline. Decode
//! takes an already-framed body. Encoders include one trailing newline. Strings
//! are literal display text, not HTML. Producer text rules apply uniformly:
//! LF/TAB/CR and C1 characters are allowed; other C0 controls and DEL are not.
//! ECMAScript trim is used only for non-emptiness, never to rewrite payloads.
//! Future transport must cap incoming batches at 32768 bytes and 120 frames/min.
//!
//! Transport must opt in after `questions_hello`, keep one global slot, and hold
//! ONE lock across preparation, the originating connection's write, and commit.
//! A definite pre-write failure leaves the slot active. A partial/uncertain write
//! is outcome_unknown: discard the preparation, revoke/disconnect the origin,
//! NEVER retry/replay. Commit proves only "sent", not received or acknowledged.
//! Producer `question_resolved` reports tool consumption; decode returns typed
//! data only, without inventing UI state. No socket, timer, default, permission
//! grant or human attestation lives here.

use crate::protocol::{session_token, token, Identity, CLOCK_SKEW_MS, FRESH_MS};
use serde::{Deserialize, Serialize};
use std::fmt;

pub const FRAME_BYTES: usize = 4096;
pub const QUESTIONS_READY_LINE: &[u8] =
    b"{\"v\":1,\"type\":\"questions_ready\",\"questionVersion\":1}\n";
pub const QUESTIONS_BUSY_REASON_READY_LINE: &[u8] =
    b"{\"v\":1,\"type\":\"questions_ready\",\"questionVersion\":1,\"busyReason\":1}\n";
/// Frame cap on a connection that negotiated `structured:1` (multiSelect, questionnaire, larger limits).
/// A connection that did not keeps [`FRAME_BYTES`] and the original limits, byte for byte.
pub const STRUCTURED_FRAME_BYTES: usize = 16384;
/// Most questions in one questionnaire frame; it occupies ONE queue slot.
pub const MAX_FORM_ITEMS: usize = 4;
/// The `questions_ready` line for the capabilities the receiver grants. Legacy combinations are the
/// exact constants above; key order is `busyReason` then `structured`.
pub fn questions_ready_line(busy_reason: bool, structured: bool) -> Vec<u8> {
    match (busy_reason, structured) {
        (false, false) => QUESTIONS_READY_LINE.to_vec(),
        (true, false) => QUESTIONS_BUSY_REASON_READY_LINE.to_vec(),
        (false, true) => b"{\"v\":1,\"type\":\"questions_ready\",\"questionVersion\":1,\"structured\":1}\n".to_vec(),
        (true, true) => b"{\"v\":1,\"type\":\"questions_ready\",\"questionVersion\":1,\"busyReason\":1,\"structured\":1}\n".to_vec(),
    }
}
/// Text limits by negotiated mode (characters; the frame cap bounds bytes on top of these).
struct Limits { text: usize, label: usize, desc: usize, header: usize, free: usize, frame: usize }
const LEGACY_LIMITS: Limits = Limits { text: 500, label: 60, desc: 160, header: 0, free: 2000, frame: FRAME_BYTES };
const STRUCTURED_LIMITS: Limits = Limits { text: 2000, label: 120, desc: 400, header: 32, free: 4000, frame: STRUCTURED_FRAME_BYTES };
fn limits(structured: bool) -> &'static Limits { if structured { &STRUCTURED_LIMITS } else { &LEGACY_LIMITS } }
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Static codes only: never expose parser diagnostics or private payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    FrameTooLarge,
    InvalidFrame,
    InvalidSchema,
    ScopeMismatch,
    InvalidTimestamp,
    InvalidQuestion,
    InvalidAnswer,
    NotLive,
    Expired,
    GenerationExhausted,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::FrameTooLarge => "frame_too_large",
            Self::InvalidFrame => "invalid_frame",
            Self::InvalidSchema => "invalid_schema",
            Self::ScopeMismatch => "scope_mismatch",
            Self::InvalidTimestamp => "invalid_timestamp",
            Self::InvalidQuestion => "invalid_question",
            Self::InvalidAnswer => "invalid_answer",
            Self::NotLive => "not_live",
            Self::Expired => "expired",
            Self::GenerationExhausted => "generation_exhausted",
        })
    }
}
impl std::error::Error for Error {}

/// `Approval` is an ordinary Pi confirmation, NEVER a backend proposal,
/// tool permission gate or provider-owned consent. It grants no authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind { Question, Approval }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason { Expired, Cancelled }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectionReason { NotLive, InvalidAnswer, ScopeMismatch }
/// Authoritative producer outcome after consuming the tool result, not a
/// receiver write receipt. Correlation to a sent delivery belongs to transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionStatus { Answered, HumanCancelled }

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionOption {
    value: String,
    label: String,
    description: String,
}
impl QuestionOption {
    pub fn value(&self) -> &str { &self.value }
    pub fn label(&self) -> &str { &self.label }
    pub fn description(&self) -> &str { &self.description }
}

#[derive(Clone)]
struct Base { project: String, session_id: String, at: u64 }
#[derive(Clone)]
pub struct Question {
    base: Base,
    id: String,
    kind: Kind,
    text: String,
    options: Vec<QuestionOption>,
    allow_free_text: bool,
    expires_at: u64,
    /// Who is asking (`pi` when the frame carries no `agent`): a short validated slug.
    agent: String,
    /// OPTIONAL display name of the asking session's project (S3); never an identity.
    project_name: Option<String>,
    /// The connection negotiated `structured:1`: larger limits and frame cap apply to this question.
    structured: bool,
    /// The human may pick several options (answer: a list of offered values).
    multi_select: bool,
    /// A questionnaire: 1-4 questions in ONE frame and ONE queue slot; the answer has one entry each.
    form: Option<Vec<Item>>,
}
/// One question of a questionnaire.
#[derive(Clone)]
pub struct Item { header: String, text: String, options: Vec<QuestionOption>, multi_select: bool, allow_free_text: bool }
impl Item {
    pub fn header(&self) -> &str { &self.header }
    pub fn text(&self) -> &str { &self.text }
    pub fn options(&self) -> &[QuestionOption] { &self.options }
    pub fn multi_select(&self) -> bool { self.multi_select }
    pub fn allow_free_text(&self) -> bool { self.allow_free_text }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireItem {
    header: String, text: String, options: Vec<QuestionOption>,
    #[serde(default, rename = "multiSelect")] multi_select: bool,
    #[serde(default, rename = "allowFreeText")] allow_free_text: bool,
}
impl Question {
    pub fn multi_select(&self) -> bool { self.multi_select }
    pub fn form(&self) -> Option<&[Item]> { self.form.as_deref() }
    pub fn structured(&self) -> bool { self.structured }
    /// Longest free-text entry this question accepts, in characters.
    pub fn free_text_max(&self) -> usize { limits(self.structured).free }
    /// The asking session's project name, when the producer sent a valid one.
    pub fn project_name(&self) -> Option<&str> { self.project_name.as_deref() }
    /// The wire identity of the asking agent (`pi` by default).
    pub fn agent(&self) -> &str { &self.agent }
    /// The human-facing name: the four known agents have their proper spelling, any other
    /// slug is shown title-cased. Plain text, derived only from the validated slug.
    pub fn agent_label(&self) -> String { agent_label(&self.agent) }
    pub fn id(&self) -> &str { &self.id }
    pub fn kind(&self) -> Kind { self.kind }
    pub fn text(&self) -> &str { &self.text }
    pub fn options(&self) -> &[QuestionOption] { &self.options }
    pub fn allow_free_text(&self) -> bool { self.allow_free_text }
    pub fn expires_at(&self) -> u64 { self.expires_at }
}
#[derive(Clone)]
pub struct Cancel { base: Base, id: String, reason: CancelReason }
impl Cancel {
    pub fn id(&self) -> &str { &self.id }
    pub fn reason(&self) -> CancelReason { self.reason }
}
#[derive(Clone)]
pub struct AnswerRejected { id: String, reason: RejectionReason }
impl AnswerRejected {
    pub fn id(&self) -> &str { &self.id }
    pub fn reason(&self) -> RejectionReason { self.reason }
}
#[derive(Clone)]
pub struct Resolved { id: String, status: ResolutionStatus }
impl Resolved {
    pub fn id(&self) -> &str { &self.id }
    pub fn status(&self) -> ResolutionStatus { self.status }
}
pub enum Inbound {
    Hello, HelloBusyReason, HelloStructured { busy_reason: bool }, Question(Question), Cancel(Cancel), AnswerRejected(AnswerRejected), Resolved(Resolved),
}

// No flatten/Value intermediate: serde's struct visitor rejects duplicates,
// missing fields, unknown fields and float representations of integer fields.
#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum Wire {
    #[serde(rename = "questions_hello")]
    Hello {
        v: u8, #[serde(rename = "questionVersion")] question_version: u8,
        project: String, #[serde(rename = "sessionId")] session_id: String, at: u64,
        #[serde(default, rename = "busyReason", deserialize_with = "busy_reason_capability")]
        busy_reason: bool,
        /// Capability level 1, exact like `busyReason`: absent or the integer 1.
        #[serde(default, deserialize_with = "busy_reason_capability")]
        structured: bool,
    },
    #[serde(rename = "question")]
    Question {
        v: u8, #[serde(rename = "questionVersion")] question_version: u8,
        project: String, #[serde(rename = "sessionId")] session_id: String, at: u64,
        id: String, kind: Kind, text: String, options: Vec<QuestionOption>,
        #[serde(rename = "allowFreeText")] allow_free_text: bool,
        #[serde(rename = "expiresAt")] expires_at: u64,
        /// OPTIONAL (P1): absent = `pi`. A present value must be a safe slug (see `agent_slug_ok`).
        #[serde(default, deserialize_with = "present_string")] agent: Option<String>,
        /// OPTIONAL (S3): display name of the project, same grammar as `settled` (`project_name_ok`).
        #[serde(default, rename = "projectName", deserialize_with = "present_string")] project_name: Option<String>,
        /// STRUCTURED only: several options may be chosen.
        #[serde(default, rename = "multiSelect", deserialize_with = "present::<_, bool>")] multi_select: Option<bool>,
        /// STRUCTURED only: a questionnaire of 1-4 questions in one frame.
        #[serde(default, deserialize_with = "present::<_, Vec<WireItem>>")] questions: Option<Vec<WireItem>>,
    },
    #[serde(rename = "question_cancel")]
    Cancel {
        v: u8, #[serde(rename = "questionVersion")] question_version: u8,
        project: String, #[serde(rename = "sessionId")] session_id: String, at: u64,
        id: String, reason: CancelReason,
    },
    #[serde(rename = "question_resolved")]
    Resolved {
        v: u8, #[serde(rename = "questionVersion")] question_version: u8,
        project: String, #[serde(rename = "sessionId")] session_id: String, at: u64,
        id: String, status: ResolutionStatus,
    },
    #[serde(rename = "question_answer_rejected")]
    Rejected {
        v: u8, #[serde(rename = "questionVersion")] question_version: u8,
        project: String, #[serde(rename = "sessionId")] session_id: String, at: u64,
        id: String, reason: RejectionReason,
    },
}

// A present value must be a real string: an explicit `null` is NOT "absent" (Option<String> alone
// would accept it as None and silently mean `pi`), so it is refused with the rest of the junk.
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}
fn present_string<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

// Absence is level 1; present MUST be integer 1. Option<u8> would accept null.
fn busy_reason_capability<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    if u8::deserialize(deserializer)? != 1 { return Err(serde::de::Error::custom("invalid capability")); }
    Ok(true)
}

/// A proved v1 identity is required, including for the question opt-in hello.
/// The caller owns the separate per-connection subscription state.
pub fn decode(body: &[u8], identity: &Identity, now: u64) -> Result<Inbound, Error> {
    decode_with(body, identity, now, false)
}
/// [`decode`] for a connection that did (`structured`) or did not negotiate `structured:1`: the frame cap,
/// the text limits and the structured fields all depend on it. `false` is exactly the original decoder.
pub fn decode_with(body: &[u8], identity: &Identity, now: u64, structured: bool) -> Result<Inbound, Error> {
    if body.len() > limits(structured).frame { return Err(Error::FrameTooLarge); }
    let wire: Wire = serde_json::from_slice(body).map_err(|_| Error::InvalidFrame)?;
    let (v, version, base, inbound) = match wire {
        Wire::Hello { v, question_version, project, session_id, at, busy_reason, structured: wants } => {
            (v, question_version, Base { project, session_id, at },
             if wants { Inbound::HelloStructured { busy_reason } }
             else if busy_reason { Inbound::HelloBusyReason } else { Inbound::Hello })
        }
        Wire::Question { v, question_version, project, session_id, at, id, kind, text,
                         options, allow_free_text, expires_at, agent, project_name, multi_select, questions } => {
            if !structured && (multi_select.is_some() || questions.is_some()) { return Err(Error::InvalidSchema); }
            let base = Base { project, session_id, at };
            let agent = match agent {
                None => DEFAULT_AGENT.to_owned(),
                Some(a) if agent_slug_ok(&a) => a,
                Some(_) => return Err(Error::InvalidQuestion),
            };
            if project_name.as_deref().is_some_and(|n| !crate::protocol::project_name_ok(n)) {
                return Err(Error::InvalidQuestion);
            }
            let form = questions.map(|items| items.into_iter().map(|i| Item {
                header: i.header, text: i.text, options: i.options, multi_select: i.multi_select, allow_free_text: i.allow_free_text,
            }).collect());
            let question = Question { base: base.clone(), id, kind, text, options, allow_free_text, expires_at, agent, project_name,
                structured, multi_select: multi_select.unwrap_or(false), form };
            validate_question(&question, now)?;
            (v, question_version, base, Inbound::Question(question))
        }
        Wire::Cancel { v, question_version, project, session_id, at, id, reason } => {
            validate_id(&id)?;
            let base = Base { project, session_id, at };
            let cancel = Cancel { base: base.clone(), id, reason };
            (v, question_version, base, Inbound::Cancel(cancel))
        }
        Wire::Resolved { v, question_version, project, session_id, at, id, status } => {
            validate_id(&id)?;
            (v, question_version, Base { project, session_id, at },
             Inbound::Resolved(Resolved { id, status }))
        }
        Wire::Rejected { v, question_version, project, session_id, at, id, reason } => {
            validate_id(&id)?;
            (v, question_version, Base { project, session_id, at },
             Inbound::AnswerRejected(AnswerRejected { id, reason }))
        }
    };
    if v != 1 || version != 1 { return Err(Error::InvalidSchema); }
    validate_base(&base, identity, now)?;
    Ok(inbound)
}

fn safe_epoch(at: u64) -> bool { at > 0 && at <= MAX_SAFE_INTEGER }
fn validate_identity(identity: &Identity) -> Result<(), Error> {
    if identity.project.len() != 64
        || !identity.project.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !session_token(&identity.session_id)
        || identity.at <= 0 || identity.at as u64 > MAX_SAFE_INTEGER {
        return Err(Error::ScopeMismatch);
    }
    Ok(())
}
fn validate_base(base: &Base, identity: &Identity, now: u64) -> Result<(), Error> {
    validate_identity(identity)?;
    if base.project != identity.project || base.session_id != identity.session_id {
        return Err(Error::ScopeMismatch);
    }
    if !safe_epoch(base.at) || base.at > now.saturating_add(CLOCK_SKEW_MS) || base.at < now.saturating_sub(FRESH_MS)
        || base.at < (identity.at as u64).saturating_sub(CLOCK_SKEW_MS) {
        return Err(Error::InvalidTimestamp);
    }
    Ok(())
}
fn validate_now(identity: &Identity, now: u64) -> Result<(), Error> {
    validate_identity(identity)?;
    if !safe_epoch(now) || now.saturating_add(CLOCK_SKEW_MS) < identity.at as u64 { return Err(Error::InvalidTimestamp); }
    Ok(())
}
fn validate_id(id: &str) -> Result<(), Error> {
    let bytes = id.as_bytes();
    if bytes.len() != 36 || bytes[14] != b'4' || !matches!(bytes[19], b'8'|b'9'|b'a'|b'b')
        || !bytes.iter().enumerate().all(|(i, &b)| {
            if matches!(i, 8|13|18|23) { b == b'-' }
            else { b.is_ascii_digit() || (b'a'..=b'f').contains(&b) }
        }) { return Err(Error::InvalidQuestion); }
    Ok(())
}
// JavaScript String.trim differs from Rust trim: JS trims BOM, not U+0085.
fn ecmascript_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn plain(text: &str, max: usize, allow_empty: bool) -> bool {
    text.chars().take(max + 1).count() <= max
        && (allow_empty || !text.trim_matches(ecmascript_whitespace).is_empty())
        && text.chars().all(|c| !matches!(c, '\u{0000}'..='\u{0008}' | '\u{000b}'
            | '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}'))
}
/// The agent a question comes from when the frame names none (every pre-P1 producer).
pub const DEFAULT_AGENT: &str = "pi";
pub const AGENT_MAX: usize = 32;

/// `[a-z0-9][a-z0-9._-]{0,31}`: lowercase ASCII only, no spaces, no control, no markup characters,
/// no path separators. It is shown to the human (in a title) and compared nowhere else, so it is
/// kept narrow instead of trying to escape anything.
pub fn agent_slug_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= AGENT_MAX && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
}

pub fn agent_label(slug: &str) -> String {
    match slug {
        "pi" => "Pi".into(),
        "claude-code" => "Claude Code".into(),
        "codex" => "Codex".into(),
        "opencode" => "OpenCode".into(),
        other => {
            // title-case each word: `gemini-cli` -> `Gemini Cli`
            let mut out = String::new();
            let mut start = true;
            for c in other.chars() {
                if c == '-' || c == '_' {
                    out.push(' ');
                    start = true;
                } else if start {
                    out.extend(c.to_uppercase());
                    start = false;
                } else {
                    out.push(c);
                }
            }
            out
        }
    }
}

fn validate_options(options: &[QuestionOption], l: &Limits) -> Result<(), Error> {
    for (index, option) in options.iter().enumerate() {
        if !token(&option.value) || !plain(&option.label, l.label, false)
            || !plain(&option.description, l.desc, true)
            || options[..index].iter().any(|prior| prior.value == option.value) {
            return Err(Error::InvalidQuestion);
        }
    }
    Ok(())
}
fn validate_question(q: &Question, now: u64) -> Result<(), Error> {
    validate_id(&q.id)?;
    let l = limits(q.structured);
    let duration = q.expires_at.checked_sub(q.base.at).ok_or(Error::InvalidQuestion)?;
    if !safe_epoch(q.expires_at) || !(30_000..=900_000).contains(&duration)
        || !plain(&q.text, l.text, false) {
        return Err(Error::InvalidQuestion);
    }
    if (q.multi_select || q.form.is_some()) && (!q.structured || q.kind != Kind::Question) {
        return Err(Error::InvalidQuestion);
    }
    if let Some(items) = &q.form {
        // The frame's own options/free text/multiSelect are empty: every question lives in its item.
        if !(1..=MAX_FORM_ITEMS).contains(&items.len()) || !q.options.is_empty() || q.allow_free_text || q.multi_select {
            return Err(Error::InvalidQuestion);
        }
        for item in items {
            if !plain(&item.header, l.header, false) || !plain(&item.text, l.text, false)
                || !(2..=4).contains(&item.options.len()) {
                return Err(Error::InvalidQuestion);
            }
            validate_options(&item.options, l)?;
        }
    } else {
        if (q.kind == Kind::Approval && (q.allow_free_text || q.options.len() != 2))
            || (!(2..=4).contains(&q.options.len())
                && !(q.options.is_empty() && q.kind == Kind::Question && q.allow_free_text && !q.multi_select)) {
            return Err(Error::InvalidQuestion);
        }
        validate_options(&q.options, l)?;
    }
    if q.expires_at <= now { return Err(Error::Expired); }
    Ok(())
}

/// UI supplies an index, never a wire token. Rust resolves the original value.
/// Text is retained verbatim; trim is used only to test non-emptiness.
pub enum HumanAnswer {
    Option { index: usize }, Text { text: String },
    /// A multiSelect question: the chosen option indexes (distinct, offered) and, only when free text is allowed, a text.
    Options { indexes: Vec<usize>, text: Option<String> },
    /// A questionnaire: exactly one entry per question, in order. All or nothing.
    Form { answers: Vec<ItemAnswer> },
}
/// The answer to ONE question of a questionnaire.
pub enum ItemAnswer { Option { index: usize }, Options { indexes: Vec<usize>, text: Option<String> }, Text { text: String } }
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ItemOut<'a> {
    Option { value: &'a str },
    Options { values: Vec<&'a str>, #[serde(skip_serializing_if = "Option::is_none")] text: Option<&'a str> },
    Text { text: &'a str },
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Answer<'a> {
    Option { value: &'a str }, Text { text: &'a str },
    Options { values: Vec<&'a str>, #[serde(skip_serializing_if = "Option::is_none")] text: Option<&'a str> },
    Form { answers: Vec<ItemOut<'a>> },
}
/// Validate one answer against one question's shape and render it. `None` = refused. The free-text
/// bound is in characters; the caller's frame cap bounds bytes.
fn item_answer<'a>(options: &'a [QuestionOption], multi: bool, free: bool, free_max: usize, a: &'a ItemAnswer) -> Option<ItemOut<'a>> {
    match a {
        ItemAnswer::Option { index } if !multi => Some(ItemOut::Option { value: &options.get(*index)?.value }),
        ItemAnswer::Text { text } if !multi && free && plain(text, free_max, false) => Some(ItemOut::Text { text }),
        ItemAnswer::Options { indexes, text } if multi => options_out(options, free, free_max, indexes, text.as_deref()),
        _ => None,
    }
}
fn options_out<'a>(options: &'a [QuestionOption], free: bool, free_max: usize, indexes: &[usize], text: Option<&'a str>) -> Option<ItemOut<'a>> {
    let mut sorted = indexes.to_vec();
    sorted.sort_unstable();
    if sorted.windows(2).any(|w| w[0] == w[1]) || sorted.iter().any(|i| *i >= options.len()) { return None; }
    if let Some(t) = text { if !free || !plain(t, free_max, false) { return None; } }
    if sorted.is_empty() && text.is_none() { return None; }
    Some(ItemOut::Options { values: sorted.iter().map(|i| options[*i].value.as_str()).collect(), text })
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Outbound<'a> {
    Answer {
        v: u8, #[serde(rename = "questionVersion")] question_version: u8,
        project: &'a str, #[serde(rename = "sessionId")] session_id: &'a str,
        at: u64, id: &'a str, source: &'static str, answer: Answer<'a>,
    },
    QuestionClosed {
        v: u8, #[serde(rename = "questionVersion")] question_version: u8,
        project: &'a str, #[serde(rename = "sessionId")] session_id: &'a str,
        at: u64, id: &'a str, reason: CloseReason, source: &'static str,
        #[serde(rename = "busyReason", skip_serializing_if = "Option::is_none")]
        busy_reason: Option<BusyReason>,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum CloseReason { Expired, Cancelled, Busy }
fn encode(frame: &Outbound<'_>) -> Result<Vec<u8>, Error> { encode_cap(frame, FRAME_BYTES) }
fn encode_cap(frame: &Outbound<'_>, cap: usize) -> Result<Vec<u8>, Error> {
    let mut body = serde_json::to_vec(frame).map_err(|_| Error::InvalidFrame)?;
    if body.len() > cap { return Err(Error::FrameTooLarge); }
    body.push(b'\n');
    Ok(body)
}
fn closed(identity: &Identity, id: &str, reason: CloseReason, human: bool, now: u64) -> Result<Vec<u8>, Error> {
    closed_with_detail(identity, id, reason, human, now, None)
}
fn closed_with_detail(identity: &Identity, id: &str, reason: CloseReason, human: bool, now: u64, busy_reason: Option<BusyReason>) -> Result<Vec<u8>, Error> {
    validate_now(identity, now)?;
    validate_id(id)?;
    // Only the dedicated human decline path can request human/cancelled.
    if (human && !matches!(reason, CloseReason::Cancelled))
        || (busy_reason.is_some() && (human || !matches!(reason, CloseReason::Busy))) {
        return Err(Error::InvalidSchema);
    }
    encode(&Outbound::QuestionClosed { v: 1, question_version: 1, project: &identity.project,
        session_id: &identity.session_id, at: now, id, reason,
        source: if human { "human" } else { "system" }, busy_reason })
}

/// Admission refusal without retaining the incoming question's display text.
/// Transport also uses this when its bounded unacknowledged receipts are full.
pub fn busy_line(identity: &Identity, id: &str, now: u64) -> Result<Vec<u8>, Error> {
    closed(identity, id, CloseReason::Busy, false, now)
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BusyReason { NativeTransitionBusy, NativeTransitionDegraded }
/// Transport may call only after per-connection level-2 negotiation. A closed
/// enum and dedicated system/busy encoder prohibit reasons on other sources.
pub fn busy_line_with_reason(identity: &Identity, id: &str, now: u64, reason: BusyReason) -> Result<Vec<u8>, Error> {
    closed_with_detail(identity, id, CloseReason::Busy, false, now, Some(reason))
}

pub struct Active { connection_id: u64, identity: Identity, question: Question, generation: u64 }
impl Active {
    pub fn connection_id(&self) -> u64 { self.connection_id }
    pub fn identity(&self) -> &Identity { &self.identity }
    pub fn question(&self) -> &Question { &self.question }
}
pub enum Admission { Accepted, Busy(Vec<u8>) }
/// Opaque, non-Clone delivery ticket. Drop on definite pre-write failure; on
/// uncertain delivery also disconnect/revoke the origin. Never cache for retry.
pub struct PreparedDelivery { connection_id: u64, generation: u64, line: Vec<u8> }
impl PreparedDelivery {
    pub fn connection_id(&self) -> u64 { self.connection_id }
    pub fn line(&self) -> &[u8] { &self.line }
}

/// Most pending questions held at once (S1/S2). Oldest first; the human sees the
/// head only. A question beyond the cap, or a second one from a connection that
/// already has one pending, is answered Busy to ITS origin and never stored.
pub const QUEUE_CAP: usize = 8;

#[derive(Default)]
pub struct QuestionSlot { queue: Vec<Active>, generation: u64 }
impl QuestionSlot {
    pub fn new() -> Self { Self::default() }
    /// The question the human currently sees: the oldest pending one.
    pub fn active(&self) -> Option<&Active> { self.queue.first() }
    /// Every pending question, oldest first (head included).
    pub fn queue(&self) -> impl Iterator<Item = &Active> { self.queue.iter() }
    pub fn len(&self) -> usize { self.queue.len() }
    pub fn is_empty(&self) -> bool { self.queue.is_empty() }
    /// Connections whose pending question has passed its OWN deadline (any position).
    pub fn due(&self, now: u64) -> Vec<u64> {
        self.queue.iter().filter(|a| now >= a.question.expires_at).map(|a| a.connection_id).collect()
    }

    /// Never replaces. Appends behind the older ones; Busy (for the incoming
    /// origin only) when the queue is full or this connection already waits.
    pub fn admit(&mut self, connection_id: u64, identity: &Identity, question: Question, now: u64) -> Result<Admission, Error> {
        validate_base(&question.base, identity, now)?;
        validate_question(&question, now)?;
        if self.queue.len() >= QUEUE_CAP
            || self.queue.iter().any(|a| a.connection_id == connection_id || a.question.id == question.id) {
            return Ok(Admission::Busy(closed(identity, &question.id, CloseReason::Busy, false, now)?));
        }
        self.generation = self.generation.checked_add(1).ok_or(Error::GenerationExhausted)?;
        self.queue.push(Active { connection_id, identity: identity.clone(), question, generation: self.generation });
        Ok(Admission::Accepted)
    }

    fn position(&self, connection_id: u64, id: &str) -> Option<usize> {
        self.queue.iter().position(|a| a.connection_id == connection_id && a.question.id == id)
    }
    /// The human may only act on what is shown: the head.
    fn for_human(&self, connection_id: u64, identity: &Identity, id: &str, now: u64) -> Result<&Active, Error> {
        let active = self.queue.first().filter(|a| a.connection_id == connection_id && a.question.id == id).ok_or(Error::NotLive)?;
        if &active.identity != identity { return Err(Error::ScopeMismatch); }
        validate_now(identity, now)?;
        if now.saturating_add(CLOCK_SKEW_MS) < active.question.base.at { return Err(Error::InvalidTimestamp); }
        if now >= active.question.expires_at { return Err(Error::Expired); }
        Ok(active)
    }
    fn preparation(active: &Active, line: Vec<u8>) -> PreparedDelivery {
        PreparedDelivery { connection_id: active.connection_id, generation: active.generation, line }
    }

    /// Pure validation and serialization: does NOT consume or mutate the slot.
    pub fn prepare_answer(&self, connection_id: u64, identity: &Identity, id: &str, input: HumanAnswer, now: u64) -> Result<PreparedDelivery, Error> {
        let active = self.for_human(connection_id, identity, id, now)?;
        let q = &active.question;
        let l = limits(q.structured);
        let plain_question = !q.multi_select && q.form.is_none();
        let answer = match &input {
            HumanAnswer::Option { index } if plain_question => Answer::Option {
                value: &q.options.get(*index).ok_or(Error::InvalidAnswer)?.value,
            },
            HumanAnswer::Text { text } if plain_question && q.kind == Kind::Question && q.allow_free_text && plain(text, l.free, false) => {
                Answer::Text { text }
            }
            HumanAnswer::Options { indexes, text } if q.multi_select => {
                match options_out(&q.options, q.allow_free_text, l.free, indexes, text.as_deref()).ok_or(Error::InvalidAnswer)? {
                    ItemOut::Options { values, text } => Answer::Options { values, text },
                    _ => return Err(Error::InvalidAnswer),
                }
            }
            HumanAnswer::Form { answers } => {
                let items = q.form.as_deref().ok_or(Error::InvalidAnswer)?;
                if answers.len() != items.len() { return Err(Error::InvalidAnswer); }
                let mut out = Vec::with_capacity(items.len());
                for (item, a) in items.iter().zip(answers) {
                    out.push(item_answer(&item.options, item.multi_select, item.allow_free_text, l.free, a).ok_or(Error::InvalidAnswer)?);
                }
                Answer::Form { answers: out }
            }
            _ => return Err(Error::InvalidAnswer),
        };
        let line = encode_cap(&Outbound::Answer { v: 1, question_version: 1, project: &identity.project,
            session_id: &identity.session_id, at: now, id: &q.id, source: "human", answer }, l.frame)?;
        Ok(Self::preparation(active, line))
    }
    pub fn prepare_decline(&self, connection_id: u64, identity: &Identity, id: &str, now: u64) -> Result<PreparedDelivery, Error> {
        let active = self.for_human(connection_id, identity, id, now)?;
        Ok(Self::preparation(active, closed(identity, id, CloseReason::Cancelled, true, now)?))
    }

    /// Call ONLY after a complete write while holding the same lock used for
    /// preparation. No deadline recheck after writing: the bytes already left.
    /// A generation prevents stale tickets consuming a re-admitted id; only the
    /// ticket's own entry leaves, every other pending question stays.
    pub fn commit_delivery(&mut self, prepared: PreparedDelivery) -> Result<(), Error> {
        let index = self.queue.iter()
            .position(|a| a.connection_id == prepared.connection_id && a.generation == prepared.generation)
            .ok_or(Error::NotLive)?;
        self.queue.remove(index);
        Ok(())
    }

    /// Matching origin + id only (any position); a system expiry produces NO answer.
    pub fn expire(&mut self, connection_id: u64, id: &str, now: u64) -> Result<Option<Vec<u8>>, Error> {
        let Some(index) = self.position(connection_id, id) else { return Ok(None); };
        let active = &self.queue[index];
        if now < active.question.expires_at { return Ok(None); }
        let line = closed(&active.identity, id, CloseReason::Expired, false, now)?;
        self.queue.remove(index);
        Ok(Some(line))
    }
    /// Producer withdrawal is scoped and revalidated, never a human answer.
    pub fn cancel(&mut self, connection_id: u64, identity: &Identity, cancel: &Cancel, now: u64) -> Result<Option<Vec<u8>>, Error> {
        validate_base(&cancel.base, identity, now)?;
        let Some(index) = self.position(connection_id, &cancel.id) else { return Ok(None); };
        let active = &self.queue[index];
        if &active.identity != identity { return Err(Error::ScopeMismatch); }
        if now.saturating_add(CLOCK_SKEW_MS) < active.question.base.at { return Err(Error::InvalidTimestamp); }
        let reason = match cancel.reason { CancelReason::Expired => CloseReason::Expired, CancelReason::Cancelled => CloseReason::Cancelled };
        let line = closed(identity, &cancel.id, reason, false, now)?;
        self.queue.remove(index);
        Ok(Some(line))
    }
    /// A disconnect has no wire reply; remove only that originating connection.
    /// Connection IDs must be unique per connection lifetime, never session IDs.
    pub fn disconnect(&mut self, connection_id: u64) -> bool {
        let before = self.queue.len();
        self.queue.retain(|a| a.connection_id != connection_id);
        self.queue.len() != before
    }
}

// Debug is deliberately opaque even for derived containers and test failures.
macro_rules! redacted_debug {
    ($($ty:ty),+ $(,)?) => { $(impl fmt::Debug for $ty {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(concat!(stringify!($ty), "(<redacted>)")) }
    })+ };
}
redacted_debug!(QuestionOption, Base, Question, Item, ItemAnswer, Cancel, AnswerRejected, Resolved, Inbound,
    HumanAnswer, Active, Admission, PreparedDelivery, QuestionSlot);

#[cfg(test)]
#[path = "question_tests.rs"]
mod tests;

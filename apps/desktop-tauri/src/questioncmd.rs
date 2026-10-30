//! Closed question IPC; no route, wire token, permission or attestation.
use crate::question::{Error, QuestionSlot};
use serde::Serialize;
use serde_json::Value;

pub const MAX_REQUEST_BYTES: usize = 16384;
pub enum Command {
    View, Answer { id: String, index: usize }, Text { id: String, text: String },
    Decline { id: String }, Budget { id: String, text: String },
    /// multiSelect: the chosen option indexes (and optional text when the question allows it).
    AnswerMany { id: String, indexes: Vec<usize>, text: Option<String> },
    /// questionnaire: one entry per question, all together.
    AnswerForm { id: String, answers: Vec<crate::question::ItemAnswer> },
}
fn control_free(text: &str) -> bool {
    !text.chars().any(|c| matches!(c, '\u{0000}'..='\u{0008}' | '\u{000b}' | '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}'))
}
fn index_list(v: &Value) -> Result<Vec<usize>, Error> {
    let list = v.as_array().filter(|a| a.len() <= 4).ok_or(Error::InvalidAnswer)?;
    list.iter().map(|i| i.as_u64().filter(|i| *i <= 3).map(|i| i as usize).ok_or(Error::InvalidAnswer)).collect()
}
fn opt_text(map: &serde_json::Map<String, Value>) -> Result<Option<String>, Error> {
    match map.get("text") {
        None => Ok(None),
        Some(t) => { let t = t.as_str().filter(|t| control_free(t)).ok_or(Error::InvalidAnswer)?; Ok(Some(t.into())) }
    }
}
fn item_answer(v: &Value) -> Result<crate::question::ItemAnswer, Error> {
    use crate::question::ItemAnswer;
    let m = v.as_object().ok_or(Error::InvalidAnswer)?;
    if m.keys().any(|k| !matches!(k.as_str(), "index" | "indexes" | "text")) { return Err(Error::InvalidSchema); }
    match (m.get("index"), m.get("indexes"), m.get("text")) {
        (Some(i), None, None) => Ok(ItemAnswer::Option { index: i.as_u64().filter(|i| *i <= 3).ok_or(Error::InvalidAnswer)? as usize }),
        (None, Some(l), _) => Ok(ItemAnswer::Options { indexes: index_list(l)?, text: opt_text(m)? }),
        (None, None, Some(_)) => Ok(ItemAnswer::Text { text: opt_text(m)?.ok_or(Error::InvalidAnswer)? }),
        _ => Err(Error::InvalidAnswer),
    }
}
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct TextBudget { pub bytes: usize, pub allowed: bool, pub reason: Option<&'static str> }
pub fn parse_command(payload: &Value) -> Result<Command, Error> {
    if serde_json::to_vec(payload).map_err(|_| Error::InvalidSchema)?.len() > MAX_REQUEST_BYTES {
        return Err(Error::FrameTooLarge);
    }
    let map = payload.as_object().ok_or(Error::InvalidSchema)?;
    let action = map.get("action").and_then(Value::as_str).ok_or(Error::InvalidSchema)?;
    if action == "view" && map.len() == 1 { return Ok(Command::View); }
    let keys: &[&str] = match action {
        "answer" => &["action", "id", "index"],
        "text" | "budget" => &["action", "id", "text"],
        "decline" => &["action", "id"],
        "answer_many" => {
            if map.len() > 4 || map.keys().any(|k| !matches!(k.as_str(), "action" | "id" | "indexes" | "text")) || !map.contains_key("indexes") {
                return Err(Error::InvalidSchema);
            }
            let id = valid_id(map.get("id"))?;
            return Ok(Command::AnswerMany { id, indexes: index_list(&map["indexes"])?, text: opt_text(map)? });
        }
        "answer_form" => {
            if map.len() != 3 || !map.contains_key("answers") { return Err(Error::InvalidSchema); }
            let id = valid_id(map.get("id"))?;
            let list = map["answers"].as_array().filter(|a| (1..=crate::question::MAX_FORM_ITEMS).contains(&a.len())).ok_or(Error::InvalidAnswer)?;
            return Ok(Command::AnswerForm { id, answers: list.iter().map(item_answer).collect::<Result<_, _>>()? });
        }
        _ => return Err(Error::InvalidSchema),
    };
    if map.len() != keys.len() || !keys.iter().all(|k| map.contains_key(*k)) {
        return Err(Error::InvalidSchema);
    }
    let id = valid_id(map.get("id"))?;
    Ok(match action {
        "answer" => Command::Answer { id, index: map["index"].as_u64().filter(|i| *i <= 3)
            .ok_or(Error::InvalidAnswer)? as usize },
        "decline" => Command::Decline { id },
        _ => {
            let text = map["text"].as_str().ok_or(Error::InvalidAnswer)?;
            if text.chars().any(|c| matches!(c, '\u{0000}'..='\u{0008}' | '\u{000b}' |
                '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}')) { return Err(Error::InvalidAnswer); }
            if action == "text" { Command::Text { id, text: text.into() } }
            else { Command::Budget { id, text: text.into() } }
        }
    })
}
fn valid_id(v: Option<&Value>) -> Result<String, Error> {
    let id = v.and_then(Value::as_str).ok_or(Error::InvalidSchema)?;
    let b = id.as_bytes();
    if b.len() != 36 || b[14] != b'4' || !matches!(b[19], b'8'|b'9'|b'a'|b'b')
        || !b.iter().enumerate().all(|(i, &c)| if matches!(i, 8|13|18|23) { c == b'-' }
            else { c.is_ascii_digit() || (b'a'..=b'f').contains(&c) }) {
        return Err(Error::InvalidQuestion);
    }
    Ok(id.to_owned())
}
/// R24: a manual fold never settles a question; the compact pill keeps it
/// visible. Host approval/quit guards are separate from question admission.
pub fn collapse_allowed(_expanded: bool, _pending: bool) -> bool { true }
/// Caller holds the admission guard. Keep Core's open-only pointer API intact:
/// validate this explicit toggle gesture through its compact release path,
/// then restore the original view before applying the admitted toggle.
pub fn guarded_release(core: &mut crate::core::Core, io: &dyn crate::core::WindowIo,
    area: crate::geometry::Rect, client: (f64, f64), cancelled: bool, pending: bool,
) -> crate::core::ReleaseOutcome {
    use crate::core::ReleaseOutcome;
    let expanded = core.expanded;
    let chat = core.chat;
    let blocked = !collapse_allowed(expanded, pending);
    core.expanded = false;
    let admitted = core.release(io, area, client, cancelled || blocked);
    core.expanded = expanded;
    core.chat = chat;
    match admitted {
        ReleaseOutcome::Toggle(_) => ReleaseOutcome::Toggle(core.toggle(io, area)),
        ReleaseOutcome::Cancelled => ReleaseOutcome::Cancelled,
    }
}
/// Retained snapshot vocabulary for protocol compatibility. The fixed window
/// has no compact resize transition and the receiver always reports Idle.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeTransition { #[default] Idle, NativeTransitionBusy, NativeTransitionDegraded }
pub fn error_code(error: Error) -> &'static str {
    match error {
        Error::FrameTooLarge => "frame_too_large", Error::InvalidFrame => "invalid_frame",
        Error::InvalidSchema => "invalid_schema", Error::ScopeMismatch => "scope_mismatch",
        Error::InvalidTimestamp => "invalid_timestamp", Error::InvalidQuestion => "invalid_question",
        Error::InvalidAnswer => "invalid_answer", Error::NotLive => "not_live",
        Error::Expired => "expired", Error::GenerationExhausted => "generation_exhausted",
    }
}
/// Read-only: serialize a prospective body and reuse the authoritative answer
/// validator. Preparation is pure; no commit, origin writer or token escapes.
/// Body size is independent of JSON field ordering, and excludes the newline.
pub fn text_budget(slot: &QuestionSlot, id: &str, text: &str, now: u64) -> Result<TextBudget, Error> {
    let active = slot.active().filter(|a| a.question().id() == id).ok_or(Error::NotLive)?;
    let identity = active.identity();
    let validation = slot.prepare_answer(active.connection_id(), identity, id,
        crate::question::HumanAnswer::Text { text: text.into() }, now);
    let reason = match validation {
        Ok(_) => None,
        Err(e @ (Error::InvalidAnswer | Error::FrameTooLarge)) => Some(error_code(e)),
        Err(e) => return Err(e),
    };
    let bytes = serde_json::to_vec(&serde_json::json!({"v":1,"type":"answer","questionVersion":1,
        "project":identity.project,"sessionId":identity.session_id,"at":now,"id":id,
        "source":"human","answer":{"type":"text","text":text}}))
        .map_err(|_| Error::InvalidFrame)?.len();
    Ok(TextBudget { bytes, allowed: reason.is_none(), reason })
}
#[cfg(test)]
#[path = "questioncmd_tests.rs"]
mod tests;

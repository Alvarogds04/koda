//! The island chat contract the page still speaks, pure (no I/O, no window system).
//!
//! K2-05 U5b: the in-memory conversation (`Conversation`, `Turn`, the turn
//! states and the producer `Event`) went with the 0.1 conversation store and the
//! direct Rust chat lane. The island's one continuous chat lives in the daemon
//! engine and reaches the page through `chatclient`/`chathost`; what is left
//! here is what `chat_action` still parses: the closed verb set (including the
//! conversation verbs `chatclient` refuses with `conversations_off`, which still
//! need the id shape), the draft/answer validators and the typed safe errors.

use serde::Serialize;
use serde_json::Value;

/// Draft limit: Unicode scalar values (contract: ≤8,000).
pub const DRAFT_MAX_SCALARS: usize = 8_000;

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

/// K2-05 U5b: the conversation-id shape the page
/// passes back in the `restore`/`history` verbs (`c-` + 3..=79 token bytes). The
/// store is gone; the shape stays because those verbs are still parsed (and then
/// refused with `conversations_off`).
pub fn valid_conversation_id(id: &str) -> bool {
    id.starts_with("c-")
        && (4..=80).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The profile a turn is frozen to (no halfway swap on selection change).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProfileRef {
    pub profile_id: String,
    pub revision: u64,
    pub lane_id: String,
}

/// Attachments accepted on one turn (submit parsing and the page agree).
pub const MAX_ATTACHMENTS_PER_TURN: usize = 5;

/// An attachment id the page may reference: `a-` + 16 lowercase hex chars.
pub fn valid_attachment_id(id: &str) -> bool {
    id.len() == 18
        && id.starts_with("a-")
        && id[2..].bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
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
            let conversation_id = text_of("conversation_id").filter(|id| valid_conversation_id(id)).ok_or_else(bad)?;
            Ok(Command::Restore { conversation_id })
        }
        "history" if keys(&["action", "conversation_id", "before"]) => {
            let conversation_id = text_of("conversation_id").filter(|id| valid_conversation_id(id)).ok_or_else(bad)?;
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

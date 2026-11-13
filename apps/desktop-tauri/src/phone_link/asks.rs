// Adapted from Coucou windows/src-tauri/src/phone_link/hub.rs @71b773f, Copyright (c) 2026 Rhytam Biswas, MIT
// (the phone link files carry that holder; protocol: Coucou docs/ANDROID_LINK.md).
//
// Slice C: approvals and questions (§8, §9), the pure half. Nothing here owns a socket, a phone or an agent: the
// fingerprint is a request's identity (§8.1) and the only thing a `decision` or an `answer` may ever be matched by,
// and the two wire lines are rendered here once, so the hub has nothing to guess and nothing to truncate.
//
// What is deliberately NOT here, because it is the human's decision: where the tool and the command come from (a
// harness frame or the island's text), whether only the queue head or every pending item is offered, and the expiry
// policy. An `Ask` arrives here already built; how it was built is the host's business.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::sha256_hex;

/// §8.1's separator: U+001F, the unit separator. It is what keeps the five fields apart.
const SEP: &str = "\u{1f}";
/// The tool slot of a question: the same fingerprint function, with this in the `tool` field (§8.1).
pub const QUESTION_TOOL: &str = "AskUserQuestion";
/// The phone is shown at most this much of a command (§8.4); the fingerprint always hashes the whole one.
pub const MAX_COMMAND_CHARS: usize = 500;
/// 1 to 4 questions, each with 1 to 8 options (§ question table).
pub const MAX_QUESTIONS: usize = 4;
pub const MAX_OPTIONS: usize = 8;
/// A rendered ask line stays far under §4's 64 KiB line limit; a question that would not is never offered, whole.
pub const MAX_LINE_BYTES: usize = 32 * 1024;

/// §8.1: lowercase hex SHA-256 of the five fields joined by U+001F, in this order. Both sides must derive it
/// identically or a decision resolves nothing, so this function is the only place that may spell it out.
pub fn fingerprint(pill_id: &str, session_id: &str, tool: &str, command: &str, input_key: &str) -> String {
    sha256_hex([pill_id, session_id, tool, command, input_key].join(SEP).as_bytes())
}

/// Exactly 64 lowercase hex characters (§8.1). Uppercase is refused too, as the phone refuses it.
pub fn is_fingerprint(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// One question the agent asked, in the agent's own words (§9.1). Field order is the identity: the fingerprint is
/// computed over this serialization, exactly as the reference desktop hashes `JSON.stringify(questions)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// The exact wording; non-blank.
    pub question: String,
    /// Absent means `false` (§ question table).
    #[serde(default)]
    pub multi_select: bool,
    pub options: Vec<Choice>,
}

/// One option of a question: the label is what a pick must match exactly, the description may be empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Choice {
    pub label: String,
    #[serde(default)]
    pub description: String,
}

/// The questions exactly as `tools/dev-desktop.mjs` builds them: every key present, in this order (`question`,
/// `multiSelect`, `options`, `label`, `description`). This text is what the fingerprint hashes, so it is canonical
/// here rather than dependent on how the agent happened to spell its own JSON.
pub fn questions_json(questions: &[Question]) -> String {
    // A plain struct of strings and bools cannot fail to serialize; anything else is a programming error.
    serde_json::to_string(questions).expect("a question is plain JSON")
}

/// A request waiting for the user: an approval (§8) or a question (§9). The fingerprint is the key the whole phone
/// protocol matches on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ask {
    Approval {
        pill_id: String,
        fingerprint: String,
        /// The tool the agent wants to use, as the agent names it (`"Bash"`, `"Write"`…).
        tool: String,
        /// The **full** command or one-line summary; the wire text is cut, the fingerprint is not.
        command: String,
        created_at: u64,
        /// D12: the request was built from a card the island could not show whole, so the phone must never offer
        /// Allow for it. The line is then sent with `truncated: true` (§8.4) and the phone shows only Denegar.
        truncated: bool,
    },
    Question {
        pill_id: String,
        fingerprint: String,
        created_at: u64,
        questions: Vec<Question>,
    },
}

impl Ask {
    /// An approval, its fingerprint derived from the full command (§8.1).
    pub fn approval(pill_id: &str, session_id: &str, tool: &str, command: &str, input_key: &str, created_at: u64) -> Ask {
        Ask::Approval {
            pill_id: pill_id.to_string(),
            fingerprint: fingerprint(pill_id, session_id, tool, command, input_key),
            tool: tool.to_string(),
            command: command.to_string(),
            created_at,
            truncated: false,
        }
    }

    /// D12: this request came from a card the island could not show whole. The phone is told so with `truncated`
    /// (`ApprovalSheetPlan.canAllowHere = !truncated`), which leaves Denegar as the only tap — the same rule the
    /// island's own lossy card applies (`hook-common.cjs` never offers `allow` there).
    pub fn lossy(self) -> Ask {
        match self {
            Ask::Approval { pill_id, fingerprint, tool, command, created_at, .. } =>
                Ask::Approval { pill_id, fingerprint, tool, command, created_at, truncated: true },
            // A question is never lossy: it is shown to the phone exactly as the agent asked it.
            other => other,
        }
    }

    /// A question, or `None` when it breaks the contract's limits: an invalid question is never offered (§9.1).
    pub fn question(pill_id: &str, session_id: &str, questions: Vec<Question>, input_key: &str, created_at: u64) -> Option<Ask> {
        if !valid_questions(&questions) {
            return None;
        }
        let json = questions_json(&questions);
        Some(Ask::Question {
            pill_id: pill_id.to_string(),
            fingerprint: fingerprint(pill_id, session_id, QUESTION_TOOL, &json, input_key),
            created_at,
            questions,
        })
    }

    pub fn fingerprint(&self) -> &str {
        match self {
            Ask::Approval { fingerprint, .. } | Ask::Question { fingerprint, .. } => fingerprint,
        }
    }

    pub fn pill_id(&self) -> &str {
        match self {
            Ask::Approval { pill_id, .. } | Ask::Question { pill_id, .. } => pill_id,
        }
    }

    /// Epoch milliseconds the request was made; the phone shows it, never expires by it (§8.2).
    pub fn created_at(&self) -> u64 {
        match self {
            Ask::Approval { created_at, .. } | Ask::Question { created_at, .. } => *created_at,
        }
    }

    pub fn is_approval(&self) -> bool {
        matches!(self, Ask::Approval { .. })
    }

    /// The questions of a question, for validating `picks` (§9.2); `None` for an approval.
    pub fn questions(&self) -> Option<&[Question]> {
        match self {
            Ask::Question { questions, .. } => Some(questions),
            Ask::Approval { .. } => None,
        }
    }

    /// The session state this request puts its pill in (§7.2): the sheet and the island must agree (§6).
    pub fn state(&self) -> &'static str {
        if self.is_approval() {
            "approval"
        } else {
            "question"
        }
    }

    /// The line to write, or `None` when this ask may never reach a phone (a broken question).
    pub fn line(&self) -> Option<String> {
        match self {
            Ask::Approval { .. } => Some(self.approval_line()),
            Ask::Question { .. } => self.question_line(),
        }
    }

    /// `approval` (§6): the command is cut to 500 characters on a character boundary, and flagged only when it was
    /// cut (§8.4). The fingerprint is untouched: it was computed over the whole command.
    pub fn approval_line(&self) -> String {
        let Ask::Approval { pill_id, fingerprint, tool, command, created_at, truncated } = self else { return String::new() };
        let shown = clip(command, MAX_COMMAND_CHARS);
        let mut line = json!({
            "type": "approval",
            "pillId": pill_id,
            "fingerprint": fingerprint,
            "tool": tool,
            "command": shown,
            "createdAt": created_at,
        });
        if *truncated || shown.chars().count() < command.chars().count() {
            line["truncated"] = json!(true);
        }
        line.to_string()
    }

    /// `question` (§6): `None` when the questions broke the limits on arrival or the line would be too long.
    pub fn question_line(&self) -> Option<String> {
        let Ask::Question { pill_id, fingerprint, created_at, questions, .. } = self else { return None };
        if !valid_questions(questions) {
            return None;
        }
        let line = json!({
            "type": "question",
            "pillId": pill_id,
            "fingerprint": fingerprint,
            "createdAt": created_at,
            "questions": serde_json::to_value(questions).ok()?,
        })
        .to_string();
        (line.len() <= MAX_LINE_BYTES).then_some(line)
    }
}

/// The § question table's limits: 1 to 4 questions, each non-blank, with 1 to 8 options whose labels are non-blank
/// and all different within that question.
pub fn valid_questions(questions: &[Question]) -> bool {
    !questions.is_empty() && questions.len() <= MAX_QUESTIONS && questions.iter().all(valid_question)
}

fn valid_question(q: &Question) -> bool {
    if q.question.trim().is_empty() || q.options.is_empty() || q.options.len() > MAX_OPTIONS {
        return false;
    }
    let labels: Vec<&str> = q.options.iter().map(|o| o.label.as_str()).collect();
    if labels.iter().any(|l| l.trim().is_empty()) {
        return false;
    }
    !labels.iter().enumerate().any(|(i, l)| labels[..i].contains(l))
}

/// §9.2's table, verbatim `tools/dev-desktop.mjs`' `validPicks`: one list per question in order, every list non-empty,
/// no repeated label inside a list, every label one that this question offered (exact equality, no trimming, no case
/// fixes), exactly one label for a single choice and one or more for a multiple choice. The order inside a list is
/// not checked: the phone sends the offered order (§9.3) and the desktop does not reorder or second-guess it.
pub fn valid_picks(questions: &[Question], picks: &[Vec<String>]) -> bool {
    picks.len() == questions.len() && questions.iter().zip(picks).all(|(q, p)| valid_picks_of(q, p))
}

fn valid_picks_of(q: &Question, picks: &[String]) -> bool {
    if picks.is_empty() {
        return false;
    }
    if picks.iter().enumerate().any(|(i, l)| picks[..i].contains(l)) {
        return false;
    }
    if !picks.iter().all(|l| q.options.iter().any(|o| &o.label == l)) {
        return false;
    }
    q.multi_select || picks.len() == 1
}

/// The only two decisions that exist from the phone: there is no “always allow”, no per-tool rule (§6 `decision`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Deny,
}

/// The `decision` message, or `None` when it is not exactly what the contract describes (then it is ignored).
pub fn parse_decision(msg: &Value) -> Option<(String, Verdict)> {
    let fingerprint = msg.get("fingerprint")?.as_str()?;
    if !is_fingerprint(fingerprint) {
        return None;
    }
    let verdict = match msg.get("decision")?.as_str()? {
        "allow" => Verdict::Allow,
        "deny" => Verdict::Deny,
        _ => return None,
    };
    Some((fingerprint.to_string(), verdict))
}

/// The `answer` message's shape (the labels are validated against the pending question, §9.2), or `None`.
pub fn parse_answer(msg: &Value) -> Option<(String, Vec<Vec<String>>)> {
    let fingerprint = msg.get("fingerprint")?.as_str()?;
    if !is_fingerprint(fingerprint) {
        return None;
    }
    let picks = msg
        .get("picks")?
        .as_array()?
        .iter()
        .map(|list| list.as_array()?.iter().map(|l| l.as_str().map(str::to_owned)).collect::<Option<Vec<String>>>())
        .collect::<Option<Vec<Vec<String>>>>()?;
    Some((fingerprint.to_string(), picks))
}

/// The first `max` characters, on a character boundary (`"é"` is one character, two bytes).
fn clip(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

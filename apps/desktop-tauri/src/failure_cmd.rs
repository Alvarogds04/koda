//! #503 «reportar fallos» T2 (pure half): the closed schema of the one command `failure_action`, the failure prefs
//! (switch + «no volver a preguntar») and the choice of which stored failures still deserve a notice.
//! The host (`failurehost.rs`) owns the files, the browser and the clipboard; nothing here touches either.
use crate::failure::{self, Env, FailureRecord, IssueUrl, Stored};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::Path;

#[cfg(all(test, unix))] // the tests exercise unix file modes
#[path = "failure_cmd_tests.rs"]
mod tests;

pub const PREFS_FILE: &str = "failure-prefs.json";
pub const TITLE_MAX: usize = 200;
pub const BODY_MAX: usize = 20_000;
const MUTED_MAX: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// `{action:"view"}` → switch + pending failures.
    View,
    /// `{action:"preview"}` (a manual report) or `{action:"preview",fingerprint}`.
    Preview(Option<String>),
    /// `{action:"send",title,body}`: the human's (possibly edited) text. Opens the browser or copies it.
    Send { title: String, body: String },
    /// `{action:"later",fingerprint}` — «Ahora no» (until the next launch).
    Later(String),
    /// `{action:"never",fingerprint}` — «No volver a preguntar por este fallo».
    Never(String),
    /// `{action:"set_enabled",enabled}`.
    SetEnabled(bool),
}

pub fn valid_fingerprint(s: &str) -> bool { s.len() == 12 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }

fn no_control(s: &str) -> bool { !s.chars().any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\r') }

pub fn parse_command(payload: &Value) -> Option<Command> {
    let o = payload.as_object()?;
    let fp = |o: &serde_json::Map<String, Value>| o.get("fingerprint").and_then(Value::as_str).filter(|f| valid_fingerprint(f)).map(str::to_owned);
    match o.get("action")?.as_str()? {
        "view" if o.len() == 1 => Some(Command::View),
        "preview" if o.len() == 1 => Some(Command::Preview(None)),
        "preview" if o.len() == 2 => Some(Command::Preview(Some(fp(o)?))),
        "later" if o.len() == 2 => Some(Command::Later(fp(o)?)),
        "never" if o.len() == 2 => Some(Command::Never(fp(o)?)),
        "set_enabled" if o.len() == 2 => Some(Command::SetEnabled(o.get("enabled")?.as_bool()?)),
        "send" if o.len() == 3 => {
            let title = o.get("title")?.as_str()?;
            let body = o.get("body")?.as_str()?;
            let ok = !title.trim().is_empty() && title.chars().count() <= TITLE_MAX && !title.contains('\n')
                && !body.trim().is_empty() && body.len() <= BODY_MAX && no_control(title) && no_control(body);
            ok.then(|| Command::Send { title: title.trim().to_owned(), body: body.to_owned() })
        }
        _ => None,
    }
}

/// Persisted choices: the notices switch (default ON) and the failures the human asked never to be asked about again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prefs { pub enabled: bool, pub muted: BTreeSet<String> }
impl Default for Prefs { fn default() -> Self { Prefs { enabled: true, muted: BTreeSet::new() } } }

impl Prefs {
    pub fn load(dir: &Path) -> Prefs {
        let Ok(text) = std::fs::read_to_string(dir.join(PREFS_FILE)) else { return Prefs::default() };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { return Prefs::default() };
        Prefs {
            enabled: v.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            muted: v.get("muted").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).filter(|f| valid_fingerprint(f)).take(MUTED_MAX).map(str::to_owned).collect()).unwrap_or_default(),
        }
    }
    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        use std::io::Write;
        #[cfg(unix)]
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)] // Windows: no mode bits; the dir is under the user's profile
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        let path = dir.join(PREFS_FILE);
        let tmp = dir.join(format!(".{PREFS_FILE}.{}", std::process::id()));
        let bytes = serde_json::to_vec(&json!({"enabled": self.enabled, "muted": self.muted})).map_err(std::io::Error::other)?;
        let mut oo = std::fs::OpenOptions::new();
        oo.create(true).truncate(true).write(true);
        #[cfg(unix)]
        oo.mode(0o600);
        let mut f = oo.open(&tmp)?;
        f.write_all(&bytes)?;
        std::fs::rename(&tmp, path)
    }
}

/// Everything the browser or the clipboard will receive. The text the human edited is untrusted input: it is redacted AGAIN here,
/// whatever the page sent, before the URL or the clipboard text exist.
pub struct Outgoing { pub url: IssueUrl, pub clipboard: String }

pub fn outgoing(title: &str, body: &str, home: &str, user: &str) -> Outgoing {
    // the page may have percent-encoded what it sends: decode (bounded) BEFORE redacting so `%2Fhome%2Falvaro` cannot slip through
    let clean = |t: &str| failure::redact(&failure::neutralize_escapes(&failure::percent_decode_bounded(t)), home, user);
    let title = clean(title).split_whitespace().collect::<Vec<_>>().join(" ");
    let body = clean(body);
    Outgoing { url: failure::issue_url(&title, &body), clipboard: format!("{title}\n\n{body}") }
}

/// Failures still worth a notice: switch on, not muted for good, not postponed this launch. Newest first.
pub fn pending(all: &[Stored], prefs: &Prefs, later: &BTreeSet<String>) -> Vec<Stored> {
    if !prefs.enabled { return Vec::new(); }
    let mut out: Vec<Stored> = all.iter()
        .filter(|s| { let fp = failure::fingerprint_of(&s.record); !prefs.muted.contains(&fp) && !later.contains(&fp) })
        .cloned().collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.record.at_secs));
    out
}

/// The record behind a report: the stored one with this fingerprint, or — for a manual report — a neutral one.
pub fn record_for(all: &[Stored], fingerprint: Option<&str>, env: &Env, now: u64) -> Option<FailureRecord> {
    match fingerprint {
        Some(fp) => all.iter().find(|s| failure::fingerprint_of(&s.record) == fp).map(|s| s.record.clone()),
        None => Some(failure::record_failure("island", "manual-report", failure::Reason::Manual, None, None, env, now)),
    }
}

/// «Last log lines»: Abito keeps no log file, so the context is the other failures recorded locally (already redacted).
pub fn context_lines(all: &[Stored], except: &FailureRecord) -> Vec<String> {
    let mut rest: Vec<&Stored> = all.iter().filter(|s| s.record != *except).collect();
    rest.sort_by_key(|s| s.record.at_secs);
    rest.iter().map(|s| format!("[{}/{}] {}", s.record.process, s.record.step, s.record.message.lines().next().unwrap_or(""))).collect()
}

pub fn pending_view(list: &[Stored]) -> Value {
    Value::Array(list.iter().map(|s| json!({
        "fingerprint": failure::fingerprint_of(&s.record), "process": s.record.process, "step": s.record.step,
        "count": s.count, "at": s.record.at_secs,
    })).collect())
}

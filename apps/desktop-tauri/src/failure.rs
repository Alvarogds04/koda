//! #503 «reportar fallos» (option A), core: a LOCAL failure record, a stable fingerprint, the redaction that
//! runs before anything is shown, and the GitHub issue URL the human's browser is sent to.
//!
//! Nothing here touches the network and nothing is sent: the record stays on this machine, the report text is
//! built from it on demand, and the only way out is a URL that the human opens by clicking (UI, T2).
//! Redaction is a pure function (`redact`) with no new crates; it is conservative on purpose — it prefers to
//! hide a harmless word than to leak a key. Conversation content is excluded structurally: a log line that
//! looks like chat/transcript/prompt text is dropped, never redacted.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[cfg(all(test, unix))] // the tests exercise unix file modes
#[path = "failure_tests.rs"]
mod tests;

pub const REPO: &str = "Alvarogds04/abito";
pub const LABELS: &str = "bug,auto-report";
pub const STORE_FILE: &str = "failures.jsonl";
/// Longest URL we hand to the browser; GitHub starts refusing around 8 KB.
pub const MAX_URL_LEN: usize = 6000;
pub const LOG_LINES: usize = 50;
const LOG_LINE_CHARS: usize = 300;
const STORE_MAX_BYTES: u64 = 256 * 1024;
const STORE_KEEP_LINES: usize = 100;
pub const MESSAGE_MAX: usize = 200;
pub const FIELD_MAX: usize = 80;
pub const RECORD_MAX_BYTES: usize = 2048;
const SECRET: &str = "<secret>";

/// One local failure. All text fields are already redacted when a record is created.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailureRecord {
    pub at_secs: u64,
    pub process: String,
    pub step: String,
    pub message: String,
    pub version: String,
    pub os: String,
    pub session: String,
}

/// What the machine looks like, plus the strings redaction has to hide.
#[derive(Clone, Debug)]
pub struct Env {
    pub version: String,
    pub os: String,
    pub session: String,
    pub home: String,
    pub user: String,
}

impl Env {
    pub fn detect() -> Env {
        let os = std::fs::read_to_string("/etc/os-release").ok()
            .and_then(|t| t.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=").map(|v| v.trim_matches('"').to_owned())))
            .unwrap_or_else(|| std::env::consts::OS.to_owned());
        Env {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            os,
            session: std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "unknown".into()),
            home: std::env::var("HOME").unwrap_or_default(),
            user: std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).unwrap_or_default(),
        }
    }
}

// ---------------------------------------------------------------- redaction

const KV_KEYS: [&str; 10] = ["access_token", "refresh_token", "id_token", "client_secret", "authorization", "api_key", "apikey", "password", "passwd", "secret"];
const KV_KEYS_WORD: [&str; 1] = ["token"];
const URL_ONLY_KEYS: [&str; 2] = ["code", "state"];
const STRONG_PREFIXES: [&str; 14] = ["sk-", "sk_live_", "pk_live_", "rk_live_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "aiza", "ya29.", "whsec_"];
const WEAK_PREFIXES: [&str; 3] = ["hf_", "re_", "npm_"];

fn is_alnum(c: char) -> bool { c.is_alphanumeric() }

/// Hide secrets, OAuth codes, e-mails, home paths and the user name. Pure; the same input gives the same output.
pub fn redact(text: &str, home: &str, user: &str) -> String {
    let t = redact_userinfo(text);
    let t = redact_kv(&t);
    let t = redact_bearer(&t);
    let t = redact_emails(&t);
    let t = redact_net(&t);
    let t = redact_tokens(&t);
    let t = redact_home(&t, home);
    redact_user(&t, user)
}

fn redact_userinfo(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(p) = rest.find("://") {
        let (head, tail) = rest.split_at(p + 3);
        out.push_str(head);
        let end = tail.find(|c: char| c == '/' || c.is_whitespace() || c == '?').unwrap_or(tail.len());
        match tail[..end].rfind('@') {
            Some(at) => { out.push_str(SECRET); rest = &tail[at..]; }
            None => rest = tail,
        }
    }
    out.push_str(rest);
    out
}

fn redact_kv(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    let lower: Vec<char> = b.iter().map(|c| c.to_ascii_lowercase()).collect();
    let matches_at = |i: usize, key: &str| -> bool {
        let k: Vec<char> = key.chars().collect();
        i + k.len() <= lower.len() && lower[i..i + k.len()] == k[..]
    };
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        let boundary = i == 0 || !is_alnum(b[i - 1]);
        let url_ctx = i > 0 && matches!(b[i - 1], '?' | '&');
        let key = if !boundary { None } else {
            KV_KEYS.iter().chain(KV_KEYS_WORD.iter()).find(|k| matches_at(i, k)).copied()
                .or_else(|| url_ctx.then(|| URL_ONLY_KEYS.iter().find(|k| matches_at(i, k)).copied()).flatten())
        };
        let Some(key) = key else { out.push(b[i]); i += 1; continue };
        let mut j = i + key.len();
        if j < b.len() && (is_alnum(b[j]) || b[j] == '_') { out.push(b[i]); i += 1; continue; }
        if j < b.len() && matches!(b[j], '"' | '\'') { j += 1; }
        while j < b.len() && b[j] == ' ' { j += 1; }
        if j >= b.len() || !matches!(b[j], '=' | ':') { out.push(b[i]); i += 1; continue; }
        j += 1;
        while j < b.len() && b[j] == ' ' { j += 1; }
        let quote = (j < b.len() && matches!(b[j], '"' | '\'')).then(|| b[j]);
        if quote.is_some() { j += 1; }
        for scheme in ["bearer ", "basic "] {
            if matches_at(j, scheme) { j += scheme.len(); }
        }
        let vs = j;
        let ends = |c: char| match quote { Some(q) => c == q, None => c.is_whitespace() || matches!(c, '&' | '"' | '\'' | ',' | ';' | '}' | ')') };
        while j < b.len() && !ends(b[j]) { j += 1; }
        if j == vs { out.push(b[i]); i += 1; continue; }
        out.extend(&b[i..vs]);
        out.push_str(SECRET);
        i = j;
    }
    out
}

fn redact_bearer(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        let word: String = b[i..].iter().take(7).collect();
        if (i == 0 || !is_alnum(b[i - 1])) && word.eq_ignore_ascii_case("bearer ") {
            let mut j = i + 7;
            let vs = j;
            while j < b.len() && !b[j].is_whitespace() && !matches!(b[j], '"' | '\'' | ',' | ';') { j += 1; }
            if j > vs { out.extend(&b[i..vs]); out.push_str(SECRET); i = j; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

fn redact_emails(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    let local = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-');
    let domain = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-');
    let mut out: Vec<char> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == '@' {
            let mut ls = out.len();
            while ls > 0 && local(out[ls - 1]) { ls -= 1; }
            let mut e = i + 1;
            while e < b.len() && domain(b[e]) { e += 1; }
            while e > i + 1 && b[e - 1] == '.' { e -= 1; }
            let dom: String = b[i + 1..e].iter().collect();
            if ls < out.len() && dom.contains('.') && !dom.starts_with('.') {
                out.truncate(ls);
                out.extend("<email>".chars());
                i = e;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out.into_iter().collect()
}

// ---- network identity: IPs and hostnames

const HOST_SUFFIXES: [&str; 5] = [".ts.net", ".local", ".lan", ".internal", ".home.arpa"];

fn machine_hostname() -> &'static str {
    static HOST: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HOST.get_or_init(|| {
        let h = std::fs::read_to_string("/proc/sys/kernel/hostname").ok()
            .or_else(|| std::env::var("HOSTNAME").ok()).unwrap_or_default().trim().to_owned();
        if h.chars().count() < 3 || h.eq_ignore_ascii_case("localhost") { String::new() } else { h }
    })
}

fn is_ipv4(run: &str) -> bool {
    let parts: Vec<&str> = run.split('.').collect();
    parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u16>().is_ok_and(|n| n <= 255))
}

fn is_ipv6(run: &str) -> bool {
    let colons = run.matches(':').count();
    if colons < 2 || !(run.contains("::") || colons == 7) || run.matches("::").count() > 1 { return false; }
    if !run.chars().any(|c| c.is_ascii_hexdigit()) { return false; }
    let groups: Vec<&str> = run.split(':').collect();
    let last = groups.len() - 1;
    groups.iter().enumerate().all(|(i, g)| g.is_empty() || (g.len() <= 4 && g.bytes().all(|b| b.is_ascii_hexdigit())) || (i == last && is_ipv4(g)))
}

fn redact_net(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        // hostname-ish token: letters, digits, '-', '.'
        if (b[i].is_ascii_alphanumeric()) && (i == 0 || !(word(b[i - 1]) || b[i - 1] == '-' || b[i - 1] == '.')) {
            let mut j = i;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == '-' || b[j] == '.') { j += 1; }
            let mut e = j;
            while e > i && b[e - 1] == '.' { e -= 1; }
            let tok: String = b[i..e].iter().collect();
            let low = tok.to_ascii_lowercase();
            let host = machine_hostname().to_ascii_lowercase();
            let after_ok = e >= b.len() || !word(b[e]);
            if after_ok && (is_ipv4(&tok) || HOST_SUFFIXES.iter().any(|x| low.ends_with(x) && low.len() > x.len())
                || (!host.is_empty() && (low == host || low.starts_with(&format!("{host}.")))) ) {
                out.push_str(if is_ipv4(&tok) { "<ip>" } else { "<host>" });
                i = e;
                continue;
            }
        }
        // hex/colon run: IPv6
        if (b[i].is_ascii_hexdigit() || b[i] == ':') && (i == 0 || !(word(b[i - 1]) || b[i - 1] == ':' || b[i - 1] == '.')) {
            let mut j = i;
            while j < b.len() && (b[j].is_ascii_hexdigit() || b[j] == ':' || b[j] == '.') { j += 1; }
            let mut e = j;
            while e > i && b[e - 1] == '.' { e -= 1; }
            let tok: String = b[i..e].iter().collect();
            if (e >= b.len() || !word(b[e])) && is_ipv6(&tok) {
                out.push_str("<ip>");
                i = e;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

fn entropy(s: &str) -> f64 {
    let mut counts = std::collections::HashMap::new();
    for c in s.chars() { *counts.entry(c).or_insert(0usize) += 1; }
    let n = s.chars().count() as f64;
    -counts.values().map(|&c| { let p = c as f64 / n; p * p.log2() }).sum::<f64>()
}

/// Prefix matching is case-insensitive (`GhP_…` is still a GitHub token to a human who retyped it); `run` is ASCII.
fn looks_secret(run: &str) -> bool {
    let low = run.to_ascii_lowercase();
    for p in STRONG_PREFIXES {
        if let Some(rest) = low.strip_prefix(p) { if rest.len() >= 8 { return true; } }
    }
    for p in WEAK_PREFIXES {
        if let Some(rest) = low.strip_prefix(p) {
            if rest.len() >= 16 && rest.chars().all(|c| c.is_ascii_alphanumeric()) { return true; }
        }
    }
    if let Some(rest) = low.strip_prefix("xox") {
        if rest.len() >= 8 && rest.as_bytes()[1] == b'-' { return true; }
    }
    if low.starts_with("eyj") && low.len() >= 20 { return true; }
    for p in ["akia", "asia"] {
        if let Some(rest) = low.strip_prefix(p) {
            if rest.len() == 16 && rest.chars().all(|c| c.is_ascii_alphanumeric()) { return true; }
        }
    }
    if run.len() >= 32 {
        if run.chars().all(|c| c.is_ascii_hexdigit()) { return true; }
        let has_digit = run.chars().any(|c| c.is_ascii_digit());
        let has_alpha = run.chars().any(|c| c.is_ascii_alphabetic());
        if has_digit && has_alpha && entropy(run) >= 3.5 { return true; }
    }
    false
}

fn redact_tokens(s: &str) -> String {
    let in_run = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+');
    let mut out = String::new();
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.is_empty() { return; }
        let trimmed = run.trim_end_matches('.');
        let tail = &run[trimmed.len()..];
        if looks_secret(trimmed) { out.push_str(SECRET); out.push_str(tail); } else { out.push_str(run); }
        run.clear();
    };
    for c in s.chars() {
        if in_run(c) { run.push(c); } else { flush(&mut run, &mut out); out.push(c); }
    }
    flush(&mut run, &mut out);
    out
}

fn redact_home(s: &str, home: &str) -> String {
    let mut t = s.to_owned();
    if home.len() > 1 { t = replace_at_boundary(&t, home.trim_end_matches('/')); }
    for prefix in ["/home/", "/Users/"] { t = replace_user_dir(&t, prefix); }
    replace_windows_users(&t)
}

/// Replace `home` by `~` only where it is a whole path prefix (followed by a separator, whitespace, a quote or the end),
/// so `/home/a` never eats the start of `/home/ana`.
fn replace_at_boundary(s: &str, home: &str) -> String {
    if home.is_empty() { return s.to_owned(); }
    let mut out = String::new();
    let mut rest = s;
    while let Some(p) = rest.find(home) {
        out.push_str(&rest[..p]);
        let after = &rest[p + home.len()..];
        match after.chars().next() {
            None => out.push('~'),
            Some(c) if matches!(c, '/' | '\\') || c.is_whitespace() || matches!(c, '"' | '\'' | ':' | ',' | ';' | ')' | ']') => out.push('~'),
            Some(_) => out.push_str(home),
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

fn seg_end(rest: &str) -> usize {
    rest.find(|c: char| matches!(c, '/' | '\\') || c.is_whitespace() || matches!(c, '"' | '\'')).unwrap_or(rest.len())
}

fn replace_user_dir(s: &str, prefix: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(p) = rest.find(prefix) {
        out.push_str(&rest[..p]);
        let after = &rest[p + prefix.len()..];
        let e = seg_end(after);
        if e == 0 { out.push_str(prefix); } else { out.push('~'); }
        rest = &after[e..];
    }
    out.push_str(rest);
    out
}

fn replace_windows_users(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < s.len() {
        if i + 9 <= s.len() && b[i].is_ascii_alphabetic() && &b[i + 1..i + 3] == b":\\" && b[i + 3..i + 9].eq_ignore_ascii_case(b"users\\") {
            let after = &s[i + 9..];
            let e = seg_end(after);
            if e > 0 { out.push('~'); i += 9 + e; continue; }
        }
        let Some(ch) = s[i..].chars().next() else { break };
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn redact_user(s: &str, user: &str) -> String {
    if user.chars().count() < 2 { return s.to_owned(); }
    let hay: Vec<char> = s.chars().collect();
    let needle: Vec<char> = user.to_lowercase().chars().collect();
    let low: Vec<char> = hay.iter().map(|c| c.to_lowercase().next().unwrap_or(*c)).collect();
    let mut out = String::new();
    let mut i = 0;
    while i < hay.len() {
        let end = i + needle.len();
        if end <= hay.len() && low[i..end] == needle[..]
            && (i == 0 || !is_alnum(hay[i - 1])) && (end == hay.len() || !is_alnum(hay[end])) {
            out.push_str("<user>");
            i = end;
        } else { out.push(hay[i]); i += 1; }
    }
    out
}

// ---------------------------------------------------------------- log tail

const CONTENT_MARKERS: [&str; 7] = ["transcript", "utterance", "conversation", "prompt", "said", "user:", "assistant"];

/// The last `max` log lines that are safe to show: lines that look like chat content are DROPPED, the rest are redacted and cut.
pub fn safe_log_lines(lines: &[String], home: &str, user: &str, max: usize) -> Vec<String> {
    let kept: Vec<String> = lines.iter()
        .filter(|l| { let low = l.to_lowercase(); !CONTENT_MARKERS.iter().any(|m| low.contains(m)) })
        .map(|l| {
            let r = redact(l, home, user);
            if r.chars().count() > LOG_LINE_CHARS { let mut c: String = r.chars().take(LOG_LINE_CHARS).collect(); c.push('…'); c } else { r }
        })
        .collect();
    let skip = kept.len().saturating_sub(max);
    kept[skip..].to_vec()
}

// ---------------------------------------------------------------- closed fields

/// The components and steps Abito's own code reports. Anything else — a typo, a user name, free text — becomes `unknown`.
pub const PROCESSES: [&str; 3] = ["island", "daemon", "voice"];
pub const STEPS: [&str; 8] = ["panic", "daemon-start", "daemon-exited", "agent-refused", "agent-no-answer", "agent-lost", "model-load-failed", "manual-report"];

fn on_list(t: &str, list: &[&str]) -> bool { list.contains(&t) || t == "unknown" }
fn closed_process(t: &str) -> String { if on_list(t, &PROCESSES) { t.to_owned() } else { "unknown".to_owned() } }
fn closed_step(t: &str) -> String { if on_list(t, &STEPS) { t.to_owned() } else { "unknown".to_owned() } }

// ---- the record's message is STRUCTURAL: a closed reason + optional numbers + optional source location. No caller text.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelError { MissingFile, Checksum, Decode, Other }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanicKind { IndexOutOfBounds, Arithmetic, Explicit, Assertion, Borrow, CapacityOverflow, UnwrapNone, UnwrapErr, Poisoned, Other }

/// Every failure Abito can record. Adding one means adding a fixed label here; there is no way to attach text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    DaemonStartFailed, DaemonExited, AgentNoAnswer, AgentRefused, AgentLost,
    ModelLoadFailed(ModelError), Panic(PanicKind), Manual,
}

impl Reason {
    pub fn label(self) -> &'static str {
        match self {
            Reason::DaemonStartFailed => "daemon did not start",
            Reason::DaemonExited => "daemon exited by itself",
            Reason::AgentNoAnswer => "agent daemon did not answer",
            Reason::AgentRefused => "agent daemon refused the connection",
            Reason::AgentLost => "agent daemon connection lost",
            Reason::ModelLoadFailed(ModelError::MissingFile) => "voice model failed to load: missing file",
            Reason::ModelLoadFailed(ModelError::Checksum) => "voice model failed to load: checksum",
            Reason::ModelLoadFailed(ModelError::Decode) => "voice model failed to load: decode",
            Reason::ModelLoadFailed(ModelError::Other) => "voice model failed to load: other",
            Reason::Panic(PanicKind::IndexOutOfBounds) => "panic: index out of bounds",
            Reason::Panic(PanicKind::Arithmetic) => "panic: arithmetic overflow",
            Reason::Panic(PanicKind::Explicit) => "panic: explicit panic",
            Reason::Panic(PanicKind::Assertion) => "panic: assertion failed",
            Reason::Panic(PanicKind::Borrow) => "panic: already borrowed",
            Reason::Panic(PanicKind::CapacityOverflow) => "panic: capacity overflow",
            Reason::Panic(PanicKind::UnwrapNone) => "panic: unwrap on a None value",
            Reason::Panic(PanicKind::UnwrapErr) => "panic: unwrap on an Err value",
            Reason::Panic(PanicKind::Poisoned) => "panic: poisoned lock",
            Reason::Panic(PanicKind::Other) => "panic: unspecified",
            Reason::Manual => "manual report",
        }
    }

    pub fn all() -> Vec<Reason> {
        use ModelError::*;
        use PanicKind::*;
        let mut v = vec![Reason::DaemonStartFailed, Reason::DaemonExited, Reason::AgentNoAnswer, Reason::AgentRefused, Reason::AgentLost, Reason::Manual];
        v.extend([MissingFile, Checksum, Decode, ModelError::Other].map(Reason::ModelLoadFailed));
        v.extend([IndexOutOfBounds, Arithmetic, Explicit, Assertion, Borrow, CapacityOverflow, UnwrapNone, UnwrapErr, Poisoned, PanicKind::Other].map(Reason::Panic));
        v
    }
}

/// The panic payload is read ONLY to pick a kind; its text is never kept.
pub fn classify_panic(payload: &str) -> PanicKind {
    if payload.starts_with("index out of bounds") || payload.starts_with("slice index") || payload.starts_with("byte index") { PanicKind::IndexOutOfBounds }
    else if payload.starts_with("attempt to ") { PanicKind::Arithmetic }
    else if payload.starts_with("explicit panic") { PanicKind::Explicit }
    else if payload.starts_with("assertion failed") || payload.starts_with("assertion `") { PanicKind::Assertion }
    else if payload.starts_with("already borrowed") || payload.starts_with("already mutably borrowed") { PanicKind::Borrow }
    else if payload.starts_with("capacity overflow") { PanicKind::CapacityOverflow }
    else if payload.starts_with("called `Option::unwrap()`") { PanicKind::UnwrapNone }
    else if payload.starts_with("called `Result::unwrap()`") { PanicKind::UnwrapErr }
    else if payload.contains("PoisonError") { PanicKind::Poisoned }
    else { PanicKind::Other }
}

/// A crate source path: `^src/[a-z0-9_/]+\.rs$` (no `..`, no empty segment).
fn valid_path(p: &str) -> bool {
    let Some(inner) = p.strip_prefix("src/").and_then(|r| r.strip_suffix(".rs")) else { return false };
    !inner.is_empty() && inner.len() <= 70 && inner.chars().all(|c| matches!(c, 'a'..='z' | '0'..='9' | '_' | '/'))
        && !inner.starts_with('/') && !inner.ends_with('/') && !inner.contains("//")
}

/// `src/…` when the file is inside a `src/` directory; dropped unless it is a plain crate source path.
fn source_location(file: &str, line: u32) -> Option<String> {
    let file = file.replace('\\', "/");
    let rel = &file[file.rfind("src/")?..];
    valid_path(rel).then(|| format!("{rel}:{line}"))
}

/// label [+ " (n)"] [+ " at path:line"] — the only shape a record message can have.
pub fn compose(reason: &Reason, code: Option<i64>, location: Option<(&str, u32)>) -> String {
    let mut m = reason.label().to_owned();
    if let Some(n) = code { m.push_str(&format!(" ({n})")); }
    if let Some((f, l)) = location { if let Some(loc) = source_location(f, l) { m.push_str(&format!(" at {loc}")); } }
    m
}

/// `compose`, then the belt: the final message goes through `redact`; if that changes anything (a user name or a secret-looking
/// word inside the path), the location is dropped rather than shown redacted.
pub fn safe_compose(reason: &Reason, code: Option<i64>, location: Option<(&str, u32)>, env: &Env) -> String {
    let full = compose(reason, code, location);
    if redact(&full, &env.home, &env.user) == full { full } else { compose(reason, code, None) }
}

/// Does `msg` have exactly the shape `compose` produces? Anything else did not come from our code and is never shown.
pub fn valid_message(msg: &str) -> bool {
    if msg.chars().count() > MESSAGE_MAX { return false; }
    Reason::all().iter().any(|r| {
        let Some(mut rest) = msg.strip_prefix(r.label()) else { return false };
        if let Some(r2) = rest.strip_prefix(" (") {
            let Some(end) = r2.find(')') else { return false };
            let n = &r2[..end];
            let digits = n.strip_prefix('-').unwrap_or(n);
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) || n.parse::<i64>().is_err() { return false; }
            rest = &r2[end + 1..];
        }
        if let Some(loc) = rest.strip_prefix(" at ") {
            let Some((path, line)) = loc.rsplit_once(':') else { return false };
            return valid_path(path) && !line.is_empty() && line.bytes().all(|b| b.is_ascii_digit()) && line.parse::<u32>().is_ok();
        }
        rest.is_empty()
    })
}

// ---------------------------------------------------------------- fingerprint

fn normalize(msg: &str) -> String {
    let t = redact(msg, "", "");
    let c: Vec<char> = t.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '0' && i + 1 < c.len() && (c[i + 1] == 'x' || c[i + 1] == 'X') {
            let mut j = i + 2;
            while j < c.len() && c[j].is_ascii_hexdigit() { j += 1; }
            if j > i + 2 { out.push('#'); i = j; continue; }
        }
        if c[i].is_ascii_digit() {
            while i < c.len() && c[i].is_ascii_digit() { i += 1; }
            out.push('#');
        } else { out.push(c[i].to_ascii_lowercase()); i += 1; }
    }
    out
}

/// 12 hex chars that are the same for the same failure on any machine, run or user (paths, numbers and addresses are ignored).
pub fn fingerprint(process: &str, step: &str, message: &str) -> String {
    let digest = Sha256::digest(format!("{process}\0{step}\0{}", normalize(message)).as_bytes());
    digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
}

pub fn fingerprint_of(rec: &FailureRecord) -> String { fingerprint(&rec.process, &rec.step, &rec.message) }

// ---------------------------------------------------------------- report and URLs

pub struct Report { pub title: String, pub body: String }

/// The exact text the human will see (and may edit) before anything is opened. Everything in it is redacted.
pub fn build_report(rec: &FailureRecord, log: &[String], home: &str, user: &str) -> Report {
    let rd = |t: &str| redact(t, home, user);
    let fp = fingerprint_of(rec);
    let msg = if valid_message(&rec.message) { rec.message.clone() } else { "unrecognized record (not shown)".to_owned() };
    let first: String = msg.lines().next().unwrap_or("").chars().take(60).collect();
    let title = format!("[{}] {}: {} ({fp})", rd(&rec.process), rd(&rec.step), first.trim());
    let log_lines = safe_log_lines(log, home, user, LOG_LINES);
    let body = format!(
        "## What happened\n- While: {step}\n- Process: {process}\n- Error: {msg}\n\n## Environment\n- Koda: {version}\n- OS: {os}\n- Session: {session}\n- Fingerprint: `{fp}`\n\n## Last log lines\n```\n{log}\n```\n\n## Details (optional, written by you)\n\n",
        step = rd(&rec.step), process = rd(&rec.process), version = rd(&rec.version), os = rd(&rec.os), session = rd(&rec.session),
        log = log_lines.join("\n"));
    Report { title, body }
}

#[derive(Debug, PartialEq, Eq)]
pub enum IssueUrl { Url(String), TooLong }

fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') { out.push(b as char); } else { out.push_str(&format!("%{b:02X}")); }
    }
    out
}

/// The pre-filled «new issue» URL; `TooLong` when the ENCODED text does not fit (the UI then copies it to the clipboard).
pub fn issue_url(title: &str, body: &str) -> IssueUrl {
    let url = format!("https://github.com/{REPO}/issues/new?title={}&body={}&labels={}", encode(title), encode(body), encode(LABELS));
    if url.len() > MAX_URL_LEN { IssueUrl::TooLong } else { IssueUrl::Url(url) }
}

/// «Search if it already exists»: the repo's issue search for this fingerprint.
pub fn search_url(fingerprint: &str) -> String {
    format!("https://github.com/{REPO}/issues?q={}", encode(&format!("is:issue {fingerprint}")))
}

// ---------------------------------------------------------------- percent-decoding (so %2F cannot hide a path from redaction)

fn hex_val(b: u8) -> Option<u8> { (b as char).to_digit(16).map(|d| d as u8) }

fn percent_decode_once(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && hex_val(b[i + 1]).is_some() && hex_val(b[i + 2]).is_some() {
            out.push(hex_val(b[i + 1]).unwrap_or(0) * 16 + hex_val(b[i + 2]).unwrap_or(0));
            i += 3;
        } else { out.push(b[i]); i += 1; }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// At most 3 passes, stopping as soon as the text is stable; invalid sequences stay as they are.
pub fn percent_decode_bounded(s: &str) -> String {
    let mut cur = s.to_owned();
    for _ in 0..3 {
        let next = percent_decode_once(&cur);
        if next == cur { break; }
        cur = next;
    }
    cur
}

/// After the bounded decode, an escape that is still there means deeper encoding: it is replaced by `%<enc>` so it can never
/// be decoded later (by the browser or GitHub) into something the redaction did not see.
pub fn neutralize_escapes(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && hex_val(b[i + 1]).is_some() && hex_val(b[i + 2]).is_some() {
            out.push_str("%<enc>");
            i += 3;
        } else {
            let ch = s[i..].chars().next().unwrap_or('\u{FFFD}');
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

// ---------------------------------------------------------------- local store

pub fn default_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME").map(PathBuf::from).filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))?;
    Some(base.join("abito-island").join("failures"))
}

pub fn store(dir: &Path, rec: &FailureRecord) -> std::io::Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let line = serde_json::to_string(rec).map_err(std::io::Error::other)?;
    if line.len() > RECORD_MAX_BYTES { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "failure record too large")); }
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)] // Windows: no mode bits; the dir is under the user's profile
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    let path = dir.join(STORE_FILE);
    if std::fs::metadata(&path).map(|m| m.len() > STORE_MAX_BYTES).unwrap_or(false) {
        let keep: Vec<String> = std::fs::read_to_string(&path).unwrap_or_default().lines().map(str::to_owned).collect();
        let tail = keep[keep.len().saturating_sub(STORE_KEEP_LINES)..].join("\n");
        std::fs::write(&path, format!("{tail}\n"))?;
    }
    let mut oo = std::fs::OpenOptions::new();
    oo.create(true).append(true);
    #[cfg(unix)]
    oo.mode(0o600);
    let mut f = oo.open(&path)?;
    #[cfg(unix)]
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?; // an older, looser file is tightened, never trusted
    writeln!(f, "{line}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stored { pub record: FailureRecord, pub count: usize }

/// Stored failures grouped by fingerprint (a repeat is one entry with a count); unreadable lines are skipped.
pub fn load_all(dir: &Path) -> Vec<Stored> {
    let text = std::fs::read_to_string(dir.join(STORE_FILE)).unwrap_or_default();
    let mut out: Vec<(String, Stored)> = Vec::new();
    for rec in text.lines().filter_map(|l| serde_json::from_str::<FailureRecord>(l).ok()).filter(|r| valid_message(&r.message) && on_list(&r.process, &PROCESSES) && on_list(&r.step, &STEPS)) {
        let fp = fingerprint_of(&rec);
        match out.iter_mut().find(|(f, _)| *f == fp) {
            Some((_, s)) => { s.count += 1; if rec.at_secs >= s.record.at_secs { s.record = rec; } }
            None => out.push((fp, Stored { record: rec, count: 1 })),
        }
    }
    out.into_iter().map(|(_, s)| s).collect()
}

// ---------------------------------------------------------------- creation

fn field(v: &str, env: &Env) -> String {
    let r = redact(v.lines().next().unwrap_or(""), &env.home, &env.user);
    if r.chars().count() > FIELD_MAX { let mut c: String = r.chars().take(FIELD_MAX).collect(); c.push('…'); c } else { r }
}

pub fn record_failure(process: &str, step: &str, reason: Reason, code: Option<i64>, location: Option<(&str, u32)>, env: &Env, at_secs: u64) -> FailureRecord {
    FailureRecord {
        at_secs,
        process: closed_process(process),
        step: closed_step(step),
        message: safe_compose(&reason, code, location, env),
        version: field(&env.version, env),
        os: field(&env.os, env),
        session: field(&env.session, env),
    }
}

/// A panic keeps its KIND and file:line; the payload text is dropped (it can carry anything the program was holding).
pub fn record_from_panic(process: &str, payload: &str, location: Option<(&str, u32)>, env: &Env, at_secs: u64) -> FailureRecord {
    record_failure(process, "panic", Reason::Panic(classify_panic(payload)), None, location, env, at_secs)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Record a non-panic failure. Local only; errors are swallowed. There is no free-text parameter on purpose.
pub fn note(dir: &Path, process: &str, step: &str, reason: Reason, code: Option<i64>) {
    let _ = store(dir, &record_failure(process, step, reason, code, None, &Env::detect(), now_secs()));
}

/// `note` into the default store; the one-line hook other modules call at a failure site.
pub fn report(process: &str, step: &str, reason: Reason, code: Option<i64>) {
    if let Some(dir) = default_dir() { note(&dir, process, step, reason, code); }
}

/// Chain a panic hook that records the panic locally and then runs the previous hook. No network, never panics itself.
pub fn install_panic_hook(process: &'static str, dir: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload().downcast_ref::<&str>().map(|s| (*s).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".to_owned());
        let location = info.location().map(|l| (l.file().to_owned(), l.line()));
        let rec = record_from_panic(process, &payload, location.as_ref().map(|(f, l)| (f.as_str(), *l)), &Env::detect(), now_secs());
        let _ = store(&dir, &rec);
        previous(info);
    }));
}

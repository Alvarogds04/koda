// Adapted from Coucou windows/src-tauri/src/phone_link/hub.rs @71b773f, Copyright (c) 2026 Rhytam Biswas, MIT
// (the phone link files carry that holder; protocol: Coucou docs/ANDROID_LINK.md).
//
// What the phone is told. Slice B: the sessions. The hub holds the last list the island's state published and
// every connection subscribes to it; it knows nothing about sockets or Tauri. Approvals and questions (slice C)
// and the rest of the optional capabilities are added to this same hub.
//
// Rules: only what changed is sent; `updatedAt` moves only when a session's content does; at most 16 sessions;
// a phone that cannot keep up (a full queue) is dropped rather than waited for, so nothing here can block the
// agent or the island.
//
// Slice B2 (`details`, §6.0/§7): `steps`, `finalLine`, `project` and `color` reach only a connection whose `hello`
// asked for `details` and whose desktop offers it. The hub therefore keeps TWO rendered lines, the plain v1 one and
// the one with details, and hands each subscriber the line matching its capability set. A change that only touches
// a details field is a change for the details phone and nothing at all for the plain one, which is never resent an
// identical plain line.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::json;
use tokio::sync::mpsc;

use super::server::Out;

pub const MAX_SESSIONS: usize = 16;
const MAX_TEXT_CHARS: usize = 200;
/// The most step labels a session carries (§6).
pub const MAX_STEPS: usize = 20;
const MAX_AGENT_CHARS: usize = 64;
const MAX_PROJECT_CHARS: usize = 64;

/// The states the phone draws, exactly the eleven keys of the phone's `BotState` (§7.2). ONE list: the state
/// vocabulary cannot drift from the contract. Anything else is sent as `idle`.
pub const STATES: [&str; 11] = [
    "idle", "working", "thinking", "searching", "approval", "question", "error", "finished", "ratelimit",
    "sleeping", "dizzy",
];

/// One agent session, as the island's state reports it. Every field here is bounded before it is kept: nothing
/// below reaches a phone in the shape it arrived.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SessionIn {
    pub pill_id: String,
    pub agent: String,
    pub state: String,
    pub status_text: String,
    pub step_index: u32,
    pub step_count: u32,
    /// The recent steps, oldest first (only sent with `details`).
    pub steps: Vec<String>,
    /// The last line of a finished agent (only sent with `details`; blank means absent).
    pub final_line: Option<String>,
    /// The folder the session runs in (only sent with `details`); only its last segment is ever kept.
    pub project: Option<String>,
    /// The agent's colour as `#RRGGBB` (only sent with `details`); anything else is dropped.
    pub color: Option<String>,
}

impl SessionIn {
    fn state_or_idle(state: String) -> String {
        if STATES.contains(&state.as_str()) {
            state
        } else {
            "idle".into()
        }
    }
}

/// A session as the hub keeps it: bounded, cleaned, with the two `updatedAt` stamps described below.
#[derive(Debug, Clone, PartialEq)]
struct Session {
    pill_id: String,
    agent: String,
    state: String,
    status_text: String,
    step_index: u32,
    step_count: u32,
    steps: Vec<String>,
    final_line: Option<String>,
    project: Option<String>,
    color: Option<String>,
    /// `updatedAt` shown to a phone WITHOUT `details`: it moves only when the plain fields change, so a details-only
    /// change never makes a plain phone think the list was updated.
    plain_at: u64,
    /// `updatedAt` shown to a phone WITH `details`: it moves when anything that phone is shown changes.
    detail_at: u64,
}

impl Session {
    fn from_input(s: SessionIn) -> Session {
        Session {
            pill_id: s.pill_id,
            agent: clip(&s.agent, MAX_AGENT_CHARS),
            state: SessionIn::state_or_idle(s.state),
            status_text: text(&s.status_text, MAX_TEXT_CHARS),
            step_index: s.step_index,
            step_count: s.step_count,
            steps: steps_of(s.steps),
            final_line: s.final_line.as_deref().and_then(|l| non_empty(text(l, MAX_TEXT_CHARS))),
            project: s.project.as_deref().and_then(project_name),
            color: s.color.as_deref().and_then(color_of),
            plain_at: 0,
            detail_at: 0,
        }
    }

    /// Everything a phone without `details` is shown (`updatedAt` aside).
    fn plain_key(&self) -> (&str, &str, &str, &str, u32, u32) {
        (&self.pill_id, &self.agent, &self.state, &self.status_text, self.step_index, self.step_count)
    }

    /// Everything a phone with `details` is shown (`updatedAt` aside).
    fn detail_key(&self) -> ((&str, &str, &str, &str, u32, u32), &[String], Option<&str>, Option<&str>, Option<&str>) {
        (self.plain_key(), &self.steps, self.final_line.as_deref(), self.project.as_deref(), self.color.as_deref())
    }

    fn same_plain(&self, other: &Session) -> bool {
        self.plain_key() == other.plain_key()
    }

    fn same_detail(&self, other: &Session) -> bool {
        self.detail_key() == other.detail_key()
    }
}

/// One session on the wire. The four `details` fields are `None` (and so absent from the JSON) for every connection
/// that did not ask for the capability, which is exactly what §6's "the desktop must omit those fields" means.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireSession<'a> {
    pill_id: &'a str,
    agent: &'a str,
    state: &'a str,
    status_text: &'a str,
    step_index: u32,
    step_count: u32,
    updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    steps: Option<&'a [String]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    final_line: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<&'a str>,
}

fn wire(s: &Session, details: bool) -> WireSession<'_> {
    WireSession {
        pill_id: &s.pill_id,
        agent: &s.agent,
        state: &s.state,
        status_text: &s.status_text,
        step_index: s.step_index,
        step_count: s.step_count,
        updated_at: if details { s.detail_at } else { s.plain_at },
        // An empty list is the default `[]`, so it is left out rather than spelled (§6).
        steps: (details && !s.steps.is_empty()).then_some(s.steps.as_slice()),
        final_line: details.then_some(s.final_line.as_deref()).flatten(),
        project: details.then_some(s.project.as_deref()).flatten(),
        color: details.then_some(s.color.as_deref()).flatten(),
    }
}

struct Sub {
    id: u64,
    tx: mpsc::Sender<Out>,
    /// The capability set of this connection: only `details` changes what it is sent today.
    details: bool,
    /// Set when the hub gives up on a phone that cannot keep up, so its connection closes (and the phone
    /// reconnects to a fresh picture) instead of staying open and silently going stale.
    evicted: Arc<AtomicBool>,
}

#[derive(Default)]
struct Inner {
    sessions: Vec<Session>,
    subs: Vec<Sub>,
    next_sub: u64,
    /// The last line rendered for each kind of subscriber, so the same content is never sent twice.
    plain: Option<Arc<str>>,
    detail: Option<Arc<str>>,
}

pub struct Hub {
    inner: Mutex<Inner>,
}

impl Hub {
    pub fn new() -> Arc<Hub> {
        Arc::new(Hub { inner: Mutex::new(Inner::default()) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The island's current sessions. Sends each phone only what changed in the line it is shown.
    pub fn publish_sessions(&self, sessions: Vec<SessionIn>, now: u64) {
        let mut inner = self.lock();
        let mut next: Vec<Session> = sessions
            .into_iter()
            .filter(|s| !s.pill_id.is_empty())
            .take(MAX_SESSIONS)
            .map(Session::from_input)
            .collect();
        // Each stamp moves only when the content that phone can see moved; otherwise it keeps the old one, so
        // "updated 2 min ago" stays honest (§6).
        for s in &mut next {
            match inner.sessions.iter().find(|o| o.pill_id == s.pill_id) {
                Some(old) => {
                    s.plain_at = if s.same_plain(old) { old.plain_at } else { now };
                    s.detail_at = if s.same_detail(old) { old.detail_at } else { now };
                }
                None => {
                    s.plain_at = now;
                    s.detail_at = now;
                }
            }
        }
        inner.sessions = next;
        let plain = sessions_line(&inner.sessions, false);
        let detail = sessions_line(&inner.sessions, true);
        let plain_changed = inner.plain.as_deref() != Some(plain.as_str());
        let detail_changed = inner.detail.as_deref() != Some(detail.as_str());
        if !plain_changed && !detail_changed {
            return;
        }
        if plain_changed {
            inner.plain = Some(plain.into());
        }
        if detail_changed {
            inner.detail = Some(detail.into());
        }
        broadcast(&mut inner, plain_changed, detail_changed);
    }

    /// The v1 `sessions` list as JSON (what a phone without `details` is sent), for tests and diagnostics.
    pub fn sessions_json(&self) -> serde_json::Value {
        self.sessions_json_with(false)
    }

    /// The same list as a phone WITH `details` sees it.
    pub fn sessions_json_with(&self, details: bool) -> serde_json::Value {
        let inner = self.lock();
        serde_json::Value::Array(
            inner.sessions.iter().map(|s| serde_json::to_value(wire(s, details)).unwrap_or_default()).collect(),
        )
    }

    /// Registers an authenticated connection; the first line it gets is the current sessions, rendered for the
    /// capabilities this connection negotiated in its `hello`.
    pub fn subscribe(&self, tx: mpsc::Sender<Out>, _now: u64, details: bool) -> (u64, Arc<AtomicBool>) {
        let mut inner = self.lock();
        let id = inner.next_sub;
        inner.next_sub += 1;
        let line = cached(&mut inner, details);
        let _ = tx.try_send(Out::Line(line));
        let evicted = Arc::new(AtomicBool::new(false));
        inner.subs.push(Sub { id, tx, details, evicted: evicted.clone() });
        (id, evicted)
    }

    pub fn unsubscribe(&self, id: u64) {
        self.lock().subs.retain(|s| s.id != id);
    }

    /// Unpaired or switched off: every connection is told and closed.
    pub fn kick_all(&self, code: &'static str, message: &'static str) {
        let subs = std::mem::take(&mut self.lock().subs);
        for s in subs {
            let _ = s.tx.try_send(Out::Close { code, message });
        }
    }

    pub fn clients(&self) -> usize {
        self.lock().subs.len()
    }
}

fn sessions_line(sessions: &[Session], details: bool) -> String {
    let rows: Vec<WireSession<'_>> = sessions.iter().map(|s| wire(s, details)).collect();
    json!({ "type": "sessions", "sessions": rows }).to_string()
}

/// The current line for one kind of subscriber, rendered once and kept.
fn cached(inner: &mut Inner, details: bool) -> Arc<str> {
    let sessions = &inner.sessions;
    let slot = if details { &mut inner.detail } else { &mut inner.plain };
    slot.get_or_insert_with(|| sessions_line(sessions, details).into()).clone()
}

/// Sends what changed to every subscriber, one line per capability set; a phone that cannot keep up (a full queue)
/// or has gone is dropped, and one whose own line did not change is simply not written to.
fn broadcast(inner: &mut Inner, plain_changed: bool, detail_changed: bool) {
    let (plain, detail) = (inner.plain.clone(), inner.detail.clone());
    inner.subs.retain(|s| {
        let (changed, line) = match (s.details, detail_changed, plain_changed) {
            (true, true, _) => (true, detail.clone()),
            (false, _, true) => (true, plain.clone()),
            _ => (false, None),
        };
        if !changed {
            return true; // nothing this phone can see changed: it is not told
        }
        let kept = line.is_some_and(|line| s.tx.try_send(Out::Line(line)).is_ok());
        if !kept {
            s.evicted.store(true, Ordering::SeqCst);
        }
        kept
    });
}

/// The first `max` characters, on a character boundary.
pub fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

/// One line of user-visible text: no control characters, trimmed, at most `max` characters.
fn text(s: &str, max: usize) -> String {
    clip(s.chars().filter(|c| !c.is_control()).collect::<String>().trim(), max)
}

fn non_empty(s: String) -> Option<String> {
    (!s.is_empty()).then_some(s)
}

/// The recent steps, oldest first: at most 20 of at most 200 characters, blanks dropped.
fn steps_of(steps: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = steps.iter().map(|s| text(s, MAX_TEXT_CHARS)).filter(|s| !s.is_empty()).collect();
    if out.len() > MAX_STEPS {
        out.drain(..out.len() - MAX_STEPS);
    }
    out
}

/// `#RRGGBB` and nothing else (§6): a colour the phone would drop is dropped here instead of drawn wrong.
fn color_of(raw: &str) -> Option<String> {
    let c = raw.trim();
    (c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())).then(|| c.to_ascii_uppercase())
}

/// Only the last segment of a folder path: never a path, never anything that could hold a user name or a drive.
/// `""`, `"/"`, `"."` and `".."` are refused (§6).
pub fn project_name(path: &str) -> Option<String> {
    let last = path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = last.chars().filter(|c| !c.is_control()).collect();
    let clean = clip(clean.trim(), MAX_PROJECT_CHARS);
    (!clean.is_empty() && clean != "." && clean != "..").then_some(clean)
}

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

use super::asks::Ask;
use super::server::Out;

pub const MAX_SESSIONS: usize = 16;
/// The most requests that may wait for the user at once: past this the oldest leaves, with the `approvalResolved` that
/// closes it on the phone (§8.3), so a phone's sheet can never belong to a request the hub silently forgot.
pub const MAX_PENDING_ASKS: usize = 8;
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

/// One session as a phone is shown it. `ask` is the request still waiting for its pill: while there is one the state
/// published is `approval` / `question` (§6: the island and the sheet must agree) and `updatedAt` at least the moment
/// the request arrived, so the row never reads older than the request it is showing.
fn wire<'a>(s: &'a Session, details: bool, ask: Option<&Ask>) -> WireSession<'a> {
    let stamp = if details { s.detail_at } else { s.plain_at };
    WireSession {
        pill_id: &s.pill_id,
        agent: &s.agent,
        state: ask.map_or(s.state.as_str(), |a| a.state()),
        status_text: &s.status_text,
        step_index: s.step_index,
        step_count: s.step_count,
        updated_at: ask.map_or(stamp, |a| stamp.max(a.created_at())),
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
    /// The capability set of this connection: `details` changes the session line it is sent, `answers` whether a
    /// `question` is offered to it at all (§6.0).
    details: bool,
    answers: bool,
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
    /// The requests waiting for the user, oldest first, keyed by fingerprint (§8.1).
    asks: Vec<Ask>,
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
        refresh(&mut inner);
    }

    /// Offers a request to the phones: an approval to every phone (approvals are v1, not a capability), a question
    /// only to a phone that negotiated `answers` (§6.0). Idempotent by fingerprint: the same request offered twice is
    /// one sheet on the phone. The pill's session is published in the `approval` / `question` state while it waits.
    pub fn offer(&self, ask: Ask) {
        let mut inner = self.lock();
        if inner.asks.iter().any(|a| a.fingerprint() == ask.fingerprint()) {
            return;
        }
        let dropped = (inner.asks.len() >= MAX_PENDING_ASKS).then(|| inner.asks.remove(0));
        inner.asks.push(ask.clone());
        refresh(&mut inner);
        if let Some(dropped) = dropped {
            send_resolved(&mut inner, dropped.fingerprint());
        }
        send_ask(&mut inner, &ask);
    }

    /// The request is gone (decided, answered, timed out, or dropped): every phone is told once and it leaves the
    /// book. `None` when it was not pending, and then nothing at all is sent.
    pub fn resolve(&self, fingerprint: &str) -> Option<Ask> {
        let mut inner = self.lock();
        let at = inner.asks.iter().position(|a| a.fingerprint() == fingerprint)?;
        let ask = inner.asks.remove(at);
        refresh(&mut inner);
        send_resolved(&mut inner, fingerprint);
        Some(ask)
    }

    /// What is waiting for the user, oldest first.
    pub fn pending(&self) -> Vec<Ask> {
        self.lock().asks.clone()
    }

    /// The pending ask with this fingerprint, if it is still waiting: the only thing a `decision` or an `answer` may
    /// be matched by (§8.1).
    pub fn pending_ask(&self, fingerprint: &str) -> Option<Ask> {
        self.lock().asks.iter().find(|a| a.fingerprint() == fingerprint).cloned()
    }

    /// The v1 `sessions` list as JSON (what a phone without `details` is sent), for tests and diagnostics.
    pub fn sessions_json(&self) -> serde_json::Value {
        self.sessions_json_with(false)
    }

    /// The same list as a phone WITH `details` sees it.
    pub fn sessions_json_with(&self, details: bool) -> serde_json::Value {
        let inner = self.lock();
        serde_json::Value::Array(
            inner
                .sessions
                .iter()
                .map(|s| serde_json::to_value(wire(s, details, ask_of(&inner.asks, &s.pill_id))).unwrap_or_default())
                .collect(),
        )
    }

    /// Registers an authenticated connection; the first line it gets is the current sessions, rendered for the
    /// capabilities this connection negotiated in its `hello`, and after it whatever is still pending (§5: a link drop
    /// clears the phone's book, so a reconnect is re-offered the same fingerprints).
    pub fn subscribe(&self, tx: mpsc::Sender<Out>, _now: u64, details: bool, answers: bool) -> (u64, Arc<AtomicBool>) {
        let mut inner = self.lock();
        let id = inner.next_sub;
        inner.next_sub += 1;
        let line = cached(&mut inner, details);
        let _ = tx.try_send(Out::Line(line));
        for ask in inner.asks.clone() {
            if answers || ask.is_approval() {
                if let Some(line) = ask.line() {
                    let _ = tx.try_send(Out::Line(line.into()));
                }
            }
        }
        let evicted = Arc::new(AtomicBool::new(false));
        inner.subs.push(Sub { id, tx, details, answers, evicted: evicted.clone() });
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

fn sessions_line(sessions: &[Session], details: bool, asks: &[Ask]) -> String {
    let rows: Vec<WireSession<'_>> = sessions.iter().map(|s| wire(s, details, ask_of(asks, &s.pill_id))).collect();
    json!({ "type": "sessions", "sessions": rows }).to_string()
}

/// The ask that decides a pill's published state: the newest one still pending, so a row shows the request the agent
/// is waiting on right now (a pill with a question and an approval pending shows the later of the two).
fn ask_of<'a>(asks: &'a [Ask], pill_id: &str) -> Option<&'a Ask> {
    asks.iter().rev().find(|a| a.pill_id() == pill_id)
}

/// The current line for one kind of subscriber, rendered once and kept.
fn cached(inner: &mut Inner, details: bool) -> Arc<str> {
    let (sessions, asks) = (&inner.sessions, &inner.asks);
    let slot = if details { &mut inner.detail } else { &mut inner.plain };
    slot.get_or_insert_with(|| sessions_line(sessions, details, asks).into()).clone()
}

/// Re-renders both session lines from what the hub holds now (source sessions plus pending asks) and sends only what
/// really changed, so a details-only change still never resends a plain phone an identical line.
fn refresh(inner: &mut Inner) {
    let plain = sessions_line(&inner.sessions, false, &inner.asks);
    let detail = sessions_line(&inner.sessions, true, &inner.asks);
    let plain_changed = inner.plain.as_deref() != Some(plain.as_str());
    let detail_changed = inner.detail.as_deref() != Some(detail.as_str());
    if plain_changed {
        inner.plain = Some(plain.into());
    }
    if detail_changed {
        inner.detail = Some(detail.into());
    }
    if plain_changed || detail_changed {
        broadcast(inner, plain_changed, detail_changed);
    }
}

/// `approvalResolved` for one fingerprint, to everyone: the request is gone as far as the phone is concerned (§8.3).
fn send_resolved(inner: &mut Inner, fingerprint: &str) {
    let line: Arc<str> = json!({ "type": "approvalResolved", "fingerprint": fingerprint }).to_string().into();
    keep(inner, line, |_| true);
}

/// The `approval` / `question` line to the phones that accept it.
fn send_ask(inner: &mut Inner, ask: &Ask) {
    let Some(line) = ask.line() else { return };
    let line: Arc<str> = line.into();
    let needs_answers = !ask.is_approval();
    keep(inner, line, |sub| !needs_answers || sub.answers);
}

/// Writes one line to the phones `wanted` accepts; one that cannot keep up (a full queue) or has gone is dropped,
/// never waited for.
fn keep(inner: &mut Inner, line: Arc<str>, wanted: impl Fn(&Sub) -> bool) {
    inner.subs.retain(|s| {
        if !wanted(s) {
            return true;
        }
        let kept = s.tx.try_send(Out::Line(line.clone())).is_ok();
        if !kept {
            s.evicted.store(true, Ordering::SeqCst);
        }
        kept
    });
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

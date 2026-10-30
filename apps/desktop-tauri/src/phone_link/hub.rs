// Adapted from Coucou windows/src-tauri/src/phone_link/hub.rs @71b773f, Copyright (c) 2026 Rhytam Biswas, MIT
// (the phone link files carry that holder; protocol: Coucou docs/ANDROID_LINK.md).
//
// What the phone is told. Slice B: the sessions. The hub holds the last list the island's state published and
// every connection subscribes to it; it knows nothing about sockets or Tauri. Approvals and questions (slice C)
// and the optional capabilities (slice D) are added to this same hub.
//
// Rules: only what changed is sent; `updatedAt` moves only when a session's content does; at most 16 sessions;
// a phone that cannot keep up (a full queue) is dropped rather than waited for, so nothing here can block the
// agent or the island.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::json;
use tokio::sync::mpsc;

use super::server::Out;

pub const MAX_SESSIONS: usize = 16;
const MAX_TEXT_CHARS: usize = 200;
const MAX_AGENT_CHARS: usize = 64;
const MAX_PROJECT_CHARS: usize = 64;

/// The states the phone draws; anything else is sent as `idle`.
const STATES: &[&str] = &[
    "idle", "working", "thinking", "searching", "approval", "question", "error", "finished",
    "ratelimit", "sleeping", "dizzy",
];

/// One agent session, as the island's state reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionIn {
    pub pill_id: String,
    pub agent: String,
    pub state: String,
    pub status_text: String,
    pub step_index: u32,
    pub step_count: u32,
    /// The folder the session runs in; only its last segment is ever kept (used by `details`, slice D).
    pub project: Option<String>,
}

impl Default for SessionIn {
    fn default() -> Self {
        Self { pill_id: String::new(), agent: String::new(), state: "idle".into(), status_text: String::new(), step_index: 0, step_count: 0, project: None }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    pill_id: String,
    agent: String,
    state: String,
    status_text: String,
    step_index: u32,
    step_count: u32,
    updated_at: u64,
    #[serde(skip)]
    project: Option<String>,
}

impl Session {
    fn same_content(&self, other: &Session) -> bool {
        Session { updated_at: 0, ..self.clone() } == Session { updated_at: 0, ..other.clone() }
    }
}

struct Sub {
    id: u64,
    tx: mpsc::Sender<Out>,
    /// Set when the hub gives up on a phone that cannot keep up, so its connection closes (and the phone
    /// reconnects to a fresh picture) instead of staying open and silently going stale.
    evicted: Arc<AtomicBool>,
}

#[derive(Default)]
struct Inner {
    sessions: Vec<Session>,
    subs: Vec<Sub>,
    next_sub: u64,
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

    /// The island's current sessions. Sends the phones only what changed.
    pub fn publish_sessions(&self, sessions: Vec<SessionIn>, now: u64) {
        let mut inner = self.lock();
        let next: Vec<Session> = sessions
            .into_iter()
            .filter(|s| !s.pill_id.is_empty())
            .take(MAX_SESSIONS)
            .map(|s| {
                let mut fresh = Session {
                    state: if STATES.contains(&s.state.as_str()) { s.state } else { "idle".into() },
                    pill_id: s.pill_id,
                    agent: clip(&s.agent, MAX_AGENT_CHARS),
                    status_text: clip(&s.status_text.chars().filter(|c| !c.is_control()).collect::<String>(), MAX_TEXT_CHARS),
                    step_index: s.step_index,
                    step_count: s.step_count,
                    updated_at: now,
                    project: s.project.as_deref().and_then(project_name),
                };
                if let Some(old) = inner.sessions.iter().find(|o| o.pill_id == fresh.pill_id) {
                    if old.same_content(&fresh) {
                        fresh.updated_at = old.updated_at;
                    }
                }
                fresh
            })
            .collect();
        if next == inner.sessions {
            return;
        }
        inner.sessions = next;
        let line: Arc<str> = sessions_line(&inner.sessions).into();
        broadcast(&mut inner, line);
    }

    /// The v1 `sessions` list as JSON (what a phone is sent), for tests and diagnostics.
    pub fn sessions_json(&self) -> serde_json::Value {
        serde_json::to_value(&self.lock().sessions).unwrap_or_default()
    }

    /// Registers an authenticated connection; the first line it gets is the current sessions.
    pub fn subscribe(&self, tx: mpsc::Sender<Out>, _now: u64) -> (u64, Arc<AtomicBool>) {
        let mut inner = self.lock();
        let id = inner.next_sub;
        inner.next_sub += 1;
        let _ = tx.try_send(Out::Line(sessions_line(&inner.sessions).into()));
        let evicted = Arc::new(AtomicBool::new(false));
        inner.subs.push(Sub { id, tx, evicted: evicted.clone() });
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

fn sessions_line(sessions: &[Session]) -> String {
    json!({ "type": "sessions", "sessions": sessions }).to_string()
}

/// Sends one line to every subscriber; one that cannot keep up (a full queue) or has gone is dropped.
fn broadcast(inner: &mut Inner, line: Arc<str>) {
    inner.subs.retain(|s| {
        let kept = s.tx.try_send(Out::Line(line.clone())).is_ok();
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

/// Only the last segment of a folder path: never a path, never anything that could hold a user name or a drive.
pub fn project_name(path: &str) -> Option<String> {
    let last = path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = last.chars().filter(|c| !c.is_control()).collect();
    let clean = clip(clean.trim(), MAX_PROJECT_CHARS);
    (!clean.is_empty() && clean != "." && clean != "..").then_some(clean)
}

//! #490 slice B: where the phone's session list comes from. ONE accessor, `ClientState::sessions_view()`, the same
//! Rust-side snapshot the island renders (agent client / daemon state), so what W1 adds to that snapshot (steps,
//! the multi-session pills) flows to the phone by extending this mapping, not by a second source.
//!
//! The island's rows are processes (`{id, kind, cwd, state, origin}`); the phone's sessions are one per agent
//! pill (`pillId` is the key of the hub), so rows of the same agent are folded into one: the busiest speaks for it.
//! An agent with no pill in Abito's catalogue is not invented.
use super::hub::{Hub, SessionIn};
use serde_json::Value;

/// The agent pill an engine `kind` belongs to, and its label.
fn pill_of(kind: &str) -> Option<(&'static str, &'static str)> {
    match kind {
        "claude-code" => Some(("integration_claude", "Claude Code")),
        "codex" => Some(("agent_codex", "Codex")),
        "gemini" => Some(("agent_gemini", "Gemini")),
        "opencode" => Some(("agent_opencode", "OpenCode")),
        _ => None,
    }
}

/// (phone state, how busy: higher wins when an agent has several rows)
fn state_of(engine: &str) -> (&'static str, u8) {
    match engine {
        "running" => ("working", 4),
        "sleeping" => ("sleeping", 3),
        "zombie" => ("dizzy", 2),
        "stopped" => ("finished", 1),
        _ => ("idle", 0),
    }
}

/// The phone's sessions from the closed `{rows, truncated}` view; anything off-shape is an empty list.
pub fn sessions_from_view(view: &Value) -> Vec<SessionIn> {
    let Some(rows) = view.get("rows").and_then(Value::as_array) else { return Vec::new() };
    let mut out: Vec<(SessionIn, u8, usize)> = Vec::new();
    for row in rows {
        let Some((pill, label)) = row.get("kind").and_then(Value::as_str).and_then(pill_of) else { continue };
        let (state, rank) = state_of(row.get("state").and_then(Value::as_str).unwrap_or(""));
        let cwd = row.get("cwd").and_then(Value::as_str).map(str::to_owned);
        match out.iter_mut().find(|(s, _, _)| s.pill_id == pill) {
            Some((s, best, n)) => {
                *n += 1;
                if rank > *best {
                    *best = rank;
                    s.state = state.into();
                    s.project = cwd;
                }
            }
            None => out.push((SessionIn { pill_id: pill.into(), agent: label.into(), state: state.into(), project: cwd, ..SessionIn::default() }, rank, 1)),
        }
    }
    out.into_iter()
        .map(|(mut s, _, n)| {
            if n > 1 {
                s.status_text = format!("{n} sessions");
            }
            s
        })
        .collect()
}

/// Publishes the snapshot to the hub (an empty or missing snapshot clears the phones' list).
pub fn publish(hub: &Hub, view: &Value, now: u64) {
    hub.publish_sessions(sessions_from_view(view), now);
}

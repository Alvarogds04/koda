//! #490 slice B: where the phone's session list comes from. ONE accessor, `ClientState::sessions_view()`, the same
//! Rust-side snapshot the island renders (agent client / daemon state), so what W1 adds to that snapshot (steps,
//! the multi-session pills) flows to the phone by extending this mapping, not by a second source.
//!
//! The island's rows are processes (`{id, kind, cwd, state, origin, tools}`); the phone's sessions are one per agent
//! pill (`pillId` is the key of the hub), so rows of the same agent are folded into one: the busiest speaks for it.
//! An agent with no pill in Abito's catalogue is not invented.
//!
//! Slice B2 (S8): the winning row's closed `tools` view (`agentclient::session_tools_view`) becomes the progress ring
//! (`stepIndex`/`stepCount`) and, behind `details`, the step labels. Only what the view really carries is mapped: the
//! row vocabulary is `running | sleeping | stopped | zombie | unknown`, so `error`, `ratelimit`, `approval` and
//! `question` stay for the slices that really know about them instead of being guessed here.
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

/// The row's engine state, as the island's closed vocabulary spells it.
fn engine_of(row: &Value) -> &str {
    row.get("state").and_then(Value::as_str).unwrap_or("")
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
    // Per pill: its label, how many rows it has, and the busiest row, which is the one that speaks for it.
    let mut folded: Vec<(&'static str, &'static str, usize, &Value)> = Vec::new();
    for row in rows {
        let Some((pill, label)) = row.get("kind").and_then(Value::as_str).and_then(pill_of) else { continue };
        let rank = state_of(engine_of(row)).1;
        match folded.iter_mut().find(|(p, _, _, _)| *p == pill) {
            Some((_, _, n, best)) => {
                *n += 1;
                if rank > state_of(engine_of(best)).1 {
                    *best = row;
                }
            }
            None => folded.push((pill, label, 1, row)),
        }
    }
    folded.into_iter().map(|(pill, label, n, row)| session_of(pill, label, n, row)).collect()
}

fn session_of(pill: &str, label: &str, rows: usize, row: &Value) -> SessionIn {
    let (state, _) = state_of(engine_of(row));
    let tools = row.get("tools");
    let (step_index, step_count) = progress(tools);
    SessionIn {
        pill_id: pill.into(),
        agent: label.into(),
        state: state.into(),
        status_text: status_text(rows, state, tools),
        step_index,
        step_count,
        steps: labels(tools),
        project: row.get("cwd").and_then(Value::as_str).map(str::to_owned),
        // `finalLine` and `color` have no source in this view: the pill colours live in the user's prefs, not in the
        // island's snapshot, so both stay absent rather than invented (see the slice's report).
        ..SessionIn::default()
    }
}

/// `(stepIndex, stepCount)` from the row's `tools` view: the denominator is the total, the numerator is the step it
/// is on. No `tools` at all means no progress claim (both zero, so the phone draws no ring).
fn progress(tools: Option<&Value>) -> (u32, u32) {
    let Some(tools) = tools else { return (0, 0) };
    let count = tools.get("total").and_then(Value::as_u64).unwrap_or(0).min(u32::MAX as u64) as u32;
    let steps = steps_of(tools);
    let Some(last) = steps.last() else { return (0, count) };
    if let Some(running) = steps.iter().rev().find(|s| state(s) == Some("running")) {
        return (index_of(running), count);
    }
    match state(last) {
        // Every step done: the ring is full.
        Some("done") => (count, count),
        // The list ends in an error: the ring stops where it failed instead of claiming progress that is not there.
        _ => (index_of(last), count),
    }
}

/// The step labels, oldest first, at most the 20 the contract allows: `"bash"` becomes `"Bash"`. A label, never the
/// command or its arguments.
fn labels(tools: Option<&Value>) -> Vec<String> {
    let steps = tools.map(steps_of).unwrap_or_default();
    let mut out: Vec<String> = steps.iter().filter_map(|s| s.get("name").and_then(Value::as_str)).map(label).collect();
    if out.len() > super::hub::MAX_STEPS {
        out.drain(..out.len() - super::hub::MAX_STEPS);
    }
    out
}

fn steps_of(tools: &Value) -> &[Value] {
    tools.get("steps").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn state(step: &Value) -> Option<&str> {
    step.get("state").and_then(Value::as_str)
}

fn index_of(step: &Value) -> u32 {
    step.get("index").and_then(Value::as_u64).unwrap_or(0).min(u32::MAX as u64) as u32
}

fn label(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// The one line under the agent name: for an agent with several rows, how many there are; for a single row, what it
/// is running right now when the view really says so, and nothing otherwise.
fn status_text(rows: usize, state: &str, tools: Option<&Value>) -> String {
    if rows > 1 {
        return format!("{rows} sessions");
    }
    if state != "working" {
        return String::new();
    }
    tools
        .map(steps_of)
        .and_then(|steps| steps.iter().rev().find(|s| self::state(s) == Some("running")))
        .and_then(|step| step.get("name").and_then(Value::as_str))
        .map(label)
        .unwrap_or_default()
}

/// Publishes the snapshot to the hub (an empty or missing snapshot clears the phones' list).
pub fn publish(hub: &Hub, view: &Value, now: u64) {
    hub.publish_sessions(sessions_from_view(view), now);
}

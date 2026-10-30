//! #467 T11 — closed `monitor_action` `{action:"list"}`: the displays the island can be
//! pinned to, so Ajustes can offer a picker. Choosing stays `prefs_action`'s
//! `set_monitor` / `clear_monitor`.
//!
//! Adapted from Coucou src-tauri/src/lib.rs (`list_monitors`) @434d6a2b, Copyright (c)
//! 2026 Louis Raillé, MIT. Abito's keys are `workarea::monitor_key` names (the same ones
//! placement resolves), and only keys `prefs` would accept are offered.
use crate::bridge::{BridgeError, RateLimiter};
use crate::workarea::MonitorChoice;
use serde_json::{json, Value};

#[cfg(test)]
#[path = "monitors_tests.rs"]
mod tests;

/// More displays than this is not a real desktop; bound the answer.
pub const MAX_MONITORS: usize = 16;

pub fn parse_monitor(payload: &Value) -> Result<(), BridgeError> {
    let map = payload.as_object().ok_or_else(|| BridgeError::denied("invalid monitor request"))?;
    if map.len() == 1 && map.get("action").and_then(Value::as_str) == Some("list") {
        Ok(())
    } else {
        Err(BridgeError::denied("invalid monitor request"))
    }
}

/// Key + geometry only. Duplicated names keep the first (placement resolves to the first);
/// degenerate geometry and keys `set_monitor` would refuse are not offered.
pub fn choices(monitors: &[MonitorChoice]) -> Value {
    let mut seen: Vec<&str> = Vec::new();
    let mut out = Vec::new();
    for m in monitors {
        if out.len() == MAX_MONITORS
            || seen.contains(&m.key.as_str())
            || m.rect.w <= 0
            || m.rect.h <= 0
            || !crate::prefs::valid_monitor_key(&m.key)
        {
            continue;
        }
        seen.push(&m.key);
        out.push(json!({"key": m.key, "x": m.rect.x, "y": m.rect.y, "width": m.rect.w, "height": m.rect.h}));
    }
    Value::Array(out)
}

/// Sender → payload → rate → read. Reachable from `main` and `settings` (read-only).
pub fn monitor_command<F>(
    label: &str,
    origin: &str,
    payload: &Value,
    rate: &mut RateLimiter,
    now: u128,
    list: F,
) -> Result<Value, BridgeError>
where
    F: FnOnce() -> Value,
{
    crate::bridge::sender_ok(label, origin)?;
    parse_monitor(payload)?;
    rate.check(now)?;
    Ok(json!({ "monitors": list() }))
}

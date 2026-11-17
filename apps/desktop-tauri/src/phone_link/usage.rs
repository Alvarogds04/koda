//! §11 `usage`: how much of the Claude and Codex plans is used, as the phone is sent it.
//!
//! Pure by construction: the numbers come in as the two `Value`s the desktop already reads — Claude's status-line
//! channel (`claude_plan::read`) and Codex's own `account/rateLimits/read` (`codex_plan::read`) — and what leaves is
//! the contract's line. Nothing here touches a file, a process or a socket.
//!
//! Every bound below is one the phone enforces by DROPPING what it does not accept (§11): a window without both
//! fields is dropped, a plan without a single usable window is dropped whole, a reset-credit count outside `0..=99`,
//! a plan name with anything but letters, digits, space and dash, or a stamp before the epoch, are each dropped on
//! their own. Sending the cleaned shape is what makes the pills show something instead of nothing.
use serde_json::{json, Map, Value};

use super::hub::clip;

/// §11: the plan name is cut to this many characters.
const MAX_PLAN_CHARS: usize = 20;
/// §11: Codex's free resets are `0..=99`; anything else is not a count.
const MAX_RESET_CREDITS: i64 = 99;
/// A day or less is Codex's short window (§11's `fiveHour`); anything else — or no duration at all — is the week.
/// The same rule the island's own gauge uses, so the phone and the pill never disagree about which window is which.
const SHORT_WINDOW_MINS: f64 = 24.0 * 60.0;

fn number(v: Option<&Value>) -> Option<f64> {
    v?.as_f64().filter(|n| n.is_finite())
}

/// One window §11 accepts: a whole percent `0..=100` and a reset in epoch milliseconds `> 0`. A percentage that
/// arrives fractional or out of range is made whole and pulled inside the range (as the island's gauge does), never
/// rounded out of it; a missing or impossible reset time is no window at all.
fn window(pct: f64, resets_at_ms: f64) -> Option<Value> {
    if !resets_at_ms.is_finite() || resets_at_ms <= 0.0 {
        return None;
    }
    let resets_at = resets_at_ms.round();
    if resets_at <= 0.0 {
        return None;
    }
    let pct = pct.round().clamp(0.0, 100.0) as i64;
    Some(json!({ "pct": pct, "resetsAt": resets_at as i64 }))
}

/// A window already in the shape `claude_plan::read` produces: `{usedPct, resetsAt}` in milliseconds.
fn window_of(raw: Option<&Value>) -> Option<Value> {
    let w = raw?.as_object()?;
    window(number(w.get("usedPct"))?, number(w.get("resetsAt"))?)
}

/// §11's `updatedAt`: epoch milliseconds, `>= 0`. A stamp from the future is the phone's business; a negative one is
/// not a date, so it is left out rather than sent.
fn stamp(raw: Option<&Value>) -> Option<i64> {
    let at = number(raw)?.round();
    (at.is_finite() && at >= 0.0).then_some(at as i64)
}

/// §11's `plan`: letters, digits, space and dash only, cut to 20 characters, blank dropped.
fn plan_name(raw: Option<&Value>) -> Option<Value> {
    let text: String = raw?
        .as_str()?
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == ' ' || *c == '-')
        .collect();
    let cut = clip(text.trim(), MAX_PLAN_CHARS);
    (!cut.is_empty()).then(|| json!(cut))
}

/// The Claude plan, or `None` when neither window can be described.
fn claude_plan(view: &Value) -> Option<Value> {
    let five = window_of(view.get("fiveHour"));
    let seven = window_of(view.get("sevenDay"));
    if five.is_none() && seven.is_none() {
        return None;
    }
    let mut plan = Map::new();
    if let Some(w) = five {
        plan.insert("fiveHour".into(), w);
    }
    if let Some(w) = seven {
        plan.insert("sevenDay".into(), w);
    }
    if let Some(at) = stamp(view.get("updatedAt")) {
        plan.insert("updatedAt".into(), json!(at));
    }
    Some(Value::Object(plan))
}

/// The Codex plan out of `{rateLimits, rateLimitResetCredits}` (what `codex_plan::limits_only` keeps), or `None`
/// when neither window can be described. Codex answers `resetsAt` in SECONDS; the wire wants milliseconds.
fn codex_plan(limits: &Value, now: i64) -> Option<Value> {
    let rate_limits = limits.get("rateLimits");
    let mut five = None;
    let mut seven = None;
    for key in ["primary", "secondary"] {
        let Some(w) = rate_limits.and_then(|r| r.get(key)).and_then(Value::as_object) else { continue };
        let (Some(pct), Some(seconds)) = (number(w.get("usedPercent")), number(w.get("resetsAt"))) else { continue };
        let Some(win) = window(pct, seconds * 1000.0) else { continue };
        let short = number(w.get("windowDurationMins")).is_some_and(|mins| mins <= SHORT_WINDOW_MINS);
        // The same rule as the island's own gauge (`frontend/vendor/coucou/core/plan.ts`): a day or less is the
        // short window, anything else — or nothing — is the week, and the later of two is the one that wins.
        if short {
            five = Some(win);
        } else {
            seven = Some(win);
        }
    }
    if five.is_none() && seven.is_none() {
        return None;
    }
    let mut plan = Map::new();
    if let Some(w) = five {
        plan.insert("fiveHour".into(), w);
    }
    if let Some(w) = seven {
        plan.insert("sevenDay".into(), w);
    }
    // §11: `resetCredits` is an integer `0..=99`; Codex reports it as `availableCount`.
    if let Some(n) = limits.get("rateLimitResetCredits").and_then(|c| c.get("availableCount")).and_then(Value::as_i64) {
        if (0..=MAX_RESET_CREDITS).contains(&n) {
            plan.insert("resetCredits".into(), json!(n));
        }
    }
    if let Some(name) = plan_name(rate_limits.and_then(|r| r.get("planType"))) {
        plan.insert("plan".into(), name);
    }
    // Codex says nothing about when its numbers were read: the read itself is the stamp.
    if let Some(at) = stamp(Some(&json!(now))) {
        plan.insert("updatedAt".into(), json!(at));
    }
    Some(Value::Object(plan))
}

/// The §11 line: `{"type":"usage"}` plus whichever plans can be described. A plan whose numbers are unknown is
/// absent, and both absent is the contract's own way of clearing the phone's display — never an empty object.
pub fn line(claude: Option<&Value>, codex: Option<&Value>, now: i64) -> Value {
    let mut out = Map::new();
    out.insert("type".into(), json!("usage"));
    if let Some(plan) = claude.and_then(claude_plan) {
        out.insert("claude".into(), plan);
    }
    if let Some(plan) = codex.and_then(|limits| codex_plan(limits, now)) {
        out.insert("codex".into(), plan);
    }
    Value::Object(out)
}

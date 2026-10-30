//! #467 closed schema of the one weekly-recap command, `recap_action`.
//! Pure parsing; the host (`recaphost.rs`) owns the store and the files.
use crate::recap::is_week_key;
use serde_json::Value;

#[cfg(test)]
#[path = "recap_cmd_tests.rs"]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    View(i64),
    Prefs,
    SetEnabled(bool),
    SetHideProjects(bool),
    MarkShown(String),
    Clear,
    SavePng { data: String, week: String },
    RevealSaved,
}

fn exact(obj: &serde_json::Map<String, Value>, n: usize) -> bool {
    obj.len() == n
}

/// `{action:"view",since}` (since ≥ 0), `prefs`, `set_enabled{enabled}`,
/// `set_hide_projects{hide}`, `mark_shown{week:YYYY-MM-DD}`, `clear`,
/// `save_png{data,week}` (week may not be empty: YYYY-MM-DD) and `reveal_saved`.
/// Unknown fields or types → `None`.
pub fn parse_command(payload: &Value) -> Option<Command> {
    let o = payload.as_object()?;
    let week = |o: &serde_json::Map<String, Value>| {
        o.get("week").and_then(Value::as_str).filter(|w| is_week_key(w)).map(str::to_owned)
    };
    match o.get("action")?.as_str()? {
        "view" if exact(o, 2) => Some(Command::View(o.get("since")?.as_i64().filter(|s| *s >= 0)?)),
        "prefs" if exact(o, 1) => Some(Command::Prefs),
        "clear" if exact(o, 1) => Some(Command::Clear),
        "reveal_saved" if exact(o, 1) => Some(Command::RevealSaved),
        "set_enabled" if exact(o, 2) => Some(Command::SetEnabled(o.get("enabled")?.as_bool()?)),
        "set_hide_projects" if exact(o, 2) => Some(Command::SetHideProjects(o.get("hide")?.as_bool()?)),
        "mark_shown" if exact(o, 2) => Some(Command::MarkShown(week(o)?)),
        "save_png" if exact(o, 3) => Some(Command::SavePng {
            data: o.get("data")?.as_str()?.to_owned(),
            week: week(o)?,
        }),
        _ => None,
    }
}

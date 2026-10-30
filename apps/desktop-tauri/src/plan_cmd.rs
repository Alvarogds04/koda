//! #467 closed schema of the plan-usage command, `plan_action`. Pure parsing.
use serde_json::Value;

#[cfg(test)]
#[path = "plan_cmd_tests.rs"]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Ask the Codex CLI for its own rate limits.
    Codex,
    /// Read the numbers the Abito status-line script left in the runtime directory.
    Claude,
}

/// `{action:"codex"}` or `{action:"claude"}` only; no field of the payload ever reaches a process or a path.
pub fn parse_command(payload: &Value) -> Option<Command> {
    let o = payload.as_object()?;
    match o.get("action")?.as_str()? {
        "codex" if o.len() == 1 => Some(Command::Codex),
        "claude" if o.len() == 1 => Some(Command::Claude),
        _ => None,
    }
}

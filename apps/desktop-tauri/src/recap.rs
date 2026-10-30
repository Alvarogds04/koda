//! #467 weekly recap history. Counts only, never a command, a path, file contents or a prompt.
//!
//! Adapted from Coucou src-tauri/src/recap.rs @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT
//! (port of RecapStore.swift). What Abito changed: no relay and no Tauri glue (the closed
//! `recap_action` host in `recaphost.rs` owns the store and feeds it from Abito's own events),
//! the hook-payload agent tag is `abito_agent`, UTC file stamps instead of a platform clock,
//! Spanish error text, and the image goes to the user's pictures folder as "Koda weekly recap".
//!
//! A "turn" runs from a prompt (or the first tool call) to Stop; only its counts and two names
//! are kept: the agent's pill id and the project folder's last path component. The history
//! lives in `recap.json`, keeps a 12-week window and a hard cap, and is written whole to a
//! temporary file then renamed over the old one. Nothing in it ever leaves the machine.
//! Aggregation (weeks, top agent, busiest day…) happens in the page, which has the user's zone.

use std::collections::{HashMap, HashSet};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(test)]
#[path = "recap_tests.rs"]
mod tests;

/// 12 weeks, like the Mac.
pub const WINDOW_SECS: i64 = 12 * 7 * 86_400;
/// A turn with no event for two hours is closed at its last event (agent
/// crashed, or never sent Stop) — RecapStore.pruneStale.
const STALE_SECS: i64 = 2 * 3600;
/// A `settled` notice this close to a hook-fed event is the same turn.
const HOOK_DEDUPE_SECS: i64 = 30;
/// Hard caps, whatever the window holds: about 2 MB of JSON at most.
const MAX_TURNS: usize = 10_000;
const MAX_DECISIONS: usize = 10_000;
const MAX_DRAFTS: usize = 256;
const MAX_REQUESTS: usize = 64;
const MAX_NAME_CHARS: usize = 64;
/// A recap.json larger than this was not written by us: set it aside.
const MAX_FILE_BYTES: u64 = 16 << 20;
/// A 1080 × 1920 PNG is ~1 MB; anything far larger is not our image.
const MAX_PNG_BYTES: usize = 24 << 20;

/// Same limits as DiffEngine.swift: beyond them, lines are counted, not diffed.
const DIFF_MAX_BYTES: usize = 200 * 1024;
const DIFF_MAX_LINES: usize = 4000;
const DIFF_MAX_CELLS: usize = 1_000_000;

/// Tool names that run a shell command, across the agents the relay serves.
const COMMAND_TOOLS: &[&str] = &[
    "Bash",
    "PowerShell",
    "Execute",
    "mcp__ide__executeCode",
    "run_shell_command",
    "shell",
    "local_shell",
    "exec_command",
    // Antigravity, and Copilot CLI's toolName, after the relay's normaliser.
    "run_command",
    "bash",
];

// ── Persisted model ───────────────────────────────────────────────────────────

/// One finished turn. Times are Unix seconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub agent: String,
    pub project: String,
    pub start: i64,
    pub end: i64,
    pub files_changed: u32,
    pub lines_added: u32,
    pub lines_removed: u32,
    pub commands_run: u32,
    pub questions: u32,
}

/// A click on Allow or Deny in the island.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub agent: String,
    pub date: i64,
    /// "allow" or "deny".
    pub decision: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    /// "Keep a history of my coding sessions" — on by default, like the Mac.
    pub enabled: bool,
    /// Leave the project name out of the shared image.
    pub hide_projects: bool,
    /// Monday (YYYY-MM-DD) of the week the recap was last shown on its own.
    pub last_shown_week: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { enabled: true, hide_projects: false, last_shown_week: String::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct History {
    schema_version: u32,
    turns: Vec<Turn>,
    decisions: Vec<Decision>,
    prefs: Prefs,
}

impl Default for History {
    fn default() -> Self {
        Self { schema_version: 1, turns: Vec::new(), decisions: Vec::new(), prefs: Prefs::default() }
    }
}

/// What the island reads: the part of the history it asked for.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryView {
    pub turns: Vec<Turn>,
    pub decisions: Vec<Decision>,
    pub prefs: Prefs,
}

/// A turn in progress, in memory only. The paths are only there to count
/// distinct files and are never written anywhere.
#[derive(Debug)]
struct Draft {
    agent: String,
    project: String,
    start: i64,
    last_event: i64,
    paths: HashSet<String>,
    lines_added: u32,
    lines_removed: u32,
    commands_run: u32,
    questions: u32,
}

impl Draft {
    fn into_turn(self, end: i64) -> Turn {
        Turn {
            agent: self.agent,
            project: self.project,
            start: self.start,
            end: end.max(self.start),
            files_changed: self.paths.len().min(u32::MAX as usize) as u32,
            lines_added: self.lines_added,
            lines_removed: self.lines_removed,
            commands_run: self.commands_run,
            questions: self.questions,
        }
    }
}

// ── Store ─────────────────────────────────────────────────────────────────────

pub struct Recap {
    path: PathBuf,
    history: History,
    drafts: HashMap<String, Draft>,
    /// Permission request ID → agent, until the island answers it.
    requests: HashMap<String, String>,
    /// The last image saved, so "Show in folder" never takes a path from the page.
    pub last_saved: Option<PathBuf>,
    /// Unix seconds of the last hook-fed event (0: none). A `settled` notice right after one is the same turn.
    hook_seen: i64,
}

impl Recap {
    /// Reads `path`. A file that cannot be used is renamed aside, never lost.
    pub fn load(path: PathBuf, now: i64) -> Self {
        let history = read_history(&path);
        let mut recap = Self {
            path,
            history,
            drafts: HashMap::new(),
            requests: HashMap::new(),
            last_saved: None,
            hook_seen: 0,
        };
        recap.prune(now);
        recap
    }

    /// One hook event, as the relay delivered it.
    pub fn observe(&mut self, payload: &Value, now: i64) {
        if !self.history.prefs.enabled {
            return;
        }
        self.close_stale(now);
        let event = text(payload, "hook_event_name");
        let agent = agent_id(payload);
        let key = session_key(payload, &agent);

        match event {
            "UserPromptSubmit" => {
                self.draft(&key, &agent, payload, now);
            }
            "PreToolUse" => {
                let tool = text(payload, "tool_name");
                let draft = self.draft(&key, &agent, payload, now);
                if COMMAND_TOOLS.contains(&tool) {
                    draft.commands_run = draft.commands_run.saturating_add(1);
                }
                if tool == "AskUserQuestion" {
                    draft.questions = draft.questions.saturating_add(1);
                }
            }
            "PostToolUse" => {
                let tool = text(payload, "tool_name");
                let input = payload.get("tool_input").unwrap_or(&Value::Null);
                let change = file_change(tool, input);
                let draft = self.draft(&key, &agent, payload, now);
                if let Some((path, added, removed)) = change {
                    draft.paths.insert(path);
                    draft.lines_added = draft.lines_added.saturating_add(added);
                    draft.lines_removed = draft.lines_removed.saturating_add(removed);
                }
            }
            // Unlike the Mac, SessionEnd closes the turn instead of dropping it:
            // a session quit mid-turn still worked.
            "Stop" | "StopFailure" | "Interrupt" | "SessionEnd" => {
                if let Some(draft) = self.drafts.remove(&key) {
                    self.history.turns.push(draft.into_turn(now));
                    self.prune(now);
                    self.save();
                }
            }
            _ => {}
        }
    }

    /// The draft for `key`, created on the first event of a turn.
    fn draft(&mut self, key: &str, agent: &str, payload: &Value, now: i64) -> &mut Draft {
        let project = project_name(text(payload, "cwd"));
        self.draft_named(key, agent, project, now)
    }

    fn draft_named(&mut self, key: &str, agent: &str, project: String, now: i64) -> &mut Draft {
        if !self.drafts.contains_key(key) && self.drafts.len() >= MAX_DRAFTS {
            self.close_oldest_draft();
        }
        let draft = self.drafts.entry(key.to_string()).or_insert_with(|| Draft {
            agent: agent.to_string(),
            project,
            start: now,
            last_event: now,
            paths: HashSet::new(),
            lines_added: 0,
            lines_removed: 0,
            commands_run: 0,
            questions: 0,
        });
        draft.last_event = now;
        draft
    }

    fn close_oldest_draft(&mut self) {
        let Some(key) = self
            .drafts
            .iter()
            .min_by_key(|(_, d)| d.last_event)
            .map(|(k, _)| k.clone())
        else {
            return;
        };
        if let Some(draft) = self.drafts.remove(&key) {
            let end = draft.last_event;
            self.history.turns.push(draft.into_turn(end));
        }
    }

    /// RecapStore.pruneStale: turns silent for two hours count up to their
    /// last event instead of being lost.
    fn close_stale(&mut self, now: i64) {
        let stale: Vec<String> = self
            .drafts
            .iter()
            .filter(|(_, d)| d.last_event < now - STALE_SECS)
            .map(|(k, _)| k.clone())
            .collect();
        if stale.is_empty() {
            return;
        }
        for key in stale {
            if let Some(draft) = self.drafts.remove(&key) {
                let end = draft.last_event;
                self.history.turns.push(draft.into_turn(end));
            }
        }
        self.prune(now);
        self.save();
    }

    /// One REDUCED event from the notify-only Claude hooks (`recap_spool`): `{v:1, at, event:
    /// prompt|tool|stop, session, project, kind?, added?, removed?, file?}`. Only counts and the
    /// folder name; `file` is an opaque id used to count distinct files and is never stored.
    pub fn observe_reduced(&mut self, rec: &Value, now: i64) {
        if !self.history.prefs.enabled || rec.get("v").and_then(Value::as_i64) != Some(1) {
            return;
        }
        let session = text(rec, "session");
        if session.is_empty() || session.len() > 128 {
            return;
        }
        let event = text(rec, "event");
        let kind = text(rec, "kind");
        let valid = match event {
            "prompt" | "stop" => true,
            "tool" => matches!(kind, "command" | "question" | "edit" | "other"),
            _ => false,
        };
        if !valid {
            return;
        }
        self.close_stale(now);
        self.hook_seen = now;
        let key = format!("hook:{session}");
        let project = clean_name(text(rec, "project"));
        let num = |k: &str| rec.get(k).and_then(Value::as_u64).unwrap_or(0).min(u64::from(u32::MAX)) as u32;
        match event {
            "prompt" => {
                self.draft_named(&key, "integration_claude", project, now);
            }
            "tool" => {
                let draft = self.draft_named(&key, "integration_claude", project, now);
                match kind {
                    "command" => draft.commands_run = draft.commands_run.saturating_add(1),
                    "question" => draft.questions = draft.questions.saturating_add(1),
                    "edit" => {
                        let file = text(rec, "file");
                        if !file.is_empty() && file.len() <= 64 {
                            draft.paths.insert(file.to_string());
                        }
                        draft.lines_added = draft.lines_added.saturating_add(num("added"));
                        draft.lines_removed = draft.lines_removed.saturating_add(num("removed"));
                    }
                    _ => {}
                }
            }
            _ => {
                if let Some(draft) = self.drafts.remove(&key) {
                    self.history.turns.push(draft.into_turn(now));
                    self.prune(now);
                    self.save();
                }
            }
        }
    }

    /// Abito feed (A): a turn Abito only knows by its end (a Pi `settled` notice). No tool
    /// counts exist for it; they stay 0 and the page shows them as unavailable.
    pub fn record_settled(&mut self, agent: &str, project: &str, now: i64) {
        // Hook events already described this turn (a Claude Stop also raises a `settled` notice).
        if !self.history.prefs.enabled || (self.hook_seen > 0 && (now - self.hook_seen).abs() <= HOOK_DEDUPE_SECS) {
            return;
        }
        self.history.turns.push(Turn {
            agent: agent.to_string(),
            project: clean_name(project),
            start: now,
            end: now,
            files_changed: 0,
            lines_added: 0,
            lines_removed: 0,
            commands_run: 0,
            questions: 0,
        });
        self.prune(now);
        self.save();
    }

    /// A permission request reached the island: remember whose it is.
    pub fn note_request(&mut self, request_id: &str, payload: &Value) {
        if self.requests.len() >= MAX_REQUESTS {
            self.requests.clear();
        }
        self.requests.insert(request_id.to_string(), agent_id(payload));
    }

    /// The request was handed back to the terminal: nothing to record.
    pub fn forget_request(&mut self, request_id: &str) {
        self.requests.remove(request_id);
    }

    /// A click on Allow or Deny.
    pub fn record_decision(&mut self, request_id: &str, decision: &str, now: i64) {
        let agent = self
            .requests
            .remove(request_id)
            .unwrap_or_else(|| "integration_claude".to_string());
        if !self.history.prefs.enabled {
            return;
        }
        let word = match decision {
            "allow" | "always" => "allow",
            "deny" => "deny",
            _ => return,
        };
        self.history.decisions.push(Decision { agent, date: now, decision: word.to_string() });
        self.prune(now);
        self.save();
    }

    /// Everything from `since` on (Unix seconds).
    pub fn view(&self, since: i64) -> HistoryView {
        HistoryView {
            turns: self.history.turns.iter().filter(|t| t.start >= since).cloned().collect(),
            decisions: self.history.decisions.iter().filter(|d| d.date >= since).cloned().collect(),
            prefs: self.history.prefs.clone(),
        }
    }

    pub fn prefs(&self) -> &Prefs {
        &self.history.prefs
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.history.prefs.enabled = enabled;
        if !enabled {
            self.drafts.clear();
            self.requests.clear();
        }
        self.save();
    }

    pub fn set_hide_projects(&mut self, hide: bool) {
        self.history.prefs.hide_projects = hide;
        self.save();
    }

    /// `week` is the Monday the recap was shown for, as YYYY-MM-DD.
    pub fn mark_shown(&mut self, week: &str) {
        if !is_week_key(week) {
            return;
        }
        self.history.prefs.last_shown_week = week.to_string();
        self.save();
    }

    /// Settings → General → Clear history. The preferences stay.
    pub fn clear(&mut self) {
        self.history.turns.clear();
        self.history.decisions.clear();
        self.drafts.clear();
        self.save();
    }

    /// 12-week window, then the hard caps (oldest first out).
    fn prune(&mut self, now: i64) {
        let cutoff = now - WINDOW_SECS;
        self.history.turns.retain(|t| t.start >= cutoff);
        self.history.decisions.retain(|d| d.date >= cutoff);
        if self.history.turns.len() > MAX_TURNS {
            self.history.turns.sort_by_key(|t| t.start);
            let excess = self.history.turns.len() - MAX_TURNS;
            self.history.turns.drain(..excess);
        }
        if self.history.decisions.len() > MAX_DECISIONS {
            self.history.decisions.sort_by_key(|d| d.date);
            let excess = self.history.decisions.len() - MAX_DECISIONS;
            self.history.decisions.drain(..excess);
        }
    }

    fn save(&self) {
        if let Err(err) = write_history(&self.path, &self.history) {
            note(format!("could not save the weekly recap history: {err}"));
        }
    }
}

// ── Reading and writing recap.json ────────────────────────────────────────────

fn read_history(path: &Path) -> History {
    let too_big = std::fs::metadata(path).is_ok_and(|m| m.len() > MAX_FILE_BYTES);
    let bytes = if too_big {
        None
    } else {
        match std::fs::read(path) {
            Ok(bytes) => Some(bytes),
            Err(err) if err.kind() == ErrorKind::NotFound => return History::default(),
            Err(err) => {
                note(format!("can't read {}: {err}", path.display()));
                // Unreadable is not corrupt: leave it, and start over in memory.
                // The first save will replace it, which only costs old counts.
                return History::default();
            }
        }
    };
    if let Some(history) = bytes.and_then(|b| serde_json::from_slice::<History>(&b).ok()) {
        return history;
    }
    // Keep the file as recap.json.corrupt-YYYYMMDD-HHMMSS, like the Mac.
    let aside = path.with_extension(format!("json.corrupt-{}", utc_stamp(now_secs())));
    match std::fs::rename(path, &aside) {
        Ok(()) => note(format!("{} was not usable — kept as {}", path.display(), aside.display())),
        Err(err) => note(format!("{} was not usable and could not be set aside: {err}", path.display())),
    }
    History::default()
}

/// Whole file to a temporary sibling, flushed, then renamed over the old one.
fn write_history(path: &Path, history: &History) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        ensure_private_dir(dir)?;
    }
    let json = serde_json::to_vec(history)
        .map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e))?;
    let temp = path.with_extension(format!("json.coucou-{}", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options
        .open(&temp)
        .and_then(|mut file| {
            file.write_all(&json)?;
            file.sync_all()
        })
        .and_then(|()| std::fs::rename(&temp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

/// One line in coucou.log. Tests must never write to the real one.
fn note(message: String) {
    eprintln!("abito recap: {message}");
}

// ── Reading a hook payload ────────────────────────────────────────────────────

fn text<'a>(payload: &'a Value, key: &str) -> &'a str {
    payload.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// Same routing as hooks.ts, so a turn counts for the pill it showed on: a
/// valid `coucou_agent` → `agent_<name>` (every agent the relay normalises,
/// Claude Desktop included); otherwise Claude Code's own pill — Cursor's when
/// it runs in Cursor's terminal, VS Code's else. "claude" is reserved.
fn agent_id(payload: &Value) -> String {
    let raw = text(payload, "abito_agent");
    let valid = !raw.is_empty()
        && raw.len() <= 24
        && raw != "claude"
        && raw.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if valid {
        format!("agent_{raw}")
    } else if text(payload, "term_editor") == "cursor" {
        "agent_cursor".to_string()
    } else {
        "integration_claude".to_string()
    }
}

/// Concurrent sessions are tracked apart; one without an ID is keyed by its
/// agent and folder, as HookServer.swift does.
fn session_key(payload: &Value, agent: &str) -> String {
    let id = text(payload, "session_id");
    if id.is_empty() || id == "unknown" {
        format!("{agent}+{}", text(payload, "cwd"))
    } else {
        id.to_string()
    }
}

/// The working folder's last component — the only part of a path ever kept.
fn project_name(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches(['/', '\\']);
    let last = trimmed.rsplit(['/', '\\']).next().unwrap_or_default();
    clean_name(last)
}

fn clean_name(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control()).take(MAX_NAME_CHARS).collect()
}

/// The file an Edit, MultiEdit or Write touched, with lines added and removed.
fn file_change(tool: &str, input: &Value) -> Option<(String, u32, u32)> {
    let path = input.get("file_path").and_then(Value::as_str)?;
    let (added, removed) = match tool {
        "Edit" => {
            let old = input.get("old_string").and_then(Value::as_str)?;
            let new = input.get("new_string").and_then(Value::as_str)?;
            line_diff(old, new)
        }
        "MultiEdit" => {
            let edits = input.get("edits").and_then(Value::as_array)?;
            edits.iter().fold((0u32, 0u32), |(a, r), edit| {
                let old = edit.get("old_string").and_then(Value::as_str).unwrap_or_default();
                let new = edit.get("new_string").and_then(Value::as_str).unwrap_or_default();
                let (da, dr) = line_diff(old, new);
                (a.saturating_add(da), r.saturating_add(dr))
            })
        }
        "Write" => {
            let content = input.get("content").and_then(Value::as_str)?;
            (count(split_lines(content).len()), 0)
        }
        _ => return None,
    };
    (added > 0 || removed > 0).then(|| (path.to_string(), added, removed))
}

fn count(n: usize) -> u32 {
    n.min(u32::MAX as usize) as u32
}

/// DiffEngine.splitLines: CRLF → LF, no trailing empty line.
fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

/// Lines added and removed between `old` and `new`, from their longest common
/// subsequence — the counts DiffEngine.fromEdit gives. Past its size limits
/// every old line counts as removed and every new one as added.
pub fn line_diff(old: &str, new: &str) -> (u32, u32) {
    let a = split_lines(old);
    let b = split_lines(new);
    let fallback = (count(b.len()), count(a.len()));
    if old.len() + new.len() > DIFF_MAX_BYTES
        || a.len() + b.len() > DIFF_MAX_LINES
        || a.len().saturating_mul(b.len()) > DIFF_MAX_CELLS
    {
        return fallback;
    }
    let mut prev = vec![0usize; b.len() + 1];
    let mut row = vec![0usize; b.len() + 1];
    for x in &a {
        for (j, y) in b.iter().enumerate() {
            row[j + 1] = if x == y { prev[j] + 1 } else { prev[j + 1].max(row[j]) };
        }
        std::mem::swap(&mut prev, &mut row);
    }
    let lcs = prev[b.len()];
    (count(b.len() - lcs), count(a.len() - lcs))
}

pub fn is_week_key(week: &str) -> bool {
    week.len() == 10
        && week.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() })
}

// ── Saving the shared image ───────────────────────────────────────────────────

/// Standard base64, with or without a `data:…;base64,` prefix.
fn decode_base64(data: &str) -> Option<Vec<u8>> {
    let body = match data.split_once(',') {
        Some((head, rest)) if head.starts_with("data:") => rest,
        _ => data,
    };
    let mut out = Vec::with_capacity(body.len() / 4 * 3);
    let mut acc = 0u32;
    let mut bits = 0u32;
    let mut padding = false;
    for b in body.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => {
                padding = true;
                continue;
            }
            b'\r' | b'\n' => continue,
            _ => return None,
        };
        if padding {
            return None;
        }
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

const PNG_SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n'];

/// Writes `bytes` as `<stem>.png` in `dir`, or `<stem> (2).png`… when that name
/// is taken. An existing file is never replaced.
fn write_unique(dir: &Path, stem: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    for n in 1..1000 {
        let name = if n == 1 { format!("{stem}.png") } else { format!("{stem} ({n}).png") };
        let path = dir.join(name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let written = file.write_all(bytes).and_then(|()| file.sync_all());
                drop(file);
                if let Err(err) = written {
                    let _ = std::fs::remove_file(&path);
                    return Err(err);
                }
                return Ok(path);
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(ErrorKind::AlreadyExists, "too many recap images with this name"))
}

/// The PNG the page rendered, checked and written to the first pictures folder
/// that exists.
pub fn save_png(dirs: &[PathBuf], data: &str, week: &str) -> Result<PathBuf, String> {
    if data.len() > MAX_PNG_BYTES / 3 * 4 + 64 {
        return Err("La imagen es demasiado grande.".to_string());
    }
    let bytes = decode_base64(data).ok_or_else(|| "No se pudo leer la imagen.".to_string())?;
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("No se pudo leer la imagen.".to_string());
    }
    let dir = dirs
        .iter()
        .find(|d| d.is_dir())
        .ok_or_else(|| "No hay carpeta Imágenes ni Descargas donde guardar.".to_string())?;
    let stem = if is_week_key(week) {
        format!("Koda weekly recap {week}")
    } else {
        "Koda weekly recap".to_string()
    };
    write_unique(dir, &stem, &bytes)
        .map_err(|_| "No se pudo guardar la imagen.".to_string())
}

// ── Small platform helpers (no platform layer in Abito) ──────────────────────

pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// `YYYYMMDD-HHMMSS` in UTC (civil-from-days, Howard Hinnant).
pub fn utc_stamp(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}{month:02}{day:02}-{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// The folder, owner-only on Unix (it holds the user's activity counts).
fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Where the shared image may be saved, best first.
pub fn picture_dirs() -> Vec<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    let Some(home) = home.map(PathBuf::from).filter(|h| h.is_absolute()) else { return Vec::new() };
    vec![home.join("Pictures"), home.join("Downloads")]
}

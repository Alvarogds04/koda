//! Closed dictation contract; no device access or Tauri dependencies.
use crate::flow::{self, portal::KeyStatus, store::{AppStyle, Prefs, Store}, text::{self, Day, Replacement, Snippet}};
use crate::speech::{audio::InputDevice, ModelsStatus};
use serde_json::{json, Value};

#[derive(Debug, PartialEq)]
pub enum Command {
    History,
    CopyEntry(String),
    CopyLast,
    DeleteEntry(String),
    ClearHistory(bool),
    Stats,
    Words,
    SetWords(Vec<String>, Vec<Replacement>),
    Snippets,
    SetSnippets(Vec<Snippet>),
    Styles,
    SetStyles(Vec<AppStyle>),
    Status,
    RunningApps,
    SetPrefs(Prefs),
    Download,
    Remove,
    Key(flow::KeyEvent),
}

pub fn parse_command(payload: &Value, devices: &[String], claude_key_present: bool) -> Option<Command> {
    let o = payload.as_object()?;
    match o.get("action")?.as_str()? {
        "copy_last" if o.len() == 1 => Some(Command::CopyLast),
        "history" if o.len() == 1 => Some(Command::History),
        "stats" if o.len() == 1 => Some(Command::Stats),
        "words" if o.len() == 1 => Some(Command::Words),
        "snippets" if o.len() == 1 => Some(Command::Snippets),
        "styles" if o.len() == 1 => Some(Command::Styles),
        action @ ("delete_entry" | "copy_entry") if o.len() == 2 => {
            let id = o.get("id")?.as_str()?;
            (!id.is_empty() && id.len() <= 64
                && id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')))
                .then(|| if action == "copy_entry" { Command::CopyEntry(id.into()) } else { Command::DeleteEntry(id.into()) })
        }
        "clear_history" if o.len() == 2 => Some(Command::ClearHistory(o.get("everything")?.as_bool()?)),
        "set_words" if o.len() == 2 => {
            let v = o.get("words")?;
            let w = v.as_object()?;
            if w.len() != 2 { return None; }
            let words = w.get("words")?.as_array()?;
            if words.len() > 500 || !words.iter().all(|v| v.as_str().is_some_and(|s|
                s.chars().count() <= 80 && text::is_plain_word(s))) { return None; }
            if !rows(w.get("replacements")?, 500, &[("id",64),("from",200),("to",200)]) { return None; }
            let words: flow::store::Words = serde_json::from_value(v.clone()).ok()?;
            Some(Command::SetWords(words.words, words.replacements))
        }
        "set_snippets" if o.len() == 2 => {
            let v = o.get("snippets")?;
            if !rows(v, 200, &[("id",64),("trigger",80),("text",4000)]) { return None; }
            let snippets: Vec<Snippet> = serde_json::from_value(v.clone()).ok()?;
            let mut triggers = std::collections::HashSet::new();
            if snippets.iter().any(|s| s.trigger.trim().is_empty() || !triggers.insert(&s.trigger)) { return None; }
            Some(Command::SetSnippets(snippets))
        }
        "set_styles" if o.len() == 2 => {
            let v = o.get("styles")?;
            if !rows(v, 100, &[("id",80),("name",80),("style",8)]) { return None; }
            Some(Command::SetStyles(serde_json::from_value(v.clone()).ok()?))
        }
        "running_apps" if o.len() == 1 => Some(Command::RunningApps),
        "status" if o.len() == 1 => Some(Command::Status),
        "download_model" if o.len() == 1 => Some(Command::Download),
        "remove_model" if o.len() == 1 => Some(Command::Remove),
        "hands_free" if o.len() == 1 => Some(Command::Key(flow::KeyEvent::HandsFree)),
        "finish" if o.len() == 1 => Some(Command::Key(flow::KeyEvent::Finish)),
        "cancel" if o.len() == 1 => Some(Command::Key(flow::KeyEvent::Cancel)),
        "set_prefs" if o.len() == 2 => {
            let value = o.get("prefs")?;
            let p = value.as_object()?;
            let keys = ["enabled", "key", "edge", "mic", "keepDays", "cleanup", "defaultStyle"];
            if p.len() != keys.len() || !keys.iter().all(|k| p.contains_key(*k)) {
                return None;
            }
            let prefs: Prefs = serde_json::from_value(value.clone()).ok()?;
            if (prefs.cleanup && !claude_key_present) || ![0, 7, 30, 365, -1].contains(&prefs.keep_days)
                || prefs.mic.len() > 200
                || (!prefs.mic.is_empty() && !devices.contains(&prefs.mic))
            {
                return None;
            }
            Some(Command::SetPrefs(prefs))
        }
        _ => None,
    }
}

/// Exact nested keys and string types, measured in Unicode scalar values.
fn rows(value: &Value, max: usize, fields: &[(&str, usize)]) -> bool {
    value.as_array().is_some_and(|items| items.len() <= max && items.iter().all(|v|
        v.as_object().is_some_and(|o| o.len() == fields.len() && fields.iter().all(|(key, limit)|
            o.get(*key).and_then(Value::as_str).is_some_and(|s| s.chars().count() <= *limit)))))
}

/// Select stored text only; renderer-supplied text never reaches the clipboard.
pub fn clipboard_text(command: &Command, store: &Store) -> Option<String> {
    match command {
        Command::CopyEntry(id) if store.prefs.keep_days != 0 =>
            store.history.iter().find(|entry| &entry.id == id).map(|entry| entry.text.clone()),
        Command::CopyLast => store.last_text(),
        _ => None,
    }
}

pub fn history_json(store: &Store) -> Value {
    if store.prefs.keep_days == 0 { json!([]) } else { json!(store.history.iter().take(300).collect::<Vec<_>>()) }
}

/// Mirrors Coucou's inclusive 7/30-day windows and oldest-first 30-day chart.
pub fn stats_json(store: &Store, today: Day) -> Value {
    let totals = |from| {
        let (words, seconds, dictations) = store.totals(from);
        json!({"words":words,"seconds":seconds,"dictations":dictations,
            "wordsPerMinute":text::words_per_minute(words, seconds),
            "minutesSaved":text::minutes_saved(words, seconds)})
    };
    let daily: Vec<_> = (0..30).rev().map(|back| {
        let key = today.minus(back).key();
        let words = store.stats.days.get(&key).map(|d| d.words).unwrap_or(0);
        (key, words)
    }).collect();
    json!({"week":totals(Some(today.minus(6))),"month":totals(Some(today.minus(29))),
        "all":totals(None),"daily":daily,"apps":store.stats.apps,"streak":store.streak(today)})
}

/// Call with the store mutex only: persistence must never hold the host mutex.
pub fn data_action(command: Command, store: &mut Store, today: Day) -> Value {
    match command {
        Command::History => return history_json(store),
        Command::Stats => return stats_json(store, today),
        Command::Words => return json!(store.words),
        Command::Snippets => return json!(store.snippets),
        Command::Styles => return json!(store.app_styles),
        Command::DeleteEntry(id) => store.delete(&id),
        Command::ClearHistory(true) => store.clear_everything(),
        Command::ClearHistory(false) => store.clear_history(),
        Command::SetWords(words, replacements) => {
            store.words = flow::store::Words { words, replacements };
            store.save_words();
        }
        Command::SetSnippets(snippets) => { store.snippets = snippets; store.save_snippets(); }
        Command::SetStyles(styles) => { store.app_styles = styles; store.save_styles(); }
        _ => unreachable!("not a data action"),
    }
    json!({"ok":true})
}

pub fn running_apps_json(apps: Vec<(String, String)>) -> Value {
    json!(apps.into_iter().map(|(id, name)| json!({"id":id,"name":name})).collect::<Vec<_>>())
}

pub fn status_json(prefs: &Prefs, models: ModelsStatus, key: KeyStatus, mics: Vec<InputDevice>, claude_key_present: bool) -> Value {
    let mut p = serde_json::to_value(prefs).expect("serializable prefs");
    for (k, v) in [("summaryEngine", json!("off")), ("openAtLaunch", json!(false)),
        ("voice", json!(false)), ("voiceOutput", json!("off")), ("voiceGender", json!("female"))] {
        p[k] = v;
    }
    let keys = if !prefs.enabled { "ok" } else { match key {
        KeyStatus::Active => "ok", KeyStatus::Pending => "pending",
        KeyStatus::Denied => "denied", KeyStatus::Unsupported => "unsupported",
    }};
    json!({"prefs":p,"models":models,"keys":keys,"hasClaudeKey":claude_key_present,
        "mics":mics,"platform":"linux","autostarted":false})
}

pub fn event(update: flow::Update) -> (&'static str, Value) {
    use flow::{Note, Phase, Update};
    match update {
        Update::Phase(p) => ("dictation:phase", json!({"phase":match p {
            Phase::Idle => "idle", Phase::Listening => "listening", Phase::Locked => "locked",
            Phase::Thinking => "thinking", Phase::Copied => "copied", Phase::Failed => "failed",
        }})),
        Update::Bands(bands) => ("dictation:bands", json!({"bands":bands})),
        Update::Level(level) => ("dictation:level", json!({"level":level})),
        Update::Note(n) => ("dictation:note", json!({"note":match n {
            Note::NeedModel => "needModel", Note::NoMicrophone => "noMicrophone",
            Note::ClipboardRefused => "clipboardRefused",
        }})),
    }
}

pub fn models_event(models: ModelsStatus) -> (&'static str, Value) {
    ("dictation:models", json!(models))
}

/// Owns the running resources: same-state writes never restart; disabling drops them.
pub struct Engine<T> {
    pub running: Option<T>,
}
impl<T> Engine<T> {
    pub fn set_enabled(&mut self, enabled: bool, start: impl FnOnce() -> T) {
        if enabled && self.running.is_none() {
            self.running = Some(start());
        } else if !enabled {
            self.running.take();
        }
    }
}

/// What the caller must do after a decision taken under the host lock.
pub enum Plan<T> {
    Keep,
    /// Build the running resources OUTSIDE the lock, then `install` them.
    Start,
    /// Drop this OUTSIDE the lock: stopping joins the engine thread, which may be mid-transcription.
    Stop(T),
}
impl<T> Engine<T> {
    /// Decides only; never starts or stops anything itself, so it is safe under a mutex.
    /// `starting` is true while another caller is already building the resources.
    pub fn plan(&mut self, enabled: bool, starting: bool) -> Plan<T> {
        if !enabled {
            return self.running.take().map_or(Plan::Keep, Plan::Stop);
        }
        if self.running.is_none() && !starting { Plan::Start } else { Plan::Keep }
    }
    /// Stores freshly built resources if they are still wanted; otherwise gives them back to be dropped.
    pub fn install(&mut self, running: T, still_wanted: bool) -> Option<T> {
        if still_wanted && self.running.is_none() {
            self.running = Some(running);
            None
        } else {
            Some(running)
        }
    }
}

#[cfg(test)]
#[path = "dictation_cmd_tests.rs"]
mod tests;

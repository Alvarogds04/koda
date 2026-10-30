//! #467 host: the one closed weekly-recap command, `recap_action`, plus the feeds.
//!
//! Same gate as `prefs_action` (known WebView label + page URL, shared rate limiter, closed
//! schema). Reachable from the settings window on purpose: Coucou's General page holds
//! "Keep a history", "Hide project names" and "Clear history". The history holds counts and
//! two names only (see `abito_island::recap`); nothing leaves the machine. `save_png` writes
//! only into the user's Pictures/Downloads folder and never replaces a file; `reveal_saved`
//! opens the folder of the image saved last, never a path from the page.
//! Feeds (A): Pi `settled` notices and Allow/Deny clicks. Tool counts need the hooks of (B).
use crate::{now_ms, AppState};
use abito_island::bridge::{self, BridgeError};
use abito_island::recap::{self, Recap};
use abito_island::recap_cmd::{parse_command, Command};
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard, PoisonError};
use tauri::{AppHandle, Manager, State};

/// Agent id of the turns Abito sees itself (the Pi engine).
const PI_AGENT: &str = "agent_pi";

#[derive(Default)]
pub struct RecapSlot(Mutex<Option<Recap>>);

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo completar la acción del resumen.".into() }
}

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("recap.json"))
}

fn with<R>(app: &AppHandle, f: impl FnOnce(&mut Recap) -> R) -> Option<R> {
    let slot = app.try_state::<RecapSlot>()?;
    let mut guard: MutexGuard<Option<Recap>> = slot.0.lock().unwrap_or_else(PoisonError::into_inner);
    if guard.is_none() {
        *guard = Some(Recap::load(path(app)?, recap::now_secs()));
    }
    guard.as_mut().map(f)
}

/// Feed (B): reduced events the notify-only Claude hooks spooled in the runtime dir.
fn ingest(app: &AppHandle) {
    let Ok(runtime) = abito_island::transport::resolve_runtime() else { return };
    let events = abito_island::recap_spool::take(&runtime);
    if events.is_empty() {
        return;
    }
    let now = recap::now_secs();
    with(app, |r| {
        for e in &events {
            // the event's own time keeps a long-queued turn honest; never from the future
            let at = e.get("at").and_then(Value::as_i64).map(|ms| ms / 1000).filter(|s| *s > 0).unwrap_or(now);
            r.observe_reduced(e, at.min(now));
        }
    });
}

/// Feed (A): a Pi turn settled.
pub fn note_settled(app: &AppHandle, project: &str) {
    ingest(app);
    with(app, |r| r.record_settled(PI_AGENT, project, recap::now_secs()));
}

/// Feed (A): the human clicked Allow or Deny on a card (agent unknown → Claude's pill, as Coucou).
pub fn note_decision(app: &AppHandle, allow: bool) {
    ingest(app);
    with(app, |r| r.record_decision("", if allow { "allow" } else { "deny" }, recap::now_secs()));
}

fn reveal(dir: &std::path::Path) {
    #[cfg(windows)]
    let opener = "explorer";
    #[cfg(not(windows))]
    let opener = "xdg-open";
    if let Ok(mut c) = std::process::Command::new(opener)
        .arg(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        std::thread::spawn(move || {
            let _ = c.wait();
        });
    }
}

/// Closed recap command; see `abito_island::recap_cmd::parse_command` for the shapes.
/// `view` → `{turns,decisions,prefs}`; `prefs` → prefs; mutations → `{ok:true}`;
/// `save_png` → `{path}`.
#[tauri::command]
pub async fn recap_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = parse_command(&payload).ok_or_else(|| err("invalid_schema"))?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        ingest(&handle);
        let unavailable = || err("unavailable");
        match command {
            Command::View(since) => with(&handle, |r| serde_json::to_value(r.view(since)))
                .ok_or_else(unavailable)?
                .map_err(|_| err("save_failed")),
            Command::Prefs => with(&handle, |r| serde_json::to_value(r.prefs()))
                .ok_or_else(unavailable)?
                .map_err(|_| err("save_failed")),
            Command::SetEnabled(v) => with(&handle, |r| r.set_enabled(v)).map(|_| json!({"ok":true})).ok_or_else(unavailable),
            Command::SetHideProjects(v) => with(&handle, |r| r.set_hide_projects(v)).map(|_| json!({"ok":true})).ok_or_else(unavailable),
            Command::MarkShown(w) => with(&handle, |r| r.mark_shown(&w)).map(|_| json!({"ok":true})).ok_or_else(unavailable),
            Command::Clear => with(&handle, |r| r.clear()).map(|_| json!({"ok":true})).ok_or_else(unavailable),
            Command::SavePng { data, week } => {
                let saved = recap::save_png(&recap::picture_dirs(), &data, &week)
                    .map_err(|_| err("save_failed"))?;
                let shown = saved.to_string_lossy().to_string();
                with(&handle, |r| r.last_saved = Some(saved)).ok_or_else(unavailable)?;
                Ok(json!({"path": shown}))
            }
            Command::RevealSaved => {
                let dir = with(&handle, |r| r.last_saved.as_ref().and_then(|p| p.parent().map(|d| d.to_path_buf())))
                    .flatten();
                if let Some(dir) = dir {
                    reveal(&dir);
                }
                Ok(json!({"ok":true}))
            }
        }
    })
    .await
    .map_err(|_| err("save_failed"))?
}

//! #467 host: the one closed custom-sounds command, `sound_action`
//! (list | read | reveal | reload).
//!
//! Same gate as `prefs_action` (known WebView label + page URL, shared rate limiter, closed
//! schema). Reachable from the settings window on purpose: Coucou's Settings → "Open sounds
//! folder" / "Reload sounds" live there. It can only read files named after one of the
//! thirty-seven cue stems (`sounds::STEMS`) inside the app's own `sounds` folder (see
//! `koda_island::sounds`), and `reveal` opens that fixed folder with no caller-influenced argument.
use crate::{now_ms, AppState};
use koda_island::bridge::{self, BridgeError};
use koda_island::sounds::{self, Command};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

fn err(code: &str) -> BridgeError {
    BridgeError {
        code: code.into(),
        message: "No se pudo completar la acción de sonidos.".into(),
    }
}

fn folder(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join(sounds::FOLDER))
}

/// Shows the folder in the file manager through the shared opener (K2-01c). The path is ours,
/// never the caller's.
fn reveal(dir: &std::path::Path) -> Result<(), BridgeError> {
    std::fs::create_dir_all(dir).map_err(|_| err("save_failed"))?;
    // K2-01c: xdg-open, Finder (`open`) or Explorer; only a spawn failure counts (explorer.exe
    // reports 1 even on success).
    koda_island::opener::open_detached(koda_island::opener::Target::Folder(dir)).map_err(|_| err("unavailable"))
}

/// Closed custom-sounds command: `{action:"list"}` → `{names:[stem…]}`,
/// `{action:"read",name}` → `{name,mime,data}` (base64), `{action:"reveal"}`,
/// `{action:"reload"}` (emits `sounds:changed`).
#[tauri::command]
pub async fn sound_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = sounds::parse_command(&payload).ok_or_else(|| err("invalid_schema"))?;
    state
        .chat_rate
        .lock()
        .expect("chat rate lock")
        .check(now_ms())?;
    let dir = folder(&app).ok_or_else(|| err("unavailable"))?;
    match command {
        Command::Reload => {
            let _ = app.emit("sounds:changed", json!({}));
            Ok(json!({"ok": true}))
        }
        Command::Reveal => {
            reveal(&dir)?;
            Ok(json!({"ok": true}))
        }
        Command::List => {
            tauri::async_runtime::spawn_blocking(move || json!({"names": sounds::list(&dir)}))
                .await
                .map_err(|_| err("save_failed"))
        }
        Command::Read(name) => tauri::async_runtime::spawn_blocking(move || sounds::read(&dir, name))
            .await
            .map_err(|_| err("save_failed"))?
            .map_err(|_| err("not_found")),
    }
}

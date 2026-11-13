//! K2-11 host: `calendar_action {action:"refresh"}` → today's and tomorrow's events from the
//! user's private ICS URL (see `calendar`). Main window only, like the GitHub card. The URL is
//! read from the keychain here and never crosses IPC; the answer carries events or a fixed code.
use crate::{now_ms, AppState};
use koda_island::bridge::{self, BridgeError};
use koda_island::calendar::{self, Cache};
use serde_json::Value;
use std::sync::Mutex;
use tauri::State;

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

#[tauri::command]
pub async fn calendar_action(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let origin = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &origin)?;
    calendar::parse_request(&payload)?;
    state.rate.lock().expect("rate lock").check(now_ms())?;
    tauri::async_runtime::spawn_blocking(move || {
        use koda_island::secrets::{Keychain, SecretStore};
        let saved = Keychain.read(calendar::KEY).ok().flatten();
        let mut slot = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        slot.get_or_insert_with(Cache::default).refresh(saved.as_deref(), now_ms() as u64, calendar::fetch_ics)
    })
    .await
    .map_err(|_| BridgeError::denied("calendar aborted"))
}

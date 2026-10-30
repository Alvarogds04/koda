//! #467 T11 host: `github_action` (see `githubcmd`). Main window only: the GitHub card
//! lives in the island and Ajustes has no use for PR/CI data (F093 pin unchanged).
//! Gate, validate and spend the rate budget on the caller's thread; `gh` runs off it,
//! holding only the cache lock (never the shared rate lock) while it waits.
use crate::{now_ms, AppState};
use abito_island::bridge::{self, BridgeError};
use abito_island::githubcmd::{self, Cache};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::State;

// The key stays native. A credential change discards both sections, so accounts never mix.
static CACHE: Mutex<(Option<String>, Option<Cache>)> = Mutex::new((None, None));

/// S2 (#503): the pulse the island already holds, for the chat's live context. Never fetches and
/// never waits: if a poll holds the cache right now, the chat simply goes without GitHub this turn.
pub fn cached_pulse() -> Option<Value> {
    CACHE.try_lock().ok()?.1.as_ref()?.cached_pulse()
}

#[tauri::command]
pub async fn github_action(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let origin = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &origin)?;
    let section = githubcmd::parse_github(&payload)?;
    state.rate.lock().expect("rate lock").check(now_ms())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut slot = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        use abito_island::secrets::{Keychain, SecretStore};
        let token = Keychain.read("github-token").ok().flatten().filter(|t| !t.is_empty());
        if slot.0 != token { slot.0 = token.clone(); slot.1 = None; }
        let cache = slot.1.get_or_insert_with(Cache::default);
        match cache.refresh(section, now_ms() as u64, |s| match token.as_deref() { Some(t) => githubcmd::run_token(s, t), None => githubcmd::run_gh(s) }) {
            Ok(v) => v,
            Err(why) => json!({ "available": false, "reason": why.code() }),
        }
    })
    .await
    .map_err(|_| BridgeError::denied("github aborted"))
}

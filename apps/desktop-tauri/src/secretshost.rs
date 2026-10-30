//! #467 host: the one closed key-store command, `secret_action` (set | clear | present).
//!
//! Same gate as `prefs_action` (known WebView label + page URL, shared rate limiter, closed
//! schema). The answer is `{key, present}` only: the value is never returned. The keychain
//! call is blocking D-Bus work, so it runs off the WebView thread.
use crate::{now_ms, AppState};
use abito_island::bridge::{self, BridgeError};
use abito_island::secrets::{self, Keychain};
use serde_json::Value;
use tauri::State;

fn err(code: &str) -> BridgeError {
    BridgeError {
        code: code.into(),
        message: "No se pudo completar el cambio de claves.".into(),
    }
}

/// Closed key-store command: `{action:"set",key,value}`, `{action:"clear",key}`,
/// `{action:"present",key}`; `key` must be on the closed list. Answers presence only,
/// `unavailable` when the OS keychain is not reachable (no plaintext fallback).
#[tauri::command]
pub async fn secret_action(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = secrets::parse_command(&payload).ok_or_else(|| err("invalid_schema"))?;
    state
        .chat_rate
        .lock()
        .expect("chat rate lock")
        .check(now_ms())?;
    tauri::async_runtime::spawn_blocking(move || {
        let answer = secrets::apply(&Keychain, &command);
        // a removed or replaced key may leave a cloud selection without credential: reset it (S2)
        crate::modelshost::reconcile_cloud(&app);
        answer
    })
        .await
        .map_err(|_| err("save_failed"))?
        .map_err(|e| err(e.code()))
}

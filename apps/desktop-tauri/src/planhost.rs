//! #467 host: the one closed plan-usage command, `plan_action`.
//!
//! Same gate as `prefs_action` (known WebView label + page URL, shared rate limiter, closed
//! schema). `claude` reads the status-line channel file (see `abito_island::claude_plan`; unknown when stale);
//! `codex` spawns the user's own `codex app-server` (see `abito_island::codex_plan`)
//! off the WebView thread and answers `{available, rateLimits, rateLimitResetCredits}`; no
//! caller text reaches the process. Reachable from the settings window: Coucou shows the plan
//! gauge there too; the answer holds limits only, never account data.
use crate::{now_ms, AppState};
use abito_island::bridge::{self, BridgeError};
use abito_island::claude_plan;
use abito_island::codex_plan;
use abito_island::plan_cmd::{parse_command, Command};
use serde_json::{json, Value};
use tauri::State;

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo consultar el uso del plan.".into() }
}

#[tauri::command]
pub async fn plan_action(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = parse_command(&payload).ok_or_else(|| err("invalid_schema"))?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    match command {
        Command::Codex => tauri::async_runtime::spawn_blocking(|| match codex_plan::read() {
            Some(limits) => {
                let mut out = limits;
                out["available"] = json!(true);
                out
            }
            None => json!({"available": false}),
        })
        .await
        .map_err(|_| err("unavailable")),
        Command::Claude => tauri::async_runtime::spawn_blocking(|| {
            let plan = abito_island::transport::resolve_runtime()
                .ok()
                .and_then(|runtime| claude_plan::read(&runtime));
            match plan {
                Some(mut p) => {
                    p["available"] = json!(true);
                    p
                }
                None => json!({"available": false}),
            }
        })
        .await
        .map_err(|_| err("unavailable")),
    }
}

//! Subscription OAuth stays in Abito; no dependency on the user's Pi installation.
use crate::{now_ms, AppState};
use koda_island::{bridge::{self, BridgeError}, oauthcmd::{self, Flows}, provider_oauth::{OAuth, RustlsHttp}, secrets::Keychain};
use serde_json::{json, Value};
use std::sync::OnceLock;
static FLOWS: OnceLock<Flows> = OnceLock::new();
fn err(code: &str) -> BridgeError { BridgeError { code: code.into(), message: "No se pudo completar el inicio de sesión. Vuelve a intentarlo.".into() } }
fn open(url: &str) -> bool {
    if koda_island::desktop::validated_web_url(&json!({"url":url})).is_err() { return false; }
    koda_island::opener::open_detached(koda_island::opener::Target::Web(url)).is_ok()
}
#[tauri::command]
pub async fn oauth_action(app: tauri::AppHandle, webview: tauri::Webview, state: tauri::State<'_, AppState>, payload: Value) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().map_err(|_| err("unavailable"))?.check(now_ms())?;
    let cmd = oauthcmd::parse(&payload).ok_or_else(|| err("invalid_schema"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let clock = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let answer = FLOWS.get_or_init(Flows::default).apply(&OAuth::new(&Keychain, &RustlsHttp, &clock), cmd, &open);
        // a sign-in that ended or a sign-out changes which cloud providers can answer: drop a stale selection (S2)
        crate::modelshost::reconcile_cloud(&app);
        answer
    }).await.map_err(|_| err("unavailable"))?.map_err(err)
}

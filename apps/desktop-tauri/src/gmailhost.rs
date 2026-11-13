//! K2-10 T4 host: the closed `gmail_action` command (see `gmailcmd`, `gmail_oauth`, `gmail_api`).
//!
//! S11 — «lo que se configure en Ajustes tiene que andar también en su ventana propia»: the Gmail
//! card lives in Ajustes, so this command gates with the SHARED sender gate (`bridge::sender_ok`,
//! the exact labels `main`/`settings` and their own page URLs) exactly like `prefs_action`, NOT
//! with `main_window_only`. It takes the same shared rate limiter as chat/models/mail and speaks a
//! closed schema; every keychain and network step runs off the WebView thread, and no token, secret
//! or client id ever reaches the page.
use crate::{now_ms, AppState};
use abito_island::bridge::{self, BridgeError};
use abito_island::gmail_api::RustlsHttp as GmailApi;
use abito_island::gmail_oauth::GmailAuth;
use abito_island::gmailcmd::{self, Env, Flows, Seen};
use abito_island::provider_oauth::RustlsHttp as TokenEndpoint;
use abito_island::secrets::Keychain;
use serde_json::{json, Value};
use std::sync::OnceLock;

static FLOWS: OnceLock<Flows> = OnceLock::new();

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo completar la acción de Gmail. Vuelve a intentarlo.".into() }
}

/// The counter's mark lives in `prefs.json` (`settingshost`, same gate and atomic writer as every
/// other preference); the host is the only writer, so the page can never move it.
struct PrefsSeen<'a>(&'a tauri::AppHandle);
impl Seen for PrefsSeen<'_> {
    fn last_seen_ms(&self) -> u64 { crate::settingshost::gmail_last_seen_ms(self.0) }
    fn remember(&self, at_ms: u64) -> Result<(), ()> {
        crate::settingshost::remember_gmail_last_seen(self.0, at_ms).then_some(()).ok_or(())
    }
}

/// Hands a link or a `mailto:` to the system through the shared K2-01c opener (never a shell).
/// This command keeps its own validation: `desktop::validated_web_url` for links (it admits only
/// http(s)) and `gmailcmd::safe_mailto` for replies.
fn open(target: &str) -> bool {
    use abito_island::opener::{open_detached, Target};
    let target = if target.starts_with("mailto:") {
        if !gmailcmd::safe_mailto(target) { return false; }
        Target::Mailto(target)
    } else {
        if abito_island::desktop::validated_web_url(&json!({"url": target})).is_err() { return false; }
        Target::Web(target)
    };
    open_detached(target).is_ok()
}

#[tauri::command]
pub async fn gmail_action(app: tauri::AppHandle, webview: tauri::Webview, state: tauri::State<'_, AppState>, payload: Value) -> Result<Value, BridgeError> {
    // S11: the island AND the own Ajustes window (the shared gate, never `main_window_only`).
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().map_err(|_| err("unavailable"))?.check(now_ms())?;
    let cmd = gmailcmd::parse(&payload).ok_or_else(|| err("invalid_schema"))?;
    tauri::async_runtime::spawn_blocking(move || {
        // The auth takes SECONDS (the token's expiry); the counter and the mark take MS.
        let seconds = || (now_ms() / 1000) as u64;
        let millis = || u64::try_from(now_ms()).unwrap_or(u64::MAX);
        let tokens = TokenEndpoint;
        let api = GmailApi;
        let auth = GmailAuth::new(&Keychain, &tokens, &seconds);
        let seen = PrefsSeen(&app);
        let env = Env {
            store: &Keychain, auth: &auth, http: &api, now_ms: &millis, opener: &open, seen: &seen,
        };
        FLOWS.get_or_init(Flows::default).apply(&env, cmd)
    })
    .await
    .map_err(|_| err("unavailable"))?
    .map_err(err)
}

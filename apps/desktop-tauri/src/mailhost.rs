//! #490 host: the closed `mail_action` command (see `mailcmd`, `imapcmd`). Main window only: the
//! mail card lives in the island. Same gate as `github_action` (known label + page URL, shared
//! rate limiter, closed schema). Keychain reads are blocking D-Bus work and run off the WebView
//! thread; the network calls await on the async runtime. Nothing here returns a credential or
//! server text.
use crate::{now_ms, AppState};
use abito_island::bridge::{self, BridgeError};
use abito_island::imapcmd::{self, Limits};
use abito_island::mailcmd::{self, Request};
use abito_island::secrets::Keychain;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

fn roots() -> Arc<rustls::RootCertStore> {
    let mut store = rustls::RootCertStore::empty();
    store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Arc::new(store)
}

fn unix_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// `xdg-open mailto:…` with one argument, like `open_chat_url` (never a shell).
fn open_mailto(url: String) -> Result<(), BridgeError> {
    let status = std::process::Command::new("xdg-open")
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| BridgeError::denied("external opener unavailable"))?;
    if status.success() { Ok(()) } else { Err(BridgeError::denied("external opener failed")) }
}

#[tauri::command]
pub async fn mail_action(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let origin = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &origin)?;
    let request = mailcmd::parse_request(&payload)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let aborted = |_| BridgeError::denied("mail aborted");
    Ok(match request {
        Request::Send(draft) => {
            let route = tauri::async_runtime::spawn_blocking(|| mailcmd::route(&Keychain)).await.map_err(aborted)?;
            match route {
                Ok(route) => mailcmd::send_route(&route, mailcmd::RESEND_URL, &draft).await,
                Err(answer) => answer,
            }
        }
        Request::Inbox | Request::MarkRead(_) => {
            let cfg = tauri::async_runtime::spawn_blocking(|| mailcmd::imap_config(&Keychain)).await.map_err(aborted)?;
            let cfg = match cfg {
                Ok(c) => c,
                Err(answer) => return Ok(answer),
            };
            let limits = Limits::default();
            match request {
                Request::MarkRead(uid) => mailcmd::read_answer(imapcmd::mark_read(&cfg, &roots(), uid, &limits).await),
                _ => mailcmd::inbox_answer(imapcmd::fetch_inbox(&cfg, &roots(), unix_now(), &limits).await),
            }
        }
        Request::Reply { to, subject } => {
            let url = mailcmd::mailto(&to, &subject);
            tauri::async_runtime::spawn_blocking(move || open_mailto(url)).await.map_err(aborted)??;
            json!({"ok": true})
        }
        Request::OpenClient => {
            let url = mailcmd::mailto_open().to_owned();
            tauri::async_runtime::spawn_blocking(move || open_mailto(url)).await.map_err(aborted)??;
            json!({"ok": true})
        }
    })
}

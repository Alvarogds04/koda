//! #503 «reportar fallos» T2 host: the one closed command `failure_action`. Reachable from the settings window (same gate as
//! `sound_action`). It reads the LOCAL failure store, builds the redacted preview, and — only on the human's «Reportar» click —
//! opens the system browser at a pre-filled GitHub issue (or copies the text when it does not fit in a URL). No token, no API.
use crate::{now_ms, AppState};
use abito_island::bridge::{self, BridgeError};
use abito_island::failure::{self, Env, IssueUrl};
use abito_island::failure_cmd::{self as cmd, Command, Prefs};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

/// «Ahora no»: postponed until the next launch (memory only).
static LATER: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo completar la acción de reportes.".into() }
}

fn open_browser(url: &str) -> Result<(), BridgeError> {
    let mut child = std::process::Command::new("xdg-open").arg(url)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().map_err(|_| err("unavailable"))?;
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

fn view(dir: &std::path::Path) -> Value {
    let prefs = Prefs::load(dir);
    let later = LATER.lock().map(|l| l.clone()).unwrap_or_default();
    let list = cmd::pending(&failure::load_all(dir), &prefs, &later);
    json!({"enabled": prefs.enabled, "pending": cmd::pending_view(&list)})
}

fn run(command: Command, dir: PathBuf) -> Result<Value, BridgeError> {
    let env = Env::detect();
    match command {
        Command::View => Ok(view(&dir)),
        Command::SetEnabled(on) => {
            let mut p = Prefs::load(&dir);
            p.enabled = on;
            p.save(&dir).map_err(|_| err("save_failed"))?;
            Ok(view(&dir))
        }
        Command::Later(fp) => { if let Ok(mut l) = LATER.lock() { l.insert(fp); } Ok(view(&dir)) }
        Command::Never(fp) => {
            let mut p = Prefs::load(&dir);
            if p.muted.len() < 200 { p.muted.insert(fp); }
            p.save(&dir).map_err(|_| err("save_failed"))?;
            Ok(view(&dir))
        }
        Command::Preview(fp) => {
            let all = failure::load_all(&dir);
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
            let rec = cmd::record_for(&all, fp.as_deref(), &env, now).ok_or_else(|| err("not_found"))?;
            let report = failure::build_report(&rec, &cmd::context_lines(&all, &rec), &env.home, &env.user);
            let fingerprint = failure::fingerprint_of(&rec);
            Ok(json!({"title": report.title, "body": report.body, "fingerprint": fingerprint, "searchUrl": failure::search_url(&fingerprint)}))
        }
        Command::Send { title, body } => {
            let out = cmd::outgoing(&title, &body, &env.home, &env.user);
            match out.url {
            IssueUrl::Url(url) => { open_browser(&url)?; Ok(json!({"opened": true, "copied": false})) }
            IssueUrl::TooLong => {
                // too long for a URL: the FULL text goes to the clipboard, the browser opens an empty form to paste it into
                let copied = abito_island::flow::paste::copy(&out.clipboard) == abito_island::flow::paste::Outcome::Copied;
                if !copied { return Err(err("clipboard_unavailable")); }
                open_browser(&format!("https://github.com/{}/issues/new?labels={}", failure::REPO, "bug%2Cauto-report"))?;
                Ok(json!({"opened": true, "copied": true}))
            }
            }
        }
    }
}

/// Closed failure-report command; shapes in `abito_island::failure_cmd::parse_command`.
#[tauri::command]
pub async fn failure_action(webview: tauri::Webview, state: State<'_, AppState>, payload: Value) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = cmd::parse_command(&payload).ok_or_else(|| err("invalid_schema"))?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let dir = failure::default_dir().ok_or_else(|| err("unavailable"))?;
    tauri::async_runtime::spawn_blocking(move || run(command, dir)).await.map_err(|_| err("save_failed"))?
}

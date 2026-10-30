//! One gated command; shared store and engine live for the application lifetime.
use crate::{now_ms, AppState};
use abito_island::{bridge::{self, BridgeError}, dictation_cmd::{self as cmd, Command, Engine, Plan}, flow, speech};
use std::sync::{Arc, Mutex};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct Running {
    dict: flow::Dictation,
    key: flow::portal::HoldKey,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.dict.stop();
    }
}
pub struct Host {
    store: Arc<Mutex<flow::store::Store>>,
    engine: Engine<Running>,
    /// True while a caller is building the resources outside the lock.
    starting: bool,
}
impl Host {
    fn load() -> Self {
        Self { store: Arc::new(Mutex::new(flow::store::Store::load())), engine: Engine { running: None }, starting: false }
    }
}

/// Builds the engine and the portal key. Slow-ish and blocking on nothing the host owns: it never runs
/// under the host lock.
fn build(store: Arc<Mutex<flow::store::Store>>, app: AppHandle) -> Running {
    if speech::is_ready() { speech::preload(); }
    let notify = Arc::new(move |update| {
        let (name, payload) = cmd::event(update);
        let _ = app.emit(name, payload);
    });
    let dict = flow::Dictation::start(store, flow::ClaudeSystem, notify);
    let key = flow::portal::listen(dict.sender(), "Mantén pulsada la tecla para dictar", "CTRL+ALT+v");
    Running { dict, key }
}

/// Applies the enabled preference: decide under the lock, act outside it. Stopping joins the engine
/// thread (it may be transcribing), so the value is dropped on its own thread and the command returns.
fn sync(app: &AppHandle) {
    let slot = app.state::<Mutex<Host>>();
    let (plan, store) = {
        let mut host = slot.lock().expect("dictation host");
        // abito-pausa: a paused feature never starts, whatever its stored preference says (the preference itself is kept)
        let enabled = abito_island::paused::effective(abito_island::paused::Feature::Dictation, host.store.lock().expect("dictation store").prefs.enabled);
        let starting = host.starting;
        let plan = host.engine.plan(enabled, starting);
        if matches!(plan, Plan::Start) { host.starting = true; }
        (plan, host.store.clone())
    };
    match plan {
        Plan::Keep => {}
        Plan::Stop(running) => { std::thread::spawn(move || drop(running)); }
        Plan::Start => {
            let running = build(store, app.clone());
            let rejected = {
                let mut host = slot.lock().expect("dictation host");
                host.starting = false;
                let wanted = abito_island::paused::effective(abito_island::paused::Feature::Dictation, host.store.lock().expect("dictation store").prefs.enabled);
                host.engine.install(running, wanted)
            };
            if let Some(unused) = rejected { std::thread::spawn(move || drop(unused)); }
        }
    }
}
pub fn start(app: &AppHandle) {
    app.manage(Mutex::new(Host::load()));
    sync(app);
}
fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo completar la acción de dictado.".into() }
}

#[tauri::command]
pub async fn dictation_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    tauri::async_runtime::spawn_blocking(move || {
        // Device enumeration and model files are slow: none of it happens under the host lock.
        let devices = if matches!(payload["action"].as_str(), Some("set_prefs" | "status")) { speech::audio::input_devices() } else { vec![] };
        let names = devices.iter().map(|d| d.name.clone()).collect::<Vec<_>>();
        use abito_island::secrets::{Keychain, SecretStore};
        let has_claude_key = matches!(payload["action"].as_str(), Some("set_prefs" | "status"))
            && Keychain.read("anthropic-api-key").ok().flatten().is_some_and(|v| !v.is_empty());
        let command = cmd::parse_command(&payload, &names, has_claude_key).ok_or_else(|| err("invalid_schema"))?;
        let slot = app.state::<Mutex<Host>>();
        match command {
            Command::Status => {
                let (key, prefs) = {
                    let host = slot.lock().expect("dictation host");
                    let key = host.engine.running.as_ref().map(|r| r.key.status()).unwrap_or(flow::portal::KeyStatus::Active);
                    let prefs = host.store.lock().expect("dictation store").prefs.clone();
                    (key, prefs)
                };
                Ok(cmd::status_json(&prefs, speech::status(), key, devices, has_claude_key))
            }
            command @ (Command::CopyEntry(_) | Command::CopyLast) => {
                let shared = slot.lock().expect("dictation host").store.clone();
                let text = {
                    let store = shared.lock().expect("dictation store");
                    cmd::clipboard_text(&command, &store).ok_or_else(|| err("not_found"))?
                };
                if flow::paste::copy(&text) != flow::paste::Outcome::Copied {
                    return Err(err("clipboard_refused"));
                }
                Ok(json!({"ok":true,"copied":true}))
            }
            Command::RunningApps => Ok(cmd::running_apps_json(flow::running_apps())),
            Command::SetPrefs(prefs) => {
                {
                    let shared = slot.lock().expect("dictation host").store.clone();
                    let mut store = shared.lock().expect("dictation store");
                    store.prefs = prefs.clone();
                    store.save_prefs();
                }
                sync(&app);
                Ok(json!(prefs))
            }
            data @ (Command::History | Command::Stats | Command::Words | Command::Snippets
                | Command::Styles | Command::DeleteEntry(_) | Command::ClearHistory(_)
                | Command::SetWords(..) | Command::SetSnippets(_) | Command::SetStyles(_)) => {
                let shared = slot.lock().expect("dictation host").store.clone();
                let today = flow::store::today();
                let mut store = shared.lock().expect("dictation store");
                let changed = matches!(data, Command::DeleteEntry(_) | Command::ClearHistory(_));
                let result = cmd::data_action(data, &mut store, today);
                drop(store);
                if changed { let _ = app.emit("dictation:history", json!({})); }
                Ok(result)
            }
            Command::Download => {
                let app = app.clone();
                speech::download(move |models| {
                    let (name, payload) = cmd::models_event(models);
                    let _ = app.emit(name, payload);
                });
                Ok(json!(speech::status()))
            }
            Command::Remove => {
                speech::remove(); // also unloads the recognizer
                Ok(json!(speech::status()))
            }
            Command::Key(event) => {
                let host = slot.lock().expect("dictation host");
                if let Some(running) = &host.engine.running {
                    running.dict.send(event);
                    Ok(json!({"ok":true}))
                } else { Ok(json!({"ok":false})) }
            }
        }
    }).await.map_err(|_| err("unavailable"))?
}

/// Validator-only seed through the real private store, never microphone input.
#[cfg(any(debug_assertions, feature = "probe"))]
pub fn seed_validation(app: &AppHandle) {
    let slot = app.state::<Mutex<Host>>();
    let shared = slot.lock().expect("dictation host").store.clone();
    let mut store = shared.lock().expect("dictation store");
    store.prefs.keep_days = 30;
    store.save_prefs();
    store.record("Dictado privado del validador", None, 2.0, flow::store::today(), flow::store::now_ms());
}

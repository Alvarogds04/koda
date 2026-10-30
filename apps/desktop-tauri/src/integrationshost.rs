//! #489 host: the `integration_action` command and the `integration:update` island event.
//!
//! Adapted from Coucou windows/src-tauri/src/integrations.rs @71b773f, Copyright (c) 2026 Louis
//! Raillé, MIT (the timers and the emit; the pollers live in `abito_island::integrations`).
//! One thread per service wakes on Coucou's cadence and does NOTHING unless the human declared
//! that pill (main or declared) and saved its key: no declared pill, no request. The last update
//! of each service is cached so the card opens with data. The island window only.
use abito_island::bridge::{self, BridgeError};
use abito_island::integrations::{self as integ, Command, Seen};
use abito_island::integrations_net::Net;
use abito_island::secrets::Keychain;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Webview};

use crate::AppState;

fn cache() -> &'static Mutex<HashMap<&'static str, Value>> {
    static CACHE: OnceLock<Mutex<HashMap<&'static str, Value>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// S2 (#503): the last update of every DECLARED service, as the island holds it. No poll, no wait.
pub fn cached_updates(app: &AppHandle) -> Vec<Value> {
    let Ok(map) = cache().try_lock() else { return Vec::new() };
    let mut out: Vec<(&&str, &Value)> = map.iter().filter(|(id, _)| is_declared(app, id)).collect();
    out.sort_by_key(|(id, _)| **id);
    out.into_iter().map(|(_, u)| u.clone()).collect()
}

fn seen() -> &'static Seen {
    static SEEN: OnceLock<Seen> = OnceLock::new();
    SEEN.get_or_init(Seen::default)
}

fn is_declared(app: &AppHandle, id: &str) -> bool {
    crate::settingshost::pill_declared(&app.state::<AppState>().settings, id)
}

/// Polls one service when it is declared; caches and emits what it says.
fn run_poll(app: &AppHandle, id: &'static str) {
    #[cfg(any(debug_assertions, feature = "probe"))]
    let fixture = validation_fixture().lock().unwrap().clone();
    #[cfg(any(debug_assertions, feature = "probe"))]
    if let Some((origin, mode)) = fixture {
        let previous = cache().lock().unwrap().get(id).cloned();
        let update = integ::refresh_snapshot(id, &FixtureHttp {origin,mode,id}, &FixtureKeys(mode != "missing_key"), seen(), previous.as_ref(), crate::now_ms() as u64);
        cache().lock().unwrap().insert(id,update.clone());
        let _ = app.emit_to("main",integ::UPDATE_EVENT,update);
        return;
    }
    if !is_declared(app, id) {
        seen().forget(id.trim_start_matches("integration_"));
        cache().lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        return;
    }
    let previous = cache().lock().unwrap_or_else(|e|e.into_inner()).get(id).cloned();
    let update = integ::refresh_snapshot(id, &Net, &Keychain, seen(), previous.as_ref(), crate::now_ms() as u64);
    cache().lock().unwrap_or_else(|e|e.into_inner()).insert(id, update.clone());
    let _ = app.emit_to("main", integ::UPDATE_EVENT, update);
}

/// Starts one timer thread per poller (Coucou's first-run delay and interval).
pub fn start(app: &AppHandle) {
    // abito-pausa: integrations are paused in this version — no poller thread, no network
    if abito_island::paused::paused(abito_island::paused::Feature::Integrations) { return; }
    for (id, delay, every) in integ::POLLERS {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(delay));
            loop {
                run_poll(&app, id);
                std::thread::sleep(Duration::from_secs(every));
            }
        });
    }
}

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo consultar la integración.".into() }
}

/// `{action:"view"}` → `{updates:{<id>:Update}}` (cached, declared services only);
/// `{action:"refresh", id}` polls that service now, then answers like `view`.
#[tauri::command]
pub async fn integration_action(app: AppHandle, webview: Webview, payload: Value) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = integ::parse_command(&payload).ok_or_else(|| err("invalid_schema"))?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Command::Refresh(id) = command {
            run_poll(&app, id);
        }
        let map = cache().lock().unwrap_or_else(|e| e.into_inner());
        let updates: serde_json::Map<String, Value> = map
            .iter()
            .filter(|(id, _)| is_declared(&app, id) || fixture_active())
            .map(|(id, u)| (id.to_string(), serde_json::to_value(u).unwrap_or(Value::Null)))
            .collect();
        json!({ "updates": updates })
    })
    .await
    .map_err(|_| err("unavailable"))
}

fn fixture_active() -> bool {
    #[cfg(any(debug_assertions, feature = "probe"))]
    { return validation_fixture().lock().unwrap().is_some(); }
    #[cfg(not(any(debug_assertions, feature = "probe")))]
    { false }
}
#[cfg(any(debug_assertions, feature = "probe"))]
fn validation_fixture() -> &'static Mutex<Option<(String,&'static str)>> {
    static FIXTURE: OnceLock<Mutex<Option<(String,&'static str)>>> = OnceLock::new();
    FIXTURE.get_or_init(||Mutex::new(None))
}
#[cfg(any(debug_assertions, feature = "probe"))]
pub fn set_validation_fixture(origin: Option<&str>, mode: &'static str) {
    let endpoint = origin.filter(|s|s.starts_with("http://127.0.0.1:"))
        .map(|s|(s.to_string(),mode));
    *validation_fixture().lock().unwrap() = endpoint;
}
#[cfg(any(debug_assertions, feature = "probe"))]
struct FixtureKeys(bool);
#[cfg(any(debug_assertions, feature = "probe"))]
impl abito_island::secrets::SecretStore for FixtureKeys {
    fn read(&self, key:&str)->Result<Option<String>,abito_island::secrets::StoreError> {
        Ok(self.0.then(||if key=="n8n-url" {"http://127.0.0.1".into()} else {"validator".into()}))
    }
    fn write(&self,_:&str,_:&str)->Result<(),abito_island::secrets::StoreError>{unreachable!()}
    fn delete(&self,_:&str)->Result<(),abito_island::secrets::StoreError>{unreachable!()}
}
#[cfg(any(debug_assertions, feature = "probe"))]
struct FixtureHttp { origin:String, mode:&'static str, id:&'static str }
#[cfg(any(debug_assertions, feature = "probe"))]
impl integ::Http for FixtureHttp {
    fn send(&self,_:&str,_:&str,_:&[(&str,&str)],_:Option<&str>)->Result<integ::Response,integ::NetError> {
        integ::Http::send(&Net,"GET",&format!("{}/{}/{}",self.origin,self.mode,self.id),&[],None)
    }
}

//! Unit U2 host wiring: the `models_action` command, the `models:state`
//! event, the selection → chat target binding and its 0600 persistence.
//!
//! - list: last listing (no network); refresh: four metadata GETs per
//!   SELECTABLE local origin + RAM/GPU counters (never inference, never a
//!   diagnostic port); select: a registered selectable profile only.
//! - A selection takes effect on the NEXT turn: a running turn keeps the
//!   target it froze at submit (no halfway swap).
//! - Persistence: `models-selection.json` (`{"v":1,"selected":…}`) in the
//!   app config dir (`com.abitog.AbitoTauri`, never the Preview's), dir 0700,
//!   file 0600, written atomically, read with O_NOFOLLOW. The probe never
//!   writes the user's config: without `ABITO_MODELS_CONFIG_DIR` it keeps the
//!   selection in memory only.

use std::path::PathBuf;
use std::sync::atomic::Ordering;

use abito_island::bridge::{self, BridgeError};
use abito_island::chat::{ChatError, ProfileRef};
use abito_island::chatlane::{Target, ISLAND_MAX_OUTPUT_TOKENS};
use abito_island::localmodel::LocalEndpoint;
use abito_island::models::{self, Entry, ModelsCommand, Saved};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{chathost, now_ms, probe_requested, AppState, QUITTING};

pub const CONFIG_ENV: &str = "ABITO_MODELS_CONFIG_DIR";

fn err(e: ChatError) -> BridgeError {
    BridgeError {
        code: e.code,
        message: e.safe_message,
    }
}

/// Where the selection lives, or `None` = memory only (probe without an
/// explicit override, or no config dir).
pub fn config_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var(CONFIG_ENV) {
        let path = PathBuf::from(dir);
        return path.is_absolute().then_some(path);
    }
    if probe_requested() {
        return None;
    }
    app.path().app_config_dir().ok()
}

pub fn target_of(entry: &Entry) -> Option<Target> {
    Some(Target {
        endpoint: LocalEndpoint::parse(entry.origin).ok()?,
        alias: entry.alias?.to_string(),
        profile: ProfileRef {
            profile_id: entry.profile_id.to_string(),
            revision: entry.revision,
            lane_id: entry.lane_id.to_string(),
        },
        max_output: ISLAND_MAX_OUTPUT_TOKENS,
    })
}

/// Startup: resolve the saved selection (fail closed) into the chat target.
pub fn registry(state: &AppState) -> Vec<Entry> {
    state.models_registry.lock().expect("models registry lock").clone()
}

pub fn load_selection(app: &AppHandle, state: &AppState) {
    #[cfg(unix)]
    let saved = match config_dir(app) {
        Some(dir) => models::read_saved_file(&dir),
        None => Saved::Absent,
    };
    #[cfg(not(unix))]
    let saved = {
        if config_dir(app).is_some() {
            eprintln!("models: saved selection restore unavailable on this platform");
        }
        Saved::Absent
    };
    *state.chat_cloud.lock().expect("cloud selection lock") = match &saved {
        Saved::Selected(id) => abito_island::cloudprofiles::select_credentialed(id, &abito_island::secrets::Keychain).ok(),
        _ => None,
    };
    let target = models::initial_selection(&saved).and_then(target_of);
    if target.is_none() && state.chat_cloud.lock().expect("cloud selection lock").is_none() {
        eprintln!("models: saved selection invalid or unknown — no local model selected");
    }
    *state.chat_target.lock().expect("chat target lock") = target;
}

fn selected_id(state: &AppState) -> Option<String> {
    if let Some(e) = *state.chat_cloud.lock().expect("cloud selection lock") { return Some(e.id.into()); }
    state
        .chat_target
        .lock()
        .expect("chat target lock")
        .as_ref()
        .map(|t| t.profile.profile_id.clone())
}

/// A cloud selection whose credential is gone (sign-out, key removed) falls back to the saved LOCAL choice, is persisted and
/// announced, so the picker never keeps showing a provider that cannot answer. Blocking (keychain): call off the main thread.
pub fn reconcile_cloud(app: &AppHandle) {
    let state = app.state::<AppState>();
    let current = *state.chat_cloud.lock().expect("cloud selection lock");
    if current.is_none() || abito_island::cloudprofiles::reconcile(current, &abito_island::secrets::Keychain).is_some() { return; }
    *state.chat_cloud.lock().expect("cloud selection lock") = None;
    #[cfg(unix)]
    if let (Some(dir), Some(t)) = (config_dir(app), state.chat_target.lock().expect("chat target lock").as_ref()) {
        let _ = models::write_saved_file(&dir, &t.profile.profile_id);
    }
    state.chat.lock().expect("chat lane lock").availability = abito_island::chatlane::Availability::unchecked();
    refresh(&state);
    publish_models(app);
    chathost::publish_chat(app);
}

/// Re-read local metadata (blocking: call off the main thread).
pub fn refresh(state: &AppState) -> Value {
    let registry = registry(state);
    let metas = models::read_all(&registry);
    let res = models::read_resources();
    let revision = state.models_revision.fetch_add(1, Ordering::SeqCst) + 1;
    let v = models::listing(&registry, &metas, &res, selected_id(state).as_deref(), revision);
    *state.models_last.lock().expect("models lock") = v.clone();
    v
}

fn last(state: &AppState) -> Value {
    let mut v = state.models_last.lock().expect("models lock").clone();
    if v.is_null() {
        v = json!({"revision": 0, "profiles": [], "selected": selected_id(state),
                   "choice_note": "Todavía no se leyeron los modelos locales.",
                   "remote": "Sin nube y sin claves: sólo modelos de esta máquina."});
    }
    let mut profiles = v["profiles"].as_array().cloned().unwrap_or_default();
    profiles.extend(abito_island::cloudprofiles::cloud_entries(&abito_island::secrets::Keychain).into_iter().map(|e| e.listing()));
    v["profiles"] = json!(profiles);
    v["remote"] = json!("Nube: sólo proveedores con credencial en Ajustes → Chat.");
    v["selected"] = json!(selected_id(state));
    v["persisted"] = json!(state.models_persisted.load(Ordering::SeqCst));
    v
}

pub fn publish_models(app: &AppHandle) {
    if QUITTING.load(Ordering::SeqCst) {
        return;
    }
    let state = app.state::<AppState>();
    if let Err(e) = app.emit("models:state", &last(&state)) {
        eprintln!("models:state emit failed: {e}");
    }
}

/// Explicit selection: registered + selectable only; effective next turn.
pub fn select(app: &AppHandle, state: &AppState, profile_id: &str) -> Result<(), BridgeError> {
    let registry = registry(state);
    if profile_id.starts_with("cloud-") {
        let cloud = abito_island::cloudprofiles::select_credentialed(profile_id, &abito_island::secrets::Keychain).map_err(err)?;
        *state.chat_cloud.lock().expect("cloud selection lock") = Some(cloud);
    } else {
        let entry = models::select(&registry, profile_id).map_err(err)?;
        let target = target_of(entry).ok_or_else(|| err(ChatError::profile_missing()))?;
        *state.chat_target.lock().expect("chat target lock") = Some(target);
        *state.chat_cloud.lock().expect("cloud selection lock") = None;
    }
    #[cfg(unix)]
    let persisted = match config_dir(app) {
        Some(dir) => match models::write_saved_file(&dir, profile_id) {
            Ok(()) => true,
            Err(e) => {
                eprintln!("models: selection not persisted: {e}");
                false
            }
        },
        None => false,
    };
    #[cfg(not(unix))]
    let persisted = {
        if config_dir(app).is_some() {
            eprintln!("models: selection persistence unavailable on this platform");
        }
        false
    };
    state.models_persisted.store(persisted, Ordering::SeqCst);
    // the chat's availability belongs to the previous target: re-check it
    state.chat.lock().expect("chat lane lock").availability =
        abito_island::chatlane::Availability::unchecked();
    Ok(())
}

/// `models_action`: sender gate → payload shape → rate → dispatch.
#[tauri::command]
pub async fn models_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = models::parse_models_command(&payload).map_err(err)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    match command {
        ModelsCommand::List => Ok(last(&state)),
        ModelsCommand::Refresh | ModelsCommand::Select { .. } => {
            if let ModelsCommand::Select { profile_id } = &command {
                select(&app, &state, profile_id)?;
            }
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                reconcile_cloud(&handle);
                let state = handle.state::<AppState>();
                refresh(&state);
                publish_models(&handle);
                chathost::publish_chat(&handle);
                last(&state)
            })
            .await
            .map_err(|_| BridgeError::denied("models refresh aborted"))
        }
    }
}

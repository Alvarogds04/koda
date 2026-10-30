//! #327 — serialized manual specialist commands and immutable per-turn configuration.
//! No model calls: target resolution uses only the existing verified local registry.
//! The picker selection is never overwritten. Disk commit precedes state publication.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use abito_island::bridge::{self, BridgeError};
use abito_island::chat::ChatError;
use abito_island::chatlane::Target;
use abito_island::models::{self, Entry};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::specialists::{self, Command, Specialist, Store};
use crate::{modelshost, now_ms, probe_requested, AppState, QUITTING};

pub const CONFIG_ENV: &str = "ABITO_SPECIALISTS_CONFIG_DIR";

#[derive(Debug, Default)]
pub struct SpecialistsHost {
    // Covers the entire read/validate/persist/commit/publish transaction, not just the write.
    operations: Mutex<()>,
    store: Mutex<Store>,
    persisted: AtomicBool,
    load_error: AtomicBool,
}

impl SpecialistsHost {
    /// Startup and tests use the same load path. A failed load remains latched until restart;
    /// no command retries, repairs, resets or replaces the original file.
    fn load(&self, dir: Option<&Path>) {
        let _operation = self.operations.lock().expect("specialists operation lock");
        let loaded = dir.map(specialists::read_file).unwrap_or_else(|| Ok(Store::default()));
        let failed = loaded.is_err();
        *self.store.lock().expect("specialists lock") = loaded.unwrap_or_default();
        self.load_error.store(failed, Ordering::SeqCst);
        self.persisted.store(dir.is_some() && !failed, Ordering::SeqCst);
    }

    pub fn snapshot(&self) -> Store {
        self.store.lock().expect("specialists lock").clone()
    }

    pub fn role(&self) -> Option<Specialist> {
        self.store.lock().expect("specialists lock").active().cloned()
    }

    fn view(&self) -> Value {
        let store = self.snapshot();
        let items: Vec<Value> = store.items.iter().map(|s| {
            json!({"id": s.id, "name": s.name, "instructions": s.instructions, "model": s.model,
                "space": s.space, "spaces": s.spaces, "permissions": s.permissions.iter().map(|p| p.as_str()).collect::<Vec<_>>()})
        }).collect();
        json!({"v": 1, "active": store.active, "specialists": items,
            "persisted": self.persisted.load(Ordering::SeqCst),
            "load_error": self.load_error.load(Ordering::SeqCst)})
    }

    /// The same dispatcher is called by IPC and isolated host tests. Publication is inside the
    /// transaction: concurrent commands cannot lose updates or emit snapshots out of order.
    fn execute(
        &self,
        dir: Option<&Path>,
        registry: &[Entry],
        command: Command,
        mut publish: impl FnMut(&Value),
    ) -> Result<Value, BridgeError> {
        let _operation = self.operations.lock().expect("specialists operation lock");
        if command == Command::View { return Ok(self.view()); }
        if self.load_error.load(Ordering::SeqCst) {
            return Err(err("load_error", "No se pudieron cargar los especialistas; no se cambió nada."));
        }
        let current = self.snapshot();
        let next = match command {
            Command::View => unreachable!("view handled before mutation guard"),
            Command::Create { id, name, instructions, model, space, spaces, permissions } => {
                check_model(registry, &model)?;
                specialists::create(&current, Specialist { id, name, instructions, model, space, spaces, permissions })
            }
            Command::Update { id, name, instructions, model, space, spaces, permissions } => {
                check_model(registry, &model)?;
                specialists::update(&current, &id, &name, &instructions, model, space, spaces, permissions)
            }
            Command::Delete { id } => specialists::remove(&current, &id),
            Command::Select { id } => {
                if let Some(role) = id.as_deref().and_then(|id| current.find(id)) {
                    check_model(registry, &role.model)?;
                }
                specialists::select(&current, id.as_deref())
            }
        }.map_err(|_| err("invalid_specialist", "No se pudo cambiar el especialista; no se cambió nada."))?;
        specialists::commit(&self.store, &self.persisted, dir, next)
            .map_err(|_| err("not_saved", "No se pudo guardar el especialista; no se cambió nada."))?;
        let view = self.view();
        publish(&view);
        Ok(view)
    }
}

fn err(code: &str, message: &str) -> BridgeError {
    BridgeError { code: code.into(), message: message.into() }
}

pub fn config_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var(CONFIG_ENV) {
        let path = PathBuf::from(dir);
        return path.is_absolute().then_some(path);
    }
    if probe_requested() { return None; }
    app.path().app_config_dir().ok()
}

pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let dir = config_dir(app);
    state.specialists.load(dir.as_deref());
}

fn check_model(registry: &[Entry], model: &Option<String>) -> Result<(), BridgeError> {
    let Some(id) = model else { return Ok(()) };
    models::select(registry, id).map(|_| ()).map_err(|_| {
        err("model_missing", "Ese modelo local no está verificado; no se cambió nada.")
    })
}

/// Resolve BOTH values from ONE immutable role snapshot. A subsequent edit/selection cannot
/// combine a previous role's model with a new role's instructions. No network or file writes.
fn resolve_turn(
    role: Option<&Specialist>,
    fallback: Option<Target>,
    registry: &[Entry],
    base: &str,
    principal_instructions: Option<&str>,
) -> Result<(Option<Target>, String), ChatError> {
    let target = match role.and_then(|r| r.model.as_deref()) {
        None => fallback,
        Some(id) => Some(modelshost::target_of(models::select(registry, id)?)
            .ok_or_else(ChatError::profile_missing)?),
    };
    Ok((target, specialists::system_prompt_with_principal(base, role, principal_instructions)))
}

pub fn turn_configuration(state: &AppState, base: &str) -> Result<(Option<Target>, String), ChatError> {
    turn_snapshot(state, base).map(|(target, system, _)| (target, system))
}

/// #341 uses the SAME role snapshot for the prompt, target and conversation association.
/// Copy prefs while holding the role lock: both values coexist at the prefs read, and
/// subsequent edits cannot mix a new role or new principal instructions into this turn.
pub fn turn_snapshot(state: &AppState, base: &str) -> Result<(Option<Target>, String, Option<abito_island::conversations::SpecialistRef>), ChatError> {
    turn_snapshot_selected(state, base).map(|(target, system, specialist, _)| (target, system, specialist))
}

/// Freeze the role and cloud selection together; an explicitly local role always wins.
pub fn turn_snapshot_selected(state: &AppState, base: &str) -> Result<(Option<Target>, String, Option<abito_island::conversations::SpecialistRef>, Option<abito_island::cloudprofiles::CloudSelection>), ChatError> {
    let (role, principal_instructions) = {
        let store = state.specialists.store.lock().expect("specialists lock");
        let instructions = crate::settingshost::abito_instructions(&state.settings);
        (store.active().cloned(), instructions)
    };
    let fallback = state.chat_target.lock().expect("chat target lock").clone();
    let registry = modelshost::registry(state);
    let cloud = if role.as_ref().is_some_and(|r| r.model.is_some()) { None } else { *state.chat_cloud.lock().expect("cloud selection lock") };
    let cloud_base = base.replace("Funcionas con un modelo local de esta máquina. ", abito_island::chatlane::CLOUD_MODEL_PROMPT);
    let base = if cloud.is_some() { &cloud_base } else { base };
    let (target, system) = resolve_turn(role.as_ref(), fallback, &registry, base, principal_instructions.as_deref())?;
    let specialist = role.map(|s| abito_island::conversations::SpecialistRef { id: s.id, name: s.name });
    Ok((target, system, specialist, cloud))
}

/// Restore a conversation's creation-time role identity without inventing a replacement role.
/// Missing roles fall back to the principal; existing roles keep the normal local-model checks.
pub fn select_conversation_role(app: &AppHandle, state: &AppState, id: Option<&str>) -> Result<bool, BridgeError> {
    let store = state.specialists.snapshot();
    let missing = id.is_some_and(|id| store.find(id).is_none());
    let selected = id.filter(|_| !missing).map(str::to_owned);
    state.specialists.execute(config_dir(app).as_deref(), &modelshost::registry(state), Command::Select { id: selected }, |view| {
        if !QUITTING.load(Ordering::SeqCst) { let _ = app.emit("specialists:state", view); }
    })?;
    Ok(missing)
}

pub fn effective_target(state: &AppState) -> Result<Option<Target>, ChatError> {
    turn_configuration(state, abito_island::chatlane::SYSTEM_PROMPT).map(|(target, _)| target)
}

#[tauri::command]
pub async fn specialists_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = specialists::parse_command(&payload)
        .map_err(|_| err("invalid_schema", "Pedido de especialistas inválido."))?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let registry = modelshost::registry(&state);
    let deleted = match &command { Command::Delete { id } => Some(id.clone()), _ => None };
    let view = state.specialists.execute(config_dir(&app).as_deref(), &registry, command, |view| {
        if !QUITTING.load(Ordering::SeqCst) {
            if let Err(e) = app.emit("specialists:state", view) {
                eprintln!("specialists:state emit failed: {e}");
            }
        }
    })?;
    // #442 T7.4: a deleted specialist also leaves the island order (read-time filtering covers a failure here).
    if let Some(id) = deleted { crate::settingshost::prune_island_agent(&app, &id); }
    Ok(view)
}

#[cfg(test)]
#[path = "specialistshost_tests.rs"]
mod tests;

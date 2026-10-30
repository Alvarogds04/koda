//! Unit U1 host wiring: the `chat_action` command, the `chat:state` event,
//! and the overview <-> chat resize of the SAME island window.
//!
//! The WebView sends only the closed `chat::Command` set (validated here:
//! sender gate, size/shape, rate) — never an endpoint, alias, key or
//! approval. Rust owns the target (U2 picker) and the single loopback
//! request per turn (`chatlane`). Nothing in this file touches the desktop
//! snapshot shape (`desktop:state` keeps its 13 keys).

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use abito_island::bridge::{self, BridgeError};
use abito_island::chat::{self, Command};
use abito_island::chatlane::{self, Target};
use abito_island::core::ViewPlan;
use abito_island::conversations::SpecialistRef;
use abito_island::desktop::IslandState;
use abito_island::geometry;
use abito_island::localmodel::DEFAULT_DEADLINES;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    main_window, now_ms, publish, refresh_work_area, specialistshost, store_requested, AppState, TauriIo,
    QUITTING,
};

/// #343 hardening: paths the OS reported DROPPING on the main window,
/// recorded natively by `main.rs`'s window event handler. `chat_attach`
/// only ever honours a member of this set: short-lived (60 s TTL), bounded
/// (16 entries) and one-shot, so the page can never name an arbitrary path.
static NATIVE_DROPS: Mutex<abito_island::uploads::DropSet> =
    Mutex::new(abito_island::uploads::DropSet::new());

/// Record a native `WindowEvent::DragDrop(Drop)` on the main window.
pub(crate) fn record_drops(paths: Vec<PathBuf>) {
    NATIVE_DROPS
        .lock()
        .expect("native drop paths lock")
        .record(paths, now_ms() as u64);
}

fn chat_error(e: chat::ChatError) -> BridgeError {
    BridgeError {
        code: e.code,
        message: e.safe_message,
    }
}

/// The selected local target of ONE turn. U2 fills the picker's selection; #327 overrides it with
/// the active specialist's own model when that role names one, and refuses the send (instead of
/// substituting another model) when the named one is no longer selectable.
pub fn current_target(state: &AppState) -> Option<Target> {
    specialistshost::effective_target(state).ok().flatten()
}

fn current_cloud(state: &AppState) -> Option<abito_island::cloudprofiles::CloudSelection> {
    if state.specialists.role().is_some_and(|r| r.model.is_some()) { return None; }
    *state.chat_cloud.lock().expect("cloud selection lock")
}

fn prepare_target(local: Option<Target>, cloud: Option<abito_island::cloudprofiles::CloudSelection>, source: &dyn abito_island::cloudmodel::CredentialSource) -> Result<chatlane::TargetSelection, chat::ChatError> {
    if let Some(e) = cloud {
        // OAuth refresh owns a synchronous runtime: never nest it in Tauri's runtime.
        std::thread::scope(|s| s.spawn(|| source.credential(&e.profile())).join())
            .map_err(|_| e.missing())?.map_err(|_| e.missing())?;
        Ok(chatlane::TargetSelection::Cloud(e.target()))
    } else {
        Ok(chatlane::TargetSelection::Local(local.ok_or_else(chat::ChatError::profile_missing)?))
    }
}

fn cloud_availability(e: abito_island::cloudprofiles::Entry) -> chatlane::Availability {
    if e.present(&abito_island::secrets::Keychain) {
        chatlane::Availability { state: "ready", message: "Credencial presente.".into() }
    } else { chatlane::Availability { state: "blocked", message: e.missing().safe_message } }
}

/// `chat:state` payload: the conversation projection, the current view, the
/// chat geometry (from the ONE Rust constant) and the target's visible
/// identity (origin + alias, never a credential — there is none).
pub fn chat_view(app: &AppHandle, state: &AppState) -> Value {
    let _ = app;
    let mut v = state.chat.lock().expect("chat lane lock").view();
    v["display_name"] = json!(crate::settingshost::display_name(&state.settings));
    let chat_open = state.core.lock().expect("core lock").chat
        && *state.phase.lock().expect("phase lock") == IslandState::Expanded;
    v["view"] = json!(if chat_open { "chat" } else { "overview" });
    // #309: the column's height follows the work area, so Rust computes it from the current one
    let area = *state.work_area.lock().expect("work area lock");
    // #431: off-main caller (chat_action, lane locks taken): read the
    // main-thread scale cache, never the blocking window scale getter.
    let scale = crate::cached_scale();
    let asked = state.core.lock().expect("core lock").chat_height();
    let (cw, ch) = geometry::chat_visible_for(area.h, scale, asked);
    v["chat_visible"] = json!([cw, ch]);
    v["target"] = if let Some(e) = current_cloud(state) {
        let a = cloud_availability(e);
        v["availability"] = json!({"state": a.state, "message": a.message});
        e.view()
    } else { match current_target(state) {
        Some(t) => json!({
            "origin": t.endpoint.origin(),
            "alias": t.alias,
            "profile_id": t.profile.profile_id,
            "profile_revision": t.profile.revision,
            "max_output_tokens": t.max_output,
        }),
        None => Value::Null,
    }};
    v["producer"] = json!({
        "pi": "not_connected",
        "note": "Chat con el modelo local. El productor de Pi no existe todavía en el escritorio."
    });
    if current_cloud(state).is_some() {
        v["producer"]["note"] = json!("Chat con el proveedor de nube elegido. No requiere Pi.");
    }
    v
}

pub fn publish_chat(app: &AppHandle) {
    if QUITTING.load(Ordering::SeqCst) {
        return;
    }
    let state = app.state::<AppState>();
    let v = chat_view(app, &state);
    if let Err(e) = app.emit("chat:state", &v) {
        eprintln!("chat:state emit failed: {e}");
    }
}

/// Apply an overview <-> chat plan inside the fixed native window.
/// Only the page animates its visible island; input-shape reports follow it.
pub fn apply_view(app: &AppHandle, state: &AppState, plan: ViewPlan) {
    let ViewPlan {
        chat,
        size: (w, h),
        rect: r,
        visible: (vw, vh),
        ..
    } = plan;
    store_requested(state, if chat { "chat" } else { "overview" }, Some((r.x, r.y)), Some((w, h)));
    state.generation.fetch_add(1, Ordering::SeqCst);
    let Some(win) = main_window(app) else { return };
    let push = format!(
        "window.__islandSetView && window.__islandSetView('{}',{vw},{vh});",
        if chat { "chat" } else { "overview" }
    );
    crate::ensure_island_window(app);
    let _ = win.eval(push);
}

/// Switch the expanded island to the chat (`true`) or the overview.
pub fn switch_view(app: &AppHandle, state: &AppState, chat: bool) {
    if *state.phase.lock().expect("phase lock") != IslandState::Expanded {
        return; // the chat opens only from the overview, never from compact
    }
    let area = refresh_work_area(app, state);
    let Some(win) = main_window(app) else { return };
    let io = TauriIo(&win);
    let plan = state
        .core
        .lock()
        .expect("core lock")
        .plan_view(&io, area, chat);
    let opened = plan.as_ref().is_some_and(|p| p.chat);
    if let Some(plan) = plan {
        apply_view(app, state, plan);
    }
    publish_chat(app);
    if opened {
        capture_window_context(app);
        if current_cloud(state).is_some() { return; }
        if current_target(state).is_none() {
            state.chat.lock().expect("chat lane lock").availability = chatlane::Availability {
                state: "blocked",
                message: "No hay un modelo local elegido. Elegilo en «Modelo».".to_string(),
            };
            publish_chat(app);
        }
        // Say "unavailable" before anyone types: metadata only, no prompt.
        if let Some(target) = current_target(state) {
            let lane = Arc::clone(&state.chat);
            let app = app.clone();
            std::thread::spawn(move || {
                chatlane::check(&lane, &target);
                publish_chat(&app);
            });
        }
    }
}

/// #487 (NotchBuddy feature 8): when the chat opens with the opt-in ON, read the previous window
/// once (off the UI thread). With the switch off nothing is read at all.
fn capture_window_context(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !crate::settingshost::window_context(&state.settings) {
        state.chat_context.lock().expect("chat context lock").on_chat_open(false, || None);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let enabled = crate::settingshost::window_context(&state.settings);
        let mut cx = state.chat_context.lock().expect("chat context lock");
        cx.on_chat_open(enabled, || abito_island::contextwin::capture(None, None));
    });
}

/// S1/S2 (#503): the live-state snapshot of THIS turn, from what the island already holds
/// (cached agent sessions, pending question, settled notices, cached GitHub pulse, cached
/// integration updates). Nothing here fetches; `None` when the switch is off or there is nothing.
fn live_snapshot(app: &AppHandle, state: &AppState) -> Option<abito_island::chatsnapshot::Snapshot> {
    if !crate::settingshost::live_context(&state.settings) {
        return None;
    }
    let sessions = state.settings.agent.try_lock().ok()
        .and_then(|a| a.as_ref().map(|c| c.view()["sessions"].clone()))
        .unwrap_or(Value::Null);
    let notices = state.notices.lock().expect("notices lock").snapshot(now_ms() as u64)
        .into_iter().map(|n| serde_json::to_value(n).unwrap_or(Value::Null)).collect();
    abito_island::chatsnapshot::build(&abito_island::chatsnapshot::LiveInputs {
        sessions,
        question: crate::questionhost::question_view(state),
        notices,
        github: crate::githubhost::cached_pulse(),
        integrations: crate::integrationshost::cached_updates(app),
        unread_mail: None,
    })
}

/// Submit one message: validated, accepted with native ids, then ONE
/// background turn against the frozen local target.
pub fn submit(
    app: &AppHandle,
    state: &AppState,
    text: &str,
    client_request_id: &str,
    attachment_ids: &[String],
) -> Result<Value, BridgeError> {
    let lane = Arc::clone(&state.chat);
    if let Some(dup) = lane.lock().expect("chat lane lock").convo.lookup(client_request_id) {
        return Ok(serde_json::to_value(dup).unwrap_or(Value::Null)); // same turn, no new job
    }
    // #327: one role snapshot supplies both model and system. Later changes affect the next turn.
    let (local, system, specialist, cloud) = specialistshost::turn_snapshot_selected(state, chatlane::SYSTEM_PROMPT)
        .map_err(chat_error)?;
    let store = abito_island::secrets::Keychain;
    let http = abito_island::provider_oauth::RustlsHttp;
    let oauth = abito_island::provider_oauth::OAuth::new(&store, &http, &abito_island::cloudprofiles::clock);
    let source = abito_island::cloudmodel::KeychainCredentials { store: &store, oauth: &oauth, resolve: &abito_island::cloudprofiles::resolve, clock: &abito_island::cloudprofiles::clock };
    let selected = prepare_target(local, cloud, &source).map_err(chat_error)?;
    let profile = match &selected { chatlane::TargetSelection::Local(t) => &t.profile, chatlane::TargetSelection::Cloud(t) => &t.profile };
    // S1: frozen at submit like the specialist's own system message; the human can see it (T3).
    let live = live_snapshot(app, state);
    let system = chatlane::with_live_context(&system, live.is_some(), live.as_ref());
    if let chatlane::TargetSelection::Local(target) = &selected {
        let gate = crate::model_gate(state, target);
        if let Err(e) = gate { return Err(chat_error(e)); }
    }
    // #487: NotchBuddy prefixes the FIRST user message with the window context. It is held for the
    // conversation in memory and added to the prompt only: never to the stored or shown text.
    let context_enabled = crate::settingshost::window_context(&state.settings);
    // #343: attachment ids are resolved ONLY against the island's uploads
    // directory — the page never sends names, sizes, MIME types or paths.
    // A chat without attachments never touches the island: no resolution,
    // no directory, no error path. An unusable id is a safe error and
    // changes nothing (no turn, no ids, no files).
    let uploads_dir = (!attachment_ids.is_empty())
        .then(|| {
            let island = island_root().ok_or_else(|| chat_error(chat::ChatError::attachment_unavailable()))?;
            abito_island::uploads::attachments_dir(&island).map_err(chat_error)
        })
        .transpose()?;
    let attachments = match uploads_dir.as_deref() {
        Some(dir) => abito_island::uploads::resolve_ids(dir, attachment_ids).map_err(chat_error)?,
        None => Vec::new(),
    };
    let (accepted, conversation_id) = {
        let mut l = lane.lock().expect("chat lane lock");
        let first = l.convo.is_empty();
        let accepted = l.submit_with_attachments(text, client_request_id, profile, specialist, chatlane::history_now(), attachments).map_err(chat_error)?;
        if !accepted.duplicate {
            if let Some(s) = &live {
                l.convo.attach_live(&accepted.turn_id, &s.text, s.trimmed_lines);
            }
        }
        // Consume explicit context only after a first message was really accepted, never on error/retry.
        if first && !accepted.duplicate {
            let mut cx = state.chat_context.lock().expect("chat context lock");
            if let Some(text) = cx.for_turn(context_enabled, true) {
                l.convo.attach_context(&accepted.turn_id, &text);
            }
            cx.first_message_consumed();
        }
        (accepted, l.convo.id().to_owned())
    };
    publish_chat(app);
    if !accepted.duplicate {
        let app = app.clone();
        let turn = accepted.turn_id.clone();
        let deadlines = *state.chat_deadlines.lock().expect("deadlines lock");
        std::thread::spawn(move || {
            let publish_app = app.clone();
            let publish = move || publish_chat(&publish_app);
            match &selected {
                chatlane::TargetSelection::Local(target) => chatlane::run_turn_scoped_uploads(&lane, &conversation_id, &turn, target, &system, deadlines, &publish, uploads_dir.as_deref()),
                chatlane::TargetSelection::Cloud(_) => {
                    let store = abito_island::secrets::Keychain;
                    let http = abito_island::provider_oauth::RustlsHttp;
                    let oauth = abito_island::provider_oauth::OAuth::new(&store, &http, &abito_island::cloudprofiles::clock);
                    let source = abito_island::cloudmodel::KeychainCredentials { store: &store, oauth: &oauth, resolve: &abito_island::cloudprofiles::resolve, clock: &abito_island::cloudprofiles::clock };
                    chatlane::run_selected(&lane, &turn, &selected, &source, &system, deadlines, &publish);
                }
            }
        });
    }
    Ok(serde_json::to_value(accepted).unwrap_or(Value::Null))
}

/// `chat_action`: sender gate → payload shape → rate → dispatch.
#[tauri::command]
pub async fn chat_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = chat::parse_command(&payload).map_err(chat_error)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    match command {
        Command::View => Ok(chat_view(&app, &state)),
        Command::List => state.chat.lock().expect("chat lane lock").list_conversations().map_err(chat_error),
        Command::History { conversation_id, before } => state.chat.lock().expect("chat lane lock").history_page(&conversation_id, before).map_err(chat_error),
        Command::New => {
            let specialist = state.specialists.role().map(|s| SpecialistRef { id: s.id, name: s.name });
            let mut lane = state.chat.lock().expect("chat lane lock");
            lane.new_conversation(specialist, chatlane::history_now()).map_err(chat_error)?;
            state.chat_context.lock().expect("chat context lock").new_conversation();
            drop(lane);
            publish_chat(&app);
            Ok(chat_view(&app, &state))
        }
        Command::NewWith { specialist_id } => {
            // Same role switch as a restore (model checks, missing role = refused here), held under the lane lock.
            let mut lane = state.chat.lock().expect("chat lane lock");
            if lane.convo.active().is_some() { return Err(chat_error(chat::ChatError::queue_full())); }
            if let Some(id) = specialist_id.as_deref() {
                if specialistshost::select_conversation_role(&app, &state, Some(id))? {
                    return Err(BridgeError::denied("specialist not found"));
                }
            } else {
                specialistshost::select_conversation_role(&app, &state, None)?;
            }
            let specialist = state.specialists.role().map(|s| SpecialistRef { id: s.id, name: s.name });
            lane.new_conversation(specialist, chatlane::history_now()).map_err(chat_error)?;
            state.chat_context.lock().expect("chat context lock").new_conversation();
            drop(lane);
            publish_chat(&app);
            Ok(chat_view(&app, &state))
        }
        Command::Restore { conversation_id } => {
            // Hold the lane across role restoration: another send cannot slip into the old context.
            let mut l = state.chat.lock().expect("chat lane lock");
            let (summary, page) = l.prepare_conversation(&conversation_id).map_err(chat_error)?;
            let role_id = summary.specialist.as_ref().map(|s| s.id.as_str());
            let missing = specialistshost::select_conversation_role(&app, &state, role_id)?;
            l.activate_conversation(summary, page);
            state.chat_context.lock().expect("chat context lock").new_conversation();
            if missing { l.history_notice("El especialista de esta conversación ya no existe; ahora responde Koda principal."); }
            drop(l);
            publish_chat(&app);
            Ok(chat_view(&app, &state))
        }
        Command::Check => {
            // metadata only, off the main thread; never a prompt
            if let Some(e) = current_cloud(&state) {
                state.chat.lock().expect("chat lane lock").availability = cloud_availability(e);
            } else if let Some(target) = current_target(&state) {
                let lane = Arc::clone(&state.chat);
                let handle = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    chatlane::check(&lane, &target);
                    publish_chat(&handle);
                })
                .await
                .map_err(|_| BridgeError::denied("check aborted"))?;
            }
            Ok(chat_view(&app, &state))
        }
        Command::Height { height } => {
            // S10 (L35): only inside the chat view; the plan clamps to Coucou's 240..300 and the work area, and a
            // repeated height is no resize at all. Same staged resize as every view change.
            let plan = {
                let area = refresh_work_area(&app, &state);
                let win = main_window(&app).ok_or_else(|| BridgeError::denied("main window unavailable"))?;
                let io = TauriIo(&win);
                state.core.lock().expect("core lock").plan_chat_height(&io, area, height)
            };
            if let Some(plan) = plan {
                apply_view(&app, &state, plan);
                publish_chat(&app);
            }
            Ok(chat_view(&app, &state))
        }
        Command::Open | Command::Back => {
            switch_view(&app, &state, command == Command::Open);
            publish(&app, &state);
            Ok(chat_view(&app, &state))
        }
        Command::Submit {
            text,
            client_request_id,
            attachments,
        } => submit(&app, &state, &text, &client_request_id, &attachments),
        Command::Cancel { turn_id } => {
            let cancelled = chatlane::cancel(&state.chat, &turn_id);
            publish_chat(&app);
            Ok(json!({ "cancelled": cancelled }))
        }
    }
}

/// #343 — the island root that owns the attachments workspace:
/// `ABITO_ISLAND_DIR` (absolute) or the user's `~/.abito-island`, same rule
/// the agent connection uses. `None` = the island does not exist yet.
fn island_root() -> Option<std::path::PathBuf> {
    abito_island::agentconn::island_root(
        std::env::var("ABITO_ISLAND_DIR").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )
}

fn attach_error(e: chat::ChatError) -> BridgeError {
    BridgeError { code: e.code, message: e.safe_message }
}

async fn store_attachment<F>(work: F) -> Result<Value, BridgeError>
where
    F: FnOnce(&std::path::Path) -> Result<chat::Attachment, chat::ChatError> + Send + 'static,
{
    let island = island_root().ok_or_else(|| {
        attach_error(chat::ChatError::invalid_input(
            "La carpeta de trabajo de Koda todavía no existe: abrí el chat cuando el motor esté disponible.",
        ))
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = abito_island::uploads::attachments_dir(&island).map_err(attach_error)?;
        let stored = work(&dir).map_err(attach_error)?;
        serde_json::to_value(stored).map_err(|_| BridgeError::denied("attach failed"))
    })
    .await
    .map_err(|_| BridgeError::denied("attach aborted"))?
}

/// #343 — `chat_attach`: one file DROPPED into the chat. The page only ever
/// sends the path it received from the window's drag-drop event: Rust
/// consumes it ONE-SHOT from the NATIVE drop set recorded by the main
/// window's drag-drop event (see `NATIVE_DROPS`) — a path the OS never
/// dropped is refused before anything is read. Then the path is read
/// (capped, symlinks refused), validated against the allowlist and copied
/// into the island's own uploads directory. The original path is never
/// stored or referenced afterwards. Same gate and rate limit as every chat
/// command.
#[tauri::command]
pub async fn chat_attach(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let path = payload
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| attach_error(chat::ChatError::invalid_input("Pedido de archivo inválido.")))?
        .to_string();
    // The page may only attach a path the OS actually dropped natively:
    // consume it one-shot from the native drop set, refusing anything else
    // BEFORE any read or write happens.
    if !NATIVE_DROPS
        .lock()
        .expect("native drop paths lock")
        .consume(std::path::Path::new(&path), now_ms() as u64)
    {
        return Err(attach_error(chat::ChatError::invalid_input(
            "Ese archivo no llegó arrastrado a la ventana.",
        )));
    }
    store_attachment(move |dir| {
        let (name, bytes) = abito_island::uploads::read_dropped(std::path::Path::new(&path))?;
        abito_island::uploads::attach(dir, &name, &bytes)
    })
    .await
}

/// #343 — `chat_attach_data`: one file PICKED in the composer. The page
/// sends raw bytes through Tauri's raw invoke (an ArrayBuffer payload): a
/// one-line JSON header `{{"name":"…"}}`, LF, then the file bytes. Rust
/// validates against the SAME allowlist and stores into the SAME uploads
/// directory as `chat_attach` — the page never names a storage path.
#[tauri::command]
pub async fn chat_attach_data(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(attach_error(chat::ChatError::invalid_input("Pedido de archivo inválido.")));
        }
    };
    store_attachment(move |dir| {
        let (name, bytes) = abito_island::uploads::split_raw_body(&body)?;
        abito_island::uploads::attach(dir, &name, bytes)
    })
    .await
}

/// Initialize private local history; probes are memory-only unless explicitly isolated.
pub fn start_history(app: &AppHandle) {
    let state = app.state::<AppState>();
    let dir = if let Ok(dir) = std::env::var("ABITO_CONVERSATIONS_DATA_DIR") {
        let dir = std::path::PathBuf::from(dir);
        if !dir.is_absolute() { state.chat.lock().expect("chat lane lock").history_failure("El directorio de historial de prueba no es válido; los mensajes no se guardarán."); return; }
        Some(dir)
    } else if crate::probe_requested() { None }
    else { app.path().app_data_dir().ok().map(|p| p.join("conversations")) };
    if let Some(dir) = dir { let _ = state.chat.lock().expect("chat lane lock").init_history(&dir); }
}

#[cfg(test)]
mod cloud_selection_tests {
    use super::*;
    struct Missing;
    impl abito_island::cloudmodel::CredentialSource for Missing {
        fn credential(&self, _: &abito_island::chat::ProfileRef) -> Result<abito_island::cloudmodel::Credential, abito_island::provider_oauth::OauthError> { Err(abito_island::provider_oauth::OauthError::NeedsSignIn) }
        fn refresh(&self, p: &abito_island::chat::ProfileRef, _: &str) -> Result<abito_island::cloudmodel::Credential, abito_island::provider_oauth::OauthError> { self.credential(p) }
    }
    #[test]
    fn missing_cloud_leaves_lane_unchanged() {
        let lane = chatlane::Lane::new("c-no-cloud");
        let before = lane.lock().unwrap().view();
        let cloud = abito_island::cloudprofiles::select("cloud-openai-gpt-4o").unwrap();
        let err = prepare_target(Some(chatlane::default_target()), Some(cloud), &Missing).err().unwrap();
        assert_eq!(err.code, "credential_missing");
        assert_eq!(err.safe_message, "Configura OpenAI en Ajustes → Chat.");
        assert_eq!(lane.lock().unwrap().view(), before);
    }
    struct Present;
    impl abito_island::cloudmodel::CredentialSource for Present {
        fn credential(&self, _: &abito_island::chat::ProfileRef) -> Result<abito_island::cloudmodel::Credential, abito_island::provider_oauth::OauthError> { Ok(abito_island::cloudmodel::Credential::new("fixture".into(), None, None)) }
        fn refresh(&self, _: &abito_island::chat::ProfileRef, _: &str) -> Result<abito_island::cloudmodel::Credential, abito_island::provider_oauth::OauthError> { panic!("must not refresh") }
    }
    #[test]
    fn present_cloud_never_uses_retained_local_target() {
        let cloud = abito_island::cloudprofiles::select("cloud-openai-gpt-4o").unwrap();
        let selected = prepare_target(Some(chatlane::default_target()), Some(cloud), &Present).unwrap();
        let chatlane::TargetSelection::Cloud(target) = selected else { panic!("silent local fallback") };
        assert_eq!(target.profile.profile_id, cloud.id);
        assert_eq!(target.origin(), "https://api.openai.com");
        assert_eq!(target.model, "gpt-4o");
    }
    #[test]
    fn local_selection_is_identical_and_never_reads_credentials() {
        let original = chatlane::default_target();
        let selected = prepare_target(Some(original.clone()), None, &Missing).unwrap();
        let chatlane::TargetSelection::Local(target) = selected else { panic!("local changed") };
        assert_eq!(target.endpoint.origin(), original.endpoint.origin());
        assert_eq!(target.alias, original.alias);
        assert_eq!(target.profile, original.profile);
        assert_eq!(target.max_output, original.max_output);
        assert_eq!(abito_island::localmodel::completion_body(&target.alias, &[], target.max_output).as_bytes(), br#"{"chat_template_kwargs":{"enable_thinking":false},"max_tokens":1024,"messages":[],"model":"Abito-gpt","stream":true}"#);
    }
}

/// Default deadlines for production turns.
pub fn default_deadlines() -> abito_island::localmodel::Deadlines {
    DEFAULT_DEADLINES
}

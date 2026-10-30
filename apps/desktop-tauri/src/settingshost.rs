//! #306 host: the three closed IPC commands of the settings panel.
//!
//! - `agent_action`   → the island agent client (accounts, sign-in, connectors list);
//! - `prefs_action`   → sound, explicit optional display name, avatar colors and the
//!   system/light/dark theme (#380) (`prefs.json` v1);
//! - `hotkey_action`  → lives in `hotkeyhost.rs` (#305), reused as is.
//!
//! Every command validates the sender (the main webview only), takes the same shared
//! rate limiter as chat/models/questions and speaks a closed schema. The agent's
//! per-launch token and socket path never cross to the WebView (`agentclient`).
use crate::{now_ms, AppState};
use abito_island::agentclient::{is_account_action, AccountStore};
use abito_island::agentconn::{island_root, AgentConn};
use abito_island::bridge::{self, BridgeError};
use abito_island::prefs::{self, Command, Prefs};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// #390 GD027: how long a `restart` waits for the fresh daemon to answer `ready`.
/// The engine's own boot timeout is 60 s (desktop-daemon/src/runtime.cjs), so this
/// bound lets the daemon reach its own verdict first; past it the answer is honestly
/// `ready:false`, never a success. Polling is cheap (a missing session.json fails in
/// one stat) and bounded — no unbounded wait anywhere.
const RESTART_WAIT: Duration = Duration::from_secs(62);
const RESTART_POLL: Duration = Duration::from_millis(200);

pub struct SettingsHost {
    // #315: the tray derives its connection state from this slot's view
    // (try_lock only — never a blocking read inside publish).
    pub(crate) agent: Mutex<Option<AgentConn>>,
    // Retained through disk commit and masked publication; never forwarded to the daemon.
    accounts: Mutex<Result<AccountStore, BridgeError>>,
    prefs: Mutex<Prefs>,
    prefs_serial: Mutex<()>, // commands retain this gate through publication
}

impl Default for SettingsHost {
    fn default() -> Self {
        SettingsHost {
            agent: Mutex::new(None),
            accounts: Mutex::new(Err(err("account_store_unavailable"))),
            prefs: Mutex::new(Prefs::default()),
            prefs_serial: Mutex::new(()),
        }
    }
}

#[cfg(test)]
pub(crate) fn with_test_prefs(prefs: Prefs) -> SettingsHost {
    SettingsHost { prefs: Mutex::new(prefs), ..SettingsHost::default() }
}

fn err(code: &str) -> BridgeError {
    BridgeError {
        code: code.into(),
        message: "No se pudo completar el cambio de ajustes.".into(),
    }
}

fn prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join(prefs::FILE))
}

fn load_prefs(app: &AppHandle) -> Prefs {
    Prefs::from_text(
        prefs_path(app)
            .and_then(|p| std::fs::read_to_string(p).ok())
            .as_deref(),
    )
}

fn persist_prefs(app: &AppHandle, p: &Prefs) -> bool {
    let Some(path) = prefs_path(app) else {
        return false;
    };
    let Some(dir) = path.parent() else {
        return false;
    };
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = dir.join(format!(".{}.{}", prefs::FILE, std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let ok = options
        .open(&tmp)
        .and_then(|mut f| f.write_all(p.to_text().as_bytes()))
        .and_then(|_| std::fs::rename(&tmp, &path));
    if ok.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    ok.is_ok()
}

/// Startup: load the prefs. The agent connection is made lazily, when the human opens Settings.
pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _serial = state
        .settings
        .prefs_serial
        .lock()
        .expect("prefs transaction lock");
    *state.settings.prefs.lock().expect("prefs lock") = load_prefs(app);
    *state.settings.accounts.lock().expect("accounts lock") = app
        .path()
        .app_config_dir()
        .map_err(|_| err("account_store_unavailable"))
        .and_then(|dir| AccountStore::load(dir.join("accounts.json"), std::sync::Arc::new(abito_island::secrets::Keychain)));
}

/// #488: the same transaction `prefs_action` runs, for a voice command ("add GitHub").
/// Returns the new prefs, or None when the command is refused or could not be saved.
pub(crate) fn voice_prefs_command(app: &AppHandle, command: &Command) -> Option<Prefs> {
    let state = app.state::<AppState>();
    prefs::transact(
        &state.settings.prefs_serial,
        &state.settings.prefs,
        command,
        |p| persist_prefs(app, p),
        |snapshot| {
            let _ = app.emit("prefs:state", view_prefs(snapshot));
        },
    )
    .ok()
}

/// The current prefs, for a voice query.
pub(crate) fn voice_prefs_snapshot(app: &AppHandle) -> Prefs {
    app.state::<AppState>().settings.prefs.lock().expect("prefs lock").clone()
}

fn context_extension_available() -> bool {
    #[cfg(target_os = "linux")]
    { abito_island::contextwin::dbus::available(None) }
    #[cfg(not(target_os = "linux"))]
    { true } // HU-050: Windows/macOS read the native window list, no extension needed
}

/// HU-050: set only where the OS withholds window titles (macOS without Screen Recording access).
/// Abito never asks for that permission; the page says so instead.
fn context_title_note() -> Option<&'static str> {
    #[cfg(not(target_os = "linux"))]
    { if !abito_island::contextwin::titles_allowed() { return Some("sin título: falta permiso de Grabación de pantalla"); } }
    None
}

fn view_prefs(p: &Prefs) -> Value {
    json!({"sound": p.sound, "gain": p.gain(), "displayName": p.display_name, "avatarColors": p.avatar_colors,
        "mainPill": p.main_pill(), "declaredPills": p.declared_pills(),
        "pillColors": p.pill_colors,
        "theme": p.theme().as_str(),
        "chosenModels": p.chosen_models,
        "autoCloseSeconds": p.auto_close_seconds(), "openOnHover": p.open_on_hover(),
        "absenceSeconds": p.absence_seconds(),
        "customBlobs": p.custom_blobs_view(),
        "islandAgents": p.island_agents_view(),
        "abitoInstructions": p.abito_instructions_view(),
        "monitor": p.monitor,
        "showPlanInNotch": p.show_plan_in_notch(),
        "showCodexPlanInNotch": p.show_codex_plan_in_notch(),
        "windowContext": p.window_context(),
        "liveContext": p.live_context(),
        "windowContextAvailable": context_extension_available(), "windowContextNote": context_title_note(), "windowContextNative": cfg!(not(target_os = "linux")),
        "openSettingsAtLaunch": p.open_settings_at_launch(),
        "settingsWindow": true})
}

/// #487: the explicit opt-in to read the previous window's app and title (off by default).
/// S5 (#503): the chat's live-state context switch (default ON).
pub fn live_context(host: &SettingsHost) -> bool {
    host.prefs.lock().expect("prefs lock").live_context()
}

pub fn window_context(host: &SettingsHost) -> bool {
    host.prefs.lock().expect("prefs lock").window_context()
}

/// #489: whether the human put this integration pill on the island (main or declared).
pub fn pill_declared(host: &SettingsHost, id: &str) -> bool {
    abito_island::integrations::declared(&host.prefs.lock().expect("prefs lock"), id)
}

/// Only the already loaded, explicitly selected local preference reaches chat.
pub fn display_name(host: &SettingsHost) -> Option<String> {
    host.prefs.lock().expect("prefs lock").display_name.clone()
}

/// Read the principal's already loaded response preferences once for an immutable turn.
pub fn abito_instructions(host: &SettingsHost) -> Option<String> {
    host.prefs.lock().expect("prefs lock").abito_instructions.clone()
}

/// T6.2: the remembered inner size of the own Ajustes window (logical px), read
/// when the window opens. Read-only: the WebView never receives it — the size is
/// Rust's own decision (event payload only), like #264's position.
pub fn settings_window_size(app: &AppHandle) -> Option<(u32, u32)> {
    let state = app.state::<AppState>();
    // the guard must drop before `state`: a tail expression would hold the borrow
    let size = state
        .settings
        .prefs
        .lock()
        .expect("prefs lock")
        .settings_window_size;
    size
}

/// #389 (GD012): the monitor the human chose for the island, read for the FIRST
/// geometry decision of a launch and on every work-area poll. Read-only: the
/// WebView only sees it through the projection. `None` = the default behaviour
/// (the island's current monitor).
pub fn chosen_monitor(app: &AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let monitor = state
        .settings
        .prefs
        .lock()
        .expect("prefs lock")
        .monitor
        .clone();
    monitor
}

/// #486: the desktop character's saved state (Coucou `desktopMochi`), read-only.
pub fn desktop_character(app: &AppHandle) -> Option<prefs::DesktopCharacter> {
    let state = app.state::<AppState>();
    let saved = state.settings.prefs.lock().expect("prefs lock").desktop_character;
    saved
}

/// #486: commit where the desktop character lives, through the same gate and atomic writer
/// as every other preference. No publication: the page never sees it.
pub fn save_desktop_character(app: &AppHandle, on: bool, spot: Option<(i32, i32)>) -> bool {
    let state = app.state::<AppState>();
    prefs::transact(
        &state.settings.prefs_serial,
        &state.settings.prefs,
        &prefs::Command::SetDesktopCharacter { on, spot },
        |p| persist_prefs(app, p),
        |_| {},
    )
    .is_ok()
}

/// T6.2: commit the size the human resized the own Ajustes window to, through
/// the SAME `prefs::transact` gate, file and atomic writer as every other
/// preference — so a settings change after a resize can never drop this, and
/// this write can never drop a settings change. No publication: the size is
/// not part of the settings view the WebView reads. Failure leaves the previous
/// size in memory (and on disk) for this launch; the debounced persister retries.
pub fn save_settings_window_size(app: &AppHandle, w: u32, h: u32) -> bool {
    let state = app.state::<AppState>();
    prefs::transact(
        &state.settings.prefs_serial,
        &state.settings.prefs,
        &prefs::Command::SetSettingsWindowSize(w, h),
        |p| persist_prefs(app, p),
        |_| {},
    )
    .is_ok()
}

/// #442 T7.4: a deleted specialist leaves the island order. Rust-internal (never a wire
/// command); a no-op when the id is not in the stored order, so it never writes needlessly.
pub fn prune_island_agent(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let command = Command::PruneIslandAgent(id.to_owned());
    let _ = prefs::transact(
        &state.settings.prefs_serial,
        &state.settings.prefs,
        &command,
        |p| persist_prefs(app, p),
        |snapshot| {
            let _ = app.emit("prefs:state", view_prefs(snapshot));
        },
    );
}

// Shared dispatch gate: executed before any preference transaction or persistence.
fn check_island_membership(
    command: &Command,
    specialists: &crate::specialists::Store,
) -> Result<(), BridgeError> {
    if let Command::SetIslandAgents(order) = command {
        if order.iter().any(|id| specialists.find(id).is_none()) {
            return Err(err("invalid_schema"));
        }
    }
    Ok(())
}

/// Closed preference commands: view, sound_on/off, set_sound_gain (0..=0.2),
/// set_display_name, set/clear_avatar_color, set_main_pill, toggle_declared_pill and
/// set_theme (system|light|dark). Pill actions take exactly action + id; selection never
/// installs or connects anything. The theme is #380's optional closed field.
/// #435: reorder_declared_pills and reorder_blobs take exactly action + order (an
/// array of strings) — apply enforces the strict-permutation gate.
#[tauri::command]
pub async fn prefs_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = prefs::parse_command(&payload).map_err(|_| err("invalid_schema"))?;
    check_island_membership(&command, &state.specialists.snapshot())?;
    state
        .chat_rate
        .lock()
        .expect("chat rate lock")
        .check(now_ms())?;
    // Same sender/rate/serialization gates; no shadow copy in prefs.json.
    if matches!(command, Command::AutostartView | Command::SetAutostart(_)) {
        let _serial = state.settings.prefs_serial.lock().expect("prefs transaction lock");
        if let Command::SetAutostart(enabled) = command {
            crate::trayhost::set_autostart(&app, enabled).map_err(|_| err("save_failed"))?;
        }
        return Ok(json!({"enabled": crate::trayhost::autostart_enabled()}));
    }
    let mut attempted_write = false;
    let next = prefs::transact(
        &state.settings.prefs_serial,
        &state.settings.prefs,
        &command,
        |p| {
            attempted_write = true;
            // Upgrade an already-enabled legacy login entry before opting into
            // manual-launch Settings. Otherwise old entries lack --autostart.
            if matches!(command, Command::SetOpenSettingsAtLaunch(true))
                && crate::trayhost::autostart_enabled() == Some(true)
                && crate::trayhost::set_autostart(&app, true).is_err() { return false; }
            persist_prefs(&app, p)
        },
        |snapshot| {
            // Snapshot belongs to this commit. The transaction gate still holds,
            // but the state mutex is free so publish_chat may re-read the name.
            let _ = app.emit("prefs:state", view_prefs(snapshot));
            if matches!(command, Command::SetDisplayName(_)) {
                crate::chathost::publish_chat(&app);
            }
        },
    )
    .map_err(|_| {
        // Stateful refusal (main toggle / fifth addition) happens inside the
        // existing serial gate before persistence; a disk failure is different.
        let refused = !attempted_write
            && matches!(
                command,
                Command::SetMainPill(_) | Command::ToggleDeclaredPill(_)
            );
        err(if refused {
            "invalid_schema"
        } else {
            "save_failed"
        })
    })?;
    Ok(view_prefs(&next))
}

/// The island agent: `view` (connects on first use), and the closed command set of
/// `agentclient::parse_ui_command`. Abito account commands are committed locally before
/// any daemon connection; snapshots expose credential presence only.
#[tauri::command]
pub async fn agent_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    AccountStore::guard(
        webview.label(),
        &url,
        &mut state.chat_rate.lock().expect("chat rate lock"),
        now_ms(),
    )?;
    let handle = app.clone();
    // the socket work and the first connect never block the WebView thread
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        if is_account_action(&payload) {
            let mut accounts = state.settings.accounts.lock().expect("accounts lock");
            let store = accounts
                .as_mut()
                .map_err(|error| BridgeError { code: error.code.clone(), message: error.message.clone() })?;
            let saved = store.command(&payload, |snapshot| {
                let _ = handle.emit("agent:state", json!({"ownedAccounts":snapshot}));
            })?;
            return Ok(json!({"ownedAccounts":saved}));
        }
        // HU-015: every Ajustes → Agentes hook read and change takes the daemon-free route, whether the engine is up
        // or down (one owner, no daemon/direct race). It never touches the engine slot below.
        if let Some(op) = abito_island::agents_direct::parse(&payload) {
            let op = op.map_err(|_| err("invalid_schema"))?;
            return Ok(abito_island::agents_direct::perform(&op));
        }
        let mut guard = state.settings.agent.lock().expect("agent lock");
        let conn = guard.get_or_insert_with(|| {
            let emitter = handle.clone();
            // The view is handed in: this callback fires while `agent_action` holds the slot, so it must
            // not lock it again (it did, once, and the first open of the panel hung forever).
            AgentConn::new(move |view| {
                let _ = emitter.emit("agent:state", view);
            })
        });
        let is_view_or_refresh = payload
            .get("action")
            .and_then(Value::as_str)
            .is_some_and(|a| a == "view" || a == "refresh");
        let connected = conn.view().get("connection").and_then(Value::as_str) == Some("connected");
        if !connected && is_view_or_refresh {
            if let Some(reason) = handle
                .state::<abito_island::daemonhost::HostSlot>()
                .failure()
            {
                conn.startup_failed(reason);
                return Ok(conn.view());
            }
            let root = island_root(
                std::env::var("ABITO_ISLAND_DIR").ok().as_deref(),
                std::env::var("HOME").ok().as_deref(),
            );
            match root {
                Some(root) => conn.connect(&root),
                None => return Err(err("no_island_root")),
            }
        }
        let mut view = conn
            .command(&payload)
            .map_err(|_| err("agent_unavailable"))?;
        view["ownedAccounts"] = state
            .settings
            .accounts
            .lock()
            .expect("accounts lock")
            .as_ref()
            .map(AccountStore::view)
            .unwrap_or(Value::Null);
        Ok(view)
    })
    .await
    .map_err(|_| err("agent_aborted"))?
}

/// #408 — `settings_view`: the page tells Rust that Ajustes opened (`{"open":true}`) or closed. Rust owns
/// the size (geometry::settings_visible, clamped to the work area) and restores the previous chat
/// rectangle on close; the page never sends a number. Same sender gate and rate limiter as the others.
#[tauri::command]
pub async fn settings_view(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state
        .chat_rate
        .lock()
        .expect("chat rate lock")
        .check(now_ms())?;
    let open = parse_settings_view(&payload).ok_or_else(|| err("invalid_schema"))?;
    let _ = app; // Compatibility command: Settings is hosted in its own window.
    Ok(json!({"open": open}))
}

/// The closed payload of `daemon_action` (#390 GD027): exactly `{"action":"status"|"restart"}`.
pub(crate) fn parse_daemon_action(payload: &Value) -> Option<&'static str> {
    let obj = payload.as_object()?;
    if obj.len() != 1 {
        return None;
    }
    match obj.get("action")?.as_str()? {
        "status" => Some("status"),
        "restart" => Some("restart"),
        _ => None,
    }
}

/// The truth of the daemon is the CONNECTION: lazily create the client (like
/// `agent_action view`), connect when it is not connected, and — when `wait` is
/// given — keep trying until it answers `ready`, OUR OWN child dies, or the bound
/// expires. Holds the agent slot (the same rule as `agent_action`): the state
/// callback only emits, it never re-locks. Returns `(connection, own_child_gone)`
/// for the restart verdict; the page only ever sees `{action, ready, connection, outcome}`.
pub(crate) fn daemon_connect(
    handle: &AppHandle,
    state: &AppState,
    root: &std::path::Path,
    wait: Option<Duration>,
    watch: Option<&abito_island::daemonhost::HostSlot>,
) -> (String, bool) {
    let mut guard = state.settings.agent.lock().expect("agent lock");
    let emitter = handle.clone();
    let conn = guard.get_or_insert_with(|| {
        AgentConn::new(move |view| {
            let _ = emitter.emit("agent:state", view);
        })
    });
    let connected =
        |c: &AgentConn| c.view().get("connection").and_then(Value::as_str) == Some("connected");
    let deadline = wait.map(|w| Instant::now() + w);
    let mut own_gone = false;
    loop {
        // Try the connection FIRST: a stale `connected` must be refreshed honestly.
        if !connected(conn) {
            conn.connect(root);
        }
        if connected(conn) {
            break;
        }
        // A watched child that died without serving must not burn the whole bound.
        if watch.is_some_and(|w| w.pid().is_none()) {
            own_gone = true;
            break;
        }
        match deadline {
            Some(end) if Instant::now() < end => std::thread::sleep(RESTART_POLL),
            _ => break,
        }
    }
    let view = conn.view();
    let connection = view
        .get("connection")
        .and_then(Value::as_str)
        .unwrap_or("no_daemon")
        .to_string();
    (connection, own_gone)
}

/// HU-046: Pi was just installed. Start the chat host WITHOUT restarting the app: the same sequence as `daemon_action restart`
/// (old client first, bounded stop, fresh start, connect with a bounded wait). `HostSlot::start` now forgets the earlier
/// «pi_missing» failure on success. Returns whether the host is running.
pub(crate) fn start_host_after_install(handle: &AppHandle) -> bool {
    let state = handle.state::<AppState>();
    let Some(root) = island_root(std::env::var("ABITO_ISLAND_DIR").ok().as_deref(), std::env::var("HOME").ok().as_deref()) else { return false };
    let old = state.settings.agent.lock().expect("agent lock").take();
    drop(old);
    let slot = handle.state::<abito_island::daemonhost::HostSlot>();
    slot.stop();
    slot.start();
    daemon_connect(handle, &state, &root, Some(RESTART_WAIT), Some(&*slot));
    slot.failure().is_none() && slot.pid().is_some()
}

/// The pid in `<root>/runtime/session.json`, read ONLY to compare it with our own
/// child inside Rust (#390 fix). It never crosses to the page.
fn session_pid(root: &std::path::Path) -> Option<u32> {
    let text = std::fs::read_to_string(abito_island::agentconn::session_path(root)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("pid")?.as_u64()?.try_into().ok()
}

/// #390 fix — the closed verdict of a `restart`, decided ONLY from our own child:
/// `restarted` (our child serves the session it published), `refused` (our child never
/// spawned, GD029 rejected it and it died, or the session belongs to someone else — a
/// foreign motor we never touch), `timeout` (our child was still booting at the bound).
/// Never a pid.
pub(crate) fn restart_outcome(
    own: Option<u32>,
    session_pid: Option<u32>,
    own_alive: bool,
    connected: bool,
) -> &'static str {
    let Some(own) = own else { return "refused" };
    if connected {
        return if session_pid == Some(own) {
            "restarted"
        } else {
            "refused"
        };
    }
    if !own_alive {
        return "refused";
    }
    "timeout"
}

/// The restart answer: exactly `{action, ready, connection, outcome}` — no token, no pid, no path.
pub(crate) fn restart_response(action: &str, connection: &str, outcome: &'static str) -> Value {
    json!({ "action": action, "ready": connection == "connected", "connection": connection, "outcome": outcome })
}

/// #390 GD027 — the closed daemon lifecycle command behind the Ajustes button.
/// `status` reports the current state once (the fast path, unchanged). `restart` drops
/// the old client, stops the app-owned host child (bounded TERM/KILL/reap in
/// `daemonhost`), spawns it again and answers the CLOSED `outcome` — `restarted` |
/// `refused` | `timeout` — decided from our own child's pid vs `session.json`, never
/// exposed. `{action, ready, connection, outcome}`: no token, no pid, no path.
#[tauri::command]
pub async fn daemon_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state
        .chat_rate
        .lock()
        .expect("chat rate lock")
        .check(now_ms())?;
    let action = parse_daemon_action(&payload).ok_or_else(|| err("invalid_schema"))?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let root = island_root(std::env::var("ABITO_ISLAND_DIR").ok().as_deref(), std::env::var("HOME").ok().as_deref())
            .ok_or_else(|| err("no_island_root"))?;
        if action == "restart" {
            // The old client (and its reader) go BEFORE its daemon; the fresh one below
            // starts from `no_daemon`, never from a stale `connected`.
            let old = state.settings.agent.lock().expect("agent lock").take();
            drop(old);
            // Bounded stop (daemonhost Drop: TERM group, KILL, reap) then a fresh spawn.
            let slot = handle.state::<abito_island::daemonhost::HostSlot>();
            slot.stop();
            slot.start();
            let own = slot.pid();
            let (connection, own_gone) = daemon_connect(&handle, &state, &root, Some(RESTART_WAIT), Some(&*slot));
            let connected = connection == "connected";
            let own_alive = !own_gone && slot.pid().is_some();
            let outcome = restart_outcome(own, session_pid(&root), own_alive, connected);
            return Ok(restart_response(action, &connection, outcome));
        }
        // status: the fast path — one honest attempt, same shape as before
        let (connection, _) = daemon_connect(&handle, &state, &root, None, None);
        Ok(json!({ "action": action, "ready": connection == "connected", "connection": connection }))
    })
    .await
    .map_err(|_| err("daemon_aborted"))?
}

/// The closed payload: exactly `{"open": <bool>}`.
pub(crate) fn parse_settings_view(payload: &Value) -> Option<bool> {
    let obj = payload.as_object()?;
    if obj.len() != 1 {
        return None;
    }
    obj.get("open")?.as_bool()
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    let conn = state.settings.agent.lock().expect("agent lock").take();
    if let Some(c) = conn {
        c.close();
    }
}

#[cfg(test)]
mod settings_view_tests {
    use super::parse_daemon_action;
    use super::parse_settings_view;
    use super::restart_outcome;
    use super::restart_response;
    use super::view_prefs;
    use serde_json::json;

    #[test]
    fn the_settings_view_payload_is_exactly_one_boolean() {
        assert_eq!(parse_settings_view(&json!({"open": true})), Some(true));
        assert_eq!(parse_settings_view(&json!({"open": false})), Some(false));
        for bad in [
            json!({}),
            json!({"open": 1}),
            json!({"open": "true"}),
            json!({"open": true, "w": 900}),
            json!(true),
            json!(null),
            json!({"width": 900}),
        ] {
            assert_eq!(parse_settings_view(&bad), None, "{bad}");
        }
    }

    /// #390 fix: the verdict comes from OUR OWN child — a closed vocabulary, never a pid.
    #[test]
    fn restart_outcome_is_a_closed_vocabulary_from_the_own_child_verdict() {
        // the coordinator's fake: our child never spawned and nobody answers → refused (ready false)
        assert_eq!(restart_outcome(None, None, false, false), "refused");
        // no child of ours, but a foreign daemon answers session.json
        assert_eq!(restart_outcome(None, Some(1234), false, true), "refused");
        // our own child published the session and serves it
        assert_eq!(
            restart_outcome(Some(100), Some(100), true, true),
            "restarted"
        );
        // connected, but the session belongs to someone else (ours never published)
        assert_eq!(restart_outcome(Some(100), Some(200), true, true), "refused");
        // our spawn was rejected (GD029) and the child died without serving
        assert_eq!(
            restart_outcome(Some(100), Some(200), false, false),
            "refused"
        );
        assert_eq!(restart_outcome(Some(100), None, false, false), "refused");
        // still booting when the bound expired: honestly a timeout
        assert_eq!(restart_outcome(Some(100), None, true, false), "timeout");
        assert_eq!(
            restart_outcome(Some(100), Some(100), true, false),
            "timeout"
        );
        for verdict in [
            restart_outcome(None, None, false, false),
            restart_outcome(Some(100), Some(100), true, true),
            restart_outcome(Some(100), None, true, false),
        ] {
            assert!(
                matches!(verdict, "restarted" | "refused" | "timeout"),
                "{verdict}"
            );
        }
    }

    /// #390 fix: the restart answer carries exactly its four keys — no token, pid or path.
    #[test]
    fn restart_response_never_carries_a_token_pid_or_path() {
        let text =
            serde_json::to_string(&restart_response("restart", "connected", "restarted")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["action", "connection", "outcome", "ready"]);
        assert_eq!(value["ready"], json!(true));
        let late = restart_response("restart", "no_daemon", "timeout");
        assert_eq!(late["ready"], json!(false));
        assert_eq!(late["outcome"], json!("timeout"));
        for banned in ["token", "pid", "endpoint", "procStart", "/home/", "/proc/"] {
            assert!(!text.contains(banned), "{banned} leaked: {text}");
        }
    }

    /// #414: the chosen models of the connected providers reach the WebView only as the
    /// validated typed pref; nothing chosen projects as null, like every optional field.
    #[test]
    fn f414_the_webview_projection_carries_the_chosen_models() {
        use abito_island::prefs::{parse_command, update, Prefs};
        let prefs = Prefs::from_text(Some(
            r#"{"v":1,"chosen_models":{"anthropic":["claude-sonnet-4-5"]}}"#,
        ));
        let view = view_prefs(&prefs);
        assert_eq!(
            view["chosenModels"],
            json!({"anthropic":["claude-sonnet-4-5"]})
        );
        assert_eq!(
            view_prefs(&Prefs::default())["chosenModels"],
            json!(null),
            "nothing chosen is null, like the other optional fields"
        );
        // a round trip through the closed command keeps the projection
        let cmd = parse_command(
            &json!({"action":"set_chosen_models","provider":"openai","models":["gpt-5.2"]}),
        )
        .unwrap();
        let next = update(&prefs, &cmd, |_| true).unwrap();
        assert_eq!(
            view_prefs(&next)["chosenModels"],
            json!({"anthropic":["claude-sonnet-4-5"],"openai":["gpt-5.2"]})
        );
    }

    /// #389: the chosen panel monitor reaches the WebView only as the validated
    /// typed pref; no choice projects as null, like every optional field.
    #[test]
    fn f389_the_webview_projection_carries_the_chosen_monitor() {
        use abito_island::prefs::{parse_command, update, Prefs};
        let prefs = Prefs::from_text(Some(r#"{"v":1,"monitor":"DP-1"}"#));
        assert_eq!(view_prefs(&prefs)["monitor"], json!("DP-1"));
        assert_eq!(
            view_prefs(&Prefs::default())["monitor"],
            json!(null),
            "no choice is null, like the other optional fields"
        );
        let cmd = parse_command(&json!({"action":"set_monitor","monitor":"eDP-1"})).unwrap();
        assert_eq!(
            view_prefs(&update(&prefs, &cmd, |_| true).unwrap())["monitor"],
            json!("eDP-1")
        );
        let cleared = parse_command(&json!({"action":"clear_monitor"})).unwrap();
        assert_eq!(
            view_prefs(&update(&prefs, &cleared, |_| true).unwrap())["monitor"],
            json!(null),
            "the default projects null"
        );
        // the established projection shapes are untouched by the new field
        let view = view_prefs(&prefs);
        assert_eq!(view["theme"], json!("system"));
        assert_eq!(
            view["sound"],
            json!(true),
            "sound is on by default: a file with no `sound` key projects the default"
        );
        assert_eq!(view["chosenModels"], json!(null));
    }

    /// #455: effective placement is always the window, without migrating stored keys.
    #[test]
    fn f093_the_webview_projection_carries_the_settings_window_choice() {
        use abito_island::prefs::Prefs;
        let defaults = view_prefs(&Prefs::default());
        assert_eq!(
            defaults["settingsWindow"],
            json!(true),
            "#455: window replaces the island"
        );
        let saved = Prefs::from_text(Some(r#"{"v":1,"settings_window":true}"#));
        assert_eq!(view_prefs(&saved)["settingsWindow"], json!(true));
        let hostile = Prefs::from_text(Some(r#"{"v":1,"settings_window":"yes"}"#));
        assert_eq!(
            view_prefs(&hostile)["settingsWindow"],
            json!(true),
            "legacy values cannot restore island settings"
        );
        let disabled = Prefs::from_text(Some(r#"{"v":1,"settings_window":false}"#));
        assert_eq!(view_prefs(&disabled)["settingsWindow"], json!(true));
        // the established projection shapes are untouched
        assert_eq!(defaults["autoCloseSeconds"], json!(15));
        assert_eq!(defaults["theme"], json!("system"));
    }

    /// #346 F033: `pillColors` is the same projection shape as `avatarColors` — already
    /// validated canonical palette hex only, and a cleared pill simply has no key.
    #[test]
    fn f033_the_webview_projection_carries_validated_pill_colours_and_a_clear_drops_the_key() {
        use abito_island::prefs::{parse_command, update, Prefs};
        let prefs = Prefs::from_text(Some(r#"{"v":1,"pill_colors":{"agent_amp":"mint"},"avatar_colors":{"abito":"mint"}}"#));
        let view = view_prefs(&prefs);
        assert_eq!(
            view["pillColors"],
            json!({"agent_amp":"#2DD4BF"}),
            "same shape as avatarColors"
        );
        assert_eq!(
            view["avatarColors"],
            json!({"abito":"#2DD4BF"}),
            "the established field keeps its shape"
        );
        let cleared = update(
            &prefs,
            &parse_command(&json!({"action":"clear_pill_color","id":"agent_amp"})).unwrap(),
            |_| true,
        )
        .unwrap();
        assert_eq!(
            view_prefs(&cleared)["pillColors"],
            json!({}),
            "a cleared pill projects no colour"
        );
        // A hostile stored value is already dropped at load, so it never reaches the projection.
        let hostile =
            Prefs::from_text(Some(r#"{"v":1,"pill_colors":{"agent_amp":"<img src=x>"}}"#));
        assert_eq!(view_prefs(&hostile)["pillColors"], json!({}));
    }

    /// #415 WU2: created blobs reach the WebView only as validated name + palette
    /// colour entries; nothing created projects as null, like every optional field.
    #[test]
    fn f415_the_webview_projection_carries_created_blobs_or_null() {
        use abito_island::prefs::{parse_command, update, Prefs};
        let defaults = view_prefs(&Prefs::default());
        assert_eq!(
            defaults["customBlobs"],
            json!(null),
            "nothing created projects as null"
        );
        let prefs = Prefs::from_text(Some(
            r#"{"v":1,"custom_blobs":[{"name":"Abito GitHub","color":"green"},{"name":"Abito correo"}]}"#,
        ));
        let view = view_prefs(&prefs);
        assert_eq!(
            view["customBlobs"],
            json!([
                {"name":"Abito GitHub","color":"#4ADE80"},
                {"name":"Abito correo","color":null},
            ])
        );
        // a round trip through the closed create command keeps the projection
        let cmd = parse_command(&json!({"action":"create_blob","name":"Abito Reviewer"})).unwrap();
        let next = update(&prefs, &cmd, |_| true).unwrap();
        let view = view_prefs(&next);
        assert_eq!(view["customBlobs"].as_array().unwrap().len(), 3);
        // a hostile stored file never reaches the projection
        let hostile = Prefs::from_text(Some(r#"{"v":1,"custom_blobs":[{"name":42},"junk"]}"#));
        assert_eq!(view_prefs(&hostile)["customBlobs"], json!(null));
    }

    /// #390 GD027: `daemon_action` is closed — exactly {"action":"status"|"restart"}.
    #[test]
    fn daemon_action_is_a_closed_two_action_payload() {
        assert_eq!(
            parse_daemon_action(&json!({"action": "status"})),
            Some("status")
        );
        assert_eq!(
            parse_daemon_action(&json!({"action": "restart"})),
            Some("restart")
        );
        for bad in [
            json!({}),
            json!({"action": "nope"}),
            json!({"action": "status", "extra": 1}),
            json!({"action": 1}),
            json!("restart"),
            json!(null),
            json!({"Action": "restart"}),
        ] {
            assert_eq!(parse_daemon_action(&bad), None, "{bad}");
        }
    }

    /// #336 T1b-a (L15): the projection carries the EFFECTIVE interaction
    /// values — the defaults (15 seconds / hover off) without any stored key,
    /// saved values when present, and the defaults again when a hostile file
    /// value was dropped at load. The established fields keep their shapes.
    #[test]
    fn f003_the_webview_projection_carries_the_effective_interaction_values() {
        use abito_island::prefs::Prefs;
        let defaults = view_prefs(&Prefs::default());
        assert_eq!(defaults["autoCloseSeconds"], json!(15));
        assert_eq!(defaults["openOnHover"], json!(false));
        let saved = Prefs::from_text(Some(
            r#"{"v":1,"auto_close_seconds":45,"open_on_hover":true}"#,
        ));
        let view = view_prefs(&saved);
        assert_eq!(view["autoCloseSeconds"], json!(45));
        assert_eq!(view["openOnHover"], json!(true));
        let hostile = Prefs::from_text(Some(
            r#"{"v":1,"auto_close_seconds":999,"open_on_hover":"yes"}"#,
        ));
        let view = view_prefs(&hostile);
        assert_eq!(
            view["autoCloseSeconds"],
            json!(15),
            "dropped values read as defaults"
        );
        assert_eq!(
            view["openOnHover"],
            json!(false),
            "dropped values read as defaults"
        );
        // the established projection shapes are untouched
        assert_eq!(view["pillColors"], json!({}));
        assert_eq!(view["theme"], json!("system"));
        assert_eq!(
            view["sound"],
            json!(true),
            "sound is on by default: a file with no `sound` key projects the default"
        );
    }
    #[test]
    fn island_membership_dispatch_refuses_unknown_ids_before_persistence() {
        use super::{check_island_membership, err, prefs, BridgeError, Command, Prefs, Value};
        let specialists = crate::specialists::Store::from_text(Some(
            r#"{"v":1,"active":null,"specialists":[{"id":"esp-known","name":"Notes","instructions":"Sort notes","model":null}]}"#,
        ));
        assert_eq!(specialists.items.len(), 1);
        let current = Prefs::default();
        let before = b"{\n  \"v\": 1, \"sound\": false\n}\n".to_vec();
        let path = std::env::temp_dir().join(format!(
            "abito-membership-{}-{}.json",
            std::process::id(),
            super::now_ms()
        ));
        std::fs::write(&path, &before).unwrap();
        let mut writes = 0;
        let mut dispatch = |payload: Value| -> Result<Prefs, BridgeError> {
            let command = prefs::parse_command(&payload).map_err(|_| err("invalid_schema"))?;
            check_island_membership(&command, &specialists)?;
            prefs::update(&current, &command, |next| {
                writes += 1;
                std::fs::write(&path, next.to_text()).is_ok()
            })
            .map_err(|_| err("save_failed"))
        };
        assert!(dispatch(json!({"action":"set_island_agents","order":["esp-missing"]})).is_err());
        assert!(dispatch(
            json!({"action":"set_island_agents","order":["esp-known","esp-missing"]})
        )
        .is_err());
        drop(dispatch);
        assert_eq!(writes, 0);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "refusal preserves actual file bytes including whitespace"
        );
        let command =
            prefs::parse_command(&json!({"action":"set_island_agents","order":["esp-known"]}))
                .unwrap();
        assert!(check_island_membership(&command, &specialists).is_ok());
        let saved = prefs::update(&current, &command, |next| {
            std::fs::write(&path, next.to_text()).is_ok()
        })
        .unwrap();
        assert_eq!(saved.island_agents, Some(vec!["esp-known".into()]));
        let persisted = Prefs::from_text(Some(&std::fs::read_to_string(&path).unwrap()));
        assert_eq!(persisted.island_agents, saved.island_agents);
        std::fs::remove_file(path).unwrap();
        assert!(check_island_membership(&Command::SetIslandAgents(vec![]), &specialists).is_ok());
    }

    /// 0.2.1 T2 (S1/S3): the Ajustes «En la isla» control writes through the REAL command path (parse -> membership -> update -> file).
    /// Toggling a pill off and on and re-sending the same specialists list must leave the file byte-identical, with no new key.
    #[test]
    fn island_toggles_through_the_real_handlers_round_trip_the_file_byte_for_byte() {
        use super::{check_island_membership, err, prefs, BridgeError, Prefs, Value};
        let specialists = crate::specialists::Store::from_text(Some(
            r#"{"v":1,"active":null,"specialists":[{"id":"esp-a1","name":"A","instructions":"x","model":null},{"id":"esp-b2","name":"B","instructions":"y","model":null}]}"#,
        ));
        let seed = Prefs::from_text(Some(
            r#"{"v":1,"sound":true,"main_pill":"agent_cursor","declared_pills":["agent_gemini","integration_github"],"island_agents":["esp-b2","esp-a1"]}"#,
        ));
        let path = std::env::temp_dir().join(format!("abito-island-roundtrip-{}-{}.json", std::process::id(), super::now_ms()));
        std::fs::write(&path, seed.to_text()).unwrap();
        let original = std::fs::read(&path).unwrap();
        let apply = |payload: Value| -> Result<Prefs, BridgeError> {
            let current = Prefs::from_text(Some(&std::fs::read_to_string(&path).unwrap()));
            let command = prefs::parse_command(&payload).map_err(|_| err("invalid_schema"))?;
            check_island_membership(&command, &specialists)?;
            prefs::update(&current, &command, |next| std::fs::write(&path, next.to_text()).is_ok()).map_err(|_| err("save_failed"))
        };
        // a stored Cursor main survives every step
        let off = apply(json!({"action":"toggle_declared_pill","id":"integration_github"})).unwrap();
        assert_eq!(off.declared_pills(), vec!["agent_gemini"]);
        assert_eq!(off.island_agents, Some(vec!["esp-b2".to_string(), "esp-a1".to_string()]), "a pill switch never touches the specialists list");
        assert_eq!(off.main_pill(), "agent_cursor");
        assert_ne!(std::fs::read(&path).unwrap(), original, "the intended field changed");
        let on = apply(json!({"action":"toggle_declared_pill","id":"integration_github"})).unwrap();
        assert_eq!(on.declared_pills(), vec!["agent_gemini", "integration_github"]);
        apply(json!({"action":"set_island_agents","order":["esp-b2","esp-a1"]})).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original, "off + on + the same specialists list = the same bytes");
        // only the intended field changes when a specialist goes off
        let spec_off = apply(json!({"action":"set_island_agents","order":["esp-b2"]})).unwrap();
        assert_eq!(spec_off.declared_pills(), on.declared_pills());
        let v: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect(); keys.sort();
        assert_eq!(keys, ["declared_pills", "island_agents", "main_pill", "sound", "v"], "no merged or new key is ever written");
        assert_eq!(v["island_agents"], json!(["esp-b2"]));
        // refusals leave the file alone: a 4th/unknown specialist and an unoffered pill
        let before = std::fs::read(&path).unwrap();
        assert!(apply(json!({"action":"set_island_agents","order":["esp-zz"]})).is_err());
        assert!(apply(json!({"action":"toggle_declared_pill","id":"not_a_pill"})).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::remove_file(path).unwrap();
    }
}

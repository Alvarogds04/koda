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
use koda_island::agentclient::{is_account_action, AccountStore};
use koda_island::agentconn::{island_root, AgentConn};
use koda_island::bridge::{self, BridgeError};
use koda_island::prefs::{self, Command, Prefs};
use koda_island::secrets::{self, LoginGuard, SessionReply};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// #390 GD027: how long a `restart` waits for the fresh daemon to answer `ready`.
/// K2-05 boot order = Gentle Dot (daemon.ts:470-481): the daemon now publishes its session and
/// answers `ready` as soon as its server listens — BEFORE its engine starts (the engine's own
/// boot, up to minutes while it reopens a long conversation, is reported live as
/// `starting`/`restarting`). So this bound covers only the daemon's pre-listen work (private
/// memory probe, the optional connector host's 10 s start bound) and is Gentle Dot's
/// DAEMON_START_TIMEOUT (shell.rs:52, 20 s); past it the answer is honestly `ready:false`, never a
/// success. Polling is cheap (a missing session.json fails in one stat) and bounded.
const RESTART_WAIT: Duration = Duration::from_secs(20);
const RESTART_POLL: Duration = Duration::from_millis(200);

/// K2-13 T6b-3 (S10/S20): «a login THIS island started is in flight». One app, one Telegram account, one login: the
/// reader thread consults it before a `telegram_session` reply is allowed into the OS keychain, so a session that
/// arrived while no login of ours was running (a stale reply, a second window, a replay) is never stored.
static TELEGRAM_LOGIN: LoginGuard = LoginGuard::new();

/// The `last_error` (code, n) this host already acted on. The connection's `last_error` is overwritten only by a NEW error, so
/// a stale one stays in every later view: acting on it each time would, after ONE revoked session, wipe the credentials of
/// every login that follows (and keep suppressing the session hand-off after a `telegram_unavailable`).
static TELEGRAM_ERROR_SEEN: Mutex<Option<(String, u64)>> = Mutex::new(None);

/// K2-13 F3: what this host knows about the ONE `telegram_session` reply of the current connection. The sink used to throw
/// `accept_session`'s answer away while the page claimed «la sesión quedó en el llavero» on any `connected`; the page now
/// gets this verdict as a boolean.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SessionStored {
    /// Nothing arrived on this connection (a start that restored an unchanged session, or a logout): the keychain's own
    /// copy is the session in use when the triple is there.
    Unknown,
    /// The reply this connection received was written.
    Stored,
    /// A reply of ours could not be written (the keychain refused it, or the session was off-contract).
    NotStored,
}

impl SessionStored {
    /// The stored form of the flag: a closed byte, never a value.
    const fn code(self) -> u8 {
        match self {
            SessionStored::Unknown => 0,
            SessionStored::Stored => 1,
            SessionStored::NotStored => 2,
        }
    }
}

impl From<u8> for SessionStored {
    fn from(n: u8) -> Self {
        match n {
            1 => SessionStored::Stored,
            2 => SessionStored::NotStored,
            _ => SessionStored::Unknown,
        }
    }
}

/// No app, no connection: process-wide, like [`TELEGRAM_LOGIN`], and reset by every login, logout, restore and dead session.
static TELEGRAM_SESSION_STORED: AtomicU8 = AtomicU8::new(SessionStored::Unknown.code());

fn remember_session_flag(flag: SessionStored) {
    TELEGRAM_SESSION_STORED.store(flag.code(), Ordering::SeqCst);
}

/// Record what became of one `telegram_session` reply. A `Foreign` reply (a replay, a stale frame, another window's
/// answer) says nothing about the keychain: it is dropped without touching the verdict.
fn note_session_reply(reply: Result<SessionReply, secrets::SecretError>) {
    match reply {
        Ok(SessionReply::Stored) => remember_session_flag(SessionStored::Stored),
        Ok(SessionReply::Refused) | Err(_) => remember_session_flag(SessionStored::NotStored),
        Ok(SessionReply::Foreign) => {}
    }
}

/// The single boolean the page receives. `Unknown` is answered from the keychain: a stored session Telegram did not rotate
/// is exactly the one the daemon is using, so it must not read as «no se pudo guardar».
fn session_stored_view(flag: SessionStored, credentials: bool) -> bool {
    match flag {
        SessionStored::Stored => true,
        SessionStored::NotStored => false,
        SessionStored::Unknown => credentials,
    }
}

/// The two booleans the page may know about the Telegram credentials — whether the triple exists, and whether the session
/// this connection uses is really in the OS keychain. Never one of the values. Computed in ONE place so the command reply
/// and the emitted `agent:state` can never drift apart (the event used to carry neither, and the page's flag flipped
/// false on every event).
fn telegram_flags(view: &mut Value) {
    let credentials = secrets::has_telegram_credentials(&secrets::Keychain);
    let stored = session_stored_view(TELEGRAM_SESSION_STORED.load(Ordering::SeqCst).into(), credentials);
    view["telegramCredentials"] = Value::Bool(credentials);
    view["telegramSessionStored"] = Value::Bool(stored);
}

/// K2-13 N1: what the host does when the daemon says the stored session is dead (AUTH_KEY_UNREGISTERED and friends): the
/// login guard is disarmed, the worthless triple goes and the session verdict falls back to the keychain. ONE helper for the
/// pre-step and the post-command block, so the two can never drift apart. The delete's failure is a log line without a
/// value (the page still gets the daemon's own verdict) and the next start retries.
fn forget_revoked_session(store: &dyn secrets::SecretStore, guard: &LoginGuard) {
    guard.cancel();
    if secrets::forget_telegram(store).is_err() {
        eprintln!("telegram: the revoked session could not be deleted from the keychain; the next start retries");
    }
    remember_session_flag(SessionStored::Unknown);
}

/// K2-13 N1: settle a revoked session this island has not been told about yet, BEFORE a login writes anything. It consults
/// the same `(code, n)` mark as the post-command block, so the two steps together act on one error exactly once: an error
/// already settled here is not settled again there.
fn settle_unseen_revoked_session(view: &Value, store: &dyn secrets::SecretStore, guard: &LoginGuard) -> bool {
    let fresh = fresh_error_code(view, &mut TELEGRAM_ERROR_SEEN.lock().expect("telegram error lock"));
    if fresh.as_deref() != Some("telegram_session_invalid") {
        return false;
    }
    forget_revoked_session(store, guard);
    true
}

/// K2-13 N3: whether `telegram_restore_if_needed` may run on this call. A login in flight owns the daemon's Telegram
/// session: the view `conn.command` returned is still `disconnected`, the triple the keychain already holds looks like a
/// restore, and the daemon's `restore()` STARTS by cancelling the pending login — the login the person just started dies.
fn restore_allowed(action: Option<&str>) -> bool {
    !matches!(
        action,
        Some("telegram_login_start" | "telegram_login_code" | "telegram_login_password")
    )
}

/// K2-13 N2: forget the `(code, n)` this host already acted on. A reconnect makes a NEW connection whose `last_error` starts
/// over at `{code: null, n: 0}` and whose counter restarts with it, so the error the previous connection ended on is not
/// this one's first error.
fn reset_seen(seen: &mut Option<(String, u64)>) {
    *seen = None;
}

/// The code of the view's `last_error` when it is one this host has not acted on yet, and marks it as acted on. `None` for
/// no error, a null code, or an error already handled. Compared by (code, n), not by order: a reconnect starts `n` over.
fn fresh_error_code(view: &Value, seen: &mut Option<(String, u64)>) -> Option<String> {
    let error = view.get("last_error");
    let Some(code) = error.and_then(|e| e.get("code")).and_then(Value::as_str) else {
        // No error at all, or the null one a brand-new connection starts with (`{code: null, n: 0}`): nothing from the
        // previous connection is remembered (N2).
        reset_seen(seen);
        return None;
    };
    let key = (code.to_string(), error.and_then(|e| e.get("n")).and_then(Value::as_u64).unwrap_or(0));
    if seen.as_ref() == Some(&key) {
        return None;
    }
    *seen = Some(key);
    Some(code.to_string())
}

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
        .and_then(|dir| AccountStore::load(dir.join("accounts.json"), std::sync::Arc::new(koda_island::secrets::Keychain)));
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
    { koda_island::contextwin::dbus::available(None) }
    #[cfg(not(target_os = "linux"))]
    { true } // HU-050: Windows/macOS read the native window list, no extension needed
}

/// HU-050: set only where the OS withholds window titles (macOS without Screen Recording access).
/// Abito never asks for that permission; the page says so instead.
fn context_title_note() -> Option<&'static str> {
    #[cfg(not(target_os = "linux"))]
    { if !koda_island::contextwin::titles_allowed() { return Some("sin título: falta permiso de Grabación de pantalla"); } }
    None
}

fn view_prefs(p: &Prefs) -> Value {
    json!({"sound": p.sound, "gain": p.gain(), "displayName": p.display_name, "avatarColors": p.avatar_colors,
        "mainPill": p.main_pill(), "declaredPills": p.declared_pills(),
        "pillColors": p.pill_colors,
        "theme": p.theme().as_str(),
        "autoCloseSeconds": p.auto_close_seconds(), "openOnHover": p.open_on_hover(),
        "customBlobs": p.custom_blobs_view(),
        "islandAgents": p.island_agents_view(),
        "abitoInstructions": p.koda_instructions_view(),
        "monitor": p.monitor,
        "showPlanInNotch": p.show_plan_in_notch(),
        "showCodexPlanInNotch": p.show_codex_plan_in_notch(),
        "phoneUsage": p.phone_usage(),
        "windowContext": p.window_context(),
        "windowCapture": p.window_capture(),
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

pub fn window_capture(host: &SettingsHost) -> bool {
    host.prefs.lock().expect("prefs lock").window_capture()
}

pub fn window_context(host: &SettingsHost) -> bool {
    host.prefs.lock().expect("prefs lock").window_context()
}

/// #489: whether the human put this integration pill on the island (main or declared).
pub fn pill_declared(host: &SettingsHost, id: &str) -> bool {
    koda_island::integrations::declared(&host.prefs.lock().expect("prefs lock"), id)
}

/// Only the already loaded, explicitly selected local preference reaches chat.
pub fn display_name(host: &SettingsHost) -> Option<String> {
    host.prefs.lock().expect("prefs lock").display_name.clone()
}

/// Read the principal's already loaded response preferences once for an immutable turn.
pub fn koda_instructions(host: &SettingsHost) -> Option<String> {
    host.prefs.lock().expect("prefs lock").koda_instructions.clone()
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

/// #264: where the human last dragged the island — the disc's spot (x = the island window's left, y = the disc's top edge on
/// screen, physical px), or None for the top-centre default. Until isla-cualquier-lado T6b this was the window's top-left:
/// identical for an upper-half island, while a bottom-edge window now stands on the disc instead of starting at it.
pub fn island_position(app: &AppHandle) -> Option<(i32, i32)> {
    let state = app.state::<AppState>();
    let saved = state.settings.prefs.lock().expect("prefs lock").position;
    saved
}

/// #264: commit the dragged island position through the same gate and atomic writer as every other preference.
/// Rust-internal (the pill drag release), never a wire command; no publication: the page never sees it.
pub fn save_island_position(app: &AppHandle, at: (i32, i32)) -> bool {
    let state = app.state::<AppState>();
    prefs::transact(
        &state.settings.prefs_serial,
        &state.settings.prefs,
        &prefs::Command::SetPosition(at.0, at.1),
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

/// K2-10 T4 (S5): the last visit of the mail card, ms since the epoch (0: never). Read from the
/// in-memory prefs under the same lock every other preferences writer takes.
pub fn gmail_last_seen_ms(app: &AppHandle) -> u64 {
    app.state::<AppState>()
        .settings
        .prefs
        .lock()
        .expect("prefs lock")
        .gmail_last_seen_ms()
}

/// K2-10 T4 (S5): remember a later visit through the SAME `prefs::transact` gate, file and atomic
/// writer as every other preference, so the mark never races a settings change. The mark is
/// monotonic (`prefs::apply` keeps the later of the two), never comes from the page and is never
/// published in the settings view. `false`: it could not be saved and the stored one stands.
pub fn remember_gmail_last_seen(app: &AppHandle, at_ms: u64) -> bool {
    let state = app.state::<AppState>();
    prefs::transact(
        &state.settings.prefs_serial,
        &state.settings.prefs,
        &prefs::Command::SetGmailLastSeen(at_ms),
        |p| persist_prefs(app, p),
        |_| {},
    )
    .is_ok()
}

/// K2-10 T8 (L23, L24): removes the 0.1 IMAP/SMTP mail accounts from the keychain once. Runs
/// off the startup thread; one attempt per launch, never a loop. The mark is stored only when
/// all seven keys are gone (or never existed), so a keychain that failed is retried on the next
/// launch, and a finished migration never touches the keychain again. Nothing here can stop Koda:
/// a failure only leaves a log line, which carries no value and no key name.
pub fn migrate_retired_mail_accounts(app: &AppHandle) {
    let done = app.state::<AppState>().settings.prefs.lock().expect("prefs lock").mail_migration_done();
    if done { return; }
    let app = app.clone();
    std::thread::spawn(move || {
        let outcome = koda_island::mailmigration::run(&koda_island::secrets::LegacyKeychain, false);
        if outcome == koda_island::mailmigration::Outcome::Done {
            let state = app.state::<AppState>();
            let saved = prefs::transact(
                &state.settings.prefs_serial,
                &state.settings.prefs,
                &Command::SetMailMigrationDone,
                |p| persist_prefs(&app, p),
                |_| {},
            );
            if saved.is_err() {
                eprintln!("mail migration: the keychain was cleaned but the mark could not be saved; the next launch checks again");
                return;
            }
        }
        let line = outcome.log_line();
        if !line.is_empty() { eprintln!("{line}"); }
    });
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

/// The ONE place an `AgentConn` is created: the panel's first use, `daemon_action status`, and the fresh client
/// after a restart all pass through here, so every connection carries the same two callbacks — the Ajustes emitter
/// and the phone link's session feed (S5/D5: the phone hangs off this connection, never a second one).
///
/// The view is handed in on purpose: a callback fires while the caller holds the agent slot, so it must never lock
/// it again (it did, once, and the first open of the panel hung forever).
pub(crate) fn agent_conn(handle: &AppHandle) -> AgentConn {
    let emitter = handle.clone();
    #[cfg(target_os = "linux")]
    let phone = handle.clone();
    // N2: a new connection's `last_error` starts over at `{code: null, n: 0}`: the (code, n) the previous connection ended on
    // is not this one's first error, even when both are the same code with the same counter.
    reset_seen(&mut TELEGRAM_ERROR_SEEN.lock().expect("telegram error lock"));
    // K2-13 T6b-3 (S20): the ONE `telegram_session` reply of this connection goes straight into the OS keychain, from the
    // reader thread and BEFORE the «connected» view is published. It never reaches the WebView, a log line or a frame. F3:
    // what became of it is recorded, so the next view says honestly whether the session really is in the keychain.
    let session_sink: koda_island::agentconn::SessionSink = Arc::new(|session: &str| {
        note_session_reply(secrets::accept_session(&secrets::Keychain, &TELEGRAM_LOGIN, session));
    });
    AgentConn::with_session_sink(
        move |mut view: Value| {
            // F3: the same two booleans the command reply carries, so the page's flags never flip on an event.
            telegram_flags(&mut view);
            #[cfg(target_os = "linux")]
            crate::phonehost::publish_sessions(&phone, &view);
            let _ = emitter.emit("agent:state", view);
        },
        session_sink,
    )
}

/// K2-13 T6b-3 (S20): hand the stored session to the daemon when the triple is complete and the daemon has none. It runs
/// at island start (the connect right above), after a reconnect and whenever Ajustes reads the Telegram state; the
/// daemon answers `telegram_status` and, only if Telegram rotated the session, one more `telegram_session` that the
/// reader thread stores — which is why the restore arms [`TELEGRAM_LOGIN`] (F4: that rotated session used to be dropped).
/// Returns whether a restore was sent.
fn telegram_restore_if_needed(conn: &AgentConn, telegram: &Value) -> bool {
    if telegram.get("state").and_then(Value::as_str) != Some("disconnected") {
        return false;
    }
    let Ok(Some(credentials)) = secrets::telegram_credentials(&secrets::Keychain) else { return false };
    let Ok(line) = serde_json::to_string(&credentials.restore_frame()) else { return false };
    if conn.send(&koda_island::agentclient::UiCommand::Wire(format!("{line}\n"))).is_err() {
        return false;
    }
    // The frame left: a `telegram_session` answering it is ours to store. Armed only on a send that succeeded — a line
    // that never left cannot be answered, and an armed guard would accept whatever arrived next.
    TELEGRAM_LOGIN.begin_restore();
    remember_session_flag(SessionStored::Unknown);
    true
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
        if let Some(op) = koda_island::agents_direct::parse(&payload) {
            let op = op.map_err(|_| err("invalid_schema"))?;
            return Ok(koda_island::agents_direct::perform(&op));
        }
        let mut guard = state.settings.agent.lock().expect("agent lock");
        // The one constructor: this view also feeds the phone link, which hangs off this same connection (S5/D5).
        let conn = guard.get_or_insert_with(|| agent_conn(&handle));
        let is_view_or_refresh = payload
            .get("action")
            .and_then(Value::as_str)
            .is_some_and(|a| a == "view" || a == "refresh");
        let connected = conn.view().get("connection").and_then(Value::as_str) == Some("connected");
        if !connected && is_view_or_refresh {
            if let Some(reason) = handle
                .state::<koda_island::daemonhost::HostSlot>()
                .failure()
            {
                conn.startup_failed(reason);
                return Ok(conn.view());
            }
            let root = island_root(
                std::env::var("KODA_ISLAND_DIR").ok().as_deref(),
                std::env::var("HOME").ok().as_deref(),
            );
            match root {
                Some(root) => {
                    // N2: a new connection's `last_error` starts over at `{code: null, n: 0}` and its counter restarts with
                    // it, so the (code, n) the previous connection ended on is not this one's first error.
                    reset_seen(&mut TELEGRAM_ERROR_SEEN.lock().expect("telegram error lock"));
                    conn.connect(&root)
                }
                None => return Err(err("no_island_root")),
            }
        }
        // K2-13 T6b-3 (S10/S20): the Telegram credential bridge. The page sends the api id, the api hash, the phone, the
        // code and the password ONCE; this side validates them with the daemon's own rules (agentclient's closed set),
        // keeps only the api pair in the OS keychain and forwards the rest, so the page never holds a stored secret. The
        // session travels the other way: `telegram_session` -> keychain -> `telegram_session_restore`, and never into a
        // view, an event or a log.
        let telegram_action = payload.get("action").and_then(Value::as_str).filter(|a| a.starts_with("telegram_"));
        // N1: an error this connection has not been acted on yet is settled BEFORE a login writes anything. A restore the
        // previous command sent is answered ASYNCHRONOUSLY (`telegram_session_invalid`), after that call returned, and the
        // `agent:state` emit path never marks an error as seen: left alone, the post-command step below would read that OLD
        // error as this login's answer, delete the pair it just wrote and disarm the guard while the daemon keeps logging
        // in — and the `telegram_session` reply that followed would then be dropped as Foreign. Same helper as below, so
        // the two steps cannot drift. `restore_allowed` is false for exactly the three login steps: the calls that write or
        // advance a login.
        if !restore_allowed(telegram_action) {
            settle_unseen_revoked_session(&conn.view(), &secrets::Keychain, &TELEGRAM_LOGIN);
        }
        if telegram_action == Some("telegram_login_start") {
            // A login is only worth starting when the pair can be stored: with no reachable keychain the answer is the
            // keychain's own code and NOTHING travels to the daemon (never a plaintext fallback, secrets.rs contract).
            let api_id = payload.get("apiId").and_then(Value::as_u64).unwrap_or(0);
            let api_hash = payload.get("apiHash").and_then(Value::as_str).unwrap_or_default();
            secrets::remember_api_pair(&secrets::Keychain, api_id, api_hash).map_err(|e| err(e.code()))?;
            TELEGRAM_LOGIN.begin();
            // A new login stores a NEW session: until that reply lands, the keychain's old copy is not the answer.
            remember_session_flag(SessionStored::Unknown);
        }
        if telegram_action == Some("telegram_logout") {
            // Account safety: after a logout nothing of this island may store or replay a session, whatever the keychain
            // still holds (`a revoked session must not be replayed`). The keychain itself is cleared only AFTER the daemon
            // was told — see N4 below.
            TELEGRAM_LOGIN.cancel();
        }
        let mut view = match conn.command(&payload) {
            Ok(view) => view,
            Err(_) => {
                if telegram_action == Some("telegram_login_start") {
                    TELEGRAM_LOGIN.cancel();
                }
                // N4: nothing reached the daemon, so nothing was logged out and nothing is forgotten.
                return Err(err("agent_unavailable"));
            }
        };
        // K2-13 N4: the stored triple goes only AFTER the daemon was told to log out. Deleting first made a locked keychain
        // a logout that could never happen (the account stayed connected at Telegram and the page only said «no se pudo»);
        // now a delete that fails is still not a success — the page gets a closed code of ours, never the keychain's text —
        // while the account IS disconnected, and the stale entry a failed delete leaves is cleaned by the
        // `telegram_session_invalid` path on the next start.
        if telegram_action == Some("telegram_logout") {
            // Nothing arrived on this connection for the login guard, and no stored session is the one in use any more.
            remember_session_flag(SessionStored::Unknown);
            secrets::forget_telegram(&secrets::Keychain).map_err(|_| err("telegram_forget_failed"))?;
        }
        // Each `last_error` is acted on ONCE (see TELEGRAM_ERROR_SEEN): a stale one must not keep touching the keychain.
        let fresh_error = fresh_error_code(&view, &mut TELEGRAM_ERROR_SEEN.lock().expect("telegram error lock"));
        // A dead session (AUTH_KEY_UNREGISTERED and friends) means the keychain copy is worthless: forget it so the next
        // start does not hand the daemon a credential Telegram already revoked. F8: the delete is attempted here and its
        // failure is NOT turned into a false «borrado» — the page must still get the daemon's verdict, so the failure is
        // recorded as a log line without a value and the next start retries. The same helper settles the same error in the
        // pre-step above; the (code, n) mark keeps the pair from acting twice on one error.
        if fresh_error.as_deref() == Some("telegram_session_invalid") {
            forget_revoked_session(&secrets::Keychain, &TELEGRAM_LOGIN);
        }
        // The hand-off of a session this island already holds: at start (this is the first connect), after a reconnect
        // and whenever Ajustes reads the state. Only when the daemon says it has none, and not on the call that just
        // learned the daemon's Telegram is unavailable (an older `telegram_unavailable` does not block it any more). N3: a
        // login step must not restore either — the daemon's `restore()` begins by cancelling the pending login. Residual,
        // documented and NOT solved here: a restore answered only with `telegram_status` leaves `TELEGRAM_LOGIN` armed (see
        // `telegram_restore_if_needed`); the daemon sends `telegram_session` only to the connection that asked, so acting on
        // a stale arm would need a daemon bug.
        if restore_allowed(telegram_action) && fresh_error.as_deref() != Some("telegram_unavailable") {
            if let Some(telegram) = view.get("telegram").cloned() {
                if telegram_restore_if_needed(&conn, &telegram) {
                    view = conn.view();
                }
            }
        }
        // The page may know whether the island holds the three values, and whether the session it is using is really in the
        // keychain. It never learns any of them.
        telegram_flags(&mut view);
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
    watch: Option<&koda_island::daemonhost::HostSlot>,
) -> (String, bool) {
    let mut guard = state.settings.agent.lock().expect("agent lock");
    let conn = guard.get_or_insert_with(|| agent_conn(handle));
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
    let Some(root) = island_root(std::env::var("KODA_ISLAND_DIR").ok().as_deref(), std::env::var("HOME").ok().as_deref()) else { return false };
    let old = state.settings.agent.lock().expect("agent lock").take();
    drop(old);
    let slot = handle.state::<koda_island::daemonhost::HostSlot>();
    slot.stop();
    slot.start();
    daemon_connect(handle, &state, &root, Some(RESTART_WAIT), Some(&*slot));
    slot.failure().is_none() && slot.pid().is_some()
}

/// The pid in `<root>/runtime/session.json`, read ONLY to compare it with our own
/// child inside Rust (#390 fix). It never crosses to the page.
fn session_pid(root: &std::path::Path) -> Option<u32> {
    let text = std::fs::read_to_string(koda_island::agentconn::session_path(root)).ok()?;
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
        let root = island_root(std::env::var("KODA_ISLAND_DIR").ok().as_deref(), std::env::var("HOME").ok().as_deref())
            .ok_or_else(|| err("no_island_root"))?;
        if action == "restart" {
            // K2-05 (L51, copy Gentle Dot): like its tray «Restart assistant» (shell.rs:743-745 →
            // restart_daemon), «Reiniciar» always restarts, even while the engine is starting; the
            // saved conversation is safe because a failed or cut reopen never writes state.json.
            // The old client (and its reader) go BEFORE its daemon; the fresh one below
            // starts from `no_daemon`, never from a stale `connected`.
            let old = state.settings.agent.lock().expect("agent lock").take();
            drop(old);
            // Bounded stop (daemonhost Drop: TERM group, KILL, reap) then a fresh spawn.
            let slot = handle.state::<koda_island::daemonhost::HostSlot>();
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
mod telegram_error_tests {
    use super::fresh_error_code;
    use serde_json::json;

    fn view(code: serde_json::Value, n: u64) -> serde_json::Value {
        json!({"last_error": {"code": code, "n": n}})
    }

    #[test]
    fn an_error_is_fresh_once_and_never_again() {
        let mut seen = None;
        let v = view(json!("telegram_session_invalid"), 3);
        assert_eq!(fresh_error_code(&v, &mut seen).as_deref(), Some("telegram_session_invalid"));
        // the same view comes back with every later call: it must not be acted on again
        assert_eq!(fresh_error_code(&v, &mut seen), None);
        assert_eq!(fresh_error_code(&v, &mut seen), None);
    }

    #[test]
    fn a_new_error_is_fresh_even_with_the_same_code_or_a_smaller_n() {
        let mut seen = None;
        assert!(fresh_error_code(&view(json!("telegram_session_invalid"), 3), &mut seen).is_some());
        assert!(fresh_error_code(&view(json!("telegram_session_invalid"), 4), &mut seen).is_some(), "the next error of the same kind");
        assert!(fresh_error_code(&view(json!("telegram_session_invalid"), 1), &mut seen).is_some(), "a reconnect starts n over");
        assert!(fresh_error_code(&view(json!("telegram_unavailable"), 1), &mut seen).is_some(), "another code");
    }

    #[test]
    fn no_error_is_never_fresh() {
        let mut seen = None;
        assert_eq!(fresh_error_code(&json!({}), &mut seen), None);
        assert_eq!(fresh_error_code(&view(json!(null), 0), &mut seen), None);
        assert_eq!(seen, None, "nothing was recorded for a view with no error");
    }
}

#[cfg(test)]
mod telegram_revoked_session_tests {
    use super::{reset_seen, restore_allowed, settle_unseen_revoked_session, TELEGRAM_ERROR_SEEN};
    use koda_island::secrets::{
        remember_api_pair, LoginGuard, SecretStore, StoreError, TELEGRAM_API_HASH, TELEGRAM_API_ID,
        TELEGRAM_SESSION,
    };
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    const HASH: &str = "8f3c1d9ae2b74c05d61fa8b3c0e7d294";

    /// The in-memory stand-in for the OS keychain: no test ever reads or writes the user's real one.
    #[derive(Default)]
    struct TinyStore {
        values: Mutex<BTreeMap<String, String>>,
        deletes: Mutex<Vec<String>>,
    }

    impl TinyStore {
        fn with_triple() -> TinyStore {
            let store = TinyStore::default();
            {
                let mut values = store.values.lock().unwrap();
                values.insert(TELEGRAM_API_ID.to_string(), "20405128".to_string());
                values.insert(TELEGRAM_API_HASH.to_string(), HASH.to_string());
                values.insert(TELEGRAM_SESSION.to_string(), "AQAAAAAsession0123456789+/base64==".to_string());
            }
            store
        }
        fn keys(&self) -> Vec<String> {
            self.values.lock().unwrap().keys().cloned().collect()
        }
        fn get(&self, key: &str) -> Option<String> {
            self.values.lock().unwrap().get(key).cloned()
        }
        fn deletes(&self) -> Vec<String> {
            self.deletes.lock().unwrap().clone()
        }
    }

    impl SecretStore for TinyStore {
        fn read(&self, key: &str) -> Result<Option<String>, StoreError> {
            Ok(self.get(key))
        }
        fn write(&self, key: &str, value: &str) -> Result<(), StoreError> {
            self.values.lock().unwrap().insert(key.to_string(), value.to_string());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), StoreError> {
            self.deletes.lock().unwrap().push(key.to_string());
            self.values.lock().unwrap().remove(key);
            Ok(())
        }
    }

    fn revoked_view(n: u64) -> Value {
        json!({"last_error": {"code": "telegram_session_invalid", "n": n}})
    }

    /// K2-13 N1: agent_action settles an error it has not acted on yet BEFORE `telegram_login_start` writes its pair. A
    /// restore answered after the previous command returned leaves an UNSEEN `telegram_session_invalid` in the view the
    /// `agent:state` emit never marks; without the pre-step, the post-command step reads that OLD error as this login's
    /// answer, deletes the pair it just wrote and disarms the guard while the daemon keeps logging in.
    ///
    /// What this test can and cannot see: the helper's contract (settle once, act once) is exercised here; the ORDER inside
    /// `agent_action` needs an `AppHandle`, so it is not unit-testable and only the helper makes it one code path.
    #[test]
    fn a_revoked_session_is_settled_once_before_the_login_writes_so_its_new_pair_survives() {
        *TELEGRAM_ERROR_SEEN.lock().expect("telegram error lock") = None;
        let store = TinyStore::with_triple();
        let guard = LoginGuard::new();
        guard.begin();
        let stale = revoked_view(2);
        // the pre-step: the session really is revoked, so the triple and the guard go
        assert!(settle_unseen_revoked_session(&stale, &store, &guard), "the first settle acts on the error");
        assert!(!guard.pending(), "the login guard is disarmed with the dead session");
        assert!(store.keys().is_empty(), "the dead session and its pair are gone: {:?}", store.keys());
        // the login writes its pair and begins
        guard.begin();
        remember_api_pair(&store, 20_405_128, HASH).expect("the pair is stored");
        let deletes_before = store.deletes();
        // `last_error` is only overwritten by a NEW error: the same view still carries it on every later call
        assert!(!settle_unseen_revoked_session(&stale, &store, &guard), "an error already acted on is not acted on again");
        assert_eq!(store.get(TELEGRAM_API_ID).as_deref(), Some("20405128"), "the pair the login just wrote survives: {:?}", store.keys());
        assert_eq!(store.get(TELEGRAM_API_HASH).as_deref(), Some(HASH));
        assert_eq!(store.deletes(), deletes_before, "nothing was deleted the second time");
        assert!(guard.pending(), "and the login in flight is still armed to store its session");
        // TRIANGULATE: only a revoked session touches the keychain. Another code says nothing about the stored triple.
        *TELEGRAM_ERROR_SEEN.lock().expect("telegram error lock") = None;
        let unavailable = json!({"last_error": {"code": "telegram_unavailable", "n": 1}});
        assert!(!settle_unseen_revoked_session(&unavailable, &store, &guard), "an unavailable daemon is not a dead session");
        assert_eq!(store.get(TELEGRAM_API_ID).as_deref(), Some("20405128"), "the pair survives: {:?}", store.keys());
        assert!(guard.pending(), "and a login in flight is still armed");
    }

    /// K2-13 N2: a reconnect makes a new connection whose `last_error` is the null one, and the daemon's counter restarts
    /// with it. Acting on the previous connection's (code, n) must not swallow the first error of the new one.
    #[test]
    fn a_reconnect_forgets_the_error_the_previous_connection_ended_on() {
        use super::fresh_error_code;
        let mut seen = None;
        let stale = revoked_view(1);
        assert_eq!(fresh_error_code(&stale, &mut seen).as_deref(), Some("telegram_session_invalid"));
        assert_eq!(fresh_error_code(&stale, &mut seen), None, "the same error is not acted on twice");
        // a reconnect: a brand-new ClientState, whose last_error is the null one
        assert_eq!(fresh_error_code(&json!({"last_error": {"code": null, "n": 0}}), &mut seen), None);
        // n restarts on the new connection: its first error can repeat the last one's (code, n) and is still a new error
        assert_eq!(
            fresh_error_code(&stale, &mut seen).as_deref(),
            Some("telegram_session_invalid"),
            "the first error of a new connection is a new error, even with the same code and n"
        );
        // TRIANGULATE: the mark is also cleared directly where a connection is made (`reset_seen`).
        let mut act = Some(("telegram_session_invalid".to_string(), 1));
        assert_eq!(fresh_error_code(&stale, &mut act), None, "the mark swallows the same error");
        reset_seen(&mut act);
        assert_eq!(fresh_error_code(&stale, &mut act).as_deref(), Some("telegram_session_invalid"), "after a reset the same (code, n) is fresh again");
    }

    /// K2-13 N3: a login in flight owns the daemon's Telegram session. `restore()` starts by cancelling the pending login, so
    /// a restore on the same call as a login step kills the login the person just started.
    #[test]
    fn a_login_in_flight_is_never_restored_over() {
        for action in ["telegram_login_start", "telegram_login_code", "telegram_login_password"] {
            assert!(!restore_allowed(Some(action)), "{action} owns the session: a restore would cancel it");
        }
        for action in [Some("telegram_logout"), Some("view"), Some("transcription_set"), None] {
            assert!(restore_allowed(action), "{action:?} must still restore a stored session");
        }
    }
}

#[cfg(test)]
mod telegram_session_flag_tests {
    use super::{session_stored_view, SessionStored};

    /// K2-13 F3: the page may only claim «la sesión quedó en el llavero» when the host knows it did. The flag is the
    /// host's own verdict on the ONE reply this connection received; `Unknown` (nothing arrived) is answered from the
    /// keychain itself, because a session Telegram did not rotate is the stored one the daemon is using.
    #[test]
    fn the_session_is_flagged_stored_only_when_the_keychain_really_holds_it() {
        // the reply this connection received was written: stored, whatever the triple read says a moment later
        assert!(session_stored_view(SessionStored::Stored, true));
        assert!(session_stored_view(SessionStored::Stored, false));
        // a write the keychain refused, or a session that was off-contract: NOT stored, even while an older triple is
        // still there (the page says «no se pudo guardar» instead of claiming a session it never wrote)
        assert!(!session_stored_view(SessionStored::NotStored, true));
        assert!(!session_stored_view(SessionStored::NotStored, false));
        // no reply on this connection (a start that restored an unchanged session): the stored triple IS that session
        assert!(session_stored_view(SessionStored::Unknown, true));
        assert!(!session_stored_view(SessionStored::Unknown, false), "no triple, no stored session: never an invented one");
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

    /// K2-05 boot order: the restart wait is Gentle Dot's DAEMON_START_TIMEOUT (shell.rs:52).
    #[test]
    fn the_restart_wait_is_gentle_dots_daemon_start_timeout() {
        assert_eq!(super::RESTART_WAIT, std::time::Duration::from_secs(20), "Gentle Dot's DAEMON_START_TIMEOUT");
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

    /// L72: the per-provider model allowlist pref was removed; the projection carries no
    /// `chosenModels` key at all, and the removed command is refused with the same bridge
    /// code as any unknown action — an old file that still has the key projects and saves clean.
    #[test]
    fn l72_the_webview_projection_carries_no_chosen_models_key() {
        use koda_island::prefs::{parse_command, update, Prefs};
        let legacy = Prefs::from_text(Some(
            r#"{"v":1,"sound":false,"chosen_models":{"anthropic":["claude-x"]}}"#,
        ));
        let view = view_prefs(&legacy);
        assert!(
            view.get("chosenModels").is_none(),
            "the projection carries no chosenModels key: {view}"
        );
        assert!(
            view_prefs(&Prefs::default()).get("chosenModels").is_none(),
            "the defaults carry no key either"
        );
        assert_eq!(view["sound"], json!(false), "the other prefs still project");
        // The removed action never reaches a transaction: the same refusal as any unknown one.
        let refused = parse_command(
            &json!({"action":"set_chosen_models","provider":"anthropic","models":["claude-x"]}),
        )
        .map_err(|_| super::err("invalid_schema"))
        .unwrap_err();
        let unknown = parse_command(&json!({"action":"choose_models"}))
            .map_err(|_| super::err("invalid_schema"))
            .unwrap_err();
        assert_eq!(refused.code, unknown.code, "exactly the unknown-command refusal");
        assert_eq!(refused.code, "invalid_schema");
        // A file that sourced the old key still takes an unrelated command, dropping the key.
        let next = update(
            &legacy,
            &parse_command(&json!({"action":"sound_on"})).unwrap(),
            |_| true,
        )
        .unwrap();
        assert!(next.to_text().contains(r#""sound":true"#));
        assert!(
            !next.to_text().contains("chosen_models"),
            "the next save drops the key: {}",
            next.to_text()
        );
    }

    /// #389: the chosen panel monitor reaches the WebView only as the validated
    /// typed pref; no choice projects as null, like every optional field.
    #[test]
    fn f389_the_webview_projection_carries_the_chosen_monitor() {
        use koda_island::prefs::{parse_command, update, Prefs};
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
    }

    /// #455: effective placement is always the window, without migrating stored keys.
    #[test]
    fn f093_the_webview_projection_carries_the_settings_window_choice() {
        use koda_island::prefs::Prefs;
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
        use koda_island::prefs::{parse_command, update, Prefs};
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
        use koda_island::prefs::{parse_command, update, Prefs};
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
        use koda_island::prefs::Prefs;
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

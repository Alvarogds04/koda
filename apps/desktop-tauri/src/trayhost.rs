//! #315 — the tray host: the real TrayIcon wiring (F098/T01, GD026/GD028).
//!
//! Menu: Mostrar Koda / Ocultar / Arrancar al iniciar sesión (the #315
//! autostart toggle; the file system is its state) / Salir. The icon state is
//! recomputed on every publish tick (`refresh`) from the same snapshot facts
//! the page sees, plus the agent connection view; the question-pending fact
//! arrives through an atomic updated off-thread by `note_question_change`
//! (an observer may fire while a caller holds the transport guard — the same
//! rule `questionhost::invalidate` already obeys: never reenter synchronously).
//!
//! HU-048: the tray now exists on Linux, macOS AND Windows (the human: «que abito salga en los iconos oculto abajo a la derecha de
//! windows»). The menu comes from the pure `tray::menu_spec`; the only difference is «Arrancar al iniciar sesión», offered only where the
//! autostart toggle works (Unix today). Any other platform keeps the honest no-op: nothing is created, nothing is pretended.

use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use tauri::{AppHandle, Manager};

use crate::tray::{self, TrayState};
use crate::AppState;

/// Last drawn state (honest start: `disconnected` until a fact says otherwise),
/// so identical refreshes never touch the tray.
static CURRENT: AtomicU8 = AtomicU8::new(TrayState::Disconnected as u8);
/// Question-pending fact, recomputed off-thread by `note_question_change`.
static QUESTION_PENDING: AtomicBool = AtomicBool::new(false);

/// The connection name the tray derives from: the agent slot's view when one
/// exists (empty string before the first connect: unknown → fails closed to
/// `disconnected`, never a guess).
fn connection_state(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    // Bound first, returned second: the mutex guard's temporary must drop
    // before the `State` binding (E0597, tail-expression temporaries).
    let name = match state.settings.agent.try_lock() {
        Ok(guard) => match guard.as_ref() {
            Some(conn) => conn
                .view()
                .get("connection")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            None => String::new(),
        },
        // the agent slot is busy (a connect or a command holds it): the honest
        // read is "unknown this tick" — derive fails closed to `disconnected`
        Err(_) => String::new(),
    };
    name
}

/// Recompute the tray state from the snapshot facts and redraw when it moved.
/// Called from `publish` — which may run while a caller holds the transport
/// guard — so this NEVER locks the transport: the question fact comes from
/// [`QUESTION_PENDING`], maintained by [`note_question_change`].
pub fn refresh(app: &AppHandle, snapshot: &Value) {
    let card_pending =
        snapshot.get("card").and_then(|c| c.get("state")).and_then(Value::as_str) == Some("pending");
    let unavailable = snapshot
        .get("unavailable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let next = tray::derive(
        &connection_state(app),
        card_pending,
        QUESTION_PENDING.load(Ordering::SeqCst),
        unavailable,
    );
    if CURRENT.swap(next as u8, Ordering::SeqCst) == next as u8 {
        return;
    }
    #[cfg(any(unix, windows))]
    set_tray_state(app, next);
}

/// Transport observer entry (installed on `on_question_change`): recompute the
/// question-pending fact OFF the observer thread, then republish so the tray
/// catches the transition at once. Never locks anything on the caller.
pub fn note_question_change(app: &AppHandle) {
    if crate::QUITTING.load(Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        if crate::QUITTING.load(Ordering::SeqCst) {
            return;
        }
        let state = handle.state::<AppState>();
        let pending = crate::questionhost::with_pending(&state, |p| p);
        QUESTION_PENDING.store(pending, Ordering::SeqCst);
        if !crate::QUITTING.load(Ordering::SeqCst) {
            crate::publish(&handle, &state);
        }
    });
}

#[cfg(any(unix, windows))]
fn set_tray_state(app: &AppHandle, state: TrayState) {
    if let Some(icon) = app.tray_by_id(TRAY_ID) {
        let glyph = tray::glyph_rgba(state);
        if let Err(e) = icon.set_icon(Some(tauri::image::Image::new_owned(
            glyph.rgba,
            glyph.width,
            glyph.height,
        ))) {
            eprintln!("tray: icon update failed: {e}");
        }
        if let Err(e) = icon.set_tooltip(Some(state.label())) {
            eprintln!("tray: tooltip update failed: {e}");
        }
    }
}

const TRAY_ID: &str = "abito-tray";

/// Keep the returned handle alive: the manager retains the icon, but holding
/// it here makes the lifetime explicit and independent of Tauri internals.
#[cfg(any(unix, windows))]
static TRAY: std::sync::Mutex<Option<tauri::tray::TrayIcon<tauri::Wry>>> = std::sync::Mutex::new(None);

/// The autostart check item's handle: TrayIcon has no menu getter, so the one
/// control the tray mutates after build is retained here directly.
#[cfg(unix)]
static AUTOSTART_CHECK: std::sync::Mutex<Option<tauri::menu::CheckMenuItem<tauri::Wry>>> =
    std::sync::Mutex::new(None);

#[cfg(unix)]
fn autostart_entry() -> Option<std::path::PathBuf> {
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let home = std::env::var("HOME").ok();
    crate::autostart::entry_path(xdg.as_deref(), home.as_deref())
}

#[cfg(unix)]
fn sync_autostart_check(app: &AppHandle, on: bool) {
    if let Ok(slot) = AUTOSTART_CHECK.lock() {
        if let Some(check) = slot.as_ref() {
            if let Err(e) = check.set_checked(on) {
                eprintln!("tray: autostart check sync failed: {e}");
            }
        }
    }
    let _ = app; // TrayIcon has no menu getter; the handle is what matters
}

/// Shared by the tray and prefs_action; the entry file remains the only state.
pub(crate) fn autostart_enabled() -> Option<bool> {
    #[cfg(unix)] { autostart_entry().map(|p| crate::autostart::is_enabled_at(&p)) }
    #[cfg(not(unix))] { None }
}

pub(crate) fn set_autostart(app: &AppHandle, enabled: bool) -> Result<bool, crate::autostart::AutostartError> {
    #[cfg(unix)] {
        use crate::autostart::{self, AutostartError};
        let path = autostart_entry().ok_or(AutostartError::InvalidPath)?;
        let exe = std::env::current_exe().map_err(AutostartError::Io)?;
        let result = autostart::set_enabled_at(&path, enabled, &exe);
        let actual = autostart::is_enabled_at(&path);
        sync_autostart_check(app, actual);
        result.map(|_| actual)
    }
    #[cfg(not(unix))] { let _ = (app, enabled); Err(crate::autostart::AutostartError::Unsupported) }
}

/// The toggle: the entry file IS the state (Coucou T02 semantics). A failed
/// change leaves the check mark synced to the file system, never to the wish.
#[cfg(unix)]
fn toggle_autostart(app: &AppHandle) {
    if let Err(error) = set_autostart(app, !autostart_enabled().unwrap_or(false)) {
        eprintln!("tray: {error}");
    }
}

#[cfg(any(unix, windows))]
fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "tray-show" => crate::restore(app),
        "tray-hide" => {
            let state = app.state::<AppState>();
            let _ = crate::dispatch_action(app, &state, crate::Action::Hide, None);
        }
        "tray-quit" => crate::quit_clean(app),
        #[cfg(unix)]
        "tray-autostart" => toggle_autostart(app),
        _ => {}
    }
}

#[cfg(any(unix, windows))]
pub fn start(app: &AppHandle) {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    // Every step fails soft: a host without a working tray service must never
    // take the island down — the island runs tray-less and says why.
    let build = || -> Result<tauri::tray::TrayIcon<tauri::Wry>, tauri::Error> {
        // Offered only where the toggle works: a desktop entry on Unix; Windows has no Run-key implementation (HU-048).
        let autostart_supported = cfg!(unix);
        #[cfg(unix)]
        let autostart_on = autostart_entry().as_deref().map(crate::autostart::is_enabled_at).unwrap_or(false);
        let menu = Menu::new(app)?;
        for entry in tray::menu_spec(autostart_supported) {
            let kind = match entry {
                tray::MenuEntry::Item(id, text) => MenuItemKind::MenuItem(MenuItem::with_id(app, id, text, true, None::<&str>)?),
                tray::MenuEntry::Separator => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
                tray::MenuEntry::Check(id, text) => {
                    #[cfg(unix)]
                    {
                        let launch = CheckMenuItem::with_id(app, id, text, true, autostart_on, None::<&str>)?;
                        if let Ok(mut slot) = AUTOSTART_CHECK.lock() { *slot = Some(launch.clone()); }
                        MenuItemKind::Check(launch)
                    }
                    #[cfg(not(unix))]
                    { MenuItemKind::Check(CheckMenuItem::with_id(app, id, text, true, false, None::<&str>)?) }
                }
            };
            menu.append(&kind)?;
        }

        let initial = tray::glyph_rgba(TrayState::from_index(CURRENT.load(Ordering::SeqCst)));
        TrayIconBuilder::with_id(TRAY_ID)
            .icon(tauri::image::Image::new_owned(
                initial.rgba,
                initial.width,
                initial.height,
            ))
            .tooltip(TrayState::from_index(CURRENT.load(Ordering::SeqCst)).label())
            .menu(&menu)
            .show_menu_on_left_click(true)
            .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
            .build(app)
    };
    match build() {
        Ok(icon) => {
            if let Ok(mut slot) = TRAY.lock() {
                *slot = Some(icon);
            }
            spawn_initial_connect(app);
        }
        Err(e) => eprintln!("tray unavailable: {e}"),
    }
}

/// One honest connection attempt after startup: the host child has just been
/// started and needs a moment to write `session.json`; bounded, off the setup
/// thread, and its landing republishes so the tray (and the page) catch the
/// connection immediately instead of a second later.
#[cfg(any(unix, windows))]
fn spawn_initial_connect(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        if crate::QUITTING.load(Ordering::SeqCst) {
            return;
        }
        let root = abito_island::agentconn::island_root(
            std::env::var("ABITO_ISLAND_DIR").ok().as_deref(),
            std::env::var("HOME").ok().as_deref(),
        );
        let Some(root) = root else { return };
        let state = handle.state::<AppState>();
        let _ = crate::settingshost::daemon_connect(
            &handle,
            &state,
            &root,
            Some(std::time::Duration::from_secs(6)),
            None,
        );
        if !crate::QUITTING.load(Ordering::SeqCst) {
            crate::publish(&handle, &state);
        }
    });
}

// --- honest stub for any other platform ---------------------------------------

#[cfg(not(any(unix, windows)))]
#[allow(unused_variables)]
pub fn start(app: &AppHandle) {
    // No tray on this platform: nothing is created, nothing is pretended.
}
// `refresh` and `note_question_change` above are platform-neutral (the icon redraw inside is Unix/Windows).

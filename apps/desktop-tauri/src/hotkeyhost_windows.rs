//! Windows U3a hotkey host: a real `RegisterHotKey` grab held on a dedicated
//! pump thread (`crate::hotkey::win32::Grabber`), with the same honest status
//! contract as the Unix host. Configuration IPC mirrors `hotkeyhost.rs`: every
//! change rebinds, persists, and publishes the REAL grabber status — Active
//! when the shortcut is ours, Taken when another app holds the combo,
//! Unsupported when the system refuses it. The backend string is `win32` so
//! the frontend can say «Atajo de Windows» instead of lying about X11.
use crate::AppState;
use abito_island::bridge::{self, BridgeError};
use abito_island::hotkey::{self, Command, HotkeyConfig, View};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

const FILE: &str = "hotkey.json";

/// The system-wide id our WM_HOTKEY messages carry back. One live grab at a
/// time (a rebind always releases the old one before registering anew).
#[cfg(any(windows, target_os = "macos"))]
const HOTKEY_ID: u32 = 1;

#[cfg(windows)]
use abito_island::hotkey::win32::Grabber;

/// The Windows host is only ever compiled for the Windows target (main.rs
/// mounts this file under cfg(not(unix)), and the only non-unix build here is
/// x86_64-pc-windows-msvc). The alias documents the shape this file would have
/// elsewhere: a grab that exists but holds nothing.
#[cfg(target_os = "macos")]
use abito_island::hotkey::macos::Grabber;

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
#[derive(Default)]
struct Grabber;
#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
impl Grabber {
    fn status(&self) -> hotkey::Status {
        hotkey::Status::Unsupported
    }
}

/// The live grab, if any. `None` means the shortcut is not held: either it is
/// disabled or the app is between grabs.
#[derive(Default)]
pub struct HotkeyHost {
    config: Mutex<HotkeyConfig>,
    grabber: Mutex<Option<Grabber>>,
}

fn config_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

fn load(app: &AppHandle) -> HotkeyConfig {
    let text = config_path(app).and_then(|path| std::fs::read_to_string(path).ok());
    HotkeyConfig::from_text(text.as_deref())
}

fn persist(app: &AppHandle, config: &HotkeyConfig) {
    let Some(path) = config_path(app) else { return };
    let _ = crate::platform::fs::write_private_atomic(&path, config.to_text().as_bytes());
}

/// The View mirrors the Unix host's `view_of`: held grabber → its real status;
/// no grabber → the idle truth from `hotkey::idle_status` (disabled, or
/// honestly unsupported while nothing holds the shortcut).
fn view_of(config: &HotkeyConfig, held: Option<&Grabber>) -> View {
    View {
        combo: config.combo.to_string(),
        enabled: config.enabled,
        status: match held {
            Some(g) => g.status(),
            None => hotkey::idle_status(config),
        },
        limited: false,
        backend: if cfg!(target_os = "macos") { "macos" } else { "win32" },
        portal_note: None,
        effective: None,
    }
}

fn publish(app: &AppHandle) {
    let state = app.state::<AppState>();
    let host = &state.hotkey;
    let config = host.config.lock().expect("hotkey config lock");
    let held = host.grabber.lock().expect("hotkey grabber lock");
    let _ = app.emit("hotkey:state", view_of(&config, held.as_ref()));
}

/// (Re)grab according to the current config, exactly like the Unix `rebind`:
/// the old grab is released first so a rebind never leaves two; a taken combo
/// is REPORTED, never retried silently.
fn rebind(app: &AppHandle) {
    let state = app.state::<AppState>();
    let host = &state.hotkey;
    if let Some(old) = host.grabber.lock().expect("hotkey grabber lock").take() {
        drop(old); // releases the system grab (the pump unregisters on its own thread)
    }
    let cfg = host.config.lock().expect("hotkey config lock").clone();
    if cfg.enabled {
        #[cfg(windows)]
        {
            let handle = app.clone();
            let grab = Grabber::start(HOTKEY_ID, cfg.combo, move |event| {
                let _ = event; // GrabEvent::Pressed is the only variant
                press_on_main(&handle);
            });
            *host.grabber.lock().expect("hotkey grabber lock") = Some(grab);
        }
        #[cfg(target_os = "macos")]
        {
            // HU-053: Carbon delivers presses on the main run loop, so register there. No
            // permission is involved; the closure publishes the real status when it is known.
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let press = handle.clone();
                let grab = Grabber::start(HOTKEY_ID, cfg.combo, move || press_on_main(&press));
                let state = handle.state::<AppState>();
                *state.hotkey.grabber.lock().expect("hotkey grabber lock") = Some(grab);
                publish(&handle);
            });
            return;
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = &cfg;
        }
    }
    publish(app);
}

/// Startup: load the persisted config and grab it (probe/test runs stay out of
/// the human's keyboard unless they ask for it).
pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    *state.hotkey.config.lock().expect("hotkey config lock") = load(app);
    rebind(app);
}

/// Release the grab before leaving (mirrors the Unix host's stop). The old
/// grab moves into a local first so the MutexGuard temporary dies on the same
/// statement: as the block's tail expression the if-let would drop its
/// temporaries AFTER `state` (E0597, edition-2024 tail scope).
pub fn stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    let host = &state.hotkey;
    let old = host.grabber.lock().expect("hotkey grabber lock").take();
    if let Some(old) = old {
        drop(old);
    }
}

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo cambiar el atajo.".into() }
}

/// Settings IPC: same closed command set as the Unix host; every mutation
/// rebinds so the status the user sees is the status the OS gave us.
#[tauri::command]
pub async fn hotkey_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|url| url.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = hotkey::parse_command(&payload).map_err(|error| err(error.code()))?;
    state.chat_rate.lock().expect("chat rate lock").check(crate::now_ms())?;
    if !matches!(command, Command::View) {
        let next = {
            let mut config = state.hotkey.config.lock().expect("hotkey config lock");
            match command {
                Command::Enable => config.enabled = true,
                Command::Disable => config.enabled = false,
                Command::Reset => *config = HotkeyConfig::default(),
                Command::Set(combo) => {
                    config.combo = combo;
                    config.enabled = true;
                }
                Command::View | Command::Suspend | Command::Resume => {}
            }
            config.clone()
        };
        persist(&app, &next);
        rebind(&app);
    }
    let config = state.hotkey.config.lock().expect("hotkey config lock");
    let held = state.hotkey.grabber.lock().expect("hotkey grabber lock");
    Ok(json!(view_of(&config, held.as_ref())))
}

/// A real WM_HOTKEY press lands here (pump thread → main thread), and the
/// probe calls the same function: one route, the Unix `on_press`, with its
/// X11 focus hand-back replaced by `hotkey::foreground` (HU-049).
#[allow(dead_code)]
pub(crate) fn press_target_from_action(app: &AppHandle, _target: abito_island::hotkey::Target) { press_on_main(app); }

pub(crate) fn press_on_main(app: &AppHandle) {
    let inner = app.clone();
    let _ = app.run_on_main_thread(move || {
        if crate::QUITTING.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        static PRESS_GATE: Mutex<hotkey::PressGate> =
            Mutex::new(hotkey::PressGate::new_const());
        if !PRESS_GATE
            .lock()
            .map(|mut gate| gate.accept(crate::now_ms() as u64))
            .unwrap_or(true)
        {
            return;
        }
        let state = inner.state::<AppState>();
        let hidden = *state.phase.lock().expect("phase lock") == abito_island::desktop::IslandState::Hidden;
        let pending = crate::questionhost::with_pending(&state, |pending| pending);
        match hotkey::toggle_decision(hidden, pending) {
            hotkey::ToggleDecision::Show => {
                // HU-049: the human is typing elsewhere. Remember who has the keyboard, show
                // the island and, if the OS gave it the keyboard anyway, hand it straight back
                // (the twin of the Unix host's X11 give_focus_back).
                let before = hotkey::foreground::current();
                crate::restore(&inner);
                if before.is_none() { return; }
                let Some(win) = crate::main_window(&inner) else { return };
                let inner = inner.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    let focused = win.is_focused().unwrap_or(false);
                    if let Some(previous) = hotkey::foreground::hand_back(focused, false, before) {
                        // AppKit is main-thread only; Win32 does not care, so one path serves both.
                        let _ = inner.run_on_main_thread(move || {
                            let _ = hotkey::foreground::give_back(previous);
                        });
                    }
                });
            }
            hotkey::ToggleDecision::Hide => {
                let _ = crate::dispatch_verb(&inner, &state, bridge::Action::Hide, None);
            }
            hotkey::ToggleDecision::Ignore => {}
        }
    });
}

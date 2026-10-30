//! #455 S8: Ajustes always opens in its own window, replacing island settings.
//! The closed open/close command keeps its sender and rate gates. Legacy
//! placement preferences are retained on disk but never restore island settings.
//!
//! The window is created by RUST ONLY: the label and its dedicated page URL
//! (`settings.html`, admitted only for the exact settings label) never
//! come from the page. The window shares the main sender gate (extended to
//! the exact `settings` label, approved narrowly) and the shared rate
//! limiter. No secret, token or path crosses to the WebView here.

use crate::AppState;
use abito_island::bridge::{self, BridgeError};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Once;
use std::time::Duration;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// The exact window label the sender gate admits for the settings window.
/// The gate is exact-string (approved): no other label shares the bridge.
pub const SETTINGS_LABEL: &str = "settings";

/// T6.2 (D2, design §3): the own window's contract sizes, in LOGICAL px — the
/// unit `inner_size`/`min_inner_size` take. The default is the design size; the
/// minimum matches `prefs::SETTINGS_WINDOW_SIZE_MIN`.
pub(crate) const DEFAULT_INNER_SIZE: (f64, f64) = (760.0, 560.0);
pub(crate) const MIN_INNER_SIZE: (f64, f64) = (720.0, 480.0);

/// T6.2 (pure): the inner size the own Ajustes window opens at, in logical px.
///
/// A remembered size is used ONLY when it is within the stored bounds (already
/// validated at load — re-checked here because this function is pure) AND fits
/// the current work area; anything else falls back to the DEFAULT — never a
/// guessed clamp of a size the current screen cannot show. Whatever was chosen
/// is then clamped into the work area (never bigger than the screen) and never
/// below the window minimum: on a screen smaller than the minimum, the minimum
/// wins — the WM enforces `min_inner_size` anyway.
pub(crate) fn opening_size(stored: Option<(u32, u32)>, work: (u32, u32)) -> (f64, f64) {
    let (min_w, min_h) = abito_island::prefs::SETTINGS_WINDOW_SIZE_MIN;
    let (max_w, max_h) = abito_island::prefs::SETTINGS_WINDOW_SIZE_MAX;
    let usable = |(w, h): (u32, u32)| {
        w >= min_w && w <= max_w && h >= min_h && h <= max_h && w <= work.0 && h <= work.1
    };
    let chosen = stored
        .filter(|s| usable(*s))
        .map(|(w, h)| (w as f64, h as f64))
        .unwrap_or(DEFAULT_INNER_SIZE);
    // ceiling-then-floor, never f64::clamp: the work area may be SMALLER than
    // the minimum, and there the minimum must win (not a panic, not zero) —
    // the WM enforces min_inner_size anyway.
    (
        chosen.0.min(work.0 as f64).max(MIN_INNER_SIZE.0),
        chosen.1.min(work.1 as f64).max(MIN_INNER_SIZE.1),
    )
}

// ---- T6.2: the debounced persister of the remembered size --------------------

/// How long the own window must stay still before its size is saved: not on
/// every pixel of an interactive drag-resize, only once it settles.
const RESIZE_QUIET_MS: u64 = 700;

/// The pending size, in LOGICAL px, written ONLY by the main-thread window
/// event (the event payload, never a window getter — R2) and read by the one
/// persister thread, which touches nothing else of the window.
static PENDING_W: AtomicU32 = AtomicU32::new(0);
static PENDING_H: AtomicU32 = AtomicU32::new(0);
/// Wall-clock ms of the last recorded resize and of the last committed save.
static CHANGED_AT_MS: AtomicU64 = AtomicU64::new(0);
static SAVED_AT_MS: AtomicU64 = AtomicU64::new(0);
static PERSISTER: Once = Once::new();

/// T6.2 (pure): a resize is due for saving when one happened AFTER the last
/// save AND the window has stayed still for the whole quiet period. A failed
/// save leaves `last_save_ms` behind `last_change_ms`, so it re-arms on its
/// own; a clock that appears to run backwards saves nothing.
pub(crate) fn save_due(last_change_ms: u64, last_save_ms: u64, now_ms: u64, quiet_ms: u64) -> bool {
    last_change_ms > last_save_ms && now_ms.saturating_sub(last_change_ms) >= quiet_ms
}

/// T6.2: record a resize of the own Ajustes window. Called from the MAIN-THREAD
/// window event with the size from the EVENT PAYLOAD and the scale factor read
/// right here on the main thread — no window getter is ever called off-thread
/// or while a host lock is held (review finding R2). Starts the one persister
/// thread on the first resize.
pub(crate) fn note_resized(app: &AppHandle, width: u32, height: u32, scale: f64) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    PENDING_W.store(((width as f64) / scale).round() as u32, Ordering::SeqCst);
    PENDING_H.store(((height as f64) / scale).round() as u32, Ordering::SeqCst);
    CHANGED_AT_MS.store(crate::now_ms() as u64, Ordering::SeqCst);
    PERSISTER.call_once(|| spawn_persister(app.clone()));
}

fn spawn_persister(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(200));
        if crate::QUITTING.load(Ordering::SeqCst) {
            break;
        }
        let now = crate::now_ms() as u64;
        if !save_due(
            CHANGED_AT_MS.load(Ordering::SeqCst),
            SAVED_AT_MS.load(Ordering::SeqCst),
            now,
            RESIZE_QUIET_MS,
        ) {
            continue;
        }
        let w = PENDING_W.load(Ordering::SeqCst);
        let h = PENDING_H.load(Ordering::SeqCst);
        if crate::settingshost::save_settings_window_size(&app, w, h) {
            SAVED_AT_MS.store(now, Ordering::SeqCst);
        } else {
            // back off: the change stays unsaved (last_save is behind last_change)
            // and is retried after the quiet period, not on every tick.
            std::thread::sleep(Duration::from_millis(RESIZE_QUIET_MS));
        }
    });
}

/// #366 F093: commands that act on the MAIN island window (drag, desktop verbs)
/// are for the island webview only. The settings window runs the same page, so
/// these refuse any label that is not exactly `main` (exact, case-sensitive).
pub(crate) fn main_window_only(label: &str) -> Result<(), BridgeError> {
    if label == "main" {
        Ok(())
    } else {
        Err(BridgeError::denied("wrong window label"))
    }
}

fn err(code: &str) -> BridgeError {
    BridgeError {
        code: code.into(),
        message: "No se pudo abrir Ajustes en su ventana.".into(),
    }
}

/// The Ajustes pages Rust may open a window on, in sidebar order. A CLOSED list of ASCII ids (the same ids the page's own shell
/// uses): the page that reaches the webview is always one of these exact strings, never text from the payload.
pub(crate) const PAGES: &[&str] = &[
    "dictation", "notes", "insights", "dictionary", "snippets", "styles", "flowsettings",
    "general", "integrations", "agents", "chat", "voice", "phone", "shortcuts", "privacy",
];

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Request {
    /// Open (or raise) the window, optionally on one of [`PAGES`].
    Open(Option<&'static str>),
    Close,
}

/// The closed payload: `{"action":"open"}`, `{"action":"open","page":<one of PAGES>}` or `{"action":"close"}` — no URL, no label,
/// no size: the window's identity is Rust's decision, and the page is chosen from Rust's own list (exact, case-sensitive).
pub(crate) fn parse_settings_window_request(payload: &Value) -> Option<Request> {
    let obj = payload.as_object()?;
    match obj.get("action")?.as_str()? {
        "close" if obj.len() == 1 => Some(Request::Close),
        "open" if obj.len() == 1 => Some(Request::Open(None)),
        "open" if obj.len() == 2 => {
            let wanted = obj.get("page")?.as_str()?;
            // 0.2.1 (S1, option B): «Integraciones» and «Agentes» are two pages again; the old «pills» link lands on Integraciones.
            let wanted = if wanted == "pills" { "integrations" } else { wanted };
            PAGES.iter().copied().find(|p| *p == wanted).map(|p| Request::Open(Some(p)))
        }
        _ => None,
    }
}

/// Kept for the original contract (and its tests): the action alone.
pub(crate) fn parse_settings_window_action(payload: &Value) -> Option<&'static str> {
    match parse_settings_window_request(payload)? {
        Request::Open(None) => Some("open"),
        Request::Close => Some("close"),
        Request::Open(Some(_)) => None,
    }
}

/// Handed to a NEW window before its scripts run: the page to open first. Built only from [`PAGES`].
pub(crate) fn page_script(page: &str) -> String { format!("window.__abitoHubPage=\"{page}\";") }
/// HU-045: handed to every NEW settings window: the version of the package it was built from (Cargo.toml, the same value as
/// tauri.conf.json). One source of truth; the page never writes a version itself.
pub(crate) fn version_script() -> String { format!("window.__abitoVersion=\"{}\";", display_version()) }
/// Rule 13: the release channel this build belongs to (`apps/desktop-tauri/RELEASE_CHANNEL`): `preview.N` for a preview, empty for a
/// stable release. Bumped together with Cargo.toml/tauri.conf.json every time a version is published.
pub(crate) const RELEASE_CHANNEL: &str = include_str!("../RELEASE_CHANNEL");
/// What Ajustes shows: «0.3.0 (preview 4)» for a preview, «0.3.0» for a stable build.
pub(crate) fn display_version() -> String { display_version_of(env!("CARGO_PKG_VERSION"), RELEASE_CHANNEL) }
pub(crate) fn display_version_of(version: &str, channel: &str) -> String {
    match channel.trim().strip_prefix("preview.") {
        Some(n) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => format!("{version} (preview {n})"),
        _ => version.to_owned(),
    }
}
/// Sent to a window that already exists. The shell listens for it and shows that page (anything off its own list is ignored).
pub(crate) fn select_script(page: &str) -> String {
    format!("document.dispatchEvent(new CustomEvent('abito:hub-select',{{detail:\"{page}\"}}));")
}

/// Called once during main-thread setup. Login startup never steals focus.
pub(crate) fn open_on_launch(app: &AppHandle, autostarted: bool) {
    if !autostarted && crate::settingshost::voice_prefs_snapshot(app).open_settings_at_launch() {
        if let Err(error) = open_window(app, None) { eprintln!("settings launch failed: {error}"); }
    }
}

/// The window, created or shown by Rust only. A repeat `open` shows and
/// focuses the existing window instead of building a second one. The URL is
/// the dedicated `settings.html` page (the closed settings-label entry); the window is
/// decorated, resizable and NOT always-on-top — it is a normal window.
fn open_window(app: &AppHandle, page: Option<&'static str>) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
        if let Some(page) = page { let _ = win.eval(select_script(page)); }
        win.show()?;
        let _ = win.unminimize();
        win.set_focus()?;
        return Ok(());
    }
    // T6.2: the remembered size (a typed pref, never page-supplied) when it fits
    // the CURRENT screen, else the design default — clamped to the work area,
    // never below the minimum. The main window's work area is the best available
    // source before this window exists.
    let work = app
        .get_webview_window("main")
        .map(|main| {
            let rect = crate::workarea::current(&main).rect;
            (rect.w.max(0) as u32, rect.h.max(0) as u32)
        })
        .unwrap_or((u32::MAX, u32::MAX));
    let (w, h) = opening_size(crate::settingshost::settings_window_size(app), work);
    let mut builder = WebviewWindowBuilder::new(
        app,
        SETTINGS_LABEL,
        WebviewUrl::App(std::path::PathBuf::from("settings.html")),
    );
    if let Some(page) = page { builder = builder.initialization_script(page_script(page)); }
    builder = builder.initialization_script(version_script());
    builder
    .title("Ajustes")
    .inner_size(w, h)
    .min_inner_size(MIN_INNER_SIZE.0, MIN_INNER_SIZE.1)
    .resizable(true)
    .build()
    .map(|_| ())
}

#[tauri::command]
pub async fn settings_window_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    // Same sender gate (main island or the settings window itself) and the
    // same shared rate limiter as every other closed command.
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state
        .chat_rate
        .lock()
        .expect("chat rate lock")
        .check(crate::now_ms())?;
    let request = parse_settings_window_request(&payload).ok_or_else(|| err("invalid_schema"))?;
    match request {
        Request::Open(page) => {
            open_window(&app, page).map_err(|e| {
                eprintln!("settings window open failed: {e}");
                err("window_failed")
            })?;
            Ok(json!({"action": "open", "open": true}))
        }
        // Closing asks the window to close; the ordinary CloseRequested path
        // (allowed for this label only) does the rest. A missing window is fine.
        Request::Close => {
            if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
                let _ = win.close();
            }
            Ok(json!({"action": "close", "open": false}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{main_window_only, parse_settings_window_action, SETTINGS_LABEL};
    use serde_json::json;

    /// #366 F093: the command payload is closed — exactly the two actions.
    #[test]
    fn f093_the_settings_window_command_is_exactly_open_or_close() {
        assert_eq!(
            parse_settings_window_action(&json!({"action": "open"})),
            Some("open")
        );
        assert_eq!(
            parse_settings_window_action(&json!({"action": "close"})),
            Some("close")
        );
        for bad in [
            json!({}),
            json!({"action": "focus"}),
            json!({"action": "open", "url": "https://evil.example/"}),
            json!({"action": "open", "label": "settings"}),
            json!({"action": 1}),
            json!("open"),
            json!(null),
            json!({"Action": "open"}),
            json!({"action": "open", "w": 900}),
        ] {
            assert_eq!(
                parse_settings_window_action(&bad),
                None,
                "{bad} must be refused"
            );
        }
    }

    /// #503 S26: «Configurar Pi…» opens Ajustes ON a page. The page is a CLOSED name chosen from Rust's own list: the payload
    /// can carry it, but only when it is exactly one of the listed ids (never a path, a URL, a label or a size).
    #[test]
    fn s26_open_may_name_one_closed_page_and_nothing_else() {
        use super::{parse_settings_window_request, Request};
        assert_eq!(parse_settings_window_request(&json!({"action": "open"})), Some(Request::Open(None)));
        assert_eq!(parse_settings_window_request(&json!({"action": "close"})), Some(Request::Close));
        for page in ["general", "chat", "voice", "integrations", "agents", "phone", "shortcuts", "dictation", "flowsettings"] {
            assert_eq!(parse_settings_window_request(&json!({"action": "open", "page": page})), Some(Request::Open(Some(page_id(page)))), "{page}");
        }
        assert_eq!(parse_settings_window_request(&json!({"action": "open", "page": "pills"})), Some(Request::Open(Some(page_id("integrations")))), "0.2.1: the old pills link lands on Integraciones");
        for bad in [json!({"action": "open", "page": "accounts"}), json!({"action": "open", "page": "Accounts"}), json!({"action": "open", "page": "accounts "}), json!({"action": "open", "page": "../x"}),
            json!({"action": "open", "page": ""}), json!({"action": "open", "page": 1}), json!({"action": "open", "page": null}), json!({"action": "open", "page": ["accounts"]}),
            json!({"action": "open", "page": "accounts", "url": "https://evil.example/"}), json!({"action": "close", "page": "accounts"}),
            json!({"action": "open", "page": "constructor"}), json!({"action": "open", "page": "a".repeat(5000)}), json!({"action": "open", "label": "settings"})] {
            assert_eq!(parse_settings_window_request(&bad), None, "{bad} must be refused");
        }
    }

    fn page_id(name: &str) -> &'static str { super::PAGES.iter().copied().find(|p| *p == name).expect("closed page") }

    /// #503 S26: the page reaches the window as ONE inert script assignment built only from the closed list (no page text is ever
    /// interpolated), and a window that already exists is told the same way instead of being rebuilt.
    #[test]
    fn s26_the_page_hint_script_is_built_from_the_closed_list_only() {
        assert_eq!(super::page_script("chat"), "window.__abitoHubPage=\"chat\";");
        assert_eq!(super::select_script("chat"), "document.dispatchEvent(new CustomEvent('abito:hub-select',{detail:\"chat\"}));");
        for page in super::PAGES { assert!(page.bytes().all(|b| b.is_ascii_lowercase()), "{page}"); }
    }

    /// HU-045 (human: «veo que la version que me sale es esta Abito 0.1.0»): Ajustes shows the version of the package it was
    /// built from, one source of truth (Cargo.toml = tauri.conf.json), handed to the window as one inert assignment.
    #[test]
    fn hu045_the_settings_window_is_told_the_package_version() {
        assert!(super::version_script().starts_with(&format!("window.__abitoVersion=\"{}", env!("CARGO_PKG_VERSION"))));
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["version"], env!("CARGO_PKG_VERSION"), "tauri.conf.json and Cargo.toml agree");
        assert!(env!("CARGO_PKG_VERSION").bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-'), "inert in a script");
    }

    /// Rule 13 (human, 29-oct: «me sale en ajustes 0.1.2 creoque eso no cambia, es importanet que cambie» / «esto ponlo como
    /// requisito que siempre poner si se cambia de version»): Ajustes shows the version AND the preview it belongs to, from one
    /// source (Cargo.toml + RELEASE_CHANNEL), e.g. «0.3.0 (preview 4)»; a stable build shows «0.3.0».
    #[test]
    fn rule13_settings_shows_the_version_with_its_preview_label() {
        assert_eq!(super::display_version_of("0.3.0", "preview.4"), "0.3.0 (preview 4)");
        assert_eq!(super::display_version_of("0.3.0", ""), "0.3.0");
        assert_eq!(super::display_version_of("0.3.0", "preview.4\n"), "0.3.0 (preview 4)", "a trailing newline in the file is not part of it");
        assert_eq!(super::version_script(), format!("window.__abitoVersion=\"{}\";", super::display_version()));
        let channel = super::RELEASE_CHANNEL.trim();
        assert!(channel.is_empty() || (channel.starts_with("preview.") && channel["preview.".len()..].parse::<u32>().is_ok_and(|n| n > 0)), "{channel:?}");
        assert_ne!(env!("CARGO_PKG_VERSION"), "0.1.2", "never the stale 0.1.2 label");
    }

    /// Koda 0.1 — Human 30-oct («Vamosa a cerrar esta version cambiar el nombre del repo por Koda y apartir de aqui empezaremos esta sera la version 0.1» → «Todo se llama Koda, repo nuevo desde 0.1» + «Solo lo visible»): the first Koda release is 0.1.0 stable (no preview label).
    #[test]
    fn koda_first_release_is_0_1_0_stable() {
        assert_eq!(env!("CARGO_PKG_VERSION"), "0.1.0");
        assert_eq!(super::RELEASE_CHANNEL.trim(), "", "a stable release has no preview label");
        assert_eq!(super::display_version(), "0.1.0");
    }

    /// #366 F093: island-window commands refuse every label but the exact `main`.
    #[test]
    fn f093_main_window_commands_refuse_the_settings_label() {
        assert!(main_window_only("main").is_ok());
        for label in ["settings", "Main", "main2", "main ", "", "Settings"] {
            let e = main_window_only(label).expect_err(label);
            assert_eq!(e.code, "denied", "{label:?}");
        }
    }

    /// #366 F093 source contract: each command acting on the MAIN island window
    /// calls the label gate before touching anything.
    /// The navigation lock must admit exactly what the sender gate admits: the settings
    /// window loads its own settings.html, so a lock that still used the island-only page
    /// allowlist blocked the window at startup ("navigation blocked from settings").
    #[test]
    fn the_navigation_lock_uses_the_sender_gate_rule() {
        let src = include_str!("main.rs");
        let at = src.find("fn navigation_lock()").expect("navigation_lock missing");
        let body = &src[at..];
        let end = body.find("\n}\n").unwrap_or(body.len());
        let body = &body[..end];
        assert!(body.contains("bridge::sender_ok(webview.label(), url.as_str()).is_ok()"), "{body}");
        assert!(!body.contains("page_url_allowed"), "{body}");
    }

    #[test]
    fn f093_the_four_island_commands_check_the_label_first() {
        let src = include_str!("main.rs");
        for name in [
            "fn drag_press(",
            "fn drag_move(",
            "fn drag_release(",
            "async fn desktop_action(",
        ] {
            let at = src.find(name).unwrap_or_else(|| panic!("{name} missing"));
            let body = &src[at..];
            let end = body.find("\n}\n").unwrap_or(body.len());
            let head: String = body[..end].lines().take(8).collect::<Vec<_>>().join("\n");
            assert!(
                head.contains("main_window_only(webview.label())"),
                "{name} must gate on the label first:\n{head}"
            );
        }
    }

    /// #366 F093: the commands reachable from the `settings` label are pinned EXACTLY. Every
    /// other Tauri command must call `main_window_only` near its top, so a future command can
    /// never silently become reachable from the settings window.
    #[test]
    fn f093_the_commands_reachable_from_settings_are_pinned_exactly() {
        const REACHABLE: [&str; 17] = [
            "agent_action",
            "daemon_action",
            "dictation_action",
            "failure_action",
            "hotkey_action",
            "models_action",
            "monitor_action",
            "oauth_action",
            "pi_install_action",
            "plan_action",
            "prefs_action",
            "recap_action",
            "secret_action",
            "settings_window_action",
            "sound_action",
            "specialists_action",
            "voice_action",
        ];
        let needle = concat!("#[tauri", "::command]");
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut ungated = std::collections::BTreeSet::new();
        let mut all = std::collections::BTreeSet::new();
        for entry in std::fs::read_dir(dir).expect("src dir") {
            let path = entry.expect("entry").path();
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if !name.ends_with(".rs") || name.ends_with("_tests.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("read");
            let lines: Vec<&str> = text.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if line.trim() != needle {
                    continue;
                }
                let Some(off) = lines[i + 1..].iter().position(|l| l.contains("fn ")) else {
                    continue;
                };
                let decl = lines[i + 1 + off];
                let fname = decl
                    .split("fn ")
                    .nth(1)
                    .and_then(|r| r.split('(').next())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let window = lines[i + 1..(i + 16).min(lines.len())].join("\n");
                all.insert(fname.clone());
                if !window.contains("main_window_only(") && !window.contains("from_character(") {
                    ungated.insert(fname);
                }
            }
        }
        let want: std::collections::BTreeSet<String> =
            REACHABLE.iter().map(|s| s.to_string()).collect();
        assert_eq!(
            ungated, want,
            "commands reachable from the settings label changed"
        );
        assert!(
            all.len() >= 20,
            "the scan must see every command, saw {all:?}"
        );
    }

    /// #366 F093: the label is the exact one the (narrowly extended) sender
    /// gate admits; it is a constant here so the gate and the window can
    /// never drift apart.
    #[test]
    fn f093_the_label_is_the_exact_string_the_gate_admits() {
        assert_eq!(SETTINGS_LABEL, "settings");
    }

    // ---- T6.2: the opening size of the own window (pure, no window system) ---

    use super::{opening_size, save_due, DEFAULT_INNER_SIZE, MIN_INNER_SIZE};

    /// T6.2 (D2, design §3): the own window is 760x560 (HU-063 S1: the Sidebar-Koda design size; was 960x640) with min 720x480, both
    /// in logical px — the unit `inner_size`/`min_inner_size` take.
    #[test]
    fn t62_the_window_opens_at_the_design_size_and_honors_the_minimum() {
        assert_eq!(DEFAULT_INNER_SIZE, (760.0, 560.0));
        assert_eq!(MIN_INNER_SIZE, (720.0, 480.0));
        assert_eq!(opening_size(None, (1920, 1080)), (760.0, 560.0));
        assert_eq!(opening_size(None, (7680, 4320)), (760.0, 560.0));
    }

    /// T6.2: a remembered size is used only when it is within the stored bounds
    /// AND fits the current work area; anything else falls back to the default —
    /// never a guessed clamp of a size the current screen cannot show.
    #[test]
    fn t62_a_remembered_size_is_used_only_when_it_fits_the_current_screen() {
        assert_eq!(
            opening_size(Some((1100, 700)), (1920, 1080)),
            (1100.0, 700.0)
        );
        assert_eq!(
            opening_size(Some((720, 480)), (1920, 1080)),
            (720.0, 480.0),
            "the min is a usable memory"
        );
        // outside the current screen (either axis): the default, not a clamp
        assert_eq!(
            opening_size(Some((2200, 1400)), (1920, 1080)),
            (760.0, 560.0)
        );
        assert_eq!(
            opening_size(Some((1100, 1400)), (1920, 1080)),
            (760.0, 560.0)
        );
        assert_eq!(
            opening_size(Some((1921, 1080)), (1920, 1080)),
            (760.0, 560.0)
        );
        // hostile stored values (already dropped at load; re-checked here because
        // this function is pure) fall back to the default too
        assert_eq!(opening_size(Some((100, 700)), (1920, 1080)), (760.0, 560.0));
        assert_eq!(
            opening_size(Some((5000, 700)), (8000, 4000)),
            (760.0, 560.0)
        );
        assert_eq!(opening_size(Some((960, 100)), (8000, 4000)), (760.0, 560.0));
    }

    /// T6.2: whatever size was chosen (default or remembered) is clamped into
    /// the work area so the window never opens bigger than the screen, and never
    /// below the window minimum — on a screen smaller than the minimum, the
    /// minimum wins (the WM enforces min_inner_size anyway).
    #[test]
    fn t62_the_opening_size_is_clamped_to_the_work_area_never_below_the_minimum() {
        // the default fits: untouched
        assert_eq!(opening_size(None, (1920, 1080)), (760.0, 560.0));
        // work area narrower or shorter than the default: clamped down on that axis only
        assert_eq!(opening_size(None, (740, 700)), (740.0, 560.0));
        assert_eq!(
            opening_size(None, (1920, 500)),
            (760.0, 500.0),
            "clamped to the area, still above the minimum"
        );
        assert_eq!(
            opening_size(None, (1920, 470)),
            (760.0, 480.0),
            "the minimum floors the clamp"
        );
        // work area smaller than the minimum: the minimum wins on both axes
        assert_eq!(opening_size(None, (600, 400)), (720.0, 480.0));
        assert_eq!(opening_size(None, (720, 480)), (720.0, 480.0));
        // a remembered size that fits is still clamped if the area shrank
        // between runs in a way that leaves it inside — the boundary is exact
        assert_eq!(opening_size(Some((900, 500)), (900, 500)), (900.0, 500.0));
    }

    /// T6.2: the debounce decision (pure) — a resize is saved when one happened
    /// AFTER the last save and the window has stayed still for the whole quiet
    /// period; a save failure re-arms (the change stays unsaved) and a clock
    /// that appears to run backwards saves nothing.
    #[test]
    fn t62_the_debounce_saves_once_the_window_stays_still() {
        const QUIET: u64 = 700;
        // nothing yet
        assert!(!save_due(0, 0, 10_000, QUIET), "no resize ever recorded");
        // quiet period not elapsed
        assert!(!save_due(1_000, 0, 1_699, QUIET));
        assert!(save_due(1_000, 0, 1_700, QUIET));
        // a second resize restarts the quiet period from its own timestamp
        assert!(!save_due(2_000, 1_000, 2_699, QUIET));
        assert!(save_due(2_000, 1_000, 2_700, QUIET));
        // already saved: a new resize re-arms, otherwise nothing is due
        assert!(!save_due(1_000, 1_000, 9_999, QUIET));
        assert!(save_due(5_000, 1_000, 5_700, QUIET));
        // a failed save left last_save behind the change: still due
        assert!(save_due(1_000, 500, 1_700, QUIET));
        // a clock that runs backwards never reports due (no underflow panic)
        assert!(!save_due(9_999, 0, 1_000, QUIET));
    }
}

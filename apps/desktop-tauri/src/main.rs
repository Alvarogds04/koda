//! Abito island — Electron to Rust+Tauri migration, units M1b (host/bridge)
//! + M2 (Pi transport receiver).
//!
//! Fixed-window island (X11 geometry, click policy, read-back probe) plus the host
//! layer ported from the Electron sources (`preload.cjs`, `core.cjs`,
//! `security.cjs`, `main.cjs`):
//! - `window.desktop.*` served by the single `desktop_action` command behind
//!   the Electron validation gate (see [`bridge`]),
//! - `desktop:state` snapshot events with Electron's exact snapshot shape
//!   (see [`desktop`]),
//! - lifecycle: single instance (second launch restores/shows/focuses the
//!   running island and the new process exits), work-area re-clamp watcher,
//!   clean quit through `RunEvent::Exit`,
//! - navigation locked to the local app page; strict CSP and a
//!   least-privilege capability live in `tauri.conf.json` /
//!   `capabilities/main.json`,
//! - M2: the Unix-domain-socket notice receiver (see [`transport`]) feeds
//!   `notices`/`connections`/`unavailable` into the snapshot, wires the
//!   `dismiss` verb, and is cleaned up on quit and on SIGINT/SIGTERM.

// U4 (windows port): the shipped build must not open a console window — the
// island is a GUI app. Debug builds keep the console on purpose: the U2 VM
// session reads stdout through SSH, and losing the log would trade one
// artifact flaw for a blind spot.
#![cfg_attr(all(target_os = "windows", not(debug_assertions)), windows_subsystem = "windows")]

mod autostart;
mod characterhost;
mod chathost;
#[cfg(target_os = "linux")]
mod hotkeyhost;
#[cfg(not(target_os = "linux"))]
#[path = "hotkeyhost_windows.rs"]
mod hotkeyhost;
mod tray;
mod trayhost;
mod githubhost;
mod mailhost;
mod monitorshost;
mod secretshost;
mod oauthhost;
mod soundshost;
mod failurehost;
mod recaphost;
mod planhost;
mod dictationhost;
mod voicehost;
mod settingshost;
mod islandhit;
mod islandclick;
mod pihost;
mod settingswindow;
mod integrationshost;
mod spotifyhost;
mod specialists;
mod specialistshost;
mod modelshost;
#[cfg(target_os = "linux")]
mod nativeaudit;
mod nativewindow;
mod islandshape;
#[cfg(any(debug_assertions, feature = "probe"))]
mod probe;
mod platform;
mod questionhost;

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use abito_island::bridge::{self, Action, BridgeError};
use abito_island::chat::ChatError;
use abito_island::chatlane::{self, Target};
use abito_island::core::{self, Core, ReleaseOutcome, TogglePlan, WindowIo};
use abito_island::desktop::{self, IslandState};
#[cfg(target_os = "linux")]
use abito_island::hotkey;
use abito_island::geometry::{self, Edge, Rect};
#[cfg(any(debug_assertions, feature = "probe"))]
use abito_island::fakebridge;
use abito_island::{approval, protocol, transport, workarea};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// The only native size/placement funnel for the island. A normal view toggle
/// does not enqueue a resize or a move when the native window already matches.
fn ensure_island_window(app: &AppHandle) -> Rect {
    let state = app.state::<AppState>();
    let area = refresh_work_area(app, &state);
    let Some(win) = main_window(app) else { return area };
    let io = TauriIo(&win);
    let monitor = *state.monitor.lock().expect("monitor lock");
    let monitor = Some(monitor).filter(|m| m.w > 0 && m.h > 0);
    // No monitor (no RandR output: the virtual screen-share monitor was removed) means GDK's scale 1 is a fallback, not a reading,
    // and the work area is a stale X value: keep where the window is and place again when a monitor or another scale shows up
    // (the work-area watcher and ScaleFactorChanged both call this funnel).
    let Some(wanted) = geometry::island_window_rect_for(monitor, area, io.scale(), state.window_h.load(Ordering::SeqCst)) else {
        let (w, h) = io.size();
        let (x, y) = io.outer_position();
        return Rect { x, y, w, h };
    };
    if io.size() != (wanted.w, wanted.h) {
        io.set_size(wanted.w, wanted.h);
    }
    if io.outer_position() != (wanted.x, wanted.y) {
        io.set_outer_position(wanted.x, wanted.y);
    }
    islandshape::apply(app, None);
    wanted
}

/// Set once a clean quit starts (port of main.cjs `quitting`): guards the
/// close-request handler and stops the background threads.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// A clean quit has started (read by background loops that must stop and leave the window clickable).
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub(crate) fn quitting() -> bool { QUITTING.load(Ordering::SeqCst) }

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Clean quit (main.cjs `quit()`): idempotent, cleans the transport first,
/// then leaves the normal exit path so plugins release their resources (the
/// single-instance D-Bus name included).
fn quit_clean(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    // main.cjs quit(): abort every active approval request FIRST — an
    // in-flight /execute fails at once instead of holding the lane open
    // (the card stays inert through the quitting rule).
    approval::abort_lane(&app.state::<AppState>().approval);
    characterhost::shutdown(app);
    hotkeyhost::stop(app); // release the X11 grab before leaving
    settingshost::stop(app);
    close_transport(app);
    app.state::<abito_island::daemonhost::HostSlot>().stop();
    app.exit(0);
}

// --- M2 transport lifecycle (main.cjs createTransport / quit / signals) ----

/// Set by the SIGINT/SIGTERM handlers (async-signal-safe: one atomic store,
/// nothing else runs on the signal context).
static SHUTDOWN_SIGNAL: AtomicBool = AtomicBool::new(false);

extern "C" fn handle_shutdown_signal(_signal: libc::c_int) {
    SHUTDOWN_SIGNAL.store(true, Ordering::SeqCst);
}

/// main.cjs line 393: SIGINT/SIGTERM run the clean quit instead of the
/// default terminate (which would leave a stale socket behind). Which of those
/// the OS can actually deliver is the platform seam's call, not ours.
fn install_shutdown_handlers() {
    platform::signals::install(handle_shutdown_signal);
}

/// Signal thread: socket cleanup first, then exit — same cleanup a normal
/// quit performs, so Ctrl-C never leaves the endpoint or dir behind.
fn spawn_shutdown_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        if !SHUTDOWN_SIGNAL.load(Ordering::SeqCst) {
            continue;
        }
        if QUITTING.swap(true, Ordering::SeqCst) {
            // A normal quit is already running: give it a moment, then leave.
            std::thread::sleep(Duration::from_millis(500));
            app.state::<abito_island::daemonhost::HostSlot>().stop();
            std::process::exit(0);
        }
        approval::abort_lane(&app.state::<AppState>().approval);
        characterhost::shutdown(&app);
        close_transport(&app);
        app.state::<abito_island::daemonhost::HostSlot>().stop();
        // Release the single-instance name before a hard exit (probe does the
        // same), so a later launch is never mistaken for a live one.
        tauri_plugin_single_instance::destroy(&app);
        std::process::exit(0);
    });
}

/// main.cjs quit() transport half: identity-checked socket cleanup with the
/// exact legacy refusal line; nothing is ever unlinked that we did not bind.
fn close_transport(app: &AppHandle) {
    let transport = app
        .state::<AppState>()
        .transport
        .lock()
        .expect("transport lock")
        .take();
    let Some(transport) = transport else {
        return;
    };
    if let Err(error) = transport.close() {
        eprintln!("Private socket cleanup refused; inspect the local runtime directory.");
    // P2: the stable pointer goes first, and only if it still names OUR socket.
    abito_island::handoff::clear(transport.runtime(), transport.endpoint());
        eprintln!("transport cleanup: {error}");
    }
}

/// Legacy dev `project` (main.cjs): sha256 hex of the canonical worktree root
/// in dev builds; an installed build takes it from `ABITO_PROJECT_ROOT` only
/// (see `identity`). None when no root can be established — the transport
/// then refuses to start instead of pretending a project identity.
fn project_id_for_this_checkout() -> Option<String> {
    abito_island::identity::project_id_of_this_process()
}

/// main.cjs lines 487-497: start the optional local notice transport; on any
/// failure `unavailable` becomes true, the legacy line is printed, and
/// nothing is faked.
fn start_transport(app: &AppHandle) {
    let state = app.state::<AppState>();
    let fail = |reason: String| {
        state.unavailable.store(true, Ordering::SeqCst);
        // #373 OD006: the startup failure is also a persistent error notice
        // (no retry exists — the flag stays the source of truth; dismissal
        // hides it for good because nothing re-inserts it).
        state
            .notices
            .lock()
            .expect("notices lock")
            .transport_failed(protocol::TransportFailure::Unavailable, now_ms() as u64);
        eprintln!("Optional local notice transport unavailable; no Pi connection was made.");
        eprintln!("transport: {reason}");
        publish(app, &state);
    };
    if state.project.is_empty() {
        fail("canonical worktree root unavailable".into());
        return;
    }
    let runtime = match transport::resolve_runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            fail(error.to_string());
            return;
        }
    };
    let notice_app = app.clone();
    let connections_app = app.clone();
    let failure_app = app.clone();
    let question_app = app.clone();
    let options = transport::TransportOptions::new(runtime, state.project.clone())
        .on_notice(move |message| {
            if QUITTING.load(Ordering::SeqCst) {
                return; // main.cjs: `if (!quitting)`
            }
            let state = notice_app.state::<AppState>();
            let accepted = state
                .notices
                .lock()
                .expect("notices lock")
                .accept(&message, now_ms() as u64);
            // S4/T2: only a `settled` turn is a finished turn for the recap. An `attention` notice (Codex asks in its
            // own terminal) and its `attention_clear` frame change what the island shows, never the turn statistics.
            if accepted && message.kind == "settled" {
                recaphost::note_settled(&notice_app, &state.project);
            }
            publish(&notice_app, &state);
        })
        .on_connections(move |count| {
            if QUITTING.load(Ordering::SeqCst) {
                return;
            }
            let state = connections_app.state::<AppState>();
            // R16: counts track presence/recovery, not failure. Normal hook
            // EOF is silent; the receiver separately reports abnormal exits.
            state
                .notices
                .lock()
                .expect("notices lock")
                .connections_changed(count, now_ms() as u64);
            state.connections.store(count, Ordering::SeqCst);
            publish(&connections_app, &state);
        })
        .on_question_change(move || {
            // #315: the tray's question-pending fact is recomputed off-thread
            // (the observer may fire while a caller holds the transport guard).
            trayhost::note_question_change(&question_app);
            questionhost::invalidate(&question_app);
        });
    match transport::create_transport_observed(options, move |failure| {
        if QUITTING.load(Ordering::SeqCst) { return; }
        let state = failure_app.state::<AppState>();
        state.notices.lock().expect("notices lock").transport_failed(failure, now_ms() as u64);
        publish(&failure_app, &state);
    }) {
        Ok(transport) => {
            // Local address only; no received payloads or labels are logged.
            println!("ABITO_DESKTOP_SOCKET={}", transport.endpoint().display());
            // P2: a stable `<runtime>/endpoint.json` so local hooks need no exported env.
            if let Err(error) = abito_island::handoff::publish(transport.runtime(), transport.endpoint()) {
                eprintln!("endpoint handoff not published: {error}");
            }
            *state.transport.lock().expect("transport lock") = Some(transport);
        }
        Err(error) => fail(error.to_string()),
    }
}

/// Last values we asked the window manager for, reported by the probe.
#[derive(Default)]
struct Requested {
    pos: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
    action: String,
}

#[derive(Clone, Debug)]
#[cfg_attr(not(any(debug_assertions, feature = "probe")), allow(dead_code))]
struct Evidence {
    svgs: usize,
    canvases: usize,
    revision: String,
}

struct AppState {
    core: Mutex<Core>,
    work_area: Mutex<Rect>,
    /// The monitor the island centres on (the screen, like a notch): a side dock shrinks `work_area` asymmetrically and used to shift
    /// the island sideways. Empty (0x0) until the first placement: the work area is then the only truth.
    monitor: Mutex<Rect>,
    requested: Mutex<Requested>,
    evidence: Mutex<Option<Evidence>>,
    /// One-shot: spawn the settle-and-retry geometry pin the first time the
    /// frontend reports ready, preserving the no-user-interference guard.
    initial_pin: AtomicBool,
    /// Set on the first real character press: startup placement must not
    /// interfere once the human is interacting with the island.
    user_touch: AtomicBool,
    /// Logical height of the native island window: the fixed 340 unless a long question asked for more
    /// (island_window_height); Rust clamps it to 70% of the work area and ensure_island_window applies it.
    window_h: AtomicI32,
    /// Bumped on every plan application; stale click plans and startup
    /// placement requests must not replace a newer transition.
    generation: AtomicU64,
    /// M1b: the phase `preload.cjs` consumers read (single writer: apply_plan
    /// for toggles, explicit stores for hide/restore).
    phase: Mutex<IslandState>,
    /// M1b: motion override (contract 2026-10-07), persisted fail-closed.
    motion_override: AtomicBool,
    /// M1b: snapshot revision, advanced only when published content changes.
    revision: AtomicU64,
    /// M1b: last published snapshot, revision-normalized (main.cjs dedupe).
    last_published: Mutex<String>,
    /// M1b: Electron main.cjs rate gate for `desktop:action` (30/s).
    rate: Mutex<bridge::RateLimiter>,
    /// M1b: one-shot facade evidence reported by the webview for the probe.
    facade: Mutex<Option<Value>>,
    /// M2: received notices (single store behind `snapshot().notices`).
    notices: Mutex<protocol::NoticeStore>,
    /// M2: handshaked Pi connections (transport `on_connections`).
    connections: AtomicU32,
    /// M2: `unavailable` flips true ONLY when the receiver could not start
    /// (main.cjs `unavailable = true` in the transport catch).
    unavailable: AtomicBool,
    /// M2: the bound receiver — endpoint for the producer/probe, cleanup on
    /// quit/signal through the identity-checked `Transport::close`.
    transport: Mutex<Option<transport::Transport>>,
    /// M2: sha256 of the canonical worktree root (legacy dev `project`).
    project: String,
    /// M3: the approval lane itself (Electron `main.cjs` bridge globals —
    /// status, auth ladder, in-memory cookie, pinned card, busy gates).
    approval: approval::Shared,
    /// M3: publish/context/log callbacks, installed in `setup` before the
    /// bridge thread starts (they need the app handle).
    hooks: Mutex<Option<approval::SharedHooks>>,
    /// M3 probe only: the in-process fake backend THIS process started for
    /// its approval read-back. `None` in production and whenever
    /// `ABITO_BRIDGE_BASE` was already set from outside.
    #[cfg(any(debug_assertions, feature = "probe"))]
    probe_fake: Mutex<Option<Arc<fakebridge::FakeBackend>>>,
    /// The bounded active chat lane, backed by #341 private local history.
    chat: chatlane::SharedLane,
    /// U1: the selected LOCAL target (U2 picker writes it; `None` = no
    /// verified local model selected → Send refuses with `profile_missing`).
    chat_target: Mutex<Option<Target>>,
    chat_cloud: Mutex<Option<abito_island::cloudprofiles::CloudSelection>>,
    /// U1: `chat_action` rate gate (same 30/s rule, its own budget).
    chat_rate: Mutex<bridge::RateLimiter>,
    /// #305: the global show/hide shortcut (config + X11 grab).
    hotkey: hotkeyhost::HotkeyHost,
    /// #306: the settings panel's host state (agent connection + prefs).
    settings: settingshost::SettingsHost,
    /// #327: the manual specialists (roles the human creates and chooses). `active: None` = the
    /// principal; the store persists in `specialists.json` (0600) and never holds a colour.
    specialists: specialistshost::SpecialistsHost,
    /// U1: per-turn deadlines (the probe shortens them for its fake).
    chat_deadlines: Mutex<abito_island::localmodel::Deadlines>,
    /// #487: the previous window's context for the chat (empty unless the opt-in is on).
    chat_context: Mutex<abito_island::contextwin::ChatContext>,
    /// U1 probe only: evidence lines the webview reports for the chat step.
    chat_probe: Mutex<Vec<Value>>,
    /// U2: the verified local registry in force. Production: exactly
    /// `models::REGISTRY`. Only the probe replaces it (its fake router) —
    /// there is no IPC or env path that can add an entry.
    models_registry: Mutex<Vec<abito_island::models::Entry>>,
    /// U2: last redacted model listing and its revision.
    models_last: Mutex<Value>,
    models_revision: AtomicU64,
    /// U2: whether the last explicit selection reached the 0600 file.
    models_persisted: AtomicBool,
}

/// U2 gate before dispatch: the target must still be a registered,
/// selectable local profile at the same revision. The resource half of the
/// gate (asleep → no load, other alias → no substitute, busy → visible
/// queue, unknown → refuse, context budget) runs per turn in the
/// `chatlane` preflight right before the single request.
fn model_gate(state: &AppState, target: &Target) -> Result<(), ChatError> {
    let registry = state
        .models_registry
        .lock()
        .expect("models registry lock")
        .clone();
    let entry = abito_island::models::select(&registry, &target.profile.profile_id)?;
    if entry.revision != target.profile.revision
        || Some(target.alias.as_str()) != entry.alias
        || target.endpoint.origin() != entry.origin
    {
        return Err(ChatError::profile_missing());
    }
    Ok(())
}

/// Adapter: the pure core handlers see the real window through this.
struct TauriIo<'a>(&'a WebviewWindow);

impl TauriIo<'_> {
    fn set_size(&self, w: i32, h: i32) {
        if let Err(e) = nativewindow::set_size(self.0, w, h) {
            eprintln!("set_size({w},{h}) failed: {e}");
        }
    }
    fn set_outer_position(&self, x: i32, y: i32) {
        if let Err(e) = self.0.set_position(tauri::PhysicalPosition::new(x, y)) {
            eprintln!("set_position({x},{y}) failed: {e}");
        }
    }
}

impl core::WindowIo for TauriIo<'_> {
    fn outer_position(&self) -> (i32, i32) {
        // Prefer the X server's own answer: Tauri 2.12.1's getter reports the
        // correct X but a Y offset by a constant on this stack (see
        // workarea::x11_window_origin). Setters are accurate.
        if let Some(origin) = workarea::x11_window_origin() {
            return origin;
        }
        self.0
            .outer_position()
            .map(|p| (p.x, p.y))
            .unwrap_or_else(|e| {
                eprintln!("outer_position failed: {e}");
                (0, 0)
            })
    }
    fn size(&self) -> (i32, i32) {
        self.0
            .inner_size()
            .map(|s| (s.width as i32, s.height as i32))
            .unwrap_or_else(|e| {
                eprintln!("inner_size failed: {e}");
                (0, 0)
            })
    }
    fn scale(&self) -> f64 {
        self.0.scale_factor().unwrap_or_else(|e| {
            eprintln!("scale_factor failed: {e}");
            1.0
        })
    }
    fn set_outer_position(&self, x: i32, y: i32) {
        TauriIo::set_outer_position(self, x, y)
    }
}

fn characterhost_label() -> &'static str {
    abito_island::characterwin::LABEL
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn edge_str(edge: Edge) -> &'static str {
    match edge {
        Edge::Top => "top",
        Edge::Bottom => "bottom",
    }
}

/// Push the island phase into the webview; animation stays inside the fixed window.
fn push_phase(app: &AppHandle, phase: &str, edge: Edge) {
    let Some(win) = main_window(app) else { return };
    let e = edge_str(edge);
    let _ = win.eval(format!(
        "window.__islandSetState && window.__islandSetState('{phase}','{e}');"
    ));
}

fn store_requested(
    state: &AppState,
    action: &str,
    pos: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
) {
    let mut req = state.requested.lock().expect("requested lock");
    if let Some(p) = pos {
        req.pos = Some(p);
    }
    if let Some(s) = size {
        req.size = Some(s);
    }
    req.action = action.to_string();
}

fn refresh_work_area(app: &AppHandle, state: &AppState) -> Rect {
    let Some(win) = main_window(app) else { return *state.work_area.lock().unwrap_or_else(|e| e.into_inner()) };
    let wa = workarea::current(&win);
    let chosen = settingshost::chosen_monitor(app);
    let rect = placement_area(&win, wa.rect, chosen.as_deref());
    // The screen the island centres on: the chosen monitor's bounds when one is chosen (its bounds ARE its work area there), else
    // the monitor the window lives on. Unknown -> the work area (today's behaviour).
    // No usable monitor at all -> an empty Rect (unknown): `ensure_island_window` then keeps the last placement instead of centring
    // on a stale X work area with a fallback scale.
    let monitor = match (chosen.is_some(), wa.monitor) {
        (_, None) => Rect { x: 0, y: 0, w: 0, h: 0 },
        (true, Some(_)) => rect,
        (false, Some(m)) => m,
    };
    *state.monitor.lock().expect("monitor lock") = monitor;
    *state.work_area.lock().expect("work area lock") = rect;
    rect
}

/// #389 (GD012): the work area used for fixed-window placement — the monitor
/// chosen in Ajustes when it is connected, else the island's current monitor
/// (the behaviour before #389). Resolution goes through the pure
/// `workarea::chosen_area` over the monitors the island itself enumerated; the
/// chosen monitor's bounds are its work area there. `base` is the
/// `workarea::current()` value the caller already holds, so the no-choice path
/// is provably today's behaviour and queries the platform once.
fn placement_area(win: &WebviewWindow, base: Rect, chosen: Option<&str>) -> Rect {
    let Some(key) = chosen else { return base };
    let monitors = win
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .filter_map(|m| {
            let pos = m.position();
            let size = m.size();
            let rect = Rect { x: pos.x, y: pos.y, w: size.width as i32, h: size.height as i32 };
            workarea::monitor_key(m.name().map(|n| n.as_str()))
                .map(|key| workarea::MonitorChoice { key, rect })
        })
        .collect::<Vec<_>>();
    workarea::chosen_area(Some(key), base, &monitors)
}

/// Apply a toggle plan without changing native geometry when it already matches.
/// Only the page's visible island and the GDK input shape transition.
///
/// This is the SINGLE funnel for compact<->overview switches — short click,
/// facade verb, probe, restore — so the published phase can never diverge
/// from the core's `expanded` flag.
fn apply_plan(app: &AppHandle, state: &AppState, plan: TogglePlan) {
    let next = if plan.is_expand() {
        IslandState::Expanded
    } else {
        IslandState::Compact
    };
    *state.phase.lock().expect("phase lock") = next;
    let (w, h) = plan.size();
    let r = plan.rect();
    let edge = plan.edge();
    let expand = plan.is_expand();
    store_requested(
        state,
        if expand { "expand" } else { "collapse" },
        Some((r.x, r.y)),
        Some((w, h)),
    );
    state.generation.fetch_add(1, Ordering::SeqCst);
    ensure_island_window(app);
    push_phase(app, if expand { "overview" } else { "compact" }, edge);
    // U1: a collapse always leaves the chat view (core resets it); tell the
    // chat surface which view is current.
    chathost::publish_chat(app);
}

// --- M1b snapshots/events ---------------------------------------------------

/// Window facts the host context needs, read without ever blocking on the
/// event loop: `is_visible()` called off the main thread posts to the event
/// loop and waits with NO timeout (tauri-runtime-wry 2.12.1), so any thread
/// that holds a host lock while calling it can deadlock against the main
/// thread (R2). The cached source is the only one the lock-holding paths
/// read; the cache is refreshed on the main thread after every show/hide.
pub(crate) trait WindowFacts: Send + Sync {
    fn is_visible(&self) -> bool;
}

/// The live getter. Inline (non-blocking) on the main thread; BLOCKING on
/// any other thread. Only ever consulted on the main thread, never while a
/// lock is held (see `sync_host_visible`).
struct LiveWindowFacts<'a>(&'a WebviewWindow);

impl WindowFacts for LiveWindowFacts<'_> {
    fn is_visible(&self) -> bool {
        self.0.is_visible().unwrap_or(true)
    }
}

/// Cached main-window visibility. `true` matches the getter's own fallback
/// (`unwrap_or(true)`): an unreadable window never blocks the lane.
static HOST_VISIBLE: AtomicBool = AtomicBool::new(true);

/// The cached source: the only `WindowFacts` a lock holder may read.
struct CachedWindowFacts;

impl WindowFacts for CachedWindowFacts {
    fn is_visible(&self) -> bool {
        HOST_VISIBLE.load(Ordering::SeqCst)
    }
}

/// Main-thread only: read the live getter once and refresh the cache. Every
/// show/hide of the main window goes through here so the cached fact can
/// never drift from the real window state.
fn sync_host_visible(win: &WebviewWindow) {
    // Main thread only: the live getter is inline here, never blocking.
    HOST_VISIBLE.store(LiveWindowFacts(win).is_visible(), Ordering::SeqCst);
    sync_scale(win);
}

/// #431: cached main-window scale factor (f64 bits; starts at 1.0, the
/// getter's own fallback). Off-main readers such as `chathost::chat_view`
/// read THIS, never the blocking `scale_factor()` getter, which posts to the
/// event loop and waits with no timeout (same hazard as R2).
static SCALE_BITS: AtomicU64 = AtomicU64::new(0x3FF0_0000_0000_0000);

/// Store a scale reading; a non-finite or non-positive value never replaces
/// a good one.
fn store_scale(scale: f64) {
    if scale.is_finite() && scale > 0.0 {
        SCALE_BITS.store(scale.to_bits(), Ordering::SeqCst);
    }
}

/// The cached scale factor: safe from any thread, never blocks.
pub(crate) fn cached_scale() -> f64 {
    f64::from_bits(SCALE_BITS.load(Ordering::SeqCst))
}

/// Main-thread only: read the live getter once and refresh the scale cache.
fn sync_scale(win: &WebviewWindow) {
    if let Ok(scale) = win.scale_factor() {
        store_scale(scale);
    }
}

/// Pure core of `host_ctx`: the window facts arrive through the seam so a
/// test can prove a lock holder never touches the blocking getter.
fn host_ctx_from(
    now_ms: i64,
    expanded: bool,
    facts: &dyn WindowFacts,
    quitting: bool,
) -> approval::HostCtx {
    approval::HostCtx {
        now_ms,
        expanded,
        visible: facts.is_visible(),
        quitting,
    }
}

/// Host facts the approval lane needs (`approval::HostCtx`). Lock order:
/// this reads ONLY the phase guard and never the approval mutex, so it is
/// safe to call from the lane while it holds its own lock. R2: `visible`
/// comes from the main-thread-maintained cache — the lane thread must NEVER
/// call a window getter, which would block on the event loop with no
/// timeout while the approval mutex is held (AB-BA against the main thread).
fn host_ctx(_app: &AppHandle, state: &AppState) -> approval::HostCtx {
    host_ctx_from(
        now_ms() as i64,
        *state.phase.lock().expect("phase lock") == IslandState::Expanded,
        &CachedWindowFacts,
        QUITTING.load(Ordering::SeqCst),
    )
}

/// Current snapshot in Electron's exact shape. `anchor` is reported only
/// when the X server really answers for our window — evidence, not intent.
/// `bridgeStatus`/`card`/`request` come verbatim from the approval lane.
fn build_snapshot(app: &AppHandle, state: &AppState) -> Value {
    let phase = *state.phase.lock().expect("phase lock");
    let edge = state.core.lock().expect("core lock").edge;
    let anchor = workarea::x11_window_origin()
        .is_some()
        .then(|| edge_str(edge));
    let revision = state.revision.load(Ordering::SeqCst);
    let connections = state.connections.load(Ordering::SeqCst);
    let unavailable = state.unavailable.load(Ordering::SeqCst);
    // M2: the pruned notice queue (expiry runs on every snapshot read, the
    // same way main.cjs `notices.snapshot(Date.now())` does).
    let notices: Vec<Value> = {
        // Serialize lifecycle diffs with the app queue, so a concurrently accepted (not yet
        // published) notice cannot lose its origin to an older snapshot.
        let mut store = state.notices.lock().expect("notices lock");
        let notices = store.snapshot(now_ms() as u64);
        let ids: Vec<String> = notices.iter().map(|n| n.id.clone()).collect();
        let removed = store.removed_origin_ids(&ids);
        if let Some(transport) = state.transport.lock().expect("transport lock").as_ref() {
            transport.forget_notice_origins(&removed);
        }
        notices.into_iter().map(|notice| serde_json::to_value(notice).unwrap_or(Value::Null)).collect()
    };
    let ctx = host_ctx(app, state);
    let (bridge_status, card, request) = approval::snapshot_fields(&state.approval, &ctx);
    serde_json::to_value(desktop::Snapshot::new(
        revision,
        phase,
        anchor,
        state.motion_override.load(Ordering::SeqCst),
        connections,
        unavailable,
        notices,
        bridge_status,
        card,
        request,
    ))
    .unwrap_or(Value::Null)
}

/// Publish on `desktop:state` with main.cjs `publish()` semantics: identical
/// content (revision aside) is never re-emitted and the revision advances
/// only when something actually changed. Never publishes after quit
/// (legacy `if (quitting …) return`).
fn publish(app: &AppHandle, state: &AppState) {
    if QUITTING.load(Ordering::SeqCst) {
        return;
    }
    let value = build_snapshot(app, state);
    // #315: the tray follows the same snapshot facts the page sees. Before the
    // dedup return: the connection/question facts may have moved even when the
    // snapshot content did not.
    trayhost::refresh(app, &value);
    let mut normalized = value;
    if let Value::Object(map) = &mut normalized {
        map.insert("revision".to_string(), Value::from(0));
    }
    let serialized = serde_json::to_string(&normalized).unwrap_or_default();
    let mut last = state.last_published.lock().expect("last snapshot lock");
    if *last == serialized {
        return;
    }
    let revision = state.revision.fetch_add(1, Ordering::SeqCst) + 1;
    let mut emitted = normalized;
    if let Value::Object(map) = &mut emitted {
        map.insert("revision".to_string(), Value::from(revision));
    }
    *last = serialized;
    drop(last);
    if let Err(e) = app.emit("desktop:state", &emitted) {
        eprintln!("desktop:state emit failed: {e}");
    }
}

// --- M1b motion override persistence (main.cjs motion.json) -----------------

/// #304: Abito animates by default; see `desktop::motion_override_from_config`.
fn load_motion_override(app: &AppHandle) -> bool {
    let text = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("motion.json")).ok());
    abito_island::desktop::motion_override_from_config(text.as_deref())
}

fn persist_motion_override(app: &AppHandle, value: bool) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let data = serde_json::json!({ "v": 1, "override": value }).to_string();
    if let Err(e) = platform::fs::write_private(&dir.join("motion.json"), data.as_bytes()) {
        // A read-only state root keeps the choice in memory for this launch
        // (main.cjs persistMotionOverride).
        eprintln!("motion override not persisted: {e}");
    }
}

// --- M1b lifecycle -----------------------------------------------------------

/// Electron main.cjs `restore()` (the `second-instance` handler): land
/// compact, keep/clamp the position in the current work area, show, focus.
/// Called by the single-instance plugin in the FIRST instance; the second
/// process exits before reaching `Builder::run`.
pub(crate) fn restore(app: &AppHandle) {
    let state = app.state::<AppState>();
    questionhost::with_pending(&state, |pending| {
        if pending {
            // Preserve phase, view and geometry; a second launch is not an answer.
            let Some(win) = main_window(app) else { return };
            let _ = win.unminimize();
            show_on_top(&win);
            sync_host_visible(&win);
            publish(app, &state);
            return;
        }
        restore_without_question(app, &state);
    });
}

fn restore_without_question(app: &AppHandle, state: &AppState) {
    let Some(win) = main_window(app) else { return };
    // transition(state, 'restore') -> compact when no question is pending.
    *state.phase.lock().expect("phase lock") = IslandState::Compact;
    // main.cjs restore() bumps the overlay epoch on EVERY restore (375).
    approval::bump_epoch(&state.approval);
    let area = refresh_work_area(app, state);
    let io = TauriIo(&win);
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        if core.expanded {
            Some(core.toggle(&io, area)) // was left open: collapse through the funnel
        } else {
            None
        }
    };
    if let Some(plan) = plan {
        apply_plan(app, state, plan);
    } else {
        let safe = ensure_island_window(app);
        state.generation.fetch_add(1, Ordering::SeqCst);
        store_requested(state, "restore", Some((safe.x, safe.y)), Some((safe.w, safe.h)));
    }
    let _ = win.unminimize();
    // Q1: show, never focus — the island must not take the keyboard from
    // the app the human is working in (legacy `restore()` focused it).
    show_on_top(&win);
    sync_host_visible(&win);
    publish(app, state);
}

/// Human L56: show the island and re-assert always-on-top. Mutter clears _NET_WM_STATE_ABOVE
/// when the window is withdrawn (hide), so a plain show() remaps it BEHIND other windows:
/// mapped but invisible, and the toggle shortcut looks dead.
fn show_on_top(win: &WebviewWindow) {
    let _ = win.show(); // show_on_top body
    let _ = win.set_always_on_top(true);
}

/// Q1: the deliberate "Open Abito chat and type" activation (second launch
/// with `--chat`): expand, switch to the chat view, take focus, and put the
/// caret in the composer. The ONLY path that calls `set_focus`.
fn open_chat_and_type(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _ = dispatch_verb(app, &state, Action::Expand, None);
    // R2: keep the cached visibility honest at the call site too — the expand
    // verb above may have revealed the island from Hidden.
    let Some(win) = main_window(app) else { return };
    sync_host_visible(&win);
    chathost::switch_view(app, &state, true);
    let _ = win.set_focus();
    let _ = win.eval("window.__islandFocusComposer && window.__islandFocusComposer();");
}

/// Poll the work area once a second and re-place the fixed window when it changes.
/// Island pointer gestures never own native placement.
fn spawn_workarea_watcher(app: AppHandle) {
    // What the last placement was made from besides the area: whether a monitor backed it, and the scale. The area alone does not
    // change when the virtual monitor comes back or GDK settles on another scale, and the island must be placed again then.
    let mut last_basis: Option<(bool, u64)> = None;
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1000));
        if QUITTING.load(Ordering::SeqCst) {
            return;
        }
        let state = app.state::<AppState>();
        let Some(win) = main_window(&app) else { return };
        let wa = workarea::current(&win);
        // #389: with a chosen monitor the island re-clamps into THAT monitor's
        // area, not the one it currently sits on; the fallback is unchanged.
        let area = placement_area(&win, wa.rect, settingshost::chosen_monitor(&app).as_deref());
        let basis = (wa.monitor.is_some(), cached_scale().to_bits());
        {
            let mut stored = state.work_area.lock().expect("work area lock");
            if area == *stored && last_basis == Some(basis) {
                continue;
            }
            *stored = area;
        }
        last_basis = Some(basis);
        let safe = ensure_island_window(&app);
        store_requested(&state, "workarea-clamp", Some((safe.x, safe.y)), Some((safe.w, safe.h)));
        publish(&app, &state);
    });
}

/// main.cjs `setInterval(publish, 1000)`: content-deduped, so it is silent
/// until something actually changed (it is what re-checks projected state).
fn spawn_publish_ticker(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1000));
        if QUITTING.load(Ordering::SeqCst) {
            return;
        }
        let state = app.state::<AppState>();
        publish(&app, &state);
    });
}

/// security.cjs equivalent for the island window: top-level navigation to
/// anything but the local app page is cancelled (Tauri asks this hook for
/// every navigation of every webview; `window.open`/`target=_blank` create
/// no webview because no new-window handler is installed).
fn navigation_lock() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("navigation-lock")
        .on_navigation(|webview, url| {
            // #366 F093 / #474: exactly the sender gate's rule: the island keeps its
            // closed page allowlist and the settings window may also load its own
            // settings.html, never anything else and never by the page's choice.
            let allowed = bridge::sender_ok(webview.label(), url.as_str()).is_ok()
                // #486: the two Rust-created character windows load exactly their own page.
                || abito_island::characterwin::navigation_allowed(webview.label(), url.as_str());
            if !allowed {
                eprintln!("navigation blocked from {}: {url}", webview.label());
            }
            allowed
        })
        .build()
}

// --- Commands: the webview only reports pointer events and evidence; every
// --- click cancellation and fixed placement policy lives in core/geometry.

#[tauri::command]
fn island_shape(app: AppHandle, webview: tauri::Webview, state: State<AppState>, payload: Value) -> Result<(), BridgeError> {
    settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let report = islandshape::parse(&payload).ok_or_else(|| BridgeError::denied("invalid island shape"))?;
    state.chat_rate.lock().expect("shape rate lock").check(now_ms())?;
    islandshape::apply(&app, Some(report));
    Ok(())
}

/// A long question asks the island window to grow (and gives the height back when it closes). Same gate as island_shape: main
/// window, sender, closed payload `{h}`, rate limit; Rust alone decides the size (>= 340, <= 70% of the work area), keeps the
/// top anchor and width, then the single native funnel applies it. Answers with the granted logical height.
#[tauri::command]
fn island_window_height(app: AppHandle, webview: tauri::Webview, state: State<AppState>, payload: Value) -> Result<Value, BridgeError> {
    settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let asked = islandshape::parse_window_height(&payload).ok_or_else(|| BridgeError::denied("invalid window height"))?;
    state.chat_rate.lock().expect("shape rate lock").check(now_ms())?;
    let area = refresh_work_area(&app, &state);
    let scale = main_window(&app).map(|w| TauriIo(&w).scale()).unwrap_or(1.0);
    let granted = geometry::clamp_window_height(asked, area.h, scale);
    if state.window_h.swap(granted, Ordering::SeqCst) != granted {
        ensure_island_window(&app);
    }
    Ok(serde_json::json!({ "h": granted }))
}

#[tauri::command]
fn drag_press(app: AppHandle, webview: tauri::Webview, state: State<AppState>, x: f64, y: f64) {
    // #366: island-only; the settings window runs the same page and must not drive the island.
    if settingswindow::main_window_only(webview.label()).is_err() { return; }
    state.user_touch.store(true, Ordering::SeqCst);
    islandclick::DRAGGING.store(true, Ordering::SeqCst); // HU-043: a press must never find the window click-through
    let Some(win) = main_window(&app) else { return };
    let io = TauriIo(&win);
    state.core.lock().expect("core lock").press(&io, (x, y));
}

#[tauri::command]
fn drag_move(app: AppHandle, webview: tauri::Webview, state: State<AppState>, x: f64, y: f64) {
    if settingswindow::main_window_only(webview.label()).is_err() { return; }
    let Some(win) = main_window(&app) else { return };
    let io = TauriIo(&win);
    let area = *state.work_area.lock().expect("work area lock");
    let moved = {
        let mut core = state.core.lock().expect("core lock");
        core.drag(&io, area, (x, y))
    };
    if let Some(pos) = moved {
        store_requested(&state, "drag", Some(pos), None);
    }
}

#[tauri::command]
fn drag_release(app: AppHandle, webview: tauri::Webview, state: State<AppState>, x: f64, y: f64, cancelled: bool) -> String {
    if settingswindow::main_window_only(webview.label()).is_err() { return "ignored".to_string(); }
    islandclick::DRAGGING.store(false, Ordering::SeqCst); // HU-043: the press is over, click-through may resume
    let area = refresh_work_area(&app, &state);
    let Some(win) = main_window(&app) else { return "ignored".to_string() };
    let io = TauriIo(&win);
    let visible = win.is_visible().unwrap_or(true);
    let now = now_ms() as i64;
    let outcome = questionhost::with_pending(&state, |pending| {
        let mut appr = state.approval.lock().expect("approval lock");
        let outcome = {
            let mut core = state.core.lock().expect("core lock");
            // Approval guards protect folding, never prevent reopening a compact
            // request. Shutdown alone vetoes both directions.
            let blocked = QUITTING.load(Ordering::SeqCst) || appr.active.is_quit()
                || (core.expanded && manual_close_verdict(&mut appr, true, visible, now).is_err());
            abito_island::questioncmd::guarded_release(
                &mut core, &io, area, (x, y), cancelled || blocked, pending,
            )
        };
        match outcome {
            ReleaseOutcome::Toggle(plan) => {
                appr.bump_epoch();
                apply_plan(&app, &state, plan);
                "toggle"
            }
            ReleaseOutcome::Cancelled => "cancelled",
        }
    });
    // Never publish under question/approval admission guards.
    if outcome == "toggle" { publish(&app, &state); }
    outcome.to_string()
}

/// F025: only a trusted local sender may ask the host to open a parsed web
/// URL. xdg-open receives exactly one URL argument, never a shell command.
#[tauri::command]
async fn open_chat_url(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<(), BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let origin = webview.url().map(|u| u.to_string()).unwrap_or_default();
    let mut child = None;
    {
        let mut rate = state.rate.lock().expect("rate lock");
        desktop::open_web_url(webview.label(), &origin, &payload, &mut rate, now_ms(), |url| {
            child = Some(std::process::Command::new("xdg-open")
                .arg(url)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn().map_err(|_| BridgeError::denied("external opener unavailable"))?);
            Ok(())
        })?;
    } // Release shared rate guard before waiting, and reap only our own child.
    tauri::async_runtime::spawn_blocking(move || {
        let status = child.ok_or_else(|| BridgeError::denied("external opener unavailable"))?.wait()
            .map_err(|_| BridgeError::denied("external opener failed"))?;
        if status.success() { Ok(()) } else { Err(BridgeError::denied("external opener failed")) }
    }).await.map_err(|_| BridgeError::denied("external opener aborted"))?
}

/// F099: only a trusted local sender may ask the island to focus an
/// already-running terminal / agent-session / editor window. The target is a
/// CLOSED enum (see `focushost`): the payload never carries a command, a
/// path or a window id, and an absent target or an unwilling desktop is an
/// honest Spanish reason — never a false success, never a spawn with a
/// caller-influenced argument.
#[tauri::command]
async fn focus_host(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<(), BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let origin = webview.url().map(|u| u.to_string()).unwrap_or_default();
    let mut rate = state.rate.lock().expect("rate lock");
    abito_island::focushost::focus_command_with_origin(
        webview.label(),
        &origin,
        &payload,
        &mut rate,
        now_ms(),
        |target, session, origin_request| {
            let Some(request) = origin_request else {
                return abito_island::focushost::focus_running(target, session);
            };
            // Refresh the app-owned notice lifecycle before reading the transport's private map.
            let ids: Vec<String> = state.notices.lock().expect("notices lock").snapshot(now_ms() as u64)
                .into_iter().map(|n| n.id).collect();
            let saved = {
                let transport = state.transport.lock().expect("transport lock");
                transport.as_ref().and_then(|t| {
                    if request.kind == abito_island::focushost::OriginKind::Notice
                        && ids.iter().filter(|id| *id == &request.id).count() != 1 { return None; }
                    t.origin_for(request)
                })
            }.ok_or_else(|| abito_island::sessionterm::ORIGIN_UNKNOWN.to_string())?;
            abito_island::sessionterm::focus_origin(&saved)
        },
    )
}

/// The single IPC entry point behind `window.desktop.*` — Electron's
/// `ipcMain.handle('desktop:action')`. The gate order mirrors main.cjs
/// exactly: sender + payload validation FIRST, then the rate gate — an
/// invalid call never consumes rate budget.
///
/// Async since M3: `allow`/`deny` perform blocking HTTP with the legacy 5 s
/// deadline (Electron's `decide` was async there too), so those run on the
/// blocking pool — never on the webkit main thread — and answer with the
/// fresh snapshot only after the decision settled.
#[tauri::command]
async fn desktop_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    if payload.get("action").and_then(Value::as_str) == Some("click") {
        let click = bridge::parse_click(&payload).map_err(log_click_denied)?;
        state.rate.lock().expect("rate lock").check(now_ms())?;
        // Serialize this click's planning/application on the native thread. No
        // transport guard is carried across scheduling or response waiting.
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let state = handle.state::<AppState>();
            let result = dispatch_click(&handle, &state, click).map_err(log_click_denied);
            let _ = send.send(result);
        })
        .map_err(|_| BridgeError::denied("click scheduling failed"))?;
        return tauri::async_runtime::spawn_blocking(move || receive.recv())
            .await
            .map_err(|_| BridgeError::denied("click aborted"))?
            .map_err(|_| BridgeError::denied("click aborted"))?;
    }
    // #437: `dismiss` carries an optional exact notice id (the notices list
    // view's per-row ×). Parsed BEFORE the generic validate_payload, which
    // still refuses every stowaway key for the other argument-free verbs.
    if payload.get("action").and_then(Value::as_str) == Some("dismiss") {
        let dismiss = bridge::parse_dismiss(&payload)?;
        state.rate.lock().expect("rate lock").check(now_ms())?;
        // Same main-thread inline as the generic verb path: dismiss performs
        // publish (window getters/ops); never across a lock off the main
        // thread (R2 deadlock).
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let state = handle.state::<AppState>();
            let _ = send.send(dispatch_dismiss(&handle, &state, dismiss));
        })
        .map_err(|_| BridgeError::denied("action scheduling failed"))?;
        return tauri::async_runtime::spawn_blocking(move || receive.recv())
            .await
            .map_err(|_| BridgeError::denied("action aborted"))?
            .map_err(|_| BridgeError::denied("action aborted"))?;
    }
    let (action, index) = bridge::validate_payload(&payload)?;
    state.rate.lock().expect("rate lock").check(now_ms())?;
    // R2 routing: `runs_off_main_thread` is the SINGLE source of truth. The
    // helper matches every Action variant exhaustively (no wildcard), so a
    // new verb cannot compile without a deliberate routing choice, and this
    // arm and the routing test can never silently diverge.
    if runs_off_main_thread(action) {
        let approval = Arc::clone(&state.approval);
        let hooks = state_hooks(&state)?;
        let decision = if action == Action::Allow {
            approval::Decision::Allow
        } else {
            approval::Decision::Deny
        };
        let handle = app.clone();
        Ok(tauri::async_runtime::spawn_blocking(move || {
            let allowed = decision == approval::Decision::Allow;
            approval::decide(&approval, decision, &hooks);
            recaphost::note_decision(&handle, allowed);
            let state = handle.state::<AppState>();
            build_snapshot(&handle, &state)
        })
        .await
        .map_err(|_| BridgeError::denied("decision aborted"))?)
    } else {
        // R2: every verb here performs window getters/ops. An off-main
        // getter posts to the event loop and blocks with NO timeout, so
        // running one with a host lock held can deadlock against the
        // main thread (which takes the same locks). Inline on the main
        // thread, exactly like the click path above; the tokio thread
        // only waits for the result.
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let state = handle.state::<AppState>();
            let _ = send.send(dispatch_verb(&handle, &state, action, index));
        })
        .map_err(|_| BridgeError::denied("action scheduling failed"))?;
        tauri::async_runtime::spawn_blocking(move || receive.recv())
            .await
            .map_err(|_| BridgeError::denied("action aborted"))?
            .map_err(|_| BridgeError::denied("action aborted"))?
    }
}

/// Invalid click logs never contain caller-provided IDs, text or payloads.
fn log_click_denied(error: BridgeError) -> BridgeError {
    eprintln!("desktop click dropped: {}", error.message);
    error
}

/// Captured native getters only: planning under host guards performs no native I/O.
struct ClickMeasurements {
    position: (i32, i32),
    size: (i32, i32),
    scale: f64,
}
impl WindowIo for ClickMeasurements {
    fn outer_position(&self) -> (i32, i32) { self.position }
    fn size(&self) -> (i32, i32) { self.size }
    fn scale(&self) -> f64 { self.scale }
    fn set_outer_position(&self, _: i32, _: i32) {
        unreachable!("click planning must not write native state")
    }
}

/// Display-only identity transaction. Never call the legacy Expand arm: it
/// promotes approval selection. This function runs on the native main thread.
fn dispatch_click(app: &AppHandle, state: &AppState, click: bridge::Click) -> Result<Value, BridgeError> {
    let win = main_window(app).ok_or_else(|| BridgeError::denied("main window unavailable"))?;
    let io = TauriIo(&win);
    let measured = ClickMeasurements {
        position: io.outer_position(), size: io.size(), scale: io.scale(),
    };
    let area = *state.work_area.lock().expect("work area lock");
    let plan = || {
        let mut core = state.core.lock().expect("core lock");
        let mut phase = state.phase.lock().expect("phase lock");
        let plan = desktop::plan_click_open(&mut core, &mut phase, &measured, area);
        let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        (plan, generation)
    };
    let (plan, generation) = match click.kind {
        bridge::ClickKind::Question => {
            let question = questionhost::question_view(state);
            bridge::route_click(&click, &question, &Value::Null, now_ms() as u64)?;
            // Snapshot validation is NOT the atomic liveness guard. Recheck ID
            // and expiry under transport → questions → core/phase, no reentry.
            questionhost::with_question_click(state, &click.id, plan)?
        }
        bridge::ClickKind::Finished => {
            let mut store = state.notices.lock().expect("notices lock");
            let now = now_ms() as u64;
            let notices = serde_json::to_value(store.snapshot(now)).unwrap_or(Value::Null);
            bridge::route_click(&click, &Value::Null, &notices, now)?;
            // Current-first validation and planning stay under the same store
            // guard; a concurrent dismissal/arrival cannot select another ID.
            plan()
        }
    };
    // All identity guards have released before native application/publication.
    if !click_native_current(state, generation) {
        return Err(BridgeError::denied("click superseded"));
    }
    match plan {
        desktop::ClickPlan::Expand(plan) => {
            let (w, h) = plan.size();
            let r = plan.rect();
            store_requested(state, "expand", Some((r.x, r.y)), Some((w, h)));
            ensure_island_window(app);
            push_phase(app, "overview", plan.edge());
        }
        desktop::ClickPlan::Overview(plan) => {
            let (w, h) = plan.size;
            let r = plan.rect;
            let (vw, vh) = plan.visible;
            store_requested(state, "overview", Some((r.x, r.y)), Some((w, h)));
            ensure_island_window(app);
            let _ = win.eval(format!(
                "window.__islandSetView && window.__islandSetView('overview',{vw},{vh});"
            ));
            push_phase(app, "overview", plan.edge);

        }
        desktop::ClickPlan::Show(edge) => push_phase(app, "overview", edge),
    }
    let _ = win.unminimize();
    show_on_top(&win); // no set_focus: focus handback is not an acceptance gate
    sync_host_visible(&win);
    chathost::publish_chat(app);
    publish(app, state);
    // Successful, guarded open only; the renderer selects the matched lane.
    // This is presentation intent, never a question/approval action.
    app.emit("desktop:notice-open", serde_json::json!({
        "id": click.id,
        "kind": match click.kind {
            bridge::ClickKind::Question => "question",
            bridge::ClickKind::Finished => "finished",
        },
    })).map_err(|_| BridgeError::denied("click view emit failed"))?;
    Ok(build_snapshot(app, state))
}

fn click_native_current(state: &AppState, generation: u64) -> bool {
    !QUITTING.load(Ordering::SeqCst) && desktop::click_plan_is_current(
        generation,
        state.generation.load(Ordering::SeqCst),
        *state.phase.lock().expect("phase lock"),
    )
}

/// The publish/context/log callbacks installed in `setup`.
fn state_hooks(state: &AppState) -> Result<approval::SharedHooks, BridgeError> {
    state
        .hooks
        .lock()
        .expect("hooks lock")
        .clone()
        .ok_or_else(|| BridgeError::denied("approval lane not started"))
}

/// Execute one validated verb with Electron main.cjs semantics. `allow`/
/// `deny`/`choose` are wired since M3: only an explicit human choice reaches
/// the lane, which re-validates card id, expiry and `payload_hash` itself
/// before any `/execute` (a notice can never approve anything).
fn dispatch_verb(
    app: &AppHandle,
    state: &AppState,
    action: Action,
    index: Option<i32>,
) -> Result<Value, BridgeError> {
    dispatch_action(app, state, action, index)
}

/// Manual folding may keep a QP/1 question in the compact Responder pill,
/// but not hide an actionable native host approval card or standing request.
/// Inert cards (expired/settled/unavailable) do not claim decision authority.
/// Call under transport → approval → core; snapshot projection is authoritative.
fn manual_close_verdict(
    appr: &mut approval::Approval, expanded: bool, visible: bool, now: i64,
) -> Result<bool, BridgeError> {
    let quitting = QUITTING.load(Ordering::SeqCst) || appr.active.is_quit();
    let poll_busy = appr.poll_busy;
    let mutation_busy = appr.mutation_busy;
    let standing_request = appr.request.is_some();
    let status = appr.status;
    let card = abito_island::card::project_card(
        appr.selected.as_mut(), &status, quitting, poll_busy, mutation_busy,
        expanded, visible, now,
    );
    let card_pending = card.get("state").and_then(Value::as_str) == Some("pending");
    // Same protected host facts as autoClose, deliberately WITHOUT QP pending.
    auto_close_verdict(false, card_pending, standing_request, mutation_busy || quitting, expanded)
}

/// Close means Expanded → Compact, never Hide, Quit, cancel or expire.
/// Admission and transition are atomic; publication follows guard release.
fn dispatch_manual_close(app: &AppHandle, state: &AppState) -> Result<Value, BridgeError> {
    let win = main_window(app).ok_or_else(|| BridgeError::denied("main window unavailable"))?;
    let io = TauriIo(&win);
    let visible = win.is_visible().unwrap_or(true);
    let area = refresh_work_area(app, state);
    let now = now_ms() as i64;
    let collapsed = questionhost::with_pending(state, |pending| {
        let mut appr = state.approval.lock().expect("approval lock");
        let plan = {
            let mut core = state.core.lock().expect("core lock");
            let phase = *state.phase.lock().expect("phase lock");
            let expanded = core.expanded && phase == IslandState::Expanded;
            if !manual_close_verdict(&mut appr, expanded, visible, now)? {
                return Ok(false);
            }
            if !abito_island::questioncmd::collapse_allowed(expanded, pending) {
                return Err(questionhost::pending_error());
            }
            core.toggle(&io, area)
        };
        appr.bump_epoch();
        apply_plan(app, state, plan);
        Ok(true)
    })?;
    if collapsed { publish(app, state); }
    Ok(build_snapshot(app, state))
}

/// #437: the display-only dismissal the webview asks for. With no id the M2
/// behaviour is untouched: the FIRST notice goes (the existing Dismiss arm,
/// the same path the probe drives). With an id, EXACTLY that notice goes; an
/// unknown id is refused with zero mutation and no publish — never a silent
/// first-notice fallback (coordinator decision, T6.6 #437).
fn dispatch_dismiss(
    app: &AppHandle,
    state: &AppState,
    dismiss: bridge::Dismiss,
) -> Result<Value, BridgeError> {
    let Some(id) = dismiss.id else {
        return dispatch_verb(app, state, Action::Dismiss, None);
    };
    let now = now_ms() as u64;
    let removed = state.notices.lock().expect("notices lock").dismiss_exact(&id, now);
    if !removed {
        return Err(BridgeError::denied("unknown notice id"));
    }
    publish(app, state);
    Ok(build_snapshot(app, state))
}
/// one snapshot of live facts taken under the established lock order. Every
/// protected fact vetoes with the single approved sentence (L15 condition ii);
/// a protected fact wins even over an already-compact island (fail closed),
/// and a clear compact island is an honest `Ok(false)` no-op — never a
/// refusal, never a fake success. Manual folding omits only the QP question
/// fact; this automatic verdict deliberately continues to protect it.
fn auto_close_verdict(
    pending: bool,
    card_pending: bool,
    standing_request: bool,
    decision_busy: bool,
    expanded: bool,
) -> Result<bool, BridgeError> {
    if pending || card_pending || standing_request || decision_busy {
        return Err(BridgeError::denied(
            "La isla tiene una interacción pendiente.",
        ));
    }
    Ok(expanded)
}

/// #336 T1b-a: atomic admission + collapse for `autoClose`. The protected
/// facts and the phase/core transition happen in ONE critical section under
/// transport → approval → core → phase (approval → phase is the established
/// `decide`/`hooks.ctx` edge, core → phase is `dispatch_click`'s), all native
/// getters are captured BEFORE the guards (dispatch_click precedent) and
/// every guard is released before the reentrant publication (L15 iii).
/// Unlike the legacy `Close` arm this path never publishes under the guard.
fn dispatch_auto_close(app: &AppHandle, state: &AppState) -> Result<Value, BridgeError> {
    let win = main_window(app).ok_or_else(|| BridgeError::denied("main window unavailable"))?;
    let io = TauriIo(&win);
    let visible = win.is_visible().unwrap_or(true);
    let now = now_ms() as i64;
    let area = refresh_work_area(app, state);
    let collapsed = questionhost::with_pending(state, |pending| {
        let mut appr = state.approval.lock().expect("approval lock");
        let verdict = {
            let core = state.core.lock().expect("core lock");
            let phase = *state.phase.lock().expect("phase lock");
            let expanded = core.expanded && phase == IslandState::Expanded;
            // Facts extracted first: a MutexGuard deref cannot be split, so
            // the mutable `selected` borrow stands alone during projection.
            let quitting = appr.active.is_quit();
            let poll_busy = appr.poll_busy;
            let mutation_busy = appr.mutation_busy;
            let standing_request = appr.request.is_some();
            let status = appr.status;
            // Same projection the snapshot shows the human: a card that is
            // merely inert (expired/quitting/busy state) is not a live claim.
            let card = abito_island::card::project_card(
                appr.selected.as_mut(),
                &status,
                quitting,
                poll_busy,
                mutation_busy,
                expanded,
                visible,
                now,
            );
            let card_pending = card.get("state").and_then(Value::as_str) == Some("pending");
            auto_close_verdict(
                pending,
                card_pending,
                standing_request,
                mutation_busy,
                expanded,
            )
        }; // core + phase guards release here, still under transport → approval
        let collapsed_now = verdict?;
        if !collapsed_now {
            return Ok(false);
        }
        // Transition right here: no question, card or request can be admitted
        // between the check and the collapse. `bump_epoch` runs on the guard
        // we already hold (the established `overlayEpoch++` of every phase
        // transition); `apply_plan` takes only phase/requested/window locks,
        // never approval or transport, and queues its compact transaction on
        // another thread. No publication happens while any guard is held.
        let plan = {
            let mut core = state.core.lock().expect("core lock");
            core.toggle(&io, area)
        };
        appr.bump_epoch();
        apply_plan(app, state, plan);
        Ok(true)
    })?;
    if collapsed {
        publish(app, state);
    }
    Ok(build_snapshot(app, state))
}

fn dispatch_action(
    app: &AppHandle,
    state: &AppState,
    action: Action,
    index: Option<i32>,
) -> Result<Value, BridgeError> {
    match action {
        Action::Snapshot => Ok(build_snapshot(app, state)),
        Action::Close => dispatch_manual_close(app, state),
        Action::Expand => {
            let win = main_window(app).ok_or_else(|| BridgeError::denied("main window unavailable"))?;
            let verb = "expand";
            let (next, was_hidden) = {
                let mut phase = state.phase.lock().expect("phase lock");
                let was_hidden = *phase == IslandState::Hidden;
                let next = desktop::transition(*phase, verb);
                if next == *phase {
                    (None, was_hidden) // no-op, exactly like Electron's transition()
                } else {
                    *phase = next;
                    (Some(next), was_hidden)
                }
            };
            if let Some(next) = next {
                // main.cjs 466-467, synchronous in one step: overlayEpoch++
                // and, on expand, the pinned queue is promoted (a closed
                // overlay never keeps the previous decision authority).
                approval::bump_epoch(&state.approval);
                if next == IslandState::Expanded {
                    approval::promote_selection(&state.approval);
                }
                let area = refresh_work_area(app, state);
                let io = TauriIo(&win);
                if was_hidden && next == IslandState::Expanded {
                    // #266 S2 Path B: reveal from Hidden through the EXISTING
                    // expand verb. Visibility and phase must agree, a reveal
                    // must NEVER collapse (desktop::hidden_reveal), and the
                    // window shows WITHOUT ever requesting focus (Q1: the
                    // island must not take the keyboard from the app the human
                    // is typing in). Boot/cached/duplicate snapshots never get
                    // here: only the page's reveal gates name this verb, and
                    // they fire solely on genuinely new events.
                    // WM focus-on-map hand-back: the show never REQUESTS the
                    // keyboard, but a WM may focus the new map anyway. Same
                    // three pieces the hotkey Show path already uses (capture
                    // BEFORE the show, pure GiveBack rule after a 250ms
                    // settle, best-effort return). Known limit, inherited from
                    // that pattern: a deliberate human click INTO the island
                    // within the 250ms window is indistinguishable from the
                    // WM's own focus-on-map, and the keyboard would be handed
                    // back. The Windows hotkey host has no twin for this and
                    // neither does the reveal there: cfg(unix) only.
                    #[cfg(target_os = "linux")]
                    let reveal_before = hotkey::x11::active_window(None);
                    let (stale_expanded, edge) = {
                        let core = state.core.lock().expect("core lock");
                        (core.expanded, core.edge)
                    };
                    match desktop::hidden_reveal(stale_expanded) {
                        desktop::HiddenReveal::ShowInPlace => {
                            // Hidden while the core still says expanded: the
                            // native rect already carries the overview
                            // geometry — a toggle would emit a COLLAPSE plan.
                            // Show in place; the chat view is NOT switched.
                            let _ = win.unminimize();
                            show_on_top(&win);
                            sync_host_visible(&win);
                            push_phase(app, "overview", edge);
                            chathost::publish_chat(app);
                        }
                        desktop::HiddenReveal::GrowThenShow => {
                            let plan = {
                                let mut core = state.core.lock().expect("core lock");
                                core.toggle(&io, area)
                            };
                            apply_plan(app, state, plan);
                            let _ = win.unminimize();
                            show_on_top(&win);
                            sync_host_visible(&win);
                        }
                    }
                    #[cfg(target_os = "linux")]
                    {
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(250));
                            let focused = win.is_focused().unwrap_or(false);
                            if hotkey::focus_after_show(focused, false)
                                == hotkey::FocusAction::GiveBack
                            {
                                if let Some(previous) = reveal_before {
                                    let _ = hotkey::x11::give_focus_back(None, previous);
                                }
                            }
                        });
                    }
                } else {
                    let plan = {
                        let mut core = state.core.lock().expect("core lock");
                        core.toggle(&io, area)
                    };
                    apply_plan(app, state, plan);
                }
                publish(app, state);
            }
            Ok(build_snapshot(app, state))
        }
        Action::AutoClose => dispatch_auto_close(app, state),
        Action::Hide => {
            let win = main_window(app).ok_or_else(|| BridgeError::denied("main window unavailable"))?;
            let hidden = {
                let mut phase = state.phase.lock().expect("phase lock");
                let next = desktop::transition(*phase, "hide");
                let changed = next != *phase;
                *phase = next;
                changed
            };
            if hidden {
                approval::bump_epoch(&state.approval); // main.cjs 467
                let _ = win.hide();
                sync_host_visible(&win);
                publish(app, state);
            }
            Ok(build_snapshot(app, state))
        }
        Action::Quit => {
            quit_clean(app);
            Ok(Value::Null) // main.cjs returns null for quit
        }
        Action::AnimateAnyway | Action::RespectSystemMotion => {
            let value = action == Action::AnimateAnyway;
            state.motion_override.store(value, Ordering::SeqCst);
            persist_motion_override(app, value);
            publish(app, state);
            Ok(build_snapshot(app, state))
        }
        Action::Dismiss => {
            // main.cjs lines 461-463: drop the FIRST notice (id + sessionId),
            // then publish. A notice is display-only: dismissing never
            // approves, decides or opens anything.
            let now = now_ms() as u64;
            let first = state
                .notices
                .lock()
                .expect("notices lock")
                .snapshot(now)
                .into_iter()
                .next();
            if let Some(notice) = first {
                state.notices.lock().expect("notices lock").dismiss(
                    &notice.id,
                    &notice.session_id,
                    now,
                );
            }
            publish(app, state);
            Ok(build_snapshot(app, state))
        }
        Action::Allow | Action::Deny => {
            // Direct host path (the probe drives this same funnel); the
            // webview path arrives through the async command above.
            let hooks = state_hooks(state)?;
            let decision = if action == Action::Allow {
                approval::Decision::Allow
            } else {
                approval::Decision::Deny
            };
            let allowed = decision == approval::Decision::Allow;
            approval::decide(&state.approval, decision, &hooks);
            recaphost::note_decision(app, allowed);
            Ok(build_snapshot(app, state))
        }
        Action::Choose => {
            // Read-and-consume in ONE synchronous step (main.cjs 444); with
            // no producer of requests the lane has none standing, so every
            // choice is `Denied` — exactly like Electron today.
            let index =
                index.ok_or_else(|| BridgeError::denied("choose requires an integer index"))?;
            approval::choose(&state.approval, index)
                .map_err(|()| BridgeError::denied("no standing request"))?;
            publish(app, state); // legacy publishes only on success
            Ok(build_snapshot(app, state))
        }
    }
}

/// Probe-only channel: the webview reports what the facade observed (verbs,
/// typed rejections, its own label/URL) so the read-back probe can print it.
/// Not part of the preload surface and not rate limited.
#[tauri::command]
fn record_facade_evidence(webview: tauri::Webview, state: State<AppState>, evidence: Value) {
    if settingswindow::main_window_only(webview.label()).is_err() { return; }
    *state.facade.lock().expect("facade lock") = Some(evidence);
}

/// U1 probe-only channel: the webview reports what the chat surface
/// observed (DOM sizes, IPC answers). Not rate limited, stores at most 8.
#[tauri::command]
fn record_chat_evidence(webview: tauri::Webview, state: State<AppState>, evidence: Value) {
    if settingswindow::main_window_only(webview.label()).is_err() { return; }
    let mut lines = state.chat_probe.lock().expect("chat probe lock");
    if lines.len() < 8 {
        lines.push(evidence);
    }
}

/// Frontend evidence for the probe: SVG element count rendered by clay-engine
/// and canvas count (must be 0 — R6 is SVG-DOM, not Canvas/WebGL).
///
/// Side effect on first report: spawn the bounded geometry pin after page
/// load. GTK's empty-child natural fallback is handled by nativewindow;
/// this pin only reasserts the contract. It aborts as soon as the
/// user touches the island or any toggle happens (generation > 0).
#[tauri::command]
fn record_frontend_evidence(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<AppState>,
    svgs: usize,
    canvases: usize,
    revision: String,
) {
    if settingswindow::main_window_only(webview.label()).is_err() { return; }
    *state.evidence.lock().expect("evidence lock") = Some(Evidence {
        svgs,
        canvases,
        revision,
    });
    let first = state
        .initial_pin
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();
    platform::audit::sample(&app, "frontend-ready", 0, None);
    if !first {
        return;
    }
    std::thread::spawn(move || {
        // Re-pin after page load without fighting newer plans or user input.
        // Explicit GTK widget requests remove the empty-child natural fallback;
        // a grow/shrink cycle is neither required nor a sizing authority.
        let aborted = |state: &AppState| {
            state.generation.load(Ordering::SeqCst) != 0 || state.user_touch.load(Ordering::SeqCst)
        };
        for attempt in 1..=4 {
            std::thread::sleep(Duration::from_millis(600));
            let state = app.state::<AppState>();
            if aborted(&state) {
                platform::audit::sample(&app, "pin-aborted", attempt, None);
                return;
            }
            platform::audit::sample(&app, "pin-before", attempt, None);
            let rect = ensure_island_window(&app);
            let (w, h) = (rect.w, rect.h);
            let Some(win) = main_window(&app) else { return };
            store_requested(&state, "initial-pin", Some((rect.x, rect.y)), Some((w, h)));
            std::thread::sleep(Duration::from_millis(200));
            platform::audit::sample(&app, "pin-settled", attempt, Some((w, h)));
            let settled = win
                .inner_size()
                .map(|s| (s.width as i32, s.height as i32))
                .unwrap_or((0, 0))
                == (w, h);
            if settled || aborted(&state) {
                return;
            }
        }
    });
}

/// The read-back probe exists only in debug builds or with `--features probe`;
/// a packaged release ignores `ABITO_PROBE`/`--probe` entirely.
#[cfg(not(any(debug_assertions, feature = "probe")))]
pub(crate) fn probe_requested() -> bool {
    false
}
#[cfg(any(debug_assertions, feature = "probe"))]
pub(crate) fn probe_requested() -> bool {
    let env = std::env::var("ABITO_PROBE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    env || std::env::args().any(|a| a == "--probe")
}

/// The three callbacks the approval lane needs from the host (`main.cjs`
/// publish / Date / console equivalents). `ctx` must NEVER take the
/// approval lock — the lane calls it while holding its own (it only reads
/// the phase guard and the cached window facts; never a window getter,
/// which would block on the event loop with no timeout — R2).
fn build_hooks(app: AppHandle) -> approval::SharedHooks {
    Arc::new(approval::Hooks {
        ctx: {
            let app = app.clone();
            Box::new(move || {
                let state = app.state::<AppState>();
                host_ctx(&app, &state)
            })
        },
        changed: {
            let app = app.clone();
            Box::new(move || {
                let state = app.state::<AppState>();
                publish(&app, &state);
            })
        },
        // legacy `mode(value)`: the auth diagnostics line is the mode name
        // and nothing else — never a value, header or credential.
        log: Box::new(|name| println!("{name}")),
    })
}

fn main() {
    // macOS S1: the same executable doubles as the host-lifetime sentinel (no GUI, no Tauri).
    #[cfg(target_os = "macos")]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.first().map(String::as_str) == Some(abito_island::daemonhost::SENTINEL_FLAG) {
            abito_island::daemonhost::sentinel_main(&args[1..]);
        }
    }
    // Heavy constraint (HANDOFF): GTK/Tao under Wayland cannot position a window
    // absolutely nor keep it always-on-top, so the island must run on
    // X11/XWayland. Force the GDK backend before GTK initialises, but only when
    // the launcher did not already choose one.
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    // #310: the renderer choice that stops the window going blank for 2 frames when it shrinks (see renderenv).
    abito_island::renderenv::apply();
    // #503 S1: any panic leaves a LOCAL failure record (redacted, no network); the human decides later whether to report it.
    if let Some(dir) = abito_island::failure::default_dir() { abito_island::failure::install_panic_hook("island", dir); }

    let project = project_id_for_this_checkout().unwrap_or_default();
    // M3: approval lane configuration. The credential source follows legacy
    // exactly — `<stateRoot>/bridge.json`, read ONCE per process with the
    // descriptor-safe port of `readBridgeLogin`; absent/invalid means
    // `disabled` and zero traffic. In probe mode the lane is pointed at an
    // in-process FAKE backend through the ABITO_BRIDGE_BASE override before
    // it is constructed: the probe never talks to a real backend.
    let login = transport::resolve_runtime()
        .ok()
        .and_then(|root| approval::read_bridge_login(&root));
    #[cfg(any(debug_assertions, feature = "probe"))]
    let mut probe_fake = None;
    // In probe mode the lane gets the SAME credential plumbing as
    // production: the `bridge.json` login when it exists, otherwise a
    // clearly synthetic probe-only login (the fake accepts exactly what the
    // lane sends and never logs it). The lane is then constructed with that
    // effective login, so the approval read-back exercises the real start
    // path — mint, poll, healthy — against the fake.
    #[cfg(any(debug_assertions, feature = "probe"))]
    let login = if probe_requested() && std::env::var(approval::BASE_ENV).is_err() {
        let effective = login.unwrap_or_else(|| "probe@local.test".to_string());
        let fake = fakebridge::FakeBackend::start(fakebridge::FakeConfig {
            login: effective.clone(),
            proposals: vec![serde_json::json!({
                "id": format!("proposal_{}", "a".repeat(32)),
                "payload_hash": "b".repeat(64),
                "operation": "Prueba M3: propuesta servida por el backend falso",
                "status": "pending",
                "expires_at": "2999-12-31T23:59:59Z",
                "principal": "probe",
                "payload": { "probe": true },
            })],
            ..Default::default()
        });
        // The documented test/probe override: the approval client reads this
        // env at construction, so this run mints and polls against the fake.
        std::env::set_var(approval::BASE_ENV, fake.origin());
        probe_fake = Some(fake);
        Some(effective)
    } else {
        login
    };
    let approval_lane = approval::Approval::from_environment(login);
    let state = AppState {
        core: Mutex::new(Core::new()),
        work_area: Mutex::new(Rect {
            x: 0,
            y: 0,
            w: 0,
            h: 0,
        }),
        monitor: Mutex::new(Rect { x: 0, y: 0, w: 0, h: 0 }),
        requested: Mutex::new(Requested::default()),
        evidence: Mutex::new(None),
        initial_pin: AtomicBool::new(false),
        user_touch: AtomicBool::new(false),
        generation: AtomicU64::new(0),
        phase: Mutex::new(IslandState::Compact),
        motion_override: AtomicBool::new(true), // #304: animate by default
        revision: AtomicU64::new(0),
        last_published: Mutex::new(String::new()),
        rate: Mutex::new(bridge::RateLimiter::new()),
        facade: Mutex::new(None),
        notices: Mutex::new(protocol::NoticeStore::new(project.clone())),
        connections: AtomicU32::new(0),
        unavailable: AtomicBool::new(false),
        transport: Mutex::new(None),
        project,
        approval: Arc::new(Mutex::new(approval_lane)),
        hooks: Mutex::new(None),
        #[cfg(any(debug_assertions, feature = "probe"))]
        probe_fake: Mutex::new(probe_fake),
        chat: chatlane::Lane::new("c-island"),
        // U2: resolved from the saved selection in `setup` (fail closed).
        chat_target: Mutex::new(None),
        chat_cloud: Mutex::new(None),
        chat_rate: Mutex::new(bridge::RateLimiter::new()),
        window_h: AtomicI32::new(geometry::ISLAND_WINDOW.1),
        hotkey: hotkeyhost::HotkeyHost::default(),
        settings: settingshost::SettingsHost::default(),
        specialists: specialistshost::SpecialistsHost::default(),
        chat_deadlines: Mutex::new(chathost::default_deadlines()),
        chat_context: Mutex::new(Default::default()),
        chat_probe: Mutex::new(Vec::new()),
        models_registry: Mutex::new(abito_island::models::REGISTRY.to_vec()),
        models_last: Mutex::new(Value::Null),
        models_revision: AtomicU64::new(0),
        models_persisted: AtomicBool::new(false),
    };

    tauri::Builder::default()
        // M1b lifecycle: a second launch hands its argv to the first instance
        // (which restores/shows/focuses the island) and exits before run().
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Q1: a plain second launch restores WITHOUT stealing focus; only
            // the exact `--chat` flag is a deliberate request to type.
            // A GNOME keybinding runs `<exe> --action <id>`: a closed set of catalog ids, nothing else.
            if let Some(target) = abito_island::hotkey::gnome::parse_action(&argv) {
                hotkeyhost::press_target_from_action(app, target);
                return;
            }
            match desktop::launch_intent(&argv) {
                desktop::LaunchIntent::Restore => restore(app),
                desktop::LaunchIntent::Chat => {
                    restore(app);
                    open_chat_and_type(app);
                }
            }
        }))
        .plugin(navigation_lock())
        .manage(state)
        .manage(abito_island::daemonhost::HostSlot::default())
        .manage(recaphost::RecapSlot::default())
        .invoke_handler(tauri::generate_handler![
            drag_press,
            drag_move,
            drag_release,
            island_shape,
            island_window_height,
            desktop_action,
            open_chat_url,
            characterhost::character_info,
            characterhost::character_fly_out,
            characterhost::character_fly_home,
            characterhost::character_drag_begin,
            characterhost::character_drag_move,
            characterhost::character_drag_end,
            characterhost::character_home,
            characterhost::character_pick_up,
            characterhost::character_push,
            characterhost::character_carry,
            characterhost::character_carry_end,
            chathost::chat_action,
            chathost::chat_attach,
            chathost::chat_attach_data,
            modelshost::models_action,
            questionhost::question_action,
            hotkeyhost::hotkey_action,
            settingshost::agent_action,
            settingshost::prefs_action,
            integrationshost::integration_action,
            spotifyhost::spotify_action,
            secretshost::secret_action,
            oauthhost::oauth_action,
            githubhost::github_action,
            mailhost::mail_action,
            monitorshost::monitor_action,
            soundshost::sound_action,
            failurehost::failure_action,
            recaphost::recap_action,
            planhost::plan_action,
            dictationhost::dictation_action,
            voicehost::voice_action,
            settingshost::settings_view,
            settingshost::daemon_action,
            pihost::pi_install_action,
            settingswindow::settings_window_action,
            specialistshost::specialists_action,
            record_facade_evidence,
            record_chat_evidence,
            record_frontend_evidence,
            focus_host
        ])
        // Electron `win.webContents.on('did-finish-load', publish)`.
        .on_page_load(|webview, _payload| {
            let state = webview.state::<AppState>();
            publish(webview.app_handle(), &state);
        })
        // Electron `win.on('close', preventDefault + quit)`: closing the
        // window quits cleanly instead of tearing the app down ad hoc.
        .on_window_event(|window, event| {
            // #343 hardening: capture the OS-reported dropped file paths
            // NATIVELY so `chat_attach` only ever accepts a path the OS
            // actually dropped on the main window (one-shot, TTL, bounded).
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if window.label() == "main" {
                    chathost::record_drops(paths.clone());
                }
            }
            if window.label() == characterhost_label() {
                if let tauri::WindowEvent::Resized(_) = event {
                    characterhost::on_resized(window.app_handle());
                }
            }
            if window.label() == "main" {
                // #431: window events run on the main thread, so the live
                // scale getter is inline here; keep the off-main cache fresh.
                if let tauri::WindowEvent::ScaleFactorChanged { scale_factor, .. } = event {
                    store_scale(*scale_factor);
                    ensure_island_window(window.app_handle());
                }
                if let tauri::WindowEvent::Resized(size) = event {
                    #[cfg(any(debug_assertions, feature = "probe"))]
                    probe::mark(format!("tao Resized {}x{}", size.width, size.height));
                    islandshape::apply(window.app_handle(), None);
                    platform::audit::sample(
                        window.app_handle(),
                        "resized",
                        0,
                        Some((size.width as i32, size.height as i32)),
                    );
                }
            }
            // T6.2: the own Ajustes window remembers its size. The event payload
            // is the ONLY source and the scale factor is read right here on the
            // main thread — never a window getter while a lock is held or off
            // the main thread (review finding R2). The debounced persister in
            // `settingswindow` touches only atomics and the prefs gate.
            if window.label() == settingswindow::SETTINGS_LABEL {
                if let tauri::WindowEvent::Resized(size) = event {
                    settingswindow::note_resized(
                        window.app_handle(),
                        size.width,
                        size.height,
                        window.scale_factor().unwrap_or(1.0),
                    );
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // #366 F093: the own Ajustes window closes normally — quitting is
                // the island window's path only, never a side effect of this one.
                if window.label() == settingswindow::SETTINGS_LABEL {
                    return;
                }
                if QUITTING.load(Ordering::SeqCst) {
                    return; // the exit path is already closing windows
                }
                api.prevent_close();
                let app = window.app_handle().clone();
                quit_clean(&app);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let win = main_window(&handle).ok_or("main window unavailable")?;
            // Load preferences before placement so the chosen monitor is available.
            // The legacy position preference stays on disk but is never applied.
            settingshost::start(&handle);
            islandclick::start(&handle); // HU-043: Windows/macOS only (no-op on Linux, which has the GDK input region)
            dictationhost::start(&handle);
            voicehost::start(&handle);
            characterhost::manage(&handle);
            characterhost::restore_on_launch(&handle);
            integrationshost::start(&handle);
            let scale = win.scale_factor().unwrap_or(1.0);
            store_scale(scale); // #431: seed the off-main scale cache
            let rect = ensure_island_window(&handle);
            let (w, h) = (rect.w, rect.h);
            // Contract attribute, set explicitly as well as via the window
            // config: the read-back probe must show is_always_on_top=true and
            // under XWayland the config path alone did not guarantee it.
            if let Err(e) = win.set_always_on_top(true) {
                eprintln!("set_always_on_top(true) failed: {e}");
            }
            // R2: seed the cached visibility the off-main host context reads
            // (main thread here, so the live getter is inline and safe).
            sync_host_visible(&win);
            let state = app.state::<AppState>();
            // ensure_island_window has cached the chosen work area already.
            state.core.lock().expect("core lock").edge = Edge::Top;
            store_requested(&state, "initial", Some((rect.x, rect.y)), Some((w, h)));
            platform::audit::sample(&handle, "setup", 0, Some((w, h)));
            // Read-only sampling stops with this process. No probe or UI actions.
            if platform::audit::enabled() {
                let audit_handle = handle.clone();
                std::thread::spawn(move || {
                    for second in 1..=16 {
                        std::thread::sleep(Duration::from_secs(1));
                        if QUITTING.load(Ordering::SeqCst) {
                            break;
                        }
                        platform::audit::sample(&audit_handle, "timer", second, None);
                    }
                });
            }
            // M1b: motion override fails closed from user config.
            state
                .motion_override
                .store(load_motion_override(&handle), Ordering::SeqCst);
            spawn_workarea_watcher(handle.clone());
            spawn_publish_ticker(handle.clone());
            #[cfg(target_os = "macos")] { // HU-065: «Ver» activates the terminal app on the main thread
                let main = handle.clone();
                abito_island::sessionterm_mac::set_main_runner(move |job| { let _ = main.run_on_main_thread(job); });
            }
            hotkeyhost::start(&handle); // #305: global show/hide shortcut (config + X11 grab)
            // #306 settings prefs: `settingshost::start` runs before the island is placed (#264)
            specialistshost::start(&handle); // #327: the manual specialists (empty = the principal)
            chathost::start_history(&handle); // #341: isolated private conversation store
            // M2: local notice transport + SIGINT/SIGTERM socket cleanup
            // (main.cjs creates the transport after the window loads; here it
            // starts before the probe so the probe can use its endpoint).
            start_transport(&handle);
            install_shutdown_handlers();
            // Only the first instance reaches setup. Failure is optional and
            // never tears down the island; runtime errors reach agent:state.
            handle.state::<abito_island::daemonhost::HostSlot>().start();
            spawn_shutdown_watcher(handle.clone());
            // #315: the tray (menu: Mostrar/Ocultar/Arrancar al iniciar sesión/Salir)
            // plus one bounded, off-thread first connection attempt so the icon
            // reflects the daemon without waiting for the first Settings open.
            trayhost::start(&handle);
            settingswindow::open_on_launch(&handle, std::env::args().any(|arg| arg == "--autostart"));
            // M3: approval lane — install the publish/context/log hooks,
            // then start the bridge (mode 'jar', mint, first poll, 10 s
            // cadence) exactly where main.cjs `startBridge` runs: after the
            // transport, before the first publish tick.
            // U2: the saved model selection (absent → the approved initial
            // local profile; corrupt/unknown → none, nothing substituted).
            modelshost::load_selection(&handle, &state);
            #[cfg(debug_assertions)]
            nativewindow::start_view_test(&win);
            let hooks = build_hooks(handle.clone());
            *state.hooks.lock().expect("hooks lock") = Some(hooks.clone());
            approval::spawn_bridge(Arc::clone(&state.approval), hooks);
            #[cfg(any(debug_assertions, feature = "probe"))]
            if probe_requested() {
                std::thread::spawn(move || probe::run(handle));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building abito island")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<abito_island::daemonhost::HostSlot>().stop();
                settingshost::stop(app);
                close_transport(app);
            }
        });
}

/// #336 T1b-a (L15 conditions ii/iv): the NEW `autoClose` verb's admission
/// verdict. Every protected fact refuses with the one approved sentence and
/// nothing else; an already-compact island is an honest no-op, never a
/// refusal. Manual folding alone may preserve a pending QP question compactly.
#[cfg(test)]
mod auto_close_tests {
    use super::*;

    const APPROVED: &str = "Denied: La isla tiene una interacción pendiente.";

    #[test]
    fn every_protected_fact_refuses_the_new_verb_with_the_one_approved_message() {
        // question pending / approval card pending / standing request /
        // decision in flight — each ONE fact alone vetoes the close (L8)
        let cases = [
            (true, false, false, false),
            (false, true, false, false),
            (false, false, true, false),
            (false, false, false, true),
            (true, true, true, true),
        ];
        for (pending, card, request, decision) in cases {
            let err = auto_close_verdict(pending, card, request, decision, true)
                .expect_err("a protected fact must refuse the close");
            assert_eq!(err.code, "denied");
            assert_eq!(err.message, APPROVED, "exactly the approved refusal");
        }
        // a protected fact still wins over an already-compact island: the
        // refusal is the honest answer, never a silent success
        for expanded in [true, false] {
            let err = auto_close_verdict(true, false, false, false, expanded)
                .expect_err("pending always refuses");
            assert_eq!(err.message, APPROVED);
        }
    }

    #[test]
    fn a_clear_expanded_island_collapses_and_a_compact_one_is_a_no_op() {
        assert_eq!(auto_close_verdict(false, false, false, false, true), Ok(true));
        assert_eq!(auto_close_verdict(false, false, false, false, false), Ok(false));
    }

    /// L15 condition ii: the approved sentence is carried verbatim inside the
    /// existing `denied` shape — code and message pinned byte for byte.
    #[test]
    fn the_refusal_shape_is_the_existing_denied_code_with_the_exact_sentence() {
        let err = auto_close_verdict(false, false, false, true, true).unwrap_err();
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            serde_json::json!({"code": "denied", "message": APPROVED})
        );
        // the sentence the coordinator approved, exactly once, capitalized and punctuated
        assert_eq!(
            err.message.strip_prefix("Denied: ").map(str::to_string),
            Some("La isla tiene una interacción pendiente.".to_string())
        );
    }
}

#[cfg(test)]
mod manual_close_tests {
    use super::*;

    #[test]
    fn native_approval_request_mutation_and_quit_still_refuse_manual_folding() {
        let now = 100_000;
        for fact in ["card", "request", "mutation", "quit"] {
            let mut appr = approval::Approval::disabled();
            appr.status = desktop::BridgeStatus { state: "healthy", reason: "" };
            match fact {
                "card" => appr.selected = Some(abito_island::card::Candidate {
                    id: "host-card".into(), hash: "hash".into(), operation: "write".into(),
                    expires_at: "future".into(), expires: now + 30_000, reason: None,
                }),
                "request" => appr.request = Some(abito_island::card::StandingRequest {
                    origin: "host".into(), question: "Approve?".into(), options: vec![],
                }),
                "mutation" => appr.mutation_busy = true,
                "quit" => appr.active.abort_all(),
                _ => unreachable!(),
            }
            assert!(manual_close_verdict(&mut appr, true, true, now).is_err(), "{fact}");
            assert_eq!(appr.epoch, 0, "a refusal must not revoke decision authority");
        }
    }

    #[test]
    fn manual_fold_leaves_inert_cards_alone_and_close_never_hides_or_quits() {
        let mut appr = approval::Approval::disabled();
        assert_eq!(manual_close_verdict(&mut appr, true, true, 100_000), Ok(true));
        assert_eq!(manual_close_verdict(&mut appr, false, true, 100_000), Ok(false));
        appr.selected = Some(abito_island::card::Candidate {
            id: "expired".into(), hash: "hash".into(), operation: "write".into(),
            expires_at: "past".into(), expires: 99_999, reason: None,
        });
        assert_eq!(manual_close_verdict(&mut appr, true, true, 100_000), Ok(true));
        assert_eq!(desktop::transition(IslandState::Expanded, "close"), IslandState::Compact);
        assert_eq!(desktop::transition(IslandState::Compact, "close"), IslandState::Compact);
        assert_eq!(desktop::transition(IslandState::Hidden, "close"), IslandState::Hidden);
    }
}

/// R2 (lock-across-getter deadlock): the host context the lane reads while
/// holding the approval mutex must never touch a blocking window getter,
/// and the visible fact it returns must track every show/hide of the main
/// window. See `WindowFacts` / `HOST_VISIBLE`.
#[cfg(test)]
mod host_ctx_tests {
    use super::*;
    use std::sync::mpsc;

    /// A fake host whose getter blocks until the test releases it: exactly
    /// what the real `is_visible()` does when called off the main thread
    /// (posts to the event loop, waits with NO timeout).
    struct BlockingFacts {
        called: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl WindowFacts for BlockingFacts {
        fn is_visible(&self) -> bool {
            self.called.send(()).expect("test channel");
            self.release
                .lock()
                .expect("test channel")
                .recv()
                .expect("test channel");
            true
        }
    }

    /// A lock holder reading the host context through the CACHED source
    /// finishes while still holding its lock and never invokes the getter.
    /// The first half proves the fake getter really blocks (the test can
    /// detect the hazard); the second half proves the cache does not.
    #[test]
    fn a_lock_holder_reading_the_host_context_never_calls_the_blocking_getter() {
        // 1. Hazard check: the same read through a blocking source hangs
        //    until released — this test CAN detect the deadlock.
        let (called_tx, called_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let blocking = BlockingFacts {
            called: called_tx,
            release: Mutex::new(release_rx),
        };
        let worker = std::thread::spawn(move || {
            host_ctx_from(0, false, &blocking, false)
        });
        assert!(
            called_rx.recv_timeout(Duration::from_secs(2)).is_ok(),
            "the blocking fake must actually be called: otherwise this test detects nothing"
        );
        release_tx.send(()).expect("test channel");
        let ctx = worker.join().expect("hazard worker thread");
        assert!(ctx.visible);

        // 2. Production source: a lock holder reads the cache and completes
        //    without ever calling the blocking getter.
        let (called_tx, called_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let uncalled = BlockingFacts {
            called: called_tx,
            release: Mutex::new(release_rx),
        };
        HOST_VISIBLE.store(true, Ordering::SeqCst);
        let lock = Arc::new(Mutex::new(()));
        let worker_lock = Arc::clone(&lock);
        let cache = CachedWindowFacts;
        let worker = std::thread::spawn(move || {
            let guard = worker_lock.lock().expect("test lock");
            let ctx = host_ctx_from(0, false, &cache, false);
            // Report completion WITHOUT releasing the lock: the holder must
            // never wait on the event loop for this read to finish.
            done_tx.send(ctx.visible).expect("test channel");
            drop(guard);
            drop(uncalled);
            drop(release_tx);
        });
        let visible = done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the cached host context must never block on the window getter");
        assert!(visible);
        assert!(
            called_rx.try_recv().is_err(),
            "a lock holder must never call the blocking getter"
        );
        worker.join().expect("cached worker thread");
    }

    /// #431: `chathost::chat_view` runs off the main thread (from `chat_action`
    /// while lane locks are taken), so it must read the CACHED scale, never the
    /// blocking `scale_factor()` getter. Source guard plus cache semantics.
    #[test]
    fn chat_view_reads_the_cached_scale_never_the_blocking_getter() {
        let src = include_str!("chathost.rs");
        let body = &src[src.find("pub fn chat_view").expect("chat_view exists")..];
        let body = &body[..body.find("\n}\n").expect("chat_view ends")];
        assert!(!body.contains("scale_factor()"), "chat_view must not call the blocking getter");
        assert!(body.contains("cached_scale()"), "chat_view reads the main-thread scale cache");
    }

    #[test]
    fn the_cached_scale_defaults_to_one_and_tracks_finite_positive_updates() {
        store_scale(1.0);
        assert_eq!(cached_scale(), 1.0);
        store_scale(2.0);
        assert_eq!(cached_scale(), 2.0);
        // a nonsensical reading never replaces a good one
        store_scale(f64::NAN);
        assert_eq!(cached_scale(), 2.0);
        store_scale(0.0);
        assert_eq!(cached_scale(), 2.0);
        store_scale(1.0);
        assert_eq!(cached_scale(), 1.0);
    }

    /// The cached visible fact tracks every show/hide: it starts `true` (the
    /// getter's own `unwrap_or(true)` fallback) and `sync_host_visible` is
    /// the only production writer (main thread, after each window op).
    #[test]
    fn the_cached_visible_fact_defaults_true_and_tracks_updates() {
        HOST_VISIBLE.store(true, Ordering::SeqCst);
        assert!(HOST_VISIBLE.load(Ordering::SeqCst));
        HOST_VISIBLE.store(false, Ordering::SeqCst);
        assert!(!HOST_VISIBLE.load(Ordering::SeqCst));
        HOST_VISIBLE.store(true, Ordering::SeqCst);
        assert!(HOST_VISIBLE.load(Ordering::SeqCst));
    }
}

/// R2 (lock-across-getter deadlock): only the approval decisions may run on
/// the tokio thread — they block on HTTP (legacy 5 s deadline) and never
/// touch a window. Every other verb performs window getters/ops, and an
/// off-main getter posts to the event loop and blocks with no timeout, so
/// taking any host lock across one can deadlock against the main thread.
///
/// This match is the routing's single source of truth and has NO wildcard
/// arm: adding an `Action` variant fails the BUILD here (compile-time
/// exhaustiveness), forcing a deliberate routing choice before this verb
/// can ever reach `desktop_action`. Update `main_thread_routing_tests` in
/// the same change.
fn runs_off_main_thread(action: Action) -> bool {
    match action {
        Action::Allow | Action::Deny => true,
        Action::Snapshot
        | Action::Expand
        | Action::Close
        | Action::Hide
        | Action::Quit
        | Action::Dismiss
        | Action::Choose
        | Action::AnimateAnyway
        | Action::RespectSystemMotion
        | Action::AutoClose => false,
    }
}

#[cfg(test)]
mod main_thread_routing_tests {
    use super::*;

    #[test]
    fn only_the_http_decision_verbs_may_run_off_the_main_thread() {
        // Exhaustiveness guard: `runs_off_main_thread` matches every Action
        // variant with NO wildcard arm, so adding a variant fails the build
        // (which fails this suite) until a deliberate routing choice is made
        // and this test's two lists are extended.
        // The decisions block on HTTP and never touch a window: the
        // spawn_blocking pool stays theirs (legacy 5 s deadline).
        for action in [Action::Allow, Action::Deny] {
            assert!(
                runs_off_main_thread(action),
                "{action:?} must keep running off the main thread"
            );
        }
        // Every other verb performs window getters/ops: inline on the main
        // thread only, never across a lock off it (R2 deadlock).
        for action in [
            Action::Snapshot,
            Action::Expand,
            Action::Close,
            Action::Hide,
            Action::Quit,
            Action::Dismiss,
            Action::Choose,
            Action::AnimateAnyway,
            Action::RespectSystemMotion,
            Action::AutoClose,
        ] {
            assert!(
                !runs_off_main_thread(action),
                "{action:?} must run inline on the main thread"
            );
        }
    }
}

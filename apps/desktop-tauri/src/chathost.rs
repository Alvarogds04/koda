//! Unit U1 host wiring: the `chat_action` command, the `chat:state` event,
//! and the overview <-> chat resize of the SAME island window.
//!
//! K2-05 T4 U3: the chat talks to the DAEMON ENGINE. The WebView still sends
//! only the closed `chat::Command` set (validated here: island gate, sender
//! gate, size/shape, rate) and still receives the SAME `chat:state` keys; the
//! verbs are routed by `chatclient::ChatHost` over ONE `agentconn::ChatConn`
//! per app (started at setup, reconnecting), with the caller's REAL window
//! label passed into chatclient's window gate. One continuous chat: the
//! conversation-list verbs are refused (`conversations_off`), attachments go to
//! the daemon (`chat_attach`/`chat_attach_data` → `ChatHost::upload`). The direct Rust chat (local/cloud lanes,
//! the private conversation store) is no longer reachable from here; only
//! `start_history` remains until U5 deletes it. Nothing in this file touches
//! the desktop snapshot shape (`desktop:state` keeps its 13 keys).

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use abito_island::agentconn::ChatConn;
use abito_island::bridge::{self, BridgeError};
use abito_island::chat::{self, Command};
use abito_island::chatclient::{self, Routed};
use abito_island::core::ViewPlan;
use abito_island::desktop::IslandState;
use abito_island::geometry;
use abito_island::localmodel::DEFAULT_DEADLINES;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{main_window, now_ms, publish, refresh_work_area, store_requested, AppState, TauriIo, QUITTING};

/// #343 hardening: paths the OS reported DROPPING on the main window,
/// recorded natively by `main.rs`'s window event handler. `chat_attach`
/// only ever reads (and hands to the daemon) a member of this set: short-lived (60 s TTL), bounded
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

/// Throttle between two connection attempts of the chat (a missing daemon must not
/// turn into a reconnect storm, and every attempt reads session.json from disk).
const RECONNECT_GAP: Duration = Duration::from_secs(2);
/// The keeper's tick: reconnects when due and re-publishes while a turn is live (the
/// settle grace of a submitted turn is time-based, not frame-based).
const KEEPER_TICK: Duration = Duration::from_millis(500);

/// K2-05 T4 U3: the island's ONE chat connection to the daemon engine plus the feed (the
/// host that routes the page verbs, and the last view the reader handed over). Managed app
/// state, created at setup by [`start_conn`].
pub struct ChatRoute {
    feed: Arc<chatclient::ChatFeed>,
    conn: Arc<ChatConn>,
    /// When the last connection attempt started; `None` until the first one.
    last_try: Mutex<Option<Instant>>,
    /// Single flight: a handshake can outlast the gap, and two concurrent connects
    /// would close each other's socket.
    connecting: Mutex<()>,
    /// The last emitted `chat:state`, to skip identical repeats (reconnect noise).
    last_emitted: Mutex<Value>,
}

fn island_dir() -> Option<PathBuf> {
    abito_island::agentconn::island_root(
        std::env::var("ABITO_ISLAND_DIR").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )
}

/// F7: the keeper's question is answered from the view the reader handed over, never by
/// serializing the whole chat state again.
fn connected(route: &ChatRoute) -> bool {
    route.feed.connected()
}

/// Connect (or reconnect) when the chat is not connected and the gap elapsed. Blocking
/// (bounded by the handshake wait): callers run it off the main thread.
fn try_reconnect(route: &ChatRoute, gap: Duration) {
    if QUITTING.load(Ordering::SeqCst) || connected(route) {
        return;
    }
    let Ok(_single) = route.connecting.try_lock() else { return };
    {
        let mut last = route.last_try.lock().expect("chat reconnect lock");
        if last.is_some_and(|t| t.elapsed() < gap) {
            return;
        }
        *last = Some(Instant::now());
    }
    if let Some(root) = island_dir() {
        route.conn.connect(&root);
    }
}

/// Setup: ONE chat connection per app, next to the settings `AgentConn` (the daemon allows
/// two clients), reconnecting in the background. Its frames re-publish `chat:state` through
/// the production reader callback ([`chatclient::ChatFeed::reader_callback`], covered by
/// `tests/chat_daemon.rs` against the real daemon).
pub fn start_conn(app: &AppHandle) {
    let emitter = app.clone();
    let feed = chatclient::ChatFeed::new(move |projection| publish_projection(&emitter, projection));
    let conn = Arc::new(ChatConn::new(chatclient::ChatFeed::reader_callback(&feed)));
    let link: Arc<dyn chatclient::ChatLink + Send + Sync> = conn.clone();
    feed.bind(Arc::downgrade(&link));
    app.manage(ChatRoute {
        feed,
        conn,
        last_try: Mutex::new(None),
        connecting: Mutex::new(()),
        last_emitted: Mutex::new(Value::Null),
    });
    let keeper = app.clone();
    std::thread::spawn(move || {
        while !QUITTING.load(Ordering::SeqCst) {
            let route = keeper.state::<ChatRoute>();
            try_reconnect(&route, RECONNECT_GAP);
            if route.feed.host().has_live() {
                publish_chat(&keeper);
            }
            std::thread::sleep(KEEPER_TICK);
        }
    });
}

/// Exit: close the chat connection (the reader thread stops, the socket shuts down).
pub fn stop_conn(app: &AppHandle) {
    if let Some(route) = app.try_state::<ChatRoute>() {
        route.conn.close();
    }
}

/// The daemon chat's `chat:state` conversation keys (the SAME keys the page renders); a
/// disconnected projection before setup managed the route.
fn conversation_view(app: &AppHandle) -> Value {
    match app.try_state::<ChatRoute>() {
        // F7: the view the reader handed over, never a fresh serialization of the state
        Some(route) => route.feed.project(now_ms() as u64),
        None => {
            let off = abito_island::chatclient::ChatState::disconnected(abito_island::agentclient::Reason::NoDaemon);
            chatclient::ChatHost::new().project(&serde_json::to_value(off).unwrap_or(Value::Null), now_ms() as u64)
        }
    }
}

/// `chat:state` payload: the conversation projection over the DAEMON chat, the current
/// view, the chat geometry (from the ONE Rust constant) and the display name. `target` is
/// null (the engine owns the model) and `producer.pi` is the real engine state.
pub fn chat_view(app: &AppHandle, state: &AppState) -> Value {
    with_page_keys(state, conversation_view(app))
}

/// The page keys around one conversation projection.
fn with_page_keys(state: &AppState, mut v: Value) -> Value {
    v["display_name"] = json!(crate::settingshost::display_name(&state.settings));
    let chat_open = state.core.lock().expect("core lock").chat
        && *state.phase.lock().expect("phase lock") == IslandState::Expanded;
    v["view"] = json!(if chat_open { "chat" } else { "overview" });
    // #309: the column's height follows the work area, so Rust computes it from the current one
    let area = *state.work_area.lock().expect("work area lock");
    // #431: off-main caller (chat_action): read the main-thread scale cache, never the
    // blocking window scale getter.
    let scale = crate::cached_scale();
    let asked = state.core.lock().expect("core lock").chat_height();
    let (cw, ch) = geometry::chat_visible_for(area.h, scale, asked);
    v["chat_visible"] = json!([cw, ch]);
    v
}

/// Re-publish `chat:state` (the keeper while a turn is live, view changes, resizes): the
/// feed projects the last handed-over view (and sends the host's own history refresh when
/// a turn settled), never a fresh serialization of the chat state (F7).
pub fn publish_chat(app: &AppHandle) {
    let projection = match app.try_state::<ChatRoute>() {
        Some(route) => route.feed.publish(now_ms() as u64),
        None => conversation_view(app),
    };
    publish_projection(app, projection);
}

/// Emit one projection as `chat:state` (skipping identical repeats).
fn publish_projection(app: &AppHandle, projection: Value) {
    if QUITTING.load(Ordering::SeqCst) {
        return;
    }
    let state = app.state::<AppState>();
    let v = with_page_keys(&state, projection);
    if let Some(route) = app.try_state::<ChatRoute>() {
        // `seq` advances on every projection: compare without it so identical
        // reconnect noise is not re-emitted
        let strip = |mut x: Value| {
            if let Some(ts) = x.get_mut("turns").and_then(Value::as_array_mut) {
                for t in ts {
                    t["seq"] = Value::Null;
                }
            }
            x
        };
        let key = strip(v.clone());
        let mut last = route.last_emitted.lock().expect("chat emit lock");
        if *last == key {
            return;
        }
        *last = key;
    }
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
        // a chat opened while the engine was away: one throttled attempt now, off the main thread
        let app = app.clone();
        std::thread::spawn(move || {
            if let Some(route) = app.try_state::<ChatRoute>() {
                try_reconnect(&route, RECONNECT_GAP);
            }
        });
    }
}

/// `chat_action`: sender gate → payload shape → rate → route to the daemon engine.
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
    // the REAL caller label travels into chatclient's window gate (never a constant)
    let caller = webview.label().to_string();
    let handle = app.clone();
    let routed_command = command.clone();
    let routed = tauri::async_runtime::spawn_blocking(move || {
        let route = handle
            .try_state::<ChatRoute>()
            .ok_or_else(|| BridgeError::denied("chat unavailable"))?;
        route
            .feed
            .host()
            .route(&*route.conn, &caller, &routed_command, now_ms() as u64)
            .map_err(chat_error)
    })
    .await
    .map_err(|_| BridgeError::denied("chat aborted"))??;
    match routed {
        Routed::View => Ok(chat_view(&app, &state)),
        Routed::Answer(answer) => {
            publish_chat(&app);
            Ok(answer)
        }
        Routed::Local => match command {
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
            _ => Ok(chat_view(&app, &state)),
        },
    }
}

// K2-05 attachments (L11 2a, Gentle Dot's model): a file the user picked, dropped or pasted goes
// to the DAEMON over the island's own chat connection (`ChatHost::upload`: `upload` chunks), which
// stores it in the engine workspace and answers an opaque id issued to this island only. The
// island never writes an upload, and the page never names a path the island reads: a dropped
// path is honoured only when the OS reported it dropped on the island window (`NATIVE_DROPS`,
// one-shot), and a picked or pasted file arrives as raw bytes.

/// How long the island waits for the daemon's answer after the last chunk.
const UPLOAD_WAIT_MS: u64 = 15_000;

/// Read one natively dropped path: a regular file only (a link is refused, never followed), at
/// most the daemon's 25 MB per file, checked on the open handle before reading.
fn read_picked_path(path: &std::path::Path) -> Result<(String, Vec<u8>), chat::ChatError> {
    use std::io::Read;
    let unreadable = || chat::ChatError::invalid_input("No se pudo leer el archivo arrastrado.");
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let meta = std::fs::symlink_metadata(path).map_err(|_| unreadable())?;
    if !meta.is_file() {
        return Err(chat::ChatError::invalid_input("Eso no es un archivo."));
    }
    let file = std::fs::File::open(path).map_err(|_| unreadable())?;
    let opened = file.metadata().map_err(|_| unreadable())?;
    if !opened.is_file() {
        return Err(chat::ChatError::invalid_input("Eso no es un archivo."));
    }
    if opened.len() > chatclient::MAX_UPLOAD_FILE_BYTES as u64 {
        return Err(chatclient::upload_error("file_too_large"));
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(chatclient::MAX_UPLOAD_FILE_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|_| unreadable())?;
    if bytes.len() > chatclient::MAX_UPLOAD_FILE_BYTES {
        return Err(chatclient::upload_error("file_too_large"));
    }
    Ok((name, bytes))
}

/// Hand one file to the daemon through the chat connection, off the main thread.
async fn upload_to_daemon(app: AppHandle, caller: String, name: String, bytes: Vec<u8>) -> Result<Value, BridgeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let route = app.try_state::<ChatRoute>().ok_or_else(|| BridgeError::denied("chat unavailable"))?;
        route.feed.host().upload(&*route.conn, &caller, &name, &bytes, UPLOAD_WAIT_MS).map_err(chat_error)
    })
    .await
    .map_err(|_| BridgeError::denied("chat aborted"))?
}

/// #343 — `chat_attach`: one file DROPPED into the chat, sent to the daemon.
#[tauri::command]
pub async fn chat_attach(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let bad = || chat_error(chat::ChatError::invalid_input("Pedido de archivo inválido."));
    let map = payload.as_object().filter(|m| m.len() == 1).ok_or_else(bad)?;
    let path = map.get("path").and_then(Value::as_str).filter(|p| !p.is_empty() && p.len() <= 4096).map(PathBuf::from).ok_or_else(bad)?;
    // only a path the OS reported dropped on the island window, once and while fresh
    let dropped = NATIVE_DROPS.lock().expect("native drop paths lock").consume(&path, now_ms() as u64);
    if !dropped {
        return Err(chat_error(chat::ChatError::invalid_input("Ese archivo no llegó arrastrado a la ventana.")));
    }
    let (name, bytes) = tauri::async_runtime::spawn_blocking(move || read_picked_path(&path))
        .await
        .map_err(|_| BridgeError::denied("chat aborted"))?
        .map_err(chat_error)?;
    upload_to_daemon(app, webview.label().to_string(), name, bytes).await
}

/// #343 — `chat_attach_data`: one file PICKED or PASTED in the composer (raw bytes: a one-line JSON
/// header `{"name":…}`, LF, the file bytes), sent to the daemon.
#[tauri::command]
pub async fn chat_attach_data(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err(chat_error(chat::ChatError::invalid_input("Pedido de archivo inválido.")));
    };
    let (name, bytes) = abito_island::uploads::split_raw_body(body).map_err(chat_error)?;
    if bytes.len() > chatclient::MAX_UPLOAD_FILE_BYTES {
        return Err(chat_error(chatclient::upload_error("file_too_large")));
    }
    let (name, bytes) = (name, bytes.to_vec());
    upload_to_daemon(app, webview.label().to_string(), name, bytes).await
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

/// Default deadlines for production turns.
pub fn default_deadlines() -> abito_island::localmodel::Deadlines {
    DEFAULT_DEADLINES
}

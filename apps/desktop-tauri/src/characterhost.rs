//! Desktop character window (#486, NotchBuddy feature 1).
//!
//! Adapted from Coucou windows/src-tauri/src/desktop.rs @71b773f, Copyright (c) 2026 Louis Raillé, MIT.
//! The character lives in its own transparent, undecorated, always-on-top window (the island
//! already runs as an XWayland window, so this one is placed with `set_outer_position`).
//! Rust owns where it is; the page only draws Abito's clay character and forwards the pointer.
//! Closed commands: no label, URL or size ever comes from a page.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use abito_island::characterwin::{self as cw, Display, Rect};
use abito_island::contextwin;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Default)]
struct Inner {
    /// Top-left of the window, physical px.
    pos: (f64, f64),
    /// Pointer (screen css px) and window origin (physical) at the press of a drag.
    drag: Option<((f64, f64), (f64, f64))>,
    /// Being carried out of the island by the pointer (the island page drives it).
    carrying: bool,
    /// Last drag event's screen pointer, physical px (not the character's centre).
    pointer: Option<(f64, f64)>,
}

#[derive(Default)]
pub struct Character {
    inner: Mutex<Inner>,
    /// Bumped by every flight: an older one still running stops moving the window.
    flight: AtomicU64,
    /// Bumped to stop the gaze poll of an older show.
    gaze: AtomicU64,
    /// Invalidates scans and queued UI updates on drop/cancel/quit.
    highlight: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    mode: &'static str,
    on_desktop: bool,
}

#[derive(Serialize, Clone)]
struct Dropped {
    from: &'static str,
    home: bool,
}

pub fn manage(app: &AppHandle) {
    app.manage(Arc::new(Character::default()));
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(cw::LABEL)
}

fn ensure_window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = window(app) {
        return Some(w);
    }
    WebviewWindowBuilder::new(app, cw::LABEL, WebviewUrl::App(cw::PAGE.into()))
        .title("Koda")
        .inner_size(cw::SIZE, cw::SIZE)
        // GTK will not size a non-resizable window below its natural size.
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focused(false)
        .focusable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .visible(false)
        .build()
        .map_err(|e| eprintln!("desktop character window failed: {e}"))
        .ok()
}

fn displays(app: &AppHandle) -> Vec<Display> {
    let Ok(monitors) = app.available_monitors() else { return Vec::new() };
    monitors
        .iter()
        .map(|m| {
            let (p, s, wa) = (m.position(), m.size(), m.work_area());
            Display {
                frame: Rect { x: p.x as f64, y: p.y as f64, w: s.width as f64, h: s.height as f64 },
                work: Rect {
                    x: wa.position.x as f64,
                    y: wa.position.y as f64,
                    w: wa.size.width as f64,
                    h: wa.size.height as f64,
                },
                scale: m.scale_factor(),
            }
        })
        .collect()
}

/// The island window's rectangle and its scale, physical px.
fn island_rect(app: &AppHandle) -> Option<(Rect, f64)> {
    let win = app.get_webview_window("main")?;
    let (p, s) = (win.outer_position().ok()?, win.outer_size().ok()?);
    let rect = Rect { x: p.x as f64, y: p.y as f64, w: s.width as f64, h: s.height as f64 };
    Some((rect, win.scale_factor().unwrap_or(1.0)))
}

fn island_origin(app: &AppHandle) -> Option<(f64, f64)> {
    let (r, scale) = island_rect(app)?;
    Some(cw::island_spot(r.x + r.w / 2.0, r.y, cw::SIZE, scale))
}

/// Click-through everywhere but the round body (Coucou: `set_desktop_shape`). GDK sets the X11
/// input shape on the window's GdkWindow, so no extra X11 crate is involved; must run on the GTK
/// thread and after the window is realized (we call it right after `show`).
#[cfg(not(target_os = "linux"))]
fn apply_shape(_app: &AppHandle, _win: &WebviewWindow) {
    // No GDK input shape off Linux: the window keeps its full (transparent) rectangle.
}

#[cfg(target_os = "linux")]
fn apply_shape(app: &AppHandle, win: &WebviewWindow) {
    let handle = win.clone();
    let _ = app.run_on_main_thread(move || {
        use gtk::cairo::{RectangleInt, Region};
        use gtk::prelude::WidgetExt;
        let Ok(gtk_win) = handle.gtk_window() else { return };
        let Some(gdk) = gtk_win.window() else { return };
        let region = Region::create();
        // GDK takes the shape in the window's logical pixels.
        for (x, y, w, h) in cw::body_input_rects(cw::SIZE, 1.0) {
            let _ = region.union_rectangle(&RectangleInt::new(x as i32, y as i32, w as i32, h as i32));
        }
        gdk.input_shape_combine_region(&region, 0, 0);
    });
}

// Adapted from Coucou NotchBuddy/Sources/App/IslandWindowController.swift @71b773f, Copyright (c) 2026 Louis Raillé, MIT.
const HIGHLIGHT: &str = "character-highlight";

fn target_at(app: &AppHandle, point: (f64, f64)) -> Option<(contextwin::ActiveWindow, Rect)> {
    let scale = displays(app).iter().find(|d| d.frame.contains(point)).map(|d| d.scale).unwrap_or(1.0);
    contextwin::capture_at(point, scale)
}

fn stop_highlight(app: &AppHandle, c: &Character) {
    c.highlight.fetch_add(1, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(HIGHLIGHT) { let _ = w.hide(); }
}

/// Also called by both native quit paths. No window or page IPC chooses this label.
pub fn shutdown(app: &AppHandle) {
    if let Some(c) = app.try_state::<Arc<Character>>() {
        c.flight.fetch_add(1, Ordering::SeqCst);
        c.gaze.fetch_add(1, Ordering::SeqCst);
        stop_highlight(app, &c);
    }
}

fn paint_highlight(app: &AppHandle, rect: Option<Rect>) {
    let Some(r) = rect else {
        if let Some(w) = app.get_webview_window(HIGHLIGHT) { let _ = w.hide(); }
        return;
    };
    let win = app.get_webview_window(HIGHLIGHT).or_else(|| {
        WebviewWindowBuilder::new(app, HIGHLIGHT, WebviewUrl::App("desktop-highlight.html".into()))
            .title("Koda").inner_size(120.0, 120.0).resizable(true)
            .decorations(false).transparent(true).shadow(false).always_on_top(true)
            .skip_taskbar(true).visible_on_all_workspaces(true).focused(false).focusable(false)
            .maximizable(false).minimizable(false).closable(false).visible(false).build().ok()
    });
    let Some(w) = win else { return };
    // Realize while hidden, then apply GDK's EMPTY region BEFORE the first show.
    // If the native input shape cannot be established, fail closed and keep it hidden.
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::WidgetExt;
        let Ok(gtk_win) = w.gtk_window() else { let _ = w.hide(); return };
        gtk_win.realize();
        let Some(gdk) = gtk_win.window() else { let _ = w.hide(); return };
        gdk.input_shape_combine_region(&gtk::cairo::Region::create(), 0, 0);
    }
    let _ = w.set_ignore_cursor_events(true);
    let _ = w.set_position(PhysicalPosition::new(r.x.round() as i32, r.y.round() as i32));
    let _ = w.set_size(tauri::PhysicalSize::new(r.w.round().max(1.0) as u32, r.h.round().max(1.0) as u32));
    let _ = w.show();
}

fn start_highlight(app: &AppHandle, c: &Arc<Character>) {
    let id = c.highlight.fetch_add(1, Ordering::SeqCst) + 1;
    let (app, c) = (app.clone(), c.clone());
    std::thread::spawn(move || {
        let mut last: Option<(f64, f64)> = None;
        let mut scanned = std::time::Instant::now();
        while c.highlight.load(Ordering::SeqCst) == id && !crate::QUITTING.load(Ordering::SeqCst) {
            let at = {
                let inner = c.inner.lock().unwrap_or_else(|e| e.into_inner());
                if inner.drag.is_none() && !inner.carrying { break; }
                inner.pointer
            };
            if let Some(p) = at {
                if last.is_none_or(|q| (p.0 - q.0).hypot(p.1 - q.1) >= 2.0) || scanned.elapsed() >= Duration::from_millis(250) {
                    last = Some(p);
                    scanned = std::time::Instant::now();
                    let rect = if island_rect(&app).is_some_and(|(r, _)| r.contains(p)) { None }
                        else { target_at(&app, p).map(|(_, r)| r) };
                    let (ui, guard) = (app.clone(), c.clone());
                    let _ = app.run_on_main_thread(move || {
                        if guard.highlight.load(Ordering::SeqCst) == id && !crate::QUITTING.load(Ordering::SeqCst) {
                            paint_highlight(&ui, rect);
                        }
                    });
                }
            }
            std::thread::sleep(Duration::from_millis(33));
        }
    });
}

/// The window events handler hands a `Resized` of the character window here: GTK may rebuild the
/// surface and drop the input shape, so the click-through region is applied again.
pub fn on_resized(app: &AppHandle) {
    if let Some(win) = window(app) {
        if win.is_visible().unwrap_or(false) {
            apply_shape(app, &win);
        }
    }
}

fn place(win: &WebviewWindow, c: &Character, pos: (f64, f64)) {
    c.inner.lock().unwrap_or_else(|e| e.into_inner()).pos = pos;
    let _ = win.set_position(PhysicalPosition::new(pos.0.round() as i32, pos.1.round() as i32));
}

/// Moves the window from `from` to `to` over `ms`; false when a newer flight took over.
async fn fly(win: &WebviewWindow, c: &Character, from: (f64, f64), to: (f64, f64), ms: u64, ease: fn(f64) -> f64) -> bool {
    let id = c.flight.fetch_add(1, Ordering::SeqCst) + 1;
    let steps = (ms / cw::TICK_MS).max(1);
    for i in 1..=steps {
        if c.flight.load(Ordering::SeqCst) != id {
            return false;
        }
        place(win, c, cw::lerp(from, to, ease(i as f64 / steps as f64)));
        let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(cw::TICK_MS))).await;
    }
    c.flight.load(Ordering::SeqCst) == id
}

fn remember(app: &AppHandle, on: bool, spot: Option<(f64, f64)>) {
    crate::settingshost::save_desktop_character(app, on, spot.map(cw::spot_to_pref));
}

/// Where the character settles when it flies out: its saved spot if a display still holds it;
/// otherwise the first-visit corner when `anywhere`, else nowhere (it stays in the island).
fn target_spot(app: &AppHandle, anywhere: bool) -> Option<(f64, f64)> {
    let d = displays(app);
    let saved = crate::settingshost::desktop_character(app).and_then(|c| c.spot).map(cw::pref_to_spot);
    if let Some(spot) = saved {
        if let Some(p) = cw::restore_spot(spot, &d, cw::SIZE, cw::MARGIN) {
            return Some(p);
        }
    }
    if saved.is_some() && !anywhere {
        return None;
    }
    let (r, _) = island_rect(app)?;
    let near = d.iter().find(|x| x.frame.contains(r.center())).or(d.first())?;
    Some(cw::default_spot(near, cw::SIZE, cw::MARGIN))
}

#[tauri::command]
pub fn character_info(webview: tauri::Webview, app: AppHandle) -> Option<Info> {
    crate::settingswindow::main_window_only(webview.label()).ok()?;
    let on = crate::settingshost::desktop_character(&app).is_some_and(|c| c.on);
    Some(Info { mode: "window", on_desktop: on })
}

/// Island → desktop: shows the window under the island and flies it to its spot.
#[tauri::command]
pub async fn character_fly_out(webview: tauri::Webview, app: AppHandle, c: State<'_, Arc<Character>>, anywhere: Option<bool>) -> Result<bool, ()> {
    crate::settingswindow::main_window_only(webview.label()).map_err(|_| ())?;
    Ok(fly_out(&app, &c, anywhere.unwrap_or(false)).await)
}

async fn fly_out(app: &AppHandle, c: &Character, anywhere: bool) -> bool {
    let (Some(to), Some(from)) = (target_spot(app, anywhere), island_origin(app)) else { return false };
    let Some(win) = ensure_window(app) else { return false };
    place(&win, c, from);
    let _ = win.show();
    apply_shape(app, &win);
    start_gaze(app, &app.state::<Arc<Character>>().inner().clone());
    if fly(&win, c, from, to, cw::FLIGHT_MS, cw::ease_in_out).await {
        remember(app, true, Some(to));
    }
    true
}

/// Launch: the character goes back to its spot if that is where it lived (Coucou `launchFlyIfNeeded`).
pub fn restore_on_launch(app: &AppHandle) {
    if !crate::settingshost::desktop_character(app).is_some_and(|c| c.on) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let c = app.state::<Arc<Character>>().inner().clone();
        // The island must be placed first; a spot on a display that is gone leaves it home.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        if !fly_out(&app, &c, false).await {
            remember(&app, false, None);
        }
    });
}

/// Desktop → island: flies back under the island and hides. `forget` = it lives in the island again.
#[tauri::command]
pub async fn character_fly_home(webview: tauri::Webview, app: AppHandle, c: State<'_, Arc<Character>>, forget: bool) -> Result<bool, ()> {
    crate::settingswindow::main_window_only(webview.label()).map_err(|_| ())?;
    Ok(go_home(&app, &c, forget).await)
}

async fn go_home(app: &AppHandle, c: &Character, forget: bool) -> bool {
    stop_highlight(app, c);
    {
        let mut inner = c.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.drag = None;
        inner.carrying = false;
    }
    let Some(win) = window(app) else { return true };
    if let Some(to) = island_origin(app) {
        let from = c.inner.lock().unwrap_or_else(|e| e.into_inner()).pos;
        fly(&win, c, from, to, cw::FLIGHT_MS, cw::ease_in_out).await;
    }
    c.gaze.fetch_add(1, Ordering::SeqCst);
    let _ = win.hide();
    if forget {
        remember(app, false, None);
    }
    true
}

// ---- drag, from the character's own page ----

fn from_character(webview: &tauri::Webview) -> bool {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    cw::character_sender_ok(webview.label(), &url).is_ok()
}

#[tauri::command]
pub fn character_drag_begin(webview: tauri::Webview, app: AppHandle, c: State<'_, Arc<Character>>, x: f64, y: f64) -> bool {
    let (true, Some(press)) = (from_character(&webview), cw::valid_point(x, y)) else { return false };
    c.flight.fetch_add(1, Ordering::SeqCst);
    let mut inner = c.inner.lock().unwrap_or_else(|e| e.into_inner());
    let origin = inner.pos;
    inner.drag = Some((press, origin));
    let scale = window(&app).and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
    inner.pointer = Some((press.0 * scale, press.1 * scale));
    drop(inner);
    start_highlight(&app, &c);
    true
}

#[tauri::command]
pub fn character_drag_move(webview: tauri::Webview, app: AppHandle, c: State<'_, Arc<Character>>, x: f64, y: f64) {
    let (true, Some(now)) = (from_character(&webview), cw::valid_point(x, y)) else { return };
    let (Some(win), Some((press, origin))) = (window(&app), c.inner.lock().unwrap_or_else(|e| e.into_inner()).drag) else { return };
    let dpr = win.scale_factor().unwrap_or(1.0);
    c.inner.lock().unwrap_or_else(|e| e.into_inner()).pointer = Some((now.0 * dpr, now.1 * dpr));
    place(&win, &c, cw::drag_top_left(origin, now, press, dpr));
}

/// The button went up: dropped on the island = home; anywhere else it settles inside a work area.
#[tauri::command]
pub async fn character_drag_end(webview: tauri::Webview, app: AppHandle, c: State<'_, Arc<Character>>) -> Result<(), ()> {
    if !from_character(&webview) {
        return Err(());
    }
    let drag = c.inner.lock().unwrap_or_else(|e| e.into_inner()).drag.take();
    stop_highlight(&app, &c);
    if let Some((_, origin)) = drag {
        finish_drop(&app, &c, "desktop", Some(origin)).await;
    }
    Ok(())
}

async fn finish_drop(app: &AppHandle, c: &Character, from: &'static str, origin: Option<(f64, f64)>) {
    stop_highlight(app, c);
    let Some(win) = window(app) else { return };
    let scale = win.scale_factor().unwrap_or(1.0);
    let pos = c.inner.lock().unwrap_or_else(|e| e.into_inner()).pos;
    let half = cw::SIZE * scale / 2.0;
    let at = c.inner.lock().unwrap_or_else(|e| e.into_inner()).pointer.unwrap_or((pos.0 + half, pos.1 + half));
    let home = island_rect(app).is_some_and(|(r, _)| cw::is_home_drop(at, r));
    let target = if home { None } else {
        let host = app.clone();
        tauri::async_runtime::spawn_blocking(move || target_at(&host, at)).await.ok().flatten()
    };
    match cw::drop_outcome(home, target.is_some(), from) {
        cw::DropOutcome::Home => {
            let _ = app.emit_to("main", "desktop-character-dropped", Dropped { from, home: true });
            go_home(app, c, true).await;
            return;
        }
        cw::DropOutcome::AttachAndReturn => {
            let Some((target, _)) = target else { return };
            app.state::<crate::AppState>().chat_context.lock().unwrap_or_else(|e| e.into_inner())
                .attach_dragged(contextwin::format_context(&target));
            let _ = app.emit_to(cw::LABEL, "desktop-character-emote", serde_json::json!({ "emote": "happy" }));
            // Same native intent as --chat; no additional command or page-chosen target.
            let ui = app.clone();
            let _ = app.run_on_main_thread(move || { crate::restore(&ui); crate::open_chat_and_type(&ui); });
            let _ = app.emit_to("main", "desktop-character-dropped", Dropped { from, home: from == "island" });
            if from == "island" { go_home(app, c, true).await; }
            else if let Some(to) = origin { fly(&win, c, pos, to, cw::FLIGHT_MS, cw::ease_in_out).await; }
            // Explicit drop: NEVER overwrite the saved desktop spot.
            return;
        }
        cw::DropOutcome::Install => {
            let _ = app.emit_to("main", "desktop-character-dropped", Dropped { from, home: false });
        }
    }
    let to = cw::settle(pos, &displays(app), cw::SIZE, cw::MARGIN);
    if fly(&win, c, pos, to, cw::SNAP_MS, cw::ease_out_back).await {
        remember(app, true, Some(to));
    }
}

// ---- carried out of the island by the pointer (island page, main only) ----

fn island_point(app: &AppHandle, x: f64, y: f64) -> Option<(f64, f64)> {
    let (x, y) = cw::valid_point(x, y)?;
    let (r, scale) = island_rect(app)?;
    Some(cw::client_to_screen((x, y), (r.x, r.y), scale))
}

#[tauri::command]
pub async fn character_pick_up(webview: tauri::Webview, app: AppHandle, c: State<'_, Arc<Character>>, x: f64, y: f64) -> Result<bool, ()> {
    crate::settingswindow::main_window_only(webview.label()).map_err(|_| ())?;
    if c.inner.lock().unwrap_or_else(|e| e.into_inner()).carrying || window(&app).is_some_and(|w| w.is_visible().unwrap_or(false)) {
        return Ok(false);
    }
    let Some(at) = island_point(&app, x, y) else { return Ok(false) };
    let Some(win) = ensure_window(&app) else { return Ok(false) };
    c.flight.fetch_add(1, Ordering::SeqCst);
    let scale = win.scale_factor().unwrap_or(1.0);
    place(&win, &c, cw::centred_on(at, cw::SIZE, scale));
    {
        let mut inner = c.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.carrying = true;
        inner.pointer = Some(at);
    }
    start_highlight(&app, &c);
    let _ = win.show();
    apply_shape(&app, &win);
    start_gaze(&app, &c);
    Ok(true)
}

#[tauri::command]
pub async fn character_carry(webview: tauri::Webview, app: AppHandle, c: State<'_, Arc<Character>>, x: f64, y: f64) -> Result<(), ()> {
    crate::settingswindow::main_window_only(webview.label()).map_err(|_| ())?;
    if !c.inner.lock().unwrap_or_else(|e| e.into_inner()).carrying {
        return Ok(());
    }
    if let (Some(win), Some(at)) = (window(&app), island_point(&app, x, y)) {
        let scale = win.scale_factor().unwrap_or(1.0);
        c.inner.lock().unwrap_or_else(|e| e.into_inner()).pointer = Some(at);
        place(&win, &c, cw::centred_on(at, cw::SIZE, scale));
    }
    Ok(())
}

#[tauri::command]
pub async fn character_carry_end(webview: tauri::Webview, app: AppHandle, c: State<'_, Arc<Character>>, x: f64, y: f64) -> Result<(), ()> {
    crate::settingswindow::main_window_only(webview.label()).map_err(|_| ())?;
    if !c.inner.lock().unwrap_or_else(|e| e.into_inner()).carrying {
        return Ok(());
    }
    if let (Some(win), Some(at)) = (window(&app), island_point(&app, x, y)) {
        let scale = win.scale_factor().unwrap_or(1.0);
        c.inner.lock().unwrap_or_else(|e| e.into_inner()).pointer = Some(at);
        place(&win, &c, cw::centred_on(at, cw::SIZE, scale));
    }
    c.inner.lock().unwrap_or_else(|e| e.into_inner()).carrying = false;
    finish_drop(&app, &c, "island", None).await;
    Ok(())
}

// ---- gaze: the pointer feeds the eyes ----

/// Global pointer position (X11 root, physical px). Under GNOME/XWayland the server only learns the
/// pointer while it is over an X11 window, so away from those the eyes keep the last position.
#[cfg(not(target_os = "linux"))]
fn pointer() -> Option<(f64, f64)> { None }

#[cfg(target_os = "linux")]
fn pointer() -> Option<(f64, f64)> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::ConnectionExt;
    use x11rb::rust_connection::RustConnection;
    thread_local! { static CONN: std::cell::RefCell<Option<(RustConnection, u32)>> = const { std::cell::RefCell::new(None) }; }
    CONN.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            let (conn, n) = std::panic::catch_unwind(|| RustConnection::connect(None)).ok()?.ok()?;
            let root = conn.setup().roots.get(n)?.root;
            *slot = Some((conn, root));
        }
        let (conn, root) = slot.as_ref()?;
        match conn.query_pointer(*root).ok().and_then(|c| c.reply().ok()) {
            Some(r) => Some((r.root_x as f64, r.root_y as f64)),
            None => {
                *slot = None;
                None
            }
        }
    })
}

#[derive(Serialize, Clone)]
struct Cursor {
    x: f64,
    y: f64,
}

/// Feeds the window's page with the pointer in its own css px, ~30 Hz, only while shown.
fn start_gaze(app: &AppHandle, c: &Arc<Character>) {
    let id = c.gaze.fetch_add(1, Ordering::SeqCst) + 1;
    let (app, c) = (app.clone(), c.clone());
    std::thread::spawn(move || {
        let mut last = None;
        loop {
            let win = window(&app);
            let visible = win.as_ref().is_some_and(|w| w.is_visible().unwrap_or(false));
            if !cw::gaze_should_run(c.gaze.load(Ordering::SeqCst), id, crate::QUITTING.load(Ordering::SeqCst), win.is_some(), visible) {
                break;
            }
            if let (Some(win), Some(p)) = (win, pointer()) {
                if last != Some((p.0 as i64, p.1 as i64)) {
                    last = Some((p.0 as i64, p.1 as i64));
                    let origin = c.inner.lock().unwrap_or_else(|e| e.into_inner()).pos;
                    let (x, y) = cw::cursor_local(p, origin, win.scale_factor().unwrap_or(1.0));
                    let _ = app.emit_to(cw::LABEL, "desktop-character-cursor", Cursor { x, y });
                }
            }
            std::thread::sleep(Duration::from_millis(33));
        }
    });
}

/// Double click on the character: home for good.
#[tauri::command]
pub async fn character_home(webview: tauri::Webview, app: AppHandle, c: State<'_, Arc<Character>>) -> Result<(), ()> {
    if !from_character(&webview) {
        return Err(());
    }
    let _ = app.emit_to("main", "desktop-character-dropped", Dropped { from: "desktop", home: true });
    go_home(&app, &c, true).await;
    Ok(())
}

/// Island → character window: its clay state or one emote. Closed lists; main only.
#[tauri::command]
pub fn character_push(webview: tauri::Webview, app: AppHandle, state: Option<String>, emote: Option<String>) -> Result<(), ()> {
    crate::settingswindow::main_window_only(webview.label()).map_err(|_| ())?;
    if let Some(s) = state.filter(|s| cw::valid_state(s)) {
        let _ = app.emit_to(cw::LABEL, "desktop-character-state", serde_json::json!({ "state": s }));
    }
    if let Some(e) = emote.filter(|e| cw::valid_emote(e)) {
        let _ = app.emit_to(cw::LABEL, "desktop-character-emote", serde_json::json!({ "emote": e }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    /// The GDK input shape can be dropped when GTK re-realizes the surface on a resize: the
    /// window events handler must hand `Resized` of the character window back to this module.
    #[test]
    fn a_resize_of_the_character_window_reapplies_the_click_through_shape() {
        let main = include_str!("main.rs");
        assert!(main.contains("characterhost::on_resized"), "main.rs must route Resized to characterhost::on_resized");
        assert!(include_str!("characterhost.rs").contains("pub fn on_resized"));
    }
}


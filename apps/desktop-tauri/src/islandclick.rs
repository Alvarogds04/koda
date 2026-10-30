//! HU-043: on Windows and macOS the island window ignores the mouse while the cursor is over its transparent area, so a click there reaches
//! the window below; over the drawn shape it takes the click as always. Linux does this with a GDK input region (islandshape::apply) and
//! never starts this poller. The decision is `islandhit::click_through` (pure, tested everywhere); this file only feeds it and applies the
//! verdict. Rules, all deliberate:
//!  * FAIL-OPEN: any unreadable fact (cursor, scale, window, rects) leaves the window clickable, and the poller stopping leaves it clickable.
//!  * Every read of a window runs on the MAIN thread (the getters can deadlock off it: main.rs «WindowFacts»); the poller thread only
//!    sleeps and schedules, and never schedules a second tick while one is pending.
//!  * No `core`/`AppState` lock is held across a window call; the drag flag is a lock-free atomic.
//!  * No polling while the island window is hidden (the cached `HOST_VISIBLE`), and a slow cadence while the cursor is far from the window.
//!  * `set_ignore_cursor_events` is called only when the verdict CHANGES.
// On Linux the click-through poller (islandclick) is not started (Linux uses the GDK input region), so these items are only exercised by tests there.
#![cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(any(windows, target_os = "macos"))]
use std::time::Duration;

/// A drag of the island is in progress (press → release). Set/cleared by `drag_press` / `drag_release`; read lock-free by the poller.
pub(crate) static DRAGGING: AtomicBool = AtomicBool::new(false);
/// One tick is queued on the main thread already: the poller never piles ticks up behind a busy event loop.
static PENDING: AtomicBool = AtomicBool::new(false);

/// Try to claim the single-flight slot. `true` = this caller must run the tick; `false` = one is already pending.
pub(crate) fn claim(pending: &AtomicBool) -> bool { pending.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() }
pub(crate) fn release(pending: &AtomicBool) { pending.store(false, Ordering::SeqCst); }

/// The change-only rule: `Some(new)` when `set_ignore_cursor_events(new)` must be called, `None` when the window already is that way.
pub(crate) fn transition(current: Option<bool>, wanted: bool) -> Option<bool> { if current == Some(wanted) { None } else { Some(wanted) } }

#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn start(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = std::thread::Builder::new().name("island-click".into()).spawn(move || {
        // `None` = never set by us (the window is in Tauri's default, clickable, state)
        let current = std::sync::Arc::new(std::sync::Mutex::new(None::<bool>));
        let mut wait = crate::islandhit::FAR_POLL;
        let next = std::sync::Arc::new(std::sync::Mutex::new(Some(crate::islandhit::FAR_POLL)));
        loop {
            std::thread::sleep(wait);
            if crate::quitting() { restore(&handle, &current); return; }
            if claim(&PENDING) {
                let (h, c, n) = (handle.clone(), current.clone(), next.clone());
                if handle.run_on_main_thread(move || { tick(&h, &c, &n); release(&PENDING); }).is_err() { release(&PENDING); }
            }
            wait = next.lock().map(|n| n.unwrap_or(crate::islandhit::HIDDEN_RECHECK)).unwrap_or(crate::islandhit::FAR_POLL);
        }
    });
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn start(_app: &tauri::AppHandle) {}

/// One look, ON the main thread. Never blocks, never holds a host lock across a window call.
#[cfg(any(windows, target_os = "macos"))]
fn tick(app: &tauri::AppHandle, current: &std::sync::Mutex<Option<bool>>, next: &std::sync::Mutex<Option<Duration>>) {
    use tauri::Manager;
    let set = |win: &tauri::WebviewWindow, ignore: bool| {
        let mut state = current.lock().expect("island click state");
        if let Some(value) = transition(*state, ignore) {
            if win.set_ignore_cursor_events(value).is_ok() { *state = Some(value); }
        }
    };
    let Some(win) = crate::main_window(app) else { return };
    let visible = win.is_visible().unwrap_or(true);
    if !visible {
        // hidden: touch nothing, leave it clickable for when it returns, and do not poll fast
        set(&win, false);
        *next.lock().expect("island click next") = None;
        return;
    }
    let cursor = win.cursor_position().ok().map(|p| (p.x, p.y));
    let (origin, size, scale) = match (win.outer_position(), win.outer_size(), win.scale_factor()) {
        (Ok(p), Ok(s), Ok(f)) => ((p.x, p.y), (s.width as i32, s.height as i32), f),
        _ => { set(&win, false); *next.lock().expect("island click next") = Some(crate::islandhit::FAR_POLL); return; } // fail-open
    };
    *next.lock().expect("island click next") = crate::islandhit::next_poll(true, cursor, (origin.0, origin.1, size.0, size.1));
    let state = app.state::<crate::AppState>();
    let protected = crate::islandshape::is_protected(app, &state);
    let logical_window = ((f64::from(size.0) / scale).round() as i32, (f64::from(size.1) / scale).round() as i32);
    let rects = crate::islandshape::current_rects(logical_window, protected);
    let point = cursor.and_then(|c| crate::islandhit::cursor_in_window(c, origin, scale));
    let ignore = crate::islandhit::click_through(point, &rects, protected, DRAGGING.load(Ordering::SeqCst), visible);
    set(&win, ignore);
}

/// Back to the default, clickable state (quit or the poller ending): the window must never be left ignoring the mouse.
#[cfg(any(windows, target_os = "macos"))]
fn restore(app: &tauri::AppHandle, current: &std::sync::Mutex<Option<bool>>) {
    let handle = app.clone();
    let state = current.lock().map(|s| *s).unwrap_or(None);
    if state == Some(true) {
        let _ = app.run_on_main_thread(move || { if let Some(win) = crate::main_window(&handle) { let _ = win.set_ignore_cursor_events(false); } });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_one_tick_is_ever_pending() {
        let flag = AtomicBool::new(false);
        assert!(claim(&flag), "the first caller runs the tick");
        for _ in 0..50 { assert!(!claim(&flag), "while one is pending nobody else queues another"); }
        release(&flag);
        assert!(claim(&flag), "after it finished the next one can run");
    }
    #[test]
    fn the_window_is_only_touched_when_the_verdict_changes() {
        assert_eq!(transition(None, false), Some(false), "first look: set it (it may have been left ignoring by a previous run)");
        assert_eq!(transition(None, true), Some(true));
        assert_eq!(transition(Some(false), false), None);
        assert_eq!(transition(Some(true), true), None);
        assert_eq!(transition(Some(false), true), Some(true));
        assert_eq!(transition(Some(true), false), Some(false));
    }
    #[test]
    fn a_drag_in_progress_is_a_lock_free_flag() {
        DRAGGING.store(true, Ordering::SeqCst);
        assert!(DRAGGING.load(Ordering::SeqCst));
        DRAGGING.store(false, Ordering::SeqCst);
        assert!(!DRAGGING.load(Ordering::SeqCst));
    }
}

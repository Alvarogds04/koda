//! GTK 3.24: explicit logical widget requests suppress NO_CONTENT_CHILD_NAT
//! (200), which otherwise becomes fixed-window WM hints with an empty child.
#[cfg(target_os = "linux")]
use gtk::prelude::*;
#[cfg(target_os = "linux")]
use std::sync::atomic::Ordering;
#[cfg(target_os = "linux")]
use tauri::Manager;
use tauri::WebviewWindow;

pub(crate) fn logical_size(w: i32, h: i32, scale: f64) -> Result<(i32, i32), &'static str> {
    if w <= 0 || h <= 0 || !scale.is_finite() || scale <= 0.0 {
        return Err("invalid physical size or scale");
    }
    let convert = |value: i32| {
        let value = (f64::from(value) / scale).round();
        if !(1.0..=f64::from(i32::MAX)).contains(&value) {
            Err("logical size out of range")
        } else {
            Ok(value as i32)
        }
    };
    Ok((convert(w)?, convert(h)?))
}

#[cfg(target_os = "linux")]
pub(crate) fn defer(task: impl FnOnce() + Send + 'static) {
    gtk::glib::idle_add_once(task);
}

/// run_on_main_thread may inline; installing an idle source does NOT dispatch
/// it. GTK handles are obtained only in that later default GUI-context turn,
/// after compact admission guards have returned. No synthetic resize ACK.
#[cfg(target_os = "linux")]
pub(crate) fn set_size(win: &WebviewWindow, w: i32, h: i32) -> tauri::Result<()> {
    let generation = win
        .state::<super::AppState>()
        .generation
        .load(Ordering::SeqCst);
    #[cfg(any(debug_assertions, feature = "probe"))]
    crate::probe::mark(format!("native set_size {w}x{h} requested"));
    let window = win.clone();
    win.run_on_main_thread(move || {
        defer(move || {
            assert!(gtk::glib::MainContext::default().is_owner());
            if window
                .state::<super::AppState>()
                .generation
                .load(Ordering::SeqCst)
                != generation
            {
                return; // a newer plan owns the window; native recovery remains event-based
            }
            #[cfg(any(debug_assertions, feature = "probe"))]
            crate::probe::mark(format!("native set_size {w}x{h} applied"));
            let apply = || -> Result<(), String> {
                let scale = window.scale_factor().map_err(|e| e.to_string())?;
                let (lw, lh) = logical_size(w, h, scale).map_err(str::to_string)?;
                let gtk = window.gtk_window().map_err(|e| e.to_string())?;
                gtk.set_size_request(lw, lh); // fixed main-window minimum, in logical pixels
                window
                    .set_size(tauri::PhysicalSize::new(w as u32, h as u32))
                    .map_err(|e| e.to_string())
            };
            if let Err(error) = apply() {
                // A failed request is not completion; retain the visible error
                // rather than claiming the fixed geometry was applied.
                eprintln!("native size({w},{h}) failed: {error}");
            }
        })
    })
}

/// D3: Windows uses a real plain resize; the GTK logical hint only suppresses
/// GTK's empty-child WM-hint bug and has no equivalent role on this target.
/// U2 validates this direct resize in the Windows VM.
#[cfg(not(target_os = "linux"))]
pub(crate) fn set_size(win: &WebviewWindow, w: i32, h: i32) -> tauri::Result<()> {
    win.set_size(tauri::PhysicalSize::new(w as u32, h as u32))
}

/// Debug fixture actuation, not a human/isTrusted claim or public command.
/// Only normal IPC view verbs: no geometry overrides, answers, sends or focus.
#[cfg(debug_assertions)]
pub(crate) fn start_view_test(win: &WebviewWindow) {
    if std::env::var("ABITO_NATIVE_VIEW_TEST").as_deref() != Ok("1") {
        return;
    }
    let window = win.clone();
    std::thread::spawn(move || {
        for (command, action) in [
            ("desktop_action", "expand"),
            ("chat_action", "open"),
            ("chat_action", "back"),
            ("desktop_action", "close"),
        ] {
            std::thread::sleep(std::time::Duration::from_secs(3));
            if let Err(error) = window.eval(format!(
                "void window.__TAURI__.core.invoke('{command}',{{payload:{{action:'{action}'}}}});"
            )) {
                eprintln!("native view fixture enqueue failed: {error}");
                return;
            }
        }
    });
}

#[cfg(all(test, target_os = "linux"))]
#[path = "nativewindow_tests.rs"]
mod tests;

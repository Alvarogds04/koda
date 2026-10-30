//! Opt-in, read-only native geometry evidence. No commands or resize authority.
use gtk::prelude::*;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub(crate) fn enabled() -> bool {
    std::env::var("ABITO_NATIVE_AUDIT").as_deref() == Ok("1")
}

pub(crate) fn expected(_view: &str, scale: f64, _area_h: i32) -> (i32, i32) {
    use abito_island::geometry;
    geometry::scaled_size(geometry::ISLAND_WINDOW, scale)
}

fn widgets(widget: &gtk::Widget, depth: usize, out: &mut Vec<Value>) {
    if depth > 5 || out.len() >= 24 {
        return;
    }
    let a = widget.allocation();
    let (min, natural) = widget.preferred_size();
    let (hm, hn) = widget.preferred_height_for_width(a.width());
    out.push(json!({
        "class": widget.type_().name(), "depth": depth,
        "scale": widget.scale_factor(), "request": widget.size_request(),
        "allocation": [a.x(), a.y(), a.width(), a.height()],
        "minimum": [min.width, min.height],
        "natural": [natural.width, natural.height],
        "height_for_width": [hm, hn],
        "visible": widget.is_visible(), "mapped": widget.is_mapped()
    }));
    if let Some(container) = widget.downcast_ref::<gtk::Container>() {
        for child in container.children() {
            widgets(&child, depth + 1, out);
        }
    }
}

fn hints(id: u32) -> Option<Vec<u32>> {
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};
    let (conn, _) = x11rb::connect(None).ok()?;
    let atom = conn
        .intern_atom(false, b"WM_NORMAL_HINTS")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let reply = conn
        .get_property(false, id, atom, AtomEnum::ANY, 0, 32)
        .ok()?
        .reply()
        .ok()?;
    let values = reply.value32()?.collect();
    Some(values)
}

/// Enqueue GTK getters on the main thread. Callers never wait or carry host
/// guards into this closure; each host lock below is acquired separately.
pub(crate) fn sample(
    app: &AppHandle,
    stage: &'static str,
    attempt: u32,
    desired: Option<(i32, i32)>,
) {
    if !enabled() {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(win) = super::main_window(&handle) else { return };
        let state = handle.state::<super::AppState>();
        let view = {
            let core = state.core.lock().expect("core lock");
            if !core.expanded { "compact" } else if core.chat { "chat" } else { "overview" }
        };
        let requested = {
            let req = state.requested.lock().expect("requested lock");
            (req.pos, req.size)
        };
        let socket_identity = {
            use std::os::unix::fs::MetadataExt;
            let transport = state.transport.lock().expect("transport lock");
            transport.as_ref().and_then(|t| std::fs::symlink_metadata(t.endpoint()).ok())
                .map(|m| [m.dev(), m.ino()])
        };
        let scale = win.scale_factor().ok();
        let gtk = win.gtk_window().expect("GTK window on main thread");
        let mut tree = Vec::new();
        widgets(gtk.upcast_ref(), 0, &mut tree);
        let wa = abito_island::workarea::current(&win);
        let rect = |r: abito_island::geometry::Rect| [r.x, r.y, r.w, r.h];
        let own = abito_island::workarea::x11_find_own_window(abito_island::workarea::WINDOW_TITLE).ok();
        let row = json!({
            "pid": std::process::id(), "time_ms": super::now_ms(),
            "stage": stage, "attempt": attempt, "view": view,
            "generation": state.generation.load(std::sync::atomic::Ordering::SeqCst),
            "user_touch": state.user_touch.load(std::sync::atomic::Ordering::SeqCst),
            "initial_pin": state.initial_pin.load(std::sync::atomic::Ordering::SeqCst),
            "socket_identity": socket_identity,
            "tauri_scale": scale, "gtk_scale": gtk.scale_factor(),
            "xft_dpi_1024": gtk::Settings::default().map(|s| s.property::<i32>("gtk-xft-dpi")),
            "expected": scale.map(|s| expected(view, s, wa.rect.h)), "desired": desired,
            "requested_position": requested.0, "requested_size": requested.1,
            "tauri_inner": win.inner_size().ok().map(|s| [s.width, s.height]),
            "tauri_outer": win.outer_size().ok().map(|s| [s.width, s.height]),
            "tauri_position": win.outer_position().ok().map(|p| [p.x, p.y]),
            "gtk_size": gtk.size(), "gtk_default": gtk.default_size(),
            "gtk_position": gtk.position(), "resizable": gtk.is_resizable(),
            "workarea": rect(wa.rect), "root_workarea": wa.x11.map(rect),
            "monitor": wa.monitor.map(rect),
            "x11": own.as_ref().map(|x| [x.id as i64, x.x as i64, x.y as i64, x.w as i64, x.h as i64]),
            "normal_hints": own.as_ref().and_then(|x| hints(x.id)), "widgets": tree
        });
        eprintln!("ABITO_NATIVE_AUDIT {row}");
    });
}

#[cfg(test)]
#[path = "nativeaudit_tests.rs"]
mod tests;

//! Linux X11 backend (S8): choose the topmost window that is not Koda's, capture it by id.
//!
//! The window's own pixels come from `composite::NameWindowPixmap` when a compositor redirects
//! it (covered parts are right); otherwise `GetImage` on the window (covered parts may be wrong).
use super::image::Raw;
use super::mcp::{CaptureError, Target};
use crate::contextwin::{is_abito, Candidate};
use x11rb::connection::Connection;
use x11rb::protocol::composite::ConnectionExt as _;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, ImageFormat, MapState};
use x11rb::rust_connection::RustConnection;

fn intern(conn: &RustConnection, name: &[u8]) -> Option<u32> {
    conn.intern_atom(false, name).ok()?.reply().ok().map(|r| r.atom)
}

fn prop(conn: &RustConnection, window: u32, atom: u32, ty: u32) -> Vec<u8> {
    conn.get_property(false, window, atom, ty, 0, u32::MAX).ok().and_then(|c| c.reply().ok()).map(|r| r.value).unwrap_or_default()
}

fn connect(display: Option<&str>) -> Result<(RustConnection, usize), CaptureError> {
    let owned = display.map(str::to_owned);
    std::panic::catch_unwind(move || RustConnection::connect(owned.as_deref()))
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| CaptureError::Unsupported("the X11 display is not reachable".into()))
}

/// The topmost visible window that is not Koda's, with its X id.
pub fn pick(display: Option<&str>) -> Result<Target, CaptureError> {
    let (conn, screen) = connect(display)?;
    let root = conn.setup().roots[screen].root;
    let none = || CaptureError::NoWindow;
    let list = intern(&conn, b"_NET_CLIENT_LIST_STACKING").ok_or_else(none)?;
    let ids: Vec<u32> = conn
        .get_property(false, root, list, AtomEnum::WINDOW, 0, u32::MAX)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| r.value32().map(|v| v.collect()))
        .unwrap_or_default();
    let (utf8, net_name) = (intern(&conn, b"UTF8_STRING"), intern(&conn, b"_NET_WM_NAME"));
    let (state, hidden, skip) = (
        intern(&conn, b"_NET_WM_STATE"),
        intern(&conn, b"_NET_WM_STATE_HIDDEN"),
        intern(&conn, b"_NET_WM_STATE_SKIP_TASKBAR"),
    );
    for id in ids.into_iter().rev() {
        let Some(attrs) = conn.get_window_attributes(id).ok().and_then(|c| c.reply().ok()) else { continue };
        if attrs.map_state != MapState::VIEWABLE {
            continue;
        }
        if let (Some(state), Some(hidden), Some(skip)) = (state, hidden, skip) {
            let states = prop(&conn, id, state, AtomEnum::ATOM.into());
            if states.chunks_exact(4).any(|b| {
                let a = u32::from_ne_bytes([b[0], b[1], b[2], b[3]]);
                a == hidden || a == skip
            }) {
                continue;
            }
        }
        let class = prop(&conn, id, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into());
        let mut parts = class.split(|b| *b == 0);
        let instance = String::from_utf8_lossy(parts.next().unwrap_or(&[])).into_owned();
        let class = String::from_utf8_lossy(parts.next().unwrap_or(&[])).into_owned();
        let mut title = Vec::new();
        if let (Some(u), Some(n)) = (utf8, net_name) {
            title = prop(&conn, id, n, u);
        }
        if title.is_empty() {
            title = prop(&conn, id, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into());
        }
        let app = if class.is_empty() { instance.clone() } else { class.clone() };
        let candidate = Candidate { app_id: format!("{instance} {class}"), app_name: app.clone(), title: String::new() };
        if is_abito(&candidate) || app.trim().is_empty() {
            continue;
        }
        return Ok(Target { app_id: candidate.app_id, app, title: String::from_utf8_lossy(&title).into_owned(), handle: id as u64 });
    }
    Err(CaptureError::NoWindow)
}

/// The window's pixels, by id.
pub fn capture(display: Option<&str>, handle: u64) -> Result<Raw, CaptureError> {
    let (conn, _) = connect(display)?;
    let id = handle as u32;
    let failed = |why: &str| CaptureError::Failed(why.to_string());
    let geometry = conn.get_geometry(id).ok().and_then(|c| c.reply().ok()).ok_or_else(|| failed("the window is gone"))?;
    // Composite: the window's own pixmap, right even when covered. Absent or not redirected: plain GetImage.
    let pixmap = (|| {
        conn.composite_query_version(0, 4).ok()?.reply().ok()?;
        let pixmap = conn.generate_id().ok()?;
        conn.composite_name_window_pixmap(id, pixmap).ok()?.check().ok()?;
        Some(pixmap)
    })();
    let drawable = pixmap.unwrap_or(id);
    let reply = conn
        .get_image(ImageFormat::Z_PIXMAP, drawable, 0, 0, geometry.width, geometry.height, u32::MAX)
        .ok()
        .and_then(|c| c.reply().ok());
    let reply = match (reply, pixmap) {
        (Some(r), _) => r,
        (None, Some(_)) => conn
            .get_image(ImageFormat::Z_PIXMAP, id, 0, 0, geometry.width, geometry.height, u32::MAX)
            .ok()
            .and_then(|c| c.reply().ok())
            .ok_or_else(|| failed("the window could not be read"))?,
        (None, None) => return Err(failed("the window could not be read")),
    };
    if reply.depth != 24 && reply.depth != 32 {
        return Err(CaptureError::Unsupported(format!("the window has a {}-bit screen depth", reply.depth)));
    }
    // 24/32-bit ZPixmap on the usual little-endian visuals is B,G,R,X.
    Ok(Raw { width: geometry.width as u32, height: geometry.height as u32, bgra: true, data: reply.data })
}

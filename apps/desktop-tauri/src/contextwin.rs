//! Active-window context (#487, NotchBuddy feature 8).
//!
//! Adapted from Coucou NotchBuddy/Sources/App/WindowContextCapture.swift @71b773f,
//! Copyright (c) 2026 Louis Raillé, MIT. Rewritten for Linux: no browser URL in v1 (#483 S3).
//!
//! NotchBuddy attaches `Context — App: <app>, Window: <title>` to the FIRST chat message,
//! taken from the last app that was active before the island (`lastExternalApp`). The island
//! is itself the focused window when the chat opens, so the reader returns the most recent
//! window that is NOT Abito.
//!
//! Sources, best first:
//! 1. Abito's own GNOME Shell extension (`gnome-extension/abito-context@abito`) on the session
//!    bus: `org.abito.Context.GetRecentWindows() -> a(sss)` (app id, app name, title), most
//!    recent first.
//! 2. X11/EWMH (`_NET_CLIENT_LIST_STACKING`, topmost first) over the existing x11rb; on GNOME
//!    Wayland this only sees XWayland windows, never guessed.
//!
//! Automatic capture runs only on chat open with the switch on. Explicit character drags use
//! a separate point query, including while the switch is off. No browser URL or page-chosen window.
use std::time::Duration;
use crate::characterwin::Rect;

// Adapted from Coucou NotchBuddy/Sources/App/IslandWindowController.swift @71b773f, Copyright (c) 2026 Louis Raillé, MIT.
/// Topmost-first hit test. The input and rectangles must use the same coordinate space.
pub fn topmost_at(point: (f64, f64), rows: &[(Candidate, Rect)]) -> Option<(ActiveWindow, Rect)> {
    rows.iter().find_map(|(c, r)| {
        if !r.contains(point) { return None; }
        pick_external(std::slice::from_ref(c)).map(|w| (w, *r))
    })
}

pub const POINT_METHOD: &str = "GetWindowAt";
type PointRow = (String, String, String, i32, i32, i32, i32);

fn point_rows(rows: Vec<PointRow>) -> Vec<(Candidate, Rect)> {
    rows.into_iter().map(|(app_id, app_name, title, x, y, w, h)| (
        Candidate { app_id, app_name, title },
        Rect { x: x as f64, y: y as f64, w: w as f64, h: h as f64 },
    )).collect()
}

/// A window as either source reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub app_id: String,
    pub app_name: String,
    pub title: String,
}

/// What the chat attaches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveWindow {
    pub app: String,
    pub title: String,
}

pub const BUS_NAME: &str = "org.abito.Context";
pub const OBJECT_PATH: &str = "/org/abito/Context";
pub const INTERFACE: &str = "org.abito.Context";
pub const METHOD: &str = "GetRecentWindows";
/// The extension answers from memory; anything slower is treated as absent.
pub const DBUS_DEADLINE: Duration = Duration::from_millis(800);

/// True for Abito's own windows (app id `com.abitog.AbitoTauri`, WM_CLASS, desktop file).
pub fn is_abito(c: &Candidate) -> bool {
    c.app_id.to_lowercase().contains("abito") || c.app_name.to_lowercase().contains("abito")
}

/// Longest app name / window title sent to the model, in characters, on every OS: a title can be a
/// whole document name or a page of text, and it leaves the machine.
pub const MAX_CONTEXT_CHARS: usize = 200;

fn capped(text: &str) -> String {
    text.trim().chars().take(MAX_CONTEXT_CHARS).collect()
}

/// Most recent window that is not Abito and has an app name (NotchBuddy: `guard let appName`).
pub fn pick_external(recent: &[Candidate]) -> Option<ActiveWindow> {
    recent
        .iter()
        .find(|c| !is_abito(c) && !c.app_name.trim().is_empty())
        .map(|c| ActiveWindow { app: capped(&c.app_name), title: capped(&c.title) })
}

/// The exact text NotchBuddy sends to the model (ClaudeService.swift: first message only).
pub fn format_context(w: &ActiveWindow) -> String {
    format!("Context — App: {}, Window: {}", w.app, w.title)
}

/// Build candidates from the extension's `a(sss)` reply.
pub fn from_reply(rows: Vec<(String, String, String)>) -> Vec<Candidate> {
    rows.into_iter().map(|(app_id, app_name, title)| Candidate { app_id, app_name, title }).collect()
}

/// A top-level window as Windows/macOS report it (stacking order, topmost first).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeWindow {
    pub pid: u32,
    pub app: String,
    pub title: String,
}

/// App name when the OS refuses to reveal the process (elevated/protected): the title still goes.
pub const UNKNOWN_APP: &str = "unknown app";

fn is_shell_desktop(w: &NativeWindow) -> bool {
    w.app.eq_ignore_ascii_case("explorer") && w.title.trim() == "Program Manager"
}

/// Windows: windows with a title only; drops our own process and the shell desktop.
pub fn from_native(own_pid: u32, rows: Vec<NativeWindow>) -> Vec<Candidate> {
    rows.into_iter()
        .filter(|w| w.pid != own_pid && !w.title.trim().is_empty() && !is_shell_desktop(w))
        .map(|w| {
            let app_name = if w.app.trim().is_empty() { UNKNOWN_APP.to_string() } else { w.app };
            Candidate { app_id: format!("{} {}", w.pid, app_name), app_name, title: w.title }
        })
        .collect()
}

/// macOS: the app name needs no permission, the title does; keep the app when the title is empty.
pub fn from_native_app_only(own_pid: u32, rows: Vec<NativeWindow>) -> Vec<Candidate> {
    rows.into_iter()
        .filter(|w| w.pid != own_pid && !w.app.trim().is_empty())
        .map(|w| Candidate { app_id: format!("{} {}", w.pid, w.app), app_name: w.app, title: w.title })
        .collect()
}

/// Build candidates from X data: `(instance, class, title)` per window, TOPMOST LAST
/// (the EWMH stacking order); returned most recent first.
pub fn from_stacking(windows: Vec<(String, String, String)>) -> Vec<Candidate> {
    windows
        .into_iter()
        .rev()
        .map(|(instance, class, title)| {
            let app_name = if class.is_empty() { instance.clone() } else { class.clone() };
            Candidate { app_id: format!("{instance} {class}"), app_name, title }
        })
        .collect()
}

#[cfg(target_os = "linux")]
pub mod dbus {
    use super::*;
    use zbus::blocking::{Connection, Proxy};

    fn connect(bus_address: Option<&str>) -> zbus::Result<Connection> {
        match bus_address {
            Some(addr) => zbus::blocking::connection::Builder::address(addr)?.build(),
            None => Connection::session(),
        }
    }

    /// Presence only: never activate the extension or ask for any window data.
    pub fn available(bus_address: Option<&str>) -> bool {
        let addr = bus_address.map(str::to_owned);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let answer = (|| -> Option<bool> {
                let conn = connect(addr.as_deref()).ok()?;
                let bus = zbus::blocking::fdo::DBusProxy::new(&conn).ok()?;
                bus.name_has_owner(zbus::names::BusName::try_from(BUS_NAME).ok()?).ok()
            })().unwrap_or(false);
            let _ = tx.send(answer);
        });
        rx.recv_timeout(DBUS_DEADLINE).unwrap_or(false)
    }

    fn ask(bus_address: Option<&str>) -> Option<Vec<Candidate>> {
        let conn = connect(bus_address).ok()?;
        // Only call a bus name somebody owns: never trigger activation of anything.
        let dbus = zbus::blocking::fdo::DBusProxy::new(&conn).ok()?;
        let name = zbus::names::BusName::try_from(BUS_NAME).ok()?;
        if !dbus.name_has_owner(name).ok()? {
            return None;
        }
        let proxy = Proxy::new(&conn, BUS_NAME, OBJECT_PATH, INTERFACE).ok()?;
        let rows: Vec<(String, String, String)> = proxy.call(METHOD, &()).ok()?;
        Some(from_reply(rows))
    }

    /// An empty reply is authoritative (no visible target); None permits the X11 fallback.
    pub fn window_at(point: (i32, i32)) -> Option<Vec<(Candidate, Rect)>> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let answer = (|| {
                let conn = connect(None).ok()?;
                let bus = zbus::blocking::fdo::DBusProxy::new(&conn).ok()?;
                if !bus.name_has_owner(zbus::names::BusName::try_from(BUS_NAME).ok()?).ok()? { return None; }
                let proxy = Proxy::new(&conn, BUS_NAME, OBJECT_PATH, INTERFACE).ok()?;
                let rows: Vec<PointRow> = proxy.call(POINT_METHOD, &point).ok()?;
                (rows.len() <= 1).then(|| point_rows(rows))
            })();
            let _ = tx.send(answer);
        });
        rx.recv_timeout(DBUS_DEADLINE).ok().flatten()
    }

    /// Recent windows from the extension; `None` when it is absent, slow or malformed.
    /// `bus_address` None = the user's session bus; Some(addr) = a private bus (tests).
    pub fn recent_windows(bus_address: Option<&str>) -> Option<Vec<Candidate>> {
        let addr = bus_address.map(str::to_owned);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(ask(addr.as_deref()));
        });
        rx.recv_timeout(DBUS_DEADLINE).ok().flatten()
    }
}

#[cfg(target_os = "linux")]
pub mod x11 {
    use super::*;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};
    use x11rb::rust_connection::RustConnection;

    fn intern(conn: &RustConnection, name: &[u8]) -> Option<u32> {
        conn.intern_atom(false, name).ok()?.reply().ok().map(|r| r.atom)
    }

    fn prop(conn: &RustConnection, window: u32, atom: u32, ty: u32) -> Vec<u8> {
        conn.get_property(false, window, atom, ty, 0, u32::MAX)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| r.value)
            .unwrap_or_default()
    }

    fn text(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).into_owned()
    }

    /// Visible EWMH clients, topmost first, with root-relative physical geometry.
    pub fn windows_with_rects() -> Option<Vec<(Candidate, Rect)>> {
        use x11rb::protocol::xproto::MapState;
        let (conn, screen) = std::panic::catch_unwind(|| RustConnection::connect(None)).ok()?.ok()?;
        let root = conn.setup().roots[screen].root;
        let list = intern(&conn, b"_NET_CLIENT_LIST_STACKING")?;
        let ids: Vec<u32> = conn.get_property(false, root, list, AtomEnum::WINDOW, 0, u32::MAX)
            .ok()?.reply().ok()?.value32()?.collect();
        let utf8 = intern(&conn, b"UTF8_STRING")?;
        let name = intern(&conn, b"_NET_WM_NAME")?;
        let state = intern(&conn, b"_NET_WM_STATE")?;
        let hidden = intern(&conn, b"_NET_WM_STATE_HIDDEN")?;
        let skip = intern(&conn, b"_NET_WM_STATE_SKIP_TASKBAR")?;
        let mut rows = Vec::new();
        for id in ids.into_iter().rev() {
            let Some(attrs) = conn.get_window_attributes(id).ok().and_then(|c| c.reply().ok()) else { continue };
            if attrs.map_state != MapState::VIEWABLE { continue; }
            let states = prop(&conn, id, state, AtomEnum::ATOM.into());
            if states.chunks_exact(4).any(|b| {
                let a = u32::from_ne_bytes([b[0], b[1], b[2], b[3]]);
                a == hidden || a == skip
            }) { continue; }
            let Some(g) = conn.get_geometry(id).ok().and_then(|c| c.reply().ok()) else { continue };
            let Some(p) = conn.translate_coordinates(id, root, 0, 0).ok().and_then(|c| c.reply().ok()) else { continue };
            let class = prop(&conn, id, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into());
            let mut parts = class.split(|b| *b == 0);
            let instance = text(parts.next().unwrap_or(&[]));
            let class = text(parts.next().unwrap_or(&[]));
            let mut title = prop(&conn, id, name, utf8);
            if title.is_empty() { title = prop(&conn, id, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()); }
            let mut candidates = from_stacking(vec![(instance, class, text(&title))]);
            rows.push((candidates.remove(0), Rect { x: p.dst_x as f64, y: p.dst_y as f64, w: g.width as f64, h: g.height as f64 }));
        }
        Some(rows)
    }

    /// Windows of the display, most recent (topmost) first. `None` when X is unreachable.
    pub fn recent_windows(display: Option<&str>) -> Option<Vec<Candidate>> {
        let owned = display.map(str::to_owned);
        let (conn, screen) = std::panic::catch_unwind(move || RustConnection::connect(owned.as_deref()))
            .ok()?
            .ok()?;
        let root = conn.setup().roots[screen].root;
        let list_atom = intern(&conn, b"_NET_CLIENT_LIST_STACKING")?;
        let ids: Vec<u32> = conn
            .get_property(false, root, list_atom, AtomEnum::WINDOW, 0, u32::MAX)
            .ok()?
            .reply()
            .ok()?
            .value32()
            .map(|it| it.collect())
            .unwrap_or_default();
        let utf8 = intern(&conn, b"UTF8_STRING")?;
        let net_name = intern(&conn, b"_NET_WM_NAME")?;
        let rows = ids
            .into_iter()
            .map(|id| {
                let class = prop(&conn, id, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into());
                let mut parts = class.split(|b| *b == 0);
                let instance = text(parts.next().unwrap_or(&[]));
                let class = text(parts.next().unwrap_or(&[]));
                let mut title = prop(&conn, id, net_name, utf8);
                if title.is_empty() {
                    title = prop(&conn, id, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into());
                }
                (instance, class, text(&title))
            })
            .collect();
        Some(from_stacking(rows))
    }
}

/// Windows (HU-050): top-level windows in z-order, topmost first, via EnumWindows. A process
/// the OS will not describe (elevated, protected) gets no app name, never an error.
#[cfg(windows)]
mod native {
    use super::{from_native, Candidate, NativeWindow};
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    fn title(hwnd: HWND) -> String {
        let mut buf = [0u16; 512];
        // SAFETY: the buffer outlives the call and its length is passed.
        let n = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    /// The executable's file stem ("chrome"), or empty when the process cannot be opened.
    fn app_name(pid: u32) -> String {
        // SAFETY: a failed OpenProcess (null) is handled; the handle is closed on every path.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() { return String::new(); }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(process);
            if ok == 0 { return String::new(); }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
        }
    }

    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> i32 {
        // SAFETY: lparam is the `&mut Vec` passed by `recent_windows` for this synchronous call.
        let out = &mut *(lparam as *mut Vec<NativeWindow>);
        if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 { return 1; }
        if (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW != 0 { return 1; }
        let mut cloaked = 0u32;
        let hr = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED as u32, &mut cloaked as *mut u32 as *mut _, 4);
        if hr == 0 && cloaked != 0 { return 1; }
        let text = title(hwnd);
        if text.trim().is_empty() { return 1; }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        out.push(NativeWindow { pid, app: app_name(pid), title: text });
        1
    }

    pub fn recent_windows() -> Option<Vec<Candidate>> {
        let mut rows: Vec<NativeWindow> = Vec::new();
        // SAFETY: EnumWindows is synchronous; `rows` outlives it.
        let ok = unsafe { EnumWindows(Some(each), &mut rows as *mut Vec<NativeWindow> as LPARAM) };
        if ok == 0 { return None; }
        Some(from_native(std::process::id(), rows))
    }

    /// Titles need no extra permission here.
    pub fn titles_allowed() -> bool { true }
}

/// macOS (HU-050): CGWindowList in stacking order. The owner (app) name needs no permission;
/// the window title is only filled in once the human has granted Screen Recording, which is
/// only ever READ (preflight), never requested.
#[cfg(target_os = "macos")]
mod native {
    use super::{from_native_app_only, Candidate, NativeWindow};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::access::ScreenCaptureAccess;
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly, kCGWindowName, kCGWindowOwnerName, kCGWindowOwnerPID,
    };

    fn text(d: &CFDictionary<CFString, CFType>, key: CFStringRef) -> Option<String> {
        // SAFETY: the CG key constants are valid static CFStrings.
        let key = unsafe { CFString::wrap_under_get_rule(key) };
        d.find(&key)?.downcast::<CFString>().map(|s| s.to_string())
    }

    fn number(d: &CFDictionary<CFString, CFType>, key: CFStringRef) -> Option<i64> {
        // SAFETY: as above.
        let key = unsafe { CFString::wrap_under_get_rule(key) };
        d.find(&key)?.downcast::<CFNumber>().and_then(|n| n.to_i64())
    }

    pub fn titles_allowed() -> bool { ScreenCaptureAccess.preflight() }

    pub fn recent_windows() -> Option<Vec<Candidate>> {
        let list = copy_window_info(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)?;
        let allowed = titles_allowed();
        let mut rows = Vec::new();
        for item in list.iter() {
            // SAFETY: CGWindowListCopyWindowInfo returns an array of CFDictionary.
            let d: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };
            // Layer 0 = ordinary app windows (menu bar, Dock and overlays live on other layers).
            // SAFETY (all three keys): static CoreGraphics constants.
            if number(&d, unsafe { kCGWindowLayer }) != Some(0) { continue; }
            let Some(app) = text(&d, unsafe { kCGWindowOwnerName }) else { continue };
            let pid = number(&d, unsafe { kCGWindowOwnerPID }).unwrap_or(0) as u32;
            let title = if allowed { text(&d, unsafe { kCGWindowName }).unwrap_or_default() } else { String::new() };
            rows.push(NativeWindow { pid, app, title });
        }
        Some(from_native_app_only(std::process::id(), rows))
    }
}

/// Whether window TITLES can be read on this OS right now (always true off macOS).
#[cfg(not(target_os = "linux"))]
pub fn titles_allowed() -> bool { native::titles_allowed() }

/// The context to attach, or `None`. Windows/macOS read the native stacking order.
#[cfg(not(target_os = "linux"))]
pub fn capture(_bus_address: Option<&str>, _display: Option<&str>) -> Option<ActiveWindow> {
    native::recent_windows().as_deref().and_then(pick_external)
}

#[cfg(not(target_os = "linux"))]
pub fn capture_at(_point: (f64, f64), _scale: f64) -> Option<(ActiveWindow, Rect)> { None }

#[cfg(target_os = "linux")]
pub fn capture(bus_address: Option<&str>, display: Option<&str>) -> Option<ActiveWindow> {
    if let Some(found) = dbus::recent_windows(bus_address).as_deref().and_then(pick_external) {
        return Some(found);
    }
    x11::recent_windows(display).as_deref().and_then(pick_external)
}

/// Explicit drag capture: physical pointer -> GNOME stage logical px using the display under it.
/// Extension geometry is converted back to physical for the input-free highlight window.
#[cfg(target_os = "linux")]
pub fn capture_at(point: (f64, f64), scale: f64) -> Option<(ActiveWindow, Rect)> {
    let k = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let logical = ((point.0 / k).floor(), (point.1 / k).floor());
    if let Some(rows) = dbus::window_at((logical.0 as i32, logical.1 as i32)) {
        return topmost_at(logical, &rows).map(|(w, r)| (w, Rect { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k }));
    }
    topmost_at(point, &x11::windows_with_rects()?)
}

/// The chat's attach point (NotchBuddy `promptContext`): captured once when the chat opens and
/// nothing is held; offered ONLY for the first message of a conversation (`conversationMessages
/// .isEmpty`), where the caller prefixes that user message with it. Pure state; the caller
/// supplies the read, so nothing here touches D-Bus or X11.
#[derive(Debug, Default)]
pub struct ChatContext {
    captured: Option<String>,
    dragged: Option<String>,
}

impl ChatContext {
    /// Explicit human intent is independent of the automatic-capture switch.
    pub fn attach_dragged(&mut self, text: String) { self.dragged = Some(text); }
    pub fn first_message_consumed(&mut self) { self.dragged = None; }
    pub fn new_conversation(&mut self) { self.dragged = None; }

    /// Chat opened. Switch off: forget automatic context and read NOTHING. Preserve explicit drag.
    pub fn on_chat_open(&mut self, enabled: bool, read: impl FnOnce() -> Option<ActiveWindow>) {
        if !enabled {
            self.captured = None;
            return;
        }
        if self.captured.is_none() {
            self.captured = read().map(|w| format_context(&w));
        }
    }

    /// First message only: explicit drag wins regardless of the automatic-capture switch.
    pub fn for_turn(&self, enabled: bool, first: bool) -> Option<String> {
        if !first { return None; }
        self.dragged.clone().or_else(|| if enabled { self.captured.clone() } else { None })
    }
}

#[cfg(test)]
#[path = "contextwin_tests.rs"]
mod tests;

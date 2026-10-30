//! Work-area resolution: X11 `_NET_WORKAREA` (excludes panels/docks) intersected
//! with the monitor the window currently sits on, with graceful fallbacks.
//!
//! Tauri's `Monitor` under GNOME/XWayland can report a degenerate (0x0) rect
//! for an not-yet-mapped window, so a valid `_NET_WORKAREA` wins whenever the
//! monitor geometry is unusable; both raw values are exposed for the read-back
//! probe. Under pure Wayland neither value exists — see README.

use crate::geometry::{self, Rect};
#[cfg(target_os = "linux")]
use std::sync::{Mutex, OnceLock};
use tauri::WebviewWindow;

pub struct WorkArea {
    pub rect: Rect,
    pub source: &'static str,
    /// Raw `_NET_WORKAREA` from the X11 root window, if present.
    pub x11: Option<Rect>,
    /// Raw monitor geometry reported by Tauri, if usable.
    pub monitor: Option<Rect>,
}

fn valid(r: Rect) -> bool {
    r.w > 0 && r.h > 0
}

/// A monitor as the #389 placement seam sees it: the platform's stable name
/// key (see [`monitor_key`]) and its geometry in physical px.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitorChoice {
    pub key: String,
    pub rect: Rect,
}

/// #389: the stable key of one monitor — the NAME the platform itself reports
/// (the X11 output name such as `eDP-1` / `HDMI-A-1`, the Windows device name
/// such as `\\.\DISPLAY1`). It survives reboots and reconnects, and it is
/// built from nothing but what the island saw: no inference, no user input.
/// A monitor the platform does not name cannot be chosen at all.
pub fn monitor_key(name: Option<&str>) -> Option<String> {
    let name = name?.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

/// #389: the geometry placement and edge snapping work in. The human's chosen
/// monitor when it is present and connected (exact key match, valid geometry);
/// the island's CURRENT monitor otherwise — no choice, an unknown key, a
/// disconnected monitor, nothing enumerable, or a degenerate geometry. The
/// fallback is exactly the value `workarea::current()` produced, so an absent
/// preference is provably today's behaviour. The chosen monitor's bounds are
/// its work area: per-monitor decorative insets are only observable for the
/// monitor the window lives on (`monitor_work_area(rect, None)` IS the monitor
/// bounds), and the pure `reclamp`/`snap`/`restore` decisions below then see
/// one honest `Rect`, whatever monitor it came from.
pub fn chosen_area(chosen: Option<&str>, current: Rect, monitors: &[MonitorChoice]) -> Rect {
    let Some(key) = chosen else { return current };
    monitors
        .iter()
        .find(|m| m.key == key && valid(m.rect))
        .map(|m| m.rect)
        .unwrap_or(current)
}

/// F010 — the decorative frame a platform reports around one monitor's usable
/// area: a macOS-style notch / menu bar at the top, a dock along a side or the
/// bottom. Absent means the platform reports none (`None` insets), NOT that
/// there is no work area.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Insets {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// F010 — the work area of ONE monitor, pure: the monitor bounds (injected;
/// no window-system calls) minus the decorative insets the platform reports
/// for that monitor. Without reported insets the monitor bounds themselves
/// are the usable work area. Insets that leave nothing usable (or a
/// degenerate monitor) are refused with `None` — the same `valid()` rule
/// every other geometry seam here applies, so no caller ever receives a
/// negative or empty rectangle.
///
/// This is the seam the production sources fill: Win32's `rcWork` is exactly
/// the monitor minus the taskbar insets (see the pinning test), and on unix
/// no notch/menu-bar inset source exists today — GNOME publishes the
/// panel-subtracted `_NET_WORKAREA`, which [`pick_work_area`] intersects
/// with the monitor the island is on.
pub fn monitor_work_area(monitor: Rect, insets: Option<Insets>) -> Option<Rect> {
    if !valid(monitor) {
        return None;
    }
    let Some(i) = insets else { return Some(monitor) };
    let left = monitor.x.checked_add(i.left)?;
    let top = monitor.y.checked_add(i.top)?;
    let right = monitor.right().checked_sub(i.right)?;
    let bottom = monitor.bottom().checked_sub(i.bottom)?;
    if right <= left || bottom <= top {
        return None;
    }
    Some(Rect {
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
    })
}

/// Read `_NET_WORKAREA` from the root window (first 4 CARDINALs: x, y, w, h).
#[cfg(target_os = "linux")]
fn x11_net_workarea() -> Option<Rect> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::AtomEnum;
    use x11rb::protocol::xproto::ConnectionExt;
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let screen = &conn.setup().roots[screen_num];
    let atom = conn.intern_atom(false, b"_NET_WORKAREA").ok()?.reply().ok()?;
    let reply = conn
        .get_property(false, screen.root, atom.atom, AtomEnum::CARDINAL, 0, 4)
        .ok()?
        .reply()
        .ok()?;
    let mut vals = reply.value32()?;
    let x = vals.next()? as i32;
    let y = vals.next()? as i32;
    let w = vals.next()? as i32;
    let h = vals.next()? as i32;
    let rect = Rect { x, y, w, h };
    valid(rect).then_some(rect)
}

/// No EWMH `_NET_WORKAREA` exists here; `current()` labels the monitor/fallback honestly.
#[cfg(not(target_os = "linux"))]
fn x11_net_workarea() -> Option<Rect> {
    None
}

/// MONITORINFO.rcWork is given as screen-space left/top/right/bottom (SDK
/// winuser.h); the work area is the rectangle between them. Degenerate or
/// inverted results are refused — the same `valid()` rule the X11 seam uses,
/// so no caller can ever receive a negative geometry. Compiled for Windows
/// (its only runtime caller) and for tests, which pin the math on Linux.
#[cfg(any(windows, test))]
fn rect_from_bounds(left: i32, top: i32, right: i32, bottom: i32) -> Option<Rect> {
    let rect = Rect {
        x: left,
        y: top,
        w: right.checked_sub(left)?,
        h: bottom.checked_sub(top)?,
    };
    valid(rect).then_some(rect)
}

/// The Win32 work area: the taskbar-aware `rcWork` of the monitor that owns
/// our window (`MonitorFromWindow` with `MONITOR_DEFAULTTONEAREST`), which is
/// the value the X11 seam's `_NET_WORKAREA` is to Linux. `hwnd()` exists on
/// the Tauri window only for the Windows target; its handle is passed as the
/// raw pointer it is, so the `windows`-crate type tauri keeps private never
/// has to be named here.
#[cfg(windows)]
fn win32_work_area(win: &WebviewWindow) -> Option<Rect> {
    use windows_sys::Win32::Foundation::HWND as SysHWND;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITOR_DEFAULTTONEAREST, MONITORINFO,
    };
    let hwnd = win.hwnd().ok()?;
    // SAFETY: `hwnd` is the window's own handle, valid for the lifetime of the
    // call; `MONITORINFO` is zeroed and carries its exact size in cbSize, as
    // the API requires; the monitor handle comes from the same call chain.
    unsafe {
        let monitor = MonitorFromWindow(hwnd.0 as SysHWND, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return None;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            rcMonitor: std::mem::zeroed(),
            rcWork: std::mem::zeroed(),
            dwFlags: 0,
        };
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return None;
        }
        rect_from_bounds(info.rcWork.left, info.rcWork.top, info.rcWork.right, info.rcWork.bottom)
    }
}

#[cfg(not(windows))]
fn win32_work_area(_win: &WebviewWindow) -> Option<Rect> {
    None
}

/// Source selection for `current()` as a pure decision, so the matrix every
/// platform falls through is pinned by tests that run on Linux (U3b). The
/// priority is by OS-truth strength: `win32` rcWork is the real taskbar-
/// subtracted area of the window's own monitor by construction (no intersection
/// needed); the X11/monitor arms keep the exact unix behavior and labels.
fn pick_work_area(
    x11: Option<Rect>,
    win32: Option<Rect>,
    mon: Option<Rect>,
) -> (Rect, &'static str) {
    if let Some(w) = win32 {
        return (w, "win32:GetMonitorInfoW rcWork");
    }
    match (x11, mon) {
        (Some(x), Some(m)) => match geometry::intersect(x, m) {
            Some(i) => (i, "x11:_NET_WORKAREA intersect monitor"),
            // Both claim to be valid but disagree: the window lives on the
            // monitor, so clamp within it rather than across the whole desktop.
            None => (m, "monitor (X11 work area disjoint from monitor)"),
        },
        // Monitor unusable (e.g. 0x0 before the window is mapped under
        // XWayland): the EWMH work area is the honest value.
        (Some(x), None) => (x, "x11:_NET_WORKAREA (monitor geometry unusable)"),
        (None, Some(m)) => (m, "monitor geometry (no _NET_WORKAREA)"),
        (None, None) => (
            Rect {
                x: 0,
                y: 0,
                w: 1920,
                h: 1080,
            },
            "fallback 1920x1080 (no monitor, no X11)",
        ),
    }
}

fn monitor_rect(win: &WebviewWindow) -> Option<Rect> {
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())?;
    let pos = monitor.position();
    let size = monitor.size();
    let rect = Rect {
        x: pos.x,
        y: pos.y,
        w: size.width as i32,
        h: size.height as i32,
    };
    valid(rect).then_some(rect)
}

/// Raw, read-only X11 ground truth for our own top-level window: client
/// geometry in root coordinates, `_GTK_FRAME_EXTENTS` (invisible CSD insets)
/// and whether `_NET_WM_STATE_ABOVE` is actually set at the WM level. This
/// disambiguates Tauri's getters from what X11/mutter really applied.
#[derive(Debug, Clone)]
pub struct X11Window {
    pub id: u32,
    /// Window origin in root coordinates (sign-corrected).
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub border: i32,
    pub frame_extents: Option<[i32; 4]>, // left, right, top, bottom
    pub wm_state_above: Option<bool>,
    pub wm_class: Option<String>,
}

#[cfg(target_os = "linux")]
fn get_string_property(
    conn: &x11rb::rust_connection::RustConnection,
    window: x11rb::protocol::xproto::Window,
    atom: x11rb::protocol::xproto::Atom,
) -> Option<String> {
    use x11rb::protocol::xproto::ConnectionExt;
    let reply = conn
        .get_property(false, window, atom, x11rb::protocol::xproto::AtomEnum::STRING, 0, 256)
        .ok()?
        .reply()
        .ok()?;
    let bytes: Vec<u8> = reply.value8()?.collect();
    Some(String::from_utf8_lossy(&bytes).trim_matches('\0').to_string())
}

/// One top-level client window as the scan saw it (identity facts only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: u32,
    /// `_NET_WM_PID`, when the client set it.
    pub pid: Option<u32>,
    /// `_NET_WM_NAME` (UTF-8), falling back to `WM_NAME`.
    pub title: Option<String>,
}

/// Why our own window could not be identified. Every variant is reported
/// (probe line / stderr) — the caller never falls back to a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnWindowError {
    /// No X server / EWMH client list readable.
    NoX11,
    /// No listed window carries our pid.
    NotFound,
    /// A window titled like ours has no `_NET_WM_PID`: we cannot prove it
    /// is ours, so we refuse instead of matching by title alone.
    PidMissing,
    /// Several of OUR windows, none with the expected title.
    Ambiguous,
}

impl OwnWindowError {
    pub fn as_str(self) -> &'static str {
        match self {
            OwnWindowError::NoX11 => "no_x11_client_list",
            OwnWindowError::NotFound => "own_window_not_found",
            OwnWindowError::PidMissing => "net_wm_pid_missing",
            OwnWindowError::Ambiguous => "own_window_ambiguous",
        }
    }
}

/// Identity criterion for "our window" (FIX-B, spec lane 4aa7c63):
/// 1. PRIMARY: `_NET_WM_PID` equals this process id. A title is not an
///    identity — any other client can set its title to "Koda".
/// 2. SECONDARY: among our own windows, the one titled `title` wins; a single
///    own window is ours even untitled; several untitled → `Ambiguous`.
/// 3. No own window, but a window with our title and NO `_NET_WM_PID` →
///    `PidMissing` (fail visibly, never guess); otherwise `NotFound`.
///
/// Pure: unit-tested without an X server.
pub fn pick_own_window(list: &[Candidate], pid: u32, title: &str) -> Result<u32, OwnWindowError> {
    let own: Vec<&Candidate> = list.iter().filter(|c| c.pid == Some(pid)).collect();
    if let Some(c) = own.iter().find(|c| c.title.as_deref() == Some(title)) {
        return Ok(c.id);
    }
    match own.as_slice() {
        [only] => return Ok(only.id),
        [] => {}
        _ => return Err(OwnWindowError::Ambiguous),
    }
    if list
        .iter()
        .any(|c| c.pid.is_none() && c.title.as_deref() == Some(title))
    {
        return Err(OwnWindowError::PidMissing);
    }
    Err(OwnWindowError::NotFound)
}

/// Every descendant of `root` (breadth first, bounded): the fallback list when no window
/// manager publishes `_NET_CLIENT_LIST`. Read-only.
#[cfg(target_os = "linux")]
fn tree_windows(conn: &x11rb::rust_connection::RustConnection, root: u32) -> Vec<u32> {
    use x11rb::protocol::xproto::ConnectionExt;
    const MAX: usize = 512;
    let mut out = Vec::new();
    let mut queue = vec![root];
    while let Some(w) = queue.pop() {
        let Some(tree) = conn.query_tree(w).ok().and_then(|c| c.reply().ok()) else { continue };
        for child in tree.children {
            if out.len() >= MAX {
                return out;
            }
            out.push(child);
            queue.push(child);
        }
    }
    out
}

/// Find OUR window (read-only; never modifies any window) by
/// [`pick_own_window`] over the EWMH client list, and report its raw X11
/// state. The title is only the secondary condition.
#[cfg(target_os = "linux")]
pub fn x11_find_own_window(title: &str) -> Result<X11Window, OwnWindowError> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::AtomEnum;
    use x11rb::protocol::xproto::ConnectionExt;
    let no_x = |_| OwnWindowError::NoX11;
    let (conn, screen_num) = x11rb::connect(None).map_err(|_| OwnWindowError::NoX11)?;
    let screen = &conn.setup().roots[screen_num];
    let atom = |name: &[u8]| -> Result<u32, OwnWindowError> {
        Ok(conn
            .intern_atom(false, name)
            .map_err(|_| OwnWindowError::NoX11)?
            .reply()
            .map_err(|_| OwnWindowError::NoX11)?
            .atom)
    };
    // Prefer the stacking list, fall back to _NET_CLIENT_LIST.
    let windows: Vec<u32> = [b"_NET_CLIENT_LIST_STACKING".as_ref(), b"_NET_CLIENT_LIST".as_ref()]
        .into_iter()
        .find_map(|name| {
            let list = conn.intern_atom(false, name).ok()?.reply().ok()?;
            // Type is WINDOW (atom 33), not ATOM (4): filter with
            // AnyPropertyType or X returns an empty reply on type mismatch.
            let reply = conn
                .get_property(false, screen.root, list.atom, AtomEnum::ANY, 0, 512)
                .ok()?
                .reply()
                .ok()?;
            let v: Vec<u32> = reply.value32()?.collect();
            (!v.is_empty()).then_some(v)
        })
        // No EWMH list (a bare X server with no window manager, e.g. a private Xvfb): walk the
        // window tree instead. Identity is still the pid, so nothing weaker than before.
        .or_else(|| {
            let found = tree_windows(&conn, screen.root);
            (!found.is_empty()).then_some(found)
        })
        .ok_or(OwnWindowError::NoX11)?;
    let net_wm_name = atom(b"_NET_WM_NAME")?;
    let net_wm_pid = atom(b"_NET_WM_PID")?;
    let utf8_string = atom(b"UTF8_STRING")?;
    let wm_name = atom(b"WM_NAME")?;
    let wm_class = atom(b"WM_CLASS")?;
    let gtk_ext = atom(b"_GTK_FRAME_EXTENTS")?;
    let net_state = atom(b"_NET_WM_STATE")?;
    let state_above = atom(b"_NET_WM_STATE_ABOVE")?;
    let candidates: Vec<Candidate> = windows
        .iter()
        .map(|&wid| {
            let pid = conn
                .get_property(false, wid, net_wm_pid, AtomEnum::CARDINAL, 0, 1)
                .ok()
                .and_then(|r| r.reply().ok())
                .and_then(|r| r.value32()?.next());
            // _NET_WM_NAME (UTF8) first, plain WM_NAME as fallback.
            let title = conn
                .get_property(false, wid, net_wm_name, utf8_string, 0, 256)
                .ok()
                .and_then(|r| r.reply().ok())
                .and_then(|r| {
                    let bytes: Vec<u8> = r.value8()?.collect();
                    (!bytes.is_empty())
                        .then(|| String::from_utf8_lossy(&bytes).trim_matches('\0').to_string())
                })
                .or_else(|| get_string_property(&conn, wid, wm_name));
            Candidate { id: wid, pid, title }
        })
        .collect();
    let wid = pick_own_window(&candidates, std::process::id(), title)?;
    let geom = conn.get_geometry(wid).map_err(no_x)?.reply().map_err(|_| OwnWindowError::NoX11)?;
    let tr = conn
        .translate_coordinates(screen.root, wid, 0, 0)
        .map_err(no_x)?
        .reply()
        .map_err(|_| OwnWindowError::NoX11)?;
    let extents = conn
        .get_property(false, wid, gtk_ext, AtomEnum::CARDINAL, 0, 4)
        .ok()
        .and_then(|r| r.reply().ok())
        .and_then(|r| {
            let v: Vec<u32> = r.value32()?.collect();
            (v.len() == 4).then(|| [v[0] as i32, v[1] as i32, v[2] as i32, v[3] as i32])
        });
    let above = conn
        .get_property(false, wid, net_state, AtomEnum::ATOM, 0, 64)
        .ok()
        .and_then(|r| r.reply().ok())
        .and_then(|r| r.value32().map(|mut it| it.any(|a| a == state_above)));
    Ok(X11Window {
        id: wid,
        // translate_coordinates(root -> wid, 0, 0) reports the root origin
        // in window coordinates, i.e. the negated window origin.
        x: -(tr.dst_x as i32),
        y: -(tr.dst_y as i32),
        w: geom.width as i32,
        h: geom.height as i32,
        border: geom.border_width as i32,
        frame_extents: extents,
        wm_state_above: above,
        wm_class: get_string_property(&conn, wid, wm_class),
    })
}

/// Cached X id of our window: after the first scan every origin read costs
/// only two round trips (translate + connection setup).
#[cfg(target_os = "linux")]
static CACHED_WID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();

#[cfg(target_os = "linux")]
fn x11_origin_by_id(wid: u32) -> Option<(i32, i32)> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::ConnectionExt;
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let screen = &conn.setup().roots[screen_num];
    let tr = conn
        .translate_coordinates(screen.root, wid, 0, 0)
        .ok()?
        .reply()
        .ok()?;
    Some((-(tr.dst_x as i32), -(tr.dst_y as i32)))
}

/// True window origin in root coordinates, straight from the X server.
///
/// Needed because Tauri 2.12.1's `outer_position` getter under this
/// XWayland/GTK stack reports the correct X but a Y offset by a constant
/// (observed: requested 32, getter -5, X server 32). Setters are accurate;
/// only the getter drifts, so the drag math reads the X server directly.
/// Returns `None` before the window is mapped; callers fall back to Tauri.
#[cfg(target_os = "linux")]
pub fn x11_window_origin() -> Option<(i32, i32)> {
    let cache = CACHED_WID.get_or_init(|| Mutex::new(None));
    if let Some(wid) = *cache.lock().expect("wid cache lock") {
        if let Some(origin) = x11_origin_by_id(wid) {
            return Some(origin);
        }
        *cache.lock().expect("wid cache lock") = None; // stale id: rescan
    }
    let win = match x11_find_own_window(WINDOW_TITLE) {
        Ok(win) => win,
        Err(error) => {
            // Visible, once per distinct reason: the caller falls back to
            // Tauri's getter — never to another client's window.
            static LAST: OnceLock<Mutex<Option<OwnWindowError>>> = OnceLock::new();
            let last = LAST.get_or_init(|| Mutex::new(None));
            let mut seen = last.lock().expect("own window error lock");
            if *seen != Some(error) {
                eprintln!("x11 own window: {} (pid {})", error.as_str(), std::process::id());
                *seen = Some(error);
            }
            return None;
        }
    };
    *cache.lock().expect("wid cache lock") = Some(win.id);
    Some((win.x, win.y))
}

/// This target has no X11 origin to read, so callers truthfully fall back to Tauri's getter.
#[cfg(not(target_os = "linux"))]
pub fn x11_window_origin() -> Option<(i32, i32)> {
    None
}

/// Koda 0.1 T2: the native window title (tauri.conf.json carries the same text). The own-window probes match on it.
pub const WINDOW_TITLE: &str = "Koda";

/// No X server/EWMH client list exists here, so report the existing truthful error.
#[cfg(not(target_os = "linux"))]
pub fn x11_find_own_window(_title: &str) -> Result<X11Window, OwnWindowError> {
    Err(OwnWindowError::NoX11)
}

/// Best available work area for the window's monitor, plus a label describing
/// where the value came from (printed by the read-back probe).
pub fn current(win: &WebviewWindow) -> WorkArea {
    let x11 = x11_net_workarea();
    let win32 = win32_work_area(win);
    let mon = monitor_rect(win);
    let (rect, source) = pick_work_area(x11, win32, mon);
    WorkArea {
        rect,
        source,
        x11,
        monitor: mon,
    }
}

#[cfg(test)]
mod tests {
    // Koda 0.1 T2: the native window title is ONE constant; tauri.conf.json must carry the same text, or the
    // own-window probes (which match on it) would stop finding the island.
    #[test]
    fn the_native_window_title_is_koda_and_matches_the_tauri_config() {
        assert_eq!(super::WINDOW_TITLE, "Koda");
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["app"]["windows"][0]["title"], super::WINDOW_TITLE);
    }

    use super::*;

    fn cand(id: u32, pid: Option<u32>, title: &str) -> Candidate {
        Candidate { id, pid, title: Some(title.to_string()) }
    }

    // --- #389: the monitor the human chose — placement and snapping area -----

    fn mon(key: &str, x: i32, y: i32, w: i32, h: i32) -> MonitorChoice {
        MonitorChoice { key: key.to_string(), rect: Rect { x, y, w, h } }
    }

    #[test]
    fn a_monitor_key_is_the_platform_name_the_island_itself_saw() {
        // the X11 output name / Windows device name is the stable identifier
        assert_eq!(monitor_key(Some("eDP-1")), Some("eDP-1".to_string()));
        assert_eq!(monitor_key(Some("HDMI-A-1")), Some("HDMI-A-1".to_string()));
        assert_eq!(monitor_key(Some(r"\\.\DISPLAY1")), Some(r"\\.\DISPLAY1".to_string()));
        // surrounding whitespace is the platform's sloppiness, not part of the key
        assert_eq!(monitor_key(Some("  DP-1 ")), Some("DP-1".to_string()));
        // a monitor the platform does not name cannot be chosen at all
        assert_eq!(monitor_key(None), None);
        assert_eq!(monitor_key(Some("")), None);
        assert_eq!(monitor_key(Some("   ")), None);
    }

    #[test]
    fn without_a_choice_the_area_is_today_s_current_monitor_exactly() {
        let current = Rect { x: 0, y: 27, w: 1920, h: 1053 };
        let monitors = [mon("eDP-1", 0, 0, 1920, 1080), mon("DP-1", 1920, 0, 2560, 1440)];
        // no pref, no monitors to compare against: provably the same value
        // `workarea::current()` produced (the equivalence the fallback promises)
        assert_eq!(chosen_area(None, current, &monitors), current);
        assert_eq!(chosen_area(None, current, &[]), current);
        assert_eq!(chosen_area(None, current, &monitors), chosen_area(None, current, &[]));
    }

    #[test]
    fn the_chosen_monitor_s_bounds_are_the_area_when_present() {
        let current = Rect { x: 0, y: 0, w: 1920, h: 1080 };
        let chosen = Rect { x: 1920, y: 0, w: 2560, h: 1440 };
        let monitors = [mon("eDP-1", 0, 0, 1920, 1080), mon("DP-1", 1920, 0, 2560, 1440)];
        assert_eq!(chosen_area(Some("DP-1"), current, &monitors), chosen);
        // a monitor to the LEFT with negative coordinates is picked verbatim
        let left = [mon("DP-1", -1920, -200, 1920, 1080), mon("eDP-1", 0, 0, 1920, 1080)];
        assert_eq!(chosen_area(Some("DP-1"), current, &left), Rect { x: -1920, y: -200, w: 1920, h: 1080 });
    }

    #[test]
    fn an_unknown_or_disconnected_key_falls_back_to_the_current_monitor() {
        let current = Rect { x: 0, y: 27, w: 1920, h: 1053 };
        let monitors = [mon("eDP-1", 0, 0, 1920, 1080)];
        // never heard of it
        assert_eq!(chosen_area(Some("HDMI-A-1"), current, &monitors), current);
        // was connected at choice time, is gone now
        assert_eq!(chosen_area(Some("DP-1"), current, &monitors), current);
        // no monitors enumerable at all
        assert_eq!(chosen_area(Some("eDP-1"), current, &[]), current);
        // a degenerate geometry is refused like everywhere else: fallback
        let broken = [mon("eDP-1", 0, 0, 0, 1080)];
        assert_eq!(chosen_area(Some("eDP-1"), current, &broken), current);
    }

    #[test]
    fn a_duplicated_name_resolves_to_the_first_offered_monitor() {
        // two ports can report the same name; the enumeration order decides,
        // deterministically: first match wins, never a guess between them
        let dup = [mon("DP-1", 0, 0, 1920, 1080), mon("DP-1", 1920, 0, 2560, 1440)];
        let area = chosen_area(Some("DP-1"), Rect { x: 960, y: 0, w: 100, h: 100 }, &dup);
        assert_eq!(area, Rect { x: 0, y: 0, w: 1920, h: 1080 });
    }

    #[test]
    fn our_window_is_the_one_with_our_pid_and_our_title() {
        let list = [cand(1, Some(999), WINDOW_TITLE), cand(2, Some(42), WINDOW_TITLE)];
        assert_eq!(pick_own_window(&list, 42, WINDOW_TITLE), Ok(2));
    }

    #[test]
    fn a_foreign_window_titled_abito_is_never_taken_for_ours() {
        // another process opens a window titled exactly "Koda"
        let list = [cand(7, Some(999), WINDOW_TITLE)];
        assert_eq!(pick_own_window(&list, 42, WINDOW_TITLE), Err(OwnWindowError::NotFound));
    }

    #[test]
    fn a_window_without_net_wm_pid_fails_visibly_instead_of_guessing() {
        let list = [cand(7, None, WINDOW_TITLE)];
        assert_eq!(pick_own_window(&list, 42, WINDOW_TITLE), Err(OwnWindowError::PidMissing));
        // even when a pid-less window is listed first, a proven own one wins
        let list = [cand(7, None, WINDOW_TITLE), cand(8, Some(42), WINDOW_TITLE)];
        assert_eq!(pick_own_window(&list, 42, WINDOW_TITLE), Ok(8));
    }

    #[test]
    fn title_is_secondary_among_our_own_windows() {
        // our process may own helper windows; prefer the titled one
        let list = [cand(3, Some(42), "helper"), cand(4, Some(42), WINDOW_TITLE)];
        assert_eq!(pick_own_window(&list, 42, WINDOW_TITLE), Ok(4));
        // exactly one own top-level window: it is ours even untitled
        let list = [cand(5, Some(42), "")];
        assert_eq!(pick_own_window(&list, 42, WINDOW_TITLE), Ok(5));
        // several own windows, none titled: ambiguous, refuse
        let list = [cand(5, Some(42), "a"), cand(6, Some(42), "b")];
        assert_eq!(pick_own_window(&list, 42, WINDOW_TITLE), Err(OwnWindowError::Ambiguous));
    }

    #[test]
    fn empty_list_is_not_found() {
        assert_eq!(pick_own_window(&[], 42, WINDOW_TITLE), Err(OwnWindowError::NotFound));
    }

    // ---- F010: the work area of ONE monitor, computed from INJECTED monitors ----

    #[test]
    fn without_reported_insets_the_monitor_bounds_are_the_work_area() {
        // the platform reports no menu bar / notch / dock: the whole monitor is usable
        let m = Rect { x: 0, y: 0, w: 1920, h: 1080 };
        assert_eq!(monitor_work_area(m, None), Some(m));
        // ...and so is one whose insets are all zero
        let zero = Insets { left: 0, top: 0, right: 0, bottom: 0 };
        assert_eq!(monitor_work_area(m, Some(zero)), Some(m));
        // negative ORIGINS are legitimate (a monitor left of the primary)
        let left = Rect { x: -1920, y: 0, w: 1920, h: 1080 };
        assert_eq!(monitor_work_area(left, None), Some(left));
    }

    #[test]
    fn a_notch_or_menu_bar_inset_shrinks_the_monitor_from_the_top() {
        // the classic macOS case: a menu bar / notch the platform reports
        let m = Rect { x: 0, y: 0, w: 2560, h: 1440 };
        let menubar = Insets { left: 0, top: 38, right: 0, bottom: 0 };
        assert_eq!(
            monitor_work_area(m, Some(menubar)),
            Some(Rect { x: 0, y: 38, w: 2560, h: 1440 - 38 })
        );
        // the same monitor placed RIGHT of the primary: insets apply in the
        // monitor's own coordinate space, never in the desktop's
        let right = Rect { x: 1920, y: 0, w: 2560, h: 1440 };
        assert_eq!(
            monitor_work_area(right, Some(menubar)),
            Some(Rect { x: 1920, y: 38, w: 2560, h: 1440 - 38 })
        );
    }

    #[test]
    fn side_and_bottom_docks_shrink_the_monitor_from_their_edges() {
        let m = Rect { x: 0, y: 0, w: 1920, h: 1080 };
        let docks = Insets { left: 48, top: 32, right: 0, bottom: 48 };
        assert_eq!(
            monitor_work_area(m, Some(docks)),
            Some(Rect { x: 48, y: 32, w: 1920 - 48, h: 1080 - 32 - 48 })
        );
    }

    #[test]
    fn insets_that_leave_no_usable_area_are_refused() {
        let m = Rect { x: 0, y: 0, w: 1920, h: 1080 };
        // the insets eat the whole monitor (or invert it): None, never a degenerate rect
        let all = Insets { left: 960, top: 540, right: 960, bottom: 540 };
        assert_eq!(monitor_work_area(m, Some(all)), None);
        let exactly = Insets { left: 0, top: 0, right: 1920, bottom: 0 };
        assert_eq!(monitor_work_area(m, Some(exactly)), None);
        // a degenerate monitor itself is refused too
        assert_eq!(monitor_work_area(Rect { x: 0, y: 0, w: 0, h: 1080 }, None), None);
    }

    #[test]
    fn the_win32_rcwork_source_is_exactly_this_inset_subtraction() {
        // the seam the production sources fill: an rcWork of (0,0,1920,1032) on a
        // 1920x1080 monitor with a 48px bottom taskbar IS monitor_work_area(...)
        let m = Rect { x: 0, y: 0, w: 1920, h: 1080 };
        let taskbar = Insets { left: 0, top: 0, right: 0, bottom: 48 };
        assert_eq!(
            monitor_work_area(m, Some(taskbar)),
            rect_from_bounds(0, 0, 1920, 1032)
        );
        // and the left-docked-taskbar rcWork from the same SDK example
        let taskbar = Insets { left: 48, top: 0, right: 0, bottom: 0 };
        assert_eq!(
            monitor_work_area(m, Some(taskbar)),
            rect_from_bounds(48, 0, 1920, 1080)
        );
    }

    // ---- U3b: the win32 work area is a real OS value; its math is pure and
    // pinned here on Linux, exactly like pick_own_window pins the X11 one.
    #[test]
    fn rcwork_bounds_become_a_rect_by_subtraction_and_garbage_is_refused() {
        // SDK winuser.h: MONITORINFO.rcWork is left/top/right/bottom screen coords.
        // A 1920x1080 monitor with a 48px taskbar at the bottom reports (0,0,1920,1032).
        assert_eq!(
            rect_from_bounds(0, 0, 1920, 1032),
            Some(Rect { x: 0, y: 0, w: 1920, h: 1032 })
        );
        // a taskbar on the LEFT shifts x and shrinks w
        assert_eq!(
            rect_from_bounds(48, 0, 1920, 1080),
            Some(Rect { x: 48, y: 0, w: 1872, h: 1080 })
        );
        // degenerate or inverted rectangles are refused, never shipped as geometry
        assert_eq!(rect_from_bounds(0, 0, 0, 0), None);
        assert_eq!(rect_from_bounds(100, 100, 100, 50), None, "inverted height");
        assert_eq!(rect_from_bounds(0, 0, 0, 1080), None, "zero width");
        // a negative ORIGIN is not garbage: an 8x8 sliver at (-8,-8) passes the
        // same valid() rule the X11 seam applies — only area<=0 is refused
        assert_eq!(rect_from_bounds(-8, -8, 0, 0), Some(Rect { x: -8, y: -8, w: 8, h: 8 }));
    }

    #[test]
    fn the_work_area_source_priority_is_win32_then_x11_then_monitor_then_fallback() {
        let r = |x: i32, y: i32, w: i32, h: i32| Rect { x, y, w, h };
        // win32 rcWork wins over everything: it IS the OS truth with the taskbar
        // already subtracted, and it is by construction inside its own monitor
        assert_eq!(
            pick_work_area(Some(r(0, 0, 1920, 1040)), Some(r(0, 0, 1920, 1032)), Some(r(0, 0, 1920, 1080))),
            (r(0, 0, 1920, 1032), "win32:GetMonitorInfoW rcWork")
        );
        // no win32: the unix matrix is preserved exactly (x11 ∩ monitor)
        assert_eq!(
            pick_work_area(Some(r(0, 27, 1920, 1053)), None, Some(r(0, 0, 1920, 1080))),
            (r(0, 27, 1920, 1053), "x11:_NET_WORKAREA intersect monitor")
        );
        // disjoint x11 vs monitor: the monitor wins (window lives there) — unchanged unix arm
        assert_eq!(
            pick_work_area(Some(r(2000, 0, 800, 600)), None, Some(r(0, 0, 1920, 1080))),
            (r(0, 0, 1920, 1080), "monitor (X11 work area disjoint from monitor)")
        );
        // x11 alone (monitor unusable) — unchanged unix arm
        assert_eq!(
            pick_work_area(Some(r(0, 27, 1920, 1053)), None, None),
            (r(0, 27, 1920, 1053), "x11:_NET_WORKAREA (monitor geometry unusable)")
        );
        // the current Windows bug, frozen as the contract of the arm it falls to
        // once win32 rcWork exists: monitor geometry alone must no longer be reached
        // on a real Windows (rcWork will be Some); it stays the honest label when not
        assert_eq!(
            pick_work_area(None, None, Some(r(0, 0, 2560, 1440))),
            (r(0, 0, 2560, 1440), "monitor geometry (no _NET_WORKAREA)")
        );
        // nothing at all: the 1920x1080 guess, still labeled as a guess
        assert_eq!(
            pick_work_area(None, None, None),
            (r(0, 0, 1920, 1080), "fallback 1920x1080 (no monitor, no X11)")
        );
    }
}

//! F099 — closed, gated focus of an already-running terminal / agent session
//! window / editor. F100 (launch Claude Desktop) joins this module as its
//! sibling command. The
//! target comes from a CLOSED enum (`terminal` | `session` | `editor`): the
//! payload never carries a command, a path or a window id, so a caller can
//! only ask for a class of window the allowlists below already accept. When
//! the target is absent or the desktop cannot do it, the answer is a public
//! Spanish reason and NOTHING changes — never a false success.
//!
//! Gate order mirrors `desktop::open_web_url` exactly: sender → payload
//! validation → rate limiter → effect, so a rejected call spends no rate
//! budget and reaches no injected effect.
//!
//! Target semantics (documented interpretation, coordinator-approved):
//! - `terminal` — a window whose WM_CLASS matches the closed terminal
//!   allowlist,
//! - `session` — an AGENT SESSION window: a terminal-class window whose
//!   title carries the standalone agent runtime tokens (`pi`, `herdr`),
//! - `editor` — a window whose WM_CLASS matches the closed editor allowlist
//!   (editors win even when a title mentions the agent).
//!
//! Resolution reads `_NET_CLIENT_LIST_STACKING` + `WM_CLASS` +
//! `_NET_WM_NAME` over the existing x11rb dependency (wmctrl/xdotool-FREE)
//! and focuses the TOPMOST match with the EWMH `_NET_ACTIVE_WINDOW` client
//! message (`set_input_focus` fallback). No process is spawned with a
//! caller-influenced argument, ever.
use crate::bridge::{BridgeError, RateLimiter};
use serde_json::Value;

#[cfg(all(test, unix))] // the tests exercise unix file modes
#[path = "focushost_tests.rs"]
mod tests;

/// Public Spanish reasons. Safe to show: they name the failure, never a
/// path, a command or an internal.
pub const ERR_INVALID_TARGET: &str = "Objetivo inválido: elegí terminal, session o editor.";
pub const PLATFORM_FOCUS_REASON: &str =
    "Este escritorio no permite enfocar ventanas de otros programas ahora.";

/// Closed WM_CLASS allowlists (lowercase, boundary-exact: the entry matches
/// the class/instance itself or the class/instance with `-`/`_`/`.` right
/// after — never a blanket substring). On GNOME/Wayland these only see
/// XWayland windows; a native-Wayland terminal is honestly "not found",
/// never guessed.
pub const TERMINAL_CLASSES: &[&str] = &[
    "gnome-terminal",
    "org.gnome.terminal",
    "org.gnome.console",
    "kgx",
    "konsole",
    "xterm",
    "alacritty",
    "kitty",
    "foot",
    "wezterm",
    "tilix",
    "terminator",
    "urxvt",
    "rxvt",
    "xfce4-terminal",
    "mate-terminal",
    "lxterminal",
    "qterminal",
];

pub const EDITOR_CLASSES: &[&str] = &[
    "code",
    "code-oss",
    "vscode",
    "org.gnome.texteditor",
    "gedit",
    "gvim",
    "neovide",
    "sublime_text",
    "zed",
    "cursor",
    "jetbrains-idea",
    "idea",
];

/// Standalone title tokens that mark an agent-session terminal (`pi`,
/// `herdr`): token match after splitting the title on non-alphanumerics, so
/// `pip install` is NOT a session window.
pub const AGENT_SESSION_MARKERS: &[&str] = &["pi", "herdr"];

/// The closed target enum: every accepted string, nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Terminal,
    Session,
    Editor,
}

impl Target {
    pub fn parse(raw: &str) -> Option<Target> {
        match raw {
            "terminal" => Some(Target::Terminal),
            "session" => Some(Target::Session),
            "editor" => Some(Target::Editor),
            _ => None,
        }
    }
}

/// One candidate window as the pure seam sees it (no X types, unit-testable).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub instance: String,
    pub class: String,
    pub title: String,
}

/// Per-target honest "absent" reason, in Spanish, safe to show.
pub fn no_window_reason(target: Target) -> String {
    match target {
        Target::Terminal => "No encontré una ventana de terminal abierta.".to_string(),
        Target::Session => "No encontré una ventana de sesión de agente abierta.".to_string(),
        Target::Editor => "No encontré una ventana de editor abierta.".to_string(),
    }
}

/// Closed allowlist rule: entry equals the (lowercased) name, or the name
/// continues the entry with a `-`/`_`/`.` boundary (`gnome-terminal-server`
/// matches `gnome-terminal`; `codesign` does NOT match `code`).
pub fn matches_allowlist(class: &str, allowlist: &[&str]) -> bool {
    let lower = class.to_lowercase();
    allowlist.iter().any(|entry| {
        lower == *entry
            || lower.starts_with(&format!("{entry}-"))
            || lower.starts_with(&format!("{entry}_"))
            || lower.starts_with(&format!("{entry}."))
    })
}

fn session_marker_present(title: &str) -> bool {
    title
        .split(|c: char| !c.is_alphanumeric())
        .any(|token| AGENT_SESSION_MARKERS.contains(&token))
}

/// Which target is this window, if any? Editors first, then terminal classes
/// split into session (title token) and plain terminal; everything else is
/// None. The session marker never promotes a non-terminal window.
pub fn classify_window(w: &WindowInfo) -> Option<Target> {
    if matches_allowlist(&w.class, EDITOR_CLASSES) || matches_allowlist(&w.instance, EDITOR_CLASSES) {
        return Some(Target::Editor);
    }
    if matches_allowlist(&w.class, TERMINAL_CLASSES) || matches_allowlist(&w.instance, TERMINAL_CLASSES) {
        if session_marker_present(&w.title) {
            return Some(Target::Session);
        }
        return Some(Target::Terminal);
    }
    None
}

/// The TOPMOST matching window in stacking order (the list arrives stacked,
/// top last), or None when no window matches. A plain `terminal` ask accepts
/// ANY terminal-class window (an agent-session terminal is still a
/// terminal); `session` only accepts the agent-session-marked ones.
pub fn pick_window_index(target: Target, windows: &[WindowInfo]) -> Option<usize> {
    windows.iter().rposition(|w| classify_window(w).is_some_and(|c| match target {
        Target::Terminal => matches!(c, Target::Terminal | Target::Session),
        Target::Session => c == Target::Session,
        Target::Editor => c == Target::Editor,
    }))
}

/// The honest focus decision over a collected window list: no candidate →
/// the per-target Spanish reason (connect ok but no matching window); a
/// failed activation → the platform reason. The activate closure receives
/// only the chosen INDEX — never a caller-controlled id.
pub fn focus_from_windows<F>(target: Target, windows: &[WindowInfo], activate: F) -> Result<(), String>
where
    F: FnOnce(usize) -> bool,
{
    match pick_window_index(target, windows) {
        None => Err(no_window_reason(target)),
        Some(idx) => {
            if activate(idx) {
                Ok(())
            } else {
                Err(PLATFORM_FOCUS_REASON.to_string())
            }
        }
    }
}

/// Public reason when even the launch fails: short, user-facing.
pub const TERMINAL_LAUNCH_REASON: &str = "No se pudo abrir una terminal.";

/// Terminal emulators tried in order: the user's default launcher first,
/// then the common ones. Fixed names, resolved on PATH, never page-supplied.
pub const LAUNCH_TERMINALS: &[&str] = &[
    "xdg-terminal-exec",
    "gnome-terminal",
    "ptyxis",
    "kgx",
    "x-terminal-emulator",
];

/// `terminal` always ends with a terminal: focus the running one; when none
/// can be focused, launch a new one. Other targets never launch anything.
pub fn focus_or_launch<F, L>(target: Target, focus: F, launch: L) -> Result<(), String>
where
    F: FnOnce(Target) -> Result<(), String>,
    L: FnOnce() -> Result<(), String>,
{
    match focus(target) {
        Ok(()) => Ok(()),
        Err(_) if target == Target::Terminal => launch(),
        Err(reason) => Err(reason),
    }
}

/// Working directory of a launched terminal: the session's directory when
/// Rust itself knows an absolute existing one, else `$HOME` when it is a
/// directory, else `/`. Never derived from the page.
pub fn resolve_launch_dir(session_dir: Option<std::path::PathBuf>, home: Option<std::path::PathBuf>) -> std::path::PathBuf {
    let usable = |p: &std::path::PathBuf| p.is_absolute() && p.is_dir();
    session_dir
        .filter(usable)
        .or_else(|| home.filter(usable))
        .unwrap_or_else(|| std::path::PathBuf::from("/"))
}

/// Pure launch core: first terminal of [`LAUNCH_TERMINALS`] found in the
/// `path_var` directories whose spawn succeeds. `spawn` receives the
/// resolved executable and the directory; argv is empty by construction.
pub fn launch_terminal_with<S>(
    path_var: &str,
    session_dir: Option<std::path::PathBuf>,
    home: Option<std::path::PathBuf>,
    mut spawn: S,
) -> Result<(), String>
where
    S: FnMut(&std::path::Path, &std::path::Path) -> bool,
{
    let dir = resolve_launch_dir(session_dir, home);
    for name in LAUNCH_TERMINALS {
        let found = std::env::split_paths(path_var)
            .map(|d| d.join(name))
            .find(|p| p.is_file());
        if let Some(exe) = found {
            if spawn(&exe, &dir) {
                return Ok(());
            }
        }
    }
    Err(TERMINAL_LAUNCH_REASON.to_string())
}

/// Validation-only seam: the validator/probe build installs a hook that
/// REPLACES the real spawn, so a scene can click the ↗ button without opening
/// a terminal on a shared desktop. Compiled out of the shipped binary
/// (`MARKER` is on the packaging gate's forbidden list).
#[cfg(any(debug_assertions, feature = "probe"))]
pub mod validation_launcher {
    use std::sync::Mutex;
    pub const MARKER: &str = "abito-validator-fake-terminal-launcher";
    type Hook = Box<dyn Fn() + Send + Sync>;
    static HOOK: Mutex<Option<Hook>> = Mutex::new(None);
    /// Install the fake launcher (replaces any previous one). Returns the marker.
    pub fn install(hook: impl Fn() + Send + Sync + 'static) -> &'static str {
        *HOOK.lock().expect("validation launcher") = Some(Box::new(hook));
        MARKER
    }
    pub fn uninstall() {
        *HOOK.lock().expect("validation launcher") = None;
    }
    /// `true` when the fake handled the request (nothing real is spawned).
    pub(super) fn intercept() -> bool {
        match HOOK.lock().expect("validation launcher").as_ref() {
            Some(hook) => { hook(); true }
            None => false,
        }
    }
}

/// Real launch: detached child, fixed (empty) argv, no shell, cwd chosen by
/// Rust. The child is reaped on a thread so no zombie is left behind.
pub fn launch_terminal(session_dir: Option<std::path::PathBuf>) -> Result<(), String> {
    #[cfg(any(debug_assertions, feature = "probe"))]
    if validation_launcher::intercept() {
        return Ok(());
    }
    let path_var = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    launch_terminal_with(&path_var, session_dir, home, |exe, dir| {
        let name = exe.file_name().and_then(|n| n.to_str()).unwrap_or("");
        match std::process::Command::new(exe)
            .args(launch_args(name, Some(dir)))
            .current_dir(dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(mut child) => {
                std::thread::spawn(move || { let _ = child.wait(); });
                true
            }
            Err(_) => false,
        }
    })
}

/// The command's platform entry: a session key shows THAT session's terminal (its window, and its herdr pane);
/// anything else, or a session Rust cannot find, is the previous behaviour.
pub fn focus_running(target: Target, session: Option<&str>) -> Result<(), String> {
    if target == Target::Terminal {
        return focus_session_or_fallback(session, crate::sessionterm::focus_session, || focus_or_launch_running(target));
    }
    focus_or_launch_running(target)
}

/// The platform entry the command calls: focus, else launch (terminal only).
pub fn focus_or_launch_running(target: Target) -> Result<(), String> {
    // The daemon's session rows carry only a directory BASENAME (never a full
    // path), so there is no trusted full cwd to pass: `$HOME` is used.
    focus_or_launch(target, focus_running_window, || launch_terminal(None))
}

fn validated_target(payload: &Value) -> Result<Target, BridgeError> {
    let (target, session, notice) = validated_request(payload)?;
    // The original entry point never knew a session: it keeps refusing one.
    if session.is_some() || notice.is_some() { return Err(BridgeError::denied(ERR_INVALID_TARGET)); }
    Ok(target)
}
/// A closed selector for a host-owned origin; never a peer-supplied process identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginRequest { pub kind: OriginKind, pub id: String }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginKind { Notice, Pending }
fn origin_uuid(s: &str) -> bool {
    s.len() == 36 && s.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_digit() || (b'a'..=b'f').contains(&b) }
    })
}
const ORIGIN_REQUEST_BYTES: usize = 512;
/// Count serialized UTF-8 bytes without allocating an oversized second copy of the request.
fn origin_request_fits(payload: &Value) -> bool {
    struct Budget(usize);
    impl std::io::Write for Budget {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.0 { return Err(std::io::ErrorKind::InvalidData.into()); }
            self.0 -= bytes.len(); Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    serde_json::to_writer(Budget(ORIGIN_REQUEST_BYTES), payload).is_ok()
}
fn validated_request(payload: &Value) -> Result<(Target, Option<String>, Option<OriginRequest>), BridgeError> {
    let invalid = || BridgeError::denied(ERR_INVALID_TARGET);
    let map = payload.as_object().ok_or_else(invalid)?;
    if map.contains_key("origin") && !origin_request_fits(payload) { return Err(invalid()); }
    let raw = map.get("target").and_then(Value::as_str).ok_or_else(invalid)?;
    let target = Target::parse(raw).ok_or_else(invalid)?;
    match map.len() {
        1 => Ok((target, None, None)),
        2 => {
            let key = map.get("session").and_then(Value::as_str).filter(|k| crate::sessionterm::valid_session_key(k)).ok_or_else(invalid)?;
            if target != Target::Terminal { return Err(invalid()); }
            Ok((target, Some(key.to_owned()), None))
        }
        3 if target == Target::Terminal => {
            let kind = match map.get("origin").and_then(Value::as_str) {
                Some("notice") => OriginKind::Notice, Some("pending") => OriginKind::Pending,
                _ => return Err(invalid()),
            };
            let id = map.get("id").and_then(Value::as_str).filter(|s| origin_uuid(s)).ok_or_else(invalid)?;
            Ok((target, None, Some(OriginRequest { kind, id: id.into() })))
        }
        _ => Err(invalid()),
    }
}

/// The F099 command body: sender gate, closed-target validation, rate gate,
/// THEN the injected focus effect. An invalid call never consumes rate
/// budget and never reaches the effect.
pub fn focus_command<F>(
    label: &str,
    origin: &str,
    payload: &Value,
    rate: &mut RateLimiter,
    now: u128,
    focus: F,
) -> Result<(), BridgeError>
where
    F: FnOnce(Target) -> Result<(), String>,
{
    crate::bridge::sender_ok(label, origin)?;
    let target = validated_target(payload)?;
    rate.check(now)?;
    focus(target).map_err(|reason| BridgeError::denied(&reason))
}

/// [`focus_command`] for a request that may carry a session key. Same gates, same order.
pub fn focus_command_for<F>(
    label: &str,
    origin: &str,
    payload: &Value,
    rate: &mut RateLimiter,
    now: u128,
    focus: F,
) -> Result<(), BridgeError>
where
    F: FnOnce(Target, Option<&str>) -> Result<(), String>,
{
    crate::bridge::sender_ok(label, origin)?;
    let (target, session, notice) = validated_request(payload)?;
    if notice.is_some() { return Err(BridgeError::denied(ERR_INVALID_TARGET)); }
    rate.check(now)?;
    focus(target, session.as_deref()).map_err(|reason| BridgeError::denied(&reason))
}

/// A known session is shown through ITS terminal and nothing else; its failure is its own public reason and never
/// triggers a second terminal. A session Rust cannot resolve (finished, recycled pid, no key) takes the old path.
pub fn focus_session_or_fallback<S, F>(session: Option<&str>, by_session: S, fallback: F) -> Result<(), String>
where
    S: FnOnce(&str) -> Option<Result<(), String>>,
    F: FnOnce() -> Result<(), String>,
{
    match session.and_then(by_session) {
        Some(outcome) => outcome,
        None => fallback(),
    }
}

/// argv of a launch candidate: only `xdg-terminal-exec` takes the directory (as ONE `--dir=<absolute path>`
/// argument Rust built); a path that is not absolute or carries control characters is dropped, never passed.
pub fn launch_args(exe_name: &str, dir: Option<&std::path::Path>) -> Vec<String> {
    match (exe_name, dir) {
        ("xdg-terminal-exec", Some(d)) if d.is_absolute() && !d.to_string_lossy().chars().any(char::is_control) =>
            vec![format!("--dir={}", d.display())],
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Linux effect layer: real X11 resolution, honest elsewhere.
// ---------------------------------------------------------------------------

/// The platform entry the command calls. On Linux this goes through X11
/// (XWayland included); any other platform is an honest stub — the reason is
/// Spanish and nothing is attempted.
pub fn focus_running_window(target: Target) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        focus_on_display(None, target)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = target;
        Err(PLATFORM_FOCUS_REASON.to_string())
    }
}

#[cfg(target_os = "linux")]
mod x11 {
    use super::{focus_from_windows, WindowInfo, PLATFORM_FOCUS_REASON, Target};
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ClientMessageData, ClientMessageEvent, ConnectionExt,
        EventMask, InputFocus};
    use x11rb::rust_connection::RustConnection;
    use x11rb::CURRENT_TIME;

    /// Connect without ever panicking (a wedged X server must not kill the
    /// island); same catch_unwind discipline as `hotkey::x11`.
    fn connect(display: Option<&str>) -> Option<(RustConnection, usize)> {
        let owned = display.map(str::to_owned);
        std::panic::catch_unwind(move || RustConnection::connect(owned.as_deref())).ok()?.ok()
    }

    fn intern(conn: &RustConnection, name: &[u8]) -> Option<u32> {
        conn.intern_atom(false, name).ok()?.reply().ok().map(|r| r.atom)
    }

    /// `_NET_CLIENT_LIST_STACKING`, stacked with the topmost window LAST.
    fn client_windows(conn: &RustConnection, root: u32) -> Vec<u32> {
        let Some(atom) = intern(conn, b"_NET_CLIENT_LIST_STACKING") else { return Vec::new() };
        conn.get_property(false, root, atom, AtomEnum::WINDOW, 0, u32::MAX)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|reply| reply.value32().map(|it| it.collect()).unwrap_or_default())
            .unwrap_or_default()
    }

    /// `WM_CLASS` → (instance, class); lossy, empty on refusal.
    fn wm_class(conn: &RustConnection, window: u32) -> (String, String) {
        conn.get_property(false, window, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, u32::MAX)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|reply| {
                let mut parts = reply.value.split(|b| *b == 0);
                (
                    String::from_utf8_lossy(parts.next().unwrap_or(&[])).into_owned(),
                    String::from_utf8_lossy(parts.next().unwrap_or(&[])).into_owned(),
                )
            })
            .unwrap_or_default()
    }

    /// `_NET_WM_NAME` (UTF-8) falling back to `WM_NAME`; empty when absent.
    fn name_prop(conn: &RustConnection, window: u32, ty: u32) -> Option<String> {
        conn.get_property(false, window, ty, ty, 0, u32::MAX)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| String::from_utf8_lossy(&r.value).into_owned())
    }

    fn wm_name(conn: &RustConnection, window: u32) -> String {
        if let Some(utf8) = intern(conn, b"UTF8_STRING") {
            if let Some(name) = name_prop(conn, window, utf8) {
                return name;
            }
        }
        name_prop(conn, window, AtomEnum::STRING.into()).unwrap_or_default()
    }

    /// EWMH `_NET_ACTIVE_WINDOW` client message (source indication 2 =
    /// application), `set_input_focus` as the fallback. Best effort, never
    /// panics.
    fn activate(conn: &RustConnection, root: u32, window: u32) -> bool {
        let Some(atom) = intern(conn, b"_NET_ACTIVE_WINDOW") else { return false };
        let event = ClientMessageEvent::new(32, window, atom, ClientMessageData::from([2u32, 0, 0, 0, 0]));
        let sent = conn
            .send_event(
                false,
                root,
                EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                event,
            )
            .ok()
            .and_then(|c| c.check().ok())
            .is_some();
        if sent {
            return true;
        }
        conn.set_input_focus(InputFocus::POINTER_ROOT, window, CURRENT_TIME)
            .ok()
            .and_then(|c| c.check().ok())
            .is_some()
    }

    fn collect_windows(conn: &RustConnection, root: u32) -> Vec<(u32, WindowInfo)> {
        client_windows(conn, root)
            .into_iter()
            .map(|id| {
                let (instance, class) = wm_class(conn, id);
                let title = wm_name(conn, id);
                (id, WindowInfo { instance, class, title })
            })
            .collect()
    }

    /// `_NET_WM_PID` of a window.
    fn wm_pid(conn: &RustConnection, window: u32) -> Option<u32> {
        let atom = intern(conn, b"_NET_WM_PID")?;
        conn.get_property(false, window, atom, AtomEnum::CARDINAL, 0, 1).ok()?.reply().ok()?.value32()?.next()
    }

    /// Raise the topmost window owned by process `pid` (XWayland / X11 windows only).
    pub(super) fn raise_window_of_pid(pid: u32) -> bool {
        let Some((conn, screen)) = connect(None) else { return false };
        let root = conn.setup().roots[screen].root;
        let windows = client_windows(&conn, root);
        match windows.into_iter().rev().find(|w| wm_pid(&conn, *w) == Some(pid)) {
            Some(window) => activate(&conn, root, window),
            None => false,
        }
    }

    /// Resolve `target` among the running windows and activate the topmost
    /// match through the SAME honest decision the unit tests cover
    /// (`focus_from_windows`). Connect failure and activation failure are
    /// BOTH the platform reason; an absent target is the per-target Spanish
    /// reason; nothing else ever happens.
    pub(super) fn focus_on_display(display: Option<&str>, target: Target) -> Result<(), String> {
        let Some((conn, screen)) = connect(display) else {
            return Err(PLATFORM_FOCUS_REASON.to_string());
        };
        let root = conn.setup().roots[screen].root;
        let list = collect_windows(&conn, root);
        let infos: Vec<WindowInfo> = list.iter().map(|(_, info)| info.clone()).collect();
        focus_from_windows(target, &infos, |idx| activate(&conn, root, list[idx].0))
    }
}

/// X11 / XWayland only: a native Wayland window has no X11 id to find.
#[cfg(target_os = "linux")]
pub fn raise_x11_window_of_pid(pid: u32) -> bool { x11::raise_window_of_pid(pid) }

#[cfg(target_os = "linux")]
fn focus_on_display(display: Option<&str>, target: Target) -> Result<(), String> {
    x11::focus_on_display(display, target)
}

/// Origin-aware command; the page only selects a host-owned record by closed kind + UUID.
pub fn focus_command_with_origin<F>(label: &str, origin: &str, payload: &Value,
    rate: &mut RateLimiter, now: u128, focus: F) -> Result<(), BridgeError>
where F: FnOnce(Target, Option<&str>, Option<&OriginRequest>) -> Result<(), String> {
    crate::bridge::sender_ok(label, origin)?;
    let (target, session, notice) = validated_request(payload)?;
    rate.check(now)?;
    focus(target, session.as_deref(), notice.as_ref()).map_err(|reason| BridgeError::denied(&reason))
}

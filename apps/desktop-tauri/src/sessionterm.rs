//! The terminal that RUNS an agent session, resolved by Rust from /proc (never from the page), and, inside
//! herdr, the pane/tab the session lives in. The page only ever names a session by its derived key `s-xxxxxxxx`
//! (the id the daemon's session list already carries); Rust re-derives that key from /proc exactly like the
//! daemon does, so an unknown or recycled key resolves to nothing and the caller falls back.
//!
//! Layers (each pure over an injected /proc root or an injected runner, so all of it is unit-tested):
//! 1. `find_session` — key -> the agent process (its cwd comes from `/proc/<pid>/cwd`, a real directory only);
//! 2. `ancestors` / `terminal_of` — the nearest terminal emulator above it, by process name;
//! 3. herdr — sessions inside herdr are children of the herdr SERVER (it owns the ptys), not of the terminal
//!    window; the window is the one running a herdr CLIENT, and the pane comes from the herdr CLI's own
//!    read-only `pane list` / `pane process-info` (ids validated before they become argv);
//! 4. `apply` — the effect order: focus the herdr workspace+tab, raise the window, and launch a terminal ONLY
//!    when no terminal of that session exists. A terminal that exists but cannot be raised is reported, never
//!    answered by opening a second one.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(test)]
#[path = "sessionterm_os_tests.rs"]
mod os_tests;
#[cfg(all(test, unix))] // the tests exercise unix file modes
#[path = "sessionterm_tests.rs"]
mod tests;

/// Same closed set as the daemon's `KIND_BY_BINARY` (sessions.cjs).
pub const AGENT_BINARIES: &[&str] = &["pi", "claude", "codex", "opencode", "gemini"];
/// Terminal emulators by PROCESS name (`comm`, at most 15 bytes: `gnome-terminal-server` shows as
/// `gnome-terminal-`). Boundary rule as in `focushost::matches_allowlist`.
pub const TERMINAL_COMMS: &[&str] = &[
    "ghostty", "ptyxis", "gnome-terminal", "kgx", "konsole", "alacritty", "kitty", "foot", "wezterm",
    "tilix", "terminator", "xterm", "urxvt", "rxvt", "xfce4-terminal", "mate-terminal", "lxterminal",
    "qterminal", "blackbox", "warp",
];
const MAX_PIDS: usize = 4096;
const MAX_HOPS: usize = 32;
pub const MAX_PANES: usize = 64;
const MAX_ID: usize = 32;

/// Public reason when the session's terminal is open but this desktop will not bring it to the front.
pub const CANNOT_RAISE_REASON_MAC: &str =
    "Pedí traer la app de tu terminal al frente; la pestaña exacta no la puedo elegir sin permisos que Koda no pide.";
pub const CANNOT_RAISE_REASON_WIN: &str =
    "Traje al frente una ventana de tu terminal, pero tiene varias y no puedo saber cuál es la del agente. Revisá las otras.";
pub const CANNOT_RAISE_REASON: &str =
    "Tu terminal está abierta, pero este escritorio no me deja traerla al frente. Cambiá a ella.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcInfo { pub pid: u32, pub ppid: u32, pub comm: String, pub starttime: u64 }

/// `s-` + the first 8 hex of sha256("<pid> <starttime>"): the daemon's `sessions.cjs` derivation.
pub fn session_key(pid: u32, starttime: u64) -> String {
    let digest = Sha256::digest(format!("{pid} {starttime}").as_bytes());
    let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("s-{hex}")
}
pub fn valid_session_key(s: &str) -> bool {
    s.len() == 10 && s.starts_with("s-") && s[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn parse_stat(text: &str) -> Option<(String, u32, u64)> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    if close < open { return None; }
    let fields: Vec<&str> = text[close + 1..].split_whitespace().collect();
    if fields.len() < 20 { return None; }
    Some((text[open + 1..close].to_string(), fields[1].parse().ok()?, fields[19].parse().ok()?))
}
/// The process table an origin is resolved against. `Path` is Linux `/proc`; macOS and Windows have their own
/// kernel-backed tables (`sessionterm_mac.rs`, `sessionterm_win.rs`). Everything above this seam (chain walk,
/// birth-identity checks, bounds, revalidation) is shared and unit-tested with fake tables on every OS.
pub trait ProcTable {
    fn read(&self, pid: u32) -> Option<ProcInfo>;
    /// Whether this process is a terminal emulator on this OS (by process name).
    fn is_terminal(&self, p: &ProcInfo) -> bool;
    /// Whether the process currently owns a window that can be raised. Window-less hosts (a ConPTY host, an
    /// editor's pty helper) are skipped so the origin anchors on the ancestor that owns the window.
    fn hosts_window(&self, _pid: u32) -> bool { true }
    /// The terminal window hosting a herdr client (Linux only).
    fn herdr_client_terminal(&self) -> Option<u32> { None }
}
impl ProcTable for Path {
    fn read(&self, pid: u32) -> Option<ProcInfo> { read_proc(self, pid) }
    fn is_terminal(&self, p: &ProcInfo) -> bool { comm_matches(&p.comm, TERMINAL_COMMS) }
    fn herdr_client_terminal(&self) -> Option<u32> { herdr_client_terminal(self) }
}
impl ProcTable for PathBuf {
    fn read(&self, pid: u32) -> Option<ProcInfo> { read_proc(self, pid) }
    fn is_terminal(&self, p: &ProcInfo) -> bool { comm_matches(&p.comm, TERMINAL_COMMS) }
    fn herdr_client_terminal(&self) -> Option<u32> { herdr_client_terminal(self) }
}
/// Exact (not prefix) match for macOS/Windows names: lowercase, `.exe` stripped. `Code-Server`, `terminal-notifier`
/// or `warp-svc` are different programs from `Code`, `Terminal` and `Warp`.
pub fn exact_name_matches(comm: &str, list: &[&str]) -> bool {
    let lower = comm.to_lowercase();
    let name = lower.strip_suffix(".exe").unwrap_or(&lower);
    list.contains(&name)
}
/// Terminal emulators by process name on macOS (`proc_bsdinfo.pbi_comm`, lowercase, at most 15 bytes).
pub const MAC_TERMINAL_COMMS: &[&str] = &[
    "terminal", "iterm2", "ghostty", "wezterm-gui", "wezterm", "kitty", "alacritty", "warp", "hyper", "tabby",
];
/// Terminal hosts on Windows (executable names, lowercase; `.exe` is accepted by the boundary rule). Never the
/// Abito island or its notice relay.
pub const WIN_TERMINAL_COMMS: &[&str] = &[
    "windowsterminal", "openconsole", "conhost", "wezterm-gui", "alacritty", "kitty", "mintty", "hyper", "tabby", "warp", "code",
];

pub fn read_proc(proc_dir: &Path, pid: u32) -> Option<ProcInfo> {
    let text = fs::read_to_string(proc_dir.join(pid.to_string()).join("stat")).ok()?;
    let (comm, ppid, starttime) = parse_stat(&text)?;
    Some(ProcInfo { pid, ppid, comm, starttime })
}
fn cmdline_args(proc_dir: &Path, pid: u32) -> Vec<String> {
    fs::read(proc_dir.join(pid.to_string()).join("cmdline")).map(|b| {
        b.split(|c| *c == 0).filter(|a| !a.is_empty()).take(3).map(|a| String::from_utf8_lossy(a).into_owned()).collect()
    }).unwrap_or_default()
}
fn is_agent(args: &[String]) -> bool {
    args.iter().any(|a| Path::new(a).file_name().and_then(|n| n.to_str()).is_some_and(|n| AGENT_BINARIES.contains(&n)))
}

pub struct SessionProc { pub pid: u32, pub cwd: Option<PathBuf> }
/// The agent process whose derived key is `key`. A malformed key never reaches /proc.
pub fn find_session(proc_dir: &Path, key: &str) -> Option<SessionProc> {
    if !valid_session_key(key) { return None; }
    let names = fs::read_dir(proc_dir).ok()?;
    for entry in names.filter_map(Result::ok).take(MAX_PIDS) {
        let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let Some(info) = read_proc(proc_dir, pid) else { continue };
        if session_key(pid, info.starttime) != key || !is_agent(&cmdline_args(proc_dir, pid)) { continue; }
        let cwd = fs::read_link(proc_dir.join(pid.to_string()).join("cwd")).ok()
            .filter(|p| p.is_absolute() && p.is_dir() && !p.to_string_lossy().chars().any(char::is_control));
        return Some(SessionProc { pid, cwd });
    }
    None
}

/// `pid` and its ancestors, nearest first; ends at init, a cycle, a vanished parent or `MAX_HOPS`.
pub fn ancestors<T: ProcTable + ?Sized>(proc_dir: &T, pid: u32) -> Vec<ProcInfo> {
    let mut chain: Vec<ProcInfo> = Vec::new();
    let mut current = pid;
    for _ in 0..MAX_HOPS {
        let Some(info) = proc_dir.read(current) else { break };
        let parent = info.ppid;
        let seen = chain.iter().any(|p| p.pid == info.pid);
        if seen { break; }
        chain.push(info);
        if parent <= 1 || chain.iter().any(|p| p.pid == parent) { break; }
        current = parent;
    }
    chain
}
fn comm_matches(comm: &str, list: &[&str]) -> bool {
    let lower = comm.to_lowercase();
    list.iter().any(|e| lower == *e || [format!("{e}-"), format!("{e}_"), format!("{e}.")].iter().any(|p| lower.starts_with(p.as_str())))
}
/// The nearest terminal emulator in a chain.
pub fn terminal_of(chain: &[ProcInfo]) -> Option<&ProcInfo> { terminal_in(chain, TERMINAL_COMMS) }
pub fn terminal_in<'a>(chain: &'a [ProcInfo], list: &[&str]) -> Option<&'a ProcInfo> { chain.iter().find(|p| comm_matches(&p.comm, list)) }

// ---- herdr -----------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HerdrPane { pub pane_id: String, pub tab_id: String, pub workspace_id: String }
/// What herdr itself prints for ids (`w6T:p1`, `wC`): short, alphanumeric plus `:`; never a flag.
pub fn valid_herdr_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_ID && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b':' || b == b'_')
        && s.as_bytes()[0].is_ascii_alphanumeric()
}
fn json(text: Option<String>) -> Option<Value> { serde_json::from_str(&text?).ok() }
fn herdr_pane_of(chain: &[u32], run: &mut dyn FnMut(&[&str]) -> Option<String>) -> Option<HerdrPane> {
    herdr_binding_of(chain, run).map(|(pane, _)| pane)
}
fn herdr_binding_of(chain: &[u32], run: &mut dyn FnMut(&[&str]) -> Option<String>) -> Option<(HerdrPane, u32)> {
    let list = json(run(&["pane", "list"]))?;
    let panes = list.pointer("/result/panes")?.as_array()?;
    for pane in panes.iter().take(MAX_PANES) {
        let field = |k: &str| pane.get(k).and_then(Value::as_str).filter(|v| valid_herdr_id(v)).map(str::to_owned);
        let (Some(pane_id), Some(tab_id), Some(workspace_id)) = (field("pane_id"), field("tab_id"), field("workspace_id")) else { continue };
        let Some(info) = json(run(&["pane", "process-info", "--pane", &pane_id])) else { continue };
        let process = info.pointer("/result/process_info");
        let mut pids: Vec<u64> = process.and_then(|p| p.get("shell_pid")).and_then(Value::as_u64).into_iter().collect();
        pids.extend(process.and_then(|p| p.get("foreground_processes")).and_then(Value::as_array).into_iter().flatten()
            .filter_map(|f| f.get("pid").and_then(Value::as_u64)));
        if let Some(pid) = pids.iter().find_map(|p| chain.iter().find(|c| u64::from(**c) == *p).copied()) {
            return Some((HerdrPane { pane_id, tab_id, workspace_id }, pid));
        }
    }
    None
}
/// The terminal window showing herdr: the nearest terminal above a herdr CLIENT (a `herdr` that is not the server).
/// HERDR MULTI-CLIENT LIMIT: the CLI help and bundled API schema (protocol 22) expose
/// server-owned workspace/tab focus, but no verifiable client PID -> workspace/pane binding.
/// Preserve the sessions lane's existing first-client-in-/proc choice: focus the exact
/// workspace/tab via herdr, then raise that first client's terminal. With several clients
/// this does NOT identify the window originally showing the pane; do not invent a heuristic.
fn herdr_client_terminal(proc_dir: &Path) -> Option<u32> {
    for entry in fs::read_dir(proc_dir).ok()?.filter_map(Result::ok).take(MAX_PIDS) {
        let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let Some(info) = read_proc(proc_dir, pid) else { continue };
        if info.comm != "herdr" || cmdline_args(proc_dir, pid).get(1).is_some_and(|a| a == "server") { continue; }
        if let Some(t) = terminal_of(&ancestors(proc_dir, pid)) { return Some(t.pid); }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan { pub cwd: Option<PathBuf>, pub terminal_pid: Option<u32>, pub herdr: Option<HerdrPane> }

/// Everything Rust can learn about where a session runs. `None` = no such session (caller falls back).
pub fn resolve(proc_dir: &Path, key: &str, herdr: &mut dyn FnMut(&[&str]) -> Option<String>) -> Option<Plan> {
    let session = find_session(proc_dir, key)?;
    let chain = ancestors(proc_dir, session.pid);
    if let Some(t) = terminal_of(&chain) {
        return Some(Plan { cwd: session.cwd, terminal_pid: Some(t.pid), herdr: None });
    }
    if chain.iter().any(|p| p.comm == "herdr") {
        let pids: Vec<u32> = chain.iter().map(|p| p.pid).collect();
        let pane = herdr_pane_of(&pids, herdr);
        let terminal_pid = pane.as_ref().and_then(|_| herdr_client_terminal(proc_dir));
        return Some(Plan { cwd: session.cwd, terminal_pid, herdr: pane });
    }
    Some(Plan { cwd: session.cwd, terminal_pid: None, herdr: None })
}

// ---- the effect ------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Raise {
    /// The window was brought to the front.
    Raised,
    /// The terminal process has no window at all (nothing to raise).
    NoWindow,
    /// A window may exist but this desktop gave us no way to raise it.
    Unreachable,
}
/// Focus the herdr workspace + tab, raise the terminal window, and launch ONLY when the session has no terminal
/// to show. `herdr` runs a mutating-but-safe focus command (fixed argv, validated ids) and says whether it worked;
/// a failure there never stops the window from being raised.
pub fn apply(
    plan: &Plan,
    herdr: &mut dyn FnMut(&[&str]) -> bool,
    raise: &mut dyn FnMut(u32) -> Raise,
    launch: &mut dyn FnMut(Option<&Path>) -> Result<(), String>,
) -> Result<(), String> {
    if let Some(pane) = &plan.herdr {
        let _ = herdr(&["workspace", "focus", &pane.workspace_id]);
        let _ = herdr(&["tab", "focus", &pane.tab_id]);
    }
    if let Some(pid) = plan.terminal_pid {
        match raise(pid) {
            Raise::Raised => return Ok(()),
            Raise::Unreachable => return Err(CANNOT_RAISE_REASON.to_string()),
            Raise::NoWindow => {}
        }
    }
    launch(plan.cwd.as_deref())
}

// ---- real effects (Linux) --------------------------------------------------------------------------------

/// The closed `org.freedesktop.Application` name of a terminal PROCESS, for terminals that own one. Only an
/// already-running owner is ever called (never activation of a name nobody owns).
pub fn dbus_app_name(comm: &str) -> Option<&'static str> {
    const TABLE: &[(&str, &str)] = &[
        ("ghostty", "com.mitchellh.ghostty"), ("ptyxis", "org.gnome.Ptyxis"), ("kgx", "org.gnome.Console"),
        ("gnome-terminal", "org.gnome.Terminal"), ("blackbox", "com.raggesilver.BlackBox"),
        ("foot", "org.codeberg.dnkl.foot"), ("konsole", "org.kde.konsole"), ("wezterm", "org.wezfurlong.wezterm"),
    ];
    TABLE.iter().find(|(c, _)| comm_matches(comm, &[c])).map(|(_, n)| *n)
}

/// The only herdr invocations Abito ever makes: two read-only queries and two focus verbs, with validated ids.
pub fn herdr_argv_allowed(args: &[&str]) -> bool {
    match args {
        ["pane", "list"] => true,
        ["pane", "process-info", "--pane", id] | ["workspace", "focus", id] | ["tab", "focus", id] => valid_herdr_id(id),
        _ => false,
    }
}

/// Run a command to completion within `deadline`, returning stdout only when it exited successfully. A command
/// that outlives the deadline is killed. Never a shell; stdin closed; stderr dropped.
pub fn run_with_deadline(program: &str, args: &[&str], deadline: std::time::Duration) -> Option<String> {
    use std::io::Read;
    let mut child = std::process::Command::new(program).args(args)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null())
        .spawn().ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || { let mut text = String::new(); let _ = out.by_ref().take(1 << 20).read_to_string(&mut text); text });
    let began = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if began.elapsed() < deadline => std::thread::sleep(std::time::Duration::from_millis(10)),
            _ => { let _ = child.kill(); let _ = child.wait(); break None; }
        }
    };
    let text = reader.join().ok()?;
    status.filter(|s| s.success()).map(|_| text)
}

#[cfg(target_os = "linux")]
fn herdr_binary() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    std::env::var_os("PATH").iter().flat_map(std::env::split_paths).chain(home.map(|h| h.join(".local/bin")))
        .map(|d| d.join("herdr")).find(|p| p.is_file())
}

/// The runner behind `resolve` / `apply`: herdr's own CLI over its socket, fixed argv, 2 s deadline.
#[cfg(target_os = "linux")]
fn herdr_run(args: &[&str]) -> Option<String> {
    herdr_run_with_budget(args, std::time::Duration::from_secs(2))
}
#[cfg(target_os = "linux")]
fn herdr_run_with_budget(args: &[&str], remaining: std::time::Duration) -> Option<String> {
    if remaining.is_zero() || !herdr_argv_allowed(args) { return None; }
    let deadline = std::time::Instant::now() + remaining;
    let bin = herdr_binary()?;
    let left = deadline.checked_duration_since(std::time::Instant::now())?;
    if left.is_zero() { return None; }
    run_with_deadline(bin.to_str()?, args, left.min(ORIGIN_RESOLUTION_BUDGET))
}

/// Bring a terminal process's window to the front. Ordered, each step honest about what it can know:
/// 1. X11 / XWayland: the window whose `_NET_WM_PID` is the terminal (EWMH `_NET_ACTIVE_WINDOW`);
/// 2. Abito's GNOME Shell extension, if installed: `ActivateByPid` (the only way to raise a NATIVE Wayland window
///    by process on GNOME; the shell refuses `FocusApp`/`Eval` to other clients);
/// 3. the terminal's own `org.freedesktop.Application.Activate`, only when its bus name already has an owner.
/// Step 3 asks the application to present itself; GNOME's focus-stealing prevention may turn that into a
/// «ready» notification instead of a raise, and nothing can observe which happened: that is the one place this
/// reports `Raised` without proof.
#[cfg(target_os = "linux")]
fn raise_terminal(pid: u32, comm: &str) -> Raise {
    if crate::focushost::raise_x11_window_of_pid(pid) { return Raise::Raised; }
    if dbus_activate_by_pid(pid) { return Raise::Raised; }
    if let Some(name) = dbus_app_name(comm) { if dbus_activate_app(name) { return Raise::Raised; } }
    Raise::Unreachable
}

#[cfg(target_os = "linux")]
fn with_session_bus<T: Send + 'static>(work: impl FnOnce(&zbus::blocking::Connection) -> Option<T> + Send + 'static) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || { let _ = tx.send(zbus::blocking::Connection::session().ok().and_then(|c| work(&c))); });
    rx.recv_timeout(std::time::Duration::from_secs(2)).ok().flatten()
}
#[cfg(target_os = "linux")]
fn has_owner(conn: &zbus::blocking::Connection, name: &str) -> bool {
    zbus::blocking::fdo::DBusProxy::new(conn).ok()
        .and_then(|b| zbus::names::BusName::try_from(name).ok().and_then(|n| b.name_has_owner(n).ok())).unwrap_or(false)
}
#[cfg(target_os = "linux")]
fn dbus_activate_by_pid(pid: u32) -> bool {
    with_session_bus(move |conn| {
        if !has_owner(conn, crate::contextwin::BUS_NAME) { return None; }
        let proxy = zbus::blocking::Proxy::new(conn, crate::contextwin::BUS_NAME, crate::contextwin::OBJECT_PATH, crate::contextwin::INTERFACE).ok()?;
        proxy.call::<_, _, bool>("ActivateByPid", &(pid,)).ok()
    }).unwrap_or(false)
}
#[cfg(target_os = "linux")]
fn dbus_activate_app(name: &'static str) -> bool {
    with_session_bus(move |conn| {
        if !has_owner(conn, name) { return None; }
        let path = format!("/{}", name.replace('.', "/"));
        let proxy = zbus::blocking::Proxy::new(conn, name, path, "org.freedesktop.Application").ok()?;
        let platform: std::collections::HashMap<&str, zbus::zvariant::Value<'_>> = std::collections::HashMap::new();
        proxy.call::<_, _, ()>("Activate", &(platform,)).ok().map(|_| true)
    }).unwrap_or(false)
}

/// The full flow for a session key: resolve in /proc, focus herdr's pane, raise the window, and launch the
/// user's default terminal in the session's directory ONLY if that session has no terminal at all.
/// `None` = the key names no session Rust can find (the caller takes the old path).
#[cfg(target_os = "linux")]
pub fn focus_session(key: &str) -> Option<Result<(), String>> {
    let proc_dir = Path::new("/proc");
    let plan = resolve(proc_dir, key, &mut |args| herdr_run(args))?;
    let comm = plan.terminal_pid.and_then(|p| read_proc(proc_dir, p)).map(|i| i.comm).unwrap_or_default();
    Some(apply(&plan,
        &mut |args| herdr_run(args).is_some(),
        &mut |pid| raise_terminal(pid, &comm),
        &mut |cwd| crate::focushost::launch_terminal(cwd.map(Path::to_path_buf))))
}
#[cfg(not(target_os = "linux"))]
pub fn focus_session(_key: &str) -> Option<Result<(), String>> { None }

// ---- retained socket origins (host only) ----------------------------------------------------------------

pub const ORIGIN_UNKNOWN: &str = "No sé cuál terminal es.";
pub const ORIGIN_GONE: &str = "Esa terminal ya no está.";
/// Host-only process identities. Deliberately not serializable/deserializable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    anchor: ProcInfo,
    terminal: Option<ProcInfo>,
    pane: Option<HerdrPane>,
}
/// One total budget for all origin queries, rather than two seconds for each pane.
pub const ORIGIN_RESOLUTION_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);
/// Resolve while the socket peer still exists, never from an identity supplied by the page/wire.
/// Compatibility seam for immediate fake runners; production uses the deadline-aware runner below.
pub fn capture_origin<T: ProcTable + ?Sized>(proc_dir: &T, peer: &ProcInfo,
    herdr: &mut dyn FnMut(&[&str]) -> Option<String>) -> Option<Origin> {
    capture_origin_with_budget(proc_dir, peer, ORIGIN_RESOLUTION_BUDGET, &mut |args, _| herdr(args))
}
fn capture_origin_unbounded<T: ProcTable + ?Sized>(proc_dir: &T, peer: &ProcInfo,
    herdr: &mut dyn FnMut(&[&str]) -> Option<String>) -> Option<Origin> {
    let chain = ancestors(proc_dir, peer.pid);
    if !chain.first().is_some_and(|p| p.pid == peer.pid && p.starttime == peer.starttime) { return None; }
    // /proc is not an atomic snapshot: a parent read after it exited may already be a new process.
    if chain.windows(2).any(|pair| pair[1].starttime > pair[0].starttime) { return None; }
    if let Some(t) = chain.iter().find(|p| proc_dir.is_terminal(p) && proc_dir.hosts_window(p.pid)) {
        return Some(Origin { anchor: t.clone(), terminal: Some(t.clone()), pane: None });
    }
    if !chain.iter().any(|p| p.comm == "herdr") { return None; }
    // Prefer the pane's persistent shell, not the short-lived foreground hook.
    let (pane, anchor_pid) = herdr_binding_of(&chain.iter().map(|p| p.pid).collect::<Vec<_>>(), herdr)?;
    let anchor = chain.iter().find(|p| p.pid == anchor_pid)?.clone();
    let terminal = proc_dir.herdr_client_terminal().and_then(|pid| proc_dir.read(pid));
    Some(Origin { anchor, terminal, pane: Some(pane) })
}
fn same_process<T: ProcTable + ?Sized>(proc_dir: &T, saved: &ProcInfo) -> Option<ProcInfo> {
    proc_dir.read(saved.pid).filter(|p| p.starttime == saved.starttime)
}
/// Revalidate immediately before the existing apply ladder. The launch callback is a refusal,
/// not an effect: origin requests can NEVER spawn, even if apply finds no window.
pub fn focus_origin_with<T: ProcTable + ?Sized>(proc_dir: &T, origin: &Origin,
    herdr: &mut dyn FnMut(&[&str]) -> Option<String>,
    raise: &mut dyn FnMut(u32) -> Raise) -> Result<(), String> {
    let gone = || ORIGIN_GONE.to_string();
    let anchor = same_process(proc_dir, &origin.anchor).ok_or_else(gone)?;
    if let Some(pane) = &origin.pane {
        let chain = ancestors(proc_dir, anchor.pid);
        if !chain.iter().any(|p| p.comm == "herdr") { return Err(gone()); }
        // Query this exact persistent anchor again: a replaced/reassigned pane is not our pane.
        if herdr_pane_of(&[anchor.pid], herdr).as_ref() != Some(pane) { return Err(gone()); }
    } else if !proc_dir.is_terminal(&anchor) { return Err(gone()); }
    let terminal = match &origin.terminal {
        Some(saved) => {
            let current = same_process(proc_dir, saved).ok_or_else(gone)?;
            if !proc_dir.is_terminal(&current) { return Err(gone()); }
            Some(current.pid)
        }
        None => None,
    };
    let plan = Plan { cwd: None, terminal_pid: terminal, herdr: origin.pane.clone() };
    apply(&plan, &mut |args| herdr(args).is_some(), raise, &mut |_| Err(gone()))
}
#[cfg(target_os = "linux")]
pub fn capture_peer_origin(peer: &ProcInfo) -> Option<Origin> {
    capture_origin_with_budget(Path::new("/proc"), peer, ORIGIN_RESOLUTION_BUDGET, &mut herdr_run_with_budget)
}
#[cfg(target_os = "macos")]
pub fn capture_peer_origin(peer: &ProcInfo) -> Option<Origin> {
    capture_origin_with_budget(&crate::sessionterm_mac::MacProcs, peer, ORIGIN_RESOLUTION_BUDGET, &mut |_, _| None)
}
#[cfg(windows)]
pub fn capture_peer_origin(peer: &ProcInfo) -> Option<Origin> {
    capture_origin_with_budget(&crate::sessionterm_win::WinProcs, peer, ORIGIN_RESOLUTION_BUDGET, &mut |_, _| None)
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn capture_peer_origin(_peer: &ProcInfo) -> Option<Origin> { None }
/// The kernel peer's birth identity, read from this OS's process table (never from the wire).
pub fn read_peer(pid: u32) -> Option<ProcInfo> {
    #[cfg(target_os = "linux")] { read_proc(Path::new("/proc"), pid) }
    #[cfg(target_os = "macos")] { crate::sessionterm_mac::MacProcs.read(pid) }
    #[cfg(windows)] { crate::sessionterm_win::WinProcs.read(pid) }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))] { let _ = pid; None }
}
#[cfg(target_os = "linux")]
pub fn focus_origin(origin: &Origin) -> Result<(), String> {
    let root = Path::new("/proc");
    focus_origin_with(root, origin, &mut herdr_run, &mut |pid| {
        // Recheck at the effect boundary as well, after the read-only herdr queries.
        let Some(saved) = origin.terminal.as_ref().filter(|t| t.pid == pid) else { return Raise::NoWindow; };
        let Some(current) = same_process(root, saved) else { return Raise::NoWindow; };
        if terminal_of(std::slice::from_ref(&current)).is_none() { return Raise::NoWindow; }
        raise_terminal(pid, &current.comm)
    })
}
/// The effect-boundary recheck, shared by every OS and by the fake-table tests: the pid being raised is the saved
/// terminal, still the same process (birth identity), and still a terminal.
pub fn boundary_ok<T: ProcTable + ?Sized>(table: &T, origin: &Origin, pid: u32) -> bool {
    let Some(saved) = origin.terminal.as_ref().filter(|t| t.pid == pid) else { return false };
    same_process(table, saved).is_some_and(|current| table.is_terminal(&current))
}

/// macOS: bring the terminal APP forward (tab-level needs Automation/Accessibility, which Abito never asks for).
#[cfg(target_os = "macos")]
pub fn focus_origin(origin: &Origin) -> Result<(), String> {
    let table = crate::sessionterm_mac::MacProcs;
    focus_origin_with(&table, origin, &mut |_| None, &mut |pid| {
        if !boundary_ok(&table, origin, pid) { return Raise::NoWindow; }
        // The same check runs again on the main thread, right before the activation.
        let saved = origin.clone();
        crate::sessionterm_mac::raise_app(pid, move || boundary_ok(&crate::sessionterm_mac::MacProcs, &saved, pid))
    })
    // The app is in front, but the exact tab cannot be chosen without a permission Abito never asks for.
    .and_then(|()| Err(CANNOT_RAISE_REASON_MAC.to_string()))
}
#[cfg(windows)]
pub fn focus_origin(origin: &Origin) -> Result<(), String> {
    let table = crate::sessionterm_win::WinProcs;
    let mut several = false;
    let result = focus_origin_with(&table, origin, &mut |_| None, &mut |pid| {
        if !boundary_ok(&table, origin, pid) { return Raise::NoWindow; }
        let (raise, windows) = crate::sessionterm_win::raise_window_of(pid);
        several = windows > 1;
        raise
    });
    // One process, several windows: the right one cannot be told apart, so say so instead of claiming it.
    if result.is_ok() && several { Err(CANNOT_RAISE_REASON_WIN.to_string()) } else { result }
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn focus_origin(_origin: &Origin) -> Result<(), String> { Err(ORIGIN_UNKNOWN.into()) }

/// Injectable deadline-aware origin runner; each call receives only the remaining total budget.
pub fn capture_origin_with_budget<T: ProcTable + ?Sized>(proc_dir: &T, peer: &ProcInfo, budget: std::time::Duration,
    herdr: &mut dyn FnMut(&[&str], std::time::Duration) -> Option<String>) -> Option<Origin> {
    let deadline = std::time::Instant::now() + budget;
    let origin = capture_origin_unbounded(proc_dir, peer, &mut |args| {
        let remaining = deadline.checked_duration_since(std::time::Instant::now())?;
        if remaining.is_zero() { return None; }
        // The production runner enforces THIS remaining budget on the subprocess, not
        // a fresh two seconds for every pane. Fakes must honor the same runner contract.
        let answer = herdr(args, remaining);
        (std::time::Instant::now() < deadline).then_some(answer).flatten()
    });
    if std::time::Instant::now() >= deadline { None } else { origin }
}

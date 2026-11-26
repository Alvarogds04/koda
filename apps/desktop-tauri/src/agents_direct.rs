//! HU-015 — the daemon-free route for ALL Ajustes → Agentes hook reads and mutations.
//!
//! The hook installer used to run only THROUGH the chat engine (the daemon), which needs Pi: with no Pi (or no
//! daemon) Claude Code and Codex could not be installed and the whole list read «Falta Pi». Now `agent_action`
//! takes `agents_list`, `hooks_preview`, `agent_connect` and `agent_disconnect` HERE, whether the daemon is up or
//! down, so there is exactly ONE owner of those operations (no daemon/direct race): the page never asks the engine.
//!
//! K3-09 M1 (S1): the entry this host runs is the ENGINE's (`jesscore`), not a Koda copy. `engine/docs/PROTOCOL.md`
//! («Engine locator and island directory») fixes where it lives, and everything here is derived from that one root:
//! `<lib>` = `ABITO_ENGINE_DIR` when it is an absolute path, else `<home>/.local/lib/abito-core`; node is
//! `<lib>/runtime/node` (never PATH's node); the entry is `<lib>/engine/src/agents-direct.cjs` (never a path from the
//! CWD, the page, PATH or the engine's own environment). The engine derives its own hooks installer from its own
//! location (`<lib>/engine/harness/bin/abito-hook.cjs`), so Koda passes none.
//!
//! No installer logic lives here. The engine entry drives its own `AgentsManager` (preview → human confirm → plan-hash
//! check → backup → apply, audit) and prints the same two closed one-line JSON frames as before (`{agents,hooks}`).
//! Rust keeps the same defences: no shell; cleared environment; stdin closed; bounded time and output; unix process
//! group killed whole on timeout. The page only sends the closed `parse_ui_command` grammar.
//!
//! The ONE rule the engine does not have is Koda's K-F Pi policy (PROTOCOL.md, «Pi policy»), so it is enforced HERE
//! while the switch is off — see [`force_pi_row`]. It is retired together with that switch (AC-08b).
use crate::agentclient::{fold_direct, parse_ui_command, CommandError, UiCommand};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A whole operation: the entry runs ~7 installer previews and, for a change, a preview + apply, each capped at
/// 10 s inside AgentsManager. The page waits at most this long, then reads «No se pudo», never hangs.
pub const TIMEOUT: Duration = Duration::from_secs(60);
/// Answer cap: two closed frames are a few KiB; anything bigger is garbage and is discarded.
pub const MAX_OUTPUT: usize = 512 * 1024;
const LIST_CACHE: Duration = Duration::from_millis(1500);
/// The one reason a Pi row can carry on this route while the legacy install is retired (K-F). The page already knows
/// this word (`frontend/settings-view.js`, `AGENT_ERRORS.legacy_pi_extension_off`); nothing new is invented here.
const PI_OFF: &str = "legacy_pi_extension_off";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectOp {
    List,
    Connect { id: String, plan_hash: Option<String> },
    Disconnect { id: String },
}
impl DirectOp {
    pub fn mutates(&self) -> bool {
        !matches!(self, DirectOp::List)
    }
    /// Is this operation about the Pi ROW? That row is the only one whose install Koda's K-F switch owns (see
    /// [`force_pi_row`]); every other agent is the engine's business.
    pub fn targets_pi(&self) -> bool {
        match self {
            DirectOp::List => false,
            DirectOp::Connect { id, .. } | DirectOp::Disconnect { id } => id == "pi",
        }
    }
    /// The closed argv grammar of the engine's `agents-direct.cjs` (it re-validates every word).
    pub fn args(&self) -> Vec<String> {
        match self {
            DirectOp::List => vec!["list".into()],
            DirectOp::Connect { id, plan_hash: None } => vec!["connect".into(), id.clone()],
            DirectOp::Connect { id, plan_hash: Some(h) } => vec!["connect".into(), id.clone(), h.clone()],
            DirectOp::Disconnect { id } => vec!["disconnect".into(), id.clone()],
        }
    }
}

/// `None`: not one of the four agent actions (the engine path keeps it). `Some(Err)`: ours but invalid.
/// Validation is the EXISTING closed grammar (`parse_ui_command`: allowlisted id, 64-hex hash, exact fields).
pub fn parse(payload: &Value) -> Option<Result<DirectOp, CommandError>> {
    let action = payload.get("action").and_then(Value::as_str)?;
    if !matches!(action, "agents_list" | "hooks_preview" | "agent_connect" | "agent_disconnect") {
        return None;
    }
    let checked = parse_ui_command(payload).map(|c| matches!(c, UiCommand::Wire(_)));
    if checked != Ok(true) || (action == "agent_connect" && payload.get("plan_hash").is_none()) {
        return Some(Err(CommandError));
    }
    let text = |k: &str| payload.get(k).and_then(Value::as_str).map(str::to_owned);
    Some(match action {
        "agent_connect" => text("agentId").map(|id| DirectOp::Connect { id, plan_hash: text("plan_hash") }).ok_or(CommandError),
        "agent_disconnect" => text("agentId").map(|id| DirectOp::Disconnect { id }).ok_or(CommandError),
        _ => Ok(DirectOp::List),
    })
}

/// The engine's install root `<lib>` — the directory that holds `engine/` and `runtime/` (PROTOCOL.md, «Engine locator
/// and island directory»). `ABITO_ENGINE_DIR` wins when it is an ABSOLUTE path; a relative or empty value is IGNORED and
/// the documented default prefix (`<home>/.local/lib/abito-core`) is used instead, because resolving it against the CWD
/// is exactly the path-from-outside hole this module closes. `None` = no engine to run (the page then reads a closed
/// `agentsRuntime` value; nothing is guessed).
pub fn install_root(engine_dir: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = engine_dir.filter(|d| d.is_absolute()) {
        return Some(dir.to_path_buf());
    }
    home.map(|h| h.join(".local").join("lib").join("abito-core"))
}

/// The node the engine ships: `<lib>/runtime/node`. Never PATH, never the app's own runtime discovery.
pub fn runtime_node(lib: &Path) -> PathBuf {
    lib.join("runtime").join(format!("node{}", std::env::consts::EXE_SUFFIX))
}

/// The engine's daemon-free entry: `<lib>/engine/src/agents-direct.cjs`.
pub fn direct_script(lib: &Path) -> PathBuf {
    lib.join("engine").join("src").join("agents-direct.cjs")
}

/// What a run needs. `node: None` = the engine's runtime is not there (or no engine at all).
pub struct Runtime {
    pub node: Option<PathBuf>,
    pub script: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    /// Koda's K-F switch, resolved ONCE when the runtime is built (`crate::legacy_pi_extension_enabled`). OFF (the
    /// default) means the retired Pi extension install is never touched — see [`force_pi_row`].
    pub legacy_pi: bool,
}

/// One variable in the closed allowlist: last value wins, never two entries for the same name.
fn keep_env(env: &mut Vec<(String, String)>, key: &str, value: &str) {
    match env.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = value.to_owned(),
        None => env.push((key.to_owned(), value.to_owned())),
    }
}

/// [`runtime`] from explicit inputs: the engine override, the home the ENGINE reads, and the K-F switch. `runtime()`
/// passes the process's own; tests pass their own, so nobody has to mutate the process environment to pin the locator.
pub fn runtime_at(engine_dir: Option<&Path>, home: Option<&Path>, legacy_pi: bool) -> Runtime {
    let lib = install_root(engine_dir, home);
    let node = lib.as_deref().map(runtime_node).filter(|p| p.is_file());
    let script = lib.as_deref().map(direct_script).filter(|p| p.is_file());
    let mut env: Vec<(String, String)> = Vec::new();
    #[allow(unused_mut)]
    let mut keep = vec!["HOME", "LANG"];
    #[cfg(windows)]
    keep.extend(["USERPROFILE", "SYSTEMROOT", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA"]);
    for key in keep {
        if let Ok(v) = std::env::var(key) {
            if !v.is_empty() {
                env.push((key.into(), v));
            }
        }
    }
    let home = home.and_then(|h| h.to_str()).filter(|h| !h.is_empty());
    // The child's HOME must be the home the locator (and the island dir) used: on this machine they are the same value,
    // and with an explicit home no test or caller can make the engine read somebody else's `~/.pi` or `~/.claude`.
    if let Some(home) = home {
        keep_env(&mut env, "HOME", home);
    }
    let island = crate::agentconn::island_root_from_env(home);
    if let Some(dir) = island.and_then(|d| d.to_str().map(str::to_owned)) {
        env.push(("KODA_ISLAND_DIR".into(), dir));
    }
    // AC-08/K-F (S2, S6): the switch is forwarded — only while it is ON, which keeps the allowlist above exactly as closed
    // as it was (off is the ABSENCE of the variable, not a value somebody could flip). The engine does not read it; it is
    // kept because the installer that K-F owns still does, and because ON is the path that must stay reachable.
    if legacy_pi {
        env.push((crate::LEGACY_PI_EXTENSION_ENV.into(), "1".into()));
    }
    Runtime { node, script, env, legacy_pi }
}

/// The runtime the app runs with, from the real process environment.
pub fn runtime() -> Runtime {
    #[cfg(windows)]
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    let engine_dir = std::env::var_os("ABITO_ENGINE_DIR").map(PathBuf::from);
    runtime_at(engine_dir.as_deref(), home.as_deref().map(Path::new), crate::legacy_pi_extension_enabled())
}

#[derive(Debug, PartialEq, Eq)]
pub struct RunFailure;

/// After the direct child has exited, how long a descendant may still hold the stdout pipe open before the whole
/// tree is killed and the run reads as failed (a clean run closes the pipe with its process).
const PIPE_GRACE: Duration = Duration::from_millis(400);

/// Kill the private process group, then reap within a deadline. On Windows the caller first closes
/// the kill-on-close Job Object; no external cleanup process or blocking wait is used.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    let _ = child.kill();
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() { break; }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Enforce the cap at the read boundary, not in a queue consumer. Only one overflow sentinel byte
/// is read beyond the cap; storage stays bounded even if the producer floods stdout.
fn read_capped(reader: &mut impl Read, cap: usize) -> Result<Vec<u8>, RunFailure> {
    let mut out = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let limit = chunk.len().min(cap.saturating_sub(out.len()).saturating_add(1));
        let n = match reader.read(&mut chunk[..limit]) {
            Ok(0) => return Ok(out),
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(RunFailure),
        };
        if n > cap.saturating_sub(out.len()) { return Err(RunFailure); }
        out.extend_from_slice(&chunk[..n]);
    }
}

/// Spawn without a shell, stdin closed, stderr discarded, ONLY `env`, wait at most `limit`, keep at most `cap`
/// bytes of stdout. Success = the child exited 0 AND closed stdout (EOF) within the limit. A timeout, an oversize
/// answer, a non-zero exit, or a descendant that keeps the pipe after the child exited kills the whole tree and
/// fails. Cleanup adds at most one second of bounded reaping; the reader thread is never joined.
pub fn run_bounded(program: &Path, args: &[String], env: &[(String, String)], limit: Duration, cap: usize) -> Result<Vec<u8>, RunFailure> {
    run_bounded_in(program, args, env, None, limit, cap)
}
/// [`run_bounded`] in a chosen working directory (`None` = the app's own). HU-046: npm reads project config from its working
/// directory, so the installer runs it somewhere the user owns instead of wherever the app happened to be launched.
pub fn run_bounded_in(program: &Path, args: &[String], env: &[(String, String)], cwd: Option<&Path>, limit: Duration, cap: usize) -> Result<Vec<u8>, RunFailure> {
    use std::sync::mpsc::{sync_channel, RecvTimeoutError};
    let mut command = Command::new(program);
    if let Some(dir) = cwd { command.current_dir(dir); }
    command.args(args).env_clear().envs(env.iter().map(|(k, v)| (k, v))).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    let (mut child, job) = crate::daemonhost::spawn_in_job(command).map_err(|_| RunFailure)?;
    #[cfg(windows)]
    let mut job = Some(job);
    #[cfg(not(windows))]
    let mut child = command.spawn().map_err(|_| RunFailure)?;
    #[allow(unused_mut)]
    let mut cleanup = |child: &mut std::process::Child| {
        #[cfg(windows)]
        drop(job.take());
        kill_tree(child);
    };
    let Some(mut stdout) = child.stdout.take() else {
        cleanup(&mut child);
        return Err(RunFailure);
    };
    // One bounded result, never an unbounded stream of allocated chunks.
    let (tx, rx) = sync_channel(1);
    std::thread::spawn(move || {
        let _ = tx.send(read_capped(&mut stdout, cap));
    });
    let started = Instant::now();
    let mut out: Vec<u8> = Vec::new();
    let mut eof = false;
    let mut exited: Option<(std::process::ExitStatus, Instant)> = None;
    loop {
        if !eof {
            match rx.recv_timeout(Duration::from_millis(10)) {
                Ok(Ok(bytes)) => { out = bytes; eof = true; }
                Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => {
                    cleanup(&mut child);
                    return Err(RunFailure);
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        } else {
            std::thread::sleep(Duration::from_millis(10));
        }
        if exited.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => exited = Some((status, Instant::now())),
                Ok(None) => {}
                Err(_) => {
                    cleanup(&mut child);
                    return Err(RunFailure);
                }
            }
        }
        if let Some((status, _)) = exited {
            if eof {
                // Also clean up descendants that closed stdout but outlived the operation.
                cleanup(&mut child);
                return if status.success() { Ok(out) } else { Err(RunFailure) };
            }
        }
        let expired = started.elapsed() >= limit || exited.is_some_and(|(_, at)| at.elapsed() >= PIPE_GRACE);
        if expired {
            cleanup(&mut child);
            return Err(RunFailure);
        }
    }
}

/// Serialises every operation (one owner, no two writers racing) and holds the last list for a moment so the
/// page's `agents_list` + `hooks_preview` pair costs one run. A mutation always runs and drops the cache.
pub struct Gate(Mutex<Option<(Instant, Value)>>);
impl Gate {
    pub const fn new() -> Self {
        Gate(Mutex::new(None))
    }
}
impl Default for Gate {
    fn default() -> Self {
        Self::new()
    }
}
pub static GATE: Gate = Gate::new();

fn runtime_view(kind: &str) -> Value {
    json!({"agentsRuntime": kind, "directAgents": [], "directHooks": []})
}

/// K3-09 M1 — K-F in Rust. The engine has NO Pi policy (PROTOCOL.md, «Pi policy»), so while the switch is OFF the Pi
/// row is the one the retired Koda manager published: `unavailable` with its own reason, no backup, and no plan — a
/// disabled row can never offer «Agregar hooks»/«Reintentar» for `~/.pi/agent/extensions/koda-island`. Left alone, the
/// engine's row reads `error`/`install_failed` and the page would offer that install as a retry. The row is REPLACED
/// field by field from the closed vocabulary the page already knows; nothing is invented and no other row is touched.
/// A frame that does not name Pi is left exactly as it is (this adds no row the engine did not send).
///
/// K3-09 M1 note (human decision, 25 Nov): keep the switch and this shim until AC-08b replaces the legacy
/// `abito-island` Pi extension with `abito-pi`.
fn force_pi_row(view: &mut Value) {
    let Some(rows) = view.get_mut("directAgents").and_then(Value::as_array_mut) else { return };
    let Some(slot) = rows.iter_mut().find(|r| r.get("id").and_then(Value::as_str) == Some("pi")) else { return };
    *slot = json!({
        "id": "pi", "state": "unavailable", "backup": false, "detail": PI_OFF,
        "plan_hash": Value::Null, "summary": Value::Null, "reviewable": true, "trust_review": false,
    });
}

/// Never fails: a missing engine (no `<lib>/runtime/node` or no entry) or a failed run is a closed `agentsRuntime` value
/// the page renders PER ROW.
pub fn perform_with(gate: &Gate, op: &DirectOp, rt: &Runtime) -> Value {
    let mut slot = gate.0.lock().unwrap_or_else(|p| p.into_inner());
    // K3-09 M1 — K-F shim (retirar con AC-08b (abito-island -> abito-pi)): with the switch OFF a `pi` mutation runs
    // NOTHING at all — no node, no engine, no installer — because the engine has no Pi policy and would preview (or
    // apply) the retired folder. The answer is the last table the page already shows, with the Pi row disabled; the page
    // asks `agents_list` before it renders any row, so that table exists. Nothing else is muted: every other agent is
    // a real operation on this same route.
    if !rt.legacy_pi && op.targets_pi() {
        let mut view = slot.as_ref().map(|(_, view)| view.clone()).unwrap_or_else(|| runtime_view("ok"));
        force_pi_row(&mut view);
        return view;
    }
    if !op.mutates() {
        if let Some((at, view)) = slot.as_ref() {
            if at.elapsed() < LIST_CACHE {
                return view.clone();
            }
        }
    }
    *slot = None;
    let Some(node) = rt.node.as_deref() else { return runtime_view("node_missing") };
    let Some(script) = rt.script.as_deref() else { return runtime_view("failed") };
    let mut args = vec![script.to_string_lossy().into_owned()];
    args.extend(op.args());
    let folded = run_bounded(node, &args, &rt.env, TIMEOUT, MAX_OUTPUT)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|answer| fold_direct(&answer));
    match folded {
        Some(mut view) => {
            if !rt.legacy_pi {
                force_pi_row(&mut view);
            }
            *slot = Some((Instant::now(), view.clone()));
            view
        }
        None => runtime_view("failed"),
    }
}

pub fn perform(op: &DirectOp) -> Value {
    perform_with(&GATE, op, &runtime())
}

#[cfg(test)]
#[path = "agents_direct_tests.rs"]
mod tests;

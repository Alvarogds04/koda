//! HU-015 — the daemon-free route for ALL Ajustes → Agentes hook reads and mutations.
//!
//! The hook installer used to run only THROUGH the chat engine (the daemon), which needs Pi: with no Pi (or no
//! daemon) Claude Code and Codex could not be installed and the whole list read «Falta Pi». Now `agent_action`
//! takes `agents_list`, `hooks_preview`, `agent_connect` and `agent_disconnect` HERE, whether the daemon is up or
//! down, so there is exactly ONE owner of those operations (no daemon/direct race): the page never asks the engine.
//!
//! No installer logic lives here. Rust runs the bundled `desktop-daemon/src/agents-direct.cjs` with node, which
//! drives the SAME `AgentsManager` (preview → human confirm → plan-hash check → backup → apply, audit) the daemon
//! used. Trust: node comes from `daemonhost::discover("node")` (session PATH absolute entries + canonical
//! locations, never CWD); the script is the one beside the installed daemon (`installed_daemon_cli` layout), never
//! a path from the page, PATH or env; no shell; cleared environment; stdin closed; bounded time and output;
//! unix process group killed whole on timeout. The page only sends the closed `parse_ui_command` grammar.
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
    /// The closed argv grammar of `agents-direct.cjs` (it re-validates every word).
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

/// `agents-direct.cjs` beside the installed daemon's `cli.cjs` (same layout the daemon launch uses).
pub fn script_beside(exe: &Path) -> Option<PathBuf> {
    crate::daemonhost::installed_daemon_cli(exe).map(|cli| cli.with_file_name("agents-direct.cjs"))
}

/// What a run needs. `node: None` = Node.js not found.
pub struct Runtime {
    pub node: Option<PathBuf>,
    pub script: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

/// Resolves node and the script the same way the daemon launch does, from the real process environment.
pub fn runtime() -> Runtime {
    let path = std::env::var_os("PATH");
    #[cfg(windows)]
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    let node = crate::daemonhost::discover("node", path.as_deref(), home.as_deref()).ok();
    let script = std::env::current_exe().ok().and_then(|exe| {
        #[allow(unused_mut)]
        let mut script = script_beside(&exe)?;
        #[cfg(debug_assertions)]
        if !script.is_file() {
            script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../desktop-daemon/src/agents-direct.cjs");
        }
        script.is_file().then_some(script)
    });
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
    let island = crate::agentconn::island_root(
        std::env::var("ABITO_ISLAND_DIR").ok().as_deref(),
        home.as_deref().and_then(|h| h.to_str()),
    );
    if let Some(dir) = island.and_then(|d| d.to_str().map(str::to_owned)) {
        env.push(("ABITO_ISLAND_DIR".into(), dir));
    }
    Runtime { node, script, env }
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

/// Never fails: a missing Node.js / a failed run is a closed `agentsRuntime` value the page renders PER ROW.
pub fn perform_with(gate: &Gate, op: &DirectOp, rt: &Runtime) -> Value {
    let mut slot = gate.0.lock().unwrap_or_else(|p| p.into_inner());
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
        Some(view) => {
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

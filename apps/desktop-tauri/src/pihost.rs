//! HU-046 host side of «Instalar Pi» (human, verbatim option chosen: «Botón «Instalar Pi» (recomendado)»). The closed command
//! `pi_install_action {action:"status"|"run"}` is reachable from Ajustes (main + settings labels, same sender rule as
//! `daemon_action`). `run` answers at once with `phase:"running"` and does the work on a background thread: the page learns the end
//! through the `pi-install:state` event (and can read `status`), so no command is held for minutes. What is executed lives in
//! `abito_island::piinstall` and is fixed; nothing here takes an argument, a path or a URL from the page.
use crate::{now_ms, AppState};
use abito_island::bridge::{self, BridgeError};
use abito_island::daemonhost::{self, HostSlot};
use abito_island::nodeinstall;
use abito_island::piinstall::{self, Reason};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

fn err(code: &str) -> BridgeError { BridgeError::denied(code) }

/// What the page may read: a closed phase and, after a failure, a closed reason with its fixed sentence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase { Idle, Running, Done, Failed(Reason),
    /// HU-069: Node.js is now where Abito looks (Linux user folder): the human can press «Instalar Pi».
    NodeReady,
    /// HU-069: the verified official installer was opened (macOS .pkg / Windows .msi); the human finishes it, then «Ya lo instalé».
    NodeInstallerOpened }
static PHASE: Mutex<Phase> = Mutex::new(Phase::Idle);

pub(crate) fn view(phase: Phase) -> Value {
    match phase {
        Phase::Idle => json!({"action":"status","phase":"idle"}),
        Phase::Running => json!({"action":"status","phase":"running"}),
        Phase::Done => json!({"action":"status","phase":"done"}),
        Phase::Failed(r) => json!({"action":"status","phase":"failed","reason":r.code(),"say":r.say()}),
        Phase::NodeReady => json!({"action":"status","phase":"node_ready","say":"Node.js quedó instalado. Tocá «Instalar Pi»."}),
        Phase::NodeInstallerOpened => json!({"action":"status","phase":"node_installer","say":"Se abrió el instalador oficial de Node.js, ya verificado. Terminá la instalación y volvé a tocar «Ya lo instalé»."}),
    }
}

/// One install at a time. Returns the phase to answer with when another one is already running.
pub(crate) fn begin(slot: &Mutex<Phase>) -> Result<(), Reason> {
    let mut phase = slot.lock().expect("pi install phase");
    if *phase == Phase::Running { return Err(Reason::Busy); }
    *phase = Phase::Running;
    Ok(())
}

/// The steps of one install, injected so the order and the decisions can be tested without Node, npm or Tauri.
pub(crate) struct Steps<'a> {
    pub node: &'a dyn Fn() -> Option<PathBuf>,
    pub npm_cli: &'a dyn Fn(&Path) -> Option<PathBuf>,
    pub install: &'a dyn Fn(&Path, &Path) -> Result<(), Reason>,
    pub pi_found: &'a dyn Fn() -> bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome { Installed, AlreadyPresent }
/// Pi first (a `run` that arrives when Pi is ALREADY there must never run `npm install -g`, which would upgrade it), then Node, its
/// npm, the install, and discovery AGAIN. `Installed` is the only outcome in which an install counts as done, and only because
/// discovery found Pi afterwards: npm exiting 0 is not enough (a custom npm prefix would install where Abito does not look).
pub(crate) fn flow(steps: &Steps) -> Result<Outcome, Reason> {
    if (steps.pi_found)() { return Ok(Outcome::AlreadyPresent); }
    let node = (steps.node)().ok_or(Reason::NodeMissing)?;
    let cli = (steps.npm_cli)(&node).ok_or(Reason::NpmMissing)?;
    (steps.install)(&node, &cli)?;
    if (steps.pi_found)() { Ok(Outcome::Installed) } else { Err(Reason::NotFoundAfter) }
}
/// The node-missing button: open nodejs.org only while Node is STILL missing. It never installs anything.
pub(crate) fn open_node_decision(node_found: bool) -> (bool, Phase) {
    if node_found { (false, Phase::Failed(Reason::NodeAppeared)) } else { (true, Phase::Failed(Reason::NodeMissing)) }
}
/// «Ya lo instalé» (and what runs after an install): re-detect Node. Found = the human can install Pi; still missing = say so.
pub(crate) fn check_node_decision(node_found: bool) -> Phase { if node_found { Phase::NodeReady } else { Phase::Failed(Reason::NodeMissing) } }
/// The one-click Node install is allowed only while Node is STILL missing (a stale page or a script must not download anything).
pub(crate) fn install_node_allowed(node_found: bool) -> Result<(), Phase> { if node_found { Err(Phase::Failed(Reason::NodeAppeared)) } else { Ok(()) } }
/// Run `f`; if it panics, report a failure through `on_panic` so the phase can never stay stuck at `running`.
pub(crate) fn guarded(f: impl FnOnce(), on_panic: impl FnOnce(Phase)) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err() { on_panic(Phase::Failed(Reason::InstallFailed)); }
}

fn app_vars() -> Vec<(String, String)> { std::env::vars().collect() }
/// The install step of one run: npm gets the FILTERED environment (never the app's own) and the chosen working directory.
pub(crate) fn install_step(vars: Vec<(String, String)>, cwd: Option<PathBuf>, limit: std::time::Duration) -> impl Fn(&Path, &Path) -> Result<(), Reason> {
    move |node, cli| piinstall::run(node, cli, &piinstall::env(node, &vars), cwd.as_deref(), limit)
}
/// No usable working directory = no install: running npm in whatever directory the app was launched from is exactly what choosing
/// a directory was meant to remove (npm reads project config from there). The step is not even started.
pub(crate) fn guard_dir(dir: Option<PathBuf>, step: &dyn Fn(&Path, &Path) -> Result<(), Reason>, node: &Path, cli: &Path) -> Result<(), Reason> {
    if dir.is_none() { return Err(Reason::InstallFailed); }
    step(node, cli)
}
/// What the page reads when the run ends well. `already` is set when Pi was there before: nothing was installed, so the page must
/// not claim it was.
pub(crate) fn done_view(outcome: Outcome) -> Value {
    match outcome {
        Outcome::Installed => view(Phase::Done),
        Outcome::AlreadyPresent => { let mut v = view(Phase::Done); v["already"] = json!(true); v }
    }
}
fn home() -> Option<std::ffi::OsString> {
    let home = std::env::var_os("HOME");
    if cfg!(windows) { home.or_else(|| std::env::var_os("USERPROFILE")) } else { home }
}
/// Where npm runs: the user's own home (never wherever the app was launched, and never a world-writable directory).
fn install_dir() -> Option<PathBuf> { home().map(PathBuf::from).filter(|p| p.is_absolute() && p.is_dir()) }
fn discover(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH");
    daemonhost::discover(name, path.as_deref(), home().as_deref()).ok()
}

/// Open nodejs.org with the platform's own opener. The URL is the Rust constant; there is no shell and no page input.
fn open_nodejs() {
    let mut command;
    #[cfg(target_os = "linux")]
    {
        let Some(opener) = ["/usr/bin/xdg-open", "/usr/local/bin/xdg-open"].iter().map(Path::new).find(|p| p.is_file()) else { return };
        command = std::process::Command::new(opener);
    }
    #[cfg(target_os = "macos")]
    { command = std::process::Command::new("/usr/bin/open"); }
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("SYSTEMROOT")).map(PathBuf::from).filter(|p| p.is_absolute());
        let Some(root) = root else { return };
        command = std::process::Command::new(root.join("explorer.exe"));
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    { return; }
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    {
        command.arg(piinstall::NODE_URL).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        if let Ok(mut child) = command.spawn() { std::thread::spawn(move || { let _ = child.wait(); }); }
    }
}

/// Open a file the host just verified with the platform's own opener (the OS installer UI takes over; Abito never runs it itself).
#[cfg(any(target_os = "macos", windows))]
fn open_installer(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("/usr/bin/open");
    #[cfg(windows)]
    let mut command = {
        let root = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("SYSTEMROOT")).map(PathBuf::from).filter(|p| p.is_absolute());
        let Some(root) = root else { return false };
        std::process::Command::new(root.join("explorer.exe"))
    };
    command.arg(path).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    match command.spawn() { Ok(mut child) => { std::thread::spawn(move || { let _ = child.wait(); }); true } Err(_) => false }
}
/// Linux installs from a tarball and never opens an installer.
#[cfg(not(any(target_os = "macos", windows)))]
fn open_installer(_path: &Path) -> bool { false }
/// Where Abito keeps what it downloads for Node: a user folder, never a shared temp.
fn node_data_dir() -> Option<PathBuf> {
    let home = install_dir()?;
    #[cfg(windows)]
    { return Some(std::env::var_os("LOCALAPPDATA").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or(home.join("AppData/Local")).join("Abito")); }
    #[cfg(target_os = "macos")]
    { return Some(home.join("Library/Application Support/Abito")); }
    #[cfg(not(any(windows, target_os = "macos")))]
    { Some(home.join(".local/share/abito")) }
}
/// The one-click Node install of one run, with the network, the runner and the opener injected so it is tested offline.
pub(crate) fn node_install_flow(env: &dyn nodeinstall::Env, os: abito_island::nodefinder::Os, arch: Option<nodeinstall::Arch>, data: Option<PathBuf>,
    open: &dyn Fn(&Path) -> bool, node_found: &dyn Fn() -> bool) -> Phase {
    let (Some(arch), Some(data)) = (arch, data) else { return Phase::Failed(Reason::Unsupported) };
    let step = || -> Result<Phase, Reason> {
        std::fs::create_dir_all(&data).map_err(|_| Reason::DownloadFailed)?;
        let scratch = nodeinstall::private_dir(&data, "node-plan")?;
        let planned = nodeinstall::plan(env, os, arch, &scratch);
        let _ = std::fs::remove_dir_all(&scratch);
        let artifact = planned?;
        match artifact.kind {
            nodeinstall::Kind::Tarball => {
                nodeinstall::install_tarball(env, &artifact, &data)?;
                Ok(check_node_decision(node_found()))
            }
            nodeinstall::Kind::Pkg | nodeinstall::Kind::Msi => {
                let dir = nodeinstall::private_dir(&data, "node-installer")?;
                let file = nodeinstall::download_verified(env, &artifact, &dir)?;
                nodeinstall::reverify(&artifact, &file)?;
                if open(&file) { Ok(Phase::NodeInstallerOpened) } else { Err(Reason::InstallFailed) }
            }
        }
    };
    step().unwrap_or_else(Phase::Failed)
}

fn finish(app: &AppHandle, phase: Phase) { finish_with(app, phase, Outcome::Installed); }
fn finish_with(app: &AppHandle, phase: Phase, outcome: Outcome) {
    *PHASE.lock().expect("pi install phase") = phase;
    let _ = app.emit("pi-install:state", if phase == Phase::Done { done_view(outcome) } else { view(phase) });
}

fn work(app: AppHandle) {
    let dir = install_dir();
    let step = install_step(app_vars(), dir.clone(), piinstall::INSTALL_LIMIT);
    let install = move |node: &Path, cli: &Path| guard_dir(dir.clone(), &step, node, cli);
    let steps = Steps {
        node: &|| discover("node"),
        npm_cli: &|node| piinstall::npm_cli(node),
        install: &install,
        pi_found: &|| discover("pi").is_some(),
    };
    match flow(&steps) {
        // Pi is NOT marked installed and nothing about the host changes. (Node missing is the human's step: «Abrir nodejs.org».)
        Err(reason) => finish(&app, Phase::Failed(reason)),
        Ok(outcome) => {
            // Pi exists now: start the host WITHOUT restarting the app. A healthy running host is left alone when Pi was already
            // there. A start that still fails is its own closed reason.
            let running = app.state::<HostSlot>().pid().is_some();
            let started = if outcome == Outcome::AlreadyPresent && running { true } else { crate::settingshost::start_host_after_install(&app) };
            finish_with(&app, if started { Phase::Done } else { Phase::Failed(Reason::HostFailed) }, outcome);
        }
    }
}

#[tauri::command]
pub async fn pi_install_action(app: AppHandle, webview: tauri::Webview, state: State<'_, AppState>, payload: Value) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let action = piinstall::parse_action(&payload).ok_or_else(|| err("invalid_schema"))?;
    if action == "status" { return Ok(view(*PHASE.lock().expect("pi install phase"))); }
    if action == "open_node" {
        // Its own closed action: opens nodejs.org (a Rust constant) only while Node is still missing, never installs.
        let (open, phase) = open_node_decision(discover("node").is_some());
        if open { open_nodejs(); }
        return Ok(view(phase));
    }
    if action == "check_node" {
        // «Ya lo instalé»: only re-detects. Nothing is downloaded or opened.
        return Ok(view(check_node_decision(discover("node").is_some())));
    }
    if action == "install_node" {
        if let Err(phase) = install_node_allowed(discover("node").is_some()) { return Ok(view(phase)); }
        if let Err(reason) = begin(&PHASE) { return Ok(view(Phase::Failed(reason))); }
        let _ = app.emit("pi-install:state", view(Phase::Running));
        let handle = app.clone();
        std::thread::spawn(move || {
            let worker = handle.clone();
            guarded(move || {
                let phase = node_install_flow(&nodeinstall::Real, abito_island::nodefinder::Os::current(), nodeinstall::Arch::current(), node_data_dir(), &open_installer, &|| discover("node").is_some());
                finish(&worker, phase);
            }, |phase| finish(&handle, phase));
        });
        return Ok(view(Phase::Running));
    }
    if app.try_state::<HostSlot>().is_none() { return Err(err("host_unavailable")); }
    if let Err(reason) = begin(&PHASE) { return Ok(view(Phase::Failed(reason))); }
    let _ = app.emit("pi-install:state", view(Phase::Running));
    let handle = app.clone();
    std::thread::spawn(move || {
        let worker = handle.clone();
        guarded(move || work(worker), |phase| finish(&handle, phase));
    });
    Ok(view(Phase::Running))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn steps_log(node: bool, npm: bool, install: Result<(), Reason>, found: bool) -> (Result<Outcome, Reason>, Vec<&'static str>) {
        // Pi is missing at the START in every case below except `present_first`; `found` is what discovery says AFTER the install.
        steps_log_with(false, node, npm, install, found)
    }
    fn steps_log_with(present_first: bool, node: bool, npm: bool, install: Result<(), Reason>, found: bool) -> (Result<Outcome, Reason>, Vec<&'static str>) {
        let log = RefCell::new(Vec::new());
        let calls = std::cell::Cell::new(0);
        let n = || { log.borrow_mut().push("node"); node.then(|| PathBuf::from("/n/node")) };
        let c = |_: &Path| { log.borrow_mut().push("npm"); npm.then(|| PathBuf::from("/n/npm-cli.js")) };
        let i = |_: &Path, _: &Path| { log.borrow_mut().push("install"); install };
        let f = || { log.borrow_mut().push("found"); calls.set(calls.get() + 1); if calls.get() == 1 { present_first } else { found } };
        let out = flow(&Steps { node: &n, npm_cli: &c, install: &i, pi_found: &f });
        (out, log.into_inner())
    }

    #[test]
    fn a_good_install_is_installed_only_because_discovery_finds_pi_afterwards() {
        assert_eq!(steps_log(true, true, Ok(()), true), (Ok(Outcome::Installed), vec!["found", "node", "npm", "install", "found"]));
        // npm said yes but Pi is not where Abito looks (a custom npm prefix): NOT installed
        assert_eq!(steps_log(true, true, Ok(()), false).0, Err(Reason::NotFoundAfter));
    }
    #[test]
    fn no_node_stops_before_anything_is_run_and_no_npm_stops_before_the_install() {
        assert_eq!(steps_log(false, true, Ok(()), true), (Err(Reason::NodeMissing), vec!["found", "node"]));
        assert_eq!(steps_log(true, false, Ok(()), true), (Err(Reason::NpmMissing), vec!["found", "node", "npm"]));
    }
    #[test]
    fn a_failed_install_never_asks_discovery_and_keeps_its_reason() {
        for reason in [Reason::InstallFailed, Reason::Timeout] {
            assert_eq!(steps_log(true, true, Err(reason), true), (Err(reason), vec!["found", "node", "npm", "install"]), "{reason:?}: discovery is not consulted AFTER a failed install, Pi is not marked installed");
        }
    }
    /// Security review of HU-046: a `run` that arrives when Pi is ALREADY there (a stale page, a script calling the command) must not
    /// run `npm install -g` (which would upgrade Pi) at all.
    #[test]
    fn a_run_when_pi_is_already_present_never_touches_node_or_npm() {
        assert_eq!(steps_log_with(true, true, true, Ok(()), true), (Ok(Outcome::AlreadyPresent), vec!["found"]));
    }
    #[test]
    fn the_node_button_never_installs_it_opens_nodejs_only_while_node_is_still_missing() {
        assert_eq!(open_node_decision(false), (true, Phase::Failed(Reason::NodeMissing)));
        assert_eq!(open_node_decision(true), (false, Phase::Failed(Reason::NodeAppeared)), "Node showed up meanwhile: nothing is opened and nothing is installed");
    }
    #[test]
    fn install_node_runs_only_while_node_is_missing_and_check_node_only_redetects() {
        assert_eq!(install_node_allowed(false), Ok(()));
        assert_eq!(install_node_allowed(true), Err(Phase::Failed(Reason::NodeAppeared)), "a stale page cannot trigger a download when Node exists");
        assert_eq!(check_node_decision(true), Phase::NodeReady);
        assert_eq!(check_node_decision(false), Phase::Failed(Reason::NodeMissing));
        assert_eq!(view(Phase::NodeReady)["phase"], "node_ready");
        assert_eq!(view(Phase::NodeInstallerOpened)["phase"], "node_installer");
    }
    /// Offline end to end per OS family: the verified installer is OPENED (never run) on mac/Windows; on Linux Node is unpacked and re-detected.
    #[test]
    fn the_node_flow_opens_a_verified_installer_on_mac_and_windows_and_never_without_a_good_hash() {
        use abito_island::nodefinder::Os;
        use std::collections::HashMap;
        struct Net(HashMap<String, Vec<u8>>);
        impl nodeinstall::Env for Net {
            fn get(&self, url: &str, _max: u64, sink: &mut dyn std::io::Write) -> Result<(), Reason> { sink.write_all(self.0.get(url).ok_or(Reason::DownloadFailed)?).map_err(|_| Reason::DownloadFailed) }
            fn run(&self, _: &Path, _: &[String], _: Option<&Path>) -> Result<Vec<u8>, Reason> { Err(Reason::InstallFailed) }
        }
        for (os, name) in [(Os::Mac, "node-v22.30.1.pkg"), (Os::Windows, "node-v22.30.1-x64.msi")] {
            let body = b"installer bytes".to_vec();
            let good = |hash: String| { let mut m = HashMap::new(); m.insert(format!("{}SHASUMS256.txt", nodeinstall::DIST_BASE), format!("{hash}  {name}\n").into_bytes()); m.insert(format!("{}{name}", nodeinstall::DIST_BASE), body.clone()); Net(m) };
            let data = std::env::temp_dir().join(format!("abito-pihost-node-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&data);
            let opened = RefCell::new(Vec::new());
            let open = |p: &Path| { opened.borrow_mut().push(p.to_path_buf()); true };
            let phase = node_install_flow(&good(nodeinstall::sha256_hex(&body)), os, Some(nodeinstall::Arch::X64), Some(data.clone()), &open, &|| false);
            assert_eq!(phase, Phase::NodeInstallerOpened, "{os:?}");
            assert_eq!(opened.borrow().len(), 1);
            assert!(opened.borrow()[0].starts_with(&data) && opened.borrow()[0].ends_with(name));
            let opened2 = RefCell::new(0);
            let open2 = |_: &Path| { *opened2.borrow_mut() += 1; true };
            let phase = node_install_flow(&good("0".repeat(64)), os, Some(nodeinstall::Arch::X64), Some(data.clone()), &open2, &|| false);
            assert_eq!(phase, Phase::Failed(Reason::ChecksumMismatch));
            assert_eq!(*opened2.borrow(), 0, "a file that fails the hash is never opened");
            let no_open = |_: &Path| false;
            assert_eq!(node_install_flow(&good(nodeinstall::sha256_hex(&body)), os, Some(nodeinstall::Arch::X64), Some(data.clone()), &no_open, &|| false), Phase::Failed(Reason::InstallFailed));
            assert_eq!(node_install_flow(&good(String::new()), os, None, Some(data.clone()), &open2, &|| false), Phase::Failed(Reason::Unsupported));
            let _ = std::fs::remove_dir_all(&data);
        }
    }
    #[test]
    fn a_panic_while_installing_does_not_leave_the_phase_stuck_at_running() {
        let seen = Mutex::new(None);
        guarded(|| panic!("boom"), |phase| *seen.lock().unwrap() = Some(phase));
        assert_eq!(*seen.lock().unwrap(), Some(Phase::Failed(Reason::InstallFailed)));
        let none = Mutex::new(None);
        guarded(|| {}, |phase| *none.lock().unwrap() = Some(phase));
        assert_eq!(*none.lock().unwrap(), None, "a normal return reports nothing extra");
    }
    /// Security review of HU-046: the install the host really builds must hand npm the FILTERED environment and the given working
    /// directory, whatever the app itself inherited. Exercised through a fake `npm-cli.js` run by the real Node.
    #[test]
    fn the_real_install_step_hands_npm_the_filtered_environment_and_the_chosen_directory() {
        // `node.exe` on Windows; a CI run with no Node FAILS instead of skipping silently (see piinstall tests).
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        let found = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).filter(|d| d.is_absolute()).map(|d| d.join(name)).find(|p| p.is_file());
        if found.is_none() { assert!(std::env::var_os("CI").is_none(), "CI has no node on PATH: this test must not skip silently"); eprintln!("skipped: no node on PATH"); }
        let Some(node) = found else { return };
        let dir = std::env::temp_dir().join(format!("abito-pihost-env-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir); std::fs::create_dir_all(&dir).unwrap();
        let record = dir.join("seen.json");
        let cli = dir.join("npm-cli.js");
        std::fs::write(&cli, format!("require('fs').writeFileSync({:?}, JSON.stringify({{nodeOptions: process.env.NODE_OPTIONS || null, prefix: process.env.npm_config_prefix || null, secret: process.env.AWS_SECRET_ACCESS_KEY || null, cwd: process.cwd(), argv: process.argv.slice(2)}}));", record)).unwrap();
        let mut vars: Vec<(String, String)> = [("NODE_OPTIONS", "--require /evil.js"), ("npm_config_prefix", "/evil"), ("AWS_SECRET_ACCESS_KEY", "s3cret"), ("HOME", "/home/t")]
            .iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        // what node.exe needs to start at all: PATH, plus SystemRoot/TEMP on Windows
        vars.extend(["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR"].iter().filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v))));
        let step = install_step(vars, Some(dir.clone()), std::time::Duration::from_secs(20));
        assert_eq!(step(&node, &cli), Ok(()));
        let seen: Value = serde_json::from_str(&std::fs::read_to_string(&record).unwrap()).unwrap();
        assert_eq!(seen["nodeOptions"], Value::Null); assert_eq!(seen["prefix"], Value::Null); assert_eq!(seen["secret"], Value::Null, "nothing outside the allowlist reaches npm");
        assert_eq!(seen["argv"], json!(["install", "-g", "@earendil-works/pi-coding-agent"]));
        assert_eq!(std::fs::canonicalize(seen["cwd"].as_str().unwrap()).unwrap(), std::fs::canonicalize(&dir).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }
    /// Security re-review of HU-046: with no usable working directory the install must be REFUSED, not silently run in whatever
    /// directory the app was launched from (the exact thing choosing a directory was meant to remove).
    #[test]
    fn an_install_with_no_working_directory_is_refused_before_anything_runs() {
        let ran = std::cell::Cell::new(false);
        let step = |_: &Path, _: &Path| { ran.set(true); Ok(()) };
        assert_eq!(guard_dir(None, &step, Path::new("/n"), Path::new("/c")), Err(Reason::InstallFailed));
        assert!(!ran.get(), "npm was not started");
        assert_eq!(guard_dir(Some(PathBuf::from("/h")), &step, Path::new("/n"), Path::new("/c")), Ok(()));
        assert!(ran.get());
    }
    #[test]
    fn a_run_that_found_pi_already_there_says_so_instead_of_claiming_an_install() {
        assert_eq!(done_view(Outcome::Installed)["phase"], "done");
        assert_eq!(done_view(Outcome::Installed).get("already"), None);
        let already = done_view(Outcome::AlreadyPresent);
        assert_eq!(already["phase"], "done"); assert_eq!(already["already"], true);
    }
    #[test]
    fn only_one_install_runs_at_a_time_and_a_rejected_second_one_leaves_the_state_alone() {
        let slot = Mutex::new(Phase::Idle);
        assert_eq!(begin(&slot), Ok(()));
        assert_eq!(*slot.lock().unwrap(), Phase::Running);
        assert_eq!(begin(&slot), Err(Reason::Busy));
        assert_eq!(*slot.lock().unwrap(), Phase::Running, "the running install is not overwritten by the refused one");
        *slot.lock().unwrap() = Phase::Failed(Reason::Timeout);
        assert_eq!(begin(&slot), Ok(()), "after a failure the human can try again");
    }
    #[test]
    fn the_page_reads_only_a_closed_phase_and_a_fixed_sentence() {
        assert_eq!(view(Phase::Idle), json!({"action":"status","phase":"idle"}));
        assert_eq!(view(Phase::Running)["phase"], "running");
        assert_eq!(view(Phase::Done), json!({"action":"status","phase":"done"}));
        let failed = view(Phase::Failed(Reason::InstallFailed));
        assert_eq!(failed["phase"], "failed"); assert_eq!(failed["reason"], "install_failed"); assert_eq!(failed["say"], Reason::InstallFailed.say());
        for v in [view(Phase::Idle), view(Phase::Running), view(Phase::Done), failed] {
            let text = v.to_string();
            assert!(!text.contains('/') && !text.contains('\\') && !text.contains("npm ERR"), "no path or npm output: {text}");
        }
    }
    #[test]
    fn the_command_is_pinned_where_it_is_reachable_and_runs_nothing_taken_from_the_page() {
        let src = include_str!("pihost.rs");
        let body = &src[src.find("pub async fn pi_install_action").unwrap()..src.find("#[cfg(test)]").unwrap()];
        assert!(body.contains("bridge::sender_ok(") && body.contains("parse_action(&payload)"), "same sender rule as daemon_action; closed payload");
        for forbidden in ["payload[", "payload.get(", "Command::new(\"npm", "Command::new(\"sh", "cmd.exe", "powershell", "sudo", "runas"] {
            assert!(!body.contains(forbidden), "the command must not use {forbidden}");
        }
        assert!(include_str!("main.rs").contains("pihost::pi_install_action,"), "registered in the invoke handler");
    }
}

//! App-owned island host. No host restart loop; only the daemon supervises Pi.
//! Linux has kernel parent-death protection (PR_SET_PDEATHSIG); Windows has a
//! Job Object with KILL_ON_JOB_CLOSE (`daemonhost_win.rs`). Other platforms fail
//! closed until an equivalent, independently verified lifetime mechanism exists.
#[cfg(windows)]
#[path = "daemonhost_win.rs"]
mod win;
#[cfg(windows)]
pub use win::Host;
#[cfg(windows)]
pub(crate) use win::spawn_in_job;
// Windows runtime lookups (T2/S4): re-exported for the integration tests.
#[cfg(windows)]
pub use win::{discover_node, discover_pi};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Bounded cadence of the runtime reap poll (#390): short enough that a dead
/// daemon is never a zombie for long, long enough to cost nothing.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
const REAP_POLL: std::time::Duration = std::time::Duration::from_millis(50);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartupFailure { NodeMissing, PiMissing, HostMissing, SpawnFailed, Unsupported }
impl StartupFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::NodeMissing => "node_missing", Self::PiMissing => "pi_missing",
            Self::HostMissing => "host_missing", Self::SpawnFailed => "host_spawn_failed",
            Self::Unsupported => "host_platform_unsupported",
        }
    }
}

#[derive(Default)]
pub struct HostSlot {
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    child: Arc<Mutex<Option<Host>>>,
    failure: Mutex<Option<StartupFailure>>,
    /// #390: the exit status of a host child that died ON ITS OWN while the app lived.
    exited: Arc<Mutex<Option<std::process::ExitStatus>>>,
}
impl HostSlot {
    pub fn start(&self) {
        #[cfg(any(target_os = "linux", target_os = "macos", windows))]
        self.start_with(start);
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        self.start_with(|| Err(StartupFailure::Unsupported));
    }
    /// `start`, with the launch supplied so a test can drive both outcomes. HU-046: a SUCCESSFUL start forgets the failure of an
    /// earlier one (Pi installed after «Falta Pi»): `agent_action` answers `startup_failed` for as long as `failure()` is set.
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    pub fn start_with(&self, launch: impl FnOnce() -> Result<Host, StartupFailure>) {
        match launch() {
            Ok(child) => { *self.failure.lock().expect("host failure lock") = None; self.adopt(child) }
            Err(reason) => self.note_failure(reason),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    pub fn start_with(&self, launch: impl FnOnce() -> Result<(), StartupFailure>) {
        match launch() {
            Ok(()) => { *self.failure.lock().expect("host failure lock") = None; }
            Err(reason) => self.note_failure(reason),
        }
    }
    fn note_failure(&self, reason: StartupFailure) {
        eprintln!("island host: no_daemon ({})", reason.code());
        #[cfg(any(target_os = "macos", windows))]
        match reason {
            StartupFailure::NodeMissing => eprintln!("Falta Node.js: instalalo desde nodejs.org."),
            StartupFailure::PiMissing => eprintln!("Falta Pi: instalalo con npm install -g @earendil-works/pi-coding-agent."),
            _ => {}
        }
        crate::failure::report("daemon", "daemon-start", crate::failure::Reason::DaemonStartFailed, None);
        *self.failure.lock().expect("host failure lock") = Some(reason);
    }
    pub fn failure(&self) -> Option<StartupFailure> { *self.failure.lock().expect("host failure lock") }
    /// Exit status of a host child that died by itself (early exit, crash, external kill);
    /// `None` while it lives or after a normal `stop()`.
    pub fn exit_status(&self) -> Option<std::process::ExitStatus> { *self.exited.lock().expect("host exit lock") }
    /// The pid of the CURRENT app-owned child, or `None` when the spawn failed or the
    /// runtime reap already took a child that died. Read only for the restart verdict
    /// (#390 fix); it is never exposed to the page.
    pub fn pid(&self) -> Option<u32> {
        #[cfg(any(target_os = "linux", target_os = "macos", windows))]
        let pid = self.child.lock().expect("host child lock").as_ref().map(Host::pid);
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        let pid = None;
        pid
    }
    /// Take ownership of a spawned host and reap it at runtime if it exits by itself:
    /// a bounded `try_wait` poll (no unbounded `wait`), so a dead daemon is never left
    /// as a zombie and its early exit becomes visible via [`exit_status`].
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    pub fn adopt(&self, host: Host) {
        *self.child.lock().expect("host child lock") = Some(host);
        let (child, exited) = (Arc::clone(&self.child), Arc::clone(&self.exited));
        std::thread::spawn(move || loop {
            std::thread::sleep(REAP_POLL);
            let Ok(mut slot) = child.lock() else { return };
            let Some(host) = slot.as_mut() else { return }; // stopped: nothing left to watch
            if let Ok(Some(status)) = host.try_wait() {
                eprintln!("island host: daemon exited by itself ({status}); reaped");
                crate::failure::report("daemon", "daemon-exited", crate::failure::Reason::DaemonExited, status.code().map(i64::from));
                if let Ok(mut out) = exited.lock() { *out = Some(status); }
                *slot = None; // Drop sees the child already reaped: no signal to a reused pid
                return;
            }
        });
    }
    pub fn stop(&self) {
        #[cfg(any(target_os = "linux", target_os = "macos", windows))]
        drop(self.child.lock().expect("host child lock").take());
    }
}

/// Session PATH first; only these canonical locations are tried afterwards.
/// Empty/relative PATH components are ignored: no working-directory execution.
pub fn discover(name: &str, path: Option<&OsStr>, home: Option<&OsStr>) -> Result<PathBuf, String> {
    discover_in(name, path, home, &crate::nodefinder::Env::from_process())
}
/// [`discover`] with the version-manager environment given explicitly (tests build it; the app passes the process's own).
pub fn discover_in(name: &str, path: Option<&OsStr>, home: Option<&OsStr>, finder: &crate::nodefinder::Env) -> Result<PathBuf, String> {
    // Windows lookup lives entirely in `daemonhost_win.rs` (node.exe and the
    // npm package CLI JS — never a .cmd shim); the unix/macOS logic below is
    // untouched.
    #[cfg(windows)]
    return win::discover(name, path, home, finder);
    #[cfg(not(windows))]
    {
        let mut candidates: Vec<PathBuf> = path.map(std::env::split_paths).into_iter().flatten()
            .filter(|p| p.is_absolute()).map(|p| p.join(name)).collect();
        // HU-069: a GUI launch (Finder, desktop launcher) does not load the shell profile, so version managers (nvm, fnm, Volta) and
        // the customary user bin directories are looked up here, the same way on every OS. Bounded, no shell, no recursive search.
        {
            let mut env = finder.clone();
            env.home = home.map(PathBuf::from).filter(|h| h.is_absolute());
            candidates.extend(crate::nodefinder::candidates(name, crate::nodefinder::Os::current(), &env));
        }
        match name {
            "node" => {
                #[cfg(target_os = "macos")]
                candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
                candidates.extend([PathBuf::from("/usr/local/bin/node"), PathBuf::from("/usr/bin/node")]);
            }
            "pi" => {
                if let Some(home) = home.map(Path::new).filter(|h| h.is_absolute()) { candidates.push(home.join(".local/bin/pi")); }
                #[cfg(target_os = "macos")]
                candidates.push(PathBuf::from("/opt/homebrew/bin/pi"));
                candidates.extend([PathBuf::from("/usr/local/bin/pi"), PathBuf::from("/usr/bin/pi")]);
            }
            _ => {}
        }
        candidates.into_iter().find(|p| executable(p)).ok_or_else(|| format!("{name} missing (PATH and canonical locations)"))
    }
}
fn executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; meta.is_file() && meta.permissions().mode() & 0o111 != 0 }
    #[cfg(not(unix))]
    { meta.is_file() }
}

/// Use the same absolute-only PATH search for Pi/SDK subprocesses as discovery.
/// Keeping a relative entry here would undo discover()'s no-CWD-execution rule.
pub fn runtime_path(path: Option<&OsStr>, node: &Path, pi: &Path) -> Result<std::ffi::OsString, std::env::JoinPathsError> {
    let mut dirs: Vec<PathBuf> = path.map(std::env::split_paths).into_iter().flatten()
        .filter(|p| p.is_absolute()).collect();
    for runtime in [node, pi] {
        if let Some(dir) = runtime.parent() { if !dirs.iter().any(|d| d == dir) { dirs.push(dir.to_owned()); } }
    }
    std::env::join_paths(dirs)
}

/// Release layout: Tauri puts resources beside MacOS/, not beside the binary.
/// Other platforms retain their adjacent desktop-daemon layout.
pub fn installed_daemon_cli(exe: &Path) -> Option<PathBuf> {
    let directory = exe.parent()?;
    #[cfg(target_os = "macos")]
    let directory = directory.parent()?.join("Resources");
    Some(directory.join("desktop-daemon/src/cli.cjs"))
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn start() -> Result<Host, StartupFailure> {
    let path = std::env::var_os("PATH");
    #[cfg(windows)]
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    let node = discover("node", path.as_deref(), home.as_deref()).map_err(|_| StartupFailure::NodeMissing)?;
    let pi = discover("pi", path.as_deref(), home.as_deref()).map_err(|_| StartupFailure::PiMissing)?;
    let exe = std::env::current_exe().map_err(|_| StartupFailure::HostMissing)?;
    let mut cli = installed_daemon_cli(&exe).ok_or(StartupFailure::HostMissing)?;
    #[cfg(debug_assertions)]
    if !cli.is_file() { cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("../desktop-daemon/src/cli.cjs"); }
    if !cli.is_file() { return Err(StartupFailure::HostMissing) }
    let child_path = runtime_path(path.as_deref(), &node, &pi).map_err(|_| StartupFailure::SpawnFailed)?;
    let mut command = std::process::Command::new(node);
    command.arg(cli).args(["run", "--app-owned"]).env("PATH", child_path);
    Host::spawn_command(command).map_err(|_| StartupFailure::SpawnFailed)
}

#[cfg(target_os = "macos")]
#[path = "daemonhost_mac.rs"]
mod mac;
#[cfg(target_os = "macos")]
pub use mac::{sentinel_main, Host, SENTINEL_FLAG};

#[cfg(target_os = "linux")]
pub struct Host { child: std::process::Child }
#[cfg(target_os = "linux")]
impl Host {
    /// Private process group for owned cleanup, plus kernel death signal. No shell.
    pub fn spawn_command(mut command: std::process::Command) -> std::io::Result<Self> {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id() as libc::pid_t;
        command.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::inherit());
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 { return Err(std::io::Error::last_os_error()) }
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 { return Err(std::io::Error::last_os_error()) }
                // Parent may have died between fork and prctl. Never escape that race.
                if libc::getppid() != parent { return Err(std::io::Error::other("app exited before host spawn")) }
                Ok(())
            });
        }
        command.spawn().map(|child| Self { child })
    }
    pub fn pid(&self) -> u32 { self.child.id() }
    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> { self.child.try_wait() }
}
#[cfg(target_os = "linux")]
impl Drop for Host {
    fn drop(&mut self) {
        // Never signal a reused process/group id after the child was already reaped.
        if self.child.try_wait().ok().flatten().is_some() { return }
        drop(self.child.stdin.take()); // EOF lease allows graceful shutdown
        let pid = self.child.id() as libc::pid_t;
        unsafe { libc::kill(-pid, libc::SIGTERM); }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() { return }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        unsafe { libc::kill(-pid, libc::SIGKILL); }
        // A child can move out of its original group. Target our unreaped
        // direct child as well; its PID cannot be reused while we still own it.
        let _ = self.child.kill();
        let reap_deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while std::time::Instant::now() < reap_deadline {
            if self.child.try_wait().ok().flatten().is_some() { return }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // Never block app exit in wait(). In an uninterruptible kernel wait,
        // PDEATHSIG remains the final backstop when this app process exits.
        eprintln!("island host: bounded reap expired; kernel parent-death protection remains active");
    }
}

/// HU-069 T3 / rule 12: «Instalar Pi» and the chat host must work when the app is started from Finder / Explorer / a desktop launcher,
/// i.e. with NO Node on PATH and no shell setup, whenever Node lives where a version manager keeps it. The same test runs on Linux,
/// macOS and Windows CI (only the manager layout differs). The Node binary used is the runner's own, copied into the fake layout.
#[cfg(test)]
mod gui_launch_tests {
    use super::*;

    fn real_node() -> Option<PathBuf> {
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        std::env::split_paths(&std::env::var_os("PATH")?).filter(|d| d.is_absolute()).map(|d| d.join(name)).find(|p| p.is_file())
    }
    #[test]
    fn node_and_npm_are_found_and_used_with_the_minimal_finder_explorer_environment() {
        let Some(real) = real_node() else {
            assert!(std::env::var_os("CI").is_none(), "CI has Node: this test must not skip silently");
            eprintln!("skipped: no node on PATH");
            return;
        };
        let root = std::env::temp_dir().join(format!("abito-gui-launch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let empty_path = root.join("empty-path");
        let no_program_files = root.join("no-program-files");
        for d in [&home, &empty_path, &no_program_files] { std::fs::create_dir_all(d).unwrap(); }
        // The layout each OS's version manager really uses, with a Node newer than the minimum.
        let (node_dir, npm_cli_dir) = if cfg!(windows) {
            let dir = home.join("AppData/Roaming/fnm/node-versions/v22.21.0/installation");
            (dir.clone(), dir.join("node_modules/npm/bin"))
        } else {
            let prefix = home.join(".nvm/versions/node/v26.13.0");
            (prefix.join("bin"), prefix.join("lib/node_modules/npm/bin"))
        };
        std::fs::create_dir_all(&node_dir).unwrap();
        std::fs::create_dir_all(&npm_cli_dir).unwrap();
        let node = node_dir.join(real.file_name().unwrap());
        std::fs::copy(&real, &node).unwrap();
        let record = root.join("seen.json");
        std::fs::write(npm_cli_dir.join("npm-cli.js"), format!("require('fs').writeFileSync({:?}, JSON.stringify(process.argv.slice(2)));", record)).unwrap();

        // The Finder/Explorer environment, built explicitly: no process-wide variable is touched (other tests read HOME in parallel).
        let finder = crate::nodefinder::Env { home: Some(home.clone()), app_data: Some(home.join("AppData/Roaming")),
            local_app_data: Some(home.join("AppData/Local")), program_files: Some(no_program_files.clone()), ..Default::default() };
        let found = discover_in("node", Some(empty_path.as_os_str()), Some(home.as_os_str()), &finder).expect("Node must be found without PATH");
        assert_eq!(std::fs::canonicalize(&found).unwrap(), std::fs::canonicalize(&node).unwrap());
        // «Instalar Pi» then runs npm with that Node, with nothing from the shell
        let cli = crate::piinstall::npm_cli(&found).expect("npm sits next to the managed Node");
        let vars: Vec<(String, String)> = ["SystemRoot", "TEMP", "TMP", "TMPDIR", "PATH"].iter().filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v))).collect();
        let env = crate::piinstall::env(&found, &vars);
        let outcome = crate::piinstall::run(&found, &cli, &env, Some(&home), std::time::Duration::from_secs(30));
        if outcome.is_err() {
            // npm's own output is never shown to users; in CI the reason must be visible.
            let direct = std::process::Command::new(&found).arg(&cli).args(["install", "-g", "x"]).current_dir(&home).output();
            eprintln!("DIAG node={found:?} cli={cli:?} direct={direct:?}");
        }
        assert_eq!(outcome, Ok(()));
        let seen: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&record).unwrap()).unwrap();
        assert_eq!(seen, serde_json::json!(["install", "-g", "@earendil-works/pi-coding-agent"]));
        // the daemon would be started with that absolute Node first on its PATH
        let child_path = runtime_path(Some(empty_path.as_os_str()), &found, &found).unwrap();
        assert_eq!(std::env::split_paths(&child_path).last().unwrap(), found.parent().unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }
}

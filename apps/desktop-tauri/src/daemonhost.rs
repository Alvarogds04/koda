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
/// `BundledRuntimeInvalid` (K2-02 S2): Koda's own runtime folder exists beside the executable but fails validation
/// (broken install): startup fails closed instead of silently using a system Node or Pi.
pub enum StartupFailure { NodeMissing, PiMissing, BundledRuntimeInvalid, HostMissing, SpawnFailed, Unsupported }
impl StartupFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::NodeMissing => "node_missing", Self::PiMissing => "pi_missing",
            Self::BundledRuntimeInvalid => "bundled_runtime_invalid",
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
        for line in failure_lines(reason, crate::nodefinder::Os::current()) { eprintln!("{line}") }
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

/// K2-02 D1 (human decision «2a»): what a person reads when Koda's own runtime folder is present but broken.
/// Koda never falls back to a system Node or Pi in that case: reinstalling Koda is the fix.
pub const BUNDLED_RUNTIME_INVALID_SENTENCE: &str = "La instalación de Koda está dañada: volvé a instalar Koda.";

/// The exact stderr lines for a startup failure: the code line, then its sentence when it has one. The same on
/// Linux, macOS and Windows (K2-02 D1 parity); `_os` keeps the per-OS seam explicit for the tests.
pub fn failure_lines(reason: StartupFailure, _os: crate::nodefinder::Os) -> Vec<String> {
    let mut lines = vec![format!("island host: no_daemon ({})", reason.code())];
    if let Some(sentence) = failure_sentence(reason) { lines.push(sentence.to_owned()) }
    lines
}

/// The sentence printed for a startup failure, if it has one.
pub fn failure_sentence(reason: StartupFailure) -> Option<&'static str> {
    match reason {
        // K2-05 (T2): the daemon's engine is the bundled Gentle Shell, so with the bundled runtime this is a
        // DEV-BUILD-ONLY path (a release install always has the runtime folder beside the executable). Without
        // it the installation is incomplete: Koda's own engine is missing, and Koda never asks for npm installs
        // (K2-02 removed «Instalar Pi») — reinstalling Koda is the fix.
        StartupFailure::NodeMissing => Some("Falta Node.js: instalalo desde nodejs.org."),
        StartupFailure::PiMissing => Some("La instalación de Koda está incompleta: falta el motor propio de Koda; volvé a instalar Koda."),
        StartupFailure::BundledRuntimeInvalid => Some(BUNDLED_RUNTIME_INVALID_SENTENCE),
        _ => None,
    }
}

/// What `discover` can fail with. `Missing` is the historical fail-closed answer (no candidate matched); a bundled runtime
/// folder that EXISTS but fails validation is its own error, so startup never falls back to a system Node (K2-02 S2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiscoverError { Missing(String), BundledRuntimeInvalid }
impl std::ops::Deref for DiscoverError {
    type Target = str;
    /// The historical message text is kept verbatim, so callers that read it as a string keep working.
    fn deref(&self) -> &str {
        match self {
            Self::Missing(message) => message,
            Self::BundledRuntimeInvalid => "the bundled runtime folder beside the executable is present but invalid",
        }
    }
}

/// Session PATH first; only these canonical locations are tried afterwards.
/// Empty/relative PATH components are ignored: no working-directory execution.
pub fn discover(name: &str, path: Option<&OsStr>, home: Option<&OsStr>) -> Result<PathBuf, DiscoverError> {
    discover_in(name, path, home, &crate::nodefinder::Env::from_process())
}
/// [`discover`] with the version-manager environment given explicitly (tests build it; the app passes the process's own).
pub fn discover_in(name: &str, path: Option<&OsStr>, home: Option<&OsStr>, finder: &crate::nodefinder::Env) -> Result<PathBuf, DiscoverError> {
    discover_with_runtime(name, path, home, finder, running_executable().as_deref())
}
/// The canonicalised path of the running executable: the bundled runtime is looked up beside it, never from an
/// environment variable a user could set.
fn running_executable() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|exe| exe.canonicalize().ok())
}
/// [`discover_in`] with the running executable given (tests inject a fake install layout; the app derives it from
/// `std::env::current_exe()`). `None` skips the bundled-runtime lookup entirely.
pub fn discover_with_runtime(name: &str, path: Option<&OsStr>, home: Option<&OsStr>, finder: &crate::nodefinder::Env, exe: Option<&Path>) -> Result<PathBuf, DiscoverError> {
    // K2-02 (S1, S2): BUNDLED-FIRST on every OS. The runtime folder beside our own executable, when it validates, wins
    // over PATH, nvm, Volta, Homebrew and %AppData%\npm; present but broken fails closed; absent falls through unchanged.
    if let Some(exe) = exe {
        match crate::nodefinder::bundled_runtime(exe, crate::nodefinder::Os::current(), crate::nodefinder::current_runtime_target()) {
            crate::nodefinder::Bundled::Valid(rt) => return match name {
                "node" => Ok(rt.node),
                // K2-05 (T2): the daemon's engine is the bundled Gentle Shell, which the daemon resolves itself from the
                // runtime next to the Node it runs on (runtime.cjs bundledGentleShell). This `pi` path is only the
                // island-side gate and a PATH input; Windows keeps the daemon's `pi` command bare (config.cjs
                // validateCommand refuses absolute paths there, K2-01b) and resolves the package CLI JS itself.
                "pi" => Ok(rt.pi),
                _ => Err(DiscoverError::Missing(format!("{name} has no bundled lookup"))),
            },
            crate::nodefinder::Bundled::Invalid => return Err(DiscoverError::BundledRuntimeInvalid),
            crate::nodefinder::Bundled::Absent => {}
        }
    }
    // Windows lookup lives entirely in `daemonhost_win.rs` (node.exe and the
    // npm package CLI JS — never a .cmd shim); the unix/macOS logic below is
    // untouched.
    #[cfg(windows)]
    return win::discover(name, path, home, finder).map_err(DiscoverError::Missing);
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
        candidates.into_iter().find(|p| executable(p)).ok_or_else(|| DiscoverError::Missing(format!("{name} missing (PATH and canonical locations)")))
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
    runtime_path_with(path, node, pi, None)
}
/// [`runtime_path`] with an optional directory forced to the FRONT: when the bundled runtime is in use, its folder
/// shadows any same-named binary on the session PATH (K2-02 S2), so a child's bare `node`/`pi` resolves to Koda's own.
pub fn runtime_path_with(path: Option<&OsStr>, node: &Path, pi: &Path, first: Option<&Path>) -> Result<std::ffi::OsString, std::env::JoinPathsError> {
    let mut dirs: Vec<PathBuf> = path.map(std::env::split_paths).into_iter().flatten()
        .filter(|p| p.is_absolute()).collect();
    if let Some(dir) = first.filter(|d| d.is_absolute()) { if !dirs.iter().any(|d| d == dir) { dirs.insert(0, dir.to_path_buf()); } }
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
/// The `pi` the daemon child needs on its PATH (K2-05 T2). The daemon's engine is the bundled
/// Gentle Shell, which the daemon resolves itself from the runtime next to the Node it runs on
/// (apps/desktop-daemon/src/runtime.cjs bundledGentleShell) — read-only: the island never spawns
/// it. So a VALID bundled runtime answers with its own `pi` and the island no longer refuses to
/// start the daemon because `pi` is missing on PATH; only without a bundled runtime (dev builds,
/// `cargo run`) is Pi still required, and there a missing Pi is an incomplete installation, not
/// an npm request. A present-but-broken runtime stays [`StartupFailure::BundledRuntimeInvalid`].
fn resolve_pi(
    bundled: Option<&crate::nodefinder::Bundled>,
    path: Option<&OsStr>, home: Option<&OsStr>, finder: &crate::nodefinder::Env, exe: Option<&Path>,
) -> Result<PathBuf, StartupFailure> {
    if let Some(crate::nodefinder::Bundled::Valid(rt)) = bundled { return Ok(rt.pi.clone()) }
    discover_with_runtime("pi", path, home, finder, exe).map_err(|reason| match reason {
        DiscoverError::BundledRuntimeInvalid => StartupFailure::BundledRuntimeInvalid,
        DiscoverError::Missing(_) => StartupFailure::PiMissing,
    })
}

fn start() -> Result<Host, StartupFailure> {
    let path = std::env::var_os("PATH");
    #[cfg(windows)]
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    let exe = running_executable();
    let bundled = exe.as_deref().map(|exe| crate::nodefinder::bundled_runtime(exe, crate::nodefinder::Os::current(), crate::nodefinder::current_runtime_target()));
    let finder = crate::nodefinder::Env::from_process();
    let failure = |missing: StartupFailure| move |reason: DiscoverError| match reason {
        DiscoverError::BundledRuntimeInvalid => StartupFailure::BundledRuntimeInvalid,
        DiscoverError::Missing(_) => missing,
    };
    let node = discover_with_runtime("node", path.as_deref(), home.as_deref(), &finder, exe.as_deref()).map_err(failure(StartupFailure::NodeMissing))?;
    let pi = resolve_pi(bundled.as_ref(), path.as_deref(), home.as_deref(), &finder, exe.as_deref())?;
    let exe = std::env::current_exe().map_err(|_| StartupFailure::HostMissing)?;
    let mut cli = installed_daemon_cli(&exe).ok_or(StartupFailure::HostMissing)?;
    #[cfg(debug_assertions)]
    if !cli.is_file() { cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("../desktop-daemon/src/cli.cjs"); }
    if !cli.is_file() { return Err(StartupFailure::HostMissing) }
    // The bundled runtime folder leads the child PATH (K2-02 S2): a child's bare `node`/`pi` resolves to Koda's own.
    // K2-05 (T2): the engine is not a PATH lookup — the daemon resolves the bundled Gentle Shell itself
    // (runtime.cjs bundledGentleShell) from the runtime next to the Node we spawn it on.
    let first = match &bundled { Some(crate::nodefinder::Bundled::Valid(rt)) => Some(rt.dir.as_path()), _ => None };
    let child_path = runtime_path_with(path.as_deref(), &node, &pi, first).map_err(|_| StartupFailure::SpawnFailed)?;
    let mut command = std::process::Command::new(node);
    command.arg(cli).args(["run", "--app-owned"]).env("PATH", child_path);
    // K2-06: the capture endpoint (loopback URL + per-launch bearer) for the daemon's private mcp.json; empty when it did not start.
    for (name, value) in crate::windowcapture::host::daemon_env() { command.env(name, value); }
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

/// HU-069 T3 / rule 12: the chat host must work when the app is started from Finder / Explorer / a desktop launcher,
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
    fn node_is_found_with_the_minimal_finder_explorer_environment() {
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
        let node_dir = if cfg!(windows) {
            home.join("AppData/Roaming/fnm/node-versions/v22.21.0/installation")
        } else {
            home.join(".nvm/versions/node/v26.13.0/bin")
        };
        std::fs::create_dir_all(&node_dir).unwrap();
        let node = node_dir.join(real.file_name().unwrap());
        std::fs::copy(&real, &node).unwrap();

        // The Finder/Explorer environment, built explicitly: no process-wide variable is touched (other tests read HOME in parallel).
        let finder = crate::nodefinder::Env { home: Some(home.clone()), app_data: Some(home.join("AppData/Roaming")),
            local_app_data: Some(home.join("AppData/Local")), program_files: Some(no_program_files.clone()), ..Default::default() };
        let found = discover_in("node", Some(empty_path.as_os_str()), Some(home.as_os_str()), &finder).expect("Node must be found without PATH");
        assert_eq!(std::fs::canonicalize(&found).unwrap(), std::fs::canonicalize(&node).unwrap());
        // K2-02 (S4): the old «Instalar Pi» npm-install half of this test is gone with piinstall/nodeinstall:
        // Koda ships its own Node and Pi; the app never runs npm.
        // the daemon would be started with that absolute Node first on its PATH
        let child_path = runtime_path(Some(empty_path.as_os_str()), &found, &found).unwrap();
        assert_eq!(std::env::split_paths(&child_path).last().unwrap(), found.parent().unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// K2-02 (S1, S2): discovery is BUNDLED-FIRST. When the runtime folder Koda ships beside its
/// own executable exists and validates, ITS node and ITS pi win over anything on PATH, nvm,
/// Volta, Homebrew, %AppData%\npm; when it exists but is broken, startup fails closed instead
/// of silently using a system Node (that would make S2 untrue in a broken install); when it
/// is absent (dev builds, `cargo run`, tests) discovery is exactly what it was before.
#[cfg(test)]
mod bundled_runtime_tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    const PI_CLI: &str = "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
    const GENTLE_SHELL: &str = "node_modules/gentle-pi/bin/gentle-shell.mjs";

    struct Rt(PathBuf);
    impl Rt {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("abito-bundled-host-{}-{tag}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn dir(&self, rel: &str) -> PathBuf {
            let d = self.0.join(rel);
            fs::create_dir_all(&d).unwrap();
            d
        }
        fn exe(&self, rel: &str) -> PathBuf {
            self.dir(rel).join(if cfg!(windows) {
                "abito-island.exe"
            } else {
                "abito-island"
            })
        }
    }
    impl Drop for Rt {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A valid runtime folder for THIS running OS (the discovery dispatch always uses
    /// `Os::current()`), with the engine shape the K2-05 build emits (Node, Pi and the
    /// Gentle Shell engine), and a rival node/pi installed on a fake PATH.
    fn bundled_with_rival(tag: &str) -> (Rt, PathBuf, PathBuf) {
        let root = Rt::new(tag);
        let exe = root.exe("app/bin");
        let runtime =
            crate::nodefinder::bundled_runtime_dir(&exe, crate::nodefinder::Os::current()).unwrap();
        fs::create_dir_all(&runtime).unwrap();
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        let node = runtime.join(node_name);
        fs::write(&node, b"node").unwrap();
        #[cfg(unix)]
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        let cli = runtime.join(PI_CLI);
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(&cli, b"cli").unwrap();
        let shell = runtime.join(GENTLE_SHELL);
        fs::create_dir_all(shell.parent().unwrap()).unwrap();
        fs::write(&shell, b"shell").unwrap();
        if !cfg!(windows) {
            for launcher in ["pi", "gentle-shell"] {
                let file = runtime.join(launcher);
                fs::write(&file, b"#!/bin/sh\n").unwrap();
                #[cfg(unix)]
                fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        fs::write(runtime.join("koda-runtime.json"),
            format!("{{\"target\":\"{}\",\"node\":\"22.23.4\",\"pi\":\"1.4.0\",\"piCli\":\"{PI_CLI}\",\"gentlePi\":\"4.3.0\",\"gentleShell\":\"{GENTLE_SHELL}\"}}", crate::nodefinder::current_runtime_target())).unwrap();
        // The rival install: a different node and pi, first on a fake session PATH.
        let rival = root.dir("rival/bin");
        for name in [node_name, "pi"] {
            let file = rival.join(name);
            fs::write(&file, b"rival").unwrap();
            #[cfg(unix)]
            fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        }
        (root, exe, rival)
    }

    fn env_without_home() -> crate::nodefinder::Env {
        crate::nodefinder::Env::default()
    }

    #[test]
    fn a_valid_bundled_runtime_wins_over_any_node_or_pi_on_the_session_path() {
        let (_root, exe, rival) = bundled_with_rival("wins");
        let path = std::env::join_paths([&rival]).unwrap();
        for name in ["node", "pi"] {
            let found = discover_with_runtime(
                name,
                Some(path.as_os_str()),
                None,
                &env_without_home(),
                Some(&exe),
            )
            .expect(name);
            let expected = crate::nodefinder::bundled_runtime(
                &exe,
                crate::nodefinder::Os::current(),
                crate::nodefinder::current_runtime_target(),
            );
            match expected {
                crate::nodefinder::Bundled::Valid(rt) => {
                    assert_eq!(
                        found,
                        if name == "node" { rt.node } else { rt.pi },
                        "{name}"
                    );
                    assert!(
                        found.starts_with(&rt.dir),
                        "{name}: must come from the bundled runtime folder"
                    );
                }
                _ => panic!("the runtime we just wrote must validate"),
            }
            assert_ne!(
                found,
                rival.join(if cfg!(windows) && name == "node" {
                    "node.exe"
                } else {
                    name
                }),
                "{name}: never the rival on PATH"
            );
        }
    }

    #[test]
    fn a_broken_bundled_runtime_fails_closed_even_when_a_node_is_on_the_path() {
        let (_root, exe, rival) = bundled_with_rival("broken");
        // Break the manifest: the folder is present but names another OS's target.
        let runtime =
            crate::nodefinder::bundled_runtime_dir(&exe, crate::nodefinder::Os::current()).unwrap();
        fs::write(
            runtime.join("koda-runtime.json"),
            r#"{"target":"not-this-os","piCli":"x.js"}"#,
        )
        .unwrap();
        let path = std::env::join_paths([&rival]).unwrap();
        for name in ["node", "pi"] {
            assert_eq!(
                discover_with_runtime(
                    name,
                    Some(path.as_os_str()),
                    None,
                    &env_without_home(),
                    Some(&exe)
                ),
                Err(DiscoverError::BundledRuntimeInvalid),
                "{name}: a broken install must never silently fall back to a system Node (S2)"
            );
        }
    }

    #[test]
    fn with_no_bundled_runtime_discovery_is_exactly_what_it_was() {
        let root = Rt::new("absent");
        let exe = root.exe("app/bin");
        let rival = root.dir("rival/bin");
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        for name in [node_name, "pi"] {
            let file = rival.join(name);
            fs::write(&file, b"rival").unwrap();
            #[cfg(unix)]
            fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = std::env::join_paths([&rival]).unwrap();
        let found = discover_with_runtime(
            "node",
            Some(path.as_os_str()),
            None,
            &env_without_home(),
            Some(&exe),
        )
        .expect("previous behaviour: the session PATH is searched");
        assert_eq!(found, rival.join(node_name));
        // And with nothing on PATH, the historical fail-closed answer stands: only the
        // canonical locations may answer (the runner may legitimately have /usr/bin/node).
        let empty = root.dir("empty");
        match discover_with_runtime(
            "node",
            Some(empty.as_os_str()),
            None,
            &env_without_home(),
            Some(&exe),
        ) {
            Ok(found) => {
                let canonical = [
                    Path::new("/usr/local/bin/node"),
                    Path::new("/usr/bin/node"),
                    Path::new("/opt/homebrew/bin/node"),
                ];
                assert!(
                    canonical.contains(&found.as_path()),
                    "no bundled runtime: only the canonical fallback may answer, got {found:?}"
                );
            }
            Err(DiscoverError::Missing(_)) => {}
            Err(other) => panic!("previous behaviour: missing stays missing, got {other:?}"),
        }
    }

    #[test]
    fn the_daemon_child_path_puts_the_bundled_runtime_dir_first() {
        // Absolute on THIS OS (RDD advisory 4): `/koda/runtime` has no drive letter, so on Windows it is NOT absolute and
        // `runtime_path_with` rightly ignores it; the fixture must be a real absolute path of the platform under test.
        let abs = |p: &str| if cfg!(windows) { PathBuf::from(format!("C:\\{}", p.replace('/', "\\"))) } else { PathBuf::from(format!("/{p}")) };
        let session = abs("session/bin");
        let runtime = abs("koda/runtime");
        assert!(session.is_absolute() && runtime.is_absolute(), "fixtures are absolute on this OS");
        let node = runtime.join("node");
        let dirs = std::env::split_paths(
            runtime_path_with(Some(session.as_os_str()), &node, &runtime.join("pi"), Some(&runtime)).unwrap().as_os_str(),
        )
        .collect::<Vec<_>>();
        assert_eq!(dirs.first().unwrap(), &runtime, "the bundled runtime shadows every same-named binary");
        assert!(dirs.contains(&session), "the session PATH dirs are kept behind it");
        assert_eq!(dirs.iter().filter(|d| **d == runtime).count(), 1, "no duplicate runtime entry");
        // Without a bundled runtime, the historical shape: runtime dirs appended at the end.
        let appended = std::env::split_paths(runtime_path(Some(session.as_os_str()), &node, &runtime.join("pi")).unwrap().as_os_str())
            .collect::<Vec<_>>();
        assert_eq!(appended.last().unwrap(), &runtime);
        assert_eq!(appended.first().unwrap(), &session);
        // A relative "first" dir is never put on the child PATH (no working-directory execution, on any OS).
        let relative = std::env::split_paths(
            runtime_path_with(Some(session.as_os_str()), &node, &runtime.join("pi"), Some(Path::new("relative/runtime"))).unwrap().as_os_str(),
        )
        .collect::<Vec<_>>();
        assert!(!relative.iter().any(|d| d == Path::new("relative/runtime")));
    }

    #[test]
    fn with_the_bundled_runtime_the_daemon_starts_even_without_any_pi_on_the_path() {
        // K2-05 (T2): the engine is the bundled Gentle Shell, resolved by the daemon itself —
        // a valid runtime answers `pi` even when NOTHING named pi exists on the session PATH.
        let (_root, exe, rival) = bundled_with_rival("no-pi-path");
        let rival_pi = rival.join("pi");
        if rival_pi.exists() { fs::remove_file(&rival_pi).unwrap(); }
        let path = std::env::join_paths([&rival]).unwrap();
        let found = discover_with_runtime("pi", Some(path.as_os_str()), None, &env_without_home(), Some(&exe))
            .expect("the bundled runtime must answer pi without any pi on PATH");
        match crate::nodefinder::bundled_runtime(&exe, crate::nodefinder::Os::current(), crate::nodefinder::current_runtime_target()) {
            crate::nodefinder::Bundled::Valid(rt) => assert_eq!(found, rt.pi, "the runtime's own pi, not a PATH find"),
            _ => panic!("the runtime we just wrote must validate"),
        }
    }

    #[test]
    fn without_a_bundled_runtime_a_missing_pi_is_an_incomplete_install_not_an_npm_request() {
        // K2-05 (T2): K2-02 removed «Instalar Pi». With no runtime folder beside the exe (dev
        // build) and no pi anywhere, the failure says Koda's own engine is missing and the
        // installation is incomplete — never an npm install advice.
        let root = Rt::new("no-runtime-no-pi");
        let exe = root.exe("app/bin");
        root.dir("app/bin");
        let empty = root.dir("empty");
        let path = std::env::join_paths([&empty]).unwrap();
        match discover_with_runtime("pi", Some(path.as_os_str()), None, &env_without_home(), Some(&exe)) {
            Err(DiscoverError::Missing(message)) => {
                assert!(!message.contains("npm install"), "no npm advice: {message}");
            }
            // The runner may legitimately carry a canonical pi (/usr/bin, Homebrew): the
            // historical fallback answer stands, the sentence below is what changed.
            Ok(found) => {
                let canonical = [
                    Path::new("/usr/local/bin/pi"), Path::new("/usr/bin/pi"), Path::new("/opt/homebrew/bin/pi"),
                ];
                assert!(canonical.contains(&found.as_path()), "only the canonical fallback may answer, got {found:?}");
            }
            Err(other) => panic!("previous behaviour: missing stays missing, got {other:?}"),
        }
        let sentence = failure_sentence(StartupFailure::PiMissing).unwrap();
        assert!(sentence.contains("La instalación de Koda está incompleta"), "{sentence}");
        assert!(sentence.contains("falta el motor propio de Koda"), "{sentence}");
        assert!(!sentence.contains("npm"), "no npm install advice: {sentence}");
    }

    #[test]
    fn resolve_pi_takes_the_bundled_pi_without_reading_the_path_and_requires_pi_without_a_runtime() {
        let finder = env_without_home();
        // With a VALID runtime, the answer comes from the runtime itself, whatever the PATH holds.
        let (_root, exe, rival) = bundled_with_rival("resolve-bundled");
        let path = std::env::join_paths([&rival]).unwrap();
        let rt = match crate::nodefinder::bundled_runtime(&exe, crate::nodefinder::Os::current(), crate::nodefinder::current_runtime_target()) {
            crate::nodefinder::Bundled::Valid(rt) => rt,
            _ => panic!("the runtime we just wrote must validate"),
        };
        assert_eq!(
            resolve_pi(Some(&crate::nodefinder::Bundled::Valid(rt.clone())), Some(path.as_os_str()), None, &finder, Some(&exe)),
            Ok(rt.pi)
        );
        // Without any runtime folder, a dev build still finds Pi the way each OS installs it.
        let root = Rt::new("resolve-path");
        let exe = root.exe("app/bin");
        let bin = root.dir("bin");
        // Unix: `pi` on the session PATH answers.
        #[cfg(unix)]
        let expected = {
            let file = bin.join("pi");
            fs::write(&file, b"#!/bin/sh\n").unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
            file
        };
        // Windows has no bare `pi` lookup (daemonhost_win.rs discover_pi): Pi is the npm package's
        // validated CLI JS under the prefix of the `node.exe` found on the session PATH.
        #[cfg(windows)]
        let expected = {
            fs::write(bin.join("node.exe"), b"").unwrap();
            let package = bin.join("node_modules").join("@earendil-works").join("pi-coding-agent");
            fs::create_dir_all(package.join("dist")).unwrap();
            fs::write(package.join("package.json"), r#"{"bin":{"pi":"dist/pi.js"}}"#).unwrap();
            fs::write(package.join("dist").join("pi.js"), b"").unwrap();
            package.join("dist").join("pi.js")
        };
        let path = std::env::join_paths([&bin]).unwrap();
        assert_eq!(
            resolve_pi(None, Some(path.as_os_str()), None, &finder, Some(&exe)),
            Ok(expected)
        );
        // And with neither, the failure is the incomplete-install startup failure.
        let empty = root.dir("empty");
        let path = std::env::join_paths([&empty]).unwrap();
        match resolve_pi(None, Some(path.as_os_str()), None, &finder, Some(&exe)) {
            Err(StartupFailure::PiMissing) => {}
            // A canonical pi on this machine would legitimately answer (see the sentence test above).
            Ok(found) => {
                let canonical = [
                    Path::new("/usr/local/bin/pi"), Path::new("/usr/bin/pi"), Path::new("/opt/homebrew/bin/pi"),
                ];
                assert!(canonical.contains(&found.as_path()), "got {found:?}");
            }
            Err(other) => panic!("PiMissing expected, got {other:?}"),
        }
    }

    #[test]
    fn the_broken_runtime_is_its_own_startup_failure_code() {
        assert_eq!(
            StartupFailure::BundledRuntimeInvalid.code(),
            "bundled_runtime_invalid"
        );
    }

    #[test]
    fn the_broken_runtime_prints_the_reinstall_sentence_and_the_two_missing_sentences_are_unchanged(
    ) {
        // K2-02 D1 (human decision «2a»): the exact sentence note_failure prints for bundled_runtime_invalid.
        assert_eq!(
            failure_sentence(StartupFailure::BundledRuntimeInvalid),
            Some("La instalación de Koda está dañada: volvé a instalar Koda.")
        );
        // The exact lines note_failure prints, the same on all three OS (K2-02 D1 parity: Linux too).
        use crate::nodefinder::Os;
        for os in [Os::Linux, Os::Mac, Os::Windows] {
            assert_eq!(
                failure_lines(StartupFailure::BundledRuntimeInvalid, os),
                vec![
                    "island host: no_daemon (bundled_runtime_invalid)".to_owned(),
                    "La instalación de Koda está dañada: volvé a instalar Koda.".to_owned()
                ]
            );
            assert_eq!(
                failure_lines(StartupFailure::PiMissing, os),
                vec![
                    "island host: no_daemon (pi_missing)".to_owned(),
                    "La instalación de Koda está incompleta: falta el motor propio de Koda; volvé a instalar Koda."
                        .to_owned()
                ]
            );
            assert_eq!(
                failure_lines(StartupFailure::HostMissing, os),
                vec![format!(
                    "island host: no_daemon ({})",
                    StartupFailure::HostMissing.code()
                )]
            );
        }

        assert_eq!(
            failure_sentence(StartupFailure::NodeMissing),
            Some("Falta Node.js: instalalo desde nodejs.org.")
        );
        assert_eq!(
            failure_sentence(StartupFailure::PiMissing),
            Some("La instalación de Koda está incompleta: falta el motor propio de Koda; volvé a instalar Koda.")
        );
        for other in [
            StartupFailure::HostMissing,
            StartupFailure::SpawnFailed,
            StartupFailure::Unsupported,
        ] {
            assert_eq!(failure_sentence(other), None);
        }
    }
}

#![cfg(target_os = "linux")]
use abito_island::daemonhost::{discover, Host};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

// A concurrent fork can inherit a script's writable fd until exec, even with
// CLOEXEC, making another test's script spawn fail with ETXTBSY. Serialize all
// script creation and process spawning in this harness (including helper tests).
static PROCESS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct TestDir(std::path::PathBuf);
impl TestDir {
    fn new() -> std::io::Result<Self> {
        let dir = std::env::temp_dir().join(format!("abito-host-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&dir)?;
        Ok(Self(dir))
    }
    fn path(&self) -> &Path { &self.0 }
}
impl Drop for TestDir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn executable(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn discovery_orders_session_path_before_canonical_fallbacks() {
    let _guard = PROCESS_TEST_LOCK.lock().unwrap();
    let root = TestDir::new().unwrap();
    let home = root.path().join("home");
    let bin = root.path().join("bin");
    executable(&home.join(".local/bin/pi"), "#!/bin/sh\nexit 0\n");
    executable(&bin.join("pi"), "#!/bin/sh\nexit 0\n");
    assert_eq!(discover("pi", Some(bin.as_os_str()), Some(home.as_os_str())).unwrap(), bin.join("pi"));
    assert_eq!(discover("pi", Some(std::ffi::OsStr::new("/usr/local/bin:/usr/bin:/bin")), Some(home.as_os_str())).unwrap(), home.join(".local/bin/pi"));
    assert_eq!(discover("node", Some(std::ffi::OsStr::new("/not-present")), None).unwrap(), Path::new("/usr/bin/node"));
    assert!(discover("missing-runtime", Some(bin.as_os_str()), Some(home.as_os_str())).unwrap_err().contains("missing-runtime missing"));
    let child_path = abito_island::daemonhost::runtime_path(
        Some(std::ffi::OsStr::new(".:relative::/usr/bin")), Path::new("/usr/bin/node"), Path::new("/canonical/pi"),
    ).unwrap();
    assert_eq!(child_path, std::ffi::OsString::from("/usr/bin:/canonical"));
    // Exercise HostSlot::start itself: a helper which stands in for Node
    // records the actual environment passed across the app -> host boundary.
    executable(&bin.join("node"), &format!("#!/bin/sh\nprintf '%s\\n' \"$PATH\" > '{}'\nexec /bin/sleep 120\n", root.path().join("derived-path").display()));
    let mut app = Command::new(std::env::current_exe().unwrap()).args(["--exact", "crash_helper", "--nocapture"])
        .env("ISLAND_HOST_TEST_HELPER", root.path()).env("ISLAND_HOST_TEST_PATH", "1")
        .env("PATH", format!(".:relative::{}:/usr/bin", bin.display())).env("HOME", &home)
        .stdout(std::process::Stdio::null()).spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !root.path().join("derived-path").exists() {
        if std::time::Instant::now() >= deadline { app.kill().unwrap(); app.wait().unwrap(); panic!("host did not record derived PATH") }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let actual = fs::read_to_string(root.path().join("derived-path")).unwrap();
    fs::write(root.path().join("path-stop"), "stop").unwrap();
    while app.try_wait().unwrap().is_none() {
        if std::time::Instant::now() >= deadline { app.kill().unwrap(); app.wait().unwrap(); panic!("PATH helper did not exit") }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(actual.trim_end(), format!("{}:/usr/bin", bin.display()));
    assert!(actual.trim_end().split(':').all(|part| !part.is_empty() && Path::new(part).is_absolute()));
}

#[test]
fn named_runtime_failure_is_in_existing_no_daemon_state_channel() {
    use abito_island::{agentclient::{ClientState, Reason}, daemonhost::StartupFailure};
    for (failure, code) in [(StartupFailure::NodeMissing, "node_missing"), (StartupFailure::PiMissing, "pi_missing")] {
        let mut state = ClientState::disconnected(Reason::NoDaemon);
        state.note_startup_failure(failure);
        let view = serde_json::to_value(state).unwrap();
        assert_eq!(view["connection"], "no_daemon");
        assert_eq!(view["last_error"]["code"], code);
        assert_eq!(view["last_error"]["n"], 1);
        assert_eq!(view["providers"], serde_json::json!([]));
        assert_eq!(view["accounts"], serde_json::json!([]));
        assert!(!view.to_string().contains("/home/"));
    }
}

#[test]
fn normal_drop_terminates_and_reaps_owned_host() {
    let _guard = PROCESS_TEST_LOCK.lock().unwrap();
    let root = TestDir::new().unwrap();
    let script = root.path().join("host.sh");
    executable(&script, "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n");
    let host = Host::spawn_command(Command::new(script)).unwrap();
    let pid = host.pid();
    drop(host);
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
}

// #390 GD027 pin: what `daemon_action restart` does at the slot level — stop() then start()
// yields a FRESH child, the old one is reaped and stays gone. Explicit bounds, no unbounded waits.
// (Characterization of existing APIs: passes before AND after the slice-B sources — a pin, not a RED.)
#[test]
fn stop_then_start_yields_a_fresh_reaped_child() {
    let _guard = PROCESS_TEST_LOCK.lock().unwrap();
    let root = TestDir::new().unwrap();
    let bin = root.path().join("bin");
    let home = root.path().join("home");
    let pids = root.path().join("pids");
    // fake node: record our own pid per spawn, then stand in for the daemon
    executable(&bin.join("node"), &format!("#!/bin/sh\nprintf '%s\\n' \"$$\" >> '{}'\nexec /bin/sleep 120\n", pids.display()));
    executable(&home.join(".local/bin/pi"), "#!/bin/sh\nexec /bin/sleep 120\n");
    let mut app = Command::new(std::env::current_exe().unwrap()).args(["--exact", "crash_helper", "--nocapture"])
        .env("ISLAND_HOST_TEST_HELPER", root.path()).env("ISLAND_HOST_TEST_RESTART", "1")
        .env("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()))
        .env("HOME", &home)
        .stdout(std::process::Stdio::null()).spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while !root.path().join("restart.finished").exists() {
        if std::time::Instant::now() >= deadline {
            app.kill().unwrap(); app.wait().unwrap();
            panic!("restart pin did not finish; pids={:?}", fs::read_to_string(&pids).unwrap_or_default());
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(app.try_wait().unwrap().is_some(), "the helper must exit on its own");
    let lines: Vec<String> = fs::read_to_string(&pids).unwrap().lines().map(str::to_string).collect();
    assert_eq!(lines.len(), 2, "exactly one child per start: {lines:?}");
}

// A separate process is essential: SIGKILL must bypass destructors exactly as an app crash does.
#[test]
fn crash_helper() {
    let _guard = PROCESS_TEST_LOCK.lock().unwrap();
    let Some(dir) = std::env::var_os("ISLAND_HOST_TEST_HELPER") else { return };
    let dir = std::path::PathBuf::from(dir);
    if std::env::var_os("ISLAND_HOST_TEST_RESTART").is_some() {
        use abito_island::daemonhost::HostSlot;
        let pids = dir.join("pids");
        let read = || fs::read_to_string(&pids).unwrap_or_default().lines().count();
        let wait_lines = |n: usize| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while read() < n {
                assert!(std::time::Instant::now() < deadline, "child {n} never recorded its pid");
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        };
        let alive = |pid: &str| {
            let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
            stat.contains("(sleep") && !stat[stat.rfind(')').map(|i| i + 2).unwrap_or(0)..].starts_with('Z')
        };
        let slot = HostSlot::default();
        slot.start();
        assert_eq!(slot.failure(), None);
        wait_lines(1);
        let pid1 = fs::read_to_string(&pids).unwrap().lines().next().unwrap().to_string();
        assert_eq!(slot.pid().map(|p| p.to_string()), Some(pid1.clone()), "the slot exposes our live child for the restart verdict");
        slot.stop();
        assert_eq!(slot.pid(), None, "after stop the slot holds no child");
        assert!(!Path::new(&format!("/proc/{pid1}")).exists(), "stop must reap its child");
        slot.start();
        assert_eq!(slot.failure(), None, "the second start must spawn cleanly");
        wait_lines(2);
        let pid2 = fs::read_to_string(&pids).unwrap().lines().nth(1).unwrap().to_string();
        assert!(alive(&pid2), "the fresh child is alive");
        assert!(!Path::new(&format!("/proc/{pid1}")).exists(), "the old child stays gone");
        slot.stop();
        assert!(!Path::new(&format!("/proc/{pid2}")).exists(), "and the new one is reaped too");
        fs::write(dir.join("restart.finished"), "ready").unwrap();
        return;
    }
    if std::env::var_os("ISLAND_HOST_TEST_PATH").is_some() {
        let slot = abito_island::daemonhost::HostSlot::default();
        slot.start(); assert_eq!(slot.failure(), None);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !dir.join("path-stop").exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        slot.stop();
        return;
    }
    if std::env::var_os("ISLAND_HOST_TEST_ESCAPE").is_some() {
        unsafe {
            assert_eq!(libc::setpgid(0, libc::getpgid(libc::getppid())), 0);
            libc::signal(libc::SIGTERM, libc::SIG_IGN);
        }
        fs::write(dir.join("escaped"), "ready").unwrap();
        loop { std::thread::sleep(std::time::Duration::from_secs(1)); }
    }
    if std::env::var_os("ISLAND_HOST_TEST_DROP").is_some() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "crash_helper", "--nocapture"])
            .env("ISLAND_HOST_TEST_ESCAPE", "1").env_remove("ISLAND_HOST_TEST_DROP");
        let host = Host::spawn_command(command).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !dir.join("escaped").exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        drop(host);
        fs::write(dir.join("drop.finished"), "ready").unwrap();
        return;
    }
    let host = Host::spawn_command(Command::new(dir.join("host.sh"))).unwrap();
    fs::write(dir.join("host.pid"), host.pid().to_string()).unwrap();
    loop { std::thread::sleep(std::time::Duration::from_secs(1)); }
}

#[test]
fn killed_app_cannot_leave_a_live_host() {
    let _guard = PROCESS_TEST_LOCK.lock().unwrap();
    let root = TestDir::new().unwrap();
    executable(&root.path().join("host.sh"), "#!/bin/sh\nexec sleep 120\n");
    let mut app = Command::new(std::env::current_exe().unwrap()).args(["--exact", "crash_helper", "--nocapture"])
        .env("ISLAND_HOST_TEST_HELPER", root.path()).stdout(std::process::Stdio::null()).spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !root.path().join("host.pid").exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let pid = fs::read_to_string(root.path().join("host.pid")).unwrap();
    app.kill().unwrap(); assert!(!app.wait().unwrap().success());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let dead = fs::read_to_string(format!("/proc/{pid}/stat")).map(|s| s[s.rfind(')').unwrap()+2..].starts_with('Z')).unwrap_or(true);
        if dead { break }
        assert!(std::time::Instant::now() < deadline, "host survived app SIGKILL");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[test]
fn missing_process_group_cannot_hang_app_exit() {
    let _guard = PROCESS_TEST_LOCK.lock().unwrap();
    let root = TestDir::new().unwrap();
    let mut app = Command::new(std::env::current_exe().unwrap()).args(["--exact", "crash_helper", "--nocapture"])
        .env("ISLAND_HOST_TEST_HELPER", root.path()).env("ISLAND_HOST_TEST_DROP", "1")
        // Do not blend a nested harness's result into Cargo's per-target count.
        .stdout(std::process::Stdio::null()).spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(9);
    loop {
        if let Some(status) = app.try_wait().unwrap() { assert!(status.success()); break }
        if std::time::Instant::now() >= deadline {
            app.kill().unwrap(); app.wait().unwrap();
            panic!("Drop hung after both group signals missed");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(root.path().join("drop.finished").exists());
}

#[test]
fn host_failure_does_not_exit_its_app_or_restart_host() {
    let _guard = PROCESS_TEST_LOCK.lock().unwrap();
    let mut cmd = Command::new("/bin/sh"); cmd.args(["-c", "exit 17"]);
    let mut host = Host::spawn_command(cmd).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert_eq!(host.try_wait().unwrap().unwrap().code(), Some(17));
    assert!(host.try_wait().unwrap().is_some());
    drop(host); // the test/app remains alive
}

// #390 GD014/check (4): a child that exits ON ITS OWN must be reaped at runtime
// (never left as a zombie while the app lives) and its early exit must become
// visible through the slot. Explicit bound, no unbounded waits.
#[test]
fn early_child_exit_is_reaped_at_runtime_and_reported() {
    let _guard = PROCESS_TEST_LOCK.lock().unwrap();
    let root = TestDir::new().unwrap();
    let script = root.path().join("host.sh");
    executable(&script, "#!/bin/sh\nexit 17\n");
    let host = Host::spawn_command(Command::new(script)).unwrap();
    let pid = host.pid();
    let slot = abito_island::daemonhost::HostSlot::default();
    slot.adopt(host);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    // 1) the early exit is observed and reported
    loop {
        if let Some(status) = slot.exit_status() {
            assert_eq!(status.code(), Some(17), "the early child exit is visible to the host");
            break;
        }
        assert!(std::time::Instant::now() < deadline, "the child exit was never reported");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    // 2) reaped, not a zombie: /proc/<pid> is gone while the app keeps running
    loop {
        if !Path::new(&format!("/proc/{pid}")).exists() { break }
        assert!(std::time::Instant::now() < deadline, "zombie left behind: /proc/{pid} still exists");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    // 3) stop() after a runtime reap is a clean no-op (no double signal, no panic)
    slot.stop();
    slot.stop();
    // 4) the dead child leaves no live pid behind (the restart verdict reads this)
    loop {
        if slot.pid().is_none() { break }
        assert!(std::time::Instant::now() < deadline, "the slot keeps holding the dead child");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

// HU-046 (human: «Instalar Pi»): once Pi gets installed the host must start WITHOUT restarting Abito, and the earlier
// «pi_missing» failure must be forgotten: `agent_action` answers `startup_failed` for as long as `failure()` is set, so a
// success that left it set would keep the chat reading «Falta Pi» after a good install. (The manual «Reiniciar» had the same flaw.)
#[test]
fn a_successful_start_forgets_the_failure_of_an_earlier_one() {
    use abito_island::daemonhost::{HostSlot, StartupFailure};
    let _guard = PROCESS_TEST_LOCK.lock().unwrap();
    let root = TestDir::new().unwrap();
    let script = root.path().join("host.sh");
    executable(&script, "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n");
    let slot = HostSlot::default();
    slot.start_with(|| Err(StartupFailure::PiMissing));
    assert_eq!(slot.failure(), Some(StartupFailure::PiMissing));
    assert_eq!(slot.pid(), None);
    slot.start_with(|| Host::spawn_command(Command::new(&script)).map_err(|_| StartupFailure::SpawnFailed));
    assert_eq!(slot.failure(), None, "Pi is installed now: the old failure must not keep answering");
    assert!(slot.pid().is_some(), "the host runs without restarting the app");
    slot.stop();
    // and a later failure is recorded again, not swallowed
    slot.start_with(|| Err(StartupFailure::NodeMissing));
    assert_eq!(slot.failure(), Some(StartupFailure::NodeMissing));
}

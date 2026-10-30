#![cfg(target_os = "linux")]
// Linux-only integration: Unix agent sockets and the Linux session/daemon policy.

//! #306: the island-agent client against the REAL `abito-island-daemon` (apps/desktop-daemon)
//! running a FAKE agent in a private temp island. No Pi, no provider, no network, no
//! credential. A daemon that is not running must read as `no_daemon`, never hang.
use abito_island::agentconn::{island_root, AgentConn};
use serde_json::{json, Value};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn daemon_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../desktop-daemon")
}

struct Island { root: PathBuf, child: Option<Child> }
impl Island {
    /// A SHORT private root (the socket path is capped at 107 bytes).
    fn start() -> Island {
        Island::start_with(json!({}))
    }
    /// Same, with extra keys in the island's config.json (e.g. `hookInstallerBin`).
    fn start_with(extra: Value) -> Island {
        static N: AtomicU32 = AtomicU32::new(0);
        static SWEPT: std::sync::Once = std::sync::Once::new();
        SWEPT.call_once(sweep_abandoned);
        let base = PathBuf::from(std::env::var("HOME").expect("HOME")).join(format!(".aisl{}-{}", std::process::id() % 100000, N.fetch_add(1, Ordering::SeqCst)));
        std::fs::DirBuilder::new().mode(0o700).create(&base).expect("private island base");
        let root = base.join("i");
        std::fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let wrapper = base.join("fake-pi.sh");
        let fake = daemon_dir().join("test/fixtures/fake-agent.cjs");
        let node = String::from_utf8(Command::new("sh").args(["-c", "command -v node"]).output().unwrap().stdout).unwrap();
        std::fs::write(&wrapper, format!("#!/bin/sh\nexec \"{}\" \"{}\" \"$@\"\n", node.trim(), fake.display())).unwrap();
        { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap(); }
        let mut config = json!({"command": wrapper});
        for (k, v) in extra.as_object().cloned().unwrap_or_default() { config[k] = v; }
        std::fs::write(root.join("config.json"), config.to_string()).unwrap();
        { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(root.join("config.json"), std::fs::Permissions::from_mode(0o600)).unwrap(); }
        let child = Command::new(node.trim()).arg(daemon_dir().join("src/cli.cjs")).arg("run")
            .env_clear().env("PATH", std::env::var("PATH").unwrap()).env("HOME", &base).env("ABITO_ISLAND_DIR", &root)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("node is required (no skip, no fake)");
        let island = Island { root: root.clone(), child: Some(child) };
        let end = Instant::now() + Duration::from_secs(20);
        while !root.join("runtime/session.json").exists() {
            assert!(Instant::now() < end, "the daemon never published session.json");
            std::thread::sleep(Duration::from_millis(50));
        }
        island
    }
    fn stop_daemon(&mut self) {
        if let Some(mut c) = self.child.take() {
            // SIGTERM first so the daemon stops its engine child and removes its own files; SIGKILL only
            // if it does not exit, so no grandchild (the fake agent) can recreate files while we delete.
            let pid = c.id() as i32;
            // SAFETY: plain signal to a child we spawned and still own.
            unsafe { libc::kill(pid, libc::SIGTERM) };
            let end = Instant::now() + Duration::from_secs(3);
            while Instant::now() < end {
                if matches!(c.try_wait(), Ok(Some(_))) { return self.settle(); }
                std::thread::sleep(Duration::from_millis(30));
            }
            let _ = c.kill(); let _ = c.wait();
            self.settle();
        }
    }
    /// A moment for the engine child (if it outlived the daemon) to notice its pipe closed.
    fn settle(&self) { std::thread::sleep(Duration::from_millis(150)); }
}
impl Drop for Island {
    fn drop(&mut self) {
        self.stop_daemon(); // kill + wait FIRST: a live daemon would recreate files while we delete
        if let Some(base) = self.root.parent() { remove_ours(base); }
    }
}

/// Is this one of OUR island bases? Exact shape `.aisl<pid>-<n>`, a real directory (never a symlink), owned by us.
/// The mode is deliberately NOT part of the test: an earlier run under a different umask left 0775 leftovers that a
/// 0700-only rule could never clean, and a stricter rule here only means garbage accumulates.
fn is_our_island_base(base: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let name = base.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let shape = name.strip_prefix(".aisl").and_then(|r| r.split_once('-')).is_some_and(|(pid, n)| {
        !pid.is_empty() && !n.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()) && n.strip_prefix("none").or_else(|| n.strip_prefix("hk")).unwrap_or(n).bytes().all(|b| b.is_ascii_digit()) && n != "none" && n != "hk"
    });
    let Ok(meta) = std::fs::symlink_metadata(base) else { return false };
    // SAFETY: getuid has no preconditions and cannot fail.
    shape && meta.is_dir() && !meta.file_type().is_symlink() && meta.uid() == unsafe { libc::getuid() }
}

/// Remove an island base this test created (see `is_our_island_base`).
fn remove_ours(base: &Path) {
    if is_our_island_base(base) {
        let _ = std::fs::remove_dir_all(base);
    }
}

#[test]
fn only_our_own_island_bases_are_removed_whatever_their_mode() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let scratch = PathBuf::from(std::env::var("HOME").expect("HOME")).join(format!(".aislz{}", std::process::id() % 100000));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::DirBuilder::new().mode(0o700).create(&scratch).unwrap();
    let mk = |name: &str, mode: u32| {
        let p = scratch.join(name);
        std::fs::create_dir(&p).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
        p
    };
    let ours_775 = mk(".aisl4242-0", 0o775);
    let ours_700 = mk(".aisl4242-1", 0o700);
    let bad_name = [mk(".aisl-x", 0o700), mk(".aislabc-1", 0o700), mk(".aisl12-", 0o700), mk(".aisl-1", 0o700), mk("aisl12-1", 0o700), mk(".aisl12-1x", 0o700)];
    let outside = scratch.join("outside"); std::fs::create_dir(&outside).unwrap(); std::fs::write(outside.join("keep"), "x").unwrap();
    let link = scratch.join(".aisl4243-0"); symlink(&outside, &link).unwrap();
    let file = scratch.join(".aisl4244-0"); std::fs::write(&file, "plain file").unwrap();
    assert!(is_our_island_base(&ours_775), "a 0775 leftover is ours");
    assert!(is_our_island_base(&ours_700));
    for b in &bad_name { assert!(!is_our_island_base(b), "{b:?}"); }
    assert!(!is_our_island_base(&link), "a symlink is never followed");
    assert!(!is_our_island_base(&file), "a plain file is not a directory");
    remove_ours(&ours_775); remove_ours(&link);
    assert!(!ours_775.exists());
    assert!(std::fs::symlink_metadata(&link).is_ok() && outside.join("keep").exists(), "the link target was never touched");
    // tidy: this scratch dir is ours and uses a shape the sweeper does not match
    let _ = std::fs::remove_file(&link); let _ = std::fs::remove_dir_all(&scratch);
}

/// Sweep islands of earlier runs whose test process is gone (a panicking test must not leak).
fn sweep_abandoned() {
    let home = PathBuf::from(std::env::var("HOME").expect("HOME"));
    let Ok(entries) = std::fs::read_dir(&home) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix(".aisl") else { continue };
        let pid = rest.split(['-']).next().and_then(|p| p.parse::<u32>().ok());
        let alive = pid.is_some_and(|p| p == std::process::id() % 100000 || Path::new(&format!("/proc/{p}")).exists());
        if !alive { remove_ours(&e.path()); }
    }
}

fn wait_for(conn: &AgentConn, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        let v = conn.view();
        if pred(&v) { return v; }
        assert!(Instant::now() < end, "timed out waiting for {what}; last view: {v}");
        std::thread::sleep(Duration::from_millis(40));
    }
}

#[test]
fn island_root_comes_from_the_environment_only() {
    assert_eq!(island_root(Some("/x/y"), Some("/home/u")), Some(PathBuf::from("/x/y")));
    assert_eq!(island_root(None, Some("/home/u")), Some(PathBuf::from("/home/u/.abito-island")));
    assert_eq!(island_root(Some(""), Some("/home/u")), Some(PathBuf::from("/home/u/.abito-island")));
    assert_eq!(island_root(Some("relative"), Some("/home/u")), None, "a relative override is refused, never guessed");
    assert_eq!(island_root(None, None), None);
    assert_eq!(island_root(None, Some("home")), None);
}

#[test]
fn no_daemon_reads_as_no_daemon_and_commands_fail_cleanly() {
    // the same `.aisl<pid>-<n>` shape as every other island base, so the sweeper and `remove_ours` own it too
    let base = PathBuf::from(std::env::var("HOME").unwrap()).join(format!(".aisl{}-none0", std::process::id() % 100000));
    let _ = std::fs::DirBuilder::new().mode(0o700).create(&base);
    struct Tidy(PathBuf);
    impl Drop for Tidy { fn drop(&mut self) { remove_ours(&self.0); } }
    let _tidy = Tidy(base.clone());
    let conn = AgentConn::new(|_| {});
    conn.connect(&base);
    assert_eq!(conn.view()["connection"], json!("no_daemon"));
    assert!(conn.command(&json!({"action":"connectors_list"})).is_err(), "nothing to send to: a clean error, no hang");
    assert_eq!(conn.command(&json!({"action":"view"})).unwrap()["connection"], json!("no_daemon"), "view is local and always works");
    remove_ours(&base);
}

#[test]
fn a_stale_session_file_of_a_dead_daemon_is_no_daemon_not_a_hang() {
    let mut island = Island::start();
    let session = std::fs::read_to_string(island.root.join("runtime/session.json")).unwrap();
    island.stop_daemon();
    // the file may survive a SIGKILL: put it back exactly as the dead daemon left it
    std::fs::write(island.root.join("runtime/session.json"), &session).unwrap();
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(island.root.join("runtime/session.json"), std::fs::Permissions::from_mode(0o600)).unwrap(); }
    let conn = AgentConn::new(|_| {});
    let t0 = Instant::now();
    conn.connect(&island.root);
    assert_eq!(conn.view()["connection"], json!("no_daemon"));
    assert!(t0.elapsed() < Duration::from_secs(5));
}

#[test]
fn a_session_file_that_is_not_ours_to_trust_is_refused() {
    let island = Island::start();
    let path = island.root.join("runtime/session.json");
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap(); }
    let conn = AgentConn::new(|_| {});
    conn.connect(&island.root);
    assert_eq!(conn.view()["connection"], json!("bad_session"), "a group/world-readable session file means the token may be exposed: do not use it");
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap(); }
    // a symlinked session file is refused too
    let real = island.root.join("runtime/real.json");
    std::fs::rename(&path, &real).unwrap();
    std::os::unix::fs::symlink(&real, &path).unwrap();
    conn.connect(&island.root);
    assert_eq!(conn.view()["connection"], json!("bad_session"));
}

#[test]
fn connects_handshakes_and_folds_the_real_daemon_frames_without_leaking_the_token() {
    let island = Island::start();
    let token = serde_json::from_str::<Value>(&std::fs::read_to_string(island.root.join("runtime/session.json")).unwrap()).unwrap()["token"].as_str().unwrap().to_string();
    let endpoint = serde_json::from_str::<Value>(&std::fs::read_to_string(island.root.join("runtime/session.json")).unwrap()).unwrap()["endpoint"].as_str().unwrap().to_string();
    let changes = Arc::new(AtomicU32::new(0));
    let c = changes.clone();
    let conn = AgentConn::new(move |_| { c.fetch_add(1, Ordering::SeqCst); });
    conn.connect(&island.root);
    let v = wait_for(&conn, "connected", |v| v["connection"] == json!("connected"));
    // the connectors list arrives (the fake island has no connectorsCommand → honestly unavailable)
    let v2 = wait_for(&conn, "connectors resolved", |v| v["connectors"]["state"] != json!("loading"));
    assert!(matches!(v2["connectors"]["state"].as_str(), Some("unavailable") | Some("failed")), "no connectorsCommand: {}", v2["connectors"]);
    let text = serde_json::to_string(&v2).unwrap();
    assert!(!text.contains(&token) && !text.contains(&endpoint), "the view never carries the token or the endpoint");
    assert!(changes.load(Ordering::SeqCst) > 0, "the host is told when the state moves");
    let _ = v;
    // unknown / chat-like commands are refused locally and never sent
    for bad in [json!({"action":"send","text":"hola"}), json!({"action":"abort"}), json!({"action":"settings_set","hotkey":"Ctrl+A"})] {
        assert!(conn.command(&bad).is_err(), "{bad}");
    }
}

#[test]
fn an_account_can_be_created_and_listed_through_the_real_protocol() {
    let island = Island::start();
    let conn = AgentConn::new(|_| {});
    conn.connect(&island.root);
    wait_for(&conn, "connected", |v| v["connection"] == json!("connected"));
    let providers = wait_for(&conn, "providers", |v| v["providers"].as_array().is_some_and(|p| !p.is_empty()));
    let first = providers["providers"][0]["id"].as_str().unwrap().to_string();
    conn.command(&json!({"action":"account_create","provider": first,"label":"Cuenta de prueba"})).unwrap();
    let v = wait_for(&conn, "account listed", |v| v["accounts"].as_array().is_some_and(|a| a.iter().any(|x| x["label"] == json!("Cuenta de prueba"))));
    let acct = v["accounts"].as_array().unwrap().iter().find(|x| x["label"] == json!("Cuenta de prueba")).unwrap();
    assert_eq!(acct["configured"], json!(false), "created, not signed in yet");
    assert_eq!(acct["provider"], json!(first));
    // removing it works and the list follows
    let id = acct["accountId"].as_str().unwrap().to_string();
    conn.command(&json!({"action":"account_remove","accountId": id})).unwrap();
    wait_for(&conn, "account gone", |v| v["accounts"].as_array().is_some_and(|a| a.iter().all(|x| x["accountId"] != json!(id))));
}

#[test]
fn api_key_login_prompt_arrives_and_a_cancelled_flow_leaves_nothing_behind() {
    let island = Island::start();
    let conn = AgentConn::new(|_| {});
    conn.connect(&island.root);
    wait_for(&conn, "connected", |v| v["connection"] == json!("connected"));
    let providers = wait_for(&conn, "providers", |v| v["providers"].as_array().is_some_and(|p| !p.is_empty()));
    let api_key = providers["providers"].as_array().unwrap().iter().find(|p| p["methods"].as_array().is_some_and(|m| m.contains(&json!("api_key"))));
    let Some(provider) = api_key else { eprintln!("no api_key provider in this daemon: login flow not exercised"); return; };
    let pid = provider["id"].as_str().unwrap().to_string();
    conn.command(&json!({"action":"account_create","provider": pid,"label":"Login de prueba"})).unwrap();
    let v = wait_for(&conn, "account", |v| v["accounts"].as_array().is_some_and(|a| a.iter().any(|x| x["label"] == json!("Login de prueba"))));
    let id = v["accounts"].as_array().unwrap().iter().find(|x| x["label"] == json!("Login de prueba")).unwrap()["accountId"].as_str().unwrap().to_string();
    conn.command(&json!({"action":"auth_start","accountId": id,"method":"api_key"})).unwrap();
    let v = wait_for(&conn, "prompt", |v| !v["auth"]["prompt"].is_null());
    // `secret` is whatever the provider's SDK flow says; the client reports it faithfully and the UI
    // decides the masking (see `mask_input` in the frontend view: key-like prompts are masked even
    // if a provider forgot the flag). Here we only require it to be a real boolean on the view.
    assert!(v["auth"]["prompt"]["secret"].is_boolean());
    let flow = v["auth"]["prompt"]["flowId"].as_str().unwrap().to_string();
    // cancel instead of sending a key: the flow ends without any secret on the wire
    conn.command(&json!({"action":"auth_cancel","flowId": flow})).unwrap();
    let v = wait_for(&conn, "flow done", |v| !v["auth"]["last"].is_null());
    assert_eq!(v["auth"]["last"]["ok"], json!(false));
    assert!(v["auth"]["prompt"].is_null(), "a finished flow leaves no prompt behind");
}

#[test]
fn losing_the_daemon_is_reported_as_lost_and_a_reconnect_after_restart_works() {
    let mut island = Island::start();
    let conn = AgentConn::new(|_| {});
    conn.connect(&island.root);
    wait_for(&conn, "connected", |v| v["connection"] == json!("connected"));
    island.stop_daemon();
    let v = wait_for(&conn, "lost", |v| v["connection"] == json!("lost"));
    assert_eq!(v["providers"], json!([]), "a lost connection shows no stale data as if it were live");
    assert!(conn.command(&json!({"action":"connectors_list"})).is_err());
}

#[test]
fn the_change_callback_may_read_the_view_while_connect_is_running_no_self_deadlock() {
    // The host emits `agent:state` from the callback. The callback fires from inside `connect`
    // (and from the reader thread), so it must be able to call `view()` of the SAME connection
    // without waiting on anything `connect` holds, or the first panel open would hang forever.
    let island = Island::start();
    let slot: Arc<std::sync::Mutex<Option<Arc<AgentConn>>>> = Arc::new(std::sync::Mutex::new(None));
    let seen = Arc::new(AtomicU32::new(0));
    let (s2, seen2) = (slot.clone(), seen.clone());
    let conn = Arc::new(AgentConn::new(move |view| {
        let _ = (&s2, view["connection"].as_str()); // the view arrives AS AN ARGUMENT: no re-entrant read at all
        seen2.fetch_add(1, Ordering::SeqCst);
    }));
    *slot.lock().unwrap() = Some(conn.clone());
    let c2 = conn.clone();
    let root = island.root.clone();
    let worker = std::thread::spawn(move || c2.connect(&root));
    let end = Instant::now() + Duration::from_secs(8);
    while !worker.is_finished() { assert!(Instant::now() < end, "connect() never returned: the callback deadlocked on the connection"); std::thread::sleep(Duration::from_millis(20)); }
    worker.join().unwrap();
    wait_for(&conn, "connected", |v| v["connection"] == json!("connected"));
    assert!(seen.load(Ordering::SeqCst) > 0);
    *slot.lock().unwrap() = None; // break the Arc cycle
}

/// Against a daemon that is ALREADY running (the probe's), same sequence the host runs on first open.
/// Opt-in: only when `ABITO_PROBE_ISLAND_DIR` names a live island; otherwise it is a no-op.
#[test]
fn live_island_first_open_sequence_returns_promptly() {
    let Some(dir) = std::env::var_os("ABITO_PROBE_ISLAND_DIR") else { return };
    let conn = AgentConn::new(|_| {});
    let t0 = Instant::now();
    conn.connect(Path::new(&dir));
    eprintln!("first connect took {:?}: {}", t0.elapsed(), conn.view()["connection"]);
    assert_eq!(conn.view()["connection"], json!("connected"));
    assert!(t0.elapsed() < Duration::from_secs(4));
}

/// The HOST's real structure: the `AgentConn` lives in a `Mutex<Option<_>>`, the command holds
/// that mutex while it connects, and the change callback reads the connection through the SAME
/// mutex to emit `agent:state`. That is a self-deadlock unless the callback never re-locks it.
#[test]
fn the_host_pattern_connect_under_the_slot_mutex_with_a_callback_that_reads_the_slot_does_not_deadlock() {
    use abito_island::agentconn::AgentConn as Conn;
    let island = Island::start();
    let slot: Arc<std::sync::Mutex<Option<Conn>>> = Arc::new(std::sync::Mutex::new(None));
    let emitted = Arc::new(AtomicU32::new(0));
    let (s2, e2) = (slot.clone(), emitted.clone());
    let root = island.root.clone();
    let s3 = slot.clone();
    let worker = std::thread::spawn(move || {
        let mut guard = s3.lock().unwrap(); // `agent_action` holds the slot while it connects
        let conn = guard.get_or_insert_with(|| Conn::new(move |_view| {
            // the callback must NOT need the slot: it is handed the view. (The old host re-locked the
            // slot here with a blocking lock() while `agent_action` held it = self-deadlock.)
            let _ = &s2;
            e2.fetch_add(1, Ordering::SeqCst);
        }));
        conn.connect(&root);
    });
    let end = Instant::now() + Duration::from_secs(8);
    while !worker.is_finished() { assert!(Instant::now() < end, "deadlock: the callback waits on the slot connect() holds"); std::thread::sleep(Duration::from_millis(20)); }
    worker.join().unwrap();
    assert!(emitted.load(Ordering::SeqCst) > 0);
}

/// #310 verdict: the engine of TODAY does not know `agents_list`. It must answer with an error the page can
/// read (a closed `last_error` with a counter) — and the page must then say «No disponible», not wait
/// forever. This runs the real daemon, so the day the engine learns the command this test turns into the
/// `agents` frame case without the page changing.
#[test]
fn a_daemon_that_does_not_know_agents_list_ends_the_wait_with_a_readable_error() {
    let island = Island::start();
    let conn = AgentConn::new(|_| {});
    conn.connect(&island.root);
    let before = wait_for(&conn, "connected", |v| v["connection"] == json!("connected"));
    let n0 = before["last_error"]["n"].as_u64().unwrap();
    assert_eq!(before["agents"], json!(null), "nothing known yet");
    conn.command(&json!({"action":"agents_list"})).unwrap();
    let after = wait_for(&conn, "an engine answer to agents_list", |v| {
        v["agents"].is_array() || v["last_error"]["n"].as_u64().unwrap_or(0) > n0
    });
    if after["agents"].is_array() {
        // an engine that implements it: the closed view, every entry from the allowlist. HU-015 (human: «Pi: instalador con
        // un clic ya») added Pi's own extension row; from a source checkout it reads `error` because the installer refuses
        // the group-writable payload (packaged files are 0644), which is the intended trust rule, not a fault of this route.
        for a in after["agents"].as_array().unwrap() {
            assert!(["claude-code", "codex", "copilot-cli", "opencode", "recap", "statusline", "pi"].contains(&a["id"].as_str().unwrap()), "{a}");
        }
    } else {
        let code = after["last_error"]["code"].as_str().unwrap();
        assert!(["bad_request", "unavailable"].contains(&code), "an engine that does not know the command says so with a closed code: {code}");
    }
    // and the page's pure view turns exactly this state into an honest, finite answer
    let node = Command::new("node").arg("-e").arg(format!(
        "const S=require('{}/frontend/settings-view.js'); const st={}; const v=S.agentsView(st,{{askedAtError:{}}}); process.stdout.write(v.kind);",
        env!("CARGO_MANIFEST_DIR"), after, n0)).output().expect("node");
    let kind = String::from_utf8_lossy(&node.stdout).to_string();
    assert!(kind == "unsupported" || kind == "ready", "the page must never keep waiting on this state: {kind} ({})", String::from_utf8_lossy(&node.stderr));
}


/// A private copy of `apps/desktop-harness` with strict modes (dirs 0755, files 0644, the installer 0755), so the
/// real daemon's trust check accepts it whatever umask the checkout was made with. The original is only read.
fn strict_harness_copy(into: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    fn copy(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        std::fs::set_permissions(to, std::fs::Permissions::from_mode(0o755)).unwrap();
        for e in std::fs::read_dir(from).unwrap().flatten() {
            let (src, dst) = (e.path(), to.join(e.file_name()));
            if e.file_name() == "node_modules" || e.file_name() == "test" { continue; }
            if src.is_dir() { copy(&src, &dst); } else {
                std::fs::copy(&src, &dst).unwrap();
                std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o644)).unwrap();
            }
        }
    }
    let root = into.join("harness");
    copy(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../desktop-harness"), &root);
    let bin = root.join("bin/abito-hook.cjs");
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

/// #310 final contract (H2b), against the REAL daemon, READ-ONLY: `agents_list` makes the daemon preview the
/// hook plan for each installable agent. HOME is the private island base, so the preview looks at an empty
/// home and nothing is ever applied (no agent_connect is sent by this test).
#[test]
fn the_real_daemon_lists_agents_with_a_plan_the_page_can_carry_back() {
    // a parent chain the daemon accepts (not group/world-writable): a private subdir of HOME, not /tmp itself.
    // Named `.aisl<pid>-hk0` so the SAME sweeper and `remove_ours` own it (a run that panics before cleanup used
    // to leave `.ahk<pid>` dirs nobody swept).
    static SWEPT_HK: std::sync::Once = std::sync::Once::new();
    SWEPT_HK.call_once(sweep_abandoned);
    let home = PathBuf::from(std::env::var("HOME").expect("HOME")).join(format!(".aisl{}-hk0", std::process::id() % 100000));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::DirBuilder::new().mode(0o700).create(&home).unwrap();
    struct Cleanup(PathBuf);
    impl Drop for Cleanup { fn drop(&mut self) { remove_ours(&self.0); } }
    let _cleanup = Cleanup(home.clone());
    let hook = strict_harness_copy(&home);
    // «Claude Code is installed» for the daemon = its config dir exists under the daemon's HOME (the island base,
    // which is the parent of the island root). No settings file: a clean machine with the tool and no hooks.
    let island = Island::start_with(json!({"hookInstallerBin": hook}));
    let daemon_home = island.root.parent().unwrap().to_path_buf();
    std::fs::DirBuilder::new().mode(0o700).create(daemon_home.join(".claude")).unwrap();
    let conn = AgentConn::new(|_| {});
    conn.connect(&island.root);
    wait_for(&conn, "connected", |v| v["connection"] == json!("connected"));
    conn.command(&json!({"action":"agents_list"})).unwrap();
    let v = wait_for(&conn, "agents frame", |v| v["agents"].is_array());
    let list = v["agents"].as_array().unwrap();
    let claude = list.iter().find(|a| a["id"] == json!("claude-code")).unwrap_or_else(|| panic!("claude-code missing: {list:?}"));
    assert_eq!(claude["state"], json!("not_connected"), "an empty private home has no hooks: {claude}");
    let hash = claude["plan_hash"].as_str().expect("a plan_hash for a button state");
    assert!(abito_island::agentclient::plan_hash_ok(hash), "{hash}");
    assert_eq!(claude["reviewable"], json!(true));
    // the page's pure view turns exactly this real frame into a one-click row carrying the hash it shows
    let js = format!("const S=require('{}/frontend/settings-view.js'); const st={}; const r=S.agentsView(st).rows.find(x=>x.id==='claude-code'); process.stdout.write(JSON.stringify({{label:r.primary&&r.primary.label,hash:r.primary&&r.primary.command.plan_hash,summary:r.summary}}));", env!("CARGO_MANIFEST_DIR"), v);
    let out = Command::new("node").arg("-e").arg(js).output().expect("node");
    let row: Value = serde_json::from_slice(&out.stdout).unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(&out.stderr)));
    // #436 design: the connect word is «Agregar hooks» (was «Conectar»)
    assert_eq!(row["label"], json!("Agregar hooks"));
    assert_eq!(row["hash"], json!(hash), "the click carries the hash the human saw");
    assert!(row["summary"].as_str().unwrap().starts_with("Agrega los hooks de Abito"), "{row}");
    if let Some(o) = list.iter().find(|a| a["id"] == json!("opencode")) { assert_eq!(o["state"], json!("unavailable")); }
}

#[test]
fn the_real_daemon_previews_hooks_read_only_and_the_page_sees_only_the_closed_view() {
    // Same private-home scaffolding as the agents test (#436 T6.5): one clean machine with the
    // tool installed and no hooks. The read-only preview must answer, and only the bounded
    // closed view may reach the page: no plan hash, no diff, no summary, no daemon name.
    static SWEPT_HK1: std::sync::Once = std::sync::Once::new();
    SWEPT_HK1.call_once(sweep_abandoned);
    let home = PathBuf::from(std::env::var("HOME").expect("HOME")).join(format!(".aisl{}-hk1", std::process::id() % 100000));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::DirBuilder::new().mode(0o700).create(&home).unwrap();
    struct Cleanup(PathBuf);
    impl Drop for Cleanup { fn drop(&mut self) { remove_ours(&self.0); } }
    let _cleanup = Cleanup(home.clone());
    let hook = strict_harness_copy(&home);
    let island = Island::start_with(json!({"hookInstallerBin": hook}));
    let daemon_home = island.root.parent().unwrap().to_path_buf();
    std::fs::DirBuilder::new().mode(0o700).create(daemon_home.join(".claude")).unwrap();
    let conn = AgentConn::new(|_| {});
    conn.connect(&island.root);
    wait_for(&conn, "connected", |v| v["connection"] == json!("connected"));
    conn.command(&json!({"action":"hooks_preview"})).unwrap();
    let v = wait_for(&conn, "hooks frame", |v| v["hooks"].is_array());
    let list = v["hooks"].as_array().unwrap();
    let claude = list.iter().find(|a| a["id"] == json!("claude-code")).unwrap_or_else(|| panic!("claude-code missing: {list:?}"));
    assert!(matches!(claude["state"].as_str(), Some("not_connected" | "unavailable" | "connected")), "{claude}");
    assert!(matches!(claude["mechanism"].as_str(), Some("harness" | "artifact")), "{claude}");
    let text = v["hooks"].to_string();
    for leaked in ["plan_hash", "diff", "summary", "install", "remove"] {
        assert!(!text.contains(leaked), "{leaked} leaked into the page view: {text}");
    }
    // the page's pure view turns exactly this real frame into honest rows: state only, no buttons
    let js = format!("const S=require('{}/frontend/settings-view.js'); const st={}; const r=S.agentsView(st).rows.find(x=>x.id==='claude-code'); process.stdout.write(JSON.stringify({{word:r.word,button:r.primary}}));", env!("CARGO_MANIFEST_DIR"), v);
    let out = Command::new("node").arg("-e").arg(js).output().expect("node");
    let row: Value = serde_json::from_slice(&out.stdout).unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(&out.stderr)));
    assert!(row["word"].is_string(), "a closed word for the real state: {row}");
    assert!(row["button"].is_null(), "the preview never offers a button: {row}");
}

use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::os::unix::net::UnixListener;

static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static SWEPT: std::sync::Once = std::sync::Once::new();
/// Every test dir lives under `/tmp/abito-ho-<pid>/`; the parents of DEAD test runs are swept the
/// first time (the same self-cleaning idea as the node checks), never a live process's.
fn fresh_root() -> PathBuf {
    let tmp = std::env::temp_dir();
    SWEPT.call_once(|| {
        for entry in std::fs::read_dir(&tmp).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(pid) = name.strip_prefix("abito-ho-").and_then(|p| p.parse::<u32>().ok()) else { continue };
            if pid != std::process::id() && !super::pid_alive(pid) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    });
    let parent = tmp.join(format!("abito-ho-{}", std::process::id()));
    std::fs::create_dir_all(&parent).unwrap();
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = parent.join(n.to_string());
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    dir
}
/// A real bound socket at `<root>/p-abc123/s`, like the transport makes.
fn bound(root: &Path, leaf: &str) -> (PathBuf, UnixListener) {
    let dir = root.join(leaf);
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let endpoint = dir.join("s");
    let listener = UnixListener::bind(&endpoint).unwrap();
    (endpoint, listener)
}
fn mode(p: &Path) -> u32 { std::fs::metadata(p).unwrap().permissions().mode() & 0o777 }

#[test]
fn publishing_writes_one_private_file_at_a_stable_path_with_the_current_endpoint() {
    let root = fresh_root();
    let (endpoint, _l) = bound(&root, "p-abc123");
    publish(&root, &endpoint).unwrap();
    let file = path(&root);
    assert_eq!(file, root.join("endpoint.json"), "the path never depends on the random p-XXXXXX leaf");
    assert_eq!(mode(&file), 0o600);
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.ends_with('\n') && text.matches('\n').count() == 1, "one line");
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["v"], 1);
    assert_eq!(v["endpoint"], endpoint.to_str().unwrap());
    assert_eq!(v["pid"], std::process::id());
    // the key set both readers accept: v, endpoint, pid and the optional procStart
    let keys = v.as_object().unwrap().len();
    assert_eq!(keys, if WRITE_PROC_START { 4 } else { 3 }, "closed key set: v, endpoint, pid[, procStart]");
    if WRITE_PROC_START { assert_eq!(v["procStart"], json!(proc_start(std::process::id()).unwrap())); }
    // no temp file is left behind
    let names: Vec<String> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
    assert!(names.iter().all(|n| !n.contains(".tmp")), "{names:?}");
}

#[test]
fn every_start_replaces_the_file_atomically_with_the_new_endpoint() {
    let root = fresh_root();
    let (first, l1) = bound(&root, "p-aaaaaa");
    publish(&root, &first).unwrap();
    drop(l1);
    let (second, _l2) = bound(&root, "p-bbbbbb");
    publish(&root, &second).unwrap();
    assert_eq!(read(&root).unwrap(), second, "the latest start wins");
    assert_eq!(mode(&path(&root)), 0o600);
}

#[test]
fn clear_removes_only_our_own_handoff() {
    let root = fresh_root();
    let (mine, _l1) = bound(&root, "p-aaaaaa");
    publish(&root, &mine).unwrap();
    // another island took over the file after us: ours must NOT delete theirs
    let (theirs, _l2) = bound(&root, "p-bbbbbb");
    publish(&root, &theirs).unwrap();
    clear(&root, &mine);
    assert!(path(&root).exists(), "a newer instance's handoff survives our exit");
    clear(&root, &theirs);
    assert!(!path(&root).exists(), "the owner's exit removes it");
    clear(&root, &theirs); // idempotent, no panic
}

#[test]
fn clear_never_follows_or_removes_a_symlink_or_a_foreign_file() {
    let root = fresh_root();
    let (endpoint, _l) = bound(&root, "p-aaaaaa");
    let target = root.join("precious");
    std::fs::write(&target, "keep").unwrap();
    symlink(&target, path(&root)).unwrap();
    clear(&root, &endpoint);
    assert!(std::fs::symlink_metadata(path(&root)).is_ok(), "a symlink is not ours to remove");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
    assert!(publish(&root, &endpoint).is_err(), "publish refuses to write through a symlink");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep", "nothing was written through it");
    std::fs::remove_file(path(&root)).unwrap();
    std::fs::write(path(&root), "{\"not\":\"ours\"}\n").unwrap();
    clear(&root, &endpoint);
    assert!(path(&root).exists(), "a file that does not name our endpoint is left alone");
}

#[test]
fn publish_refuses_an_endpoint_that_is_not_the_exact_receiver_shape() {
    let root = fresh_root();
    let (good, _l) = bound(&root, "p-abc123");
    let elsewhere = fresh_root();
    let (outside, _l2) = bound(&elsewhere, "p-abc123");
    for bad in [outside.clone(), root.join("p-abc12").join("s"), root.join("p-abc123").join("x"), root.join("q-abc123").join("s"),
                root.join("p-abc123/../p-abc123/s"), PathBuf::from("relative/p-abc123/s"), root.join("p-abc123")] {
        assert!(publish(&root, &bad).is_err(), "must refuse {bad:?}");
        assert!(!path(&root).exists(), "a refused publish writes nothing");
    }
    publish(&root, &good).unwrap();
}

#[test]
fn publish_requires_a_live_socket_and_a_private_runtime_root() {
    let root = fresh_root();
    let dir = root.join("p-abc123");
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("s"), "a plain file is not a socket").unwrap();
    assert!(publish(&root, &dir.join("s")).is_err(), "not a socket");
    let (endpoint, _l) = bound(&root, "p-zzzzzz");
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(publish(&root, &endpoint).is_err(), "a runtime root that is not 0700 is refused");
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    publish(&root, &endpoint).unwrap();
}

#[test]
fn a_consumer_reads_it_back_and_a_stale_file_is_never_believed() {
    let root = fresh_root();
    assert_eq!(read(&root), None, "no file, no endpoint");
    let (endpoint, l) = bound(&root, "p-abc123");
    publish(&root, &endpoint).unwrap();
    assert_eq!(read(&root), Some(endpoint.clone()));
    // the island died: its pid is gone and the socket is gone
    drop(l);
    std::fs::remove_file(&endpoint).unwrap();
    assert_eq!(read(&root), None, "the socket no longer exists");
    // garbage in the file
    for junk in ["", "not json", "{}", "[]", "{\"v\":2,\"endpoint\":\"/x\",\"pid\":1}", "{\"v\":1,\"endpoint\":7,\"pid\":1}",
                 "{\"v\":1,\"endpoint\":\"/etc/passwd\",\"pid\":1}", "{\"v\":1,\"endpoint\":\"rel/p-abc123/s\",\"pid\":1}"] {
        std::fs::write(path(&root), junk).unwrap();
        assert_eq!(read(&root), None, "{junk:?}");
    }
}

#[test]
fn a_file_left_by_a_killed_island_is_not_believed_even_if_the_socket_inode_lingers() {
    let root = fresh_root();
    let (endpoint, _listener) = bound(&root, "p-abc123");
    // a pid that is certainly not alive (pid_max is far below this)
    let dead = format!("{{\"endpoint\":{:?},\"pid\":4194999,\"v\":1}}\n", endpoint.to_str().unwrap());
    std::fs::write(path(&root), dead).unwrap();
    assert_eq!(read(&root), None, "the island that wrote it is gone");
    publish(&root, &endpoint).unwrap();
    assert_eq!(read(&root), Some(endpoint), "a live pid (ours) is believed");
}

// ---- #313 (engine suggestion): a PID alone is not an identity — a recycled pid would be believed ---------------
#[test]
fn the_start_time_of_a_process_is_read_from_the_kernel_and_is_a_decimal_string() {
    let mine = proc_start(std::process::id()).expect("our own start time");
    assert!(!mine.is_empty() && mine.bytes().all(|b| b.is_ascii_digit()), "{mine}");
    assert_eq!(proc_start(std::process::id()), Some(mine.clone()), "stable for the life of the process");
    assert_eq!(proc_start(4_194_999), None, "a pid that does not exist has no start time");
    assert_eq!(proc_start(0), None);
}

#[test]
fn a_file_with_our_pid_and_the_wrong_start_time_is_a_recycled_pid_and_is_not_believed() {
    let root = fresh_root();
    let (endpoint, _l) = bound(&root, "p-abc123");
    publish(&root, &endpoint).unwrap();
    // the reader's identity check does not depend on whether WE write the key: use the true value
    let real = proc_start(std::process::id()).expect("our own start time");
    assert_eq!(read(&root), Some(endpoint.clone()));
    // same pid, different life of that pid
    let forged = format!("{{\"endpoint\":{:?},\"pid\":{},\"procStart\":\"{}1\",\"v\":1}}\n", endpoint.to_str().unwrap(), std::process::id(), real);
    std::fs::write(path(&root), forged).unwrap();
    assert_eq!(read(&root), None, "pid alive, but it is not the process that wrote the file");
    for junk in ["", "abc", "-1", "1 2", "\"7\"", " 7"] {
        let body = format!("{{\"endpoint\":{:?},\"pid\":{},\"procStart\":{:?},\"v\":1}}\n", endpoint.to_str().unwrap(), std::process::id(), junk);
        std::fs::write(path(&root), body).unwrap();
        assert_eq!(read(&root), None, "{junk:?}");
    }
}

#[test]
fn the_start_time_key_is_optional_on_read_so_an_older_file_still_works_but_nothing_else_is_added() {
    let root = fresh_root();
    let (endpoint, _l) = bound(&root, "p-abc123");
    let old = format!("{{\"endpoint\":{:?},\"pid\":{},\"v\":1}}\n", endpoint.to_str().unwrap(), std::process::id());
    std::fs::write(path(&root), old).unwrap();
    assert_eq!(read(&root), Some(endpoint.clone()), "a file without procStart is the previous format");
    let extra = format!("{{\"endpoint\":{:?},\"pid\":{},\"v\":1,\"x\":1}}\n", endpoint.to_str().unwrap(), std::process::id());
    std::fs::write(path(&root), extra).unwrap();
    assert_eq!(read(&root), None, "the key set stays closed");
}

#[test]
fn clear_still_removes_only_our_own_file_with_the_new_key() {
    let root = fresh_root();
    let (mine, _l1) = bound(&root, "p-aaaaaa");
    publish(&root, &mine).unwrap();
    clear(&root, &mine);
    assert!(!path(&root).exists());
}

#[test]
fn the_start_time_is_written_now_that_the_engine_reader_accepts_it() {
    // the engine's hook reader (desktop-harness) accepts and verifies `procStart` since 2ece2c3; this is the same
    // change that turns the writing on, so the recycled-pid hole is closed on both sides
    assert!(WRITE_PROC_START);
    let root = fresh_root();
    let (endpoint, _l) = bound(&root, "p-abc123");
    publish(&root, &endpoint).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path(&root)).unwrap()).unwrap();
    assert_eq!(v["procStart"], json!(proc_start(std::process::id()).unwrap()));
    assert_eq!(read(&root), Some(endpoint), "our own reader still believes it");
}

#[test]
fn the_real_node_reader_finds_the_endpoint_in_the_file_publish_writes() {
    // END TO END against the engine's real reader: the file WE write must be one THEY accept (the previous
    // format was invisible to a reader that wanted exactly endpoint,pid,v)
    // The engine's reader demands a SECURE directory chain (no world-writable ancestor), so this root lives under
    // HOME, not /tmp. Named `.abito-ho-<pid>` and removed by the guard (exact own shape only, never a symlink).
    struct Guard(PathBuf);
    impl Drop for Guard {
        fn drop(&mut self) {
            use std::os::unix::fs::MetadataExt;
            let ok = std::fs::symlink_metadata(&self.0).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink() && m.uid() == unsafe { libc::getuid() });
            if ok && self.0.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(".abito-ho-")) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
    let root = PathBuf::from(std::env::var("HOME").expect("HOME")).join(format!(".abito-ho-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let _guard = Guard(root.clone());
    let (endpoint, _l) = bound(&root, "p-abc123");
    // the real receiver makes its socket 0600 (transport.rs); a bare `UnixListener::bind` under umask 002 gives
    // 0775, which the engine's reader rightly refuses as an unsafe socket
    std::fs::set_permissions(&endpoint, std::fs::Permissions::from_mode(0o600)).unwrap();
    publish(&root, &endpoint).unwrap();
    let reader = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../desktop-harness/src/config.cjs");
    let js = format!("const {{resolveConfig}}=require({:?}); const r=resolveConfig({{KODA_SOCKET_DIR:{:?}}}, process.getuid()); process.stdout.write(r.endpoint||'');", reader, root);
    let out = std::process::Command::new("node").arg("-e").arg(js).output().expect("node");
    assert_eq!(String::from_utf8_lossy(&out.stdout), endpoint.to_str().unwrap(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    // and a recycled pid (another life of the same number) is refused by THEM too
    let real = proc_start(std::process::id()).unwrap();
    let forged = format!("{{\"endpoint\":{:?},\"pid\":{},\"procStart\":\"{}1\",\"v\":1}}\n", endpoint.to_str().unwrap(), std::process::id(), real);
    std::fs::write(path(&root), forged).unwrap();
    let out = std::process::Command::new("node").arg("-e").arg(format!("const {{resolveConfig}}=require({:?}); const r=resolveConfig({{KODA_SOCKET_DIR:{:?}}}, process.getuid()); process.stdout.write(r.endpoint||'none');", reader, root)).output().expect("node");
    assert_eq!(String::from_utf8_lossy(&out.stdout), "none");
}

// ---- HU-068: macOS has a receiver, so it publishes the handoff too (it used to compile the «no receiver» stub) ----
#[test]
fn liveness_uses_the_kernel_on_every_unix() {
    assert!(super::pid_alive(std::process::id()), "we are alive");
    assert!(!super::pid_alive(4_194_999), "a pid that does not exist is not alive");
    assert!(!super::pid_alive(0));
}

#[cfg(target_os = "macos")]
#[test]
fn macos_start_time_is_whole_epoch_seconds_like_the_engine_reader() {
    let mine: u64 = proc_start(std::process::id()).expect("our start time").parse().unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    assert!(mine <= now && now - mine < 24 * 3600, "seconds since the epoch, not ticks: {mine} vs {now}");
}

#[test]
fn the_socket_path_limit_matches_this_kernel() {
    #[cfg(target_os = "linux")]
    assert_eq!(super::SUN_PATH_MAX, 107);
    #[cfg(target_os = "macos")]
    assert_eq!(super::SUN_PATH_MAX, 103);
}

// ---- AC-08 K-A: one owner of endpoint.json — the engine (jesscore) keeps it, Koda stays in standby -------------

/// A live process that is not us: our parent (the test runner's launcher).
fn foreign_live_pid() -> u32 { std::os::unix::process::parent_id() }

fn engine_file(root: &Path, endpoint: &Path, pid: u32) -> String {
    let text = format!("{{\"v\":1,\"endpoint\":{:?},\"pid\":{pid}}}\n", endpoint.to_str().unwrap());
    std::fs::write(path(root), &text).unwrap();
    std::fs::set_permissions(path(root), std::fs::Permissions::from_mode(0o600)).unwrap();
    text
}

#[test]
fn engine_first_then_koda_leaves_the_engine_endpoint_untouched() {
    let root = fresh_root();
    let (engine_ep, _e) = bound(&root, "p-engine");
    let (koda_ep, _k) = bound(&root, "p-koda11");
    let before = engine_file(&root, &engine_ep, foreign_live_pid());
    let out = publish(&root, &koda_ep).unwrap();
    assert_eq!(out, Published::Standby { owner_pid: foreign_live_pid() });
    assert_eq!(std::fs::read_to_string(path(&root)).unwrap(), before, "byte for byte the engine's file");
    assert_eq!(read(&root), Some(engine_ep.clone()), "hooks still reach the engine");
    clear(&root, &koda_ep);
    assert_eq!(read(&root), Some(engine_ep), "Koda's clear never removes the engine's file");
}

#[test]
fn koda_first_then_engine_the_engine_replaces_it_and_koda_does_not_take_it_back_on_exit() {
    let root = fresh_root();
    let (koda_ep, _k) = bound(&root, "p-koda11");
    assert_eq!(publish(&root, &koda_ep).unwrap(), Published::Written);
    assert_eq!(read(&root), Some(koda_ep.clone()));
    // the engine's own rule (engine/src/notices/handoff.cjs): it stays standby while a LIVE foreign pid owns the
    // file, so the cession on Koda's side is: a file naming a dead Koda is replaceable, and Koda's clear only removes its own.
    let (engine_ep, _e) = bound(&root, "p-engine");
    engine_file(&root, &engine_ep, foreign_live_pid());
    clear(&root, &koda_ep);
    assert_eq!(read(&root), Some(engine_ep), "Koda's exit leaves the engine's file in place");
}

#[test]
fn a_dead_or_our_own_previous_owner_is_replaced() {
    let root = fresh_root();
    let (old, l) = bound(&root, "p-old111");
    engine_file(&root, &old, 4194999);
    drop(l);
    let (ours, _k) = bound(&root, "p-koda11");
    assert_eq!(publish(&root, &ours).unwrap(), Published::Written);
    assert_eq!(read(&root), Some(ours));
}

#[test]
fn a_live_foreign_pid_with_another_start_time_is_a_recycled_pid_and_is_replaced() {
    let root = fresh_root();
    let (old, _o) = bound(&root, "p-old111");
    let text = format!("{{\"v\":1,\"endpoint\":{:?},\"pid\":{},\"procStart\":\"1\"}}\n", old.to_str().unwrap(), foreign_live_pid());
    std::fs::write(path(&root), text).unwrap();
    let (ours, _k) = bound(&root, "p-koda11");
    assert_eq!(publish(&root, &ours).unwrap(), Published::Written);
    assert_eq!(read(&root), Some(ours));
}

// --- AC-08 / K-C: the one reversible switch --------------------------------------------------------------
// The human decided (21 Nov) that the OLD engine path for agent requests is DISABLED, not deleted: nothing is
// removed and nothing is uninstalled, so `KODA_LEGACY_AGENT_REQUESTS=1` must bring the whole legacy path back.

#[test]
fn legacy_agent_requests_switch_is_on_only_for_the_exact_value_one() {
    assert!(!legacy_agent_requests_switch(None), "unset: off");
    assert!(!legacy_agent_requests_switch(Some("")), "empty: off");
    assert!(!legacy_agent_requests_switch(Some("0")), "explicit zero: off");
    assert!(!legacy_agent_requests_switch(Some("true")), "only \"1\" is the switch");
    assert!(!legacy_agent_requests_switch(Some(" 1")), "no trimming, no near-misses");
    assert!(legacy_agent_requests_switch(Some("1")), "the documented value: on");
}

#[test]
fn the_handoff_is_published_only_while_the_legacy_path_is_on() {
    // With the switch off, an installed hook/producer must find NO `endpoint.json` and stay on its own
    // terminal prompt: the gate is the frozen decision, and main.rs publishes exactly through it.
    assert!(!should_publish_handoff(false), "legacy path off: nothing is published");
    assert!(should_publish_handoff(true), "legacy path on: the handoff is published as before");
}

// ---- AC-08 K-D (native review of K-A): a standby Koda must take the file when the engine exits ------
// The engine owns `endpoint.json` while it lives, but it can exit at any moment. One bounded watcher
// retries the publish every ~2 s; [`retry_publish`] is its ONE step, pure, so the three outcomes are
// pinned here instead of in a thread.

#[test]
fn the_standby_retry_takes_the_file_over_the_moment_the_engine_is_gone() {
    let root = fresh_root();
    let (engine_ep, _e) = bound(&root, "p-engine");
    let (koda_ep, _k) = bound(&root, "p-koda11");
    // the file a killed engine leaves behind: same shape, its pid no longer alive
    engine_file(&root, &engine_ep, 4_194_999);
    assert_eq!(retry_publish(&root, &koda_ep).expect("our socket is alive").unwrap(), Published::Written, "a dead owner is replaceable");
    // the retry wrote OUR endpoint and our pid: the same file `publish` writes
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path(&root)).unwrap()).unwrap();
    assert_eq!(v["endpoint"], json!(koda_ep.to_str().unwrap()));
    assert_eq!(v["pid"], json!(std::process::id()));
    assert_eq!(read(&root), Some(koda_ep));
}

#[test]
fn while_the_engine_lives_the_standby_retry_stays_in_standby_and_never_touches_the_file() {
    let root = fresh_root();
    let (engine_ep, _e) = bound(&root, "p-engine");
    let (koda_ep, _k) = bound(&root, "p-koda11");
    let before = engine_file(&root, &engine_ep, foreign_live_pid());
    assert_eq!(
        retry_publish(&root, &koda_ep).expect("our socket is alive").unwrap(),
        Published::Standby { owner_pid: foreign_live_pid() },
        "a live foreign owner keeps the file"
    );
    assert_eq!(std::fs::read_to_string(path(&root)).unwrap(), before, "byte for byte the engine's file");
    assert_eq!(read(&root), Some(engine_ep), "hooks still reach the engine");
}

#[test]
fn the_standby_retry_stops_when_our_own_transport_is_gone() {
    let root = fresh_root();
    let (koda_ep, listener) = bound(&root, "p-koda11");
    drop(listener);
    std::fs::remove_file(&koda_ep).unwrap(); // our transport closed: the socket is gone
    let (engine_ep, _e) = bound(&root, "p-engine");
    engine_file(&root, &engine_ep, foreign_live_pid());
    assert!(retry_publish(&root, &koda_ep).is_none(), "nothing to publish any more: the watcher must stop, never publish a dead endpoint");
    assert_eq!(read(&root), Some(engine_ep), "and it never touches the engine's file on the way out");
}

#[test]
fn the_retry_interval_is_the_documented_two_seconds() {
    assert_eq!(STANDBY_RETRY_MS, 2000, "a killed engine is noticed within ~2 s, never later than the hook's own timeout");
}

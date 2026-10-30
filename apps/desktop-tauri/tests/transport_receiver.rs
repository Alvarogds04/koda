#![cfg(unix)]
// Unix integration (Linux and macOS, HU-062): real receiver sockets over the platform's peer-credential check (SO_PEERCRED / getpeereid)
// and runtime-root policy. Only the /proc terminal-origin test is Linux-only (macOS has its own pin below; Windows has windows_notice.rs).

//! M2 integration tests: a real receiver bound in a private temp/runtime dir
//! driven through real `UnixStream` clients — no GUI, no display.
//!
//! Cases mirror the applicable legacy `test/transport.test.cjs` behaviours:
//! permissions/owner, handshake + exact ready line, malformed/oversized
//! rejection, dedupe, expiry, quotas (connections, frame rate, batch cap),
//! idle/handshake deadlines, cleanup identity (never a foreign path), plus
//! the read-only preview-socket detection and the unchanged Node producer.

use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use abito_island::protocol::{self, Message, READY_LINE};
use abito_island::transport::{self, Transport, TransportOptions};
use serde_json::{json, Value};

// --- helpers ----------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Private runtime root per test (0700), short enough for sockaddr_un.
/// Fixtures are ours: leftovers from a previous run of the same test are
/// stale test artifacts and are cleaned before recreating.
fn runtime_root(tag: &str) -> PathBuf {
    // sockaddr_un.sun_path holds 107 bytes on Linux and 103 on macOS, and the endpoint is `<root>/p-XXXXXX/s`. The cargo target tmp dir
    // lives under the checkout, so a long checkout path (a worktree, a CI workspace) overflowed it (PathTooLong; the Node adapter also
    // refuses longer endpoints). Use the cargo dir when the longest endpoint fits, else the short per-user runtime dir: `$XDG_RUNTIME_DIR`
    // on Linux; on macOS the canonical per-user temp dir (`/private/var/folders/.../T`, 0700, the same base the receiver itself uses —
    // `/var` is a symlink and the directory-chain check refuses symlinks). A world-writable /tmp would not pass the chain check.
    #[cfg(target_os = "macos")]
    const SUN_PATH_MAX: usize = 103;
    #[cfg(not(target_os = "macos"))]
    const SUN_PATH_MAX: usize = 107;
    const ENDPOINT_TAIL: usize = "/p-XXXXXX/s".len();
    let cargo = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(tag);
    let dir = if cargo.as_os_str().len() + ENDPOINT_TAIL <= SUN_PATH_MAX - 7 { cargo } else {
        let base = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().canonicalize().expect("canonical per-user temp dir"));
        base.join(format!("abito-tr-{}", std::process::id())).join(tag)
    };
    if let Some(parent) = dir.parent() {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(parent).expect("create fixture parent");
    }
    if dir.exists() {
        std::fs::remove_dir_all(&dir).expect("clean previous fixture");
    }
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .expect("create runtime root");
    dir
}

#[derive(Default)]
struct Events {
    notices: Mutex<Vec<Message>>,
    counts: Mutex<Vec<u32>>,
}

impl Events {
    fn notice(&self, message: Message) {
        self.notices.lock().expect("events").push(message);
    }
    fn count(&self, count: u32) {
        self.counts.lock().expect("events").push(count);
    }
    fn notice_count(&self) -> usize {
        self.notices.lock().expect("events").len()
    }
    fn counts(&self) -> Vec<u32> {
        self.counts.lock().expect("events").clone()
    }
    fn wait(&self, predicate: impl Fn(&Self) -> bool, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if predicate(self) {
                return true;
            }
            if Instant::now() >= deadline {
                return predicate(self);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

struct Fixture {
    events: Arc<Events>,
    transport: Transport,
    runtime: PathBuf,
    project: String,
}

impl Fixture {
    fn start(tag: &str) -> Fixture {
        Fixture::start_with(tag, |options| options)
    }

    fn start_with(tag: &str, tweak: impl FnOnce(TransportOptions) -> TransportOptions) -> Fixture {
        let runtime = runtime_root(tag);
        let project = protocol::project_id("m2-integration-project");
        let events = Arc::new(Events::default());
        let options = TransportOptions::new(&runtime, &project)
            .on_notice({
                let events = events.clone();
                move |message| events.notice(message)
            })
            .on_connections({
                let events = events.clone();
                move |count| events.count(count)
            });
        let transport = transport::create_transport(tweak(options)).expect("receiver binds");
        Fixture {
            events,
            transport,
            runtime,
            project,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.transport.close(); // identity-checked socket + dir removal
        let _ = std::fs::remove_dir_all(&self.runtime); // our fixture only
    }
}

fn connect(endpoint: &Path) -> UnixStream {
    UnixStream::connect(endpoint).expect("connect to receiver")
}

fn hello(project: &str) -> Value {
    json!({"v":1, "type":"hello", "project":project, "sessionId":"session-1", "at":now_ms()})
}

fn send(stream: &mut UnixStream, value: &Value) -> std::io::Result<()> {
    stream.write_all(value.to_string().as_bytes())?;
    stream.write_all(b"\n")
}

fn read_some(stream: &UnixStream, timeout: Duration) -> Option<Vec<u8>> {
    stream.set_read_timeout(Some(timeout)).ok()?;
    let mut buffer = [0u8; 256];
    let mut reader = stream; // Read is implemented for &UnixStream
    match reader.read(&mut buffer) {
        Ok(0) => None,
        Ok(read) => Some(buffer[..read].to_vec()),
        Err(_) => None,
    }
}

/// The receiver must answer with the byte-exact legacy ready line.
fn expect_ready(stream: &UnixStream) -> bool {
    read_some(stream, Duration::from_secs(2))
        .map(|bytes| bytes == READY_LINE)
        .unwrap_or(false)
}

fn wait_closed(stream: &UnixStream, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() >= deadline {
            return false;
        }
        stream.set_read_timeout(Some(Duration::from_millis(50))).ok();
        let mut buffer = [0u8; 256];
        let mut reader = stream; // Read is implemented for &UnixStream
        match reader.read(&mut buffer) {
            Ok(0) => return true,
            Ok(_) => continue, // stray bytes: keep reading until EOF
            Err(error)
                if error.kind() == ErrorKind::WouldBlock || error.kind() == ErrorKind::TimedOut => {}
            Err(_) => return true, // ECONNRESET and friends also mean closed
        }
    }
}

fn still_open(stream: &UnixStream, window: Duration) -> bool {
    !wait_closed(stream, window)
}

fn mode_of(path: &Path) -> u32 {
    std::fs::symlink_metadata(path)
        .expect("lstat")
        .permissions()
        .mode()
        & 0o7777
}

// --- 1. happy path ----------------------------------------------------------

#[test]
fn valid_handshake_notice_permissions_counting_and_cleanup() {
    let fixture = Fixture::start("t1");
    let endpoint = fixture.transport.endpoint().to_path_buf();
    let directory = endpoint.parent().expect("socket dir").to_path_buf();

    // private identity: dir 0700, socket 0600, endpoint verifiable
    assert_eq!(mode_of(&directory), 0o700, "generated dir is 0700");
    assert_eq!(mode_of(&endpoint), 0o600, "socket is 0600");
    transport::verify_endpoint(&endpoint, &fixture.runtime).expect("verify_endpoint");

    let mut client = connect(&endpoint);
    send(&mut client, &hello(&fixture.project)).expect("write hello");
    assert!(expect_ready(&client), "byte-exact ready line");
    assert!(
        fixture
            .events
            .wait(|e| e.counts().contains(&1), Duration::from_secs(2)),
        "connection counted after handshake: {:?}",
        fixture.events.counts()
    );

    let settled = json!({"v":1, "type":"settled", "project":fixture.project,
                         "sessionId":"session-1", "at":now_ms(), "id":"event-1"});
    send(&mut client, &settled).expect("write settled");
    assert!(
        fixture
            .events
            .wait(|e| e.notice_count() >= 1, Duration::from_secs(2)),
        "notice delivered"
    );
    let notice = fixture
        .events
        .notices
        .lock()
        .expect("events")
        .first()
        .cloned()
        .expect("one notice");
    assert_eq!(notice.kind, "settled");
    assert_eq!(notice.session_id, "session-1");
    assert_eq!(notice.id.as_deref(), Some("event-1"));

    drop(client);
    assert!(
        fixture
            .events
            .wait(|e| e.counts().contains(&0), Duration::from_secs(2)),
        "disconnect reported"
    );

    fixture.transport.close().expect("close removes socket");
    assert!(!endpoint.exists(), "socket unlinked on close");
    assert!(!directory.exists(), "generated dir removed on close");
    fixture.transport.close().expect("close is idempotent");
    assert!(
        !fixture.runtime.join("p-stale").exists(),
        "runtime root itself untouched by close"
    );
}

// --- 2. malformed / oversized -----------------------------------------------

#[test]
fn oversized_and_malformed_frames_close_the_connection() {
    let fixture = Fixture::start("t2");
    let endpoint = fixture.transport.endpoint().to_path_buf();

    // legacy transport.test.cjs:2 malformed payloads each end the socket
    let mut oversized = connect(&endpoint);
    let mut line = vec![b'x'; protocol::FRAME_BYTES + 1];
    line.push(b'\n');
    oversized.write_all(&line).expect("write oversized");
    assert!(wait_closed(&oversized, Duration::from_secs(2)), "oversized");

    let mut malformed = connect(&endpoint);
    malformed.write_all(b"{bad}\n").expect("write garbage");
    assert!(wait_closed(&malformed, Duration::from_secs(2)), "malformed");

    let mut malformed_project = connect(&endpoint);
    let foreign = json!({"v":1, "type":"hello", "project":"g".repeat(64),
                         "sessionId":"session-1", "at":now_ms()});
    send(&mut malformed_project, &foreign).expect("write malformed project");
    assert!(wait_closed(&malformed_project, Duration::from_secs(2)), "project schema");

    // none of them produced a handshake or a notice
    assert_eq!(fixture.events.notice_count(), 0, "no notice from rejects");
    assert!(
        !fixture.events.counts().contains(&1),
        "no connection ever identified: {:?}",
        fixture.events.counts()
    );
}

// --- 3. dedupe / mismatch / expiry ------------------------------------------

#[test]
fn duplicate_settled_deduped_mismatch_closed_expired_dropped() {
    let fixture = Fixture::start("t3");
    let endpoint = fixture.transport.endpoint().to_path_buf();
    let settled = |at: u64, id: &str| {
        json!({"v":1, "type":"settled", "project":fixture.project,
               "sessionId":"session-1", "at":at, "id":id})
    };

    let mut client = connect(&endpoint);
    send(&mut client, &hello(&fixture.project)).expect("hello");
    assert!(expect_ready(&client));
    let event = settled(now_ms(), "event-1");
    send(&mut client, &event).expect("settled");
    assert!(fixture
        .events
        .wait(|e| e.notice_count() >= 1, Duration::from_secs(2)));
    // the identical frame again must be deduplicated
    send(&mut client, &event).expect("settled again");
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(fixture.events.notice_count(), 1, "duplicate deduped");
    // a post-handshake frame claiming another session closes the connection
    // (legacy transport.test.cjs:111)
    let impostor = json!({"v":1, "type":"settled", "project":fixture.project,
                          "sessionId":"other", "at":now_ms(), "id":"bad"});
    send(&mut client, &impostor).expect("impostor");
    assert!(wait_closed(&client, Duration::from_secs(2)), "identity mismatch");
    assert_eq!(fixture.events.notice_count(), 1, "impostor not accepted");

    // expired frame: outside the 15 s freshness window — dropped, and the
    // legacy receiver destroys the connection for the invalid frame.
    let mut stale = connect(&endpoint);
    send(&mut stale, &hello(&fixture.project)).expect("hello");
    assert!(expect_ready(&stale));
    send(&mut stale, &settled(now_ms() - protocol::FRESH_MS - 1_000, "stale-1"))
        .expect("stale settled");
    assert!(wait_closed(&stale, Duration::from_secs(2)), "expired frame");
    assert_eq!(fixture.events.notice_count(), 1, "expired frame dropped");

    // a fresh valid event still lands afterwards
    let mut fresh = connect(&endpoint);
    send(&mut fresh, &hello(&fixture.project)).expect("hello");
    assert!(expect_ready(&fresh));
    send(&mut fresh, &settled(now_ms(), "fresh-1")).expect("fresh settled");
    assert!(fixture
        .events
        .wait(|e| e.notice_count() >= 2, Duration::from_secs(2)));
}

// --- 4. quotas ---------------------------------------------------------------

#[test]
fn quotas_connections_frame_rate_and_batch_cap() {
    let fixture = Fixture::start("t4");
    let endpoint = fixture.transport.endpoint().to_path_buf();

    // global connection quota: the 5th simultaneous client dies at once
    let held: Vec<UnixStream> = (0..protocol::CONNECTIONS)
        .map(|_| connect(&endpoint))
        .collect();
    let overflow = connect(&endpoint);
    assert!(
        wait_closed(&overflow, Duration::from_secs(2)),
        "connection quota enforced"
    );
    drop(held);
    assert!(fixture
        .events
        .wait(|e| e.counts().contains(&0), Duration::from_secs(2)));

    // per-connection frame rate: hello (1) + 119 heartbeats = 120 in the
    // window; frame 121 destroys the connection. Batches stay well under the
    // batch cap so the RATE gate is what must fire.
    let mut rate = connect(&endpoint);
    send(&mut rate, &hello(&fixture.project)).expect("hello");
    assert!(expect_ready(&rate));
    let heartbeat = json!({"v":1, "type":"heartbeat", "project":fixture.project,
                           "sessionId":"session-1", "at":now_ms()});
    let mut closed = false;
    for batch in 0..13 {
        if closed {
            break;
        }
        let mut payload = String::new();
        for _ in 0..10 {
            payload.push_str(&heartbeat.to_string());
            payload.push('\n');
        }
        rate.write_all(payload.as_bytes()).expect("heartbeat batch");
        std::thread::sleep(Duration::from_millis(50)); // one read per batch
        if batch == 10 {
            // 1 + 10*11 = 111 frames: still inside the window (proves the
            // rate gate, not an early batch/cap close, ends this connection)
            assert!(still_open(&rate, Duration::from_millis(120)),
                "connection must still be open at frame 111");
        }
        if wait_closed(&rate, Duration::from_millis(120)) {
            closed = true;
        }
    }
    assert!(closed, "frame-rate quota enforced past 120 frames/min");
    assert_eq!(fixture.events.notice_count(), 0, "heartbeats are not notices");

    // batch cap: one chunk beyond frameBytes * 8 dies before reading
    let mut flood = connect(&endpoint);
    flood
        .write_all(&vec![b'a'; protocol::FRAME_BYTES * protocol::BATCH_FACTOR + 64])
        .expect("flood");
    assert!(wait_closed(&flood, Duration::from_secs(2)), "batch cap");
}

// --- 5. permissions and unsafe roots ----------------------------------------

#[test]
fn wrong_permissions_special_bits_and_unsafe_roots_refused() {
    let fixture = Fixture::start("t5");
    let endpoint = fixture.transport.endpoint().to_path_buf();
    let directory = endpoint.parent().expect("socket dir").to_path_buf();

    transport::verify_endpoint(&endpoint, &fixture.runtime).expect("valid");
    std::fs::set_permissions(&endpoint, std::fs::Permissions::from_mode(0o666)).expect("chmod");
    assert!(
        transport::verify_endpoint(&endpoint, &fixture.runtime).is_err(),
        "world-writable socket refused"
    );
    std::fs::set_permissions(&endpoint, std::fs::Permissions::from_mode(0o600)).expect("chmod");
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o2700)).expect("chmod");
    assert!(
        transport::verify_endpoint(&endpoint, &fixture.runtime).is_err(),
        "setgid special bit refused"
    );
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).expect("chmod");
    transport::verify_endpoint(&endpoint, &fixture.runtime).expect("restored");
    fixture.transport.close().expect("close");

    // an unsafe (world-writable) runtime root is refused outright
    let unsafe_root = runtime_root("t5b");
    std::fs::set_permissions(&unsafe_root, std::fs::Permissions::from_mode(0o777)).expect("chmod");
    assert!(
        transport::create_transport(TransportOptions::new(&unsafe_root, "unused")).is_err(),
        "world-writable runtime refused"
    );
    std::fs::remove_dir_all(&unsafe_root).expect("fixture cleanup");

    // the world-writable /tmp chain fails BEFORE anything is created there
    let never = std::env::temp_dir().join(format!("m2-unsafe-chain-{}", std::process::id()));
    assert!(
        transport::create_transport(TransportOptions::new(&never, "unused")).is_err(),
        "world-writable parent chain refused"
    );
    assert!(!never.exists(), "nothing created outside owned dirs");

    // reserved Preview roots (com.abitog.Abito / .Preview) are never allowed
    assert!(
        !transport::resolve_runtime_from(
            Some("/run/user/1000/abito-desktop"),
            Path::new("/elsewhere/.runtime"),
            Some("/run/user/1000"),
        )
        .is_ok(),
        "installed Preview runtime root refused"
    );
    assert!(
        transport::resolve_runtime_from(
            None,
            Path::new("/elsewhere/.runtime"),
            Some("/run/user/1000"),
        )
        .is_ok(),
        "our own default root allowed"
    );
}

// --- 6. preview socket detection (read-only) ---------------------------------

#[test]
fn preview_detection_reads_only_and_skips_symlinks() {
    // The synthetic root stands in for /run/user/<uid>/abito-desktop; kept
    // shallow so the fake socket path stays inside sockaddr_un (SUN_LEN).
    // runtime_root already created it private (0700).
    let root = runtime_root("t6");

    // a real socket file (listener kept alive so the file stays bound)
    let live = root.join("p-abc123").join("s");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(live.parent().expect("dir"))
        .expect("p-dir");
    let _listener = UnixListener::bind(&live).expect("fake socket");

    // a stale socket file (bound then released, file left behind)
    let stale_dir = root.join("p-stale9");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&stale_dir)
        .expect("stale dir");
    let stale = stale_dir.join("s");
    drop(UnixListener::bind(&stale).expect("stale socket"));

    // a symlinked p- dir must never be followed, a missing or non-socket `s`
    // must not be reported
    let link = root.join("p-link99");
    std::os::unix::fs::symlink(live.parent().expect("dir"), &link).expect("symlink");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(root.join("p-nosock1"))
        .expect("plain dir");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(root.join("p-notsok2"))
        .expect("plain dir");
    std::fs::write(root.join("p-notsok2").join("s"), b"not a socket").expect("file");

    let found = transport::detect_sockets(&root);
    let rendered: Vec<String> = found.iter().map(|p| p.display().to_string()).collect();
    assert!(
        rendered.iter().any(|p| p.ends_with("/p-abc123/s")),
        "real socket detected: {rendered:?}"
    );
    assert!(
        rendered.iter().any(|p| p.ends_with("/p-stale9/s")),
        "stale socket detected (presence only): {rendered:?}"
    );
    assert!(
        !rendered.iter().any(|p| p.contains("p-link99")),
        "symlink never followed: {rendered:?}"
    );
    assert!(
        !rendered.iter().any(|p| p.contains("p-nosock1") || p.contains("p-notsok2")),
        "non-sockets never reported: {rendered:?}"
    );
    // detection only ever reads: the listener socket still accepts nothing
    // from us and no file was removed
    assert!(live.exists(), "detected socket untouched");
    assert!(stale.exists(), "stale socket untouched");

    // the real scan runs read-only too (no assertion on content: it reports
    // whatever the installed Preview currently has, touching nothing)
    let _real = transport::preview_scan();

    std::fs::remove_dir_all(&root).expect("fixture cleanup");
}

// --- 7. deadlines ------------------------------------------------------------

#[test]
fn trickle_cannot_extend_idle_and_valid_frames_renew_it() {
    // handshake deadline: a silent client dies at handshake_ms
    let handshake = Fixture::start_with("t7", |o| o.handshake_ms(200));
    let silent = connect(handshake.transport.endpoint());
    assert!(
        wait_closed(&silent, Duration::from_secs(2)),
        "handshake deadline enforced"
    );
    drop(handshake);

    // idle deadline: a partial-byte trickle must NOT extend it (legacy
    // transport.test.cjs:129), while complete valid frames do renew it.
    // idle_ms 400 keeps a comfortable margin over the test's own polling
    // cadence when it proves that valid heartbeats renew the lease.
    let fixture = Fixture::start_with("t7", |o| o.handshake_ms(8_000).idle_ms(400));
    let endpoint = fixture.transport.endpoint().to_path_buf();
    let mut client = connect(&endpoint);
    send(&mut client, &hello(&fixture.project)).expect("hello");
    assert!(expect_ready(&client));

    let writer = client.try_clone().expect("clone");
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let trickle = {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let mut writer = writer; // Write is implemented for &UnixStream
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                if writer.write_all(b" ").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        })
    };
    let started = Instant::now();
    assert!(
        wait_closed(&client, Duration::from_secs(2)),
        "idle deadline not extended by a partial-byte trickle"
    );
    assert!(
        started.elapsed() < Duration::from_millis(1_500),
        "closed near idle_ms (400 ms), took {:?}",
        started.elapsed()
    );
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = trickle.join();

    // a fresh connection: complete valid frames renew the idle lease
    let mut live = connect(&endpoint);
    send(&mut live, &hello(&fixture.project)).expect("hello");
    assert!(expect_ready(&live));
    for _ in 0..6 {
        let heartbeat = json!({"v":1, "type":"heartbeat", "project":fixture.project,
                               "sessionId":"session-1", "at":now_ms()});
        send(&mut live, &heartbeat).expect("heartbeat");
        assert!(
            still_open(&live, Duration::from_millis(120)),
            "a valid frame renews the idle lease"
        );
        std::thread::sleep(Duration::from_millis(60));
    }
    assert!(wait_closed(&live, Duration::from_secs(2)), "idle after last frame");
}

// --- 8. unchanged Node producer ----------------------------------------------

#[test]
fn unchanged_node_producer_connects_and_settles() {
    let node = match Command::new("node").arg("--version").output() {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        other => {
            eprintln!("SKIPPED: node unavailable ({other:?}) — producer check not run");
            return;
        }
    };
    eprintln!("node: {node}");

    // receiver project = sha256 of the canonical worktree root, exactly the
    // dev value main.cjs computes (realpath of the checkout root).
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .join("../..")
        .canonicalize()
        .expect("canonical worktree root");
    let root = root.to_str().expect("utf-8 path").to_string();
    let project = protocol::project_id(&root);

    let runtime = runtime_root("t8");
    let events = Arc::new(Events::default());
    let options = TransportOptions::new(&runtime, &project)
        .on_notice({
            let events = events.clone();
            move |message| events.notice(message)
        })
        .on_connections({
            let events = events.clone();
            move |count| events.count(count)
        });
    let transport = transport::create_transport(options).expect("receiver binds");
    let endpoint = transport.endpoint().to_path_buf();

    let harness = Path::new(env!("CARGO_MANIFEST_DIR")).join("test-node/producer-check.cjs");
    let mut child = Command::new("node")
        .arg(&harness)
        .arg(&endpoint)
        .arg(&runtime)
        .arg(&root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn node producer harness");

    // the UNCHANGED adapter.cjs must complete hello → ready → settled
    assert!(
        events.wait(|e| e.counts().contains(&1), Duration::from_secs(10)),
        "producer handshake counted: {:?}",
        events.counts()
    );
    assert!(
        events.wait(|e| e.notice_count() >= 1, Duration::from_secs(10)),
        "producer settled became a notice"
    );
    {
        let notices = events.notices.lock().expect("events");
        let notice = notices.first().expect("one notice from the producer");
        assert_eq!(notice.kind, "settled");
        assert_eq!(notice.session_id, "harness-session");
        assert!(notice.id.as_deref().map(protocol::token) == Some(true));
    }

    // reap the harness (it self-exits; kill only if it hangs)
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("node producer harness did not exit");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let output = child.wait_with_output().expect("harness output");
    assert!(status.success(), "harness failed: {output:?}");
    let line = String::from_utf8_lossy(&output.stdout);
    let report: Value = serde_json::from_str(line.trim()).expect("harness JSON");
    assert_eq!(report["project"], json!(project), "same project id");

    assert!(
        events.wait(|e| e.counts().contains(&0), Duration::from_secs(3)),
        "producer disconnect reported"
    );
    transport.close().expect("close");
    let _ = std::fs::remove_dir_all(&runtime);
}


// Linux only: the terminal origin is frozen from /proc (macOS has none). macOS twin of the "no origin" half: the test below.
#[cfg(target_os = "linux")]
#[test]
fn r21_socket_peer_notice_origin_is_host_only_bounded_and_revoked() {
    use abito_island::{focushost::{OriginRequest, OriginKind}, sessionterm};
    let runtime = runtime_root("r21-origin");
    let proc_root = runtime.join("proc");
    let peer = sessionterm::read_proc(Path::new("/proc"), std::process::id()).unwrap();
    let stat = |pid, comm, parent, start| format!("{pid} ({comm}) S {parent} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 {start}");
    for (pid, comm, parent, start) in [(peer.pid, "hook", 10, peer.starttime), (10, "kitty", 1, 2)] {
        let d = proc_root.join(pid.to_string()); std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("stat"), stat(pid, comm, parent, start)).unwrap();
    }
    let project = protocol::project_id("r21");
    let events = Arc::new(Events::default());
    let e = events.clone();
    let options = TransportOptions::new(&runtime, &project).on_notice(move |message| e.notice(message));
    let transport = transport::create_transport_with_origin_resolver(options, |_| {}, move |kernel_peer| {
        assert_eq!((kernel_peer.pid, kernel_peer.starttime), (peer.pid, peer.starttime));
        sessionterm::capture_origin(&proc_root, kernel_peer, &mut |_| panic!("no herdr"))
    }).unwrap();
    let mut stream = connect(transport.endpoint());
    send(&mut stream, &hello(&project)).unwrap(); assert!(expect_ready(&stream));
    let id = "3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b";
    send(&mut stream, &json!({"v":1,"type":"settled","project":project,"sessionId":"session-1","at":now_ms(),"id":id})).unwrap();
    assert!(events.wait(|e| e.notice_count() == 1, Duration::from_secs(2)));
    let request = OriginRequest { kind: OriginKind::Notice, id: id.into() };
    assert!(transport.origin_for(&request).is_some(), "accepted socket notice retains its terminal origin");
    let view = serde_json::to_value(&events.notices.lock().unwrap()[0]).unwrap();
    for key in ["pid", "ppid", "starttime", "tty", "pane", "terminal", "origin"] { assert!(view.get(key).is_none(), "{key}"); }
    assert!(transport.origin_for(&OriginRequest { kind: OriginKind::Notice, id: "00000000-0000-0000-0000-000000000000".into() }).is_none());
    // More than the notice queue capacity: the oldest origin is evicted too.
    for i in 2..=10 {
        let next = format!("3f2b8a40-1c2d-4e5f-8a6b-{i:012x}");
        send(&mut stream, &json!({"v":1,"type":"settled","project":project,"sessionId":"session-1","at":now_ms(),"id":next})).unwrap();
    }
    assert!(events.wait(|e| e.notice_count() == 10, Duration::from_secs(2)));
    assert!(transport.origin_for(&request).is_none(), "oldest notice origin is bounded by the queue");
    let last = OriginRequest { kind: OriginKind::Notice, id: "3f2b8a40-1c2d-4e5f-8a6b-00000000000a".into() };
    assert!(transport.origin_for(&last).is_some());
    transport.forget_notice_origins(&[last.id.clone()]);
    assert!(transport.origin_for(&last).is_none(), "app dismissal revokes the origin");
    // QP/1 is unchanged; questions capture the same socket peer, never wire identity.
    send(&mut stream, &json!({"v":1,"type":"questions_hello","questionVersion":1,"project":project,"sessionId":"session-1","at":now_ms()})).unwrap();
    assert_eq!(read_some(&stream, Duration::from_secs(2)).unwrap(), abito_island::question::QUESTIONS_READY_LINE);
    send(&mut stream, &json!({"v":1,"type":"question","questionVersion":1,"project":project,"sessionId":"session-1","at":now_ms(),"id":id,
        "kind":"question","text":"Choose","options":[{"value":"a","label":"A","description":""},{"value":"b","label":"B","description":""}],"allowFreeText":false,"expiresAt":now_ms()+30000})).unwrap();
    assert!(events.wait(|_| transport.question_snapshot().pending.is_some(), Duration::from_secs(2)));
    let pending = OriginRequest { kind: OriginKind::Pending, id: id.into() };
    assert!(transport.origin_for(&pending).is_some());
    let pending_view = serde_json::to_value(transport.question_snapshot().pending).unwrap();
    for key in ["pid", "ppid", "starttime", "tty", "pane", "terminal", "origin"] { assert!(pending_view.get(key).is_none()); }
    transport.answer(id, 0).unwrap();
    assert!(transport.origin_for(&pending).is_none(), "answered question drops its origin");
    transport.close().unwrap();
}


#[test]
fn r21_review_origin_resolution_does_not_hold_the_question_mutex() {
    use std::sync::mpsc;
    let runtime = runtime_root("r21-lock");
    let project = protocol::project_id("r21-lock");
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    let transport = Arc::new(transport::create_transport_with_origin_resolver(
        TransportOptions::new(&runtime,&project), |_| {}, move |_| {
            entered_tx.send(()).unwrap();
            release_rx.lock().unwrap().recv_timeout(Duration::from_secs(3)).unwrap();
            None
        }).unwrap());
    let mut stream = connect(transport.endpoint());
    send(&mut stream,&hello(&project)).unwrap(); assert!(expect_ready(&stream));
    send(&mut stream,&json!({"v":1,"type":"questions_hello","questionVersion":1,"project":project,"sessionId":"session-1","at":now_ms()})).unwrap();
    assert_eq!(read_some(&stream,Duration::from_secs(2)).unwrap(),abito_island::question::QUESTIONS_READY_LINE);
    send(&mut stream,&json!({"v":1,"type":"question","questionVersion":1,"project":project,"sessionId":"session-1","at":now_ms(),
        "id":"3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b","kind":"question","text":"Choose",
        "options":[{"value":"a","label":"A","description":""},{"value":"b","label":"B","description":""}],"allowFreeText":false,"expiresAt":now_ms()+30000})).unwrap();
    // Linux (/proc + SO_PEERCRED) and, since HU-065, macOS (LOCAL_PEERPID + proc_pidinfo) both freeze the kernel peer's identity
    // and resolve its terminal through the injected resolver while the question is admitted.
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let t = transport.clone(); let (read_tx,read_rx) = mpsc::channel();
    let reader = std::thread::spawn(move || { let pending = t.question_snapshot().pending.is_some(); read_tx.send(pending).unwrap(); });
    let unlocked = read_rx.recv_timeout(Duration::from_millis(200));
    release_tx.send(()).unwrap(); reader.join().unwrap(); transport.close().unwrap();
    assert_eq!(unlocked,Ok(false),"question snapshots/answers must remain available while the terminal origin is resolving");
}

/// HU-065: on macOS the receiver resolves a peer's terminal from LOCAL_PEERPID + proc_pidinfo (sessionterm_mac.rs). A test process
/// has no allowlisted terminal ancestor, so no origin may be invented for it, and the notice view never carries a process or terminal
/// field. Linux twin: the r21 tests above; Windows: windows_notice.rs.
#[cfg(target_os = "macos")]
#[test]
fn macos_origin_is_never_invented_even_for_an_accepted_notice() {
    use abito_island::focushost::{OriginKind, OriginRequest};
    let runtime = runtime_root("mac-origin");
    let project = protocol::project_id("mac-origin");
    let events = Arc::new(Events::default());
    let e = events.clone();
    let options = TransportOptions::new(&runtime, &project).on_notice(move |message| e.notice(message));
    let transport = transport::create_transport(options).expect("receiver binds");
    let mut stream = connect(transport.endpoint());
    send(&mut stream, &hello(&project)).unwrap();
    assert!(expect_ready(&stream));
    let id = "3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b";
    send(&mut stream, &json!({"v":1,"type":"settled","project":project,"sessionId":"session-1","at":now_ms(),"id":id})).unwrap();
    assert!(events.wait(|e| e.notice_count() == 1, Duration::from_secs(2)));
    assert!(transport.origin_for(&OriginRequest { kind: OriginKind::Notice, id: id.into() }).is_none(), "no terminal ancestor: no origin is invented");
    let view = serde_json::to_value(&events.notices.lock().unwrap()[0]).unwrap();
    for key in ["pid", "ppid", "starttime", "tty", "pane", "terminal", "origin"] { assert!(view.get(key).is_none(), "{key}"); }
    transport.close().expect("close");
    let _ = std::fs::remove_dir_all(&runtime);
}

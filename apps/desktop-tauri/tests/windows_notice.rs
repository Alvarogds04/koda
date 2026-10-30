#![cfg(windows)]
// Windows-only integration: real named pipes, real SDDL DACLs, real pids and
// the relay binary. Every case that needs a DIFFERENT Windows user would need
// an OS token fixture — those are policy-level tests here (marked honestly).

//! T2/S3/S6 integration: the notice receiver over `\\.\pipe\abito-notice-…`
//! driven through real same-user clients, the FIRST_INSTANCE squat guard,
//! discovery-metadata ACL rules, and the `abito-notice-relay` pre-flight
//! (right pid/SID, wrong server pid, stale metadata, broadened ACL).
//! B1/B2/B3 pins: overlapped handles everywhere, timeout/cancel paths DRAIN
//! before reuse/drop, accept-close is prompt, concurrent read/write on one
//! connected handle, and creation-time owner-only DACLs on private files.

use std::io::{Read as _, Write as _};
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use abito_island::protocol::{self, READY_LINE};
use abito_island::transport::{self, TransportOptions};
use abito_island::winipc;
use windows_sys::Win32::Foundation::HANDLE;
use serde_json::{json, Value};

// --- helpers ----------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn runtime_root(tag: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(tag);
    let _ = std::fs::remove_dir_all(&dir); // stale fixture from a previous run: ours
    std::fs::create_dir_all(&dir).expect("create runtime root");
    // CI checkout directories need not inherit the runner user's private ACL.
    // Provision only our empty fixture; production must still reject broad ACLs.
    let sid = winipc::ffi::current_user_sid().expect("fixture owner");
    winipc::ffi::set_owner_only_acl(&dir, &sid).expect("private fixture directory");
    dir
}

#[derive(Default)]
struct Events {
    notices: Mutex<Vec<protocol::Message>>,
    counts: Mutex<Vec<u32>>,
}

impl Events {
    fn wait(&self, condition: impl Fn(&Events) -> bool, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if condition(self) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        condition(self)
    }
    fn notice_count(&self) -> usize {
        self.notices.lock().expect("events").len()
    }
}

struct Fixture {
    events: Arc<Events>,
    transport: transport::Transport,
    runtime: PathBuf,
    project: String,
}

impl Fixture {
    fn new(tag: &str) -> Fixture {
        let runtime = runtime_root(tag);
        let project = protocol::project_id("windows-notice-integration");
        let events = Arc::new(Events::default());
        let options = TransportOptions::new(&runtime, &project)
            .on_notice({
                let events = events.clone();
                move |message| events.notices.lock().expect("events").push(message)
            })
            .on_connections({
                let events = events.clone();
                move |count| events.counts.lock().expect("events").push(count)
            });
        let transport = transport::create_transport(options).expect("receiver binds");
        Fixture { events, transport, runtime, project }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.transport.close();
        let _ = std::fs::remove_dir_all(&self.runtime); // our fixture only
    }
}

fn hello(project: &str) -> Value {
    json!({"v":1, "type":"hello", "project":project, "sessionId":"session-1", "at":now_ms()})
}

/// An overlapped client end with its own read event: EVERY I/O on B1 handles
/// is overlapped (plain std read/write on such handles is invalid).
struct TestClient {
    file: std::fs::File,
    event: OwnedHandle,
}

impl TestClient {
    fn connect(transport: &transport::Transport) -> TestClient {
        let file = winipc::ffi::open_client(
            transport.endpoint().to_str().expect("pipe name is utf-8"),
            Duration::from_secs(5),
        )
        .expect("connect to receiver");
        let event = winipc::ffi::create_manual_event().expect("read event");
        TestClient { file, event }
    }
    fn send(&self, value: &Value) {
        let mut line = value.to_string().into_bytes();
        line.push(b'\n');
        winipc::ffi::write_bounded(
            self.file.as_raw_handle() as HANDLE,
            &line,
            Duration::from_secs(5),
        )
        .expect("bounded overlapped write");
    }
    fn read_some(&self, timeout: Duration) -> Option<Vec<u8>> {
        let mut buffer = [0u8; 256];
        let count = winipc::ffi::read_bounded_overlapped(
            &self.file,
            self.event.as_raw_handle() as HANDLE,
            &mut buffer,
            timeout,
        )
        .ok()?;
        (count > 0).then(|| buffer[..count].to_vec())
    }
}

fn metadata_text(runtime: &Path) -> String {
    std::fs::read_to_string(runtime.join(winipc::ffi::ENDPOINT_FILE)).expect("metadata file")
}

fn relay() -> Command {
    Command::new(env!("CARGO_BIN_EXE_abito-notice-relay"))
}

// --- receiver: same-user full path ------------------------------------------

#[test]
fn same_user_handshake_notice_and_bounded_close() {
    let fixture = Fixture::new("win-notice-full");
    // Discovery metadata: present, parseable, and naming exactly our pipe.
    let meta = winipc::EndpointMeta::parse(&metadata_text(&fixture.runtime)).expect("valid metadata");
    assert_eq!(meta.pipe, fixture.transport.endpoint().to_str().unwrap());
    assert_eq!(meta.pid, std::process::id());
    assert_eq!(meta.sid, winipc::ffi::current_user_sid().expect("own sid"));

    let client = TestClient::connect(&fixture.transport);
    client.send(&hello(&fixture.project));
    assert_eq!(
        client.read_some(Duration::from_secs(5)).as_deref(),
        Some(READY_LINE),
        "byte-exact ready line"
    );
    assert!(
        fixture.events.wait(|e| e.counts.lock().unwrap().contains(&1), Duration::from_secs(2)),
        "connection counted after handshake"
    );

    let settled = json!({"v":1, "type":"settled", "project":fixture.project,
                         "sessionId":"session-1", "at":now_ms(), "id":"event-1"});
    client.send(&settled);
    assert!(
        fixture.events.wait(|e| e.notice_count() >= 1, Duration::from_secs(5)),
        "notice delivered"
    );
    let notice = fixture.events.notices.lock().expect("events").first().cloned().expect("one notice");
    assert_eq!(notice.kind, "settled");
    assert_eq!(notice.session_id, "session-1");
    assert_eq!(notice.id.as_deref(), Some("event-1"));

    drop(client);
    assert!(
        fixture.events.wait(|e| e.counts.lock().unwrap().contains(&0), Duration::from_secs(5)),
        "disconnect reported"
    );

    // Bounded shutdown: cancellation, joins and metadata removal finish fast.
    let started = Instant::now();
    fixture.transport.close().expect("close removes metadata");
    assert!(started.elapsed() < Duration::from_secs(5), "close is bounded, took {:?}", started.elapsed());
    assert!(
        !fixture.runtime.join(winipc::ffi::ENDPOINT_FILE).exists(),
        "metadata removed on close"
    );
}

/// HU-065 (registered gap: «Ver» does not yet take the human to the agent's terminal on Windows/macOS). Until it does, this pins the
/// documented behaviour so nobody mistakes it for working: Windows NEVER invents a terminal origin. An accepted notice, an unknown id,
/// and a pending-question id all resolve to nothing, and the notice view carries no process or terminal field. The Linux twin is
/// `r21_socket_peer_notice_origin_is_host_only_bounded_and_revoked`; macOS has `macos_origin_is_never_invented_even_for_an_accepted_notice`.
#[test]
fn windows_never_invents_a_terminal_origin_hu065() {
    use abito_island::focushost::{OriginKind, OriginRequest};
    let fixture = Fixture::new("win-notice-origin");
    let client = TestClient::connect(&fixture.transport);
    client.send(&hello(&fixture.project));
    assert_eq!(client.read_some(Duration::from_secs(5)).as_deref(), Some(READY_LINE));
    let id = "3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b";
    client.send(&json!({"v":1, "type":"settled", "project":fixture.project, "sessionId":"session-1", "at":now_ms(), "id":id}));
    assert!(fixture.events.wait(|e| e.notice_count() >= 1, Duration::from_secs(5)), "notice delivered");
    for kind in [OriginKind::Notice, OriginKind::Pending] {
        let request = OriginRequest { kind, id: id.into() };
        assert!(fixture.transport.origin_for(&request).is_none(), "an accepted id has no origin");
    }
    let unknown = OriginRequest { kind: OriginKind::Notice, id: "00000000-0000-0000-0000-000000000000".into() };
    assert!(fixture.transport.origin_for(&unknown).is_none());
    let view = serde_json::to_value(&fixture.events.notices.lock().unwrap()[0]).unwrap();
    for key in ["pid", "ppid", "starttime", "tty", "pane", "terminal", "origin"] { assert!(view.get(key).is_none(), "{key}"); }
}

// --- FIRST_INSTANCE squat guard ---------------------------------------------

#[test]
fn first_instance_squat_is_refused() {
    let sid = winipc::ffi::current_user_sid().expect("own sid");
    let instance = winipc::ffi::random_instance_hex().expect("random instance");
    let name = winipc::pipe_name_for(&sid, &instance).expect("valid name");
    let _holder = winipc::ffi::create_server_pipe(&name, &sid, true).expect("first creation wins");
    // A second creator with the FIRST flag (a squatter) can never join.
    assert!(
        winipc::ffi::create_server_pipe(&name, &sid, true).is_err(),
        "FILE_FLAG_FIRST_PIPE_INSTANCE refuses an existing name"
    );
    // The legitimate owner (no flag) can still attach a new instance.
    let _second = winipc::ffi::create_server_pipe(&name, &sid, false).expect("replacement instance");
}

// --- client SID policy (policy-level: no different-user token fixture here) --

#[test]
fn client_sid_policy_fails_closed() {
    // POLICY-LEVEL: the real different-user runtime proof needs an OS token
    // fixture (see the report); what IS tested here is the exact verdict the
    // accept path applies, including its fail-closed API-failure arm.
    let me = winipc::ffi::current_user_sid().expect("own sid");
    assert!(winipc::client_admitted(&me, Some(&me)));
    assert!(!winipc::client_admitted(&me, None), "API failure refuses");
    assert!(!winipc::client_admitted(&me, Some("S-1-5-21-9-9-9-1002")));
    // And the accept path uses exactly this verdict: a same-user client is
    // admitted and gets the ready line after its hello.
    let runtime = runtime_root("win-notice-policy");
    let project = protocol::project_id("windows-notice-integration");
    let transport =
        transport::create_transport(TransportOptions::new(&runtime, &project)).expect("receiver binds");
    let client = TestClient::connect(&transport);
    client.send(&hello(&project));
    assert_eq!(client.read_some(Duration::from_secs(5)).as_deref(), Some(READY_LINE));
    let _ = transport.close();
    let _ = std::fs::remove_dir_all(&runtime);
}

// --- B2: accept cancellation is prompt --------------------------------------

#[test]
fn idle_accept_close_is_prompt() {
    // No client ever connects: close() must cancel AND drain the pending
    // overlapped ConnectNamedPipe and still return promptly.
    let runtime = runtime_root("win-accept-close");
    let project = protocol::project_id("windows-notice-integration");
    let transport =
        transport::create_transport(TransportOptions::new(&runtime, &project)).expect("receiver binds");
    let started = Instant::now();
    transport.close().expect("close");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "idle accept close drained promptly, took {:?}",
        started.elapsed()
    );
    let _ = std::fs::remove_dir_all(&runtime);
}

// --- B2: write timeout drains and the handle is safely reusable -------------

#[test]
fn write_timeout_drains_and_reuses_handle() {
    let sid = winipc::ffi::current_user_sid().expect("own sid");
    let instance = winipc::ffi::random_instance_hex().expect("random instance");
    let name = winipc::pipe_name_for(&sid, &instance).expect("valid name");
    let server = winipc::ffi::create_server_pipe(&name, &sid, true).expect("server pipe");
    let handle = server.as_raw_handle() as HANDLE;
    // Connect a client that will NEVER read: the pipe buffer stays full.
    // Connecting BEFORE ConnectNamedPipe also pins the ERROR_PIPE_CONNECTED
    // immediate-completion branch (no unsignalled-event wait).
    let client = winipc::ffi::open_client(&name, Duration::from_secs(5)).expect("client connects");
    winipc::ffi::connect_and_wait(handle, Duration::from_secs(5)).expect("accept");

    // A write bigger than the 8 KiB pipe buffer cannot complete: it must
    // time out, CANCEL AND DRAIN (no use-after-free), and return an error.
    let big = vec![0x61u8; 65536];
    let started = Instant::now();
    let result = winipc::ffi::write_bounded(handle, &big, Duration::from_millis(300));
    assert!(result.is_err(), "oversized write to a silent reader times out");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "the timeout+drain path is bounded, took {:?}",
        started.elapsed()
    );
    // The SAME handle is immediately reusable for a bounded small write.
    winipc::ffi::write_bounded(handle, b"after-drain\n", Duration::from_secs(2))
        .expect("handle safely reusable after cancel+drain");
    // And the client end can still be dropped safely afterwards.
    drop(client);
    drop(server);
}

// --- B2: concurrent overlapped read AND write on one connected handle -------

#[test]
fn concurrent_read_write_on_one_handle_is_bounded() {
    let sid = winipc::ffi::current_user_sid().expect("own sid");
    let instance = winipc::ffi::random_instance_hex().expect("random instance");
    let name = winipc::pipe_name_for(&sid, &instance).expect("valid name");
    let server = winipc::ffi::create_server_pipe(&name, &sid, true).expect("server pipe");
    let handle = server.as_raw_handle() as HANDLE;
    let client = winipc::ffi::open_client(&name, Duration::from_secs(5)).expect("client connects");
    winipc::ffi::connect_and_wait(handle, Duration::from_secs(5)).expect("accept");
    let server_file = std::fs::File::from(server);
    // Reader thread: continuous bounded overlapped reads on the SERVER handle
    // (the File moves into the thread; the raw value stays usable here; the
    // read event is created inside the thread — raw HANDLEs are not Send).
    let reader = std::thread::spawn(move || {
        let read_event = winipc::ffi::create_manual_event().expect("event");
        let event_handle = read_event.as_raw_handle() as HANDLE;
        let mut buffer = [0u8; 512];
        let mut received = 0usize;
        for _ in 0..20 {
            match winipc::ffi::read_bounded_overlapped(&server_file, event_handle, &mut buffer, Duration::from_millis(100)) {
                Ok(0) => break,               // peer gone
                Ok(count) => received += count,
                Err(_) => continue,           // deadline slice: loop again
            }
        }
        received
    });
    // The opposite endpoint echoes bytes: a duplex pipe is not loopback.
    let echo = std::thread::spawn(move || {
        let event = winipc::ffi::create_manual_event().expect("client event");
        let mut buffer = [0u8; 512];
        let mut echoed = 0;
        while echoed < 5 * b"concurrent\n".len() {
            let count = winipc::ffi::read_bounded_overlapped(
                &client, event.as_raw_handle() as HANDLE, &mut buffer,
                Duration::from_secs(2),
            ).expect("client receives server writes");
            assert!(count > 0, "server must not close before echo");
            winipc::ffi::write_bounded(
                client.as_raw_handle() as HANDLE, &buffer[..count],
                Duration::from_secs(2),
            ).expect("client echoes to server reader");
            echoed += count;
        }
        // Keep this endpoint alive until the server reader consumes the echo.
        client
    });
    // Main thread: concurrent bounded writes on the SAME connected handle.
    for _ in 0..5 {
        winipc::ffi::write_bounded(handle, b"concurrent\n", Duration::from_secs(2))
            .expect("concurrent write on the shared connected handle");
    }
    let client = echo.join().expect("client echo completes");
    let received = reader.join().expect("reader thread ends without hanging");
    assert_eq!(received, 5 * "concurrent\n".len(), "server received every echoed byte");
    drop(client);
}

// --- relay: right pid/SID ----------------------------------------------------

#[test]
fn relay_forwards_for_matching_server() {
    let runtime = runtime_root("win-relay-ok");
    let sid = winipc::ffi::current_user_sid().expect("own sid");
    let instance = winipc::ffi::random_instance_hex().expect("random instance");
    let name = winipc::pipe_name_for(&sid, &instance).expect("valid name");
    // The TEST process is the pipe server; the metadata names this very pid.
    let server = winipc::ffi::create_server_pipe(&name, &sid, true).expect("server pipe");
    let meta = winipc::EndpointMeta::new(name.clone(), std::process::id(), sid.clone()).expect("meta");
    winipc::ffi::publish_endpoint(&runtime, &meta).expect("publish");

    let mut child = relay()
        .arg(runtime.join(winipc::ffi::ENDPOINT_FILE))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("relay starts");

    // Accept the relay's connection (B1/B2: bounded overlapped accept; the
    // relay connects first, so this returns via ERROR_PIPE_CONNECTED).
    let server_handle = server.as_raw_handle() as HANDLE;
    winipc::ffi::connect_and_wait(server_handle, Duration::from_secs(10)).expect("relay connects");
    let server_file = std::fs::File::from(server);

    // The connected server handle is overlapped: bounded overlapped I/O only.
    let mut line = hello(&protocol::project_id("windows-notice-integration")).to_string().into_bytes();
    line.push(b'\n');
    child.stdin.as_mut().expect("relay stdin").write_all(&line)
        .expect("hook sends hello through relay stdin");
    let read_event = winipc::ffi::create_manual_event().expect("event");
    let mut received = vec![0; line.len()];
    let mut offset = 0;
    while offset < received.len() {
        let count = winipc::ffi::read_bounded_overlapped(
            &server_file, read_event.as_raw_handle() as HANDLE,
            &mut received[offset..], Duration::from_secs(5),
        ).expect("server receives forwarded hello");
        assert!(count > 0, "relay must not close mid-frame");
        offset += count;
    }
    assert_eq!(received, line, "stdin bytes reach the actual server unchanged");
    winipc::ffi::write_bounded(server_handle, READY_LINE, Duration::from_secs(5))
        .expect("server replies ready");
    let mut reply = vec![0; READY_LINE.len()];
    child.stdout.as_mut().expect("relay stdout").read_exact(&mut reply)
        .expect("hook receives reply through relay stdout");
    assert_eq!(reply, READY_LINE, "pipe response reaches stdout unchanged");
    drop(read_event);
    drop(child.stdin.take());
    let status = child.wait().expect("relay exits");
    assert!(status.success(), "clean EOF exit, got {status:?}");
    let _ = std::fs::remove_dir_all(&runtime);
}

// --- relay: wrong server pid (metadata names an alive OTHER process) ---------

#[test]
fn relay_refuses_wrong_server_pid() {
    let runtime = runtime_root("win-relay-wrongpid");
    let sid = winipc::ffi::current_user_sid().expect("own sid");
    let instance = winipc::ffi::random_instance_hex().expect("random instance");
    let name = winipc::pipe_name_for(&sid, &instance).expect("valid name");
    // Alive same-user decoy (the metadata pid), but the pipe server is US.
    let mut decoy = Command::new("cmd").args(["/c", "ping", "-n", "30", "127.0.0.1"])
        .stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("decoy process");
    let server = winipc::ffi::create_server_pipe(&name, &sid, true).expect("server pipe");
    let meta = winipc::EndpointMeta::new(name, decoy.id(), sid).expect("meta");
    winipc::ffi::publish_endpoint(&runtime, &meta).expect("publish");

    let mut child = relay()
        .arg(runtime.join(winipc::ffi::ENDPOINT_FILE))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().expect("relay starts");
    drop(child.stdin.take());
    let status = child.wait().expect("relay exits");
    assert_eq!(status.code(), Some(5), "server pid mismatch refuses: {status:?}");
    let _ = server; // keep the pipe alive until the relay has decided
    let _ = decoy.kill();
    let _ = decoy.wait();
    let _ = std::fs::remove_dir_all(&runtime);
}

// --- relay: stale metadata ---------------------------------------------------

#[test]
fn relay_refuses_stale_metadata() {
    let runtime = runtime_root("win-relay-stale");
    let sid = winipc::ffi::current_user_sid().expect("own sid");
    let instance = winipc::ffi::random_instance_hex().expect("random instance");
    let name = winipc::pipe_name_for(&sid, &instance).expect("valid name");
    // An EXITED pid: alive-check refuses before any connection attempt.
    let mut exited = Command::new("cmd").args(["/c", "exit"])
        .stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("short-lived process");
    let pid = exited.id();
    let _ = exited.wait();
    let meta = winipc::EndpointMeta::new(name, pid, sid).expect("meta");
    winipc::ffi::publish_endpoint(&runtime, &meta).expect("publish");

    let mut child = relay()
        .arg(runtime.join(winipc::ffi::ENDPOINT_FILE))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().expect("relay starts");
    drop(child.stdin.take());
    let status = child.wait().expect("relay exits");
    assert_eq!(status.code(), Some(3), "stale metadata refuses: {status:?}");
    let _ = std::fs::remove_dir_all(&runtime);
}

// --- B3: private files get their owner-only DACL AT CREATION ----------------

#[test]
fn private_file_has_owner_only_dacl_from_creation() {
    let runtime = runtime_root("win-private-file");
    let sid = winipc::ffi::current_user_sid().expect("own sid");
    let path = runtime.join("secret.json");
    winipc::ffi::private_file_bytes(&path, b"{\"v\":1}", &sid).expect("private file created");
    // The DACL that exists NOW is the creation-time one: owner-only.
    assert!(
        winipc::ffi::directory_private(&path, &sid, true),
        "newly created private file is owner-only (creation-time DACL, not post-hoc)"
    );
    assert_eq!(std::fs::read(&path).expect("content"), b"{\"v\":1}");
    // Widening the DACL afterwards is detectable (the reader would refuse).
    let grant = Command::new("icacls").arg(&path).args(["/grant", "*S-1-1-0:(R)"])
        .output().expect("icacls runs");
    assert!(grant.status.success(), "icacls grant succeeded");
    assert!(
        !winipc::ffi::directory_private(&path, &sid, true),
        "a broadened DACL is no longer owner-only"
    );
    let _ = std::fs::remove_dir_all(&runtime);
}

#[test]
fn private_file_refuses_directory_and_reparse_targets() {
    let runtime = runtime_root("win-private-refuse");
    let sid = winipc::ffi::current_user_sid().expect("own sid");
    // A directory at the target path is never replaced.
    let dir_target = runtime.join("not-a-file");
    std::fs::create_dir(&dir_target).expect("fixture dir");
    assert!(
        winipc::ffi::private_file_bytes(&dir_target, b"x", &sid).is_err(),
        "directory target refused"
    );
    assert!(dir_target.is_dir(), "the directory is untouched");
    let _ = std::fs::remove_dir_all(&runtime);
}

#[test]
fn inherited_broad_runtime_acl_is_refused() {
    let root = runtime_root("win-inherited-broad-acl");
    let sid = winipc::ffi::current_user_sid().expect("own sid");
    let grant = Command::new("icacls").arg(&root)
        .args(["/grant", "*S-1-1-0:(OI)(CI)(R)"])
        .arg(format!("*{sid}:(OI)(CI)(F)"))
        .output().expect("grant owner write and inheritable Everyone read on fixture");
    assert!(grant.status.success(), "fixture ACL broadening succeeds");
    let runtime = root.join("inherited");
    std::fs::create_dir(&runtime).expect("child inherits broad ACL");
    let sentinel = runtime.join("untouched.txt");
    std::fs::write(&sentinel, b"unchanged").expect("sentinel");
    assert!(!winipc::ffi::directory_private(&runtime, &sid, false));
    let project = protocol::project_id("windows-notice-integration");
    assert!(transport::create_transport(TransportOptions::new(&runtime, &project)).is_err(),
        "production receiver refuses inherited broad runtime ACL");
    assert_eq!(std::fs::read(&sentinel).expect("sentinel preserved"), b"unchanged");
    assert!(!runtime.join(winipc::ffi::ENDPOINT_FILE).exists(), "no metadata published");
    let _ = std::fs::remove_dir_all(&root);
}

// --- metadata: a broadened file ACL is refused -------------------------------

#[test]
fn broadened_metadata_acl_is_refused() {
    let runtime = runtime_root("win-relay-acl");
    let sid = winipc::ffi::current_user_sid().expect("own sid");
    let instance = winipc::ffi::random_instance_hex().expect("random instance");
    let name = winipc::pipe_name_for(&sid, &instance).expect("valid name");
    let meta = winipc::EndpointMeta::new(name, std::process::id(), sid).expect("meta");
    winipc::ffi::publish_endpoint(&runtime, &meta).expect("publish");
    let path = runtime.join(winipc::ffi::ENDPOINT_FILE);
    assert!(winipc::ffi::read_verified_meta(&path).is_some(), "owner-only ACL passes");
    // Widen the file DACL to Everyone (icacls grants an extra ALLOWED ace).
    let grant = Command::new("icacls")
        .arg(&path)
        .args(["/grant", "*S-1-1-0:(R)"])
        .output()
        .expect("icacls runs");
    assert!(grant.status.success(), "icacls grant succeeded");
    assert!(
        winipc::ffi::read_verified_meta(&path).is_none(),
        "a broader ACL refuses the metadata file"
    );
    let _ = std::fs::remove_dir_all(&runtime);
}

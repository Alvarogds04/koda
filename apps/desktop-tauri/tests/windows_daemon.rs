//! Windows daemon runtime integration tests (T2/S3/S4/S6).
//!
//! The FILE compiles on every platform — `xbuild.sh check --all-targets` proves
//! the platform seams — but the bodies run ONLY on Windows (`#![cfg(windows)]`):
//! the FFI half, protected DACLs and named pipes do not exist elsewhere.
//! Missing native proof on Linux/macOS is explicit and expected.
//!
//! Covered here:
//! * the native helper writes `session.json` with an owner-only DACL AT
//!   CREATION and refuses unsafe island overrides and malformed payloads;
//! * the agent client refuses a session file whose own DACL is wider than
//!   owner-only, and a session whose recorded pid is not the pipe server —
//!   without sending a single byte (no token) to the unverified server;
//! * the happy path sends the hello (token) ONLY after the server pid/SID
//!   verification passes;
//! * Windows runtime discovery: node.exe and the npm package CLI JS (never a
//!   .cmd shim), with the missing-dependency error messages.
#![cfg(windows)]

use std::io::Write as _;
use std::os::windows::ffi::OsStrExt as _;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::os::windows::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

use abito_island::agentconn::AgentConn;
use abito_island::daemonhost;
use abito_island::winipc;
use serde_json::{json, Value};

const HELPER: &str = env!("CARGO_BIN_EXE_abito-private-session");
static SEQ: AtomicUsize = AtomicUsize::new(0);

/// A unique scratch base that plays the role of %LOCALAPPDATA%. The island
/// root and runtime directory are explicitly provisioned with a protected
/// owner-only DACL: a runner's temp tree inherits broad inherited ACLs, and
/// the helper/reader must only ever accept private directories.
fn scratch(tag: &str) -> PathBuf {
    let base = std::env::temp_dir()
        .join(format!("abito-win-daemon-{}-{}-{}", tag, std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(base.join("Abito").join("runtime")).expect("scratch island");
    let me = current_sid();
    // Protect deepest-first: setting the parent's non-inheritable DACL first
    // removes the child's inherited grants on Windows before we can set its
    // owner/DACL (ERROR_ACCESS_DENIED on hosted runners). A protected child
    // keeps its explicit owner-only grants when the parent changes afterward.
    apply_protected_dacl(base.join("Abito").join("runtime").as_path(), &me);
    apply_protected_dacl(base.join("Abito").as_path(), &me);
    base
}

fn token() -> String {
    "c2Vzc2lvbi10b2tlbi1iYXNlNjR1cmw".to_owned()
}

fn pipe_name() -> String {
    // Unique per test, EXACT daemon pipe shape: `\\.\pipe\abito-<32 lowercase hex>`
    // (winpolicy::pipe_endpoint_ok). The instance is 128 random bits from winipc.
    let instance = winipc::ffi::random_instance_hex().expect("random instance");
    format!(r"\\.\pipe\abito-{instance}")
}

fn payload(endpoint: &str, pid: u32) -> String {
    json!({
        "protocol": "island-agent/1",
        "endpoint": endpoint,
        "token": token(),
        "pid": pid,
        "startedAt": 1234u64,
    })
    .to_string()
}

/// Runs the native helper against `base` (as LOCALAPPDATA), feeding `input`.
fn run_helper(base: &Path, input: &[u8], island_dir: Option<&Path>) -> std::process::Output {
    let mut command = Command::new(HELPER);
    command.env("LOCALAPPDATA", base).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = island_dir {
        command.env("ABITO_ISLAND_DIR", dir);
    } else {
        command.env_remove("ABITO_ISLAND_DIR");
    }
    let mut child = command.spawn().expect("spawn helper");
    child.stdin.as_mut().expect("helper stdin").write_all(input).expect("write stdin");
    child.wait_with_output().expect("wait helper")
}

fn session_file(base: &Path) -> PathBuf {
    base.join("Abito").join("runtime").join("session.json")
}

fn current_sid() -> String {
    winipc::ffi::current_user_sid().expect("own user SID")
}

#[test]
fn helper_writes_session_with_an_owner_only_dacl_at_creation() {
    let base = scratch("acl");
    let out = run_helper(&base, payload(&pipe_name(), std::process::id()).as_bytes(), None);
    assert_eq!(out.status.code(), Some(0), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let file = session_file(&base);
    let written = std::fs::read_to_string(&file).expect("session.json written");
    let value: Value = serde_json::from_str(&written).expect("canonical json");
    assert_eq!(value["token"], json!(token()));
    assert_eq!(value["pid"], json!(std::process::id()));
    let me = current_sid();
    // The file's own DACL is STRICTLY owner-only (no SYSTEM/Administrators), and the
    // runtime directory stays private in the winpolicy sense (owner+SYSTEM+Admins).
    assert!(winipc::ffi::directory_private(&file, &me, true), "session.json must be owner-only");
    assert!(winipc::ffi::directory_private(&file.parent().unwrap(), &me, false));
    assert!(winipc::ffi::directory_private(base.join("Abito").as_path(), &me, false));
    // Re-publication (atomic replace) keeps the same guarantees.
    let again = run_helper(&base, payload(&pipe_name(), std::process::id()).as_bytes(), None);
    assert_eq!(again.status.code(), Some(0));
    assert!(winipc::ffi::directory_private(&file, &me, true), "replaced file is still owner-only");
}

#[test]
fn helper_refuses_an_override_outside_the_canonical_protected_root() {
    let base = scratch("override");
    let outside = base.join("elsewhere");
    std::fs::create_dir_all(outside.join("runtime")).expect("decoy runtime");
    let out = run_helper(&base, payload(&pipe_name(), std::process::id()).as_bytes(), Some(&outside));
    assert_ne!(out.status.code(), Some(0), "an unsafe override must be refused, never honoured");
    assert!(!outside.join("runtime").join("session.json").exists(), "nothing written to the decoy root");
    assert!(!session_file(&base).exists(), "nothing written to the canonical root either");
    // Path tricks are refused the same way.
    for trick in [format!("{}\\Abito\\..\\..\\steal", base.display()), format!("{}\\Abito\\.\\x", base.display())] {
        let out = run_helper(&base, payload(&pipe_name(), std::process::id()).as_bytes(), Some(Path::new(&trick)));
        assert_ne!(out.status.code(), Some(0), "trick override refused: {trick}");
        assert!(!base.join("steal").join("runtime").join("session.json").exists());
    }
}

#[test]
fn helper_refuses_malformed_payloads_without_writing() {
    let base = scratch("badpayload");
    for input in [b"not json".as_slice(), b"{}".as_slice(), payload(r"\\.\pipe\other-0123456789abcdef0123456789abcdef", 4242).as_bytes()] {
        let out = run_helper(&base, input, None);
        assert_ne!(out.status.code(), Some(0), "refused: {input:?}");
    }
    assert!(!session_file(&base).exists());
}

#[test]
fn helper_refuses_an_overbound_payload_without_writing() {
    // B4: the helper must bound stdin BEFORE reading it — one byte over the
    // limit is refused and mutates nothing.
    let base = scratch("overbound");
    let out = run_helper(&base, &vec![b'a'; 4097], None);
    assert_ne!(out.status.code(), Some(0), "overbound stdin refused");
    assert!(!session_file(&base).exists(), "no session file on an overbound payload");
}

/// Widens the file's DACL to owner + Everyone (protected), simulating the
/// damage the native helper must never let through to the reader.
fn widen_dacl_to_everyone(path: &Path) {
    set_protected_dacl(path, &format!("O:{}D:P(A;;GA;;;WD)", current_sid()));
}

/// Provisions a fixture directory with a protected owner-only DACL (the
/// production primitive class): a runner's temp tree inherits broad ACLs the
/// helper/reader must reject.
fn apply_protected_dacl(path: &Path, sid: &str) {
    set_protected_dacl(path, &format!("O:{sid}D:P(A;;GA;;;{sid})"));
}

/// Applies an explicit protected DACL (SDDL) to a path — the same primitive
/// class the production helpers use, also used to simulate damage for the
/// wider-DACL negative.
fn set_protected_dacl(path: &Path, sddl: &str) {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW, SE_FILE_OBJECT, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetSecurityDescriptorDacl, GetSecurityDescriptorOwner, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        PROTECTED_DACL_SECURITY_INFORMATION,
    };
    let wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(wide.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut())
    };
    assert!(ok != 0, "SDDL conversion");
    let (mut present, mut defaulted) = (0, 0);
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let got = unsafe { GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) };
    assert!(got != 0 && present != 0, "self-relative DACL");
    // OWNER_SECURITY_INFORMATION requires a non-null owner SID. Merely
    // including O:<sid> in the descriptor does not populate that argument.
    let mut owner = std::ptr::null_mut();
    assert_ne!(unsafe { GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted) }, 0);
    assert!(!owner.is_null(), "fixture descriptor must name its owner");
    let result = (|| {
        let file: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let status = unsafe {
            SetNamedSecurityInfoW(
                file.as_ptr().cast_mut(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                owner,
                std::ptr::null_mut(),
                dacl,
                std::ptr::null_mut(),
            )
        };
        assert_eq!(status, 0, "SetNamedSecurityInfoW");
    })();
    unsafe { LocalFree(sd.cast()) };
    result
}

#[test]
fn reader_rejects_a_wider_dacl_on_the_session_file() {
    let base = scratch("wider");
    let out = run_helper(&base, payload(&pipe_name(), std::process::id()).as_bytes(), None);
    assert_eq!(out.status.code(), Some(0));
    let file = session_file(&base);
    widen_dacl_to_everyone(&file);
    let root = base.join("Abito");
    let conn = AgentConn::new(|_| {});
    conn.connect(&root);
    let view = conn.view();
    assert_eq!(view["connection"], json!("bad_session"), "a wider own-file DACL is refused, never trusted");
}

#[test]
fn reader_sends_no_token_to_a_server_with_a_foreign_pid() {
    let base = scratch("foreign");
    // A live process that is NOT the pipe server (a sleeper child of this test).
    let mut sleeper = Command::new("ping").args(["-n", "30", "127.0.0.1"]).creation_flags(0x08000000).spawn().expect("sleeper");
    let name = pipe_name();
    let sid = current_sid();
    let server = winipc::ffi::create_server_pipe(&name, &sid, false).expect("pipe server");
    let out = run_helper(&base, payload(&name, sleeper.id()).as_bytes(), None);
    assert_eq!(out.status.code(), Some(0));
    let root = base.join("Abito");
    let conn = AgentConn::new(|_| {});
    conn.connect(&root);
    assert_eq!(conn.view()["connection"], json!("refused"), "server pid must equal the recorded session pid");
    // The squat guard fired BEFORE any byte: the server never received a token.
    let avail = winipc::ffi::available(server.as_raw_handle());
    assert!(matches!(avail, None | Some(0)), "no byte (no token) may reach an unverified server, got {avail:?}");
    drop(server);
    let _ = sleeper.kill();
    let _ = sleeper.wait();
}

#[test]
fn reader_sends_the_token_only_after_verification_and_connects() {
    let base = scratch("happy");
    let name = pipe_name();
    let sid = current_sid();
    let server = winipc::ffi::create_server_pipe(&name, &sid, false).expect("pipe server");
    let out = run_helper(&base, payload(&name, std::process::id()).as_bytes(), None);
    assert_eq!(out.status.code(), Some(0));
    let root = base.join("Abito");
    // Server side: read the hello, then answer ready — through the bounded
    // overlapped helpers, on the OVERLAPPED server handle.
    let server_thread = std::thread::spawn(move || {
        let event = winipc::ffi::create_manual_event().expect("event");
        let file = std::fs::File::from(server);
        // Accept the client FIRST: a fresh listening instance has no peer until
        // ConnectNamedPipe returns, and reading before that races the client.
        winipc::ffi::connect_and_wait(file.as_raw_handle(), std::time::Duration::from_secs(5)).expect("client connected");
        let mut buf = [0u8; 512];
        let n = winipc::ffi::read_bounded_overlapped(&file, event.as_raw_handle(), &mut buf, std::time::Duration::from_secs(5)).expect("read hello");
        assert!(n > 0, "the hello (with the token) must arrive after verification");
        let hello = String::from_utf8_lossy(&buf[..n]).into_owned();
        winipc::ffi::write_bounded(file.as_raw_handle(), b"{\"type\":\"ready\"}\n", std::time::Duration::from_secs(5)).expect("write ready");
        // Keep the server side ALIVE until the client has processed the ready
        // frame and settled: dropping the handle early would EOF the client
        // mid-connect and race the connected assertion.
        std::thread::sleep(std::time::Duration::from_millis(500));
        hello
    });
    let conn = AgentConn::new(|_| {});
    conn.connect(&root);
    assert_eq!(conn.view()["connection"], json!("connected"), "verified server: hello sent, ready accepted");
    let hello = server_thread.join().expect("server thread");
    assert!(hello.contains(&token()), "the hello carries the per-launch token");
    // The session file itself was owner-only and the connection then dropped cleanly.
    drop(conn);
}

#[test]
fn helper_verify_is_read_only_and_requires_native_identity_and_ready() {
    for ready in [true, false] {
        let base = scratch(if ready { "verify-ready" } else { "verify-refused" });
        let name = pipe_name();
        let server = winipc::ffi::create_server_pipe(&name, &current_sid(), false).unwrap();
        assert_eq!(run_helper(&base, payload(&name, std::process::id()).as_bytes(), None).status.code(), Some(0));
        let before = std::fs::read(session_file(&base)).unwrap();
        let server_thread = std::thread::spawn(move || {
            let event = winipc::ffi::create_manual_event().unwrap();
            let file = std::fs::File::from(server);
            let wait = std::time::Duration::from_secs(5);
            winipc::ffi::connect_and_wait(file.as_raw_handle(), wait).unwrap();
            let mut buffer = [0u8; 512];
            let n = winipc::ffi::read_bounded_overlapped(&file, event.as_raw_handle(), &mut buffer, wait).unwrap();
            assert!(String::from_utf8_lossy(&buffer[..n]).contains(&token()));
            let reply: &[u8] = if ready { b"{\"type\":\"ready\"}\n" } else { b"{\"type\":\"refused\"}\n" };
            winipc::ffi::write_bounded(file.as_raw_handle(), reply, wait).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(200));
        });
        let output = Command::new(HELPER).arg("--verify").env("LOCALAPPDATA", &base).env_remove("ABITO_ISLAND_DIR").output().unwrap();
        server_thread.join().unwrap();
        assert_eq!(output.status.code(), Some(if ready { 0 } else { 1 }));
        assert!(output.stdout.is_empty() && output.stderr.is_empty(), "verdict code only");
        assert_eq!(std::fs::read(session_file(&base)).unwrap(), before);
        assert_eq!(std::fs::read_dir(base.join("Abito/runtime")).unwrap().count(), 1);
        widen_dacl_to_everyone(&session_file(&base));
        let refused = Command::new(HELPER).arg("--verify").env("LOCALAPPDATA", &base).env_remove("ABITO_ISLAND_DIR").output().unwrap();
        assert_eq!(refused.status.code(), Some(1));
        assert!(refused.stdout.is_empty() && refused.stderr.is_empty());
        assert_eq!(std::fs::read(session_file(&base)).unwrap(), before);
        let invalid = Command::new(HELPER).args(["--verify", "attacker-path"]).env("LOCALAPPDATA", &base).output().unwrap();
        assert_ne!(invalid.status.code(), Some(0), "no caller path argument");
        let outside = base.join("not-canonical");
        let redirected = Command::new(HELPER).arg("--verify").env("LOCALAPPDATA", &base).env("ABITO_ISLAND_DIR", &outside).output().unwrap();
        assert_eq!(redirected.status.code(), Some(1));
        assert!(redirected.stdout.is_empty() && redirected.stderr.is_empty());
        assert!(!outside.exists(), "verify cannot create or inspect a caller-selected non-canonical root");
        assert_eq!(std::fs::read(session_file(&base)).unwrap(), before);
    }
}

#[test]
fn node_discovery_finds_only_a_real_executable() {
    let base = scratch("node");
    std::fs::write(base.join("node.exe"), b"").unwrap();
    let found = daemonhost::discover_node(Some(&std::ffi::OsString::from(base.display().to_string())), None).expect("node found");
    assert_eq!(found, base.join("node.exe"));
    // An empty PATH and an explicit None ProgramFiles: fully isolated from the
    // ambient runner (no fallback bases at all). The fixed message gates the S4 copy.
    let missing = daemonhost::discover_node(Some(&std::ffi::OsString::from("")), None);
    assert!(missing.is_err());
    assert!(missing.unwrap_err().contains("node missing"));
}

#[test]
fn pi_discovery_uses_the_validated_package_cli_js_never_a_cmd_shim() {
    let base = scratch("pi");
    let package = base.join("npm").join("node_modules").join("@earendil-works").join("pi-coding-agent");
    std::fs::create_dir_all(package.join("dist")).unwrap();
    std::fs::write(package.join("package.json"), r#"{"bin":{"pi":"dist/pi.js"}}"#).unwrap();
    std::fs::write(package.join("dist").join("pi.js"), b"").unwrap();
    let found = daemonhost::discover_pi(Some(&std::ffi::OsString::from("")), None, None, Some(&std::ffi::OsString::from(base.display().to_string()))).expect("package cli found");
    assert_eq!(found, package.join("dist").join("pi.js"));
    // A `..` bin entry is refused even when the file exists.
    std::fs::write(base.join("evil.js"), b"").unwrap();
    std::fs::write(package.join("package.json"), r#"{"bin":{"pi":"../evil.js"}}"#).unwrap();
    let refused = daemonhost::discover_pi(Some(&std::ffi::OsString::from("")), None, None, Some(&std::ffi::OsString::from(base.display().to_string())));
    assert!(refused.is_err());
    // Nothing installed at all: the fixed missing-Pi message.
    let empty = scratch("pi-empty");
    let missing = daemonhost::discover_pi(Some(&std::ffi::OsString::from("")), None, None, Some(&std::ffi::OsString::from(empty.display().to_string())));
    let message = missing.unwrap_err();
    assert!(message.contains("pi missing"), "{message}");
    assert!(message.contains("npm install -g @earendil-works/pi-coding-agent"), "{message}");
}

#[test]
fn shared_discover_dispatches_windows_lookups() {
    let base = scratch("dispatch");
    std::fs::write(base.join("node.exe"), b"").unwrap();
    let path = std::ffi::OsString::from(base.display().to_string());
    assert_eq!(daemonhost::discover("node", Some(&path), None).expect("node"), base.join("node.exe"));
    assert!(daemonhost::discover("other", Some(&path), None).is_err(), "no lookup for anything else");
}

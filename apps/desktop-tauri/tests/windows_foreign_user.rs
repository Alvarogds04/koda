#![cfg(windows)]
//! Actual second-Windows-user S6 probes (T2/S6) — CI-ONLY by design.
//!
//! Everything the same-user integration tests (`windows_notice.rs`,
//! `windows_daemon.rs`) could only assert at the POLICY level is proven here
//! against REAL OS accounts on a disposable `windows-latest` runner:
//!
//! 1. a client process running as a DIFFERENT local Windows user (real logon
//!    token, not an injected SID) cannot open the receiver pipe — or, if the
//!    kernel ever opened it, cannot receive a single protocol byte from it —
//!    and the receiver processes nothing (no connection counted, no notice);
//! 2. `abito-notice-relay` refuses a pipe server that is ACTUALLY running as
//!    the other user (metadata published by the current user with a private
//!    ACL and the foreign server's REAL pid) before forwarding any byte;
//! 3. the other user cannot read `session.json` (written by the real
//!    `abito-private-session` helper) or the receiver's discovery metadata
//!    (`endpoint.json`, published by the real receiver) — the OS itself
//!    answers with access denied (`UnauthorizedAccessException`), never with
//!    a missing-file or generic error, and the current user can still read
//!    both (control), with the owner-only file DACL asserted directly.
//!
//! Guard policy (fail-safe, never silent):
//! * The bodies run ONLY when `GITHUB_ACTIONS=true`, `RUNNER_OS=Windows`,
//!   `RUNNER_ENVIRONMENT=github-hosted` and `ABITO_FOREIGN_USER_TEST=1`.
//!   Anywhere else the tests print an explicit
//!   `ignored:` line and return — a skip is visible, never faked proof.
//! * Inside an authorized run, a missing account env var, a failing launcher
//!   or a hung foreign child FAILS the test. Launching happens through
//!   `ci/public/foreign-user.ps1` (`run` mode): a disposable local account
//!   (`abito-ci-<run id>`) created by the workflow's `setup` step, bounded
//!   child lifetimes, and `always()` cleanup. This file never creates,
//!   renames or deletes the account itself.
//!
//! Nothing here runs on the Linux host or a human PC: no account is created
//! outside the CI runner, no real user's data is touched, and the foreign
//! scratch (probe scripts, captured output) is a disposable Everyone-ACL
//! directory under ProgramData holding no secret.

use std::io::Write as _;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use abito_island::protocol::{self, READY_LINE};
use abito_island::transport::{self, TransportOptions};
use abito_island::winipc;
use serde_json::{json, Value};
use windows_sys::Win32::Foundation::HANDLE;

const LAUNCHER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/ci/public/foreign-user.ps1");
const HELPER: &str = env!("CARGO_BIN_EXE_abito-private-session");
const RELAY: &str = env!("CARGO_BIN_EXE_abito-notice-relay");

/// The probe runs AS the foreign user: attempts against the receiver pipe,
/// a foreign pipe server for the relay case, and private-file reads. It
/// always exits 0 and reports its verdict on stdout in fixed markers, so a
/// refusal is data — only launcher/logon failures surface as exit codes.
const PROBE_PS1: &str = r#"param(
  [Parameter(Mandatory=$true)][string]$Mode,
  [string]$Target = '',
  [string]$Done = '',
  [string]$IdFile = ''
)
$ErrorActionPreference = 'Stop'

if ($Mode -eq 'connect') {
  # Case 1: try to open the receiver pipe as the foreign user.
  try {
    $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Target, [System.IO.Pipes.PipeDirection]::InOut)
    $client.Connect(5000)
  } catch {
    $cause = $_.Exception.GetBaseException()
    if ($cause -isnot [System.UnauthorizedAccessException] -and
        $cause -isnot [System.TimeoutException]) { throw }
    Write-Output ("REFUSED-OPEN " + $cause.GetType().FullName)
    exit 0
  }
  # Opened (must not happen): prove the server never sends a byte.
  try {
    $buf = New-Object byte[] 128
    $task = $client.ReadAsync($buf, 0, $buf.Length)
    if (-not $task.Wait(5000)) {
      Write-Output 'OPENED-NO-BYTES read-deadline'
    } else {
      Write-Output ("OPENED-READ " + $task.Result)
    }
  } catch {
    Write-Output ("OPENED-IO-ERROR " + $_.Exception.GetType().FullName)
  }
  try { $client.Dispose() } catch {}
  exit 0
}

if ($Mode -eq 'serve') {
  # Case 2: a REAL pipe server owned by the foreign user. Its actual pid is
  # reported through IdFile; the process stays alive until the Done marker
  # appears (or a hard 120s deadline), and reports whether ANY client ever
  # connected or any byte ever arrived.
  if (-not $IdFile -or -not $Done) { Write-Output 'PROBE-ERROR serve requires -IdFile and -Done'; exit 0 }
  try {
    $server = [System.IO.Pipes.NamedPipeServerStream]::new($Target,
      [System.IO.Pipes.PipeDirection]::InOut, 1,
      [System.IO.Pipes.PipeTransmissionMode]::Byte,
      [System.IO.Pipes.PipeOptions]::Asynchronous)
    $accept = $server.WaitForConnectionAsync()
  } catch {
    Write-Output ("PROBE-ERROR server pipe refused: " + $_.Exception.GetType().FullName)
    exit 0
  }
  [System.IO.File]::WriteAllText($IdFile, [string][System.Diagnostics.Process]::GetCurrentProcess().Id)
  $connections = 0
  $bytes = 0
  $deadline = (Get-Date).AddSeconds(120)
  while (-not $accept.IsCompleted -and -not (Test-Path -LiteralPath $Done) -and
         (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 50
  }
  # Check completion even when Done arrived first: a real connection must not
  # be hidden by the marker. A faulted accept is a probe failure, not zero I/O.
  if ($accept.IsCompleted) {
    $accept.GetAwaiter().GetResult()
    $connections = 1
    try {
      $buf = New-Object byte[] 256
      $task = $server.ReadAsync($buf, 0, $buf.Length)
      if ($task.Wait(3000)) { $bytes = $task.Result }
    } catch {}
  }
  try { $server.Dispose() } catch {}
  Write-Output ("SERVE-RESULT connections=" + $connections + " bytes=" + $bytes)
  exit 0
}

if ($Mode -eq 'read') {
  # Case 3: try to read a private file as the foreign user. The exception
  # TYPE is the evidence: UnauthorizedAccessException is the OS access
  # denial; a missing file or any other error is NOT permission proof.
  try {
    $text = [System.IO.File]::ReadAllText($Target)
    Write-Output ("READ " + $text.Length)
  } catch {
    Write-Output ("DENIED " + $_.Exception.GetBaseException().GetType().FullName)
  }
  exit 0
}

Write-Output ('PROBE-ERROR unknown mode ' + $Mode)
exit 0
"#;

// --- authorization (fail-safe, never silent) ---------------------------------

struct Auth { _user: String, _cred: PathBuf }

enum Authorization { Skip(&'static str), Ready(Auth) }

fn authorization() -> Authorization {
    let on_ci = std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true")
        && std::env::var("RUNNER_OS").as_deref() == Ok("Windows")
        && std::env::var("RUNNER_ENVIRONMENT").as_deref() == Ok("github-hosted");
    let opted_in = std::env::var("ABITO_FOREIGN_USER_TEST").as_deref() == Ok("1");
    if !on_ci || !opted_in {
        return Authorization::Skip(
            "actual foreign-user probes need GITHUB_ACTIONS=true, RUNNER_OS=Windows, RUNNER_ENVIRONMENT=github-hosted and ABITO_FOREIGN_USER_TEST=1",
        );
    }
    // Authorized run: a broken setup is a FAILURE, not a skip.
    let user = std::env::var("ABITO_FU_USER").unwrap_or_default();
    let cred = std::env::var("ABITO_FU_CRED").unwrap_or_default();
    if user.is_empty() || cred.is_empty() {
        panic!("authorized foreign-user run is missing ABITO_FU_USER/ABITO_FU_CRED: the workflow setup step did not run or did not export them");
    }
    if !Path::new(&cred).is_file() {
        panic!("authorized foreign-user run: credential blob {} is missing", cred);
    }
    if !Path::new(LAUNCHER).is_file() {
        panic!("authorized foreign-user run: launcher script {} is missing", LAUNCHER);
    }
    Authorization::Ready(Auth { _user: user, _cred: PathBuf::from(&cred) })
}

// --- foreign execution --------------------------------------------------------

/// A disposable scratch directory BOTH users can fully access. It holds only
/// probe scripts, marker/pid files and captured output — never a secret. The
/// private fixtures stay under the runner user's target tmpdir.
struct ForeignScratch { path: PathBuf }

impl ForeignScratch {
    fn new(tag: &str) -> ForeignScratch {
        let base = PathBuf::from(std::env::var("ProgramData").expect("ProgramData is set on Windows"))
            .join(format!("abito-fu-probe-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&base); // stale fixture of ours only
        std::fs::create_dir_all(&base).expect("foreign-user scratch directory");
        let grant = Command::new("icacls")
            .arg(&base)
            .args(["/grant", "*S-1-1-0:(OI)(CI)F"]) // Everyone: the probe account must run and write here
            .output()
            .expect("icacls runs");
        assert!(
            grant.status.success(),
            "icacls grant on the probe scratch failed: {}",
            String::from_utf8_lossy(&grant.stderr)
        );
        ForeignScratch { path: base }
    }

    fn probe(&self) -> PathBuf {
        let path = self.path.join("probe.ps1");
        std::fs::write(&path, PROBE_PS1).expect("probe script written");
        path
    }
}

impl Drop for ForeignScratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path); // our fixture only
    }
}

/// Launches `child` as the foreign probe account through the launcher script
/// and returns the launcher's output. The launcher exits with the child's
/// exit code and forwards its captured stdout/stderr; a launcher or logon
/// failure is a nonzero exit that the tests turn into a FAILURE.
fn run_foreign(scratch: &Path, child: &[&str], timeout_secs: u64) -> Output {
    Command::new("pwsh.exe")
        .args([
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", LAUNCHER, "run",
        ])
        .arg(scratch)
        .arg("--")
        .args(child)
        .env("ABITO_FU_CHILD_TIMEOUT", timeout_secs.to_string())
        .output()
        .expect("foreign-user launcher runs")
}

fn assert_foreign_launched(output: &Output, what: &str) {
    assert!(
        output.status.success(),
        "{what}: foreign probe failed to run (launcher/logon/timeout failure must fail, never skip): status {:?}\nstdout: {}\nstderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Bounded wait for a file the foreign probe writes; the timeout turns into a
/// failure with the launcher's captured evidence.
fn wait_for_file(path: &Path, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            if !text.trim().is_empty() {
                return text.trim().to_owned();
            }
        }
        if Instant::now() >= deadline {
            panic!("foreign probe never produced {} within {timeout:?}", path.display());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Writes the done marker when dropped (also on failure paths), so the
/// long-lived foreign pipe server always terminates promptly.
struct DoneMarker(PathBuf);

impl Drop for DoneMarker {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.0, b"done");
    }
}

// --- receiver fixture (real native receiver, same as windows_notice.rs) ------

fn runtime_root(tag: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(tag);
    let _ = std::fs::remove_dir_all(&dir); // stale fixture from a previous run: ours
    std::fs::create_dir_all(&dir).expect("create runtime root");
    let sid = winipc::ffi::current_user_sid().expect("fixture owner");
    winipc::ffi::set_owner_only_acl(&dir, &sid).expect("private fixture directory");
    dir
}

struct Receiver {
    transport: transport::Transport,
    runtime: PathBuf,
    project: String,
    notices: Arc<Mutex<Vec<protocol::Message>>>,
    counts: Arc<Mutex<Vec<u32>>>,
}

impl Receiver {
    fn new(tag: &str) -> Receiver {
        let runtime = runtime_root(tag);
        let project = protocol::project_id("windows-foreign-user");
        let notices = Arc::new(Mutex::new(Vec::new()));
        let counts = Arc::new(Mutex::new(Vec::new()));
        let options = TransportOptions::new(&runtime, &project)
            .on_notice({
                let notices = notices.clone();
                move |message| notices.lock().expect("notices").push(message)
            })
            .on_connections({
                let counts = counts.clone();
                move |count| counts.lock().expect("counts").push(count)
            });
        let transport = transport::create_transport(options).expect("receiver binds");
        Receiver { transport, runtime, project, notices, counts }
    }

    fn identified_connections(&self) -> usize {
        self.counts.lock().expect("counts").iter().filter(|c| **c > 0).count()
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        let _ = self.transport.close();
        let _ = std::fs::remove_dir_all(&self.runtime);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hello(project: &str) -> Value {
    json!({"v":1, "type":"hello", "project":project, "sessionId":"session-1", "at":now_ms()})
}

/// A same-user overlapped client, used as the CONTROL that the receiver still
/// serves its rightful owner after every foreign attempt.
struct ControlClient {
    file: std::fs::File,
    event: OwnedHandle,
}

impl ControlClient {
    fn connect(receiver: &Receiver) -> ControlClient {
        let file = winipc::ffi::open_client(
            receiver.transport.endpoint().to_str().expect("pipe name is utf-8"),
            Duration::from_secs(5),
        )
        .expect("same-user control client connects");
        let event = winipc::ffi::create_manual_event().expect("read event");
        ControlClient { file, event }
    }
    fn send(&self, value: &Value) {
        let mut line = value.to_string().into_bytes();
        line.push(b'\n');
        winipc::ffi::write_bounded(self.file.as_raw_handle() as HANDLE, &line, Duration::from_secs(5))
            .expect("bounded overlapped write");
    }
    fn read_some(&self, timeout: Duration) -> Option<Vec<u8>> {
        let mut buffer = [0u8; 256];
        let count = winipc::ffi::read_bounded_overlapped(
            &self.file, self.event.as_raw_handle() as HANDLE, &mut buffer, timeout,
        )
        .ok()?;
        (count > 0).then(|| buffer[..count].to_vec())
    }
}

// --- case 1: actual foreign-SID client vs the receiver ------------------------

#[test]
fn foreign_client_is_refused_before_any_protocol_byte() {
    let auth = match authorization() {
        Authorization::Skip(why) => {
            eprintln!("ignored: foreign_client_is_refused_before_any_protocol_byte — {why}");
            return;
        }
        Authorization::Ready(auth) => auth,
    };
    let _ = auth; // the launcher reads the credential env itself
    let scratch = ForeignScratch::new("connect");
    let probe = scratch.probe();
    let receiver = Receiver::new("fu-connect");
    let plain = receiver
        .transport
        .endpoint()
        .to_str()
        .expect("pipe name is utf-8")
        .strip_prefix(winipc::PIPE_PREFIX)
        .expect("receiver pipe shape")
        .to_owned();

    let out = run_foreign(
        &scratch.path,
        &[
            "pwsh.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", probe.to_str().unwrap(), "-Mode", "connect", "-Target", &plain,
        ],
        120,
    );
    assert_foreign_launched(&out, "receiver connect probe");
    let stdout = String::from_utf8_lossy(&out.stdout);

    // Client side: the open itself is refused (owner-only pipe DACL), or — if
    // the kernel ever opened it — the server sends ZERO bytes (the client
    // pid/SID gate disconnects before the ready line or any payload).
    let refused_open = stdout.contains("REFUSED-OPEN");
    let zero_bytes = stdout.contains("OPENED-READ 0")
        || stdout.contains("OPENED-NO-BYTES")
        || stdout.contains("OPENED-IO-ERROR");
    assert!(
        refused_open || zero_bytes,
        "a foreign-SID client must be refused before any protocol byte; probe said:\n{stdout}"
    );
    assert!(
        !stdout.contains("OPENED-READ ") || stdout.contains("OPENED-READ 0"),
        "the receiver must never send the foreign client a byte; probe said:\n{stdout}"
    );

    // Server side: nothing was processed — no identified connection, no notice.
    assert_eq!(
        receiver.identified_connections(),
        0,
        "no foreign connection may ever be identified"
    );
    assert!(
        receiver.notices.lock().expect("notices").is_empty(),
        "no foreign payload may ever be decoded"
    );

    // Control: the same user is still served normally (the pipe was not
    // replaced, wedged or closed by the foreign attempt).
    let control = ControlClient::connect(&receiver);
    control.send(&hello(&receiver.project));
    assert_eq!(
        control.read_some(Duration::from_secs(5)).as_deref(),
        Some(READY_LINE),
        "same-user client still gets the ready line after the foreign refusal"
    );
}

// --- case 2: the relay refuses a pipe server that really runs as another user -

#[test]
fn relay_refuses_a_pipe_server_actually_running_as_another_user() {
    let auth = match authorization() {
        Authorization::Skip(why) => {
            eprintln!("ignored: relay_refuses_a_pipe_server_actually_running_as_another_user — {why}");
            return;
        }
        Authorization::Ready(auth) => auth,
    };
    let _ = auth;
    let scratch = ForeignScratch::new("relay");
    let probe = scratch.probe();
    let sid = winipc::ffi::current_user_sid().expect("own sid");
    let instance = winipc::ffi::random_instance_hex().expect("random instance");
    let name = winipc::pipe_name_for(&sid, &instance).expect("valid receiver pipe shape");
    let plain = name.strip_prefix(winipc::PIPE_PREFIX).expect("pipe shape").to_owned();

    let id_file = scratch.path.join("server.pid");
    let done = scratch.path.join("server.done");
    let _marker = DoneMarker(done.clone());

    // Start the REAL foreign pipe server (bounded; see DoneMarker + launcher
    // timeout), then take its actual pid — not an invented or same-SID one.
    let scratch_path = scratch.path.clone();
    let id_path = id_file.clone();
    let done_path = done.clone();
    let server = std::thread::spawn(move || {
        run_foreign(
            &scratch_path,
            &[
                "pwsh.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-File", probe.to_str().unwrap(), "-Mode", "serve", "-Target", &plain,
                "-Done", done_path.to_str().unwrap(), "-IdFile", id_path.to_str().unwrap(),
            ],
            180,
        )
    });
    let foreign_pid: u32 = wait_for_file(&id_file, Duration::from_secs(60))
        .parse()
        .expect("foreign server pid is a number");

    // Metadata created by the CURRENT user (private parent, owner-only file)
    // naming the foreign server's actual pid and OUR sid — exactly what a
    // tampered host file would look like after the real island died.
    let runtime = runtime_root("fu-relay");
    let meta = winipc::EndpointMeta::new(name, foreign_pid, sid).expect("endpoint metadata");
    winipc::ffi::publish_endpoint(&runtime, &meta).expect("publish metadata");
    assert!(
        winipc::ffi::directory_private(&runtime.join(winipc::ffi::ENDPOINT_FILE), &meta.sid, true),
        "fixture metadata file must be owner-only before the relay reads it"
    );

    let out = Command::new(RELAY)
        .arg(runtime.join(winipc::ffi::ENDPOINT_FILE))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("relay runs");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(
        out.status.code(),
        Some(3),
        "the relay must refuse a foreign-SID server (pid+SID checked BEFORE any byte); stderr: {stderr}"
    );
    assert!(
        stderr.contains("stale or foreign"),
        "the refusal must be the fixed foreign-identity message, got: {stderr}"
    );
    assert!(
        out.stdout.is_empty(),
        "no payload may be forwarded to or from the foreign server"
    );

    // The relay never even connected: the foreign server saw zero clients
    // and zero bytes.
    let _ = std::fs::write(&done, b"done");
    let server_out = server.join().expect("foreign server probe finishes");
    assert_foreign_launched(&server_out, "relay serve probe");
    let server_stdout = String::from_utf8_lossy(&server_out.stdout);
    assert!(
        server_stdout.contains("SERVE-RESULT connections=0 bytes=0"),
        "the refused relay must not have connected to the foreign server; probe said:\n{server_stdout}"
    );

    let _ = std::fs::remove_dir_all(&runtime);
}

// --- case 3: the foreign user cannot read the private files -------------------

/// Island scratch for the real `abito-private-session` helper (same shape as
/// windows_daemon.rs): protected owner-only Abito/runtime directories.
fn session_fixture(tag: &str) -> PathBuf {
    let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(tag);
    let _ = std::fs::remove_dir_all(&base); // stale fixture of ours
    std::fs::create_dir_all(base.join("Abito").join("runtime")).expect("island scratch");
    let sid = winipc::ffi::current_user_sid().expect("fixture owner");
    // Protect the existing child first, before the parent's non-inheritable
    // DACL removes the child's inherited grants (same fixture as windows_daemon).
    winipc::ffi::set_owner_only_acl(&base.join("Abito").join("runtime"), &sid).expect("private runtime dir");
    winipc::ffi::set_owner_only_acl(&base.join("Abito"), &sid).expect("private Abito dir");
    base
}

#[test]
fn foreign_user_cannot_read_private_session_or_notice_metadata() {
    let auth = match authorization() {
        Authorization::Skip(why) => {
            eprintln!("ignored: foreign_user_cannot_read_private_session_or_notice_metadata — {why}");
            return;
        }
        Authorization::Ready(auth) => auth,
    };
    let _ = auth;
    let scratch = ForeignScratch::new("files");
    let probe = scratch.probe();
    let sid = winipc::ffi::current_user_sid().expect("own sid");

    // (a) session.json, written by the ACTUAL native helper.
    let base = session_fixture("fu-session");
    let instance = winipc::ffi::random_instance_hex().expect("random instance");
    let payload = json!({
        "protocol": "island-agent/1",
        "endpoint": format!(r"\\.\pipe\abito-{instance}"),
        "token": "c2Vzc2lvbi10b2tlbi1iYXNlNjR1cmw",
        "pid": std::process::id(),
        "startedAt": 1234u64,
    })
    .to_string();
    let mut helper = Command::new(HELPER)
        .env("LOCALAPPDATA", &base)
        .env_remove("ABITO_ISLAND_DIR")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn private-session helper");
    helper
        .stdin
        .as_mut()
        .expect("helper stdin")
        .write_all(payload.as_bytes())
        .expect("write helper stdin");
    let helper_out = helper.wait_with_output().expect("wait helper");
    assert_eq!(
        helper_out.status.code(),
        Some(0),
        "helper writes the session fixture; stderr: {}",
        String::from_utf8_lossy(&helper_out.stderr)
    );
    let session_file = base.join("Abito").join("runtime").join("session.json");

    // (b) endpoint.json, published by the ACTUAL receiver.
    let receiver = Receiver::new("fu-files");
    let endpoint_file = receiver.runtime.join(winipc::ffi::ENDPOINT_FILE);

    // Controls: both files EXIST and are readable by the current user, and
    // both carry an owner-only file DACL right now (the exact property the
    // foreign read is about to prove holds at the OS level).
    for (name, path) in [("session.json", &session_file), ("endpoint.json", &endpoint_file)] {
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("current user must read {name}: {error}"));
        let value: Value = serde_json::from_str(&text).expect("fixture parses");
        assert!(value.is_object(), "{name} holds a JSON object");
        assert!(
            winipc::ffi::directory_private(path, &sid, true),
            "{name} must be owner-only (the foreign read then proves it at the OS level)"
        );
    }

    // Foreign reads: the OS must answer ACCESS DENIED — exactly
    // UnauthorizedAccessException, never "file not found" or anything generic.
    for (name, path) in [("session.json", &session_file), ("endpoint.json", &endpoint_file)] {
        let out = run_foreign(
            &scratch.path,
            &[
                "pwsh.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-File", probe.to_str().unwrap(), "-Mode", "read", "-Target", path.to_str().unwrap(),
            ],
            60,
        );
        assert_foreign_launched(&out, &format!("{name} read probe"));
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("DENIED System.UnauthorizedAccessException"),
            "the foreign user must be DENIED {name} by the OS (access denied, not a missing file \
             or a generic error); probe said:\n{stdout}"
        );
        assert!(
            !stdout.contains("READ "),
            "no byte of {name} may reach the foreign user; probe said:\n{stdout}"
        );
    }

    let _ = std::fs::remove_dir_all(&base);
}

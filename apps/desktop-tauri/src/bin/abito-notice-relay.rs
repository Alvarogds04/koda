//! `abito-notice-relay` — stdio ⇄ named-pipe bridge for Windows hook clients
//! (T2/S3/S6). No Tauri/GUI initialization; a small forwarder with the same
//! fail-closed pre-flight the island receiver uses:
//!
//! 1. the discovery metadata file is a regular file (never a symlink) with a
//!    private parent and an explicit owner-only DACL — anything broader is
//!    refused (`winipc::read_verified_meta`);
//! 2. the metadata pid is ALIVE and runs as OUR user (stale metadata refuses;
//!    there is NO direct-connection fallback);
//! 3. the connected pipe's `GetNamedPipeServerProcessId` equals the metadata
//!    pid AND that process's token user SID equals ours — proven BEFORE any
//!    byte is forwarded (a squatter server is refused);
//! 4. forwarding is bounded: the process terminates on stdin/pipe EOF or when
//!    nothing has moved for HANDSHAKE_WAIT before the first byte (a hung hook
//!    cannot pin us) or IDLE_WAIT afterwards (the producer's own protocol
//!    heartbeats — well under 30 s apart — keep a live session alive).
//!
//! Exit codes: 0 clean EOF · 2 metadata refused · 3 stale/foreign pid ·
//! 4 pipe unreachable · 5 server pid/SID mismatch · 6 handshake timeout ·
//! 7 idle timeout · 8 pipe write failure.

#[cfg(windows)]
mod imp {
    use abito_island::winipc;
    use std::io::{Read, Write};
    use std::os::windows::io::AsRawHandle;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const OPEN_WAIT: Duration = Duration::from_secs(2);
    const HANDSHAKE_WAIT: Duration = Duration::from_secs(5);
    const IDLE_WAIT: Duration = Duration::from_secs(30);
    const WRITE_WAIT: Duration = Duration::from_secs(5);
    const READ_SLICE: Duration = Duration::from_millis(500);
    const CHUNK: usize = 8192;

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0)
    }

    fn die(code: i32, reason: &str) -> ! {
        eprintln!("abito-notice-relay: {reason}");
        std::process::exit(code)
    }

    fn metadata_path() -> std::path::PathBuf {
        // Optional explicit path (tests); default is the canonical LOCALAPPDATA
        // location. The path is never trusted: the ACL/owner checks always run.
        match std::env::args().nth(1) {
            Some(path) => std::path::PathBuf::from(path),
            None => abito_island::transport::resolve_runtime()
                .map(|runtime| runtime.join(winipc::ffi::ENDPOINT_FILE))
                .unwrap_or_else(|_| std::path::PathBuf::from(winipc::ffi::ENDPOINT_FILE)),
        }
    }

    pub fn main() {
        let path = metadata_path();
        // 1. metadata: shape, private parent, owner-only DACL (no broader ACL).
        let meta = winipc::ffi::read_verified_meta(&path)
            .unwrap_or_else(|| die(2, "endpoint metadata refused (shape, owner or ACL)"));
        // 2. the recorded island must be alive and ours (stale metadata refuses).
        let me = winipc::ffi::current_user_sid().unwrap_or_else(|| die(2, "own user identity unavailable"));
        if !winipc::ffi::process_alive(meta.pid) || winipc::ffi::process_user_sid(meta.pid).as_deref() != Some(&me) {
            die(3, "endpoint metadata is stale or foreign");
        }
        // 3. connect to the EXACT pipe (bounded; no direct-connection fallback).
        let file = Arc::new(
            winipc::ffi::open_client(&meta.pipe, OPEN_WAIT)
                .unwrap_or_else(|error| die(4, &format!("pipe unreachable: {error}"))),
        );
        // 4. the server is who the metadata said — before any byte is forwarded.
        let server = winipc::ffi::server_pid(file.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE)
            .unwrap_or_else(|| die(5, "server pid unavailable"));
        if server != meta.pid || winipc::ffi::process_user_sid(server).as_deref() != Some(&me) {
            die(5, "pipe server does not match the endpoint metadata");
        }

        let last_activity = Arc::new(AtomicU64::new(now_ms()));
        let first_byte = Arc::new(AtomicBool::new(false));
        let note = |activity: &AtomicU64, first: &AtomicBool| {
            first.store(true, Ordering::SeqCst);
            activity.store(now_ms(), Ordering::SeqCst);
        };

        // pipe → stdout (bounded overlapped reads; EOF or shutdown ends us).
        let reader_last = last_activity.clone();
        let reader_first = first_byte.clone();
        let reader_file = file.clone();
        let _writer = std::thread::spawn(move || {
            let event = match winipc::ffi::create_manual_event() {
                Ok(event) => event,
                Err(_) => std::process::exit(8),
            };
            let event = event.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
            let mut chunk = [0u8; CHUNK];
            loop {
                match winipc::ffi::read_bounded_overlapped(&reader_file, event, &mut chunk, READ_SLICE) {
                    Ok(0) => std::process::exit(0), // server closed: clean EOF
                    Ok(count) => {
                        note(&reader_last, &reader_first);
                        let mut out = std::io::stdout().lock();
                        if out.write_all(&chunk[..count]).is_err() || out.flush().is_err() {
                            std::process::exit(0); // our own stdout is gone
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::TimedOut => continue,
                    Err(_) => std::process::exit(0), // broken pipe: server gone
                }
            }
        });

        // stdin → pipe (bounded writes).
        let feeder_last = last_activity.clone();
        let feeder_first = first_byte.clone();
        let _feeder = std::thread::spawn(move || {
            let mut chunk = [0u8; CHUNK];
            let mut stdin = std::io::stdin().lock();
            loop {
                match stdin.read(&mut chunk) {
                    Ok(0) => std::process::exit(0), // hook closed its end: clean EOF
                    Ok(count) => {
                        if winipc::ffi::write_bounded(file.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE, &chunk[..count], WRITE_WAIT).is_err() {
                            die(8, "pipe write failed");
                        }
                        note(&feeder_last, &feeder_first);
                    }
                    Err(_) => std::process::exit(0),
                }
            }
        });

        // Watchdog: bounded handshake, bounded idle, both reset by any traffic.
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let quiet = now_ms().saturating_sub(last_activity.load(Ordering::SeqCst));
            if !first_byte.load(Ordering::SeqCst) {
                if quiet > HANDSHAKE_WAIT.as_millis() as u64 {
                    die(6, "handshake timeout: no bytes flowed");
                }
            } else if quiet > IDLE_WAIT.as_millis() as u64 {
                die(7, "idle timeout: no bytes flowed");
            }
        }
    }
}

#[cfg(windows)]
fn main() {
    imp::main()
}

#[cfg(not(windows))]
fn main() {}

//! abito-private-session — native Windows writer for the daemon session file
//! (T2/S6, decision L6).
//!
//! The Node daemon cannot set a Windows ACL. The launch token lives in
//! `session.json`, so that file is written HERE, natively:
//!
//! * Input: ONE bounded JSON object on stdin. The token NEVER travels on the
//!   command line, in the environment or in a log.
//! * Output path: exactly `<island>/runtime/session.json`, where `<island>` is
//!   the canonical protected `%LOCALAPPDATA%\Abito` root — or an
//!   `ABITO_ISLAND_DIR` override INSIDE it (`winpolicy::island_root` refuses
//!   anything else). No path ever comes from the input.
//! * Write: `winipc::ffi::private_file_bytes` — CREATE_NEW temp with an
//!   explicit protected owner-only DACL AT CREATION (O:<sid>D:P(A;;GA;;;<sid>)),
//!   then an atomic replace. Node's chmod 0600 is not an ACL; this is.
//! * Validation: closed field set, shaped endpoint, bounded token. Reparse
//!   points anywhere in the runtime path and a non-private runtime directory
//!   are refused. Everything fails closed; errors are fixed strings (never
//!   echoed input, never the token).
//!
//! No GUI. Default publication consumes stdin and prints no success output.
//! `--verify` derives the same canonical root, proves the native session/pipe
//! identity and hello→ready without writes, and returns only a silent verdict
//! exit code. It never accepts a path argument or exposes a token.
use std::io::Read as _;
use std::io::Write as _;
#[cfg(windows)]
use abito_island::winipc;
use abito_island::winpolicy;
use serde_json::Value;

const PROTOCOL: &str = "island-agent/1";
/// Bounded stdin: the session payload is a few hundred bytes at most.
const MAX_INPUT: usize = 4096;
const MIN_TOKEN: usize = 16;
const MAX_TOKEN: usize = 512;

fn fail(message: &str) -> i32 {
    let _ = writeln!(std::io::stderr(), "abito-private-session: {message}");
    1
}

/// The stdin JSON with a CLOSED field set and shaped values; returns the
/// canonical bytes to write (single line + LF, matching the Unix writer).
fn validated_bytes(input: &str) -> Result<Vec<u8>, &'static str> {
    let value: Value = serde_json::from_str(input).map_err(|_| "input is not one JSON object")?;
    let map = value.as_object().ok_or("input is not one JSON object")?;
    let protocol = map.get("protocol").and_then(Value::as_str).ok_or("protocol missing")?;
    if protocol != PROTOCOL {
        return Err("unknown protocol");
    }
    let endpoint = map.get("endpoint").and_then(Value::as_str).ok_or("endpoint missing")?;
    if !winpolicy::pipe_endpoint_ok(endpoint) {
        return Err("endpoint is not this daemon's pipe shape");
    }
    let token = map.get("token").and_then(Value::as_str).ok_or("token missing")?;
    let token_ok = (MIN_TOKEN..=MAX_TOKEN).contains(&token.len())
        && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !token_ok {
        return Err("token is not a bounded base64url string");
    }
    let pid = map.get("pid").and_then(Value::as_u64).ok_or("pid missing")?;
    if pid <= 1 || pid > u64::from(u32::MAX) {
        return Err("pid out of range");
    }
    let proc_start = match map.get("procStart") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if !text.is_empty() && text.len() <= 32 && text.bytes().all(|b| b.is_ascii_digit()) => {
            Some(Value::String(text.clone()))
        }
        Some(_) => return Err("procStart is not a bounded decimal string"),
    };
    let started_at = map.get("startedAt").and_then(Value::as_f64).ok_or("startedAt missing")?;
    if !(0.0..=9.0e15).contains(&started_at) || started_at.fract() != 0.0 {
        return Err("startedAt is not a bounded integer timestamp");
    }
    let ppid = match map.get("ppid") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => {
            let p = n.as_u64().ok_or("ppid is not an integer")?;
            if p > u64::from(u32::MAX) {
                return Err("ppid out of range");
            }
            Some(Value::from(p as u32))
        }
        Some(_) => return Err("ppid is not an integer"),
    };
    // Closed key set: exactly these fields, nothing else.
    let known = ["protocol", "endpoint", "token", "pid", "procStart", "startedAt", "ppid"];
    if map.keys().any(|k| !known.contains(&k.as_str())) {
        return Err("unknown field in session payload");
    }
    let canonical = serde_json::json!({
        "protocol": protocol,
        "endpoint": endpoint,
        "token": token,
        "pid": pid as u32,
        "procStart": proc_start,
        "startedAt": started_at as u64,
        "ppid": ppid,
    });
    let mut bytes = serde_json::to_vec(&canonical).map_err(|_| "canonical serialization failed")?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Read-only peer probe: no path or identity supplied by the caller, only a bounded PID.
fn parent_check_pid(args: &[String]) -> Option<u32> {
    if args.len() != 2 || args[0] != "--parent-check" || args[1].is_empty()
        || args[1].len() > 10 || !args[1].bytes().all(|b| b.is_ascii_digit()) { return None; }
    args[1].parse::<u32>().ok().filter(|pid| *pid > 1)
}

#[cfg(windows)]
fn parent_evidence(pid: u32) -> Option<Value> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;
    let current = winipc::ffi::current_user_sid()?;
    // Hold the handle across both token and image reads to avoid PID reuse between probes.
    let (process, parent) = winipc::ffi::open_process_with_user(pid)?;
    if current != parent { return None; }
    let mut image = [0u16; 1024];
    let mut length = image.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.as_raw_handle() as _, 0, image.as_mut_ptr(), &mut length) } == 0 {
        return None;
    }
    let executable = String::from_utf16(image.get(..length as usize)?).ok()?;
    if executable.is_empty() || executable.chars().any(char::is_control) { return None; }
    Some(serde_json::json!({"schema":"abito-parent/1", "pid":pid, "executable":executable,
        "currentSid":current, "parentSid":parent}))
}

/// Fixed hook targets only. No caller path can reach the native filesystem probe.
fn target_parts(args: &[String]) -> Option<&'static [&'static str]> {
    if args.len() != 2 || args[0] != "--check-target" { return None; }
    match args[1].as_str() {
        "claude" | "recap" | "statusline" => Some(&[".claude", "settings.json"]),
        "codex" => Some(&[".codex", "hooks.json"]),
        "copilot" => Some(&[".copilot", "hooks", "abito-island.json"]),
        "opencode" => Some(&[".config", "opencode", "plugins", "abito-island.js"]),
        _ => None,
    }
}

#[cfg(windows)]
fn target_private(target: &std::path::Path, sid: &str) -> bool {
    let Some(parent) = target.parent() else { return false; };
    if !winipc::ffi::directory_private(parent, sid, false) { return false; }
    match std::fs::symlink_metadata(target) {
        Ok(meta) => meta.is_file() && winipc::ffi::config_file_private(target, sid),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

fn run() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.as_slice() == ["--help"] {
        println!("Usage: abito-private-session [--verify | --parent-check <pid> | --check-target <agent-id> | --check-path <p> | ...]\nNo arguments: publish bounded session JSON from stdin.\n--verify: read-only canonical session ACL/server identity/hello-ready check; silent exit 0 on success, 1 on refusal. No path arguments.\n--parent-check <pid>: Windows own-user process image/SID evidence as bounded JSON; silent exit 1 if unavailable.\n--check-path|--make-dir|--delete <abs path>, --move <from> <to>, --write-private <path> --expect none|<sha256> (stdin): Windows installer filesystem operations with owner/DACL/reparse checks; one JSON line abito-fs/1, exit 1 on refusal.\n--check-target <agent-id>: read-only Windows default hook target owner/DACL/reparse check (claude, codex, copilot, opencode, recap, statusline); silent exit 0 when private, 1 otherwise. Does not authorize installation or check audit/side files.");
        return 0;
    }
    if args.first().map(String::as_str) == Some("--parent-check") {
        let Some(pid) = parent_check_pid(&args) else { return 1; };
        #[cfg(windows)]
        { return match parent_evidence(pid) { Some(evidence) => { println!("{evidence}"); 0 }, None => 1 }; }
        #[cfg(not(windows))]
        { let _ = pid; return 1; }
    }
    if args.first().map(String::as_str) == Some("--check-target") {
        let Some(parts) = target_parts(&args) else { return 1; };
        #[cfg(windows)]
        {
            let Some(home) = std::env::home_dir() else { return 1; };
            let Some(sid) = winipc::ffi::current_user_sid() else { return 1; };
            let target = parts.iter().fold(home, |base, part| base.join(part));
            return if target_private(&target, &sid) { 0 } else { 1 };
        }
        #[cfg(not(windows))]
        { let _ = parts; return 1; }
    }
    if let Some(cmd) = winpolicy::parse_fs_args(&args) {
        #[cfg(windows)]
        {
            return match abito_island::winfs::ffi::run(&cmd, &mut std::io::stdin()) {
                Ok(json) => { println!("{json}"); 0 }
                Err(reason) => { println!("{{\"schema\":\"abito-fs/1\",\"ok\":false,\"reason\":\"{reason}\"}}"); 1 }
            };
        }
        #[cfg(not(windows))]
        { let _ = cmd; return 1; }
    }
    let verify = args.as_slice() == ["--verify"];
    if !args.is_empty() && !verify { return fail("usage: abito-private-session [--verify]"); }
    #[cfg(windows)]
    {
        run_windows(verify)
    }
    #[cfg(not(windows))]
    {
        if verify { 1 } else { fail("this helper is Windows-only") }
    }
}

/// Bounded stdin read (B4): the take() limit is applied BEFORE any read, so an
/// overbound payload can never be buffered in full; one extra byte proves the
/// payload exceeds the bound and is refused before any parsing or write.
fn read_bounded_input(reader: &mut impl std::io::Read) -> Result<String, &'static str> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_INPUT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "stdin missing or unreadable")?;
    if bytes.len() > MAX_INPUT {
        return Err("stdin over the size bound");
    }
    String::from_utf8(bytes).map_err(|_| "stdin is not UTF-8")
}

#[cfg(windows)]
fn run_windows(verify: bool) -> i32 {
    // Identity first: without OUR user SID there is no owner for the DACL.
    let Some(sid) = winipc::ffi::current_user_sid() else {
        return if verify { 1 } else { fail("current user SID unavailable") };
    };
    // Canonical root only: an unsafe override is refused here (never bypasses
    // the protected LOCALAPPDATA root), matching the Rust reader's policy.
    let root = match winpolicy::island_root(
        std::env::var("ABITO_ISLAND_DIR").ok().as_deref(),
        std::env::var("LOCALAPPDATA").ok().as_deref(),
    ) {
        Some(root) => root,
        None => return if verify { 1 } else { fail("island root is not the canonical protected one") },
    };
    if verify {
        return if abito_island::agentconn::verify_session(&root).is_ok() { 0 } else { 1 };
    }
    let runtime = root.join("runtime");
    // The daemon creates the runtime directory; this helper only ever fills
    // session.json inside it. A missing, non-private or reparse runtime
    // directory is refused — nothing is created implicitly.
    if !winipc::ffi::directory_private(&runtime, &sid, false) {
        return fail("runtime directory missing or not private");
    }
    let text = match read_bounded_input(&mut std::io::stdin()) {
        Ok(text) => text,
        Err(message) => return fail(message),
    };
    let bytes = match validated_bytes(&text) {
        Ok(bytes) => bytes,
        Err(message) => return fail(message),
    };
    match winipc::ffi::private_file_bytes(&runtime.join("session.json"), &bytes, &sid) {
        Ok(()) => 0,
        Err(_) => fail("protected session write failed"),
    }
}

fn main() {
    std::process::exit(run());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_check_accepts_only_one_bounded_decimal_pid() {
        assert_eq!(parent_check_pid(&["--parent-check".into(), "42".into()]), Some(42));
        for args in [vec!["--parent-check"], vec!["--parent-check", "1"], vec!["--parent-check", "0"],
            vec!["--parent-check", "-1"], vec!["--parent-check", "4294967296"], vec!["--parent-check", "42", "path"],
            vec!["--parent-check", "42/evil"], vec!["--verify"], vec![]] {
            assert_eq!(parent_check_pid(&args.into_iter().map(str::to_owned).collect::<Vec<_>>()), None);
        }
    }

    #[test]
    fn target_check_accepts_only_closed_agent_ids_without_paths() {
        assert_eq!(target_parts(&["--check-target".into(), "claude".into()]), Some(&[".claude", "settings.json"][..]));
        assert_eq!(target_parts(&["--check-target".into(), "codex".into()]), Some(&[".codex", "hooks.json"][..]));
        for args in [vec!["--check-target"], vec!["--check-target", "unknown"], vec!["--check-target", "../claude"],
            vec!["--check-target", "claude", "C:\\other"], vec!["--verify", "claude"]] {
            assert_eq!(target_parts(&args.into_iter().map(str::to_owned).collect::<Vec<_>>()), None);
        }
    }

    #[cfg(windows)]
    #[test]
    fn native_parent_evidence_is_own_user_and_bounded() {
        let evidence = parent_evidence(std::process::id()).expect("own process evidence");
        assert_eq!(evidence["currentSid"], evidence["parentSid"]);
        assert_eq!(evidence["pid"], std::process::id());
        assert!(evidence["executable"].as_str().unwrap().ends_with(".exe"));
        assert!(evidence.to_string().len() < 8192);
        assert!(parent_evidence(0).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn native_target_probe_refuses_broad_acl_reparse_and_missing_parent() {
        use std::os::windows::fs::symlink_dir;
        let sid = winipc::ffi::current_user_sid().unwrap();
        let root = std::env::temp_dir().join(format!("abito-target-{}-{}", std::process::id(), winipc::ffi::random_instance_hex().unwrap()));
        std::fs::create_dir(&root).unwrap();
        winipc::ffi::set_owner_only_acl(&root, &sid).unwrap();
        let file = root.join("settings.json");
        assert!(target_private(&file, &sid), "missing file in private directory");
        winipc::ffi::private_file_bytes(&file, b"{}", &sid).unwrap();
        assert!(target_private(&file, &sid), "private regular file");
        assert!(!target_private(&root.join("absent/settings.json"), &sid));
        assert!(!winipc::ffi::config_file_private(&root, &sid), "directory is not a config file");
        let grant = std::process::Command::new("icacls").arg(&file).args(["/grant", "*S-1-5-32-545:(R)"]).output().unwrap();
        assert!(grant.status.success());
        assert!(!target_private(&file, &sid), "Users:R must refuse");
        assert_eq!(std::fs::read(&file).unwrap(), b"{}");
        let link = root.join("linked");
        symlink_dir(&root, &link).expect("Windows test runner needs symlink privileges");
        assert!(!target_private(&link.join("settings.json"), &sid), "reparse ancestor");
        std::fs::remove_dir(&link).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn payload() -> String {
        serde_json::json!({
            "protocol": PROTOCOL,
            "endpoint": r"\\.\pipe\abito-0123456789abcdef0123456789abcdef",
            "token": "aGVsbG8td29ybGQtdG9rZW4tMTIz", // 23 base64url chars
            "pid": 4242,
            "startedAt": 1234u64,
        })
        .to_string()
    }

    #[test]
    fn overbound_input_is_refused_before_any_parse_or_write() {
        // One byte over the bound is refused; the bound itself is accepted.
        let over = vec![b'a'; MAX_INPUT + 1];
        assert_eq!(read_bounded_input(&mut over.as_slice()).unwrap_err(), "stdin over the size bound");
        let at_limit = vec![b'a'; MAX_INPUT];
        assert!(read_bounded_input(&mut at_limit.as_slice()).is_ok());
        // The bounded reader only enforces bounds + UTF-8; emptiness is the
        // VALIDATION layer's refusal, not a bounds violation.
        assert_eq!(read_bounded_input(&mut &b""[..]).unwrap(), "");
        assert!(read_bounded_input(&mut &[0xff, 0xfe][..]).is_err(), "non-UTF-8 refused");
    }

    #[test]
    fn valid_payload_roundtrips_canonically() {
        let bytes = validated_bytes(&payload()).unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["pid"], 4242);
        assert_eq!(value["protocol"], PROTOCOL);
        assert_eq!(value["endpoint"], r"\\.\pipe\abito-0123456789abcdef0123456789abcdef");
        assert_eq!(value["startedAt"], 1234);
        assert!(bytes.ends_with(b"\n"));
    }

    #[test]
    fn every_bad_shape_is_refused() {
        for patch in [
            ("protocol", serde_json::json!("island-agent/2")),
            ("endpoint", serde_json::json!("\\\\.\\pipe\\other-0123456789abcdef0123456789abcdef")),
            ("token", serde_json::json!("short")),
            ("token", serde_json::json!("not a token!")),
            ("pid", serde_json::json!(1)),
            ("pid", serde_json::json!("4242")),
            ("startedAt", serde_json::json!("1234")),
            ("procStart", serde_json::json!("12x")),
            ("ppid", serde_json::json!("x")),
        ] {
            let mut bad = serde_json::from_str::<Value>(&payload()).unwrap();
            bad[patch.0] = patch.1;
            assert!(validated_bytes(&bad.to_string()).is_err(), "{}", patch.0);
        }
        // unknown fields refused; missing fields refused
        let mut extra = serde_json::from_str::<Value>(&payload()).unwrap();
        extra["extra"] = serde_json::json!(1);
        assert!(validated_bytes(&extra.to_string()).is_err());
        assert!(validated_bytes("{}").is_err());
        assert!(validated_bytes("not json").is_err());
        assert!(validated_bytes("[1]").is_err());
    }
}

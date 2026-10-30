//! P2 — the STABLE handoff of the receiver endpoint.
//!
//! The island binds a fresh `<runtime>/p-XXXXXX/s` on every start, so a local consumer (an agent
//! hook) cannot know it in advance. After the bind we publish ONE file at a path that never
//! changes — `<runtime>/endpoint.json` — and remove it on exit:
//!
//! ```json
//! {"v":1,"endpoint":"<runtime>/p-XXXXXX/s","pid":<island pid>,"procStart":"<field 22 of /proc/<pid>/stat>"}
//! ```
//!
//! `procStart` makes the pid an IDENTITY: a recycled pid has a different start time, so a file left by a
//! killed island is not believed just because some other process now owns that number. Optional on read (a
//! file from before this key still works); never written empty.
//!
//! 0600, written to a temp file then `rename`d (readers never see a half file), closed key set.
//! It is a pointer, not an authority: the consumer still connects to the socket, which checks the
//! peer uid, and [`read`] refuses a stale file (socket gone, wrong shape). Nothing here makes a
//! path, a pid or a label trusted.
use serde_json::{json, Value};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

#[cfg(test)]
#[path = "handoff_tests.rs"]
mod tests;

pub const FILE_NAME: &str = "endpoint.json";
/// Write `procStart` into the handoff. On since `desktop-harness` accepts and verifies the key (2ece2c3): the
/// engine's hook reader used to accept exactly `endpoint,pid,v`, so this was held back until both sides moved.
pub const WRITE_PROC_START: bool = true;
const MAX_FILE: u64 = 4096;

/// `<runtime>/endpoint.json`.
/// Longest socket path the kernel accepts (sockaddr_un.sun_path minus the NUL): 107 on Linux, 103 on macOS.
#[cfg(target_os = "linux")]
const SUN_PATH_MAX: usize = 107;
#[cfg(not(target_os = "linux"))]
const SUN_PATH_MAX: usize = 103;

pub fn path(runtime: &Path) -> PathBuf {
    runtime.join(FILE_NAME)
}

/// Field 22 of `/proc/<pid>/stat` (the process start time in clock ticks since boot) as a decimal string, or
/// `None` when the process does not exist or `/proc` cannot be read. `comm` may contain spaces and parentheses, so
/// the fields are parsed after the LAST `)`. Mirrors the engine daemon's `procStartTicks`.
#[cfg(target_os = "linux")]
pub fn proc_start(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = stat.get(stat.rfind(')')? + 2..)?;
    let ticks = rest.split(' ').nth(22 - 3)?;
    (!ticks.is_empty() && ticks.bytes().all(|b| b.is_ascii_digit())).then(|| ticks.to_string())
}

/// macOS (HU-068): the process start in whole seconds since the epoch from `proc_pidinfo(PROC_PIDTBSDINFO)`, the
/// SAME value the engine's darwin reader derives from `ps -o lstart=` (1-second resolution, documented residual
/// in HU-054). No `/proc`, no shell.
#[cfg(target_os = "macos")]
pub fn proc_start(pid: u32) -> Option<String> {
    if pid == 0 || pid > i32::MAX as u32 {
        return None;
    }
    // SAFETY: zeroed POD out-buffer of the exact size the call is told; the return value is checked.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let got = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    (got == size && info.pbi_start_tvsec > 0).then(|| info.pbi_start_tvsec.to_string())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn proc_start(_pid: u32) -> Option<String> {
    None
}

/// Is `pid` a live process? Linux reads `/proc/<pid>`; other Unix asks the kernel with signal 0 (EPERM = it exists
/// but belongs to someone else, which still means alive).
fn pid_alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        if pid == 0 || pid > i32::MAX as u32 {
            return false;
        }
        // SAFETY: kill with signal 0 sends nothing; it only checks existence/permission.
        let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
        r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

/// `<runtime>/p-<6 alphanumerics>/s`, absolute and normalized, exactly one level below `runtime`.
fn endpoint_shape_ok(endpoint: &Path, runtime: &Path) -> bool {
    if !endpoint.is_absolute() || endpoint.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return false;
    }
    let (Some(dir), Some(leaf)) = (endpoint.parent(), endpoint.file_name()) else { return false };
    let (Some(parent), Some(name)) = (dir.parent(), dir.file_name()) else { return false };
    let name = name.as_bytes();
    leaf.as_bytes() == b"s"
        && parent == runtime
        && endpoint.as_os_str().as_bytes().len() <= SUN_PATH_MAX
        && name.len() == 8
        && name.starts_with(b"p-")
        && name[2..].iter().all(u8::is_ascii_alphanumeric)
}

fn io(msg: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, msg.to_string())
}

/// Publish `endpoint` for local consumers. Refuses anything that is not the exact receiver socket
/// of `runtime`, a non-private `runtime`, and a symlink at the target path.
pub fn publish(runtime: &Path, endpoint: &Path) -> std::io::Result<()> {
    if !endpoint_shape_ok(endpoint, runtime) {
        return Err(io("endpoint is not <runtime>/p-XXXXXX/s"));
    }
    let socket = std::fs::symlink_metadata(endpoint)?;
    if !socket.file_type().is_socket() {
        return Err(io("endpoint is not a socket"));
    }
    let dir = std::fs::symlink_metadata(runtime)?;
    let me = uid();
    if !dir.file_type().is_dir() || dir.uid() != me || dir.permissions().mode() & 0o777 != 0o700 {
        return Err(io("runtime root must be a private (0700) directory of ours"));
    }
    let target = path(runtime);
    if let Ok(existing) = std::fs::symlink_metadata(&target) {
        if existing.file_type().is_symlink() || !existing.file_type().is_file() {
            return Err(io("refusing to replace a symlink or a non-file"));
        }
    }
    let me = std::process::id();
    let mut body = json!({"v": 1, "endpoint": endpoint.to_str().ok_or_else(|| io("endpoint is not UTF-8"))?, "pid": me});
    // Never an empty or invented value: if /proc cannot say, the key is simply absent (the previous format, which
    // the readers still accept).
    if WRITE_PROC_START {
        if let Some(start) = proc_start(me) {
            body["procStart"] = json!(start);
        }
    }
    let line = format!("{body}\n");
    let tmp = runtime.join(format!("{FILE_NAME}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let written = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        file.write_all(line.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&tmp, &target)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Contents of a handoff file, parsed and shape-checked; `None` for anything that is not ours.
fn parse(runtime: &Path, text: &str) -> Option<PathBuf> {
    let v: Value = serde_json::from_str(text).ok()?;
    let map = v.as_object()?;
    // closed key set: v, endpoint, pid, and optionally procStart
    let has_start = map.contains_key("procStart");
    if map.len() != 3 + usize::from(has_start) || map.get("v") != Some(&json!(1)) {
        return None;
    }
    // the island that wrote it must still be alive: a SIGKILL leaves the file (and the socket
    // inode) behind, and a recycled path must not be believed
    let pid = map.get("pid")?.as_u64().filter(|p| *p > 0 && *p <= i32::MAX as u64)? as u32;
    if !pid_alive(pid) {
        return None;
    }
    // ...and it must be the SAME life of that pid: a recycled pid has another start time
    if has_start {
        let claimed = map.get("procStart")?.as_str()?;
        if claimed.is_empty() || !claimed.bytes().all(|b| b.is_ascii_digit()) || proc_start(pid).as_deref() != Some(claimed) {
            return None;
        }
    }
    let endpoint = PathBuf::from(map.get("endpoint")?.as_str()?);
    endpoint_shape_ok(&endpoint, runtime).then_some(endpoint)
}

fn read_text(runtime: &Path) -> Option<String> {
    let target = path(runtime);
    let meta = std::fs::symlink_metadata(&target).ok()?;
    if !meta.file_type().is_file() || meta.len() > MAX_FILE || meta.uid() != uid() {
        return None;
    }
    std::fs::read_to_string(&target).ok()
}

/// The endpoint a consumer should connect to, or `None`: no file, malformed, wrong shape, or the
/// socket it names no longer exists (a crashed island leaves the file behind).
pub fn read(runtime: &Path) -> Option<PathBuf> {
    let endpoint = parse(runtime, &read_text(runtime)?)?;
    std::fs::symlink_metadata(&endpoint).ok()?.file_type().is_socket().then_some(endpoint)
}

/// Remove the handoff, but ONLY when it still names `endpoint`: a newer instance may have taken
/// the file over, and a symlink or foreign file is never ours. Idempotent, never panics.
pub fn clear(runtime: &Path, endpoint: &Path) {
    if read_text(runtime).and_then(|t| parse(runtime, &t)).as_deref() == Some(endpoint) {
        let _ = std::fs::remove_file(path(runtime));
    }
}

fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

//! #467 Claude plan usage, read from the file channel the Abito status-line script writes
//! (`apps/desktop-harness/bin/abito-statusline.cjs` → `<runtime>/plan-claude.json`).
//!
//! The channel holds only `{v:1, at, five_hour?, seven_day?}` (numbers). This reader still treats
//! it as untrusted: no symlinks, regular file owned by us with mode 0600, at most 4 KiB, strict shape,
//! and data older than 10 minutes (or from the future) is "unknown". Extra keys are dropped.
use serde_json::{json, Value};
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

#[cfg(all(test, unix))] // the tests exercise unix file modes
#[path = "claude_plan_tests.rs"]
mod tests;

pub const FILE: &str = "plan-claude.json";
const MAX_BYTES: u64 = 4096;
/// Older than this the gauge would lie: unknown.
pub const MAX_AGE_MS: i64 = 10 * 60 * 1000;
const DAY_MS: i64 = 86_400_000;

fn window(raw: Option<&Value>, now_ms: i64) -> Option<Value> {
    let w = raw?.as_object()?;
    let pct = w.get("used_percentage")?.as_f64()?;
    let epoch = w.get("resets_at")?.as_f64()?;
    if !(0.0..=200.0).contains(&pct) || epoch <= 0.0 || epoch * 1000.0 > (now_ms + 400 * DAY_MS) as f64 {
        return None;
    }
    Some(json!({"usedPct": pct.min(100.0), "resetsAt": (epoch * 1000.0) as i64}))
}

/// The plan as the page's gauge reads it (`{updatedAt, fiveHour?, sevenDay?}`), or `None`.
pub fn read_at(runtime: &Path, now_ms: i64) -> Option<Value> {
    let path = runtime.join(FILE);
    let mut open = std::fs::OpenOptions::new();
    open.read(true);
    #[cfg(unix)]
    open.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let file = open.open(&path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return None;
    }
    // Windows has no mode bits or euid: the runtime dir sits under the user's profile (inherited ACL), so the
    // owner/mode check is a unix-only hardening; the symlink/size/shape checks above and below stay everywhere.
    #[cfg(unix)]
    if meta.mode() & 0o7777 != 0o600 || meta.uid() != unsafe { libc::geteuid() } {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_BYTES {
        return None;
    }
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    let o = v.as_object()?;
    if o.get("v")?.as_i64()? != 1 {
        return None;
    }
    let at = o.get("at")?.as_i64()?;
    if at > now_ms.saturating_add(crate::protocol::CLOCK_SKEW_MS as i64) || now_ms - at > MAX_AGE_MS {
        return None;
    }
    let five = window(o.get("five_hour"), now_ms);
    let seven = window(o.get("seven_day"), now_ms);
    if five.is_none() && seven.is_none() {
        return None;
    }
    let mut out = json!({"updatedAt": at});
    if let Some(w) = five {
        out["fiveHour"] = w;
    }
    if let Some(w) = seven {
        out["sevenDay"] = w;
    }
    Some(out)
}

pub fn read(runtime: &Path) -> Option<Value> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
    read_at(runtime, now)
}

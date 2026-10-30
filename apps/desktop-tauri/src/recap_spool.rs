//! #467 recap spool: the notify-only Claude hooks (`apps/desktop-harness/bin/abito-recap-hook.cjs`)
//! append one reduced JSON line per event to `<runtime>/recap-events.jsonl`; the island takes the
//! whole file with a rename (so a hook appending meanwhile starts a fresh file) and feeds the recap.
//!
//! The file is untrusted: a symlink, a file not owned by us, a mode other than 0600 or more than
//! 1 MiB is deleted unread; lines that are not JSON objects are skipped; at most [`MAX_EVENTS`] lines
//! are taken per read.
use serde_json::Value;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

#[cfg(all(test, unix))] // the tests exercise unix file modes
#[path = "recap_spool_tests.rs"]
mod tests;

pub const FILE: &str = "recap-events.jsonl";
pub const MAX_BYTES: u64 = 1024 * 1024;
pub const MAX_EVENTS: usize = 5000;

/// The reduced events waiting in `runtime`, oldest first; the spool is removed.
pub fn take(runtime: &Path) -> Vec<Value> {
    let spool = runtime.join(FILE);
    if std::fs::symlink_metadata(&spool).is_err() {
        return Vec::new();
    }
    let work = runtime.join(format!(".{FILE}.{}.work", std::process::id()));
    if std::fs::rename(&spool, &work).is_err() {
        return Vec::new();
    }
    let events = read_work(&work);
    let _ = std::fs::remove_file(&work);
    events
}

fn read_work(work: &Path) -> Vec<Value> {
    let mut open = std::fs::OpenOptions::new();
    open.read(true);
    #[cfg(unix)]
    open.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let Ok(file) = open.open(work) else { return Vec::new() };
    let Ok(meta) = file.metadata() else { return Vec::new() };
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return Vec::new();
    }
    // Owner/mode are unix-only hardening (Windows: no mode bits/euid; the runtime dir is in the user's profile).
    #[cfg(unix)]
    if meta.mode() & 0o7777 != 0o600 || meta.uid() != unsafe { libc::geteuid() } {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if file.take(MAX_BYTES + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > MAX_BYTES {
        return Vec::new();
    }
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(Value::is_object)
        .take(MAX_EVENTS)
        .collect()
}

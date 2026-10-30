//! #467 Codex plan usage: the same source as Codex's own `/status`.
//!
//! Adapted from Coucou src-tauri/src/codex_plan.rs @434d6a2b, Copyright (c) 2026 Louis Raillé,
//! MIT. Abito changes: no pause flag and no platform layer (candidate lookup is local and
//! Unix/Windows-neutral), the closed `plan_action` host owns the call.
//!
//! Abito asks the Codex CLI itself: `codex app-server` (the JSON-RPC server behind /status)
//! is started, asked `account/rateLimits/read`, and stopped. Abito makes no network call of
//! its own and reads no credential: Codex answers with its own sign-in. Nothing is installed
//! or written. At most one ask at a time, 15 s at most; blocking, so call it off the UI thread.
use std::cmp::Ordering;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{self, AtomicBool};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

#[cfg(test)]
#[path = "codex_plan_tests.rs"]
mod tests;

const TIMEOUT: Duration = Duration::from_secs(15);
/// One JSON-RPC line we are willing to read; the answer is a few hundred bytes.
const MAX_LINE: usize = 256 * 1024;
/// Everything we are willing to read before the answer shows up.
const MAX_TOTAL: usize = 2 * 1024 * 1024;

const REQUESTS: &str = concat!(
    r#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"abito","version":"1"}}}"#,
    "\n",
    r#"{"method":"initialized"}"#,
    "\n",
    r#"{"id":2,"method":"account/rateLimits/read"}"#,
    "\n",
);

static BUSY: AtomicBool = AtomicBool::new(false);

struct NotBusy;
impl Drop for NotBusy {
    fn drop(&mut self) {
        BUSY.store(false, atomic::Ordering::Release);
    }
}

fn executable(p: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// Where a `codex` binary may live, best first: PATH, then the usual user installs, then nvm
/// (newest Node first).
pub fn candidates() -> Vec<PathBuf> {
    candidates_in(std::env::var_os("PATH"))
}

/// [`candidates`] with an explicit PATH, so tests never mutate the process environment (other tests run in parallel
/// and spawn `node` through it).
pub(crate) fn candidates_in(path: Option<std::ffi::OsString>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(path) = path {
        out.extend(std::env::split_paths(&path).map(|d| d.join("codex")));
    }
    #[cfg(unix)]
    {
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from).filter(|h| h.is_absolute()) {
            for dir in [".local/bin", ".npm-global/bin", ".volta/bin", ".bun/bin", ".local/share/pnpm"] {
                out.push(home.join(dir).join("codex"));
            }
            out.push(PathBuf::from("/usr/local/bin/codex"));
            out.push(PathBuf::from("/usr/bin/codex"));
            let nvm = home.join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(&nvm) {
                let mut versions: Vec<String> =
                    entries.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
                versions.sort_by(|a, b| compare_versions(b, a));
                out.extend(versions.iter().map(|v| nvm.join(v).join("bin/codex")));
            }
        }
    }
    out.retain(|p| p.is_absolute() && executable(p));
    out
}

/// The limits part of Codex's `account/rateLimits/read` answer, or `None` when Codex is not
/// installed, not signed in, slow, or already being asked.
pub fn read() -> Option<Value> {
    read_with(std::env::var_os("PATH"))
}

/// [`read`] with an explicit PATH (used to find `codex` and handed to it); the process environment is never changed.
pub(crate) fn read_with(path: Option<std::ffi::OsString>) -> Option<Value> {
    if BUSY.swap(true, atomic::Ordering::AcqRel) {
        return None;
    }
    let _busy = NotBusy;

    let exe = candidates_in(path.clone()).into_iter().next()?;
    let mut cmd = Command::new(&exe);
    cmd.arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    // An npm install is a `#!/usr/bin/env node` script: its own folder first on PATH so it
    // finds its Node.
    if let Some(dir) = exe.parent() {
        let mut dirs = vec![dir.to_path_buf()];
        if let Some(path) = &path {
            dirs.extend(std::env::split_paths(path));
        }
        if let Ok(joined) = std::env::join_paths(dirs) {
            cmd.env("PATH", joined);
        }
    }
    let mut child = cmd.spawn().ok()?;

    let answer = (|| {
        let mut stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(first_answer(BufReader::new(stdout)));
        });
        stdin.write_all(REQUESTS.as_bytes()).ok()?;
        stdin.flush().ok()?;
        let answer = rx.recv_timeout(TIMEOUT).ok().flatten();
        // Closing its input is how app-server learns we are done.
        drop(stdin);
        answer
    })();
    let _ = child.kill();
    let _ = child.wait();
    answer.map(|result| limits_only(&result))
}

/// Reads JSON-RPC lines until the answer to request 2 and returns its `result`.
/// Gives up on a line or a stream that is far too long for what we expect.
pub fn first_answer(reader: impl BufRead) -> Option<Value> {
    let mut reader = reader;
    let mut total = 0usize;
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = (&mut reader).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line).ok()?;
        if n == 0 {
            return None;
        }
        total += n;
        if total > MAX_TOTAL || line.len() > MAX_LINE {
            return None;
        }
        let Ok(message) = serde_json::from_slice::<Value>(&line) else { continue };
        if message.get("id").and_then(Value::as_i64) == Some(2) {
            return message.get("result").filter(|r| r.is_object()).cloned();
        }
    }
}

/// Only what the card shows goes to the webview: the limits and the free resets.
pub fn limits_only(result: &Value) -> Value {
    json!({
        "rateLimits": result.get("rateLimits").cloned().unwrap_or(Value::Null),
        "rateLimitResetCredits": result.get("rateLimitResetCredits").cloned().unwrap_or(Value::Null),
    })
}

/// Compares version-like names with their numbers as numbers ("v20.1" > "v9.12").
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    fn parts(s: &str) -> Vec<Result<u64, String>> {
        let mut out = Vec::new();
        let mut cur = String::new();
        let mut digits = false;
        for c in s.chars() {
            if c.is_ascii_digit() != digits && !cur.is_empty() {
                out.push(if digits { Ok(cur.parse().unwrap_or(u64::MAX)) } else { Err(cur.clone()) });
                cur.clear();
            }
            digits = c.is_ascii_digit();
            cur.push(c);
        }
        if !cur.is_empty() {
            out.push(if digits { Ok(cur.parse().unwrap_or(u64::MAX)) } else { Err(cur) });
        }
        out
    }
    let (pa, pb) = (parts(a), parts(b));
    for (x, y) in pa.iter().zip(pb.iter()) {
        let ord = match (x, y) {
            (Ok(x), Ok(y)) => x.cmp(y),
            (Err(x), Err(y)) => x.cmp(y),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    pa.len().cmp(&pb.len())
}

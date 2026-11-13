//! K2-05 U5b — what is left of the island's upload support, and why.
//!
//! The island never stores a file any more (L11 2a: attachments go to the
//! daemon's engine workspace, `chatclient` hands them over and the daemon
//! issues their ids). The 0.1 store that lived here left with the direct Rust
//! chat lane and the 0.1 conversation store: `attach`/`attach_with_cap`,
//! `attachments_dir`, `read_dropped`, `stored_text`, `stored_data_url`,
//! `resolve_ids`, the total-bytes cap and the stale-`tmp` sweep.
//!
//! Three small pieces still have a real caller:
//! - [`DropSet`]: the native drag-drop paths, kept for specialists until U5d
//!   (K2-05 L59) — `chat_attach` still only honours a path the OS reported
//!   dropped on the island window, and the attachments path that replaces it
//!   (L58 «the new attach path needs it») keeps using it;
//! - [`split_raw_body`]: the `chat_attach_data` raw body (a one-line JSON
//!   header, LF, the bytes) the command still parses before handing the file
//!   to the daemon.
//!
//! K2-10 T7 (L21/L22): the mail card lost IMAP and SMTP, so [`MAX_FILE_BYTES`]
//! and [`sanitize_name`] have no caller left inside Koda. They stay because
//! they are public and still describe the one rule a dropped file must keep;
//! deleting them is a separate call, not a side effect of retiring a card.

use std::path::{Path, PathBuf};

use crate::chat::ChatError;

/// Hard size cap for one attached file.
pub const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;

/// Sanitize a DISPLAY name: basename of any separator style, control
/// characters stripped, path-significant and unusual characters folded to
/// `_`, leading/trailing dots and spaces removed, bounded to 80 chars,
/// never empty and never a dot name.
pub fn sanitize_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let mut out = String::new();
    for c in base.chars().filter(|c| !c.is_control()) {
        if c.is_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-' | '(' | ')') {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    let trimmed: String = out.trim_matches(|c| c == '.' || c == ' ').to_string();
    let mut bounded: String = trimmed.chars().take(80).collect();
    if bounded.is_empty() {
        bounded = "archivo".to_string();
    }
    bounded
}

fn invalid(why: &str) -> ChatError {
    ChatError::invalid_input(why)
}

/// Longest a native drop stays claimable.
pub const DROP_TTL_MS: u64 = 60_000;
/// Most native-dropped paths held at once.
pub const DROP_CAP: usize = 16;

/// Paths the OS reported through the native drag-drop event: short-lived,
/// bounded and one-shot. `chat_attach` only honours a member of this set.
#[derive(Default)]
pub struct DropSet {
    entries: Vec<(PathBuf, u64)>,
}

impl DropSet {
    /// An empty set, usable in a `static`.
    pub const fn new() -> Self {
        DropSet {
            entries: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn prune(&mut self, now_ms: u64) {
        self.entries
            .retain(|(_, at)| now_ms.saturating_sub(*at) <= DROP_TTL_MS);
    }

    /// Remember dropped paths; the oldest are evicted beyond `DROP_CAP`.
    pub fn record(&mut self, paths: Vec<PathBuf>, now_ms: u64) {
        self.prune(now_ms);
        for path in paths {
            self.entries.retain(|(p, _)| *p != path);
            self.entries.push((path, now_ms));
        }
        let excess = self.entries.len().saturating_sub(DROP_CAP);
        if excess > 0 {
            self.entries.drain(..excess);
        }
    }

    /// True once if `path` was dropped and is still fresh; it is removed.
    pub fn consume(&mut self, path: &Path, now_ms: u64) -> bool {
        self.prune(now_ms);
        match self.entries.iter().position(|(p, _)| p == path) {
            Some(i) => {
                self.entries.remove(i);
                true
            }
            None => false,
        }
    }
}

/// Split a raw `chat_attach_data` body into (display name, bytes): a
/// one-line JSON header `{"name":"…"}` (≤1 KiB), LF, then the file bytes.
pub fn split_raw_body(body: &[u8]) -> Result<(String, &[u8]), ChatError> {
    let bad = || invalid("Pedido de archivo inválido.");
    let line_end = body
        .iter()
        .position(|b| *b == b'\n')
        .filter(|i| *i <= 1024)
        .ok_or_else(bad)?;
    let header = std::str::from_utf8(&body[..line_end]).map_err(|_| bad())?;
    let name = serde_json::from_str::<serde_json::Value>(header)
        .map_err(|_| bad())?
        .get("name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(bad)?
        .to_string();
    Ok((name, &body[line_end + 1..]))
}

#[cfg(test)]
#[path = "uploads_tests.rs"]
mod tests;

//! K2-05 T5 (S3): one-time cleanup of Koda 0.1's private chat conversations on upgrade from 0.1.
//!
//! 0.2 talks to the daemon engine with one continuous chat and keeps no conversation list
//! (K2-05 T4/U5 removes the direct Rust chat). On upgrade the user's stored 0.1 conversations
//! are deleted — ONLY those files, nothing else:
//! - `<app_data_dir>/conversations/<id>.jsonl` (what `conversations.rs::create` wrote, ids shaped
//!   `c-<stamp>-<pid>-<n>`: `c-` prefix, 4..=80 chars, ASCII alphanumeric or `-`)
//! - `<app_data_dir>/conversations/index.json` (the rebuilt index)
//! - `<app_data_dir>/conversations/index-<pid>-<n>.tmp` (atomic-rename leftovers of the index)
//!
//! Accounts, preferences, secrets (keychain `com.abitog.AbitoTauri`), the Engram memory and every
//! other file in the app data dir are the user's and are never touched.
//!
//! Guards: every leaf is `lstat`ed and only a regular file is removed. A symlink is never
//! followed — not the leaf files, and not the `conversations` directory itself either (if it is a
//! symlink, its target is not ours to empty). Nothing is recursive, and the directory itself is
//! removed only when it is empty afterwards. «Not found» is success. Any other error is reported
//! content-free and the next start retries. The directory path comes from Tauri
//! (`app_data_dir`), never from the user: if the app data dir ABOVE it is a symlink (a data dir
//! the user moved elsewhere), it is followed on purpose, because that is where Koda's own data
//! lives; only the final component of each target is guarded.
//! Same code on Linux, macOS and Windows: the directory comes from Tauri (`app_data_dir`).
//! Independent of `conversations.rs`/`chathost` on purpose: U5 deletes them, this module survives.
//! TODO(K2-05 follow-up): remove one version after K2-05 ships.
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

pub const INDEX_FILE: &str = "index.json";
const TEMP_PREFIX: &str = "index-";
const TEMP_SUFFIX: &str = ".tmp";
const TURN_SUFFIX: &str = ".jsonl";
const ID_PREFIX: &str = "c-";
const ID_MIN_LEN: usize = 4;
const ID_MAX_LEN: usize = 80;

/// What one cleanup run did: how many files went and whether any removal failed (no names, no paths).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub removed: usize,
    pub failed: usize,
}

impl Outcome {
    /// The single content-free log line for this run, if there is anything to say.
    pub fn log_line(&self) -> Option<String> {
        match (self.removed, self.failed) {
            (0, 0) => None,
            (r, 0) => Some(format!("legacy conversations data removed ({r} files)")),
            (r, f) => Some(format!(
                "legacy conversations data cleanup incomplete ({r} removed, {f} failed); retrying next start"
            )),
        }
    }
}

/// A name `conversations.rs` wrote for a stored conversation: `<valid id>.jsonl`.
fn is_turn_file(name: &str) -> bool {
    let Some(id) = name.strip_suffix(TURN_SUFFIX) else {
        return false;
    };
    id.starts_with(ID_PREFIX)
        && (ID_MIN_LEN..=ID_MAX_LEN).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// An atomic-rename leftover `conversations.rs::index` wrote: `index-<pid>-<n>.tmp`, both numeric.
fn is_temp_file(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(TEMP_PREFIX).and_then(|r| r.strip_suffix(TEMP_SUFFIX)) else {
        return false;
    };
    match rest.split_once('-') {
        Some((pid, counter)) => {
            !pid.is_empty()
                && pid.bytes().all(|b| b.is_ascii_digit())
                && !counter.is_empty()
                && counter.bytes().all(|b| b.is_ascii_digit())
        }
        None => false,
    }
}

fn is_legacy_name(name: &str) -> bool {
    name == INDEX_FILE || is_turn_file(name) || is_temp_file(name)
}

fn remove_regular(path: &Path, out: &mut Outcome) {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => match fs::remove_file(path) {
            Ok(()) => out.removed += 1,
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(_) => out.failed += 1,
        },
        Ok(_) => {} // a symlink, directory or anything else is not ours to delete
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(_) => out.failed += 1,
    }
}

/// Remove the legacy conversation files from `dir` (`<app_data_dir>/conversations`; may be absent).
pub fn cleanup(dir: Option<&Path>) -> Outcome {
    let mut out = Outcome::default();
    let Some(dir) = dir else {
        return out;
    };
    // The directory itself is Koda's own leaf, but only a REAL directory is ours to empty: a
    // symlink (the user pointed it elsewhere) or anything else is left untouched, never followed.
    match fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return out,
        Err(e) if e.kind() == ErrorKind::NotFound => return out,
        Err(_) => {
            out.failed += 1;
            return out;
        }
    }
    match fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries {
                let Ok(entry) = entry else {
                    out.failed += 1;
                    continue;
                };
                let name = entry.file_name();
                let Some(name) = name.to_str() else {
                    continue; // `conversations.rs` only ever wrote ASCII names
                };
                if is_legacy_name(name) {
                    remove_regular(&dir.join(name), &mut out);
                }
            }
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(_) => out.failed += 1,
    }
    // Only when nothing failed and nothing is left: take the now-empty directory itself too.
    if out.failed == 0 {
        match fs::read_dir(dir) {
            Ok(mut entries) => {
                if entries.next().is_none() {
                    match fs::remove_dir(dir) {
                        Ok(()) => {}
                        Err(e) if e.kind() == ErrorKind::NotFound => {}
                        Err(_) => out.failed += 1,
                    }
                }
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(_) => out.failed += 1,
        }
    }
    out
}

#[cfg(test)]
#[path = "legacy_conversations_tests.rs"]
mod tests;

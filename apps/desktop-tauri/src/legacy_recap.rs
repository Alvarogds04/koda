//! K2-03 T3 (S2, S4): one-time cleanup of the removed weekly Recap's data on upgrade from Koda 0.1.
//!
//! Recap was removed in 0.2. Its data is deleted at island start, and ONLY these exact paths:
//! - `<app_local_data_dir>/recap.json`
//! - `<app_local_data_dir>/recap.json.corrupt-*` (the copies a corrupt history was set aside as)
//! - `<runtime>/recap-events.jsonl` (the hook spool)
//!
//! Guards: every target is `lstat`ed and only a regular file is removed. A symlink is never followed, a directory is
//! never removed, nothing is recursive, and only that single directory is listed. «Not found» is success. Any other
//! error is reported content-free and the next start retries. PNG images the user saved («Koda weekly recap» in
//! Pictures/Downloads) are the user's files and are never touched.
//! The two DIRECTORIES themselves come from Koda (Tauri's `app_local_data_dir` and the transport runtime), never from
//! the user or a file: if one of them is a symlink (for instance a data dir the user moved elsewhere), it is followed on
//! purpose, because that is where Koda's own data lives. Only the final component of each target is guarded.
//! K2-04 T6: the data dir is the sibling named after the OLD bundle identifier (`legacy_identity::legacy_sibling`), because the
//! identifier is now `com.abitog.Koda`; `<app_local_data_dir>` above means that old folder. Nothing is copied or moved.
//! Same code on Linux, macOS and Windows: the two directories come from Tauri (`app_local_data_dir`) and from
//! `transport::resolve_runtime` for each OS.
//! TODO(K2-03 follow-up): remove one version after K2-03 ships.
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

pub const HISTORY_FILE: &str = "recap.json";
pub const CORRUPT_PREFIX: &str = "recap.json.corrupt-";
pub const SPOOL_FILE: &str = "recap-events.jsonl";

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
            (r, 0) => Some(format!("legacy recap data removed ({r} files)")),
            (r, f) => Some(format!("legacy recap data cleanup incomplete ({r} removed, {f} failed); retrying next start")),
        }
    }
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

/// Remove the legacy Recap files from `data_dir` (the app-local data dir) and `runtime_dir` (either may be absent).
pub fn cleanup(data_dir: Option<&Path>, runtime_dir: Option<&Path>) -> Outcome {
    let mut out = Outcome::default();
    if let Some(dir) = data_dir {
        remove_regular(&dir.join(HISTORY_FILE), &mut out);
        match fs::read_dir(dir) {
            Ok(entries) => {
                for entry in entries {
                    let Ok(entry) = entry else {
                        out.failed += 1;
                        continue;
                    };
                    let name = entry.file_name();
                    if name.to_str().is_some_and(|n| n.starts_with(CORRUPT_PREFIX)) {
                        remove_regular(&dir.join(name), &mut out);
                    }
                }
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(_) => out.failed += 1,
        }
    }
    if let Some(dir) = runtime_dir {
        remove_regular(&dir.join(SPOOL_FILE), &mut out);
    }
    out
}

#[cfg(test)]
#[path = "legacy_recap_tests.rs"]
mod tests;

//! #467 custom sounds: the user's own audio files replace Abito's synthesized cues.
//!
//! Adapted from Coucou src-tauri/src/sounds.rs @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
//! (Idea of "a file named like the sound replaces it" and the format list only. No Coucou
//! sound file is shipped: the folder starts empty and holds only what the user puts there.
//! The closed command, the stem allowlist, the symlink refusal and the base64 answer are
//! Abito's.)
//!
//! Contract:
//! - the folder is `<app config dir>/sounds`, created only by `reveal`;
//! - a file replaces a cue when it is named after the cue's stem (`notice.wav`, `reply.mp3`);
//!   the stems are the closed list [`STEMS`], i.e. the ids of `frontend/sound-engine.js`
//!   without the `snd.` prefix, so no WebView-supplied text ever reaches a path;
//! - only regular, non-empty files up to [`MAX_BYTES`]; a symlink is never followed;
//! - the page decodes the bytes itself and falls back to the built-in cue on any failure.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[cfg(test)]
#[path = "sounds_tests.rs"]
mod tests;

/// Sub-folder of the app config directory that holds the user's files.
pub const FOLDER: &str = "sounds";

/// The cues that can be replaced: `frontend/sound-engine.js` ids minus `snd.`.
pub const STEMS: [&str; 37] = [
    "notice", "attention", "confirm", "reject", "error", "sent", "think", "reply", "listen",
    "expired", "open", "close", "peek", "hover", "pop", "tick", "love",
    "blip", "slap", "annoyed", "dizzy", "greet", "work", "finish", "approval", "question", "approve",
    "gulp", "send", "proud", "wink", "yawn", "attach", "search", "rate", "sleep", "greeting",
];

/// Formats a webview can usually decode, as (extension, MIME), looked for in this order.
const FORMATS: [(&str, &str); 10] = [
    ("wav", "audio/wav"),
    ("mp3", "audio/mpeg"),
    ("ogg", "audio/ogg"),
    ("oga", "audio/ogg"),
    ("m4a", "audio/mp4"),
    ("aac", "audio/aac"),
    ("flac", "audio/flac"),
    ("aiff", "audio/aiff"),
    ("aif", "audio/aiff"),
    ("caf", "audio/x-caf"),
];

/// A sound effect, not an album. The bytes cross the bridge as base64 in one JSON answer,
/// so the bound is far below Coucou's 8 MiB.
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    List,
    Read(&'static str),
    Reveal,
    Reload,
}

/// Closed schema: `{action:"list"}`, `{action:"read",name}`, `{action:"reveal"}`,
/// `{action:"reload"}`; `name` must be one of [`STEMS`]. Anything else → `None`.
pub fn parse_command(payload: &Value) -> Option<Command> {
    let obj = payload.as_object()?;
    match obj.get("action")?.as_str()? {
        "list" if obj.len() == 1 => Some(Command::List),
        "reveal" if obj.len() == 1 => Some(Command::Reveal),
        "reload" if obj.len() == 1 => Some(Command::Reload),
        "read" if obj.len() == 2 => {
            let name = obj.get("name")?.as_str()?;
            STEMS.iter().copied().find(|s| *s == name).map(Command::Read)
        }
        _ => None,
    }
}

fn usable(path: &Path) -> bool {
    // symlink_metadata: a link in the folder must not turn into "read any file I can reach".
    std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_file() && m.len() > 0 && m.len() <= MAX_BYTES)
        .unwrap_or(false)
}

/// The user's file for `stem` in `dir` and its MIME type, if there is a usable one.
fn found(dir: &Path, stem: &str) -> Option<(PathBuf, &'static str)> {
    if !STEMS.contains(&stem) {
        return None;
    }
    FORMATS
        .iter()
        .map(|(ext, mime)| (dir.join(format!("{stem}.{ext}")), *mime))
        .find(|(p, _)| usable(p))
}

pub fn custom_file(dir: &Path, stem: &str) -> Option<PathBuf> {
    found(dir, stem).map(|(p, _)| p)
}

/// Stems that have a file of the user's own, in [`STEMS`] order sorted alphabetically.
/// A missing folder is an empty list.
pub fn list(dir: &Path) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = STEMS
        .iter()
        .copied()
        .filter(|s| custom_file(dir, s).is_some())
        .collect();
    out.sort_unstable();
    out
}

/// `{name, mime, data}` with the file bytes as standard base64.
pub fn read(dir: &Path, stem: &str) -> Result<Value, std::io::Error> {
    let (path, mime) = found(dir, stem)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no custom sound"))?;
    let bytes = std::fs::read(path)?;
    Ok(json!({"name": stem, "mime": mime, "data": STANDARD.encode(bytes)}))
}

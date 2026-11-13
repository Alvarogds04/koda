//! #315 — user-local XDG autostart entry for the island (F095/T02).
//!
//! Launch Abito automatically at session login by installing or removing
//! `autostart/koda.desktop` under `$XDG_CONFIG_HOME` (default
//! `$HOME/.config`). The toggle's persistent state IS the file's presence:
//! the same mechanism Coucou's T02 uses, no parallel preference store to
//! desync. The entry is the closed template below; enabling again is
//! idempotent, a corrupt or foreign file is replaced honestly.
//!
//! Pure template + path resolution live here for every platform; the file
//! effects are Unix-only (XDG autostart). Non-Unix builds get honest stubs
//! that fail with [`AutostartError::Unsupported`] instead of pretending.

use std::path::{Path, PathBuf};

/// Fixed name of the autostart entry (one app, one entry, no surprises).
pub const ENTRY_FILE_NAME: &str = "koda.desktop";

/// Why an autostart change can fail. `Unsupported` is the honest non-Unix
/// answer; `Io` carries the OS reason verbatim.
#[derive(Debug)]
pub enum AutostartError {
    // Constructed only by the non-Unix stub (honest "not supported" answer);
    // on Unix builds the match arm exists for the same contract.
    #[cfg_attr(unix, allow(dead_code))]
    Unsupported,
    /// The binary path cannot cross a .desktop value (relative, control chars).
    InvalidPath,
    /// The filesystem refused the change.
    Io(std::io::Error),
}

impl std::fmt::Display for AutostartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AutostartError::Unsupported => write!(f, "autostart is not supported on this platform"),
            AutostartError::InvalidPath => write!(f, "invalid executable path for the autostart entry"),
            AutostartError::Io(e) => write!(f, "autostart write failed: {e}"),
        }
    }
}

#[cfg(test)]
#[path = "autostart_tests.rs"]
mod tests;

// --- pure template -----------------------------------------------------------

/// The closed autostart template for `exe`. The Icon is the packaging-staged
/// `koda.png` beside the binary, mirroring `packaging/lib.cjs` desktopText
/// (`Icon` is a plain string value, unquoted — only `Exec` is a quoted
/// argument list). Returns `None` for a path that can never be quoted
/// honestly (relative, empty, or carrying control characters).
pub fn desktop_entry(exe: &Path) -> Option<String> {
    let exec = quote_exec(exe)?;
    let icon = exe.parent()?.join("koda.png");
    let icon = plain_value(&icon)?;
    Some(format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Koda\n\
         Comment=Koda\n\
         Exec={exec} --autostart\n\
         Icon={icon}\n\
         Terminal=false\n\
         Categories=Utility;\n\
         StartupWMClass=Koda\n\
         X-GNOME-Autostart-enabled=true\n"
    ))
}

/// Plain .desktop string value: absolute, no control characters, unquoted
/// (the `Icon` value is not an argument list; quoting would corrupt it).
fn plain_value(path: &Path) -> Option<String> {
    let text = path.to_str()?;
    if text.is_empty() || !Path::new(text).is_absolute() || text.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(text.to_string())
}

/// Desktop Entry Spec `Exec` quoting: the whole path as ONE argument inside
/// double quotes, escaping the four characters the spec reserves inside
/// quotes (backslash, double quote, dollar, backtick). Refuses relative
/// paths and any control character — they cannot cross a .desktop value.
fn quote_exec(path: &Path) -> Option<String> {
    let text = path.to_str()?;
    if text.is_empty() || !Path::new(text).is_absolute() {
        return None;
    }
    if text.chars().any(|c| c.is_control()) {
        return None;
    }
    let escaped: String = text
        .chars()
        .flat_map(|c| match c {
            '\\' | '"' | '$' | '`' => vec!['\\', c],
            c => vec![c],
        })
        .collect();
    Some(format!("\"{escaped}\""))
}

// --- path resolution ---------------------------------------------------------

/// The XDG autostart directory: `$XDG_CONFIG_HOME/autostart`, falling back to
/// `$HOME/.config/autostart` when XDG is unset or empty (spec fallback).
/// Both must be absolute; anything else is `None` (no honest path, no toggle).
pub fn autostart_dir(xdg_config_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    // XDG Base Directory spec: a relative XDG_CONFIG_HOME is invalid and must be ignored (falling back to $HOME/.config).
    let root = match xdg_config_home.filter(|v| !v.is_empty() && v.starts_with('/')) {
        Some(xdg) => PathBuf::from(xdg),
        None => PathBuf::from(home.filter(|h| !h.is_empty() && h.starts_with('/'))?)
            .join(".config"),
    };
    Some(root.join("autostart"))
}

/// Full path of our entry under the resolved autostart directory.
pub fn entry_path(xdg_config_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    autostart_dir(xdg_config_home, home).map(|dir| dir.join(ENTRY_FILE_NAME))
}

/// The toggle reads the FILE SYSTEM, never a cached preference: the entry's
/// presence IS the enabled state (Coucou T02 semantics, no desync).
pub fn is_enabled_at(path: &Path) -> bool {
    path.is_file()
}

// --- the Koda 0.1 entry (K2-04 T6) -------------------------------------------

/// The file the Koda 0.1 wrote in the XDG autostart directory.
pub const LEGACY_ENTRY_FILE_NAME: &str = "abito-island.desktop";

/// What [`retire_legacy_entry`] did. Nothing here carries a path or any file content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyOutcome {
    /// There was no 0.1 entry (or no autostart directory).
    NotThere,
    /// The 0.1 entry was ours and is gone.
    Removed,
    /// Something is at the name but it is not the file the 0.1 wrote (edited by the user, a link, a directory): untouched.
    Kept,
    /// It was ours but could not be removed; the next start retries.
    Failed,
}

impl LegacyOutcome {
    /// A log line without any path or file content; `None` when nothing happened.
    pub fn log_line(self) -> Option<String> {
        match self {
            LegacyOutcome::Removed => Some("legacy autostart entry removed".into()),
            LegacyOutcome::Failed => Some("legacy autostart entry could not be removed; will retry on the next start".into()),
            LegacyOutcome::NotThere | LegacyOutcome::Kept => None,
        }
    }
}

/// The Koda 0.1 wrote this file with `desktop_entry`: ONE exact shape per binary path. Rebuild that shape from the binary path
/// found in the file's own `Exec` line and require the whole text to match it BYTE FOR BYTE. Anything that is not exactly what the
/// 0.1 wrote is the user's (a comment, a blank line, a changed Name or Icon, autostart switched off, an env prefix, another
/// program, a duplicated or extra key, CRLF endings, a missing trailing newline) and stays.
fn is_legacy_template(text: &str) -> bool {
    let Some(exec) = text.lines().find_map(|line| line.strip_prefix("Exec=")) else { return false };
    let Some(quoted) = exec.strip_suffix(" --autostart") else { return false };
    let Some(inner) = quoted.strip_prefix('"').and_then(|rest| rest.strip_suffix('"')) else { return false };
    // undo the 0.1's quoting: a backslash escapes exactly one of \ " $ `
    let mut path = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some(escaped @ ('\\' | '"' | '$' | '`')) => path.push(escaped),
                _ => return false,
            },
            '"' | '$' | '`' => return false, // the 0.1 always escaped these
            c => path.push(c),
        }
    }
    let exe = Path::new(&path);
    if !exe.is_absolute() || exe.file_name().and_then(|n| n.to_str()) != Some("abito-island") { return false; }
    let Some(dir) = exe.parent() else { return false };
    let Some(expected) = legacy_entry_text(exe, dir) else { return false };
    text == expected
}

/// The 0.1's closed template, byte for byte, for `exe` (the 0.1 binary `.../abito-island`) with its icon beside it.
fn legacy_entry_text(exe: &Path, dir: &Path) -> Option<String> {
    let exec = quote_exec(exe)?;
    let icon = plain_value(&dir.join("abito-island.png"))?;
    Some(format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Koda\n\
         Comment=Koda\n\
         Exec={exec} --autostart\n\
         Icon={icon}\n\
         Terminal=false\n\
         Categories=Utility;\n\
         StartupWMClass=Abito-island\n\
         X-GNOME-Autostart-enabled=true\n"
    ))
}

/// Removes the Koda 0.1 autostart entry from `autostart_dir` and nothing else: that ONE exact file name, only when it is a
/// regular file (never a link or a directory, never followed), small, and the closed template the 0.1 wrote. It does not turn
/// the 0.2 autostart on in its place (the human decided nothing from 0.1 is migrated; preferences start from zero).
#[cfg(unix)]
pub fn retire_legacy_entry(autostart_dir: &Path) -> LegacyOutcome {
    const MAX_ENTRY: u64 = 4096;
    let path = autostart_dir.join(LEGACY_ENTRY_FILE_NAME);
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return LegacyOutcome::NotThere,
        Err(_) => return LegacyOutcome::Failed,
    };
    if !meta.file_type().is_file() || meta.len() > MAX_ENTRY { return LegacyOutcome::Kept; }
    let Ok(text) = std::fs::read_to_string(&path) else { return LegacyOutcome::Kept };
    if !is_legacy_template(&text) { return LegacyOutcome::Kept; }
    match std::fs::remove_file(&path) {
        Ok(()) => LegacyOutcome::Removed,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => LegacyOutcome::NotThere,
        Err(_) => LegacyOutcome::Failed,
    }
}

#[cfg(not(unix))]
pub fn retire_legacy_entry(_autostart_dir: &Path) -> LegacyOutcome {
    LegacyOutcome::NotThere
}

// --- enable / disable (platform seam) ----------------------------------------

/// Install (`enabled = true`) or remove (`enabled = false`) the entry.
/// Enabling creates the autostart directory when missing, writes the closed
/// template through a sibling temp file + rename (a reader never sees a half
/// entry) with mode 0644, and is idempotent. Disabling removes the file and
/// succeeds when it is already absent. Unsupported on non-Unix builds.
pub fn set_enabled_at(path: &Path, enabled: bool, exe: &Path) -> Result<(), AutostartError> {
    set_enabled_impl(path, enabled, exe)
}

#[cfg(unix)]
fn set_enabled_impl(path: &Path, enabled: bool, exe: &Path) -> Result<(), AutostartError> {
    if !enabled {
        // already absent is fine: the toggle reflects reality, not history
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AutostartError::Io(e)),
        }
    } else {
        let text = desktop_entry(exe).ok_or(AutostartError::InvalidPath)?;
        let dir = path.parent().ok_or(AutostartError::InvalidPath)?;
        std::fs::create_dir_all(dir).map_err(AutostartError::Io)?;
        // sibling temp file: same filesystem, so the rename is atomic
        let tmp = dir.join(format!(
            ".{}.tmp-{}",
            ENTRY_FILE_NAME,
            std::process::id()
        ));
        let write = || -> Result<(), AutostartError> {
            {
                use std::io::Write;
                let mut f = std::fs::File::create(&tmp).map_err(AutostartError::Io)?;
                f.write_all(text.as_bytes()).map_err(AutostartError::Io)?;
                f.sync_all().map_err(AutostartError::Io)?;
            }
            // 0644, matching the packaging-installed .desktop
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644))
                .map_err(AutostartError::Io)?;
            std::fs::rename(&tmp, path).map_err(AutostartError::Io)
        };
        match write() {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = std::fs::remove_file(&tmp); // never leave the sibling behind
                Err(e)
            }
        }
    }
}

#[cfg(not(unix))]
#[allow(unused_variables)]
fn set_enabled_impl(path: &Path, enabled: bool, exe: &Path) -> Result<(), AutostartError> {
    // Honest stub: no XDG autostart off Unix. The UI stays reachable and the
    // failure says so instead of pretending the entry was written.
    Err(AutostartError::Unsupported)
}

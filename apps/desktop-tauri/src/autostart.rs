//! #315 — user-local XDG autostart entry for the island (F095/T02).
//!
//! Launch Abito automatically at session login by installing or removing
//! `autostart/abito-island.desktop` under `$XDG_CONFIG_HOME` (default
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
pub const ENTRY_FILE_NAME: &str = "abito-island.desktop";

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
/// `abito-island.png` beside the binary, mirroring `packaging/lib.cjs`
/// desktopText (`Icon` is a plain string value, unquoted — only `Exec` is a
/// quoted argument list). Returns `None` for a path that can never be quoted
/// honestly (relative, empty, or carrying control characters).
pub fn desktop_entry(exe: &Path) -> Option<String> {
    let exec = quote_exec(exe)?;
    let icon = exe.parent()?.join("abito-island.png");
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
         StartupWMClass=Abito-island\n\
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
    let root = match xdg_config_home.filter(|v| !v.is_empty()) {
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

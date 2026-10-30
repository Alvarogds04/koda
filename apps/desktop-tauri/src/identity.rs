//! M4-PRE: where the app's identity comes from. A dev (debug) build derives
//! its project from the source checkout it was built in (the legacy dev
//! layout); a release/packaged binary carries NO build-tree path at all and
//! takes the project root from an explicit, validated setting. macOS/Windows
//! GUI launches without that setting use the user's home; Linux stays explicit.
use std::path::PathBuf;

/// Installed identity (tauri.conf.json `identifier`), never the Preview's.
pub const APP_IDENTIFIER: &str = "com.abitog.AbitoTauri";
/// Env var the launcher/config sets for an installed app (absolute path).
pub const PROJECT_ROOT_ENV: &str = "ABITO_PROJECT_ROOT";

/// Build-tree path baked by cargo — debug builds only.
#[cfg(debug_assertions)]
pub fn dev_manifest_dir() -> Option<&'static str> {
    option_env!("CARGO_MANIFEST_DIR")
}
#[cfg(not(debug_assertions))]
pub fn dev_manifest_dir() -> Option<&'static str> {
    None
}

// Validate lexically before canonicalization: Windows components() normalizes
// away interior `.` segments, and rooted/drive-relative paths are not absolute.
#[cfg(any(windows, test))]
fn windows_absolute_normalized(text: &str) -> bool {
    let normalized = text.replace('/', "\\");
    let bytes = normalized.as_bytes();
    let tail = if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':' && bytes[2] == b'\\' {
        if bytes.len() == 3 { return true; }
        &normalized[3..]
    } else if let Some(unc) = normalized.strip_prefix("\\\\") {
        if unc.split('\\').count() < 2 { return false; }
        unc
    } else {
        return false;
    };
    tail.split('\\').all(|segment| {
        !segment.is_empty() && segment != "." && segment != ".."
            && !segment.ends_with(['.', ' '])
            && !segment.chars().any(|ch| ch.is_control() || "<>:\"|?*".contains(ch))
    })
}

#[cfg(windows)]
fn absolute_normalized(text: &str) -> bool {
    windows_absolute_normalized(text)
}

#[cfg(test)]
mod windows_path_tests {
    #[test]
    fn explicit_windows_root_is_absolute_and_normalized() {
        for accepted in [r"C:\Users\x\proj", r"C:\", "C:/Users/x/proj", r"\\server\share\proj"] {
            assert!(super::windows_absolute_normalized(accepted), "{accepted}");
        }
        for rejected in ["", "relative", r"C:relative", r"\rooted", "/unix", r"C:\a\..\b", r"C:\a\.\b", r"C:\a\\b", r"C:\a\", r"C:\a ", r"C:\a.", r"C:\a:stream", r"\\?\C:\a", r"\\.\pipe\a", r"\\server", r"\\server\share\..\a"] {
            assert!(!super::windows_absolute_normalized(rejected), "{rejected}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn installed_explicit_root_resolves_existing_windows_directory() {
        let root = std::env::temp_dir();
        let explicit = root.to_str().expect("temporary path is Unicode").trim_end_matches(['\\', '/']);
        assert_eq!(super::project_root_for(None, Some(explicit)), std::fs::canonicalize(&root).ok());
        for rejected in ["", "relative", r"C:\a\..\b"] {
            assert_eq!(super::project_root_for(None, Some(rejected)), None);
        }
    }
}

#[cfg(not(windows))]
fn absolute_normalized(text: &str) -> bool {
    text.starts_with('/')
        && text
            .split('/')
            .skip(1)
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// Pure choice of the canonical project root.
/// - `manifest = Some(dir)` (dev): `<dir>/../..`, the worktree root.
/// - `manifest = None` (installed): `env_root` must be absolute and
///   normalized; anything else yields `None`.
pub fn project_root_for(manifest: Option<&str>, env_root: Option<&str>) -> Option<PathBuf> {
    match manifest {
        Some(dir) => {
            let apps = std::fs::canonicalize(dir).ok()?;
            Some(apps.parent()?.parent()?.to_path_buf())
        }
        None => {
            let text = env_root.filter(|t| absolute_normalized(t))?;
            std::fs::canonicalize(text).ok().filter(|p| p.is_dir())
        }
    }
}

/// GUI installs have no launcher-provided project. Fall back only when the
/// setting is absent, never when an explicit setting is invalid. Dev and Linux
/// retain their previous root selection. This root gates notices, not access.
pub fn project_root_with_home(manifest: Option<&str>, env_root: Option<&str>, _home: Option<&str>) -> Option<PathBuf> {
    #[cfg(not(target_os = "linux"))]
    if manifest.is_none() && env_root.is_none() {
        let home = std::path::Path::new(_home?);
        if !home.is_absolute() { return None }
        return std::fs::canonicalize(home).ok().filter(|p| p.is_dir());
    }
    project_root_for(manifest, env_root)
}

/// Project id of this process (sha256 of the canonical root), or `None`.
pub fn project_id_of_this_process() -> Option<String> {
    let env_root = match std::env::var(PROJECT_ROOT_ENV) {
        Ok(root) => Some(root),
        Err(std::env::VarError::NotPresent) => None,
        // A present but invalid setting must not activate the home fallback.
        Err(std::env::VarError::NotUnicode(_)) => Some(String::new()),
    };
    #[cfg(target_os = "windows")]
    let home = std::env::var("USERPROFILE").ok();
    #[cfg(not(target_os = "windows"))]
    let home = std::env::var("HOME").ok();
    let root = project_root_with_home(dev_manifest_dir(), env_root.as_deref(), home.as_deref())?;
    Some(crate::protocol::project_id(root.to_str()?))
}

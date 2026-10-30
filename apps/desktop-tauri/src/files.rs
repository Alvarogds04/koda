//! Small, closed helpers shared by the integrations and GitHub hosts: the n8n base URL
//! check (https, or http on loopback, no credentials) and an absolute-PATH executable
//! lookup. The former "open in apps" command (#467 T11) was removed in #498: no page
//! ever invoked it.
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

#[cfg(test)]
#[path = "files_tests.rs"]
mod tests;

/// The n8n URL, only when it is safe to open: https, or http on a loopback host;
/// never credentials, whitespace or control characters.
pub fn n8n_url(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > 2000 || raw.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let url = tauri::Url::parse(raw).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    match url.scheme() {
        "https" => url.host_str().is_some().then(|| url.to_string()),
        "http" => matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")).then(|| url.to_string()),
        _ => None,
    }
}

/// `name` on `path_var`: absolute directories only, a regular file with an executable bit.
/// `name` must be a bare file name.
pub fn find_on_path_in(name: &str, path_var: &OsStr) -> Option<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\', '\0']) || name == "." || name == ".." {
        return None;
    }
    std::env::split_paths(path_var)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

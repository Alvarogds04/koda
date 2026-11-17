//! Starts the capture endpoint once per launch and hands its address to the daemon (T1).
//!
//! The endpoint and its bearer token live in memory here and, through the environment of the
//! daemon child, in the daemon's private 0600 `mcp.json` projection. They are never logged.
use super::mcp::{self, Desktop, Dialogs, Helper};
use super::server;
use std::sync::{Arc, OnceLock};

/// The two variables the daemon reads (`apps/desktop-daemon/src/config.cjs`).
pub const ENV_URL: &str = "KODA_WINDOW_MCP_URL";
pub const ENV_TOKEN: &str = "KODA_WINDOW_MCP_TOKEN";

static ENDPOINT: OnceLock<(String, String)> = OnceLock::new();

/// Starts the loopback server (once). `enabled` is the user's on/off option, read at every call.
/// A failure to bind leaves the daemon without the tool: nothing is captured.
pub fn start(
    desktop: Arc<dyn Desktop>,
    dialogs: Arc<dyn Dialogs>,
    enabled: Arc<dyn Fn() -> bool + Send + Sync>,
) -> bool {
    if ENDPOINT.get().is_some() {
        return true;
    }
    // Before anything can ask for a window: the backend takes its registrations (Linux: the one
    // connection to Koda's GNOME extension) once, here, not lazily on the first pick.
    desktop.start();
    let token = mcp::new_token();
    let now = Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0));
    let helper = Arc::new(Helper::new(desktop, dialogs, now, enabled, token.clone()));
    match server::start(helper) {
        Ok(endpoint) => ENDPOINT.set((endpoint.url, token)).is_ok(),
        Err(_) => false,
    }
}

/// What the daemon child gets in its environment; empty until `start` succeeded.
pub fn daemon_env() -> Vec<(&'static str, String)> {
    match ENDPOINT.get() {
        Some((url, token)) => vec![(ENV_URL, url.clone()), (ENV_TOKEN, token.clone())],
        None => Vec::new(),
    }
}


/// The consent dialog of this OS, asked from a worker thread (S6). Native on macOS and Windows
/// (`alert`), GTK on Linux (`consent_gtk`). Anything but an explicit Allow refuses.
pub struct AppDialogs(pub tauri::AppHandle);

impl Dialogs for AppDialogs {
    fn ask_grant(&self) -> bool {
        #[cfg(any(target_os = "macos", windows))]
        { super::alert::ask_grant(&self.0) }
        #[cfg(target_os = "linux")]
        { super::consent_gtk::ask_grant(&self.0) }
        #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
        { false }
    }
}

/// The capture backend of this OS.
pub fn system_desktop() -> Arc<dyn Desktop> {
    #[cfg(target_os = "linux")]
    { Arc::new(super::linux::LinuxDesktop::new()) }
    #[cfg(target_os = "macos")]
    { Arc::new(super::macos::MacDesktop::new()) }
    #[cfg(windows)]
    { Arc::new(super::win::WinDesktop) }
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;

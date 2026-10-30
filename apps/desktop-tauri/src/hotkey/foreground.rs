//! Keyboard focus hand-back for Windows and macOS (HU-049, parity with `x11::give_focus_back`).
//!
//! The human is typing somewhere else and presses the global shortcut: Abito remembers who had
//! the keyboard, shows the island and, if the OS gave the island the keyboard anyway, hands it
//! straight back. The decision is pure and shared; only `current`/`give_back` touch the OS.
//! Linux keeps its own X11 path (`x11.rs`); here Linux has no reader and answers `None`.

#[cfg(test)]
#[path = "foreground_tests.rs"]
mod tests;

/// An opaque OS handle: the HWND on Windows, the process id on macOS.
pub type Token = u64;

/// What to remember: a real window that is not ours.
pub fn remember(own_pid: u32, owner_pid: u32, token: Token) -> Option<Token> {
    if token == 0 || owner_pid == own_pid { None } else { Some(token) }
}

/// Who gets the keyboard back after a show. Same rule as the Linux path
/// (`hotkey::focus_after_show`): only when the island took focus and nobody asked for that.
pub fn hand_back(island_focused: bool, deliberate: bool, previous: Option<Token>) -> Option<Token> {
    match super::focus_after_show(island_focused, deliberate) {
        super::FocusAction::GiveBack => previous,
        super::FocusAction::Leave => None,
    }
}

#[cfg(windows)]
pub fn current() -> Option<Token> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    // SAFETY: plain reads; a null handle or a failed pid lookup is answered with None.
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() { return None; }
        let mut pid = 0u32;
        if GetWindowThreadProcessId(hwnd, &mut pid) == 0 { return None; }
        remember(std::process::id(), pid, hwnd as usize as Token)
    }
}

/// Best effort, never panics: the window may be gone or minimized, or Windows may refuse the switch.
#[cfg(windows)]
pub fn give_back(token: Token) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindow, SetForegroundWindow};
    let hwnd = token as usize as windows_sys::Win32::Foundation::HWND;
    // SAFETY: IsWindow validates a stale handle first; every call tolerates failure.
    unsafe {
        // A minimized target is left alone: the human minimized it on purpose.
        if IsWindow(hwnd) == 0 || IsIconic(hwnd) != 0 { return false; }
        SetForegroundWindow(hwnd) != 0
    }
}

#[cfg(target_os = "macos")]
pub fn current() -> Option<Token> {
    use objc2_app_kit::NSWorkspace;
    let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
    let pid = app.processIdentifier();
    if pid <= 0 { return None; }
    remember(std::process::id(), pid as u32, pid as Token)
}

/// AppKit objects belong to the main thread: callers on another thread must marshal this call
/// there (the hotkey host uses `run_on_main_thread`).
#[cfg(target_os = "macos")]
#[allow(deprecated)]
pub fn give_back(token: Token) -> bool {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    let Ok(pid) = i32::try_from(token) else { return false };
    match NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
        Some(app) => app.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps),
        None => false,
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn current() -> Option<Token> { None }

#[cfg(not(any(windows, target_os = "macos")))]
pub fn give_back(_token: Token) -> bool { false }

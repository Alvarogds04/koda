//! Seam: read-only native geometry evidence (decision D4).
//!
//! On Linux the audit samples the GTK widget tree, the GTK/X11 window hints and
//! the X work area to explain why a resize settled where it did
//! (`ABITO_NATIVE_AUDIT=1`, opt-in, no resize authority). Its evidence is a
//! *GTK-and-X11* view of the window: Windows has neither the widget tree nor
//! `_NET_WM_STATE_ABOVE`, and the Win32 equivalents (DWM attributes,
//! UI Automation) are the observation surface this unit is explicitly NOT
//! allowed to build. So on Windows this capability is reported unavailable once
//! at startup and every sample is a no-op.

use super::Availability;

/// Why the audit is or is not served by this binary. main.rs logs this once.
#[cfg(target_os = "linux")]
pub(crate) fn availability() -> Availability {
    Availability::Provided
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn availability() -> Availability {
    Availability::Unavailable(
        "native audit reads the GTK widget tree and X11 window hints; Windows offers neither, and its UI Automation equivalent is out of scope for this port",
    )
}

/// Opt-in switch. On Windows there is nothing to opt into, so it never enables.
#[cfg(target_os = "linux")]
pub(crate) fn enabled() -> bool {
    crate::nativeaudit::enabled()
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn enabled() -> bool {
    false
}

/// Enqueue native getters on the main thread. Callers never wait and never
/// carry host guards into the closure.
#[cfg(target_os = "linux")]
pub(crate) fn sample(
    app: &tauri::AppHandle,
    stage: &'static str,
    attempt: u32,
    desired: Option<(i32, i32)>,
) {
    crate::nativeaudit::sample(app, stage, attempt, desired);
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn sample(
    _app: &tauri::AppHandle,
    _stage: &'static str,
    _attempt: u32,
    _desired: Option<(i32, i32)>,
) {
    // Unavailable by decision D4: no fake evidence row is emitted, because a
    // row full of nulls would read like a native tree that happens to be empty.
}

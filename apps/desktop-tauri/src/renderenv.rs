//! WebKit rendering switches the island sets for itself, before GTK/WebKit initialise.
//!
//! Measured (#310, `probe::native_resize_flash_scene` + `tools/flash-analyze.py`, 3 runs each on a private
//! Xvfb): every time the native window SHRINKS (column → overview, overview → dot) the X window holds 2 fully
//! blank frames (~33 ms) between the last frame of the old content and the first of the new one — the flash the
//! human sees on a view change. With `WEBKIT_DISABLE_DMABUF_RENDERER=1` those frames were 0 in 3 of 3 runs
//! (baseline: 4–5 in 3 of 3). Disabling compositing entirely also removed them but unsyncs `requestAnimationFrame`
//! from the display (2 ms steps instead of 16 ms), so it is NOT used. Animation duration is clock-driven and was
//! the same in every variant (≈250 ms expand, ≈320 ms collapse).
//!
//! LIMIT: measured on Xvfb (no compositor). On a real GPU/Wayland session this is the same family of fix, not a
//! proof; the human's eyes are the final judge.

#[cfg(test)]
#[path = "renderenv_tests.rs"]
mod tests;

/// The only switches this module may ever set.
pub const ALLOWED_SWITCHES: [&str; 1] = ["WEBKIT_DISABLE_DMABUF_RENDERER"];

/// What to set, given a way to read the current environment. A value already present (even empty) is the
/// caller's explicit choice and is never overridden.
pub fn webkit_env_to_set(get: &dyn Fn(&str) -> Option<String>) -> Vec<(&'static str, &'static str)> {
    ALLOWED_SWITCHES
        .iter()
        .filter(|name| get(name).is_none())
        .map(|name| (*name, "1"))
        .collect()
}

/// Apply it to the real process environment. Must run before GTK/WebKit initialise, on the main thread, before
/// any other thread exists.
pub fn apply() {
    for (name, value) in webkit_env_to_set(&|k| std::env::var(k).ok()) {
        std::env::set_var(name, value);
    }
}

//! The order of the Linux backends (S8). The backends themselves are exercised against a private
//! bus and a private X server in tests/windowcapture_gnome.rs.
use super::*;

#[test]
fn a_wayland_session_never_counts_as_x11_even_though_xwayland_sets_display() {
    assert!(!x11_session(Some("wayland"), Some("wayland-0"), Some(":0")), "under Wayland DISPLAY is only XWayland");
    assert!(!x11_session(Some("wayland"), None, Some(":0")));
    assert!(x11_session(Some("x11"), None, Some(":0")), "a real X11 session");
    assert!(!x11_session(Some("x11"), None, None), "an X11 session with no display cannot capture");
    // No session type at all: a Wayland compositor in the environment or the lack of an X server decides.
    assert!(x11_session(None, None, Some(":0")));
    assert!(!x11_session(None, Some("wayland-0"), Some(":0")));
    assert!(!x11_session(None, None, None));
}

#[test]
fn with_neither_the_extension_nor_x11_the_human_picks_the_window() {
    // A dead bus (the extension is absent) on a Wayland session with no X11 display: the only way
    // to know which window the human means is the system picker, so the target is left open.
    let desktop = LinuxDesktop::fixed(Some("unix:path=/nonexistent/koda-bus"), None, None, Some("wayland"));
    let target = desktop.pick_target().expect("the picker is the target when nothing else can pick");
    assert_eq!(target, Target { app_id: String::new(), app: String::new(), title: String::new(), handle: 0 });
    assert_eq!(desktop.source(&target), Source::Portal);
    // On an X11 session with a display that has no window, the answer is that there is no window,
    // not a system picker the human never asked for.
    let broken = LinuxDesktop::fixed(Some("unix:path=/nonexistent/koda-bus"), Some(":98"), None, Some("x11"));
    assert_eq!(broken.pick_target(), Err(CaptureError::NoWindow));
}

#[test]
fn a_system_picker_capture_needs_no_private_directory() {
    // The portal writes its own file, so a session without XDG_RUNTIME_DIR can still answer.
    let desktop = LinuxDesktop::fixed(Some("unix:path=/nonexistent/koda-bus"), None, Some(""), Some("wayland"));
    let target = desktop.pick_target().unwrap();
    // Nothing to capture behind a dead bus: this must be an error, never a panic or a hang.
    assert!(desktop.capture(&target).is_err());
}

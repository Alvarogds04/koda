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
fn without_the_extension_or_x11_a_wayland_session_refuses_instead_of_picking_for_the_human() {
    // A dead bus (the extension is absent) on a Wayland session with no X11 display. The system picker
    // would answer a PICTURE with no app identity, so nothing could be vetted against the refusal list:
    // Koda refuses and says what is missing (the extension, or an X11 session).
    let desktop = LinuxDesktop::fixed(Some("unix:path=/nonexistent/koda-bus"), None, None, Some("wayland"));
    let error = desktop.pick_target().expect_err("an unidentified window is never captured");
    assert!(matches!(&error, CaptureError::Unsupported(why) if why.contains("cannot tell which app a window belongs to")), "{error:?}");
    assert!(matches!(&error, CaptureError::Unsupported(why) if why.contains("GNOME extension")), "{error:?}");
    // On an X11 session with a display that has no window, the answer is that there is no window,
    // not a system picker the human never asked for.
    let broken = LinuxDesktop::fixed(Some("unix:path=/nonexistent/koda-bus"), Some(":98"), None, Some("x11"));
    assert_eq!(broken.pick_target(), Err(CaptureError::NoWindow));
}

#[test]
fn a_window_no_backend_can_identify_is_never_captured() {
    // The portal is no longer a capture path: a session with neither the extension nor X11 has no way
    // to name a window, so a capture is refused with the same message instead of asking the system
    // picker for a picture nobody can vet.
    let desktop = LinuxDesktop::fixed(Some("unix:path=/nonexistent/koda-bus"), None, Some(""), Some("wayland"));
    let anonymous = Target { app_id: String::new(), app: String::new(), title: String::new(), handle: 0 };
    assert!(desktop.source(&anonymous).is_err(), "no backend owns such a target");
    let error = desktop.capture(&anonymous).expect_err("there is nothing to capture through");
    assert!(matches!(&error, CaptureError::Unsupported(why) if why.contains("cannot tell which app a window belongs to")), "{error:?}");
}

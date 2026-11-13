//! S1/S5/S7 on macOS: which window is chosen and how a capture's pixels are read. The capture
//! itself needs a Screen Recording grant a test runner does not have (and asking for it would show
//! the system prompt), so it is exercised by the macOS CI job and the human test; everything that
//! decides is pure and is checked here.
use super::*;

fn window(id: u32, pid: i32, app: &str, bundle_id: &str) -> MacWindow {
    MacWindow { id, pid, app: app.to_string(), bundle_id: bundle_id.to_string(), title: "a window".into() }
}

#[test]
fn the_topmost_window_that_is_not_kodas_is_chosen() {
    let own = 400;
    let rows = [
        window(11, own, "Koda", "com.abitog.AbitoTauri"),
        window(12, 900, "Bitwarden", "com.bitwarden.desktop"),
        window(13, 901, "Code", "com.microsoft.VSCode"),
    ];
    let target = pick(own, &rows).unwrap();
    // Koda's own island is never the target, even when it is topmost.
    assert_eq!(target.handle, 12);
    assert_eq!(target.app, "Bitwarden");
    // S5 is decided on the bundle id on macOS, so the app id is the bundle id.
    assert_eq!(target.app_id, "com.bitwarden.desktop");
    assert_eq!(
        crate::windowcapture::blocklist::blocked_reason_on(
            crate::windowcapture::blocklist::Platform::MacOs,
            &target.app_id,
            &target.app
        ),
        Some("Bitwarden")
    );
}

#[test]
fn a_window_without_an_id_or_an_app_is_skipped() {
    let own = 400;
    let rows = [
        window(0, 900, "Code", "com.microsoft.VSCode"),
        window(21, 901, "   ", ""),
        window(22, 902, "Preview", ""),
    ];
    let target = pick(own, &rows).unwrap();
    assert_eq!(target.handle, 22);
    // No bundle id (a process that is not an app): the app name carries the identity.
    assert_eq!(target.app_id, "Preview");
    assert_eq!(pick(own, &rows[..2]), Err(CaptureError::NoWindow));
    assert_eq!(pick(own, &[]), Err(CaptureError::NoWindow));
}

#[test]
fn pixels_are_packed_by_dropping_the_row_padding() {
    // Two rows of two BGRA pixels, each row padded to 16 bytes instead of 8.
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
    bytes.extend_from_slice(&[0xaa; 8]);
    bytes.extend_from_slice(&[9, 10, 11, 12, 13, 14, 15, 16]);
    bytes.extend_from_slice(&[0xbb; 8]);
    let packed = compact(&bytes, 2, 2, 16).unwrap();
    assert_eq!(packed, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    // A capture with no padding is passed through unchanged.
    assert_eq!(compact(&packed, 2, 2, 8), Some(packed.clone()));
    // A truncated buffer, an empty image, and a stride narrower than a row are all refused.
    assert_eq!(compact(&packed[..8], 2, 2, 16), None);
    assert_eq!(compact(&packed, 2, 2, 7), None);
    assert_eq!(compact(&packed, 0, 2, 8), None);
    assert_eq!(compact(&packed, 2, 0, 8), None);
}

#[test]
fn an_old_macos_says_what_is_missing() {
    // S2: the message names the version, so the agent can tell the user what is missing.
    assert!(TOO_OLD.contains("macOS 14"));
    // A process that is not an app has no bundle id, and asking about one that is gone is not a panic.
    assert!(bundle_id_of(0).is_empty());
    assert!(bundle_id_of(i32::MAX).is_empty());
}

#[test]
fn a_handle_that_is_not_a_cgwindowid_is_refused_before_any_permission_prompt() {
    // A malformed tool call must never reach the OS, so it cannot trigger the system prompt either.
    assert!(matches!(capture_window(0), Err(CaptureError::Failed(_))));
    assert!(matches!(capture_window(u64::MAX), Err(CaptureError::Failed(_))));
}

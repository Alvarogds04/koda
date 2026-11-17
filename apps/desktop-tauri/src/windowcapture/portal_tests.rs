//! What the screenshot portal's answer means, and how its URI becomes a path (S8 fallback).
use super::*;
use crate::windowcapture::mcp::error_message;

#[test]
fn a_response_says_saved_cancelled_or_failed() {
    assert_eq!(response(0, Some("file:///tmp/koda-a.png")), Response::Saved(PathBuf::from("/tmp/koda-a.png")));
    assert_eq!(response(1, None), Response::Cancelled, "the human closed the picker");
    assert_eq!(response(1, Some("file:///tmp/koda-a.png")), Response::Cancelled);
    assert_eq!(response(2, Some("file:///tmp/koda-a.png")), Response::Failed, "any other portal error");
    assert_eq!(response(0, None), Response::Failed, "success with no image is not a capture");
    assert_eq!(response(0, Some("")), Response::Failed);
    assert_eq!(response(0, Some("https://example.com/a.png")), Response::Failed, "only a local file is read");
}

#[test]
fn a_file_uri_becomes_a_local_path() {
    assert_eq!(file_uri_to_path("file:///tmp/a.png"), Some(PathBuf::from("/tmp/a.png")));
    assert_eq!(file_uri_to_path("file:///home/a%20b/foto.png"), Some(PathBuf::from("/home/a b/foto.png")));
    assert_eq!(file_uri_to_path("file:///home/a%20b/caf%C3%A9.png"), Some(PathBuf::from("/home/a b/café.png")));
    assert_eq!(file_uri_to_path("file://localhost/tmp/a.png"), Some(PathBuf::from("/tmp/a.png")));
    // A remote host, a relative path and a non-file scheme are not the user's own window.
    assert_eq!(file_uri_to_path("file://elsewhere/tmp/a.png"), None);
    assert_eq!(file_uri_to_path("file://relative/a.png"), None);
    assert_eq!(file_uri_to_path("/tmp/a.png"), None);
    assert_eq!(file_uri_to_path(""), None);
}

#[test]
fn closing_the_picker_tells_the_human_what_happened() {
    let message = error_message(&CaptureError::Failed(CANCELLED.to_string()));
    assert!(message.contains("you did not pick a window"), "{message}");
    assert!(message.contains("window"), "{message}");
}

#[test]
fn only_a_file_the_portal_left_in_a_temporary_place_is_removed() {
    let root = std::env::temp_dir().join(format!("koda-portal-{}", std::process::id()));
    let deep = root.join("pictures");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&deep).unwrap();
    // The portal's own tmp dir (what `std::env::temp_dir()` is) is cleaned up…
    let temporary = std::env::temp_dir().join(format!("koda-portal-shot-{}.png", std::process::id()));
    std::fs::write(&temporary, b"x").unwrap();
    remove_if_temporary(&temporary);
    assert!(!temporary.exists(), "a temporary file does not survive the capture");
    // …a picture the human can keep is not.
    let kept = deep.join("shot.png");
    std::fs::write(&kept, b"x").unwrap();
    remove_if_temporary(&kept);
    assert!(kept.exists(), "a file the user may want is never deleted");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_literal_percent_or_a_broken_escape_is_left_alone() {
    // The portal escapes only what it must; a lone `%` or a short tail is not an escape.
    assert_eq!(file_uri_to_path("file:///tmp/100%25.png"), Some(PathBuf::from("/tmp/100%.png")));
    assert_eq!(file_uri_to_path("file:///tmp/50%.png"), Some(PathBuf::from("/tmp/50%.png")));
    assert_eq!(file_uri_to_path("file:///tmp/%zz.png"), Some(PathBuf::from("/tmp/%zz.png")));
    assert_eq!(file_uri_to_path("file:///tmp/tail%2"), Some(PathBuf::from("/tmp/tail%2")));
}

//! K2-05 U5b — tests of what is left of the upload support: the display-name
//! sanitiser, the attachment-id grammar the closed `chat_action` set parses, the
//! native drop set and the `chat_attach_data` raw-body split.
//!
//! The 0.1 storage tests (content allowlist, attach/read-back/resolve, the
//! workspace directory, the total-bytes cap and the stale-`tmp` sweep) left with
//! the code they covered: the island never stores a file any more (L11 2a).

use super::*;
use crate::chat::valid_attachment_id;

#[test]
fn sanitize_name_keeps_a_safe_display_name() {
    assert_eq!(sanitize_name("../etc/passwd"), "passwd");
    assert_eq!(sanitize_name("C:\\Users\\alguien\\foto.png"), "foto.png");
    assert_eq!(sanitize_name("documento final?.pdf"), "documento final_.pdf");
    assert_eq!(sanitize_name(".."), "archivo");
    assert_eq!(sanitize_name(""), "archivo");
    assert_eq!(sanitize_name("\u{7}campana\u{8}.txt"), "campana.txt");
    assert_eq!(sanitize_name(".oculto."), "oculto");
    let long = "a".repeat(90);
    assert_eq!(sanitize_name(&long).chars().count(), 80);
    assert_eq!(sanitize_name("café.png"), "café.png");
}

/// The id the closed `chat_action` verb set accepts for `submit`/`discard`
/// (`a-` + 16 lowercase hex): the page's own reference, nothing else.
#[test]
fn attachment_id_grammar() {
    assert!(valid_attachment_id("a-0123456789abcdef"));
    assert!(!valid_attachment_id("a-0123456789ABCDEF")); // uppercase refused
    assert!(!valid_attachment_id("a-0123"));
    assert!(!valid_attachment_id("b-0123456789abcdef"));
    assert!(!valid_attachment_id("a-0123456789abcdefg"));
}

#[test]
fn split_raw_body_takes_a_bounded_header_line() {
    let body = format!("{{\"name\":\"informe.txt\"}}\ncontenido",);
    let (name, rest) = split_raw_body(body.as_bytes()).unwrap();
    assert_eq!(name, "informe.txt");
    assert_eq!(rest, b"contenido");
    // Binary content after the header line passes through untouched.
    let mut binary = b"{\"name\":\"f.png\"}\n".to_vec();
    binary.extend_from_slice(&[0xFF, 0xD8, 0xFF, 0x00, 0x0A]);
    let (name, rest) = split_raw_body(&binary).unwrap();
    assert_eq!(name, "f.png");
    assert_eq!(rest, &[0xFF, 0xD8, 0xFF, 0x00, 0x0A]);
    // No header line, oversize header, bad JSON, missing name.
    assert!(split_raw_body(b"sin header").is_err());
    assert!(split_raw_body(&[b'x'; 2048]).is_err());
    assert!(split_raw_body(b"{oops}\nbytes").is_err());
    assert!(split_raw_body(b"{}\nbytes").is_err());
    assert!(split_raw_body(b"").is_err());
}

// --- the native drop gate (`chat_attach` accepts only what the OS reported) ---

#[test]
fn never_dropped_path_is_refused() {
    let mut set = DropSet::new();
    assert!(set.is_empty());
    assert!(!set.consume(Path::new("/tmp/k205-u5b-never.png"), 0));
}

#[test]
fn dropped_path_is_one_shot() {
    let path = PathBuf::from("/tmp/k205-u5b-once.png");
    let mut set = DropSet::new();
    set.record(vec![path.clone()], 1_000);
    assert_eq!(set.len(), 1);
    assert!(set.consume(&path, 2_000));
    assert!(set.is_empty(), "a drop is claimable exactly once");
    assert!(!set.consume(&path, 2_001));
}

#[test]
fn expired_drop_is_refused_and_the_set_is_bounded() {
    let path = PathBuf::from("/tmp/k205-u5b-expired.png");
    let mut set = DropSet::new();
    set.record(vec![path.clone()], 1_000);
    assert!(!set.consume(&path, 1_000 + DROP_TTL_MS + 1), "a stale drop is not claimable");
    // Exactly at the TTL the drop is still fresh, and it is still one-shot.
    let mut fresh = DropSet::new();
    fresh.record(vec![path.clone()], 1_000);
    assert!(fresh.consume(&path, 1_000 + DROP_TTL_MS));

    let many: Vec<PathBuf> = (0..40).map(|i| PathBuf::from(format!("/tmp/k205-u5b-f{i}.png"))).collect();
    let mut set = DropSet::new();
    set.record(many.clone(), 5_000);
    assert!(set.len() <= DROP_CAP, "the set never grows past its cap");
    // The oldest are the ones evicted; the newest stay claimable.
    assert!(!set.consume(&many[0], 5_001));
    assert!(set.consume(&many[39], 5_001));
    // Re-recording the same path does not duplicate it.
    set.record(vec![many[39].clone()], 5_002);
    assert!(set.consume(&many[39], 5_003));
    assert!(!set.consume(&many[39], 5_004));
}

use super::*;
use std::os::unix::fs::{symlink, OpenOptionsExt};
use std::path::{Path, PathBuf};

const T0: i64 = 1_791_158_400;

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("abito-spool-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn put(dir: &Path, text: &str, mode: u32) {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true).mode(mode);
    std::io::Write::write_all(&mut o.open(dir.join(FILE)).unwrap(), text.as_bytes()).unwrap();
}

#[test]
fn good_lines_are_taken_and_the_spool_is_gone() {
    let d = scratch("take");
    put(&d, "{\"v\":1,\"event\":\"prompt\"}\nnot json\n\n{\"v\":1,\"event\":\"stop\"}\n", 0o600);
    let got = take(&d);
    assert_eq!(got.len(), 2);
    assert_eq!(got[1]["event"], "stop");
    assert!(!d.join(FILE).exists());
    assert!(take(&d).is_empty());
    let leftovers: Vec<_> = std::fs::read_dir(&d).unwrap().collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn a_symlink_loose_mode_or_oversize_spool_is_discarded_unread() {
    let d = scratch("refuse");
    let victim = d.join("victim.txt");
    std::fs::write(&victim, "{\"v\":1,\"event\":\"prompt\"}\n").unwrap();
    symlink(&victim, d.join(FILE)).unwrap();
    assert!(take(&d).is_empty());
    assert!(victim.exists(), "the link target is never touched");
    assert!(std::fs::symlink_metadata(d.join(FILE)).is_err(), "the link itself is removed");
    put(&d, "{\"v\":1,\"event\":\"prompt\"}\n", 0o644);
    assert!(take(&d).is_empty());
    assert!(!d.join(FILE).exists());
    put(&d, &format!("{}\n", "x".repeat(MAX_BYTES as usize + 1)), 0o600);
    assert!(take(&d).is_empty());
    assert!(!d.join(FILE).exists());
}

#[test]
fn a_missing_folder_is_just_empty_and_lines_are_bounded() {
    assert!(take(&scratch("none").join("missing")).is_empty());
    let d = scratch("many");
    let line = "{\"v\":1,\"event\":\"prompt\"}\n";
    put(&d, &line.repeat(MAX_EVENTS + 50), 0o600);
    assert_eq!(take(&d).len(), MAX_EVENTS);
    let _ = T0;
}

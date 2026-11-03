// K2-03 T3 (S2, S4): legacy Recap cleanup. Temp dirs only; the user's real data dirs are never touched.
use super::*;
use std::path::PathBuf;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("koda-legacy-recap-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
}

#[test]
fn removes_exactly_the_recap_history_its_corrupt_copies_and_the_spool() {
    let data = scratch("data");
    let runtime = scratch("runtime");
    write(&data.join("recap.json"), b"{\"turns\":[]}");
    write(&data.join("recap.json.corrupt-20260101-000000"), b"bad");
    write(&data.join("recap.json.corrupt-20260202-121212"), b"bad");
    write(&runtime.join("recap-events.jsonl"), b"{}\n");

    let out = cleanup(Some(&data), Some(&runtime));

    assert_eq!(out, Outcome { removed: 4, failed: 0 });
    assert!(!data.join("recap.json").exists());
    assert!(!data.join("recap.json.corrupt-20260101-000000").exists());
    assert!(!data.join("recap.json.corrupt-20260202-121212").exists());
    assert!(!runtime.join("recap-events.jsonl").exists());
    assert_eq!(out.log_line().as_deref(), Some("legacy recap data removed (4 files)"));
    fs::remove_dir_all(&data).unwrap();
    fs::remove_dir_all(&runtime).unwrap();
}

#[test]
fn everything_else_stays_byte_identical() {
    let data = scratch("keep");
    let runtime = scratch("keep-rt");
    write(&data.join("recap.json"), b"{}");
    // look-alikes and neighbours that are NOT the approved paths
    write(&data.join("recap.json.bak"), b"user backup");
    write(&data.join("recap.jsonl"), b"other");
    write(&data.join("prefs.json"), b"{\"v\":1}");
    write(&data.join("Koda weekly recap.png"), b"\x89PNG");
    fs::create_dir(data.join("recap.json.corrupt-x")).unwrap();
    write(&data.join("recap.json.corrupt-x").join("inside"), b"kept");
    fs::create_dir(data.join("audit")).unwrap();
    write(&data.join("audit").join("recap.json"), b"nested, never recursive");
    write(&runtime.join("endpoint.json"), b"{}");
    write(&runtime.join("recap-events.jsonl.old"), b"x");

    let out = cleanup(Some(&data), Some(&runtime));

    assert_eq!(out, Outcome { removed: 1, failed: 0 });
    for (path, bytes) in [
        (data.join("recap.json.bak"), &b"user backup"[..]),
        (data.join("recap.jsonl"), b"other"),
        (data.join("prefs.json"), b"{\"v\":1}"),
        (data.join("Koda weekly recap.png"), b"\x89PNG"),
        (data.join("recap.json.corrupt-x").join("inside"), b"kept"),
        (data.join("audit").join("recap.json"), b"nested, never recursive"),
        (runtime.join("endpoint.json"), b"{}"),
        (runtime.join("recap-events.jsonl.old"), b"x"),
    ] {
        assert_eq!(fs::read(&path).unwrap(), bytes, "{}", path.display());
    }
    assert!(data.join("recap.json.corrupt-x").is_dir(), "a directory with the corrupt prefix is never removed");
    fs::remove_dir_all(&data).unwrap();
    fs::remove_dir_all(&runtime).unwrap();
}

#[cfg(unix)]
#[test]
fn a_symlink_named_like_a_target_is_left_and_its_target_untouched() {
    let data = scratch("link");
    let outside = scratch("link-outside");
    write(&outside.join("precious"), b"never deleted");
    std::os::unix::fs::symlink(outside.join("precious"), data.join("recap.json")).unwrap();
    std::os::unix::fs::symlink(outside.join("precious"), data.join("recap.json.corrupt-1")).unwrap();

    let out = cleanup(Some(&data), None);

    assert_eq!(out, Outcome { removed: 0, failed: 0 });
    assert!(fs::symlink_metadata(data.join("recap.json")).unwrap().file_type().is_symlink());
    assert_eq!(fs::read(outside.join("precious")).unwrap(), b"never deleted");
    fs::remove_dir_all(&data).unwrap();
    fs::remove_dir_all(&outside).unwrap();
}

// Windows twin of the symlink guard: a directory junction-free check that works without privileges. A directory named
// exactly `recap.json` is not a regular file, so it stays (the unix test above covers real symlinks).
#[test]
fn a_directory_named_recap_json_is_left() {
    let data = scratch("dir-named");
    fs::create_dir(data.join("recap.json")).unwrap();
    write(&data.join("recap.json").join("x"), b"kept");
    let out = cleanup(Some(&data), None);
    assert_eq!(out, Outcome { removed: 0, failed: 0 });
    assert_eq!(fs::read(data.join("recap.json").join("x")).unwrap(), b"kept");
    fs::remove_dir_all(&data).unwrap();
}

#[test]
fn nothing_there_is_success_and_silent_and_a_second_run_is_a_noop() {
    let data = scratch("empty");
    let missing = data.join("does-not-exist");
    assert_eq!(cleanup(Some(&missing), Some(&missing)), Outcome::default());
    assert_eq!(cleanup(None, None), Outcome::default());
    write(&data.join("recap.json"), b"{}");
    assert_eq!(cleanup(Some(&data), None).removed, 1);
    let again = cleanup(Some(&data), None);
    assert_eq!(again, Outcome::default(), "idempotent");
    assert_eq!(again.log_line(), None, "nothing to say, nothing logged");
    fs::remove_dir_all(&data).unwrap();
}

#[test]
fn the_log_line_is_content_free() {
    let line = Outcome { removed: 2, failed: 1 }.log_line().unwrap();
    assert_eq!(line, "legacy recap data cleanup incomplete (2 removed, 1 failed); retrying next start");
    assert!(!line.contains('/') && !line.contains('\\'), "no path in the log");
}

// The data dir itself comes from Tauri, not from the user: a symlinked data dir is followed on purpose (see module doc).
// Only the exact targets inside it go; everything else behind the link stays.
#[cfg(unix)]
#[test]
fn a_symlinked_data_dir_is_followed_and_only_the_exact_targets_inside_go() {
    let real = scratch("real-data");
    let parent = scratch("link-parent");
    let link = parent.join("com.abitog.AbitoTauri");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    write(&real.join("recap.json"), b"{}");
    write(&real.join("recap.json.corrupt-1"), b"bad");
    write(&real.join("prefs.json"), b"keep");
    let out = cleanup(Some(&link), None);
    assert_eq!(out, Outcome { removed: 2, failed: 0 });
    assert_eq!(fs::read(real.join("prefs.json")).unwrap(), b"keep");
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "the link itself stays");
    fs::remove_dir_all(&real).unwrap();
    fs::remove_dir_all(&parent).unwrap();
}

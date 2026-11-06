// K2-05 T5 (S3): legacy conversations cleanup. Temp dirs only; the user's real data dirs are never touched.
use super::*;
use std::path::PathBuf;

// An id exactly as `conversations.rs::create` wrote them: `c-<nanostamp>-<pid>-<counter>`.
const A_ID: &str = "c-1761820800000000000-4242-0";
const B_ID: &str = "c-1761820800000000001-4242-1";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("koda-legacy-conversations-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
}

#[test]
fn removes_exactly_the_conversation_files_the_index_and_its_temp_leftovers() {
    let conv = scratch("data");
    write(&conv.join(format!("{A_ID}.jsonl")), b"{\"v\":1}");
    write(&conv.join(format!("{B_ID}.jsonl")), b"{\"v\":1}");
    write(&conv.join("index.json"), b"{\"v\":1}");
    write(&conv.join("index-4242-0.tmp"), b"partial");
    write(&conv.join("index-4242-1.tmp"), b"partial");

    let out = cleanup(Some(&conv));

    assert_eq!(out, Outcome { removed: 5, failed: 0 });
    assert!(!conv.join(format!("{A_ID}.jsonl")).exists());
    assert!(!conv.join(format!("{B_ID}.jsonl")).exists());
    assert!(!conv.join("index.json").exists());
    assert!(!conv.join("index-4242-0.tmp").exists());
    assert!(!conv.join("index-4242-1.tmp").exists());
    assert_eq!(out.log_line().as_deref(), Some("legacy conversations data removed (5 files)"));
    assert!(!conv.exists(), "the emptied directory itself goes too");
}

#[test]
fn everything_else_stays_byte_identical() {
    let conv = scratch("keep");
    let valid_shaped = format!("{A_ID}.jsonl");
    write(&conv.join(&valid_shaped), b"{}");
    // look-alikes and neighbours that are NOT the approved names
    write(&conv.join("c-.jsonl"), b"id too short"); // id below 4..=80
    write(&conv.join("c-nope~.jsonl"), b"id with a stray byte");
    write(&conv.join("notes.jsonl"), b"the user's own file");
    write(&conv.join("index.json.bak"), b"user backup");
    write(&conv.join("index"), b"not the index");
    write(&conv.join("index-abc-1.tmp"), b"pid must be numeric");
    write(&conv.join("index-4242-1x.tmp"), b"counter must be numeric");
    write(&conv.join("index-4242.tmp"), b"single numeric field is not ours");
    write(&conv.join("index-4242-1.tmp.old"), b"not a .tmp");
    write(&conv.join("my notes.txt"), b"the user's own file");
    fs::create_dir(conv.join("audit")).unwrap();
    write(&conv.join("audit").join(&valid_shaped), b"nested, never recursive");
    // A DIRECTORY with one of our exact names is not a regular file: it stays whole.
    fs::create_dir(conv.join("index.json")).unwrap();
    write(&conv.join("index.json").join("inside"), b"kept");
    fs::create_dir(conv.join(format!("{B_ID}.jsonl"))).unwrap();
    write(&conv.join(format!("{B_ID}.jsonl")).join("inside"), b"kept");

    let out = cleanup(Some(&conv));

    assert_eq!(out, Outcome { removed: 1, failed: 0 });
    for (name, bytes) in [
        ("c-.jsonl", &b"id too short"[..]),
        ("c-nope~.jsonl", b"id with a stray byte"),
        ("notes.jsonl", b"the user's own file"),
        ("index.json.bak", b"user backup"),
        ("index", b"not the index"),
        ("index-abc-1.tmp", b"pid must be numeric"),
        ("index-4242-1x.tmp", b"counter must be numeric"),
        ("index-4242.tmp", b"single numeric field is not ours"),
        ("index-4242-1.tmp.old", b"not a .tmp"),
        ("my notes.txt", b"the user's own file"),
    ] {
        assert_eq!(fs::read(conv.join(name)).unwrap(), bytes, "{}", name);
    }
    assert_eq!(
        fs::read(conv.join("audit").join(&valid_shaped)).unwrap(),
        b"nested, never recursive"
    );
    assert_eq!(fs::read(conv.join("index.json").join("inside")).unwrap(), b"kept");
    assert_eq!(
        fs::read(conv.join(format!("{B_ID}.jsonl")).join("inside")).unwrap(),
        b"kept",
        "a directory named like a conversation file is never removed"
    );
    assert!(conv.exists(), "kept files mean the directory stays");
    fs::remove_dir_all(&conv).unwrap();
}

#[cfg(unix)]
#[test]
fn a_symlink_named_like_a_target_is_left_and_its_target_untouched() {
    let conv = scratch("link");
    let outside = scratch("link-outside");
    write(&outside.join("precious"), b"never deleted");
    std::os::unix::fs::symlink(outside.join("precious"), conv.join(format!("{A_ID}.jsonl"))).unwrap();
    std::os::unix::fs::symlink(outside.join("precious"), conv.join("index.json")).unwrap();
    std::os::unix::fs::symlink(outside.join("precious"), conv.join("index-4242-0.tmp")).unwrap();

    let out = cleanup(Some(&conv));

    assert_eq!(out, Outcome { removed: 0, failed: 0 });
    assert!(fs::symlink_metadata(conv.join(format!("{A_ID}.jsonl"))).unwrap().file_type().is_symlink());
    assert!(fs::symlink_metadata(conv.join("index.json")).unwrap().file_type().is_symlink());
    assert!(fs::symlink_metadata(conv.join("index-4242-0.tmp")).unwrap().file_type().is_symlink());
    assert_eq!(fs::read(outside.join("precious")).unwrap(), b"never deleted");
    fs::remove_dir_all(&conv).unwrap();
    fs::remove_dir_all(&outside).unwrap();
}

// Windows twin of the symlink guard: a directory named exactly like one of our targets is not a
// regular file, so it stays (the unix test above covers real symlinks).
#[test]
fn a_directory_named_like_a_target_is_left() {
    let conv = scratch("dir-named");
    fs::create_dir(conv.join(format!("{A_ID}.jsonl"))).unwrap();
    write(&conv.join(format!("{A_ID}.jsonl")).join("x"), b"kept");
    fs::create_dir(conv.join("index.json")).unwrap();
    write(&conv.join("index.json").join("x"), b"kept");
    let out = cleanup(Some(&conv));
    assert_eq!(out, Outcome { removed: 0, failed: 0 });
    assert_eq!(fs::read(conv.join(format!("{A_ID}.jsonl")).join("x")).unwrap(), b"kept");
    assert_eq!(fs::read(conv.join("index.json").join("x")).unwrap(), b"kept");
    fs::remove_dir_all(&conv).unwrap();
}

#[test]
fn nothing_there_is_success_and_silent_and_a_second_run_is_a_noop() {
    let conv = scratch("empty");
    let missing = conv.join("does-not-exist");
    assert_eq!(cleanup(Some(&missing)), Outcome::default());
    assert_eq!(cleanup(None), Outcome::default());
    write(&conv.join("index.json"), b"{}");
    assert_eq!(cleanup(Some(&conv)).removed, 1);
    assert!(!conv.exists(), "the empty leftover directory goes with the files");
    let again = cleanup(Some(&conv));
    assert_eq!(again, Outcome::default(), "idempotent");
    assert_eq!(again.log_line(), None, "nothing to say, nothing logged");
}

#[test]
fn the_log_line_is_content_free() {
    let line = Outcome { removed: 3, failed: 1 }.log_line().unwrap();
    assert_eq!(
        line,
        "legacy conversations data cleanup incomplete (3 removed, 1 failed); retrying next start"
    );
    assert!(!line.contains('/') && !line.contains('\\'), "no path in the log");
}

#[cfg(unix)]
#[test]
fn a_symlinked_conversations_dir_is_never_followed() {
    let real = scratch("real-conversations");
    let parent = scratch("link-parent");
    let link = parent.join("conversations");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    write(&real.join(format!("{A_ID}.jsonl")), b"{}");
    write(&real.join("index.json"), b"{}");

    let out = cleanup(Some(&link));

    assert_eq!(out, Outcome { removed: 0, failed: 0 }, "a symlink there is not ours to empty");
    assert_eq!(fs::read(real.join(format!("{A_ID}.jsonl"))).unwrap(), b"{}");
    assert_eq!(fs::read(real.join("index.json")).unwrap(), b"{}");
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "the link itself stays");
    fs::remove_dir_all(&real).unwrap();
    fs::remove_dir_all(&parent).unwrap();
}

// The app data dir itself comes from Tauri, not from the user: a symlinked app data dir is
// followed on purpose (see module doc). Only the exact targets inside `conversations` go.
#[cfg(unix)]
#[test]
fn a_symlinked_app_data_dir_is_followed_and_only_the_exact_targets_inside_go() {
    let real = scratch("real-data");
    let parent = scratch("data-link-parent");
    let link = parent.join("com.abitog.AbitoTauri");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let conv = link.join("conversations");
    fs::create_dir_all(&conv).unwrap();
    write(&conv.join(format!("{A_ID}.jsonl")), b"{}");
    write(&conv.join("index-4242-0.tmp"), b"partial");
    write(&conv.join("index.json"), b"{}");
    write(&conv.join("notes.jsonl"), b"keep");
    write(&real.join("prefs.json"), b"keep");

    let out = cleanup(Some(&conv));

    assert_eq!(out, Outcome { removed: 3, failed: 0 });
    assert_eq!(fs::read(conv.join("notes.jsonl")).unwrap(), b"keep");
    assert_eq!(fs::read(real.join("prefs.json")).unwrap(), b"keep");
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "the link itself stays");
    fs::remove_dir_all(&real).unwrap();
    fs::remove_dir_all(&parent).unwrap();
}

#[test]
fn the_name_predicates_match_exactly_what_conversations_rs_wrote() {
    assert!(is_turn_file(&format!("{A_ID}.jsonl")));
    assert!(is_turn_file("c-ab.jsonl"), "4 chars is the valid-id floor");
    assert!(!is_turn_file("c-a.jsonl"), "3 chars is below the floor");
    assert!(!is_turn_file("d-1761820800000000000-4242-0.jsonl"), "ids start with c-");
    assert!(!is_turn_file("c-no~pe.jsonl"), "only ASCII alphanumeric and dash");
    assert!(!is_turn_file("index.jsonl"), "not an id-shaped name");
    assert!(!is_turn_file(&format!("{A_ID}.JSONL")), "the suffix is exact");
    assert!(is_temp_file("index-4242-0.tmp"));
    assert!(is_temp_file("index-1-99999999999999999999.tmp"));
    assert!(!is_temp_file("index-4242-0"), "no suffix, no");
    assert!(!is_temp_file("index-4242-.tmp"), "empty counter");
    assert!(!is_temp_file("index--0.tmp"), "empty pid");
    assert!(!is_temp_file("index-4242-0.tmp.txt"), "suffix must end the name");
    assert!(!is_temp_file("xindex-4242-0.tmp"), "prefix must start the name");
}

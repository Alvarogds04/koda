//! N7: test-fixture hygiene. The short UDS leaves (`q00..qff`, `n00..nff`) must
//! never run out: a leaf is removed when its owner drops (even while panicking
//! and even with leftovers inside) and a leaf whose owner process is gone is
//! reclaimed on the next allocation. Parallel owners never touch each other.
#![cfg(unix)] // Uses Unix file mode, uid, and symlink APIs.
mod common;
use common::fixture_leaf::{Leaf, SPACE};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static N: AtomicU64 = AtomicU64::new(0);
fn base() -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("leaf-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
    dir
}
fn dead_pid() -> u32 {
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    pid
}
fn plant(base: &Path, name: &str, owner: Option<u32>) -> PathBuf {
    let dir = base.join(name);
    std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
    std::fs::create_dir(dir.join("p-AbCdEf")).unwrap();
    std::fs::write(dir.join("p-AbCdEf").join("s"), b"left behind").unwrap();
    if let Some(pid) = owner { std::fs::write(dir.join(".owner"), pid.to_string()).unwrap(); }
    dir
}
fn cleanup(base: &Path) { let _ = std::fs::remove_dir_all(base); }

#[test]
fn allocation_is_private_0700_and_distinct_across_parallel_owners() {
    let base = base();
    let leaves: Vec<Leaf> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..24).map(|_| s.spawn(|| Leaf::alloc(&base, "q"))).collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let mut names: Vec<_> = leaves.iter().map(|l| l.path().to_path_buf()).collect();
    names.sort(); names.dedup();
    assert_eq!(names.len(), 24, "every owner got its own leaf");
    for leaf in &leaves {
        let meta = std::fs::symlink_metadata(leaf.path()).unwrap();
        assert!(meta.is_dir() && meta.permissions().mode() & 0o7777 == 0o700);
        assert_eq!(std::fs::read_to_string(leaf.path().join(".owner")).unwrap(), std::process::id().to_string());
    }
    drop(leaves);
    assert_eq!(std::fs::read_dir(&base).unwrap().count(), 0, "all leaves removed on drop");
    cleanup(&base);
}

#[test]
fn drop_removes_the_leaf_even_with_leftovers_and_even_while_panicking() {
    let base = base();
    let path = {
        let leaf = Leaf::alloc(&base, "q");
        std::fs::create_dir(leaf.path().join("p-XyZ123")).unwrap();
        std::fs::write(leaf.path().join("p-XyZ123").join("s"), b"socket stand-in").unwrap();
        leaf.path().to_path_buf()
    };
    assert!(!path.exists(), "non-empty leaf removed on a normal drop");
    let base2 = base.clone();
    let result = std::panic::catch_unwind(move || {
        let leaf = Leaf::alloc(&base2, "q");
        std::fs::write(leaf.path().join("junk"), b"x").unwrap();
        let p = leaf.path().to_path_buf();
        std::fs::write(base2.join("last-path"), p.to_string_lossy().as_bytes()).unwrap();
        panic!("a failing test");
    });
    assert!(result.is_err());
    let p = std::fs::read_to_string(base.join("last-path")).unwrap();
    assert!(!Path::new(&p).exists(), "leaf removed while panicking: {p}");
    cleanup(&base);
}

#[test]
fn a_leaf_whose_owner_is_gone_is_reclaimed_so_the_space_never_runs_out() {
    let base = base();
    let gone = dead_pid();
    for n in 0..SPACE { plant(&base, &format!("q{n:02x}"), Some(gone)); }
    assert_eq!(std::fs::read_dir(&base).unwrap().count(), SPACE, "the whole space is leaked: the old failure mode");
    let leaf = Leaf::alloc(&base, "q"); // used to panic with «free private fixture leaf»
    assert!(leaf.path().is_dir());
    drop(leaf);
    cleanup(&base);
}

#[test]
fn every_allocation_sweeps_abandoned_leaves_of_its_prefix_so_they_do_not_pile_up() {
    let base = base();
    let gone = dead_pid();
    for n in 0..40 { plant(&base, &format!("q{n:02x}"), Some(gone)); }
    let survivor = plant(&base, "n01", Some(gone)); // another prefix: not ours to sweep
    let live = plant(&base, "q41", Some(std::process::id()));
    let leaf = Leaf::alloc(&base, "q");
    let left: Vec<_> = std::fs::read_dir(&base).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert!(left.iter().filter(|n| n.starts_with('q')).count() <= 2, "only the live leaf and ours remain: {left:?}");
    assert!(live.exists() && survivor.exists());
    drop(leaf);
    cleanup(&base);
}

#[test]
fn a_live_owner_is_never_reclaimed_and_neither_is_a_young_ownerless_leaf() {
    let base = base();
    let live = plant(&base, "q00", Some(std::process::id()));
    let young = plant(&base, "q01", None);
    let fresh = Leaf::alloc(&base, "q");
    assert!(live.join("p-AbCdEf").join("s").exists(), "another LIVE process's (or thread's) leaf is untouched");
    assert!(young.join("p-AbCdEf").join("s").exists(), "a leaf with no owner yet may be mid-creation: untouched while young");
    assert_ne!(fresh.path(), live); assert_ne!(fresh.path(), young);
    drop(fresh);
    cleanup(&base);
}

#[test]
fn an_old_ownerless_leaf_is_reclaimed() {
    let base = base();
    let old = plant(&base, "q00", None);
    let file = std::fs::File::open(&old).unwrap();
    file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600)).unwrap();
    for n in 1..SPACE { plant(&base, &format!("q{n:02x}"), Some(std::process::id())); } // everything else is live
    let leaf = Leaf::alloc(&base, "q");
    assert_eq!(leaf.path(), old, "only the old ownerless leaf was free to take");
    drop(leaf);
    cleanup(&base);
}

#[test]
fn only_leaves_of_our_own_shape_are_ever_touched() {
    let base = base();
    let gone = dead_pid();
    // foreign entries that look dangerous: wrong names, a symlink, a plain file, another prefix
    let outside = base.join("outside"); std::fs::create_dir(&outside).unwrap(); std::fs::write(outside.join("precious"), b"keep").unwrap();
    std::os::unix::fs::symlink(&outside, base.join("q7f")).unwrap();
    let other_prefix = plant(&base, "n00", Some(gone));
    let named = plant(&base, "m4-xdg", Some(gone));
    let too_long = plant(&base, "q000", Some(gone));
    std::fs::write(base.join("q80"), b"a file, not a leaf").unwrap();
    for n in 0..SPACE { let name = format!("q{n:02x}"); if !base.join(&name).exists() { plant(&base, &name, Some(gone)); } }
    let leaf = Leaf::alloc(&base, "q");
    assert!(outside.join("precious").exists(), "a symlinked «leaf» is never followed or removed");
    assert!(other_prefix.exists() && named.exists() && too_long.exists(), "other prefixes and names are not ours");
    assert!(base.join("q80").is_file());
    drop(leaf);
    assert!(outside.join("precious").exists());
    cleanup(&base);
}

#[test]
fn a_foreign_owned_leaf_is_not_ours_to_remove() {
    // owner file naming a dead pid is not enough on its own: the directory must be OURS and 0700
    let base = base();
    let gone = dead_pid();
    let wide = plant(&base, "q00", Some(gone));
    std::fs::set_permissions(&wide, std::fs::Permissions::from_mode(0o755)).unwrap();
    for n in 1..SPACE { plant(&base, &format!("q{n:02x}"), Some(std::process::id())); }
    let result = std::panic::catch_unwind(|| Leaf::alloc(&base, "q"));
    assert!(result.is_err(), "no free leaf: the only candidate is not 0700, so it is not reclaimed (and nothing is invented)");
    assert!(wide.join("p-AbCdEf").join("s").exists());
    assert_eq!(std::fs::metadata(&wide).unwrap().uid(), unsafe_uid());
    cleanup(&base);
}
fn unsafe_uid() -> u32 { std::fs::metadata(env!("CARGO_TARGET_TMPDIR")).unwrap().uid() }

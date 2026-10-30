#![cfg(target_os = "linux")]
// Linux-only integration: receiver runtime policy uses XDG paths and Unix metadata.
//! M4-PRE: a packaged (release) binary must never resolve its runtime root or
//! project id to the source tree, and the installed root is its own private
//! leaf that never touches the Preview's reserved roots.
use abito_island::identity::{self, project_root_for};
use abito_island::transport::{
    self, default_runtime_for, resolve_runtime_from, runtime_allowed, INSTALLED_RUNTIME_LEAF,
    RESERVED_RUNTIME_NAMES,
};
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};

const BUILD_TREE: &str = env!("CARGO_MANIFEST_DIR");

#[test]
fn installed_default_is_the_own_leaf_under_xdg_and_never_the_source_tree() {
    let root = default_runtime_for(Some("/run/user/1000"), None).expect("installed default");
    assert_eq!(root, PathBuf::from("/run/user/1000/abito-island"));
    assert!(!root.starts_with(BUILD_TREE), "installed root must not point at the build tree");
    assert!(!INSTALLED_RUNTIME_LEAF.is_empty());
    assert!(!RESERVED_RUNTIME_NAMES.contains(&INSTALLED_RUNTIME_LEAF));
    // allowed by the Preview-root guard, with the real XDG base
    assert!(runtime_allowed(&root, Some("/run/user/1000")));
    resolve_runtime_from(None, &root, Some("/run/user/1000")).expect("resolves");
}

#[test]
fn installed_default_refuses_instead_of_inventing_a_location() {
    for bad in [None, Some(""), Some("relative/run"), Some("/run/user/../1000"), Some("/run//user")] {
        assert!(default_runtime_for(bad, None).is_err(), "{bad:?}");
    }
}

#[test]
fn dev_layout_is_the_crate_side_runtime_only_when_a_manifest_is_given() {
    let dev = default_runtime_for(Some("/run/user/1000"), Some(BUILD_TREE)).expect("dev");
    assert_eq!(dev, Path::new(BUILD_TREE).join(".runtime"));
}

#[test]
fn this_binary_resolves_to_the_source_tree_only_in_a_debug_build() {
    // The behaviour test that FAILS a packaged binary resolving to the tree:
    // in a release build (what gets packaged) the baked manifest must be gone.
    let baked = identity::dev_manifest_dir();
    if cfg!(debug_assertions) {
        assert_eq!(baked, Some(BUILD_TREE));
    } else {
        assert_eq!(baked, None, "a release binary must not carry the build-tree path");
        let root = transport::default_runtime();
        if let Ok(path) = root {
            assert!(!path.starts_with(BUILD_TREE), "release runtime root points at the source tree");
        }
        let project = std::env::var("ABITO_PROJECT_ROOT").ok();
        let from_tree = project_root_for(Some(BUILD_TREE), None).and_then(|p| p.to_str().map(str::to_owned));
        if let (Some(tree), Some(env_root)) = (from_tree, project.as_deref()) {
            assert_ne!(identity::project_root_for(None, Some(env_root)).and_then(|p| p.to_str().map(str::to_owned)), Some(tree));
        }
    }
}

#[test]
fn source_never_bakes_the_build_tree_outside_debug_only_items() {
    // Static guard: every `CARGO_MANIFEST_DIR` read in src/ must sit right
    // under `#[cfg(debug_assertions)]`.
    let mut observed = 0usize;
    for file in ["src/transport.rs", "src/identity.rs", "src/main.rs"] {
        let text = std::fs::read_to_string(Path::new(BUILD_TREE).join(file)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if line.contains("option_env!(\"CARGO_MANIFEST_DIR\")") && !line.trim_start().starts_with("//") {
                observed += 1;
                let guarded = (1..=2).any(|back| i >= back && lines[i - back].trim() == "#[cfg(debug_assertions)]");
                assert!(guarded, "{file}:{} reads CARGO_MANIFEST_DIR outside a debug-only fn", i + 1);
            }
        }
    }
    // A static guard that matched nothing has stopped guarding: it would pass
    // forever while the thing it polices moves to another spelling or another
    // file. Fail loudly and name the maintenance act instead.
    assert!(
        observed >= 2,
        "this guard inspected {observed} CARGO_MANIFEST_DIR reads, expected at least the 2 known ones \
         (src/transport.rs, src/identity.rs): the pattern moved or was renamed, so the loop asserted nothing"
    );
}

#[test]
fn installed_project_root_comes_only_from_an_explicit_absolute_directory() {
    assert!(project_root_for(None, None).is_none());
    assert!(project_root_for(None, Some("relative")).is_none());
    assert!(project_root_for(None, Some("/tmp/../etc")).is_none());
    assert!(project_root_for(None, Some("/definitely/not/here")).is_none());
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("m4-project-root");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let got = project_root_for(None, dir.to_str()).expect("explicit directory");
    assert_eq!(got, std::fs::canonicalize(&dir).unwrap());
    // the id is derived from that root, not from the build tree
    let id = abito_island::protocol::project_id(got.to_str().unwrap());
    assert_ne!(id, abito_island::protocol::project_id(&std::fs::canonicalize(BUILD_TREE).unwrap().parent().unwrap().parent().unwrap().to_string_lossy()));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn installed_leaf_is_private_0700_and_owned_by_us() {
    // `prepare_runtime` on a leaf shaped like the installed one, inside a
    // private parent (never /tmp: world-writable chains are refused).
    let parent = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("m4-xdg");
    let _ = std::fs::remove_dir_all(&parent);
    std::fs::DirBuilder::new().mode(0o700).create(&parent).unwrap();
    let leaf = default_runtime_for(parent.to_str(), None).expect("leaf");
    assert_eq!(leaf, parent.join(INSTALLED_RUNTIME_LEAF));
    let prepared = transport::prepare_runtime(&leaf).expect("prepare");
    let meta = std::fs::symlink_metadata(&prepared).unwrap();
    assert_eq!(meta.mode() & 0o7777, 0o700);
    assert_eq!(meta.uid(), std::fs::metadata(&parent).unwrap().uid(), "leaf is owned by the same user as its private parent");
    let _ = std::fs::remove_dir_all(&parent);
}

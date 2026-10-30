//! Self-cleaning short fixture leaves for UDS tests (N7).
//!
//! A socket path must stay under 107 bytes, so a leaf is `<prefix><2 hex>`
//! (256 possible names per prefix) directly under a private base directory.
//! Tests only: nothing here is production code.
//!
//! Contract:
//! - `Leaf::alloc` creates a leaf with exclusive `mkdir 0700` (parallel owners,
//!   threads or processes, can never share one) and writes `.owner` (our pid).
//! - A taken name is RECLAIMED only when it is provably abandoned: a real
//!   directory (never a symlink), ours, mode 0700, whose `.owner` pid is not a
//!   live process — or which has no `.owner` and has not been touched for
//!   `STALE_AFTER` (a leaf being created right now has no owner file yet).
//! - Names outside `^<prefix>[0-9a-f]{2}$` are never touched.
//! - Drop removes the leaf recursively, also while panicking and also with
//!   leftovers (a stale socket after a failed close), without ever panicking.
#![cfg(unix)] // Uses Unix file mode, uid, and symlink APIs.
#![allow(dead_code)]
use std::io::ErrorKind;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const SPACE: usize = 256;
const STALE_AFTER: Duration = Duration::from_secs(600);
static NEXT: AtomicU64 = AtomicU64::new(1);

pub struct Leaf { path: PathBuf }
impl Leaf {
    pub fn path(&self) -> &Path { &self.path }
    pub fn alloc(base: &Path, prefix: &str) -> Leaf {
        let seed = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)
            .wrapping_add(u64::from(std::process::id()));
        // Sweep what is provably abandoned (dead owner / old ownerless) so it never piles up.
        for n in 0..SPACE { let path = base.join(format!("{prefix}{n:02x}")); if reclaimable(&path) { remove_leaf(&path); } }
        let first = seed.wrapping_add(NEXT.fetch_add(1, Ordering::Relaxed));
        for step in 0..SPACE as u64 {
            let n = first.wrapping_add(step) % SPACE as u64;
            let path = base.join(format!("{prefix}{n:02x}"));
            if let Some(leaf) = Self::try_create(&path) { return leaf; }
            if reclaimable(&path) {
                remove_leaf(&path);
                if let Some(leaf) = Self::try_create(&path) { return leaf; }
            }
        }
        panic!("free private fixture leaf: all {SPACE} `{prefix}xx` leaves under {} are held by live owners", base.display());
    }
    fn try_create(path: &Path) -> Option<Leaf> {
        match std::fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => {
                std::fs::write(path.join(".owner"), std::process::id().to_string()).expect("write leaf owner");
                Some(Leaf { path: path.to_path_buf() })
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => None,
            Err(e) => panic!("private fixture: {e}"),
        }
    }
}
impl Drop for Leaf {
    fn drop(&mut self) { remove_leaf(&self.path); }
}

fn our_shape(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
    let hex = name.len() >= 3 && name[name.len() - 2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let prefix = &name[..name.len().saturating_sub(2)];
    hex && !prefix.is_empty() && prefix.len() <= 2 && prefix.bytes().all(|b| b.is_ascii_lowercase())
}
/// A real directory, ours, 0700 — the only thing we ever remove.
fn ours(path: &Path) -> Option<std::fs::Metadata> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    let mine = std::fs::metadata(path.parent()?).ok()?.uid();
    (meta.file_type().is_dir() && !meta.file_type().is_symlink() && meta.uid() == mine && meta.permissions().mode() & 0o7777 == 0o700).then_some(meta)
}
fn pid_alive(pid: u32) -> bool { Path::new(&format!("/proc/{pid}")).exists() }
fn reclaimable(path: &Path) -> bool {
    if !our_shape(path) { return false; }
    let Some(meta) = ours(path) else { return false };
    match std::fs::read_to_string(path.join(".owner")).ok().and_then(|t| t.trim().parse::<u32>().ok()) {
        Some(pid) => !pid_alive(pid),
        None => meta.modified().ok().and_then(|m| SystemTime::now().duration_since(m).ok()).is_some_and(|age| age >= STALE_AFTER),
    }
}
fn remove_leaf(path: &Path) {
    if !our_shape(path) || ours(path).is_none() { return; }
    let _ = std::fs::remove_dir_all(path); // never panics: this also runs while a test is panicking
}

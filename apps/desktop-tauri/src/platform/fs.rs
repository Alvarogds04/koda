//! Seam: private config writes.
//!
//! The island keeps two small files in its config directory — the hotkey
//! binding and the motion-override flag. Both are written with owner-only
//! permissions on unix, and the hotkey file additionally goes through a
//! temp + rename so an interrupted write can never leave a half-written
//! binding that the next launch would parse as a real one.
//!
//! Only the *permission bits* are Unix-only. The temp + rename discipline is
//! portable and is kept on both targets: dropping it on Windows would be a
//! silent behaviour difference, not a simplification.
//!
//! This seam also closes a real gap the port found: the hotkey writer used to
//! be wrapped in a bare `#[cfg(unix)]` block with no other arm, so a Windows
//! build compiled, ran, and quietly never saved the user's binding. Routing
//! through here makes "writes on every OS" the shape of the code.

use std::io::{self, Write};
use std::path::Path;

/// Replace `path` with `bytes`, keeping the file private to the owner where
/// the OS has permission bits. Non-atomic by design: this mirrors the
/// truncate-and-write the motion flag has always done.
#[cfg(unix)]
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

#[cfg(windows)]
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    // No POSIX mode to set; the file inherits the directory's ACL, which is
    // already the user's app-data directory.
    std::fs::write(path, bytes)
}

/// Write `bytes` to `path` via a `.{name}.{pid}` sibling and a rename, so a
/// reader either sees the whole old file or the whole new one. The temp file is
/// removed if the write or the rename fails.
#[cfg(unix)]
pub(crate) fn write_private_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = sibling_temp(path);
    let result = (|| -> io::Result<()> {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(bytes)?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(windows)]
pub(crate) fn write_private_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = sibling_temp(path);
    let result = (|| -> io::Result<()> {
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// `.{file name}.{pid}` next to `path` — the same name the hotkey writer has
/// always used, so a crash leaves a file a human can recognise as ours.
fn sibling_temp(path: &Path) -> std::path::PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_else(|| std::ffi::OsString::from("abito-island.tmp"));
    let mut tmp = std::ffi::OsString::from(".");
    tmp.push(&name);
    tmp.push(format!(".{}", std::process::id()));
    // Measured std behaviour: `Path::new("/").parent()` is None — the root has
    // no parent. Fall back to the path itself so the temp stays beside the
    // target; falling back to an empty path instead would silently drop it
    // into the current directory.
    path.parent().unwrap_or(path).join(tmp)
}

#[cfg(test)]
mod tests {
    use super::{sibling_temp, write_private, write_private_atomic};
    use std::path::Path;

    #[test]
    fn sibling_temp_is_a_dotfile_beside_the_target() {
        let tmp = sibling_temp(Path::new("/etc/abito/hotkey.json"));
        assert_eq!(tmp.parent().unwrap(), Path::new("/etc/abito"));
        let name = tmp.file_name().unwrap().to_string_lossy().into_owned();
        // ".hotkey.json.<pid>" — dot-prefixed, keeps the real name, pid suffix.
        assert!(name.starts_with(".hotkey.json."), "got {name}");
        let pid = name.rsplit('.').next().unwrap();
        assert_eq!(pid.parse::<u32>().unwrap(), std::process::id());
    }

    #[test]
    fn sibling_temp_survives_a_path_without_a_name() {
        // Written against measured std behaviour, not remembered spec:
        // `file_name()` ignores a trailing separator ("/etc/abito/" IS "abito"),
        // and `Path::new("/").parent()` is None — so the name-less root falls
        // back to the path itself and the dotfile stays absolute beside it,
        // never in the current directory. Must not panic either way.
        let tmp = sibling_temp(Path::new("/"));
        assert!(tmp.is_absolute(), "temp escaped to CWD: {}", tmp.display());
        assert!(tmp.to_string_lossy().starts_with("/.abito-island.tmp."));
        // A trailing separator is NOT the name-less case — it keeps the real name.
        assert!(sibling_temp(Path::new("/etc/abito/"))
            .to_string_lossy()
            .starts_with("/etc/.abito."));
    }

    #[test]
    fn atomic_write_leaves_no_temp_behind() {
        let dir = std::env::temp_dir().join(format!("abito-fs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("conf.json");
        write_private_atomic(&path, b"{\"v\":1}").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"{\"v\":1}");
        // Only the real file remains: the temp was renamed, not copied.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".conf.json.")
            })
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn private_write_round_trips() {
        let dir = std::env::temp_dir().join(format!("abito-fs-p-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("motion.json");
        write_private(&path, b"1").unwrap();
        write_private(&path, b"0").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"0");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

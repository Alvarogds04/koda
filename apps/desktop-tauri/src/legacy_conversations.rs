//! K2-05 T5 (S3): one-time cleanup of Koda 0.1's private chat conversations on upgrade from 0.1.
//!
//! 0.2 talks to the daemon engine with one continuous chat and keeps no conversation list
//! (K2-05 T4/U5 removes the direct Rust chat). On upgrade the user's stored 0.1 conversations
//! are deleted — ONLY those files, nothing else:
//! - `<app_data_dir>/conversations/<id>.jsonl` (what `conversations.rs::create` wrote, ids shaped
//!   `c-<stamp>-<pid>-<n>`: `c-` prefix, 4..=80 chars, ASCII alphanumeric or `-`)
//! - `<app_data_dir>/conversations/index.json` (the rebuilt index)
//! - `<app_data_dir>/conversations/index-<pid>-<n>.tmp` (atomic-rename leftovers of the index)
//!
//! Accounts, preferences, secrets (keychain `com.abitog.AbitoTauri`, the 0.1 service), the Engram memory and every
//! other file in the app data dir are the user's and are never touched.
//!
//! Guards: the folder is opened ONCE without following a link (Unix `O_DIRECTORY|O_NOFOLLOW`; Windows reparse point refused)
//! and every leaf is checked and unlinked RELATIVE to that opened folder (`fstatat`/`unlinkat` with `AT_SYMLINK_NOFOLLOW`), so
//! swapping the path for a link or another directory mid-run cannot redirect a delete. Only a regular file is removed. A symlink is never
//! followed — not the leaf files, and not the `conversations` directory itself either (if it is a
//! symlink, its target is not ours to empty). Nothing is recursive, and the directory itself is
//! removed only when it is empty afterwards. «Not found» is success. Any other error is reported
//! content-free and the next start retries. The directory path comes from Tauri
//! (`app_data_dir`), never from the user: if the app data dir ABOVE it is a symlink (a data dir
//! the user moved elsewhere), it is followed on purpose, because that is where Koda's own data
//! lives; only the final component of each target is guarded.
//! Same code on Linux, macOS and Windows: the directory comes from Tauri (`app_data_dir`).
//! K2-04 T6: the 0.1 folder is the sibling named after the OLD bundle identifier (`legacy_identity::legacy_sibling`), because the
//! identifier is now `com.abitog.Koda`; `<app_data_dir>` above means that old folder. Nothing is copied or moved.
//! Independent of `conversations.rs`/`chathost` on purpose: U5 deletes them, this module survives.
//! TODO(K2-05 follow-up): remove one version after K2-05 ships.
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

pub const INDEX_FILE: &str = "index.json";
const TEMP_PREFIX: &str = "index-";
const TEMP_SUFFIX: &str = ".tmp";
const TURN_SUFFIX: &str = ".jsonl";
const ID_PREFIX: &str = "c-";
const ID_MIN_LEN: usize = 4;
const ID_MAX_LEN: usize = 80;

/// What one cleanup run did: how many files went and whether any removal failed (no names, no paths).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub removed: usize,
    pub failed: usize,
}

impl Outcome {
    /// The single content-free log line for this run, if there is anything to say.
    pub fn log_line(&self) -> Option<String> {
        match (self.removed, self.failed) {
            (0, 0) => None,
            (r, 0) => Some(format!("legacy conversations data removed ({r} files)")),
            (r, f) => Some(format!(
                "legacy conversations data cleanup incomplete ({r} removed, {f} failed); retrying next start"
            )),
        }
    }
}

/// A name `conversations.rs` wrote for a stored conversation: `<valid id>.jsonl`.
fn is_turn_file(name: &str) -> bool {
    let Some(id) = name.strip_suffix(TURN_SUFFIX) else {
        return false;
    };
    id.starts_with(ID_PREFIX)
        && (ID_MIN_LEN..=ID_MAX_LEN).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// An atomic-rename leftover `conversations.rs::index` wrote: `index-<pid>-<n>.tmp`, both numeric.
fn is_temp_file(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(TEMP_PREFIX).and_then(|r| r.strip_suffix(TEMP_SUFFIX)) else {
        return false;
    };
    match rest.split_once('-') {
        Some((pid, counter)) => {
            !pid.is_empty()
                && pid.bytes().all(|b| b.is_ascii_digit())
                && !counter.is_empty()
                && counter.bytes().all(|b| b.is_ascii_digit())
        }
        None => false,
    }
}

fn is_legacy_name(name: &str) -> bool {
    name == INDEX_FILE || is_turn_file(name) || is_temp_file(name)
}

/// Why the folder could not be opened as «our» folder.
enum OpenError {
    /// Nothing there: success, nothing to do.
    Missing,
    /// A symlink, reparse point or non-directory sits there: not ours to empty, never followed.
    NotOurs,
    /// Anything else: reported content-free, retried next start.
    Failed,
}

/// The conversations folder, opened ONCE without following a link. Every later look and delete
/// goes through this handle, so swapping the path afterwards cannot redirect a delete elsewhere.
#[cfg(unix)]
mod folder {
    use super::OpenError;
    use std::ffi::{CString, OsStr, OsString};
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::path::Path;

    pub struct Folder(OwnedFd);

    /// Open `dir` with `O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC`: a link as the LAST component is
    /// refused (links in the path above it are followed: that is Tauri's own data dir).
    pub fn open(dir: &Path) -> Result<Folder, OpenError> {
        let c = CString::new(dir.as_os_str().as_bytes()).map_err(|_| OpenError::Failed)?;
        // SAFETY: `c` is a valid NUL-terminated path; the returned fd is owned right below.
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(match io::Error::last_os_error().raw_os_error() {
                Some(libc::ENOENT) => OpenError::Missing,
                Some(libc::ELOOP) | Some(libc::ENOTDIR) => OpenError::NotOurs,
                _ => OpenError::Failed,
            });
        }
        // SAFETY: `fd` was just returned by open(2) and nothing else owns it.
        Ok(Folder(unsafe { OwnedFd::from_raw_fd(fd) }))
    }

    impl Folder {
        /// Entry names of the opened folder (no `.`/`..`).
        pub fn entries(&self) -> io::Result<Vec<OsString>> {
            // SAFETY: dup(2) of a live fd; on success `fdopendir` takes ownership of the dup.
            let dup = unsafe { libc::dup(self.0.as_raw_fd()) };
            if dup < 0 {
                return Err(io::Error::last_os_error());
            }
            let dir = unsafe { libc::fdopendir(dup) };
            if dir.is_null() {
                let e = io::Error::last_os_error();
                unsafe { libc::close(dup) };
                return Err(e);
            }
            unsafe { libc::rewinddir(dir) }; // the dup shares the offset with earlier listings
            let mut names = Vec::new();
            let result = loop {
                // readdir returns NULL at the end AND on error: tell them apart through errno.
                unsafe { *errno_location() = 0 };
                let ent = unsafe { libc::readdir(dir) };
                if ent.is_null() {
                    let errno = unsafe { *errno_location() };
                    break if errno == 0 { Ok(()) } else { Err(io::Error::from_raw_os_error(errno)) };
                }
                // SAFETY: `d_name` is a NUL-terminated name inside the dirent just returned.
                let name = unsafe { std::ffi::CStr::from_ptr((*ent).d_name.as_ptr()) }.to_bytes();
                if name != b"." && name != b".." {
                    names.push(OsString::from_vec(name.to_vec()));
                }
            };
            unsafe { libc::closedir(dir) };
            result.map(|()| names)
        }

        /// `Some(true)` regular file, `Some(false)` anything else (link, dir, …), `None` gone.
        pub fn is_regular_file(&self, name: &OsStr) -> io::Result<Option<bool>> {
            let c = CString::new(name.as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            // SAFETY: valid fd, NUL-terminated relative name, writable stat buffer.
            let rc = unsafe { libc::fstatat(self.0.as_raw_fd(), c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) };
            if rc != 0 {
                let e = io::Error::last_os_error();
                return if e.kind() == io::ErrorKind::NotFound { Ok(None) } else { Err(e) };
            }
            Ok(Some((st.st_mode & libc::S_IFMT) == libc::S_IFREG))
        }

        /// `unlinkat(fd, name)`: removes a name INSIDE the opened folder only.
        pub fn unlink(&self, name: &OsStr) -> io::Result<()> {
            let c = CString::new(name.as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
            // SAFETY: valid fd and NUL-terminated relative name; flags 0 never removes a directory.
            if unsafe { libc::unlinkat(self.0.as_raw_fd(), c.as_ptr(), 0) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    unsafe fn errno_location() -> *mut libc::c_int {
        libc::__errno_location()
    }
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    unsafe fn errno_location() -> *mut libc::c_int {
        libc::__error()
    }
}

/// Windows: the folder is opened without following a reparse point (symlink/junction) and refused
/// if it is one. The handle is held (sharing read/write but NOT delete) for the whole run, so the
/// folder cannot be renamed, deleted or replaced while we delete inside it. Files are then removed
/// by path under that held folder. Remaining gap: the leaf deletes are by path, not by handle
/// (std has no `NtSetInformationFile`-relative delete), and the empty-folder removal at the end.
#[cfg(windows)]
mod folder {
    use super::OpenError;
    use std::ffi::{OsStr, OsString};
    use std::fs;
    use std::io;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::path::{Path, PathBuf};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    pub struct Folder {
        path: PathBuf,
        _handle: fs::File,
    }

    pub fn open(dir: &Path) -> Result<Folder, OpenError> {
        let file = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(dir)
            .map_err(|e| if e.kind() == io::ErrorKind::NotFound { OpenError::Missing } else { OpenError::Failed })?;
        let meta = file.metadata().map_err(|_| OpenError::Failed)?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !meta.is_dir() {
            return Err(OpenError::NotOurs);
        }
        Ok(Folder { path: dir.to_path_buf(), _handle: file })
    }

    impl Folder {
        pub fn entries(&self) -> io::Result<Vec<OsString>> {
            fs::read_dir(&self.path)?.map(|e| e.map(|e| e.file_name())).collect()
        }

        pub fn is_regular_file(&self, name: &OsStr) -> io::Result<Option<bool>> {
            match fs::symlink_metadata(self.path.join(name)) {
                Ok(m) => Ok(Some(m.file_type().is_file())),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e),
            }
        }

        pub fn unlink(&self, name: &OsStr) -> io::Result<()> {
            fs::remove_file(self.path.join(name))
        }
    }
}

fn remove_regular(folder: &folder::Folder, name: &std::ffi::OsStr, out: &mut Outcome) {
    match folder.is_regular_file(name) {
        Ok(Some(true)) => match folder.unlink(name) {
            Ok(()) => out.removed += 1,
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(_) => out.failed += 1,
        },
        Ok(Some(false)) => {} // a symlink, directory or anything else is not ours to delete
        Ok(None) => {}
        Err(_) => out.failed += 1,
    }
}

/// Test-only seam: runs right after the folder was validated, i.e. exactly inside the window a
/// folder swap would exploit. Compiled out of production builds.
#[cfg(test)]
thread_local! {
    pub(crate) static AFTER_FOLDER_CHECK: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn after_folder_check() {
    AFTER_FOLDER_CHECK.with(|h| {
        if let Some(f) = h.borrow().as_ref() {
            f();
        }
    });
}

/// Remove the legacy conversation files from `dir` (`<app_data_dir>/conversations`; may be absent).
pub fn cleanup(dir: Option<&Path>) -> Outcome {
    let mut out = Outcome::default();
    let Some(dir) = dir else {
        return out;
    };
    // The directory itself is Koda's own leaf, but only a REAL directory is ours to empty: a
    // symlink (the user pointed it elsewhere) or anything else is refused, never followed. It is
    // opened once; from here on every look and delete is relative to that opened folder.
    let folder = match folder::open(dir) {
        Ok(f) => f,
        Err(OpenError::Missing | OpenError::NotOurs) => return out,
        Err(OpenError::Failed) => {
            out.failed += 1;
            return out;
        }
    };
    #[cfg(test)]
    after_folder_check();
    match folder.entries() {
        Ok(names) => {
            for name in names {
                let Some(text) = name.to_str() else {
                    continue; // `conversations.rs` only ever wrote ASCII names
                };
                if is_legacy_name(text) {
                    remove_regular(&folder, &name, &mut out);
                }
            }
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(_) => out.failed += 1,
    }
    // Only when nothing failed and nothing is left: take the now-empty directory itself too.
    if out.failed == 0 {
        match folder.entries() {
            Ok(names) if names.is_empty() => {
                drop(folder); // Windows: release the hold before removing the folder
                match fs::remove_dir(dir) {
                    Ok(()) => {}
                    Err(e) if e.kind() == ErrorKind::NotFound => {}
                    Err(_) => out.failed += 1,
                }
            }
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(_) => out.failed += 1,
        }
    }
    out
}

#[cfg(test)]
#[path = "legacy_conversations_tests.rs"]
mod tests;

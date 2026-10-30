//! Native Windows filesystem facts and writes for the hook/Pi installers (HU-047).
//!
//! Node cannot read or set an ACL, so every trust-sensitive read of facts and
//! every write of an installer-managed file goes through `abito-private-session`
//! flags backed by this module. All verdicts are fail-closed with fixed reasons.
//!
//! * `check_path` is strictly read-only.
//! * `write_private` verifies the parent chain, creates the temp file in the same
//!   directory WITH a protected owner-only DACL at creation (CREATE_NEW), writes
//!   bounded bytes, flushes, replaces atomically (MoveFileExW REPLACE_EXISTING |
//!   WRITE_THROUGH) and re-verifies the final file.
//! * Owner policy: current user SID; BUILTIN\Administrators only for an elevated token.
//! * Paths: drive-letter absolute only (`winpolicy::fs_path_ok`), reparse points
//!   refused on every component.

/// Largest payload `--write-private` accepts (matches the installers' 1 MiB file cap).
pub const MAX_WRITE: usize = 1024 * 1024;

/// Fixed refusal reasons surfaced to Ajustes (never paths, never content).
pub const REASONS: [&str; 9] = ["unsafe_path", "not_private", "reparse", "exists", "missing", "mismatch", "too_large", "busy", "io"];

#[cfg(windows)]
pub mod ffi {
    use super::MAX_WRITE;
    use crate::winipc::ffi::{current_user_sid, last_error, owner_and_dacl, plain_path, prepare_private_directory, wide};
    use crate::winpolicy::{install_acl_private, Expect, FsCommand};
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::Path;
    use windows_sys::Win32::Foundation::{LocalFree, HANDLE, INVALID_HANDLE_VALUE, ERROR_FILE_EXISTS, GENERIC_WRITE};
    use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, DeleteFileW, GetFileAttributesW, GetFileInformationByHandle, MoveFileExW, RemoveDirectoryW,
        BY_HANDLE_FILE_INFORMATION, CREATE_NEW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, INVALID_FILE_ATTRIBUTES, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    type Refusal = &'static str;

    pub fn token_elevated() -> Option<bool> {
        let mut token: HANDLE = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 { return None; }
        let token = unsafe { OwnedHandle::from_raw_handle(token as _) };
        let mut info = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut len = 0u32;
        let ok = unsafe { GetTokenInformation(token.as_raw_handle() as HANDLE, TokenElevation, (&mut info as *mut TOKEN_ELEVATION).cast(), std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut len) };
        (ok != 0).then_some(info.TokenIsElevated != 0)
    }

    struct Who { sid: String, elevated: bool }
    fn who() -> Result<Who, Refusal> {
        Ok(Who { sid: current_user_sid().ok_or("io")?, elevated: token_elevated().ok_or("io")? })
    }

    fn attrs(path: &Path) -> Option<u32> {
        let a = unsafe { GetFileAttributesW(wide(&path.to_string_lossy()).as_ptr()) };
        (a != INVALID_FILE_ATTRIBUTES).then_some(a)
    }

    /// Link count of an existing entry, opened WITHOUT following a reparse point.
    fn link_count(path: &Path) -> Option<u32> {
        let h = unsafe {
            CreateFileW(wide(&path.to_string_lossy()).as_ptr(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, std::ptr::null_mut())
        };
        if h == INVALID_HANDLE_VALUE { return None; }
        let h = unsafe { OwnedHandle::from_raw_handle(h as _) };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        (unsafe { GetFileInformationByHandle(h.as_raw_handle() as HANDLE, &mut info) } != 0).then_some(info.nNumberOfLinks)
    }

    fn entry_private(path: &Path, who: &Who) -> bool {
        let Some((owner, allowed)) = owner_and_dacl(path) else { return false };
        install_acl_private(&owner, &who.sid, who.elevated, Some(&allowed))
    }

    /// Parent-directory policy: plain chain (no reparse anywhere), a real directory,
    /// install owner and private principals.
    fn dir_ok(dir: &Path, who: &Who) -> bool {
        plain_path(dir) && attrs(dir).is_some_and(|a| a & FILE_ATTRIBUTE_DIRECTORY != 0) && entry_private(dir, who)
    }

    /// A regular, single-link, private file (not a directory, not reparse).
    fn file_ok(file: &Path, who: &Who) -> bool {
        plain_path(file) && attrs(file).is_some_and(|a| a & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) == 0)
            && link_count(file) == Some(1) && entry_private(file, who)
    }

    fn parent_of(path: &Path) -> Result<&Path, Refusal> { path.parent().ok_or("unsafe_path") }

    fn json_escape(s: &str) -> String { serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into()) }

    fn read_bounded(file: &Path) -> Result<Vec<u8>, Refusal> {
        let f = std::fs::File::open(file).map_err(|_| "io")?;
        let mut buf = Vec::new();
        f.take((MAX_WRITE + 1) as u64).read_to_end(&mut buf).map_err(|_| "io")?;
        if buf.len() > MAX_WRITE { return Err("too_large"); }
        Ok(buf)
    }
    fn hex(bytes: &[u8]) -> String { Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect() }

    /// Read-only. Always prints facts for the PARENT and, when it exists, the target.
    pub fn check_path(path: &str) -> Result<String, Refusal> {
        let who = who()?;
        let target = Path::new(path);
        let parent_ok = dir_ok(parent_of(target)?, &who);
        let meta = std::fs::symlink_metadata(target);
        let (exists, kind, size, mtime_ms) = match &meta {
            Ok(m) => (true, if m.is_dir() { "dir" } else if m.is_file() { "file" } else { "other" }, m.len(),
                m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, "none", 0, 0),
            Err(_) => return Err("io"),
        };
        let reparse = exists && attrs(target).is_some_and(|a| a & FILE_ATTRIBUTE_REPARSE_POINT != 0);
        let private = exists && !reparse && match kind { "file" => file_ok(target, &who), "dir" => dir_ok(target, &who), _ => false };
        let nlink = if exists && !reparse { link_count(target).unwrap_or(0) } else { 0 };
        Ok(format!("{{\"schema\":\"abito-fs/1\",\"ok\":true,\"path\":{},\"parent_ok\":{},\"exists\":{},\"kind\":\"{}\",\"reparse\":{},\"private\":{},\"nlink\":{},\"size\":{},\"mtime_ms\":{},\"elevated\":{}}}",
            json_escape(path), parent_ok, exists, kind, reparse, private, nlink, size, mtime_ms, who.elevated))
    }

    /// Creates ONE directory (parent must pass the directory policy) with a protected DACL at creation.
    /// `created:false` means it already existed and passes the policy (used as the lock primitive).
    pub fn make_dir(path: &str) -> Result<String, Refusal> {
        let who = who()?;
        let dir = Path::new(path);
        if !dir_ok(parent_of(dir)?, &who) { return Err("not_private"); }
        let existed = std::fs::symlink_metadata(dir).is_ok();
        if existed {
            if !dir_ok(dir, &who) { return Err(if attrs(dir).is_some_and(|a| a & FILE_ATTRIBUTE_REPARSE_POINT != 0) { "reparse" } else { "not_private" }); }
        } else {
            prepare_private_directory(dir, &who.sid, dir).map_err(|_| "io")?;
            if !dir_ok(dir, &who) { return Err("not_private"); }
        }
        Ok(format!("{{\"schema\":\"abito-fs/1\",\"ok\":true,\"created\":{}}}", !existed))
    }

    pub fn write_private(path: &str, expect: &Expect, data: &[u8]) -> Result<String, Refusal> {
        if data.len() > MAX_WRITE { return Err("too_large"); }
        let who = who()?;
        let target = Path::new(path);
        let dir = parent_of(target)?;
        if !dir_ok(dir, &who) { return Err("not_private"); }
        match (std::fs::symlink_metadata(target), expect) {
            (Err(e), Expect::Absent) if e.kind() == std::io::ErrorKind::NotFound => {}
            (Err(e), Expect::Sha256(_)) if e.kind() == std::io::ErrorKind::NotFound => return Err("missing"),
            (Err(_), _) => return Err("io"),
            (Ok(_), Expect::Absent) => return Err("exists"),
            (Ok(_), Expect::Sha256(want)) => {
                if attrs(target).is_some_and(|a| a & FILE_ATTRIBUTE_REPARSE_POINT != 0) { return Err("reparse"); }
                if !file_ok(target, &who) { return Err("not_private"); }
                if &hex(&read_bounded(target)?) != want { return Err("mismatch"); }
            }
        }
        let name = target.file_name().ok_or("unsafe_path")?.to_string_lossy().into_owned();
        let sddl = crate::winipc::sddl_owner_full(&who.sid).ok_or("io")?;
        let sddl_w = wide(&sddl);
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl_w.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) } == 0 { return Err("io"); }
        let attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd, bInheritHandle: 0 };
        let mut created: Option<(std::path::PathBuf, OwnedHandle)> = None;
        for attempt in 0..8u32 {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
            let candidate = dir.join(format!(".{name}.abito-tmp-{}-{nonce}-{attempt}", std::process::id()));
            let h = unsafe { CreateFileW(wide(&candidate.to_string_lossy()).as_ptr(), GENERIC_WRITE, 0, &attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut()) };
            if h != INVALID_HANDLE_VALUE { created = Some((candidate, unsafe { OwnedHandle::from_raw_handle(h as _) })); break; }
            if last_error().raw_os_error() != Some(ERROR_FILE_EXISTS as i32) { break; }
        }
        unsafe { LocalFree(sd.cast()) };
        let (tmp, handle) = created.ok_or("io")?;
        let result = (|| -> Result<(), Refusal> {
            let mut f = std::fs::File::from(handle);
            f.write_all(data).map_err(|_| "io")?;
            f.sync_all().map_err(|_| "io")?;
            drop(f);
            // Final guard right before the swap: the directory must still be ours and private.
            if !dir_ok(dir, &who) { return Err("not_private"); }
            if unsafe { MoveFileExW(wide(&tmp.to_string_lossy()).as_ptr(), wide(path).as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 { return Err("io"); }
            Ok(())
        })();
        if let Err(e) = result { let _ = std::fs::remove_file(&tmp); return Err(e); }
        if !file_ok(target, &who) { return Err("not_private"); }
        if hex(&read_bounded(target)?) != hex(data) { return Err("mismatch"); }
        Ok(format!("{{\"schema\":\"abito-fs/1\",\"ok\":true,\"sha256\":\"{}\",\"size\":{}}}", hex(data), data.len()))
    }

    /// Rename within ONE volume and ONE private parent chain each; never replaces, never copies.
    pub fn move_entry(from: &str, to: &str) -> Result<String, Refusal> {
        let who = who()?;
        let (src, dst) = (Path::new(from), Path::new(to));
        if from.as_bytes()[0].to_ascii_lowercase() != to.as_bytes()[0].to_ascii_lowercase() { return Err("unsafe_path"); }
        if !dir_ok(parent_of(src)?, &who) || !dir_ok(parent_of(dst)?, &who) { return Err("not_private"); }
        let a = attrs(src).ok_or("missing")?;
        if a & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err("reparse"); }
        let ok = if a & FILE_ATTRIBUTE_DIRECTORY != 0 { dir_ok(src, &who) } else { file_ok(src, &who) };
        if !ok { return Err("not_private"); }
        if std::fs::symlink_metadata(dst).is_ok() { return Err("exists"); }
        if unsafe { MoveFileExW(wide(from).as_ptr(), wide(to).as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 { return Err("io"); }
        Ok("{\"schema\":\"abito-fs/1\",\"ok\":true}".into())
    }

    /// Deletes one file or one EMPTY directory that passes the policy. Never recursive.
    pub fn delete_entry(path: &str) -> Result<String, Refusal> {
        let who = who()?;
        let t = Path::new(path);
        if !dir_ok(parent_of(t)?, &who) { return Err("not_private"); }
        let a = attrs(t).ok_or("missing")?;
        if a & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err("reparse"); }
        let dir = a & FILE_ATTRIBUTE_DIRECTORY != 0;
        if !(if dir { dir_ok(t, &who) } else { file_ok(t, &who) }) { return Err("not_private"); }
        let done = unsafe { if dir { RemoveDirectoryW(wide(path).as_ptr()) } else { DeleteFileW(wide(path).as_ptr()) } };
        if done == 0 { return Err("io"); }
        Ok("{\"schema\":\"abito-fs/1\",\"ok\":true}".into())
    }

    pub fn run(cmd: &FsCommand, stdin: &mut impl Read) -> Result<String, Refusal> {
        match cmd {
            FsCommand::CheckPath(p) => check_path(p),
            FsCommand::MakeDir(p) => make_dir(p),
            FsCommand::Delete(p) => delete_entry(p),
            FsCommand::Move { from, to } => move_entry(from, to),
            FsCommand::WritePrivate { path, expect } => {
                let mut buf = Vec::new();
                stdin.take((MAX_WRITE + 1) as u64).read_to_end(&mut buf).map_err(|_| "io")?;
                write_private(path, expect, &buf)
            }
        }
    }
}

#[cfg(all(test, windows))]
mod native_tests {
    use super::ffi::*;
    use crate::winpolicy::Expect;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        // Never under %LOCALAPPDATA%\Abito (the installed smoke refuses a runner that already has it):
        // a fresh child of the temp dir with our own protected DACL.
        let dir = std::env::temp_dir().join(format!("abito-fs-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sid = crate::winipc::ffi::current_user_sid().unwrap();
        crate::winipc::ffi::prepare_runtime(&dir, &sid).unwrap();
        dir
    }
    fn p(dir: &std::path::Path, n: &str) -> String { dir.join(n).to_string_lossy().into_owned() }

    #[test]
    fn write_private_creates_replaces_and_guards_expectation() {
        let d = temp_dir("w");
        let f = p(&d, "settings.json");
        assert!(write_private(&f, &Expect::Absent, b"{}\n").is_ok());
        assert!(check_path(&f).unwrap().contains("\"private\":true"));
        assert_eq!(write_private(&f, &Expect::Absent, b"x").unwrap_err(), "exists");
        assert_eq!(write_private(&f, &Expect::Sha256("0".repeat(64)), b"x").unwrap_err(), "mismatch");
        let h = { use sha2::{Digest, Sha256}; Sha256::digest(b"{}\n").iter().map(|b| format!("{b:02x}")).collect::<String>() };
        assert!(write_private(&f, &Expect::Sha256(h), b"{\"a\":1}\n").is_ok());
        assert_eq!(std::fs::read(&f).unwrap(), b"{\"a\":1}\n");
        assert_eq!(write_private(&p(&d, "big"), &Expect::Absent, &vec![0u8; super::MAX_WRITE + 1]).unwrap_err(), "too_large");
        let leftovers: Vec<_> = std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(leftovers, vec!["settings.json".to_string()]);
    }

    #[test]
    fn a_junction_parent_or_target_is_refused() {
        let d = temp_dir("j");
        let real = d.join("real");
        std::fs::create_dir(&real).ok();
        let link = d.join("link");
        let ok = std::process::Command::new("cmd").args(["/C", "mklink", "/J", &link.to_string_lossy(), &real.to_string_lossy()]).output().map(|o| o.status.success()).unwrap_or(false);
        assert!(ok, "mklink /J must work on the runner");
        assert!(write_private(&p(&link, "x.json"), &Expect::Absent, b"{}").is_err());
        assert!(check_path(&p(&d, "link")).unwrap().contains("\"reparse\":true"));
        assert!(move_entry(&p(&d, "link"), &p(&d, "other")).is_err());
        assert!(delete_entry(&p(&d, "link")).is_err());
    }

    #[test]
    fn move_never_replaces_and_make_dir_is_idempotent_for_private_dirs() {
        let d = temp_dir("m");
        let (a, b) = (p(&d, "a.txt"), p(&d, "b.txt"));
        write_private(&a, &Expect::Absent, b"1").unwrap();
        write_private(&b, &Expect::Absent, b"2").unwrap();
        assert_eq!(move_entry(&a, &b).unwrap_err(), "exists");
        assert!(move_entry(&a, &p(&d, "c.txt")).is_ok());
        assert!(make_dir(&p(&d, "sub")).unwrap().contains("\"created\":true"));
        assert!(make_dir(&p(&d, "sub")).unwrap().contains("\"created\":false"));
        assert!(delete_entry(&p(&d, "sub")).is_ok());
    }
}

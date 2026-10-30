//! Win32 IPC primitives for the Windows notice transport — T2/S3/S6.
//!
//! Two halves, kept deliberately apart:
//!
//! * **Pure policy** (every target, unit-tested on Linux CI): pipe-name shape,
//!   SDDL text, discovery-metadata shape (closed key set), and the ACL
//!   verdicts that decide who may ever be trusted. Failing closed is decided
//!   HERE, so Linux tests exercise the same decisions the Windows runtime
//!   makes.
//! * **FFI half** (`#[cfg(windows)]`): token/SID queries, directory and file
//!   ACL reads, the protected-DACL named-pipe server, atomic metadata
//!   publication and bounded overlapped writes. Every API failure refuses.
//!
//! No helper here ever *grants* trust: the pipe server proves the client's
//! pid+SID before a byte is processed, the relay proves the server's pid+SID
//! and the metadata file's owner-only ACL before a byte is forwarded, and the
//! metadata is published with an explicit protected owner-only DACL.
//!
//! These helpers are the minimal coherent interface the daemon session ACL
//! hardening will reuse later (same SID/ACL/verdict vocabulary as
//! `agentconn_win.rs`, without touching that file).

use serde_json::{json, Value};

/// `%LOCALAPPDATA%\Abito\<NOTICES_LEAF>` — discovery metadata root.
pub const NOTICES_LEAF: &str = "notices";
/// Discovery metadata format version (the only one parsed).
pub const META_VERSION: u32 = 1;
/// Fixed pipe-name prefix: `\\.\pipe\abito-notice-<SID>-<32 hex>`.
pub const PIPE_PREFIX: &str = r"\\.\pipe\abito-notice-";

/// `S-1-<authority>-<subauthority>…` — decimal, no empty components.
pub fn sid_shape_ok(sid: &str) -> bool {
    let rest = match sid.strip_prefix("S-") {
        Some(rest) => rest,
        None => return false,
    };
    let mut parts = rest.split('-');
    parts.next().is_some_and(|a| !a.is_empty() && a.bytes().all(|b| b.is_ascii_digit()))
        && parts.all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && sid.len() <= 68 // max SID string form (15 subauthorities)
}

fn instance_hex_ok(hex: &str) -> bool {
    hex.len() == 32 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The exact pipe name this receiver owns, for SID `sid` and a 128-bit
/// instance given as 32 lowercase hex characters. `None` on any malformed
/// input — never a name guessed from unvalidated parts.
pub fn pipe_name_for(sid: &str, instance_hex: &str) -> Option<String> {
    if !sid_shape_ok(sid) || !instance_hex_ok(instance_hex) {
        return None;
    }
    Some(format!("{PIPE_PREFIX}{sid}-{instance_hex}"))
}

/// Shape check for a receiver pipe name. Remote (`\\server\pipe\…`) names,
/// foreign prefixes and any malformed SID/instance are refused.
pub fn pipe_name_ok(name: &str) -> bool {
    let rest = match name.strip_prefix(PIPE_PREFIX) {
        Some(rest) => rest,
        None => return false,
    };
    let (sid, hex) = match rest.rsplit_once('-') {
        Some(parts) => parts,
        None => return false,
    };
    sid_shape_ok(sid) && instance_hex_ok(hex)
}

/// The explicit protected DACL the pipe server and the metadata file get:
/// owner-only generic-all, no inheritance. `None` on a malformed SID.
pub fn sddl_owner_full(sid: &str) -> Option<String> {
    sid_shape_ok(sid).then(|| format!("O:{sid}D:P(A;;GA;;;{sid})"))
}

/// Discovery metadata for the notice receiver. `pipe` embeds `sid`; readers
/// re-check that binding, so a tampered file cannot point at a foreign pipe
/// while keeping a plausible owner SID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointMeta {
    pub v: u32,
    pub pipe: String,
    pub pid: u32,
    pub sid: String,
}

impl EndpointMeta {
    pub fn new(pipe: String, pid: u32, sid: String) -> Option<Self> {
        if !pipe_name_ok(&pipe) || !sid_shape_ok(&sid) || pid == 0 {
            return None;
        }
        let embedded = pipe
            .strip_prefix(PIPE_PREFIX)
            .and_then(|rest| rest.rsplit_once('-'))
            .map(|(sid, _)| sid.to_owned())?;
        if embedded != sid {
            return None;
        }
        Some(EndpointMeta { v: META_VERSION, pipe, pid, sid })
    }

    /// Closed key set: `v`, `pipe`, `pid`, `sid` — exactly these four.
    pub fn to_json(&self) -> String {
        json!({"v": self.v, "pipe": self.pipe, "pid": self.pid, "sid": self.sid}).to_string()
    }

    /// Parse with the full shape rules; anything else is `None`.
    pub fn parse(text: &str) -> Option<Self> {
        let v: Value = serde_json::from_str(text).ok()?;
        let map = v.as_object()?;
        if map.len() != 4 || map.get("v") != Some(&json!(META_VERSION)) {
            return None;
        }
        let pipe = map.get("pipe")?.as_str()?.to_owned();
        let pid = map.get("pid")?.as_u64().filter(|p| *p > 0 && *p <= u32::MAX as u64)? as u32;
        let sid = map.get("sid")?.as_str()?.to_owned();
        EndpointMeta::new(pipe, pid, sid)
    }
}

/// A DACL is owner-only when its owner is the caller and every understood
/// entry names the caller and nobody else. A missing DACL (everyone access)
/// is refused; the native reader checks allow and deny principals. STRICTER than
/// [`crate::winpolicy::dacl_private`]: not even SYSTEM or Administrators are
/// accepted, because we always publish with an explicit protected DACL that
/// grants exactly the owner.
pub fn dacl_owner_only(owner: &str, current_user: &str, allowed_entries: Option<&[String]>) -> bool {
    if owner != current_user {
        return false;
    }
    let Some(entries) = allowed_entries else { return false };
    entries.iter().all(|sid| sid == current_user)
}

/// Wire-level admission verdict for the pipe server: the client's own-user
/// proof must be present AND match. `None` (any API failure on pid/token)
/// refuses — failing closed happens here, not in the caller.
pub fn client_admitted(own_sid: &str, client_sid: Option<&str>) -> bool {
    client_sid == Some(own_sid)
}

// ---- Windows FFI half (fail closed on every API failure) -------------------

#[cfg(windows)]
pub mod ffi {
    use super::*;
    use crate::winpolicy;
    use std::fs::File;
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::Path;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{
        GetLastError, LocalFree, HANDLE, INVALID_HANDLE_VALUE, NTSTATUS, GENERIC_WRITE,
        ERROR_BROKEN_PIPE, ERROR_FILE_EXISTS, ERROR_IO_PENDING, ERROR_PIPE_BUSY,
        ERROR_PIPE_CONNECTED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        ConvertStringSidToSidW, GetNamedSecurityInfoW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    use windows_sys::Win32::Security::{
        GetAce, GetAclInformation, GetSecurityDescriptorDacl, GetTokenInformation, AclSizeInformation,
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PROTECTED_DACL_SECURITY_INFORMATION,
        PSID, SECURITY_ATTRIBUTES, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, GetFileAttributesW, MoveFileExW, ReadFile, WriteFile, CREATE_NEW,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, INVALID_FILE_ATTRIBUTES,
        MOVEFILE_REPLACE_EXISTING, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId,
        GetNamedPipeServerProcessId, PeekNamedPipe, PIPE_READMODE_BYTE,
        PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
        PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
        ResetEvent, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    /// Discovery metadata file name (the Windows analogue of the Unix
    /// `<runtime>/endpoint.json`; this target's `handoff` is unavailable).
    pub const ENDPOINT_FILE: &str = "endpoint.json";
    const MAX_META_FILE: u64 = 4096;
    const PIPE_BUFFER: u32 = 8192;

    pub(crate) fn wide(text: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt as _;
        std::ffi::OsStr::new(text).encode_wide().chain(Some(0)).collect()
    }

    pub(crate) fn last_error() -> io::Error {
        io::Error::from_raw_os_error(unsafe { GetLastError() } as i32)
    }

    pub fn current_pid() -> u32 {
        unsafe { GetCurrentProcessId() }
    }

    /// 128 random bits as 32 lowercase hex characters (the pipe instance).
    pub fn random_instance_hex() -> Option<String> {
        let mut bytes = [0u8; 16];
        let status: NTSTATUS =
            unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), 16, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
        (status == 0).then(|| bytes.iter().map(|b| format!("{b:02x}")).collect())
    }

    /// This process token's user SID, string form. `None` = no proof, refuse.
    pub fn current_user_sid() -> Option<String> {
        let mut token: HANDLE = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        let token = unsafe { OwnedHandle::from_raw_handle(token as _) };
        token_user_sid_string(token.as_raw_handle() as HANDLE)
    }

    /// SID of the user running `pid`, or None (fail closed) if it cannot be
    /// opened. Callers keep the process handle for PID-reuse safety.
    pub fn open_process_with_user(pid: u32) -> Option<(OwnedHandle, String)> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() || process == INVALID_HANDLE_VALUE {
            return None;
        }
        let process = unsafe { OwnedHandle::from_raw_handle(process as _) };
        let mut token: HANDLE = std::ptr::null_mut();
        if unsafe { OpenProcessToken(process.as_raw_handle() as HANDLE, TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        let token = unsafe { OwnedHandle::from_raw_handle(token as _) };
        let sid = token_user_sid_string(token.as_raw_handle() as HANDLE)?;
        Some((process, sid))
    }

    pub fn process_user_sid(pid: u32) -> Option<String> {
        open_process_with_user(pid).map(|(_, sid)| sid)
    }

    fn token_user_sid_string(token: HANDLE) -> Option<String> {
        let mut needed = 0u32;
        unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
        if needed == 0 || needed > 4096 {
            return None;
        }
        // Aligned buffer: TOKEN_USER begins with a pointer.
        let mut aligned = vec![0u64; (needed as usize) / 8 + 2];
        let ok = unsafe {
            GetTokenInformation(token, TokenUser, aligned.as_mut_ptr().cast(), (aligned.len() * 8) as u32, &mut needed)
        };
        if ok == 0 {
            return None;
        }
        let user = unsafe { &*(aligned.as_ptr() as *const TOKEN_USER) };
        sid_to_string(user.User.Sid)
    }

    fn sid_to_string(sid: PSID) -> Option<String> {
        let mut wide: *mut u16 = std::ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut wide) } == 0 || wide.is_null() {
            return None;
        }
        let mut len = 0;
        while unsafe { *wide.add(len) } != 0 {
            len += 1;
            if len > 256 {
                unsafe { LocalFree(wide.cast()) };
                return None;
            }
        }
        let text = String::from_utf16(unsafe { std::slice::from_raw_parts(wide, len) }).ok();
        unsafe { LocalFree(wide.cast()) };
        text
    }

    pub fn process_alive(pid: u32) -> bool {
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() || process == INVALID_HANDLE_VALUE {
            return false;
        }
        let process = unsafe { OwnedHandle::from_raw_handle(process as _) };
        unsafe { WaitForSingleObject(process.as_raw_handle() as HANDLE, 0) == WAIT_TIMEOUT }
    }

    /// Owner + DACL of a file or directory against policy: `owner_only` uses
    /// the strict metadata verdict, otherwise the winpolicy private verdict
    /// (user or Administrators owner; user/SYSTEM/Administrators principals).
    /// Any API failure, NULL DACL or reparse path refuses.
    pub fn directory_private(target: &Path, current: &str, owner_only: bool) -> bool {
        if !plain_path(target) { return false; }
        let attributes = unsafe { GetFileAttributesW(wide(&target.to_string_lossy()).as_ptr()) };
        if !owner_only && attributes & FILE_ATTRIBUTE_DIRECTORY == 0 { return false; }
        let Some((owner, allowed)) = owner_and_dacl(target) else { return false };
        if owner_only {
            dacl_owner_only(&owner, current, Some(&allowed))
        } else {
            winpolicy::dacl_private(&owner, current, Some(&allowed))
        }
    }

    /// Read-only config-file policy: unlike directory_private this requires a
    /// regular file and allows only user/SYSTEM/Administrators DACL principals.
    /// No ACL repair and no reparse ancestors.
    pub fn config_file_private(target: &Path, current: &str) -> bool {
        if !plain_path(target) { return false; }
        let attributes = unsafe { GetFileAttributesW(wide(&target.to_string_lossy()).as_ptr()) };
        if attributes == INVALID_FILE_ATTRIBUTES || attributes & FILE_ATTRIBUTE_DIRECTORY != 0 { return false; }
        let Some((owner, allowed)) = owner_and_dacl(target) else { return false; };
        winpolicy::dacl_private(&owner, current, Some(&allowed))
    }

    pub(crate) fn owner_and_dacl(target: &Path) -> Option<(String, Vec<String>)> {
        let wide = wide(&target.to_string_lossy());
        let (mut owner, mut dacl, mut descriptor) =
            (std::ptr::null_mut(), std::ptr::null_mut::<ACL>(), std::ptr::null_mut());
        let status = unsafe {
            GetNamedSecurityInfoW(
                wide.as_ptr(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner, std::ptr::null_mut(), &mut dacl, std::ptr::null_mut(), &mut descriptor,
            )
        };
        if status != 0 {
            return None;
        }
        let verdict = (|| {
            let owner = sid_to_string(owner)?;
            // NULL DACL grants Everyone full control, unlike an empty DACL.
            // Refuse before collecting entries for BOTH file and directory policy.
            if dacl.is_null() { return None; }
            let mut allowed = Vec::new();
            if !dacl.is_null() {
                let mut info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
                if unsafe {
                    GetAclInformation(dacl, (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                        std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation)
                } == 0
                {
                    return None;
                }
                for index in 0..info.AceCount {
                    let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
                    if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
                        return None;
                    }
                    let header = unsafe { &*(ace as *const ACE_HEADER) };
                    match header.AceType {
                        0 | 1 => { // Standard allow/deny ACEs share the SID layout.
                            let ace = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
                            allowed.push(sid_to_string((&ace.SidStart as *const u32).cast_mut().cast())?);
                        }
                        _ => return None, // object/callback/unknown ACEs: not understood, refuse
                    }
                }
            }
            Some((owner, allowed))
        })();
        unsafe { LocalFree(descriptor) };
        verdict
    }


    /// Never follow a junction, symlink or other reparse point, including in
    /// ancestors. Shared by daemon file checks and receiver directory checks.
    pub(crate) fn plain_path(target: &Path) -> bool {
        target.is_absolute() && target.ancestors().all(|path| {
            let attributes = unsafe { GetFileAttributesW(wide(&path.to_string_lossy()).as_ptr()) };
            attributes != INVALID_FILE_ATTRIBUTES && attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
        })
    }

    /// Create missing directories with an explicit owner and protected DACL
    /// AT CREATION, never an inherited-ACL window followed by chmod/ACL repair.
    /// Existing directories are checked, never rewritten.
    pub fn prepare_runtime(root: &Path, sid: &str) -> io::Result<()> {
        // Profile ancestors are not ours: their ACLs may contain legitimate
        // domain/capability entries. Only Abito and its descendants use our
        // private policy; every path component still rejects reparse points.
        let canonical = winpolicy::island_root(None, std::env::var("LOCALAPPDATA").ok().as_deref());
        let boundary = canonical.as_deref().filter(|base| root.starts_with(base)).unwrap_or(root);
        if boundary != root { prepare_private_directory(boundary, sid, boundary)?; }
        prepare_private_directory(root, sid, boundary)
    }

    pub(crate) fn prepare_private_directory(root: &Path, sid: &str, boundary: &Path) -> io::Result<()> {
        if !root.is_absolute() || !sid_shape_ok(sid) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid private directory identity"));
        }
        match std::fs::symlink_metadata(root) {
            Ok(meta) => {
                if root != boundary && root.starts_with(boundary) {
                    let parent = root.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "directory has no parent"))?;
                    prepare_private_directory(parent, sid, boundary)?;
                }
                let accepted = if root.starts_with(boundary) {
                    directory_private(root, sid, false)
                } else {
                    meta.is_dir() && plain_path(root)
                };
                if !accepted {
                    return Err(io::Error::new(io::ErrorKind::PermissionDenied, "runtime root is not a private directory of ours"));
                }
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let parent = root.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "directory has no parent"))?;
        prepare_private_directory(parent, sid, boundary)?;
        let descriptor = wide(&format!("O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)"));
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) } == 0 {
            return Err(last_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: 0,
        };
        let created = unsafe { CreateDirectoryW(wide(&root.to_string_lossy()).as_ptr(), &attributes) };
        let error = last_error();
        unsafe { LocalFree(sd.cast()); }
        // A concurrent creator gets no ACL rewrite: accept only if its directory
        // independently passes the same policy, otherwise fail closed.
        if created == 0 && error.kind() != io::ErrorKind::AlreadyExists { return Err(error); }
        if !directory_private(root, sid, false) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "created runtime directory is not private"));
        }
        Ok(())
    }

    /// Explicit protected owner-only DACL (O:<sid>D:P(A;;GA;;;<sid>)) on a
    /// file. PROTECTED_DACL blocks inheritance from widening it again.
    /// Reusable seam for the daemon session ACL hardening (session.json and
    /// the future native daemon-secret helper).
    pub fn set_owner_only_acl(path: &Path, sid: &str) -> io::Result<()> {
        let Some(sddl) = super::sddl_owner_full(sid) else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "bad sid"));
        };
        let sddl_wide = wide(&sddl);
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl_wide.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) } == 0 {
            return Err(last_error());
        }
        let result = (|| {
            let (mut present, mut defaulted) = (0, 0);
            let mut dacl: *mut ACL = std::ptr::null_mut();
            if unsafe { GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) } == 0 || present == 0 {
                return Err(last_error());
            }
            let sid_wide = wide(sid);
            let mut psid: PSID = std::ptr::null_mut();
            if unsafe { ConvertStringSidToSidW(sid_wide.as_ptr(), &mut psid) } == 0 {
                return Err(last_error());
            }
            let path_wide = wide(&path.to_string_lossy());
            let status = unsafe {
                SetNamedSecurityInfoW(
                    path_wide.as_ptr(), SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    psid, std::ptr::null_mut(), dacl, std::ptr::null_mut(),
                )
            };
            unsafe { LocalFree(psid) };
            if status != 0 {
                return Err(io::Error::from_raw_os_error(status as i32));
            }
            Ok(())
        })();
        unsafe { LocalFree(sd) };
        result
    }

    /// Create the pipe server with the explicit protected owner-only DACL.
    /// `first` adds FILE_FLAG_FIRST_PIPE_INSTANCE (name-squat guard): creation
    /// fails when ANY instance of the name already exists.
    ///
    /// B1: every server handle is opened FILE_FLAG_OVERLAPPED — all Connect/
    /// Read/Write on it carry an OVERLAPPED, which is what makes every wait
    /// cancellable and every shutdown drainable (see `cancel_and_drain`).
    pub fn create_server_pipe(name: &str, sid: &str, first: bool) -> io::Result<OwnedHandle> {
        let Some(sddl) = super::sddl_owner_full(sid) else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "bad sid"));
        };
        let sddl_wide = wide(&sddl);
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl_wide.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) } == 0 {
            return Err(last_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: 0,
        };
        let name_wide = wide(name);
        let open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
        let pipe_mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
        let handle = unsafe {
            CreateNamedPipeW(name_wide.as_ptr(), open_mode, pipe_mode, PIPE_UNLIMITED_INSTANCES,
                PIPE_BUFFER, PIPE_BUFFER, 0, &attributes)
        };
        unsafe { LocalFree(sd) };
        if handle == INVALID_HANDLE_VALUE {
            return Err(last_error());
        }
        Ok(unsafe { OwnedHandle::from_raw_handle(handle as _) })
    }

    /// A manual-reset event for overlapped I/O.
    pub fn create_manual_event() -> io::Result<OwnedHandle> {
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() || event == INVALID_HANDLE_VALUE {
            return Err(last_error());
        }
        Ok(unsafe { OwnedHandle::from_raw_handle(event as _) })
    }

    /// B2 cancellation primitive: cancel the pending overlapped operation,
    /// then WAIT for the kernel to complete (abort) the very same OVERLAPPED
    /// before returning. Until GetOverlappedResult(bWait=TRUE) has returned,
    /// the kernel may still reference the OVERLAPPED, its event and the
    /// buffers the operation was issued with — dropping any of them earlier is
    /// a use-after-free. No guarantee is made about WHO completed the
    /// operation or with what status: the caller only learns it is no longer
    /// pending (drained), which is exactly the invariant dropping needs.
    fn cancel_and_drain(handle: HANDLE, overlapped: &OVERLAPPED) {
        unsafe { CancelIoEx(handle, overlapped) };
        let mut written = 0u32;
        // bWait=TRUE: wait for the completion/abortion itself. If the operation
        // already completed, this returns immediately with its status.
        unsafe { GetOverlappedResult(handle, overlapped, &mut written, 1) };
    }

    /// Bounded overlapped write: never blocks past `timeout`. Immediate
    /// completion (no ERROR_IO_PENDING) never waits on the event; a timeout or
    /// failed wait cancels AND DRAINS before the OVERLAPPED/event/buffer drop.
    pub fn write_bounded(handle: HANDLE, bytes: &[u8], timeout: Duration) -> io::Result<()> {
        if bytes.len() > u32::MAX as usize {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "write too large"));
        }
        let event = create_manual_event()?;
        let result = (|| {
            let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
            overlapped.hEvent = event.as_raw_handle() as HANDLE;
            let ok = unsafe {
                WriteFile(handle, bytes.as_ptr(), bytes.len() as u32, std::ptr::null_mut(), &mut overlapped)
            };
            if ok == 0 {
                let error = unsafe { GetLastError() };
                if error != ERROR_IO_PENDING {
                    // Never pended: the kernel holds no OVERLAPPED reference.
                    return Err(io::Error::from_raw_os_error(error as i32));
                }
            } else {
                // Completed synchronously: done, nothing to wait for or drain.
                let mut written = 0u32;
                if unsafe { GetOverlappedResult(handle, &overlapped, &mut written, 0) } == 0 {
                    return Err(last_error());
                }
                return if written as usize == bytes.len() { Ok(()) }
                    else { Err(io::Error::new(io::ErrorKind::WriteZero, "partial pipe write")) };
            }
            let wait = unsafe { WaitForSingleObject(event.as_raw_handle() as HANDLE, timeout.as_millis().min(u32::MAX as u128) as u32) };
            if wait != WAIT_OBJECT_0 {
                // B2: cancel AND drain before the OVERLAPPED/event/borrowed
                // buffer may drop; the caller then reuses or closes freely.
                cancel_and_drain(handle, &overlapped);
                return Err(io::Error::new(io::ErrorKind::TimedOut, "write deadline"));
            }
            let mut written = 0u32;
            if unsafe { GetOverlappedResult(handle, &overlapped, &mut written, 0) } == 0 {
                return Err(last_error());
            }
            if written as usize != bytes.len() {
                return Err(io::Error::new(io::ErrorKind::WriteZero, "partial pipe write"));
            }
            Ok(())
        })();
        drop(event);
        result
    }

    /// Cancel every pending overlapped I/O on `handle` (shutdown path).
    pub fn cancel_io(handle: HANDLE) {
        unsafe { CancelIoEx(handle, std::ptr::null()) };
    }

    /// Client-side admission proof for the pipe SERVER: the client's pid and
    /// its process SID. `None` = any API failure or a foreign user. The process
    /// handle is retained (PID-reuse safety) and dropped with the proof.
    pub struct ClientProof {
        pub pid: u32,
        /// Kept open: a closed handle would let the pid be recycled unnoticed.
        pub _process: OwnedHandle,
    }

    pub fn verified_client(handle: HANDLE, own_sid: &str) -> Option<ClientProof> {
        let mut pid = 0u32;
        if unsafe { GetNamedPipeClientProcessId(handle, &mut pid) } == 0 || pid == 0 {
            return None;
        }
        let (process, sid) = open_process_with_user(pid)?;
        if !client_admitted(own_sid, Some(&sid)) {
            return None;
        }
        Some(ClientProof { pid, _process: process })
    }

    /// The pid of the process that created this pipe (relay-side server check).
    pub fn server_pid(handle: HANDLE) -> Option<u32> {
        let mut pid = 0u32;
        (unsafe { GetNamedPipeServerProcessId(handle, &mut pid) } != 0 && pid > 0).then_some(pid)
    }

    /// Open a client end of the named pipe, retrying ERROR_PIPE_BUSY within
    /// `timeout`. B1: opened FILE_FLAG_OVERLAPPED — reads/writes on it must
    /// use `read_bounded_overlapped`/`write_bounded`, never plain std I/O.
    pub fn open_client(name: &str, timeout: Duration) -> io::Result<File> {
        use std::os::windows::fs::OpenOptionsExt;
        let deadline = std::time::Instant::now() + timeout;
        loop {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(FILE_FLAG_OVERLAPPED)
                .open(name)
            {
                Ok(file) => return Ok(file),
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {}
                Err(error) => return Err(error),
            }
            if std::time::Instant::now() >= deadline {
                return Err(io::Error::from_raw_os_error(ERROR_PIPE_BUSY as i32));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Bounded server-side accept: overlapped ConnectNamedPipe with the drain
    /// discipline (B2). `Ok` = a client is connected; ERROR_PIPE_CONNECTED and
    /// synchronous completion return immediately instead of waiting on an
    /// event that will never be signalled; a timeout cancels AND drains before
    /// returning, so the caller may reuse or close the handle right away.
    pub fn connect_and_wait(handle: HANDLE, timeout: Duration) -> io::Result<()> {
        let event = create_manual_event()?;
        let result = (|| {
            let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
            overlapped.hEvent = event.as_raw_handle() as HANDLE;
            let ok = unsafe { ConnectNamedPipe(handle, &mut overlapped) };
            if ok == 0 {
                match unsafe { GetLastError() } {
                    ERROR_IO_PENDING => {}
                    // A client connected before the call: never pended.
                    ERROR_PIPE_CONNECTED => return Ok(()),
                    error => return Err(io::Error::from_raw_os_error(error as i32)),
                }
            } else {
                // Completed synchronously: done, nothing to wait for or drain.
                return Ok(());
            }
            let wait = unsafe { WaitForSingleObject(event.as_raw_handle() as HANDLE, timeout.as_millis().min(u32::MAX as u128) as u32) };
            if wait != WAIT_OBJECT_0 {
                cancel_and_drain(handle, &overlapped);
                return Err(io::Error::new(io::ErrorKind::TimedOut, "accept deadline"));
            }
            let mut written = 0u32;
            if unsafe { GetOverlappedResult(handle, &overlapped, &mut written, 0) } == 0 {
                return Err(last_error());
            }
            Ok(())
        })();
        drop(event);
        result
    }

    /// Create-or-replace a private file whose owner-only protected DACL is in
    /// place AT CREATION TIME (B3): the temp is created with CreateFileW
    /// (CREATE_NEW, share-none, non-inheritable SECURITY_ATTRIBUTES carrying
    /// the SDDL O:<sid>D:P(A;;GA;;;<sid>) descriptor) — no byte is written
    /// before that DACL exists, so no other user can ever open the file, not
    /// even transiently. The full file is then atomically moved over `path`
    /// (same-volume rename keeps the descriptor).
    ///
    /// Refuses symlink/reparse-point/directory targets. Temp names are unique
    /// per attempt; a pre-existing temp is NEVER removed (we only ever delete
    /// the file this very call created). Reusable seam for the daemon session
    /// ACL hardening (session.json, daemon secrets).
    pub fn private_file_bytes(path: &Path, bytes: &[u8], sid: &str) -> io::Result<()> {
        if let Ok(existing) = std::fs::symlink_metadata(path) {
            if existing.file_type().is_symlink() || !existing.file_type().is_file() {
                return Err(io::Error::new(io::ErrorKind::AlreadyExists, "refusing to replace a symlink or non-file"));
            }
        }
        let attrs = unsafe { GetFileAttributesW(wide(&path.to_string_lossy()).as_ptr()) };
        if attrs != INVALID_FILE_ATTRIBUTES
            && (attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 || attrs & FILE_ATTRIBUTE_DIRECTORY != 0)
        {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "refusing to replace a reparse point or directory"));
        }
        let dir = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent directory"))?.to_path_buf();
        let name = path.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?.to_string_lossy().into_owned();
        let Some(sddl) = super::sddl_owner_full(sid) else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "bad sid"));
        };
        let sddl_wide = wide(&sddl);
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl_wide.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) } == 0 {
            return Err(last_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: 0, // non-inheritable: no child ever gets this handle
        };
        // Unique temp per attempt; a name collision means a pre-existing file
        // we do NOT own — never deleted, just side-stepped.
        let mut created: Option<(std::path::PathBuf, OwnedHandle)> = None;
        for attempt in 0..8u32 {
            let candidate = dir.join(format!("{name}.{}.{}.{}.tmp", current_pid(), now_millis_fallback(), attempt));
            let handle = unsafe {
                CreateFileW(
                    wide(&candidate.to_string_lossy()).as_ptr(), GENERIC_WRITE, 0, &attributes,
                    CREATE_NEW, FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                created = Some((candidate, unsafe { OwnedHandle::from_raw_handle(handle as _) }));
                break;
            }
            let error = last_error();
            if error.raw_os_error() != Some(ERROR_FILE_EXISTS as i32) {
                unsafe { LocalFree(sd) };
                return Err(error);
            }
        }
        let Some((tmp, handle)) = created else {
            unsafe { LocalFree(sd) };
            return Err(io::Error::from_raw_os_error(ERROR_FILE_EXISTS as i32));
        };
        unsafe { LocalFree(sd) };
        let written = (|| -> io::Result<()> {
            let mut file = std::fs::File::from(handle);
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            let moved = unsafe { MoveFileExW(wide(&tmp.to_string_lossy()).as_ptr(), wide(&path.to_string_lossy()).as_ptr(), MOVEFILE_REPLACE_EXISTING) };
            if moved == 0 {
                return Err(last_error());
            }
            Ok(())
        })();
        if let Err(error) = written {
            // Only OUR temp of THIS call is cleaned; anything pre-existing stays.
            let _ = std::fs::remove_file(&tmp);
            return Err(error);
        }
        Ok(())
    }

    fn now_millis_fallback() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    }

    /// Canonical confinement for island runtime state on Windows:
    /// `%LOCALAPPDATA%\Abito\<leaf>`, created and ACL-verified (private:
    /// owner, SYSTEM, Administrators). Reusable seam for the daemon session
    /// ACL hardening. `None` when LOCALAPPDATA is missing/relative.
    pub fn prepare_runtime_leaf(leaf: &str, sid: &str) -> Option<std::path::PathBuf> {
        let root = winpolicy::island_root(None, std::env::var("LOCALAPPDATA").ok().as_deref())?;
        let dir = root.join(leaf);
        prepare_runtime(&dir, sid).ok()?;
        Some(dir)
    }

    /// Atomically publish the discovery metadata: temp file in the same
    /// directory, explicit protected owner-only DACL on the temp, then
    /// MoveFileExW(REPLACE_EXISTING). Readers never see a half file.
    pub fn publish_endpoint(runtime: &Path, meta: &EndpointMeta) -> io::Result<()> {
        private_file_bytes(&runtime.join(ENDPOINT_FILE), meta.to_json().as_bytes(), &meta.sid)
    }

    use std::io::Write as _;

    /// Identity-checked removal (the Unix close() analogue): the file is
    /// deleted only when it still names exactly OUR pipe and pid.
    pub fn unpublish_endpoint(runtime: &Path, pipe: &str, pid: u32) -> io::Result<()> {
        let target = runtime.join(ENDPOINT_FILE);
        let Ok(existing) = std::fs::symlink_metadata(&target) else {
            return Ok(()); // nothing published: nothing to remove
        };
        if existing.file_type().is_symlink() || !existing.file_type().is_file() {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "endpoint is a symlink or non-file"));
        }
        let text = std::fs::read_to_string(&target)?;
        match EndpointMeta::parse(&text) {
            Some(meta) if meta.pipe == pipe && meta.pid == pid => std::fs::remove_file(&target),
            _ => Err(io::Error::new(io::ErrorKind::PermissionDenied, "endpoint file is no longer ours")),
        }
    }

    /// The relay's pre-flight: regular file (no symlink), private parent,
    /// owner-only file DACL, then the closed-key-set parse. `None` refuses.
    pub fn read_verified_meta(path: &Path) -> Option<EndpointMeta> {
        let meta = std::fs::symlink_metadata(path).ok()?;
        if meta.file_type().is_symlink() || !meta.file_type().is_file() || meta.len() > MAX_META_FILE {
            return None;
        }
        let me = current_user_sid()?;
        let parent = path.parent()?;
        if !directory_private(parent, &me, false) {
            return None;
        }
        if !directory_private(path, &me, true) {
            return None;
        }
        EndpointMeta::parse(&std::fs::read_to_string(path).ok()?)
    }

    /// Bytes available on a connected pipe; `None` when the peer is gone.
    pub fn available(handle: HANDLE) -> Option<u32> {
        let mut avail = 0u32;
        let ok = unsafe {
            PeekNamedPipe(handle, std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut avail, std::ptr::null_mut())
        };
        (ok != 0).then_some(avail)
    }

    /// Bounded read on an OVERLAPPED handle (B1: every handle this module
    /// creates is opened FILE_FLAG_OVERLAPPED, so every ReadFile carries an
    /// OVERLAPPED). `event` is a manual-reset event owned by the reading
    /// thread; it is reset before each attempt. 0 = EOF, `TimedOut` after
    /// `wait` (cancelling AND draining the pending read, B2).
    pub fn read_bounded_overlapped(
        file: &File, event: HANDLE, out: &mut [u8], wait: Duration,
    ) -> io::Result<usize> {
        let deadline = std::time::Instant::now() + wait;
        loop {
            match available(file.as_raw_handle() as HANDLE) {
                None => return Ok(0),
                Some(0) if std::time::Instant::now() >= deadline => {
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "read deadline"))
                }
                Some(0) => std::thread::sleep(Duration::from_millis(10)),
                Some(_) => {
                    let handle = file.as_raw_handle() as HANDLE;
                    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
                    overlapped.hEvent = event;
                    unsafe { ResetEvent(event) };
                    let ok = unsafe {
                        ReadFile(handle, out.as_mut_ptr(), out.len().min(u32::MAX as usize) as u32,
                            std::ptr::null_mut(), &mut overlapped)
                    };
                    if ok == 0 {
                        let error = unsafe { GetLastError() };
                        if error != ERROR_IO_PENDING {
                            // Never pended (e.g. broken pipe): nothing to drain.
                            if error == ERROR_BROKEN_PIPE {
                                return Ok(0); // peer gone: EOF
                            }
                            return Err(io::Error::from_raw_os_error(error as i32));
                        }
                    } else {
                        // Completed synchronously: done, nothing to wait for.
                        let mut got = 0u32;
                        if unsafe { GetOverlappedResult(handle, &overlapped, &mut got, 0) } == 0 {
                            return Err(last_error());
                        }
                        return Ok(got as usize);
                    }
                    let left = deadline.saturating_duration_since(std::time::Instant::now());
                    let wait_ms = left.as_millis().min(u32::MAX as u128).max(1) as u32;
                    if unsafe { WaitForSingleObject(event, wait_ms) } != WAIT_OBJECT_0 {
                        // B2: cancel AND drain before OVERLAPPED/event/buffer drop.
                        cancel_and_drain(handle, &overlapped);
                        return Err(io::Error::new(io::ErrorKind::TimedOut, "read deadline"));
                    }
                    let mut got = 0u32;
                    if unsafe { GetOverlappedResult(handle, &overlapped, &mut got, 0) } == 0 {
                        let error = last_error();
                        if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                            return Ok(0); // peer gone mid-read: EOF
                        }
                        return Err(error);
                    }
                    return Ok(got as usize);
                }
            }
        }
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "S-1-5-21-1-2-3-1001";
    const HEX: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn sid_shape_accepts_only_sids() {
        assert!(sid_shape_ok("S-1-5-18"));
        assert!(sid_shape_ok(ME));
        assert!(sid_shape_ok("S-1-5-32-544"));
        for bad in ["", "S", "S-", "s-1-5", "S-1-", "S-1-x", "S-1-5-", "X-1-5-18", "S-1-5-18-x", "S+1-5"] {
            assert!(!sid_shape_ok(bad), "{bad}");
        }
    }

    #[test]
    fn pipe_names_have_one_exact_shape() {
        let good = pipe_name_for(ME, HEX).unwrap();
        assert!(good.starts_with(PIPE_PREFIX));
        assert!(good.ends_with(&format!("-{HEX}")));
        assert_eq!(good, format!("{PIPE_PREFIX}{ME}-{HEX}"));
        assert!(pipe_name_ok(&good));
        assert!(!pipe_name_for(ME, "0123").is_some(), "short instance refused");
        assert!(!pipe_name_for(ME, &HEX.to_uppercase()).is_some(), "uppercase hex refused");
        assert!(!pipe_name_for("not-a-sid", HEX).is_some());
        for bad in [
            r"\\.\pipe\abito-notice-x-0123456789abcdef0123456789abcdef",
            r"\\server\pipe\abito-notice-x-0123456789abcdef0123456789abcdef",
            r"\\.\pipe\abito-0123456789abcdef0123456789abcdef",
            "",
        ] {
            assert!(!pipe_name_ok(bad), "{bad}");
        }
    }

    #[test]
    fn sddl_is_protected_and_owner_only() {
        assert_eq!(sddl_owner_full(ME).as_deref(), Some("O:S-1-5-21-1-2-3-1001D:P(A;;GA;;;S-1-5-21-1-2-3-1001)"));
        assert!(sddl_owner_full("nope").is_none());
    }

    #[test]
    fn metadata_roundtrip_and_closed_key_set() {
        let pipe = pipe_name_for(ME, HEX).unwrap();
        let meta = EndpointMeta::new(pipe.clone(), 4242, ME.into()).unwrap();
        let text = meta.to_json();
        assert_eq!(EndpointMeta::parse(&text).as_ref(), Some(&meta));
        // closed key set: one extra or missing key is refused
        let mut tampered: Value = serde_json::from_str(&text).unwrap();
        tampered.as_object_mut().unwrap().insert("extra".into(), json!(1));
        assert!(EndpointMeta::parse(&tampered.to_string()).is_none());
        let mut missing: Value = serde_json::from_str(&text).unwrap();
        missing.as_object_mut().unwrap().remove("pid");
        assert!(EndpointMeta::parse(&missing.to_string()).is_none());
        // wrong version, pid 0, and sid/pipe mismatch are refused
        for patch in [
            ("v", json!(2)),
            ("pid", json!(0)),
            ("sid", json!("S-1-5-21-9-9-9-1002")),
        ] {
            let mut bad: Value = serde_json::from_str(&text).unwrap();
            bad[patch.0] = patch.1;
            let key = patch.0;
            assert!(EndpointMeta::parse(&bad.to_string()).is_none(), "{key}");
        }
        // a foreign pipe under our SID cannot be published
        let foreign_pipe = format!(r"\\.\pipe\abito-notice-S-1-5-21-9-9-9-1002-{HEX}");
        assert!(EndpointMeta::new(foreign_pipe, 4242, ME.into()).is_none());
        assert!(EndpointMeta::new("not a pipe".into(), 4242, ME.into()).is_none());
        assert!(EndpointMeta::new(pipe, 0, ME.into()).is_none());
    }

    #[test]
    fn owner_only_dacl_refuses_everyone_else() {
        let v = |x: &[&str]| Some(x.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert!(dacl_owner_only(ME, ME, v(&[ME]).as_deref()));
        assert!(dacl_owner_only(ME, ME, v(&[ME]).as_deref()));
        assert!(!dacl_owner_only(ME, ME, v(&[ME, "S-1-5-18"]).as_deref()), "SYSTEM is still broader");
        assert!(!dacl_owner_only(ME, ME, v(&[ME, "S-1-5-32-544"]).as_deref()), "Admins are broader");
        assert!(!dacl_owner_only(ME, ME, v(&[ME, "S-1-1-0"]).as_deref()), "Everyone refused");
        assert!(!dacl_owner_only(ME, ME, None), "missing DACL is everyone access");
        assert!(!dacl_owner_only("S-1-5-21-9-9-9-1002", ME, v(&[ME]).as_deref()));
    }

    #[test]
    fn client_admission_fails_closed() {
        assert!(client_admitted(ME, Some(ME)));
        assert!(!client_admitted(ME, Some("S-1-5-21-9-9-9-1002")));
        assert!(!client_admitted(ME, None), "API failure refuses");
        assert!(!client_admitted(ME, Some("")));
    }
}

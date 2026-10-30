//! Windows lifetime guarantee for the app-owned daemon host (W1a).
//!
//! The Linux arm uses PR_SET_PDEATHSIG + a private process group. The Windows
//! equivalent is a Job Object with `KILL_ON_JOB_CLOSE`: the only handle to the
//! job lives in the app process, so when the app dies for ANY reason the kernel
//! closes it and kills the whole tree (grandchildren included, because
//! `BREAKAWAY_OK` is never set). The child is created suspended and put in the
//! job BEFORE its first instruction runs, so it can never escape or fork out of
//! the job. Any failure to establish that guarantee is fail-closed: the child is
//! terminated and the spawn reports an error.
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    OpenThread, ResumeThread, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    THREAD_SUSPEND_RESUME,
};

/// Owned kernel handle, stored as an integer so `Host` stays `Send`.
pub(crate) struct Owned(isize);
impl Owned {
    fn new(h: HANDLE) -> Option<Self> {
        (!h.is_null() && h != INVALID_HANDLE_VALUE).then_some(Self(h as isize))
    }
    fn raw(&self) -> HANDLE { self.0 as HANDLE }
}
impl Drop for Owned {
    fn drop(&mut self) { unsafe { CloseHandle(self.raw()); } }
}

pub struct Host { child: Child, job: Owned }

fn kill_job_object() -> std::io::Result<Owned> {
    let job = Owned::new(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })
        .ok_or_else(std::io::Error::last_os_error)?;
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    let ok = unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 { return Err(std::io::Error::last_os_error()) }
    Ok(job)
}

/// Resume the (single) initial thread of a process created with CREATE_SUSPENDED.
fn resume_initial_thread(pid: u32) -> std::io::Result<()> {
    let snap = Owned::new(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })
        .ok_or_else(std::io::Error::last_os_error)?;
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut more = unsafe { Thread32First(snap.raw(), &mut entry) } != 0;
    while more {
        if entry.th32OwnerProcessID == pid {
            let thread = Owned::new(unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) })
                .ok_or_else(std::io::Error::last_os_error)?;
            // ResumeThread returns the previous suspend count, or u32::MAX on failure.
            return match unsafe { ResumeThread(thread.raw()) } {
                u32::MAX => Err(std::io::Error::last_os_error()),
                _ => Ok(()),
            };
        }
        more = unsafe { Thread32Next(snap.raw(), &mut entry) } != 0;
    }
    Err(std::io::Error::other("suspended host thread not found"))
}

// ---- runtime discovery (T2/S4): standard Node + npm-installed Pi ----------

/// The npm global package that provides Pi. Its Windows install is a `.cmd`
/// shim backed by JS — the shim is NEVER executed (no cmd.exe, ever); the JS
/// entry is resolved from the installed package's own `package.json` `bin`
/// map instead and run with Node.
const PI_PACKAGE: &str = r"@earendil-works\pi-coding-agent";

/// `node.exe`: absolute PATH entries first, then the customary MSI location
/// (`%ProgramFiles%\nodejs`). PATHEXT-free on purpose: only the real
/// executable, never a shim that would re-resolve through cmd.exe.
pub fn discover_node(
    path: Option<&std::ffi::OsStr>,
    program_files: Option<&std::ffi::OsStr>,
) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = path
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .filter(|p| p.is_absolute())
        .map(|p| p.join("node.exe"))
        .collect();
    if let Some(base) = program_files.map(PathBuf::from).filter(|b| b.is_absolute()) {
        candidates.push(base.join("nodejs").join("node.exe"));
    }
    candidates.into_iter().find(|p| p.is_file()).ok_or_else(|| "node missing (PATH and canonical locations)".to_owned())
}

/// Bounded npm global prefixes: `%AppData%\npm` (npm's Windows default) and
/// the directory of the discovered `node.exe` (prefix = the node install for
/// version managers). Never a PATH walk, never the working directory.
fn npm_prefixes(node: Option<&Path>, app_data: Option<&std::ffi::OsStr>) -> Vec<PathBuf> {
    let mut prefixes = Vec::new();
    if let Some(data) = app_data.map(PathBuf::from).filter(|p| p.is_absolute()) {
        prefixes.push(data.join("npm"));
    }
    if let Some(dir) = node.and_then(Path::parent) {
        if !prefixes.iter().any(|p| p == dir) {
            prefixes.push(dir.to_path_buf());
        }
    }
    prefixes
}

/// The CLI JS of an installed Node package, taken from its own `package.json`
/// `bin` map and validated: relative, no `..`/root components, existing
/// regular file. `None` on anything else — never a guessed entry.
fn package_cli_js(package_dir: &Path, bin_name: &str) -> Option<PathBuf> {
    let manifest = serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(package_dir.join("package.json")).ok()?).ok()?;
    let bin = manifest.get("bin")?.get(bin_name)?.as_str()?;
    if bin.is_empty() || std::path::Path::new(bin).is_absolute() {
        return None;
    }
    let mut resolved = package_dir.to_path_buf();
    for part in std::path::Path::new(bin).components() {
        match part {
            std::path::Component::Normal(p) => resolved.push(p),
            std::path::Component::CurDir => {}
            _ => return None, // `..`, root/prefix: refused
        }
    }
    resolved.is_file().then_some(resolved)
}

/// Pi on Windows: the npm-installed package's CLI JS (run with Node by the
/// daemon runtime). The `.cmd` shim is never executed, and a bare `pi.exe` is
/// deliberately NOT a discovery target: the gate must match what the daemon
/// runtime can actually spawn (Node + validated package CLI JS), so a non-npm
/// install fails closed with the missing-Pi message instead of a spawn error.
/// All bases are explicit parameters (no ambient environment), so tests can
/// isolate the lookup from whatever the runner happens to have installed.
pub fn discover_pi(
    path: Option<&std::ffi::OsStr>,
    _home: Option<&std::ffi::OsStr>,
    program_files: Option<&std::ffi::OsStr>,
    app_data: Option<&std::ffi::OsStr>,
) -> Result<PathBuf, String> {
    discover_pi_with(discover_node(path, program_files).ok(), app_data)
}
/// [`discover_pi`] with the Node already chosen (so the app can pass a version-manager Node).
pub fn discover_pi_with(node: Option<PathBuf>, app_data: Option<&std::ffi::OsStr>) -> Result<PathBuf, String> {
    npm_prefixes(node.as_deref(), app_data)
        .iter()
        .filter_map(|prefix| package_cli_js(&prefix.join("node_modules").join(PI_PACKAGE), "pi"))
        .next()
        .ok_or_else(|| "pi missing (npm install -g @earendil-works/pi-coding-agent)".to_owned())
}

/// The Windows lookup behind `daemonhost::discover` (cfg(windows) dispatch):
/// only the two daemon runtimes have one; anything else refuses.
pub fn discover(name: &str, path: Option<&std::ffi::OsStr>, home: Option<&std::ffi::OsStr>, finder: &crate::nodefinder::Env) -> Result<PathBuf, String> {
    // HU-069: after PATH and Program Files, the version managers (nvm-windows, fnm, Volta) a GUI launch cannot see. The two functions
    // above stay fully explicit (tests isolate them from the runner); only this app-level entry point adds the process environment.
    let managed = || crate::nodefinder::candidates("node", crate::nodefinder::Os::Windows, finder).into_iter().find(|p| p.is_file());
    let node = || discover_node(path, finder.program_files.as_deref().map(|p| p.as_os_str())).ok().or_else(managed);
    let _ = home;
    match name {
        "node" => node().ok_or_else(|| "node missing (PATH and canonical locations)".to_owned()),
        "pi" => discover_pi_with(node(), finder.app_data.as_deref().map(|p| p.as_os_str())),
        _ => Err(format!("{name} has no Windows lookup")),
    }
}

/// Shared suspended-create → assign → resume boundary. Caller owns stdio and lifetime policy;
/// dropping the returned job handle kills descendants even after the direct child exits.
pub(crate) fn spawn_in_job(mut command: Command) -> std::io::Result<(Child, Owned)> {
    let job = kill_job_object()?;
    command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    let mut child = command.spawn()?;
    let attach = (|| {
        if unsafe { AssignProcessToJobObject(job.raw(), child.as_raw_handle() as HANDLE) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        resume_initial_thread(child.id())
    })();
    if let Err(error) = attach {
        // Never resume an uncontained child; cleanup must not block the caller indefinitely.
        drop(job);
        let _ = child.kill();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while std::time::Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() { break; }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        return Err(error);
    }
    Ok((child, job))
}

impl Host {
    /// Suspended create -> assign to a kill-on-close job -> resume. No shell.
    pub fn spawn_command(mut command: Command) -> std::io::Result<Self> {
        command.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit());
        let (child, job) = spawn_in_job(command)?;
        Ok(Self { child, job })
    }
    pub fn pid(&self) -> u32 { self.child.id() }
    pub fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> { self.child.try_wait() }
}

impl Drop for Host {
    fn drop(&mut self) {
        // Never act on a child that was already reaped.
        if self.child.try_wait().ok().flatten().is_some() { return }
        drop(self.child.stdin.take()); // EOF lease allows graceful shutdown
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() { return }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        unsafe { TerminateJobObject(self.job.raw(), 1); }
        let reap_deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while std::time::Instant::now() < reap_deadline {
            if self.child.try_wait().ok().flatten().is_some() { return }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // Never block app exit; closing the job handle (field drop) kills the tree anyway.
        eprintln!("island host: bounded reap expired; the job object kills the tree on close");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;

    fn sleeper() -> Command {
        let mut c = Command::new("ping");
        c.args(["-n", "60", "127.0.0.1"]);
        c
    }

    #[test]
    fn host_runs_inside_the_kill_on_close_job() {
        let host = Host::spawn_command(sleeper()).expect("spawn");
        let mut inside = 0;
        let ok = unsafe { IsProcessInJob(host.child.as_raw_handle() as HANDLE, host.job.raw(), &mut inside) };
        assert!(ok != 0 && inside != 0, "child must be in OUR job");
    }

    #[test]
    fn closing_the_job_kills_the_child_without_a_graceful_exit() {
        let mut host = Host::spawn_command(sleeper()).expect("spawn");
        let Host { child, job } = &mut host;
        unsafe { TerminateJobObject(job.raw(), 7) };
        let status = child.wait().expect("wait");
        assert_eq!(status.code(), Some(7));
    }

    #[test]
    fn dropping_the_host_does_not_leave_a_running_child() {
        let host = Host::spawn_command(sleeper()).expect("spawn");
        let pid = host.pid();
        drop(host);
        let out = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
        assert!(!String::from_utf8_lossy(&out.stdout).contains("ping.exe"));
    }
}

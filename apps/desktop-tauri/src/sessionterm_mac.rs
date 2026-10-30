//! macOS backend of the terminal origin (HU-065): the peer's process table through `proc_pidinfo` (no `/proc`, no
//! shell), and "bring the terminal APP forward" through `NSRunningApplication`. Tab-level focus would need the
//! Automation/Accessibility permission, which Abito never asks for, so this is app-level by design.
use crate::sessionterm::{ProcInfo, ProcTable, Raise, MAC_TERMINAL_COMMS};
use std::sync::OnceLock;

pub struct MacProcs;

impl ProcTable for MacProcs {
    fn read(&self, pid: u32) -> Option<ProcInfo> { read_pid(pid) }
    fn is_terminal(&self, p: &ProcInfo) -> bool { crate::sessionterm::exact_name_matches(&p.comm, MAC_TERMINAL_COMMS) }
}

/// ppid, process name and birth time (µs since the epoch) of `pid`; `None` once it is gone.
fn read_pid(pid: u32) -> Option<ProcInfo> {
    let pid_c = libc::c_int::try_from(pid).ok().filter(|p| *p > 0)?;
    // SAFETY: zeroed POD out-struct; the size passed is exactly its size.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let got = unsafe { libc::proc_pidinfo(pid_c, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    if got != size || info.pbi_pid != pid { return None; }
    let name = |raw: &[libc::c_char]| -> String {
        let bytes: Vec<u8> = raw.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    };
    // `pbi_name` is the long process name, `pbi_comm` is cut at 16 bytes; prefer the long one.
    let long = name(&info.pbi_name);
    let comm = if long.is_empty() { name(&info.pbi_comm) } else { long };
    Some(ProcInfo { pid, ppid: info.pbi_ppid, comm, starttime: info.pbi_start_tvsec.saturating_mul(1_000_000).saturating_add(info.pbi_start_tvusec) })
}

/// `LOCAL_PEERPID`: the pid of the process on the other end of a connected unix socket.
pub fn peer_pid(fd: std::os::unix::io::RawFd) -> Option<u32> {
    const SOL_LOCAL: libc::c_int = 0;
    const LOCAL_PEERPID: libc::c_int = 0x002;
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: fd is open for the call; the out-pointers are valid locals.
    let r = unsafe { libc::getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &mut pid as *mut _ as *mut libc::c_void, &mut len) };
    (r == 0 && pid > 0).then_some(pid as u32)
}

type MainRunner = Box<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;
static MAIN: OnceLock<MainRunner> = OnceLock::new();
/// AppKit objects belong to the main thread: the app registers how to run a closure there.
pub fn set_main_runner(runner: impl Fn(Box<dyn FnOnce() + Send>) + Send + Sync + 'static) { let _ = MAIN.set(Box::new(runner)); }

/// Activate the app that owns `pid` (never launches anything). `still_valid` runs on the main thread right before
/// the activation; a job that outlived its 2 s wait is cancelled and never activates anything later.
pub fn raise_app(pid: u32, still_valid: impl FnOnce() -> bool + Send + 'static) -> Raise {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    let Some(run) = MAIN.get() else { return Raise::Unreachable };
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    run(Box::new(move || {
        if flag.load(Ordering::SeqCst) { return; }
        let _ = tx.send(if still_valid() { activate(pid) } else { None });
    }));
    match rx.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(Some(true)) => Raise::Raised,
        Ok(Some(false)) => Raise::Unreachable,
        Ok(None) => Raise::NoWindow,
        Err(_) => { cancelled.store(true, Ordering::SeqCst); Raise::Unreachable }
    }
}
/// `Some(activated)`, or `None` when the process has no running application (a bare CLI process).
#[allow(deprecated)]
fn activate(pid: u32) -> Option<bool> {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    let app = NSRunningApplication::runningApplicationWithProcessIdentifier(i32::try_from(pid).ok()?)?;
    Some(app.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps))
}

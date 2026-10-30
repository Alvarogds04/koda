//! Windows backend of the terminal origin (HU-065): the process table through a Toolhelp32 snapshot (ppid, exe
//! name) plus `GetProcessTimes` (birth identity), and "bring the terminal window forward" with the same rules as
//! `hotkey::foreground` (restore only if minimized by us asking; `SetForegroundWindow`, best effort).
use crate::sessionterm::{ProcInfo, ProcTable, Raise, WIN_TERMINAL_COMMS};
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HWND, LPARAM};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, GW_OWNER, SW_RESTORE,
};

pub struct WinProcs;

impl ProcTable for WinProcs {
    fn read(&self, pid: u32) -> Option<ProcInfo> { read_pid(pid) }
    fn is_terminal(&self, p: &ProcInfo) -> bool { crate::sessionterm::exact_name_matches(&p.comm, WIN_TERMINAL_COMMS) }
    fn hosts_window(&self, pid: u32) -> bool { top_level_windows(pid).0 > 0 }
}

fn read_pid(pid: u32) -> Option<ProcInfo> {
    if pid == 0 { return None; }
    let (ppid, comm) = snapshot_entry(pid)?;
    Some(ProcInfo { pid, ppid, comm, starttime: creation_time(pid)? })
}

fn snapshot_entry(pid: u32) -> Option<(u32, String)> {
    // SAFETY: the snapshot handle is closed on every path; the entry struct is sized before use.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap as isize == -1 { return None; }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        let mut ok = Process32FirstW(snap, &mut entry);
        while ok != 0 {
            if entry.th32ProcessID == pid {
                let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
                found = Some((entry.th32ParentProcessID, String::from_utf16_lossy(&entry.szExeFile[..len])));
                break;
            }
            ok = Process32NextW(snap, &mut entry);
        }
        CloseHandle(snap);
        found
    }
}

/// FILETIME of creation: with the pid it is the process's identity (a recycled pid has a later one).
fn creation_time(pid: u32) -> Option<u64> {
    // SAFETY: the process handle is closed on every path; FILETIME is a POD out-parameter.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() { return None; }
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut created, mut a, mut b, mut c) = (zero, zero, zero, zero);
        let ok = GetProcessTimes(handle, &mut created, &mut a, &mut b, &mut c);
        CloseHandle(handle);
        (ok != 0).then(|| ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
    }
}

struct Search { pid: u32, found: HWND, count: usize }
unsafe extern "system" fn each_window(hwnd: HWND, lparam: LPARAM) -> i32 {
    // SAFETY: lparam is the &mut Search that top_level_windows keeps alive for the whole enumeration.
    let search = unsafe { &mut *(lparam as *mut Search) };
    let mut owner = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, &mut owner) };
    // A real top-level window: visible and unowned (tool windows and dialogs are owned).
    if owner == search.pid && unsafe { IsWindowVisible(hwnd) } != 0 && unsafe { GetWindow(hwnd, GW_OWNER) }.is_null() {
        if search.found.is_null() { search.found = hwnd; }
        search.count += 1;
    }
    1
}
fn top_level_windows(pid: u32) -> (usize, HWND) {
    let mut search = Search { pid, found: std::ptr::null_mut(), count: 0 };
    // SAFETY: the callback only dereferences `search`, which outlives the call.
    unsafe { EnumWindows(Some(each_window), &mut search as *mut Search as LPARAM) };
    (search.count, search.found)
}

/// Bring the first top-level window of `pid` to the front and say how many it has. No window: `NoWindow`
/// (never launches anything).
pub fn raise_window_of(pid: u32) -> (Raise, usize) {
    let (count, found) = top_level_windows(pid);
    if found.is_null() { return (Raise::NoWindow, 0); }
    // SAFETY: the handle came from the enumeration just now; every call tolerates a stale handle.
    unsafe {
        if IsIconic(found) != 0 { ShowWindow(found, SW_RESTORE); }
        (if SetForegroundWindow(found) != 0 { Raise::Raised } else { Raise::Unreachable }, count)
    }
}

//! HU-065: the terminal origin on macOS and Windows, over a fake process table. These run on every OS (the kernel
//! backends only feed `ProcTable`), so the shared rules are proven on Linux, macOS and Windows CI alike.
use super::*;
use std::cell::RefCell;
use std::collections::HashMap;

struct Fake { procs: RefCell<HashMap<u32, ProcInfo>>, terms: &'static [&'static str], windowless: RefCell<Vec<u32>> }
impl Fake {
    fn new(terms: &'static [&'static str], rows: &[(u32, &str, u32, u64)]) -> Self {
        let f = Fake { procs: RefCell::new(HashMap::new()), terms, windowless: RefCell::new(vec![]) };
        for (pid, comm, ppid, start) in rows { f.set(*pid, comm, *ppid, *start); }
        f
    }
    fn set(&self, pid: u32, comm: &str, ppid: u32, starttime: u64) {
        self.procs.borrow_mut().insert(pid, ProcInfo { pid, ppid, comm: comm.into(), starttime });
    }
    fn drop_pid(&self, pid: u32) { self.procs.borrow_mut().remove(&pid); }
}
impl ProcTable for Fake {
    fn read(&self, pid: u32) -> Option<ProcInfo> { self.procs.borrow().get(&pid).cloned() }
    fn is_terminal(&self, p: &ProcInfo) -> bool { exact_name_matches(&p.comm, self.terms) }
    fn hosts_window(&self, pid: u32) -> bool { !self.windowless.borrow().contains(&pid) }
}
fn no_herdr(_: &[&str]) -> Option<String> { panic!("no herdr outside Linux") }

#[test]
fn macos_hook_in_a_terminal_app_resolves_and_focus_revalidates_the_app() {
    let t = Fake::new(MAC_TERMINAL_COMMS, &[(10, "iTerm2", 1, 100), (20, "zsh", 10, 200), (30, "node", 20, 300)]);
    let peer = t.read(30).unwrap();
    let origin = capture_origin(&t, &peer, &mut no_herdr).expect("iTerm2 is a terminal");
    let mut raised = vec![];
    assert!(focus_origin_with(&t, &origin, &mut no_herdr, &mut |pid| { raised.push(pid); Raise::Raised }).is_ok());
    assert_eq!(raised, vec![10], "the app is raised, never the shell or the hook");
    // The app quit and its pid was recycled by an unrelated process: refuse, never raise a guess.
    t.set(10, "Safari", 1, 999);
    assert_eq!(focus_origin_with(&t, &origin, &mut no_herdr, &mut |_| panic!("must not raise")), Err(ORIGIN_GONE.into()));
}

#[test]
fn macos_every_listed_terminal_app_matches_and_non_terminals_never_do() {
    for name in ["Terminal", "iTerm2", "ghostty", "WezTerm-gui", "kitty", "Alacritty", "Warp"] {
        let t = Fake::new(MAC_TERMINAL_COMMS, &[(10, name, 1, 1), (30, "node", 10, 2)]);
        assert!(capture_origin(&t, &t.read(30).unwrap(), &mut no_herdr).is_some(), "{name}");
    }
    let t = Fake::new(MAC_TERMINAL_COMMS, &[(10, "terminal-notifier", 1, 1), (20, "Finder", 10, 2), (30, "node", 20, 3)]);
    assert!(capture_origin(&t, &t.read(30).unwrap(), &mut no_herdr).is_none(), "unknown origin is not invented");
}

#[test]
fn windows_relay_as_pipe_client_resolves_the_hooks_terminal_never_the_relay_or_the_island() {
    // WindowsTerminal -> pwsh -> node (the hook) -> abito-notice-relay.exe (the pipe client)
    let t = Fake::new(WIN_TERMINAL_COMMS, &[(10, "WindowsTerminal.exe", 1, 100), (20, "pwsh.exe", 10, 200),
        (30, "node.exe", 20, 300), (40, "abito-notice-relay.exe", 30, 400)]);
    let relay = t.read(40).unwrap();
    let origin = capture_origin(&t, &relay, &mut no_herdr).expect("hook ancestors reach Windows Terminal");
    let mut raised = vec![];
    focus_origin_with(&t, &origin, &mut no_herdr, &mut |pid| { raised.push(pid); Raise::Raised }).unwrap();
    assert_eq!(raised, vec![10]);
    // The relay started by the island itself (no terminal above it): nothing is invented.
    let t = Fake::new(WIN_TERMINAL_COMMS, &[(10, "explorer.exe", 1, 1), (20, "Abito.exe", 10, 2), (40, "abito-notice-relay.exe", 20, 3)]);
    assert!(capture_origin(&t, &t.read(40).unwrap(), &mut no_herdr).is_none());
}

#[test]
fn windows_exe_suffix_matches_and_prefix_lookalikes_do_not() {
    for name in ["WindowsTerminal.exe", "conhost.exe", "wezterm-gui.exe", "Code.exe", "alacritty.exe"] {
        let t = Fake::new(WIN_TERMINAL_COMMS, &[(10, name, 1, 1), (30, "node.exe", 10, 2)]);
        assert!(capture_origin(&t, &t.read(30).unwrap(), &mut no_herdr).is_some(), "{name}");
    }
    for name in ["codeserver.exe", "terminal-fake.exe", "conhostile.exe", "code-server.exe", "code-tunnel.exe", "warp-svc.exe", "abito-notice-relay.exe", "Abito.exe"] {
        let t = Fake::new(WIN_TERMINAL_COMMS, &[(10, name, 1, 1), (30, "node.exe", 10, 2)]);
        assert!(capture_origin(&t, &t.read(30).unwrap(), &mut no_herdr).is_none(), "{name}");
    }
}

#[test]
fn a_recycled_peer_or_a_vanished_terminal_never_focuses_and_says_so() {
    let t = Fake::new(WIN_TERMINAL_COMMS, &[(10, "WindowsTerminal.exe", 1, 100), (30, "node.exe", 10, 300)]);
    let peer = t.read(30).unwrap();
    let origin = capture_origin(&t, &peer, &mut no_herdr).unwrap();
    t.set(30, "node.exe", 10, 301);
    assert!(capture_origin(&t, &peer, &mut no_herdr).is_none(), "the peer pid now names another process");
    t.drop_pid(10);
    assert_eq!(focus_origin_with(&t, &origin, &mut no_herdr, &mut |_| panic!()), Err(ORIGIN_GONE.into()));
    // The terminal exists but the OS refuses to raise it: the honest reason, no second window.
    t.set(10, "WindowsTerminal.exe", 1, 100);
    assert_eq!(focus_origin_with(&t, &origin, &mut no_herdr, &mut |_| Raise::Unreachable), Err(CANNOT_RAISE_REASON.into()));
}

// ---- real kernel tables (compiled and run only on the OS that owns them: CI evidence for HU-065) ----------

#[cfg(any(target_os = "macos", windows))]
fn real() -> &'static dyn ProcTable {
    #[cfg(target_os = "macos")] { &crate::sessionterm_mac::MacProcs }
    #[cfg(windows)] { &crate::sessionterm_win::WinProcs }
}
#[cfg(any(target_os = "macos", windows))]
#[test]
fn real_process_table_reads_this_process_and_its_parent_with_a_stable_birth_identity() {
    let me = real().read(std::process::id()).expect("own process is readable");
    assert!(!me.comm.is_empty() && me.starttime > 0 && me.ppid > 0, "{me:?}");
    assert_eq!(real().read(std::process::id()).unwrap().starttime, me.starttime, "birth identity is stable");
    let chain = ancestors(real(), std::process::id());
    assert!(chain.len() >= 2 && chain[1].pid == me.ppid, "the walk reaches the real parent: {chain:?}");
    assert!(real().read(u32::MAX - 1).is_none(), "a pid that does not exist reads as gone");
}
#[cfg(any(target_os = "macos", windows))]
#[test]
fn real_child_resolves_through_the_real_table_and_a_dead_child_is_gone() {
    #[cfg(windows)] let mut child = std::process::Command::new("ping").args(["-n", "30", "127.0.0.1"]).spawn().unwrap();
    #[cfg(target_os = "macos")] let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
    let info = real().read(child.id()).expect("child is readable");
    assert_eq!(info.ppid, std::process::id(), "the child's parent is this test process");
    child.kill().unwrap(); child.wait().unwrap();
    assert!(real().read(child.id()).filter(|p| p.starttime == info.starttime).is_none(), "an exited child is gone");
}
#[cfg(target_os = "macos")]
#[test]
fn macos_peer_pid_of_a_unix_socket_pair_is_this_process_and_raise_without_main_thread_is_unreachable() {
    use std::os::unix::io::AsRawFd;
    let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
    assert_eq!(crate::sessionterm_mac::peer_pid(a.as_raw_fd()), Some(std::process::id()));
    assert_eq!(crate::sessionterm_mac::peer_pid(-1), None);
    assert_eq!(crate::sessionterm_mac::raise_app(std::process::id(), || true), Raise::Unreachable);
}
#[cfg(windows)]
#[test]
fn windows_raise_of_a_process_without_a_window_is_no_window() {
    let mut child = std::process::Command::new("ping").args(["-n", "30", "127.0.0.1"]).spawn().unwrap();
    assert_eq!(crate::sessionterm_win::raise_window_of(child.id()), (Raise::NoWindow, 0));
    child.kill().unwrap(); child.wait().unwrap();
}

#[test]
fn windowless_console_hosts_are_skipped_for_the_ancestor_that_owns_the_window() {
    // WindowsTerminal -> OpenConsole (ConPTY host, no window) -> pwsh -> node (hook)
    let t = Fake::new(WIN_TERMINAL_COMMS, &[(10, "WindowsTerminal.exe", 1, 1), (15, "OpenConsole.exe", 10, 2), (20, "pwsh.exe", 15, 3), (30, "node.exe", 20, 4)]);
    t.windowless.borrow_mut().push(15);
    let origin = capture_origin(&t, &t.read(30).unwrap(), &mut no_herdr).unwrap();
    let mut raised = vec![];
    focus_origin_with(&t, &origin, &mut no_herdr, &mut |pid| { raised.push(pid); Raise::Raised }).unwrap();
    assert_eq!(raised, vec![10], "the window owner, not the pty host");
    // VS Code: renderer/pty-helper Code.exe has no window, the main Code.exe does.
    let t = Fake::new(WIN_TERMINAL_COMMS, &[(10, "Code.exe", 1, 1), (15, "Code.exe", 10, 2), (20, "pwsh.exe", 15, 3), (30, "node.exe", 20, 4)]);
    t.windowless.borrow_mut().push(15);
    let origin = capture_origin(&t, &t.read(30).unwrap(), &mut no_herdr).unwrap();
    let mut raised = vec![];
    focus_origin_with(&t, &origin, &mut no_herdr, &mut |pid| { raised.push(pid); Raise::Raised }).unwrap();
    assert_eq!(raised, vec![10]);
}

#[test]
fn the_effect_boundary_recheck_refuses_a_recycled_pid_a_non_terminal_and_a_foreign_pid() {
    let t = Fake::new(MAC_TERMINAL_COMMS, &[(10, "iTerm2", 1, 100), (30, "node", 10, 300)]);
    let origin = capture_origin(&t, &t.read(30).unwrap(), &mut no_herdr).unwrap();
    assert!(boundary_ok(&t, &origin, 10));
    assert!(!boundary_ok(&t, &origin, 30), "only the saved terminal pid may be raised");
    t.set(10, "iTerm2", 1, 101);
    assert!(!boundary_ok(&t, &origin, 10), "recycled pid");
    t.set(10, "Safari", 1, 100);
    assert!(!boundary_ok(&t, &origin, 10), "no longer a terminal");
    t.drop_pid(10);
    assert!(!boundary_ok(&t, &origin, 10), "gone");
}

//! macOS app-owned host lifetime (S1). Linux asks the kernel for `PR_SET_PDEATHSIG`; macOS has no
//! equivalent, so the guarantee is three independent layers, and the host is NOT started unless the
//! sentinel layer is proven armed (fail closed):
//!   1. the stdin-EOF lease (the kernel closes our pipe end when the app dies, whatever the cause),
//!   2. a sentinel: this same executable re-run as `--host-sentinel <app_pid> <child_pid>`. It waits
//!      on kqueue `EVFILT_PROC`/`NOTE_EXIT` for BOTH pids; when the app dies it SIGKILLs the child's
//!      process group, and when the child dies it exits. It lives in its own session (not in the
//!      child's group) and tells the app it is armed by writing one byte on a pipe,
//!   3. the host's own ppid poll (desktop-daemon), covering a dead sentinel.
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// How long the app waits for the sentinel's "armed" byte before giving up (fail closed).
pub const HANDSHAKE_WAIT: Duration = Duration::from_secs(2);
/// The handshake pipe's write end is always fd 3 inside the sentinel.
const HANDSHAKE_FD: libc::c_int = 3;
pub const SENTINEL_FLAG: &str = "--host-sentinel";

pub struct Host { child: Child, sentinel: Child }

fn kill_group(pid: libc::pid_t) {
    // SAFETY: plain signal syscalls; callers only pass a pid they own (unreaped child) or one the
    // sentinel is watching through kqueue.
    unsafe { libc::kill(-pid, libc::SIGKILL); libc::kill(pid, libc::SIGKILL); }
}

/// Set or clear FD_CLOEXEC, checking BOTH fcntl calls: an unchecked failure would leak the
/// handshake pipe into the host (or silently lose it), so every error propagates (fail closed).
fn set_cloexec(fd: libc::c_int, on: bool) -> std::io::Result<()> {
    // SAFETY: fcntl on a descriptor the caller owns; no pointers involved.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags < 0 { return Err(std::io::Error::last_os_error()) }
        let wanted = if on { flags | libc::FD_CLOEXEC } else { flags & !libc::FD_CLOEXEC };
        if libc::fcntl(fd, libc::F_SETFD, wanted) < 0 { return Err(std::io::Error::last_os_error()) }
    }
    Ok(())
}

/// Wait up to `wait` for exactly one `1` byte on `fd`. Timeout, EOF and error are all `false`.
fn read_armed_byte(fd: libc::c_int, wait: Duration) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let mut poll = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        // SAFETY: one valid pollfd.
        let ready = unsafe { libc::poll(&mut poll, 1, left.as_millis().min(i32::MAX as u128) as libc::c_int) };
        if ready < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted { continue }
        if ready <= 0 { return false }
        let mut byte = [0u8; 1];
        // SAFETY: reading into a one-byte local.
        let read = unsafe { libc::read(fd, byte.as_mut_ptr().cast(), 1) };
        if read < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted { continue }
        return read == 1 && byte[0] == 1;
    }
}

impl Host {
    /// Spawn `command` as the host under the real sentinel (this executable).
    pub fn spawn_command(command: Command) -> std::io::Result<Self> {
        Self::spawn_with_sentinel(command, Command::new(std::env::current_exe()?), HANDSHAKE_WAIT)
    }

    /// `sentinel` is the program to run as the sentinel; the three flag arguments are appended.
    pub fn spawn_with_sentinel(mut command: Command, mut sentinel: Command, wait: Duration) -> std::io::Result<Self> {
        let app = std::process::id() as libc::pid_t;
        command.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit());
        // SAFETY: only async-signal-safe calls (setpgid) between fork and exec.
        unsafe { command.pre_exec(|| { if libc::setpgid(0, 0) != 0 { return Err(std::io::Error::last_os_error()) } Ok(()) }); }
        let mut child = command.spawn()?;
        let child_pid = child.id() as libc::pid_t;
        let mut fds = [0 as libc::c_int; 2];
        // SAFETY: a two-int array for pipe().
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            let error = std::io::Error::last_os_error();
            kill_group(child_pid); let _ = child.wait();
            return Err(error);
        }
        let (read_fd, write_fd) = (fds[0], fds[1]);
        if let Err(error) = set_cloexec(read_fd, true).and_then(|()| set_cloexec(write_fd, true)) {
            // SAFETY: closing the two descriptors opened just above.
            unsafe { libc::close(read_fd); libc::close(write_fd); }
            kill_group(child_pid); let _ = child.wait();
            return Err(error);
        }
        sentinel.arg(SENTINEL_FLAG).arg(app.to_string()).arg(child_pid.to_string())
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit());
        // SAFETY: setsid/dup2/fcntl are async-signal-safe. The sentinel leaves the app's session and
        // the child's group, and sees only fds 0-2 plus the handshake pipe at fd 3.
        unsafe {
            sentinel.pre_exec(move || {
                if libc::setsid() < 0 { return Err(std::io::Error::last_os_error()) }
                // dup2 clears CLOEXEC on the new fd; when it is already fd 3 clear it by hand.
                if write_fd == HANDSHAKE_FD { set_cloexec(write_fd, false) }
                else if libc::dup2(write_fd, HANDSHAKE_FD) < 0 { Err(std::io::Error::last_os_error()) }
                else { Ok(()) }
            });
        }
        let spawned = sentinel.spawn();
        // SAFETY: the app's copy of the write end; only the sentinel may hold it now.
        unsafe { libc::close(write_fd); }
        let mut sentinel = match spawned {
            Ok(sentinel) => sentinel,
            Err(error) => {
                unsafe { libc::close(read_fd); }
                kill_group(child_pid); let _ = child.wait();
                return Err(error);
            }
        };
        let armed = read_armed_byte(read_fd, wait);
        // SAFETY: closing the read end we opened.
        unsafe { libc::close(read_fd); }
        if !armed {
            kill_group(child_pid); let _ = child.wait();
            let _ = sentinel.kill(); let _ = sentinel.wait();
            return Err(std::io::Error::other("host lifetime sentinel did not arm"));
        }
        Ok(Self { child, sentinel })
    }
    pub fn pid(&self) -> u32 { self.child.id() }
    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> { self.child.try_wait() }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.sentinel.try_wait();
        if self.child.try_wait().ok().flatten().is_none() {
            drop(self.child.stdin.take()); // EOF lease allows graceful shutdown
            let pid = self.child.id() as libc::pid_t;
            // SAFETY: our own unreaped child's group.
            unsafe { libc::kill(-pid, libc::SIGTERM); }
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut reaped = false;
            while Instant::now() < deadline {
                if self.child.try_wait().ok().flatten().is_some() { reaped = true; break }
                std::thread::sleep(Duration::from_millis(20));
            }
            if !reaped {
                unsafe { libc::kill(-pid, libc::SIGKILL); }
                let _ = self.child.kill();
                let reap_deadline = Instant::now() + Duration::from_secs(1);
                while Instant::now() < reap_deadline {
                    if self.child.try_wait().ok().flatten().is_some() { break }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        // The sentinel exits by itself once the child is gone; make sure it never lingers.
        let _ = self.sentinel.kill();
        let _ = self.sentinel.wait();
    }
}

// --- the sentinel process ---------------------------------------------------------------------

/// Register `EVFILT_PROC`/`NOTE_EXIT` for `pid`. `false` = the process is already gone (ESRCH) or
/// the registration failed; both mean "treat as exited".
fn watch_exit(kq: libc::c_int, pid: libc::pid_t) -> bool {
    let change = libc::kevent {
        ident: pid as libc::uintptr_t, filter: libc::EVFILT_PROC,
        flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
        fflags: libc::NOTE_EXIT, data: 0, udata: std::ptr::null_mut(),
    };
    // SAFETY: one valid change record, no event list.
    unsafe { libc::kevent(kq, &change, 1, std::ptr::null_mut(), 0, std::ptr::null()) >= 0 }
}

/// Sentinel body. `armed_fd` receives one `1` byte once BOTH pids are registered. Returns the exit
/// code: 0 = the child exited first, 3 = the app exited and the child group was killed,
/// 2 = could not arm (nothing written, so the app fails closed).
pub fn run_sentinel(app: libc::pid_t, child: libc::pid_t, armed_fd: libc::c_int) -> i32 {
    // SAFETY: kqueue takes no arguments.
    let kq = unsafe { libc::kqueue() };
    if kq < 0 { return 2 }
    let app_registered = watch_exit(kq, app);
    let child_registered = watch_exit(kq, child);
    if !app_registered {
        // The app is already gone: the guarantee is "child dies with the app".
        kill_group(child);
        return 3;
    }
    if !child_registered { return 2 }
    let one = [1u8];
    // SAFETY: writing one byte from a local.
    if unsafe { libc::write(armed_fd, one.as_ptr().cast(), 1) } != 1 { kill_group(child); return 2 }
    // SAFETY: closing the handshake descriptor we were handed.
    unsafe { libc::close(armed_fd); }
    loop {
        let mut events: [libc::kevent; 2] = unsafe { std::mem::zeroed() };
        // SAFETY: a valid event buffer of 2 and no timeout (block until an exit).
        let count = unsafe { libc::kevent(kq, std::ptr::null(), 0, events.as_mut_ptr(), 2, std::ptr::null()) };
        if count < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted { continue }
            kill_group(child);
            return 2;
        }
        let seen = &events[..count as usize];
        // The child exiting first wins: never signal a pid that may have been reused.
        if seen.iter().any(|event| event.ident == child as libc::uintptr_t) { return 0 }
        if seen.iter().any(|event| event.ident == app as libc::uintptr_t) { kill_group(child); return 3 }
    }
}

/// Entry for `abito --host-sentinel <app_pid> <child_pid>`; never returns.
pub fn sentinel_main(args: &[String]) -> ! {
    // SAFETY: ignoring signals and closing stray descriptors at process start.
    unsafe {
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        for fd in (HANDSHAKE_FD + 1)..1024 { libc::close(fd); }
    }
    let parse = |index: usize| args.get(index).and_then(|text| text.parse::<libc::pid_t>().ok()).filter(|pid| *pid > 1);
    let (Some(app), Some(child)) = (parse(0), parse(1)) else { std::process::exit(2) };
    std::process::exit(run_sentinel(app, child, HANDSHAKE_FD))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sleeper_group() -> Child {
        let mut command = Command::new("sleep");
        command.arg("1000");
        unsafe { command.pre_exec(|| { if libc::setpgid(0, 0) != 0 { return Err(std::io::Error::last_os_error()) } Ok(()) }); }
        command.spawn().expect("sleep")
    }
    fn pipe() -> (libc::c_int, libc::c_int) {
        let mut fds = [0; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        (fds[0], fds[1])
    }

    #[test]
    fn sentinel_kills_the_child_group_when_the_app_pid_exits() {
        let mut app = sleeper_group();
        let mut child = sleeper_group();
        let (read_fd, write_fd) = pipe();
        let (app_pid, child_pid) = (app.id() as libc::pid_t, child.id() as libc::pid_t);
        let sentinel = std::thread::spawn(move || run_sentinel(app_pid, child_pid, write_fd));
        assert!(read_armed_byte(read_fd, Duration::from_secs(2)), "sentinel must arm");
        assert!(child.try_wait().unwrap().is_none(), "child alive while the app lives");
        app.kill().unwrap(); app.wait().unwrap(); // SIGKILL of the "app": no cleanup code runs
        assert_eq!(sentinel.join().unwrap(), 3);
        let status = child.wait().unwrap();
        assert!(!status.success(), "child must have been killed: {status:?}");
        unsafe { libc::close(read_fd); }
    }

    #[test]
    fn sentinel_exits_quietly_when_the_child_exits_first() {
        let app = sleeper_group();
        let mut child = sleeper_group();
        let (read_fd, write_fd) = pipe();
        let (app_pid, child_pid) = (app.id() as libc::pid_t, child.id() as libc::pid_t);
        let sentinel = std::thread::spawn(move || run_sentinel(app_pid, child_pid, write_fd));
        assert!(read_armed_byte(read_fd, Duration::from_secs(2)));
        child.kill().unwrap(); child.wait().unwrap();
        assert_eq!(sentinel.join().unwrap(), 0);
        let mut app = app; assert!(app.try_wait().unwrap().is_none(), "the app is never touched"); app.kill().unwrap(); app.wait().unwrap();
        unsafe { libc::close(read_fd); }
    }

    #[test]
    fn sentinel_does_not_arm_and_kills_when_the_app_is_already_gone() {
        let mut app = sleeper_group(); let app_pid = app.id() as libc::pid_t;
        app.kill().unwrap(); app.wait().unwrap();
        let mut child = sleeper_group();
        let (read_fd, write_fd) = pipe();
        assert_eq!(run_sentinel(app_pid, child.id() as libc::pid_t, write_fd), 3);
        assert!(!read_armed_byte(read_fd, Duration::from_millis(200)), "no armed byte on a dead app");
        assert!(!child.wait().unwrap().success());
        unsafe { libc::close(write_fd); libc::close(read_fd); }
    }

    #[test]
    fn set_cloexec_reports_fcntl_failure_and_applies_the_flag() {
        let (read_fd, write_fd) = pipe();
        set_cloexec(read_fd, true).expect("valid fd");
        assert_ne!(unsafe { libc::fcntl(read_fd, libc::F_GETFD) } & libc::FD_CLOEXEC, 0);
        set_cloexec(read_fd, false).expect("valid fd");
        assert_eq!(unsafe { libc::fcntl(read_fd, libc::F_GETFD) } & libc::FD_CLOEXEC, 0);
        unsafe { libc::close(read_fd); libc::close(write_fd); }
        // a closed descriptor: fcntl fails with EBADF and the error must surface, not vanish
        assert!(set_cloexec(read_fd, true).is_err());
        assert!(set_cloexec(-1, false).is_err());
    }

    #[test]
    fn spawn_fails_closed_and_kills_the_host_when_the_sentinel_never_arms() {
        let mut host = Command::new("sleep"); host.arg("1000");
        let started = Instant::now();
        let result = Host::spawn_with_sentinel(host, Command::new("/usr/bin/false"), Duration::from_millis(500));
        assert!(result.is_err(), "no armed byte: no host");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn spawn_times_out_when_the_sentinel_stays_silent() {
        let mut host = Command::new("sleep"); host.arg("1000");
        let mut sentinel = Command::new("sleep"); sentinel.arg("30");
        // `sleep 30 --host-sentinel …` fails at once on macOS (bad operand) or stays silent: both fail closed.
        assert!(Host::spawn_with_sentinel(host, sentinel, Duration::from_millis(300)).is_err());
    }

    #[test]
    fn spawn_succeeds_when_the_sentinel_arms_and_drop_stops_the_host() {
        let mut host = Command::new("sleep"); host.arg("1000");
        let mut sentinel = Command::new("/bin/sh");
        sentinel.args(["-c", "printf '\\001' >&3; sleep 30"]);
        let host = Host::spawn_with_sentinel(host, sentinel, Duration::from_secs(2)).expect("armed");
        let pid = host.pid() as libc::pid_t;
        drop(host);
        // SAFETY: probe only; the child was reaped by Drop so the pid is gone (ESRCH).
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "host must be gone after drop");
    }
}

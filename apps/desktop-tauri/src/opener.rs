//! K2-01c: one way to hand a link, a `mailto:` or a folder to the system, on Linux, macOS and Windows.
//!
//! Never a shell: the target is exactly one argument of a fixed program, so `&`, `^`, `|`, `%` or
//! spaces in a URL stay data (that is why Windows never uses `cmd /c start`).
//! - Linux: `xdg-open <target>` (byte-identical to what every caller ran before K2-01c);
//! - macOS: `/usr/bin/open <target>` (absolute: no PATH lookup);
//! - Windows: `rundll32 url.dll,FileProtocolHandler <url>` for links and mail (the default browser or
//!   mail client, already used by the OAuth sign-in), `explorer <folder>` for folders;
//! - any other OS: no opener (`None`), never a guess.
//!
//! Callers keep their own validation, gates and rate limits; this module only checks the scheme
//! once more so a wrong target can never reach a program.
use std::ffi::OsString;
use std::path::Path;
use std::process::{Child, Command, Stdio};

#[cfg(test)]
#[path = "opener_tests.rs"]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Linux,
    MacOs,
    Windows,
    Other,
}

impl Os {
    #[cfg(target_os = "linux")]
    pub const CURRENT: Os = Os::Linux;
    #[cfg(target_os = "macos")]
    pub const CURRENT: Os = Os::MacOs;
    #[cfg(windows)]
    pub const CURRENT: Os = Os::Windows;
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    pub const CURRENT: Os = Os::Other;
}

/// What to open. `Web` must be `http(s)://`, `Mailto` must be `mailto:`.
#[derive(Clone, Copy, Debug)]
pub enum Target<'a> {
    Web(&'a str),
    Mailto(&'a str),
    Folder(&'a Path),
}

fn scheme_ok(target: Target<'_>) -> bool {
    match target {
        Target::Web(u) => u.starts_with("https://") || u.starts_with("http://"),
        Target::Mailto(u) => u.starts_with("mailto:"),
        Target::Folder(_) => true,
    }
}

fn arg(target: Target<'_>) -> OsString {
    match target {
        Target::Web(u) | Target::Mailto(u) => OsString::from(u),
        Target::Folder(p) => p.as_os_str().to_owned(),
    }
}

/// Program and argument list for `target` on `os`, or `None` (wrong scheme or no opener).
pub fn plan(os: Os, target: Target<'_>) -> Option<(&'static str, Vec<OsString>)> {
    if !scheme_ok(target) {
        return None;
    }
    match (os, target) {
        (Os::Linux, _) => Some(("xdg-open", vec![arg(target)])),
        (Os::MacOs, _) => Some(("/usr/bin/open", vec![arg(target)])),
        (Os::Windows, Target::Folder(_)) => Some(("explorer", vec![arg(target)])),
        (Os::Windows, _) => Some(("rundll32", vec![OsString::from("url.dll,FileProtocolHandler"), arg(target)])),
        (Os::Other, _) => None,
    }
}

/// Explorer exits 1 even when it opened the folder; every other opener's exit code is a real signal.
pub fn exit_code_is_meaningful(os: Os, target: Target<'_>) -> bool {
    !(os == Os::Windows && matches!(target, Target::Folder(_)))
}

/// Why opening failed. No text on purpose: callers map it to their own public error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenError {
    /// No opener for this target on this OS, or the program could not be started.
    Unavailable,
    /// The opener ran and reported failure.
    Failed,
}

/// Starts the opener for `target` on this OS with null stdio. The caller owns the child.
pub fn spawn(target: Target<'_>) -> Result<Child, OpenError> {
    let (program, args) = plan(Os::CURRENT, target).ok_or(OpenError::Unavailable)?;
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| OpenError::Unavailable)
}

/// Starts the opener and reaps it on a background thread (fire and forget).
pub fn open_detached(target: Target<'_>) -> Result<(), OpenError> {
    let mut child = spawn(target)?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Waits for an opener started by [`spawn`] and reads its result (blocking: call off the UI thread).
pub fn finish(mut child: Child, meaningful_exit: bool) -> Result<(), OpenError> {
    let status = child.wait().map_err(|_| OpenError::Failed)?;
    if status.success() || !meaningful_exit {
        Ok(())
    } else {
        Err(OpenError::Failed)
    }
}

/// [`spawn`] then [`finish`]: blocking, for callers that report the opener's own result.
pub fn open_and_wait(target: Target<'_>) -> Result<(), OpenError> {
    let meaningful = exit_code_is_meaningful(Os::CURRENT, target);
    finish(spawn(target)?, meaningful)
}

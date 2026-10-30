//! Where the words go: the Wayland clipboard, through `wl-copy`.
//!
//! No keystroke is injected into the app in front (that would need the
//! RemoteDesktop portal, a separate consent that this slice does not take): the
//! text waits on the clipboard and the pill says "press Ctrl+V". The text goes
//! to `wl-copy` through its stdin, never through the command line, where any
//! local user could read it in the process list.

use std::io::Write;
use std::process::{Command, Stdio};

/// What happened to the words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Typed into the app in front.
    Pasted,
    /// On the clipboard only: the user presses Ctrl+V.
    Copied,
    /// The clipboard refused the text.
    Failed,
}

/// Puts `text` on the clipboard with `program` (normally `wl-copy`).
pub fn copy_with(program: &str, text: &str) -> Outcome {
    let child = Command::new(program)
        .arg("--trim-newline")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return Outcome::Failed };
    let wrote = child.stdin.take().map(|mut stdin| stdin.write_all(text.as_bytes()).is_ok()).unwrap_or(false);
    // wl-copy forks to keep serving the selection; its first process exits at once.
    match child.wait() {
        Ok(status) if wrote && status.success() => Outcome::Copied,
        _ => Outcome::Failed,
    }
}

pub fn copy(text: &str) -> Outcome {
    copy_with("wl-copy", text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_clipboard_tool_is_a_failure_not_a_panic() {
        assert_eq!(copy_with("/nonexistent/wl-copy-abito", "hola"), Outcome::Failed);
    }

    #[test]
    #[cfg(unix)]
    fn the_text_travels_on_stdin_never_in_the_arguments() {
        let dir = std::env::temp_dir().join(format!("abito-paste-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("got");
        let args = dir.join("args");
        let script = dir.join("fake-wl-copy");
        std::fs::write(&script, format!("#!/bin/sh\necho \"$@\" > {}\ncat > {}\n", args.display(), out.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        // A freshly written script exec'd at once can fail with ETXTBSY while a parallel test's
        // fork still holds our just-closed write descriptor (until that child execs). The window
        // is transient, so retry a few times; a real failure still fails after the last attempt.
        let mut outcome = Outcome::Failed;
        for _ in 0..20 {
            outcome = copy_with(script.to_str().unwrap(), "secreto dictado");
            if outcome == Outcome::Copied {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert_eq!(outcome, Outcome::Copied);
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "secreto dictado");
        assert!(!std::fs::read_to_string(&args).unwrap().contains("secreto"));
        let _ = std::fs::remove_dir_all(dir);
    }
}

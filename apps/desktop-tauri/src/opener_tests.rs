use super::*;
use std::ffi::OsString;
use std::path::Path;

fn argv(os: Os, target: Target<'_>) -> Option<(String, Vec<String>)> {
    plan(os, target).map(|(p, a)| (p.to_owned(), a.into_iter().map(|s: OsString| s.into_string().unwrap()).collect()))
}

const URL: &str = "https://example.com/a?b=1&c=%41^|x";
const MAILTO: &str = "mailto:ana@example.com?subject=Re%3A%20hola&body=x";

/// K2-01c S2: Linux keeps exactly today's `xdg-open <one argument>`.
#[test]
fn linux_opens_everything_with_xdg_open_and_one_argument() {
    assert_eq!(argv(Os::Linux, Target::Web(URL)), Some(("xdg-open".into(), vec![URL.into()])));
    assert_eq!(argv(Os::Linux, Target::Mailto(MAILTO)), Some(("xdg-open".into(), vec![MAILTO.into()])));
    assert_eq!(argv(Os::Linux, Target::Folder(Path::new("/home/u/sounds"))), Some(("xdg-open".into(), vec!["/home/u/sounds".into()])));
}

/// K2-01c S2: macOS opens links, mail and folders with the system `open` (absolute path, no PATH lookup).
#[test]
fn macos_opens_everything_with_usr_bin_open() {
    assert_eq!(argv(Os::MacOs, Target::Web(URL)), Some(("/usr/bin/open".into(), vec![URL.into()])));
    assert_eq!(argv(Os::MacOs, Target::Mailto(MAILTO)), Some(("/usr/bin/open".into(), vec![MAILTO.into()])));
    assert_eq!(argv(Os::MacOs, Target::Folder(Path::new("/Users/u/sounds"))), Some(("/usr/bin/open".into(), vec!["/Users/u/sounds".into()])));
}

/// K2-01c S2: Windows hands links and mail to the URL protocol handler and folders to Explorer —
/// never `cmd /c start`, so `&`, `^`, `|` and `%` in a URL stay data.
#[test]
fn windows_uses_the_protocol_handler_and_explorer_never_a_shell() {
    let handler = ("rundll32".to_owned(), vec!["url.dll,FileProtocolHandler".to_owned(), URL.to_owned()]);
    assert_eq!(argv(Os::Windows, Target::Web(URL)), Some(handler));
    assert_eq!(
        argv(Os::Windows, Target::Mailto(MAILTO)),
        Some(("rundll32".into(), vec!["url.dll,FileProtocolHandler".into(), MAILTO.into()]))
    );
    assert_eq!(argv(Os::Windows, Target::Folder(Path::new(r"C:\u\sounds"))), Some(("explorer".into(), vec![r"C:\u\sounds".into()])));
    for t in [Target::Web(URL), Target::Mailto(MAILTO), Target::Folder(Path::new("x"))] {
        let (p, _) = argv(Os::Windows, t).unwrap();
        assert!(!p.eq_ignore_ascii_case("cmd") && !p.eq_ignore_ascii_case("powershell"), "{p}");
    }
}

/// A target of the wrong scheme is refused before any program is chosen, on every OS.
#[test]
fn wrong_schemes_are_refused_on_every_os() {
    for os in [Os::Linux, Os::MacOs, Os::Windows, Os::Other] {
        assert_eq!(argv(os, Target::Web("file:///etc/passwd")), None, "{os:?}");
        assert_eq!(argv(os, Target::Web("mailto:a@b.c")), None, "{os:?}");
        assert_eq!(argv(os, Target::Mailto("https://example.com")), None, "{os:?}");
        assert_eq!(argv(os, Target::Web("-https://x")), None, "{os:?}");
    }
}

/// An OS without a known opener is honestly unavailable, never a guess.
#[test]
fn an_unknown_os_has_no_opener() {
    assert_eq!(argv(Os::Other, Target::Web(URL)), None);
    assert_eq!(argv(Os::Other, Target::Folder(Path::new("/x"))), None);
}

/// Windows' Explorer exits 1 even when it worked, so only there is the exit code meaningless.
#[test]
fn only_windows_folder_reveal_ignores_the_exit_code() {
    assert!(!exit_code_is_meaningful(Os::Windows, Target::Folder(Path::new("x"))));
    assert!(exit_code_is_meaningful(Os::Windows, Target::Web(URL)));
    assert!(exit_code_is_meaningful(Os::Linux, Target::Folder(Path::new("x"))));
    assert!(exit_code_is_meaningful(Os::MacOs, Target::Mailto(MAILTO)));
}

#[test]
fn this_build_reports_its_own_os() {
    #[cfg(target_os = "linux")]
    assert_eq!(Os::CURRENT, Os::Linux);
    #[cfg(target_os = "macos")]
    assert_eq!(Os::CURRENT, Os::MacOs);
    #[cfg(windows)]
    assert_eq!(Os::CURRENT, Os::Windows);
}

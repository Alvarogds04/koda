//! Windows privacy policy, kept OS-free so Linux CI exercises it (W1).
//!
//! Node cannot set an ACL on the files and the pipe it creates, so the Rust host
//! decides what to trust: a pipe endpoint must have the exact shape the daemon
//! generates, and the runtime directory must be private to the current user.

/// `\\.\pipe\abito-<32 lowercase hex>`: the exact name `server.cjs` generates.
pub fn pipe_endpoint_ok(endpoint: &str) -> bool {
    endpoint.strip_prefix(r"\\.\pipe\abito-")
        .is_some_and(|hex| hex.len() == 32 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

pub const SID_SYSTEM: &str = "S-1-5-18";
pub const SID_ADMINISTRATORS: &str = "S-1-5-32-544";

/// A directory is private when owned by the current user or Administrators
/// (the default owner for elevated tokens), and every understood DACL entry
/// names only the current user, SYSTEM or Administrators. A missing/NULL DACL
/// grants everyone access and is refused. Metadata files retain owner-only policy.
pub fn dacl_private(owner: &str, current_user: &str, allowed_entries: Option<&[String]>) -> bool {
    if owner != current_user && owner != SID_ADMINISTRATORS { return false }
    let Some(entries) = allowed_entries else { return false };
    entries.iter().all(|sid| sid == current_user || sid == SID_SYSTEM || sid == SID_ADMINISTRATORS)
}

/// Default island root on Windows: `%LOCALAPPDATA%\Abito`, which inherits a
/// user-only profile DACL. `ABITO_ISLAND_DIR` is honoured ONLY as a
/// parallel-island/test seam INSIDE that canonical protected root: an
/// override pointing anywhere else would bypass the profile ACLs that guard
/// the token file, so it is refused (`None`), never guessed.
/// OS-free containment (these verdicts run on Linux CI too): `candidate` is
/// accepted only when it IS the canonical root or sits inside it, with no
/// `.`/`..` and no empty path component that could climb out textually.
fn within_canonical(candidate: &str, canonical: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/");
    let (c, base) = (norm(candidate), norm(canonical));
    let base = base.trim_end_matches('/');
    if c == base {
        return true;
    }
    let Some(rest) = c.strip_prefix(base) else { return false };
    let Some(rest) = rest.strip_prefix('/') else { return false };
    rest.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

pub fn island_root(env_dir: Option<&str>, local_app_data: Option<&str>) -> Option<std::path::PathBuf> {
    let absolute = |s: &str| {
        let b = s.as_bytes();
        (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
            && !s.chars().any(char::is_control)
    };
    let canonical = local_app_data.filter(|d| absolute(d)).map(|d| std::path::Path::new(d).join("Abito"))?;
    if let Some(d) = env_dir.filter(|d| !d.is_empty()) {
        return (absolute(d) && within_canonical(d, &canonical.to_string_lossy()))
            .then(|| std::path::PathBuf::from(d));
    }
    Some(canonical)
}

/// Installer owner policy: the current user, or BUILTIN\Administrators ONLY
/// when the current token is elevated (elevated tokens default-own to BA).
pub fn install_owner_ok(owner: &str, current_user: &str, elevated: bool) -> bool {
    owner == current_user || (elevated && owner == SID_ADMINISTRATORS)
}

/// Directory/file verdict for hook and Pi installation: stricter owner rule
/// than `dacl_private`, same principal set. A missing/NULL DACL is refused.
pub fn install_acl_private(owner: &str, current_user: &str, elevated: bool, allowed_entries: Option<&[String]>) -> bool {
    install_owner_ok(owner, current_user, elevated) && dacl_private(current_user, current_user, allowed_entries)
        && allowed_entries.is_some_and(|e| e.iter().all(|sid| sid == current_user || sid == SID_SYSTEM || sid == SID_ADMINISTRATORS))
}

const RESERVED: [&str; 30] = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "COM\u{b9}", "COM\u{b2}", "COM\u{b3}", "LPT\u{b9}", "LPT\u{b2}", "LPT\u{b3}"];

/// Target paths the native filesystem helper accepts: `X:\a\b`, normalized, no
/// UNC, device (`\\?\`, `\\.\`), stream (`:`), reserved-name, `.`/`..` or
/// trailing dot/space components. Purely lexical; the helper still checks reparse points.
pub fn fs_path_ok(path: &str) -> bool {
    let b = path.as_bytes();
    if path.len() > 520 || b.len() < 4 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' { return false; }
    path[3..].split('\\').all(|c| {
        !c.is_empty() && c != "." && c != ".." && !c.ends_with(['.', ' '])
            && !c.chars().any(|ch| ch.is_control() || "<>:\"|?*/~".contains(ch))
            && !RESERVED.contains(&c.split('.').next().unwrap_or("").to_ascii_uppercase().as_str())
    })
}

/// What the target must hold for `--write-private` to proceed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expect { Absent, Sha256(String) }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsCommand {
    CheckPath(String),
    MakeDir(String),
    WritePrivate { path: String, expect: Expect },
    Move { from: String, to: String },
    Delete(String),
}

/// Fixed argv shapes only; anything else is None (the helper then exits 1).
pub fn parse_fs_args(args: &[String]) -> Option<FsCommand> {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    match a.as_slice() {
        ["--check-path", p] if fs_path_ok(p) => Some(FsCommand::CheckPath((*p).into())),
        ["--make-dir", p] if fs_path_ok(p) => Some(FsCommand::MakeDir((*p).into())),
        ["--delete", p] if fs_path_ok(p) => Some(FsCommand::Delete((*p).into())),
        ["--write-private", p, "--expect", e] if fs_path_ok(p) => {
            let expect = if *e == "none" { Expect::Absent }
                else if e.len() == 64 && e.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) { Expect::Sha256((*e).into()) }
                else { return None };
            Some(FsCommand::WritePrivate { path: (*p).into(), expect })
        }
        ["--move", f, t] if fs_path_ok(f) && fs_path_ok(t) && !f.eq_ignore_ascii_case(t) => Some(FsCommand::Move { from: (*f).into(), to: (*t).into() }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ME: &str = "S-1-5-21-1-2-3-1001";
    fn v(x: &[&str]) -> Vec<String> { x.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn pipe_names_have_one_exact_shape() {
        assert!(pipe_endpoint_ok(r"\\.\pipe\abito-0123456789abcdef0123456789abcdef"));
        for bad in [r"\\.\pipe\abito-0123", r"\\.\pipe\abito-0123456789ABCDEF0123456789ABCDEF", r"\\.\pipe\other-0123456789abcdef0123456789abcdef",
            r"\\server\pipe\abito-0123456789abcdef0123456789abcdef", r"\\.\pipe\abito-0123456789abcdef0123456789abcdef\x", "/tmp/p-abcdef/s", ""] {
            assert!(!pipe_endpoint_ok(bad), "{bad}");
        }
    }
    #[test]
    fn only_owner_system_and_admins_may_hold_access() {
        assert!(dacl_private(ME, ME, Some(&v(&[ME, SID_SYSTEM, SID_ADMINISTRATORS]))));
        assert!(dacl_private(ME, ME, Some(&v(&[ME]))));
        assert!(!dacl_private(ME, ME, Some(&v(&[ME, "S-1-1-0"])))); // Everyone
        assert!(!dacl_private(ME, ME, Some(&v(&[ME, "S-1-5-32-545"])))); // Users
        assert!(!dacl_private(ME, ME, Some(&v(&[ME, "S-1-5-21-1-2-3-1002"])))); // another user
    }
    #[test]
    fn elevated_profile_owner_is_private_but_broad_aces_are_not() {
        assert!(dacl_private(SID_ADMINISTRATORS, ME, Some(&v(&[SID_SYSTEM, SID_ADMINISTRATORS, ME]))));
        for broad in ["S-1-1-0", "S-1-5-32-545", "S-1-5-11", "S-1-5-21-1-2-3-1002"] {
            assert!(!dacl_private(SID_ADMINISTRATORS, ME, Some(&v(&[ME, SID_SYSTEM, broad]))));
        }
        assert!(!dacl_private(SID_SYSTEM, ME, Some(&v(&[ME]))));
        assert!(!dacl_private(SID_ADMINISTRATORS, ME, None));
    }
    #[test]
    fn a_foreign_owner_or_a_null_dacl_is_refused() {
        assert!(!dacl_private("S-1-5-21-1-2-3-1002", ME, Some(&v(&[ME]))));
        assert!(!dacl_private(ME, ME, None));
    }
    #[test]
    fn island_root_is_absolute_and_defaults_under_local_app_data() {
        let local = r"C:\Users\a\AppData\Local";
        assert_eq!(island_root(None, Some(local)).unwrap(), std::path::Path::new(local).join("Abito"));
        // An ABITO_ISLAND_DIR override is honoured ONLY inside the canonical
        // protected root: anything else would bypass the profile ACLs that
        // guard the token file, so it is refused, never guessed.
        assert_eq!(
            island_root(Some(r"C:\Users\a\AppData\Local\Abito\test-island"), Some(local)).unwrap(),
            std::path::PathBuf::from(r"C:\Users\a\AppData\Local\Abito\test-island")
        );
        assert_eq!(
            island_root(Some(r"C:\Users\a\AppData\Local\Abito"), Some(local)).unwrap(),
            std::path::PathBuf::from(r"C:\Users\a\AppData\Local\Abito")
        );
        for bad in [r"D:\x", r"rel\x", r"C:\Users\a\AppData\Local\AbitoEvil", r"C:\other\Abito", r"C:\Users\a\AppData\Local\Abito\\.."] {
            assert!(island_root(Some(bad), Some(local)).is_none(), "{bad}");
        }
        assert!(island_root(None, Some("rel")).is_none());
        assert!(island_root(None, None).is_none());
    }
    #[test]
    fn install_owner_admins_only_when_elevated() {
        assert!(install_owner_ok(ME, ME, false));
        assert!(install_owner_ok(ME, ME, true));
        assert!(!install_owner_ok(SID_ADMINISTRATORS, ME, false));
        assert!(install_owner_ok(SID_ADMINISTRATORS, ME, true));
        assert!(!install_owner_ok(SID_SYSTEM, ME, true));
        assert!(!install_owner_ok("S-1-5-21-1-2-3-1002", ME, true));
    }
    #[test]
    fn install_acl_needs_install_owner_and_private_principals() {
        assert!(install_acl_private(ME, ME, false, Some(&v(&[ME, SID_SYSTEM, SID_ADMINISTRATORS]))));
        assert!(!install_acl_private(SID_ADMINISTRATORS, ME, false, Some(&v(&[ME]))));
        assert!(install_acl_private(SID_ADMINISTRATORS, ME, true, Some(&v(&[ME]))));
        assert!(!install_acl_private(ME, ME, true, Some(&v(&[ME, "S-1-1-0"]))));
        assert!(!install_acl_private(ME, ME, true, None));
    }
    #[test]
    fn fs_paths_are_plain_drive_letter_absolute() {
        for ok in [r"C:\Users\a\.claude\settings.json", r"d:\x\y", r"C:\a b\c.json"] { assert!(fs_path_ok(ok), "{ok}"); }
        for bad in ["", r"C:\", r"C:", "C:/x/y", r"\\server\share\x", r"\\?\C:\x", r"\\.\pipe\x", r"rel\x", r"C:\a\..\b", r"C:\a\.\b",
            r"C:\a\\b", r"C:\a\b\", r"C:\a\b.txt:ads", "C:\\a\\b\0", r"C:\a\NUL", r"C:\a\com1.txt", r"C:\a\b ", r"C:\a\b.", r"C:\a\b*", "C:\\a\\\u{1}", "C:\\a\\COM\u{b9}", "C:\\a\\lpt\u{b2}.txt", r"C:\a\PROGRA~1\x", "C:\\a\\CONIN$"] {
            assert!(!fs_path_ok(bad), "{bad:?}");
        }
        assert!(!fs_path_ok(&format!(r"C:\{}", "a".repeat(600))));
    }
    #[test]
    fn fs_args_have_one_fixed_shape_per_command() {
        let a = |x: &[&str]| x.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let p = r"C:\Users\a\.claude\settings.json";
        let h = "a".repeat(64);
        assert_eq!(parse_fs_args(&a(&["--check-path", p])), Some(FsCommand::CheckPath(p.into())));
        assert_eq!(parse_fs_args(&a(&["--make-dir", p])), Some(FsCommand::MakeDir(p.into())));
        assert_eq!(parse_fs_args(&a(&["--delete", p])), Some(FsCommand::Delete(p.into())));
        assert_eq!(parse_fs_args(&a(&["--write-private", p, "--expect", "none"])), Some(FsCommand::WritePrivate { path: p.into(), expect: Expect::Absent }));
        assert_eq!(parse_fs_args(&a(&["--write-private", p, "--expect", &h])), Some(FsCommand::WritePrivate { path: p.into(), expect: Expect::Sha256(h.clone()) }));
        assert_eq!(parse_fs_args(&a(&["--move", p, r"C:\Users\a\b"])), Some(FsCommand::Move { from: p.into(), to: r"C:\Users\a\b".into() }));
        for bad in [vec![], vec!["--check-path"], vec!["--check-path", "rel"], vec!["--check-path", p, "x"], vec!["--write-private", p],
            vec!["--write-private", p, "--expect", "ABC"], vec!["--write-private", p, "--expect", &"A".repeat(64)], vec!["--write-private", p, "--expect", "none", "x"],
            vec!["--move", p], vec!["--move", p, "rel"], vec!["--move", p, p], vec!["--make-dir", r"\\?\C:\x"], vec!["--unknown", p]] {
            assert!(parse_fs_args(&a(&bad)).is_none(), "{bad:?}");
        }
    }
}

use super::*;

fn unique_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "autostart-{}-{}-{}",
        tag,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

const EXE: &str = "/opt/abito/bin/koda";

/// A per-OS absolute binary path. `desktop_entry` is a pure text function,
/// but its absoluteness rule is the HOST's own (POSIX wants a leading `/`,
/// Windows a drive prefix — `Path::is_absolute` on Windows refuses "/opt/…"
/// because it has no prefix). The template tests feed the path shape each
/// OS can actually run, so the same closed-template properties are asserted
/// on Linux, macOS and Windows instead of being a POSIX-only premise.
fn sample_exe() -> std::path::PathBuf {
    if cfg!(windows) {
        std::path::PathBuf::from(r"C:\Program Files\Koda\bin\koda.exe")
    } else {
        std::path::PathBuf::from(EXE)
    }
}

/// Expected `Exec` argument list for a path text, derived with the SAME
/// Desktop Entry Spec rule the template applies: the whole path as ONE
/// argument inside double quotes, escaping the four reserved characters
/// (`\`, `"`, `$`, `` ` ``) with a backslash. On Windows this doubles every
/// separator backslash — the naive `Exec="{exe}"` interpolation without this
/// rule is what failed Windows CI 41729969464. The hand-written literals in
/// the tests pin the rule itself, so a shared drift is still caught.
fn spec_quoted(text: &str) -> String {
    let escaped: String = text
        .chars()
        .flat_map(|c| match c {
            '\\' | '"' | '$' | '`' => vec!['\\', c],
            c => vec![c],
        })
        .collect();
    format!("\"{escaped}\"")
}

// --- pure template -----------------------------------------------------------

#[test]
fn entry_is_the_closed_template() {
    let exe = sample_exe();
    let icon = exe.parent().expect("the sample has a parent").join("koda.png");
    let text = desktop_entry(&exe).expect("valid exe");
    let mut lines = text.lines();
    assert_eq!(lines.next(), Some("[Desktop Entry]"), "entry must start with the section header");
    let rest: Vec<&str> = lines.collect();
    let exec = format!("Exec={} --autostart", spec_quoted(exe.to_str().expect("utf-8 sample")));
    let icon = format!("Icon={}", icon.to_str().expect("utf-8 sample"));
    for key in [
        "Type=Application",
        "Name=Koda",
        "Comment=Koda",
        exec.as_str(),
        icon.as_str(),
        "Terminal=false",
        "Categories=Utility;",
        "StartupWMClass=Koda",
        "X-GNOME-Autostart-enabled=true",
    ] {
        assert!(rest.contains(&key), "closed template must carry {key:?} — got:\n{text}");
    }
    assert_eq!(rest.len(), 9, "no extra keys beyond the closed template");
    assert!(text.ends_with('\n'), "desktop entries end with a newline");
    // Pinned literal (not derived through spec_quoted): on Windows the spec
    // escaping doubles every separator backslash inside the quoted Exec value.
    #[cfg(windows)]
    assert!(
        text.contains(r#"Exec="C:\\Program Files\\Koda\\bin\\koda.exe" --autostart"#),
        "pinned Windows Exec literal — got:\n{text}"
    );
}

#[test]
fn entry_quoting_escapes_and_refuses_hostile_paths() {
    // spaces are safe inside the quoted Exec value — an absolute path of the
    // host's own shape, since absoluteness is judged per OS
    let spaced = if cfg!(windows) {
        std::path::PathBuf::from(r"C:\opt\Abito Apps\island")
    } else {
        std::path::PathBuf::from("/opt/Abito Apps/island")
    };
    let text = desktop_entry(&spaced).expect("path with a space is quotable");
    assert!(
        text.contains(&format!("Exec={} --autostart", spec_quoted(spaced.to_str().expect("utf-8")))),
        "{text}"
    );
    // the spec escapes backslash, double quote, dollar and backtick inside
    // quotes. On Windows the backslash IS a separator, so the path exercises
    // its doubling; on POSIX the classic specials path does all four.
    let (tricky, exec) = if cfg!(windows) {
        (r"C:\opt\a$b`c", r#""C:\\opt\\a\$b\`c""#)
    } else {
        ("/opt/a\"b\\c$d`e", r#""/opt/a\"b\\c\$d\`e""#)
    };
    let text = desktop_entry(std::path::Path::new(tricky)).expect("escapable specials");
    assert!(text.contains(&format!("Exec={exec} --autostart")), "{text}");
    // Windows-shaped proof that also runs on POSIX hosts: a leading-slash path
    // whose components carry backslashes is absolute on Linux/macOS, and the
    // quoted Exec value must double every backslash — the exact rule a native
    // `C:\…` path exercises where the backslash IS the separator. Pinned as a
    // literal so the doubling is never derived from the code it tests.
    if !cfg!(windows) {
        let win_shape = "/opt/C:\\Program Files\\Koda\\bin\\koda.exe";
        let text = desktop_entry(std::path::Path::new(win_shape)).expect("absolute on POSIX");
        assert!(
            text.contains(
                r#"Exec="/opt/C:\\Program Files\\Koda\\bin\\koda.exe" --autostart"#
            ),
            "Windows-shaped backslashes double through the real template — got:\n{text}"
        );
    }
    // control characters can never cross a .desktop value honestly
    for bad in ["/opt/a\nb", "/opt/a\rb", "/opt/a\tb", "\u{7}"] {
        assert!(desktop_entry(std::path::Path::new(bad)).is_none(), "{bad:?} refused");
    }
    // relative paths are refused: autostart must point at an absolute binary
    assert!(desktop_entry(std::path::Path::new("koda")).is_none());
    assert!(desktop_entry(std::path::Path::new("")).is_none());
}

// --- install path ------------------------------------------------------------

#[test]
fn autostart_dir_prefers_xdg_and_falls_back_to_home() {
    assert_eq!(
        autostart_dir(Some("/xdg/cfg"), Some("/home/u")),
        Some(std::path::PathBuf::from("/xdg/cfg/autostart"))
    );
    assert_eq!(
        autostart_dir(None, Some("/home/u")),
        Some(std::path::PathBuf::from("/home/u/.config/autostart"))
    );
    // an empty XDG value is not a directory: fall through to $HOME
    assert_eq!(
        autostart_dir(Some(""), Some("/home/u")),
        Some(std::path::PathBuf::from("/home/u/.config/autostart"))
    );
    // no usable root at all is honest: no path, no toggle
    assert_eq!(autostart_dir(None, None), None);
    assert_eq!(autostart_dir(None, Some("")), None);
    assert_eq!(autostart_dir(None, Some("relative")), None, "$HOME must be absolute");
}

// --- enable / disable (real files) -------------------------------------------

#[cfg(unix)]
#[test]
fn enable_writes_the_entry_and_disable_removes_it() {
    let root = unique_dir("roundtrip");
    let xdg = root.join("cfg");
    let path = entry_path(Some(xdg.to_str().expect("ascii")), None).expect("path");
    assert!(!is_enabled_at(&path), "nothing installed yet");

    let exe = root.join("bin").join("koda");
    std::fs::create_dir_all(exe.parent().expect("bin dir")).expect("bin dir");
    set_enabled_at(&path, true, &exe).expect("enable");
    assert!(is_enabled_at(&path), "entry installed");
    let text = std::fs::read_to_string(&path).expect("entry text");
    assert_eq!(Some(text.as_str()), desktop_entry(&exe).as_deref(), "entry is exactly the template");
    // 0644 like the packaging-installed .desktop
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&path).expect("meta").permissions().mode() & 0o777;
    assert_eq!(mode, 0o644, "entry mode 0644, got {mode:o}");

    // enabling again is idempotent, byte-identical (mtime/content churn free)
    let before = std::fs::read(&path).expect("read");
    set_enabled_at(&path, true, &exe).expect("enable again");
    assert_eq!(std::fs::read(&path).expect("read again"), before, "idempotent enable");

    set_enabled_at(&path, false, &exe).expect("disable");
    assert!(!is_enabled_at(&path), "entry removed");
    // removing an already-absent entry stays Ok
    set_enabled_at(&path, false, &exe).expect("disable again is fine");
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn enable_replaces_a_corrupt_or_foreign_entry() {
    let root = unique_dir("corrupt");
    let xdg = root.join("cfg");
    std::fs::create_dir_all(xdg.join("autostart")).expect("autostart dir");
    let path = entry_path(Some(xdg.to_str().expect("ascii")), None).expect("path");
    std::fs::write(&path, "not a desktop entry\n").expect("corrupt entry");
    assert!(is_enabled_at(&path), "a file is present: the toggle must say enabled, never lie");
    let exe = root.join("koda");
    set_enabled_at(&path, true, &exe).expect("enable replaces");
    let text = std::fs::read_to_string(&path).expect("entry text");
    assert_eq!(Some(text.as_str()), desktop_entry(&exe).as_deref(), "corrupt entry replaced");
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn enable_without_a_config_root_fails_honestly() {
    let path = entry_path(None, None);
    assert_eq!(path, None, "no usable config root: no honest path at all");
    // The real contract on a resolvable path: an unwritable location must
    // fail, not pretend. /proc/... can never take a new directory.
    let impossible = std::path::PathBuf::from("/proc/abito-cannot-exist/autostart/koda.desktop");
    let result = set_enabled_at(&impossible, true, std::path::Path::new(EXE));    assert!(result.is_err(), "unwritable location must fail, not pretend");
    assert!(!is_enabled_at(&impossible));
}

#[cfg(unix)]
#[test]
fn enable_creates_a_missing_autostart_directory() {
    let root = unique_dir("mkdir");
    let path = root.join("cfg").join("autostart").join("koda.desktop");
    set_enabled_at(&path, true, std::path::Path::new(EXE)).expect("enable creates the dir");
    assert!(is_enabled_at(&path));
    let _ = std::fs::remove_dir_all(&root);
}

/// Koda 0.1 — Human 30-oct («Vamosa a cerrar esta version cambiar el nombre del repo por Koda y apartir de aqui empezaremos esta sera la version 0.1» → «Todo se llama Koda, repo nuevo desde 0.1» + «Solo lo visible»): the visible launcher name is «Koda». K2-04 T6: the installed launcher and the binary it execs are named `koda` too (the binary is the installed main bin, not the crate).
#[test]
fn the_visible_app_name_is_koda() {
    let exe = if cfg!(windows) {
        std::path::PathBuf::from(r"C:\opt\abito\koda-launcher.exe")
    } else {
        std::path::PathBuf::from("/opt/abito/koda-launcher")
    };
    let text = super::desktop_entry(&exe).unwrap();
    assert!(text.contains("\nName=Koda\n"), "{text}");
    assert!(text.contains("\nComment=Koda\n"), "{text}");
    assert!(
        text.contains(&format!(
            "Exec={} --autostart",
            spec_quoted(exe.to_str().expect("utf-8"))
        )),
        "the launcher path is quoted into Exec: {text}"
    );
    assert!(!text.contains("Tauri"), "{text}");
}

#[test]
fn login_entry_identifies_itself_so_settings_stays_closed_at_login() {
    let exe = if cfg!(windows) {
        std::path::PathBuf::from(r"C:\Program Files\Koda\Abito.exe")
    } else {
        std::path::PathBuf::from("/private/Abito")
    };
    let text = desktop_entry(&exe).unwrap();
    assert!(text.lines().any(|line| line == format!("Exec={} --autostart", spec_quoted(exe.to_str().expect("utf-8")))));
}

/// The Windows twin of the autostart mechanism: there is no XDG autostart off
/// Unix, and the product says so honestly instead of pretending (a corrupt
/// stub would silently claim an entry that was never written). Linux/macOS
/// keep the real file effects in the `cfg(unix)` tests above.
#[cfg(not(unix))]
#[test]
fn non_unix_enable_refuses_honestly_and_never_writes() {
    let root = unique_dir("stub");
    let path = root.join("autostart").join("koda.desktop");
    let err = set_enabled_at(&path, true, &sample_exe()).expect_err("non-Unix autostart must refuse");
    assert!(matches!(err, AutostartError::Unsupported), "got {err:?}");
    assert!(!is_enabled_at(&path), "nothing may be written by the stub");
    let err = set_enabled_at(&path, false, &sample_exe()).expect_err("disable refuses too");
    assert!(matches!(err, AutostartError::Unsupported), "got {err:?}");
    assert!(!path.exists(), "no file, no directory: the stub is inert");
    let _ = std::fs::remove_dir_all(&root);
}

// --- K2-04 T6: retire the Koda 0.1 autostart entry -------------------------------------------------
// The 0.1 wrote `autostart/abito-island.desktop` (Exec = its own `abito-island --autostart`). The 0.2 installs elsewhere and
// leaves the 0.1 binary in place, so that entry would start the 0.1 island next to this one at every login. The 0.2 removes
// exactly that file, only when it is the closed template the 0.1 wrote; it never turns the 0.2 autostart on in its place.

#[cfg(unix)]
fn legacy_template(exe: &str) -> String {
    // what the 0.1 wrote: the whole path as ONE double-quoted word, with \\ " $ ` escaped by a backslash
    let quoted: String = exe.chars().flat_map(|c| match c { '\\' | '"' | '$' | '`' => vec!['\\', c], c => vec![c] }).collect();
    let icon = format!("{}/abito-island.png", exe.rsplit_once('/').map(|(dir, _)| dir).unwrap_or(""));
    format!(
        "[Desktop Entry]\nType=Application\nName=Koda\nComment=Koda\nExec=\"{quoted}\" --autostart\nIcon={icon}\nTerminal=false\nCategories=Utility;\nStartupWMClass=Abito-island\nX-GNOME-Autostart-enabled=true\n"
    )
}

#[cfg(unix)]
#[test]
fn the_legacy_entry_is_removed_and_the_new_one_is_not_created() {
    let dir = unique_dir("legacy-gone");
    let file = dir.join(LEGACY_ENTRY_FILE_NAME);
    std::fs::write(&file, legacy_template("/home/u/.local/share/abito-island/abito-island")).unwrap();
    assert_eq!(retire_legacy_entry(&dir), LegacyOutcome::Removed);
    assert!(!file.exists(), "the 0.1 entry is gone");
    assert!(!dir.join(ENTRY_FILE_NAME).exists(), "and nothing is enabled in its place");
    assert_eq!(retire_legacy_entry(&dir), LegacyOutcome::NotThere, "a second run is a no-op");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn an_entry_the_user_changed_or_that_is_not_ours_stays_untouched() {
    let dir = unique_dir("legacy-keep");
    let file = dir.join(LEGACY_ENTRY_FILE_NAME);
    let ours = legacy_template("/home/u/.local/share/abito-island/abito-island");
    let cases: Vec<(&str, String)> = vec![
        ("an extra key the user added", format!("{ours}X-MyKey=1\n")),
        ("a different program", ours.replace("/abito-island\" --autostart", "/other-app\" --autostart")),
        ("a look-alike binary name", ours.replace("/abito-island\" --autostart", "/not-abito-island\" --autostart")),
        ("an extra argument", ours.replace("--autostart", "--autostart --debug")),
        ("not a desktop entry", "Exec=/x/abito-island --autostart\n".to_string()),
        ("terminal app", ours.replace("Terminal=false", "Terminal=true")),
        ("too large", format!("{ours}{}", "# pad\n".repeat(2000))),
    ];
    for (why, text) in cases {
        std::fs::write(&file, &text).unwrap();
        assert_eq!(retire_legacy_entry(&dir), LegacyOutcome::Kept, "{why}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text, "{why}: byte-identical");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// A file the user touched is theirs. The 0.1 wrote ONE exact shape per binary path, so anything that is not byte-for-byte that
// shape stays, including the edits a person would realistically make.
#[cfg(unix)]
#[test]
fn every_realistic_user_edit_keeps_the_file() {
    let dir = unique_dir("legacy-edits");
    let file = dir.join(LEGACY_ENTRY_FILE_NAME);
    let exe = "/home/u/.local/share/abito-island/abito-island";
    let ours = legacy_template(exe);
    let cases: Vec<(&str, String)> = vec![
        ("a comment", format!("# my note\n{ours}")),
        ("a blank line", ours.replacen("Type=Application\n", "Type=Application\n\n", 1)),
        ("Name changed", ours.replace("Name=Koda", "Name=My Koda")),
        ("Comment changed", ours.replace("Comment=Koda", "Comment=mine")),
        ("Icon elsewhere", ours.replace("Icon=/home/u/.local/share/abito-island/abito-island.png", "Icon=/usr/share/icons/x.png")),
        ("Categories changed", ours.replace("Categories=Utility;", "Categories=Utility;Development;")),
        ("WM class changed", ours.replace("StartupWMClass=Abito-island", "StartupWMClass=Mine")),
        ("autostart disabled by the user", ours.replace("X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-enabled=false")),
        ("Type changed", ours.replace("Type=Application", "Type=Link")),
        ("only the header and Exec", format!("[Desktop Entry]\nExec=\"{exe}\" --autostart\n")),
        ("env prefix before the path", ours.replace(&format!("Exec=\"{exe}\""), &format!("Exec=env X=1 \"{exe}\""))),
        ("another program with our path as an argument", ours.replace(&format!("Exec=\"{exe}\""), &format!("Exec=/usr/bin/other-prog \"{exe}\""))),
        ("a relative binary", ours.replace(&format!("Exec=\"{exe}\""), "Exec=abito-island")),
        ("a duplicated Exec", ours.replacen("Terminal=false\n", "Terminal=false\nExec=/usr/bin/other --autostart\n", 1)),
        ("a duplicated key", format!("{ours}Name=Koda\n")),
        ("CRLF line endings", ours.replace('\n', "\r\n")),
        ("no trailing newline", ours.trim_end().to_string()),
        ("a second section", format!("{ours}\n[Desktop Action x]\nName=x\n")),
        ("Hidden", format!("{ours}Hidden=true\n")),
    ];
    for (why, text) in &cases {
        assert_ne!(text, &ours, "{why}: the fixture must differ from the template");
        std::fs::write(&file, text).unwrap();
        assert_eq!(retire_legacy_entry(&dir), LegacyOutcome::Kept, "{why}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), *text, "{why}: byte-identical");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// The XDG Base Directory spec: a relative XDG_CONFIG_HOME is invalid and ignored. It must never resolve against the current
// directory, where an exact-name file could be removed by mistake.
#[test]
fn a_relative_xdg_config_home_is_ignored_and_never_resolves_against_the_current_directory() {
    assert_eq!(autostart_dir(Some("relative/cfg"), Some("/home/u")), Some(std::path::PathBuf::from("/home/u/.config/autostart")));
    assert_eq!(autostart_dir(Some("relative/cfg"), None), None, "no valid base at all: no directory");
    assert_eq!(autostart_dir(Some(""), Some("/home/u")), Some(std::path::PathBuf::from("/home/u/.config/autostart")));
    assert_eq!(autostart_dir(None, Some("home/u")), None);
}

#[cfg(unix)]
#[test]
fn the_exact_0_1_entry_is_recognised_even_for_a_path_the_0_1_had_to_escape() {
    let dir = unique_dir("legacy-escaped");
    let file = dir.join(LEGACY_ENTRY_FILE_NAME);
    for exe in ["/home/u/.local/share/abito-island/abito-island", "/home/u/my \"dir\"/$x/`y`/abito-island", "/opt/with space/abito-island"] {
        std::fs::write(&file, legacy_template(exe)).unwrap();
        assert_eq!(retire_legacy_entry(&dir), LegacyOutcome::Removed, "{exe}");
        assert!(!file.exists());
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_symlink_or_a_directory_at_the_legacy_name_is_never_followed_or_removed() {
    let dir = unique_dir("legacy-link");
    let target = dir.join("target.desktop");
    std::fs::write(&target, legacy_template("/home/u/.local/share/abito-island/abito-island")).unwrap();
    let file = dir.join(LEGACY_ENTRY_FILE_NAME);
    std::os::unix::fs::symlink(&target, &file).unwrap();
    assert_eq!(retire_legacy_entry(&dir), LegacyOutcome::Kept);
    assert!(std::fs::symlink_metadata(&file).unwrap().file_type().is_symlink(), "the link stays");
    assert!(target.exists(), "and so does its target");
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    assert_eq!(retire_legacy_entry(&dir), LegacyOutcome::Kept);
    assert!(file.is_dir());
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn the_new_entry_and_other_files_in_the_autostart_dir_are_left_alone() {
    let dir = unique_dir("legacy-others");
    let new_entry = dir.join(ENTRY_FILE_NAME);
    std::fs::write(&new_entry, "[Desktop Entry]\nExec=/x/koda --autostart\n").unwrap();
    std::fs::write(dir.join("other.desktop"), "x").unwrap();
    assert_eq!(retire_legacy_entry(&dir), LegacyOutcome::NotThere);
    assert!(new_entry.exists() && dir.join("other.desktop").exists());
    assert_eq!(retire_legacy_entry(&dir.join("missing")), LegacyOutcome::NotThere, "a missing autostart dir is not an error");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn the_legacy_log_line_carries_no_path_or_content() {
    assert_eq!(LegacyOutcome::Removed.log_line().as_deref(), Some("legacy autostart entry removed"));
    assert_eq!(LegacyOutcome::Failed.log_line().as_deref(), Some("legacy autostart entry could not be removed; will retry on the next start"));
    assert_eq!(LegacyOutcome::NotThere.log_line(), None);
    assert_eq!(LegacyOutcome::Kept.log_line(), None);
}

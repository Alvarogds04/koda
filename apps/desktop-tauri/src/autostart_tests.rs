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

const EXE: &str = "/opt/abito/bin/abito-island";

/// A per-OS absolute binary path. `desktop_entry` is a pure text function,
/// but its absoluteness rule is the HOST's own (POSIX wants a leading `/`,
/// Windows a drive prefix — `Path::is_absolute` on Windows refuses "/opt/…"
/// because it has no prefix). The template tests feed the path shape each
/// OS can actually run, so the same closed-template properties are asserted
/// on Linux, macOS and Windows instead of being a POSIX-only premise.
fn sample_exe() -> std::path::PathBuf {
    if cfg!(windows) {
        std::path::PathBuf::from(r"C:\Program Files\Koda\bin\abito-island.exe")
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
    let icon = exe.parent().expect("the sample has a parent").join("abito-island.png");
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
        "StartupWMClass=Abito-island",
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
        text.contains(r#"Exec="C:\\Program Files\\Koda\\bin\\abito-island.exe" --autostart"#),
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
        let win_shape = "/opt/C:\\Program Files\\Koda\\bin\\abito-island.exe";
        let text = desktop_entry(std::path::Path::new(win_shape)).expect("absolute on POSIX");
        assert!(
            text.contains(
                r#"Exec="/opt/C:\\Program Files\\Koda\\bin\\abito-island.exe" --autostart"#
            ),
            "Windows-shaped backslashes double through the real template — got:\n{text}"
        );
    }
    // control characters can never cross a .desktop value honestly
    for bad in ["/opt/a\nb", "/opt/a\rb", "/opt/a\tb", "\u{7}"] {
        assert!(desktop_entry(std::path::Path::new(bad)).is_none(), "{bad:?} refused");
    }
    // relative paths are refused: autostart must point at an absolute binary
    assert!(desktop_entry(std::path::Path::new("abito-island")).is_none());
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

    let exe = root.join("bin").join("abito-island");
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
    let exe = root.join("abito-island");
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
    let impossible = std::path::PathBuf::from("/proc/abito-cannot-exist/autostart/abito-island.desktop");
    let result = set_enabled_at(&impossible, true, std::path::Path::new(EXE));    assert!(result.is_err(), "unwritable location must fail, not pretend");
    assert!(!is_enabled_at(&impossible));
}

#[cfg(unix)]
#[test]
fn enable_creates_a_missing_autostart_directory() {
    let root = unique_dir("mkdir");
    let path = root.join("cfg").join("autostart").join("abito-island.desktop");
    set_enabled_at(&path, true, std::path::Path::new(EXE)).expect("enable creates the dir");
    assert!(is_enabled_at(&path));
    let _ = std::fs::remove_dir_all(&root);
}

/// Koda 0.1 — Human 30-oct («Vamosa a cerrar esta version cambiar el nombre del repo por Koda y apartir de aqui empezaremos esta sera la version 0.1» → «Todo se llama Koda, repo nuevo desde 0.1» + «Solo lo visible»): the visible launcher name is «Koda»; the binary, icon file and class stay internal.
#[test]
fn the_visible_app_name_is_koda() {
    let exe = if cfg!(windows) {
        std::path::PathBuf::from(r"C:\opt\abito\abito-island-launcher.exe")
    } else {
        std::path::PathBuf::from("/opt/abito/abito-island-launcher")
    };
    let text = super::desktop_entry(&exe).unwrap();
    assert!(text.contains("\nName=Koda\n"), "{text}");
    assert!(text.contains("\nComment=Koda\n"), "{text}");
    assert!(
        text.contains(&format!(
            "Exec={} --autostart",
            spec_quoted(exe.to_str().expect("utf-8"))
        )),
        "the launcher keeps its internal name: {text}"
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
    let path = root.join("autostart").join("abito-island.desktop");
    let err = set_enabled_at(&path, true, &sample_exe()).expect_err("non-Unix autostart must refuse");
    assert!(matches!(err, AutostartError::Unsupported), "got {err:?}");
    assert!(!is_enabled_at(&path), "nothing may be written by the stub");
    let err = set_enabled_at(&path, false, &sample_exe()).expect_err("disable refuses too");
    assert!(matches!(err, AutostartError::Unsupported), "got {err:?}");
    assert!(!path.exists(), "no file, no directory: the stub is inert");
    let _ = std::fs::remove_dir_all(&root);
}

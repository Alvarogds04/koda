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

// --- pure template -----------------------------------------------------------

#[test]
fn entry_is_the_closed_template() {
    let text = desktop_entry(std::path::Path::new(EXE)).expect("valid exe");
    let mut lines = text.lines();
    assert_eq!(lines.next(), Some("[Desktop Entry]"), "entry must start with the section header");
    let rest: Vec<&str> = lines.collect();
    for key in [
        "Type=Application",
        "Name=Koda",
        "Comment=Koda",
        "Exec=\"/opt/abito/bin/abito-island\" --autostart",
        "Icon=/opt/abito/bin/abito-island.png",
        "Terminal=false",
        "Categories=Utility;",
        "StartupWMClass=Abito-island",
        "X-GNOME-Autostart-enabled=true",
    ] {
        assert!(rest.contains(&key), "closed template must carry {key:?} — got:\n{text}");
    }
    assert_eq!(rest.len(), 9, "no extra keys beyond the closed template");
    assert!(text.ends_with('\n'), "desktop entries end with a newline");
}

#[test]
fn entry_quoting_escapes_and_refuses_hostile_paths() {
    // spaces are safe inside the quoted Exec value
    let text = desktop_entry(std::path::Path::new("/opt/Abito Apps/island"))
        .expect("path with a space is quotable");
    assert!(text.contains("Exec=\"/opt/Abito Apps/island\""), "{text}");
    // the spec escapes backslash, double quote, dollar and backtick inside quotes
    let text = desktop_entry(std::path::Path::new("/opt/a\"b\\c$d`e"))
        .expect("escapable specials");
    assert!(text.contains("Exec=\"/opt/a\\\"b\\\\c\\$d\\`e\""), "{text}");
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
    let text = super::desktop_entry(std::path::Path::new("/opt/abito/abito-island-launcher")).unwrap();
    assert!(text.contains("\nName=Koda\n"), "{text}");
    assert!(text.contains("\nComment=Koda\n"), "{text}");
    assert!(text.contains("abito-island-launcher\" --autostart"), "the launcher keeps its internal name: {text}");
    assert!(!text.contains("Tauri"), "{text}");
}

#[test]
fn login_entry_identifies_itself_so_settings_stays_closed_at_login() {
    let text = desktop_entry(std::path::Path::new("/private/Abito")).unwrap();
    assert!(text.lines().any(|line| line == "Exec=\"/private/Abito\" --autostart"));
}

//! Installed runtime lookup: no build-tree dependency, explicit roots retain precedence.
use abito_island::identity::project_root_with_home;
use std::path::Path;

#[test]
fn installed_identity_preserves_explicit_validation_and_linux_behavior() {
    let home = std::env::current_dir().unwrap();
    let home = home.to_str().unwrap();
    assert_eq!(project_root_with_home(None, Some(home), Some("/missing")),
        abito_island::identity::project_root_for(None, Some(home)));
    #[cfg(not(target_os = "windows"))]
    assert_eq!(project_root_with_home(None, Some(home), Some("/missing")), std::fs::canonicalize(home).ok());
    for invalid in ["", "relative", "/tmp/../etc", "/definitely/not/here"] {
        assert_eq!(project_root_with_home(None, Some(invalid), Some(home)), None);
    }
    #[cfg(target_os = "linux")]
    assert_eq!(project_root_with_home(None, None, Some(home)), None);
    #[cfg(not(target_os = "linux"))]
    assert_eq!(project_root_with_home(None, None, Some(home)), std::fs::canonicalize(home).ok());
    assert_eq!(project_root_with_home(None, None, None), None);
    assert_eq!(project_root_with_home(None, None, Some("relative")), None);
    assert_eq!(project_root_with_home(Some(env!("CARGO_MANIFEST_DIR")), None, Some(home)),
        abito_island::identity::project_root_for(Some(env!("CARGO_MANIFEST_DIR")), None));
}

#[cfg(target_os = "windows")]
#[test]
fn windows_home_accepts_native_drive_path_without_changing_explicit_setting() {
    let home = std::env::var("USERPROFILE").expect("Windows user profile");
    assert!(Path::new(&home).is_absolute());
    assert_eq!(project_root_with_home(None, None, Some(&home)), std::fs::canonicalize(&home).ok());
    assert_eq!(project_root_with_home(None, Some(&home), Some(&home)),
        abito_island::identity::project_root_for(None, Some(&home)));
}

#[test]
fn installed_daemon_uses_platform_bundle_location() {
    let exe = Path::new("/Applications/Abito.app/Contents/MacOS/abito-island");
    let result = abito_island::daemonhost::installed_daemon_cli(exe).unwrap();
    #[cfg(target_os = "macos")]
    assert_eq!(result, Path::new("/Applications/Abito.app/Contents/Resources/desktop-daemon/src/cli.cjs"));
    #[cfg(not(target_os = "macos"))]
    assert_eq!(result, exe.parent().unwrap().join("desktop-daemon/src/cli.cjs"));
}

#[cfg(target_os = "macos")]
#[test]
fn finder_discovers_npm_global_runtimes_without_shell_path() {
    use std::{fs, os::unix::fs::PermissionsExt};
    let home = std::env::temp_dir().join(format!("abito-discovery-{}", std::process::id()));
    let bin = home.join(".npm-global/bin");
    fs::create_dir_all(&bin).unwrap();
    for name in ["pi", "node"] {
        let file = bin.join(name);
        fs::write(&file, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(abito_island::daemonhost::discover(name, None, Some(home.as_os_str())).unwrap(), file);
    }
    fs::remove_dir_all(home).unwrap();
}

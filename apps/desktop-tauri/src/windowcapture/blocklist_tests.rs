use super::*;

#[test]
fn every_listed_app_is_refused_on_each_platform() {
    // S5: the list of Gentle Dot, plus Koda itself and the Linux equivalents.
    let macos = [
        ("com.abitog.Koda", "Koda"), ("com.apple.systempreferences", "System Settings"),
        ("com.apple.SecurityAgent", "SecurityAgent"), ("com.apple.loginwindow", "loginwindow"),
        ("com.apple.UserNotificationCenter", "x"), ("com.apple.LocalAuthentication.UIAgent", "x"),
        ("com.apple.CoreServicesUIAgent", "x"), ("com.apple.keychainaccess", "Keychain Access"),
        ("com.apple.Passwords", "Passwords"), ("com.1password.1password", "1Password"),
        ("com.agilebits.onepassword7", "x"), ("com.bitwarden.desktop", "Bitwarden"),
        ("com.dashlane.dashlanephonefinal", "Dashlane"), ("com.lastpass.LastPass", "LastPass"),
    ];
    for (id, name) in macos {
        assert!(blocked_reason_on(Platform::MacOs, id, name).is_some(), "macos {id}");
    }
    let windows = [
        "Koda", "Settings", "Control Panel", "Windows Security", "User Account Control", "CredentialUIBroker",
        "LogonUI", "LockApp", "Credential Manager", "1Password", "Bitwarden", "Dashlane", "KeePass", "KeePassXC",
        "LastPass", UNIDENTIFIED,
    ];
    for name in windows {
        assert!(blocked_reason_on(Platform::Windows, "", name).is_some(), "windows {name}");
    }
    assert!(blocked_reason_on(Platform::Windows, "bitwarden.exe", "x").is_some());
    // K2-04 T6: the installed main binary is `koda` (its WM_CLASS / exe stem), blurred by the same Koda entry.
    assert!(blocked_reason_on(Platform::Windows, "koda.exe", "Koda").is_some(), "koda.exe");
    assert!(blocked_reason_on(Platform::Windows, "C:\\Program Files\\KeePassXC\\KeePassXC.exe", "x").is_some());
    let linux = [
        ("org.gnome.Settings", "Settings"), ("polkit-gnome-authentication-agent-1", "x"),
        ("org.gnome.seahorse.Application", "Passwords and Keys"), ("1password", "1Password"),
        ("bitwarden", "Bitwarden"), ("keepassxc", "KeePassXC"), ("org.keepassxc.KeePassXC", "x"),
        ("com.abitog.Koda", "Koda"), ("dashlane", "x"), ("lastpass", "x"), ("keepass", "x"),
        // K2-04 T6: the installed binary/window id is `koda`, not `abito-island`.
        ("koda", "x"),
    ];
    for (id, name) in linux {
        assert!(blocked_reason_on(Platform::Linux, id, name).is_some(), "linux {id}");
    }
}

#[test]
fn helpers_and_case_do_not_slip_through() {
    assert_eq!(blocked_reason_on(Platform::MacOs, "com.apple.Passwords.MenuBarExtra", "x"), Some("Passwords"));
    assert_eq!(blocked_reason_on(Platform::MacOs, "COM.APPLE.KEYCHAINACCESS", "x"), Some("Keychain Access"));
}

#[test]
fn the_koda_entry_names_every_identifier_of_ours() {
    // K2-04 T6 (L20/L22): the installed main binary is `koda`, so its window id/WM_CLASS is `koda` too. The id list
    // must carry it explicitly: a substring or name match would be the only thing catching it otherwise, and a
    // renaming later (T7) must not silently drop Koda out of its own blocklist.
    assert!(KODA.ids.contains(&"koda"), "the installed binary id: {:?}", KODA.ids);
    assert!(KODA.ids.contains(&"com.abitog.Koda"), "the bundle id: {:?}", KODA.ids);
    assert!(KODA.ids.contains(&"abito-island"), "the 0.1 binary still running: {:?}", KODA.ids);
}

#[test]
fn ordinary_apps_are_allowed() {
    assert_eq!(blocked_reason_on(Platform::MacOs, "com.apple.Safari", "Safari"), None);
    assert_eq!(blocked_reason_on(Platform::MacOs, "com.apple.PasswordsX", "x"), None);
    assert_eq!(blocked_reason_on(Platform::Linux, "firefox", "Firefox"), None);
    assert_eq!(blocked_reason_on(Platform::Linux, "org.gnome.Terminal", "Terminal"), None);
    assert_eq!(blocked_reason_on(Platform::Windows, "", "Notepad"), None);
    // K2-04 T6: the id match is exact (or dot-prefixed), so a neighbour name is never blurred.
    assert_eq!(blocked_reason_on(Platform::Linux, "kodak", "x"), None);
    assert_eq!(blocked_reason_on(Platform::Windows, "kodak.exe", "x"), None);
}

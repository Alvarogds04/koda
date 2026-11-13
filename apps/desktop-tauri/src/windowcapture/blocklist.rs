//! Apps a capture may never target (S5): Koda itself, the system settings, the login and
//! authorization prompts, the credential stores and the known password managers.
//!
//! Adapted from Gentle Dot `computer/blocklist.rs`, MIT. Gentle Dot identifies a window by bundle
//! id (macOS) or executable stem (Windows); Koda also gets Linux, where `contextwin` reports the
//! app id (WM_CLASS or desktop id) and the app name.

struct Entry {
    label: &'static str,
    /// An id also blocks its helpers (`com.apple.Passwords` blocks `com.apple.Passwords.MenuBarExtra`).
    ids: &'static [&'static str],
    names: &'static [&'static str],
}

/// The name Windows gives an app it does not identify. It is blocked.
pub const UNIDENTIFIED: &str = "Unidentified app";

const KODA: Entry = Entry { label: "Koda", ids: &["com.abitog.Koda", "koda", "abito-island"], names: &["Koda", "Abito"] };

const MACOS: &[Entry] = &[
    KODA,
    Entry { label: "System Settings", ids: &["com.apple.systempreferences"], names: &["System Settings", "System Preferences"] },
    Entry { label: "SecurityAgent", ids: &["com.apple.SecurityAgent"], names: &["SecurityAgent"] },
    Entry { label: "loginwindow", ids: &["com.apple.loginwindow"], names: &["loginwindow"] },
    Entry { label: "UserNotificationCenter", ids: &["com.apple.UserNotificationCenter"], names: &["UserNotificationCenter"] },
    Entry { label: "LocalAuthentication", ids: &["com.apple.LocalAuthentication.UIAgent"], names: &["LocalAuthenticationUIAgent"] },
    Entry { label: "CoreServicesUIAgent", ids: &["com.apple.CoreServicesUIAgent"], names: &["CoreServicesUIAgent"] },
    Entry { label: "Keychain Access", ids: &["com.apple.keychainaccess"], names: &["Keychain Access"] },
    Entry { label: "1Password", ids: &["com.1password", "com.agilebits"], names: &["1Password", "1Password 7", "1Password 8"] },
    Entry { label: "Bitwarden", ids: &["com.bitwarden"], names: &["Bitwarden"] },
    Entry { label: "Dashlane", ids: &["com.dashlane"], names: &["Dashlane"] },
    Entry { label: "LastPass", ids: &["com.lastpass"], names: &["LastPass"] },
    Entry { label: "Passwords", ids: &["com.apple.Passwords"], names: &["Passwords"] },
];

const WINDOWS: &[Entry] = &[
    KODA,
    Entry { label: "Settings", ids: &["systemsettings"], names: &["Settings", "Windows Settings"] },
    Entry { label: "Control Panel", ids: &["control"], names: &["Control Panel"] },
    Entry { label: "Windows Security", ids: &["sechealthui", "securityhealthsystray"], names: &["Windows Security"] },
    Entry { label: "User Account Control", ids: &["consent"], names: &["User Account Control"] },
    Entry { label: "CredentialUIBroker", ids: &["credentialuibroker"], names: &["CredentialUIBroker"] },
    Entry { label: "LogonUI", ids: &["logonui"], names: &["LogonUI"] },
    Entry { label: "LockApp", ids: &["lockapp"], names: &["LockApp"] },
    Entry { label: "Credential Manager", ids: &[], names: &["Credential Manager"] },
    Entry { label: "1Password", ids: &["1password"], names: &["1Password"] },
    Entry { label: "Bitwarden", ids: &["bitwarden"], names: &["Bitwarden"] },
    Entry { label: "Dashlane", ids: &["dashlane"], names: &["Dashlane"] },
    Entry { label: "LastPass", ids: &["lastpass"], names: &["LastPass"] },
    Entry { label: "KeePass", ids: &["keepass"], names: &["KeePass", "KeePass Password Safe"] },
    Entry { label: "KeePassXC", ids: &["keepassxc"], names: &["KeePassXC"] },
    Entry { label: "an app Windows does not identify", ids: &[], names: &[UNIDENTIFIED] },
];

/// Linux (Koda's addition, S5): the same password managers, plus the GNOME settings and the
/// authorization dialogs (polkit agents, the keyring prompt, the lock screen).
const LINUX: &[Entry] = &[
    KODA,
    Entry {
        label: "Settings",
        ids: &["org.gnome.Settings", "gnome-control-center", "systemsettings", "org.kde.systemsettings"],
        names: &["Settings", "System Settings"],
    },
    Entry {
        label: "an authorization dialog",
        ids: &["polkit-gnome-authentication-agent-1", "org.gnome.PolicyKit", "polkit-kde-authentication-agent-1", "gcr-prompter", "org.gnome.keyring.PromptingTest", "gnome-keyring-prompt"],
        names: &["Authentication Required", "Authenticate", "Unlock Login Keyring", "Unlock Keyring"],
    },
    Entry { label: "the lock screen", ids: &["gnome-screensaver-dialog", "org.gnome.ScreenSaver", "kscreenlocker_greet"], names: &["Lock Screen"] },
    Entry { label: "Passwords and Keys", ids: &["org.gnome.seahorse", "seahorse", "org.kde.kwalletmanager5", "org.kde.kwalletmanager"], names: &["Passwords and Keys", "Seahorse", "KWalletManager"] },
    Entry { label: "1Password", ids: &["1password"], names: &["1Password"] },
    Entry { label: "Bitwarden", ids: &["bitwarden"], names: &["Bitwarden"] },
    Entry { label: "Dashlane", ids: &["dashlane"], names: &["Dashlane"] },
    Entry { label: "LastPass", ids: &["lastpass"], names: &["LastPass"] },
    Entry { label: "KeePass", ids: &["keepass"], names: &["KeePass", "KeePass Password Safe"] },
    Entry { label: "KeePassXC", ids: &["keepassxc", "org.keepassxc.KeePassXC"], names: &["KeePassXC"] },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Windows,
    Linux,
}

#[cfg(target_os = "macos")]
pub const PLATFORM: Platform = Platform::MacOs;
#[cfg(windows)]
pub const PLATFORM: Platform = Platform::Windows;
#[cfg(not(any(target_os = "macos", windows)))]
pub const PLATFORM: Platform = Platform::Linux;

fn entries(platform: Platform) -> &'static [Entry] {
    match platform {
        Platform::MacOs => MACOS,
        Platform::Windows => WINDOWS,
        Platform::Linux => LINUX,
    }
}

fn id_matches(id: &str, blocked: &str) -> bool {
    let (id, blocked) = (id.to_lowercase(), blocked.to_lowercase());
    id == blocked || id.strip_prefix(&blocked).is_some_and(|rest| rest.starts_with('.'))
}

/// Why a window of app `app_id` / `app_name` may not be captured, or `None` when it may.
pub fn blocked_reason(app_id: &str, app_name: &str) -> Option<&'static str> {
    blocked_reason_on(PLATFORM, app_id, app_name)
}

/// An id or name with its path and platform suffixes removed (`C:\x\KeePass.exe`, `Keychain Access.app`).
fn stem(text: &str) -> String {
    let text = text.trim().trim_end_matches(['/', '\\']);
    let text = text.rsplit(['/', '\\']).next().unwrap_or(text).trim();
    let lower = text.to_ascii_lowercase();
    for suffix in [".exe", ".lnk", ".app", ".desktop"] {
        if lower.ends_with(suffix) {
            return text[..text.len() - suffix.len()].to_string();
        }
    }
    text.to_string()
}

pub fn blocked_reason_on(platform: Platform, app_id: &str, app_name: &str) -> Option<&'static str> {
    let (id, name) = (stem(app_id), stem(app_name));
    entries(platform)
        .iter()
        .find(|e| {
            e.ids.iter().any(|b| (!id.is_empty() && id_matches(&id, b)) || (!name.is_empty() && id_matches(&name, b)))
                || e.names.iter().any(|n| n.eq_ignore_ascii_case(&name) || n.eq_ignore_ascii_case(&id))
        })
        .map(|e| e.label)
}

#[cfg(test)]
#[path = "blocklist_tests.rs"]
mod tests;

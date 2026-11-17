// Adapted from Coucou windows/src-tauri/src/phone_link/keystore.rs @71b773f, Copyright (c) 2026 Rhytam Biswas, MIT
// (the phone link files carry that holder; protocol: Coucou docs/ANDROID_LINK.md).
//
// Where the phone link's identity and token really live: the OS keystore (`secrets.rs`), never a file, never
// `prefs.json`. This is the adapter from the app's store to the link's own `pairing::SecretStore`, generic over the
// store so its rules are a unit test with an in-memory one.
//
// The keys are in `secrets::INTERNAL_KEYS`: the page can never set, clear or ask about them, and `secrets`'
// command parser is not used here at all.
use super::pairing;

/// The ONE text a refused write answers with: fixed, so a platform error can never carry a value into a log.
pub const WRITE_FAILED: &str = "the OS keystore refused to store the phone link";

/// Reported once per process: a keystore that is not there must not reprint on every connection attempt.
static READ_FAILED: std::sync::Once = std::sync::Once::new();

pub struct KeychainStore<S: crate::secrets::SecretStore> {
    store: S,
}

impl<S: crate::secrets::SecretStore> KeychainStore<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }
}

/// The app's store: the Secret Service / Credential Manager entry Koda uses for its own keys.
pub fn keychain() -> KeychainStore<crate::secrets::Keychain> {
    KeychainStore::new(crate::secrets::Keychain)
}

impl<S: crate::secrets::SecretStore + Send + Sync> pairing::SecretStore for KeychainStore<S> {
    /// A missing, empty or unreadable entry is all the same to the link: absent, so it makes a new one (and a
    /// new certificate means the phone pairs again). No value ever reaches the report.
    fn get(&self, key: &str) -> Option<String> {
        match self.store.read(key) {
            Ok(value) => value.filter(|v| !v.is_empty()),
            Err(error) => {
                READ_FAILED.call_once(|| eprintln!("phone link: the keystore is unavailable ({})", code(error)));
                None
            }
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.store.write(key, value).map_err(|_| WRITE_FAILED.to_string())
    }
}

fn code(error: crate::secrets::StoreError) -> &'static str {
    match error {
        crate::secrets::StoreError::Unavailable => "unavailable",
        crate::secrets::StoreError::Failed => "failed",
    }
}

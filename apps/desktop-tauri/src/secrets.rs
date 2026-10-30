//! #467 key store: API keys and tokens live in the OS keychain (Secret Service on Linux,
//! Credential Manager on Windows), never on disk, never in the WebView and never in a log.
//!
//! Adapted from Coucou src-tauri/src/secrets.rs @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
//! (Allowlist idea and `keyring` backend only; the closed command, the `unavailable` answer
//! and the presence-only view are Abito's.)
//!
//! Contract:
//! - closed key list: any other name is refused at parse time;
//! - NO plaintext fallback: with no Secret Service the answer is `unavailable`, nothing is
//!   written anywhere else and nothing is retried;
//! - the WebView can only `set`, `clear` or ask `present`; the value is never read back to it
//!   and never appears in `Debug`, errors or answers.
use serde_json::{json, Value};

#[cfg(test)]
#[path = "secrets_tests.rs"]
mod tests;

/// Keychain service name: Abito's own app identifier (tauri.conf.json).
pub const SERVICE: &str = "com.abitog.AbitoTauri";

/// Every key the island may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    "anthropic-api-key",
    "claude-oauth",
    "chatgpt-oauth",
    "openai-api-key",
    "google-api-key",
    "openrouter-api-key",
    "nan-api-key",
    "opencode-go-api-key",
    "openai-compatible-key",
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "stripe-api-key",
    "resend-api-key",
    "resend-from",
    "smtp-host",
    "smtp-user",
    "smtp-password",
    "smtp-from",
    "imap-host",
    "imap-user",
    "imap-password",
    "notion-api-key",
    "calcom-api-key",
    "elevenlabs-api-key",
];

/// Keys the host itself keeps in the keychain (phone link certificate, key and pairing token, #490).
/// They are NOT in [`KNOWN_KEYS`]: the page can never set, clear or ask about them.
pub const INTERNAL_KEYS: &[&str] = &["phone-link-cert", "phone-link-key", "phone-link-token"];

/// Upper bound of a stored value (Windows Credential Manager caps a secret near 2.5 KB).
pub const MAX_VALUE_BYTES: usize = 2048;

/// Why the backend could not serve a request. Carries no text on purpose: a platform
/// error string must never be able to carry a value into a log or an answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    /// No keychain/Secret Service reachable or locked out.
    Unavailable,
    /// The keychain answered but refused the operation.
    Failed,
}

/// The keychain seam. `read` returns `Ok(None)` for a missing entry.
pub trait SecretStore {
    fn read(&self, key: &str) -> Result<Option<String>, StoreError>;
    fn write(&self, key: &str, value: &str) -> Result<(), StoreError>;
    /// Deleting a missing entry is `Ok`.
    fn delete(&self, key: &str) -> Result<(), StoreError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretError {
    Unavailable,
    Failed,
}

impl SecretError {
    /// Bridge error code for the WebView.
    pub fn code(self) -> &'static str {
        match self {
            SecretError::Unavailable => "unavailable",
            SecretError::Failed => "save_failed",
        }
    }
}

impl From<StoreError> for SecretError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Unavailable => SecretError::Unavailable,
            StoreError::Failed => SecretError::Failed,
        }
    }
}

/// A parsed command. The key is always one of [`KNOWN_KEYS`].
#[derive(Clone, PartialEq, Eq)]
pub enum Command {
    Set { key: &'static str, value: String },
    Clear(&'static str),
    Present(&'static str),
}

impl std::fmt::Debug for Command {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Command::Set { key, .. } => write!(f, "Set {{ key: {key:?}, value: <redacted> }}"),
            Command::Clear(key) => write!(f, "Clear({key:?})"),
            Command::Present(key) => write!(f, "Present({key:?})"),
        }
    }
}

/// Closed schema: `{action:"set",key,value}`, `{action:"clear",key}`, `{action:"present",key}`.
/// Unknown fields, unknown keys, empty/oversized/NUL-bearing values → `None`.
pub fn parse_command(payload: &Value) -> Option<Command> {
    let obj = payload.as_object()?;
    let key = KNOWN_KEYS
        .iter()
        .copied()
        .find(|k| obj.get("key").and_then(Value::as_str) == Some(*k))?;
    match obj.get("action")?.as_str()? {
        "set" if obj.len() == 3 && !matches!(key, "claude-oauth" | "chatgpt-oauth") => {
            let value = obj.get("value")?.as_str()?;
            if value.is_empty() || value.len() > MAX_VALUE_BYTES || value.contains('\0') {
                return None;
            }
            Some(Command::Set { key, value: value.to_owned() })
        }
        "clear" if obj.len() == 2 => Some(Command::Clear(key)),
        "present" if obj.len() == 2 => Some(Command::Present(key)),
        _ => None,
    }
}

/// Runs one command with exactly one backend call. The answer is presence only.
pub fn apply(store: &dyn SecretStore, command: &Command) -> Result<Value, SecretError> {
    let (key, present) = match command {
        Command::Set { key, value } => {
            store.write(key, value)?;
            (*key, true)
        }
        Command::Clear(key) => {
            store.delete(key)?;
            (*key, false)
        }
        Command::Present(key) => {
            let found = store.read(key)?.is_some_and(|v| !v.is_empty());
            (*key, found)
        }
    };
    Ok(json!({"key": key, "present": present}))
}

/// The real keychain. Linux: Secret Service; Windows: Credential Manager; any other OS has
/// no store and is honestly `Unavailable` (never a file).
pub struct Keychain;

#[cfg(any(target_os = "linux", windows))]
mod native {
    use super::{StoreError, SERVICE};

    pub fn entry(key: &str) -> Result<keyring::Entry, StoreError> {
        keyring::Entry::new(SERVICE, key).map_err(map)
    }

    /// Error text is dropped on purpose (see [`StoreError`]).
    pub fn map(e: keyring::Error) -> StoreError {
        match e {
            keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_) => {
                StoreError::Unavailable
            }
            _ => StoreError::Failed,
        }
    }
}

#[cfg(any(target_os = "linux", windows))]
impl SecretStore for Keychain {
    fn read(&self, key: &str) -> Result<Option<String>, StoreError> {
        match native::entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(native::map(e)),
        }
    }
    fn write(&self, key: &str, value: &str) -> Result<(), StoreError> {
        native::entry(key)?.set_password(value).map_err(native::map)
    }
    fn delete(&self, key: &str) -> Result<(), StoreError> {
        match native::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(native::map(e)),
        }
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
impl SecretStore for Keychain {
    fn read(&self, _: &str) -> Result<Option<String>, StoreError> {
        Err(StoreError::Unavailable)
    }
    fn write(&self, _: &str, _: &str) -> Result<(), StoreError> {
        Err(StoreError::Unavailable)
    }
    fn delete(&self, _: &str) -> Result<(), StoreError> {
        Err(StoreError::Unavailable)
    }
}

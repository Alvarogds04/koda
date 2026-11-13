//! #467 key store: API keys and tokens live in the OS keychain (Secret Service on Linux,
//! the login Keychain on macOS, Credential Manager on Windows), never on disk, never in the WebView and never in a log.
//!
//! Adapted from Coucou src-tauri/src/secrets.rs @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
//! (Allowlist idea and `keyring` backend only; the closed command, the `unavailable` answer
//! and the presence-only view are Abito's.)
//!
//! Contract:
//! - closed key list: any other name is refused at parse time;
//! - NO plaintext fallback: with no reachable keychain the answer is `unavailable`, nothing is
//!   written anywhere else and nothing is retried;
//! - the WebView can only `set`, `clear` or ask `present`; the value is never read back to it
//!   and never appears in `Debug`, errors or answers.
use serde_json::{json, Value};

#[cfg(test)]
#[path = "secrets_tests.rs"]
mod tests;

/// Keychain service name: Koda's own entry, independent of the bundle identifier (T6 renames that
/// one; this constant keeps the two apart on purpose).
pub const SERVICE: &str = "com.abitog.Koda";

/// The 0.1 keychain service. NOTHING reads credentials from it any more (no alias, no fallback,
/// L4); it exists for exactly one purpose — a one-time cleanup of 0.1 entries, which must keep
/// naming it explicitly (K2-10 T8 deletes the seven retired imap-*/smtp-* keys). Using [`SERVICE`]
/// there would silently leave the 0.1 entries in the user's keychain forever.
pub const LEGACY_KEYCHAIN_SERVICE: &str = "com.abitog.AbitoTauri";

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
    "notion-api-key",
    "calcom-api-key",
    "calendar-ics-url",
    "elevenlabs-api-key",
];

/// Keys the host itself keeps in the keychain (phone link certificate, key and pairing token, #490;
/// the Gmail client and tokens, K2-10; the Telegram credentials and session, K2-13).
/// They are NOT in [`KNOWN_KEYS`]: the page can never set, clear or ask about them.
pub const INTERNAL_KEYS: &[&str] = &[
    "phone-link-cert",
    "phone-link-key",
    "phone-link-token",
    "gmail-oauth",
    // K2-13 (S10/S20): the api id, the api hash and the exported Telegram session. The session IS a credential
    // (whoever holds it is the account), so it lives here and only here; the page may know whether the three exist.
    "telegram-api-id",
    "telegram-api-hash",
    "telegram-session",
];

/// Upper bound of a stored value (Windows Credential Manager caps a secret near 2.5 KB).
pub const MAX_VALUE_BYTES: usize = 2048;

/// Why the backend could not serve a request. Carries no text on purpose: a platform
/// error string must never be able to carry a value into a log or an answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    /// No OS keychain reachable or locked out.
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

// ---- K2-13 Telegram (S10, S20): the api id, the api hash and the session live here ----------------------------------
//
// «3 que el api se pida en ajustes y ahi se conecte el usuario» (S10) and option (a) of S20: the island stores the three
// values in the OS keychain, hands the session to the daemon at start (and after a reconnect) and stores the NEW one the
// daemon returns after a login. Nothing of this ever reaches the page: the WebView may ask whether the three exist and
// nothing else, and the value is written straight from the reader thread that received it.
/// The keychain entries. `telegram-session` is the exported mtcute session string: whoever holds it IS the account.
pub const TELEGRAM_API_ID: &str = "telegram-api-id";
pub const TELEGRAM_API_HASH: &str = "telegram-api-hash";
pub const TELEGRAM_SESSION: &str = "telegram-session";

/// The daemon's api id bound (`protocol.cjs` TELEGRAM_LIMITS.maxApiId).
pub const TELEGRAM_API_ID_MAX: u64 = 2_147_483_647;

/// `apiHash`: exactly 32 lowercase hex (the daemon's own rule, refused here first).
pub fn telegram_api_hash_ok(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// The session the daemon may hand over: printable ASCII and bounded. It must ALSO fit one keychain entry, which is
/// smaller than the daemon's 4096-char contract (Windows Credential Manager refuses a secret near 2.5 KB), so a longer
/// value is refused here instead of silently not being stored.
pub fn telegram_session_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_VALUE_BYTES && s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// The three values, together, only ever built when ALL of them are present and valid.
#[derive(Clone, PartialEq, Eq)]
pub struct TelegramCredentials {
    pub api_id: u64,
    pub api_hash: String,
    pub session: String,
}

impl std::fmt::Debug for TelegramCredentials {
    /// Never a secret in a log line, a panic message or a `{:?}`.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TelegramCredentials").field("api_id", &self.api_id).field("api_hash", &"<redacted>").field("session", &"<redacted>").finish()
    }
}

impl TelegramCredentials {
    /// The one frame that hands the session to the daemon. Built from validated parts only.
    pub fn restore_frame(&self) -> Value {
        json!({
            "action": "telegram_session_restore",
            "apiId": self.api_id,
            "apiHash": self.api_hash,
            "session": self.session,
        })
    }
}

/// Whether a login this island started is in flight. A `telegram_session` reply is stored ONLY for our own login: the
/// daemon sends it as the reply to the connection that asked, and this guard is the island's half of that rule (two
/// windows, a restore and a login can never be confused for each other).
pub struct LoginGuard(std::sync::atomic::AtomicBool);

impl Default for LoginGuard {
    fn default() -> Self {
        LoginGuard(std::sync::atomic::AtomicBool::new(false))
    }
}

impl LoginGuard {
    pub const fn new() -> Self {
        LoginGuard(std::sync::atomic::AtomicBool::new(false))
    }
    /// `telegram_login_start` is on its way: from here on a session reply is ours.
    pub fn begin(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    /// Logout, a refused login or a dead session: nothing that arrives from now on is ours to store.
    pub fn cancel(&self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
    /// Consume the guard: true exactly once per started login.
    pub fn take(&self) -> bool {
        self.0.swap(false, std::sync::atomic::Ordering::SeqCst)
    }
    pub fn pending(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

fn read_opt(store: &dyn SecretStore, key: &str) -> Result<Option<String>, SecretError> {
    Ok(store.read(key)?.filter(|v| !v.is_empty()))
}

/// Remember the pair the person typed in Ajustes (S10). The api id travels as its decimal text; the hash is validated
/// here so a store can never hold a value the daemon would refuse.
pub fn remember_api_pair(store: &dyn SecretStore, api_id: u64, api_hash: &str) -> Result<(), SecretError> {
    if api_id == 0 || api_id > TELEGRAM_API_ID_MAX || !telegram_api_hash_ok(api_hash) {
        return Err(SecretError::Failed);
    }
    store.write(TELEGRAM_API_ID, &api_id.to_string()).map_err(SecretError::from)?;
    store.write(TELEGRAM_API_HASH, api_hash).map_err(SecretError::from)
}

/// Store the session the daemon just returned — ONLY when this island started the login (`LoginGuard`). Returns whether
/// it was stored: `Ok(false)` means the reply was not ours (or the session was off-contract), and nothing was written.
pub fn accept_session(store: &dyn SecretStore, guard: &LoginGuard, session: &str) -> Result<bool, SecretError> {
    if !guard.take() {
        return Ok(false);
    }
    if !telegram_session_ok(session) {
        return Ok(false);
    }
    store.write(TELEGRAM_SESSION, session).map_err(SecretError::from)?;
    Ok(true)
}

/// The triple, or `None` when ANY of the three is missing or off-contract. A partial pair is never a restore: the daemon
/// would answer `bad_request` and the island would look connected while nothing is stored.
pub fn telegram_credentials(store: &dyn SecretStore) -> Result<Option<TelegramCredentials>, SecretError> {
    let Some(api_id) = read_opt(store, TELEGRAM_API_ID)? else { return Ok(None) };
    let Some(api_hash) = read_opt(store, TELEGRAM_API_HASH)? else { return Ok(None) };
    let Some(session) = read_opt(store, TELEGRAM_SESSION)? else { return Ok(None) };
    let Some(api_id) = api_id.parse::<u64>().ok().filter(|n| (1..=TELEGRAM_API_ID_MAX).contains(n)) else { return Ok(None) };
    if !telegram_api_hash_ok(&api_hash) || !telegram_session_ok(&session) {
        return Ok(None);
    }
    Ok(Some(TelegramCredentials { api_id, api_hash, session }))
}

/// Whether the three exist (what the page is allowed to know: a boolean, never a value).
pub fn has_telegram_credentials(store: &dyn SecretStore) -> bool {
    telegram_credentials(store).map(|c| c.is_some()).unwrap_or(false)
}

/// Logout, a revoked session or a fresh start: the three entries go. Every deletion is attempted even if one fails, and
/// a failing store still reports the first error (the caller says «no se pudo» instead of claiming the keys are gone).
pub fn forget_telegram(store: &dyn SecretStore) -> Result<(), SecretError> {
    let mut first = None;
    for key in [TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION] {
        if let Err(e) = store.delete(key) {
            first = first.or(Some(e));
        }
    }
    match first {
        Some(e) => Err(SecretError::from(e)),
        None => Ok(()),
    }
}

/// The 0.1 keychain, for the one-time cleanup of retired 0.1 entries and nothing else (K2-04 L4):
/// it targets [`LEGACY_KEYCHAIN_SERVICE`], only deletes, and refuses to read or write, so the old
/// service can never become an alias or a fallback for Koda's own entries.
pub struct LegacyKeychain;

impl LegacyKeychain {
    pub fn service() -> &'static str {
        LEGACY_KEYCHAIN_SERVICE
    }
}

/// The real keychain. Linux: Secret Service; macOS: the login Keychain (K2-01c); Windows:
/// Credential Manager; any other OS has no store and is honestly `Unavailable` (never a file).
pub struct Keychain;

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
mod native {
    use super::{StoreError, SERVICE};

    pub fn entry(key: &str) -> Result<keyring::Entry, StoreError> {
        entry_in(SERVICE, key)
    }

    pub fn entry_in(service: &str, key: &str) -> Result<keyring::Entry, StoreError> {
        keyring::Entry::new(service, key).map_err(map)
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

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
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

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
impl SecretStore for LegacyKeychain {
    fn read(&self, _: &str) -> Result<Option<String>, StoreError> {
        Err(StoreError::Failed)
    }
    fn write(&self, _: &str, _: &str) -> Result<(), StoreError> {
        Err(StoreError::Failed)
    }
    fn delete(&self, key: &str) -> Result<(), StoreError> {
        match native::entry_in(LEGACY_KEYCHAIN_SERVICE, key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(native::map(e)),
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
impl SecretStore for LegacyKeychain {
    fn read(&self, _: &str) -> Result<Option<String>, StoreError> {
        Err(StoreError::Failed)
    }
    fn write(&self, _: &str, _: &str) -> Result<(), StoreError> {
        Err(StoreError::Failed)
    }
    fn delete(&self, _: &str) -> Result<(), StoreError> {
        Err(StoreError::Unavailable)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
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

//! K2-13 T6b-3 (S10, S20) — the Telegram credentials and session in the OS keychain.
//!
//! The bridge is tested against a FAKE store (the crate's `SecretStore` seam): no test ever reads or writes the user's real
//! keychain. What must hold:
//! 1. the triple is restored only when ALL THREE values are present and on-contract — a partial or off-contract set is
//!    never handed to the daemon;
//! 2. the session is stored ONLY from the reply to a request this island started (`LoginGuard`: the login it began or the
//!    `telegram_session_restore` it sent), and only when it satisfies the daemon's carry contract AND fits one keychain
//!    entry; a reply with nothing of ours in flight is a replay and is dropped;
//! 2b. a pair is stored all-or-nothing: when the second write is refused the first is rolled back, so a half pair never
//!    survives to make the island look configured while nothing usable is stored;
//! 3. logout (and a revoked session) deletes the three, attempting every deletion;
//! 4. no secret appears in a `Debug` line, in the restore frame beyond its own three fields, or in any state the page sees.
use koda_island::secrets::{
    accept_session, forget_telegram, has_telegram_credentials, remember_api_pair, telegram_api_hash_ok, telegram_credentials,
    telegram_session_ok, LoginGuard, SecretError, SecretStore, SessionReply, StoreError, TelegramCredentials, TELEGRAM_API_HASH,
    TELEGRAM_API_ID, TELEGRAM_API_ID_MAX, TELEGRAM_SESSION,
};
use std::collections::BTreeMap;
use std::sync::Mutex;

const HASH: &str = "8f3c1d9ae2b74c05d61fa8b3c0e7d294";
const SESSION: &str = "AQAAAAAabcdef0123456789+/base64sessionstring==";
/// What the daemon hands back after it re-authorized a stored session (`telegram_session_restore` → `telegram_session`).
const ROTATED: &str = "AQAAAAArotated0123456789+/base64sessionstring==";

/// The in-memory stand-in for the OS keychain (never the user's real one).
#[derive(Default)]
struct FakeStore {
    values: Mutex<BTreeMap<String, String>>,
    /// One key whose deletion always fails, to prove `forget` keeps going and still reports the failure.
    fail_delete: Option<&'static str>,
    /// The 1-based write the store refuses, to prove a refused second write leaves no half pair behind.
    fail_write_at: Option<usize>,
    writes: Mutex<Vec<String>>,
    deletes: Mutex<Vec<String>>,
}

impl FakeStore {
    fn with(pairs: &[(&str, &str)]) -> FakeStore {
        let store = FakeStore { fail_delete: None, fail_write_at: None, ..Default::default() };
        for (k, v) in pairs {
            store.values.lock().unwrap().insert((*k).to_string(), (*v).to_string());
        }
        store
    }
    fn written(&self) -> Vec<String> {
        self.writes.lock().unwrap().clone()
    }
    fn get(&self, key: &str) -> Option<String> {
        self.values.lock().unwrap().get(key).cloned()
    }
    fn keys(&self) -> Vec<String> {
        self.values.lock().unwrap().keys().cloned().collect()
    }
}

impl SecretStore for FakeStore {
    fn read(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self.get(key))
    }
    fn write(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let mut writes = self.writes.lock().unwrap();
        writes.push(key.to_string());
        if self.fail_write_at == Some(writes.len()) {
            return Err(StoreError::Failed);
        }
        drop(writes);
        self.values.lock().unwrap().insert(key.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), StoreError> {
        self.deletes.lock().unwrap().push(key.to_string());
        if self.fail_delete == Some(key) {
            return Err(StoreError::Failed);
        }
        self.values.lock().unwrap().remove(key);
        Ok(())
    }
}

// ----- the triple -------------------------------------------------------------------------

#[test]
fn the_triple_is_restored_only_when_all_three_values_are_there() {
    assert!(telegram_credentials(&FakeStore::default()).unwrap().is_none(), "nothing stored, nothing to restore");
    assert!(telegram_credentials(&FakeStore::with(&[(TELEGRAM_API_ID, "20405128")])).unwrap().is_none());
    assert!(telegram_credentials(&FakeStore::with(&[(TELEGRAM_API_HASH, HASH), (TELEGRAM_SESSION, SESSION)])).unwrap().is_none(), "a session with no api pair is not a restore");
    let full = telegram_credentials(&FakeStore::with(&[
        (TELEGRAM_API_ID, "20405128"),
        (TELEGRAM_API_HASH, HASH),
        (TELEGRAM_SESSION, SESSION),
    ]))
    .unwrap()
    .expect("the full triple restores");
    assert_eq!(full.api_id, 20_405_128);
    assert_eq!(full.api_hash, HASH);
    assert_eq!(full.session, SESSION);
}

#[test]
fn an_off_contract_member_makes_the_whole_triple_unusable() {
    for (key, value) in [
        (TELEGRAM_API_ID, ""),
        (TELEGRAM_API_ID, "0"),
        (TELEGRAM_API_ID, "20405128x"),
        (TELEGRAM_API_ID, "99999999999"),
        (TELEGRAM_API_HASH, HASH.to_uppercase().as_str()),
        (TELEGRAM_API_HASH, "8f3c"),
        (TELEGRAM_SESSION, ""),
        (TELEGRAM_SESSION, "sesión"),
        (TELEGRAM_SESSION, "a b\nc"),
    ] {
        let mut pairs: Vec<(&str, &str)> = vec![
            (TELEGRAM_API_ID, "20405128"),
            (TELEGRAM_API_HASH, HASH),
            (TELEGRAM_SESSION, SESSION),
        ];
        for pair in pairs.iter_mut() {
            if pair.0 == key {
                pair.1 = value;
            }
        }
        assert!(telegram_credentials(&FakeStore::with(&pairs)).unwrap().is_none(), "{key} = {value:?} must not restore");
    }
}

#[test]
fn nothing_is_stored_until_the_pair_or_the_session_could_ever_be_valid() {
    let store = FakeStore::default();
    for (api_id, hash) in [(0, HASH), (TELEGRAM_API_ID_MAX + 1, HASH), (20_405_128, "nope"), (20_405_128, "")] {
        assert!(remember_api_pair(&store, api_id, hash).is_err(), "api id {api_id} with hash {hash:?} is refused");
    }
    assert!(store.keys().is_empty(), "a refused pair writes nothing: {:?}", store.keys());

    let guard = LoginGuard::new();
    guard.begin();
    for bad in ["", "sesión", "a\nb", &"x".repeat(koda_island::secrets::MAX_VALUE_BYTES + 1)] {
        assert_eq!(accept_session(&store, &guard, bad).unwrap(), SessionReply::Refused, "session {bad:?} is not stored");
        guard.begin(); // the guard is only consumed by a reply we accept
    }
    assert!(store.get(TELEGRAM_SESSION).is_none(), "no session was written by a refused value");
}

#[test]
fn a_refused_half_pair_is_rolled_back_so_no_half_pair_survives() {
    // the api id lands and the store refuses the api hash: the pair must not be left half-written
    let store = FakeStore { fail_write_at: Some(2), ..Default::default() };
    assert_eq!(remember_api_pair(&store, 20_405_128, HASH).unwrap_err(), SecretError::Failed);
    assert!(store.get(TELEGRAM_API_ID).is_none(), "the api id written first was rolled back: {:?}", store.keys());
    assert!(store.keys().is_empty(), "a half pair never survives: {:?}", store.keys());
    assert_eq!(store.written().len(), 2, "a rollback deletes what it wrote instead of writing again");
    assert_eq!(store.deletes.lock().unwrap().clone(), vec![TELEGRAM_API_ID.to_string()], "exactly the key that landed is deleted");
    assert!(!has_telegram_credentials(&store), "nothing usable is stored, and the island does not pretend otherwise");

    // the very first write refused: there is nothing to roll back, and nothing is deleted
    let nothing = FakeStore { fail_write_at: Some(1), ..Default::default() };
    assert_eq!(remember_api_pair(&nothing, 20_405_128, HASH).unwrap_err(), SecretError::Failed);
    assert!(nothing.keys().is_empty());
    assert!(nothing.deletes.lock().unwrap().is_empty(), "no delete is attempted for a write that never landed");
}

// ----- the session hears only our own login ------------------------------------------------

#[test]
fn the_session_is_stored_only_from_the_reply_to_our_own_login() {
    let store = FakeStore::default();
    let guard = LoginGuard::new();
    // a `telegram_session` that arrives while no login of ours is running is not ours to keep
    assert_eq!(accept_session(&store, &guard, SESSION).unwrap(), SessionReply::Foreign);
    assert!(store.get(TELEGRAM_SESSION).is_none(), "nothing stored without our own login");

    guard.begin();
    assert_eq!(accept_session(&store, &guard, SESSION).unwrap(), SessionReply::Stored);
    assert_eq!(store.get(TELEGRAM_SESSION).as_deref(), Some(SESSION), "the reply of our own login is stored");
    assert!(!guard.pending(), "and the guard is spent");
    // a second reply (a stale frame, a second window) is not stored
    assert_eq!(accept_session(&store, &guard, "AQAAAAAothersession==").unwrap(), SessionReply::Foreign);
    assert_eq!(store.get(TELEGRAM_SESSION).as_deref(), Some(SESSION), "the stored session is the first, not the replay");
}

/// K2-13 F4: the daemon answers `telegram_session_restore` with a ROTATED session (server.cjs:1711-1715). That reply is
/// ours — this island sent the restore on this connection — so it replaces the stored session. A reply with nothing of
/// ours in flight stays a replay and is still dropped.
#[test]
fn a_session_the_daemon_rotated_after_our_own_restore_is_stored_too() {
    let store = FakeStore::with(&[(TELEGRAM_SESSION, SESSION)]);
    let guard = LoginGuard::new();
    // nothing of ours is in flight on this fresh guard: the first reply is a replay
    assert_eq!(accept_session(&store, &guard, ROTATED).unwrap(), SessionReply::Foreign);
    assert_eq!(store.get(TELEGRAM_SESSION).as_deref(), Some(SESSION), "a stray reply never touches the stored session");

    // the island sent the restore: the rotated session it answered with is stored, replacing the old one
    guard.begin_restore();
    assert_eq!(accept_session(&store, &guard, ROTATED).unwrap(), SessionReply::Stored);
    assert_eq!(store.get(TELEGRAM_SESSION).as_deref(), Some(ROTATED), "the rotated session replaces the stored one");
    assert!(!guard.pending(), "one restore, one reply");

    // the same reply repeated with nothing of ours in flight is a replay again
    assert_eq!(accept_session(&store, &guard, SESSION).unwrap(), SessionReply::Foreign);
    assert_eq!(store.get(TELEGRAM_SESSION).as_deref(), Some(ROTATED), "the replay never overwrites what was stored");
}

#[test]
fn a_cancelled_login_never_stores_what_arrives_after_it() {
    let store = FakeStore::default();
    let guard = LoginGuard::new();
    guard.begin();
    guard.cancel(); // logout, a refused login, a paused daemon
    assert_eq!(accept_session(&store, &guard, SESSION).unwrap(), SessionReply::Foreign);
    assert!(store.get(TELEGRAM_SESSION).is_none());

    // a restore of ours that a logout cancelled is not stored either
    guard.begin_restore();
    guard.cancel();
    assert_eq!(accept_session(&store, &guard, SESSION).unwrap(), SessionReply::Foreign);
    assert!(store.get(TELEGRAM_SESSION).is_none());
}

// ----- deletion ---------------------------------------------------------------------------

#[test]
fn logout_forgets_the_three_and_still_tries_every_one() {
    let store = FakeStore::with(&[(TELEGRAM_API_ID, "20405128"), (TELEGRAM_API_HASH, HASH), (TELEGRAM_SESSION, SESSION)]);
    forget_telegram(&store).expect("deleting a present triple succeeds");
    assert!(store.keys().is_empty(), "the three are gone: {:?}", store.keys());

    // a store that refuses one deletion: the other two still go, and the failure is reported (never a false «borrado»)
    let failing = FakeStore { fail_delete: Some(TELEGRAM_SESSION), ..Default::default() };
    failing.values.lock().unwrap().insert(TELEGRAM_SESSION.to_string(), SESSION.to_string());
    assert_eq!(forget_telegram(&failing).unwrap_err(), SecretError::Failed);
    let attempts = failing.deletes.lock().unwrap().clone();
    assert_eq!(attempts.len(), 3, "every deletion is attempted: {attempts:?}");
    for key in [TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION] {
        assert!(attempts.contains(&key.to_string()), "{key} was attempted: {attempts:?}");
    }
}

#[test]
fn the_page_only_ever_learns_whether_the_triple_exists() {
    assert!(!has_telegram_credentials(&FakeStore::default()));
    assert!(!has_telegram_credentials(&FakeStore::with(&[(TELEGRAM_API_ID, "20405128"), (TELEGRAM_API_HASH, HASH)])));
    assert!(has_telegram_credentials(&FakeStore::with(&[
        (TELEGRAM_API_ID, "20405128"),
        (TELEGRAM_API_HASH, HASH),
        (TELEGRAM_SESSION, SESSION),
    ])));
}

// ----- no secret anywhere -----------------------------------------------------------------

#[test]
fn a_credentials_line_never_shows_the_hash_or_the_session() {
    let credentials = TelegramCredentials { api_id: 20_405_128, api_hash: HASH.to_string(), session: SESSION.to_string() };
    let line = format!("{credentials:?}");
    assert!(!line.contains(HASH), "the api hash is redacted: {line}");
    assert!(!line.contains(SESSION), "the session is redacted: {line}");
    assert!(line.contains("20405128"), "the api id is not a secret and helps a log line be useful: {line}");
}

#[test]
fn the_restore_frame_carries_the_three_values_and_nothing_else() {
    let credentials = TelegramCredentials { api_id: 20_405_128, api_hash: HASH.to_string(), session: SESSION.to_string() };
    let frame = credentials.restore_frame();
    let object = frame.as_object().expect("the frame is one object");
    assert_eq!(object.len(), 4, "action + apiId + apiHash + session, and no other field: {frame}");
    assert_eq!(frame["action"], serde_json::json!("telegram_session_restore"));
    assert_eq!(frame["apiId"], serde_json::json!(20_405_128));
    assert_eq!(frame["apiHash"], serde_json::json!(HASH));
    assert_eq!(frame["session"], serde_json::json!(SESSION));
}

#[test]
fn the_two_validators_are_the_daemons_own_rules() {
    assert!(telegram_api_hash_ok(HASH));
    for bad in ["", "8f3c1d9ae2b74c05d61fa8b3c0e7d29", "8F3C1D9AE2B74C05D61FA8B3C0E7D294", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"] {
        assert!(!telegram_api_hash_ok(bad), "api hash {bad:?}");
    }
    assert!(telegram_session_ok(SESSION));
    assert!(telegram_session_ok(&"x".repeat(koda_island::secrets::MAX_VALUE_BYTES)), "one keychain entry is the island's bound");
    for bad in ["", "sesión", "a\nb", &"x".repeat(koda_island::secrets::MAX_VALUE_BYTES + 1)] {
        assert!(!telegram_session_ok(bad), "session {bad:?} does not fit the store");
    }
}

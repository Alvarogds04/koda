use super::*;
use crate::secrets::{SecretStore, StoreError};
use std::cell::RefCell;
use std::collections::BTreeMap;

/// Keychain fake: records every call; `fail` makes the listed keys refuse (Unavailable) on delete.
#[derive(Default)]
struct Keys { map: RefCell<BTreeMap<String, String>>, fail: RefCell<Vec<String>>, calls: RefCell<Vec<String>> }
impl Keys {
    fn with(entries: &[(&str, &str)]) -> Self {
        let k = Self::default();
        for (a, b) in entries { k.map.borrow_mut().insert((*a).into(), (*b).into()); }
        k
    }
    fn keys(&self) -> Vec<String> { self.map.borrow().keys().cloned().collect() }
}
impl SecretStore for Keys {
    fn read(&self, key: &str) -> Result<Option<String>, StoreError> {
        self.calls.borrow_mut().push(format!("read {key}"));
        Ok(self.map.borrow().get(key).cloned())
    }
    fn write(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.calls.borrow_mut().push(format!("write {key}"));
        self.map.borrow_mut().insert(key.into(), value.into());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), StoreError> {
        self.calls.borrow_mut().push(format!("delete {key}"));
        if self.fail.borrow().iter().any(|k| k == key) { return Err(StoreError::Unavailable); }
        self.map.borrow_mut().remove(key);
        Ok(())
    }
}

const SECRET: &str = "s3cr3t-app-password";
const OTHERS: &[(&str, &str)] = &[
    ("gmail-oauth", "{\"client_id\":\"x\"}"), ("resend-api-key", "re_keep"), ("resend-from", "a@b.c"),
    ("github-token", "ghp_keep"), ("calendar-ics-url", "https://cal"), ("phone-link-token", "t"),
    ("anthropic-api-key", "sk-keep"),
];
fn full() -> Keys {
    let mut all: Vec<(&str, &str)> = RETIRED_KEYS.iter().map(|k| (*k, SECRET)).collect();
    all.extend_from_slice(OTHERS);
    Keys::with(&all)
}
fn other_names() -> Vec<String> { let mut v: Vec<String> = OTHERS.iter().map(|(k, _)| (*k).to_owned()).collect(); v.sort(); v }

#[test]
fn the_retired_keys_are_exactly_the_seven_imap_and_smtp_accounts_of_0_1() {
    assert_eq!(RETIRED_KEYS, &["imap-host", "imap-user", "imap-password", "smtp-host", "smtp-user", "smtp-password", "smtp-from"]);
    for k in RETIRED_KEYS { assert!(!crate::secrets::INTERNAL_KEYS.contains(k), "{k}"); }
}

#[test]
fn a_pending_migration_deletes_only_the_seven_keys_and_is_done() {
    let keys = full();
    assert_eq!(run(&keys, false), Outcome::Done);
    assert_eq!(keys.keys(), other_names(), "every other entry is untouched");
    for (k, v) in OTHERS { assert_eq!(keys.map.borrow().get(*k).map(String::as_str), Some(*v), "{k}"); }
    let deletes: Vec<String> = keys.calls.borrow().iter().filter(|c| c.starts_with("delete ")).cloned().collect();
    assert_eq!(deletes, RETIRED_KEYS.iter().map(|k| format!("delete {k}")).collect::<Vec<_>>(), "nothing else is ever deleted");
    assert!(keys.calls.borrow().iter().all(|c| !c.starts_with("write ")), "the migration never writes the keychain");
}

#[test]
fn missing_keys_are_not_an_error() {
    let keys = Keys::with(OTHERS);
    assert_eq!(run(&keys, false), Outcome::Done);
    assert_eq!(keys.keys(), other_names());
    let some = Keys::with(&[("imap-host", "imap.x"), ("smtp-from", "me@x"), ("github-token", "ghp_keep")]);
    assert_eq!(run(&some, false), Outcome::Done);
    assert_eq!(some.keys(), vec!["github-token".to_owned()]);
}

#[test]
fn a_finished_migration_never_touches_the_keychain_again() {
    let keys = full();
    assert_eq!(run(&keys, true), Outcome::AlreadyDone);
    assert!(keys.calls.borrow().is_empty(), "no read, delete or write once the mark is stored");
    assert_eq!(keys.keys().len(), RETIRED_KEYS.len() + OTHERS.len());
}

#[test]
fn a_failing_keychain_keeps_the_migration_pending_and_tries_every_key_once() {
    let keys = full();
    keys.fail.borrow_mut().push("smtp-user".into());
    let outcome = run(&keys, false);
    assert_eq!(outcome, Outcome::Pending { failed: 1 });
    let deletes = keys.calls.borrow().iter().filter(|c| c.starts_with("delete ")).count();
    assert_eq!(deletes, RETIRED_KEYS.len(), "one attempt per key in this launch, no loop");
    // every other retired key is gone; the failed one stays for the next launch; others untouched
    let mut want = other_names(); want.push("smtp-user".into()); want.sort();
    assert_eq!(keys.keys(), want);
}

#[test]
fn a_keychain_that_failed_once_is_cleaned_on_the_next_launch() {
    let keys = full();
    keys.fail.borrow_mut().extend(RETIRED_KEYS.iter().map(|k| (*k).to_owned()));
    assert_eq!(run(&keys, false), Outcome::Pending { failed: RETIRED_KEYS.len() });
    assert_eq!(keys.keys().len(), RETIRED_KEYS.len() + OTHERS.len());
    // next launch: the keychain answers again; the mark was not stored, so it runs again
    keys.fail.borrow_mut().clear();
    assert_eq!(run(&keys, false), Outcome::Done);
    assert_eq!(keys.keys(), other_names());
}

#[test]
fn the_log_line_never_carries_a_value_or_a_key_name_beyond_the_count() {
    for outcome in [Outcome::Done, Outcome::AlreadyDone, Outcome::Pending { failed: 3 }] {
        let line = outcome.log_line();
        assert!(!line.contains(SECRET), "{line}");
        for k in RETIRED_KEYS { assert!(!line.contains(k), "{line}"); }
    }
    assert!(Outcome::AlreadyDone.log_line().is_empty(), "nothing to log when nothing happened");
    assert!(Outcome::Pending { failed: 3 }.log_line().contains('3'));
}

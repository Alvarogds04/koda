use super::*;
use serde_json::json;
use std::cell::RefCell;
use std::collections::BTreeMap;

/// In-memory backend: records every call so tests can prove what never happened.
#[derive(Default)]
struct Fake {
    map: RefCell<BTreeMap<String, String>>,
    down: bool,
    calls: RefCell<Vec<String>>,
}

impl SecretStore for Fake {
    fn read(&self, key: &str) -> Result<Option<String>, StoreError> {
        self.calls.borrow_mut().push(format!("read {key}"));
        if self.down {
            return Err(StoreError::Unavailable);
        }
        Ok(self.map.borrow().get(key).cloned())
    }
    fn write(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.calls.borrow_mut().push(format!("write {key}"));
        if self.down {
            return Err(StoreError::Unavailable);
        }
        self.map.borrow_mut().insert(key.into(), value.into());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), StoreError> {
        self.calls.borrow_mut().push(format!("delete {key}"));
        if self.down {
            return Err(StoreError::Unavailable);
        }
        self.map.borrow_mut().remove(key);
        Ok(())
    }
}

#[test]
fn only_the_closed_list_of_keys_parses() {
    for key in KNOWN_KEYS {
        assert!(parse_command(&json!({"action":"present","key":key})).is_some(), "{key}");
    }
    for bad in ["", "github", "GITHUB-TOKEN", "github-token ", "../x", "phone-link-key", "anthropic-api-key\n"] {
        assert!(parse_command(&json!({"action":"present","key":bad})).is_none(), "{bad:?}");
        assert!(parse_command(&json!({"action":"set","key":bad,"value":"v"})).is_none(), "{bad:?}");
        assert!(parse_command(&json!({"action":"clear","key":bad})).is_none(), "{bad:?}");
    }
}

#[test]
fn the_wire_shape_is_closed() {
    for bad in [
        json!(null),
        json!("set"),
        json!({}),
        json!({"action":"get","key":"github-token"}),
        json!({"action":"view"}),
        json!({"action":"present"}),
        json!({"action":"present","key":7}),
        json!({"action":"present","key":"github-token","extra":1}),
        json!({"action":"clear","key":"github-token","value":"x"}),
        json!({"action":"set","key":"github-token"}),
        json!({"action":"set","key":"github-token","value":""}),
        json!({"action":"set","key":"github-token","value":5}),
        json!({"action":"set","key":"github-token","value":"x".repeat(MAX_VALUE_BYTES + 1)}),
        json!({"action":"set","key":"github-token","value":"a\0b"}),
        json!({"Action":"set","key":"github-token","value":"x"}),
    ] {
        assert!(parse_command(&bad).is_none(), "{bad} must be refused");
    }
    assert!(parse_command(&json!({"action":"set","key":"github-token","value":"x".repeat(MAX_VALUE_BYTES)})).is_some());
}

#[test]
fn set_then_present_then_clear_never_echoes_the_value() {
    let store = Fake::default();
    let set = parse_command(&json!({"action":"set","key":"github-token","value":"ghp_SECRET"})).unwrap();
    let out = apply(&store, &set).unwrap();
    assert_eq!(out, json!({"key":"github-token","present":true}));
    let present = parse_command(&json!({"action":"present","key":"github-token"})).unwrap();
    assert_eq!(apply(&store, &present).unwrap(), json!({"key":"github-token","present":true}));
    let other = parse_command(&json!({"action":"present","key":"n8n-url"})).unwrap();
    assert_eq!(apply(&store, &other).unwrap(), json!({"key":"n8n-url","present":false}));
    let clear = parse_command(&json!({"action":"clear","key":"github-token"})).unwrap();
    assert_eq!(apply(&store, &clear).unwrap(), json!({"key":"github-token","present":false}));
    assert!(store.map.borrow().is_empty());
    // clearing something absent is fine (idempotent)
    assert_eq!(apply(&store, &clear).unwrap(), json!({"key":"github-token","present":false}));
}

#[test]
fn an_empty_stored_value_counts_as_absent() {
    let store = Fake::default();
    store.map.borrow_mut().insert("github-token".into(), String::new());
    let present = parse_command(&json!({"action":"present","key":"github-token"})).unwrap();
    assert_eq!(apply(&store, &present).unwrap()["present"], json!(false));
}

#[test]
fn no_secret_service_means_unavailable_and_nothing_else_is_tried() {
    let store = Fake { down: true, ..Fake::default() };
    for payload in [
        json!({"action":"set","key":"github-token","value":"v"}),
        json!({"action":"clear","key":"github-token"}),
        json!({"action":"present","key":"github-token"}),
    ] {
        let cmd = parse_command(&payload).unwrap();
        assert_eq!(apply(&store, &cmd), Err(SecretError::Unavailable), "{payload}");
    }
    // exactly one backend call per command: no retry, no second store, no fallback
    assert_eq!(store.calls.borrow().len(), 3);
    assert!(store.map.borrow().is_empty());
}

#[test]
fn the_secret_value_never_reaches_debug_or_errors() {
    let cmd = parse_command(&json!({"action":"set","key":"github-token","value":"ghp_SECRET"})).unwrap();
    assert!(!format!("{cmd:?}").contains("ghp_SECRET"));
    assert!(!format!("{:?}", SecretError::Unavailable).contains("ghp_SECRET"));
    assert_eq!(SecretError::Unavailable.code(), "unavailable");
    assert_eq!(SecretError::Failed.code(), "save_failed");
}

#[test]
fn the_service_name_is_kodas_own() {
    assert_eq!(SERVICE, "com.abitog.Koda");
    assert!(!SERVICE.to_lowercase().contains("coucou"));
}

/// L4 (13 Nov, human): the keychain service is Koda's, with no alias and no fallback, so a 0.1
/// entry under the old service is simply not read. Exactly ONE thing may still target the old
/// service: a one-time cleanup of 0.1 entries (K2-10 T8 deletes the seven imap-*/smtp-* keys).
/// That constant is pinned here so the cleanup can never silently follow the rename.
#[test]
fn the_legacy_service_is_pinned_for_one_time_cleanups_only() {
    assert_eq!(super::LEGACY_KEYCHAIN_SERVICE, "com.abitog.AbitoTauri");
    assert_ne!(SERVICE, LEGACY_KEYCHAIN_SERVICE, "the migration must name the old service explicitly");
    assert!(SERVICE.starts_with("com.abitog."), "still Abito's own reverse-DNS namespace (the bundle id is T6)");
}

/// K2-01c S1: on macOS a saved value lands in the login Keychain under Abito's own service and is
/// still there for a fresh store (a reopened Koda). Checked through the public store and through
/// `security`, so it cannot pass against any other backend. Uses a throwaway probe entry only.
#[cfg(target_os = "macos")]
#[test]
fn macos_keeps_secrets_in_the_login_keychain() {
    let key = format!("k2-01c-test-probe-{}", std::process::id());
    let value = "probe-value-not-a-secret";
    assert_eq!(Keychain.write(&key, value), Ok(()));
    // a new store instance, like a second launch of Koda, reads the same entry back
    let fresh = Keychain;
    assert_eq!(fresh.read(&key), Ok(Some(value.to_owned())));
    // Attributes only (no -w): reading the password from another binary would hit the item's
    // ACL and a prompt; the attributes prove the entry is in the Keychain under Abito's service.
    let out = std::process::Command::new("security")
        .args(["find-generic-password", "-s", SERVICE, "-a", &key])
        .output()
        .expect("security(1) runs");
    assert!(out.status.success(), "the entry is in the macOS Keychain");
    let attrs = String::from_utf8_lossy(&out.stdout);
    assert!(attrs.contains(SERVICE) && attrs.contains(&key), "service and account match");
    assert!(!attrs.contains(value), "attributes never carry the value");
    assert_eq!(fresh.delete(&key), Ok(()));
    assert_eq!(fresh.read(&key), Ok(None));
    // deleting a missing entry stays Ok (same contract as Linux/Windows)
    assert_eq!(fresh.delete(&key), Ok(()));
}

/// #503 S3: NaN and OpenCode Go keys live in the closed keychain list like every other chat key.
#[test]
fn nan_and_opencode_go_keys_are_known() {
    for key in ["nan-api-key", "opencode-go-api-key"] {
        assert!(KNOWN_KEYS.contains(&key), "{key}");
        assert!(parse_command(&json!({"action":"set","key":key,"value":"v"})).is_some(), "{key}");
    }
}

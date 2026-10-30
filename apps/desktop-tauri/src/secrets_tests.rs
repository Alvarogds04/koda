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
fn the_service_name_is_abitos_own() {
    assert_eq!(SERVICE, "com.abitog.AbitoTauri");
    assert!(!SERVICE.to_lowercase().contains("coucou"));
}

/// #503 S3: NaN and OpenCode Go keys live in the closed keychain list like every other chat key.
#[test]
fn nan_and_opencode_go_keys_are_known() {
    for key in ["nan-api-key", "opencode-go-api-key"] {
        assert!(KNOWN_KEYS.contains(&key), "{key}");
        assert!(parse_command(&json!({"action":"set","key":key,"value":"v"})).is_some(), "{key}");
    }
}

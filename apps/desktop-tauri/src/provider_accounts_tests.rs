//! Offline public account-command contract. Runtime-only synthetic values, never printed.
use super::*;
use serde_json::json;
use crate::secrets::{SecretStore, StoreError};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct FakeSecrets {
    values: Mutex<std::collections::BTreeMap<String, String>>,
    failure: Mutex<Option<StoreError>>,
    fail_key: Mutex<Option<String>>,
    /// Allow this many more mutations (write/delete), then fail every one: the compensation of an earlier mutation fails too.
    mutations_left: Mutex<Option<usize>>,
    crash_before: Mutex<bool>,
    crash_after_write: Mutex<bool>,
    observe_delete: Mutex<Option<std::path::PathBuf>>,
}
impl FakeSecrets {
    fn mutation_allowed(&self) -> bool {
        let mut left = self.mutations_left.lock().unwrap();
        match left.as_mut() { None => true, Some(0) => false, Some(n) => { *n -= 1; true } }
    }
}
impl SecretStore for FakeSecrets {
    fn read(&self, key: &str) -> Result<Option<String>, StoreError> {
        if *self.failure.lock().unwrap() == Some(StoreError::Unavailable) { return Err(StoreError::Unavailable); }
        Ok(self.values.lock().unwrap().get(key).cloned())
    }
    fn write(&self, key: &str, value: &str) -> Result<(), StoreError> {
        if *self.crash_before.lock().unwrap() { panic!("simulated interruption before mutation"); }
        if let Some(error) = *self.failure.lock().unwrap() { return Err(error); }
        if self.fail_key.lock().unwrap().as_deref() == Some(key) || !self.mutation_allowed() { return Err(StoreError::Failed); }
        self.values.lock().unwrap().insert(key.into(), value.into());
        if *self.crash_after_write.lock().unwrap() { panic!("simulated interruption after write"); }
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), StoreError> {
        if *self.crash_before.lock().unwrap() { panic!("simulated interruption before mutation"); }
        if let Some(path) = self.observe_delete.lock().unwrap().as_ref() {
            let disk: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert!(disk["accounts"].as_array().unwrap().iter().all(|a| a["credentialRef"] != key));
        }
        if let Some(error) = *self.failure.lock().unwrap() { return Err(error); }
        if !self.mutation_allowed() { return Err(StoreError::Failed); }
        self.values.lock().unwrap().remove(key); Ok(())
    }
}
thread_local! { static SECRETS: Arc<FakeSecrets> = Arc::new(FakeSecrets::default()); }
fn load(path: std::path::PathBuf) -> Result<AccountStore, crate::bridge::BridgeError> {
    SECRETS.with(|secrets| AccountStore::load(path, secrets.clone()))
}

fn disk(dir: &Sandbox) -> Value {
    serde_json::from_slice(&std::fs::read(dir.file()).unwrap()).unwrap()
}
fn active_ref(dir: &Sandbox) -> String { disk(dir)["accounts"][0]["credentialRef"].as_str().unwrap().into() }
fn interrupt(f: impl FnOnce()) {
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err());
}

#[test]
fn account_journal_interrupted_remove_is_swept_on_reload() {
    let dir = Sandbox::new(); let secrets = Arc::new(FakeSecrets::default());
    let mut store = AccountStore::load(dir.file(), secrets.clone()).unwrap();
    let mut p = request("abito_account_create", "openai", "https://example.com/v1");
    p["config"]["apiKey"] = json!("original-key"); store.command(&p, |_| {}).unwrap();
    let reference = active_ref(&dir);
    *secrets.crash_before.lock().unwrap() = true;
    interrupt(|| { let _ = store.command(&json!({"action":"abito_account_remove","accountId":"example"}), |_| {}); });
    drop(store);
    assert_eq!(disk(&dir)["accounts"], json!([]));
    assert_eq!(disk(&dir)["pendingCleanup"], json!([reference]));
    assert!(secrets.read(&reference).unwrap().is_some());
    *secrets.crash_before.lock().unwrap() = false;
    AccountStore::load(dir.file(), secrets.clone()).unwrap();
    assert_eq!(secrets.read(&reference).unwrap(), None);
    assert_eq!(disk(&dir)["pendingCleanup"], json!([]));
}

#[test]
fn account_journal_interrupted_legacy_clear_does_not_reactivate_retired_ref() {
    let dir = Sandbox::new(); legacy_file(&dir, "example");
    let secrets = Arc::new(FakeSecrets::default());
    let mut store = AccountStore::load(dir.file(), secrets.clone()).unwrap();
    let reference = active_ref(&dir);
    let mut p = request("abito_account_save", "openai", "https://example.com/v1");
    p["config"]["apiKey"] = Value::Null;
    *secrets.crash_before.lock().unwrap() = true;
    interrupt(|| { let _ = store.command(&p, |_| {}); }); drop(store);
    assert!(disk(&dir)["accounts"][0]["credentialRef"].is_null());
    *secrets.crash_before.lock().unwrap() = false;
    let loaded = AccountStore::load(dir.file(), secrets.clone()).unwrap();
    assert_eq!(loaded.view()["accounts"][0]["hasCredential"], false);
    assert_eq!(secrets.read(&reference).unwrap(), None);
    assert_eq!(disk(&dir)["pendingCleanup"], json!([]));
}

#[test]
fn account_journal_interruptions_preserve_previous_account_and_sweep_only_orphan() {
    for replacing in [false, true] { for after_write in [false, true] {
        let dir = Sandbox::new(); let secrets = Arc::new(FakeSecrets::default());
        let mut store = AccountStore::load(dir.file(), secrets.clone()).unwrap();
        let mut p = request("abito_account_create", "openai", "https://example.com/v1");
        p["config"]["apiKey"] = json!("original-key");
        let previous = if replacing { store.command(&p, |_| {}).unwrap(); Some(active_ref(&dir)) } else { None };
        let before = store.view();
        if replacing { p["action"] = json!("abito_account_save"); }
        p["config"]["apiKey"] = json!("new-key");
        *secrets.crash_before.lock().unwrap() = !after_write;
        *secrets.crash_after_write.lock().unwrap() = after_write;
        interrupt(|| { let _ = store.command(&p, |_| {}); }); drop(store);
        assert_eq!(disk(&dir)["pendingCleanup"].as_array().unwrap().len(), 1);
        *secrets.crash_before.lock().unwrap() = false;
        *secrets.crash_after_write.lock().unwrap() = false;
        secrets.write("openai-api-key", "shared-key").unwrap();
        secrets.write("key-other", "untouched-key").unwrap();
        secrets.write("account-untracked", "untracked-key").unwrap();
        let reloaded = AccountStore::load(dir.file(), secrets.clone()).unwrap();
        assert_eq!(reloaded.view(), before);
        if let Some(reference) = previous { assert_eq!(secrets.read(&reference).unwrap().as_deref(), Some("original-key")); }
        assert_eq!(secrets.read("openai-api-key").unwrap().as_deref(), Some("shared-key"));
        assert!(secrets.read("key-other").unwrap().is_some());
        assert!(secrets.read("account-untracked").unwrap().is_some());
        assert!(!secrets.values.lock().unwrap().values().any(|v| v == "new-key"));
        assert_eq!(disk(&dir)["pendingCleanup"], json!([]));
    } }
}

#[test]
fn account_journal_rotation_and_failed_create() {
    let dir = Sandbox::new(); let secrets = Arc::new(FakeSecrets::default());
    let mut store = AccountStore::load(dir.file(), secrets.clone()).unwrap();
    let mut p = request("abito_account_create", "openai", "https://example.com/v1");
    p["config"]["apiKey"] = json!("original-key");
    *secrets.mutations_left.lock().unwrap() = Some(0);
    assert!(store.command(&p, |_| panic!("no publication")).is_err());
    assert_eq!(store.view()["accounts"], json!([]));
    *secrets.mutations_left.lock().unwrap() = None;
    store.command(&p, |_| {}).unwrap(); let old = active_ref(&dir);
    assert!(old.starts_with("account-example-"));
    *secrets.observe_delete.lock().unwrap() = Some(dir.file());
    p["action"] = json!("abito_account_save"); p["config"]["apiKey"] = json!("new-key");
    store.command(&p, |_| {}).unwrap(); let new = active_ref(&dir);
    assert_ne!(old, new); assert_eq!(secrets.read(&old).unwrap(), None);
    assert_eq!(secrets.read(&new).unwrap().as_deref(), Some("new-key"));
}

#[test]
fn account_journal_validation_and_bound() {
    use std::os::unix::fs::PermissionsExt;
    for bad in ["openai-api-key", "key-openai", "account-example", "account-../bad", "account-key-openai", "account-x-ABCDEF12"] {
        let dir = Sandbox::new(); legacy_file(&dir, "example");
        let mut value = disk(&dir); value["pendingCleanup"] = json!([bad]);
        std::fs::write(dir.file(), serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(AccountStore::load(dir.file(), Arc::new(FakeSecrets::default())).err().expect("hostile journal rejected").code, "store_unavailable");
    }
    // A legacy dangling ref remains visible as missing, while foreign/malformed
    // active refs are rejected before touching the keychain.
    for reference in ["account-example", "account-example-0123abcd", "account-example-0123ABCD", "account-other", "account-example-short"] {
        let dir = Sandbox::new(); legacy_file(&dir, "example");
        let mut value = disk(&dir);
        value["accounts"][0]["config"].as_object_mut().unwrap().remove("apiKey");
        value["accounts"][0]["credentialRef"] = json!(reference);
        std::fs::write(dir.file(), serde_json::to_vec(&value).unwrap()).unwrap();
        let result = AccountStore::load(dir.file(), Arc::new(FakeSecrets::default()));
        if ["account-example", "account-example-0123abcd"].contains(&reference) {
            assert_eq!(result.unwrap().view()["accounts"][0]["hasCredential"], false);
        } else { assert_eq!(result.err().unwrap().code, "store_unavailable"); }
    }
    for count in [64, 65] {
        let dir = Sandbox::new();
        let refs: Vec<_> = (0..count).map(|n| format!("account-orphan{n}")).collect();
        std::fs::write(dir.file(), serde_json::to_vec(&json!({"version":1,"accounts":[],"pendingCleanup":refs})).unwrap()).unwrap();
        std::fs::set_permissions(dir.file(), std::fs::Permissions::from_mode(0o600)).unwrap();
        let secrets = Arc::new(FakeSecrets::default()); *secrets.mutations_left.lock().unwrap() = Some(0);
        let loaded = AccountStore::load(dir.file(), secrets);
        assert_eq!(loaded.is_ok(), count == 64);
        if let Ok(mut store) = loaded {
            let mut p = request("abito_account_create", "openai", "https://example.com/v1"); p["config"]["apiKey"] = json!("new-key");
            assert!(store.command(&p, |_| {}).is_err());
            assert_eq!(disk(&dir)["pendingCleanup"].as_array().unwrap().len(), 64);
        }
    }
}

fn request(action: &str, provider: &str, url: &str) -> Value {
    json!({"action":action,"accountId":"example","provider":provider,"config":{
        "nombre":"Example","baseUrl":url,"api":"openai-completions","compat":{},
        "models":["example-model"],"defaultModel":"example-model"
    }})
}

#[test]
fn account_commands_are_local_and_redacted() {
    for action in ["abito_account_create", "abito_account_save", "abito_account_endpoint_set"] {
        let mut p = request(action, "openai", "https://api.nan.builders/v1");
        let secret: String = (65..95).filter_map(char::from_u32).collect();
        p["config"]["apiKey"] = json!(secret);
        let parsed = parse_ui_command(&p);
        assert!(parsed.is_ok(), "local account command must be recognized");
        let command = parsed.unwrap();
        assert!(!format!("{command:?}").contains(&secret));
        assert!(command.line().is_empty(), "local accounts must never enter daemon wire");
    }
}

#[test]
fn account_hostile_urls_and_invalid_payloads_are_rejected() {
    for url in ["javascript:alert(1)","file:///tmp/a","data:text/plain,a","https:///v1",
        "https://user:pass@example.com/v1","https://example.com\\@evil.com/v1",
        "https://exam ple.com/v1","https://éxample.com/v1","https://xn--xample-9ua.com/v1",
        "https://%65xample.com/v1","https://example.com./v1","https://example.com/v1?key=x",
        "https://example.com/#x","https://example.com:0/v1","http://api.nan.builders/v1"] {
        assert!(parse_ui_command(&request("abito_account_save", "openai", url)).is_err());
    }
    for url in ["https://localhost:11434/v1","http://localhost.evil/v1","http://127.1/v1",
        "http://2130706433/v1","http://0x7f000001/v1","http://192.168.1.2/v1"] {
        assert!(parse_ui_command(&request("abito_account_create", "ollama", url)).is_err());
    }
    let valid = request("abito_account_save", "openai", "https://example.com/v1");
    for field in ["nombre","baseUrl","api","compat","models","defaultModel"] {
        let mut bad = valid.clone(); bad["config"].as_object_mut().unwrap().remove(field);
        assert!(parse_ui_command(&bad).is_err());
    }
    let mut bad = valid; bad["config"]["defaultModel"] = json!("not-listed");
    assert!(parse_ui_command(&bad).is_err());
}

#[test]
fn account_local_loopback_and_remote_https_are_accepted() {
    for url in ["http://localhost:11434/v1","http://127.0.0.1:1234/v1","http://[::1]:11434/v1"] {
        assert!(parse_ui_command(&request("abito_account_create", "ollama", url)).is_ok());
    }
    for provider in ["anthropic","google","openai","openrouter"] {
        assert!(parse_ui_command(&request("abito_account_save", provider, "https://api.nan.builders/v1")).is_ok());
    }
}

#[test]
fn account_ipv4_mapped_loopback_and_unspecified_are_never_remote() {
    let hosts = ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::FFFF:7F00:1]",
        "[0:0:0:0:0:ffff:127.0.0.1]", "127.0.0.1", "[::1]",
        "[::ffff:0.0.0.0]", "[::ffff:0:0]", "0.0.0.0", "[::]"];
    let mut failures = Vec::new();
    for host in hosts {
        let dir = Sandbox::new();
        let mut store = load(dir.file()).unwrap();
        let before = store.view();
        let mut publications = 0;
        let payload = request("abito_account_create", "openai", &format!("https://{host}/v1"));
        let rejected = parse_ui_command(&payload).is_err();
        let result = store.command(&payload, |_| publications += 1);
        if !rejected || !matches!(result, Err(ref e) if e.code == "invalid_account")
            || store.view() != before || dir.file().exists() || publications != 0 {
            failures.push(host);
        }
    }
    // Local allowlist stays strict: mapped forms are not added by remote unmapping.
    for host in &hosts[..4] {
        assert!(parse_ui_command(&request("abito_account_create", "ollama", &format!("http://{host}/v1"))).is_err());
    }
    assert!(failures.is_empty(), "remote rejection/nonmutation failed for: {failures:?}");
}

#[test]
fn account_existing_oauth_and_profile_selection_wire_are_unchanged() {
    assert_eq!(parse_ui_command(&json!({"action":"account_create","provider":"openai","label":"Example"})).unwrap().line(), "{\"type\":\"account_create\",\"provider\":\"openai\",\"label\":\"Example\"}\n");
    assert!(parse_ui_command(&json!({"action":"view"})).unwrap().line().is_empty());
    assert_eq!(parse_ui_command(&json!({"action":"profile_select","id":"main"})).unwrap().line(), "{\"type\":\"profile_select\",\"id\":\"main\"}\n");
}

struct Sandbox(std::path::PathBuf);
impl Sandbox {
    fn new() -> Self {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/provider-account-tests");
        std::fs::create_dir_all(&base).unwrap();
        let root = base.join(format!("test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir(&root).unwrap(); Self(root)
    }
    fn file(&self) -> std::path::PathBuf { self.0.join("accounts.json") }
}
impl Drop for Sandbox { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

#[test]
fn account_presence_set_clear_default_model_roundtrip_and_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let dir = Sandbox::new(); let mut store = load(dir.file()).unwrap();
    let mut p = request("abito_account_create", "openai", "https://example.com/v1");
    let secret: String = (97..123).filter_map(char::from_u32).collect();
    p["config"]["apiKey"] = json!(secret);
    let mut events = Vec::new();
    let view = store.command(&p, |v| events.push(v));
    assert!(view.is_ok(), "valid account must persist");
    let view = view.unwrap();
    assert_eq!(events.len(), 1);
    assert!(!view.to_string().contains(&secret));
    assert!(!view.to_string().contains("apiKey"));
    assert_eq!(view["accounts"][0]["hasCredential"], true);
    assert_eq!(view["accounts"][0]["config"]["defaultModel"], "example-model");
    assert_eq!(std::fs::metadata(dir.file()).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(load(dir.file()).unwrap().view(), view);
    p["action"] = json!("abito_account_save");
    p["config"].as_object_mut().unwrap().remove("apiKey");
    assert_eq!(store.command(&p, |_| {}).unwrap()["accounts"][0]["hasCredential"], true);
    p["config"]["apiKey"] = Value::Null;
    assert_eq!(store.command(&p, |_| {}).unwrap()["accounts"][0]["hasCredential"], false);
    assert_eq!(load(dir.file()).unwrap().view()["accounts"][0]["hasCredential"], false);
    assert!(!String::from_utf8(std::fs::read(dir.file()).unwrap()).unwrap().contains(&secret));
}

#[test]
fn account_invalid_save_does_not_open_mutate_or_publish() {
    let dir = Sandbox::new(); let mut store = load(dir.file()).unwrap();
    let before = store.view();
    let mut events = 0;
    for url in ["javascript:x", "file:///x", "data:x", "https://u:p@example.com", "https://a\\b", "https://éxample.com", "https://x y.com"] {
        let p = request("abito_account_create", "openai", url);
        let error = store.command(&p, |_| events += 1).unwrap_err();
        assert_eq!(error.code, "invalid_account");
        assert!(!error.message.contains(url));
        assert!(!dir.file().exists()); assert_eq!(store.view(), before); assert_eq!(events, 0);
    }
}

#[test]
fn account_failed_save_keeps_previous_disk_memory_and_events() {
    let dir = Sandbox::new(); let mut store = load(dir.file()).unwrap();
    let mut p = request("abito_account_create", "openai", "https://example.com/v1");
    assert!(store.command(&p, |_| {}).is_ok(), "seed must persist");
    let before = store.view(); let bytes = std::fs::read(dir.file()).unwrap();
    // A conflicting exclusive temporary file rejects the save before touching the target.
    std::fs::write(dir.0.join(".accounts.json.pending"), b"owned obstruction").unwrap();
    p["action"] = json!("abito_account_save"); p["config"]["nombre"] = json!("Changed");
    let mut events = 0;
    assert_eq!(store.command(&p, |_| events += 1).unwrap_err().code, "save_failed");
    assert!(std::fs::read(dir.file()).unwrap() == bytes);
    assert_eq!(store.view(), before); assert_eq!(events, 0);
    assert_eq!(std::fs::read(dir.0.join(".accounts.json.pending")).unwrap(), b"owned obstruction");
}

#[test]
fn account_existing_record_identity_and_endpoint_are_guarded() {
    let dir = Sandbox::new(); let mut store = load(dir.file()).unwrap();
    let mut p = request("abito_account_create", "ollama", "http://127.0.0.1:11434/v1");
    assert!(store.command(&p, |_| {}).is_ok());
    let before = store.view();
    assert_eq!(store.command(&p, |_| panic!("duplicate publish")).unwrap_err().code, "account_exists");
    p["action"] = json!("abito_account_endpoint_set"); p["config"]["baseUrl"] = json!("http://localhost:1234/v1");
    assert!(store.command(&p, |_| {}).is_ok());
    assert_ne!(store.view(), before);
    p["provider"] = json!("openai"); p["config"]["baseUrl"] = json!("https://example.com/v1");
    assert_eq!(store.command(&p, |_| panic!("identity publish")).unwrap_err().code, "account_identity");
}

#[test]
fn account_store_load_fails_closed_on_unsafe_or_corrupt_files() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = Sandbox::new();
    std::fs::write(dir.file(), b"broken").unwrap();
    assert!(load(dir.file()).is_err());
    std::fs::set_permissions(dir.file(), std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(load(dir.file()).is_err());
    std::fs::remove_file(dir.file()).unwrap();
    let target = dir.0.join("other"); std::fs::write(&target, b"{}").unwrap();
    symlink(&target, dir.file()).unwrap();
    assert!(load(dir.file()).is_err());
}

fn legacy_file(dir: &Sandbox, id: &str) -> Vec<u8> {
    use std::os::unix::fs::PermissionsExt;
    let mut p = request("abito_account_create", "openai", "https://example.com/v1");
    p["config"]["apiKey"] = json!("synthetic-migration-key");
    let bytes = serde_json::to_vec(&json!({"version":1,"accounts":[{
        "accountId":id,"provider":"openai","config":p["config"]}]})).unwrap();
    std::fs::write(dir.file(), &bytes).unwrap();
    std::fs::set_permissions(dir.file(), std::fs::Permissions::from_mode(0o600)).unwrap();
    bytes
}

#[test]
fn account_migration_is_lossless_scrubbed_and_idempotent() {
    let dir = Sandbox::new(); legacy_file(&dir, "example");
    let secrets = Arc::new(FakeSecrets::default());
    let store = AccountStore::load(dir.file(), secrets.clone()).unwrap();
    assert_eq!(secrets.read("account-example").unwrap().as_deref(), Some("synthetic-migration-key"));
    let bytes = std::fs::read(dir.file()).unwrap();
    let text = String::from_utf8(bytes.clone()).unwrap();
    assert!(!text.contains("synthetic-migration-key")); assert!(!text.contains("apiKey"));
    assert!(text.contains("credentialRef"));
    assert_eq!(store.view()["accounts"][0]["hasCredential"], true);
    assert!(!store.view().to_string().contains("synthetic-migration-key"));
    *secrets.failure.lock().unwrap() = Some(StoreError::Failed);
    assert!(AccountStore::load(dir.file(), secrets).is_ok(), "second load must not write");
    assert_eq!(std::fs::read(dir.file()).unwrap(), bytes);
}

#[test]
fn account_migration_failure_preserves_exact_file_and_explains_recovery() {
    for failure in [StoreError::Failed, StoreError::Unavailable] {
        let dir = Sandbox::new(); let before = legacy_file(&dir, "example");
        let secrets = Arc::new(FakeSecrets::default());
        *secrets.failure.lock().unwrap() = Some(failure);
        let error = AccountStore::load(dir.file(), secrets).err().expect("must fail closed");
        assert_eq!(error.code, "keychain_unavailable");
        assert_eq!(error.message, "El llavero del sistema no está disponible; las claves siguen donde estaban. Desbloquéalo o instala un servicio de secretos y reintenta.");
        assert_eq!(std::fs::read(dir.file()).unwrap(), before);
    }
}

#[test]
fn account_migration_partial_keychain_success_never_scrubs_input_and_can_retry() {
    let dir = Sandbox::new(); let bytes = legacy_file(&dir, "first");
    let mut disk: Value = serde_json::from_slice(&bytes).unwrap();
    let mut second = disk["accounts"][0].clone(); second["accountId"] = json!("second");
    second["config"]["apiKey"] = json!("second-synthetic-key");
    disk["accounts"].as_array_mut().unwrap().push(second);
    let before = serde_json::to_vec(&disk).unwrap(); std::fs::write(dir.file(), &before).unwrap();
    let secrets = Arc::new(FakeSecrets::default());
    *secrets.fail_key.lock().unwrap() = Some("account-second".into());
    assert_eq!(AccountStore::load(dir.file(), secrets.clone()).err().unwrap().code, "keychain_unavailable");
    assert_eq!(std::fs::read(dir.file()).unwrap(), before);
    assert_eq!(secrets.read("account-first").unwrap().as_deref(), Some("synthetic-migration-key"));
    assert!(!dir.0.join(".accounts.json.pending").exists());
    *secrets.fail_key.lock().unwrap() = None;
    let store = AccountStore::load(dir.file(), secrets.clone()).unwrap();
    assert!(store.view()["accounts"].as_array().unwrap().iter().all(|a| a["hasCredential"] == true));
    assert_eq!(secrets.read("account-second").unwrap().as_deref(), Some("second-synthetic-key"));
    let after = String::from_utf8(std::fs::read(dir.file()).unwrap()).unwrap();
    assert!(!after.contains("apiKey")); assert!(!after.contains("synthetic-key"));
}

#[test]
fn account_keychain_failure_preserves_previous_key_and_journals_committed_removal() {
    let dir = Sandbox::new(); let secrets = Arc::new(FakeSecrets::default());
    let mut store = AccountStore::load(dir.file(), secrets.clone()).unwrap();
    let mut p = request("abito_account_create", "openai", "https://example.com/v1");
    p["config"]["apiKey"] = json!("original-key"); store.command(&p, |_| {}).unwrap();
    let reference = active_ref(&dir);
    let before = store.view();
    *secrets.failure.lock().unwrap() = Some(StoreError::Failed);
    p["action"] = json!("abito_account_save"); p["config"]["apiKey"] = json!("replacement-key");
    assert_eq!(store.command(&p, |_| panic!("failure must not publish")).unwrap_err().code, "keychain_unavailable");
    assert_eq!(store.view(), before);
    assert_eq!(secrets.read(&reference).unwrap().as_deref(), Some("original-key"));
    assert_eq!(store.command(&json!({"action":"abito_account_remove","accountId":"example"}), |_| panic!("failure must not publish")).unwrap_err().code, "keychain_unavailable");
    assert_eq!(store.view()["accounts"], json!([]));
    assert!(secrets.read(&reference).unwrap().is_some());
}

#[test]
fn account_shared_keys_are_references_never_overwritten_or_deleted() {
    for existing in [false, true] {
        let dir = Sandbox::new(); legacy_file(&dir, "key-openai");
        let secrets = Arc::new(FakeSecrets::default());
        if existing { secrets.write("openai-api-key", "existing-chat-key").unwrap(); }
        let mut store = AccountStore::load(dir.file(), secrets.clone()).unwrap();
        let expected = if existing { "existing-chat-key" } else { "synthetic-migration-key" };
        assert_eq!(secrets.read("openai-api-key").unwrap().as_deref(), Some(expected));
        assert_eq!(secrets.values.lock().unwrap().len(), 1);
        let mut p = request("abito_account_save", "openai", "https://example.com/v1");
        p["accountId"] = json!("key-openai");
        for value in [json!("replacement"), Value::Null] {
            p["config"]["apiKey"] = value;
            assert_eq!(store.command(&p, |_| panic!("must not publish")).unwrap_err().code, "invalid_account");
        }
        store.command(&json!({"action":"abito_account_remove","accountId":"key-openai"}), |_| {}).unwrap();
        assert_eq!(secrets.read("openai-api-key").unwrap().as_deref(), Some(expected));
    }
}

#[test]
fn account_owned_removal_clears_key_and_shared_presence_tracks_keychain() {
    let dir = Sandbox::new(); let secrets = Arc::new(FakeSecrets::default());
    let mut store = AccountStore::load(dir.file(), secrets.clone()).unwrap();
    let mut p = request("abito_account_create", "openai", "https://example.com/v1");
    p["config"]["apiKey"] = json!("owned-test-key");
    store.command(&p, |_| {}).unwrap();
    let reference = active_ref(&dir);
    assert_eq!(secrets.read(&reference).unwrap().as_deref(), Some("owned-test-key"));
    store.command(&json!({"action":"abito_account_remove","accountId":"example"}), |_| {}).unwrap();
    assert_eq!(secrets.read(&reference).unwrap(), None);
    p["accountId"] = json!("key-openai"); p["config"].as_object_mut().unwrap().remove("apiKey");
    store.command(&p, |_| {}).unwrap();
    assert_eq!(store.view()["accounts"][0]["hasCredential"], false);
    secrets.write("openai-api-key", "").unwrap();
    assert_eq!(store.view()["accounts"][0]["hasCredential"], false);
    secrets.write("openai-api-key", "shared-test-key").unwrap();
    assert_eq!(store.view()["accounts"][0]["hasCredential"], true);
    assert!(!store.view().to_string().contains("shared-test-key"));
    assert!(!store.view().to_string().contains("credentialRef"));
}

#[test]
fn account_sender_and_shared_rate_guard_reject_before_mutation() {
    let mut rate = crate::bridge::RateLimiter::new();
    assert_eq!(AccountStore::guard("other", "tauri://localhost", &mut rate, 0).unwrap_err().code, "denied");
    assert_eq!(AccountStore::guard("main", "https://example.com", &mut rate, 0).unwrap_err().code, "denied");
    for _ in 0..30 { assert!(AccountStore::guard("main", "tauri://localhost", &mut rate, 0).is_ok()); }
    assert_eq!(AccountStore::guard("main", "tauri://localhost", &mut rate, 0).unwrap_err().code, "rate-exceeded");
    assert!(AccountStore::guard("main", "tauri://localhost", &mut rate, 1000).is_ok());
}

/// #503 S3: the NaN and OpenCode Go chat accounts reference the chat key itself (single source of truth, no second copy).
#[test]
fn nan_and_opencode_go_accounts_share_the_chat_key() {
    assert_eq!(super::shared_credential_ref("key-nan"), Some("nan-api-key"));
    assert_eq!(super::shared_credential_ref("key-opencodego"), Some("opencode-go-api-key"));
    assert_eq!(super::shared_credential_ref("personal"), None);
}

/// Verifier finding (C3): a failed FILE commit must never leave the old key unrecoverable, even when compensation also fails.
#[test]
fn account_remove_with_failed_file_commit_and_failed_compensation_keeps_the_key() {
    let dir = Sandbox::new(); let secrets = Arc::new(FakeSecrets::default());
    let mut store = AccountStore::load(dir.file(), secrets.clone()).unwrap();
    let mut p = request("abito_account_create", "openai", "https://example.com/v1");
    p["config"]["apiKey"] = json!("original-key"); store.command(&p, |_| {}).unwrap();
    let reference = active_ref(&dir);
    std::fs::write(dir.0.join(".accounts.json.pending"), b"owned obstruction").unwrap(); // the file commit will fail
    *secrets.mutations_left.lock().unwrap() = Some(1);                                    // one keychain mutation works, the rest fail
    let result = store.command(&json!({"action":"abito_account_remove","accountId":"example"}), |_| panic!("failure must not publish"));
    assert!(result.is_err());
    assert_eq!(secrets.read(&reference).unwrap().as_deref(), Some("original-key"), "the key must survive");
}

#[test]
fn account_replace_with_failed_file_commit_and_failed_compensation_keeps_the_previous_key() {
    let dir = Sandbox::new(); let secrets = Arc::new(FakeSecrets::default());
    let mut store = AccountStore::load(dir.file(), secrets.clone()).unwrap();
    let mut p = request("abito_account_create", "openai", "https://example.com/v1");
    p["config"]["apiKey"] = json!("original-key"); store.command(&p, |_| {}).unwrap();
    let reference = active_ref(&dir);
    std::fs::write(dir.0.join(".accounts.json.pending"), b"owned obstruction").unwrap();
    *secrets.mutations_left.lock().unwrap() = Some(1);
    p["action"] = json!("abito_account_save"); p["config"]["apiKey"] = json!("replacement-key");
    assert!(store.command(&p, |_| panic!("failure must not publish")).is_err());
    assert_eq!(secrets.read(&reference).unwrap().as_deref(), Some("original-key"), "the previous key must survive");
}

#[test]
fn account_remove_commits_the_file_first_and_a_failed_key_delete_keeps_the_key() {
    let dir = Sandbox::new(); let secrets = Arc::new(FakeSecrets::default());
    let mut store = AccountStore::load(dir.file(), secrets.clone()).unwrap();
    let mut p = request("abito_account_create", "openai", "https://example.com/v1");
    p["config"]["apiKey"] = json!("original-key"); store.command(&p, |_| {}).unwrap();
    let reference = active_ref(&dir);
    *secrets.mutations_left.lock().unwrap() = Some(0);
    assert!(store.command(&json!({"action":"abito_account_remove","accountId":"example"}), |_| panic!("no publish")).is_err());
    assert_eq!(store.view()["accounts"], json!([]), "removal stays committed; cleanup is journaled");
    assert_eq!(secrets.read(&reference).unwrap().as_deref(), Some("original-key"));
    assert_eq!(disk(&dir)["pendingCleanup"], json!([reference]));
}

// HU-041: the generic 'custom' provider is created and edited ONLY through the daemon's reviewed
// custom_* gateway; the local keyring path refuses it for every account action.
#[test]
fn account_path_refuses_provider_custom_for_every_action() {
    for action in ["abito_account_create", "abito_account_save", "abito_account_endpoint_set"] {
        let p = request(action, "custom", "https://gateway.example/v1");
        assert!(parse_ui_command(&p).is_err(), "{action} must refuse provider custom");
        let dir = Sandbox::new(); let mut store = load(dir.file()).unwrap();
        let before = store.view(); let mut events = 0;
        assert_eq!(store.command(&p, |_| events += 1).unwrap_err().code, "invalid_account");
        assert!(!dir.file().exists()); assert_eq!(store.view(), before); assert_eq!(events, 0);
    }
}

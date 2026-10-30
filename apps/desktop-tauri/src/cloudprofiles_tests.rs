use super::*;
use crate::secrets::{SecretStore, StoreError};
struct Store(Option<(&'static str, &'static str)>);
impl SecretStore for Store {
    fn read(&self, key: &str) -> Result<Option<String>, StoreError> {
        if self.0.is_some_and(|(k, _)| k == "unavailable") { return Err(StoreError::Unavailable); }
        Ok(self.0.filter(|(k, _)| *k == key).map(|(_, v)| v.into()))
    }
    fn write(&self, _: &str, _: &str) -> Result<(), StoreError> { unreachable!() }
    fn delete(&self, _: &str) -> Result<(), StoreError> { unreachable!() }
}
#[test]
fn only_credentialed_profiles_are_listed() {
    assert!(cloud_entries(&Store(None)).is_empty());
    let entries = cloud_entries(&Store(Some(("openai-api-key", "fixture"))));
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().all(|e| e.provider == CloudProvider::OpenAi));
    assert!(cloud_entries(&Store(Some(("claude-oauth", "not-json")))).is_empty());
    assert!(cloud_entries(&Store(Some(("unavailable", "")))).is_empty());
    assert!(cloud_entries(&Store(Some(("openai-api-key", "")))).is_empty());
    for key in ["claude-oauth", "chatgpt-oauth"] {
        let entries = cloud_entries(&Store(Some((key, r#"{"refresh_token":"fixture","access_token":"fixture","expires_at":18446744073709551615,"account_id":"fixture"}"#))));
        assert!(!entries.is_empty());
        assert!(entries.iter().all(|e| e.key == key));
        assert!(cloud_entries(&Store(Some((key, r#"{"refresh_token":"fixture","expires_at":1}"#)))).is_empty());
    }
}
#[test]
fn closed_ids_and_safe_view() {
    assert!(select("cloud-openai-forged").is_err());
    for entry in PROFILES {
        let view = entry.view();
        assert!(!view.to_string().contains("/v1"));
        assert_eq!(view["profile_revision"], 1);
        assert_eq!(select(entry.id).unwrap().id, entry.id);
        assert_eq!(crate::models::parse_saved(Some(&crate::models::saved_bytes(entry.id))), crate::models::Saved::Selected(entry.id.into()));
        assert!(!view.to_string().contains("fixture"));
        let url = reqwest::Url::parse(view["origin"].as_str().unwrap()).unwrap();
        assert_eq!(url.path(), "/");
        assert_eq!(url.scheme(), "https");
    }
}
#[test]
fn missing_credential_is_named() {
    let e = select("cloud-openai-gpt-4o").unwrap();
    let err = e.require(&Store(None)).unwrap_err();
    assert_eq!(err.code, "credential_missing");
    assert_eq!(err.safe_message, "Configura OpenAI en Ajustes → Chat.");
}

/// Final verifier (77d6165): a cloud selection is only valid while its credential exists.
#[test]
fn a_cloud_id_cannot_be_selected_without_its_credential() {
    assert_eq!(select_credentialed("cloud-openai-gpt-4o", &Store(None)).unwrap_err().code, "credential_missing");
    assert!(select_credentialed("cloud-openai-forged", &Store(Some(("openai-api-key", "fixture")))).is_err());
    assert_eq!(select_credentialed("cloud-openai-gpt-4o", &Store(Some(("openai-api-key", "fixture")))).unwrap().id, "cloud-openai-gpt-4o");
    assert!(select_credentialed("cloud-openai-gpt-4o", &Store(Some(("unavailable", "")))).is_err(), "unreadable keychain never selects");
}
#[test]
fn a_stale_cloud_selection_is_reset_when_the_credential_disappears() {
    let selected = select("cloud-openai-gpt-4o").ok();
    assert!(reconcile(selected, &Store(None)).is_none(), "key removed or signed out");
    assert!(reconcile(selected, &Store(Some(("openai-api-key", "fixture")))).is_some(), "still credentialed: untouched");
    assert!(reconcile(None, &Store(None)).is_none());
}

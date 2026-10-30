//! Closed cloud picker profiles. Models/subscription compatibility: sin verificar.
use crate::chat::{ChatError, ProfileRef};
use crate::cloudmodel::{CloudProvider, CloudTarget, CredentialRef};
use crate::provider_oauth::{OauthError, Provider};
use crate::secrets::SecretStore;
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug)]
pub struct Entry { pub id: &'static str, pub provider: CloudProvider, pub label: &'static str, pub model: &'static str, key: &'static str, oauth: Option<Provider> }
pub type CloudSelection = Entry;
macro_rules! profile {
    ($provider:ident, $label:literal, $slug:literal, $model:literal, $key:literal, $oauth:expr) => {
        Entry { id: concat!("cloud-", $slug), provider: CloudProvider::$provider, label: $label, model: $model, key: $key, oauth: $oauth }
    };
}
pub const PROFILES: &[Entry] = &[
    profile!(Anthropic, "Anthropic", "anthropic-claude-opus-5", "claude-opus-5", "anthropic-api-key", None),
    profile!(Anthropic, "Anthropic", "anthropic-claude-sonnet-5", "claude-sonnet-5", "anthropic-api-key", None),
    profile!(Anthropic, "Anthropic", "anthropic-claude-haiku-4-5", "claude-haiku-4-5", "anthropic-api-key", None),
    profile!(Anthropic, "Claude", "claude-claude-opus-5", "claude-opus-5", "claude-oauth", Some(Provider::Claude)),
    profile!(Anthropic, "Claude", "claude-claude-sonnet-5", "claude-sonnet-5", "claude-oauth", Some(Provider::Claude)),
    profile!(Anthropic, "Claude", "claude-claude-haiku-4-5", "claude-haiku-4-5", "claude-oauth", Some(Provider::Claude)),
    profile!(OpenAi, "OpenAI", "openai-gpt-4o", "gpt-4o", "openai-api-key", None),
    profile!(OpenAi, "OpenAI", "openai-gpt-4o-mini", "gpt-4o-mini", "openai-api-key", None),
    profile!(Codex, "ChatGPT", "codex-gpt-5-codex", "gpt-5-codex", "chatgpt-oauth", Some(Provider::Chatgpt)),
    profile!(Google, "Google", "google-gemini-2-0-flash", "gemini-2.0-flash", "google-api-key", None),
    profile!(OpenRouter, "OpenRouter", "openrouter-openrouter-auto", "openrouter/auto", "openrouter-api-key", None),
    profile!(Nan, "NaN", "nan-nan-default", "nan-default", "nan-api-key", None),
    profile!(OpenCodeGo, "OpenCode Go", "opencode-go-kimi-k3", "kimi-k3", "opencode-go-api-key", None),
    profile!(OpenCodeGo, "OpenCode Go", "opencode-go-glm-5-2", "glm-5.2", "opencode-go-api-key", None),
    profile!(OpenCodeGo, "OpenCode Go", "opencode-go-deepseek-v4-pro", "deepseek-v4-pro", "opencode-go-api-key", None),
];
pub fn clock() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() }
pub fn select(id: &str) -> Result<Entry, ChatError> { PROFILES.iter().find(|p| p.id == id).copied().ok_or_else(ChatError::profile_missing) }
pub fn resolve(p: &ProfileRef) -> Result<CredentialRef, OauthError> {
    let e = select(&p.profile_id).map_err(|_| OauthError::Invalid)?;
    if p.revision != 1 || p.lane_id != "conversation" { return Err(OauthError::Invalid); }
    Ok(e.oauth.map(CredentialRef::Oauth).unwrap_or(CredentialRef::ApiKey(e.key)))
}
impl Entry {
    pub fn profile(self) -> ProfileRef { ProfileRef { profile_id: self.id.into(), revision: 1, lane_id: "conversation".into() } }
    pub fn target(self) -> CloudTarget { CloudTarget::new(self.provider, self.profile(), self.model.into(), crate::chatlane::ISLAND_MAX_OUTPUT_TOKENS) }
    /// Presence only, no refresh/network. Mirrors OAuth status (valid, unexpired sign-in).
    pub fn present(self, store: &dyn SecretStore) -> bool {
        let Some(value) = store.read(self.key).ok().flatten().filter(|s| !s.is_empty()) else { return false };
        if self.oauth.is_none() { return true; }
        let Ok(v) = serde_json::from_str::<Value>(&value) else { return false };
        v["refresh_token"].as_str().is_some_and(|s| !s.is_empty()) && v["expires_at"].as_u64().is_some_and(|t| t > clock())
    }
    pub fn missing(self) -> ChatError { ChatError { code: "credential_missing".into(), safe_message: format!("Configura {} en Ajustes → Chat.", self.label), retryable: false } }
    pub fn require(self, store: &dyn SecretStore) -> Result<(), ChatError> { if self.present(store) { Ok(()) } else { Err(self.missing()) } }
    pub fn view(self) -> Value { let t = self.target(); json!({"origin": t.origin(), "alias": self.model, "profile_id": self.id, "profile_revision": 1, "max_output_tokens": t.max_output}) }
    pub fn listing(self) -> Value { let mut v = self.view(); v["revision"] = json!(1); v["selectable"] = json!(true); v["cloud"] = json!(true); v["provider"] = json!(self.label); v["gate"] = json!({"state":"ready", "message":"Credencial presente."}); v }
}
/// Selecting a cloud id requires its credential NOW (a provider the picker would not list cannot be selected).
pub fn select_credentialed(id: &str, store: &dyn SecretStore) -> Result<Entry, ChatError> { let e = select(id)?; e.require(store)?; Ok(e) }
/// A saved or current cloud selection whose credential is gone (sign-out, key removed) is no selection at all.
pub fn reconcile(selected: Option<Entry>, store: &dyn SecretStore) -> Option<Entry> { selected.filter(|e| e.present(store)) }
pub fn cloud_entries(store: &dyn SecretStore) -> Vec<Entry> { PROFILES.iter().copied().filter(|e| e.present(store)).collect() }
#[cfg(test)]
#[path = "cloudprofiles_tests.rs"]
mod tests;

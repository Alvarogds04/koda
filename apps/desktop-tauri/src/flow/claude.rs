//! Optional text-only Anthropic cleanup. Adapted from Coucou (MIT, Louis Raillé).
use super::cleanup::{CleanupProvider, Request};
use crate::secrets::{Keychain, SecretStore};
use serde_json::{json, Value};
use std::time::Duration;

const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const TIMEOUT: Duration = Duration::from_secs(4);
const MAX_BODY: usize = 256 * 1024;
pub struct AnthropicCleanup;

#[derive(Clone, Copy, Debug)]
enum Failure { Timeout, OddReply, Http(u16) }
impl Failure {
    fn message(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Http(300..=399) => "http 3xx",
            Self::Http(400..=499) => "http 4xx",
            Self::Http(500..=599) => "http 5xx",
            Self::Http(_) => "http status",
            Self::OddReply => "odd reply",
        }
    }
}
fn body(r: &Request<'_>) -> Value {
    json!({"model":"claude-haiku-4-5","max_tokens":2048,"system":r.system_prompt(),
        "messages":[{"role":"user","content":r.user_message()}]})
}
fn reply(bytes: &[u8]) -> Result<String, Failure> {
    if bytes.len() > MAX_BODY { return Err(Failure::OddReply); }
    let v: Value = serde_json::from_slice(bytes).map_err(|_| Failure::OddReply)?;
    if v["stop_reason"] == "refusal" { return Err(Failure::OddReply); }
    let blocks = v["content"].as_array().ok_or(Failure::OddReply)?;
    let text: String = blocks.iter().filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str()).collect();
    if text.trim().is_empty() { return Err(Failure::OddReply); }
    Ok(text.trim().to_string())
}
fn clean_using(store: &dyn SecretStore, r: &Request<'_>, send: impl FnOnce(&str, &Value) -> Result<Vec<u8>, Failure>) -> Result<String, String> {
    let key = store.read("anthropic-api-key").ok().flatten().filter(|k| !k.is_empty())
        .ok_or_else(|| "no key".to_string())?;
    send(&key, &body(r)).and_then(|bytes| reply(&bytes)).map_err(|e| e.message().into())
}
impl CleanupProvider for AnthropicCleanup {
    fn clean(&self, r: &Request<'_>) -> Result<String, String> {
        clean_using(&Keychain, r, send)
    }
}
fn network_error(e: reqwest::Error) -> Failure {
    if e.is_timeout() { Failure::Timeout } else { Failure::OddReply }
}
/// A std worker drives one request; no redirect, retry, alternate endpoint or API error text.
fn send(key: &str, body: &Value) -> Result<Vec<u8>, Failure> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| Failure::OddReply)?;
    rt.block_on(async {
        tokio::time::timeout(TIMEOUT, async {
            let client = reqwest::Client::builder().https_only(true)
                .redirect(reqwest::redirect::Policy::none()).timeout(TIMEOUT)
                .connect_timeout(TIMEOUT).build().map_err(network_error)?;
            let mut response = client.post(ENDPOINT).header("x-api-key", key)
                .header("anthropic-version", "2023-06-01").header("content-type", "application/json")
                .body(body.to_string()).send().await.map_err(network_error)?;
            if !response.status().is_success() { return Err(Failure::Http(response.status().as_u16())); }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(network_error)? {
                if chunk.len() > MAX_BODY - bytes.len() { return Err(Failure::OddReply); }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        }).await.map_err(|_| Failure::Timeout)?
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{flow::{cleanup, store::Style}, secrets::StoreError};
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Key(bool);
    impl SecretStore for Key {
        fn read(&self, name: &str) -> Result<Option<String>, StoreError> {
            assert_eq!(name, "anthropic-api-key");
            Ok(self.0.then(|| "secret-test-key".into()))
        }
        fn write(&self, _: &str, _: &str) -> Result<(), StoreError> { unreachable!() }
        fn delete(&self, _: &str) -> Result<(), StoreError> { unreachable!() }
    }
    struct Fake { key: bool, result: Result<Vec<u8>, Failure>, calls: AtomicUsize }
    impl CleanupProvider for Fake {
        fn clean(&self, r: &Request<'_>) -> Result<String, String> {
            clean_using(&Key(self.key), r, |key, _| {
                assert_eq!(key, "secret-test-key");
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.result.clone()
            })
        }
    }
    #[test]
    fn body_and_text_blocks_match_messages_contract() {
        let words = vec!["Abito".into()];
        let r = Request { text: "hello there my good friend", style: Style::Polished, app: Some("Outlook"), words: &words };
        assert_eq!(body(&r), json!({"model":"claude-haiku-4-5","max_tokens":2048,
            "system":r.system_prompt(),"messages":[{"role":"user","content":r.user_message()}]}));
        assert_eq!(reply(br#"{"content":[{"type":"text","text":" Hi"},{"type":"tool_use","text":"IGNORE"},{"type":"text","text":" there "}]}"#).unwrap(), "Hi there");
        for bad in [b"no json".as_slice(), br#"{}"#, br#"{"content":[]}"#, br#"{"content":[{"type":"text","text":" "}]}"#,
            br#"{"stop_reason":"refusal","content":[{"type":"text","text":"No"}]}"#] {
            assert!(reply(bad).is_err());
        }
    }
    #[test]
    fn oversized_replies_and_transport_errors_are_fixed_and_redacted() {
        assert!(reply(&vec![b' '; MAX_BODY + 1]).is_err());
        let r = Request { text: "one two three", style: Style::Natural, app: None, words: &[] };
        for (failure, expected) in [(Failure::Timeout, "timeout"), (Failure::OddReply, "odd reply"),
            (Failure::Http(302), "http 3xx"), (Failure::Http(401), "http 4xx"),
            (Failure::Http(503), "http 5xx"), (Failure::Http(100), "http status")] {
            assert_eq!(clean_using(&Key(true), &r, |_, _| Err(failure)).unwrap_err(), expected);
        }
        assert_eq!(clean_using(&Key(false), &r, |_, _| panic!("missing key sent a request")).unwrap_err(), "no key");
    }
    #[test]
    fn fake_transport_cleanup_guards_fallback_and_secret_safety() {
        let raw = "hello there my good friend";
        let ok = serde_json::to_vec(&json!({"content":[{"type":"text","text":"Hello there, my good friend."}]})).unwrap();
        for (key, enabled, style, text, result, expected, calls) in [
            (true, true, Style::Natural, raw, Ok(ok.clone()), "Hello there, my good friend.", 1),
            (true, false, Style::Natural, raw, Ok(ok.clone()), raw, 0),
            (true, true, Style::Verbatim, raw, Ok(ok.clone()), raw, 0),
            (true, true, Style::Natural, "two words", Ok(ok.clone()), "two words", 0),
            (false, true, Style::Natural, raw, Ok(ok), raw, 0),
            (true, true, Style::Natural, raw, Err(Failure::Timeout), raw, 1),
            (true, true, Style::Natural, raw, Err(Failure::Http(500)), raw, 1),
            (true, true, Style::Natural, raw, Ok(b"bad reply".to_vec()), raw, 1),
        ] {
            let fake = Fake { key, result, calls: AtomicUsize::new(0) };
            assert_eq!(cleanup::clean(Some(&fake), enabled, text, style, None, &[]), expected);
            assert_eq!(fake.calls.load(Ordering::SeqCst), calls);
            if let Err(error) = fake.clean(&Request { text, style, app: None, words: &[] }) {
                assert!(!error.contains("secret-test-key"));
            }
        }
    }
}

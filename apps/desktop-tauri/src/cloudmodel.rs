//! Rust-direct cloud streaming. Credentials and upstream failures never implement revealing Debug.
use std::time::Duration;
use serde_json::{json, Value};
use crate::chat::{ChatError, Message, ProfileRef};
use crate::localmodel::{Cancel, Deadlines, Ended, Finish, StreamItem, SSE_MAX_LINE, MAX_STREAM_BYTES};
use crate::provider_oauth::{OAuth, OauthError, Provider};

// Unverified subscription compatibility values live together with PROVIDERS, not scattered here.
pub use crate::provider_oauth::{CLAUDE_OAUTH_SYSTEM, CLAUDE_OAUTH_BETA, CODEX_URL, CODEX_BETA, CODEX_ORIGINATOR};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind { AnthropicMessages, OpenAiChat, CodexResponses }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudProvider { Anthropic, OpenAi, Google, OpenRouter, Nan, OpenCodeGo, Codex }
// Only Rust chooses credential destinations. No settings/WebView URL is accepted.
const CLOUD_PROVIDERS: [(CloudProvider, Kind, &str); 7] = [
    (CloudProvider::Anthropic, Kind::AnthropicMessages, "https://api.anthropic.com/v1"),
    (CloudProvider::OpenAi, Kind::OpenAiChat, "https://api.openai.com/v1"),
    (CloudProvider::Google, Kind::OpenAiChat, "https://generativelanguage.googleapis.com/v1beta/openai"),
    (CloudProvider::OpenRouter, Kind::OpenAiChat, "https://openrouter.ai/api/v1"),
    (CloudProvider::Nan, Kind::OpenAiChat, "https://api.nan.builders/v1"),
    (CloudProvider::OpenCodeGo, Kind::OpenAiChat, "https://opencode.ai/inference/go/openai/v1"),
    (CloudProvider::Codex, Kind::CodexResponses, CODEX_URL),
];
#[derive(Clone)]
pub struct CloudTarget { kind: Kind, pub profile: ProfileRef, pub model: String, base_url: String, pub max_output: usize }
impl CloudTarget {
    /// Public identity is the vendor origin only, never an API path or credential.
    pub fn origin(&self) -> String { reqwest::Url::parse(&self.base_url).expect("fixed URL").origin().ascii_serialization() }
    pub fn new(provider: CloudProvider, profile: ProfileRef, model: String, max_output: usize) -> Self {
        let (_, _, base) = CLOUD_PROVIDERS.iter().find(|(p, _, _)| *p == provider).expect("closed provider table");
        Self::fixed(provider, profile, model, max_output, base).expect("fixed provider URL")
    }
    fn fixed(provider: CloudProvider, profile: ProfileRef, model: String, max_output: usize, base: &str) -> Result<Self, OauthError> {
        let (_, kind, expected) = CLOUD_PROVIDERS.iter().find(|(p, _, _)| *p == provider).ok_or(OauthError::Invalid)?;
        // Exact canonical strings reject parser normalization, ports, userinfo and path tricks.
        if base != *expected { return Err(OauthError::Invalid); }
        Ok(Self { kind: *kind, profile, model, base_url: base.into(), max_output })
    }
    #[cfg(test)]
    pub(crate) fn loopback(kind: Kind, profile: ProfileRef, model: String, max_output: usize, base: &str, credential: &Credential) -> Result<Self, OauthError> {
        let url = reqwest::Url::parse(base).map_err(|_| OauthError::Invalid)?;
        if credential.oauth || url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() { return Err(OauthError::Invalid); }
        Ok(Self { kind, profile, model, max_output, base_url: base.into() })
    }
}
impl std::fmt::Debug for CloudTarget { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.debug_struct("CloudTarget").field("kind", &self.kind).finish_non_exhaustive() } }
pub struct Credential { secret: String, oauth: bool, provider: Option<Provider>, account_id: Option<String> }
impl Credential {
    /// None is an API key; OAuth credentials retain their issuing vendor.
    pub fn new(secret: String, provider: Option<Provider>, account_id: Option<String>) -> Self {
        Self { secret, oauth: provider.is_some(), provider, account_id }
    }
}
impl std::fmt::Debug for Credential { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Credential(<redacted>)") } }
pub trait CredentialSource: Sync {
    fn credential(&self, profile: &ProfileRef) -> Result<Credential, OauthError>;
    fn refresh(&self, profile: &ProfileRef, rejected: &str) -> Result<Credential, OauthError>;
    /// Blocking implementations must honor cancellation and the absolute turn deadline here.
    fn credential_controlled(&self, profile: &ProfileRef, _cancel: &Cancel, _deadline: std::time::Instant) -> Result<Credential, OauthError> { self.credential(profile) }
    fn refresh_controlled(&self, profile: &ProfileRef, rejected: &str, _cancel: &Cancel, _deadline: std::time::Instant) -> Result<Credential, OauthError> { self.refresh(profile, rejected) }
}
#[derive(Clone, Copy)]
pub enum CredentialRef { ApiKey(&'static str), Oauth(Provider) }
/// Host binds profile revisions to keychain names/providers; never supplied by SSE or WebView text.
pub struct KeychainCredentials<'a> {
    pub store: &'a (dyn crate::secrets::SecretStore + Sync), pub oauth: &'a OAuth<'a>,
    pub resolve: &'a (dyn Fn(&ProfileRef) -> Result<CredentialRef, OauthError> + Sync),
    pub clock: &'a (dyn Fn() -> u64 + Sync),
}
impl CredentialSource for KeychainCredentials<'_> {
    fn credential_controlled(&self, p: &ProfileRef, cancel: &Cancel, deadline: std::time::Instant) -> Result<Credential, OauthError> {
        let cancelled = || cancel.is_cancelled();
        let oauth = self.oauth.controlled(&cancelled, deadline);
        KeychainCredentials { store: self.store, oauth: &oauth, resolve: self.resolve, clock: self.clock }.credential(p)
    }
    fn refresh_controlled(&self, p: &ProfileRef, rejected: &str, cancel: &Cancel, deadline: std::time::Instant) -> Result<Credential, OauthError> {
        let cancelled = || cancel.is_cancelled();
        let oauth = self.oauth.controlled(&cancelled, deadline);
        KeychainCredentials { store: self.store, oauth: &oauth, resolve: self.resolve, clock: self.clock }.refresh(p, rejected)
    }
    fn credential(&self, p: &ProfileRef) -> Result<Credential, OauthError> {
        match (self.resolve)(p)? {
            CredentialRef::ApiKey(key) => {
                if !crate::secrets::KNOWN_KEYS.contains(&key) || !key.ends_with("-key") { return Err(OauthError::Invalid); }
                Ok(Credential::new(self.store.read(key).map_err(|_| OauthError::Store)?.filter(|s| !s.is_empty()).ok_or(OauthError::NeedsSignIn)?, None, None))
            }
            CredentialRef::Oauth(provider) => Ok(Credential::new(self.oauth.access_token(provider, (self.clock)())?, Some(provider), self.oauth.account_id(provider)?)),
        }
    }
    fn refresh(&self, p: &ProfileRef, rejected: &str) -> Result<Credential, OauthError> {
        match (self.resolve)(p)? {
            CredentialRef::Oauth(provider) => Ok(Credential::new(self.oauth.refresh_rejected(provider, (self.clock)(), rejected)?, Some(provider), self.oauth.account_id(provider)?)),
            _ => Err(OauthError::Rejected),
        }
    }
}
fn failed() -> Ended { Ended::Failed(ChatError::inference_error()) }
fn signin() -> Ended { Ended::Failed(ChatError { code: "provider_sign_in_required".into(), safe_message: "Vuelve a iniciar sesión".into(), retryable: false }) }
fn credential_error(e: OauthError) -> Ended { if matches!(e, OauthError::Rejected | OauthError::NeedsSignIn) { signin() } else { failed() } }
fn endpoint(target: &CloudTarget, test_http: bool) -> Result<reqwest::Url, Ended> {
    let mut url = reqwest::Url::parse(&target.base_url).map_err(|_| failed())?;
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() { return Err(failed()); }
    if url.scheme() != "https" && !(test_http && url.scheme() == "http" && url.host_str() == Some("127.0.0.1")) { return Err(failed()); }
    let suffix = match target.kind { Kind::AnthropicMessages => "/messages", Kind::OpenAiChat => "/chat/completions", Kind::CodexResponses => "/responses" };
    if !url.path().ends_with(suffix) { url.set_path(&format!("{}{suffix}", url.path().trim_end_matches('/'))); }
    Ok(url)
}
fn oauth_destination(kind: Kind, credential: &Credential, url: &reqwest::Url) -> bool {
    url.scheme() == "https" && url.port_or_known_default() == Some(443) && match (kind, credential.provider) {
        (Kind::AnthropicMessages, Some(Provider::Claude)) => url.host_str() == Some("api.anthropic.com"),
        (Kind::CodexResponses, Some(Provider::Chatgpt)) => url.host_str() == Some("chatgpt.com"),
        _ => false,
    }
}
fn body(target: &CloudTarget, messages: &[Message], oauth: bool) -> Result<Value, Ended> {
    let system: Vec<_> = messages.iter().filter(|m| m.role == "system").map(|m| m.content.as_str().ok_or_else(failed)).collect::<Result<_, _>>()?;
    let instructions = system.join("\n\n");
    let conversation: Vec<_> = messages.iter().filter(|m| m.role != "system").collect();
    Ok(match target.kind {
        Kind::OpenAiChat => json!({"model":target.model,"messages":messages,"stream":true,"max_tokens":target.max_output}),
        Kind::AnthropicMessages => {
            let mut blocks = vec![];
            if oauth { blocks.push(json!({"type":"text","text":CLAUDE_OAUTH_SYSTEM})); }
            if !instructions.is_empty() { blocks.push(json!({"type":"text","text":instructions})); }
            // This slice does not translate OpenAI image parts to Anthropic image blocks.
            if conversation.iter().any(|m| !m.content.is_string()) { return Err(Ended::Failed(ChatError::vision_unsupported())); }
            json!({"model":target.model,"system":blocks,"messages":conversation,"stream":true,"max_tokens":target.max_output})
        }
        Kind::CodexResponses => json!({"model":target.model,"instructions":instructions,"input":conversation,"stream":true,"store":false}),
    })
}
/// One bounded SSE event at a time. Bounds cover both ignored fields and multiline data.
#[derive(Default)]
struct Decoder { line: Vec<u8>, data: Vec<String>, event_bytes: usize }
impl Decoder {
    fn push(&mut self, input: &[u8], kind: Kind) -> Result<Vec<StreamItem>, ()> {
        let mut items = vec![];
        for &b in input {
            self.event_bytes += 1;
            if self.event_bytes > SSE_MAX_LINE { return Err(()); }
            if b != b'\n' { self.line.push(b); if self.line.len() > SSE_MAX_LINE { return Err(()); } continue; }
            let line = std::mem::take(&mut self.line);
            let line = std::str::from_utf8(&line).map_err(|_| ())?.trim_end_matches('\r');
            if line.is_empty() {
                self.event_bytes = 0;
                if self.data.is_empty() { continue; }
                let data = std::mem::take(&mut self.data).join("\n");
                if kind == Kind::OpenAiChat {
                    let mut sse = crate::localmodel::Sse::default();
                    items.extend(sse.push(format!("data: {data}\n\n").as_bytes()).map_err(|_| ())?);
                } else { decode(&data, kind, &mut items)?; }
            } else if let Some(data) = line.strip_prefix("data:") { self.data.push(data.strip_prefix(' ').unwrap_or(data).into()); }
        }
        Ok(items)
    }
}
fn decode(data: &str, kind: Kind, out: &mut Vec<StreamItem>) -> Result<(), ()> {
    let v: Value = serde_json::from_str(data).map_err(|_| ())?;
    if v.get("error").is_some() { return Err(()); }
    match (kind, v["type"].as_str().ok_or(())?) {
        (_, "error" | "response.failed" | "response.incomplete") => return Err(()),
        (Kind::AnthropicMessages, "content_block_delta") => {
            if v["delta"]["type"] == "text_delta" { out.push(StreamItem::Content(v["delta"]["text"].as_str().ok_or(())?.into())); }
            else if v["delta"]["type"] == "thinking_delta" { out.push(StreamItem::Reasoning); }
        }
        (Kind::AnthropicMessages, "message_delta") => {
            if let Some(reason) = v["delta"]["stop_reason"].as_str() { out.push(StreamItem::Finish(if reason == "max_tokens" { Finish::Length } else { Finish::Stop })); }
        }
        (Kind::AnthropicMessages, "message_stop") => out.push(StreamItem::Done),
        (Kind::CodexResponses, "response.output_text.delta") => out.push(StreamItem::Content(v["delta"].as_str().ok_or(())?.into())),
        (Kind::CodexResponses, "response.completed") => {
            if v.pointer("/response/error").is_some_and(|e| !e.is_null()) { return Err(()); }
            out.push(StreamItem::Done);
        }
        _ => {}
    }
    Ok(())
}
pub fn stream_chat(target: &CloudTarget, source: &dyn CredentialSource, messages: &[Message], deadlines: Deadlines, cancel: &Cancel, on_item: &mut dyn FnMut(&StreamItem)) -> Ended {
    stream_inner(target, source, messages, deadlines, cancel, on_item, false)
}
#[cfg(test)]
fn stream_chat_test(target: &CloudTarget, source: &dyn CredentialSource, messages: &[Message], deadlines: Deadlines, cancel: &Cancel, on_item: &mut dyn FnMut(&StreamItem)) -> Ended {
    stream_inner(target, source, messages, deadlines, cancel, on_item, true)
}
#[allow(clippy::too_many_arguments)]
fn stream_inner(target: &CloudTarget, source: &dyn CredentialSource, messages: &[Message], deadlines: Deadlines, cancel: &Cancel, on_item: &mut dyn FnMut(&StreamItem), test_http: bool) -> Ended {
    if cancel.is_cancelled() { return Ended::Cancelled; }
    if target.max_output == 0 || target.max_output > 32768 || target.model.is_empty() || target.model.len() > 256 { return failed(); }
    let url = match endpoint(target, test_http) { Ok(u) => u, Err(e) => return e };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() { Ok(r) => r, Err(_) => return failed() };
    let started = std::time::Instant::now();
    // Resolve/refresh outside the streaming runtime: OAuth's sync seam owns its own runtime.
    let deadline = started + Duration::from_millis(deadlines.total_ms);
    let mut credential = match source.credential_controlled(&target.profile, cancel, deadline) { Ok(c) => c, Err(_) if cancel.is_cancelled() => return Ended::Cancelled, Err(e) => return credential_error(e) };
    for attempt in 0..2 {
    if cancel.is_cancelled() { return Ended::Cancelled; }
    let Some(left) = Duration::from_millis(deadlines.total_ms).checked_sub(started.elapsed()) else { return failed(); };
    let ended = runtime.block_on(async {
        // Dropping the request/body future on cancellation shuts down reqwest's connection.
        // The total deadline also covers retries and waiting for response headers.
        let work = async {
            let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_millis(deadlines.connect_ms.max(1)))
                .read_timeout(Duration::from_millis(deadlines.idle_ms.max(1))).build().map_err(|_| failed())?;
                let body = body(target, messages, credential.oauth)?;
                let serialized = serde_json::to_vec(&body).map_err(|_| failed())?;
                if serialized.len() > 4 * 1024 * 1024 { return Err(failed()); }
                // Recheck immediately before attaching credentials, on every retry.
                if credential.oauth && !oauth_destination(target.kind, &credential, &url) { return Err(failed()); }
                let mut request = client.post(url.clone()).header("content-type", "application/json").header("accept", "text/event-stream").body(serialized);
                request = match target.kind {
                    Kind::AnthropicMessages => {
                        let request = request.header("anthropic-version", "2023-06-01");
                        if credential.oauth { request.bearer_auth(&credential.secret).header("anthropic-beta", CLAUDE_OAUTH_BETA) } else { request.header("x-api-key", &credential.secret) }
                    }
                    Kind::OpenAiChat => request.bearer_auth(&credential.secret),
                    Kind::CodexResponses => {
                        if !credential.oauth { return Err(signin()); }
                        request.bearer_auth(&credential.secret).header("chatgpt-account-id", credential.account_id.as_ref().ok_or_else(signin)?).header("OpenAI-Beta", CODEX_BETA).header("originator", CODEX_ORIGINATOR)
                    }
                };
                let reply = request.send().await.map_err(|_| failed())?;
                if reply.status().as_u16() == 401 && credential.oauth {
                    return Err(Ended::Failed(ChatError { code: "cloud_retry_401".into(), safe_message: "Vuelve a iniciar sesión".into(), retryable: false }));
                }
                if !reply.status().is_success() { return Err(failed()); }
                if !reply.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|s| s.starts_with("text/event-stream")) { return Err(failed()); }
            let mut response = reply; let mut decoder = Decoder::default();
            let mut bytes = 0usize; let mut output = 0usize; let mut finish = Finish::Stop;
            while let Some(chunk) = response.chunk().await.map_err(|_| failed())? {
                bytes = bytes.saturating_add(chunk.len()); if bytes > MAX_STREAM_BYTES { return Err(failed()); }
                for item in decoder.push(&chunk, target.kind).map_err(|_| failed())? {
                    if cancel.is_cancelled() { return Ok(Ended::Cancelled); }
                    if let StreamItem::Content(text) = &item {
                        let left = (target.max_output * 4).saturating_sub(output);
                        let n = text.chars().count();
                        if n > left {
                            if left > 0 { on_item(&StreamItem::Content(text.chars().take(left).collect())); }
                            on_item(&StreamItem::Finish(Finish::Length)); on_item(&StreamItem::Done);
                            return Ok(Ended::Finished(Finish::Length));
                        }
                        output += n;
                    }
                    on_item(&item);
                    match item { StreamItem::Finish(f) => finish = f, StreamItem::Done => return Ok(Ended::Finished(finish)), _ => {} }
                }
            }
            Err(failed()) // EOF without explicit completion is never success.
        };
        let cancelled = async { loop { if cancel.is_cancelled() { break; } tokio::time::sleep(Duration::from_millis(10)).await; } };
        tokio::select! {
            _ = cancelled => Ended::Cancelled,
            result = tokio::time::timeout(left, work) => match result { Ok(Ok(e)) | Ok(Err(e)) => e, Err(_) => failed() },
        }
    });
    if matches!(&ended, Ended::Failed(e) if e.code == "cloud_retry_401") {
        if attempt == 1 { return signin(); }
        if cancel.is_cancelled() { return Ended::Cancelled; }
        credential = match source.refresh_controlled(&target.profile, &credential.secret, cancel, deadline) { Ok(c) => c, Err(_) if cancel.is_cancelled() => return Ended::Cancelled, Err(e) => return credential_error(e) };
    } else { return ended; }
    }
    signin()
}

/// Cloud counterpart to chatlane's local worker. The local worker is untouched.
pub fn run_turn(lane: &crate::chatlane::SharedLane, turn_id: &str, target: &CloudTarget, source: &dyn CredentialSource, system: &str, deadlines: Deadlines, publish: &(dyn Fn() + Send + Sync)) {
    use crate::chat::{Event, FinishReason};
    let handle = std::sync::Arc::new(Cancel::new());
    let (conversation_id, prompt) = {
        let mut l = lane.lock().expect("chat lane lock");
        if l.convo.turn(turn_id).is_none_or(|t| t.state.is_terminal()) { return; }
        l.cancel = Some((turn_id.into(), handle.clone()));
        let seq = l.convo.turn(turn_id).unwrap().seq + 1; let _ = l.convo.apply(turn_id, seq, Event::Thinking);
        // Conservative fixed input budget until provider profiles carry verified context sizes.
        let prompt = l.convo.prompt_for(turn_id, system, 8192, target.max_output);
        (l.convo.id().to_owned(), prompt)
    };
    publish();
    let apply = |event| {
        let mut l = lane.lock().expect("chat lane lock");
        if l.convo.id() != conversation_id { return; }
        if let Some(turn) = l.convo.turn(turn_id) {
            if turn.state.is_terminal() { return; }
            let seq = turn.seq + 1; let _ = l.convo.apply(turn_id, seq, event);
            if l.convo.turn(turn_id).is_some_and(|t| t.state.is_terminal()) { handle.cancel(); l.persist_turn(turn_id, crate::chatlane::history_now()); }
        }
        drop(l); publish();
    };
    let ended = match prompt {
        Ok(prompt) => stream_chat(target, source, &prompt.messages, deadlines, &handle, &mut |i| { if let StreamItem::Content(s) = i { apply(Event::Delta(s.clone())); } }),
        Err(e) => Ended::Failed(e),
    };
    match ended {
        Ended::Finished(f) => apply(Event::Complete(if f == Finish::Length { FinishReason::Limit } else { FinishReason::Stop })),
        Ended::Failed(e) => apply(Event::Error(e)), Ended::Cancelled => { publish(); }
    }
    let mut l = lane.lock().expect("chat lane lock");
    if l.convo.id() == conversation_id && l.cancel.as_ref().is_some_and(|(id,_)| id == turn_id) { l.cancel = None; }
}
#[cfg(test)]
#[path = "cloudmodel_tests.rs"]
mod tests;

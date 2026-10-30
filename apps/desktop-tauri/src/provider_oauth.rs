//! Subscription OAuth. Pending authorization secrets exist only in memory; credentials only in SecretStore.
use std::sync::Mutex;
use oauth2::{CsrfToken, PkceCodeChallenge, PkceCodeVerifier};
use serde::{Deserialize, Serialize};
use crate::secrets::SecretStore;

// ONE subscription compatibility constants area. All provider-specific OAuth / CLI
// conventions below are sin verificar; L6 accepts the identification-as-another-app risk.
pub const CLAUDE_OAUTH_SYSTEM: &str = "You are Claude Code, Anthropic's official CLI for Claude.";
pub const CLAUDE_OAUTH_BETA: &str = "oauth-2025-04-20";
pub const CODEX_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
pub const CODEX_BETA: &str = "responses=experimental";
pub const CODEX_ORIGINATOR: &str = "codex_cli_rs";
pub const CLAUDE_CODE_CLIENT_ID: &str = match option_env!("ABITO_CLAUDE_CLIENT_ID") { Some(v) => v, None => "9d1c250a-e61b-44d9-88ed-5944d1962f5e" };
pub const CODEX_CLI_CLIENT_ID: &str = match option_env!("ABITO_CODEX_CLIENT_ID") { Some(v) => v, None => "app_EMoamEEZ73f0CkXaXp7hrann" };
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider { Claude, Chatgpt }
impl Provider {
    pub fn config(self) -> &'static ProviderConfig { &PROVIDERS[match self { Self::Claude => 0, Self::Chatgpt => 1 }] }
    pub fn key(self) -> &'static str { match self { Self::Claude => "claude-oauth", Self::Chatgpt => "chatgpt-oauth" } }
}
#[derive(Clone, Copy)]
pub struct ProviderConfig {
    pub id: Provider, pub label: &'static str, pub authorize_url: &'static str,
    pub token_url: &'static str, pub redirect: &'static str, pub scopes: &'static str,
    pub client_id: &'static str, pub extra: &'static [(&'static str, &'static str)],
}
/// Claude values: remembered public Claude Code behavior, sin verificar (not official documentation).
/// ChatGPT issuer/endpoints/scopes/params: remembered Codex CLI behavior, sin verificar.
/// Client IDs: human-supplied Claude Code/Codex values, with build-time overrides; sin verificar.
/// Identifying Abito as another app risks rejection/account restrictions; human accepted this in L6.
pub const PROVIDERS: [ProviderConfig; 2] = [
    ProviderConfig { id: Provider::Claude, label: "Claude", authorize_url: "https://claude.ai/oauth/authorize", token_url: "https://console.anthropic.com/v1/oauth/token", redirect: "https://console.anthropic.com/oauth/code/callback", scopes: "org:create_api_key user:profile user:inference", client_id: CLAUDE_CODE_CLIENT_ID, extra: &[] },
    ProviderConfig { id: Provider::Chatgpt, label: "ChatGPT", authorize_url: "https://auth.openai.com/oauth/authorize", token_url: "https://auth.openai.com/oauth/token", redirect: "http://localhost:1455/auth/callback", scopes: "openid profile email offline_access", client_id: CODEX_CLI_CLIENT_ID, extra: &[("id_token_add_organizations", "true"), ("codex_cli_simplified_flow", "true")] },
];
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OauthError { State, Used, Expired, Rejected, NeedsSignIn, Transport, Store, Invalid, PortBusy }
impl std::fmt::Display for OauthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(match self {
        Self::Rejected => "El proveedor rechazó el inicio de sesión. Vuelve a iniciar sesión.",
        Self::NeedsSignIn => "Vuelve a iniciar sesión.", Self::PortBusy => "El puerto de inicio de sesión está ocupado.",
        Self::State | Self::Used | Self::Expired | Self::Invalid => "El inicio de sesión no es válido o caducó. Vuelve a intentarlo.",
        Self::Transport => "No se pudo contactar con el proveedor. Vuelve a intentarlo.",
        Self::Store => "No se pudo acceder al llavero del sistema.",
    }) }
}
impl std::error::Error for OauthError {}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status { Present, Expired, Absent }
pub struct Pending {
    provider: Provider, state: CsrfToken, verifier: Option<PkceCodeVerifier>, created_at: u64,
    listener: Option<std::net::TcpListener>,
}
impl std::fmt::Debug for Pending { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Pending(<redacted>)") } }
pub struct Begun { pub auth_url: String, pub pending: Pending }
impl std::fmt::Debug for Begun { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Begun(<redacted>)") } }
#[derive(Serialize, Deserialize)]
struct Tokens { refresh_token: String, access_token: Option<String>, expires_at: u64, account_id: Option<String> }
pub struct TokenReply { pub status: u16, pub body: Vec<u8> }
pub trait TokenHttp: Sync {
    fn post(&self, url: &str, form: &[(String, String)]) -> Result<TokenReply, OauthError>;
    /// Injected transports must honor this budget if they perform blocking I/O.
    fn post_controlled(&self, url: &str, form: &[(String, String)], cancelled: &(dyn Fn() -> bool + Sync), deadline: std::time::Instant) -> Result<TokenReply, OauthError> {
        if cancelled() || std::time::Instant::now() >= deadline { return Err(OauthError::Transport); }
        self.post(url, form)
    }
}
pub struct RustlsHttp;
impl TokenHttp for RustlsHttp {
    fn post(&self, url: &str, form: &[(String, String)]) -> Result<TokenReply, OauthError> {
        if oauth2::url::Url::parse(url).map_err(|_| OauthError::Invalid)?.scheme() != "https" { return Err(OauthError::Invalid); }
        token_post(url, form)
    }
    fn post_controlled(&self, url: &str, form: &[(String, String)], cancelled: &(dyn Fn() -> bool + Sync), deadline: std::time::Instant) -> Result<TokenReply, OauthError> {
        if oauth2::url::Url::parse(url).map_err(|_| OauthError::Invalid)?.scheme() != "https" { return Err(OauthError::Invalid); }
        token_post_controlled(url, form, cancelled, deadline)
    }
}
fn token_post(url: &str, form: &[(String, String)]) -> Result<TokenReply, OauthError> {
    token_post_controlled(url, form, &|| false, std::time::Instant::now() + std::time::Duration::from_secs(30))
}
fn token_post_controlled(url: &str, form: &[(String, String)], cancelled: &(dyn Fn() -> bool + Sync), deadline: std::time::Instant) -> Result<TokenReply, OauthError> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| OauthError::Transport)?;
    rt.block_on(async {
        let work = async {
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().timeout(std::time::Duration::from_secs(30)).build().map_err(|_| OauthError::Transport)?;
        let mut response = client.post(url).form(form).send().await.map_err(|_| OauthError::Transport)?;
        let status = response.status().as_u16(); let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| OauthError::Transport)? {
            if body.len() + chunk.len() > 64 * 1024 { return Err(OauthError::Invalid); }
            body.extend_from_slice(&chunk);
        }
        Ok(TokenReply { status, body })
        };
        let cancellation = async { loop { if cancelled() { break; } tokio::time::sleep(std::time::Duration::from_millis(10)).await; } };
        let left = deadline.checked_duration_since(std::time::Instant::now()).ok_or(OauthError::Transport)?;
        tokio::select! {
            _ = cancellation => Err(OauthError::Transport),
            result = tokio::time::timeout(left, work) => result.map_err(|_| OauthError::Transport)?,
        }
    })
}
// Shared across instances as well as callers: refresh and sign-out cannot race credential writes.
static TOKEN_LOCK: Mutex<()> = Mutex::new(());
pub struct OAuth<'a> { store: &'a (dyn SecretStore + Sync), http: &'a dyn TokenHttp, clock: &'a (dyn Fn() -> u64 + Sync), configs: &'a [ProviderConfig; 2], loopback: std::net::SocketAddr, control: Option<(&'a (dyn Fn() -> bool + Sync), std::time::Instant)> }
impl<'a> OAuth<'a> {
    pub fn new(store: &'a (dyn SecretStore + Sync), http: &'a dyn TokenHttp, clock: &'a (dyn Fn() -> u64 + Sync)) -> Self { Self { store, http, clock, configs: &PROVIDERS, loopback: (std::net::Ipv4Addr::LOCALHOST, 1455).into(), control: None } }
    #[cfg(test)]
    fn with_configs(store: &'a (dyn SecretStore + Sync), http: &'a dyn TokenHttp, clock: &'a (dyn Fn() -> u64 + Sync), configs: &'a [ProviderConfig; 2]) -> Self { Self { configs, ..Self::new(store, http, clock) } }
    #[cfg(test)]
    pub(crate) fn with_loopback(mut self, loopback: std::net::SocketAddr) -> Self { self.loopback = loopback; self }
    pub fn controlled<'b>(&'b self, cancelled: &'b (dyn Fn() -> bool + Sync), deadline: std::time::Instant) -> OAuth<'b> {
        OAuth { store: self.store, http: self.http, clock: self.clock, configs: self.configs, loopback: self.loopback, control: Some((cancelled, deadline)) }
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'static, ()>, OauthError> {
        if let Some((cancelled, deadline)) = self.control {
            loop {
                if cancelled() || std::time::Instant::now() >= deadline { return Err(OauthError::Transport); }
                match TOKEN_LOCK.try_lock() {
                    Ok(lock) => return Ok(lock),
                    Err(std::sync::TryLockError::Poisoned(_)) => return Err(OauthError::Store),
                    Err(std::sync::TryLockError::WouldBlock) => std::thread::sleep(std::time::Duration::from_millis(5)),
                }
            }
        }
        TOKEN_LOCK.lock().map_err(|_| OauthError::Store)
    }
    fn config(&self, p: Provider) -> &ProviderConfig { &self.configs[match p { Provider::Claude => 0, Provider::Chatgpt => 1 }] }
    pub fn begin(&self, provider: Provider) -> Result<Begun, OauthError> {
        let listener = if provider == Provider::Chatgpt { Some(std::net::TcpListener::bind(self.loopback).map_err(|_| OauthError::PortBusy)?) } else { None };
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256(); let state = CsrfToken::new_random(); let c = self.config(provider);
        let mut url = oauth2::url::Url::parse(c.authorize_url).map_err(|_| OauthError::Invalid)?;
        url.query_pairs_mut().extend_pairs([("response_type", "code"), ("client_id", c.client_id), ("redirect_uri", c.redirect), ("scope", c.scopes), ("state", state.secret()), ("code_challenge", challenge.as_str()), ("code_challenge_method", "S256")]).extend_pairs(c.extra.iter().copied());
        Ok(Begun { auth_url: url.into(), pending: Pending { provider, state, verifier: Some(verifier), created_at: (self.clock)(), listener } })
    }
    pub fn complete(&self, pending: &mut Pending, input: &str) -> Result<(), OauthError> {
        let verifier = pending.verifier.take().ok_or(OauthError::Used)?;
        pending.listener.take();
        if (self.clock)().saturating_sub(pending.created_at) >= 600 { return Err(OauthError::Expired); }
        let (code, state) = if pending.provider == Provider::Claude {
            let (c,s) = input.split_once('#').ok_or(OauthError::State)?; (c.to_owned(), s.to_owned())
        } else {
            let url = oauth2::url::Url::parse(input).map_err(|_| OauthError::Invalid)?;
            let expected = oauth2::url::Url::parse(self.config(pending.provider).redirect).map_err(|_| OauthError::Invalid)?;
            if url.origin() != expected.origin() || url.path() != expected.path() { return Err(OauthError::State); }
            let pairs: Vec<_> = url.query_pairs().collect();
            if pairs.iter().filter(|(k,_)| k == "code").count() != 1 || pairs.iter().filter(|(k,_)| k == "state").count() != 1 { return Err(OauthError::State); }
            (pairs.iter().find(|(k,_)| k == "code").ok_or(OauthError::State)?.1.to_string(), pairs.iter().find(|(k,_)| k == "state").ok_or(OauthError::State)?.1.to_string())
        };
        if !state_equal(state.as_bytes(), pending.state.secret().as_bytes()) || code.is_empty() { return Err(OauthError::State); }
        let _lock = self.lock()?;
        let c = self.config(pending.provider);
        let tokens = self.exchange(pending.provider, vec![("grant_type".into(), "authorization_code".into()), ("code".into(), code), ("code_verifier".into(), verifier.secret().clone()), ("client_id".into(), c.client_id.into()), ("redirect_uri".into(), c.redirect.into())], None, (self.clock)())?;
        self.save(pending.provider, &tokens)
    }
    /// Poll the reserved IPv4 loopback listener. No connection => Ok(false).
    /// Host polls on a worker until completion/TTL; dropping Pending releases the port.
    pub fn complete_loopback(&self, pending: &mut Pending) -> Result<bool, OauthError> {
        use std::io::{Read, Write};
        if pending.verifier.is_none() { return Err(OauthError::Used); }
        if (self.clock)().saturating_sub(pending.created_at) >= 600 {
            pending.verifier.take(); pending.listener.take(); return Err(OauthError::Expired);
        }
        let listener = pending.listener.as_ref().ok_or(OauthError::Invalid)?;
        listener.set_nonblocking(true).map_err(|_| OauthError::Transport)?;
        let (mut stream, peer) = match listener.accept() {
            Ok(s) => s, Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(false), Err(_) => return Err(OauthError::Transport),
        };
        if peer.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST) { return Err(OauthError::Invalid); }
        stream.set_nonblocking(false).map_err(|_| OauthError::Transport)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut bytes = Vec::new();
        let callback = (|| {
            while !bytes.ends_with(b"\r\n\r\n") {
                if bytes.len() >= 8192 { return Err(OauthError::Invalid); }
                let left = deadline.checked_duration_since(std::time::Instant::now()).ok_or(OauthError::Expired)?;
                stream.set_read_timeout(Some(left)).map_err(|_| OauthError::Transport)?;
                let mut byte = [0];
                if stream.read(&mut byte).map_err(|_| OauthError::Transport)? == 0 { return Err(OauthError::Invalid); }
                bytes.push(byte[0]);
            }
            let text = std::str::from_utf8(&bytes).map_err(|_| OauthError::Invalid)?;
            let mut fields = text.lines().next().ok_or(OauthError::Invalid)?.split_whitespace();
            if fields.next() != Some("GET") { return Err(OauthError::Invalid); }
            let path = fields.next().filter(|s| s.starts_with("/auth/callback?")).ok_or(OauthError::Invalid)?;
            if fields.next() != Some("HTTP/1.1") || fields.next().is_some() { return Err(OauthError::Invalid); }
            Ok(format!("http://localhost:1455{path}"))
        })();
        let result = callback.and_then(|url| self.complete(pending, &url));
        // Even malformed callbacks consume the pending authorization.
        pending.verifier.take(); pending.listener.take();
        let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(1)));
        let response = if result.is_ok() { "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" } else { "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" };
        let _ = stream.write_all(response.as_bytes());
        result.map(|_| true)
    }
    fn load(&self, provider: Provider) -> Result<Option<Tokens>, OauthError> { self.store.read(provider.key()).map_err(|_| OauthError::Store)?.map(|s| serde_json::from_str(&s).map_err(|_| OauthError::Store)).transpose() }
    fn save(&self, p: Provider, t: &Tokens) -> Result<(), OauthError> { self.store.write(p.key(), &serde_json::to_string(t).map_err(|_| OauthError::Store)?).map_err(|_| OauthError::Store) }
    fn exchange(&self, p: Provider, form: Vec<(String,String)>, old: Option<&Tokens>, now: u64) -> Result<Tokens, OauthError> {
        // oauth2 builds the public-client exchange/refresh POST and validates the token
        // response; TokenHttp is the injected rustls transport (also used by loopback fakes).
        let c = self.config(p);
        let client = oauth2::basic::BasicClient::new(oauth2::ClientId::new(c.client_id.into()))
            .set_auth_uri(oauth2::AuthUrl::new(c.authorize_url.into()).map_err(|_| OauthError::Invalid)?)
            .set_token_uri(oauth2::TokenUrl::new(c.token_url.into()).map_err(|_| OauthError::Invalid)?)
            .set_redirect_uri(oauth2::RedirectUrl::new(c.redirect.into()).map_err(|_| OauthError::Invalid)?)
            .set_auth_type(oauth2::AuthType::RequestBody);
        let captured = std::cell::RefCell::new(None);
        let transport = |request: oauth2::HttpRequest| -> Result<oauth2::HttpResponse, OauthError> {
            let pairs: Vec<_> = oauth2::url::form_urlencoded::parse(request.body()).into_owned().collect();
            let reply = if let Some((cancelled, deadline)) = self.control {
                self.http.post_controlled(&request.uri().to_string(), &pairs, cancelled, deadline)?
            } else { self.http.post(&request.uri().to_string(), &pairs)? };
            let response = oauth2::http::Response::builder().status(reply.status)
                .header("content-type", "application/json").body(reply.body.clone()).map_err(|_| OauthError::Invalid)?;
            *captured.borrow_mut() = Some(reply);
            Ok(response)
        };
        let field = |name: &str| form.iter().find(|(k,_)| k == name).map(|(_,v)| v.clone()).ok_or(OauthError::Invalid);
        let parsed = if old.is_some() {
            client.exchange_refresh_token(&oauth2::RefreshToken::new(field("refresh_token")?)).request(&transport)
        } else {
            client.exchange_code(oauth2::AuthorizationCode::new(field("code")?))
                .set_pkce_verifier(PkceCodeVerifier::new(field("code_verifier")?)).request(&transport)
        };
        let reply = captured.into_inner().ok_or(OauthError::Transport)?;
        if [400,401,403].contains(&reply.status) {
            if serde_json::from_slice::<serde_json::Value>(&reply.body).ok().and_then(|v| v["error"].as_str().map(str::to_owned)).as_deref() == Some("invalid_grant") {
                if let Some(t) = old { self.save(p, &Tokens { refresh_token: String::new(), access_token: None, expires_at: 0, account_id: t.account_id.clone() })?; }
            }
            return Err(OauthError::Rejected);
        }
        if !(200..300).contains(&reply.status) { return Err(OauthError::Transport); }
        parsed.map_err(|_| OauthError::Invalid)?;
        let v: serde_json::Value = serde_json::from_slice(&reply.body).map_err(|_| OauthError::Invalid)?;
        let access = v["access_token"].as_str().filter(|s| !s.is_empty()).ok_or(OauthError::Invalid)?;
        let refresh = v["refresh_token"].as_str().or_else(|| old.map(|t| t.refresh_token.as_str())).filter(|s| !s.is_empty()).ok_or(OauthError::Invalid)?;
        let expiry = v["expires_in"].as_u64().filter(|n| *n > 0).ok_or(OauthError::Invalid)?;
        Ok(Tokens { refresh_token: refresh.into(), access_token: Some(access.into()), expires_at: now.saturating_add(expiry), account_id: if p == Provider::Chatgpt { v["id_token"].as_str().and_then(account_id).or_else(|| old.and_then(|t| t.account_id.clone())) } else { None } })
    }
    pub fn access_token(&self, p: Provider, now: u64) -> Result<String, OauthError> { self.token(p, now, None) }
    /// On 401, refresh only if the rejected token is still the current one.
    pub fn refresh_rejected(&self, p: Provider, now: u64, rejected: &str) -> Result<String, OauthError> { self.token(p, now, Some(rejected)) }
    fn token(&self, p: Provider, now: u64, rejected: Option<&str>) -> Result<String, OauthError> {
        let _lock = self.lock()?;
        let t = self.load(p)?.ok_or(OauthError::NeedsSignIn)?;
        if t.refresh_token.is_empty() { return Err(OauthError::NeedsSignIn); }
        if t.expires_at > now.saturating_add(60) && t.access_token.as_deref() != rejected {
            if let Some(access) = t.access_token { return Ok(access); }
        }
        let next = self.exchange(p, vec![("grant_type".into(), "refresh_token".into()), ("refresh_token".into(), t.refresh_token.clone()), ("client_id".into(), self.config(p).client_id.into())], Some(&t), now)?;
        self.save(p, &next)?; next.access_token.ok_or(OauthError::Invalid)
    }
    pub fn account_id(&self, p: Provider) -> Result<Option<String>, OauthError> { let _lock = self.lock()?; Ok(self.load(p)?.and_then(|t| t.account_id)) }
    pub fn status(&self, p: Provider) -> Result<Status, OauthError> { let _lock = self.lock()?; Ok(match self.load(p)? { None => Status::Absent, Some(t) if t.refresh_token.is_empty() || t.expires_at <= (self.clock)() => Status::Expired, Some(_) => Status::Present }) }
    pub fn sign_out(&self, p: Provider) -> Result<(), OauthError> { let _lock = self.lock()?; self.store.delete(p.key()).map_err(|_| OauthError::Store) }
}
fn state_equal(a: &[u8], b: &[u8]) -> bool {
    use sha2::{Digest, Sha256};
    use subtle::ConstantTimeEq;
    // Hashing accepts variable-length input; the constant-time comparison always
    // receives two 32-byte digests, never unequal-length state slices.
    bool::from(Sha256::digest(a).ct_eq(&Sha256::digest(b)))
}
pub fn account_id(jwt: &str) -> Option<String> {
    use base64::Engine;
    let payload = jwt.split('.').nth(1)?;
    if payload.len() > 32 * 1024 { return None; }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id")?.as_str().map(str::to_owned)
}
#[cfg(test)]
#[path = "provider_oauth_tests.rs"]
mod tests;

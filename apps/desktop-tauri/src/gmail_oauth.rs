//! Gmail sign-in with the user's own Google Cloud desktop client (K2-10, S4).
//!
//! Desktop flow from Google's «OAuth 2.0 for Desktop Apps»: the system browser, a
//! loopback redirect on `127.0.0.1` with a random port, PKCE `S256` and a random
//! `state`. The client id (and its optional secret, which Google issues for desktop
//! clients but does not treat as confidential) is pasted by the user; Koda ships no
//! client id and talks to no server of its own. Everything lives in one keychain
//! entry the page can never reach (`secrets::INTERNAL_KEYS`). Only the read-only
//! scope is ever requested. Authorization material is never Debug output.
use crate::provider_oauth::{OauthError, TokenHttp};
use crate::secrets::{SecretStore, MAX_VALUE_BYTES};
use oauth2::{CsrfToken, PkceCodeChallenge, PkceCodeVerifier};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[cfg(test)]
#[path = "gmail_oauth_tests.rs"]
mod tests;

/// Keychain entry (internal: the page cannot set, clear or ask about it).
pub const KEY: &str = "gmail-oauth";
pub const SCOPE: &str = "https://www.googleapis.com/auth/gmail.readonly";
pub const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const CLIENT_SUFFIX: &str = ".apps.googleusercontent.com";
/// A pending authorization (and its loopback port) lives at most this long, in seconds.
const PENDING_TTL: u64 = 600;
/// An access token this close to its expiry is refreshed first, in seconds.
const EXPIRY_MARGIN: u64 = 60;
/// Largest loopback request head accepted.
const HEAD_LIMIT: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GmailError {
    /// No client id was pasted in Settings.
    NoClient,
    /// No usable refresh token: connect (again).
    NeedsSignIn,
    /// The callback did not carry the expected `state` (or carried no code).
    State,
    /// The user declined on Google's consent screen.
    Denied,
    Expired,
    Used,
    /// Google refused the code exchange (wrong client, wrong secret, reused code).
    Rejected,
    /// The grant does not include the Gmail read-only scope.
    ScopeMissing,
    Transport,
    Store,
    Invalid,
    PortBusy,
}
impl GmailError {
    /// Stable code for the page; never carries a value.
    pub fn code(self) -> &'static str {
        match self {
            Self::NoClient => "no_client", Self::NeedsSignIn => "needs_sign_in", Self::State => "state",
            Self::Denied => "denied", Self::Expired => "expired", Self::Used => "used", Self::Rejected => "rejected",
            Self::ScopeMissing => "scope_missing", Self::Transport => "network", Self::Store => "keychain",
            Self::Invalid => "invalid", Self::PortBusy => "port_busy",
        }
    }
}
impl From<OauthError> for GmailError {
    fn from(e: OauthError) -> Self { if e == OauthError::Invalid { Self::Invalid } else { Self::Transport } }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// No client id saved.
    NoClient,
    /// Client id saved, never connected (or the user cancelled/denied).
    SignedOut,
    Connected,
    /// Google stopped accepting the refresh token (revoked, expired, password change).
    Reconnect,
}

/// The user's desktop client, validated.
#[derive(Clone, PartialEq, Eq)]
pub struct Client { pub id: String, pub secret: Option<String> }
impl std::fmt::Debug for Client { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Client(<redacted>)") } }

/// Accepts what Google Cloud shows for a desktop client: `<digits>-<id>.apps.googleusercontent.com`
/// and an optional secret. Pasted whitespace is trimmed; an empty secret means none.
pub fn parse_client(id: &str, secret: Option<&str>) -> Option<Client> {
    let id = id.trim();
    let prefix = id.strip_suffix(CLIENT_SUFFIX)?;
    if id.len() > 256 || prefix.is_empty() || !prefix.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return None; }
    let secret = match secret.map(str::trim) {
        None | Some("") => None,
        Some(s) if s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') => Some(s.to_owned()),
        Some(_) => return None,
    };
    Some(Client { id: id.to_owned(), secret })
}

#[derive(Serialize, Deserialize)]
struct Stored {
    client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_secret: Option<String>,
    /// Empty when signed out.
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    expires_at: u64,
    /// Google refused the refresh token: the user has to connect again.
    #[serde(default)]
    reconnect: bool,
}
impl Stored {
    fn signed_out(client: &Client) -> Self {
        Self { client_id: client.id.clone(), client_secret: client.secret.clone(), refresh_token: String::new(), access_token: None, expires_at: 0, reconnect: false }
    }
    fn client_form(&self, form: &mut Vec<(String, String)>) {
        form.push(("client_id".into(), self.client_id.clone()));
        if let Some(s) = &self.client_secret { form.push(("client_secret".into(), s.clone())); }
    }
}

pub struct Pending {
    state: CsrfToken,
    verifier: Option<PkceCodeVerifier>,
    redirect: String,
    created_at: u64,
    listener: Option<std::net::TcpListener>,
}
impl std::fmt::Debug for Pending { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Pending(<redacted>)") } }
pub struct Begun { pub auth_url: String, pub pending: Pending }
impl std::fmt::Debug for Begun { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Begun(<redacted>)") } }

/// Shared by every instance: a refresh, a sign-in and a forget never race a keychain write.
static LOCK: Mutex<()> = Mutex::new(());

const DONE_PAGE: &str = "Listo: Gmail quedó conectado. Ya podés cerrar esta pestaña y volver a Koda.";
const FAILED_PAGE: &str = "No se pudo conectar Gmail. Volvé a Koda e intentá de nuevo.";

pub struct GmailAuth<'a> { store: &'a (dyn SecretStore + Sync), http: &'a dyn TokenHttp, clock: &'a (dyn Fn() -> u64 + Sync) }
impl<'a> GmailAuth<'a> {
    pub fn new(store: &'a (dyn SecretStore + Sync), http: &'a dyn TokenHttp, clock: &'a (dyn Fn() -> u64 + Sync)) -> Self { Self { store, http, clock } }

    fn lock(&self) -> Result<std::sync::MutexGuard<'static, ()>, GmailError> { LOCK.lock().map_err(|_| GmailError::Store) }
    fn load(&self) -> Result<Option<Stored>, GmailError> {
        self.store.read(KEY).map_err(|_| GmailError::Store)?.map(|s| serde_json::from_str(&s).map_err(|_| GmailError::Store)).transpose()
    }
    fn save(&self, s: &Stored) -> Result<(), GmailError> {
        let mut text = serde_json::to_string(s).map_err(|_| GmailError::Store)?;
        if text.len() > MAX_VALUE_BYTES {
            // Windows Credential Manager caps a secret near 2.5 KB: keep the refresh token, drop the cache.
            text = serde_json::to_string(&Stored { access_token: None, expires_at: 0, client_secret: s.client_secret.clone(), client_id: s.client_id.clone(), refresh_token: s.refresh_token.clone(), reconnect: s.reconnect }).map_err(|_| GmailError::Store)?;
        }
        self.store.write(KEY, &text).map_err(|_| GmailError::Store)
    }

    /// Saves the pasted client. The same client id keeps the connection (a new secret is
    /// stored); a different one signs out and revokes the old grant at Google, best effort.
    pub fn set_client(&self, client: &Client) -> Result<(), GmailError> {
        let old = {
            let _lock = self.lock()?;
            match self.load()? {
                Some(mut s) if s.client_id == client.id => {
                    if s.client_secret != client.secret { s.client_secret = client.secret.clone(); self.save(&s)?; }
                    return Ok(());
                }
                old => { self.save(&Stored::signed_out(client))?; old }
            }
        };
        if let Some(old) = old { self.revoke(old); }
        Ok(())
    }

    /// Best effort: a revoke that cannot reach Google still leaves nothing stored locally.
    fn revoke(&self, old: Stored) {
        let token = if old.refresh_token.is_empty() { old.access_token } else { Some(old.refresh_token) };
        if let Some(token) = token { let _ = self.http.post(REVOKE_URL, &[("token".into(), token)]); }
    }

    pub fn status(&self) -> Result<Status, GmailError> {
        let _lock = self.lock()?;
        Ok(match self.load()? {
            None => Status::NoClient,
            Some(s) if s.refresh_token.is_empty() => if s.reconnect { Status::Reconnect } else { Status::SignedOut },
            Some(_) => Status::Connected,
        })
    }

    /// Reserves a random loopback port and builds Google's authorization URL.
    pub fn begin(&self) -> Result<Begun, GmailError> {
        let stored = { let _lock = self.lock()?; self.load()?.ok_or(GmailError::NoClient)? };
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|_| GmailError::PortBusy)?;
        let port = listener.local_addr().map_err(|_| GmailError::PortBusy)?.port();
        let redirect = format!("http://127.0.0.1:{port}");
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        let state = CsrfToken::new_random();
        let mut url = oauth2::url::Url::parse(AUTH_URL).map_err(|_| GmailError::Invalid)?;
        url.query_pairs_mut().extend_pairs([
            ("response_type", "code"), ("client_id", stored.client_id.as_str()), ("redirect_uri", redirect.as_str()),
            ("scope", SCOPE), ("state", state.secret().as_str()), ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"), ("access_type", "offline"), ("prompt", "consent"),
        ]);
        Ok(Begun { auth_url: url.into(), pending: Pending { state, verifier: Some(verifier), redirect, created_at: (self.clock)(), listener: Some(listener) } })
    }

    /// Polls the loopback listener once. `Ok(false)`: nothing yet (or a stray request such as
    /// the favicon, answered 404). The first callback carrying a query consumes the pending
    /// authorization whatever its outcome.
    pub fn complete_loopback(&self, pending: &mut Pending) -> Result<bool, GmailError> {
        use std::io::Write;
        if pending.verifier.is_none() { return Err(GmailError::Used); }
        if (self.clock)().saturating_sub(pending.created_at) >= PENDING_TTL {
            pending.verifier.take(); pending.listener.take(); return Err(GmailError::Expired);
        }
        let listener = pending.listener.as_ref().ok_or(GmailError::Invalid)?;
        listener.set_nonblocking(true).map_err(|_| GmailError::Transport)?;
        let (mut stream, peer) = match listener.accept() {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
            Err(_) => return Err(GmailError::Transport),
        };
        let answer = |stream: &mut std::net::TcpStream, status: &str, body: &str| {
            let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(1)));
            let _ = stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
        };
        let _ = peer; // bound to 127.0.0.1: every peer is local
        let query = match read_request_target(&mut stream) {
            Some(target) => match target.strip_prefix("/?") { Some(q) => q.to_owned(), None => { answer(&mut stream, "404 Not Found", ""); return Ok(false); } },
            None => { answer(&mut stream, "400 Bad Request", ""); return Ok(false); }
        };
        // Only a callback carrying this flow's state ends it: anything else (a forged state, a
        // port scan, a duplicated parameter) is refused and the flow keeps waiting.
        let Some(outcome) = callback(&query, &pending.state) else { answer(&mut stream, "400 Bad Request", FAILED_PAGE); return Ok(false); };
        let verifier = pending.verifier.take().ok_or(GmailError::Used)?;
        let redirect = pending.redirect.clone();
        pending.listener.take();
        let result = outcome.and_then(|code| self.finish(verifier, &redirect, &code));
        match result {
            Ok(()) => answer(&mut stream, "200 OK", DONE_PAGE),
            Err(_) => answer(&mut stream, "400 Bad Request", FAILED_PAGE),
        }
        result.map(|()| true)
    }

    fn finish(&self, verifier: PkceCodeVerifier, redirect: &str, code: &str) -> Result<(), GmailError> {
        let stored = { let _lock = self.lock()?; self.load()?.ok_or(GmailError::NoClient)? };
        let mut form = vec![("grant_type".into(), "authorization_code".into()), ("code".into(), code.to_owned()), ("code_verifier".into(), verifier.secret().clone()), ("redirect_uri".into(), redirect.to_owned())];
        stored.client_form(&mut form);
        // The keychain lock is never held across the network (status() must answer at once).
        let reply = self.http.post(TOKEN_URL, &form)?;
        if [400, 401, 403].contains(&reply.status) { return Err(GmailError::Rejected); }
        if !(200..300).contains(&reply.status) { return Err(GmailError::Transport); }
        let v: serde_json::Value = serde_json::from_slice(&reply.body).map_err(|_| GmailError::Invalid)?;
        if !v["scope"].as_str().is_some_and(|s| s.split(' ').any(|x| x == SCOPE)) { return Err(GmailError::ScopeMissing); }
        let (access, expires) = access_of(&v)?;
        let refresh = v["refresh_token"].as_str().filter(|s| !s.is_empty()).ok_or(GmailError::Invalid)?.to_owned();
        let _lock = self.lock()?;
        // The client was changed or forgotten while Google answered: these tokens belong to nobody.
        let mut current = self.load()?.filter(|c| c.client_id == stored.client_id).ok_or(GmailError::NoClient)?;
        current.refresh_token = refresh;
        current.access_token = Some(access);
        current.expires_at = (self.clock)().saturating_add(expires);
        current.reconnect = false;
        self.save(&current)
    }

    /// A valid access token, refreshed when it is about to expire or when the Gmail API
    /// just rejected `rejected` (refreshed only if that is still the current token).
    pub fn access_token(&self, rejected: Option<&str>) -> Result<String, GmailError> {
        let stored = {
            let _lock = self.lock()?;
            let stored = self.load()?.ok_or(GmailError::NoClient)?;
            if stored.refresh_token.is_empty() { return Err(GmailError::NeedsSignIn); }
            if let Some(access) = stored.access_token.as_deref() {
                if stored.expires_at > (self.clock)().saturating_add(EXPIRY_MARGIN) && Some(access) != rejected { return Ok(access.to_owned()); }
            }
            stored
        };
        let mut form = vec![("grant_type".into(), "refresh_token".into()), ("refresh_token".into(), stored.refresh_token.clone())];
        stored.client_form(&mut form);
        // The keychain lock is never held across the network (status() must answer at once).
        let reply = self.http.post(TOKEN_URL, &form)?;
        let _lock = self.lock()?;
        // Write back only onto the same grant: a forget, a client change or a newer sign-in
        // that happened meanwhile wins.
        let mut current = self.load()?.filter(|c| c.client_id == stored.client_id && c.refresh_token == stored.refresh_token).ok_or(GmailError::NeedsSignIn)?;
        if (400..500).contains(&reply.status) {
            let error = serde_json::from_slice::<serde_json::Value>(&reply.body).ok().and_then(|v| v["error"].as_str().map(str::to_owned));
            if matches!(error.as_deref(), Some("invalid_grant" | "invalid_client" | "unauthorized_client")) {
                current.refresh_token.clear(); current.access_token = None; current.expires_at = 0; current.reconnect = true;
                self.save(&current)?;
                return Err(GmailError::NeedsSignIn);
            }
            return Err(GmailError::Transport);
        }
        if !(200..300).contains(&reply.status) { return Err(GmailError::Transport); }
        let v: serde_json::Value = serde_json::from_slice(&reply.body).map_err(|_| GmailError::Invalid)?;
        let (access, expires) = access_of(&v)?;
        if let Some(r) = v["refresh_token"].as_str().filter(|s| !s.is_empty()) { current.refresh_token = r.to_owned(); }
        current.access_token = Some(access.clone());
        current.expires_at = (self.clock)().saturating_add(expires);
        self.save(&current)?;
        Ok(access)
    }

    /// Revokes the grant at Google when it can (best effort) and deletes the entry.
    pub fn forget(&self) -> Result<(), GmailError> {
        let old = {
            let _lock = self.lock()?;
            let old = self.load()?;
            self.store.delete(KEY).map_err(|_| GmailError::Store)?;
            old
        };
        if let Some(old) = old { self.revoke(old); }
        Ok(())
    }
}

fn access_of(v: &serde_json::Value) -> Result<(String, u64), GmailError> {
    let access = v["access_token"].as_str().filter(|s| !s.is_empty()).ok_or(GmailError::Invalid)?;
    let expires = v["expires_in"].as_u64().filter(|n| *n > 0).ok_or(GmailError::Invalid)?;
    Ok((access.to_owned(), expires))
}

/// The authorization code of a callback carrying exactly one `state` equal to this flow's.
/// `None`: not this flow's callback (keep waiting). `Some(Err)`: the user declined or the
/// callback carries no single code; the flow ends.
fn callback(query: &str, state: &CsrfToken) -> Option<Result<String, GmailError>> {
    let pairs: Vec<(String, String)> = oauth2::url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
    let one = |k: &str| { let mut it = pairs.iter().filter(|(a, _)| a == k); match (it.next(), it.next()) { (Some((_, v)), None) => Some(v.as_str()), (None, _) => Some(""), _ => None } };
    let given = one("state")?;
    if given.is_empty() || !same_secret(given, state.secret()) { return None; }
    let (code, error) = (one("code")?, one("error")?);
    if !error.is_empty() { return Some(Err(GmailError::Denied)); }
    if code.is_empty() { return Some(Err(GmailError::State)); }
    Some(Ok(code.to_owned()))
}

fn same_secret(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

/// Reads one bounded request head (32 KiB: a browser sends its cookies for 127.0.0.1; 2 s) and returns the target of `GET <target> HTTP/1.x`.
fn read_request_target(stream: &mut std::net::TcpStream) -> Option<String> {
    use std::io::Read;
    stream.set_nonblocking(false).ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 512];
    while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
        if bytes.len() >= HEAD_LIMIT { return None; }
        let left = deadline.checked_duration_since(std::time::Instant::now())?;
        stream.set_read_timeout(Some(left)).ok()?;
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 { return None; }
        bytes.extend_from_slice(&chunk[..n]);
    }
    let text = std::str::from_utf8(&bytes).ok()?;
    let mut fields = text.lines().next()?.split_whitespace();
    if fields.next() != Some("GET") { return None; }
    let target = fields.next()?.to_owned();
    if !fields.next().is_some_and(|v| v == "HTTP/1.1" || v == "HTTP/1.0") || fields.next().is_some() { return None; }
    Some(target)
}

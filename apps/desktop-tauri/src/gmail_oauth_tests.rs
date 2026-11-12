use super::*;
use crate::provider_oauth::{OauthError, TokenHttp, TokenReply};
use crate::secrets::{SecretStore, StoreError};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const ID: &str = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";
const SECRET: &str = "GOCSPX-abcDEF_123-xyz";

#[derive(Default)]
struct Store { map: Mutex<BTreeMap<String, String>>, down: bool }
impl SecretStore for Store {
    fn read(&self, key: &str) -> Result<Option<String>, StoreError> {
        if self.down { return Err(StoreError::Unavailable); }
        Ok(self.map.lock().unwrap().get(key).cloned())
    }
    fn write(&self, key: &str, value: &str) -> Result<(), StoreError> {
        if self.down { return Err(StoreError::Unavailable); }
        self.map.lock().unwrap().insert(key.into(), value.into()); Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), StoreError> {
        if self.down { return Err(StoreError::Unavailable); }
        self.map.lock().unwrap().remove(key); Ok(())
    }
}
impl Store { fn raw(&self) -> Option<serde_json::Value> { self.map.lock().unwrap().get(KEY).map(|s| serde_json::from_str(s).unwrap()) } }

/// Replays queued replies in order and records every POST (url + form).
#[derive(Default)]
struct Http { replies: Mutex<Vec<Result<TokenReply, OauthError>>>, calls: Mutex<Vec<(String, Vec<(String, String)>)>> }
impl Http {
    fn with(replies: Vec<Result<(u16, serde_json::Value), OauthError>>) -> Self {
        Self { replies: Mutex::new(replies.into_iter().rev().map(|r| r.map(|(status, v)| TokenReply { status, body: v.to_string().into_bytes() })).collect()), ..Default::default() }
    }
    fn calls(&self) -> Vec<(String, Vec<(String, String)>)> { self.calls.lock().unwrap().clone() }
}
impl TokenHttp for Http {
    fn post(&self, url: &str, form: &[(String, String)]) -> Result<TokenReply, OauthError> {
        self.calls.lock().unwrap().push((url.into(), form.to_vec()));
        self.replies.lock().unwrap().pop().unwrap_or(Err(OauthError::Transport))
    }
}
fn field<'a>(form: &'a [(String, String)], k: &str) -> Option<&'a str> { form.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str()) }
fn granted(access: &str, refresh: Option<&str>) -> (u16, serde_json::Value) {
    let mut v = serde_json::json!({"access_token": access, "expires_in": 3599, "scope": SCOPE, "token_type": "Bearer"});
    if let Some(r) = refresh { v["refresh_token"] = r.into(); }
    (200, v)
}

struct Rig { store: Store, http: Http, now: AtomicU64 }
impl Rig {
    fn new(http: Http) -> Self { Self { store: Store::default(), http, now: AtomicU64::new(1_000_000) } }
    fn run<T>(&self, f: impl FnOnce(&GmailAuth<'_>) -> T) -> T {
        let clock = || self.now.load(Ordering::SeqCst);
        f(&GmailAuth::new(&self.store, &self.http, &clock))
    }
    fn client(&self, secret: Option<&str>) { self.run(|a| a.set_client(&parse_client(ID, secret).unwrap())).unwrap(); }
}
fn query(url: &str) -> BTreeMap<String, String> { oauth2::url::Url::parse(url).unwrap().query_pairs().into_owned().collect() }
/// Plays the browser: sends one raw request to the loopback redirect and returns the raw answer.
fn browser(redirect: &str, path: &str) -> std::thread::JoinHandle<String> {
    let addr = redirect.trim_start_matches("http://").to_owned();
    let path = path.to_owned();
    std::thread::spawn(move || {
        let mut s = std::net::TcpStream::connect(addr).unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes()).unwrap();
        let mut out = String::new(); let _ = s.read_to_string(&mut out); out
    })
}
fn poll_until(rig: &Rig, pending: &mut Pending) -> Result<bool, GmailError> {
    for _ in 0..400 {
        match rig.run(|a| a.complete_loopback(pending)) { Ok(false) => std::thread::sleep(std::time::Duration::from_millis(5)), other => return other }
    }
    Ok(false)
}
fn sign_in(rig: &Rig, reply: (u16, serde_json::Value)) -> Result<bool, GmailError> {
    rig.http.replies.lock().unwrap().insert(0, Ok(TokenReply { status: reply.0, body: reply.1.to_string().into_bytes() }));
    let begun = rig.run(|a| a.begin()).unwrap();
    let q = query(&begun.auth_url);
    let mut pending = begun.pending;
    let b = browser(&q["redirect_uri"], &format!("/?state={}&code=4%2Fcode&scope={}", q["state"], SCOPE));
    let r = poll_until(rig, &mut pending); b.join().unwrap(); r
}

#[test]
fn a_client_id_must_look_like_a_google_desktop_client_and_the_secret_is_optional() {
    assert!(parse_client(ID, None).is_some());
    assert!(parse_client(&format!("  {ID}\n"), Some(" GOCSPX-x ")).is_some(), "pasted whitespace is trimmed");
    assert!(parse_client(ID, Some("")).unwrap().secret.is_none(), "an empty secret means none");
    for bad in ["", "abc", "123.apps.googleusercontent.com.evil.com", "a b.apps.googleusercontent.com", "x&y=1.apps.googleusercontent.com"] {
        assert!(parse_client(bad, None).is_none(), "{bad}");
    }
    assert!(parse_client(&format!("{}{ID}", "a".repeat(300)), None).is_none(), "too long");
    assert!(parse_client(ID, Some("bad secret")).is_none());
    assert!(parse_client(ID, Some(&"s".repeat(200))).is_none());
}

#[test]
fn the_gmail_credentials_live_in_an_internal_key_the_page_can_never_reach() {
    assert!(!crate::secrets::KNOWN_KEYS.contains(&KEY));
    assert!(crate::secrets::INTERNAL_KEYS.contains(&KEY));
    assert!(crate::secrets::parse_command(&serde_json::json!({"action":"present","key":KEY})).is_none());
    assert!(crate::secrets::parse_command(&serde_json::json!({"action":"set","key":KEY,"value":"v"})).is_none());
}

#[test]
fn status_goes_from_no_client_to_signed_out_to_connected() {
    let rig = Rig::new(Http::default());
    assert_eq!(rig.run(|a| a.status()), Ok(Status::NoClient));
    rig.client(None);
    assert_eq!(rig.run(|a| a.status()), Ok(Status::SignedOut));
    assert_eq!(sign_in(&rig, granted("ya29.a", Some("1//r"))), Ok(true));
    assert_eq!(rig.run(|a| a.status()), Ok(Status::Connected));
}

#[test]
fn begin_without_a_client_id_asks_for_one() {
    let rig = Rig::new(Http::default());
    assert_eq!(rig.run(|a| a.begin()).err(), Some(GmailError::NoClient));
}

#[test]
fn the_authorization_url_is_googles_with_pkce_s256_a_random_loopback_port_and_only_the_read_only_scope() {
    let rig = Rig::new(Http::default());
    rig.client(Some(SECRET));
    let begun = rig.run(|a| a.begin()).unwrap();
    let url = oauth2::url::Url::parse(&begun.auth_url).unwrap();
    assert_eq!(format!("{}://{}{}", url.scheme(), url.host_str().unwrap(), url.path()), AUTH_URL);
    let q = query(&begun.auth_url);
    assert_eq!(q["client_id"], ID);
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["scope"], "https://www.googleapis.com/auth/gmail.readonly");
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["code_challenge"].len(), 43);
    assert!(q["state"].len() >= 16);
    let redirect = oauth2::url::Url::parse(&q["redirect_uri"]).unwrap();
    assert_eq!(redirect.host_str(), Some("127.0.0.1"));
    assert_ne!(redirect.port(), Some(0));
    assert!(!q.contains_key("client_secret"), "the secret never travels in the browser URL");
    let other = rig.run(|a| a.begin()).unwrap();
    assert_ne!(query(&other.auth_url)["state"], q["state"]);
    assert_ne!(query(&other.auth_url)["code_challenge"], q["code_challenge"]);
}

#[test]
fn without_a_browser_visit_the_flow_keeps_waiting() {
    let rig = Rig::new(Http::default());
    rig.client(None);
    let mut pending = rig.run(|a| a.begin()).unwrap().pending;
    assert_eq!(rig.run(|a| a.complete_loopback(&mut pending)), Ok(false));
    assert!(rig.http.calls().is_empty());
}

#[test]
fn the_browser_callback_exchanges_the_code_with_the_verifier_and_stores_the_tokens() {
    use base64::Engine;
    use sha2::Digest;
    let rig = Rig::new(Http::with(vec![Ok(granted("ya29.access", Some("1//refresh")))]));
    rig.client(Some(SECRET));
    let begun = rig.run(|a| a.begin()).unwrap();
    let q = query(&begun.auth_url);
    let mut pending = begun.pending;
    let b = browser(&q["redirect_uri"], &format!("/?state={}&code=4%2Fthe-code&scope={}", q["state"], SCOPE));
    assert_eq!(poll_until(&rig, &mut pending), Ok(true));
    let page = b.join().unwrap();
    assert!(page.starts_with("HTTP/1.1 200"), "{page}");
    assert!(page.contains("Koda"));
    let calls = rig.http.calls();
    assert_eq!(calls.len(), 1);
    let (url, form) = &calls[0];
    assert_eq!(url, TOKEN_URL);
    assert_eq!(field(form, "grant_type"), Some("authorization_code"));
    assert_eq!(field(form, "code"), Some("4/the-code"));
    assert_eq!(field(form, "client_id"), Some(ID));
    assert_eq!(field(form, "client_secret"), Some(SECRET));
    assert_eq!(field(form, "redirect_uri"), Some(q["redirect_uri"].as_str()));
    let verifier = field(form, "code_verifier").unwrap();
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
    assert_eq!(challenge, q["code_challenge"], "the verifier matches the challenge sent to Google");
    let stored = rig.store.raw().unwrap();
    assert_eq!(stored["client_id"], ID);
    assert_eq!(stored["refresh_token"], "1//refresh");
    assert_eq!(stored["access_token"], "ya29.access");
    // used once: polling again does not reuse the pending authorization
    assert_eq!(rig.run(|a| a.complete_loopback(&mut pending)), Err(GmailError::Used));
}

#[test]
fn without_a_client_secret_the_exchange_sends_none() {
    let rig = Rig::new(Http::default());
    rig.client(None);
    assert_eq!(sign_in(&rig, granted("a", Some("r"))), Ok(true));
    assert_eq!(field(&rig.http.calls()[0].1, "client_secret"), None);
}

#[test]
fn a_callback_with_the_wrong_state_is_refused_and_nothing_is_stored() {
    let rig = Rig::new(Http::with(vec![Ok(granted("a", Some("r")))]));
    rig.client(None);
    let begun = rig.run(|a| a.begin()).unwrap();
    let q = query(&begun.auth_url);
    let mut pending = begun.pending;
    let b = browser(&q["redirect_uri"], "/?state=forged&code=x");
    assert_eq!(poll_until(&rig, &mut pending), Err(GmailError::State));
    assert!(b.join().unwrap().starts_with("HTTP/1.1 400"));
    assert!(rig.http.calls().is_empty(), "no exchange with a forged state");
    assert_eq!(rig.store.raw().unwrap()["refresh_token"], "");
    assert_eq!(rig.run(|a| a.complete_loopback(&mut pending)), Err(GmailError::Used));
}

#[test]
fn a_user_who_denies_access_gets_denied_and_nothing_is_stored() {
    let rig = Rig::new(Http::default());
    rig.client(None);
    let begun = rig.run(|a| a.begin()).unwrap();
    let q = query(&begun.auth_url);
    let mut pending = begun.pending;
    let b = browser(&q["redirect_uri"], &format!("/?error=access_denied&state={}", q["state"]));
    assert_eq!(poll_until(&rig, &mut pending), Err(GmailError::Denied));
    b.join().unwrap();
    assert!(rig.http.calls().is_empty());
    assert_eq!(rig.run(|a| a.status()), Ok(Status::SignedOut));
}

#[test]
fn a_stray_browser_request_such_as_the_favicon_does_not_end_the_flow() {
    let rig = Rig::new(Http::with(vec![Ok(granted("a", Some("r")))]));
    rig.client(None);
    let begun = rig.run(|a| a.begin()).unwrap();
    let q = query(&begun.auth_url);
    let mut pending = begun.pending;
    let b = browser(&q["redirect_uri"], "/favicon.ico");
    for _ in 0..100 { if rig.run(|a| a.complete_loopback(&mut pending)) != Ok(false) { panic!("stray request ended the flow"); } if b.is_finished() { break; } std::thread::sleep(std::time::Duration::from_millis(5)); }
    assert!(b.join().unwrap().starts_with("HTTP/1.1 404"));
    let b = browser(&q["redirect_uri"], &format!("/?state={}&code=c&scope={}", q["state"], SCOPE));
    assert_eq!(poll_until(&rig, &mut pending), Ok(true));
    b.join().unwrap();
}

#[test]
fn a_grant_without_the_gmail_scope_is_refused() {
    let rig = Rig::new(Http::default());
    rig.client(None);
    let (s, mut v) = granted("a", Some("r"));
    v["scope"] = "openid".into();
    assert_eq!(sign_in(&rig, (s, v)), Err(GmailError::ScopeMissing));
    assert_eq!(rig.run(|a| a.status()), Ok(Status::SignedOut));
}

#[test]
fn a_google_error_on_the_exchange_is_rejected_and_nothing_is_stored() {
    let rig = Rig::new(Http::default());
    rig.client(None);
    assert_eq!(sign_in(&rig, (400, serde_json::json!({"error":"invalid_client"}))), Err(GmailError::Rejected));
    assert_eq!(rig.run(|a| a.status()), Ok(Status::SignedOut));
}

#[test]
fn a_pending_authorization_expires_after_ten_minutes() {
    let rig = Rig::new(Http::default());
    rig.client(None);
    let mut pending = rig.run(|a| a.begin()).unwrap().pending;
    rig.now.fetch_add(600, Ordering::SeqCst);
    assert_eq!(rig.run(|a| a.complete_loopback(&mut pending)), Err(GmailError::Expired));
}

#[test]
fn a_fresh_access_token_is_reused_without_calling_google() {
    let rig = Rig::new(Http::default());
    rig.client(None);
    sign_in(&rig, granted("ya29.one", Some("1//r"))).unwrap();
    let before = rig.http.calls().len();
    assert_eq!(rig.run(|a| a.access_token(None)), Ok("ya29.one".into()));
    assert_eq!(rig.http.calls().len(), before);
}

#[test]
fn an_expiring_access_token_is_refreshed_with_the_users_client_and_kept_refresh_token() {
    let rig = Rig::new(Http::default());
    rig.client(Some(SECRET));
    sign_in(&rig, granted("ya29.one", Some("1//r"))).unwrap();
    rig.now.fetch_add(3599 - 30, Ordering::SeqCst);
    rig.http.replies.lock().unwrap().push(Ok(TokenReply { status: 200, body: granted("ya29.two", None).1.to_string().into_bytes() }));
    assert_eq!(rig.run(|a| a.access_token(None)), Ok("ya29.two".into()));
    let calls = rig.http.calls();
    let (url, form) = calls.last().unwrap();
    assert_eq!(url, TOKEN_URL);
    assert_eq!(field(form, "grant_type"), Some("refresh_token"));
    assert_eq!(field(form, "refresh_token"), Some("1//r"));
    assert_eq!(field(form, "client_id"), Some(ID));
    assert_eq!(field(form, "client_secret"), Some(SECRET));
    assert_eq!(rig.store.raw().unwrap()["refresh_token"], "1//r", "Google omits it on refresh: keep the old one");
    assert_eq!(rig.store.raw().unwrap()["access_token"], "ya29.two");
}

#[test]
fn a_token_the_api_rejected_is_refreshed_even_if_it_looks_fresh() {
    let rig = Rig::new(Http::default());
    rig.client(None);
    sign_in(&rig, granted("ya29.one", Some("1//r"))).unwrap();
    rig.http.replies.lock().unwrap().push(Ok(TokenReply { status: 200, body: granted("ya29.two", None).1.to_string().into_bytes() }));
    assert_eq!(rig.run(|a| a.access_token(Some("ya29.one"))), Ok("ya29.two".into()));
    // a stale rejection (another caller already refreshed) does not refresh again
    let before = rig.http.calls().len();
    assert_eq!(rig.run(|a| a.access_token(Some("ya29.one"))), Ok("ya29.two".into()));
    assert_eq!(rig.http.calls().len(), before);
}

#[test]
fn a_revoked_or_expired_refresh_token_asks_to_reconnect_and_keeps_the_client_id() {
    for error in ["invalid_grant", "invalid_client", "unauthorized_client"] {
        let rig = Rig::new(Http::default());
        rig.client(Some(SECRET));
        sign_in(&rig, granted("ya29.one", Some("1//r"))).unwrap();
        rig.now.fetch_add(4000, Ordering::SeqCst);
        rig.http.replies.lock().unwrap().push(Ok(TokenReply { status: 400, body: serde_json::json!({"error": error}).to_string().into_bytes() }));
        assert_eq!(rig.run(|a| a.access_token(None)), Err(GmailError::NeedsSignIn), "{error}");
        assert_eq!(rig.run(|a| a.status()), Ok(Status::Reconnect), "{error}");
        let stored = rig.store.raw().unwrap();
        assert_eq!(stored["refresh_token"], "");
        assert!(stored["access_token"].is_null());
        assert_eq!(stored["client_id"], ID);
        assert_eq!(rig.run(|a| a.access_token(None)), Err(GmailError::NeedsSignIn));
    }
}

#[test]
fn a_network_failure_on_refresh_keeps_the_connection() {
    let rig = Rig::new(Http::default());
    rig.client(None);
    sign_in(&rig, granted("ya29.one", Some("1//r"))).unwrap();
    rig.now.fetch_add(4000, Ordering::SeqCst);
    rig.http.replies.lock().unwrap().push(Err(OauthError::Transport));
    assert_eq!(rig.run(|a| a.access_token(None)), Err(GmailError::Transport));
    assert_eq!(rig.run(|a| a.status()), Ok(Status::Connected));
    rig.http.replies.lock().unwrap().push(Ok(TokenReply { status: 503, body: b"{}".to_vec() }));
    assert_eq!(rig.run(|a| a.access_token(None)), Err(GmailError::Transport));
    assert_eq!(rig.store.raw().unwrap()["refresh_token"], "1//r");
}

#[test]
fn access_token_without_a_connection_asks_to_sign_in() {
    let rig = Rig::new(Http::default());
    assert_eq!(rig.run(|a| a.access_token(None)), Err(GmailError::NoClient));
    rig.client(None);
    assert_eq!(rig.run(|a| a.access_token(None)), Err(GmailError::NeedsSignIn));
    assert!(rig.http.calls().is_empty());
}

#[test]
fn changing_the_client_id_drops_the_old_tokens() {
    let rig = Rig::new(Http::default());
    rig.client(None);
    sign_in(&rig, granted("ya29.one", Some("1//r"))).unwrap();
    let other = ID.replacen("123456789012", "999999999999", 1);
    rig.run(|a| a.set_client(&parse_client(&other, None).unwrap())).unwrap();
    assert_eq!(rig.run(|a| a.status()), Ok(Status::SignedOut));
    assert_eq!(rig.store.raw().unwrap()["refresh_token"], "");
    // the same client again keeps the connection
    rig.client(None);
    sign_in(&rig, granted("ya29.one", Some("1//r"))).unwrap();
    rig.client(None);
    assert_eq!(rig.run(|a| a.status()), Ok(Status::Connected));
}

#[test]
fn forgetting_revokes_the_refresh_token_at_google_and_deletes_everything() {
    let rig = Rig::new(Http::default());
    rig.client(Some(SECRET));
    sign_in(&rig, granted("ya29.one", Some("1//r"))).unwrap();
    rig.http.replies.lock().unwrap().push(Ok(TokenReply { status: 200, body: b"{}".to_vec() }));
    assert_eq!(rig.run(|a| a.forget()), Ok(()));
    let calls = rig.http.calls();
    let (url, form) = calls.last().unwrap();
    assert_eq!(url, REVOKE_URL);
    assert_eq!(field(form, "token"), Some("1//r"));
    assert!(rig.store.raw().is_none());
    assert_eq!(rig.run(|a| a.status()), Ok(Status::NoClient));
}

#[test]
fn forgetting_deletes_locally_even_when_google_cannot_be_reached() {
    let rig = Rig::new(Http::default());
    rig.client(None);
    sign_in(&rig, granted("a", Some("r"))).unwrap();
    rig.http.replies.lock().unwrap().push(Err(OauthError::Transport));
    assert_eq!(rig.run(|a| a.forget()), Ok(()));
    assert!(rig.store.raw().is_none());
    // nothing to revoke: no call at all
    let before = rig.http.calls().len();
    assert_eq!(rig.run(|a| a.forget()), Ok(()));
    assert_eq!(rig.http.calls().len(), before);
}

#[test]
fn a_locked_keychain_is_reported_and_never_treated_as_signed_out() {
    let rig = Rig { store: Store { down: true, ..Default::default() }, http: Http::default(), now: AtomicU64::new(0) };
    assert_eq!(rig.run(|a| a.status()), Err(GmailError::Store));
    assert_eq!(rig.run(|a| a.set_client(&parse_client(ID, None).unwrap())), Err(GmailError::Store));
    assert_eq!(rig.run(|a| a.access_token(None)), Err(GmailError::Store));
}

#[test]
fn debug_output_never_carries_authorization_material() {
    let rig = Rig::new(Http::default());
    rig.client(Some(SECRET));
    let begun = rig.run(|a| a.begin()).unwrap();
    let text = format!("{:?} {:?} {:?}", parse_client(ID, Some(SECRET)).unwrap(), begun, begun.pending);
    assert!(!text.contains(SECRET) && !text.contains(&query(&begun.auth_url)["state"]), "{text}");
}

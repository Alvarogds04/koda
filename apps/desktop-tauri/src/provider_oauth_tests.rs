use super::*;
use crate::secrets::{SecretStore, StoreError};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
struct Memory(Mutex<HashMap<String, String>>);
impl SecretStore for Memory {
    fn read(&self, k: &str) -> Result<Option<String>, StoreError> { Ok(self.0.lock().unwrap().get(k).cloned()) }
    fn write(&self, k: &str, v: &str) -> Result<(), StoreError> { self.0.lock().unwrap().insert(k.into(), v.into()); Ok(()) }
    fn delete(&self, k: &str) -> Result<(), StoreError> { self.0.lock().unwrap().remove(k); Ok(()) }
}
#[test]
fn pkce_state_ttl_and_single_use() {
    let store = Memory::default();
    let http = Fake::new();
    let clock = || 100;
    let flow = OAuth::new(&store, &http, &clock);
    let b = flow.begin(Provider::Claude).unwrap();
    let u = oauth2::url::Url::parse(&b.auth_url).unwrap();
    let params: HashMap<_, _> = u.query_pairs().into_owned().collect();
    assert_eq!(params["code_challenge"], oauth2::PkceCodeChallenge::from_code_verifier_sha256(b.pending.verifier.as_ref().unwrap()).as_str());
    assert_eq!(params["code_challenge_method"], "S256");
    let mut p = b.pending;
    assert_eq!(flow.complete(&mut p, "secret-code#wrong"), Err(OauthError::State));
    assert_eq!(flow.complete(&mut p, "secret-code#wrong"), Err(OauthError::Used));
    let mut p = flow.begin(Provider::Claude).unwrap().pending;
    p.created_at = 0;
    let late = || 601;
    assert_eq!(OAuth::new(&store, &http, &late).complete(&mut p, "x#y"), Err(OauthError::Expired));
}
struct Fake(Mutex<Vec<(u16, String)>>);
impl Fake { fn new() -> Self { Self(Mutex::new(vec![])) } }
impl TokenHttp for Fake {
    fn post(&self, _: &str, _: &[(String, String)]) -> Result<TokenReply, OauthError> {
        let (status, body) = self.0.lock().unwrap().remove(0);
        Ok(TokenReply { status, body: body.into_bytes() })
    }
}
#[test]
fn exchange_refresh_rotation_and_sign_out() {
    let store = Memory::default(); let http = Fake::new(); let clock = || 100;
    http.0.lock().unwrap().push((200, r#"{"access_token":"access-secret","refresh_token":"refresh-secret","expires_in":70,"token_type":"Bearer"}"#.into()));
    let flow = OAuth::new(&store, &http, &clock);
    let mut p = flow.begin(Provider::Claude).unwrap().pending;
    let callback = format!("code-secret#{}", p.state.secret());
    flow.complete(&mut p, &callback).unwrap();
    assert_eq!(flow.complete(&mut p, &callback), Err(OauthError::Used));
    assert_eq!(flow.access_token(Provider::Claude, 100).unwrap(), "access-secret");
    assert_eq!(flow.status(Provider::Claude).unwrap(), Status::Present);
    http.0.lock().unwrap().push((200, r#"{"access_token":"new-access","refresh_token":"rotated","expires_in":3600,"token_type":"Bearer"}"#.into()));
    assert_eq!(flow.access_token(Provider::Claude, 111).unwrap(), "new-access");
    assert!(store.read("claude-oauth").unwrap().unwrap().contains("rotated"));
    flow.sign_out(Provider::Claude).unwrap();
    assert_eq!(flow.status(Provider::Claude).unwrap(), Status::Absent);
}
#[test]
fn oauth_webview_cannot_set() {
    for key in ["claude-oauth", "chatgpt-oauth"] {
        assert!(crate::secrets::parse_command(&serde_json::json!({"action":"set","key":key,"value":"x"})).is_none());
        assert!(crate::secrets::parse_command(&serde_json::json!({"action":"present","key":key})).is_some());
        assert!(crate::secrets::parse_command(&serde_json::json!({"action":"clear","key":key})).is_some());
    }
}
#[test]
fn refresh_failures_preserve_or_mark_credentials() {
    for (status, body, expired) in [(500, "server secret", false), (400, r#"{"error":"invalid_grant"}"#, true), (401, r#"{"error":"unauthorized"}"#, false)] {
        let store = Memory::default(); let http = Fake::new(); let clock = || 100;
        store.write("claude-oauth", r#"{"refresh_token":"retained-secret","access_token":"old-secret","expires_at":120,"account_id":null}"#).unwrap();
        http.0.lock().unwrap().push((status, body.into()));
        let flow = OAuth::new(&store, &http, &clock);
        let error = flow.access_token(Provider::Claude, 100).unwrap_err();
        assert!(!format!("{error:?} {error}").contains("secret"));
        let stored = store.read("claude-oauth").unwrap().unwrap();
        if expired {
            assert_eq!(flow.status(Provider::Claude).unwrap(), Status::Expired);
            assert_eq!(flow.access_token(Provider::Claude, 100), Err(OauthError::NeedsSignIn));
            assert!(!stored.contains("retained-secret"));
        } else { assert!(stored.contains("retained-secret")); }
    }
}
#[test]
fn concurrent_refresh_is_single_flight() {
    let store = Memory::default(); let http = Fake::new(); let clock = || 100;
    store.write("claude-oauth", r#"{"refresh_token":"old-refresh","access_token":"old","expires_at":120,"account_id":null}"#).unwrap();
    http.0.lock().unwrap().push((200, r#"{"access_token":"new","refresh_token":"rotated","expires_in":3600,"token_type":"Bearer"}"#.into()));
    let flow = OAuth::new(&store, &http, &clock);
    std::thread::scope(|s| {
        let threads: Vec<_> = (0..12).map(|_| s.spawn(|| flow.access_token(Provider::Claude, 100).unwrap())).collect();
        for t in threads { assert_eq!(t.join().unwrap(), "new"); }
    });
    assert!(http.0.lock().unwrap().is_empty());
    assert!(store.read("claude-oauth").unwrap().unwrap().contains("rotated"));
}
#[test]
fn loopback_exchange_uses_test_client_and_never_exposes_secrets() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/token", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let mut bytes = vec![]; let mut b = [0; 4096];
        loop {
            let n = stream.read(&mut b).unwrap(); assert!(n > 0); bytes.extend_from_slice(&b[..n]);
            if let Some(p) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&bytes[..p]);
                let len: usize = head.lines().find_map(|s| s.to_ascii_lowercase().strip_prefix("content-length:").map(|s| s.trim().parse().unwrap())).unwrap();
                if bytes.len() >= p + 4 + len { break; }
            }
        }
        let body = r#"{"access_token":"access-secret","refresh_token":"refresh-secret","expires_in":3600,"token_type":"Bearer"}"#;
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        String::from_utf8(bytes).unwrap()
    });
    struct LocalHttp(String);
    impl TokenHttp for LocalHttp {
        fn post(&self, _: &str, form: &[(String,String)]) -> Result<TokenReply, OauthError> { token_post(&self.0, form) }
    }
    let store = Memory::default(); let clock = || 100; let http = LocalHttp(url);
    let mut config = PROVIDERS;
    config[0].client_id = "test-client-id";
    let flow = OAuth::with_configs(&store, &http, &clock, &config);
    let begun = flow.begin(Provider::Claude).unwrap();
    assert!(!format!("{begun:?}").contains(begun.pending.state.secret()));
    let mut pending = begun.pending;
    let callback = format!("code-secret#{}", pending.state.secret());
    flow.complete(&mut pending, &callback).unwrap();
    let request = server.join().unwrap();
    assert!(request.contains("client_id=test-client-id")); assert!(request.contains("code_verifier="));
    assert!(store.read("claude-oauth").unwrap().unwrap().contains("access-secret"));
}
#[test]
fn chatgpt_loopback_callback_and_port_busy() {
    use std::io::{Read, Write};
    use base64::Engine;
    let store = Memory::default(); let http = Fake::new(); let clock = || 100;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"https://api.openai.com/auth":{"chatgpt_account_id":"account-secret"}}"#);
    http.0.lock().unwrap().push((200, serde_json::json!({"access_token":"access-secret","refresh_token":"refresh-secret","expires_in":3600,"token_type":"Bearer","id_token":format!("e30.{payload}.sig")}).to_string()));
    let mut config = PROVIDERS; config[1].client_id = "test-codex";
    let flow = OAuth::with_configs(&store, &http, &clock, &config).with_loopback("127.0.0.1:0".parse().unwrap());
    let mut pending = flow.begin(Provider::Chatgpt).unwrap().pending;
    let address = pending.listener.as_ref().unwrap().local_addr().unwrap();
    let occupied = OAuth::new(&store, &http, &clock).with_loopback(address);
    assert_eq!(occupied.begin(Provider::Chatgpt).unwrap_err(), OauthError::PortBusy);
    assert!(!flow.complete_loopback(&mut pending).unwrap());
    let state = pending.state.secret().clone();
    let browser = std::thread::spawn(move || {
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        write!(stream, "GET /auth/callback?code=code-secret&state={state} HTTP/1.1\r\nHost: localhost:1455\r\n\r\n").unwrap();
        let mut response = String::new(); stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200")); assert!(!response.contains("code-secret"));
    });
    let started = std::time::Instant::now();
    while !flow.complete_loopback(&mut pending).unwrap() { assert!(started.elapsed().as_secs() < 5); std::thread::sleep(std::time::Duration::from_millis(5)); }
    browser.join().unwrap();
    assert_eq!(flow.account_id(Provider::Chatgpt).unwrap(), Some("account-secret".into()));
    assert_eq!(flow.complete_loopback(&mut pending), Err(OauthError::Used));
}
#[test]
fn token_transport_cancellation_and_deadline() {
    use std::io::{Read, Write};
    for cancel_early in [true, false] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); let url = format!("http://{}/token", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut b = [0; 4096]; let _ = stream.read(&mut b);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n");
            // The client must close the body on cancellation/deadline, not wait for 30 s.
            match stream.read(&mut b) { Ok(0) | Err(_) => {}, Ok(_) => {} }
        });
        let started = std::time::Instant::now();
        let cancelled = || cancel_early && started.elapsed() >= std::time::Duration::from_millis(20);
        let reply = token_post_controlled(&url, &[("client_id".into(), "test-client".into())], &cancelled, started + std::time::Duration::from_millis(100));
        assert!(matches!(reply, Err(OauthError::Transport)));
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        server.join().unwrap();
    }
}
#[test]
fn injected_loopback_listeners_are_independent() {
    let store = Memory::default(); let http = Fake::new(); let clock = || 100;
    let production = OAuth::new(&store, &http, &clock);
    assert_eq!(production.loopback, "127.0.0.1:1455".parse().unwrap());
    let flow = production.with_loopback("127.0.0.1:0".parse().unwrap());
    let first = flow.begin(Provider::Chatgpt).unwrap();
    let second = flow.controlled(&|| false, std::time::Instant::now() + std::time::Duration::from_secs(5)).begin(Provider::Chatgpt).unwrap();
    let a = first.pending.listener.as_ref().unwrap().local_addr().unwrap();
    let b = second.pending.listener.as_ref().unwrap().local_addr().unwrap();
    assert!(a.ip().is_loopback()); assert!(b.ip().is_loopback()); assert_ne!(a, b);
    let url = oauth2::url::Url::parse(&first.auth_url).unwrap();
    assert_eq!(url.query_pairs().find(|(k, _)| k == "redirect_uri").unwrap().1, "http://localhost:1455/auth/callback");
}
#[test]
fn state_comparison_covers_mismatch_prefix_lengths_equal_and_empty() {
    for (a, b, equal) in [
        (b"abc".as_slice(), b"xyz".as_slice(), false),
        (b"same-prefix-a", b"same-prefix-b", false),
        (b"abc", b"abcd", false), (b"abcd", b"abc", false),
        (b"abc", b"abc", true), (b"", b"", true),
        (b"", b"a", false), (b"a", b"", false),
    ] { assert_eq!(state_equal(a, b), equal); }
}
fn invalid_loopback_consumes_flow(request: Option<Vec<u8>>) {
    use std::io::{Read, Write};
    let store = Memory::default(); let http = Fake::new(); let clock = || 100;
    let flow = OAuth::new(&store, &http, &clock).with_loopback("127.0.0.1:0".parse().unwrap());
    let mut pending = flow.begin(Provider::Chatgpt).unwrap().pending;
    let address = pending.listener.as_ref().unwrap().local_addr().unwrap();
    assert_eq!(address.ip(), std::net::Ipv4Addr::LOCALHOST);
    // Connect before polling so the test does not depend on scheduling.
    let mut browser = std::net::TcpStream::connect(address).unwrap();
    browser.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
    if let Some(bytes) = request { browser.write_all(&bytes).unwrap(); }
    let start = std::time::Instant::now();
    assert!(flow.complete_loopback(&mut pending).is_err());
    assert!(start.elapsed() < std::time::Duration::from_secs(5));
    assert!(pending.listener.is_none()); assert!(pending.verifier.is_none());
    assert_eq!(flow.complete_loopback(&mut pending), Err(OauthError::Used));
    assert_eq!(flow.complete(&mut pending, "http://localhost:1455/auth/callback?code=x&state=x"), Err(OauthError::Used));
    let mut response = Vec::new();
    // Oversized unread headers can cause a TCP reset after the 400; close is allowed.
    let _ = browser.read_to_end(&mut response);
    assert!(response.is_empty() || response.starts_with(b"HTTP/1.1 400"));
    assert!(store.0.lock().unwrap().is_empty());
    assert!(http.0.lock().unwrap().is_empty(), "Fake panics if a token exchange was attempted");
}
#[test]
fn malformed_loopback_request_consumes_flow() {
    invalid_loopback_consumes_flow(Some(b"GET /auth/callback?code=x&state=x HTTP/1.1 extra\r\n\r\n".to_vec()));
}
#[test]
fn oversized_loopback_headers_consume_flow() {
    let mut bytes = b"GET /auth/callback?code=x&state=x HTTP/1.1\r\nX-Large: ".to_vec();
    bytes.extend(vec![b'x'; 9000]); bytes.extend(b"\r\n\r\n");
    invalid_loopback_consumes_flow(Some(bytes));
}
#[test]
fn silent_loopback_timeout_consumes_flow() { invalid_loopback_consumes_flow(None); }
#[test]
fn jwt_account_id() {
    use base64::Engine;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"https://api.openai.com/auth":{"chatgpt_account_id":"account"}}"#);
    assert_eq!(account_id(&format!("e30.{payload}.sig")), Some("account".into()));
    assert_eq!(account_id("bad"), None);
}

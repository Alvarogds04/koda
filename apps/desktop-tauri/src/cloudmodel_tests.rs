use super::*;
use crate::localmodel::DEFAULT_DEADLINES;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Credentials { refreshes: AtomicUsize, oauth: bool }
impl CredentialSource for Credentials {
    fn credential(&self, _: &ProfileRef) -> Result<Credential, crate::provider_oauth::OauthError> { Ok(Credential::new("secret-key".into(), self.oauth.then_some(Provider::Claude), Some("account".into()))) }
    fn refresh(&self, _: &ProfileRef, _: &str) -> Result<Credential, crate::provider_oauth::OauthError> { self.refreshes.fetch_add(1, Ordering::SeqCst); Ok(Credential::new("rotated-key".into(), Some(Provider::Claude), Some("account".into()))) }
}
fn server(responses: Vec<(u16, String)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let addr = listener.local_addr().unwrap();
    let thread = std::thread::spawn(move || {
        let mut requests = vec![];
        for (status, body) in responses {
            let (mut stream, _) = listener.accept().unwrap(); stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut raw = vec![]; let mut buf = [0; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap(); assert!(n > 0); raw.extend_from_slice(&buf[..n]);
                if let Some(p) = raw.windows(4).position(|b| b == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&raw[..p]);
                    let len: usize = head.lines().find_map(|s| s.to_ascii_lowercase().strip_prefix("content-length:").map(|s| s.trim().parse().unwrap())).unwrap_or(0);
                    if raw.len() >= p + 4 + len { break; }
                }
            }
            requests.push(String::from_utf8(raw).unwrap());
            write!(stream, "HTTP/1.1 {status} OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        requests
    }); (format!("http://{addr}"), thread)
}
fn target(kind: Kind, base: &str) -> CloudTarget {
    CloudTarget::loopback(kind, ProfileRef { profile_id: "test".into(), revision: 1, lane_id: "conversation".into() }, "test-model".into(), 100, base, &Credential::new("test-key".into(), None, None)).unwrap()
}
#[test]
fn untrusted_origins_are_rejected_before_credentials_leave() {
    let source = Credentials { refreshes: AtomicUsize::new(0), oauth: true };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    for kind in [Kind::AnthropicMessages, Kind::CodexResponses, Kind::OpenAiChat] {
        let result = stream_chat_test(&target(kind, &url), &source, &[], Deadlines { connect_ms: 100, idle_ms: 100, total_ms: 200 }, &Cancel::new(), &mut |_| {});
        assert!(matches!(result, Ended::Failed(_)));
        assert!(listener.accept().is_err(), "OAuth must not reach even a test loopback host");
    }
}
#[test]
fn construction_uses_only_canonical_provider_table() {
    let profile = target(Kind::OpenAiChat, "http://127.0.0.1:1").profile;
    for base in [
        "http://api.anthropic.com/v1", "https://evil.test/v1",
        "https://api.anthropic.com.evil.test/v1", "https://api.anthropic.com@evil.test/v1",
        "https://api.anthropic.com:443/v1", "https://api.anthropic.com:444/v1",
        "https://api.anthropic.com/v1/../evil", "https://api.anthropic.com/v1.evil",
        "https://api.anthropic.com./v1", "https://API.ANTHROPIC.COM/v1",
        "https://api.anthropic.com/v1?evil", "https://api.anthropic.com/v1#evil",
    ] {
        assert!(CloudTarget::fixed(CloudProvider::Anthropic, profile.clone(), "m".into(), 100, base).is_err(), "{base}");
    }
    for (provider, kind, base) in CLOUD_PROVIDERS {
        let t = CloudTarget::new(provider, profile.clone(), "m".into(), 100);
        assert_eq!(t.kind, kind); assert_eq!(t.base_url, base);
        assert_eq!(endpoint(&t, false).unwrap().host_str(), reqwest::Url::parse(base).unwrap().host_str());
    }
    let oauth = Credential::new("token".into(), Some(Provider::Claude), None);
    assert!(CloudTarget::loopback(Kind::AnthropicMessages, profile, "m".into(), 100, "http://127.0.0.1:1", &oauth).is_err());
}
#[test]
fn oauth_vendor_binding_is_not_interchangeable() {
    for provider in [Provider::Claude, Provider::Chatgpt] {
        let credential = Credential::new("token".into(), Some(provider), None);
        for (cloud, kind, base) in CLOUD_PROVIDERS {
            let url = reqwest::Url::parse(base).unwrap();
            assert_eq!(oauth_destination(kind, &credential, &url), matches!((provider, cloud), (Provider::Claude, CloudProvider::Anthropic) | (Provider::Chatgpt, CloudProvider::Codex)));
        }
    }
}
#[test]
fn cross_host_redirect_is_not_followed() {
    let destination = TcpListener::bind("127.0.0.1:0").unwrap();
    destination.set_nonblocking(true).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let location = format!("http://localhost:{}/stolen", destination.local_addr().unwrap().port());
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut raw = Vec::new(); let mut b = [0; 4096];
        loop {
            let n = stream.read(&mut b).unwrap(); assert!(n > 0); raw.extend_from_slice(&b[..n]);
            if let Some(p) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&raw[..p]);
                let len: usize = head.lines().find_map(|s| s.to_ascii_lowercase().strip_prefix("content-length:").map(|s| s.trim().parse().unwrap())).unwrap();
                if raw.len() >= p + 4 + len { break; }
            }
        }
        write!(stream, "HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    });
    let creds = Credentials { refreshes: AtomicUsize::new(0), oauth: false };
    let ended = stream_chat_test(&target(Kind::OpenAiChat, &base), &creds, &[], DEFAULT_DEADLINES, &Cancel::new(), &mut |_| {});
    assert!(matches!(ended, Ended::Failed(_))); thread.join().unwrap();
    assert!(destination.accept().is_err(), "redirect leaked credentials");
}
#[test]
fn subscription_protocols_have_required_bodies_and_decoder() {
    let profile = target(Kind::OpenAiChat, "http://127.0.0.1:1").profile;
    let claude = CloudTarget::new(CloudProvider::Anthropic, profile.clone(), "m".into(), 100);
    assert!(body(&claude, &[], true).unwrap().to_string().contains(CLAUDE_OAUTH_SYSTEM));
    let codex = CloudTarget::new(CloudProvider::Codex, profile, "m".into(), 100);
    assert_eq!(body(&codex, &[], true).unwrap()["store"], false);
    assert_eq!(endpoint(&codex, false).unwrap().as_str(), CODEX_URL);
    let mut decoder = Decoder::default();
    let items = decoder.push(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hola\"}\n\ndata: {\"type\":\"response.completed\"}\n\n", Kind::CodexResponses).unwrap();
    assert_eq!(items, vec![StreamItem::Content("hola".into()), StreamItem::Done]);
}
fn openai() -> String { "data: {\"choices\":[{\"delta\":{\"content\":\"hola\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n".into() }
#[test]
fn api_key_protocols_stream_done() {
    for (kind, body, path) in [
        (Kind::OpenAiChat, openai(), "/chat/completions"),
        (Kind::AnthropicMessages, "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hola\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n".into(), "/messages"),

    ] {
        let (url, thread) = server(vec![(200, body)]); let t = target(kind, &url);
        let creds = Credentials { refreshes: AtomicUsize::new(0), oauth: false }; let mut items = vec![];
        let result = stream_chat_test(&t, &creds, &[], DEFAULT_DEADLINES, &Cancel::new(), &mut |i| items.push(i.clone()));
        assert_eq!(result, Ended::Finished(Finish::Stop));
        assert!(items.contains(&StreamItem::Content("hola".into()))); assert!(items.contains(&StreamItem::Done));
        let request = thread.join().unwrap().remove(0);
        assert!(request.lines().next().unwrap().contains(path));
        if kind == Kind::AnthropicMessages { assert!(request.contains("x-api-key: secret-key")); assert!(!request.contains(CLAUDE_OAUTH_SYSTEM)); }
        if kind == Kind::CodexResponses { assert!(request.contains("chatgpt-account-id: account")); }
    }
}
#[test]
fn api_key_401_does_not_refresh() {
    let (url, thread) = server(vec![(401, "sensitive vendor body".into())]);
    let creds = Credentials { refreshes: AtomicUsize::new(0), oauth: false };
    let result = stream_chat_test(&target(Kind::OpenAiChat, &url), &creds, &[], DEFAULT_DEADLINES, &Cancel::new(), &mut |_| {});
    assert!(matches!(result, Ended::Failed(_)));
    assert_eq!(creds.refreshes.load(Ordering::SeqCst), 0);
    assert!(!format!("{result:?}").contains("sensitive"));
    assert_eq!(thread.join().unwrap().len(), 1);
}
#[test]
fn in_flight_cancel_and_idle_deadline_close_connection() {
    for do_cancel in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let url = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap(); stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = vec![]; let mut b = [0; 4096];
            loop {
                let n = stream.read(&mut b).unwrap(); assert!(n > 0); request.extend_from_slice(&b[..n]);
                if let Some(p) = request.windows(4).position(|b| b == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&request[..p]);
                    let len: usize = head.lines().find_map(|s| s.to_ascii_lowercase().strip_prefix("content-length:").map(|s| s.trim().parse().unwrap())).unwrap();
                    if request.len() >= p + 4 + len { break; }
                }
            }
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").unwrap();
            if do_cancel { write!(stream, "data: {{\"choices\":[{{\"delta\":{{\"content\":\"first\"}}}}]}}\n\n").unwrap(); }
            match stream.read(&mut b) { Ok(0) | Err(_) => {}, Ok(_) => panic!("unexpected retry") }
        });
        let creds = Credentials { refreshes: AtomicUsize::new(0), oauth: false }; let cancel = Cancel::new();
        let result = stream_chat_test(&target(Kind::OpenAiChat, &url), &creds, &[], Deadlines { connect_ms: 1000, idle_ms: 100, total_ms: 2000 }, &cancel, &mut |i| { if matches!(i, StreamItem::Content(_)) { cancel.cancel(); } });
        if do_cancel { assert_eq!(result, Ended::Cancelled); } else { assert!(matches!(result, Ended::Failed(_))); }
        thread.join().unwrap();
    }
}
#[test]
fn decoder_fragmentation_caps_and_output_bound() {
    let text = "data: {\"choices\":[{\"delta\":{\"content\":\"¡sí!\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n";
    let mut decoder = Decoder::default(); let mut items = vec![];
    for b in text.as_bytes() { items.extend(decoder.push(&[*b], Kind::OpenAiChat).unwrap()); }
    assert_eq!(items, vec![StreamItem::Content("¡sí!".into()), StreamItem::Done]);
    assert!(Decoder::default().push(&vec![b'x'; SSE_MAX_LINE + 1], Kind::OpenAiChat).is_err());
    let mut decoder = Decoder::default();
    for _ in 0..SSE_MAX_LINE / 8 { if decoder.push(b"data: x\n", Kind::OpenAiChat).is_err() { break; } }
    assert!(decoder.push(&vec![b'x'; SSE_MAX_LINE], Kind::OpenAiChat).is_err());
    let (url, thread) = server(vec![(200, openai())]); let mut t = target(Kind::OpenAiChat, &url); t.max_output = 1;
    let creds = Credentials { refreshes: AtomicUsize::new(0), oauth: false }; let mut output = String::new();
    let result = stream_chat_test(&t, &creds, &[], DEFAULT_DEADLINES, &Cancel::new(), &mut |i| { if let StreamItem::Content(s) = i { output.push_str(s); } });
    assert_eq!(output, "hola"); assert_eq!(result, Ended::Finished(Finish::Stop)); thread.join().unwrap();
    let (url, thread) = server(vec![(200, openai().replace("hola", "longer"))]); t = target(Kind::OpenAiChat, &url); t.max_output = 1;
    let result = stream_chat_test(&t, &creds, &[], DEFAULT_DEADLINES, &Cancel::new(), &mut |_| {});
    assert_eq!(result, Ended::Finished(Finish::Length)); thread.join().unwrap();
    let t = target(Kind::OpenAiChat, "http://127.0.0.1:1");
    assert!(matches!(stream_chat(&t, &creds, &[], DEFAULT_DEADLINES, &Cancel::new(), &mut |_| {}), Ended::Failed(_)));
    assert!(!format!("{t:?}").contains("secret-key"));
}
#[test]
fn credential_resolution_observes_cancellation_budget() {
    struct Waiting;
    impl CredentialSource for Waiting {
        fn credential(&self, _: &ProfileRef) -> Result<Credential, OauthError> { panic!("controlled seam required") }
        fn refresh(&self, _: &ProfileRef, _: &str) -> Result<Credential, OauthError> { unreachable!() }
        fn credential_controlled(&self, _: &ProfileRef, cancel: &Cancel, deadline: std::time::Instant) -> Result<Credential, OauthError> {
            while !cancel.is_cancelled() && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(1)); }
            Err(OauthError::Transport)
        }
    }
    let cancel = Cancel::new();
    std::thread::scope(|s| {
        s.spawn(|| { std::thread::sleep(Duration::from_millis(20)); cancel.cancel(); });
        let result = stream_chat_test(&target(Kind::OpenAiChat, "http://127.0.0.1:1"), &Waiting, &[], DEFAULT_DEADLINES, &cancel, &mut |_| {});
        assert_eq!(result, Ended::Cancelled);
    });
}
#[test]
fn keychain_oauth_adapter_refreshes_outside_streaming_runtime() {
    use crate::provider_oauth::{TokenHttp, TokenReply};
    use crate::secrets::{SecretStore, StoreError};
    struct Memory(std::sync::Mutex<Option<String>>);
    impl SecretStore for Memory {
        fn read(&self, _: &str) -> Result<Option<String>, StoreError> { Ok(self.0.lock().unwrap().clone()) }
        fn write(&self, _: &str, v: &str) -> Result<(), StoreError> { *self.0.lock().unwrap() = Some(v.into()); Ok(()) }
        fn delete(&self, _: &str) -> Result<(), StoreError> { *self.0.lock().unwrap() = None; Ok(()) }
    }
    struct Tokens;
    impl TokenHttp for Tokens {
        fn post(&self, _: &str, _: &[(String,String)]) -> Result<TokenReply, OauthError> {
            assert!(tokio::runtime::Handle::try_current().is_err(), "sync OAuth must not nest runtimes");
            Ok(TokenReply { status: 200, body: br#"{"access_token":"rotated-key","refresh_token":"rotated-refresh","expires_in":3600,"token_type":"Bearer"}"#.to_vec() })
        }
    }
    let store = Memory(std::sync::Mutex::new(Some(r#"{"refresh_token":"refresh-secret","access_token":"secret-key","expires_at":3600,"account_id":null}"#.into())));
    let clock = || 100; let oauth = OAuth::new(&store, &Tokens, &clock);
    let resolve = |_: &ProfileRef| Ok(CredentialRef::Oauth(Provider::Chatgpt));
    let source = KeychainCredentials { store: &store, oauth: &oauth, resolve: &resolve, clock: &clock };
    // Exercise the sync refresh seam directly: OAuth is never permitted on a fake host.
    let profile = target(Kind::OpenAiChat, "http://127.0.0.1:1").profile;
    assert_eq!(source.credential(&profile).unwrap().secret, "secret-key");
    assert_eq!(source.refresh(&profile, "secret-key").unwrap().secret, "rotated-key");
    assert!(store.read("chatgpt-oauth").unwrap().unwrap().contains("rotated-refresh"));
}
#[test]
fn malformed_and_cancel_are_safe() {
    let creds = Credentials { refreshes: AtomicUsize::new(0), oauth: false };
    let (url, thread) = server(vec![(200, "data: bad-secret\n\n".into())]);
    let result = stream_chat_test(&target(Kind::OpenAiChat, &url), &creds, &[], DEFAULT_DEADLINES, &Cancel::new(), &mut |_| {});
    assert!(matches!(result, Ended::Failed(_))); assert!(!format!("{result:?}").contains("bad-secret")); thread.join().unwrap();
    let cancel = Cancel::new(); cancel.cancel();
    assert_eq!(stream_chat_test(&target(Kind::OpenAiChat, "http://127.0.0.1:1"), &creds, &[], DEFAULT_DEADLINES, &cancel, &mut |_| {}), Ended::Cancelled);
    assert!(!format!("{:?}", creds.credential(&target(Kind::OpenAiChat, "http://127.0.0.1:1").profile).unwrap()).contains("secret-key"));
}

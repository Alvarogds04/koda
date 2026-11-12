//! Slice A: identity/token/link (pairing), admission bookkeeping and the TLS hello. The client side
//! of the tests pins the certificate by SHA-256 exactly as the phone does, over real TLS on loopback.
use super::{hub, ids, source};
use super::announce::{self, Advertise, Announcement, Record};
use super::pairing::{self, SecretStore};
use super::server::{self, Features, Shared, PROTOCOL};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn run<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}

// ---- the identifiers live in ONE module -----------------------------------------------------------

#[test]
fn the_wire_identifiers_are_in_one_module_and_user_text_says_abito() {
    assert_eq!(ids::SCHEME, "abito");
    assert_eq!(ids::MDNS_SERVICE, "_abito._tcp");
    assert_eq!(ids::CERT_CN, "Abito phone link");
    assert_eq!(ids::DEFAULT_NAME, "Abito");
    assert_eq!(ids::DEFAULT_PORT, 47821, "the contract's default port lives here too (§1)");
    // No other file spells an identifier: each takes it from ids.rs (the switch stays one line).
    for f in ["pairing.rs", "server.rs", "admission.rs", "link.rs", "announce.rs"] {
        let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/phone_link").join(f)).unwrap();
        let code: String = src.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        assert!(!code.contains("abito://") && !code.contains("_abito") && !code.contains("phone link\""), "{f} must take the identifiers from ids.rs");
    }
}

// ---- pairing --------------------------------------------------------------------------------------

#[derive(Default)]
struct Mem(std::sync::Mutex<std::collections::HashMap<String, String>>);
impl SecretStore for Mem {
    fn get(&self, key: &str) -> Option<String> {
        self.0.lock().unwrap().get(key).cloned()
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }
}

#[test]
fn the_certificate_is_made_once_kept_and_its_fingerprint_is_the_sha256_of_the_der() {
    let store = Mem::default();
    let a = pairing::load_or_create_identity(&store).unwrap();
    let b = pairing::load_or_create_identity(&store).unwrap();
    assert_eq!((a.cert_der.clone(), a.fingerprint.clone()), (b.cert_der, b.fingerprint.clone()));
    assert_eq!(a.fingerprint.len(), 64);
    assert_eq!(a.fingerprint, super::hex(ring::digest::digest(&ring::digest::SHA256, &a.cert_der).as_ref()));
    store.set(pairing::PRIVATE_KEY, "zz-not-hex").unwrap();
    let c = pairing::load_or_create_identity(&store).unwrap();
    assert_ne!(a.fingerprint, c.fingerprint, "a damaged key means a new identity, not a crash");
    assert_eq!(pairing::load_or_create_identity(&store).unwrap().fingerprint, c.fingerprint);
}

#[test]
fn tokens_are_valid_random_kept_and_replaced_on_demand() {
    let store = Mem::default();
    let a = pairing::token(&store).unwrap();
    assert!(pairing::is_token(&a));
    assert_eq!(pairing::token(&store).unwrap(), a);
    let b = pairing::new_token(&store).unwrap();
    assert_ne!(a, b);
    assert_eq!(pairing::token(&store).unwrap(), b);
    store.set(pairing::TOKEN_KEY, "short").unwrap();
    assert!(pairing::is_token(&pairing::token(&store).unwrap()), "a damaged token is replaced");
    assert!(pairing::is_token(&"a".repeat(16)) && pairing::is_token(&"A-_9".repeat(32)));
    for bad in ["a".repeat(15), "a".repeat(129), "aaaaaaaaaaaaaaa!".into(), "aaaaaaaaaaaaaaa ".into(), String::new()] {
        assert!(!pairing::is_token(&bad), "{bad:?}");
    }
}

#[test]
fn the_pairing_link_has_every_field_and_encodes_the_name() {
    let link = pairing::pairing_link("192.168.1.20", 47821, &"ab".repeat(32), "tok_en-1234567890abcd", "Léa's PC & co");
    assert_eq!(
        link,
        format!(
            "{}://pair?v=1&host=192.168.1.20&port=47821&fp={}&token=tok_en-1234567890abcd&name=L%C3%A9a%27s%20PC%20%26%20co",
            ids::SCHEME,
            "ab".repeat(32)
        )
    );
    let long = pairing::pairing_link("2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff", 47821, &"ab".repeat(32), &"t".repeat(128), &"é".repeat(48));
    assert!(long.len() < 2048, "the phone refuses 2,048 characters or more: {}", long.len());
    assert!(pairing::qr_svg(&long).is_some());
    let svg = pairing::qr_svg(&link).unwrap();
    assert!(svg.contains("<svg") && !svg.contains("script"));
}

// ---- admission ------------------------------------------------------------------------------------

mod admission {
    use super::super::admission::*;
    use std::net::IpAddr;
    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn one_address_holds_at_most_two_unauthenticated_connections() {
        let a = Admission::new();
        let t1 = a.admit(ip("192.168.1.50")).unwrap();
        let _t2 = a.admit(ip("192.168.1.50")).unwrap();
        assert!(a.admit(ip("192.168.1.50")).is_none());
        assert!(a.admit(ip("192.168.1.51")).is_some());
        drop(t1);
        assert!(a.admit(ip("192.168.1.50")).is_some());
        let b = Admission::new();
        let _x = b.admit(ip("192.168.1.50")).unwrap();
        let _y = b.admit(ip("::ffff:192.168.1.50")).unwrap();
        assert!(b.admit(ip("192.168.1.50")).is_none(), "the same address written two ways is one address");
    }

    #[test]
    fn strangers_share_a_pool_and_a_flood_cannot_lock_out_the_paired_phone() {
        let a = Admission::new();
        a.admit(ip("192.168.1.20")).unwrap().authenticated();
        assert!(a.knows(ip("192.168.1.20")));
        let flood: Vec<_> = (0..50).filter_map(|n| a.admit(ip(&format!("192.168.1.{}", 100 + n)))).collect();
        assert_eq!(flood.len(), MAX_UNAUTH_STRANGERS);
        let phone = a.admit(ip("192.168.1.20")).expect("the paired phone is not locked out");
        phone.authenticated();
        a.admit(ip("192.168.1.20")).expect("and reconnects during the flood").authenticated();
        assert!(a.counts().0 <= MAX_CONNECTIONS);
    }

    #[test]
    fn the_places_come_back_the_wait_shortens_and_eight_addresses_are_remembered() {
        let a = Admission::new();
        {
            let t1 = a.admit(ip("192.168.1.20")).unwrap();
            let _t2 = a.admit(ip("192.168.1.21")).unwrap();
            t1.authenticated();
            t1.authenticated();
        }
        assert_eq!(a.counts(), (0, 0));
        let b = Admission::new();
        assert_eq!(b.admit(ip("192.168.1.1")).unwrap().wait(), PATIENT);
        let _held: Vec<_> = (0..2).map(|n| b.admit(ip(&format!("192.168.2.{n}"))).unwrap()).collect();
        assert_eq!(b.admit(ip("192.168.3.1")).unwrap().wait(), HURRIED);
        let c = Admission::new();
        for n in 0..(KNOWN_ADDRESSES + 3) {
            c.admit(ip(&format!("192.168.5.{n}"))).unwrap().authenticated();
        }
        assert!(!c.knows(ip("192.168.5.0")) && c.knows(ip(&format!("192.168.5.{}", KNOWN_ADDRESSES + 2))));
        let d = Admission::new();
        let mut held = Vec::new();
        for n in 0..MAX_CONNECTIONS {
            let t = d.admit(ip(&format!("192.168.1.{}", 10 + n))).unwrap();
            t.authenticated();
            held.push(t);
        }
        assert!(d.admit(ip("192.168.1.10")).is_none(), "never over eight, even for known phones");
    }
}

// ---- the TLS server ---------------------------------------------------------------------------------

struct Off;
impl Features for Off {}


/// A client verifier that accepts exactly one certificate, by SHA-256: what the phone does.
#[derive(Debug)]
struct Pin(String);
impl rustls::client::danger::ServerCertVerifier for Pin {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let got = super::hex(ring::digest::digest(&ring::digest::SHA256, end_entity.as_ref()).as_ref());
        if got == self.0 { Ok(rustls::client::danger::ServerCertVerified::assertion()) } else { Err(rustls::Error::General("pin mismatch".into())) }
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider().signature_verification_algorithms.supported_schemes()
    }
}

struct Rig {
    port: u16,
    fingerprint: String,
    token: String,
    handle: Option<server::Handle>,
    hub: Arc<hub::Hub>,
}

async fn start() -> Rig {
    let store = Mem::default();
    let id = pairing::load_or_create_identity(&store).unwrap();
    let token = pairing::token(&store).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let hub = hub::Hub::new();
    let shared = Shared::with_hub(hub.clone(), token.clone(), "Test PC".into(), Arc::new(Off));
    let handle = server::serve(listener, server::tls_acceptor(&id).unwrap(), shared);
    Rig { port, fingerprint: id.fingerprint, token, handle: Some(handle), hub }
}

type Client = (BufReader<tokio::io::ReadHalf<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>>, tokio::io::WriteHalf<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>);

async fn connect(port: u16, pin: &str) -> Result<Client, std::io::Error> {
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pin(pin.to_string())))
        .with_no_client_auth();
    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    let tls = tokio_rustls::TlsConnector::from(Arc::new(cfg)).connect("abito".try_into().unwrap(), tcp).await?;
    let (r, w) = tokio::io::split(tls);
    Ok((BufReader::new(r), w))
}

async fn send(w: &mut tokio::io::WriteHalf<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>, v: Value) {
    w.write_all(format!("{v}\n").as_bytes()).await.unwrap();
}

async fn recv(r: &mut BufReader<tokio::io::ReadHalf<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>>) -> Option<Value> {
    let mut line = String::new();
    match tokio::time::timeout(std::time::Duration::from_secs(5), r.read_line(&mut line)).await {
        Ok(Ok(n)) if n > 0 => serde_json::from_str(&line).ok(),
        _ => None,
    }
}

#[test]
fn a_paired_phone_gets_welcome_and_pong_and_bye_closes() {
    run(async {
        let rig = start().await;
        let (mut r, mut w) = connect(rig.port, &rig.fingerprint).await.unwrap();
        send(&mut w, json!({"type":"hello","v":PROTOCOL,"token":rig.token,"device":"Pixel"})).await;
        let welcome = recv(&mut r).await.unwrap();
        assert_eq!(welcome["type"], "welcome");
        assert_eq!((welcome["v"].as_u64(), welcome["desktop"].as_str(), welcome["os"].as_str()), (Some(1), Some("Test PC"), Some(std::env::consts::OS)));
        assert!(welcome.get("caps").is_none(), "no capability is offered to a phone that asked for none");
        assert_eq!(recv(&mut r).await.unwrap()["type"], "sessions", "the current sessions follow the welcome");
        send(&mut w, json!({"type":"ping"})).await;
        assert_eq!(recv(&mut r).await.unwrap()["type"], "pong");
        send(&mut w, json!({"type":"future-thing"})).await;
        send(&mut w, json!({"type":"ping"})).await;
        assert_eq!(recv(&mut r).await.unwrap()["type"], "pong", "unknown types are ignored");
        send(&mut w, json!({"type":"bye"})).await;
        assert!(recv(&mut r).await.is_none(), "bye closes the link");
    });
}

#[test]
fn a_wrong_token_or_version_gets_an_auth_error_and_nothing_else() {
    run(async {
        let rig = start().await;
        for hello in [
            json!({"type":"hello","v":PROTOCOL,"token":"x".repeat(rig.token.len())}),
            json!({"type":"hello","v":PROTOCOL,"token":"short"}),
            json!({"type":"hello","v":PROTOCOL}),
            json!({"type":"hello","v":2,"token":rig.token}),
        ] {
            let (mut r, mut w) = connect(rig.port, &rig.fingerprint).await.unwrap();
            send(&mut w, hello).await;
            let e = recv(&mut r).await.unwrap();
            assert_eq!((e["type"].as_str(), e["code"].as_str()), (Some("error"), Some("auth")));
            assert!(recv(&mut r).await.is_none());
        }
    });
}

#[test]
fn a_phone_that_does_not_say_hello_first_gets_nothing() {
    run(async {
        let rig = start().await;
        let (mut r, mut w) = connect(rig.port, &rig.fingerprint).await.unwrap();
        send(&mut w, json!({"type":"ping"})).await;
        assert!(recv(&mut r).await.is_none());
        let (mut r, mut w) = connect(rig.port, &rig.fingerprint).await.unwrap();
        w.write_all(b"this is not json\n").await.unwrap();
        assert!(recv(&mut r).await.is_none());
    });
}

#[test]
fn a_line_over_64_kib_closes_and_exactly_64_kib_is_accepted() {
    run(async {
        let rig = start().await;
        let (mut r, mut w) = connect(rig.port, &rig.fingerprint).await.unwrap();
        send(&mut w, json!({"type":"hello","v":PROTOCOL,"token":rig.token})).await;
        assert_eq!(recv(&mut r).await.unwrap()["type"], "welcome");
        assert_eq!(recv(&mut r).await.unwrap()["type"], "sessions");
        let mut line = br#"{"type":"ping","pad":""#.to_vec();
        let tail = br#""}"#;
        line.resize(server::MAX_LINE - tail.len(), b'a');
        line.extend_from_slice(tail);
        assert_eq!(line.len(), server::MAX_LINE);
        line.push(b'\n');
        w.write_all(&line).await.unwrap();
        assert_eq!(recv(&mut r).await.unwrap()["type"], "pong");
        let mut big = br#"{"type":"ping","pad":""#.to_vec();
        big.resize(server::MAX_LINE + 10, b'a');
        big.push(b'\n');
        w.write_all(&big).await.unwrap();
        let e = recv(&mut r).await.unwrap();
        assert_eq!((e["type"].as_str(), e["code"].as_str()), (Some("error"), Some("protocol")));
        assert!(recv(&mut r).await.is_none());
    });
}

#[test]
fn a_phone_pinning_another_certificate_never_connects_and_stop_closes_the_link() {
    run(async {
        let mut rig = start().await;
        assert!(connect(rig.port, &"00".repeat(32)).await.is_err());
        let (mut r, mut w) = connect(rig.port, &rig.fingerprint).await.unwrap();
        send(&mut w, json!({"type":"hello","v":PROTOCOL,"token":rig.token})).await;
        assert_eq!(recv(&mut r).await.unwrap()["type"], "welcome");
        rig.handle.take().unwrap().stop();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", rig.port)).await.is_err(), "nothing listens once it is off");
    });
}

#[test]
fn only_the_local_network_may_connect() {
    for ok in ["192.168.1.20", "10.0.0.5", "172.16.3.4", "172.31.255.255", "127.0.0.1", "169.254.7.7", "::1", "fd12:3456::1", "fe80::1", "::ffff:192.168.0.9"] {
        assert!(server::is_local(ok.parse().unwrap()), "{ok}");
    }
    for no in ["8.8.8.8", "172.32.0.1", "100.64.0.1", "2001:db8::1", "::ffff:8.8.8.8", "0.0.0.0"] {
        assert!(!server::is_local(no.parse().unwrap()), "{no}");
    }
}

#[test]
fn the_idle_limit_is_well_above_what_a_sleeping_phone_needs_but_bounded() {
    assert!(server::IDLE_TIMEOUT >= std::time::Duration::from_secs(16 * 60));
    assert!(server::IDLE_TIMEOUT <= std::time::Duration::from_secs(30 * 60));
}

#[test]
fn the_phone_link_keys_are_internal_only_never_reachable_from_the_page() {
    for k in [pairing::CERT_KEY, pairing::PRIVATE_KEY, pairing::TOKEN_KEY] {
        assert!(!crate::secrets::KNOWN_KEYS.contains(&k), "{k}");
        assert!(crate::secrets::INTERNAL_KEYS.contains(&k), "{k}");
        assert!(crate::secrets::parse_command(&json!({"action":"present","key":k})).is_none());
        assert!(crate::secrets::parse_command(&json!({"action":"set","key":k,"value":"v"})).is_none());
    }
}

// ---- slice B: the hub and the session source ----------------------------------------------------------

fn sess(pill: &str, state: &str) -> hub::SessionIn {
    hub::SessionIn { pill_id: pill.into(), agent: pill.into(), state: state.into(), ..hub::SessionIn::default() }
}

async fn paired(rig: &Rig) -> Client {
    let (mut r, mut w) = connect(rig.port, &rig.fingerprint).await.unwrap();
    send(&mut w, json!({"type":"hello","v":PROTOCOL,"token":rig.token})).await;
    assert_eq!(recv(&mut r).await.unwrap()["type"], "welcome");
    (r, w)
}

#[test]
fn a_phone_gets_the_current_sessions_on_connect_and_every_change_after() {
    run(async {
        let rig = start().await;
        rig.hub.publish_sessions(vec![sess("integration_claude", "working")], 1_000);
        let (mut r, _w) = paired(&rig).await;
        let first = recv(&mut r).await.unwrap();
        assert_eq!(first["type"], "sessions");
        assert_eq!(first["sessions"][0]["pillId"], "integration_claude");
        assert_eq!(first["sessions"][0]["state"], "working");
        assert_eq!(first["sessions"][0]["updatedAt"], 1_000);
        assert_eq!(first["sessions"][0].as_object().unwrap().len(), 7, "the v1 session has exactly its seven fields: {first}");
        rig.hub.publish_sessions(vec![sess("integration_claude", "thinking"), sess("agent_codex", "idle")], 2_000);
        let next = recv(&mut r).await.unwrap();
        assert_eq!(next["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(next["sessions"][0]["state"], "thinking");
    });
}

#[test]
fn an_unchanged_picture_sends_nothing_and_updated_at_only_moves_when_the_content_does() {
    run(async {
        let rig = start().await;
        let (mut r, _w) = paired(&rig).await;
        assert_eq!(recv(&mut r).await.unwrap()["sessions"].as_array().unwrap().len(), 0, "an empty list on connect");
        rig.hub.publish_sessions(vec![sess("integration_claude", "working"), sess("agent_codex", "idle")], 1_000);
        recv(&mut r).await.unwrap();
        rig.hub.publish_sessions(vec![sess("integration_claude", "working"), sess("agent_codex", "idle")], 5_000);
        rig.hub.publish_sessions(vec![sess("integration_claude", "working"), sess("agent_codex", "working")], 6_000);
        let v = recv(&mut r).await.unwrap();
        assert_eq!((v["sessions"][0]["updatedAt"].as_u64(), v["sessions"][1]["updatedAt"].as_u64()), (Some(1_000), Some(6_000)), "{v}");
    });
}

#[test]
fn what_reaches_the_phone_is_bounded_and_cleaned() {
    let hub = hub::Hub::new();
    let many: Vec<_> = (0..40).map(|n| sess(&format!("agent_{n}"), "working")).collect();
    let mut odd = sess("agent_x", "levitating");
    odd.agent = "é".repeat(100);
    odd.status_text = format!("{}\u{0}", "z".repeat(500));
    odd.project = Some("/home/me/secret-work/".into());
    let mut v = many;
    v.insert(0, odd);
    v.insert(1, sess("", "idle"));
    hub.publish_sessions(v, 1);
    let lines = hub.sessions_json();
    assert_eq!(lines.as_array().unwrap().len(), 16, "at most 16 sessions, and the one without a pill is gone");
    let first = &lines[0];
    assert_eq!(first["state"], "idle", "an unknown state is shown as idle");
    assert_eq!(first["agent"].as_str().unwrap().chars().count(), 64);
    assert!(first["statusText"].as_str().unwrap().chars().count() <= 200);
    assert!(!first.to_string().contains("secret-work"), "the v1 line never carries the folder");
}

#[test]
fn a_hub_with_nobody_listening_costs_nothing_and_kick_all_closes_everyone() {
    run(async {
        let rig = start().await;
        assert_eq!(rig.hub.clients(), 0);
        rig.hub.publish_sessions(vec![sess("integration_claude", "working")], 1);
        let (mut r, _w) = paired(&rig).await;
        recv(&mut r).await.unwrap();
        assert_eq!(rig.hub.clients(), 1);
        rig.hub.kick_all("closed", "the phone link was turned off");
        let e = recv(&mut r).await.unwrap();
        assert_eq!((e["type"].as_str(), e["code"].as_str()), (Some("error"), Some("closed")));
        assert!(recv(&mut r).await.is_none());
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(rig.hub.clients(), 0, "a closed link is unsubscribed");
    });
}

#[test]
fn a_phone_that_cannot_keep_up_is_dropped_not_waited_for() {
    run(async {
        let hub = hub::Hub::new();
        let (tx, _rx) = tokio::sync::mpsc::channel::<server::Out>(2);
        let (_id, evicted) = hub.subscribe(tx, 0);
        for n in 0..10 {
            hub.publish_sessions(vec![sess("integration_claude", if n % 2 == 0 { "working" } else { "idle" })], n);
        }
        assert!(evicted.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(hub.clients(), 0);
    });
}

fn rows(v: serde_json::Value) -> serde_json::Value {
    json!({"rows": v, "truncated": false})
}

#[test]
fn the_islands_session_rows_become_one_phone_session_per_agent() {
    let view = rows(json!([
        {"id":"s-0000000a","kind":"claude-code","cwd":"proj-a","state":"sleeping","origin":"terminal"},
        {"id":"s-0000000b","kind":"claude-code","cwd":"proj-b","state":"running","origin":null},
        {"id":"s-0000000c","kind":"codex","cwd":null,"state":"stopped","origin":null},
        {"id":"s-0000000d","kind":"gemini","cwd":"g","state":"zombie","origin":null},
        {"id":"s-0000000e","kind":"opencode","cwd":"o","state":"unknown","origin":null},
        {"id":"s-0000000f","kind":"pi","cwd":"p","state":"running","origin":null}
    ]));
    let got = source::sessions_from_view(&view);
    let by = |p: &str| got.iter().find(|s| s.pill_id == p).unwrap_or_else(|| panic!("{p} in {got:?}"));
    assert_eq!(by("integration_claude").state, "working", "the busiest row of an agent speaks for it");
    assert_eq!(by("integration_claude").project.as_deref(), Some("proj-b"));
    assert_eq!(by("integration_claude").status_text, "2 sessions");
    assert_eq!(by("agent_codex").state, "finished");
    assert_eq!(by("agent_gemini").state, "dizzy");
    assert_eq!(by("agent_opencode").state, "idle");
    assert_eq!(by("agent_codex").status_text, "");
    assert!(got.iter().all(|s| s.pill_id != "agent_pi" && !s.pill_id.is_empty()), "an agent with no pill is not invented: {got:?}");
    assert_eq!(got.len(), 4);
}

#[test]
fn a_missing_or_malformed_snapshot_is_an_empty_list_and_publishing_it_clears_the_phone() {
    for bad in [serde_json::Value::Null, json!({}), json!({"rows":"x"}), json!({"rows":[1,2,{"kind":5}]})] {
        assert!(source::sessions_from_view(&bad).is_empty(), "{bad}");
    }
    let hub = hub::Hub::new();
    source::publish(&hub, &rows(json!([{"id":"s-0000000a","kind":"codex","cwd":null,"state":"running","origin":null}])), 10);
    assert_eq!(hub.sessions_json().as_array().unwrap().len(), 1);
    source::publish(&hub, &serde_json::Value::Null, 20);
    assert_eq!(hub.sessions_json().as_array().unwrap().len(), 0);
}

#[test]
fn the_session_source_is_the_one_accessor_of_the_agent_client_state() {
    let mut st = crate::agentclient::ClientState::connected();
    assert_eq!(st.sessions_view(), &serde_json::Value::Null);
    st.apply(&json!({"type":"sessions","schema":"abito-sessions/view/1","truncated":false,"sessions":[
        {"id":"s-0000000a","kind":"codex","state":"running","cwd":"x","origin":null}]})).unwrap();
    let got = source::sessions_from_view(st.sessions_view());
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].pill_id, "agent_codex");
}

// ---- S7: the mDNS announcement, §3.2 of the link contract -------------------------------

/// What §3.2 puts on the wire, field by field. The announcement is a hint, never a credential: the phone still
/// pins the full certificate, so only the id and the version decide «this is my computer».
#[test]
fn the_announcement_record_is_exactly_what_the_contract_asks_for() {
    let fp = pairing::load_or_create_identity(&Mem::default()).unwrap().fingerprint;
    let r = announce::record("Alvaro PC", 47821, &fp);
    assert_eq!(r.service, "_abito._tcp.local.", "ids::MDNS_SERVICE plus the DNS-SD domain (S12: still `abito`)");
    assert_eq!(r.instance, "Alvaro PC", "the computer's name, the same one the pairing link carries");
    assert_eq!(r.host, "alvaro-pc.local.", "a DNS label of the computer name");
    assert_eq!(r.port, 47821, "the listening port");
    assert_eq!(r.fp, fp[..announce::FP_ID_LEN], "the FIRST 16 hex characters of the certificate SHA-256");
    assert_eq!(r.fp.len(), 16);
    assert!(r.fp.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "lowercase hex only");
    assert_eq!(r.v, "1", "the protocol version, as text");
    assert_eq!(r.v, server::PROTOCOL.to_string(), "one source for the version, the one the handshake compares");
    // Uppercase input announces lowercase: the phone compares the id case-insensitively (§2.3).
    assert_eq!(announce::fp16(&fp.to_uppercase()), r.fp);
}

/// The host label is what the announced addresses hang from: a DNS label, never empty, never `-bound`.
#[test]
fn the_announced_host_is_a_dns_label_of_the_computer_name() {
    assert_eq!(announce::host_label("Alvaro PC"), "alvaro-pc");
    assert_eq!(announce::host_label("  Léa's  PC & co  "), "l-a-s-pc-co", "everything DNS refuses becomes one '-'");
    assert_eq!(announce::host_label(""), ids::DEFAULT_NAME.to_ascii_lowercase());
    assert_eq!(announce::host_label("---"), "abito", "an unusable name falls back instead of announcing `.local.`");
    let cut = announce::host_label(&format!("{} PC", "A".repeat(80)));
    assert_eq!(cut.len(), 63, "a DNS label holds at most 63 bytes");
    assert!(!cut.ends_with('-') && !cut.starts_with('-'), "{cut}");
    // A name the phone would show but DNS would not carry still yields one label.
    let record = announce::record("  ", 1, &"ab".repeat(32));
    assert_eq!((record.instance.as_str(), record.host.as_str()), (ids::DEFAULT_NAME, "abito.local."));
}

/// The record is a service the daemon accepts: registration refuses a malformed type, host or TXT, so this is the
/// contract's §3.2 checked against the crate that carries it (still no socket: `ServiceInfo` is a value).
#[test]
fn the_record_is_a_service_the_mdns_daemon_can_carry() {
    let r = announce::record("Alvaro PC", 47821, &"ab".repeat(32));
    let info = mdns_sd::ServiceInfo::new(
        &r.service,
        &r.instance,
        &r.host,
        (),
        r.port,
        &[("fp", r.fp.as_str()), ("v", r.v.as_str())] as &[(&str, &str)],
    )
    .unwrap();
    assert_eq!(info.get_fullname(), "Alvaro PC._abito._tcp.local.");
    assert_eq!(info.get_hostname(), "alvaro-pc.local.");
    assert_eq!(info.get_port(), 47821);
    assert_eq!(info.get_property_val_str("fp"), Some("abababababababab"), "16 hex, no more");
    assert_eq!(info.get_property_val_str("v"), Some("1"));
}

/// The announcement seam: the app's [`announce::Mdns`], the tests' [`FakeMdns`]. No unit test opens a multicast
/// socket, so `cargo test` stays isolated and fast.
struct FakeMdns {
    records: std::sync::Mutex<Vec<Record>>,
    stops: Arc<std::sync::Mutex<usize>>,
    fails: bool,
}

impl FakeMdns {
    fn working() -> Arc<FakeMdns> {
        Arc::new(FakeMdns { records: std::sync::Mutex::new(Vec::new()), stops: Arc::default(), fails: false })
    }
    fn failing() -> Arc<FakeMdns> {
        Arc::new(FakeMdns { records: std::sync::Mutex::new(Vec::new()), stops: Arc::default(), fails: true })
    }
    fn records(&self) -> Vec<Record> {
        self.records.lock().unwrap().clone()
    }
    fn stops(&self) -> usize {
        *self.stops.lock().unwrap()
    }
}

impl Advertise for FakeMdns {
    fn announce(&self, record: &Record) -> Result<Box<dyn Announcement>, String> {
        self.records.lock().unwrap().push(record.clone());
        if self.fails {
            return Err("no mDNS on this network".to_string());
        }
        Ok(Box::new(FakeAnnouncement(self.stops.clone())))
    }
}

struct FakeAnnouncement(Arc<std::sync::Mutex<usize>>);

impl Announcement for FakeAnnouncement {
    fn stop(&mut self) {
        *self.0.lock().unwrap() += 1;
    }
}

/// A link whose announcement is the fake: every link test uses this, never the real daemon.
fn test_link() -> (super::link::Link, Arc<FakeMdns>) {
    let mdns = FakeMdns::working();
    (super::link::Link::with_advertiser(mdns.clone()), mdns)
}

#[test]
fn the_link_announces_once_with_the_port_it_bound_and_stops_when_switched_off() {
    let store = Mem::default();
    let (link, mdns) = test_link();
    assert_eq!(link.status_for(None)["mdns"], json!("off"), "S3: nothing is announced while it is off");
    assert!(mdns.records().is_empty(), "and no daemon was started either");

    assert_eq!(link.enable(&store, "127.0.0.1:0".parse().unwrap()), Ok(()));
    let status = link.status_for(None);
    let port = u16::try_from(status["port"].as_u64().unwrap()).unwrap();
    assert_eq!(status["mdns"], json!("on"));
    let fp = pairing::load_or_create_identity(&store).unwrap().fingerprint;
    let records = mdns.records();
    assert_eq!(records.len(), 1, "exactly one announcement per enable");
    assert_eq!(records[0].port, port, "the real bound port, not the 0 the test asked for");
    assert_ne!(port, 0);
    assert_eq!(records[0].fp, fp[..announce::FP_ID_LEN]);
    assert_eq!(records[0].instance, pairing::computer_name().trim(), "the same name the link carries");
    assert_eq!(records[0].service, "_abito._tcp.local.");
    assert_eq!(records[0].v, "1");

    assert_eq!(link.enable(&store, "127.0.0.1:0".parse().unwrap()), Ok(()));
    assert_eq!(mdns.records().len(), 1, "a second enable is the same switch, never a second announcement");
    assert_eq!(mdns.stops(), 0);

    link.disable();
    assert_eq!(mdns.stops(), 1, "switching off unregisters");
    let off = link.status_for(None);
    assert_eq!((off["running"].as_bool(), off["mdns"].as_str()), (Some(false), Some("off")));
    assert!(mdns.records().len() == 1, "and it does not announce again by itself");
}

#[test]
fn a_failed_bind_announces_nothing() {
    let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = held.local_addr().unwrap().port();
    let store = Mem::default();
    let (link, mdns) = test_link();
    assert_eq!(link.enable(&store, format!("127.0.0.1:{port}").parse().unwrap()), Err("port_in_use"));
    assert!(mdns.records().is_empty(), "no listener, no announcement");
    assert_eq!(mdns.stops(), 0);
    let status = link.status_for(None);
    assert_eq!((status["running"].as_bool(), status["mdns"].as_str()), (Some(false), Some("off")));
    assert_eq!(status["error"].as_str(), Some("port_in_use"), "the fatal reason keeps its own field");
}

#[test]
fn an_announcement_failure_is_not_fatal_so_the_qr_still_pairs() {
    run(async {
        let store = Mem::default();
        let mdns = FakeMdns::failing();
        let link = super::link::Link::with_advertiser(mdns.clone());
        assert_eq!(link.enable(&store, "127.0.0.1:0".parse().unwrap()), Ok(()), "S7: mDNS failing never fails enable");
        let status = link.status_for(Some("192.168.1.20".to_string()));
        assert_eq!((status["running"].as_bool(), status["enabled"].as_bool()), (Some(true), Some(true)));
        assert_eq!(status["mdns"], json!("error"), "the page can say the announcement did not happen");
        assert!(status["error"].is_null(), "`error` stays for the fatal reasons");
        assert_eq!(mdns.stops(), 0, "a failed announcement has nothing to unregister");

        let port = u16::try_from(status["port"].as_u64().unwrap()).unwrap();
        let fp = pairing::load_or_create_identity(&store).unwrap().fingerprint;
        let token = pairing::token(&store).unwrap();
        let (mut r, mut w) = connect(port, &fp).await.unwrap();
        send(&mut w, json!({"type":"hello","v":PROTOCOL,"token":token})).await;
        assert_eq!(recv(&mut r).await.unwrap()["type"], "welcome", "the QR's link still pairs");
        assert_eq!(recv(&mut r).await.unwrap()["type"], "sessions");

        link.disable();
        assert_eq!(link.status_for(None)["mdns"], json!("off"));
        // A transient failure is not remembered: the next enable tries again.
        assert_eq!(link.enable(&store, "127.0.0.1:0".parse().unwrap()), Ok(()));
        assert_eq!(mdns.records().len(), 2, "a later enable announces again");
        link.disable();
    });
}

/// The real thing, once, by hand: `cargo test --lib -- --ignored the_real_announcement` starts the app's own link
/// on 127.0.0.1:0 and browses `_abito._tcp` the way the phone does, reading the TXT out of the resolution. Ignored
/// because it binds mDNS's port 5353, sends real multicast and browses the LAN, which no routine unit test may do.
#[test]
#[ignore = "binds mDNS port 5353, sends real multicast and browses the LAN"]
fn the_real_announcement_is_found_by_a_real_browse() {
    use mdns_sd::{ServiceDaemon, ServiceEvent};

    let store = Mem::default();
    let link = super::link::Link::new(); // the app's link: the real announcement, not the fake
    assert_eq!(link.enable(&store, "127.0.0.1:0".parse().unwrap()), Ok(()));
    let status = link.status_for(None);
    assert_eq!(status["mdns"], json!("on"), "{status}");
    let port = u16::try_from(status["port"].as_u64().unwrap()).unwrap();
    let fp = pairing::load_or_create_identity(&store).unwrap().fingerprint;

    let browser = ServiceDaemon::new().unwrap();
    let events = browser.browse("_abito._tcp.local.").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut found = None;
    while found.is_none() && std::time::Instant::now() < deadline {
        if let Ok(ServiceEvent::ServiceResolved(info)) = events.recv_timeout(std::time::Duration::from_millis(250)) {
            if info.get_property_val_str("fp") == Some(&fp[..announce::FP_ID_LEN]) {
                found = Some(info);
            }
        }
    }
    let _ = browser.shutdown();
    let info = found.expect("what this computer announced came back over multicast");
    assert_eq!(info.get_port(), port, "the port the listener really bound");
    assert_eq!(info.get_property_val_str("v"), Some("1"));
    assert_eq!(info.get_fullname(), format!("{}._abito._tcp.local.", pairing::computer_name().trim()));

    link.disable();
    assert_eq!(link.status_for(None)["mdns"], json!("off"), "and the announcement goes with the listener");
}

// ---- the live link: S2's missing switch, S3's off-by-default -----------------------------------------

/// An in-memory `secrets::SecretStore` (the OS keystore's seam): the adapter's rules are a unit test.
#[derive(Clone, Default)]
struct Vault(std::sync::Arc<VaultInner>);

#[derive(Default)]
struct VaultInner {
    entries: std::sync::Mutex<std::collections::HashMap<String, String>>,
    broken: std::sync::atomic::AtomicBool,
}

impl Vault {
    fn read_raw(&self, key: &str) -> Option<String> {
        self.0.entries.lock().unwrap().get(key).cloned()
    }
    fn put_raw(&self, key: &str, value: &str) {
        self.0.entries.lock().unwrap().insert(key.into(), value.into());
    }
    fn break_it(&self) {
        self.0.broken.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

impl crate::secrets::SecretStore for Vault {
    fn read(&self, key: &str) -> Result<Option<String>, crate::secrets::StoreError> {
        if self.0.broken.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::secrets::StoreError::Unavailable);
        }
        Ok(self.read_raw(key))
    }
    fn write(&self, key: &str, value: &str) -> Result<(), crate::secrets::StoreError> {
        if self.0.broken.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::secrets::StoreError::Failed);
        }
        self.put_raw(key, value);
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), crate::secrets::StoreError> {
        if self.0.broken.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::secrets::StoreError::Failed);
        }
        self.0.entries.lock().unwrap().remove(key);
        Ok(())
    }
}

#[test]
fn the_keystore_adapter_reads_and_writes_and_answers_a_fixed_text_on_failure() {
    use super::keystore::{KeychainStore, WRITE_FAILED};
    let vault = Vault::default();
    let store = KeychainStore::new(vault.clone());
    assert_eq!(store.get(pairing::TOKEN_KEY), None, "a missing entry reads as absent");
    assert_eq!(store.set(pairing::TOKEN_KEY, "tok_en-1234567890abcd"), Ok(()));
    assert_eq!(vault.read_raw(pairing::TOKEN_KEY).as_deref(), Some("tok_en-1234567890abcd"));
    assert_eq!(store.get(pairing::TOKEN_KEY).as_deref(), Some("tok_en-1234567890abcd"));
    vault.put_raw(pairing::CERT_KEY, "");
    assert_eq!(store.get(pairing::CERT_KEY), None, "an empty entry is the same as missing: no fallback to disk");
    vault.break_it();
    assert_eq!(store.get(pairing::TOKEN_KEY), None, "an unreadable keystore is reported as absent, never as a crash");
    let refused = store.set(pairing::TOKEN_KEY, "another-token-value");
    assert_eq!(refused, Err(WRITE_FAILED.to_string()));
    assert!(!refused.unwrap_err().contains("another-token-value"), "the answer never carries the value");
    // The app's adapter is this one over the real keychain; the type is checked, nothing is read.
    let _: &dyn SecretStore = &super::keystore::keychain();
}

#[test]
fn a_link_that_was_never_switched_on_listens_nowhere_and_says_so() {
    let (link, mdns) = test_link();
    let status = link.status_for(Some("192.168.1.20".to_string()));
    assert_eq!(status["enabled"], json!(false), "S3: off until the human turns it on");
    assert_eq!(status["running"], json!(false));
    assert_eq!(status["port"], json!(0));
    assert_eq!(status["clients"], json!(0));
    assert_eq!(status["mdns"], json!("off"), "S7/S3: a link that is off announces nothing");
    assert!(status["link"].is_null() && status["qrSvg"].is_null() && status["error"].is_null());
    assert!(mdns.records().is_empty(), "and there is no daemon behind the status either");
    assert_eq!(link.hub().clients(), 0);
}

#[test]
fn the_link_serves_a_paired_phone_and_everything_stops_when_it_is_switched_off() {
    run(async {
        let store = Mem::default();
        let (link, _mdns) = test_link();
        assert_eq!(link.enable(&store, "127.0.0.1:0".parse().unwrap()), Ok(()));
        let status = link.status_for(Some("192.168.1.20".to_string()));
        assert_eq!((status["enabled"].as_bool(), status["running"].as_bool()), (Some(true), Some(true)));
        assert!(status["error"].is_null());
        let port = u16::try_from(status["port"].as_u64().unwrap()).unwrap();
        assert_ne!(port, 0, "the test binds port 0: status reports the real one");
        let fp = pairing::load_or_create_identity(&store).unwrap().fingerprint;
        let text = status["link"].as_str().unwrap().to_string();
        assert!(text.starts_with("abito://pair?v=1&"), "{text}");
        assert!(text.contains(&format!("port={port}&fp={fp}")), "{text}");
        assert!(status["qrSvg"].as_str().unwrap().contains("<svg"));
        assert_eq!(status["clients"], json!(0));

        let token = pairing::token(&store).unwrap();
        let (mut r, mut w) = connect(port, &fp).await.unwrap();
        send(&mut w, json!({"type":"hello","v":PROTOCOL,"token":token})).await;
        assert_eq!(recv(&mut r).await.unwrap()["type"], "welcome");
        assert_eq!(recv(&mut r).await.unwrap()["type"], "sessions");
        assert_eq!(link.status_for(Some("192.168.1.20".to_string()))["clients"], json!(1));
        link.publish_sessions(&rows(json!([{"id":"s-0000000a","kind":"codex","cwd":"koda","state":"running","origin":null}])), 1_000);
        let pushed = recv(&mut r).await.unwrap();
        assert_eq!(pushed["type"], "sessions");
        assert_eq!(pushed["sessions"][0]["pillId"], "agent_codex", "the phone reads what the island draws");

        link.disable();
        let e = recv(&mut r).await.unwrap();
        assert_eq!((e["type"].as_str(), e["code"].as_str()), (Some("error"), Some("closed")));
        assert!(recv(&mut r).await.is_none(), "the phone's link ends");
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err(), "nothing listens once it is off");
        let off = link.status_for(Some("192.168.1.20".to_string()));
        assert_eq!((off["enabled"].as_bool(), off["running"].as_bool()), (Some(false), Some(false)));
        assert_eq!(off["port"], json!(0));
        assert!(off["link"].is_null() && off["qrSvg"].is_null());
    });
}

#[test]
fn enabling_a_running_link_changes_nothing() {
    let store = Mem::default();
    let (link, _mdns) = test_link();
    assert_eq!(link.enable(&store, "127.0.0.1:0".parse().unwrap()), Ok(()));
    let port = link.status_for(None)["port"].as_u64();
    assert_eq!(link.enable(&store, "127.0.0.1:0".parse().unwrap()), Ok(()));
    assert_eq!(link.status_for(None)["port"].as_u64(), port, "the same listener, never a second one");
    link.disable();
}

#[test]
fn a_port_already_in_use_is_a_closed_error_and_the_link_stays_off() {
    let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = held.local_addr().unwrap().port();
    let store = Mem::default();
    let (link, _mdns) = test_link();
    assert_eq!(link.enable(&store, format!("127.0.0.1:{port}").parse().unwrap()), Err("port_in_use"));
    let status = link.status_for(Some("192.168.1.20".to_string()));
    assert_eq!((status["running"].as_bool(), status["error"].as_str()), (Some(false), Some("port_in_use")));
    assert!(status["link"].is_null());
    // The wish stays on: the next start retries instead of pretending the human turned it off.
    assert_eq!(status["enabled"], json!(true));
    drop(held);
    assert_eq!(link.enable(&store, "127.0.0.1:0".parse().unwrap()), Ok(()), "a later attempt works");
    assert!(link.status_for(None)["error"].is_null());
    link.disable();
}

#[test]
fn unlink_rotates_the_token_and_locks_the_old_phone_out() {
    run(async {
        let store = Mem::default();
        let (link, _mdns) = test_link();
        assert_eq!(link.enable(&store, "127.0.0.1:0".parse().unwrap()), Ok(()));
        let port = u16::try_from(link.status_for(None)["port"].as_u64().unwrap()).unwrap();
        let fp = pairing::load_or_create_identity(&store).unwrap().fingerprint;
        let old = pairing::token(&store).unwrap();
        let (mut r, mut w) = connect(port, &fp).await.unwrap();
        send(&mut w, json!({"type":"hello","v":PROTOCOL,"token":old})).await;
        assert_eq!(recv(&mut r).await.unwrap()["type"], "welcome");
        assert_eq!(recv(&mut r).await.unwrap()["type"], "sessions");

        assert_eq!(link.unlink(&store), Ok(()));
        let new = pairing::token(&store).unwrap();
        assert_ne!(new, old, "a fresh token, the certificate untouched");
        let e = recv(&mut r).await.unwrap();
        assert_eq!((e["type"].as_str(), e["code"].as_str()), (Some("error"), Some("auth")), "the paired phone is locked out");
        assert!(recv(&mut r).await.is_none());

        let (mut r2, mut w2) = connect(port, &fp).await.unwrap();
        send(&mut w2, json!({"type":"hello","v":PROTOCOL,"token":old})).await;
        let refused = recv(&mut r2).await.unwrap();
        assert_eq!((refused["type"].as_str(), refused["code"].as_str()), (Some("error"), Some("auth")));

        let (mut r3, mut w3) = connect(port, &fp).await.unwrap();
        send(&mut w3, json!({"type":"hello","v":PROTOCOL,"token":new.clone()})).await;
        assert_eq!(recv(&mut r3).await.unwrap()["type"], "welcome");
        assert!(link.status_for(Some("192.168.1.20".to_string()))["link"].as_str().unwrap().contains(&new), "the new link carries the new token");
        link.disable();
    });
}

// ---- the switch under contention: one operation at a time ---------------------------------------------

/// A keystore that holds the first caller until a second one is inside it too (or a short timeout runs out). Two
/// enables that really overlap both pass «is it running?» before either can bind; a serialized pair never has a
/// second caller in here, so the timeout carries the only one on.
struct Rendezvous {
    arrivals: std::sync::Mutex<usize>,
    released: std::sync::Condvar,
    mem: Mem,
}

impl Rendezvous {
    fn new() -> Rendezvous {
        Rendezvous { arrivals: std::sync::Mutex::new(0), released: std::sync::Condvar::new(), mem: Mem::default() }
    }
    fn enter(&self) {
        let mut arrived = self.arrivals.lock().unwrap();
        *arrived += 1;
        if *arrived == 1 {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
            while *arrived < 2 {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                if left.is_zero() {
                    break;
                }
                arrived = self.released.wait_timeout(arrived, left).unwrap().0;
            }
        } else {
            self.released.notify_all();
        }
    }
}

impl SecretStore for Rendezvous {
    fn get(&self, key: &str) -> Option<String> {
        self.enter();
        self.mem.get(key)
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.enter();
        self.mem.set(key, value)
    }
}

/// A keystore that holds every call until the test opens it, and says when the first one is inside: that is how a
/// disable is guaranteed to arrive while an enable is still in flight.
struct Held {
    entered: std::sync::mpsc::Sender<()>,
    open: std::sync::Mutex<bool>,
    opened: std::sync::Condvar,
    mem: Mem,
}

impl Held {
    fn new() -> (Held, std::sync::mpsc::Receiver<()>) {
        let (entered, rx) = std::sync::mpsc::channel();
        (Held { entered, open: std::sync::Mutex::new(false), opened: std::sync::Condvar::new(), mem: Mem::default() }, rx)
    }
    fn wait(&self) {
        let mut open = self.open.lock().unwrap();
        if !*open {
            let _ = self.entered.send(());
            while !*open {
                open = self.opened.wait(open).unwrap();
            }
        }
    }
    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.opened.notify_all();
    }
}

impl SecretStore for Held {
    fn get(&self, key: &str) -> Option<String> {
        self.wait();
        self.mem.get(key)
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.wait();
        self.mem.set(key, value)
    }
}

/// The same in-memory store with a latch that makes every later write fail: what `unlink` sees when the keystore
/// refuses while a link is up.
#[derive(Default)]
struct Flaky {
    mem: Mem,
    refuse: std::sync::atomic::AtomicBool,
}

impl Flaky {
    fn refuse_writes(&self) {
        self.refuse.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

impl SecretStore for Flaky {
    fn get(&self, key: &str) -> Option<String> {
        self.mem.get(key)
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        if self.refuse.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("the keystore refused the write".into());
        }
        self.mem.set(key, value)
    }
}

fn free_port() -> u16 {
    let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    held.local_addr().unwrap().port()
}

#[test]
fn two_enables_at_once_leave_one_listener_and_neither_knocks_the_other_down() {
    let store = Arc::new(Rendezvous::new());
    let link = Arc::new(super::link::Link::with_advertiser(FakeMdns::working()));
    let port = free_port();
    let addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let (first, second) = std::thread::scope(|s| {
        let a = {
            let (link, store) = (link.clone(), store.clone());
            s.spawn(move || link.enable(&*store, addr))
        };
        let b = {
            let (link, store) = (link.clone(), store.clone());
            s.spawn(move || link.enable(&*store, addr))
        };
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!((first, second), (Ok(()), Ok(())), "a second enable is the same switch, never a failed bind that kills the first");
    let status = link.status_for(Some("192.168.1.20".to_string()));
    assert_eq!((status["running"].as_bool(), status["error"].is_null()), (Some(true), true), "{status}");
    assert_eq!(status["port"], json!(port), "one listener, on the port both asked for");
    run(async {
        let fp = pairing::load_or_create_identity(&*store).unwrap().fingerprint;
        let token = pairing::token(&*store).unwrap();
        let (mut r, mut w) = connect(port, &fp).await.unwrap();
        send(&mut w, json!({"type":"hello","v":PROTOCOL,"token":token})).await;
        assert_eq!(recv(&mut r).await.unwrap()["type"], "welcome", "the surviving listener still pairs a phone");
        assert_eq!(recv(&mut r).await.unwrap()["type"], "sessions");
    });
    link.disable();
}

#[test]
fn a_disable_that_races_an_enable_leaves_nothing_running() {
    let (store, entered) = Held::new();
    let link = Arc::new(super::link::Link::with_advertiser(FakeMdns::working()));
    let port = free_port();
    let addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    std::thread::scope(|s| {
        let enabling = {
            let (link, held) = (link.clone(), &store);
            s.spawn(move || link.enable(held, addr))
        };
        entered.recv_timeout(std::time::Duration::from_secs(5)).expect("the enable reached the keystore");
        let disabling = {
            let link = link.clone();
            s.spawn(move || link.disable())
        };
        store.release();
        assert_eq!(enabling.join().unwrap(), Ok(()));
        disabling.join().unwrap();
    });
    let status = link.status_for(Some("192.168.1.20".to_string()));
    assert_eq!((status["enabled"].as_bool(), status["running"].as_bool()), (Some(false), Some(false)), "{status}");
    assert_eq!(status["port"], json!(0));
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "the enable that was in flight left no listener behind");
}

#[test]
fn a_failed_unlink_keeps_the_running_link_and_the_old_token() {
    run(async {
        let store = Flaky::default();
        let (link, _mdns) = test_link();
        assert_eq!(link.enable(&store, "127.0.0.1:0".parse().unwrap()), Ok(()));
        let port = u16::try_from(link.status_for(None)["port"].as_u64().unwrap()).unwrap();
        store.refuse_writes();
        assert_eq!(link.unlink(&store), Err("keystore"));
        let status = link.status_for(Some("192.168.1.20".to_string()));
        assert_eq!((status["running"].as_bool(), status["port"].as_u64()), (Some(true), Some(u64::from(port))), "the listener the human switched on is still up: {status}");
        assert_eq!(status["error"].as_str(), Some("keystore"), "and it says why the unlink did not happen");
        let old = pairing::token(&store).unwrap();
        assert!(status["link"].as_str().unwrap().contains(&old), "the old token still pairs: nothing was forgotten");
        let fp = pairing::load_or_create_identity(&store).unwrap().fingerprint;
        let (mut r, mut w) = connect(port, &fp).await.unwrap();
        send(&mut w, json!({"type":"hello","v":PROTOCOL,"token":old})).await;
        assert_eq!(recv(&mut r).await.unwrap()["type"], "welcome");
        assert_eq!(recv(&mut r).await.unwrap()["type"], "sessions");
        link.disable();
    });
}

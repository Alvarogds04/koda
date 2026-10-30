use super::*;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::sync::mpsc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

// ---- test PKI: a CA the client trusts, and a leaf for "localhost" signed by it -------------

pub(crate) struct Pki {
    pub root_der: Vec<u8>,
    pub leaf_der: Vec<u8>,
    pub leaf_key: Vec<u8>,
}

pub(crate) fn pki() -> Pki {
    use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair};
    let ca_key = KeyPair::generate().unwrap();
    let mut ca = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca_cert = ca.self_signed(&ca_key).unwrap();
    let leaf_key = KeyPair::generate().unwrap();
    let leaf = CertificateParams::new(vec!["localhost".to_string()]).unwrap().signed_by(&leaf_key, &ca_cert, &ca_key).unwrap();
    Pki { root_der: ca_cert.der().to_vec(), leaf_der: leaf.der().to_vec(), leaf_key: leaf_key.serialize_der() }
}

pub(crate) fn roots_of(der: &[u8]) -> Arc<rustls::RootCertStore> {
    let mut store = rustls::RootCertStore::empty();
    store.add(CertificateDer::from(der.to_vec())).unwrap();
    Arc::new(store)
}

pub(crate) fn acceptor(p: &Pki) -> tokio_rustls::TlsAcceptor {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(p.leaf_der.clone())], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(p.leaf_key.clone())))
        .unwrap();
    tokio_rustls::TlsAcceptor::from(Arc::new(cfg))
}

fn run<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}

// ---- fake IMAP server (TLS) ------------------------------------------------------------------

#[derive(Clone)]
struct Fx {
    uid: u32,
    flags: &'static str,
    date: &'static str,
    header: String,
    text: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Normal,
    HugeLiteral,
    LongLine,
    Hang,
    Garbage,
    SelectBad,
}

fn fixtures() -> Vec<Fx> {
    vec![
        Fx { uid: 3, flags: "\\Seen", date: "17-Jul-2026 10:00:00 +0000",
            header: "From: Martín Gómez <martin@example.com>\r\nSubject: Re: presupuesto\r\nDate: Fri, 17 Jul 2026 10:00:00 +0000\r\n\r\n".into(),
            text: "Gracias por la propuesta.\r\nLo charlamos mañana.\r\n".into() },
        Fx { uid: 5, flags: "", date: "17-Jul-2026 11:30:00 +0000",
            header: "From: =?UTF-8?B?THVjw61hIEZlcm7DoW5kZXo=?= <lucia@example.com>\r\nSubject: =?utf-8?Q?Reuni=C3=B3n_del_jueves?=\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n".into(),
            text: "Te confirmo la reuni=C3=B3n =\r\ndel jueves.\r\n".into() },
        Fx { uid: 7, flags: "\\Flagged", date: "17-Jul-2026 11:59:00 +0000",
            header: "From: noreply@example.com\r\nSubject: Aviso\r\nContent-Type: multipart/alternative; boundary=\"BB\"\r\n\r\n".into(),
            text: "--BB\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\nSG9sYSBkZXNkZSBiYXNlNjQ=\r\n--BB\r\nContent-Type: text/html\r\n\r\n<p>Hola html</p>\r\n--BB--\r\n".into() },
    ]
}

struct Server {
    port: u16,
    transcript: mpsc::Receiver<Vec<String>>,
}

fn quote_ok(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn spawn_server(p: &Pki, mode: Mode, many: usize) -> Server {
    let acceptor = acceptor(p);
    let (tx, rx) = mpsc::channel();
    let (ptx, prx) = mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            ptx.send(listener.local_addr().unwrap().port()).unwrap();
            let Ok((tcp, _)) = listener.accept().await else { return };
            let Ok(tls) = acceptor.accept(tcp).await else { let _ = tx.send(vec!["TLS-FAILED".into()]); return };
            let (rd, mut wr) = tokio::io::split(tls);
            let mut rd = BufReader::new(rd);
            let mut log: Vec<String> = Vec::new();
            let mut msgs = fixtures();
            for i in 0..many {
                msgs.push(Fx { uid: 100 + i as u32, flags: "", date: "17-Jul-2026 09:00:00 +0000", header: format!("From: bulk{i}@example.com\r\nSubject: bulk {i}\r\n\r\n"), text: "x\r\n".into() });
            }
            let _ = wr.write_all(b"* OK IMAP4rev1 fake ready\r\n").await;
            if mode == Mode::Garbage {
                let _ = wr.write_all(b"\x00\xff nonsense\r\n").await;
            }
            loop {
                let mut line = String::new();
                if rd.read_line(&mut line).await.unwrap_or(0) == 0 {
                    break;
                }
                let line = line.trim_end().to_string();
                log.push(line.clone());
                let (tag, cmd) = line.split_once(' ').unwrap_or((&line, ""));
                let up = cmd.to_ascii_uppercase();
                if mode == Mode::Hang && up.starts_with("LOGIN") {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                } else if up.starts_with("LOGIN") {
                    let ok = cmd == format!("LOGIN \"me@x.com\" \"pw\\\\\\\"secret\"");
                    let _ = wr.write_all(if ok { format!("{tag} OK LOGIN done\r\n") } else { format!("{tag} NO [AUTHENTICATIONFAILED] nope\r\n") }.as_bytes()).await;
                } else if up.starts_with("SELECT") {
                    let reply = if mode == Mode::SelectBad { format!("{tag} BAD no\r\n") } else { format!("* {} EXISTS\r\n{tag} OK [READ-WRITE] done\r\n", msgs.len()) };
                    let _ = wr.write_all(reply.as_bytes()).await;
                } else if up.starts_with("UID SEARCH ALL") {
                    let uids: Vec<String> = msgs.iter().map(|m| m.uid.to_string()).collect();
                    let _ = wr.write_all(format!("* SEARCH {}\r\n{tag} OK done\r\n", uids.join(" ")).as_bytes()).await;
                } else if up.starts_with("UID FETCH") {
                    let set = cmd.split(' ').nth(2).unwrap_or("");
                    let mut out: Vec<u8> = Vec::new();
                    for (seq, m) in msgs.iter().enumerate().filter(|(_, m)| set.split(',').any(|u| u == m.uid.to_string())) {
                        let lit = match mode {
                            Mode::HugeLiteral => b"BODY[TEXT]<0> {99999999}\r\n".to_vec(),
                            Mode::LongLine => { let mut v = b"X-JUNK ".to_vec(); v.extend(std::iter::repeat(b'a').take(20_000)); v.extend_from_slice(b"\r\n"); v }
                            _ => Vec::new(),
                        };
                        out.extend_from_slice(format!("* {} FETCH (", seq + 1).as_bytes());
                        if !lit.is_empty() { out.extend_from_slice(&lit); let _ = wr.write_all(&out).await; out.clear(); break; }
                        // Deliberately not in the order the client asked for.
                        out.extend_from_slice(format!("BODY[TEXT]<0> {{{}}}\r\n{}", m.text.len(), m.text).as_bytes());
                        out.extend_from_slice(format!(" UID {} FLAGS ({}) INTERNALDATE \"{}\" ", m.uid, m.flags, m.date).as_bytes());
                        out.extend_from_slice(format!("BODY[HEADER.FIELDS (FROM SUBJECT DATE CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] {{{}}}\r\n{})\r\n", m.header.len(), m.header).as_bytes());
                    }
                    out.extend_from_slice(format!("{tag} OK done\r\n").as_bytes());
                    let _ = wr.write_all(&out).await;
                } else if up.starts_with("UID STORE") {
                    let _ = wr.write_all(format!("* 1 FETCH (FLAGS (\\Seen))\r\n{tag} OK stored\r\n").as_bytes()).await;
                } else if up.starts_with("LOGOUT") {
                    let _ = wr.write_all(format!("* BYE\r\n{tag} OK bye\r\n").as_bytes()).await;
                    break;
                } else {
                    let _ = wr.write_all(format!("{tag} BAD unknown\r\n").as_bytes()).await;
                }
            }
            let mut sink = Vec::new();
            let _ = rd.read_to_end(&mut sink).await;
            let _ = tx.send(log);
        });
    });
    Server { port: prx.recv().unwrap(), transcript: rx }
}

fn cfg(port: u16) -> ImapConfig {
    ImapConfig { host: "localhost".into(), port, user: "me@x.com".into(), password: "pw\\\"secret".into() }
}

const NOW: i64 = 1_784_278_800 + 3 * 60; // 2026-07-17T09:03Z + ... see minutes assertions below

fn now_for(date_epoch: i64, minutes: i64) -> i64 {
    date_epoch + minutes * 60
}

// 17-Jul-2026 11:59:00 +0000
const T7: i64 = 1_784_289_540;

#[test]
fn the_inbox_is_fetched_over_real_tls_decoded_and_newest_first() {
    let p = pki();
    let s = spawn_server(&p, Mode::Normal, 0);
    let out = run(fetch_inbox(&cfg(s.port), &roots_of(&p.root_der), now_for(T7, 5), &Limits::default())).unwrap();
    assert_eq!(out.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![7, 5, 3], "newest uid first");
    let (m7, m5, m3) = (&out[0], &out[1], &out[2]);
    assert_eq!((m5.from_name.as_str(), m5.address.as_str()), ("Lucía Fernández", "lucia@example.com"));
    assert_eq!(m5.subject, "Reunión del jueves");
    assert_eq!(m5.preview, "Te confirmo la reunión del jueves.", "quoted-printable with a soft break");
    assert!(!m5.read && !m7.read && m3.read, "\\Seen decides read");
    assert_eq!((m3.from_name.as_str(), m3.address.as_str(), m3.subject.as_str()), ("Martín Gómez", "martin@example.com", "Re: presupuesto"));
    assert_eq!(m3.preview, "Gracias por la propuesta. Lo charlamos mañana.");
    assert_eq!((m7.from_name.as_str(), m7.address.as_str()), ("noreply@example.com", "noreply@example.com"), "no display name → the address");
    assert_eq!(m7.preview, "Hola desde base64", "multipart/alternative: the text/plain part, decoded");
    assert_eq!(m7.minutes_ago, 5);
    assert_eq!(m5.minutes_ago, 5 + 29);
    assert_eq!(m3.minutes_ago, 5 + 119);
}

#[test]
fn reading_never_sets_seen_and_the_session_is_a_fixed_closed_script() {
    let p = pki();
    let s = spawn_server(&p, Mode::Normal, 0);
    run(fetch_inbox(&cfg(s.port), &roots_of(&p.root_der), NOW, &Limits::default())).unwrap();
    let log = s.transcript.recv().unwrap();
    let cmds: Vec<&str> = log.iter().map(|l| l.split_once(' ').unwrap().1).collect();
    assert_eq!(cmds[0], "LOGIN \"me@x.com\" \"pw\\\\\\\"secret\"", "quoted-string escaping of \\ and \"");
    assert_eq!(cmds[1], "SELECT INBOX");
    assert_eq!(cmds[2], "UID SEARCH ALL");
    assert!(cmds[3].starts_with("UID FETCH 3,5,7 (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.2048>)"), "{}", cmds[3]);
    assert!(!log.iter().any(|l| l.contains("STORE") || l.contains("BODY[")), "no flag change, no non-PEEK fetch: {log:?}");
    assert_eq!(cmds[4], "LOGOUT");
}

#[test]
fn only_the_newest_twenty_are_requested() {
    let p = pki();
    let s = spawn_server(&p, Mode::Normal, 40);
    let out = run(fetch_inbox(&cfg(s.port), &roots_of(&p.root_der), NOW, &Limits::default())).unwrap();
    assert_eq!(out.len(), 20);
    assert_eq!(out[0].uid, 139);
    let log = s.transcript.recv().unwrap();
    assert_eq!(log.iter().find(|l| l.contains("UID FETCH")).unwrap().split(' ').nth(3).unwrap().split(',').count(), 20);
}

#[test]
fn mark_read_stores_seen_for_exactly_that_uid() {
    let p = pki();
    let s = spawn_server(&p, Mode::Normal, 0);
    run(mark_read(&cfg(s.port), &roots_of(&p.root_der), 5, &Limits::default())).unwrap();
    let log = s.transcript.recv().unwrap();
    assert!(log.iter().any(|l| l.ends_with("UID STORE 5 +FLAGS (\\Seen)")), "{log:?}");
    assert_eq!(log.iter().filter(|l| l.contains("STORE")).count(), 1);
}

#[test]
fn a_certificate_the_client_does_not_trust_is_refused_before_any_credential_is_sent() {
    let p = pki();
    let other = pki();
    let s = spawn_server(&p, Mode::Normal, 0);
    assert_eq!(run(fetch_inbox(&cfg(s.port), &roots_of(&other.root_der), NOW, &Limits::default())), Err(ImapError::Tls));
    let log = s.transcript.recv().unwrap();
    assert!(!log.iter().any(|l| l.contains("LOGIN")), "{log:?}");
}

#[test]
fn a_name_the_certificate_does_not_cover_is_refused() {
    let p = pki();
    let s = spawn_server(&p, Mode::Normal, 0);
    let mut c = cfg(s.port);
    c.host = "127.0.0.1".into();
    assert_eq!(run(fetch_inbox(&c, &roots_of(&p.root_der), NOW, &Limits::default())), Err(ImapError::Tls));
}

#[test]
fn a_wrong_password_is_auth_and_the_server_text_never_comes_back() {
    let p = pki();
    let s = spawn_server(&p, Mode::Normal, 0);
    let mut c = cfg(s.port);
    c.password = "other".into();
    assert_eq!(run(fetch_inbox(&c, &roots_of(&p.root_der), NOW, &Limits::default())), Err(ImapError::Auth));
    drop(s);
}

#[test]
fn credentials_that_could_inject_commands_never_leave_the_machine() {
    let p = pki();
    let s = spawn_server(&p, Mode::Normal, 0);
    for bad in ["a\r\nb", "a\nb", "a\0b", ""] {
        let mut c = cfg(s.port);
        c.user = bad.into();
        assert_eq!(run(fetch_inbox(&c, &roots_of(&p.root_der), NOW, &Limits::default())), Err(ImapError::Protocol), "{bad:?}");
        let mut c = cfg(s.port);
        c.password = bad.into();
        assert_eq!(run(fetch_inbox(&c, &roots_of(&p.root_der), NOW, &Limits::default())), Err(ImapError::Protocol), "{bad:?}");
    }
}

#[test]
fn hostile_servers_are_bounded() {
    let p = pki();
    for (mode, want) in [
        (Mode::HugeLiteral, ImapError::TooLarge),
        (Mode::LongLine, ImapError::TooLarge),
        (Mode::Garbage, ImapError::Protocol),
        (Mode::SelectBad, ImapError::Protocol),
    ] {
        let s = spawn_server(&p, mode, 0);
        assert_eq!(run(fetch_inbox(&cfg(s.port), &roots_of(&p.root_der), NOW, &Limits::default())), Err(want));
    }
    let s = spawn_server(&p, Mode::Hang, 0);
    let limits = Limits { timeout: std::time::Duration::from_millis(300), ..Limits::default() };
    let started = std::time::Instant::now();
    assert_eq!(run(fetch_inbox(&cfg(s.port), &roots_of(&p.root_der), NOW, &limits)), Err(ImapError::Timeout));
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}

#[test]
fn a_dead_port_is_a_network_error() {
    let p = pki();
    assert_eq!(run(fetch_inbox(&cfg(1), &roots_of(&p.root_der), NOW, &Limits::default())), Err(ImapError::Network));
}

#[test]
fn the_password_never_shows_in_debug() {
    assert!(!format!("{:?}", cfg(993)).contains("secret"));
}

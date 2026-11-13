// Adapted from Coucou windows/src-tauri/src/phone_link/server.rs @71b773f, Copyright (c) 2026 Rhytam Biswas, MIT
// (the phone link files carry that holder; protocol: Coucou docs/ANDROID_LINK.md).
//
// The phone link's TLS server (protocol v1), slice A: the way in (admission, TLS, hello/token/version) and the
// keep-alive. Sessions, approvals and the optional capabilities are added by the next slices through the hub.
//
// What it refuses, on purpose:
//   * anyone who is not on the local network (private, loopback, link-local);
//   * a first message that is not a valid `hello` within a few seconds;
//   * a wrong token or protocol version (after a short pause, so guessing is slow);
//   * a line over 64 KiB, or silence for 20 minutes;
//   * more than a handful of connections at once (admission.rs).
// Not ported: the relay entry (`admit_relay`) and the cloud relay (S5 spending rule).

use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio_rustls::rustls::version::{TLS12, TLS13};
use tokio_rustls::rustls::{crypto::ring as ring_provider, ServerConfig};
use tokio_rustls::TlsAcceptor;

use super::admission::{Admission, Ticket};
use super::asks;
use super::constant_eq;
use super::hub::Hub;
use super::ids;
use super::pairing::Identity;

pub const PROTOCOL: u64 = 1;
pub const MAX_LINE: usize = 64 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// An authenticated phone may be silent this long: a sleeping phone checks in every few minutes (Doze may stretch
/// that to about 15). Bounded, so a vanished phone does not hold one of the 8 places for hours.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// Pause before answering a wrong token.
const AUTH_PENALTY: Duration = Duration::from_millis(400);

/// Which optional capabilities the desktop offers right now (§6.0), read again for every connection, so a switch
/// changes the very next `welcome`.
///
/// Whether `details` is offered always while the link is on, or sits behind its own Ajustes switch, is the human's
/// decision and lives entirely in the implementation of `offered`: `link.rs` answers what the user chose, this trait
/// only says what the wire carries. Offering nothing (the default) is today's behaviour: a plain v1 welcome.
pub trait Features: Send + Sync {
    /// The caps the desktop can serve right now, named with `ids::CAPS`' wire values. Read on every `hello`;
    /// anything unknown is ignored, and only what both sides name is ever in force.
    fn offered(&self) -> Vec<&'static str> {
        Vec::new()
    }
}

/// What the desktop does with a phone's `decision` or `answer` (§8, §9): the one seam between the phone and the
/// agent, and the whole of what this module knows about it.
///
/// It is synchronous like [`Features`], because the link's thread must not own the agent's threads: the implementation
/// hands the decision to whatever really holds the pending request (the relay that asked for the approval, the agent
/// waiting on the question) and answers — `Ok` only when the agent took it. A refusal is silence on the wire: the
/// request stays pending and decidable, and `approvalResolved` is never sent for it (§8.3, §9.2).
///
/// The default implementation refuses everything, so a desktop that has not wired the seam behaves exactly as before
/// this slice: `decision`s and `answer`s are ignored (`link.rs`).
pub trait Decisions: Send + Sync {
    /// Apply an approval decision. `Ok` means the agent has it.
    fn decide(&self, fingerprint: &str, allow: bool) -> Result<(), ()>;
    /// Hand the labels of every question, in the order the questions were asked (§9.2).
    fn answer(&self, fingerprint: &str, picks: Vec<Vec<String>>) -> Result<(), ()>;
}

/// The capability set in force on one connection: what the phone asked for ∩ what the desktop offers (§6.0, «only
/// in force when both sides name it»), in the contract's canonical order, unknown strings dropped on either side and
/// never duplicated.
pub fn in_force(asked: &[&str], offered: &[&str]) -> Vec<&'static str> {
    ids::CAPS
        .iter()
        .copied()
        .filter(|cap| asked.iter().any(|a| a == cap) && offered.iter().any(|o| o == cap))
        .collect()
}

/// A line to write, or the last one (an `error`) and close.
pub enum Out {
    Line(Arc<str>),
    Close { code: &'static str, message: &'static str },
}

/// What a connection needs to know about the desktop.
pub struct Shared {
    pub hub: Arc<Hub>,
    /// Replaced when the user pairs again; read for every `hello`.
    pub token: Mutex<String>,
    pub name: String,
    pub features: Arc<dyn Features>,
    /// The way from a phone's `decision` / `answer` to the agent (§8, §9).
    pub decisions: Arc<dyn Decisions>,
    admission: Arc<Admission>,
}

impl Shared {
    /// The link with nothing behind the seam: a `decision` or an `answer` is ignored, which is what a desktop with no
    /// approvals to offer does.
    pub fn with_hub(hub: Arc<Hub>, token: String, name: String, features: Arc<dyn Features>) -> Arc<Shared> {
        Shared::with_hub_and_decisions(hub, token, name, features, Arc::new(super::link::RefuseDecisions))
    }

    pub fn with_hub_and_decisions(
        hub: Arc<Hub>,
        token: String,
        name: String,
        features: Arc<dyn Features>,
        decisions: Arc<dyn Decisions>,
    ) -> Arc<Shared> {
        Arc::new(Shared { hub, token: Mutex::new(token), name, features, decisions, admission: Admission::new() })
    }
}

/// A running server; dropping it does not stop it, `stop` does.
pub struct Handle {
    accept: JoinHandle<()>,
    open: Arc<tokio::sync::Notify>,
}

impl Handle {
    /// Stops accepting and closes every open link.
    pub fn stop(self) {
        self.accept.abort();
        self.open.notify_waiters();
    }
}

/// TLS 1.2 and 1.3, the certificate made once. `ring` is named explicitly so nothing depends on a process-wide
/// default provider.
pub fn tls_acceptor(identity: &Identity) -> Result<TlsAcceptor, String> {
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(identity.key_der.clone()));
    let config = ServerConfig::builder_with_provider(Arc::new(ring_provider::default_provider()))
        .with_protocol_versions(&[&TLS13, &TLS12])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(identity.cert_der.clone())], key)
        .map_err(|e| e.to_string())?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// Accepts connections until stopped. Must be called inside the async runtime.
pub fn serve(listener: TcpListener, acceptor: TlsAcceptor, shared: Arc<Shared>) -> Handle {
    let open = Arc::new(tokio::sync::Notify::new());
    let stop = open.clone();
    let accept = tokio::spawn(async move {
        loop {
            let (tcp, peer) = match listener.accept().await {
                Ok(x) => x,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
            };
            if !is_local(peer.ip()) {
                continue; // dropped before any byte is read
            }
            // The slot is held until the connection ends (the ticket drops), whatever way it ends.
            let Some(ticket) = shared.admission.admit(peer.ip()) else { continue };
            let (shared, acceptor, stop) = (shared.clone(), acceptor.clone(), stop.clone());
            tokio::spawn(async move {
                let _ = tcp.set_nodelay(true);
                tokio::select! {
                    _ = one_connection(tcp, acceptor, &shared, Arc::new(ticket)) => {}
                    _ = stop.notified() => {}
                }
            });
        }
    });
    Handle { accept, open }
}

/// The local network only: private, loopback and link-local addresses.
pub fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_local(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 /* fc00::/7 */ || (first & 0xffc0) == 0xfe80 /* fe80::/10 */
        }
    }
}

async fn one_connection(tcp: TcpStream, acceptor: TlsAcceptor, shared: &Arc<Shared>, ticket: Arc<Ticket>) {
    let Ok(Ok(tls)) = tokio::time::timeout(ticket.wait(), acceptor.accept(tcp)).await else { return };
    run_with(tls, shared, Some(ticket)).await;
}

/// The conversation over a byte stream (TLS in the app), holding its admission ticket until it ends.
pub(super) async fn run_with<S>(stream: S, shared: &Arc<Shared>, ticket: Option<Arc<Ticket>>)
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (read, mut write) = tokio::io::split(stream);
    let (tx, mut rx) = mpsc::channel::<Out>(64);

    let reader = tokio::spawn(read_loop(read, tx, shared.clone(), ticket));

    while let Some(out) = rx.recv().await {
        let (line, last) = match out {
            Out::Line(l) => (l.to_string(), false),
            Out::Close { code, message } => (json!({ "type": "error", "code": code, "message": message }).to_string(), true),
        };
        if write.write_all(line.as_bytes()).await.is_err() || write.write_all(b"\n").await.is_err() || write.flush().await.is_err() || last {
            break;
        }
    }
    reader.abort();
    let _ = write.shutdown().await;
}

async fn read_loop<R>(read: R, tx: mpsc::Sender<Out>, shared: Arc<Shared>, ticket: Option<Arc<Ticket>>)
where
    R: AsyncRead + Unpin,
{
    let mut lines = LineReader::new(read);
    let say = |v: serde_json::Value| tx.send(Out::Line(v.to_string().into()));

    // 1. hello
    let hello_wait = ticket.as_ref().map_or(HELLO_TIMEOUT, |t| t.wait());
    let hello = match tokio::time::timeout(hello_wait, lines.next()).await {
        Ok(Next::Line(l)) => l,
        Ok(Next::TooLong) => {
            let _ = tx.send(Out::Close { code: "protocol", message: "line too long" }).await;
            return;
        }
        _ => return,
    };
    let Ok(hello) = serde_json::from_slice::<serde_json::Value>(&hello) else { return };
    if hello["type"] != "hello" {
        return;
    }
    let sent_token = hello["token"].as_str().unwrap_or("").to_string();
    let expected = shared.token.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let good = hello["v"].as_u64() == Some(PROTOCOL) && constant_eq(sent_token.as_bytes(), expected.as_bytes());
    if !good {
        tokio::time::sleep(AUTH_PENALTY).await;
        let _ = tx.send(Out::Close { code: "auth", message: "bad token or version" }).await;
        return;
    }
    // A valid hello: this connection no longer counts against the unauthenticated limits, and the address is
    // remembered so a flood from elsewhere cannot keep this phone out.
    if let Some(t) = &ticket {
        t.authenticated();
    }
    // §6.0: what the phone can use ∩ what the desktop offers right now, in the contract's canonical order. Read
    // again on every connection, so a switch changes the very next welcome. The welcome names that intersection and
    // not the whole list of switches: that is what the reference desktop does (`tools/dev-desktop.mjs` computes its
    // `offered` from the phone's `caps` too), and it is the stricter of the two readings of §6.0.
    let asked: Vec<&str> = hello["caps"].as_array().map(|a| a.iter().filter_map(serde_json::Value::as_str).collect()).unwrap_or_default();
    let in_force = in_force(&asked, &shared.features.offered());
    let mut welcome = json!({ "type": "welcome", "v": PROTOCOL, "desktop": shared.name, "os": std::env::consts::OS });
    if !in_force.is_empty() {
        // Omitted entirely when empty, exactly as the phone omits an empty hello `caps`.
        welcome["caps"] = json!(in_force);
    }
    let _ = say(welcome).await;
    // The first line after the welcome is the current sessions, rendered for this connection's capabilities; later
    // changes arrive through the hub, which keeps one line per capability set.
    let (id, evicted) = shared.hub.subscribe(
        tx.clone(),
        now_ms(),
        in_force.contains(&ids::CAP_DETAILS),
        in_force.contains(&ids::CAP_ANSWERS),
        in_force.contains(&ids::CAP_USAGE),
    );

    // 2. the conversation
    loop {
        let line = match tokio::time::timeout(IDLE_TIMEOUT, lines.next()).await {
            Ok(Next::Line(l)) => l,
            Ok(Next::TooLong) => {
                let _ = tx.send(Out::Close { code: "protocol", message: "line too long" }).await;
                break;
            }
            _ => break, // closed, failed or silent for too long
        };
        let Ok(msg) = serde_json::from_slice::<serde_json::Value>(&line) else { break };
        // The hub stopped sending to this phone because it could not keep up: close, and the phone reconnects
        // to a fresh picture (it pings every 20 s).
        if evicted.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
        match msg["type"].as_str() {
            Some("ping") => {
                let _ = say(json!({ "type": "pong" })).await;
            }
            Some("bye") => break,
            Some("decision") => decide(&shared, &msg),
            Some("answer") => answer(&shared, &msg, in_force.contains(&ids::CAP_ANSWERS)),
            _ => {} // unknown types are ignored
        }
    }
    shared.hub.unsubscribe(id);
}

/// A `decision` (§6, §8): only for a request that is still pending — an unknown, already resolved or expired one is
/// ignored, with nothing sent back — and `approvalResolved` only after the agent really took the decision.
fn decide(shared: &Arc<Shared>, msg: &serde_json::Value) {
    let Some((fingerprint, verdict)) = asks::parse_decision(msg) else { return };
    let Some(ask) = shared.hub.pending_ask(&fingerprint) else { return };
    // A question is answered, never decided: the two messages do not stand in for each other.
    if !ask.is_approval() {
        return;
    }
    let allow = verdict == asks::Verdict::Allow;
    if shared.decisions.decide(&fingerprint, allow).is_ok() {
        shared.hub.resolve(&fingerprint);
    }
}

/// An `answer` (§6, §9): only with `answers` in force on this connection, only for a question that is still pending,
/// and only when every pick passes §9.2's table. Anything else is silence, because a refusal is not a state the phone
/// shows — the question simply stays until it is answered or expires.
fn answer(shared: &Arc<Shared>, msg: &serde_json::Value, answers: bool) {
    if !answers {
        return;
    }
    let Some((fingerprint, picks)) = asks::parse_answer(msg) else { return };
    let Some(ask) = shared.hub.pending_ask(&fingerprint) else { return };
    if ask.is_approval() {
        return;
    }
    let Some(questions) = ask.questions() else { return };
    if !asks::valid_picks(questions, &picks) {
        return;
    }
    if shared.decisions.answer(&fingerprint, picks).is_ok() {
        shared.hub.resolve(&fingerprint);
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

enum Next {
    Line(Vec<u8>),
    TooLong,
    Closed,
}

/// Newline-delimited lines, none longer than MAX_LINE.
struct LineReader<R> {
    inner: BufReader<R>,
}

impl<R: AsyncRead + Unpin> LineReader<R> {
    fn new(read: R) -> Self {
        Self { inner: BufReader::new(read) }
    }

    async fn next(&mut self) -> Next {
        loop {
            let mut buf = Vec::new();
            // Never reads more than one byte past the limit, however much is sent.
            let mut limited = (&mut self.inner).take(MAX_LINE as u64 + 2);
            match limited.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => return Next::Closed,
                Ok(_) => {}
            }
            if buf.last() != Some(&b'\n') {
                // No newline within the limit: too long (or the phone vanished mid-line).
                return if buf.len() > MAX_LINE { Next::TooLong } else { Next::Closed };
            }
            buf.pop();
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            if buf.len() > MAX_LINE {
                return Next::TooLong;
            }
            if !buf.is_empty() {
                return Next::Line(buf);
            }
        }
    }
}

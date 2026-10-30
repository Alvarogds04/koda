//! In-process fake bridge backend — test/probe scaffolding, unit M3.
//!
//! A tiny std-only HTTP/1.1 server on `127.0.0.1:0` that speaks the SAME
//! contract `src/sb_bridge/api.py` enforces for the approval lane:
//! - `GET /` mints the session cookie (`Set-Cookie: sb_session=…; Path=/`),
//! - every `/api/*` answer requires the exact `tailscale-user-login` header
//!   (else 401, api.py `authenticate`) and, for POST, `X-SB-Request: 1`
//!   (else 403 `request must be signed`),
//! - `GET /api/health`, `GET /api/proposals?status=pending`,
//!   `POST …/execute` (bound to the proposal's `payload_hash`: mismatch →
//!   409, api.py `TodoistBridge.approve`), `POST …/reject`.
//!
//! It is scripted per test (status ladders, network drops, stalls) and logs
//! every request WITHOUT ever logging credential values: only method, path,
//! whether a session cookie was present, whether the confirmation header was
//! present, and the payload hash a POST carried (a hash, not a secret).
//!
//! This module exists for `tests/` and the `ABITO_PROBE` approval step only;
//! it is never started unless a test or the probe explicitly starts it, and
//! it binds only a loopback ephemeral port.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

/// The session value the fake mints. Obviously synthetic; never a real one.
const SESSION_VALUE: &str = "fake-sb-session-32";

/// One observed request (credential VALUES are never recorded).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEntry {
    pub method: String,
    pub path: String,
    /// A `Cookie` header carrying `sb_session=` was present.
    pub session_cookie: bool,
    /// The `X-SB-Request: 1` confirmation header was present.
    pub x_sb_request: bool,
    /// `payload_hash` an execute body carried, if any.
    pub payload_hash: Option<String>,
}

/// Scripting for one fake instance. Defaults: mint a cookie, require it on
/// `/api/*`, behave like a healthy api.py lane.
#[derive(Clone)]
pub struct FakeConfig {
    /// Exact `tailscale-user-login` the fake accepts (401 otherwise).
    pub login: String,
    /// Proposals served by `GET /api/proposals?status=pending`.
    pub proposals: Vec<serde_json::Value>,
    /// Answer `GET /` with a `Set-Cookie` (false → legacy `cookie absent
    /// stops after one mint` script).
    pub mint_cookie: bool,
    /// First N `/api/*` calls answer 403 regardless (the 403 ladder).
    pub scripted_403: u32,
    /// Every `/api/*` call answers 401 (failed/foreign login scenario).
    pub force_401: bool,
    /// `GET /` answers this status instead of 200 (failed initial mint).
    pub mint_status: Option<u16>,
    /// Sleep before answering (deadline/timeout scripts).
    pub stall: Option<Duration>,
    /// Accept `/api/*` connections and close them with no response (network
    /// failure mid-request, after a successful mint).
    pub drop_api_connections: bool,
    /// Hash the fake expects at `/execute` (default: the proposal's own
    /// `payload_hash`); a mismatch answers 409 — the binding rule.
    pub stored_hash: Option<String>,
}

impl Default for FakeConfig {
    fn default() -> Self {
        FakeConfig {
            login: String::new(),
            proposals: Vec::new(),
            mint_cookie: true,
            scripted_403: 0,
            force_401: false,
            mint_status: None,
            stall: None,
            drop_api_connections: false,
            stored_hash: None,
        }
    }
}

impl FakeConfig {
    /// Cookie required on `/api/*` whenever the fake mints one — a healthy
    /// lane always sends it back (api.py `session.admits`).
    fn cookie_required(&self) -> bool {
        self.mint_cookie
    }
}

struct Inner {
    config: FakeConfig,
    origin: String,
    log: Mutex<Vec<LogEntry>>,
    accepted: AtomicU32,
    scripted_hits: AtomicU32,
    proposals: Mutex<Vec<serde_json::Value>>,
    running: Arc<AtomicBool>,
    listener: Mutex<Option<TcpListener>>,
    accept_thread: Mutex<Option<JoinHandle<()>>>,
}

/// The running fake: `origin()` is what `ABITO_BRIDGE_BASE` points at.
pub struct FakeBackend {
    inner: Arc<Inner>,
}

impl FakeBackend {
    pub fn start(config: FakeConfig) -> Arc<FakeBackend> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .expect("fake bridge binds a loopback ephemeral port");
        let port = listener.local_addr().expect("bound addr").port();
        listener
            .set_nonblocking(true)
            .expect("fake bridge listener nonblocking");
        let inner = Arc::new(Inner {
            proposals: Mutex::new(config.proposals.clone()),
            config,
            origin: format!("http://127.0.0.1:{port}"),
            log: Mutex::new(Vec::new()),
            accepted: AtomicU32::new(0),
            scripted_hits: AtomicU32::new(0),
            running: Arc::new(AtomicBool::new(true)),
            listener: Mutex::new(Some(listener)),
            accept_thread: Mutex::new(None),
        });
        let backend = Arc::new(FakeBackend {
            inner: Arc::clone(&inner),
        });
        let thread_inner = Arc::clone(&inner);
        let handle = std::thread::spawn(move || accept_loop(thread_inner));
        *backend.inner.accept_thread.lock().expect("accept thread") = Some(handle);
        backend
    }

    pub fn origin(&self) -> String {
        self.inner.origin.clone()
    }

    pub fn log(&self) -> Vec<LogEntry> {
        self.inner.log.lock().expect("fake log").clone()
    }

    /// Total accepted connections (dropped ones count too): a retry is a
    /// NEW connection, so "never retried" is observable as a count.
    pub fn accepted(&self) -> u32 {
        self.inner.accepted.load(Ordering::SeqCst)
    }

    pub fn posts(&self) -> Vec<LogEntry> {
        self.log()
            .into_iter()
            .filter(|entry| entry.method == "POST")
            .collect()
    }

    /// Swap the served proposal list (poll scripts).
    pub fn set_proposals(&self, proposals: Vec<serde_json::Value>) {
        *self.inner.proposals.lock().expect("proposals") = proposals;
    }

    pub fn stop(&self) {
        self.inner.running.store(false, Ordering::SeqCst);
        if let Ok(stream) = TcpStream::connect(self.inner.origin.trim_start_matches("http://")) {
            drop(stream); // wake the non-blocking accept loop
        }
        if let Some(handle) = self
            .inner
            .accept_thread
            .lock()
            .expect("accept thread")
            .take()
        {
            let _ = handle.join();
        }
    }
}

impl Drop for FakeBackend {
    fn drop(&mut self) {
        self.inner.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self
            .inner
            .accept_thread
            .lock()
            .expect("accept thread")
            .take()
        {
            let _ = handle.join();
        }
    }
}

fn accept_loop(inner: Arc<Inner>) {
    while inner.running.load(Ordering::SeqCst) {
        let accepted = {
            let guard = inner.listener.lock().expect("listener");
            match guard.as_ref().expect("listener alive").accept() {
                Ok((stream, _)) => Some(stream),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => None,
                Err(_) => None,
            }
        };
        match accepted {
            Some(stream) => {
                inner.accepted.fetch_add(1, Ordering::SeqCst);
                let thread_inner = Arc::clone(&inner);
                std::thread::spawn(move || handle_connection(thread_inner, stream));
            }
            None => std::thread::sleep(Duration::from_millis(2)),
        }
    }
}

fn handle_connection(inner: Arc<Inner>, mut stream: TcpStream) {
    let Some(request) = read_request(&mut stream) else {
        return;
    };
    if inner.config.drop_api_connections && request.path.starts_with("/api/") {
        // The request ARRIVED (it is logged) and got no response at all:
        // the client observes a transport failure, not a status.
        log_request(&inner, &request, None);
        drop(stream);
        return;
    }
    let (response, payload_hash) = respond(&inner, &request);
    // Arrival is logged BEFORE any scripted stall: the log records what
    // reached the fake, not when the fake chose to answer.
    log_request(&inner, &request, payload_hash);
    if let Some(stall) = inner.config.stall {
        std::thread::sleep(stall);
    }
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    // `Connection: close` — one request per connection, as the client asks.
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let split = loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position;
        }
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > 64 * 1024 {
            return None;
        }
    };
    let head = String::from_utf8(buffer[..split].to_vec()).ok()?;
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split(' ');
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length: usize = headers
        .get("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let mut body = buffer[split + 4..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);
    Some(Request {
        method,
        path,
        headers,
        body: String::from_utf8(body).unwrap_or_default(),
    })
}

fn respond(inner: &Inner, request: &Request) -> (String, Option<String>) {
    // `GET /` — the webapp mints the session cookie on the root serve.
    if request.method == "GET" && request.path == "/" {
        let status = inner.config.mint_status.unwrap_or(200);
        if status != 200 {
            return (http_response(status, "text/plain", "mint failed"), None);
        }
        let response = http_response(200, "text/html", "<html>mint</html>");
        return (
            if inner.config.mint_cookie {
                with_cookie(response)
            } else {
                response
            },
            None,
        );
    }
    if !request.path.starts_with("/api/") {
        return (
            http_response(404, "application/json", "{\"detail\":\"not found\"}"),
            None,
        );
    }

    // api.py `authenticate()` middleware for `/api/*`.
    let login_ok = request
        .headers
        .get("tailscale-user-login")
        .map(String::as_str)
        == Some(inner.config.login.as_str());
    let has_session = request
        .headers
        .get("cookie")
        .is_some_and(|value| value.contains(&format!("sb_session={SESSION_VALUE}")));
    let signed_ok = request.headers.get("x-sb-request").map(String::as_str) == Some("1");

    if inner.config.force_401 || !login_ok {
        return (
            http_response(401, "application/json", "{\"detail\":\"authentication required\"}"),
            None,
        );
    }
    // Scripted rejections: the first N /api/ calls answer 403 regardless of
    // cookies — the legacy ladder's "known rejected requests".
    if inner.config.scripted_403 > 0
        && inner.scripted_hits.fetch_add(1, Ordering::SeqCst) < inner.config.scripted_403
    {
        return (
            http_response(403, "application/json", "{\"detail\":\"approval authorization required\"}"),
            None,
        );
    }
    if inner.config.cookie_required() && !has_session {
        return (
            http_response(403, "application/json", "{\"detail\":\"approval authorization required\"}"),
            None,
        );
    }
    if request.method != "GET" && !signed_ok {
        return (
            http_response(403, "application/json", "{\"detail\":\"request must be signed\"}"),
            None,
        );
    }

    let (route, query) = request.path.split_once('?').unwrap_or((&request.path, ""));
    if request.method == "GET" && route == "/api/health" {
        if !query.is_empty() {
            return (
                http_response(422, "application/json", "{\"detail\":\"invalid request\"}"),
                None,
            );
        }
        return (http_response(200, "application/json", "{\"ok\":true}"), None);
    }
    if request.method == "GET" && route == "/api/proposals" {
        if !query.is_empty() && query != "status=pending" {
            return (
                http_response(422, "application/json", "{\"detail\":\"invalid request\"}"),
                None,
            );
        }
        let proposals = inner.proposals.lock().expect("proposals").clone();
        let body = serde_json::to_string(&proposals).unwrap_or_else(|_| "[]".into());
        return (http_response(200, "application/json", &body), None);
    }
    if let Some(rest) = route.strip_prefix("/api/proposals/") {
        let Some((id, verb)) = rest.split_once('/') else {
            // `GET /api/proposals/{id}` is part of the backend contract but
            // the Electron lane never sends it (not in `BRIDGE_ROUTES`), so
            // the fake answers the route only for completeness.
            let proposals = inner.proposals.lock().expect("proposals").clone();
            return match proposals
                .iter()
                .find(|proposal| proposal.get("id").and_then(|v| v.as_str()) == Some(rest))
            {
                Some(proposal) => (
                    http_response(
                        200,
                        "application/json",
                        &serde_json::to_string(proposal).unwrap_or_default(),
                    ),
                    None,
                ),
                None => (
                    http_response(404, "application/json", "{\"detail\":\"not found\"}"),
                    None,
                ),
            };
        };
        let proposals = inner.proposals.lock().expect("proposals").clone();
        let Some(proposal) = proposals
            .iter()
            .find(|proposal| proposal.get("id").and_then(|v| v.as_str()) == Some(id))
        else {
            return (
                http_response(404, "application/json", "{\"detail\":\"not found\"}"),
                None,
            );
        };
        match (request.method.as_str(), verb) {
            ("POST", "execute") => {
                let sent = serde_json::from_str::<serde_json::Value>(&request.body)
                    .ok()
                    .and_then(|body| {
                        body.get("payload_hash")
                            .and_then(|value| value.as_str())
                            .map(str::to_string)
                    });
                let expected = inner.config.stored_hash.clone().or_else(|| {
                    proposal
                        .get("payload_hash")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                });
                if sent.is_some() && sent == expected {
                    let mut executed = proposal.clone();
                    if let Some(object) = executed.as_object_mut() {
                        object.insert("status".into(), serde_json::json!("executed"));
                    }
                    return (
                        http_response(
                            200,
                            "application/json",
                            &serde_json::to_string(&executed).unwrap_or_default(),
                        ),
                        sent,
                    );
                }
                return (
                    http_response(409, "application/json", "{\"detail\":\"proposal state conflict\"}"),
                    sent,
                );
            }
            ("POST", "reject") => {
                let mut rejected = proposal.clone();
                if let Some(object) = rejected.as_object_mut() {
                    object.insert("status".into(), serde_json::json!("rejected"));
                }
                return (
                    http_response(
                        200,
                        "application/json",
                        &serde_json::to_string(&rejected).unwrap_or_default(),
                    ),
                    None,
                );
            }
            _ => {
                return (
                    http_response(404, "application/json", "{\"detail\":\"not found\"}"),
                    None,
                );
            }
        }
    }
    (
        http_response(404, "application/json", "{\"detail\":\"not found\"}"),
        None,
    )
}

fn log_request(inner: &Inner, request: &Request, payload_hash: Option<String>) {
    inner
        .log
        .lock()
        .expect("fake log")
        .push(entry(request, payload_hash));
}

fn entry(request: &Request, payload_hash: Option<String>) -> LogEntry {
    LogEntry {
        method: request.method.clone(),
        path: request.path.clone(),
        session_cookie: request
            .headers
            .get("cookie")
            .is_some_and(|value| value.contains("sb_session=")),
        x_sb_request: request.headers.get("x-sb-request").map(String::as_str) == Some("1"),
        payload_hash,
    }
}

fn with_cookie(mut response: String) -> String {
    // Insert the Set-Cookie header right after the status line.
    if let Some(at) = response.find("\r\n").map(|index| index + 2) {
        response.insert_str(
            at,
            &format!("Set-Cookie: sb_session={SESSION_VALUE}; Path=/; HttpOnly\r\n"),
        );
    }
    response
}

fn http_response(status: u16, content_type: &str, body: &str) -> String {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        500 => "Internal Server Error",
        _ => "Status",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

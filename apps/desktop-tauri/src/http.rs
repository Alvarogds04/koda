//! HTTP client for the approval lane — unit M3.
//!
//! A deliberately small, loopback-only HTTP/1.1 client that reproduces the
//! observable behaviour of the Electron `fetch` call in `main.cjs request()`
//! (138) with exact control over the things the legacy code pinned:
//!
//! - **deadline**: one absolute 5 s budget covering connect, request write
//!   AND streaming body consumption (`main.cjs`: `setTimeout(abort, 5000)`
//!   whose comment says "The deadline covers fetch AND streaming
//!   consumption; a lying Content-Length is irrelevant"),
//! - **redirects**: never followed — `redirect: 'manual'`; a 3xx is a
//!   response the caller classifies (legacy treats it as stop-auth),
//! - **body discard**: responses whose body the legacy code would
//!   `cancel()` are discarded by shutting the connection down without
//!   reading them,
//! - **body cap**: at most 1 MiB of JSON, strictly UTF-8 decoded and
//!   strictly parsed by the caller,
//! - **abort-on-quit**: every live stream is registered and shut down the
//!   moment the lane quits (`main.cjs quit()` aborts all active
//!   controllers), which also fails any in-flight read immediately,
//! - **no TLS, no cookies jar, no redirect cache**: the bridge origin is a
//!   fixed `http://127.0.0.1` (or a test/probe override of the same shape).
//!
//! Nothing here knows about authentication or routes: `requests.rs` judges
//! what may be sent and `approval.rs` decides what a status means.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::requests::Origin;

/// `main.cjs` `deadline = setTimeout(() => controller.abort(), 5000)` (151):
/// one absolute deadline per request, covering the response body too.
pub const REQUEST_DEADLINE_MS: u64 = 5_000;

/// `main.cjs` `if (size > 1024 * 1024) throw` (170): the streamed JSON body
/// cap. A body over 1 MiB fails closed.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

/// Bound for the response head (status line + headers); a peer that never
/// sends the blank line hits this instead of buffering forever.
const MAX_HEAD_BYTES: usize = 16 * 1024;

/// The abort registry (legacy `activeRequests` + `controller.abort()` in
/// `quit()`, main.cjs 380): one instance per approval lane; `abort_all`
/// flips the quit flag and shuts every in-flight stream down, so blocking
/// reads fail at once instead of waiting out their deadline.
pub struct ActiveRequests {
    quit: AtomicBool,
    next: AtomicU64,
    streams: Mutex<Vec<(u64, TcpStream)>>,
}

impl ActiveRequests {
    pub fn new() -> Arc<Self> {
        Arc::new(ActiveRequests {
            quit: AtomicBool::new(false),
            next: AtomicU64::new(1),
            streams: Mutex::new(Vec::new()),
        })
    }

    pub fn is_quit(&self) -> bool {
        self.quit.load(Ordering::SeqCst)
    }

    /// `main.cjs quit()`: mark the lane dead and abort every active request.
    pub fn abort_all(&self) {
        self.quit.store(true, Ordering::SeqCst);
        let guard = self.streams.lock().expect("active requests lock");
        for (_, stream) in guard.iter() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }

    fn register(&self, stream: &TcpStream) -> Option<u64> {
        let clone = stream.try_clone().ok()?;
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        self.streams
            .lock()
            .expect("active requests lock")
            .push((id, clone));
        Some(id)
    }

    fn unregister(&self, id: u64) {
        self.streams
            .lock()
            .expect("active requests lock")
            .retain(|(known, _)| *known != id);
    }
}

/// One response. `body` is present only when the caller asked for the JSON
/// body AND the status was 2xx — everything else was discarded (legacy
/// `discard(response.body)`), never read.
pub struct Response {
    pub status: u16,
    pub body: Option<Vec<u8>>,
    /// First `Set-Cookie` for `sb_session` (`sb_session=VALUE`), for the
    /// lane to validate and store exactly like Chromium's jar would.
    pub set_cookie: Option<String>,
}

struct Guard<'a> {
    active: &'a ActiveRequests,
    id: Option<u64>,
}

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            self.active.unregister(id);
        }
    }
}

fn deadline_left(deadline: Instant) -> Option<Duration> {
    let left = deadline.checked_duration_since(Instant::now())?;
    (!left.is_zero()).then_some(left)
}

fn apply_deadline(stream: &TcpStream, deadline: Instant) -> Result<(), ()> {
    let left = deadline_left(deadline).ok_or(())?;
    stream.set_read_timeout(Some(left)).map_err(|_| ())?;
    stream.set_write_timeout(Some(left)).map_err(|_| ())?;
    Ok(())
}

fn read_more(stream: &mut TcpStream, buffer: &mut Vec<u8>, deadline: Instant) -> Result<usize, ()> {
    apply_deadline(stream, deadline)?;
    let mut chunk = [0u8; 4096];
    let read = stream.read(&mut chunk).map_err(|_| ())?;
    if read == 0 {
        return Err(()); // EOF mid-response: a transport failure, not a status
    }
    buffer.extend_from_slice(&chunk[..read]);
    Ok(read)
}

/// Send one request and return its response. `Err(())` is the legacy
/// `throw new Error('Unavailable')` — a transport failure (deadline, EOF,
/// protocol garbage, quit); statuses are NOT errors here.
#[allow(clippy::too_many_arguments)]
pub fn send(
    origin: &Origin,
    method: &str,
    path_query: &str,
    headers: &[(String, String)],
    body: Option<&str>,
    read_json_body: bool,
    deadline_ms: u64,
    active: &ActiveRequests,
) -> Result<Response, ()> {
    if active.is_quit() {
        return Err(());
    }
    let deadline = Instant::now() + Duration::from_millis(deadline_ms);

    // Connect (no redirect machinery, no proxy, no DNS surprises: the
    // authority is a fixed loopback origin).
    let host = origin.host.trim_start_matches('[').trim_end_matches(']');
    let address = (host, origin.port)
        .to_socket_addrs()
        .map_err(|_| ())?
        .next()
        .ok_or(())?;
    if deadline_left(deadline).is_none() {
        return Err(());
    }
    let connect_left = deadline_left(deadline).ok_or(())?;
    let mut stream = TcpStream::connect_timeout(&address, connect_left).map_err(|_| ())?;
    let guard = Guard {
        active,
        id: active.register(&stream),
    };
    if active.is_quit() {
        return Err(());
    }

    // Build the raw request. Headers are host-generated from validated
    // values only (login charset, cookie token charset, hex ids) — there is
    // no user-controlled text to escape here.
    let mut request = format!("{method} {path_query} HTTP/1.1\r\nHost: {}\r\n", origin.authority);
    for (name, value) in headers {
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    match body {
        Some(payload) => {
            request.push_str(&format!("Content-Length: {}\r\n", payload.len()));
        }
        // A bodyless POST still declares an empty body (what `fetch` does).
        None if method == "POST" => request.push_str("Content-Length: 0\r\n"),
        None => {}
    }
    request.push_str("Connection: close\r\n\r\n");
    if let Some(payload) = body {
        request.push_str(payload);
    }
    apply_deadline(&stream, deadline)?;
    stream.write_all(request.as_bytes()).map_err(|_| ())?;
    if active.is_quit() {
        return Err(());
    }

    // Response head: read until the blank line, then split RAW bytes so a
    // non-UTF-8 body prefix can never fail the head parse.
    let mut head = Vec::new();
    let split_at = loop {
        if let Some(position) = head.windows(4).position(|window| window == b"\r\n\r\n") {
            break position;
        }
        if head.len() >= MAX_HEAD_BYTES {
            return Err(());
        }
        read_more(&mut stream, &mut head, deadline)?;
        if active.is_quit() {
            return Err(());
        }
    };
    let head_text = String::from_utf8(head[..split_at].to_vec()).map_err(|_| ())?;
    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    let mut set_cookie = None;
    let mut lines = head_text.split("\r\n");
    let status_line = lines.next().ok_or(())?;
    let mut parts = status_line.split(' ');
    let version = parts.next().ok_or(())?;
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(());
    }
    let code = parts.next().ok_or(())?;
    if code.len() != 3 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(());
    }
    let status: u16 = code.parse().map_err(|_| ())?;
    if !(100..=599).contains(&status) {
        return Err(()); // legacy: status outside 100..599 → Unavailable
    }
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(());
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        match name.as_str() {
            "set-cookie" if value.starts_with("sb_session=") && set_cookie.is_none() => {
                let first_pair = value.split(';').next().unwrap_or("");
                if !first_pair.is_empty() {
                    set_cookie = Some(first_pair.to_string());
                }
            }
            "content-length" => content_length = value.parse::<usize>().ok(),
            "transfer-encoding" if value.to_ascii_lowercase().contains("chunked") => {
                chunked = true;
            }
            _ => {}
        }
    }

    // Body handling mirrors the legacy branches exactly:
    // - not reading (no JSON requested, or non-2xx) → DISCARD without reading
    //   (legacy `discard(response.body)`),
    // - reading → bounded consumption under the same absolute deadline.
    if !read_json_body || !(200..=299).contains(&status) {
        let _ = stream.shutdown(Shutdown::Both);
        return Ok(Response {
            status,
            body: None,
            set_cookie,
        });
    }
    let mut buffered = head[split_at + 4..].to_vec();
    if chunked {
        let bytes = read_chunked(&mut stream, &mut buffered, deadline)?;
        drop(guard);
        return Ok(Response {
            status,
            body: Some(bytes),
            set_cookie,
        });
    }
    if let Some(length) = content_length {
        if length > MAX_BODY_BYTES {
            return Err(());
        }
        while buffered.len() < length {
            if active.is_quit() {
                return Err(());
            }
            let mut chunk = [0u8; 4096];
            let want = (length - buffered.len()).min(chunk.len());
            apply_deadline(&stream, deadline)?;
            let read = stream.read(&mut chunk[..want]).map_err(|_| ())?;
            if read == 0 {
                return Err(()); // truncated body
            }
            buffered.extend_from_slice(&chunk[..read]);
        }
        buffered.truncate(length);
        drop(guard);
        return Ok(Response {
            status,
            body: Some(buffered),
            set_cookie,
        });
    }
    // No framing: read to EOF, capped — a lying or absent header cannot make
    // us buffer more than the legacy stream cap.
    loop {
        if active.is_quit() {
            return Err(());
        }
        let mut chunk = [0u8; 4096];
        apply_deadline(&stream, deadline)?;
        let read = stream.read(&mut chunk).map_err(|_| ())?;
        if read == 0 {
            break;
        }
        buffered.extend_from_slice(&chunk[..read]);
        if buffered.len() > MAX_BODY_BYTES {
            return Err(());
        }
    }
    drop(guard);
    Ok(Response {
        status,
        body: Some(buffered),
        set_cookie,
    })
}

fn read_line(
    stream: &mut TcpStream,
    buffer: &mut Vec<u8>,
    deadline: Instant,
) -> Result<Vec<u8>, ()> {
    loop {
        if let Some(position) = buffer.windows(2).position(|window| window == b"\r\n") {
            let line = buffer.drain(..position + 2).collect::<Vec<u8>>();
            return Ok(line[..position].to_vec());
        }
        if buffer.len() > 1024 {
            return Err(());
        }
        read_more(stream, buffer, deadline)?;
    }
}

/// Chunked decoding with the same 1 MiB cap (legacy reads raw chunk bytes
/// against the cap; decoded size is what could be published, so it is what
/// we bound).
fn read_chunked(
    stream: &mut TcpStream,
    buffered: &mut Vec<u8>,
    deadline: Instant,
) -> Result<Vec<u8>, ()> {
    let mut out: Vec<u8> = Vec::new();
    loop {
        let line = read_line(stream, buffered, deadline)?;
        let text = String::from_utf8(line).map_err(|_| ())?;
        let size_text = text.split(';').next().unwrap_or("").trim().to_string();
        let size = usize::from_str_radix(&size_text, 16).map_err(|_| ())?;
        if size == 0 {
            // Trainers: read until the terminating blank line, bounded.
            loop {
                let trailer = read_line(stream, buffered, deadline)?;
                if trailer.is_empty() {
                    break;
                }
            }
            return Ok(out);
        }
        if out.len().saturating_add(size) > MAX_BODY_BYTES {
            return Err(());
        }
        while buffered.len() < size + 2 {
            read_more(stream, buffered, deadline)?;
        }
        out.extend_from_slice(&buffered[..size]);
        buffered.drain(..size + 2); // chunk data + CRLF
    }
}

//! Serves `Helper` on `127.0.0.1:<ephemeral port>/mcp` (S1). Loopback only, no CORS, bounded reads.
//!
//! Adapted from Gentle Dot `computer/server.rs`, MIT, on std sockets instead of tiny_http (Koda has no
//! HTTP server crate). Each connection is read with a deadline and a size cap, answered once, and closed.
use super::mcp::{Helper, HttpReply, HttpRequest};
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Requests larger than this are refused: a tool call is tiny.
const MAX_BODY: usize = 64 * 1024;
const MAX_HEAD: usize = 16 * 1024;
const READ_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Endpoint {
    pub url: String,
}

/// Binds a random loopback port and serves each connection on its own thread.
pub fn start(helper: Arc<Helper>) -> std::io::Result<Endpoint> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    std::thread::Builder::new().name("window-capture-mcp".into()).spawn(move || {
        for stream in listener.incoming().flatten() {
            let helper = helper.clone();
            std::thread::spawn(move || serve(&helper, stream));
        }
    })?;
    Ok(Endpoint { url: format!("http://127.0.0.1:{port}/mcp") })
}

struct Parsed {
    method: String,
    path: String,
    authorization: Option<String>,
    body: String,
}

fn read_request(stream: &mut TcpStream) -> Option<Parsed> {
    let start = Instant::now();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_HEAD { return None; }
        let left = READ_DEADLINE.checked_sub(start.elapsed())?;
        stream.set_read_timeout(Some(left.max(Duration::from_millis(1)))).ok()?;
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 { return None; }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target) = (first.next()?.to_string(), first.next()?.to_string());
    let (mut authorization, mut length) = (None, 0usize);
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        if name.eq_ignore_ascii_case("authorization") { authorization = Some(value.trim().to_string()); }
        if name.eq_ignore_ascii_case("content-length") { length = value.trim().parse().ok()?; }
    }
    if length > MAX_BODY { return None; }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let left = READ_DEADLINE.checked_sub(start.elapsed())?;
        stream.set_read_timeout(Some(left.max(Duration::from_millis(1)))).ok()?;
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 { return None; }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length);
    let path = target.split('?').next().unwrap_or_default().to_string();
    Some(Parsed { method, path, authorization, body: String::from_utf8(body).ok()? })
}

fn serve(helper: &Helper, mut stream: TcpStream) {
    // Defense in depth: the socket is bound to loopback, but refuse any non-loopback peer anyway.
    if !matches!(stream.peer_addr(), Ok(SocketAddr::V4(a)) if a.ip().is_loopback()) { return; }
    let reply = match read_request(&mut stream) {
        Some(r) => helper.handle(&HttpRequest { method: &r.method, path: &r.path, authorization: r.authorization.as_deref(), body: &r.body }),
        None => HttpReply { status: 400, body: None },
    };
    let text = reply.body.as_ref().map(|b| b.to_string()).unwrap_or_default();
    let reason = match reply.status { 200 => "OK", 202 => "Accepted", 400 => "Bad Request", 401 => "Unauthorized", 404 => "Not Found", 405 => "Method Not Allowed", _ => "Error" };
    let mut head = format!("HTTP/1.1 {} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n", reply.status, text.len());
    if reply.body.is_some() { head.push_str("Content-Type: application/json\r\n"); }
    if reply.status == 401 { head.push_str("WWW-Authenticate: Bearer\r\n"); }
    let _ = stream.write_all(format!("{head}\r\n{text}").as_bytes());
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;

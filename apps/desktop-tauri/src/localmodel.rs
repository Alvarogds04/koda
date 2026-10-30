//! Unit U1 — the LOCAL model client: talks to an OpenAI-compatible llama.cpp
//! router on a literal loopback address and nothing else.
//!
//! Policy, enforced by construction (docs/abito-features.md §4):
//! - [`LocalEndpoint`] only accepts `http://127.0.0.1:<port>` or
//!   `http://[::1]:<port>` — a literal loopback IP, so no DNS lookup can send
//!   the request off-machine; no TLS, no path, no userinfo,
//! - one request per turn: no retry, no redirect following (any 3xx is an
//!   error), no fallback to another endpoint, alias or provider — a refused
//!   connection is `local_model_unavailable` and the turn ends there,
//! - no credential is ever attached (the local router is unkeyed); no tools,
//!   no `user` field; the body names only the selected alias,
//! - bounded: connect/idle/total deadlines, line and raw-byte caps,
//!   cancellation shuts the socket down at once.
//!
//! The pure decoders (`Chunked`, `Sse`, `parse_head`, `completion_body`) are
//! unit-tested first; the socket part is integration-tested against the
//! in-process fake (`fakemodel.rs`) in `tests/chat_local_model.rs`.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::chat::{ChatError, Message};

/// SSE line cap (one `data:` line); a router never sends lines this long.
pub const SSE_MAX_LINE: usize = 256 * 1024;
/// Raw bytes accepted for one streamed response (≫ 32,000 scalars of text
/// wrapped in JSON frames, still bounded).
pub const MAX_STREAM_BYTES: usize = 8 * 1024 * 1024;
const MAX_HEAD_BYTES: usize = 16 * 1024;
const MAX_CHUNK_BYTES: usize = 16 * 1024 * 1024;

/// Deadlines for one turn. Connect is short on purpose: a loopback router
/// that does not accept within it is down, and the chat says so.
#[derive(Debug, Clone, Copy)]
pub struct Deadlines {
    pub connect_ms: u64,
    /// Longest silence between two received bytes (prompt processing
    /// included).
    pub idle_ms: u64,
    /// Whole turn.
    pub total_ms: u64,
}

pub const DEFAULT_DEADLINES: Deadlines = Deadlines {
    connect_ms: 1_500,
    idle_ms: 90_000,
    total_ms: 300_000,
};

/// A same-machine endpoint: literal loopback IP + port, plain HTTP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalEndpoint {
    addr: SocketAddr,
    origin: String,
}

impl LocalEndpoint {
    pub fn parse(text: &str) -> Result<Self, ()> {
        let authority = text.strip_prefix("http://").ok_or(())?;
        if authority.is_empty() || authority.contains(['/', '?', '#', '@']) {
            return Err(());
        }
        let addr: SocketAddr = authority.parse().map_err(|_| ())?;
        let loopback = match addr.ip() {
            IpAddr::V4(ip) => ip == Ipv4Addr::LOCALHOST,
            IpAddr::V6(ip) => ip == Ipv6Addr::LOCALHOST,
        };
        if !loopback || addr.port() == 0 {
            return Err(());
        }
        Ok(LocalEndpoint {
            addr,
            origin: text.to_string(),
        })
    }
    pub fn origin(&self) -> &str {
        &self.origin
    }
    pub fn port(&self) -> u16 {
        self.addr.port()
    }
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }
    fn host_header(&self) -> String {
        self.origin.trim_start_matches("http://").to_string()
    }
}

/// Model alias: 1..=64 of `[A-Za-z0-9._-]`.
pub fn valid_alias(alias: &str) -> bool {
    (1..=64).contains(&alias.len())
        && alias
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

/// Decoder fault (never carries upstream text).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamFault;

// --- chunked transfer decoding ------------------------------------------------

#[derive(Debug, Default)]
enum ChunkState {
    #[default]
    Size,
    Data(usize),
    DataEnd,
    Trailer,
    Done,
}

/// Incremental `Transfer-Encoding: chunked` decoder.
#[derive(Debug, Default)]
pub struct Chunked {
    state: ChunkState,
    line: Vec<u8>,
}

impl Chunked {
    pub fn finished(&self) -> bool {
        matches!(self.state, ChunkState::Done)
    }

    pub fn push(&mut self, mut input: &[u8]) -> Result<Vec<u8>, StreamFault> {
        let mut out = Vec::new();
        while !input.is_empty() {
            match self.state {
                ChunkState::Size | ChunkState::Trailer | ChunkState::DataEnd => {
                    let byte = input[0];
                    input = &input[1..];
                    self.line.push(byte);
                    if self.line.len() > 32 {
                        return Err(StreamFault);
                    }
                    // After chunk data only an exact CRLF may follow.
                    if matches!(self.state, ChunkState::DataEnd)
                        && !b"\r\n".starts_with(&self.line)
                    {
                        return Err(StreamFault);
                    }
                    if !self.line.ends_with(b"\r\n") {
                        continue;
                    }
                    let line = std::mem::take(&mut self.line);
                    let line = &line[..line.len() - 2];
                    self.state = match self.state {
                        ChunkState::DataEnd => {
                            if !line.is_empty() {
                                return Err(StreamFault);
                            }
                            ChunkState::Size
                        }
                        ChunkState::Trailer => {
                            if line.is_empty() {
                                ChunkState::Done
                            } else {
                                ChunkState::Trailer
                            }
                        }
                        _ => {
                            let text = std::str::from_utf8(line).map_err(|_| StreamFault)?;
                            let hex = text.split(';').next().unwrap_or("").trim();
                            if hex.is_empty() || hex.len() > 8 {
                                return Err(StreamFault);
                            }
                            let size = usize::from_str_radix(hex, 16).map_err(|_| StreamFault)?;
                            if size > MAX_CHUNK_BYTES {
                                return Err(StreamFault);
                            }
                            if size == 0 {
                                ChunkState::Trailer
                            } else {
                                ChunkState::Data(size)
                            }
                        }
                    };
                }
                ChunkState::Data(left) => {
                    let take = left.min(input.len());
                    out.extend_from_slice(&input[..take]);
                    input = &input[take..];
                    self.state = if take == left {
                        ChunkState::DataEnd
                    } else {
                        ChunkState::Data(left - take)
                    };
                }
                ChunkState::Done => break,
            }
        }
        Ok(out)
    }
}

// --- SSE / OpenAI stream decoding ----------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finish {
    Stop,
    Length,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamItem {
    /// The model is reasoning (its reasoning text is NOT surfaced).
    Reasoning,
    Content(String),
    Finish(Finish),
    Done,
}

/// Incremental server-sent-events decoder for OpenAI-compatible chunks.
#[derive(Debug, Default)]
pub struct Sse {
    line: Vec<u8>,
    data: Vec<String>,
}

impl Sse {
    pub fn push(&mut self, input: &[u8]) -> Result<Vec<StreamItem>, StreamFault> {
        let mut items = Vec::new();
        for &byte in input {
            if byte != b'\n' {
                self.line.push(byte);
                if self.line.len() > SSE_MAX_LINE {
                    return Err(StreamFault);
                }
                continue;
            }
            let mut line = std::mem::take(&mut self.line);
            if line.ends_with(b"\r") {
                line.pop();
            }
            if line.is_empty() {
                if !self.data.is_empty() {
                    let data = std::mem::take(&mut self.data).join("\n");
                    decode_event(&data, &mut items)?;
                }
                continue;
            }
            if line.starts_with(b":") {
                continue; // comment / keep-alive
            }
            let text = String::from_utf8(line).map_err(|_| StreamFault)?;
            if let Some(rest) = text.strip_prefix("data:") {
                self.data
                    .push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
            }
            // other SSE fields (event:, id:, retry:) carry nothing we use
        }
        Ok(items)
    }
}

fn decode_event(data: &str, items: &mut Vec<StreamItem>) -> Result<(), StreamFault> {
    if data.trim() == "[DONE]" {
        items.push(StreamItem::Done);
        return Ok(());
    }
    let value: Value = serde_json::from_str(data).map_err(|_| StreamFault)?;
    if value.get("error").is_some() {
        return Err(StreamFault); // upstream detail is never surfaced
    }
    let Some(choice) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
    else {
        return Ok(());
    };
    let delta = choice.get("delta");
    let text_of = |key: &str| {
        delta
            .and_then(|d| d.get(key))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    if text_of("reasoning_content").is_some() {
        items.push(StreamItem::Reasoning);
    }
    if let Some(content) = text_of("content") {
        items.push(StreamItem::Content(content.to_string()));
    }
    match choice.get("finish_reason").and_then(Value::as_str) {
        Some("length") => items.push(StreamItem::Finish(Finish::Length)),
        Some(_) => items.push(StreamItem::Finish(Finish::Stop)),
        None => {}
    }
    Ok(())
}

// --- request body / response head ----------------------------------------------

/// `POST /v1/chat/completions` body: the alias, the bounded messages,
/// streaming, the output cap. Nothing else — no tools, no user id, no key.
/// `enable_thinking: false` keeps the island answer short; a template that
/// ignores the flag still works (reasoning only shows as "pensando").
pub fn completion_body(alias: &str, messages: &[Message], max_tokens: usize) -> String {
    json!({
        "model": alias,
        "messages": messages,
        "stream": true,
        "max_tokens": max_tokens,
        "chat_template_kwargs": { "enable_thinking": false },
    })
    .to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub status: u16,
    pub chunked: bool,
    pub content_length: Option<usize>,
    pub event_stream: bool,
}

pub fn parse_head(text: &str) -> Result<Head, StreamFault> {
    let mut lines = text.split("\r\n");
    let status_line = lines.next().ok_or(StreamFault)?;
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().ok_or(StreamFault)?;
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(StreamFault);
    }
    let code = parts.next().ok_or(StreamFault)?;
    if code.len() != 3 {
        return Err(StreamFault);
    }
    let status: u16 = code.parse().map_err(|_| StreamFault)?;
    let mut head = Head {
        status,
        chunked: false,
        content_length: None,
        event_stream: false,
    };
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(StreamFault);
        };
        let value = value.trim().to_ascii_lowercase();
        match name.trim().to_ascii_lowercase().as_str() {
            "transfer-encoding" => head.chunked = value.contains("chunked"),
            "content-length" => head.content_length = value.parse().ok(),
            "content-type" => head.event_stream = value.starts_with("text/event-stream"),
            _ => {}
        }
    }
    Ok(head)
}

/// Non-2xx → a safe error. 503 (loading/sleeping) and 404 (alias gone) mean
/// the local model is not there; everything else is an inference error. A
/// redirect is never followed.
pub fn status_error(status: u16) -> ChatError {
    match status {
        503 | 404 => ChatError::local_model_unavailable(),
        _ => ChatError::inference_error(),
    }
}

// --- the socket client ------------------------------------------------------------

/// Cancellation handle for one in-flight turn: `cancel()` marks it and shuts
/// the socket down so a blocked read returns at once.
#[derive(Debug, Default)]
pub struct Cancel {
    cancelled: AtomicBool,
    stream: Mutex<Option<TcpStream>>,
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(s) = self.stream.lock().expect("cancel lock").as_ref() {
            let _ = s.shutdown(Shutdown::Both);
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    fn attach(&self, stream: &TcpStream) {
        *self.stream.lock().expect("cancel lock") = stream.try_clone().ok();
        if self.is_cancelled() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

/// How a turn's stream ended (the caller maps it onto `chat::Event`s).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    Finished(Finish),
    Cancelled,
    Failed(ChatError),
}

/// Stream one chat completion from the local router. Exactly ONE request;
/// `on_item` sees every decoded item in order. Never retries.
pub fn stream_chat(
    endpoint: &LocalEndpoint,
    alias: &str,
    messages: &[Message],
    max_tokens: usize,
    deadlines: Deadlines,
    cancel: &Cancel,
    on_item: &mut dyn FnMut(&StreamItem),
) -> Ended {
    if !valid_alias(alias) {
        return Ended::Failed(ChatError::profile_missing());
    }
    if cancel.is_cancelled() {
        return Ended::Cancelled;
    }
    let started = Instant::now();
    let total = Duration::from_millis(deadlines.total_ms);
    let mut stream = match TcpStream::connect_timeout(
        &endpoint.addr(),
        Duration::from_millis(deadlines.connect_ms),
    ) {
        Ok(s) => s,
        Err(_) => return Ended::Failed(ChatError::local_model_unavailable()),
    };
    cancel.attach(&stream);
    let _ = stream.set_nodelay(true);
    let body = completion_body(alias, messages, max_tokens);
    let request = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nAccept: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        endpoint.host_header(),
        body.len(),
        body
    );
    let idle = Duration::from_millis(deadlines.idle_ms.max(1));
    let _ = stream.set_write_timeout(Some(idle));
    if stream.write_all(request.as_bytes()).is_err() {
        return if cancel.is_cancelled() {
            Ended::Cancelled
        } else {
            Ended::Failed(ChatError::local_model_unavailable())
        };
    }

    // read until the head is complete
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    let mut read_some = |stream: &mut TcpStream, raw: &mut Vec<u8>| -> Result<usize, Ended> {
        if cancel.is_cancelled() {
            return Err(Ended::Cancelled);
        }
        let left = total.checked_sub(started.elapsed()).filter(|d| !d.is_zero());
        let Some(left) = left else {
            return Err(Ended::Failed(ChatError::inference_error()));
        };
        let _ = stream.set_read_timeout(Some(left.min(idle)));
        match stream.read(&mut buf) {
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                Ok(n)
            }
            Err(_) if cancel.is_cancelled() => Err(Ended::Cancelled),
            Err(_) => Err(Ended::Failed(ChatError::inference_error())),
        }
    };
    let split = loop {
        if let Some(p) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break p;
        }
        if raw.len() > MAX_HEAD_BYTES {
            return Ended::Failed(ChatError::inference_error());
        }
        match read_some(&mut stream, &mut raw) {
            Ok(0) => {
                return if cancel.is_cancelled() {
                    Ended::Cancelled
                } else {
                    Ended::Failed(ChatError::local_model_unavailable())
                }
            }
            Ok(_) => {}
            Err(e) => return e,
        }
    };
    let head = match std::str::from_utf8(&raw[..split])
        .map_err(|_| StreamFault)
        .and_then(parse_head)
    {
        Ok(h) => h,
        Err(_) => return Ended::Failed(ChatError::inference_error()),
    };
    if !(200..=299).contains(&head.status) {
        let _ = stream.shutdown(Shutdown::Both);
        return Ended::Failed(status_error(head.status));
    }
    if !head.event_stream {
        let _ = stream.shutdown(Shutdown::Both);
        return Ended::Failed(ChatError::stream_gap());
    }

    let mut pending = raw.split_off(split + 4);
    let mut chunked = head.chunked.then(Chunked::default);
    let mut sse = Sse::default();
    let mut finish: Option<Finish> = None;
    let mut total_bytes = 0usize;
    loop {
        if !pending.is_empty() {
            total_bytes += pending.len();
            if total_bytes > MAX_STREAM_BYTES {
                return Ended::Failed(ChatError::stream_gap());
            }
            let decoded = match chunked.as_mut() {
                Some(c) => match c.push(&pending) {
                    Ok(d) => d,
                    Err(_) => return Ended::Failed(ChatError::stream_gap()),
                },
                None => std::mem::take(&mut pending),
            };
            pending.clear();
            let items = match sse.push(&decoded) {
                Ok(items) => items,
                Err(_) => return Ended::Failed(ChatError::inference_error()),
            };
            for item in items {
                if cancel.is_cancelled() {
                    return Ended::Cancelled;
                }
                on_item(&item);
                match item {
                    StreamItem::Finish(f) => finish = Some(f),
                    StreamItem::Done => {
                        let _ = stream.shutdown(Shutdown::Both);
                        return Ended::Finished(finish.unwrap_or(Finish::Stop));
                    }
                    _ => {}
                }
            }
            if chunked.as_ref().is_some_and(Chunked::finished) {
                break;
            }
        }
        match read_some(&mut stream, &mut pending) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => return e,
        }
    }
    if cancel.is_cancelled() {
        return Ended::Cancelled;
    }
    match finish {
        Some(f) => Ended::Finished(f),
        None => Ended::Failed(ChatError::stream_gap()),
    }
}

/// Bounded metadata read (`GET <path>` → JSON) from the same pinned endpoint:
/// no inference, no body sent, one attempt, short deadline. Used by the
/// model picker (U2). `None` on any failure.
pub fn get_json(endpoint: &LocalEndpoint, path: &str, deadline_ms: u64) -> Option<Value> {
    if !matches!(path, "/health" | "/v1/models" | "/props" | "/slots") {
        return None; // closed set of metadata routes, never inference
    }
    let origin = crate::requests::parse_origin(endpoint.origin()).ok()?;
    let active = crate::http::ActiveRequests::new();
    let response = crate::http::send(
        &origin,
        "GET",
        path,
        &[("Accept".to_string(), "application/json".to_string())],
        None,
        true,
        deadline_ms,
        &active,
    )
    .ok()?;
    if response.status != 200 {
        return None;
    }
    serde_json::from_slice(&response.body?).ok()
}

#[cfg(test)]
#[path = "localmodel_tests.rs"]
mod tests;

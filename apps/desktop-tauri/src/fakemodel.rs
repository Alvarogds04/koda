//! In-process fake LOCAL model router — test/probe scaffolding, unit U1.
//!
//! A std-only HTTP/1.1 server on `127.0.0.1:0` speaking the subset of the
//! llama.cpp server API the island uses: `GET /health`, `/v1/models`,
//! `/props`, `/slots`, and `POST /v1/chat/completions` answered as an
//! OpenAI-compatible SSE stream (chunked). Scripted per test: refuse with a
//! status, redirect, stall, break the stream, send malformed frames, or
//! never finish. Records every request (method, path, body) so tests can
//! prove "exactly one request, no retry, no fallback". Never contacts
//! anything; never started unless a test or the probe starts it.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub body: String,
}

/// How `POST /v1/chat/completions` answers.
#[derive(Debug, Clone)]
pub enum Reply {
    /// Stream these content pieces (after an optional reasoning piece), then
    /// `finish_reason` and `[DONE]`.
    Stream {
        reasoning: bool,
        pieces: Vec<String>,
        finish: &'static str,
        gap_ms: u64,
    },
    /// Answer this status with a small JSON error body.
    Status(u16),
    /// 302 to this location (must never be followed).
    Redirect(String),
    /// Send the head, then stall forever (idle deadline / cancel tests).
    StallAfterHead,
    /// Stream pieces, then close the socket without finish or `[DONE]`.
    BreakAfter(Vec<String>),
    /// A malformed SSE frame.
    Malformed,
}

#[derive(Debug, Clone)]
pub struct FakeModelConfig {
    pub alias: String,
    pub sleeping: bool,
    pub busy: bool,
    pub n_ctx: u64,
    pub size_bytes: u64,
    pub reply: Reply,
}

impl Default for FakeModelConfig {
    fn default() -> Self {
        FakeModelConfig {
            alias: "Abito-gpt".into(),
            sleeping: false,
            busy: false,
            n_ctx: 65_536,
            size_bytes: 18_198_045_184,
            reply: Reply::Stream {
                reasoning: false,
                pieces: vec!["Hola, ".into(), "soy Abito.".into()],
                finish: "stop",
                gap_ms: 0,
            },
        }
    }
}

pub struct FakeModel {
    port: u16,
    config: Mutex<FakeModelConfig>,
    seen: Mutex<Vec<Seen>>,
    stop: AtomicBool,
}

impl FakeModel {
    pub fn start(config: FakeModelConfig) -> Arc<Self> {
        let listener =
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("fake model bind 127.0.0.1:0");
        let port = listener.local_addr().expect("fake model addr").port();
        let fake = Arc::new(FakeModel {
            port,
            config: Mutex::new(config),
            seen: Mutex::new(Vec::new()),
            stop: AtomicBool::new(false),
        });
        let server = Arc::clone(&fake);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if server.stop.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(stream) = stream else { continue };
                let server = Arc::clone(&server);
                std::thread::spawn(move || server.serve(stream));
            }
        });
        fake
    }

    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    pub fn port(&self) -> u16 {
        self.port
    }
    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().expect("seen lock").clone()
    }
    /// Inference requests received (metadata reads excluded).
    pub fn completions(&self) -> usize {
        self.seen()
            .iter()
            .filter(|s| s.path == "/v1/chat/completions")
            .count()
    }
    pub fn set(&self, f: impl FnOnce(&mut FakeModelConfig)) {
        f(&mut self.config.lock().expect("config lock"));
    }
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect((Ipv4Addr::LOCALHOST, self.port));
    }

    fn serve(&self, mut stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut raw = Vec::new();
        let mut buf = [0u8; 4096];
        let split = loop {
            if let Some(p) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                break p;
            }
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => raw.extend_from_slice(&buf[..n]),
            }
            if raw.len() > 1 << 20 {
                return;
            }
        };
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let mut lines = head.split("\r\n");
        let mut first = lines.next().unwrap_or("").split(' ');
        let method = first.next().unwrap_or("").to_string();
        let path = first.next().unwrap_or("").to_string();
        let length = lines
            .filter_map(|l| l.split_once(':'))
            .find(|(n, _)| n.trim().eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.trim().parse::<usize>().ok())
            .unwrap_or(0);
        let mut body = raw[split + 4..].to_vec();
        while body.len() < length {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => body.extend_from_slice(&buf[..n]),
            }
        }
        self.seen.lock().expect("seen lock").push(Seen {
            method: method.clone(),
            path: path.clone(),
            body: String::from_utf8_lossy(&body).to_string(),
        });
        let config = self.config.lock().expect("config lock").clone();
        match (method.as_str(), path.as_str()) {
            ("GET", "/health") => json_reply(&mut stream, 200, &json!({"status": "ok"})),
            ("GET", "/v1/models") => json_reply(
                &mut stream,
                200,
                &json!({"object": "list", "data": [{
                    "id": config.alias, "aliases": [config.alias], "object": "model",
                    "owned_by": "llamacpp",
                    "meta": {"n_ctx": config.n_ctx, "n_ctx_train": 262_144,
                             "n_params": 35_505_251_456u64, "size": config.size_bytes,
                             "ftype": "IQ4_XS - 4.25 bpw"}
                }]}),
            ),
            ("GET", "/props") => json_reply(
                &mut stream,
                200,
                &json!({"model_alias": config.alias, "total_slots": 1,
                        "is_sleeping": config.sleeping,
                        "model_path": "/srv/ai/models/fake/fake.gguf",
                        "modalities": {"vision": false, "audio": false}}),
            ),
            ("GET", "/slots") => json_reply(
                &mut stream,
                200,
                &json!([{"id": 0, "n_ctx": config.n_ctx, "is_processing": config.busy}]),
            ),
            ("POST", "/v1/chat/completions") => self.completion(&mut stream, &config),
            _ => json_reply(&mut stream, 404, &json!({"error": "not found"})),
        }
    }

    fn completion(&self, stream: &mut TcpStream, config: &FakeModelConfig) {
        let sse_head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
        let chunk = |s: &mut TcpStream, data: &str| {
            let _ = s.write_all(format!("{:x}\r\n{data}\r\n", data.len()).as_bytes());
            let _ = s.flush();
        };
        let frame = |delta: Value, finish: Value| {
            format!(
                "data: {}\n\n",
                json!({"object": "chat.completion.chunk",
                       "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
            )
        };
        match &config.reply {
            Reply::Status(code) => json_reply(stream, *code, &json!({"error": {"message": "x"}})),
            Reply::Redirect(location) => {
                let _ = stream.write_all(
                    format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .as_bytes(),
                );
            }
            Reply::StallAfterHead => {
                let _ = stream.write_all(sse_head.as_bytes());
                let _ = stream.flush();
                let mut sink = [0u8; 64];
                let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
                let _ = stream.read(&mut sink); // until the client hangs up
            }
            Reply::Malformed => {
                let _ = stream.write_all(sse_head.as_bytes());
                chunk(stream, "data: {not json}\n\n");
                chunk(stream, "");
            }
            Reply::BreakAfter(pieces) => {
                let _ = stream.write_all(sse_head.as_bytes());
                for p in pieces {
                    chunk(stream, &frame(json!({"content": p}), Value::Null));
                }
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            Reply::Stream {
                reasoning,
                pieces,
                finish,
                gap_ms,
            } => {
                let _ = stream.write_all(sse_head.as_bytes());
                chunk(stream, &frame(json!({"role": "assistant"}), Value::Null));
                if *reasoning {
                    chunk(stream, &frame(json!({"reasoning_content": "…"}), Value::Null));
                }
                for p in pieces {
                    if *gap_ms > 0 {
                        std::thread::sleep(Duration::from_millis(*gap_ms));
                    }
                    chunk(stream, &frame(json!({"content": p}), Value::Null));
                }
                chunk(stream, &frame(json!({}), json!(finish)));
                chunk(stream, "data: [DONE]\n\n");
                chunk(stream, "");
            }
        }
    }
}

fn json_reply(stream: &mut TcpStream, status: u16, body: &Value) {
    let body = body.to_string();
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
}

/// A loopback port with nothing listening (bound then released).
pub fn closed_port() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    port
}

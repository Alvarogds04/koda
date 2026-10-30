//! #490 — minimal IMAP read client for the island inbox (NotchBuddy feature 5), written by hand
//! because the Rust IMAP crates are alpha or native-tls based (owner decision, slice 3).
//!
//! Scope, deliberately small: implicit TLS only (no plaintext, no STARTTLS), `LOGIN`,
//! `SELECT INBOX`, `UID SEARCH ALL`, `UID FETCH` of headers + the first 2 KiB of the body with
//! `BODY.PEEK` (reading never sets \Seen), `UID STORE +FLAGS (\Seen)` for «mark read», `LOGOUT`.
//! The server is untrusted: every line, literal, response count and the whole session are
//! bounded, any off-script line is a protocol error, and server text is never returned.
//! The command script is fixed: nothing from the page reaches the wire except the numeric UID
//! and the account credentials, which are validated (ASCII, no CR/LF/NUL) before any connection.
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[cfg(test)]
#[path = "imapcmd_tests.rs"]
pub(crate) mod tests;

#[derive(Clone, PartialEq, Eq)]
pub struct ImapConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
}

impl std::fmt::Debug for ImapConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ImapConfig {{ host: {:?}, port: {}, password: <redacted> }}", self.host, self.port)
    }
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_line: usize,
    pub max_literal: usize,
    pub max_response: usize,
    pub max_untagged: usize,
    pub timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_line: 8 * 1024, max_literal: 16 * 1024, max_response: 1024 * 1024, max_untagged: 200, timeout: Duration::from_secs(20) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImapError {
    Network,
    Tls,
    Auth,
    Protocol,
    TooLarge,
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub uid: u32,
    pub from_name: String,
    pub address: String,
    pub subject: String,
    pub preview: String,
    pub minutes_ago: u32,
    pub read: bool,
}


type Roots = Arc<rustls::RootCertStore>;

/// How many messages the island lists (the frame cap of `integrations-mail.js` is 20).
pub const MAX_MESSAGES: usize = 20;
/// Bytes of body requested per message (only a preview is shown).
const PREVIEW_BYTES: usize = 2048;
const MAX_FROM: usize = 40;
const MAX_SUBJECT: usize = 120;
const MAX_PREVIEW: usize = 200;

// ---- wire --------------------------------------------------------------------------------------

enum Part {
    Text(String),
    Literal(Vec<u8>),
}
type Untagged = Vec<Part>;

struct Conn<S> {
    io: S,
    buf: Vec<u8>,
    total: usize,
    next_tag: u32,
    limits: Limits,
}

impl<S: AsyncRead + AsyncWrite + Unpin> Conn<S> {
    fn new(io: S, limits: &Limits) -> Self {
        Conn { io, buf: Vec::new(), total: 0, next_tag: 1, limits: limits.clone() }
    }

    async fn fill(&mut self) -> Result<(), ImapError> {
        let mut chunk = [0u8; 4096];
        let n = self.io.read(&mut chunk).await.map_err(|_| ImapError::Network)?;
        if n == 0 {
            return Err(ImapError::Network);
        }
        self.total += n;
        if self.total > self.limits.max_response {
            return Err(ImapError::TooLarge);
        }
        self.buf.extend_from_slice(&chunk[..n]);
        Ok(())
    }

    /// One CRLF-terminated line, without the terminator.
    async fn read_line(&mut self) -> Result<Vec<u8>, ImapError> {
        loop {
            if let Some(at) = self.buf.iter().position(|b| *b == b'\n') {
                let mut line: Vec<u8> = self.buf.drain(..=at).collect();
                line.pop();
                if line.pop() != Some(b'\r') {
                    return Err(ImapError::Protocol);
                }
                if line.len() > self.limits.max_line {
                    return Err(ImapError::TooLarge);
                }
                return Ok(line);
            }
            if self.buf.len() > self.limits.max_line {
                return Err(ImapError::TooLarge);
            }
            self.fill().await?;
        }
    }

    async fn read_literal(&mut self, n: usize) -> Result<Vec<u8>, ImapError> {
        while self.buf.len() < n {
            self.fill().await?;
        }
        Ok(self.buf.drain(..n).collect())
    }

    async fn greeting(&mut self) -> Result<(), ImapError> {
        let line = self.read_line().await?;
        if line.starts_with(b"* OK") { Ok(()) } else { Err(ImapError::Protocol) }
    }

    /// Sends one command and collects its untagged responses up to the tagged status.
    async fn command(&mut self, cmd: &str) -> Result<(Status, Vec<Untagged>), ImapError> {
        let tag = format!("A{}", self.next_tag);
        self.next_tag += 1;
        let line = format!("{tag} {cmd}\r\n");
        self.io.write_all(line.as_bytes()).await.map_err(|_| ImapError::Network)?;
        self.io.flush().await.map_err(|_| ImapError::Network)?;
        let mut out: Vec<Untagged> = Vec::new();
        loop {
            let line = self.read_line().await?;
            if let Some(rest) = line.strip_prefix(b"* ") {
                let mut parts: Untagged = Vec::new();
                let mut cur = rest.to_vec();
                loop {
                    match literal_len(&cur)? {
                        Some(n) => {
                            if n > self.limits.max_literal {
                                return Err(ImapError::TooLarge);
                            }
                            parts.push(Part::Text(String::from_utf8_lossy(&cur).into_owned()));
                            parts.push(Part::Literal(self.read_literal(n).await?));
                            cur = self.read_line().await?;
                        }
                        None => {
                            parts.push(Part::Text(String::from_utf8_lossy(&cur).into_owned()));
                            break;
                        }
                    }
                }
                out.push(parts);
                if out.len() > self.limits.max_untagged {
                    return Err(ImapError::TooLarge);
                }
            } else if let Some(rest) = line.strip_prefix(format!("{tag} ").as_bytes()) {
                let status = if rest.starts_with(b"OK") {
                    Status::Ok
                } else if rest.starts_with(b"NO") {
                    Status::No
                } else if rest.starts_with(b"BAD") {
                    Status::Bad
                } else {
                    return Err(ImapError::Protocol);
                };
                return Ok((status, out));
            } else {
                // Continuation requests, other tags, binary noise: nothing this client asked for.
                return Err(ImapError::Protocol);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Ok,
    No,
    Bad,
}

/// `Some(n)` when the line ends in a literal announcement `{n}`.
fn literal_len(line: &[u8]) -> Result<Option<usize>, ImapError> {
    if line.last() != Some(&b'}') {
        return Ok(None);
    }
    let Some(open) = line.iter().rposition(|b| *b == b'{') else { return Ok(None) };
    let digits = &line[open + 1..line.len() - 1];
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return Ok(None);
    }
    std::str::from_utf8(digits).ok().and_then(|d| d.parse::<usize>().ok()).map(Some).ok_or(ImapError::TooLarge)
}

fn quoted(s: &str) -> Result<String, ImapError> {
    if s.is_empty() || !s.is_ascii() || s.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return Err(ImapError::Protocol);
    }
    Ok(format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")))
}

async fn connect(cfg: &ImapConfig, roots: &Roots) -> Result<Conn<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>, ImapError> {
    // Credentials are validated before any byte leaves the machine.
    quoted(&cfg.user)?;
    quoted(&cfg.password)?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| ImapError::Tls)?
        .with_root_certificates(roots.clone())
        .with_no_client_auth();
    let name = rustls::pki_types::ServerName::try_from(cfg.host.clone()).map_err(|_| ImapError::Protocol)?;
    let tcp = tokio::net::TcpStream::connect((cfg.host.as_str(), cfg.port)).await.map_err(|_| ImapError::Network)?;
    let stream = tokio_rustls::TlsConnector::from(Arc::new(tls)).connect(name, tcp).await.map_err(|_| ImapError::Tls)?;
    Ok(Conn::new(stream, &Limits::default()))
}

async fn login_select<S: AsyncRead + AsyncWrite + Unpin>(c: &mut Conn<S>, cfg: &ImapConfig) -> Result<(), ImapError> {
    c.greeting().await?;
    let (st, _) = c.command(&format!("LOGIN {} {}", quoted(&cfg.user)?, quoted(&cfg.password)?)).await?;
    match st {
        Status::Ok => {}
        Status::No => return Err(ImapError::Auth),
        Status::Bad => return Err(ImapError::Protocol),
    }
    let (st, _) = c.command("SELECT INBOX").await?;
    if st == Status::Ok { Ok(()) } else { Err(ImapError::Protocol) }
}

async fn logout<S: AsyncRead + AsyncWrite + Unpin>(c: &mut Conn<S>) {
    let _ = c.command("LOGOUT").await;
    let _ = c.io.shutdown().await;
}

// ---- operations -------------------------------------------------------------------------------

/// The newest [`MAX_MESSAGES`] messages of INBOX, newest first. `now` is Unix seconds.
pub async fn fetch_inbox(cfg: &ImapConfig, roots: &Roots, now: i64, limits: &Limits) -> Result<Vec<Message>, ImapError> {
    let work = async {
        let mut c = connect(cfg, roots).await?;
        c.limits = limits.clone();
        let result = inbox_session(&mut c, cfg, now).await;
        if result.is_ok() {
            logout(&mut c).await;
        }
        result
    };
    tokio::time::timeout(limits.timeout, work).await.map_err(|_| ImapError::Timeout)?
}

async fn inbox_session<S: AsyncRead + AsyncWrite + Unpin>(c: &mut Conn<S>, cfg: &ImapConfig, now: i64) -> Result<Vec<Message>, ImapError> {
    login_select(c, cfg).await?;
    let (st, found) = c.command("UID SEARCH ALL").await?;
    if st != Status::Ok {
        return Err(ImapError::Protocol);
    }
    let mut uids: Vec<u32> = found
        .iter()
        .filter_map(|r| match r.first() {
            Some(Part::Text(t)) => t.strip_prefix("SEARCH"),
            _ => None,
        })
        .flat_map(|t| t.split_whitespace().filter_map(|n| n.parse::<u32>().ok()).collect::<Vec<_>>())
        .collect();
    uids.sort_unstable();
    uids.dedup();
    let keep = uids.len().saturating_sub(MAX_MESSAGES);
    let uids = uids.split_off(keep);
    let mut out = Vec::new();
    if !uids.is_empty() {
        let set = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let (st, fetched) = c
            .command(&format!(
                "UID FETCH {set} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.{PREVIEW_BYTES}>)"
            ))
            .await?;
        if st != Status::Ok {
            return Err(ImapError::Protocol);
        }
        for r in &fetched {
            if let Some(m) = message_of(r, now) {
                if uids.contains(&m.uid) && !out.iter().any(|o: &Message| o.uid == m.uid) {
                    out.push(m);
                }
            }
        }
    }
    out.sort_by_key(|m| std::cmp::Reverse(m.uid));
    Ok(out)
}

/// `UID STORE <uid> +FLAGS (\Seen)`: the only write this client ever does.
pub async fn mark_read(cfg: &ImapConfig, roots: &Roots, uid: u32, limits: &Limits) -> Result<(), ImapError> {
    let work = async {
        let mut c = connect(cfg, roots).await?;
        c.limits = limits.clone();
        login_select(&mut c, cfg).await?;
        let (st, _) = c.command(&format!("UID STORE {uid} +FLAGS (\\Seen)")).await?;
        if st != Status::Ok {
            return Err(ImapError::Protocol);
        }
        logout(&mut c).await;
        Ok(())
    };
    tokio::time::timeout(limits.timeout, work).await.map_err(|_| ImapError::Timeout)?
}

// ---- FETCH response → Message ------------------------------------------------------------------

fn message_of(r: &Untagged, now: i64) -> Option<Message> {
    let (mut uid, mut read, mut date) = (None, false, None);
    let (mut header, mut text): (Option<&[u8]>, Option<&[u8]>) = (None, None);
    let mut first = true;
    let mut last_text = "";
    for part in r {
        match part {
            Part::Text(t) => {
                if first {
                    // "<seq> FETCH (…": anything else is not a FETCH.
                    if !t.split_whitespace().nth(1).is_some_and(|w| w.eq_ignore_ascii_case("FETCH")) {
                        return None;
                    }
                    first = false;
                }
                if let Some(at) = t.find("UID ") {
                    uid = t[at + 4..].split(|c: char| !c.is_ascii_digit()).next().and_then(|n| n.parse::<u32>().ok()).or(uid);
                }
                if let Some(at) = t.find("FLAGS (") {
                    let start = at + "FLAGS (".len();
                    let end = t[start..].find(')').map_or(t.len(), |e| start + e);
                    read = t[start..end].split_whitespace().any(|f| f.eq_ignore_ascii_case("\\Seen"));
                }
                if let Some(at) = t.find("INTERNALDATE \"") {
                    let rest = &t[at + 14..];
                    date = rest.find('"').and_then(|e| internal_date(&rest[..e]));
                }
                last_text = t;
            }
            Part::Literal(bytes) => {
                let section = last_text.rfind("BODY[").map(|at| &last_text[at..]).unwrap_or("");
                if section.starts_with("BODY[HEADER") {
                    header = Some(bytes);
                } else if section.starts_with("BODY[TEXT") {
                    text = Some(bytes);
                }
            }
        }
    }
    let uid = uid?;
    let headers = parse_headers(header.unwrap_or(&[]));
    let get = |k: &str| headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).unwrap_or("");
    let (name, address) = parse_from(&decode_words(get("from")));
    let subject = clean(&decode_words(get("subject")), MAX_SUBJECT);
    let preview = clean(&body_text(get("content-type"), get("content-transfer-encoding"), text.unwrap_or(&[]), 0), MAX_PREVIEW);
    let from_name = clean(if name.is_empty() { &address } else { &name }, MAX_FROM);
    let minutes_ago = date.map_or(0, |d| ((now - d).max(0) / 60).min(u32::MAX as i64) as u32);
    Some(Message { uid, from_name, address: clean(&address, 254), subject, preview, minutes_ago, read })
}

/// Control characters out, whitespace collapsed, bounded by characters.
fn clean(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(max).collect();
    while out.ends_with('\u{FFFD}') {
        out.pop();
    }
    out.trim().to_owned()
}

fn parse_headers(raw: &[u8]) -> Vec<(String, String)> {
    let text = String::from_utf8_lossy(raw);
    let mut out: Vec<(String, String)> = Vec::new();
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            break;
        }
        if line.starts_with([' ', '\t']) {
            if let Some((_, v)) = out.last_mut() {
                v.push(' ');
                v.push_str(line.trim());
            }
        } else if let Some((n, v)) = line.split_once(':') {
            out.push((n.trim().to_ascii_lowercase(), v.trim().to_owned()));
        }
    }
    out
}

fn parse_from(from: &str) -> (String, String) {
    let from = from.trim();
    if let (Some(lt), Some(gt)) = (from.rfind('<'), from.rfind('>')) {
        if lt < gt {
            let name = from[..lt].trim().trim_matches('"').trim().to_owned();
            return (name, from[lt + 1..gt].trim().to_owned());
        }
    }
    (String::new(), from.to_owned())
}

// RFC 2047 encoded words.
fn decode_words(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    let mut after_word = false;
    while let Some(at) = rest.find("=?") {
        let (before, cand) = rest.split_at(at);
        match encoded_word(cand) {
            Some((decoded, used)) => {
                if !(after_word && before.trim().is_empty()) {
                    out.push_str(before);
                }
                out.push_str(&decoded);
                rest = &cand[used..];
                after_word = true;
            }
            None => {
                out.push_str(before);
                out.push_str("=?");
                rest = &cand[2..];
                after_word = false;
            }
        }
    }
    out.push_str(rest);
    out
}

fn encoded_word(s: &str) -> Option<(String, usize)> {
    let inner = s.strip_prefix("=?")?;
    let end = inner.find("?=")?;
    let mut f = inner[..end].splitn(3, '?');
    let (charset, enc, text) = (f.next()?, f.next()?, f.next()?);
    let bytes = match enc {
        "B" | "b" => b64(text.as_bytes())?,
        "Q" | "q" => qp(text.replace('_', " ").as_bytes(), true),
        _ => return None,
    };
    Some((charset_to_string(&bytes, charset), 2 + end + 2))
}

fn charset_to_string(bytes: &[u8], charset: &str) -> String {
    let cs = charset.split('*').next().unwrap_or("").to_ascii_lowercase();
    if matches!(cs.as_str(), "iso-8859-1" | "latin1" | "windows-1252" | "us-ascii") && !bytes.is_ascii() {
        return bytes.iter().map(|b| *b as char).collect();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn b64(raw: &[u8]) -> Option<Vec<u8>> {
    use base64::Engine;
    let mut clean: Vec<u8> = raw.iter().copied().filter(|b| !b.is_ascii_whitespace()).collect();
    clean.truncate(clean.len() / 4 * 4); // the body preview may cut a quad
    base64::engine::general_purpose::STANDARD.decode(&clean).ok()
}

fn qp(raw: &[u8], word: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    let hex = |b: u8| (b as char).to_digit(16);
    while i < raw.len() {
        if raw[i] == b'=' {
            if raw[i + 1..].starts_with(b"\r\n") {
                i += 3;
                continue;
            }
            if raw[i + 1..].starts_with(b"\n") {
                i += 2;
                continue;
            }
            if let (Some(h), Some(l)) = (raw.get(i + 1).and_then(|b| hex(*b)), raw.get(i + 2).and_then(|b| hex(*b))) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(if word && raw[i] == b'_' { b' ' } else { raw[i] });
        i += 1;
    }
    out
}

fn param(value: &str, name: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    let at = lower.find(&format!("{name}="))?;
    let rest = value[at + name.len() + 1..].trim_start();
    let v = match rest.strip_prefix('"') {
        Some(q) => q.split('"').next()?,
        None => rest.split(|c: char| c == ';' || c.is_whitespace()).next()?,
    };
    Some(v.to_owned())
}

/// The readable text of a (possibly multipart) body. `depth` bounds nested multiparts.
fn body_text(content_type: &str, cte: &str, body: &[u8], depth: u8) -> String {
    let ct = content_type.to_ascii_lowercase();
    let kind = ct.split(';').next().unwrap_or("").trim().to_owned();
    if kind.starts_with("multipart/") {
        let Some(boundary) = param(content_type, "boundary").filter(|b| !b.is_empty()) else { return String::new() };
        if depth >= 3 {
            return String::new();
        }
        let text = String::from_utf8_lossy(body).into_owned();
        let marker = format!("--{boundary}");
        let (mut plain, mut html) = (None, None);
        for chunk in text.split(&marker).skip(1) {
            if chunk.starts_with("--") {
                break;
            }
            let chunk = chunk.trim_start_matches(['\r', '\n']);
            let split = chunk.find("\r\n\r\n").map(|i| (i, 4)).or_else(|| chunk.find("\n\n").map(|i| (i, 2)));
            let (hdr, content) = match split {
                Some((i, n)) => (&chunk[..i], &chunk[i + n..]),
                None => (chunk, ""),
            };
            let h = parse_headers(hdr.as_bytes());
            let get = |k: &str| h.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).unwrap_or("");
            let part_ct = get("content-type");
            let t = part_ct.to_ascii_lowercase();
            if t.starts_with("multipart/") {
                let inner = body_text(part_ct, get("content-transfer-encoding"), content.as_bytes(), depth + 1);
                if !inner.is_empty() && plain.is_none() {
                    plain = Some(inner);
                }
            } else if t.is_empty() || t.starts_with("text/plain") {
                plain.get_or_insert_with(|| body_text(part_ct, get("content-transfer-encoding"), content.as_bytes(), depth + 1));
            } else if t.starts_with("text/html") {
                html.get_or_insert_with(|| body_text(part_ct, get("content-transfer-encoding"), content.as_bytes(), depth + 1));
            }
        }
        return plain.or(html).unwrap_or_default();
    }
    if !(kind.is_empty() || kind.starts_with("text/")) {
        return String::new();
    }
    let raw = match cte.trim().to_ascii_lowercase().as_str() {
        "base64" => b64(body).unwrap_or_default(),
        "quoted-printable" => qp(body, false),
        _ => body.to_vec(),
    };
    let text = charset_to_string(&raw, &param(content_type, "charset").unwrap_or_default());
    if kind == "text/html" { strip_tags(&text) } else { text }
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for c in s.chars() {
        match c {
            '<' => inside = true,
            '>' if inside => {
                inside = false;
                out.push(' ');
            }
            _ if !inside => out.push(c),
            _ => {}
        }
    }
    out
}

/// `17-Jul-2026 11:59:00 +0000` → Unix seconds.
fn internal_date(s: &str) -> Option<i64> {
    let mut it = s.split_whitespace();
    let (date, time, zone) = (it.next()?, it.next()?, it.next()?);
    let mut d = date.split('-');
    let day: i64 = d.next()?.parse().ok()?;
    let mon = d.next()?;
    let month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
        .iter()
        .position(|m| m.eq_ignore_ascii_case(mon))? as i64
        + 1;
    let year: i64 = d.next()?.parse().ok()?;
    let mut t = time.split(':');
    let (h, mi, se): (i64, i64, i64) = (t.next()?.parse().ok()?, t.next()?.parse().ok()?, t.next()?.parse().ok()?);
    let sign = if zone.starts_with('-') { -1 } else { 1 };
    let z = zone.trim_start_matches(['+', '-']);
    if z.len() != 4 || !(1..=31).contains(&day) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let off = sign * (z[..2].parse::<i64>().ok()? * 3600 + z[2..].parse::<i64>().ok()? * 60);
    // days_from_civil (Howard Hinnant).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + se - off)
}

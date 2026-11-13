//! Read-only Gmail REST client for the island's mail card (K2-10: S1, S5, S6, S7, S9).
//!
//! Only `GET` under [`API_BASE`]: one list page, one metadata fetch per listed message, the
//! INBOX label counter, one `format=full` message. There is no `modify`, no `trash`, no `send`
//! and no «Marcar como leído» (S5): the transport trait has no other verb, so no caller can
//! build one. Every request goes through the injected [`GmailHttp`], which is what the tests
//! inspect. Answers are bounded (2 MiB of JSON) and every error is a stable code, never a
//! token, a URL or a body.
//!
//! Bodies become plain text (S6): the `text/plain` part when there is one, otherwise the HTML
//! converted to text with `**bold**` and `- list` markers. Scripts, styles, images and every
//! remote reference are dropped — nothing is fetched to draw a message. Link chips carry the
//! real host and whether it belongs to the sender (S7), using a small, explicit approximation of
//! the public suffix list: the last two labels, or the last three when the last two are a known
//! two-level suffix (`co.uk`, `com.ar`, …). Hosts are compared lowercased, as they arrive.
use crate::gmail_oauth::{GmailAuth, GmailError};
use base64::Engine;
use serde_json::Value;

#[cfg(test)]
#[path = "gmail_api_tests.rs"]
mod tests;

/// The only API root this module can build a URL for.
pub const API_BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
/// Messages the island lists at once (the card frame cap, `imapcmd::MAX_MESSAGES`).
pub const MAX_MESSAGES: usize = 20;
/// Largest page the counters read; a full page means «at least this many».
pub const MAX_PAGE: usize = 100;
/// Characters of readable body kept for the detail view.
pub const MAX_BODY_CHARS: usize = 64 * 1024;
/// Link chips per message.
pub const MAX_LINKS: usize = 30;
/// Bounded JSON answer.
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_ID: usize = 64;
const MAX_HEADER: usize = 300;
const MAX_FROM: usize = 40;
const MAX_SNIPPET: usize = 200;
const MAX_URL: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiError {
    /// No usable token: the user has to connect Gmail (again).
    NeedsSignIn,
    /// 403: the grant lost the read-only scope, or Google refused the call.
    Forbidden,
    /// 429: too many requests right now.
    RateLimited,
    /// 5xx.
    Server,
    /// No connection, a timeout or an unreadable answer.
    Network,
    /// 404, a refused id, or an answer this client does not understand.
    Invalid,
}
impl ApiError {
    /// Stable code for the page; never carries a token, a URL or a body.
    pub fn code(self) -> &'static str {
        match self {
            Self::NeedsSignIn => "needs_sign_in", Self::Forbidden => "forbidden", Self::RateLimited => "rate_limited",
            Self::Server => "server", Self::Network => "network", Self::Invalid => "invalid",
        }
    }
}
impl From<GmailError> for ApiError {
    fn from(e: GmailError) -> Self {
        match e {
            GmailError::NeedsSignIn | GmailError::NoClient => Self::NeedsSignIn,
            GmailError::Invalid => Self::Invalid,
            _ => Self::Network,
        }
    }
}

pub struct HttpReply {
    pub status: u16,
    pub body: Vec<u8>,
}

/// The injected transport: exactly one verb, so no caller can reach a modifying endpoint.
pub trait GmailHttp: Sync {
    /// `Ok` for any HTTP answer (the status decides); `Err` only when no answer arrived.
    fn get(&self, url: &str, bearer: &str) -> Result<HttpReply, ApiError>;
}

/// Where an access token comes from (`GmailAuth` in production, a fake in tests). `rejected` is
/// the token the API just refused, so the provider refreshes it instead of handing it back.
pub trait Tokens {
    fn access_token(&self, rejected: Option<&str>) -> Result<String, GmailError>;
}
impl<F> Tokens for F where F: Fn(Option<&str>) -> Result<String, GmailError> {
    fn access_token(&self, rejected: Option<&str>) -> Result<String, GmailError> { self(rejected) }
}
impl Tokens for GmailAuth<'_> {
    fn access_token(&self, rejected: Option<&str>) -> Result<String, GmailError> { GmailAuth::access_token(self, rejected) }
}

/// The real transport: rustls only, no proxy, no redirects, 30 s, [`MAX_JSON_BYTES`] of body.
pub struct RustlsHttp;
impl GmailHttp for RustlsHttp {
    fn get(&self, url: &str, bearer: &str) -> Result<HttpReply, ApiError> {
        // The URL is always built from API_BASE; the check keeps that true of the wire too.
        if !url.starts_with(API_BASE) || url.len() > 4096 || bearer.is_empty() { return Err(ApiError::Invalid) }
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| ApiError::Network)?;
        rt.block_on(async {
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none()).no_proxy()
                .timeout(std::time::Duration::from_secs(30))
                .user_agent(concat!("Abito/", env!("CARGO_PKG_VERSION")))
                .build().map_err(|_| ApiError::Network)?;
            let mut response = client.get(url).bearer_auth(bearer).send().await.map_err(|_| ApiError::Network)?;
            let status = response.status().as_u16();
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| ApiError::Network)? {
                if body.len() + chunk.len() > MAX_JSON_BYTES { return Err(ApiError::Invalid) }
                body.extend_from_slice(&chunk);
            }
            Ok(HttpReply { status, body })
        })
    }
}

/// S5: the four filters of the card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    Nuevos,
    Importantes,
    /// S9: «Principal + remitente no automático».
    DePersonas,
    Todos,
}
impl Filter {
    pub fn query(self) -> &'static str {
        match self {
            Self::Nuevos => "in:inbox is:unread", Self::Importantes => "in:inbox is:important",
            Self::DePersonas => "in:inbox category:primary", Self::Todos => "in:inbox",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub id: String,
    pub thread_id: String,
    pub from_name: String,
    pub from_address: String,
    pub subject: String,
    /// `snippet`, HTML entities decoded.
    pub snippet: String,
    pub internal_date_ms: u64,
    pub unread: bool,
    pub important: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inbox {
    pub messages: Vec<Summary>,
    /// New since the last visit (unread, newer than `last_seen_ms`).
    pub new_count: u32,
    /// The counter read a full page: `new_count` is a lower bound.
    pub new_count_capped: bool,
    pub unread_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    /// The chip's label: the anchor text, or the URL itself for a bare link.
    pub text: String,
    pub url: String,
    /// The real host (`mail.example.com`), never a shortened or rewritten one.
    pub domain: String,
    /// S7: same registrable domain as the sender (a subdomain of the sender counts).
    pub same_as_sender: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detail {
    pub id: String,
    pub thread_id: String,
    pub from_name: String,
    pub from_address: String,
    /// «Responder» goes to `Reply-To` when the message has one, else to the sender.
    pub reply_to: String,
    pub subject: String,
    /// `Re: …`, added once.
    pub reply_subject: String,
    /// Plain text: `**bold**`, `- list`, nothing else from the HTML.
    pub body: String,
    pub body_truncated: bool,
    pub internal_date_ms: u64,
    pub unread: bool,
    pub important: bool,
    pub links: Vec<Link>,
}

// ---- one session over the injected transport ---------------------------------------------------

struct Session<'a> {
    auth: &'a dyn Tokens,
    http: &'a dyn GmailHttp,
    token: String,
    refreshed: bool,
}
impl<'a> Session<'a> {
    fn open(auth: &'a dyn Tokens, http: &'a dyn GmailHttp) -> Result<Self, ApiError> {
        Ok(Self { auth, http, token: auth.access_token(None).map_err(ApiError::from)?, refreshed: false })
    }
    /// One GET of `API_BASE/<path>`; a 401 refreshes the token and retries exactly once.
    fn get(&mut self, path: &str) -> Result<Value, ApiError> {
        let url = format!("{API_BASE}/{path}");
        let mut reply = self.http.get(&url, &self.token)?;
        if reply.status == 401 && !self.refreshed {
            self.refreshed = true;
            self.token = self.auth.access_token(Some(&self.token)).map_err(ApiError::from)?;
            reply = self.http.get(&url, &self.token)?;
        }
        if reply.body.len() > MAX_JSON_BYTES { return Err(ApiError::Invalid) }
        match reply.status {
            200..=299 => serde_json::from_slice(&reply.body).map_err(|_| ApiError::Invalid),
            401 => Err(ApiError::NeedsSignIn),
            403 => Err(ApiError::Forbidden),
            404 => Err(ApiError::Invalid),
            429 => Err(ApiError::RateLimited),
            500..=599 => Err(ApiError::Server),
            _ => Err(ApiError::Invalid),
        }
    }
}

/// Percent-encoding for the few values that reach a URL (the fixed paths stay readable).
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') { out.push(b as char) } else { out.push_str(&format!("%{b:02X}")) }
    }
    out
}

fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn meta_path(id: &str) -> String {
    let headers: String = ["From", "Subject", "Date", "List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted"]
        .iter().map(|h| format!("&metadataHeaders={h}")).collect();
    format!("messages/{}?format=metadata{headers}", encode(id))
}

fn counter_path(last_seen_ms: u64) -> String {
    let q = format!("{} after:{}", Filter::Nuevos.query(), last_seen_ms / 1000);
    format!("messages?q={}&maxResults={MAX_PAGE}&fields=messages/id", encode(&q))
}

fn ids_of(v: &Value) -> Vec<String> {
    v["messages"].as_array()
        .map(|list| list.iter().filter_map(|m| m["id"].as_str()).filter(|id| id_ok(id)).map(str::to_owned).take(MAX_PAGE).collect())
        .unwrap_or_default()
}

// ---- inbox -------------------------------------------------------------------------------------

/// The island's list plus the «N nuevos · M sin leer» counter of S5.
///
/// The counter query is second-granular (`after:`), so messages already fetched above are
/// re-checked against their exact `internalDate`; the rest are counted as new. A full page sets
/// `new_count_capped`, because Gmail never says «more» in a page.
pub fn inbox(auth: &dyn Tokens, http: &dyn GmailHttp, filter: Filter, last_seen_ms: u64) -> Result<Inbox, ApiError> {
    let mut session = Session::open(auth, http)?;
    let q = if filter == Filter::Nuevos {
        format!("{} after:{}", filter.query(), last_seen_ms / 1000)
    } else {
        filter.query().to_owned()
    };
    let list = session.get(&format!("messages?q={}&maxResults={MAX_MESSAGES}", encode(&q)))?;
    let mut fetched: Vec<(String, u64)> = Vec::new();
    let mut messages = Vec::new();
    for id in ids_of(&list) {
        if messages.len() >= MAX_MESSAGES { break }
        let value = session.get(&meta_path(&id))?;
        let Some(summary) = summary_of(&value) else { continue };
        fetched.push((summary.id.clone(), summary.internal_date_ms));
        let skip = match filter {
            Filter::Nuevos => summary.internal_date_ms <= last_seen_ms,
            Filter::DePersonas => automated(&value),
            _ => false,
        };
        if !skip { messages.push(summary) }
    }
    let unread_count = session.get("labels/INBOX")?["messagesUnread"].as_u64().unwrap_or(0).min(u64::from(u32::MAX)) as u32;
    let candidates = ids_of(&session.get(&counter_path(last_seen_ms))?);
    let new_count = candidates.iter()
        .filter(|id| fetched.iter().find(|(known, _)| known == *id).is_none_or(|(_, ms)| *ms > last_seen_ms))
        .count() as u32;
    Ok(Inbox { messages, new_count, new_count_capped: candidates.len() >= MAX_PAGE, unread_count })
}

/// One message, as plain text plus link chips, with what «Responder» needs (S2, S6, S7).
pub fn message(auth: &dyn Tokens, http: &dyn GmailHttp, id: &str) -> Result<Detail, ApiError> {
    if !id_ok(id) { return Err(ApiError::Invalid) }
    let mut session = Session::open(auth, http)?;
    detail_of(&session.get(&format!("messages/{}?format=full", encode(id)))?).ok_or(ApiError::Invalid)
}

/// `mailto:` for «Responder», through the shared builder in [`crate::mailcmd`].
/// `None` when the address cannot be quoted safely (control characters, `?`, `&`, no single `@`).
pub fn reply_mailto(detail: &Detail) -> Option<String> {
    let address = detail.reply_to.as_str();
    let quote_safe = !address.is_empty()
        && address.chars().count() <= 254
        && !address.chars().any(|c| c.is_control())
        && !address.contains(['?', '&', ' ', '<', '>', ',', ';', '"', '\\'])
        && address.matches('@').count() == 1
        && !address.starts_with('@') && !address.ends_with('@');
    quote_safe.then(|| crate::mailcmd::mailto(address, &detail.reply_subject))
}

// ---- parsing: headers and summaries ------------------------------------------------------------

/// Control characters out, whitespace collapsed, bounded by characters.
fn clean(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(max).collect();
    while out.ends_with('\u{FFFD}') { out.pop(); }
    out.trim().to_owned()
}

fn headers_of(v: &Value) -> Vec<(String, String)> {
    v["payload"]["headers"].as_array()
        .map(|list| list.iter().filter_map(|h| Some((h["name"].as_str()?.to_ascii_lowercase(), h["value"].as_str()?.chars().take(1024).collect()))).collect())
        .unwrap_or_default()
}
fn header<'a>(headers: &'a [(String, String)], name: &str) -> &'a str {
    headers.iter().find(|(n, _)| n == name).map_or("", |(_, v)| v.as_str())
}
fn parse_from(from: &str) -> (String, String) {
    let from = from.trim();
    if let (Some(lt), Some(gt)) = (from.rfind('<'), from.rfind('>')) {
        if lt < gt { return (from[..lt].trim().trim_matches('"').trim().to_owned(), from[lt + 1..gt].trim().to_owned()) }
    }
    (String::new(), from.to_owned())
}
fn label(v: &Value, name: &str) -> bool {
    v["labelIds"].as_array().is_some_and(|list| list.iter().any(|l| l.as_str() == Some(name)))
}
fn internal_date_ms(v: &Value) -> u64 { v["internalDate"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0) }

fn summary_of(v: &Value) -> Option<Summary> {
    let id = v["id"].as_str()?;
    if !id_ok(id) { return None }
    let headers = headers_of(v);
    let (name, address) = parse_from(&words(header(&headers, "from")));
    Some(Summary {
        id: id.to_owned(),
        thread_id: clean(v["threadId"].as_str().unwrap_or(""), MAX_ID),
        from_name: clean(if name.is_empty() { &address } else { &name }, MAX_FROM),
        from_address: clean(&address, 254),
        subject: clean(&words(header(&headers, "subject")), MAX_HEADER),
        snippet: clean(&entities(v["snippet"].as_str().unwrap_or("")), MAX_SNIPPET),
        internal_date_ms: internal_date_ms(v),
        unread: label(v, "UNREAD"),
        important: label(v, "IMPORTANT"),
    })
}

/// S9: a sender no human typed. `List-*`, bulk/list precedence, a machine `Auto-Submitted` and
/// the usual no-reply locals.
const AUTOMATED_LOCALS: &[&str] = &[
    "noreply", "no-reply", "donotreply", "do-not-reply", "notifications", "notification", "mailer-daemon", "postmaster", "bounce",
];
fn automated(v: &Value) -> bool {
    let headers = headers_of(v);
    if !header(&headers, "list-unsubscribe").is_empty() || !header(&headers, "list-id").is_empty() { return true }
    if matches!(header(&headers, "precedence").trim().to_ascii_lowercase().as_str(), "bulk" | "list" | "junk") { return true }
    let auto = header(&headers, "auto-submitted").trim().to_ascii_lowercase();
    if !auto.is_empty() && auto != "no" { return true }
    let (_, address) = parse_from(&words(header(&headers, "from")));
    AUTOMATED_LOCALS.contains(&address.split('@').next().unwrap_or("").to_ascii_lowercase().as_str())
}

/// An address that can be put in a `mailto:`: no whitespace or control characters, one `@`.
fn usable_address(address: &str) -> bool {
    !address.is_empty()
        && address.chars().count() <= 254
        && !address.chars().any(|c| c.is_control() || c.is_whitespace())
        && address.matches('@').count() == 1
        && !address.starts_with('@') && !address.ends_with('@')
}

fn detail_of(v: &Value) -> Option<Detail> {
    let id = v["id"].as_str()?;
    if !id_ok(id) { return None }
    let headers = headers_of(v);
    let (name, address) = parse_from(&words(header(&headers, "from")));
    let reply_address = parse_from(&words(header(&headers, "reply-to"))).1;
    // A junk `Reply-To` must not swallow «Responder»: fall back to the sender.
    let reply_to = if usable_address(&reply_address) { reply_address } else { address.clone() };
    let subject = clean(&words(header(&headers, "subject")), MAX_HEADER);
    let already = subject.get(..3).is_some_and(|prefix| prefix.eq_ignore_ascii_case("re:"));
    let (body_full, anchors) = body_of(&v["payload"]);
    let links = links_of(&body_full, anchors, &address);
    let body_truncated = body_full.chars().count() > MAX_BODY_CHARS;
    let body: String = if body_truncated { body_full.chars().take(MAX_BODY_CHARS).collect() } else { body_full };
    Some(Detail {
        id: id.to_owned(),
        thread_id: clean(v["threadId"].as_str().unwrap_or(""), MAX_ID),
        from_name: clean(if name.is_empty() { &address } else { &name }, MAX_FROM),
        from_address: clean(&address, 254),
        reply_to: clean(&reply_to, 254),
        reply_subject: if already { subject.clone() } else { format!("Re: {subject}") },
        subject, body, body_truncated,
        internal_date_ms: internal_date_ms(v),
        unread: label(v, "UNREAD"),
        important: label(v, "IMPORTANT"),
        links,
    })
}

// ---- body: text/plain, or HTML turned into text ------------------------------------------------

/// The readable text of a message plus its HTML anchors (label, href).
fn body_of(payload: &Value) -> (String, Vec<(String, String)>) {
    let (mut plain, mut html) = (None, None);
    walk(payload, 0, &mut plain, &mut html);
    match (plain, html) {
        (Some(text), _) => (normalize(&text), Vec::new()),
        (None, Some(markup)) => { let (text, anchors) = html_to_text(&markup); (normalize(&text), anchors) }
        (None, None) => (String::new(), Vec::new()),
    }
}

fn walk(part: &Value, depth: u8, plain: &mut Option<String>, html: &mut Option<String>) {
    if depth > 4 { return }
    if let Some(parts) = part["parts"].as_array() {
        for child in parts { walk(child, depth + 1, plain, html) }
        return;
    }
    let text = part_text(part);
    if text.trim().is_empty() { return }
    let mime = part["mimeType"].as_str().unwrap_or("").to_ascii_lowercase();
    if mime.starts_with("text/plain") {
        plain.get_or_insert(text);
    } else if mime.starts_with("text/html") {
        html.get_or_insert(text);
    }
}

fn part_text(part: &Value) -> String {
    let Some(decoded) = b64url(part["body"]["data"].as_str().unwrap_or("")) else { return String::new() };
    let headers: Vec<(String, String)> = part["headers"].as_array()
        .map(|list| list.iter().filter_map(|h| Some((h["name"].as_str()?.to_ascii_lowercase(), h["value"].as_str()?.to_owned()))).collect())
        .unwrap_or_default();
    let transfer = header(&headers, "content-transfer-encoding").trim().to_ascii_lowercase();
    let bytes = if transfer.starts_with("quoted-printable") { qp_bytes(&decoded) } else { decoded };
    // Only the charsets Gmail still sends that would otherwise show as mojibake are re-mapped.
    let charset = header(&headers, "content-type").to_ascii_lowercase();
    if (charset.contains("iso-8859-1") || charset.contains("windows-1252") || charset.contains("latin1")) && !bytes.is_ascii() {
        return bytes.iter().map(|b| *b as char).collect();
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn b64url(s: &str) -> Option<Vec<u8>> {
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace() && *c != '=').collect();
    if cleaned.len() > MAX_JSON_BYTES / 3 * 4 + 4 { return None }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(cleaned).ok()
}

/// Quoted-printable, including its soft line breaks (`=` at the end of a line).
fn qp_bytes(raw: &[u8]) -> Vec<u8> {
    let hex = |b: u8| (b as char).to_digit(16);
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'=' {
            if raw[i + 1..].starts_with(b"\r\n") { i += 3; continue }
            if raw[i + 1..].starts_with(b"\n") { i += 2; continue }
            if let (Some(h), Some(l)) = (raw.get(i + 1).and_then(|b| hex(*b)), raw.get(i + 2).and_then(|b| hex(*b))) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    out
}

/// Blocks whose content must never reach the text: nothing is executed and nothing is fetched.
fn strip_blocks(html: &str) -> String {
    let mut text = html.to_owned();
    for name in ["script", "style", "head"] {
        let (open, close) = (format!("<{name}"), format!("</{name}"));
        let mut from = 0;
        loop {
            let lower = text.to_ascii_lowercase();
            let Some(at) = lower[from..].find(&open).map(|i| from + i) else { break };
            // `<header>` is not `<head>`: the name must end there.
            if !matches!(lower[at + open.len()..].chars().next(), Some('>' | ' ' | '\t' | '\r' | '\n' | '/')) {
                from = at + open.len();
                continue;
            }
            let Some(end) = lower[at..].find(&close).map(|i| at + i) else { break };
            let Some(gt) = lower[end..].find('>').map(|i| end + i) else { break };
            text.replace_range(at..=gt, "");
            from = at;
        }
    }
    text
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    loop {
        from = lower[from..].find(name).map(|i| from + i)? + name.len();
        let Some(value) = tag[from..].trim_start().strip_prefix('=') else { continue };
        let value = value.trim_start();
        return Some(match value.chars().next()? {
            quote @ ('"' | '\'') => value[1..].split(quote).next()?.to_owned(),
            _ => value.split(|c: char| c.is_whitespace() || c == '>').next()?.to_owned(),
        });
    }
}

fn html_to_text(html: &str) -> (String, Vec<(String, String)>) {
    let cleaned = strip_blocks(html);
    let mut rest = cleaned.as_str();
    let mut out = String::new();
    let mut anchors: Vec<(String, String)> = Vec::new();
    let mut open: Option<(String, String)> = None;
    // Markdown-ish markers go to the current target (an anchor's label or the body).
    let mark = |s: &str, out: &mut String, open: &mut Option<(String, String)>| match open {
        Some((_, label)) => label.push_str(s),
        None => out.push_str(s),
    };
    while let Some(at) = rest.find('<') {
        let text = entities(&rest[..at]);
        mark(&text, &mut out, &mut open);
        // No `>` left: the rest is not markup this client can read.
        let Some(gt) = rest[at..].find('>') else { return (out, anchors) };
        let tag = &rest[at + 1..at + gt];
        rest = &rest[at + gt + 1..];
        let closing = tag.starts_with('/');
        let name = tag.trim_start_matches('/').trim_start().split([' ', '\t', '\r', '\n', '/', '>']).next().unwrap_or("").to_ascii_lowercase();
        match (name.as_str(), closing) {
            ("a", false) => { if let Some(href) = attr(tag, "href") { open = Some((href, String::new())) } }
            ("a", true) => { if let Some((href, label)) = open.take() { anchors.push((label.trim().to_owned(), href.trim().to_owned())) } }
            ("b" | "strong", _) => mark("**", &mut out, &mut open),
            ("li", false) => mark("\n- ", &mut out, &mut open),
            ("br" | "p" | "div" | "tr" | "li" | "ul" | "ol" | "table" | "blockquote" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6", _) => mark("\n", &mut out, &mut open),
            _ => {}
        }
    }
    mark(&entities(rest), &mut out, &mut open);
    // An unterminated anchor still yields its link, with whatever text it carried.
    if let Some((href, label)) = open.take() { anchors.push((label.trim().to_owned(), href.trim().to_owned())) }
    (out, anchors)
}

/// Body text: no control characters, no trailing spaces, at most one blank line in a row.
fn normalize(s: &str) -> String {
    let cleaned: String = s.chars().map(|c| match c {
        '\r' => '\n', '\u{a0}' => ' ', c if c.is_control() && !matches!(c, '\n' | '\t') => ' ', c => c,
    }).collect();
    let mut out = String::with_capacity(cleaned.len());
    let mut blanks = 0;
    for line in cleaned.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            blanks += 1;
            if blanks > 1 { continue }
        } else {
            blanks = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim_end().to_owned()
}

/// Named and numeric HTML entities, decoded. Unknown entities are left as they are.
fn entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let cand = &rest[at..];
        let name = cand[..cand.len().min(12)].find(';').map(|end| (&cand[1..end], end));
        let known = name.and_then(|(name, _)| match name {
            "amp" => Some('&'), "lt" => Some('<'), "gt" => Some('>'), "quot" => Some('"'), "apos" | "#39" | "#x27" => Some('\''),
            "nbsp" => Some(' '), "ndash" | "mdash" => Some('-'), "hellip" => Some('…'), "laquo" => Some('«'), "raquo" => Some('»'),
            _ => name.strip_prefix('#').and_then(|n| match n.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(&hex[..hex.len().min(6)], 16).ok(),
                None => n.parse::<u32>().ok(),
            }).and_then(char::from_u32),
        });
        match (known, name) {
            (Some(c), Some((_, end))) => { out.push(c); rest = &cand[end + 1..] }
            _ => { out.push('&'); rest = &cand[1..] }
        }
    }
    out.push_str(rest);
    out
}

/// RFC 2047 encoded words in headers (`=?UTF-8?B?…?=`, `=?UTF-8?Q?…?=`).
fn words(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    let mut after_word = false;
    while let Some(at) = rest.find("=?") {
        let (before, cand) = rest.split_at(at);
        match encoded_word(cand) {
            Some((decoded, used)) => {
                if !(after_word && before.trim().is_empty()) { out.push_str(before) }
                out.push_str(&decoded);
                rest = &cand[used..];
                after_word = true;
            }
            None => { out.push_str(before); out.push_str("=?"); rest = &cand[2..]; after_word = false }
        }
    }
    out.push_str(rest);
    out
}

fn encoded_word(s: &str) -> Option<(String, usize)> {
    let inner = s.strip_prefix("=?")?;
    let end = inner.find("?=")?;
    let mut fields = inner[..end].splitn(3, '?');
    let (charset, encoding, text) = (fields.next()?, fields.next()? , fields.next()?);
    let bytes = match encoding.to_ascii_lowercase().as_str() {
        "b" => base64::engine::general_purpose::STANDARD.decode(text.replace(' ', "")).ok()?,
        "q" => qp_bytes(text.replace('_', " ").as_bytes()),
        _ => return None,
    };
    let charset = charset.split('*').next().unwrap_or("").to_ascii_lowercase();
    let decoded = if matches!(charset.as_str(), "iso-8859-1" | "latin1" | "windows-1252") && !bytes.is_ascii() {
        bytes.iter().map(|b| *b as char).collect()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Some((decoded, 2 + end + 2))
}

// ---- link chips (S7) ---------------------------------------------------------------------------

/// Two-level public suffixes this approximation knows. The real list is far longer; an unknown
/// suffix falls back to the last two labels, which can only over-report «same domain».
const TWO_LEVEL: &[&str] = &[
    "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "or.jp", "com.br", "com.ar",
    "com.mx", "com.co", "com.pe", "com.cl", "com.ve", "com.uy", "com.ec", "com.bo", "com.py", "com.do", "com.gt", "co.za", "co.in",
    "com.cn", "com.sg", "com.tr", "co.kr", "com.tw", "com.hk", "co.id", "com.my", "com.ph", "com.sa", "com.eg",
];

/// The registrable domain of a host, lowercased: `news.shop.co.uk` → `shop.co.uk`.
fn registrable(host: &str) -> String {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() <= 2 { return labels.join(".") }
    let last_two = format!("{}.{}", labels[labels.len() - 2], labels[labels.len() - 1]);
    let take = if TWO_LEVEL.contains(&last_two.as_str()) { 3 } else { 2 };
    labels[labels.len() - take.min(labels.len())..].join(".")
}

fn push_link(out: &mut Vec<Link>, url: &str, label: &str, sender_domain: &str) {
    if out.len() >= MAX_LINKS { return }
    let Some(url) = url.split_whitespace().next().filter(|u| u.len() <= MAX_URL) else { return };
    if out.iter().any(|l| l.url.eq_ignore_ascii_case(url)) { return }
    let Some(url_parsed) = reqwest::Url::parse(url).ok().filter(|u| matches!(u.scheme(), "http" | "https")) else { return };
    let Some(host) = url_parsed.host_str() else { return };
    let domain = host.to_ascii_lowercase();
    if domain.is_empty() { return }
    out.push(Link {
        text: clean(&entities(if label.trim().is_empty() { url } else { label.trim() }), MAX_HEADER),
        url: url.to_owned(),
        same_as_sender: !sender_domain.is_empty() && registrable(&domain) == sender_domain,
        domain,
    });
}

fn urls_in(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("http") {
        let cand = &rest[at..];
        if !(cand.starts_with("http://") || cand.starts_with("https://")) { rest = &cand[4..]; continue }
        let end = cand.find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | ')' | ']' | '}' | ',' | ';')).unwrap_or(cand.len());
        if out.len() < MAX_LINKS * 2 { out.push(cand[..end].trim_end_matches(['.', ',', ';', ':', '!', '?']).to_owned()) }
        rest = &cand[end..];
    }
    out
}

fn links_of(text: &str, anchors: Vec<(String, String)>, sender: &str) -> Vec<Link> {
    let sender_domain = sender.rsplit_once('@').map(|(_, domain)| registrable(domain)).unwrap_or_default();
    let mut out: Vec<Link> = Vec::new();
    for (label, href) in &anchors { push_link(&mut out, href, label, &sender_domain) }
    for url in urls_in(text) { push_link(&mut out, &url, "", &sender_domain) }
    out
}

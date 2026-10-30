//! #490 — closed `mail_action` for the island's mail card. Slice 1: `{action:"send"}` through
//! the Resend HTTP API with the user's own key (keychain only, never read back to the page).
//!
//! Adapted from NotchBuddy Sources/App/IslandViewContent.swift (`sendMail`, `sendViaResend`)
//! @71b773f, Copyright (c) 2026 Louis Raillé, MIT. Same request (Bearer key, `from`/`to`/
//! `subject`/`text`, base64 `attachments`, 200/201 = sent, an empty subject falls back to the
//! file name or "File", an empty body is sent as one space). Differences: Abito has no Apple
//! Mail fallback; with no Resend account the answer is `not_configured` (SMTP is the next
//! slice). Nothing here logs, stores or returns the key.
use crate::bridge::BridgeError;
use crate::secrets::{SecretStore, StoreError};
use base64::Engine;
use serde_json::{json, Map, Value};

#[cfg(test)]
#[path = "mailcmd_tests.rs"]
mod tests;

/// The one real endpoint. Tests pass a loopback URL; the host never takes one from the page.
pub const RESEND_URL: &str = "https://api.resend.com/emails";
pub const KEY_ID: &str = "resend-api-key";
pub const FROM_ID: &str = "resend-from";
pub const MAX_TO: usize = 254;
pub const MAX_SUBJECT: usize = 120;
pub const MAX_BODY: usize = 4000;
/// Same cap as chat attachments (`uploads::MAX_FILE_BYTES`), applied to the decoded bytes.
pub const MAX_ATTACHMENT_BYTES: usize = crate::uploads::MAX_FILE_BYTES;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub name: String,
    /// Already-validated base64 (standard alphabet), passed through to Resend as is.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    pub to: String,
    pub subject: String,
    pub body: String,
    pub attachment: Option<Attachment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailError {
    /// The service answered something other than 200/201 (or redirected).
    Rejected,
    /// No connection, timeout or an unreadable answer.
    Network,
}

fn bad() -> BridgeError {
    BridgeError::denied("invalid mail request")
}

fn has_control(s: &str, keep_whitespace: bool) -> bool {
    s.chars().any(|c| c.is_control() && !(keep_whitespace && matches!(c, '\n' | '\t')))
}

/// One plain address: no whitespace, one `@`, a dotted domain (not a deliverability check).
fn address_ok(a: &str) -> bool {
    if a.is_empty() || a.chars().count() > MAX_TO || a.chars().any(|c| c.is_whitespace() || matches!(c, ',' | ';' | '<' | '>')) {
        return false;
    }
    let mut parts = a.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else { return false };
    let labels: Vec<&str> = domain.split('.').collect();
    !local.is_empty() && labels.len() >= 2 && labels.iter().all(|l| !l.is_empty())
}

/// Closed schema: `{action:"send", to, subject, body, attachment?:{name,data}}`.
pub fn parse_mail(payload: &Value) -> Result<Draft, BridgeError> {
    let map = payload.as_object().ok_or_else(bad)?;
    if map.get("action").and_then(Value::as_str) != Some("send") {
        return Err(bad());
    }
    let has_attachment = map.contains_key("attachment");
    if map.len() != 4 + usize::from(has_attachment) {
        return Err(bad());
    }
    let text = |k: &str| map.get(k).and_then(Value::as_str).ok_or_else(bad);
    let to = text("to")?.trim_matches(' ').to_owned();
    let subject = text("subject")?.to_owned();
    let body = text("body")?.to_owned();
    if !address_ok(&to)
        || subject.chars().count() > MAX_SUBJECT
        || has_control(&subject, false)
        || body.chars().count() > MAX_BODY
        || has_control(&body, true)
    {
        return Err(bad());
    }
    let attachment = if has_attachment { Some(parse_attachment(map.get("attachment"))?) } else { None };
    let subject = if subject.trim().is_empty() {
        attachment.as_ref().map_or_else(|| "File".to_owned(), |a| a.name.clone())
    } else {
        subject
    };
    Ok(Draft { to, subject, body, attachment })
}

fn parse_attachment(v: Option<&Value>) -> Result<Attachment, BridgeError> {
    let obj: &Map<String, Value> = v.and_then(Value::as_object).ok_or_else(bad)?;
    if obj.len() != 2 {
        return Err(bad());
    }
    let name = obj.get("name").and_then(Value::as_str).ok_or_else(bad)?;
    let data = obj.get("data").and_then(Value::as_str).ok_or_else(bad)?;
    // Check the size before decoding: base64 is 4 chars per 3 bytes.
    if data.is_empty() || data.len() > MAX_ATTACHMENT_BYTES / 3 * 4 + 4 {
        return Err(bad());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| bad())?;
    if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(bad());
    }
    Ok(Attachment { name: crate::uploads::sanitize_name(name), data: data.to_owned() })
}

/// The Resend request body (NotchBuddy `payload`).
pub fn resend_body(from: &str, d: &Draft) -> Value {
    let mut body = json!({
        "from": from,
        "to": [d.to],
        "subject": d.subject,
        "text": if d.body.is_empty() { " " } else { d.body.as_str() },
    });
    if let Some(a) = &d.attachment {
        body["attachments"] = json!([{ "filename": a.name, "content": a.data }]);
    }
    body
}

/// POSTs one mail. 200 and 201 are the only successes; redirects are never followed and
/// nothing about the answer body is read or surfaced.
#[cfg(target_os = "linux")]
pub async fn send_resend(endpoint: &str, key: &str, from: &str, d: &Draft) -> Result<(), MailError> {
    use std::time::Duration;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("Abito/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| MailError::Network)?;
    let payload = serde_json::to_vec(&resend_body(from, d)).map_err(|_| MailError::Network)?;
    let response = client
        .post(endpoint)
        .bearer_auth(key)
        .header("content-type", "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|_| MailError::Network)?;
    match response.status().as_u16() {
        200 | 201 => Ok(()),
        _ => Err(MailError::Rejected),
    }
}

#[cfg(not(target_os = "linux"))]
pub async fn send_resend(_: &str, _: &str, _: &str, _: &Draft) -> Result<(), MailError> {
    Err(MailError::Network)
}

/// Where a mail goes, decided from what the keychain holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Resend { key: String, from: String },
    Smtp(SmtpConfig),
}

/// The user's own SMTP account. `host` is `name` or `name:port`; port 465 means implicit TLS,
/// anything else (587 by default) means STARTTLS, which is REQUIRED: there is no plaintext mode.
#[derive(Clone, PartialEq, Eq)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub from: String,
}

impl std::fmt::Debug for SmtpConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SmtpConfig {{ host: {:?}, port: {}, password: <redacted> }}", self.host, self.port)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Security {
    Implicit,
    StartTls,
    /// Loopback fake servers in tests only.
    #[cfg(test)]
    Plain,
}

impl SmtpConfig {
    pub fn security(&self) -> Security {
        if self.port == 465 { Security::Implicit } else { Security::StartTls }
    }
}

/// `host` or `host:port` → (host, port). Hostname characters only; a port is 1..=65535.
pub fn parse_host(raw: &str) -> Option<(String, u16)> {
    let raw = raw.trim();
    let (host, port) = match raw.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().ok().filter(|p| *p != 0)?),
        None => (raw, 587),
    };
    let ok = !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|l| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    ok.then(|| (host.to_ascii_lowercase(), port))
}

/// Keychain → route, or the answer to give instead of sending. Resend (key + sender) wins,
/// as in NotchBuddy; otherwise a complete SMTP account; otherwise a precise refusal.
pub fn route(store: &dyn SecretStore) -> Result<Route, Value> {
    let read = |k: &str| match store.read(k) {
        Ok(v) => Ok(v.filter(|s| !s.is_empty())),
        Err(StoreError::Unavailable | StoreError::Failed) => Err(json!({"ok": false, "reason": "keychain_unavailable"})),
    };
    let (key, from) = (read(KEY_ID)?, read(FROM_ID)?);
    if let (Some(key), Some(from)) = (&key, &from) {
        return Ok(Route::Resend { key: key.clone(), from: from.clone() });
    }
    if let (Some(host), Some(user), Some(password)) = (read("smtp-host")?, read("smtp-user")?, read("smtp-password")?) {
        let Some((host, port)) = parse_host(&host) else { return Err(json!({"ok": false, "reason": "smtp_config"})) };
        let from = read("smtp-from")?.unwrap_or_else(|| user.clone());
        if !address_ok(from.rsplit_once('<').map_or(from.as_str(), |(_, a)| a.trim_end_matches('>')).trim()) {
            return Err(json!({"ok": false, "reason": "smtp_config"}));
        }
        return Ok(Route::Smtp(SmtpConfig { host, port, user, password, from }));
    }
    // NotchBuddy: «Set sender address in Settings.» when only the key is set.
    if key.is_some() {
        return Err(json!({"ok": false, "reason": "no_sender"}));
    }
    Err(json!({"ok": false, "reason": "not_configured"}))
}

pub fn outcome(r: Result<(), MailError>) -> Value {
    match r {
        Ok(()) => json!({"ok": true}),
        Err(MailError::Rejected) => json!({"ok": false, "reason": "rejected"}),
        Err(MailError::Network) => json!({"ok": false, "reason": "network"}),
    }
}

/// Builds the RFC 5322 message (lettre encodes headers and the attachment; it rejects header injection).
pub fn build_message(from: &str, d: &Draft) -> Result<lettre::Message, MailError> {
    use lettre::message::{header::ContentType, Attachment as Part, MultiPart, SinglePart};
    let b = lettre::Message::builder()
        .from(from.parse().map_err(|_| MailError::Rejected)?)
        .to(d.to.parse().map_err(|_| MailError::Rejected)?)
        .subject(d.subject.clone());
    let text = if d.body.is_empty() { " ".to_owned() } else { d.body.clone() };
    let built = match &d.attachment {
        None => b.body(text),
        Some(a) => {
            let bytes = base64::engine::general_purpose::STANDARD.decode(&a.data).map_err(|_| MailError::Rejected)?;
            b.multipart(
                MultiPart::mixed()
                    .singlepart(SinglePart::plain(text))
                    .singlepart(Part::new(a.name.clone()).body(bytes, ContentType::parse("application/octet-stream").map_err(|_| MailError::Rejected)?)),
            )
        }
    };
    built.map_err(|_| MailError::Rejected)
}

/// Sends through the user's SMTP account (TLS always; credentials only inside the TLS session).
/// `security` is explicit so tests can reach a loopback fake; production uses `cfg.security()`.
pub async fn send_smtp(cfg: &SmtpConfig, security: Security, d: &Draft) -> Result<(), MailError> {
    send_smtp_with(cfg, security, None, d).await
}

/// Same as [`send_smtp`] with an optional TLS configuration (tests inject their own root; the
/// shipped path passes `None` and lettre uses the bundled webpki roots).
pub async fn send_smtp_with(cfg: &SmtpConfig, security: Security, tls: Option<lettre::transport::smtp::client::TlsParameters>, d: &Draft) -> Result<(), MailError> {
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::transport::smtp::client::Tls;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
    let message = build_message(&cfg.from, d)?;
    let builder = match security {
        Security::Implicit => AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host),
        Security::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host),
        #[cfg(test)]
        Security::Plain => Ok(AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host)),
    }
    .map_err(|_| MailError::Network)?;
    let builder = match (tls, security) {
        (Some(p), Security::StartTls) => builder.tls(Tls::Required(p)),
        (Some(p), Security::Implicit) => builder.tls(Tls::Wrapper(p)),
        _ => builder,
    };
    let transport = builder
        .port(cfg.port)
        .credentials(Credentials::new(cfg.user.clone(), cfg.password.clone()))
        .timeout(Some(std::time::Duration::from_secs(30)))
        .build();
    match transport.send(message).await {
        Ok(r) if r.is_positive() => Ok(()),
        Ok(_) => Err(MailError::Rejected),
        Err(e) if e.is_permanent() || e.is_transient() => Err(MailError::Rejected),
        Err(_) => Err(MailError::Network),
    }
}

/// Runs the chosen route.
pub async fn send_route(route: &Route, resend_endpoint: &str, d: &Draft) -> Value {
    outcome(match route {
        Route::Resend { key, from } => send_resend(resend_endpoint, key, from, d).await,
        Route::Smtp(cfg) => send_smtp(cfg, cfg.security(), d).await,
    })
}

/// Credentials → one send → the page's answer (`{ok}` or `{ok:false, reason}`; no secrets).
pub async fn send_answer(store: &dyn SecretStore, endpoint: &str, d: &Draft) -> Value {
    match route(store) {
        Ok(r) => send_route(&r, endpoint, d).await,
        Err(answer) => answer,
    }
}

// ---- the other verbs: inbox, mark read, reply, open the client (slice 3) --------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Send(Draft),
    Inbox,
    MarkRead(u32),
    /// Opens the user's own mail client with a prepared reply (nothing is sent by Abito).
    Reply { to: String, subject: String },
    OpenClient,
}

/// Closed schema for every `mail_action` verb.
pub fn parse_request(payload: &Value) -> Result<Request, BridgeError> {
    let map = payload.as_object().ok_or_else(bad)?;
    match map.get("action").and_then(Value::as_str) {
        Some("send") => parse_mail(payload).map(Request::Send),
        Some("inbox") if map.len() == 1 => Ok(Request::Inbox),
        Some("open_client") if map.len() == 1 => Ok(Request::OpenClient),
        Some("mark_read") if map.len() == 2 => {
            let uid = map.get("uid").and_then(Value::as_u64).filter(|u| (1..=u64::from(u32::MAX)).contains(u)).ok_or_else(bad)?;
            Ok(Request::MarkRead(uid as u32))
        }
        Some("reply") if map.len() == 3 => {
            let to = map.get("to").and_then(Value::as_str).ok_or_else(bad)?.trim_matches(' ').to_owned();
            let subject = map.get("subject").and_then(Value::as_str).ok_or_else(bad)?;
            if !address_ok(&to) || subject.chars().count() > MAX_SUBJECT || has_control(subject, false) {
                return Err(bad());
            }
            let subject = if subject.len() >= 3 && subject[..3].eq_ignore_ascii_case("re:") { subject.to_owned() } else { format!("Re: {subject}") };
            Ok(Request::Reply { to, subject })
        }
        _ => Err(bad()),
    }
}

fn pct(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `mailto:` for a reply. `to` is already a validated plain address, so `@` stays readable.
pub fn mailto(to: &str, subject: &str) -> String {
    format!("mailto:{}?subject={}", pct(to).replace("%40", "@"), pct(subject))
}

pub fn mailto_open() -> &'static str {
    "mailto:"
}

/// The user's IMAP account (`imap-host[:port]`, `imap-user`, `imap-password`); port 993 = implicit TLS.
pub fn imap_config(store: &dyn SecretStore) -> Result<crate::imapcmd::ImapConfig, Value> {
    let read = |k: &str| match store.read(k) {
        Ok(v) => Ok(v.filter(|s| !s.is_empty())),
        Err(StoreError::Unavailable | StoreError::Failed) => Err(json!({"ok": false, "reason": "keychain_unavailable"})),
    };
    let (host, user, password) = (read("imap-host")?, read("imap-user")?, read("imap-password")?);
    let (Some(host), Some(user), Some(password)) = (host, user, password) else {
        return Err(json!({"ok": false, "reason": "imap_not_configured"}));
    };
    let hostport = if host.contains(':') { host } else { format!("{host}:993") };
    let Some((host, port)) = parse_host(&hostport) else { return Err(json!({"ok": false, "reason": "imap_config"})) };
    Ok(crate::imapcmd::ImapConfig { host, port, user, password })
}

fn imap_reason(e: crate::imapcmd::ImapError) -> &'static str {
    use crate::imapcmd::ImapError::*;
    match e {
        Auth => "imap_auth",
        Tls => "imap_tls",
        Network | Timeout => "imap_network",
        Protocol | TooLarge => "imap_protocol",
    }
}

pub fn inbox_answer(r: Result<Vec<crate::imapcmd::Message>, crate::imapcmd::ImapError>) -> Value {
    match r {
        Ok(list) => json!({"ok": true, "messages": list.iter().map(|m| json!({
            "uid": m.uid, "from": m.from_name, "address": m.address, "subject": m.subject,
            "preview": m.preview, "minutesAgo": m.minutes_ago, "read": m.read,
        })).collect::<Vec<_>>()}),
        Err(e) => json!({"ok": false, "reason": imap_reason(e)}),
    }
}

pub fn read_answer(r: Result<(), crate::imapcmd::ImapError>) -> Value {
    match r {
        Ok(()) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "reason": imap_reason(e)}),
    }
}

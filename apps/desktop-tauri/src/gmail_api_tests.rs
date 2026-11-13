//! Tests for the read-only Gmail REST client, through its public interface only.
use super::*;
use crate::gmail_oauth::GmailError;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::Mutex;

// ---- fakes -------------------------------------------------------------------------------------

type Reply = Result<(u16, Value), ApiError>;

/// Replays scripted replies in order and records every (url, bearer).
struct Fake {
    seen: Mutex<Vec<(String, String)>>,
    script: Mutex<VecDeque<Reply>>,
}

impl Fake {
    fn new(script: Vec<Reply>) -> Self {
        Self { seen: Mutex::new(Vec::new()), script: Mutex::new(script.into()) }
    }
    fn urls(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|(u, _)| u.clone()).collect()
    }
    fn bearers(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|(_, b)| b.clone()).collect()
    }
}

impl GmailHttp for Fake {
    fn get(&self, url: &str, bearer: &str) -> Result<HttpReply, ApiError> {
        self.seen.lock().unwrap().push((url.to_owned(), bearer.to_owned()));
        match self.script.lock().unwrap().pop_front() {
            Some(Ok((status, v))) => Ok(HttpReply { status, body: v.to_string().into_bytes() }),
            Some(Err(e)) => Err(e),
            // A test that forgets a reply must fail loudly, not silently.
            None => Err(ApiError::Network),
        }
    }
}

/// Records which rejected token the token provider was handed and issues the queued tokens.
struct Tok {
    calls: Mutex<Vec<Option<String>>>,
    issued: Mutex<VecDeque<String>>,
}

impl Tok {
    fn new(issued: &[&str]) -> Self {
        Self { calls: Mutex::new(Vec::new()), issued: Mutex::new(issued.iter().map(|s| (*s).to_owned()).collect()) }
    }
    fn calls(&self) -> Vec<Option<String>> {
        self.calls.lock().unwrap().clone()
    }
}

impl Tokens for Tok {
    fn access_token(&self, rejected: Option<&str>) -> Result<String, GmailError> {
        self.calls.lock().unwrap().push(rejected.map(str::to_owned));
        Ok(self.issued.lock().unwrap().pop_front().unwrap_or_else(|| "tok-last".to_owned()))
    }
}

fn auth() -> impl Fn(Option<&str>) -> Result<String, GmailError> {
    |_: Option<&str>| Ok("tok".to_owned())
}

// ---- Gmail JSON --------------------------------------------------------------------------------

fn simpler_headers(pairs: &[(&str, &str)]) -> Value {
    json!(pairs.iter().map(|(n, v)| json!({"name": n, "value": v})).collect::<Vec<_>>())
}

fn meta(id: &str, pairs: &[(&str, &str)], ms: u64, labels: &[&str]) -> Value {
    json!({
        "id": id, "threadId": format!("th-{id}"), "internalDate": ms.to_string(),
        "labelIds": labels, "snippet": "hola &amp; chau",
        "payload": {"mimeType": "text/plain", "headers": simpler_headers(pairs)},
    })
}

fn listed(ids: &[&str]) -> Value {
    json!({
        "messages": ids.iter().map(|id| json!({"id": id, "threadId": format!("th-{id}")})).collect::<Vec<_>>(),
        "resultSizeEstimate": ids.len(),
    })
}

fn inbox_label(unread: u64) -> Value {
    json!({"id": "INBOX", "name": "INBOX", "messagesTotal": 900, "messagesUnread": unread})
}

fn ok(v: Value) -> Reply {
    Ok((200, v))
}

fn status(s: u16) -> Reply {
    Ok((s, json!({"error": {"code": s}})))
}

fn b64(text: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text.as_bytes())
}

fn part(mime: &str, text: &str, pairs: &[(&str, &str)]) -> Value {
    json!({"mimeType": mime, "headers": simpler_headers(pairs), "body": {"data": b64(text), "size": text.len()}})
}

fn full(id: &str, pairs: &[(&str, &str)], mut payload: Value, labels: &[&str]) -> Value {
    if !pairs.is_empty() {
        payload["headers"] = simpler_headers(pairs);
    }
    json!({
        "id": id, "threadId": format!("th-{id}"), "internalDate": "1700000000000",
        "labelIds": labels, "snippet": "…", "payload": payload,
    })
}

/// One `format=full` reply for a single-part body, the shape most real messages have.
fn single(id: &str, pairs: &[(&str, &str)], mime: &str, text: &str) -> Value {
    full(id, pairs, part(mime, text, &[]), &["UNREAD"])
}

// ---- inbox: filters ----------------------------------------------------------------------------

#[test]
fn todos_lists_inbox_with_summaries_and_counters() {
    let fake = Fake::new(vec![
        ok(listed(&["a1"])),
        ok(meta("a1", &[("From", "Ana Pérez <ana@ejemplo.com>"), ("Subject", "Hola")], 1_700_000_000_000, &["UNREAD", "IMPORTANT"])),
        ok(inbox_label(128)),
        ok(listed(&[])),
    ]);
    let got = inbox(&auth(), &fake, Filter::Todos, 0).unwrap();
    assert_eq!(got.messages.len(), 1);
    let m = &got.messages[0];
    assert_eq!(m.id, "a1");
    assert_eq!(m.thread_id, "th-a1");
    assert_eq!(m.from_name, "Ana Pérez");
    assert_eq!(m.from_address, "ana@ejemplo.com");
    assert_eq!(m.subject, "Hola");
    assert_eq!(m.snippet, "hola & chau");
    assert_eq!(m.internal_date_ms, 1_700_000_000_000);
    assert!(m.unread);
    assert!(m.important);
    assert_eq!(got.unread_count, 128);
    assert_eq!(got.new_count, 0);
    assert!(!got.new_count_capped);

    let urls = fake.urls();
    assert_eq!(urls.len(), 4);
    assert_eq!(urls[0], format!("{API_BASE}/messages?q=in%3Ainbox&maxResults=20"));
    assert!(urls[1].starts_with(&format!("{API_BASE}/messages/a1?format=metadata")), "{}", urls[1]);
    for header in ["metadataHeaders=From", "metadataHeaders=Subject", "metadataHeaders=Date", "metadataHeaders=List-Unsubscribe", "metadataHeaders=List-Id", "metadataHeaders=Precedence", "metadataHeaders=Auto-Submitted"] {
        assert!(urls[1].contains(header), "missing {header} in {}", urls[1]);
    }
    assert_eq!(urls[2], format!("{API_BASE}/labels/INBOX"));
    assert!(urls[3].contains("q=in%3Ainbox%20is%3Aunread%20after%3A0"), "{}", urls[3]);
    assert!(urls[3].contains("maxResults=100"), "{}", urls[3]);
    assert!(fake.bearers().iter().all(|b| b == "tok"));
}

#[test]
fn nuevos_adds_after_and_drops_messages_already_seen() {
    let fake = Fake::new(vec![
        ok(listed(&["new", "old"])),
        ok(meta("new", &[("From", "a@b.com"), ("Subject", "n")], 2_000, &["UNREAD"])),
        ok(meta("old", &[("From", "c@d.com"), ("Subject", "o")], 1_000, &["UNREAD"])),
        ok(inbox_label(2)),
        ok(listed(&["new", "old"])),
    ]);
    let got = inbox(&auth(), &fake, Filter::Nuevos, 1_500).unwrap();
    assert!(fake.urls()[0].contains("q=in%3Ainbox%20is%3Aunread%20after%3A1"), "{}", fake.urls()[0]);
    assert_eq!(got.messages.len(), 1);
    assert_eq!(got.messages[0].id, "new");
    // `old` was fetched with its exact internalDate, so the second-granularity `after:` is corrected.
    assert_eq!(got.new_count, 1);
    assert!(!got.new_count_capped);
}

#[test]
fn importantes_uses_is_important() {
    let fake = Fake::new(vec![ok(listed(&[])), ok(inbox_label(0)), ok(listed(&[]))]);
    inbox(&auth(), &fake, Filter::Importantes, 0).unwrap();
    assert!(fake.urls()[0].contains("q=in%3Ainbox%20is%3Aimportant"), "{}", fake.urls()[0]);
}

#[test]
fn de_personas_keeps_people_and_drops_automated_senders() {
    let senders = [
        ("person", vec![("From", "Ana <ana@ejemplo.com>")], true),
        ("unsub", vec![("From", "Tienda <hola@shop.com>"), ("List-Unsubscribe", "<https://shop.com/u>")], false),
        ("listid", vec![("From", "Lista <l@shop.com>"), ("List-Id", "<x.shop.com>")], false),
        ("bulk", vec![("From", "Boletín <b@shop.com>"), ("Precedence", "bulk")], false),
        ("preclist", vec![("From", "Boletín <b@shop.com>"), ("Precedence", "list")], false),
        ("precjunk", vec![("From", "Spam <s@shop.com>"), ("Precedence", "junk")], false),
        ("auto", vec![("From", "Robot <r@shop.com>"), ("Auto-Submitted", "auto-generated")], false),
        ("autono", vec![("From", "Ana <ana@ejemplo.com>"), ("Auto-Submitted", "no")], true),
        ("noreply", vec![("From", "Tienda <noreply@shop.com>")], false),
        ("norepl2", vec![("From", "Tienda <no-reply@shop.com>")], false),
        ("donot", vec![("From", "Tienda <donotreply@shop.com>")], false),
        ("notifs", vec![("From", "App <notifications@shop.com>")], false),
        ("postmaster", vec![("From", "Mailer <postmaster@shop.com>")], false),
        ("bounce", vec![("From", "Mailer <bounce@shop.com>")], false),
    ];
    let ids: Vec<&str> = senders.iter().map(|(id, _, _)| *id).collect();
    let mut script = vec![ok(listed(&ids))];
    for (id, pairs, _) in &senders {
        script.push(ok(meta(id, pairs, 500, &["UNREAD"])));
    }
    script.push(ok(inbox_label(0)));
    script.push(ok(listed(&[])));
    let fake = Fake::new(script);

    let got = inbox(&auth(), &fake, Filter::DePersonas, 0).unwrap();
    let kept: Vec<&str> = got.messages.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(kept, ["person", "autono"]);
    assert!(fake.urls()[0].contains("q=in%3Ainbox%20category%3Aprimary"), "{}", fake.urls()[0]);
}

#[test]
fn the_list_never_grows_past_twenty_messages() {
    let ids: Vec<String> = (0..25).map(|n| format!("m{n}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let mut script = vec![ok(listed(&refs))];
    for id in &refs {
        script.push(ok(meta(id, &[("From", "a@b.com"), ("Subject", "s")], 900, &["UNREAD"])));
    }
    script.push(ok(inbox_label(25)));
    script.push(ok(listed(&[])));
    let fake = Fake::new(script);
    let got = inbox(&auth(), &fake, Filter::Todos, 0).unwrap();
    assert_eq!(got.messages.len(), MAX_MESSAGES);
    assert_eq!(fake.urls().len(), 1 + MAX_MESSAGES + 1 + 1);
}

#[test]
fn the_new_counter_is_capped_at_one_page() {
    let ids: Vec<String> = (0..MAX_PAGE).map(|n| format!("n{n}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let fake = Fake::new(vec![ok(listed(&[])), ok(inbox_label(0)), ok(listed(&refs))]);
    let got = inbox(&auth(), &fake, Filter::Todos, 0).unwrap();
    assert_eq!(got.new_count, MAX_PAGE as u32);
    assert!(got.new_count_capped);
}

#[test]
fn encoded_words_and_quoted_names_are_decoded() {
    let subject = format!("=?UTF-8?B?{}?=", base64::engine::general_purpose::STANDARD.encode("Informe ñ"));
    let fake = Fake::new(vec![
        ok(listed(&["a1"])),
        ok(meta("a1", &[("From", "\"Pérez, Ana\" <ana@ejemplo.com>"), ("Subject", &subject)], 1_000, &[])),
        ok(inbox_label(0)),
        ok(listed(&[])),
    ]);
    let got = inbox(&auth(), &fake, Filter::Todos, 0).unwrap();
    assert_eq!(got.messages[0].subject, "Informe ñ");
    assert_eq!(got.messages[0].from_name, "Pérez, Ana");
    assert_eq!(got.messages[0].from_address, "ana@ejemplo.com");
    assert!(!got.messages[0].unread && !got.messages[0].important);
}

// ---- auth and stable codes ---------------------------------------------------------------------

#[test]
fn one_unauthorized_refreshes_the_token_and_retries_once() {
    let fake = Fake::new(vec![status(401), ok(listed(&[])), ok(inbox_label(4)), ok(listed(&[]))]);
    let tok = Tok::new(&["old", "fresh"]);
    let got = inbox(&tok, &fake, Filter::Todos, 0).unwrap();
    assert_eq!(got.unread_count, 4);
    assert_eq!(tok.calls(), vec![None, Some("old".to_owned())]);
    assert_eq!(fake.bearers(), vec!["old", "fresh", "fresh", "fresh"]);
    assert_eq!(fake.urls()[0], fake.urls()[1]);
}

#[test]
fn a_second_unauthorized_asks_to_sign_in_again() {
    let fake = Fake::new(vec![status(401), status(401)]);
    let tok = Tok::new(&["old", "fresh"]);
    let err = inbox(&tok, &fake, Filter::Todos, 0).unwrap_err();
    assert_eq!(err, ApiError::NeedsSignIn);
    assert_eq!(err.code(), "needs_sign_in");
    assert_eq!(tok.calls().len(), 2);
    assert_eq!(fake.urls().len(), 2, "never a third attempt");
}

#[test]
fn status_codes_map_to_stable_error_codes() {
    for (code, name) in [(403u16, "forbidden"), (429, "rate_limited"), (500, "server"), (503, "server"), (400, "invalid")] {
        let fake = Fake::new(vec![status(code)]);
        let err = inbox(&auth(), &fake, Filter::Todos, 0).unwrap_err();
        assert_eq!(err.code(), name, "status {code}");
    }
}

#[test]
fn a_transport_failure_is_a_network_code() {
    let fake = Fake::new(vec![Err(ApiError::Network)]);
    let err = inbox(&auth(), &fake, Filter::Todos, 0).unwrap_err();
    assert_eq!(err.code(), "network");
}

#[test]
fn no_token_means_no_request() {
    let auth = |_: Option<&str>| Err(GmailError::NeedsSignIn);
    let fake = Fake::new(vec![]);
    assert_eq!(inbox(&auth, &fake, Filter::Todos, 0).unwrap_err().code(), "needs_sign_in");
    assert!(fake.urls().is_empty());
}

#[test]
fn only_get_requests_under_the_api_root_are_ever_made() {
    let fake = Fake::new(vec![
        ok(listed(&["a1"])),
        ok(meta("a1", &[("From", "a@b.com"), ("Subject", "s")], 900, &["UNREAD"])),
        ok(inbox_label(1)),
        ok(listed(&["a1"])),
        ok(single("a1", &[("From", "a@b.com"), ("Subject", "s")], "text/plain", "hola")),
    ]);
    inbox(&auth(), &fake, Filter::Todos, 0).unwrap();
    message(&auth(), &fake, "a1").unwrap();
    for url in fake.urls() {
        assert!(url.starts_with(&format!("{API_BASE}/")), "{url}");
        for forbidden in ["modify", "trash", "untrash", "send", "batch", "insert", "import", "delete", "drafts", "settings"] {
            assert!(!url.contains(forbidden), "{forbidden} in {url}");
        }
    }
}

// ---- one message -------------------------------------------------------------------------------

#[test]
fn multipart_prefers_the_plain_text_part() {
    let plain = "Hola Ana,\n\nMirá https://ejemplo.com/panel y https://otro.test/x\n\nGracias.";
    let payload = json!({
        "mimeType": "multipart/alternative", "headers": [],
        "parts": [part("text/plain", plain, &[]), part("text/html", "<p>Hola <b>Ana</b></p>", &[])],
    });
    let fake = Fake::new(vec![ok(full("a1", &[("From", "Ana <ana@ejemplo.com>"), ("Subject", "Panel")], payload, &["UNREAD", "IMPORTANT"]))]);
    let d = message(&auth(), &fake, "a1").unwrap();
    assert_eq!(d.body, plain);
    assert!(!d.body_truncated);
    assert_eq!(d.subject, "Panel");
    assert_eq!(d.reply_subject, "Re: Panel");
    assert_eq!(d.reply_to, "ana@ejemplo.com");
    assert!(d.unread && d.important);
    assert_eq!(d.internal_date_ms, 1_700_000_000_000);
    assert_eq!(d.links.len(), 2);
    assert_eq!(d.links[0].domain, "ejemplo.com");
    assert!(d.links[0].same_as_sender);
    assert!(!d.links[1].same_as_sender);
    assert!(fake.urls()[0].contains("messages/a1?format=full"), "{}", fake.urls()[0]);
}

#[test]
fn html_only_becomes_plain_text_with_no_remote_content() {
    let html = concat!(
        "<html><head><style>.x{color:red}</style><script>alert('boom')</script></head><body>",
        "<p>Hola <b>Ana</b></p><ul><li>uno</li><li>dos</li></ul>",
        "<img src='https://tracker.test/p.gif' width='1'>",
        "<p>Ver <a href='https://ejemplo.com/x'>el panel</a></p><p>&amp; listo &nbsp;ya</p></body></html>"
    );
    let fake = Fake::new(vec![ok(single("a1", &[("From", "Ana <ana@ejemplo.com>"), ("Subject", "HTML")], "text/html", html))]);
    let d = message(&auth(), &fake, "a1").unwrap();
    assert!(d.body.contains("**Ana**"), "{:?}", d.body);
    assert!(d.body.contains("- uno") && d.body.contains("- dos"), "{:?}", d.body);
    assert!(d.body.contains("& listo"), "{:?}", d.body);
    assert!(!d.body.contains("alert") && !d.body.contains("boom"), "{:?}", d.body);
    assert!(!d.body.contains(".x{"), "style leaked: {:?}", d.body);
    assert!(!d.body.contains('<') && !d.body.contains("src="), "{:?}", d.body);
    assert!(!d.body.contains("tracker.test"), "remote image leaked: {:?}", d.body);
    assert_eq!(d.links.len(), 1, "{:?}", d.links);
    assert_eq!(d.links[0].text, "el panel");
    assert_eq!(d.links[0].url, "https://ejemplo.com/x");
    assert!(d.links[0].same_as_sender);
}

#[test]
fn link_chips_compare_the_registrable_domain() {
    let html = concat!(
        "<a href='https://ejemplo.com/a'>uno</a><a href='https://mail.ejemplo.com/b'>dos</a>",
        "<a href='https://ejemplo.com.evil.test/c'>tres</a><a href='https://www.ejemplo.com/d'>cuatro</a>",
        "<a href='https://otro.test/e'>cinco</a>"
    );
    let fake = Fake::new(vec![ok(single("a1", &[("From", "Ana <ana@ejemplo.com>"), ("Subject", "Links")], "text/html", html))]);
    let d = message(&auth(), &fake, "a1").unwrap();
    let flags: Vec<bool> = d.links.iter().map(|l| l.same_as_sender).collect();
    assert_eq!(flags, [true, true, false, true, false]);
    assert_eq!(d.links[1].domain, "mail.ejemplo.com");
    assert_eq!(d.links[2].domain, "ejemplo.com.evil.test");
}

#[test]
fn link_chips_handle_two_level_public_suffixes() {
    let chips = |sender: &str, html: &str| -> Vec<Link> {
        let from = format!("Ana <{sender}>");
        let fake = Fake::new(vec![ok(single("a1", &[("From", &from), ("Subject", "s")], "text/html", html))]);
        message(&auth(), &fake, "a1").unwrap().links
    };
    let uk = chips("ana@shop.co.uk", "<a href='https://shop.co.uk/x'>a</a><a href='https://news.shop.co.uk/y'>b</a><a href='https://shop.co.uk.evil.test/z'>c</a><a href='https://evil.test/?d=shop.co.uk'>d</a>");
    assert_eq!(uk.iter().map(|l| l.same_as_sender).collect::<Vec<_>>(), [true, true, false, false]);
    let ar = chips("lucia@ejemplo.com.ar", "<a href='https://ejemplo.com.ar/a'>a</a><a href='https://ejemplo.com.ar.evil.test/b'>b</a>");
    assert_eq!(ar.iter().map(|l| l.same_as_sender).collect::<Vec<_>>(), [true, false]);
    assert_eq!(ar[0].domain, "ejemplo.com.ar");
}

#[test]
fn the_body_and_the_links_are_capped() {
    let long = "x".repeat(MAX_BODY_CHARS + 10);
    let fake = Fake::new(vec![ok(single("a1", &[("From", "a@b.com"), ("Subject", "s")], "text/plain", &long))]);
    let d = message(&auth(), &fake, "a1").unwrap();
    assert_eq!(d.body.chars().count(), MAX_BODY_CHARS);
    assert!(d.body_truncated);

    let many: String = (0..40).map(|n| format!("https://h{n}.test/p ")).collect();
    let fake = Fake::new(vec![ok(single("a1", &[("From", "a@b.com"), ("Subject", "s")], "text/plain", &many))]);
    let d = message(&auth(), &fake, "a1").unwrap();
    assert_eq!(d.links.len(), MAX_LINKS);
}

#[test]
fn an_invalid_id_never_reaches_the_network() {
    let fake = Fake::new(vec![]);
    for id in ["", "a b", "a/b", "../labels", "id?format=full", &"x".repeat(65), "correo@ejemplo.com"] {
        assert_eq!(message(&auth(), &fake, id).unwrap_err(), ApiError::Invalid, "{id:?}");
    }
    assert!(fake.urls().is_empty());
}

#[test]
fn a_missing_message_is_invalid() {
    let fake = Fake::new(vec![status(404)]);
    assert_eq!(message(&auth(), &fake, "a1").unwrap_err(), ApiError::Invalid);
}

#[test]
fn a_nested_multipart_still_finds_the_plain_text() {
    let payload = json!({
        "mimeType": "multipart/mixed", "headers": [],
        "parts": [
            {"mimeType": "multipart/alternative", "headers": [],
             "parts": [part("text/plain", "El texto de verdad", &[]), part("text/html", "<b>otro</b>", &[])]},
            {"mimeType": "application/pdf", "headers": [], "body": {"data": b64("%PDF-1.4")}},
        ],
    });
    let fake = Fake::new(vec![ok(full("a1", &[("From", "Ana <ana@ejemplo.com>"), ("Subject", "Adjunto")], payload, &[]))]);
    assert_eq!(message(&auth(), &fake, "a1").unwrap().body, "El texto de verdad");
}

#[test]
fn a_quoted_printable_part_is_decoded() {
    let payload = part(
        "text/plain",
        "Se=C3=B1or, l=C3=ADnea larga=\r\nseguida",
        &[("From", "Ana <ana@ejemplo.com>"), ("Subject", "Acentos"), ("Content-Transfer-Encoding", "quoted-printable")],
    );
    let fake = Fake::new(vec![ok(full("a1", &[], payload, &[]))]);
    assert_eq!(message(&auth(), &fake, "a1").unwrap().body, "Señor, línea largaseguida");
}

#[test]
fn an_unusable_reply_to_falls_back_to_the_sender() {
    let fake = Fake::new(vec![ok(single("a1", &[("From", "Ana <ana@ejemplo.com>"), ("Reply-To", "sin arroba"), ("Subject", "Hola")], "text/plain", "hola"))]);
    let d = message(&auth(), &fake, "a1").unwrap();
    assert_eq!(d.reply_to, "ana@ejemplo.com");
    assert!(reply_mailto(&d).is_some());
}

// ---- reply (S2) --------------------------------------------------------------------------------

#[test]
fn reply_uses_reply_to_and_the_re_prefix_once() {
    let fake = Fake::new(vec![ok(single("a1", &[("From", "Ana <ana@ejemplo.com>"), ("Reply-To", "Soporte <soporte@ejemplo.com>"), ("Subject", "Consulta de facturación")], "text/plain", "hola"))]);
    let d = message(&auth(), &fake, "a1").unwrap();
    assert_eq!(d.reply_to, "soporte@ejemplo.com");
    assert_eq!(d.reply_subject, "Re: Consulta de facturación");
    assert_eq!(reply_mailto(&d).unwrap(), "mailto:soporte@ejemplo.com?subject=Re%3A%20Consulta%20de%20facturaci%C3%B3n");

    let fake = Fake::new(vec![ok(single("a2", &[("From", "Ana <ana@ejemplo.com>"), ("Subject", "RE: ya iba")], "text/plain", "hola"))]);
    let d = message(&auth(), &fake, "a2").unwrap();
    assert_eq!(d.reply_subject, "RE: ya iba");
}

#[test]
fn reply_mailto_refuses_an_address_it_cannot_quote() {
    let base = || Detail {
        id: "a1".into(), thread_id: "t1".into(), from_name: "Ana".into(), from_address: "ana@ejemplo.com".into(),
        reply_to: "ana@ejemplo.com".into(), subject: "Hola".into(), reply_subject: "Re: Hola".into(),
        body: String::new(), body_truncated: false, internal_date_ms: 0, unread: false, important: false, links: vec![],
    };
    assert_eq!(reply_mailto(&base()).unwrap(), "mailto:ana@ejemplo.com?subject=Re%3A%20Hola");
    for bad in ["a@b.com?x=1", "a&b@c.com", "a\nb@c.com", "a@@b.com", "sin-arroba", "@b.com", "a@", "a b@c.com"] {
        let mut d = base();
        d.reply_to = bad.to_owned();
        assert_eq!(reply_mailto(&d), None, "{bad:?}");
    }
}

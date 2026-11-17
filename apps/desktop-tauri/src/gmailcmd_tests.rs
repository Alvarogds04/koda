//! Tests for the closed `gmail_action` boundary, through its public interface only: schema,
//! status mapping, the sign-in lifecycle, the counter's mark, the read-only calls and «Responder».
//! No window, no browser, no network: the loopback listener is real (it is a local socket), the
//! opener, the keychain, the token endpoint and the Gmail API are all fakes.
use super::*;
use crate::gmail_api::{ApiError, HttpReply, Summary};
use crate::provider_oauth::{OauthError, TokenHttp, TokenReply};
use crate::secrets::StoreError;
use serde_json::json;
use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const ID: &str = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";
const SECRET: &str = "GOCSPX-abcDEF_123-xyz";
const TOKEN: &str = "ya29.access-token-secret";
const REFRESH: &str = "1//refresh-token-secret";
const LAST_SEEN: u64 = 1_700_000_000_000;

// ---- fakes -------------------------------------------------------------------------------------

/// An in-memory keychain, with a switch that makes every call fail like a locked Secret Service.
#[derive(Default)]
struct Store {
    map: Mutex<BTreeMap<String, String>>,
    down: Mutex<bool>,
}
impl SecretStore for Store {
    fn read(&self, key: &str) -> Result<Option<String>, StoreError> {
        if *self.down.lock().unwrap() { return Err(StoreError::Unavailable) }
        Ok(self.map.lock().unwrap().get(key).cloned())
    }
    fn write(&self, key: &str, value: &str) -> Result<(), StoreError> {
        if *self.down.lock().unwrap() { return Err(StoreError::Unavailable) }
        self.map.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), StoreError> {
        if *self.down.lock().unwrap() { return Err(StoreError::Unavailable) }
        self.map.lock().unwrap().remove(key);
        Ok(())
    }
}
impl Store {
    fn raw(&self) -> Option<Value> {
        self.map.lock().unwrap().get(gmail_oauth::KEY).map(|s| serde_json::from_str(s).unwrap())
    }
    fn set_down(&self, down: bool) { *self.down.lock().unwrap() = down }
}

/// The token endpoint: records every POST and replays queued answers.
#[derive(Default)]
struct Tokens {
    replies: Mutex<Vec<Result<TokenReply, OauthError>>>,
    calls: Mutex<Vec<(String, Vec<(String, String)>)>>,
}
impl TokenHttp for Tokens {
    fn post(&self, url: &str, form: &[(String, String)]) -> Result<TokenReply, OauthError> {
        self.calls.lock().unwrap().push((url.into(), form.to_vec()));
        self.replies.lock().unwrap().pop().unwrap_or(Err(OauthError::Transport))
    }
}
impl Tokens {
    fn urls(&self) -> Vec<String> { self.calls.lock().unwrap().iter().map(|(u, _)| u.clone()).collect() }
}

/// The Gmail API: replays scripted replies in order and records every (url, bearer).
struct Api {
    script: Mutex<VecDeque<Result<(u16, Value), ApiError>>>,
    seen: Mutex<Vec<(String, String)>>,
}
impl Api {
    fn new(script: Vec<Result<(u16, Value), ApiError>>) -> Self {
        Self { script: Mutex::new(script.into()), seen: Mutex::new(Vec::new()) }
    }
    fn urls(&self) -> Vec<String> { self.seen.lock().unwrap().iter().map(|(u, _)| u.clone()).collect() }
    fn bearers(&self) -> Vec<String> { self.seen.lock().unwrap().iter().map(|(_, b)| b.clone()).collect() }
}
impl GmailHttp for Api {
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

/// The whole host, injected: keychain, token endpoint, API, wall clock, opener and the mark.
struct Rig {
    store: Store,
    tokens: Tokens,
    api: Api,
    now: AtomicU64,
    opened: Mutex<Vec<String>>,
    opens: Mutex<bool>,
    seen: Mutex<u64>,
    seen_fails: Mutex<bool>,
}
impl Seen for Rig {
    fn last_seen_ms(&self) -> u64 { *self.seen.lock().unwrap() }
    // Deliberately naive: it stores whatever it is handed, so a missing monotonic guard in
    // `apply` shows up as a stored regression instead of being hidden here.
    fn remember(&self, at_ms: u64) -> Result<(), ()> {
        if *self.seen_fails.lock().unwrap() { return Err(()) }
        *self.seen.lock().unwrap() = at_ms;
        Ok(())
    }
}
impl Rig {
    fn new(script: Vec<Result<(u16, Value), ApiError>>) -> Self {
        Self {
            store: Store::default(), tokens: Tokens::default(), api: Api::new(script),
            now: AtomicU64::new(1_760_000_000_000), opened: Mutex::new(Vec::new()),
            opens: Mutex::new(true), seen: Mutex::new(0), seen_fails: Mutex::new(false),
        }
    }
    fn now_ms(&self) -> u64 { self.now.load(Ordering::SeqCst) }
    fn advance_ms(&self, ms: u64) { self.now.fetch_add(ms, Ordering::SeqCst); }
    fn open_fails(&self) { *self.opens.lock().unwrap() = false }
    fn opened(&self) -> Vec<String> { self.opened.lock().unwrap().clone() }
    fn mark(&self, at_ms: u64) { *self.seen.lock().unwrap() = at_ms }
    fn stored_mark(&self) -> u64 { *self.seen.lock().unwrap() }
    /// A stored client (never connected) or a connected one (`tokens`), or one Google stopped
    /// accepting (`reconnect`).
    fn with_client(&self, state: &str) {
        let (refresh, access, reconnect) = match state {
            "signed_out" => ("", Value::Null, false),
            "reconnect" => ("", Value::Null, true),
            _ => (REFRESH, json!(TOKEN), false),
        };
        let text = json!({
            "client_id": ID, "client_secret": SECRET, "refresh_token": refresh,
            "access_token": access, "expires_at": 9_999_999_999u64, "reconnect": reconnect,
        }).to_string();
        self.store.write(gmail_oauth::KEY, &text).unwrap();
    }
    /// Runs one command on ONE `Flows` (created per run, like the app's single slot).
    fn run<T>(&self, f: impl FnOnce(&Flows, &Env<'_>) -> T) -> T { self.run_on(&Flows::default(), f) }
    fn run_on<T>(&self, flows: &Flows, f: impl FnOnce(&Flows, &Env<'_>) -> T) -> T {
        let seconds = || self.now_ms() / 1000;
        let auth = GmailAuth::new(&self.store, &self.tokens, &seconds);
        let now = || self.now_ms();
        let open = |url: &str| {
            self.opened.lock().unwrap().push(url.to_owned());
            *self.opens.lock().unwrap()
        };
        let env = Env {
            store: &self.store, auth: &auth, http: &self.api, now_ms: &now, opener: &open, seen: self,
        };
        f(flows, &env)
    }
    fn apply(&self, cmd: &Value) -> Value {
        let cmd = parse(cmd).expect("the schema accepts this action");
        self.run(|flows, env| flows.apply(env, cmd).unwrap())
    }
}

// Gmail JSON helpers (the same shapes `gmail_api` reads).
fn headers(pairs: &[(&str, &str)]) -> Value {
    json!(pairs.iter().map(|(n, v)| json!({"name": n, "value": v})).collect::<Vec<_>>())
}
fn meta(id: &str, from: &str, subject: &str, ms: u64, labels: &[&str]) -> Value {
    json!({
        "id": id, "threadId": format!("th-{id}"), "internalDate": ms.to_string(),
        "labelIds": labels, "snippet": "un adelanto",
        "payload": {"mimeType": "text/plain", "headers": headers(&[("From", from), ("Subject", subject)])},
    })
}
fn full(id: &str, from: &str, subject: &str, body: &str) -> Value {
    use base64::Engine;
    let data = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body.as_bytes());
    json!({
        "id": id, "threadId": format!("th-{id}"), "internalDate": "1700000001000", "labelIds": ["UNREAD"],
        "payload": {"mimeType": "text/plain", "headers": headers(&[("From", from), ("Subject", subject)]),
                    "body": {"data": data}},
    })
}
fn ok(v: Value) -> Result<(u16, Value), ApiError> { Ok((200, v)) }
fn id_list(ids: &[&str]) -> Value {
    json!({"messages": ids.iter().map(|id| json!({"id": id, "threadId": format!("th-{id}")})).collect::<Vec<_>>()})
}

// ---- closed schema -----------------------------------------------------------------------------

#[test]
fn the_schema_accepts_exactly_the_documented_shape_of_each_action() {
    for action in ["status", "begin", "poll", "cancel", "forget"] {
        assert!(parse(&json!({"action": action})).is_some(), "{action}");
        assert!(parse(&json!({"action": action, "extra": 1})).is_none(), "{action} with an extra key");
        assert!(parse(&json!({"action": action, "atMs": 1})).is_none(), "{action} with a foreign field");
    }
    assert_eq!(parse(&json!({"action": "set_client", "clientId": ID})), Some(Cmd::SetClient(Client { id: ID.into(), secret: None })));
    assert_eq!(
        parse(&json!({"action": "set_client", "clientId": ID, "clientSecret": SECRET})),
        Some(Cmd::SetClient(Client { id: ID.into(), secret: Some(SECRET.into()) }))
    );
    // The pasted whitespace Google Cloud copies along is trimmed, an empty secret means none.
    assert_eq!(parse(&json!({"action": "set_client", "clientId": format!("  {ID} "), "clientSecret": "  "})),
        Some(Cmd::SetClient(Client { id: ID.into(), secret: None })));
    for bad in [
        json!({"action": "set_client"}),
        json!({"action": "set_client", "clientId": ""}),
        json!({"action": "set_client", "clientId": "nope"}),
        json!({"action": "set_client", "clientId": format!("{}.apps.googleusercontent.com", "x".repeat(300))}),
        json!({"action": "set_client", "clientId": ID, "clientSecret": "x".repeat(MAX_CLIENT_SECRET + 1)}),
        json!({"action": "set_client", "clientId": ID, "clientSecret": "se cret"}),
        json!({"action": "set_client", "clientId": ID, "clientSecret": "a\nb"}),
        json!({"action": "set_client", "clientId": ID, "clientSecret": null}),
        json!({"action": "set_client", "clientId": ID, "clientSecret": SECRET, "extra": 1}),
        json!({"action": "set_client", "clientid": ID}),
        json!({"action": "set_client", "clientId": 5}),
    ] {
        assert!(parse(&bad).is_none(), "{bad} must be refused");
    }
    for (name, filter) in [("nuevos", Filter::Nuevos), ("importantes", Filter::Importantes), ("personas", Filter::DePersonas), ("todos", Filter::Todos)] {
        assert_eq!(parse(&json!({"action": "inbox", "filter": name})), Some(Cmd::Inbox(filter)), "{name}");
    }
    for bad in [
        json!({"action": "inbox"}),
        json!({"action": "inbox", "filter": "spam"}),
        json!({"action": "inbox", "filter": "Todos"}),
        json!({"action": "inbox", "filter": "todos", "after": 1}),
        json!({"action": "inbox", "filter": 1}),
    ] {
        assert!(parse(&bad).is_none(), "{bad} must be refused");
    }
    for action in ["message", "reply"] {
        assert_eq!(parse(&json!({"action": action, "id": "18a2f-9b"})), Some(if action == "message" { Cmd::Message("18a2f-9b".into()) } else { Cmd::Reply("18a2f-9b".into()) }));
        for bad in [json!(""), json!("a/b"), json!("@@@"), json!("x".repeat(MAX_ID + 1)), json!("id con espacio"), json!(7), json!(null)] {
            assert!(parse(&json!({"action": action, "id": bad})).is_none(), "{action} with {bad}");
        }
        assert!(parse(&json!({"action": action, "id": "a", "folder": "x"})).is_none());
        assert!(parse(&json!({"action": action})).is_none());
    }
    assert_eq!(parse(&json!({"action": "seen", "atMs": 1_700_000_000_000u64})), Some(Cmd::Seen(1_700_000_000_000)));
    for bad in [json!(0), json!(-1), json!(1.5), json!("5"), json!(null), json!(true)] {
        assert!(parse(&json!({"action": "seen", "atMs": bad})).is_none(), "seen with {bad}");
    }
    assert!(parse(&json!({"action": "seen"})).is_none());
    assert!(parse(&json!({"action": "seen", "atMs": 1, "extra": 1})).is_none());
    for bad in [json!(null), json!([]), json!("status"), json!({}), json!({"action": "refresh"}), json!({"action": true}), json!({"Action": "status"}), json!({"action": "STATUS"})] {
        assert!(parse(&bad).is_none(), "{bad} must be refused");
    }
}

#[test]
fn nothing_typed_from_the_page_ever_reaches_a_debug_line() {
    let cmd = parse(&json!({"action": "set_client", "clientId": ID, "clientSecret": SECRET})).unwrap();
    let debug = format!("{cmd:?}");
    for secret in [ID, SECRET, "GOCSPX", "apps.googleusercontent"] {
        assert!(!debug.contains(secret), "Debug leaked {secret}");
    }
    assert!(debug.contains("redacted"), "{debug}");
    let flows = Flows::default();
    assert_eq!(format!("{flows:?}"), "Flows(<redacted>)");
}

// ---- status ------------------------------------------------------------------------------------

#[test]
fn status_maps_every_state_and_only_ever_masks_the_client() {
    let rig = Rig::new(vec![]);
    assert_eq!(rig.apply(&json!({"action": "status"})), json!({"ok": true, "state": "no_client", "clientId": null, "hasSecret": false}));
    for (stored, state) in [("signed_out", "signed_out"), ("connected", "connected"), ("reconnect", "reconnect")] {
        let rig = Rig::new(vec![]);
        rig.with_client(stored);
        let answer = rig.apply(&json!({"action": "status"}));
        assert_eq!(answer["state"], state, "{stored}");
        assert_eq!(answer["ok"], true);
        assert_eq!(answer["clientId"], "123456…", "only the first six characters");
        assert_eq!(answer["hasSecret"], true);
        let text = answer.to_string();
        for secret in [ID, SECRET, REFRESH, TOKEN] {
            assert!(!text.contains(secret), "{stored}: the answer leaked {secret}");
        }
    }
    // A stored entry this module cannot read yields no mask — it never guesses.
    let rig = Rig::new(vec![]);
    rig.store.write(gmail_oauth::KEY, "not json").unwrap();
    assert_eq!(rig.apply(&json!({"action": "status"}))["clientId"], Value::Null);
}

#[test]
fn a_locked_keychain_is_an_honest_code_not_a_panic() {
    let rig = Rig::new(vec![]);
    rig.with_client("signed_out");
    rig.store.set_down(true);
    assert_eq!(rig.apply(&json!({"action": "status"})), json!({"ok": false, "reason": "keychain"}));
}

#[test]
fn set_client_saves_the_pasted_client_and_answers_the_new_state() {
    let rig = Rig::new(vec![]);
    let answer = rig.apply(&json!({"action": "set_client", "clientId": ID, "clientSecret": SECRET}));
    assert_eq!(answer, json!({"ok": true, "state": "signed_out", "clientId": "123456…", "hasSecret": true}));
    let stored = rig.store.raw().expect("the client is in the keychain");
    assert_eq!(stored["client_id"], ID);
    assert_eq!(stored["client_secret"], SECRET);
    assert_eq!(stored["refresh_token"], "", "no sign-in yet");
    let text = answer.to_string();
    assert!(!text.contains(SECRET) && !text.contains(ID), "the answer carries no credential");
    // Without a secret (Google's own choice for desktop clients) it is still a valid client.
    let rig = Rig::new(vec![]);
    let answer = rig.apply(&json!({"action": "set_client", "clientId": ID}));
    assert_eq!(answer["hasSecret"], false);
    assert_eq!(answer["state"], "signed_out");
}

// ---- sign-in: begin / poll / cancel ----------------------------------------------------------

#[test]
fn begin_needs_a_client_and_opens_google_with_pkce_in_the_system_browser() {
    let rig = Rig::new(vec![]);
    assert_eq!(rig.apply(&json!({"action": "begin"})), json!({"ok": false, "reason": "no_client"}));
    rig.with_client("signed_out");
    let answer = rig.apply(&json!({"action": "begin"}));
    assert_eq!(answer, json!({"ok": true, "state": "waiting", "browserOpened": true}));
    let opened = rig.opened();
    assert_eq!(opened.len(), 1);
    let url = oauth2::url::Url::parse(&opened[0]).expect("a real URL reaches the opener");
    assert_eq!(url.host_str(), Some("accounts.google.com"));
    let pairs: BTreeMap<String, String> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    assert_eq!(pairs["scope"], gmail_oauth::SCOPE);
    assert_eq!(pairs["code_challenge_method"], "S256");
    assert!(pairs["code_challenge"].len() > 20);
    assert!(pairs["state"].len() > 10);
    assert_eq!(pairs["access_type"], "offline");
    assert!(pairs["redirect_uri"].starts_with("http://127.0.0.1:"), "{}", pairs["redirect_uri"]);
    // The answer never carries the authorization material back to the page.
    let text = answer.to_string();
    assert!(!text.contains(&pairs["state"]) && !text.contains(&pairs["code_challenge"]));
    assert!(!text.contains("authUrl"));
}

#[test]
fn begin_replaces_the_previous_flow_and_a_failing_opener_still_offers_the_url() {
    let rig = Rig::new(vec![]);
    rig.with_client("signed_out");
    rig.run(|flows, env| {
        flows.apply(env, Cmd::Begin).unwrap();
        flows.apply(env, Cmd::Begin).unwrap();
        assert_eq!(flows.pending_count(), 1, "one slot: the old listener is dropped before binding again");
    });
    let first = rig.opened()[0].clone();
    let second = rig.opened()[1].clone();
    assert_ne!(first, second, "a new flow is a new state and port");
    // No browser: the page gets the URL so the human can open it by hand (the loopback still answers).
    let rig = Rig::new(vec![]);
    rig.with_client("signed_out");
    rig.open_fails();
    let answer = rig.apply(&json!({"action": "begin"}));
    assert_eq!(answer["ok"], true);
    assert_eq!(answer["state"], "waiting");
    assert_eq!(answer["browserOpened"], false);
    assert_eq!(answer["authUrl"], rig.opened()[0]);
    assert!(!safe_mailto(answer["authUrl"].as_str().unwrap()), "the URL is http(s), not a mailto");
    assert!(!answer["authUrl"].as_str().unwrap().chars().any(char::is_control));
}

#[test]
fn poll_answers_waiting_done_or_a_code_and_never_twice() {
    // No flow at all.
    let rig = Rig::new(vec![]);
    assert_eq!(rig.apply(&json!({"action": "poll"})), json!({"ok": true, "state": "none"}));
    // A real pending flow with no callback yet.
    rig.with_client("signed_out");
    rig.run(|flows, env| {
        flows.apply(env, Cmd::Begin).unwrap();
        assert_eq!(flows.apply(env, Cmd::Poll).unwrap(), json!({"ok": true, "state": "waiting"}));
        // The pending authorization is still held: a second poll keeps waiting.
        assert_eq!(flows.apply(env, Cmd::Poll).unwrap(), json!({"ok": true, "state": "waiting"}));
        assert_eq!(flows.pending_count(), 1);
    });
    // Every outcome of one loopback poll, including the finished one (a real browser callback
    // needs a port the page never names, so the decision itself is what is pinned here).
    assert_eq!(poll_answer(Ok(false)), json!({"ok": true, "state": "waiting"}));
    assert_eq!(poll_answer(Ok(true)), json!({"ok": true, "state": "done"}));
    for (error, code) in [
        (GmailError::Expired, "expired"), (GmailError::State, "state"), (GmailError::Denied, "denied"),
        (GmailError::Used, "used"), (GmailError::Rejected, "rejected"), (GmailError::ScopeMissing, "scope_missing"),
        (GmailError::Transport, "network"), (GmailError::Invalid, "invalid"), (GmailError::Store, "keychain"),
        (GmailError::PortBusy, "port_busy"), (GmailError::NeedsSignIn, "needs_sign_in"), (GmailError::NoClient, "no_client"),
    ] {
        assert_eq!(poll_answer(Err(error)), json!({"ok": false, "reason": code}), "{code}");
    }
}

#[test]
fn an_expired_sign_in_ends_the_flow_with_a_code_and_releases_the_slot() {
    let rig = Rig::new(vec![]);
    rig.with_client("signed_out");
    rig.run(|flows, env| {
        flows.apply(env, Cmd::Begin).unwrap();
        rig.advance_ms(3_600_000); // an hour: far past the pending authorization's life
        assert_eq!(flows.apply(env, Cmd::Poll).unwrap(), json!({"ok": false, "reason": "expired"}));
        assert_eq!(flows.pending_count(), 0, "a finished flow is never polled again");
        assert_eq!(flows.apply(env, Cmd::Poll).unwrap(), json!({"ok": true, "state": "none"}));
    });
}

#[test]
fn cancel_drops_the_flow_and_forget_drops_the_credential() {
    let rig = Rig::new(vec![]);
    rig.with_client("signed_out");
    rig.run(|flows, env| {
        flows.apply(env, Cmd::Begin).unwrap();
        assert_eq!(flows.apply(env, Cmd::Cancel).unwrap(), json!({"ok": true, "state": "none"}));
        assert_eq!(flows.pending_count(), 0);
        assert_eq!(flows.apply(env, Cmd::Cancel).unwrap(), json!({"ok": true, "state": "none"}), "cancel is idempotent");
    });
    rig.with_client("connected");
    rig.run(|flows, env| {
        flows.apply(env, Cmd::Begin).unwrap();
        assert_eq!(flows.apply(env, Cmd::Forget).unwrap(), json!({"ok": true, "state": "no_client"}));
        assert_eq!(flows.pending_count(), 0, "forget also drops a sign-in in flight");
    });
    assert!(rig.store.raw().is_none(), "nothing is left in the keychain");
    assert!(rig.tokens.urls().iter().any(|u| u == gmail_oauth::REVOKE_URL), "the grant is revoked at Google, best effort");
    assert_eq!(rig.apply(&json!({"action": "status"}))["state"], "no_client");
}

// ---- the counter's mark ----------------------------------------------------------------------

#[test]
fn the_mark_only_moves_forwards_and_never_past_now() {
    let rig = Rig::new(vec![]);
    assert_eq!(rig.apply(&json!({"action": "seen", "atMs": 5_000})), json!({"ok": true, "lastSeenMs": 5_000}));
    assert_eq!(rig.stored_mark(), 5_000);
    assert_eq!(rig.apply(&json!({"action": "seen", "atMs": 9_000}))["lastSeenMs"], 9_000);
    assert_eq!(rig.stored_mark(), 9_000);
    // An earlier visit — a late answer, a clock that stepped back — never rewrites the mark.
    assert_eq!(rig.apply(&json!({"action": "seen", "atMs": 1_000})), json!({"ok": true, "lastSeenMs": 9_000}));
    assert_eq!(rig.stored_mark(), 9_000, "the mark never moves backwards");
    // The page cannot hide new mail by claiming a future visit.
    let now = rig.now_ms();
    assert_eq!(rig.apply(&json!({"action": "seen", "atMs": now + 600_000}))["lastSeenMs"], now);
    assert_eq!(rig.stored_mark(), now);
    // A storage failure is an honest code, never a silent success.
    *rig.seen_fails.lock().unwrap() = true;
    assert_eq!(rig.apply(&json!({"action": "seen", "atMs": now + 1_000})), json!({"ok": false, "reason": "prefs"}));
}

// ---- the read-only list and detail -----------------------------------------------------------

#[test]
fn inbox_wires_the_counter_to_the_stored_mark() {
    let rig = Rig::new(vec![
        ok(id_list(&["m1", "m2"])),
        ok(meta("m1", "Ana <ana@example.com>", "Hola", LAST_SEEN + 500, &["UNREAD", "INBOX"])),
        ok(meta("m2", "Bruno <bruno@example.com>", "Viejo", LAST_SEEN - 100_000, &["INBOX"])),
        ok(json!({"messagesUnread": 12})),
        ok(id_list(&["m1", "m2", "m3"])),
    ]);
    rig.with_client("connected");
    rig.mark(LAST_SEEN);
    let answer = rig.apply(&json!({"action": "inbox", "filter": "todos"}));
    assert_eq!(answer["ok"], true, "{answer}");
    let messages = answer["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["id"], "m1");
    assert_eq!(messages[0]["from"], "Ana");
    assert_eq!(messages[0]["address"], "ana@example.com");
    assert_eq!(messages[0]["subject"], "Hola");
    assert_eq!(messages[0]["unread"], true);
    assert_eq!(messages[1]["unread"], false);
    // m1 (already fetched, newer than the mark) + m3 (never fetched): m2 is older than the mark.
    assert_eq!(answer["newCount"], 2);
    assert_eq!(answer["newCountCapped"], false);
    assert_eq!(answer["unreadCount"], 12);
    assert_eq!(answer["lastSeenMs"], LAST_SEEN);
    let urls = rig.api.urls();
    assert!(urls[0].contains("q=in%3Ainbox"), "{}", urls[0]);
    let counter = urls.last().unwrap();
    assert!(counter.contains(&format!("after%3A{}", LAST_SEEN / 1000)), "the counter reads the stored mark: {counter}");
    for bearer in rig.api.bearers() {
        assert_eq!(bearer, TOKEN);
    }
    assert!(!answer.to_string().contains(TOKEN), "the token never reaches the page");
}

#[test]
fn a_full_counter_page_is_reported_as_capped() {
    let many: Vec<String> = (0..crate::gmail_api::MAX_PAGE).map(|i| format!("m{i}")).collect();
    let ids: Vec<&str> = many.iter().map(String::as_str).collect();
    let rig = Rig::new(vec![ok(json!({})), ok(json!({"messagesUnread": 0})), ok(id_list(&ids))]);
    rig.with_client("connected");
    let answer = rig.apply(&json!({"action": "inbox", "filter": "nuevos"}));
    assert_eq!(answer["newCount"], crate::gmail_api::MAX_PAGE as u64);
    assert_eq!(answer["newCountCapped"], true, "Gmail never says «more»");
    assert!(answer["messages"].as_array().unwrap().is_empty());
}

#[test]
fn message_returns_the_plain_text_detail_and_its_link_chips() {
    let rig = Rig::new(vec![ok(full("m1", "Ana <ana@example.com>", "Hola", "Primera línea\nSegunda"))]);
    rig.with_client("connected");
    let answer = rig.apply(&json!({"action": "message", "id": "m1"}));
    assert_eq!(answer["ok"], true, "{answer}");
    let detail = &answer["detail"];
    assert_eq!(detail["id"], "m1");
    assert_eq!(detail["from"], "Ana");
    assert_eq!(detail["subject"], "Hola");
    assert_eq!(detail["body"], "Primera línea\nSegunda");
    assert_eq!(detail["bodyTruncated"], false);
    assert_eq!(detail["unread"], true);
    assert!(detail["links"].is_array());
    assert!(!answer.to_string().contains(TOKEN));
    assert!(rig.api.urls()[0].contains("format=full"), "{}", rig.api.urls()[0]);
}

// ---- «Responder» (S2) ------------------------------------------------------------------------

#[test]
fn reply_opens_the_mail_client_with_the_subject_ready() {
    let rig = Rig::new(vec![ok(full("m1", "Ana <ana@example.com>", "Hola", "texto"))]);
    rig.with_client("connected");
    assert_eq!(rig.apply(&json!({"action": "reply", "id": "m1"})), json!({"ok": true, "opened": true}));
    let opened = rig.opened();
    assert_eq!(opened.len(), 1);
    assert!(opened[0].starts_with("mailto:ana@example.com?subject=Re%3A%20Hola"), "{}", opened[0]);
    assert!(safe_mailto(&opened[0]));
    // A mail client that cannot be started is reported, not claimed.
    let rig = Rig::new(vec![ok(full("m1", "Ana <ana@example.com>", "Hola", "texto"))]);
    rig.with_client("connected");
    rig.open_fails();
    assert_eq!(rig.apply(&json!({"action": "reply", "id": "m1"})), json!({"ok": true, "opened": false}));
}

#[test]
fn reply_refuses_an_address_it_cannot_quote_and_then_never_opens_anything() {
    for from in ["sin arroba", "dos@arrobas@example.com", "", "ana@example.com\ninyectado"] {
        let rig = Rig::new(vec![ok(full("m1", from, "Hola", "texto"))]);
        rig.with_client("connected");
        assert_eq!(rig.apply(&json!({"action": "reply", "id": "m1"})), json!({"ok": false, "reason": "invalid"}), "{from:?}");
        assert!(rig.opened().is_empty(), "{from:?}: nothing was opened");
    }
    // A hostile `Reply-To` falls back to the sender inside `gmail_api`, never to a header value.
    let mut weird = full("m1", "Ana <ana@example.com>", "Hola", "texto");
    weird["payload"]["headers"] = headers(&[("From", "Ana <ana@example.com>"), ("Subject", "Hola"), ("Reply-To", "otro@example.com?bcc=mallory@evil.test")]);
    let rig = Rig::new(vec![ok(weird)]);
    rig.with_client("connected");
    assert_eq!(rig.apply(&json!({"action": "reply", "id": "m1"})), json!({"ok": true, "opened": true}));
    assert_eq!(rig.opened()[0], "mailto:ana@example.com?subject=Re%3A%20Hola");
}

#[test]
fn safe_mailto_admits_the_scheme_and_nothing_else() {
    for good in ["mailto:", "mailto:ana@example.com?subject=Re%3A%20Hola", "mailto:a@b.co"] {
        assert!(safe_mailto(good), "{good}");
    }
    for bad in [
        "", "http://example.com", "https://example.com/?mailto:x", "MAILTO:a@b.co", "mailto:a@b.co\nbcc=x",
        "mailto:a@b.co bcc=x", " mailto:a@b.co", "mailto:\u{7f}", "javascript:alert(1)", "mailto:a\u{0}",
    ] {
        assert!(!safe_mailto(bad), "{bad:?}");
    }
    assert!(!safe_mailto(&format!("mailto:a@{}", "x".repeat(MAX_MAILTO))), "bounded");
}

// ---- errors are codes ------------------------------------------------------------------------

#[test]
fn every_failure_is_a_stable_code_and_never_google_text() {
    let cases: Vec<(&str, Vec<Result<(u16, Value), ApiError>>, Value)> = vec![
        ("forbidden", vec![Err(ApiError::Forbidden)], json!({"ok": false, "reason": "forbidden"})),
        ("network", vec![Err(ApiError::Network)], json!({"ok": false, "reason": "network"})),
        ("rate_limited", vec![Err(ApiError::RateLimited)], json!({"ok": false, "reason": "rate_limited"})),
        ("server", vec![Err(ApiError::Server)], json!({"ok": false, "reason": "server"})),
        ("invalid", vec![Err(ApiError::Invalid)], json!({"ok": false, "reason": "invalid"})),
        ("needs_sign_in", vec![Err(ApiError::NeedsSignIn)], json!({"ok": false, "reason": "needs_sign_in"})),
    ];
    for (label, script, want) in cases {
        let rig = Rig::new(script);
        rig.with_client("connected");
        let answer = rig.apply(&json!({"action": "inbox", "filter": "todos"}));
        assert_eq!(answer, want, "{label}");
        assert!(!answer.to_string().contains("https://"), "{label} carries no URL");
    }
    // Google's own error body never becomes the answer: only the code does.
    let body = json!({"error": {"code": 403, "message": "Google says access_token=".to_owned() + TOKEN}});
    let rig = Rig::new(vec![Ok((403, body))]);
    rig.with_client("connected");
    let answer = rig.apply(&json!({"action": "message", "id": "m1"}));
    assert_eq!(answer, json!({"ok": false, "reason": "forbidden"}));
    assert!(!answer.to_string().contains(TOKEN));
    // With no client at all the answer says so before touching the network.
    let rig = Rig::new(vec![]);
    assert_eq!(rig.apply(&json!({"action": "inbox", "filter": "todos"})), json!({"ok": false, "reason": "needs_sign_in"}));
    assert!(rig.api.urls().is_empty(), "nothing was fetched");
}

#[test]
fn the_message_summary_is_bounded_plain_text_with_no_html() {
    // A summary only carries what the card draws: no payload, no body, no labels array.
    let rig = Rig::new(vec![
        ok(id_list(&["m1"])),
        ok(meta("m1", "Ana <ana@example.com>", "Hola <b>mundo</b>", LAST_SEEN, &["UNREAD", "INBOX"])),
        ok(json!({"messagesUnread": 1})),
        ok(id_list(&["m1"])),
    ]);
    rig.with_client("connected");
    let answer = rig.apply(&json!({"action": "inbox", "filter": "nuevos"}));
    let message = &answer["messages"][0];
    let keys = message.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>();
    assert_eq!(keys, ["address", "dateMs", "from", "id", "important", "snippet", "subject", "unread"], "the closed summary shape");
    let summary = Summary {
        id: "m1".into(), thread_id: "th".into(), from_name: "Ana".into(), from_address: "ana@example.com".into(),
        subject: "Hola <b>mundo</b>".into(), snippet: "x".into(), internal_date_ms: 1, unread: true, important: false,
    };
    assert_eq!(summary_json(&summary)["subject"], "Hola <b>mundo</b>", "textContent-only: the page never parses it");
}

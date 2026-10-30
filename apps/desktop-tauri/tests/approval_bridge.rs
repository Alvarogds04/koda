//! M3 integration tests: the approval lane against an in-process fake
//! backend (`fakebridge`, a std-only loopback server). No real provider, no
//! real backend, no network egress — the fake binds `127.0.0.1:0`.
//!
//! Covered legacy contracts (ported from `test/main.test.cjs` where a
//! counterpart exists):
//! - login cookie minted once and sent on every API call,
//! - list → pending card with the exact projection shape,
//! - `/execute` with the EXACT `payload_hash` binding + confirmation header,
//! - `/reject` with no body and no content type,
//! - expired card / changed hash refuse BEFORE any HTTP call,
//! - backend hash mismatch (409) → sticky `conflict`, never `sent`,
//! - 401 → stop auth, polling frozen (no further requests),
//! - network failure → unhealthy, never retried (connection counts),
//! - known 403s → bounded ladder (explicit → remint ≤2 → stop),
//! - failed initial mint never retried; cookie never minted → one request,
//! - deadline aborts a stalled mint and stops auth,
//! - quit aborts an in-flight decision (no retry, quick inert return).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use abito_island::approval::{self, Approval, Decision, HostCtx, Shared, SharedHooks};
use abito_island::fakebridge::{FakeBackend, FakeConfig};
use abito_island::http::REQUEST_DEADLINE_MS;
use serde_json::{json, Value};

const LOGIN: &str = "tester@example.test";
const SESSION: &str = "fake-sb-session-32"; // must match the fake's mint

fn proposal(n: char, expires_at: &str, payload_hash: &str) -> Value {
    json!({
        "id": format!("proposal_{}", n.to_string().repeat(32)),
        "payload_hash": payload_hash,
        "operation": "Review document",
        "status": "pending",
        "expires_at": expires_at,
        "principal": "private",
        "payload": { "secret": true },
    })
}

fn pending(n: char) -> Value {
    proposal(n, "2999-12-31T23:59:59Z", &"c".repeat(64))
}

fn proposal_id(n: char) -> String {
    format!("proposal_{}", n.to_string().repeat(32))
}

struct Fixture {
    fake: Arc<FakeBackend>,
    appr: Shared,
    hooks: SharedHooks,
    modes: Arc<Mutex<Vec<String>>>,
    publishes: Arc<AtomicU32>,
    expanded: Arc<AtomicBool>,
    visible: Arc<AtomicBool>,
    quitting: Arc<AtomicBool>,
}

impl Fixture {
    fn new(config: FakeConfig) -> Self {
        let fake = FakeBackend::start(config);
        let approval = Approval::new(&fake.origin(), Some(LOGIN.to_string()))
            .expect("fake origin parses");
        let appr: Shared = Arc::new(Mutex::new(approval));
        let modes: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let publishes: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));
        let expanded = Arc::new(AtomicBool::new(false));
        let visible = Arc::new(AtomicBool::new(true));
        let quitting = Arc::new(AtomicBool::new(false));
        let hooks: SharedHooks = Arc::new(approval::Hooks {
            ctx: {
                let expanded = Arc::clone(&expanded);
                let visible = Arc::clone(&visible);
                let quitting = Arc::clone(&quitting);
                Box::new(move || {
                    let now_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    HostCtx {
                        now_ms,
                        expanded: expanded.load(Ordering::SeqCst),
                        visible: visible.load(Ordering::SeqCst),
                        quitting: quitting.load(Ordering::SeqCst),
                    }
                })
            },
            changed: {
                let publishes = Arc::clone(&publishes);
                Box::new(move || {
                    publishes.fetch_add(1, Ordering::SeqCst);
                })
            },
            log: {
                let modes = Arc::clone(&modes);
                Box::new(move |name: &str| modes.lock().expect("modes").push(name.to_string()))
            },
        });
        Fixture {
            fake,
            appr,
            hooks,
            modes,
            publishes,
            expanded,
            visible,
            quitting,
        }
    }

    fn startup(&self) {
        approval::bridge_startup(&self.appr, &self.hooks);
    }

    /// The expand path: phase change → epoch bump → promote (main.rs does
    /// exactly this on the `expand` verb).
    fn open(&self) {
        self.expanded.store(true, Ordering::SeqCst);
        approval::promote_selection(&self.appr);
    }

    fn status(&self) -> (String, String) {
        let appr = self.appr.lock().expect("approval lock");
        (appr.status.state.to_string(), appr.status.reason.to_string())
    }

    fn snapshot(&self) -> Value {
        let ctx = (self.hooks.ctx)();
        let (status, card, request) = approval::snapshot_fields(&self.appr, &ctx);
        json!({ "bridgeStatus": status, "card": card, "request": request })
    }

    fn modes(&self) -> Vec<String> {
        self.modes.lock().expect("modes").clone()
    }

    fn health_calls(&self) -> usize {
        self.fake
            .log()
            .iter()
            .filter(|entry| entry.path.starts_with("/api/health"))
            .count()
    }

    fn mint_calls(&self) -> usize {
        self.fake
            .log()
            .iter()
            .filter(|entry| entry.method == "GET" && entry.path == "/")
            .count()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.fake.stop();
    }
}

// --- login cookie ---------------------------------------------------------

#[test]
fn login_cookie_is_minted_once_and_sent_on_every_api_call() {
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        ..FakeConfig::default()
    });
    fixture.startup();
    let log = fixture.fake.log();
    assert!(log.len() >= 3, "mint + health + proposals: {log:?}");
    // the mint itself carries no cookie; every later call does
    assert_eq!((log[0].method.as_str(), log[0].path.as_str()), ("GET", "/"));
    assert!(!log[0].session_cookie, "mint cannot carry the cookie yet");
    for entry in &log[1..] {
        assert!(entry.session_cookie, "{} {} sent no cookie", entry.method, entry.path);
    }
    let (state, _) = fixture.status();
    assert_eq!(state, "healthy");
    // exactly one mint: the startup one
    assert_eq!(fixture.mint_calls(), 1);
    // auth diagnostics carry the mode name and nothing else
    assert_eq!(fixture.modes(), vec!["jar".to_string()]);
}

#[test]
fn cookie_never_minted_stops_after_exactly_one_request() {
    // legacy: `cookie absent stops after one mint`
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        mint_cookie: false,
        ..FakeConfig::default()
    });
    fixture.startup();
    assert_eq!(fixture.fake.accepted(), 1, "one request, then stopped");
    let (state, reason) = fixture.status();
    assert_eq!(state, "stopped");
    assert_eq!(reason, "Autenticación detenida; reiniciá la aplicación.");
    assert_eq!(fixture.modes(), vec!["jar".to_string(), "none".to_string()]);
}

// --- list → card ----------------------------------------------------------

#[test]
fn list_poll_projects_the_pending_card_with_the_exact_snapshot_shape() {
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        ..FakeConfig::default()
    });
    fixture.startup();
    // compact: the card exists but is inert with the compact reason
    let compact = fixture.snapshot();
    assert_eq!(compact["bridgeStatus"]["state"], "healthy");
    assert_eq!(compact["card"]["state"], "inert");
    assert_eq!(compact["card"]["reason"], "Abrí la tarjeta para decidir.");
    assert!(compact["request"].is_null(), "no standing request exists in M3");
    // expand: pending and actionable
    fixture.open();
    let open = fixture.snapshot();
    let card = open["card"].clone();
    let mut keys: Vec<String> = card.as_object().expect("card object").keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, vec!["expires_at", "operation", "reason", "state"]);
    assert_eq!(card["state"], "pending");
    assert!(card["reason"].is_null());
    assert_eq!(card["operation"], "Review document");
    assert_eq!(card["expires_at"], "2999-12-31T23:59:59Z");
    // private identity never reaches the renderer
    let text = open.to_string();
    assert!(!text.contains("proposal_"), "id leaks into the snapshot");
    assert!(!text.contains(&"c".repeat(64)), "hash leaks into the snapshot");
    assert!(!text.contains("private"), "payload leaks into the snapshot");
}

// --- decisions ------------------------------------------------------------

#[test]
fn allow_posts_execute_with_the_exact_payload_hash_binding() {
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        ..FakeConfig::default()
    });
    fixture.startup();
    fixture.open();
    approval::decide(&fixture.appr, Decision::Allow, &fixture.hooks);
    let posts = fixture.fake.posts();
    assert_eq!(posts.len(), 1, "exactly one write: {posts:?}");
    assert_eq!(
        posts[0].path,
        format!("/api/proposals/{}/execute", proposal_id('a'))
    );
    assert_eq!(posts[0].payload_hash.as_deref(), Some("c".repeat(64).as_str()));
    assert!(posts[0].x_sb_request, "POST must carry X-SB-Request: 1");
    assert_eq!(
        posts[0].session_cookie, true,
        "the decision is authenticated with the session cookie"
    );
    let snapshot = fixture.snapshot();
    assert_eq!(snapshot["card"]["state"], "inert");
    assert_eq!(snapshot["card"]["reason"], "Decisión enviada.");
    // a second click on the same (now decided) card never writes again
    approval::decide(&fixture.appr, Decision::Allow, &fixture.hooks);
    approval::decide(&fixture.appr, Decision::Deny, &fixture.hooks);
    assert_eq!(fixture.fake.posts().len(), 1);
}

#[test]
fn deny_posts_reject_with_no_body_and_no_content_type() {
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        ..FakeConfig::default()
    });
    fixture.startup();
    fixture.open();
    approval::decide(&fixture.appr, Decision::Deny, &fixture.hooks);
    let posts = fixture.fake.posts();
    assert_eq!(posts.len(), 1);
    assert_eq!(
        posts[0].path,
        format!("/api/proposals/{}/reject", proposal_id('a'))
    );
    assert_eq!(posts[0].payload_hash, None, "reject carries no body");
    assert!(posts[0].x_sb_request, "POST must carry X-SB-Request: 1");
    let snapshot = fixture.snapshot();
    assert_eq!(snapshot["card"]["reason"], "Decisión enviada.");
}

#[test]
fn expired_card_refuses_before_any_http_call_is_made() {
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![proposal('a', "2000-01-01T00:00:00Z", &"c".repeat(64))],
        ..FakeConfig::default()
    });
    fixture.startup();
    fixture.open();
    let before = fixture.fake.accepted();
    approval::decide(&fixture.appr, Decision::Allow, &fixture.hooks);
    assert_eq!(fixture.fake.posts().len(), 0, "an expired card never posts");
    assert_eq!(fixture.fake.accepted(), before, "not one connection was made");
    let snapshot = fixture.snapshot();
    // #338 / D1(B): an already-expired candidate NEVER reaches the lane — the
    // host ignores it exactly like an empty pending list (`card.rs`
    // `receive_candidate` filters `expires <= now`), so the card RETIRES to
    // `null` instead of sitting inert forever. The row keeps polling as
    // `pending` (only approve/execute write `Status.EXPIRED`,
    // `sb_bridge/bridge.py:77-79,100-102`) and no verb could clear an inert
    // card (`decide` returns before any HTTP), which is the bug D1 fixed.
    // The refusal assertions above are unchanged and now stronger: there is
    // not even a card left to click. The sticky «Propuesta vencida.» DISPLAY
    // for a card that expires WHILE pinned stays pinned by `src/card.rs`
    // (`reason_order_sticky_then_quit_then_expiry_then_health_then_busy_then_phase`,
    // `expiry_of_a_pinned_card_is_rechecked_on_every_poll_and_sticky`,
    // `empty_pending_list_keeps_the_pinned_card_inert_while_expanded`).
    assert!(snapshot["card"].is_null(), "the expired card retires: {snapshot:?}");
    // it stays retired while the expired row keeps polling as pending
    approval::poll_once(&fixture.appr, &fixture.hooks);
    assert!(fixture.snapshot()["card"].is_null(), "still retired after the next poll");
    assert_eq!(fixture.fake.posts().len(), 0, "still no write after the next poll");
}

#[test]
fn changed_hash_is_inert_and_posts_nothing() {
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        ..FakeConfig::default()
    });
    fixture.startup();
    fixture.open();
    // same proposal id, new payload hash → a DIFFERENT decision (sameCard)
    fixture.fake.set_proposals(vec![proposal(
        'a',
        "2999-12-31T23:59:59Z",
        &"d".repeat(64),
    )]);
    approval::poll_once(&fixture.appr, &fixture.hooks);
    let snapshot = fixture.snapshot();
    assert_eq!(snapshot["card"]["state"], "inert");
    assert_eq!(snapshot["card"]["reason"], "Propuesta no disponible para decidir.");
    approval::decide(&fixture.appr, Decision::Allow, &fixture.hooks);
    assert_eq!(fixture.fake.posts().len(), 0, "stale hash never reaches /execute");
}

#[test]
fn backend_hash_mismatch_is_a_conflict_never_sent() {
    // The BACKEND binds too: a lane whose stored hash differs from the
    // proposal's gets 409 (api.py approve → ProposalError → 409).
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        stored_hash: Some("d".repeat(64)),
        ..FakeConfig::default()
    });
    fixture.startup();
    fixture.open();
    approval::decide(&fixture.appr, Decision::Allow, &fixture.hooks);
    let posts = fixture.fake.posts();
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0].payload_hash.as_deref(), Some("c".repeat(64).as_str()));
    let snapshot = fixture.snapshot();
    assert_eq!(snapshot["card"]["state"], "inert");
    assert_eq!(snapshot["card"]["reason"], "No se pudo confirmar la decisión.");
}

#[test]
fn choose_is_wired_but_denied_while_no_request_stands() {
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        ..FakeConfig::default()
    });
    fixture.startup();
    // legacy: no producer of requests exists → chooseRequest throws Denied
    assert!(approval::choose(&fixture.appr, 0).is_err());
    assert!(approval::choose(&fixture.appr, -1).is_err());
    let snapshot = fixture.snapshot();
    assert!(snapshot["request"].is_null());
    // …and a denied choice never posts
    assert_eq!(fixture.fake.posts().len(), 0);
}

// --- auth failures --------------------------------------------------------

#[test]
fn http_401_stops_auth_and_polling_forever() {
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        force_401: true,
        ..FakeConfig::default()
    });
    fixture.startup();
    let (state, reason) = fixture.status();
    assert_eq!(state, "stopped");
    assert_eq!(reason, "Autenticación detenida; reiniciá la aplicación.");
    assert_eq!(fixture.modes(), vec!["jar".to_string(), "none".to_string()]);
    let accepted = fixture.fake.accepted();
    // polling is cleared: later polls make no connection at all
    approval::poll_once(&fixture.appr, &fixture.hooks);
    approval::poll_once(&fixture.appr, &fixture.hooks);
    assert_eq!(fixture.fake.accepted(), accepted, "stopped means stopped");
}

#[test]
fn failed_initial_mint_is_never_retried() {
    // legacy: `failed initial mint (401, 403, 302, 500) is never retried`
    for status in [401u16, 403, 302, 500] {
        let fixture = Fixture::new(FakeConfig {
            login: LOGIN.into(),
            proposals: vec![pending('a')],
            mint_status: Some(status),
            ..FakeConfig::default()
        });
        fixture.startup();
        assert_eq!(fixture.fake.accepted(), 1, "mint {status}: one request only");
        let (state, _) = fixture.status();
        assert_eq!(state, "stopped", "mint {status}");
        assert_eq!(fixture.modes(), vec!["jar".to_string(), "none".to_string()]);
        approval::poll_once(&fixture.appr, &fixture.hooks);
        assert_eq!(fixture.fake.accepted(), 1, "mint {status}: no later requests");
    }
}

// --- retry policy ---------------------------------------------------------

#[test]
fn network_failure_is_unhealthy_and_never_retried() {
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        drop_api_connections: true,
        ..FakeConfig::default()
    });
    fixture.startup();
    // mint succeeded (GET / is not dropped); the health call was dropped
    assert_eq!(fixture.mint_calls(), 1);
    assert_eq!(
        fixture.fake.accepted(),
        2,
        "exactly one health attempt — a network failure is not retried"
    );
    let (state, reason) = fixture.status();
    assert_eq!(state, "unhealthy");
    assert_eq!(reason, "Puente no disponible.");
    assert_ne!(fixture.modes(), vec!["none".to_string()], "a transport failure is not a stop");
    // one later poll = one new attempt, never a burst
    let accepted = fixture.fake.accepted();
    approval::poll_once(&fixture.appr, &fixture.hooks);
    assert_eq!(fixture.fake.accepted(), accepted + 1);
    assert_eq!(fixture.status().0, "unhealthy");
}

#[test]
fn known_rejected_requests_run_the_bounded_403_ladder() {
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        scripted_403: 2,
        ..FakeConfig::default()
    });
    fixture.startup();
    // ladder: health 403 → explicit retry 403 → remint → health 200
    assert_eq!(fixture.health_calls(), 3, "two rejections, then success");
    assert_eq!(fixture.mint_calls(), 2, "startup mint + exactly one remint");
    assert_eq!(fixture.status().0, "healthy");
    assert_eq!(
        fixture.modes(),
        vec!["jar".to_string(), "explicit".to_string()],
        "no `none`: auth never stopped"
    );
}

#[test]
fn three_known_rejections_stop_after_exactly_two_mints() {
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        scripted_403: 100,
        ..FakeConfig::default()
    });
    fixture.startup();
    assert_eq!(fixture.health_calls(), 3, "third known rejection ends the ladder");
    assert_eq!(fixture.mint_calls(), 2, "never a third mint");
    assert_eq!(fixture.status().0, "stopped");
    assert_eq!(
        fixture.modes(),
        vec![
            "jar".to_string(),
            "explicit".to_string(),
            "none".to_string()
        ]
    );
    let accepted = fixture.fake.accepted();
    approval::poll_once(&fixture.appr, &fixture.hooks);
    assert_eq!(fixture.fake.accepted(), accepted, "stopped polling makes no requests");
}

// --- deadline and quit ----------------------------------------------------

#[test]
fn stalled_mint_hits_the_deadline_and_stops_auth() {
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        stall: Some(Duration::from_secs(30)),
        ..FakeConfig::default()
    });
    {
        let mut appr = fixture.appr.lock().expect("approval lock");
        appr.deadline_ms = 200; // same code path as legacy 5000, shortened
    }
    let started = Instant::now();
    fixture.startup();
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_secs(2), "deadline aborted: {elapsed:?}");
    assert_eq!(fixture.status().0, "stopped", "a timeout stops mint");
    assert_eq!(fixture.modes(), vec!["jar".to_string(), "none".to_string()]);
    assert_eq!(REQUEST_DEADLINE_MS, 5_000, "production deadline unchanged");
}

#[test]
fn quit_aborts_an_inflight_decision_without_retry() {
    // The fake stalls every connection, so the lane is seeded white-box
    // (real state fields, REAL decide path over a real stalled socket).
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        stall: Some(Duration::from_secs(30)),
        ..FakeConfig::default()
    });
    {
        let mut appr = fixture.appr.lock().expect("approval lock");
        appr.ladder.begin();
        appr.cookie = Some(approval::StoredCookie {
            value: SESSION.to_string(),
            expires_at: None,
        });
        appr.status = abito_island::desktop::BridgeStatus {
            state: "healthy",
            reason: "Puente disponible.",
        };
        let candidate = abito_island::card::parse_proposals(&json!([pending('a')]))
            .expect("parseable")
            .expect("one candidate");
        appr.queued = Some(candidate.clone());
        appr.selected = Some(candidate);
        appr.deadline_ms = 10_000; // long deadline: only quit can end this
    }
    fixture.open();
    let started = Instant::now();
    let decider = {
        let appr = Arc::clone(&fixture.appr);
        let hooks = Arc::clone(&fixture.hooks);
        std::thread::spawn(move || approval::decide(&appr, Decision::Allow, &hooks))
    };
    std::thread::sleep(Duration::from_millis(250));
    approval::abort_lane(&fixture.appr); // the quit path
    fixture.quitting.store(true, Ordering::SeqCst);
    decider.join().expect("decide returns");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(5),
        "abort ended the in-flight read at once: {elapsed:?}"
    );
    // one write attempt happened, but nothing retried and nothing claims sent
    assert_eq!(fixture.fake.posts().len(), 1, "the attempt is not repeated");
    let snapshot = fixture.snapshot();
    assert_eq!(snapshot["card"]["state"], "inert");
    assert_eq!(
        snapshot["card"]["reason"],
        "Autenticación detenida; reiniciá la aplicación.",
        "quitting makes everything inert (legacy cardReason first rule)"
    );
    // the lane is quiescent: publish ran during the decision, not after quit
    assert!(fixture.publishes.load(Ordering::SeqCst) >= 1);
}

// --- no configuration, no traffic ----------------------------------------

#[test]
fn no_login_configuration_means_disabled_and_zero_requests() {
    let fixture = Fixture::new(FakeConfig {
        login: LOGIN.into(),
        proposals: vec![pending('a')],
        ..FakeConfig::default()
    });
    {
        let mut appr = fixture.appr.lock().expect("approval lock");
        appr.login = None;
        appr.status = abito_island::desktop::BridgeStatus {
            state: "disabled",
            reason: "Puente deshabilitado: configuración no válida.",
        };
    }
    fixture.startup();
    approval::poll_once(&fixture.appr, &fixture.hooks);
    approval::decide(&fixture.appr, Decision::Allow, &fixture.hooks);
    assert_eq!(fixture.fake.accepted(), 0, "disabled means no traffic at all");
    assert_eq!(fixture.snapshot()["bridgeStatus"]["state"], "disabled");
}

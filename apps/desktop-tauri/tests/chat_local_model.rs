//! U1 integration: the chat lane against an IN-PROCESS fake local router
//! (`fakemodel`, `127.0.0.1:0`). No real model, no provider, no network
//! egress. Proves: local answer streamed in order; router down → honest
//! `local_model_unavailable` with ZERO inference requests anywhere; exactly
//! one request per turn (no retry, no redirect follow, no fallback); asleep
//! model never loaded; cancel; idle deadline; malformed/broken streams.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use abito_island::chat::{FinishReason, ProfileRef, TurnState};
use abito_island::chatlane::{self, Lane, SharedLane, Target};
use abito_island::fakemodel::{closed_port, FakeModel, FakeModelConfig, Reply};
use abito_island::localmodel::{Deadlines, LocalEndpoint, DEFAULT_DEADLINES};

fn profile() -> ProfileRef {
    ProfileRef {
        profile_id: "local-abito-gpt".into(),
        revision: 1,
        lane_id: "conversation".into(),
    }
}

fn target(origin: &str) -> Target {
    Target {
        endpoint: LocalEndpoint::parse(origin).unwrap(),
        alias: "Abito-gpt".into(),
        profile: profile(),
        max_output: 256,
    }
}

fn submit(lane: &SharedLane, text: &str, id: &str) -> String {
    lane.lock()
        .unwrap()
        .convo
        .submit(text, id, &profile())
        .unwrap()
        .turn_id
}

fn run(lane: &SharedLane, turn: &str, t: &Target, d: Deadlines) -> u32 {
    run_with_system(lane, turn, t, chatlane::SYSTEM_PROMPT, d)
}

fn run_with_system(lane: &SharedLane, turn: &str, t: &Target, system: &str, d: Deadlines) -> u32 {
    let publishes = Arc::new(AtomicU32::new(0));
    let p = Arc::clone(&publishes);
    chatlane::run_turn(lane, turn, t, system, d, &move || {
        p.fetch_add(1, Ordering::SeqCst);
    });
    publishes.load(Ordering::SeqCst)
}

fn state(lane: &SharedLane, turn: &str) -> (TurnState, String, Option<String>, Option<FinishReason>) {
    let l = lane.lock().unwrap();
    let t = l.convo.turn(turn).unwrap();
    (
        t.state,
        t.reply.clone(),
        t.error.as_ref().map(|e| e.code.clone()),
        t.finish,
    )
}

#[test]
fn local_model_answer_is_streamed_and_completed() {
    let fake = FakeModel::start(FakeModelConfig::default());
    let lane = Lane::new("c-1");
    let turn = submit(&lane, "¿quién sos?", "req-0000000001");
    let publishes = run(&lane, &turn, &target(&fake.origin()), DEFAULT_DEADLINES);
    let (s, reply, err, finish) = state(&lane, &turn);
    assert_eq!(s, TurnState::Completed);
    assert_eq!(reply, "Hola, soy Abito.");
    assert_eq!(err, None);
    assert_eq!(finish, Some(FinishReason::Stop));
    assert!(publishes >= 3, "thinking + deltas + complete were published");
    assert_eq!(fake.completions(), 1);
    // the one inference request names only the alias, streams, no tools/key
    let seen = fake.seen();
    let post = seen.iter().find(|s| s.path == "/v1/chat/completions").unwrap();
    let body: serde_json::Value = serde_json::from_str(&post.body).unwrap();
    assert_eq!(body["model"], "Abito-gpt");
    assert_eq!(body["stream"], true);
    assert_eq!(body["max_tokens"], 256);
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"].as_array().unwrap().last().unwrap()["content"], "¿quién sos?");
    assert!(body.get("tools").is_none());
    // preflight was metadata only, and preceded the single POST
    let paths: Vec<&str> = seen.iter().map(|s| s.path.as_str()).collect();
    assert_eq!(paths, ["/health", "/props", "/slots", "/v1/models", "/v1/chat/completions"]);
}

/// #327: a turn sends the system message its caller FROZE at submit — the base policy plus the
/// specialist chosen then — and never re-reads a role later. With no specialist the base message is
/// byte for byte the one Abito always sent.
#[test]
fn the_turn_sends_the_system_message_the_caller_froze_at_submit() {
    const FROZEN: &str = "Sos Koda, el compañero de escritorio.\n\nAhora hablás como «Investigador»: buscá fuentes y citá.";
    let fake = FakeModel::start(FakeModelConfig::default());
    let lane = Lane::new("c-327");
    let turn = submit(&lane, "¿quién sos?", "req-0000000001");
    run_with_system(&lane, &turn, &target(&fake.origin()), FROZEN, DEFAULT_DEADLINES);
    let (s, _, err, _) = state(&lane, &turn);
    assert_eq!(s, TurnState::Completed);
    assert_eq!(err, None);
    let seen = fake.seen();
    let post = seen.iter().find(|s| s.path == "/v1/chat/completions").unwrap();
    let body: serde_json::Value = serde_json::from_str(&post.body).unwrap();
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][0]["content"], FROZEN, "the role frozen at submit is what the local model sees");
    assert_ne!(body["messages"][0]["content"], chatlane::SYSTEM_PROMPT);

    // the NEXT turn, with no specialist, is the base message again: the principal is unchanged
    let turn2 = submit(&lane, "¿y ahora?", "req-0000000002");
    run_with_system(&lane, &turn2, &target(&fake.origin()), chatlane::SYSTEM_PROMPT, DEFAULT_DEADLINES);
    let seen = fake.seen();
    let post = seen.iter().filter(|s| s.path == "/v1/chat/completions").next_back().unwrap();
    let body: serde_json::Value = serde_json::from_str(&post.body).unwrap();
    assert_eq!(body["messages"][0]["content"], chatlane::SYSTEM_PROMPT);
}

#[test]
fn router_down_says_unavailable_and_sends_nothing_anywhere() {
    // a sentinel "other" router proves no fallback reached it
    let other = FakeModel::start(FakeModelConfig::default());
    let lane = Lane::new("c-2");
    let turn = submit(&lane, "hola", "req-0000000001");
    let started = Instant::now();
    run(&lane, &turn, &target(&format!("http://127.0.0.1:{}", closed_port())), DEFAULT_DEADLINES);
    let (s, reply, err, _) = state(&lane, &turn);
    assert_eq!(s, TurnState::Error);
    assert_eq!(err.as_deref(), Some("local_model_unavailable"));
    assert_eq!(reply, "");
    assert!(started.elapsed() < Duration::from_secs(3), "fails fast");
    assert!(other.seen().is_empty(), "no fallback endpoint was contacted");
    let l = lane.lock().unwrap();
    let msg = &l.convo.turn(&turn).unwrap().error.as_ref().unwrap().safe_message;
    assert!(msg.contains("no está disponible"));
    assert!(msg.contains("No se usó ningún otro modelo"));
}

#[test]
fn router_dying_between_preflight_and_send_is_unavailable_without_retry() {
    let fake = FakeModel::start(FakeModelConfig {
        reply: Reply::Status(503),
        ..Default::default()
    });
    let lane = Lane::new("c-3");
    let turn = submit(&lane, "hola", "req-0000000001");
    run(&lane, &turn, &target(&fake.origin()), DEFAULT_DEADLINES);
    let (s, _, err, _) = state(&lane, &turn);
    assert_eq!(s, TurnState::Error);
    assert_eq!(err.as_deref(), Some("local_model_unavailable"));
    assert_eq!(fake.completions(), 1, "exactly one attempt, never retried");
}

#[test]
fn a_sleeping_model_is_not_loaded_by_sending() {
    let fake = FakeModel::start(FakeModelConfig {
        sleeping: true,
        ..Default::default()
    });
    let lane = Lane::new("c-4");
    let turn = submit(&lane, "hola", "req-0000000001");
    run(&lane, &turn, &target(&fake.origin()), DEFAULT_DEADLINES);
    let (s, _, err, _) = state(&lane, &turn);
    assert_eq!(s, TurnState::Error);
    assert_eq!(err.as_deref(), Some("resource_authorization_required"));
    assert_eq!(fake.completions(), 0, "no inference request = no load");
}

#[test]
fn a_different_loaded_alias_is_never_substituted() {
    let fake = FakeModel::start(FakeModelConfig {
        alias: "Otro-modelo".into(),
        ..Default::default()
    });
    let lane = Lane::new("c-5");
    let turn = submit(&lane, "hola", "req-0000000001");
    run(&lane, &turn, &target(&fake.origin()), DEFAULT_DEADLINES);
    assert_eq!(state(&lane, &turn).2.as_deref(), Some("local_model_unavailable"));
    assert_eq!(fake.completions(), 0);
}

#[test]
fn a_busy_slot_queues_visibly_and_still_sends_once() {
    let fake = FakeModel::start(FakeModelConfig {
        busy: true,
        reply: Reply::Stream {
            reasoning: false,
            pieces: vec!["ok".into()],
            finish: "stop",
            gap_ms: 200,
        },
        ..Default::default()
    });
    let lane = Lane::new("c-6");
    let turn = submit(&lane, "hola", "req-0000000001");
    let l2 = Arc::clone(&lane);
    let t = target(&fake.origin());
    let tid = turn.clone();
    let worker = std::thread::spawn(move || run(&l2, &tid, &t, DEFAULT_DEADLINES));
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut saw_note = false;
    while Instant::now() < deadline && !saw_note {
        saw_note = lane.lock().unwrap().queue_note.is_some();
        std::thread::sleep(Duration::from_millis(10));
    }
    worker.join().unwrap();
    assert!(saw_note, "the queue position was shown while waiting");
    assert_eq!(state(&lane, &turn).0, TurnState::Completed);
    assert!(lane.lock().unwrap().queue_note.is_none());
    assert_eq!(fake.completions(), 1);
}

#[test]
fn a_redirect_is_never_followed() {
    let sentinel = FakeModel::start(FakeModelConfig::default());
    let fake = FakeModel::start(FakeModelConfig {
        reply: Reply::Redirect(format!("{}/v1/chat/completions", sentinel.origin())),
        ..Default::default()
    });
    let lane = Lane::new("c-7");
    let turn = submit(&lane, "hola", "req-0000000001");
    run(&lane, &turn, &target(&fake.origin()), DEFAULT_DEADLINES);
    assert_eq!(state(&lane, &turn).2.as_deref(), Some("inference_error"));
    assert!(sentinel.seen().is_empty());
}

#[test]
fn malformed_and_broken_streams_end_with_safe_errors_and_no_retry() {
    for (reply, code) in [
        (Reply::Malformed, "inference_error"),
        (Reply::BreakAfter(vec!["medio".into()]), "stream_gap"),
    ] {
        let fake = FakeModel::start(FakeModelConfig {
            reply,
            ..Default::default()
        });
        let lane = Lane::new("c-8");
        let turn = submit(&lane, "hola", "req-0000000001");
        run(&lane, &turn, &target(&fake.origin()), DEFAULT_DEADLINES);
        let (s, _, err, _) = state(&lane, &turn);
        assert_eq!(s, TurnState::Error);
        assert_eq!(err.as_deref(), Some(code));
        assert_eq!(fake.completions(), 1);
    }
}

#[test]
fn idle_deadline_ends_a_stalled_stream() {
    let fake = FakeModel::start(FakeModelConfig {
        reply: Reply::StallAfterHead,
        ..Default::default()
    });
    let lane = Lane::new("c-9");
    let turn = submit(&lane, "hola", "req-0000000001");
    let started = Instant::now();
    run(
        &lane,
        &turn,
        &target(&fake.origin()),
        Deadlines { connect_ms: 1_000, idle_ms: 300, total_ms: 5_000 },
    );
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(state(&lane, &turn).2.as_deref(), Some("inference_error"));
    assert_eq!(fake.completions(), 1);
}

#[test]
fn cancel_stops_a_running_turn_promptly_and_discards_later_text() {
    let fake = FakeModel::start(FakeModelConfig {
        reply: Reply::Stream {
            reasoning: true,
            pieces: (0..50).map(|n| format!("p{n} ")).collect(),
            finish: "stop",
            gap_ms: 50,
        },
        ..Default::default()
    });
    let lane = Lane::new("c-10");
    let turn = submit(&lane, "hola", "req-0000000001");
    let l2 = Arc::clone(&lane);
    let t = target(&fake.origin());
    let tid = turn.clone();
    let worker = std::thread::spawn(move || run(&l2, &tid, &t, DEFAULT_DEADLINES));
    // wait for streaming to start, then cancel
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && state(&lane, &turn).0 != TurnState::Streaming {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(chatlane::cancel(&lane, &turn));
    let reply_at_cancel = state(&lane, &turn).1;
    let started = Instant::now();
    worker.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(1), "socket was shut down");
    let (s, reply, _, finish) = state(&lane, &turn);
    assert_eq!(s, TurnState::Cancelled);
    assert_eq!(finish, Some(FinishReason::Cancelled));
    assert_eq!(reply, reply_at_cancel, "nothing appended after cancel");
    assert!(!reply.contains("p49"));
    assert_eq!(fake.completions(), 1);
}

#[test]
fn length_finish_is_an_explicit_limit_not_a_follow_up_request() {
    let fake = FakeModel::start(FakeModelConfig {
        reply: Reply::Stream {
            reasoning: false,
            pieces: vec!["cortado".into()],
            finish: "length",
            gap_ms: 0,
        },
        ..Default::default()
    });
    let lane = Lane::new("c-11");
    let turn = submit(&lane, "hola", "req-0000000001");
    run(&lane, &turn, &target(&fake.origin()), DEFAULT_DEADLINES);
    let (s, reply, _, finish) = state(&lane, &turn);
    assert_eq!((s, reply.as_str(), finish), (TurnState::Completed, "cortado", Some(FinishReason::Limit)));
    assert_eq!(fake.completions(), 1);
}

#[test]
fn second_turn_carries_the_first_as_history() {
    let fake = FakeModel::start(FakeModelConfig::default());
    let lane = Lane::new("c-12");
    let t = target(&fake.origin());
    let first = submit(&lane, "uno", "req-0000000001");
    run(&lane, &first, &t, DEFAULT_DEADLINES);
    let second = submit(&lane, "dos", "req-0000000002");
    run(&lane, &second, &t, DEFAULT_DEADLINES);
    let posts: Vec<_> = fake.seen().into_iter().filter(|s| s.path == "/v1/chat/completions").collect();
    assert_eq!(posts.len(), 2);
    let body: serde_json::Value = serde_json::from_str(&posts[1].body).unwrap();
    let roles: Vec<&str> = body["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["system", "user", "assistant", "user"]);
    assert_eq!(body["messages"][2]["content"], "Hola, soy Abito.");
}

#[test]
fn check_reads_metadata_only_and_never_infers() {
    let fake = FakeModel::start(FakeModelConfig::default());
    let lane = Lane::new("c-13");
    let a = chatlane::check(&lane, &target(&fake.origin()));
    assert_eq!(a.state, "ready");
    assert_eq!(fake.completions(), 0);
    let down = chatlane::check(&lane, &target(&format!("http://127.0.0.1:{}", closed_port())));
    assert_eq!(down.state, "unavailable");
    assert!(!down.can_send());
    assert_eq!(lane.lock().unwrap().view()["availability"]["state"], "unavailable");
}

/// Opt-in smoke against the REAL local router (127.0.0.1:11002, alias
/// Abito-gpt): one preflight + one short turn. Never a provider; skipped
/// unless `ABITO_REAL_LOCAL_MODEL=1`. If the router is asleep or busy the
/// lane refuses or queues exactly as in production — nothing is loaded.
#[test]
fn real_local_router_smoke_when_opted_in() {
    if std::env::var("ABITO_REAL_LOCAL_MODEL").as_deref() != Ok("1") {
        eprintln!("SKIPPED: set ABITO_REAL_LOCAL_MODEL=1 to talk to 127.0.0.1:11002");
        return;
    }
    let mut t = chatlane::default_target();
    t.max_output = 48;
    let lane = Lane::new("c-real");
    let availability = chatlane::check(&lane, &t);
    eprintln!("availability: {availability:?}");
    if !availability.can_send() {
        return; // honest refusal is the expected behaviour, not a failure
    }
    let turn = submit(&lane, "Decí solo: hola", "req-real-000001");
    let started = Instant::now();
    run(&lane, &turn, &t, DEFAULT_DEADLINES);
    let (s, reply, err, finish) = state(&lane, &turn);
    eprintln!("state={s:?} finish={finish:?} err={err:?} ms={} reply={reply:?}", started.elapsed().as_millis());
    assert!(matches!(s, TurnState::Completed), "{s:?} {err:?}");
    assert!(!reply.trim().is_empty());
}

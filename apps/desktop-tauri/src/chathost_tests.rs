//! K2-05 T4 U3 — the island chat host's route to the daemon engine.
//!
//! Included from `lib.rs` (so `cargo test --lib chathost` selects these): the
//! pure dispatcher and the `chat:state` projection live in `chatclient.rs`
//! (lib, so `tests/chat_daemon.rs` can drive the SAME code end to end); the
//! Tauri glue in `chathost.rs` (binary) is covered here by source guards.
//!
//! The fake link below parses through the REAL `ChatState::command` (the
//! window gate and the closed chat parser), so "this verb sends that
//! `ChatCommand`" is asserted against the real wire contract.

use crate::chat::{ChatError, Command};
use crate::chatclient::*;
use serde_json::{json, Value};
use std::sync::Mutex;

struct FakeLink {
    state: Mutex<ChatState>,
    sent: Mutex<Vec<ChatCommand>>,
    /// Applied to the state after each sent command (the daemon's answer).
    answer: Box<dyn Fn(&ChatCommand) -> Vec<Value> + Send + Sync>,
    /// Each view read takes this long (widens a check-then-send race window).
    slow_view_ms: u64,
    /// Lift the island's own per-minute budget (long-chat tests send hundreds of lines).
    unlimited: bool,
}

impl FakeLink {
    fn new() -> FakeLink {
        FakeLink::answering(|_| vec![])
    }
    fn answering(answer: impl Fn(&ChatCommand) -> Vec<Value> + Send + Sync + 'static) -> FakeLink {
        let mut st = ChatState::connected();
        st.apply(&json!({"type":"agent_state","busy":false,"status":"ready","paused":false}));
        FakeLink { state: Mutex::new(st), sent: Mutex::new(vec![]), answer: Box::new(answer), slow_view_ms: 0, unlimited: false }
    }
    fn offline() -> FakeLink {
        FakeLink { state: Mutex::new(ChatState::disconnected(crate::agentclient::Reason::NoDaemon)), sent: Mutex::new(vec![]), answer: Box::new(|_| vec![]), slow_view_ms: 0, unlimited: false }
    }
    fn frame(&self, f: Value) {
        self.state.lock().unwrap().apply(&f);
    }
    fn sent(&self) -> Vec<ChatCommand> {
        self.sent.lock().unwrap().clone()
    }
}

impl ChatLink for FakeLink {
    fn view(&self) -> Value {
        let v = serde_json::to_value(&*self.state.lock().unwrap()).unwrap();
        if self.slow_view_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(self.slow_view_ms));
        }
        v
    }
    fn command(&self, caller: &str, payload: &Value) -> Result<Value, CommandError> {
        if self.unlimited {
            self.state.lock().unwrap().rate_count.set(0);
        }
        let cmd = self.state.lock().unwrap().command(caller, payload)?;
        let frames = (self.answer)(&cmd);
        self.sent.lock().unwrap().push(cmd);
        for f in frames {
            self.frame(f);
        }
        Ok(self.view())
    }
}

const T0: u64 = 1_000_000;

fn submit(text: &str, id: &str) -> Command {
    Command::Submit { text: text.into(), client_request_id: id.into(), attachments: vec![] }
}

fn err_code(r: Result<Routed, ChatError>) -> String {
    match r {
        Err(e) => e.code,
        Ok(r) => panic!("expected a refusal, got {r:?}"),
    }
}

fn last_turn(v: &Value) -> Value {
    v["turns"].as_array().and_then(|t| t.last()).cloned().unwrap_or(Value::Null)
}

// ---- each verb → the right ChatCommand or refusal ------------------------------------------

#[test]
fn chathost_submit_sends_one_chat_send_with_the_validated_text() {
    let link = FakeLink::new();
    let host = ChatHost::new();
    let r = host.route(&link, "main", &submit("hola\r\nKoda", "req-00000001"), T0).unwrap();
    assert_eq!(
        link.sent(),
        vec![ChatCommand::Send { text: "hola\nKoda".into(), client_request_id: "req-00000001".into() }],
        "the page text is validated and normalized by chat.rs before it leaves"
    );
    let Routed::Answer(a) = r else { panic!("submit answers the page") };
    assert_eq!(a["duplicate"], json!(false));
    let v = host.project(&link.view(), T0);
    let t = last_turn(&v);
    assert_eq!(t["user_text"], json!("hola\nKoda"));
    assert_eq!(t["state"], json!("thinking"));
    assert_eq!(a["turn_id"], t["turn_id"], "the answer names the turn the page will see");
    assert_eq!(v["active_turn"], t["turn_id"]);
}

#[test]
fn chathost_view_and_check_ask_the_engine_status_and_answer_with_the_view() {
    for cmd in [Command::View, Command::Check] {
        let link = FakeLink::new();
        let host = ChatHost::new();
        assert_eq!(host.route(&link, "main", &cmd, T0).unwrap(), Routed::View, "{cmd:?}");
        assert_eq!(link.sent(), vec![ChatCommand::Status], "{cmd:?}");
    }
    // a burst of page views sends one status, not one per view (the chat's budget)
    let link = FakeLink::new();
    let host = ChatHost::new();
    for i in 0..5 {
        host.route(&link, "main", &Command::View, T0 + i * 100).unwrap();
    }
    assert_eq!(link.sent(), vec![ChatCommand::Status]);
    host.route(&link, "main", &Command::Check, T0 + 2_500).unwrap();
    assert_eq!(link.sent(), vec![ChatCommand::Status, ChatCommand::Status], "after the gap, again");
    // offline: the view never fails because the status line could not be sent
    let host = ChatHost::new();
    assert_eq!(host.route(&FakeLink::offline(), "main", &Command::View, T0).unwrap(), Routed::View);
}

#[test]
fn chathost_open_back_and_height_stay_local_and_send_nothing() {
    for cmd in [Command::Open, Command::Back, Command::Height { height: 260 }] {
        let link = FakeLink::new();
        assert_eq!(ChatHost::new().route(&link, "main", &cmd, T0).unwrap(), Routed::Local, "{cmd:?}");
        assert!(link.sent().is_empty(), "{cmd:?}");
    }
}

#[test]
fn chathost_one_continuous_chat_refuses_new_new_with_list_and_restore() {
    let cmds = [
        Command::New,
        Command::NewWith { specialist_id: None },
        Command::NewWith { specialist_id: Some("writer".into()) },
        Command::List,
        Command::Restore { conversation_id: "c-other".into() },
    ];
    for cmd in cmds {
        let link = FakeLink::new();
        let e = ChatHost::new().route(&link, "main", &cmd, T0).unwrap_err();
        assert_eq!(e.code, "conversations_off", "{cmd:?}");
        assert_eq!(e.safe_message, conversations_off().safe_message, "{cmd:?}: one fixed sentence");
        assert!(link.sent().is_empty(), "{cmd:?}: nothing reaches the daemon");
    }
}

#[test]
fn chathost_attachments_are_refused_with_a_closed_error_until_the_uploads_unit() {
    let link = FakeLink::new();
    let host = ChatHost::new();
    let cmd = Command::Submit { text: "mirá".into(), client_request_id: "req-00000002".into(), attachments: vec!["a1b2c3".into()] };
    let e = host.route(&link, "main", &cmd, T0).unwrap_err();
    assert_eq!(e.code, "attachments_unavailable");
    assert_eq!(e.safe_message, attachments_off().safe_message);
    assert!(link.sent().is_empty());
    assert_eq!(host.project(&link.view(), T0)["turns"], json!([]), "no turn is invented");
}

#[test]
fn chathost_invalid_text_is_refused_by_chat_rs_before_anything_is_sent() {
    let link = FakeLink::new();
    for bad in ["   ", "a\u{0}b"] {
        assert_eq!(err_code(ChatHost::new().route(&link, "main", &submit(bad, "req-00000003"), T0)), "invalid_input");
    }
    assert!(link.sent().is_empty());
}

#[test]
fn chathost_history_without_a_cursor_reads_the_newest_page() {
    let link = FakeLink::answering(|c| match c {
        ChatCommand::History => vec![json!({"type":"history","messages":[
            {"id":"s0-1","role":"user","text":"hola"},{"id":"s0-2","role":"assistant","text":"buenas"}],"hasEarlier":false})],
        _ => vec![],
    });
    let host = ChatHost::new();
    let cmd = Command::History { conversation_id: CHAT_CONVERSATION_ID.into(), before: None };
    let Routed::Answer(page) = host.route(&link, "main", &cmd, T0).unwrap() else { panic!("a page") };
    assert_eq!(link.sent(), vec![ChatCommand::History]);
    assert_eq!(page["turns"][0]["user_text"], json!("hola"));
    assert_eq!(page["turns"][0]["reply"], json!("buenas"));
    assert_eq!(page["before"], json!(null), "nothing older");
    assert_eq!(page["skipped"], json!(0));
}

#[test]
fn chathost_history_with_a_cursor_asks_the_daemon_for_the_page_before_the_oldest_message() {
    let link = FakeLink::answering(|c| match c {
        ChatCommand::Earlier { before } if before == "s0-3" => vec![json!({"type":"earlier","before":"s0-3","messages":[
            {"id":"s0-1","role":"user","text":"primera"},{"id":"s0-2","role":"assistant","text":"uno"}],"hasEarlier":false})],
        _ => vec![],
    });
    link.frame(json!({"type":"history","messages":[
        {"id":"s0-3","role":"user","text":"segunda"},{"id":"s0-4","role":"assistant","text":"dos"}],"hasEarlier":true}));
    let host = ChatHost::new();
    let first = host.project(&link.view(), T0);
    let before = first["history_before"].as_u64().expect("a positive numeric cursor the page passes back unchanged");
    assert!(before > 0);
    let newest_id = first["turns"][0]["turn_id"].clone();
    let cmd = Command::History { conversation_id: CHAT_CONVERSATION_ID.into(), before: Some(before) };
    let Routed::Answer(page) = host.route(&link, "main", &cmd, T0).unwrap() else { panic!("a page") };
    assert_eq!(link.sent(), vec![ChatCommand::Earlier { before: "s0-3".into() }]);
    let turns = page["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 1, "the page carries only what is older than the cursor");
    assert_eq!(turns[0]["user_text"], json!("primera"));
    assert_eq!(turns[0]["reply"], json!("uno"));
    let n = |t: &Value| t["turn_id"].as_str().unwrap()[2..].parse::<u64>().unwrap();
    assert!(n(&turns[0]) < n(&first["turns"][0]), "an older turn sorts before (chat-view.js mergeHistory)");
    assert_eq!(page["before"], json!(null));
    let after = host.project(&link.view(), T0);
    assert_eq!(after["turns"][1]["turn_id"], newest_id, "the turn already shown keeps its id across the prepend");
}

#[test]
fn chathost_history_for_another_conversation_is_refused() {
    let link = FakeLink::new();
    let cmd = Command::History { conversation_id: "c-principal".into(), before: None };
    assert_eq!(err_code(ChatHost::new().route(&link, "main", &cmd, T0)), "invalid_input");
    assert!(link.sent().is_empty());
}

#[test]
fn chathost_cancel_aborts_only_the_active_turn() {
    let link = FakeLink::new();
    let host = ChatHost::new();
    host.route(&link, "main", &submit("hola", "req-00000004"), T0).unwrap();
    let v = host.project(&link.view(), T0);
    let active = v["active_turn"].as_str().unwrap().to_owned();
    // a turn id that is not the active one: nothing is sent
    let r = host.route(&link, "main", &Command::Cancel { turn_id: "t-1".into() }, T0).unwrap();
    assert_eq!(r, Routed::Answer(json!({"cancelled": false})));
    assert_eq!(link.sent().len(), 1);
    let r = host.route(&link, "main", &Command::Cancel { turn_id: active.clone() }, T0).unwrap();
    assert_eq!(r, Routed::Answer(json!({"cancelled": true})));
    assert_eq!(link.sent().last(), Some(&ChatCommand::Abort));
    let v = host.project(&link.view(), T0);
    assert_eq!(last_turn(&v)["state"], json!("cancelled"));
    assert_eq!(v["active_turn"], json!(null));
}

#[test]
fn chathost_a_repeated_request_id_is_not_sent_twice_and_a_second_live_turn_is_refused() {
    let link = FakeLink::new();
    let host = ChatHost::new();
    host.route(&link, "main", &submit("hola", "req-00000005"), T0).unwrap();
    let Routed::Answer(dup) = host.route(&link, "main", &submit("hola", "req-00000005"), T0).unwrap() else { panic!() };
    assert_eq!(dup["duplicate"], json!(true));
    assert_eq!(link.sent().len(), 1, "the same page request is the same turn");
    assert_eq!(err_code(host.route(&link, "main", &submit("otra", "req-00000006"), T0)), "queue_full");
    assert_eq!(link.sent().len(), 1);
}

#[test]
fn chathost_an_offline_engine_refuses_the_send_without_inventing_a_turn() {
    let link = FakeLink::offline();
    let host = ChatHost::new();
    assert_eq!(err_code(host.route(&link, "main", &submit("hola", "req-00000007"), T0)), "engine_unavailable");
    assert_eq!(host.project(&link.view(), T0)["turns"], json!([]));
}

// ---- the window gate: the real label reaches the chatclient parse -------------------------

#[test]
fn chathost_the_settings_window_can_never_chat() {
    let host = ChatHost::new();
    for label in ["settings", "Main", "", "main "] {
        let link = FakeLink::new();
        let e = host.route(&link, label, &submit("hola", "req-00000008"), T0).unwrap_err();
        assert_eq!(e.code, "send_refused", "{label:?}");
        assert!(link.sent().is_empty(), "{label:?}: nothing leaves");
        let _ = host.route(&link, label, &Command::Check, T0);
        assert!(link.sent().is_empty(), "{label:?}: not even a status line");
    }
    assert_eq!(host.project(&FakeLink::new().view(), T0)["turns"], json!([]), "a refused send leaves no turn");
}

// ---- the chat:state projection ------------------------------------------------------------

const CONVERSATION_KEYS: [&str; 13] = [
    "active_turn", "availability", "conversation_id", "conversation_specialist", "evicted", "history_before",
    "history_persisted", "history_problem", "history_skipped", "producer", "queue_note", "target", "turns",
];
const TURN_KEYS: [&str; 12] = [
    "attachments", "error", "finish_reason", "profile_id", "profile_revision", "reply", "request_id", "seq",
    "state", "trimmed_turns", "turn_id", "user_text",
];

fn keys(v: &Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().expect("object").keys().cloned().collect();
    k.sort();
    k
}

#[test]
fn chathost_the_projection_keeps_the_page_keys_and_turn_shape() {
    let link = FakeLink::new();
    link.frame(json!({"type":"history","messages":[{"id":"s0-1","role":"user","text":"hola"},{"id":"s0-2","role":"assistant","text":"buenas"}],"hasEarlier":false}));
    let host = ChatHost::new();
    host.route(&link, "main", &submit("otra", "req-00000009"), T0).unwrap();
    let v = host.project(&link.view(), T0);
    assert_eq!(keys(&v), CONVERSATION_KEYS);
    assert_eq!(v["conversation_id"], json!(CHAT_CONVERSATION_ID));
    assert!(crate::conversations::valid_id(CHAT_CONVERSATION_ID), "the page passes it back through chat.rs's history parse");
    assert_eq!(v["target"], json!(null), "the engine owns the model: no local target");
    assert_eq!(keys(&v["availability"]), ["message", "state"]);
    assert_eq!(keys(&v["producer"]), ["note", "pi"]);
    for t in v["turns"].as_array().unwrap() {
        assert_eq!(keys(t), TURN_KEYS);
        let id = t["turn_id"].as_str().unwrap();
        assert!(id.len() <= 24 && id.starts_with("t-") && id[2..].bytes().all(|b| b.is_ascii_digit()), "chat.rs valid_turn_id: {id}");
    }
}

#[test]
fn chathost_producer_is_the_real_engine_state_and_never_names_the_engine_vendor() {
    let host = ChatHost::new();
    let off = host.project(&FakeLink::offline().view(), T0);
    assert_eq!(off["producer"]["pi"], json!("unavailable"));
    assert_eq!(off["availability"]["state"], json!("unavailable"));
    let link = FakeLink::new();
    let cases = [
        (json!({"type":"agent_state","busy":false,"status":"ready","paused":false}), "ready", "ready"),
        (json!({"type":"agent_state","busy":true,"status":"ready","paused":false}), "busy", "busy"),
        (json!({"type":"agent_state","busy":false,"status":"starting","paused":false}), "connected", "unchecked"),
        (json!({"type":"agent_state","busy":false,"status":"restarting","paused":false}), "unavailable", "unavailable"),
        (json!({"type":"agent_state","busy":false,"status":"stopped","paused":false}), "unavailable", "unavailable"),
        (json!({"type":"agent_state","busy":false,"status":"ready","paused":true}), "ready", "blocked"),
    ];
    let mut values = vec![off];
    for (frame, producer, availability) in cases {
        link.frame(frame.clone());
        let v = host.project(&link.view(), T0);
        assert_eq!(v["producer"]["pi"], json!(producer), "{frame}");
        assert_eq!(v["availability"]["state"], json!(availability), "{frame}");
        values.push(v);
    }
    let fresh = ChatState::connected();
    let v = host.project(&serde_json::to_value(&fresh).unwrap(), T0);
    assert_eq!(v["producer"]["pi"], json!("connected"), "connected, no engine status yet");
    values.push(v);
    for v in values {
        for text in [&v["producer"]["note"], &v["availability"]["message"]] {
            let s = text.as_str().expect("a sentence");
            assert!(!s.split(|c: char| !c.is_alphanumeric()).any(|w| w.eq_ignore_ascii_case("pi")), "{s}");
        }
    }
}

#[test]
fn chathost_a_streamed_reply_belongs_to_the_submitted_turn_never_to_the_last_history_turn() {
    let link = FakeLink::new();
    link.frame(json!({"type":"history","messages":[{"id":"s0-1","role":"user","text":"hola"},{"id":"s0-2","role":"assistant","text":"buenas"}],"hasEarlier":false}));
    let host = ChatHost::new();
    host.route(&link, "main", &submit("otra", "req-00000010"), T0).unwrap();
    link.frame(json!({"type":"agent_state","busy":true,"status":"ready","paused":false}));
    link.frame(json!({"type":"message_delta","messageId":"m0","text":"escri"}));
    let v = host.project(&link.view(), T0 + 10);
    let turns = v["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["reply"], json!("buenas"), "the history turn is untouched");
    assert_eq!(turns[1]["user_text"], json!("otra"));
    assert_eq!(turns[1]["reply"], json!("escri"));
    assert_eq!(turns[1]["state"], json!("streaming"));
    let live_id = turns[1]["turn_id"].clone();
    // the message lands: still the submitted turn's reply, not a new pairing with "hola"
    link.frame(json!({"type":"message_delta","messageId":"m0","text":"bo"}));
    link.frame(json!({"type":"message_done","messageId":"m0"}));
    link.frame(json!({"type":"agent_state","busy":false,"status":"ready","paused":false}));
    let v = host.project(&link.view(), T0 + 20);
    let turns = v["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["reply"], json!("buenas"));
    assert_eq!(turns[1]["reply"], json!("escribo"));
    assert_eq!(turns[1]["state"], json!("completed"));
    assert_eq!(v["active_turn"], json!(null));
    // the daemon's own history confirms the turn: the page keeps the same turn id
    link.frame(json!({"type":"history","messages":[
        {"id":"s0-1","role":"user","text":"hola"},{"id":"s0-2","role":"assistant","text":"buenas"},
        {"id":"s0-3","role":"user","text":"otra"},{"id":"s0-4","role":"assistant","text":"escribo"}],"hasEarlier":false}));
    let v = host.project(&link.view(), T0 + 30);
    let turns = v["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[1]["turn_id"], live_id, "the confirmed turn keeps its id");
    assert_eq!(turns[1]["reply"], json!("escribo"));
}

#[test]
fn chathost_seq_never_decreases_so_the_page_never_drops_a_newer_state() {
    let link = FakeLink::new();
    link.frame(json!({"type":"history","messages":[{"id":"s0-3","role":"user","text":"b"},{"id":"s0-4","role":"assistant","text":"2"}],"hasEarlier":true}));
    let host = ChatHost::new();
    let a = host.project(&link.view(), T0);
    link.frame(json!({"type":"earlier","before":"s0-3","messages":[{"id":"s0-1","role":"user","text":"a"},{"id":"s0-2","role":"assistant","text":"1"}],"hasEarlier":false}));
    let b = host.project(&link.view(), T0);
    // a fresh newest page REPLACES the log (fewer messages than after the prepend)
    link.frame(json!({"type":"history","messages":[{"id":"s0-3","role":"user","text":"b"},{"id":"s0-4","role":"assistant","text":"2"}],"hasEarlier":true}));
    let c = host.project(&link.view(), T0);
    let seq_of = |v: &Value, id: &Value| v["turns"].as_array().unwrap().iter().find(|t| &t["turn_id"] == id).map(|t| t["seq"].as_u64().unwrap());
    let id = a["turns"][0]["turn_id"].clone();
    assert!(seq_of(&b, &id).unwrap() > seq_of(&a, &id).unwrap());
    assert!(seq_of(&c, &id).unwrap() > seq_of(&b, &id).unwrap(), "chat-view.js staleSnapshot would drop c otherwise");
    assert_eq!(c["turns"][0]["turn_id"], id, "same message, same id");
}

#[test]
fn chathost_a_daemon_error_ends_the_live_turn_with_a_closed_sentence() {
    let link = FakeLink::new();
    let host = ChatHost::new();
    host.route(&link, "main", &submit("hola", "req-00000011"), T0).unwrap();
    link.frame(json!({"type":"error","code":"busy","message":"raw daemon text"}));
    let v = host.project(&link.view(), T0 + 5);
    let t = last_turn(&v);
    assert_eq!(t["state"], json!("error"));
    assert_eq!(t["error"]["code"], json!("busy"));
    let msg = t["error"]["safe_message"].as_str().unwrap();
    assert!(!msg.contains("raw"), "never the daemon's raw text");
    assert_eq!(v["active_turn"], json!(null));
    // a lost connection ends a live turn too
    let link = FakeLink::new();
    let host = ChatHost::new();
    host.route(&link, "main", &submit("hola", "req-00000012"), T0).unwrap();
    let lost = serde_json::to_value(ChatState::disconnected(crate::agentclient::Reason::Lost)).unwrap();
    assert_eq!(last_turn(&host.project(&lost, T0 + 5))["state"], json!("error"));
}

#[test]
fn chathost_a_turn_settles_after_the_grace_even_when_busy_was_never_seen() {
    let link = FakeLink::new();
    let host = ChatHost::new();
    host.route(&link, "main", &submit("hola", "req-00000013"), T0).unwrap();
    assert_eq!(last_turn(&host.project(&link.view(), T0 + 100))["state"], json!("thinking"), "inside the grace");
    assert_eq!(last_turn(&host.project(&link.view(), T0 + PENDING_SETTLE_MS))["state"], json!("completed"));
}

// ---- source guards on the Tauri glue (chathost.rs / main.rs, binary crate) -----------------

fn chat_action_body() -> &'static str {
    let src = include_str!("chathost.rs");
    let start = src.find("pub async fn chat_action").expect("chat_action exists");
    let rest = &src[start..];
    &rest[..rest.find("\n}\n").expect("chat_action ends")]
}

#[test]
fn chathost_chat_action_keeps_its_gates_and_passes_the_real_window_label() {
    let body = chat_action_body();
    let gate = body.find("main_window_only(webview.label())").expect("the island gate stays");
    let origin = body.find("bridge::sender_ok(webview.label(), &url)").expect("the origin gate stays");
    let rate = body.find("chat_rate").expect("the rate gate stays");
    let route = body.find(".route(").expect("chat_action routes through ChatHost::route");
    assert!(gate < origin && origin < rate && rate < route, "gates run before anything is routed");
    assert!(body.contains("let caller = webview.label().to_string();"), "the REAL window label is what the route sees");
    assert!(body.contains("&caller"), "and it is passed into the chatclient parse");
    assert!(!include_str!("chathost.rs").contains("CHAT_WINDOW_LABEL"), "never a constant label");
}

#[test]
fn chathost_the_direct_rust_chat_is_no_longer_reachable() {
    let src = include_str!("chathost.rs");
    for gone in ["chatlane", "cloudmodel", "live_snapshot", "prepare_target", "specialistshost", "list_conversations", "new_conversation", "history_page", "run_turn"] {
        assert!(!src.contains(gone), "chathost.rs still reaches {gone}");
    }
    assert!(src.contains("pub fn start_history"), "the local store init stays until U5");
}

#[test]
fn chathost_setup_starts_one_reconnecting_chat_connection_after_the_legacy_cleanup() {
    let main = include_str!("main.rs");
    let cleanup = main.find("legacy_conversations::cleanup").expect("T5 cleanup");
    let history = main.find("chathost::start_history(&handle)").expect("start_history");
    let conn = main.find("chathost::start_conn(&handle)").expect("setup starts the chat connection");
    assert!(cleanup < history, "T5's cleanup still runs before start_history");
    assert!(history < conn);
    assert!(main.contains("chathost::stop_conn(app)"), "the connection closes on exit");
    let src = include_str!("chathost.rs");
    let start = &src[src.find("pub fn start_conn").expect("start_conn")..];
    let start = &start[..start.find("\n}\n").unwrap()];
    assert!(start.contains("ChatConn::new"), "one ChatConn per app");
    assert!(start.contains("RECONNECT_GAP"), "a lost connection is retried, throttled");
    assert!(start.contains(".manage("), "managed state, not a new AppState field");
}

// ---- K2-05 T4 U3 follow-ups (verifier mwanung2-19-7bou F1/F4-F8, native review R1-R3) ----------

fn agent(link: &FakeLink, busy: bool, status: &str) {
    link.frame(json!({"type":"agent_state","busy":busy,"status":status,"paused":false}));
}

fn page(link: &FakeLink, msgs: &[(&str, &str, &str)], has_earlier: bool) {
    let messages: Vec<Value> = msgs.iter().map(|(id, role, text)| json!({"id": id, "role": role, "text": text})).collect();
    link.frame(json!({"type":"history","messages":messages,"hasEarlier":has_earlier}));
}

fn turns(v: &Value) -> Vec<Value> {
    v["turns"].as_array().cloned().unwrap_or_default()
}

#[test]
fn chathost_f1_a_refused_send_never_claims_the_history_of_a_later_identical_send() {
    let link = FakeLink::new();
    let host = ChatHost::new();
    host.route(&link, "main", &submit("hola", "req-f1000001"), T0).unwrap();
    link.frame(json!({"type":"error","code":"busy"}));
    assert_eq!(last_turn(&host.project(&link.view(), T0 + 10))["state"], json!("error"), "the refusal ends the turn");
    host.route(&link, "main", &submit("hola", "req-f1000002"), T0 + 20).unwrap();
    agent(&link, true, "ready");
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"respuesta"}));
    link.frame(json!({"type":"message_done","messageId":"m1"}));
    agent(&link, false, "ready");
    host.project(&link.view(), T0 + 30);
    page(&link, &[("s0-1", "user", "hola"), ("s0-2", "assistant", "respuesta")], false);
    let v = host.project(&link.view(), T0 + 40);
    let ts = turns(&v);
    assert_eq!(ts.len(), 2, "one refused turn and one answered turn, never the exchange twice: {v}");
    assert_eq!(ts[0]["state"], json!("error"), "the refusal stays visible");
    assert_eq!(ts[0]["error"]["code"], json!("busy"));
    assert_eq!(ts[0]["reply"], json!(""));
    assert_eq!(ts[1]["state"], json!("completed"));
    assert_eq!(ts[1]["reply"], json!("respuesta"));
}

#[test]
fn chathost_f4_a_cancelled_turn_keeps_its_state_and_partial_text_after_history_confirms_it() {
    let link = FakeLink::new();
    let host = ChatHost::new();
    host.route(&link, "main", &submit("contame", "req-f4000001"), T0).unwrap();
    agent(&link, true, "ready");
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"parcial"}));
    let v = host.project(&link.view(), T0 + 10);
    let active = v["active_turn"].as_str().unwrap().to_owned();
    host.route(&link, "main", &Command::Cancel { turn_id: active.clone() }, T0 + 20).unwrap();
    agent(&link, false, "ready");
    host.project(&link.view(), T0 + 30);
    // the engine recorded the prompt but no answer: the daemon's history has only the user row
    page(&link, &[("s0-1", "user", "contame")], false);
    let v = host.project(&link.view(), T0 + 40);
    let ts = turns(&v);
    assert_eq!(ts.len(), 1, "{v}");
    assert_eq!(ts[0]["turn_id"], json!(active));
    assert_eq!(ts[0]["state"], json!("cancelled"), "never completed with an empty reply");
    assert_eq!(ts[0]["reply"], json!("parcial"), "the partial text is kept");
}

#[test]
fn chathost_f4_a_daemon_restart_interrupts_the_turn_and_keeps_the_last_known_history() {
    let link = FakeLink::new();
    page(&link, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "respuesta vieja")], false);
    let host = ChatHost::new();
    host.project(&link.view(), T0);
    host.route(&link, "main", &submit("nueva", "req-f4000002"), T0).unwrap();
    agent(&link, true, "ready");
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"medio"}));
    let id = host.project(&link.view(), T0 + 10)["active_turn"].clone();
    // the daemon goes away: the connection is lost and the reader resets the chat view
    let lost = serde_json::to_value(ChatState::disconnected(crate::agentclient::Reason::Lost)).unwrap();
    let v = host.project(&lost, T0 + 20);
    let ts = turns(&v);
    assert_eq!(ts.len(), 2, "the last known history stays on screen while the daemon is down: {v}");
    assert_eq!(ts[0]["user_text"], json!("vieja"));
    assert_eq!(ts[0]["reply"], json!("respuesta vieja"));
    assert_eq!(ts[1]["turn_id"], id);
    assert_eq!(ts[1]["state"], json!("error"));
    assert_eq!(ts[1]["error"]["code"], json!("interrupted"));
    assert_eq!(ts[1]["reply"], json!("medio"), "the partial text is kept");
    // a fresh connection (not yet given a page) still shows the last known chat
    let fresh = serde_json::to_value(ChatState::connected()).unwrap();
    assert_eq!(turns(&host.project(&fresh, T0 + 25)).len(), 2);
    // reconnected: the daemon's history carries the prompt; the turn keeps its id, state and text
    let again = FakeLink::new();
    page(&again, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "respuesta vieja"), ("s0-3", "user", "nueva")], false);
    let v = host.project(&again.view(), T0 + 30);
    let ts = turns(&v);
    assert_eq!(ts.len(), 2, "no duplicate: {v}");
    assert_eq!(ts[1]["turn_id"], id);
    assert_eq!(ts[1]["error"]["code"], json!("interrupted"));
    assert_eq!(ts[1]["reply"], json!("medio"));
}

#[test]
fn chathost_f4_an_engine_restart_interrupts_the_live_turn_instead_of_completing_it() {
    let link = FakeLink::new();
    let host = ChatHost::new();
    host.route(&link, "main", &submit("hola", "req-f4000003"), T0).unwrap();
    agent(&link, true, "ready");
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"algo"}));
    host.project(&link.view(), T0 + 10);
    agent(&link, false, "restarting");
    let t = last_turn(&host.project(&link.view(), T0 + 5_000));
    assert_eq!(t["state"], json!("error"));
    assert_eq!(t["error"]["code"], json!("interrupted"));
    assert_eq!(t["reply"], json!("algo"));
}

#[test]
fn chathost_f5_only_an_error_correlated_to_the_send_ends_a_thinking_turn() {
    let link = FakeLink::new();
    let host = ChatHost::new();
    // a history read is already waiting for its answer when the turn is sent
    link.command("main", &json!({"action": "chat_history"})).unwrap();
    host.route(&link, "main", &submit("hola", "req-f5000001"), T0).unwrap();
    for code in ["unknown_ask", "not_busy", "conversations_off"] {
        link.frame(json!({"type":"error","code":code}));
        assert_eq!(last_turn(&host.project(&link.view(), T0 + 10))["state"], json!("thinking"), "{code} is never the send's");
    }
    // FIFO: the oldest waiting command that can fail this way (the history read) takes it
    link.frame(json!({"type":"error","code":"unavailable"}));
    assert_eq!(last_turn(&host.project(&link.view(), T0 + 20))["state"], json!("thinking"), "the history read's error");
    link.frame(json!({"type":"error","code":"unavailable"}));
    let t = last_turn(&host.project(&link.view(), T0 + 30));
    assert_eq!(t["state"], json!("error"), "the send's own refusal ends it");
    assert_eq!(t["error"]["code"], json!("unavailable"));
}

#[test]
fn chathost_f6_a_settled_turn_refreshes_the_daemon_history_on_the_next_page_verb() {
    let link = FakeLink::new();
    let host = ChatHost::new();
    host.route(&link, "main", &submit("hola", "req-f6000001"), T0).unwrap();
    agent(&link, true, "ready");
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"buenas"}));
    link.frame(json!({"type":"message_done","messageId":"m1"}));
    agent(&link, false, "ready");
    assert_eq!(last_turn(&host.project(&link.view(), T0 + 10))["state"], json!("completed"));
    host.route(&link, "main", &Command::View, T0 + 20).unwrap();
    assert!(link.sent().contains(&ChatCommand::History), "the settle asks the daemon for its record: {:?}", link.sent());
    // only once per settle
    host.route(&link, "main", &Command::View, T0 + 5_000).unwrap();
    assert_eq!(link.sent().iter().filter(|c| **c == ChatCommand::History).count(), 1);
}

/// A fake daemon with a real transcript: `send` appends the prompt and a reply, `get_history`
/// answers the newest 100 messages, `get_earlier` the 100 before a page id.
fn transcript_link() -> FakeLink {
    let log: std::sync::Arc<Mutex<Vec<(String, String)>>> = Default::default();
    let page_of = |log: &[(String, String)], from: usize, to: usize| -> Vec<Value> {
        (from..to).map(|i| json!({"id": format!("s0-{i}"), "role": log[i].0, "text": log[i].1})).collect()
    };
    let mut link = FakeLink::answering(move |c| {
        let mut log = log.lock().unwrap();
        match c {
            ChatCommand::Send { text, .. } => {
                log.push(("user".into(), text.clone()));
                log.push(("assistant".into(), format!("r-{text}")));
                let id = format!("m{}", log.len());
                vec![
                    json!({"type":"agent_state","busy":true,"status":"ready","paused":false}),
                    json!({"type":"message_delta","messageId":id,"text":format!("r-{text}")}),
                    json!({"type":"message_done","messageId":id}),
                    json!({"type":"agent_state","busy":false,"status":"ready","paused":false}),
                ]
            }
            ChatCommand::History => {
                let from = log.len().saturating_sub(100);
                vec![json!({"type":"history","messages":page_of(&log, from, log.len()),"hasEarlier":from > 0})]
            }
            ChatCommand::Earlier { before } => {
                let to: usize = before.rsplit('-').next().unwrap().parse().unwrap();
                let from = to.saturating_sub(100);
                vec![json!({"type":"earlier","before":before,"messages":page_of(&log, from, to),"hasEarlier":from > 0})]
            }
            _ => vec![],
        }
    });
    link.unlimited = true;
    link
}

#[test]
fn chathost_f6_f3_a_long_chat_stays_bounded_and_every_turn_stays_reachable_by_paging() {
    const N: u64 = 260;
    let link = transcript_link();
    let host = ChatHost::new();
    let mut now = T0;
    for k in 0..N {
        let r = host.route(&link, "main", &submit(&format!("t{k}"), &format!("req-{k:08x}")), now);
        assert!(r.is_ok(), "turn {k}: {r:?}");
        now += 10;
        let v = host.project(&link.view(), now);
        assert!(turns(&v).len() <= 50, "turn {k}: chat:state carries the visible window only ({})", turns(&v).len());
        assert_eq!(last_turn(&v)["state"], json!("completed"), "turn {k}");
        now += 10;
    }
    let v = host.project(&link.view(), now);
    assert_eq!(last_turn(&v)["user_text"], json!(format!("t{}", N - 1)));
    let mut seen: Vec<String> = turns(&v).iter().map(|t| t["user_text"].as_str().unwrap().to_owned()).collect();
    for t in turns(&v) {
        assert_eq!(t["reply"], json!(format!("r-{}", t["user_text"].as_str().unwrap())));
    }
    let mut cursor = v["history_before"].clone();
    let mut pages = 0;
    while let Some(n) = cursor.as_u64() {
        pages += 1;
        assert!(pages < 20, "paging terminates");
        let cmd = Command::History { conversation_id: CHAT_CONVERSATION_ID.into(), before: Some(n) };
        let Routed::Answer(p) = host.route(&link, "main", &cmd, now).unwrap() else { panic!("a page") };
        let ts = turns(&p);
        assert!(!ts.is_empty() && ts.len() <= 50, "a bounded, non-empty page: {}", ts.len());
        for t in &ts {
            assert_eq!(t["reply"], json!(format!("r-{}", t["user_text"].as_str().unwrap())));
        }
        seen.extend(ts.iter().map(|t| t["user_text"].as_str().unwrap().to_owned()));
        cursor = p["before"].clone();
    }
    let mut expected: Vec<String> = (0..N).map(|k| format!("t{k}")).collect();
    expected.sort();
    seen.sort();
    assert_eq!(seen, expected, "every turn reachable exactly once");
    // F3: paging deep never leaves the newest end trimmed from the chat
    let v = host.project(&link.view(), now);
    assert_eq!(last_turn(&v)["user_text"], json!(format!("t{}", N - 1)), "the newest turn is still on screen");
    assert_eq!(link.view()["newerTrimmed"], json!(false), "the host reloaded the newest page");
}

#[test]
fn chathost_r1_two_concurrent_submits_never_both_reach_the_daemon() {
    let mut link = FakeLink::new();
    link.slow_view_ms = 40;
    let link = std::sync::Arc::new(link);
    let host = std::sync::Arc::new(ChatHost::new());
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|i| {
            let (link, host, barrier) = (link.clone(), host.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                host.route(&*link, "main", &submit(&format!("hola {i}"), &format!("req-r1{i:06}")), T0).map_err(|e| e.code)
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let sends = link.sent().iter().filter(|c| matches!(c, ChatCommand::Send { .. })).count();
    assert_eq!(sends, 1, "check and send are one critical section: {results:?}");
    assert_eq!(results.iter().filter(|r| r.as_ref().err().map(String::as_str) == Some("queue_full")).count(), 1, "{results:?}");
}

fn fn_body<'a>(src: &'a str, sig: &str) -> &'a str {
    let start = src.find(sig).unwrap_or_else(|| panic!("{sig} exists"));
    let rest = &src[start..];
    &rest[..rest.find("\n}\n").unwrap_or_else(|| panic!("{sig} ends"))]
}

#[test]
fn chathost_f7_the_keeper_and_publish_never_reserialize_the_chat_state() {
    let src = include_str!("chathost.rs");
    assert!(!fn_body(src, "fn connected(").contains(".view()"), "the keeper reads the view the reader handed over");
    assert!(!fn_body(src, "fn conversation_view(").contains("conn.view()"), "publish projects the handed-over view");
    assert!(!fn_body(src, "pub fn publish_chat(").contains("conn.view()"));
    let start = fn_body(src, "pub fn start_conn(");
    assert!(start.contains("ChatFeed::reader_callback"), "the production callback is the tested one");
}

#[test]
fn chathost_f8_chat_attach_and_chat_attach_data_refuse_and_write_nothing() {
    let src = include_str!("chathost.rs");
    for sig in ["pub async fn chat_attach(", "pub async fn chat_attach_data("] {
        let body = fn_body(src, sig);
        assert!(body.contains("attachments_off()"), "{sig} refuses with attachments_unavailable");
        for gone in ["store_attachment", "uploads::attach", "attachments_dir", "read_dropped", "split_raw_body"] {
            assert!(!body.contains(gone), "{sig} still reaches {gone}");
        }
        let gate = body.find("main_window_only(webview.label())").expect("the island gate stays");
        assert!(gate < body.find("attachments_off()").unwrap());
    }
    assert!(!src.contains("fn store_attachment"), "no write path left to call");
}

#[test]
fn chathost_r2_the_production_reader_callback_projects_emits_and_refreshes_on_the_settle_event() {
    let emitted: std::sync::Arc<Mutex<Vec<Value>>> = Default::default();
    let sink = emitted.clone();
    let feed = ChatFeed::new(move |v| sink.lock().unwrap().push(v));
    let link: std::sync::Arc<FakeLink> = std::sync::Arc::new(FakeLink::new());
    let dyn_link: std::sync::Arc<dyn ChatLink + Send + Sync> = link.clone();
    feed.bind(std::sync::Arc::downgrade(&dyn_link));
    let callback = ChatFeed::reader_callback(&feed);
    assert!(!feed.connected(), "nothing handed over yet: not connected");
    callback(link.view());
    assert!(feed.connected(), "the keeper reads the handed-over view");
    assert_eq!(emitted.lock().unwrap().len(), 1, "every handed-over view is projected and emitted");
    feed.host().route(&*link, "main", &submit("hola", "req-r2000001"), T0).unwrap();
    for f in [
        json!({"type":"agent_state","busy":true,"status":"ready","paused":false}),
        json!({"type":"message_delta","messageId":"m1","text":"buenas"}),
        json!({"type":"message_done","messageId":"m1"}),
    ] {
        link.frame(f);
        callback(link.view());
    }
    assert!(!link.sent().contains(&ChatCommand::History), "no refresh while the turn runs");
    // the settle EVENT (busy → false) is what triggers the refresh, not a timer
    link.frame(json!({"type":"agent_state","busy":false,"status":"ready","paused":false}));
    callback(link.view());
    assert_eq!(link.sent().iter().filter(|c| **c == ChatCommand::History).count(), 1, "{:?}", link.sent());
    let last = emitted.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last_turn(&last)["reply"], json!("buenas"));
    assert_eq!(last_turn(&last)["state"], json!("completed"));
    // a lost connection handed over: not connected, history kept on screen
    callback(serde_json::to_value(ChatState::disconnected(crate::agentclient::Reason::Lost)).unwrap());
    assert!(!feed.connected());
}

#[test]
fn chathost_f3_a_trimmed_view_never_takes_the_newest_turns_off_the_chat() {
    // the daemon never answers the reload: the island must keep the newest window on its own
    let link = FakeLink::new();
    let rows = |from: usize, to: usize| -> Vec<Value> {
        (from..to).map(|i| json!({"id": format!("s0-{i}"), "role": if i % 2 == 0 { "user" } else { "assistant" }, "text": format!("m{i}")})).collect()
    };
    link.frame(json!({"type":"history","messages":rows(500, 600),"hasEarlier":true}));
    let host = ChatHost::new();
    let newest = last_turn(&host.project(&link.view(), T0));
    assert_eq!(newest["user_text"], json!("m598"));
    for k in (0..5).rev() {
        link.frame(json!({"type":"earlier","before":format!("s0-{}", (k + 1) * 100),"messages":rows(k * 100, (k + 1) * 100),"hasEarlier":k > 0}));
    }
    assert_eq!(link.view()["newerTrimmed"], json!(true), "the daemon view lost its newest end");
    let v = host.project(&link.view(), T0 + 10);
    assert_eq!(last_turn(&v)["turn_id"], newest["turn_id"], "the chat still ends with the newest turn: {}", last_turn(&v));
}

// ---- K2-05 T4 U4 verifier B1/B2/F1-edge/F6-edge: deep paging over daemon-shaped pages -------

/// A fake daemon shaped like `conversations.cjs` `pageHistory`: message ids `s0-<index>`
/// (1-based), a page is at most `page_size(end)` messages counted back from `end` (the newest
/// message for `get_history`, the message before the cursor for `get_earlier`), `hasEarlier` =
/// messages remain before the page. Turn `k` is the user text `p<k>` and, unless `no_reply(k)`,
/// the assistant reply `r-p<k>`.
fn daemon_link(total_turns: usize, no_reply: fn(usize) -> bool, page_size: fn(usize) -> usize) -> (FakeLink, Vec<(String, String)>) {
    let mut log: Vec<(&'static str, String)> = vec![];
    let mut expected = vec![];
    for k in 0..total_turns {
        log.push(("user", format!("p{k}")));
        let reply = if no_reply(k) { String::new() } else { format!("r-p{k}") };
        if !reply.is_empty() {
            log.push(("assistant", reply.clone()));
        }
        expected.push((format!("p{k}"), reply));
    }
    let log = std::sync::Arc::new(log);
    let mut link = FakeLink::answering(move |c| {
        // the messages log[from..end] (ids s0-(from+1) ..= s0-end)
        let page = |end: usize| -> (Vec<Value>, bool) {
            let from = end.saturating_sub(page_size(end));
            let messages = (from..end).map(|i| json!({"id": format!("s0-{}", i + 1), "role": log[i].0, "text": log[i].1})).collect();
            (messages, from > 0)
        };
        match c {
            ChatCommand::History => {
                let (messages, more) = page(log.len());
                vec![json!({"type":"history","messages":messages,"hasEarlier":more})]
            }
            ChatCommand::Earlier { before } => {
                let k: usize = before.strip_prefix("s0-").and_then(|k| k.parse().ok()).unwrap_or(0);
                let (messages, more) = if k == 0 || k > log.len() { (vec![], false) } else { page(k - 1) };
                vec![json!({"type":"earlier","before":before,"messages":messages,"hasEarlier":more})]
            }
            _ => vec![],
        }
    });
    link.unlimited = true;
    (link, expected)
}

fn texts(ts: &[Value]) -> Vec<(String, String)> {
    ts.iter().map(|t| (t["user_text"].as_str().unwrap_or("?").to_owned(), t["reply"].as_str().unwrap_or("?").to_owned())).collect()
}

/// One pass of the page from the newest window back to the first turn, exactly as chat.js
/// pages (the cursor the host returns, passed back unchanged). After every page the
/// `chat:state` window must still be the newest contiguous turns (B1), and a turn id must
/// always carry the same turn (the page merges by id, live turns win: one id = one turn).
fn pass(host: &ChatHost, link: &FakeLink, expected: &[(String, String)], ids: &mut std::collections::HashMap<String, (String, String)>, label: &str) {
    let window = |v: &Value| {
        let ts = turns(v);
        assert!(!ts.is_empty() && ts.len() <= WINDOW_TURNS, "{label}: a bounded window ({})", ts.len());
        assert_eq!(texts(&ts), expected[expected.len() - ts.len()..].to_vec(), "{label}: chat:state shows the NEWEST contiguous turns, in order, each with its own reply");
        ts
    };
    let record = |ts: &[Value], ids: &mut std::collections::HashMap<String, (String, String)>| {
        for t in ts {
            let id = t["turn_id"].as_str().unwrap().to_owned();
            let content = (t["user_text"].as_str().unwrap().to_owned(), t["reply"].as_str().unwrap().to_owned());
            let known = ids.entry(id.clone()).or_insert_with(|| content.clone());
            assert_eq!(*known, content, "{label}: turn id {id} always names the same turn");
        }
    };
    let v = host.project(&link.view(), T0);
    let mut shown = window(&v);
    record(&shown, ids);
    let mut cursor = v["history_before"].clone();
    let mut pages = 0;
    while let Some(n) = cursor.as_u64() {
        pages += 1;
        assert!(pages <= expected.len(), "{label}: paging terminates");
        let cmd = Command::History { conversation_id: CHAT_CONVERSATION_ID.into(), before: Some(n) };
        let Routed::Answer(p) = host.route(link, "main", &cmd, T0).unwrap() else { panic!("{label}: a page") };
        let ts = turns(&p);
        assert!(!ts.is_empty() && ts.len() <= WINDOW_TURNS, "{label}: a page with a cursor is never empty (B2): {p}");
        assert_eq!(ts.last().unwrap()["turn_id"].as_str().map(|s| s[2..].parse::<u64>().unwrap()).unwrap() < n, true, "{label}: older than the cursor");
        record(&ts, ids);
        let mut next = ts;
        next.extend(shown);
        shown = next;
        cursor = p["before"].clone();
        window(&host.project(&link.view(), T0));
    }
    // ORDER and CONTENT, never sorted: every turn exactly once, in chat order, its own reply
    assert_eq!(texts(&shown), expected.to_vec(), "{label}: the pass reaches every turn once, in order");
    let nums: Vec<u64> = shown.iter().map(|t| t["turn_id"].as_str().unwrap()[2..].parse().unwrap()).collect();
    assert!(nums.windows(2).all(|w| w[0] < w[1]), "{label}: turn ids follow the chat order (chat-view.js sorts by them)");
}

fn two_passes(total: usize, no_reply: fn(usize) -> bool, page_size: fn(usize) -> usize, label: &str) {
    let (link, expected) = daemon_link(total, no_reply, page_size);
    let host = ChatHost::new();
    let first = Command::History { conversation_id: CHAT_CONVERSATION_ID.into(), before: None };
    host.route(&link, "main", &first, T0).unwrap();
    let mut ids = std::collections::HashMap::new();
    pass(&host, &link, &expected, &mut ids, &format!("{label} pass 1"));
    pass(&host, &link, &expected, &mut ids, &format!("{label} pass 2"));
}

fn some_without_reply(k: usize) -> bool {
    k % 7 == 3 || k % 11 == 5
}
fn all_replied(_: usize) -> bool {
    false
}
/// The byte budget makes real pages shorter and uneven: ~48 messages, sometimes fewer.
fn budget_pages(end: usize) -> usize {
    [48, 47, 45, 48, 31, 48][end % 6]
}

#[test]
fn chathost_b1_deep_paging_with_48_message_pages_reaches_every_turn_in_order_on_two_passes() {
    for total in [320, 600] {
        two_passes(total, all_replied, |_| 48, &format!("{total} turns, 48/page"));
        two_passes(total, some_without_reply, |_| 48, &format!("{total} turns, 48/page, some unanswered"));
    }
}

#[test]
fn chathost_b1_deep_paging_with_99_and_100_message_pages_never_moves_a_reply_across_a_gap() {
    for total in [320, 600] {
        two_passes(total, some_without_reply, |_| 99, &format!("{total} turns, 99/page, some unanswered"));
        two_passes(total, some_without_reply, |_| 100, &format!("{total} turns, 100/page, some unanswered"));
        two_passes(total, all_replied, |_| 100, &format!("{total} turns, 100/page"));
    }
}

#[test]
fn chathost_b1_deep_paging_with_uneven_byte_budget_pages_reaches_every_turn_in_order() {
    for total in [320, 600] {
        two_passes(total, some_without_reply, budget_pages, &format!("{total} turns, uneven pages, some unanswered"));
    }
}

#[test]
fn chathost_b2_a_page_holding_one_message_still_advances_the_cursor() {
    // every earlier page is ONE message: half of them a lone assistant reply (no turn of its own)
    two_passes(60, all_replied, |end| if end == 120 { 48 } else { 1 }, "one-message pages");
    two_passes(60, some_without_reply, |end| if end == 60 * 2 - 13 { 48 } else { 1 }, "one-message pages, some unanswered");
}

#[test]
fn chathost_b1_a_history_answer_never_counts_as_the_earlier_page_answer() {
    // the reload's (or the settle refresh's) `history` answer lands while an `earlier` read
    // waits: it must never be taken for the earlier page
    let mut st = ChatState::connected();
    st.command("main", &json!({"action":"chat_earlier","before":"s0-50"})).unwrap();
    st.command("main", &json!({"action":"chat_history"})).unwrap();
    let before = serde_json::to_value(&st).unwrap();
    st.apply(&json!({"type":"history","messages":[{"id":"s0-60","role":"user","text":"x"}],"hasEarlier":true}));
    let after = serde_json::to_value(&st).unwrap();
    assert_eq!(after["earlierReads"], before["earlierReads"], "a history answer is not the earlier answer: {after}");
    st.apply(&json!({"type":"earlier","before":"s0-50","messages":[{"id":"s0-49","role":"user","text":"y"}],"hasEarlier":true}));
    let done = serde_json::to_value(&st).unwrap();
    assert_eq!(done["earlierReads"]["answered"], json!(1), "{done}");
}

#[test]
fn chathost_f1_identical_texts_claim_in_send_order_and_never_a_later_turns_record() {
    let link = FakeLink::new();
    page(&link, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "respuesta vieja")], false);
    let host = ChatHost::new();
    host.project(&link.view(), T0);
    // turn A «hola»: the engine restarts under it and never records it
    let Routed::Answer(a) = host.route(&link, "main", &submit("hola", "req-f1e00001"), T0).unwrap() else { panic!() };
    agent(&link, false, "restarting");
    assert_eq!(last_turn(&host.project(&link.view(), T0 + 10))["error"]["code"], json!("interrupted"));
    agent(&link, false, "ready");
    page(&link, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "respuesta vieja")], false);
    host.project(&link.view(), T0 + 20);
    // turn B «otra», recorded
    host.route(&link, "main", &submit("otra", "req-f1e00002"), T0 + 30).unwrap();
    agent(&link, true, "ready");
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"r-otra"}));
    link.frame(json!({"type":"message_done","messageId":"m1"}));
    agent(&link, false, "ready");
    host.project(&link.view(), T0 + 40);
    page(&link, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "respuesta vieja"), ("s0-3", "user", "otra"), ("s0-4", "assistant", "r-otra")], false);
    host.project(&link.view(), T0 + 50);
    // turn C «hola» again, recorded this time
    let Routed::Answer(c) = host.route(&link, "main", &submit("hola", "req-f1e00003"), T0 + 60).unwrap() else { panic!() };
    agent(&link, true, "ready");
    link.frame(json!({"type":"message_delta","messageId":"m2","text":"r-hola"}));
    link.frame(json!({"type":"message_done","messageId":"m2"}));
    agent(&link, false, "ready");
    host.project(&link.view(), T0 + 70);
    page(
        &link,
        &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "respuesta vieja"), ("s0-3", "user", "otra"), ("s0-4", "assistant", "r-otra"), ("s0-5", "user", "hola"), ("s0-6", "assistant", "r-hola")],
        false,
    );
    let v = host.project(&link.view(), T0 + 80);
    let ts = turns(&v);
    let rows: Vec<(String, String, String, String)> = ts
        .iter()
        .map(|t| (t["turn_id"].as_str().unwrap().into(), t["user_text"].as_str().unwrap().into(), t["reply"].as_str().unwrap().into(), t["state"].as_str().unwrap().into()))
        .collect();
    assert_eq!(ts.len(), 4, "{v}");
    assert_eq!(rows[1].0, a["turn_id"].as_str().unwrap(), "the unrecorded turn keeps its place: {v}");
    assert_eq!((rows[1].1.as_str(), rows[1].2.as_str(), rows[1].3.as_str()), ("hola", "", "error"), "the unrecorded turn never takes the later record: {v}");
    assert_eq!(rows[3].0, c["turn_id"].as_str().unwrap(), "the recorded «hola» is the later turn's own: {v}");
    assert_eq!((rows[3].1.as_str(), rows[3].2.as_str(), rows[3].3.as_str()), ("hola", "r-hola", "completed"));
    assert_eq!((rows[2].1.as_str(), rows[2].2.as_str()), ("otra", "r-otra"));
}

#[test]
fn chathost_f6_an_old_cancelled_turn_keeps_its_state_after_hundreds_of_later_turns() {
    // a cancelled first turn, then 230 answered turns: every settled turn stays in the store
    let log: std::sync::Arc<Mutex<Vec<(String, String)>>> = Default::default();
    let held = log.clone();
    let mut link = FakeLink::answering(move |c| {
        let mut log = held.lock().unwrap();
        match c {
            ChatCommand::Send { text, .. } => {
                log.push(("user".into(), text.clone()));
                if text == "t0" {
                    // the first turn is cancelled before the engine answers
                    return vec![json!({"type":"agent_state","busy":true,"status":"ready","paused":false})];
                }
                log.push(("assistant".into(), format!("r-{text}")));
                let id = format!("m{}", log.len());
                vec![
                    json!({"type":"agent_state","busy":true,"status":"ready","paused":false}),
                    json!({"type":"message_delta","messageId":id,"text":format!("r-{text}")}),
                    json!({"type":"message_done","messageId":id}),
                    json!({"type":"agent_state","busy":false,"status":"ready","paused":false}),
                ]
            }
            ChatCommand::Abort => vec![json!({"type":"agent_state","busy":false,"status":"ready","paused":false})],
            ChatCommand::History | ChatCommand::Earlier { .. } => {
                let end = match c {
                    ChatCommand::Earlier { before } => before.strip_prefix("s0-").unwrap().parse::<usize>().unwrap() - 1,
                    _ => log.len(),
                };
                let from = end.saturating_sub(100);
                let messages: Vec<Value> = (from..end).map(|i| json!({"id": format!("s0-{}", i + 1), "role": log[i].0, "text": log[i].1})).collect();
                let kind = if matches!(c, ChatCommand::History) { "history" } else { "earlier" };
                let mut f = json!({"type":kind,"messages":messages,"hasEarlier":from > 0});
                if let ChatCommand::Earlier { before } = c {
                    f["before"] = json!(before);
                }
                vec![f]
            }
            _ => vec![],
        }
    });
    link.unlimited = true;
    let host = ChatHost::new();
    let mut now = T0;
    let Routed::Answer(first) = host.route(&link, "main", &submit("t0", "req-f6e00000"), now).unwrap() else { panic!() };
    now += 10;
    host.project(&link.view(), now);
    host.route(&link, "main", &Command::Cancel { turn_id: first["turn_id"].as_str().unwrap().into() }, now).unwrap();
    for k in 1..231 {
        now += 10;
        host.project(&link.view(), now);
        host.route(&link, "main", &submit(&format!("t{k}"), &format!("req-{k:08x}")), now).unwrap();
        now += 10;
        host.project(&link.view(), now);
    }
    now += 10;
    host.route(&link, "main", &Command::View, now).unwrap();
    let v = host.project(&link.view(), now);
    assert_eq!(last_turn(&v)["user_text"], json!("t230"));
    // page back to the first turn
    let mut cursor = v["history_before"].clone();
    let mut oldest = Value::Null;
    while let Some(n) = cursor.as_u64() {
        let cmd = Command::History { conversation_id: CHAT_CONVERSATION_ID.into(), before: Some(n) };
        let Routed::Answer(p) = host.route(&link, "main", &cmd, now).unwrap() else { panic!() };
        if let Some(t) = turns(&p).first() {
            oldest = t.clone();
        }
        cursor = p["before"].clone();
    }
    assert_eq!(oldest["user_text"], json!("t0"), "{oldest}");
    assert_eq!(oldest["turn_id"], first["turn_id"]);
    assert_eq!(oldest["state"], json!("cancelled"), "an old cancelled turn never turns «completed»: {oldest}");
}

#[test]
fn chathost_f1_a_message_another_client_recorded_first_never_blocks_the_islands_claim() {
    let link = FakeLink::new();
    let host = ChatHost::new();
    let Routed::Answer(a) = host.route(&link, "main", &submit("hola", "req-f1e00010"), T0).unwrap() else { panic!() };
    agent(&link, true, "ready");
    // before the island's turn reaches the record, another client's prompt lands in it
    page(&link, &[("s0-1", "user", "otro cliente"), ("s0-2", "assistant", "r-otro")], false);
    host.project(&link.view(), T0 + 10);
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"r-hola"}));
    link.frame(json!({"type":"message_done","messageId":"m1"}));
    agent(&link, false, "ready");
    host.project(&link.view(), T0 + 20);
    page(&link, &[("s0-1", "user", "otro cliente"), ("s0-2", "assistant", "r-otro"), ("s0-3", "user", "hola"), ("s0-4", "assistant", "r-hola")], false);
    let v = host.project(&link.view(), T0 + 30);
    let ts = turns(&v);
    // (the island turn's number was handed out at send time, so it sorts before the other
    // client's earlier-recorded prompt: pre-existing, out of this fix's scope)
    assert_eq!(ts.len(), 2, "no duplicate: {v}");
    let own = ts.iter().find(|t| t["turn_id"] == a["turn_id"]).expect("the island's turn is shown");
    assert_eq!((own["user_text"].clone(), own["reply"].clone(), own["state"].clone()), (json!("hola"), json!("r-hola"), json!("completed")), "the island's turn took its record over: {v}");
    assert!(ts.iter().any(|t| t["user_text"] == json!("otro cliente") && t["reply"] == json!("r-otro")));
}

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
    assert_eq!(after["turns"][0]["turn_id"], newest_id, "the turn already shown keeps its id after the earlier page");
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
    let reloads = link.sent().iter().filter(|c| **c == ChatCommand::History).count();
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
    assert_eq!(link.sent().iter().filter(|c| **c == ChatCommand::History).count(), reloads, "paging never reloads the newest page");
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
fn chathost_f3_earlier_pages_never_take_the_newest_turns_off_the_chat() {
    // Gentle Dot's model: an earlier page never enters the newest view, so no reload is needed
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
    assert_eq!(link.view()["messages"].as_array().unwrap().len(), 100, "the newest view still holds only the newest page");
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

fn two_passes(total: usize, no_reply: fn(usize) -> bool, page_size: fn(usize) -> usize, label: &str) {
    let (link, expected) = daemon_link(total, no_reply, page_size);
    let host = ChatHost::new();
    let first = Command::History { conversation_id: CHAT_CONVERSATION_ID.into(), before: None };
    host.route(&link, "main", &first, T0).unwrap();
    let mut ids = std::collections::HashMap::new();
    for pass in 1..=2 {
        let (shown, _) = walk_up(&host, &link, &expected, &mut ids, &format!("{label} pass {pass}"));
        assert!(shown.iter().all(|t| t["turn_id"].as_str().unwrap().len() <= 24), "{label}: chat.rs valid_turn_id");
    }
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

// ---- K2-05 T4 S2 paging redesign (Gentle Dot's model): the re-verifier's cases ------------------
//
// A fake daemon that follows `conversations.cjs` `pageHistory`: ids `s0-<i>` (1-based), a page is
// counted back from its end while it holds at most `max(end)` messages and at most 192 KiB (the
// first message is always taken), and `hasEarlier` says messages remain before it. The host
// under test is the real `ChatHost` over the real `ChatState` fold; every comparison is ORDER
// and CONTENT, never sorted.

const PAGE_BYTES: usize = 192 * 1024;

struct Record {
    log: Vec<(&'static str, String)>,
    max: fn(usize) -> usize,
}

impl Record {
    /// Turn `k` is the prompt `p<k>` and, unless `no_reply(k)`, the reply `r-p<k>`.
    fn turns(total: usize, no_reply: fn(usize) -> bool, max: fn(usize) -> usize) -> (Record, Vec<(String, String)>) {
        let mut log = vec![];
        let mut expected = vec![];
        for k in 0..total {
            log.push(("user", format!("p{k}")));
            let reply = if no_reply(k) { String::new() } else { format!("r-p{k}") };
            if !reply.is_empty() {
                log.push(("assistant", reply.clone()));
            }
            expected.push((format!("p{k}"), reply));
        }
        (Record { log, max }, expected)
    }

    fn message(&self, i: usize) -> Value {
        json!({"id": format!("s0-{}", i + 1), "role": self.log[i].0, "text": self.log[i].1})
    }

    /// The page ending right before message index `end` (0-based, exclusive).
    fn page(&self, end: usize) -> (Vec<Value>, bool) {
        let (mut from, mut bytes) = (end, 0usize);
        while from > 0 && end - from < (self.max)(end) {
            let size = serde_json::to_string(&self.message(from - 1)).unwrap().len();
            if from < end && bytes + size > PAGE_BYTES {
                break;
            }
            bytes += size;
            from -= 1;
        }
        ((from..end).map(|i| self.message(i)).collect(), from > 0)
    }

    fn history(&self) -> Value {
        let (messages, more) = self.page(self.log.len());
        json!({"type":"history","messages":messages,"hasEarlier":more})
    }

    fn earlier(&self, before: &str) -> Value {
        let k: usize = before.strip_prefix("s0-").and_then(|k| k.parse().ok()).unwrap_or(0);
        let (messages, more) = if k == 0 || k > self.log.len() { (vec![], false) } else { self.page(k - 1) };
        json!({"type":"earlier","before":before,"messages":messages,"hasEarlier":more})
    }
}

/// The fake daemon as a link. `after_earlier` frames are delivered right after every earlier
/// answer (a newest page landing in the middle of deep paging).
fn record_link(record: Record, after_earlier: bool, unlimited: bool) -> (std::sync::Arc<FakeLink>, std::sync::Arc<Mutex<Record>>) {
    let record = std::sync::Arc::new(Mutex::new(record));
    let held = record.clone();
    let mut link = FakeLink::answering(move |c| {
        let r = held.lock().unwrap();
        match c {
            ChatCommand::History => vec![r.history()],
            ChatCommand::Earlier { before } if after_earlier => vec![r.earlier(before), r.history()],
            ChatCommand::Earlier { before } => vec![r.earlier(before)],
            _ => vec![],
        }
    });
    link.unlimited = unlimited;
    (std::sync::Arc::new(link), record)
}

/// The page's walk from the newest window to the first turn: every answer is prepended,
/// its cursor passed back unchanged; an answer may hold no whole turn (a lone reply) as long
/// as its cursor moves. Returns the whole chat as the page would show it and the number of
/// page requests. After every answer the chat:state window is still the newest turns.
fn walk_up(host: &ChatHost, link: &FakeLink, expected: &[(String, String)], ids: &mut std::collections::HashMap<String, (String, String)>, label: &str) -> (Vec<Value>, usize) {
    let mut record = |ts: &[Value]| {
        for t in ts {
            let id = t["turn_id"].as_str().unwrap().to_owned();
            let content = (t["user_text"].as_str().unwrap().to_owned(), t["reply"].as_str().unwrap().to_owned());
            assert_eq!(*ids.entry(id.clone()).or_insert_with(|| content.clone()), content, "{label}: turn id {id} always names the same turn");
        }
    };
    let window = |v: &Value| {
        let ts = turns(v);
        assert_eq!(texts(&ts), expected[expected.len() - ts.len()..].to_vec(), "{label}: chat:state shows the newest turns, in order");
        ts
    };
    let v = host.project(&link.view(), T0);
    let mut shown = window(&v);
    record(&shown);
    let mut cursor = v["history_before"].clone();
    let mut requests = 0;
    while let Some(n) = cursor.as_u64() {
        requests += 1;
        assert!(requests <= 4 * expected.len(), "{label}: paging terminates");
        let cmd = Command::History { conversation_id: CHAT_CONVERSATION_ID.into(), before: Some(n) };
        let r = host.route(link, "main", &cmd, T0);
        let Ok(Routed::Answer(p)) = r else { panic!("{label}: page {requests} failed: {r:?}") };
        let ts = turns(&p);
        assert!(!ts.is_empty() || p["before"].as_u64().is_some_and(|b| b != n), "{label}: an answer with no whole turn still moves the cursor: {p}");
        record(&ts);
        let mut next = ts;
        next.extend(shown);
        shown = next;
        cursor = p["before"].clone();
        window(&host.project(&link.view(), T0));
    }
    assert_eq!(texts(&shown), expected.to_vec(), "{label}: every turn exactly once, in order, each with its own reply");
    (shown, requests)
}

fn first_window(host: &ChatHost, link: &FakeLink) {
    let cmd = Command::History { conversation_id: CHAT_CONVERSATION_ID.into(), before: None };
    host.route(link, "main", &cmd, T0).unwrap();
}

#[test]
fn paging_600_turns_with_48_message_and_uneven_pages_reaches_every_turn_twice() {
    for (label, max) in [("48/page", (|_| 48) as fn(usize) -> usize), ("uneven", budget_pages)] {
        for no_reply in [all_replied as fn(usize) -> bool, some_without_reply] {
            let (record, expected) = Record::turns(600, no_reply, max);
            let (link, _) = record_link(record, false, true);
            let host = ChatHost::new();
            first_window(&host, &link);
            let mut ids = std::collections::HashMap::new();
            walk_up(&host, &link, &expected, &mut ids, &format!("600 {label} pass 1"));
            // «Ir al final»: the page drops what it loaded and walks again from the window
            walk_up(&host, &link, &expected, &mut ids, &format!("600 {label} pass 2"));
        }
    }
}

#[test]
fn paging_after_a_reconnect_never_uses_an_earlier_page_that_arrives_before_the_newest() {
    let (record, expected) = Record::turns(600, some_without_reply, |_| 48);
    let (link, record) = record_link(record, false, true);
    let host = ChatHost::new();
    first_window(&host, &link);
    let v = host.project(&link.view(), T0);
    let mut shown = turns(&v);
    let mut cursor = v["history_before"].clone();
    // page up past turn 350 (of 600)
    while shown.len() < 250 {
        let cmd = Command::History { conversation_id: CHAT_CONVERSATION_ID.into(), before: Some(cursor.as_u64().unwrap()) };
        let Routed::Answer(p) = host.route(&*link, "main", &cmd, T0).unwrap() else { panic!() };
        let mut next = turns(&p);
        next.extend(shown);
        shown = next;
        cursor = p["before"].clone();
    }
    // the connection drops and comes back: a fresh chat view with no page yet; the newest page
    // (the connect's get_history) lands only after the page's next earlier request was answered
    {
        let mut st = ChatState::connected();
        st.apply(&json!({"type":"agent_state","busy":false,"status":"ready","paused":false}));
        *link.state.lock().unwrap() = st;
    }
    let late = {
        let (link, record) = (link.clone(), record.clone());
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let frame = record.lock().unwrap().history();
            link.frame(frame);
        })
    };
    let mut attempts = 0;
    while let Some(n) = cursor.as_u64() {
        attempts += 1;
        assert!(attempts < 400, "paging terminates");
        let cmd = Command::History { conversation_id: CHAT_CONVERSATION_ID.into(), before: Some(n) };
        match host.route(&*link, "main", &cmd, T0) {
            Ok(Routed::Answer(p)) => {
                let mut next = turns(&p);
                next.extend(shown);
                shown = next;
                cursor = p["before"].clone();
            }
            // a refused page (the newest one not there yet) is retried with the same cursor
            Err(e) => {
                assert_eq!(e.code, "history_unavailable", "{e:?}");
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Ok(other) => panic!("{other:?}"),
        }
    }
    late.join().unwrap();
    assert_eq!(texts(&shown), expected, "every turn once, in order, own reply, never renumbered across the reconnect");
    let ids: std::collections::HashSet<&str> = shown.iter().map(|t| t["turn_id"].as_str().unwrap()).collect();
    assert_eq!(ids.len(), shown.len(), "one id per turn");
    assert_eq!(texts(&turns(&host.project(&link.view(), T0))), expected[600 - turns(&host.project(&link.view(), T0)).len()..].to_vec());
}

#[test]
fn paging_a_newest_page_landing_between_a_lone_reply_and_its_prompt_keeps_the_reply() {
    // the older chat comes one message per page, so most earlier pages are a lone reply; a
    // newest page lands right after EVERY earlier answer (a settle refresh while paging)
    let (record, expected) = Record::turns(72, all_replied, |end| if end == 144 { 48 } else { 1 });
    let (link, _) = record_link(record, true, true);
    let host = ChatHost::new();
    first_window(&host, &link);
    let mut ids = std::collections::HashMap::new();
    let (shown, _) = walk_up(&host, &link, &expected, &mut ids, "lone replies under newest pages");
    assert!(shown.iter().all(|t| t["reply"].as_str().is_some_and(|r| !r.is_empty())), "no turn lost its reply");
}

#[test]
fn paging_a_newest_page_holding_only_a_lone_reply_keeps_the_history_reachable() {
    let big_prompt = "q".repeat(9 * 1024);
    let big_reply = "r".repeat(185 * 1024);
    let record = Record {
        log: vec![("user", "hola".into()), ("assistant", "buenas".into()), ("user", big_prompt.clone()), ("assistant", big_reply.clone())],
        max: |_| 100,
    };
    // the island shows a history text up to its own 64 Ki-unit ceiling (history_message_view)
    let expected = vec![("hola".to_owned(), "buenas".to_owned()), (big_prompt, big_reply[..MAX_TEXT_CHARS].to_owned())];
    let (link, _) = record_link(record, false, true);
    let host = ChatHost::new();
    first_window(&host, &link);
    assert_eq!(link.view()["messages"].as_array().unwrap().len(), 1, "the daemon's newest page is the lone reply");
    let v = host.project(&link.view(), T0);
    assert!(v["history_before"].as_u64().is_some(), "a page holding only a lone reply still offers the history: {}", v["history_before"]);
    let mut ids = std::collections::HashMap::new();
    walk_up(&host, &link, &expected, &mut ids, "lone newest reply");
}

#[test]
fn paging_another_clients_prompt_recorded_before_an_island_turn_keeps_the_records_order() {
    let link = FakeLink::new();
    page(&link, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "r-vieja")], false);
    let host = ChatHost::new();
    host.project(&link.view(), T0);
    let Routed::Answer(a) = host.route(&link, "main", &submit("hola", "req-a0000001"), T0).unwrap() else { panic!() };
    agent(&link, true, "ready");
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"r-hola"}));
    link.frame(json!({"type":"message_done","messageId":"m1"}));
    agent(&link, false, "ready");
    host.project(&link.view(), T0 + 10);
    // the record: another client's prompt landed BEFORE the island's
    page(
        &link,
        &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "r-vieja"), ("s0-3", "user", "otro cliente"), ("s0-4", "assistant", "r-otro"), ("s0-5", "user", "hola"), ("s0-6", "assistant", "r-hola")],
        false,
    );
    let ts = turns(&host.project(&link.view(), T0 + 20));
    assert_eq!(
        texts(&ts),
        vec![("vieja".into(), "r-vieja".into()), ("otro cliente".into(), "r-otro".into()), ("hola".into(), "r-hola".into())],
        "the record's order"
    );
    assert_eq!(ts[2]["turn_id"], a["turn_id"], "the island turn keeps its id when the record takes it over");
}

#[test]
fn paging_1500_turns_stays_within_the_islands_budget_and_a_send_still_goes_through() {
    let (record, expected) = Record::turns(1_500, some_without_reply, |_| 48);
    let (link, _) = record_link(record, false, false);
    let host = ChatHost::new();
    first_window(&host, &link);
    let mut ids = std::collections::HashMap::new();
    let (_, up) = walk_up(&host, &link, &expected, &mut ids, "1,500 turns");
    let reads = link.sent().iter().filter(|c| matches!(c, ChatCommand::History | ChatCommand::Earlier { .. })).count();
    println!("1,500 turns: {up} page requests, {reads} daemon reads");
    assert!(reads <= CHAT_FRAMES_PER_MINUTE as usize, "one daemon read per page at most: {reads}");
    // the way back down is the page's own scroll (everything it loaded stays): no request; then a send
    host.route(&*link, "main", &submit("al final", "req-b0000001"), T0 + 10).expect("a send is never refused because paging spent the budget");
    assert!(link.sent().iter().any(|c| matches!(c, ChatCommand::Send { .. })));
}

// ---- K2-05 T4 S2 paging follow-ups (verifier mwb2ywag-6-bm3h on ccbeab4: B1, B2, F6) -------------
//
// A fake daemon over a `Record` that also takes sends: the island's `send` (and another client's,
// through `foreign`) appends its prompt (and, unless cancelled, its reply) and streams the frames
// the daemon broadcasts. Comparisons are ORDER and CONTENT, never sorted.

struct Live {
    record: std::sync::Arc<Mutex<Record>>,
    link: std::sync::Arc<FakeLink>,
    /// The answers of `Read::Defer` reads, as the daemon read them (delivered later by the test).
    deferred: std::sync::Arc<Mutex<Vec<Value>>>,
}

/// How the fake daemon answers the k-th `get_history` (0-based).
#[derive(Clone, Copy, PartialEq, Debug)]
enum Read {
    Answer,
    /// The daemon refuses it (an `error` frame).
    Refuse,
    /// The daemon reads the record NOW but answers only when the test delivers it (late).
    Defer,
}

impl Live {
    /// `reply(text)`: the engine's reply to an island send (None = the island cancels it before
    /// any output; `record_cancelled` = the engine recorded the cancelled prompt anyway).
    fn new(log: Vec<(&'static str, String)>, reply: fn(&str) -> Option<String>, record_cancelled: bool) -> Live {
        Live::with_reads(log, reply, record_cancelled, |_| Read::Answer, true)
    }

    fn with_reads(log: Vec<(&'static str, String)>, reply: fn(&str) -> Option<String>, record_cancelled: bool, reads: fn(usize) -> Read, unlimited: bool) -> Live {
        let record = std::sync::Arc::new(Mutex::new(Record { log, max: |_| 100 }));
        let held = record.clone();
        let deferred: std::sync::Arc<Mutex<Vec<Value>>> = Default::default();
        let late = deferred.clone();
        let asked = std::sync::atomic::AtomicUsize::new(0);
        let mut link = FakeLink::answering(move |c| {
            let mut r = held.lock().unwrap();
            match c {
                ChatCommand::History => {
                    let k = asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    match reads(k) {
                        Read::Answer => vec![r.history()],
                        Read::Refuse => vec![json!({"type":"error","code": if k % 2 == 0 { "failed" } else { "rate_limited" }})],
                        Read::Defer => {
                            late.lock().unwrap().push(r.history());
                            vec![]
                        }
                    }
                }
                ChatCommand::Send { text, .. } => {
                    let busy = json!({"type":"agent_state","busy":true,"status":"ready","paused":false});
                    match reply(text) {
                        Some(answer) => {
                            r.log.push(("user", text.clone()));
                            r.log.push(("assistant", answer.clone()));
                            let id = format!("m{}", r.log.len());
                            vec![busy, json!({"type":"message_delta","messageId":id,"text":answer}), json!({"type":"message_done","messageId":id}), json!({"type":"agent_state","busy":false,"status":"ready","paused":false})]
                        }
                        None => {
                            if record_cancelled {
                                r.log.push(("user", text.clone()));
                            }
                            vec![busy]
                        }
                    }
                }
                ChatCommand::Abort => vec![json!({"type":"agent_state","busy":false,"status":"ready","paused":false})],
                ChatCommand::Earlier { before } => vec![r.earlier(before)],
                _ => vec![],
            }
        });
        link.unlimited = unlimited;
        Live { record, link: std::sync::Arc::new(link), deferred }
    }

    /// Deliver the late answers the daemon read earlier.
    fn deliver_late(&self) {
        let frames: Vec<Value> = std::mem::take(&mut *self.deferred.lock().unwrap());
        for f in frames {
            self.link.frame(f);
        }
    }

    /// The connection drops and comes back: a fresh chat view, then its newest page.
    fn reconnect(&self, host: &ChatHost, now: u64) {
        let mut st = ChatState::connected();
        st.apply(&json!({"type":"agent_state","busy":false,"status":"ready","paused":false}));
        *self.link.state.lock().unwrap() = st;
        host.project(&self.link.view(), now);
        first_window(host, &self.link);
    }

    /// Another client's whole turn: recorded by the daemon, broadcast to the island as busy,
    /// its reply's stream, quiet. `seen` = the island's reader projects after every frame
    /// (production: the reader callback), or only once at the end.
    fn foreign(&self, host: &ChatHost, prompt: &str, reply: &str, seen: bool, now: u64) {
        let id = {
            let mut r = self.record.lock().unwrap();
            r.log.push(("user", prompt.to_owned()));
            r.log.push(("assistant", reply.to_owned()));
            format!("x{}", r.log.len())
        };
        for f in [
            json!({"type":"agent_state","busy":true,"status":"ready","paused":false}),
            json!({"type":"message_delta","messageId":id,"text":reply}),
            json!({"type":"message_done","messageId":id}),
            json!({"type":"agent_state","busy":false,"status":"ready","paused":false}),
        ] {
            self.link.frame(f);
            if seen {
                self.publish(host, now);
            }
        }
    }

    /// The production reader callback's work: project the view, then the host's own refresh.
    fn publish(&self, host: &ChatHost, now: u64) -> Value {
        let v = host.project(&self.link.view(), now);
        host.route(&*self.link, "main", &Command::View, now).unwrap();
        v
    }

    /// The page's whole chat: the newest window, then every earlier page prepended (the page's
    /// `mergeHistory`: one run, the live window wins on a shared id, a repeated id shown once).
    fn whole_chat(&self, host: &ChatHost, now: u64) -> Vec<Value> {
        let v = host.project(&self.link.view(), now);
        let window = turns(&v);
        let mut older: Vec<Value> = vec![];
        let mut cursor = v["history_before"].clone();
        let mut guard = 0;
        while let Some(n) = cursor.as_u64() {
            guard += 1;
            assert!(guard < 100, "paging terminates");
            let cmd = Command::History { conversation_id: CHAT_CONVERSATION_ID.into(), before: Some(n) };
            let Routed::Answer(p) = host.route(&*self.link, "main", &cmd, now).unwrap() else { panic!() };
            let mut next = turns(&p);
            next.extend(older);
            older = next;
            cursor = p["before"].clone();
        }
        let ids: std::collections::HashSet<String> = window.iter().map(|t| t["turn_id"].as_str().unwrap().to_owned()).collect();
        let mut seen = std::collections::HashSet::new();
        let mut run: Vec<Value> = older.into_iter().filter(|t| {
            let id = t["turn_id"].as_str().unwrap().to_owned();
            !ids.contains(&id) && seen.insert(id)
        }).collect();
        run.extend(window);
        run
    }
}

fn shape(ts: &[Value]) -> Vec<(String, String, String)> {
    ts.iter().map(|t| (t["user_text"].as_str().unwrap_or("?").to_owned(), t["reply"].as_str().unwrap_or("?").to_owned(), t["state"].as_str().unwrap_or("?").to_owned())).collect()
}

#[test]
fn followups_b1_a_newest_page_holding_only_the_islands_own_reply_keeps_its_turn_with_one_reply() {
    // the verifier's case: prompt ~7,905 chars, reply ~63,004 chars of 3-byte text (≈189 KB):
    // the daemon's newest page (192 KiB) is the lone reply of the island's own turn
    let prompt = "€".repeat(7_905);
    let log = vec![("user", "hola".to_owned()), ("assistant", "buenas".to_owned())];
    let live = Live::new(log, |_| Some("€".repeat(63_004)), false);
    let reply = "€".repeat(63_004);
    let host = ChatHost::new();
    first_window(&host, &live.link);
    live.publish(&host, T0);
    let Routed::Answer(a) = host.route(&*live.link, "main", &submit(&prompt, "req-fb100001"), T0).unwrap() else { panic!() };
    live.publish(&host, T0 + 10);
    live.publish(&host, T0 + 20);
    let page = live.link.view()["messages"].as_array().unwrap().clone();
    assert_eq!(page.len(), 1, "the daemon's newest page is the lone reply");
    assert_eq!(page[0]["role"], json!("assistant"));
    let expected = vec![
        ("hola".to_owned(), "buenas".to_owned(), "completed".to_owned()),
        (prompt.clone(), reply.clone(), "completed".to_owned()),
    ];
    // the window still shows the island's own turn, once, with one copy of its reply
    let v = host.project(&live.link.view(), T0 + 30);
    let window = turns(&v);
    assert_eq!(shape(&window), expected[1..].to_vec(), "the island's own turn stays visible: {} turns", window.len());
    assert_eq!(window[0]["turn_id"], a["turn_id"]);
    assert!(v["history_before"].as_u64().is_some(), "the history stays reachable");
    // paging up: every turn once, the reply attached once to the right turn
    let run = live.whole_chat(&host, T0 + 40);
    assert_eq!(shape(&run), expected, "paging up: one copy of the reply, under its own prompt");
    // the next pushes (the turn settles into the record) and a page reload walk again
    for k in 0..2 {
        live.publish(&host, T0 + 50 + k);
        let run = live.whole_chat(&host, T0 + 60 + k);
        assert_eq!(shape(&run), expected, "walk {k} after the record took the turn over");
        assert!(run.iter().any(|t| t["turn_id"] == a["turn_id"]), "the island's turn keeps its id");
    }
}

/// B2: another client's turn lands in the record first; then the island sends and cancels.
fn b2_case(foreign_text: &str, island_text: &str, seen: bool, recorded: bool) {
    let label = format!("foreign «{foreign_text}», island «{island_text}», reader saw it: {seen}, cancelled prompt recorded: {recorded}");
    let log = vec![("user", "vieja".to_owned()), ("assistant", "r-vieja".to_owned())];
    let live = Live::new(log, |_| None, recorded);
    let host = ChatHost::new();
    first_window(&host, &live.link);
    live.publish(&host, T0);
    live.foreign(&host, foreign_text, "r-otro", seen, T0 + 10);
    let Routed::Answer(a) = host.route(&*live.link, "main", &submit(island_text, "req-fb200001"), T0 + 20).unwrap() else { panic!("{label}") };
    let v = live.publish(&host, T0 + 30);
    let active = v["active_turn"].as_str().unwrap_or_else(|| panic!("{label}: the island's turn runs: {v}")).to_owned();
    assert_eq!(active, a["turn_id"].as_str().unwrap());
    host.route(&*live.link, "main", &Command::Cancel { turn_id: active }, T0 + 40).unwrap();
    let expected = vec![
        ("vieja".to_owned(), "r-vieja".to_owned(), "completed".to_owned()),
        (foreign_text.to_owned(), "r-otro".to_owned(), "completed".to_owned()),
        (island_text.to_owned(), String::new(), "cancelled".to_owned()),
    ];
    for k in 0..3 {
        live.publish(&host, T0 + 50 + k);
        let ts = turns(&host.project(&live.link.view(), T0 + 60 + k));
        assert_eq!(shape(&ts), expected, "{label}: pass {k}: the record's order, «Cancelado» under the island's own turn");
        assert_eq!(ts[2]["turn_id"], a["turn_id"], "{label}: the island's turn keeps its id");
        assert_ne!(ts[1]["turn_id"], a["turn_id"], "{label}: the other client's prompt never takes the island's turn");
    }
    // a page reload: the whole chat walked again from the window
    assert_eq!(shape(&live.whole_chat(&host, T0 + 100)), expected, "{label}: after a page reload");
}

#[test]
fn followups_b2_another_clients_identical_prompt_recorded_first_never_takes_the_islands_turn() {
    for seen in [true, false] {
        for recorded in [true, false] {
            b2_case("hola", "hola", seen, recorded);
        }
    }
}

#[test]
fn followups_b2_another_clients_different_prompt_recorded_first_keeps_the_records_order() {
    for seen in [true, false] {
        for recorded in [true, false] {
            b2_case("otra cosa", "hola", seen, recorded);
        }
    }
}

#[test]
fn followups_f6_another_clients_reply_never_joins_the_islands_newest_turn() {
    let log = vec![("user", "vieja".to_owned()), ("assistant", "r-vieja".to_owned())];
    let live = Live::new(log, |t| Some(format!("r-{t}")), false);
    let host = ChatHost::new();
    first_window(&host, &live.link);
    live.publish(&host, T0);
    host.route(&*live.link, "main", &submit("hola", "req-f6f00001"), T0).unwrap();
    live.publish(&host, T0 + 10);
    for refreshed in [false, true] {
        // the island's own turn settled; its record may or may not have landed yet
        if refreshed {
            live.publish(&host, T0 + 20);
        }
        let label = format!("own record landed: {refreshed}");
        let (other, theirs) = (format!("de otro {refreshed}"), format!("r-otro {refreshed}"));
        // another client's turn streams: never under the island's turn
        let id = {
            let mut r = live.record.lock().unwrap();
            r.log.push(("user", other.clone()));
            r.log.push(("assistant", theirs.clone()));
            format!("x{}", r.log.len())
        };
        live.link.frame(json!({"type":"agent_state","busy":true,"status":"ready","paused":false}));
        live.link.frame(json!({"type":"message_delta","messageId":id,"text":theirs}));
        let ts = turns(&host.project(&live.link.view(), T0 + 30));
        assert!(ts.iter().all(|t| !t["reply"].as_str().unwrap().contains(theirs.as_str())), "{label}: streaming: {:?}", shape(&ts));
        live.link.frame(json!({"type":"message_done","messageId":id}));
        let ts = turns(&host.project(&live.link.view(), T0 + 40));
        assert!(ts.iter().all(|t| !t["reply"].as_str().unwrap().contains(theirs.as_str())), "{label}: landed: {:?}", shape(&ts));
        assert_eq!(ts.iter().find(|t| t["user_text"] == json!("hola")).map(|t| t["reply"].clone()), Some(json!("r-hola")), "{label}");
        live.link.frame(json!({"type":"agent_state","busy":false,"status":"ready","paused":false}));
        // the record arrives (the island asks for it once the engine is quiet): the other client's turn shows
        live.publish(&host, T0 + 50);
        let ts = turns(&live.publish(&host, T0 + 60));
        let tail: Vec<_> = shape(&ts).into_iter().rev().skip_while(|t| t.0 != other).collect::<Vec<_>>().into_iter().rev().collect();
        let tail = tail[tail.len() - 2..].to_vec();
        assert_eq!(
            tail,
            vec![("hola".to_owned(), "r-hola".to_owned(), "completed".to_owned()), (other.clone(), theirs.clone(), "completed".to_owned())],
            "{label}: the record's order once it arrives"
        );
        if !refreshed {
            // second round: the island's turn, then another foreign turn after the record landed
            host.route(&*live.link, "main", &submit("hola", "req-f6f00002"), T0 + 70).unwrap();
            live.publish(&host, T0 + 80);
        }
    }
}

#[test]
fn followups_b2_a_newest_page_read_while_another_turn_runs_never_sets_the_claim_floor() {
    let log = vec![("user", "vieja".to_owned()), ("assistant", "r-vieja".to_owned())];
    let live = Live::new(log, |_| None, true);
    let host = ChatHost::new();
    first_window(&host, &live.link);
    live.publish(&host, T0);
    // another client's turn starts; the island reads the newest page before that prompt is recorded
    live.link.frame(json!({"type":"agent_state","busy":true,"status":"ready","paused":false}));
    first_window(&host, &live.link);
    live.publish(&host, T0 + 5);
    {
        let mut r = live.record.lock().unwrap();
        r.log.push(("user", "hola".to_owned()));
        r.log.push(("assistant", "r-otro".to_owned()));
    }
    live.link.frame(json!({"type":"message_delta","messageId":"x1","text":"r-otro"}));
    live.link.frame(json!({"type":"message_done","messageId":"x1"}));
    live.link.frame(json!({"type":"agent_state","busy":false,"status":"ready","paused":false}));
    live.publish(&host, T0 + 10);
    let Routed::Answer(a) = host.route(&*live.link, "main", &submit("hola", "req-fb2r0001"), T0 + 20).unwrap() else { panic!() };
    let v = live.publish(&host, T0 + 30);
    host.route(&*live.link, "main", &Command::Cancel { turn_id: v["active_turn"].as_str().unwrap().into() }, T0 + 40).unwrap();
    for k in 0..3 {
        live.publish(&host, T0 + 50 + k);
    }
    let ts = turns(&host.project(&live.link.view(), T0 + 60));
    assert_eq!(
        shape(&ts),
        vec![
            ("vieja".to_owned(), "r-vieja".to_owned(), "completed".to_owned()),
            ("hola".to_owned(), "r-otro".to_owned(), "completed".to_owned()),
            ("hola".to_owned(), String::new(), "cancelled".to_owned()),
        ]
    );
    assert_eq!(ts[2]["turn_id"], a["turn_id"]);
}

// ---- K2-05 T4 S2 re-verify follow-ups (mwb5m1ps-8-5ta4): B2 residual, N1, empty first message ----

/// How the island's reads go wrong around the other client's identical turn.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Trouble {
    /// The island's own read budget is spent (100 status reads in the window).
    BudgetSpent,
    /// The daemon refuses the settle refresh and the pre-send read.
    RefusedTwice,
    /// Both reads are answered only after the island's send (past the 3 s pre-send wait).
    Late,
}

/// B2 residual: another client's «hola» is recorded first; the island's reads of it are refused
/// or late; the island sends «hola» too (cancelled, or completed). The island's turn must never
/// take the other client's prompt — also after the budget window resets and after a reconnect.
fn b2_residual(trouble: Trouble, completed: bool, recorded: bool) {
    let label = format!("{trouble:?}, completed: {completed}, cancelled prompt recorded: {recorded}");
    let log = vec![("user", "vieja".to_owned()), ("assistant", "r-vieja".to_owned())];
    let reply: fn(&str) -> Option<String> = if completed { |_| Some("r-isla".to_owned()) } else { |_| None };
    let reads: fn(usize) -> Read = match trouble {
        Trouble::BudgetSpent => |_| Read::Answer,
        Trouble::RefusedTwice => |k| if k == 1 || k == 2 { Read::Refuse } else { Read::Answer },
        Trouble::Late => |k| if k == 1 || k == 2 { Read::Defer } else { Read::Answer },
    };
    let live = Live::with_reads(log, reply, recorded, reads, trouble != Trouble::BudgetSpent);
    let host = ChatHost::new();
    first_window(&host, &live.link);
    live.publish(&host, T0);
    if trouble == Trouble::BudgetSpent {
        while live.link.command("main", &json!({"action":"chat_status"})).is_ok() {}
    }
    live.foreign(&host, "hola", "r-otro", true, T0 + 10);
    let Routed::Answer(a) = host.route(&*live.link, "main", &submit("hola", "req-b2r00001"), T0 + 20).unwrap() else { panic!("{label}") };
    if trouble == Trouble::Late {
        live.deliver_late();
    }
    // (the settle grace counts from the real send, after up to 3 s of pre-send wait)
    let t1 = T0 + 20 + 10_000;
    let v = live.publish(&host, t1);
    if !completed {
        let active = v["active_turn"].as_str().unwrap_or_else(|| panic!("{label}: the island's turn runs: {v}")).to_owned();
        assert_eq!(active, a["turn_id"].as_str().unwrap(), "{label}");
        host.route(&*live.link, "main", &Command::Cancel { turn_id: active }, t1 + 10).unwrap();
    }
    let (reply, state) = if completed { ("r-isla", "completed") } else { ("", "cancelled") };
    let expected = vec![
        ("vieja".to_owned(), "r-vieja".to_owned(), "completed".to_owned()),
        ("hola".to_owned(), "r-otro".to_owned(), "completed".to_owned()),
        ("hola".to_owned(), reply.to_owned(), state.to_owned()),
    ];
    let check = |when: &str, now: u64| {
        for k in 0..3 {
            live.publish(&host, now + k);
        }
        let ts = turns(&host.project(&live.link.view(), now + 5));
        assert_eq!(shape(&ts), expected, "{label}, {when}: the record's order, the island's end under its own turn");
        assert_eq!(ts[2]["turn_id"], a["turn_id"], "{label}, {when}: the island's turn keeps its id");
        assert_ne!(ts[1]["turn_id"], a["turn_id"], "{label}, {when}: the other client's prompt never takes the island's turn");
        assert_eq!(shape(&live.whole_chat(&host, now + 6)), expected, "{label}, {when}: a page reload walks the same chat");
    };
    check("right after", t1 + 20);
    // the island's read budget window resets: the record is read again
    live.link.state.lock().unwrap().rate_window.set(None);
    check("after the budget window reset", t1 + 100);
    // the connection drops and comes back (a new connection, its own newest page)
    live.reconnect(&host, t1 + 150);
    check("after a reconnect", t1 + 200);
}

#[test]
fn followups_b2_residual_a_spent_read_budget_never_lets_the_island_claim_the_other_clients_prompt() {
    for completed in [false, true] {
        for recorded in [true, false] {
            b2_residual(Trouble::BudgetSpent, completed, recorded);
        }
    }
}

#[test]
fn followups_b2_residual_refused_reads_never_let_the_island_claim_the_other_clients_prompt() {
    for completed in [false, true] {
        for recorded in [true, false] {
            b2_residual(Trouble::RefusedTwice, completed, recorded);
        }
    }
}

#[test]
fn followups_b2_residual_late_reads_never_let_the_island_claim_the_other_clients_prompt() {
    for completed in [false, true] {
        b2_residual(Trouble::Late, completed, true);
    }
}

#[test]
fn followups_b2_residual_the_pre_send_read_is_never_refused_by_the_islands_read_budget() {
    let log = vec![("user", "vieja".to_owned()), ("assistant", "r-vieja".to_owned())];
    let live = Live::with_reads(log, |_| Some("r-isla".to_owned()), false, |_| Read::Answer, false);
    let host = ChatHost::new();
    first_window(&host, &live.link);
    while live.link.command("main", &json!({"action":"chat_status"})).is_ok() {}
    live.foreign(&host, "otra", "r-otro", true, T0);
    let reads = live.link.sent().iter().filter(|c| **c == ChatCommand::History).count();
    host.route(&*live.link, "main", &submit("hola", "req-b2r00002"), T0 + 10).unwrap();
    let sent = live.link.sent();
    assert_eq!(sent.iter().filter(|c| **c == ChatCommand::History).count(), reads + 1, "the pre-send read went out: {sent:?}");
    assert!(matches!(sent.last(), Some(ChatCommand::Send { .. })), "and the send after it: {sent:?}");
}

/// N1: a link whose newest-page read answers only after `delay_ms`, and whose send has no
/// optimistic busy yet (the engine's frames come later, from the test).
fn slow_read_link(delay_ms: u64) -> std::sync::Arc<FakeLink> {
    let record = std::sync::Arc::new(Mutex::new(Record { log: vec![("user", "vieja".to_owned()), ("assistant", "r-vieja".to_owned())], max: |_| 100 }));
    let held = record.clone();
    let slow: std::sync::Arc<Mutex<Option<std::sync::Weak<FakeLink>>>> = Default::default();
    let weak = slow.clone();
    let asked = std::sync::atomic::AtomicUsize::new(0);
    let link = std::sync::Arc::new(FakeLink::answering(move |c| match c {
        ChatCommand::History if asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 => vec![held.lock().unwrap().history()],
        ChatCommand::History => {
            let frame = held.lock().unwrap().history();
            let link = weak.lock().unwrap().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                if let Some(link) = link.and_then(|l| l.upgrade()) {
                    link.frame(frame);
                }
            });
            vec![]
        }
        _ => vec![],
    }));
    *slow.lock().unwrap() = Some(std::sync::Arc::downgrade(&link));
    link
}

fn wall() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

/// The page's view of the island's turn while a submit is routed: what every keeper tick shows.
fn submit_watching(host: &std::sync::Arc<ChatHost>, link: &std::sync::Arc<FakeLink>, id: &str) -> (Value, Vec<(u64, Value, Value, bool)>) {
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watcher = {
        let (host, link, done) = (host.clone(), link.clone(), done.clone());
        std::thread::spawn(move || {
            let start = wall();
            let mut seen = vec![];
            while !done.load(std::sync::atomic::Ordering::SeqCst) {
                let live = host.has_live();
                let v = host.project(&link.view(), wall());
                seen.push((wall() - start, v["active_turn"].clone(), last_turn(&v), live));
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            seen
        })
    };
    let Routed::Answer(a) = host.route(&**link, "main", &submit("hola", id), wall()).unwrap() else { panic!() };
    done.store(true, std::sync::atomic::Ordering::SeqCst);
    (a, watcher.join().unwrap())
}

#[test]
fn followups_n1_a_slow_pre_send_read_shows_the_turn_as_thinking_and_never_completes_it_early() {
    let link = slow_read_link(2_000);
    let host = std::sync::Arc::new(ChatHost::new());
    first_window(&host, &link);
    host.project(&link.view(), wall());
    // another client's turn ran: the island reads the record before its send (2 s)
    agent(&link, true, "ready");
    agent(&link, false, "ready");
    let started = std::time::Instant::now();
    let (a, seen) = submit_watching(&host, &link, "req-n1000001");
    let sent_at = wall();
    assert!(started.elapsed() >= std::time::Duration::from_millis(1_900), "the pre-send read took 2 s: {:?}", started.elapsed());
    assert!(matches!(link.sent().last(), Some(ChatCommand::Send { .. })), "the send went out after the read");
    // while the read waited the page already showed the turn: thinking, cancellable
    let waiting: Vec<_> = seen.iter().filter(|(ms, _, _, _)| *ms >= 300 && *ms <= 1_800).collect();
    assert!(!waiting.is_empty());
    for (ms, active, turn, live) in waiting {
        assert!(*live, "at {ms} ms the keeper re-publishes (the turn is live before any projection)");
        assert_eq!(*active, a["turn_id"], "at {ms} ms the turn is the active one (cancel available): {turn}");
        assert_eq!((turn["user_text"].clone(), turn["state"].clone()), (json!("hola"), json!("thinking")), "at {ms} ms: {turn}");
    }
    // right after the send (no busy frame yet), and inside the grace measured from the send
    for after in [0, 1_000, PENDING_SETTLE_MS - 100] {
        let v = host.project(&link.view(), sent_at + after);
        assert_eq!(last_turn(&v)["state"], json!("thinking"), "{after} ms after the send: {v}");
        assert_eq!(v["active_turn"], a["turn_id"]);
    }
    // the engine's reply streams into the island's own turn
    agent(&link, true, "ready");
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"buenas"}));
    assert_eq!(last_turn(&host.project(&link.view(), wall()))["state"], json!("streaming"));
    link.frame(json!({"type":"message_done","messageId":"m1"}));
    agent(&link, false, "ready");
    let t = last_turn(&host.project(&link.view(), wall()));
    assert_eq!((t["turn_id"].clone(), t["reply"].clone(), t["state"].clone()), (a["turn_id"].clone(), json!("buenas"), json!("completed")));
}

#[test]
fn followups_n1_a_turn_cancelled_while_its_pre_send_read_waits_never_reaches_the_engine() {
    let link = slow_read_link(1_000);
    let host = std::sync::Arc::new(ChatHost::new());
    first_window(&host, &link);
    host.project(&link.view(), wall());
    agent(&link, true, "ready");
    agent(&link, false, "ready");
    let canceller = {
        let (host, link) = (host.clone(), link.clone());
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            let v = host.project(&link.view(), wall());
            let id = v["active_turn"].as_str().map(str::to_owned).unwrap_or_else(|| panic!("the turn is active while it waits: {v}"));
            host.route(&*link, "main", &Command::Cancel { turn_id: id }, wall()).unwrap()
        })
    };
    let Routed::Answer(a) = host.route(&*link, "main", &submit("hola", "req-n1000002"), wall()).unwrap() else { panic!() };
    assert_eq!(canceller.join().unwrap(), Routed::Answer(json!({"cancelled": true})));
    assert!(!link.sent().iter().any(|c| matches!(c, ChatCommand::Send { .. } | ChatCommand::Abort)), "nothing reached the engine: {:?}", link.sent());
    let v = host.project(&link.view(), wall() + 5_000);
    let t = last_turn(&v);
    assert_eq!((t["turn_id"].clone(), t["state"].clone()), (a["turn_id"].clone(), json!("cancelled")));
    assert_eq!(v["active_turn"], json!(null));
    host.route(&*link, "main", &submit("otra", "req-n1000003"), wall() + 5_010).expect("the next send goes through");
}

#[test]
fn followups_an_island_reply_whose_first_message_is_empty_has_no_leading_blank_paragraph() {
    let log = vec![("user", "vieja".to_owned()), ("assistant", "r-vieja".to_owned())];
    let live = Live::new(log, |_| None, false);
    let host = ChatHost::new();
    first_window(&host, &live.link);
    live.publish(&host, T0);
    let Routed::Answer(a) = host.route(&*live.link, "main", &submit("buscá", "req-e0000001"), T0 + 10).unwrap() else { panic!() };
    // a tool call with no text: the first message lands empty, then the text
    live.link.frame(json!({"type":"message_done","messageId":"m1"}));
    live.link.frame(json!({"type":"message_delta","messageId":"m2","text":"encontré esto"}));
    let t = last_turn(&host.project(&live.link.view(), T0 + 20));
    assert_eq!((t["reply"].clone(), t["state"].clone()), (json!("encontré esto"), json!("streaming")), "{t}");
    live.link.frame(json!({"type":"message_done","messageId":"m2"}));
    live.link.frame(json!({"type":"agent_state","busy":false,"status":"ready","paused":false}));
    let t = last_turn(&host.project(&live.link.view(), T0 + 30));
    assert_eq!((t["reply"].clone(), t["state"].clone()), (json!("encontré esto"), json!("completed")), "{t}");
    // the record carries the turn (the daemon joins only non-empty texts): one copy, same text
    {
        let mut r = live.record.lock().unwrap();
        r.log.push(("user", "buscá".to_owned()));
        r.log.push(("assistant", "encontré esto".to_owned()));
    }
    for k in 0..3 {
        live.publish(&host, T0 + 40 + k);
    }
    let ts = turns(&host.project(&live.link.view(), T0 + 50));
    assert_eq!(
        shape(&ts),
        vec![("vieja".to_owned(), "r-vieja".to_owned(), "completed".to_owned()), ("buscá".to_owned(), "encontré esto".to_owned(), "completed".to_owned())]
    );
    assert_eq!(ts[1]["turn_id"], a["turn_id"]);
}

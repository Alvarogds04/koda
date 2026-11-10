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
}

impl FakeLink {
    fn new() -> FakeLink {
        FakeLink::answering(|_| vec![])
    }
    fn answering(answer: impl Fn(&ChatCommand) -> Vec<Value> + Send + Sync + 'static) -> FakeLink {
        let mut st = ChatState::connected();
        st.apply(&json!({"type":"agent_state","busy":false,"status":"ready","paused":false}));
        FakeLink { state: Mutex::new(st), sent: Mutex::new(vec![]), answer: Box::new(answer) }
    }
    fn offline() -> FakeLink {
        FakeLink { state: Mutex::new(ChatState::disconnected(crate::agentclient::Reason::NoDaemon)), sent: Mutex::new(vec![]), answer: Box::new(|_| vec![]) }
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
        serde_json::to_value(&*self.state.lock().unwrap()).unwrap()
    }
    fn command(&self, caller: &str, payload: &Value) -> Result<Value, CommandError> {
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

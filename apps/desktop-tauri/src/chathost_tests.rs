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

/// K2-05 bind by id: the daemon announces the prompt the engine recorded for the island's last send
/// (`user_message` with that send's own `requestId`, as server.cjs onUserMessage does).
fn own_record(link: &FakeLink, record_id: &str) {
    let sent = link.sent();
    let send = sent.iter().rev().find(|c| matches!(c, ChatCommand::Send { .. })).expect("a send went out");
    let ChatCommand::Send { text, .. } = send else { unreachable!() };
    let request_id = wire_request_id(send).expect("every send carries its requestId");
    link.frame(json!({"type":"user_message","messageId":record_id,"text":text,"requestId":request_id}));
}

// ---- each verb → the right ChatCommand or refusal ------------------------------------------

#[test]
fn chathost_submit_sends_one_chat_send_with_the_validated_text() {
    let link = FakeLink::new();
    let host = ChatHost::new();
    let r = host.route(&link, "main", &submit("hola\r\nKoda", "req-00000001"), T0).unwrap();
    let sent = link.sent();
    assert!(
        matches!(sent.as_slice(), [ChatCommand::Send { text, client_request_id, .. }] if text == "hola\nKoda" && client_request_id == "req-00000001"),
        "the page text is validated and normalized by chat.rs before it leaves: {sent:?}"
    );
    assert!(wire_request_id(&sent[0]).is_some_and(|r| r != "req-00000001"), "a fresh wire requestId, never the page's own id");
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
fn chathost_attachments_an_id_off_the_daemons_grammar_never_reaches_the_wire() {
    let link = FakeLink::new();
    let host = ChatHost::new();
    let cmd = Command::Submit { text: "mirá".into(), client_request_id: "req-00000002".into(), attachments: vec!["a1b2c3".into()] };
    let e = host.route(&link, "main", &cmd, T0).unwrap_err();
    assert_eq!(e.code, "send_refused");
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

const CONVERSATION_KEYS: [&str; 15] = [
    "active_turn", "answered_asks", "asks", "availability", "conversation_id", "conversation_specialist", "evicted", "history_before",
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
fn chathost_a_starting_or_restarting_engine_is_a_wait_said_in_spanish_never_a_downed_model() {
    // K2-05 boot order = Gentle Dot ChatSurface statusText: «Starting the assistant…» /
    // «The assistant is restarting…» while the daemon already answers.
    let host = ChatHost::new();
    let link = FakeLink::new();
    for (status, state, message) in [
        ("starting", "starting", "Koda está arrancando… abriendo tu conversación."),
        ("restarting", "restarting", "Koda se está reiniciando… abriendo tu conversación."),
    ] {
        link.frame(json!({"type":"agent_state","busy":false,"status":status,"paused":false}));
        let v = host.project(&link.view(), T0);
        assert_eq!(v["availability"], json!({"state": state, "message": message}), "{status}");
    }
    link.frame(json!({"type":"agent_state","busy":false,"status":"stopped","paused":false}));
    assert_eq!(host.project(&link.view(), T0)["availability"]["state"], json!("unavailable"), "a stopped engine is still down");
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
        (json!({"type":"agent_state","busy":false,"status":"starting","paused":false}), "connected", "starting"),
        (json!({"type":"agent_state","busy":false,"status":"restarting","paused":false}), "unavailable", "restarting"),
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
    assert_eq!(v["availability"]["state"], json!("starting"), "Gentle Dot's store starts at agentState starting");
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
    own_record(&link, "s0-3");
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
    own_record(&link, "s0-1");
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
    own_record(&link, "s0-1");
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
    own_record(&link, "s0-3");
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
    own_record(&link, "s0-1");
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
    own_record(&link, "s0-1");
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
                let record = format!("s0-{}", log.len() - 1);
                log.push(("assistant".into(), format!("r-{text}")));
                let id = format!("m{}", log.len());
                vec![
                    json!({"type":"agent_state","busy":true,"status":"ready","paused":false}),
                    json!({"type":"user_message","messageId":record,"text":text,"requestId":wire_request_id(c)}),
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
fn chathost_f8_chat_attach_and_chat_attach_data_forward_to_the_daemon_and_write_nothing() {
    // K2-05 attachments: both commands keep their gates, then hand the bytes to the DAEMON
    // (`ChatHost::upload`); the island never writes an upload itself
    let src = include_str!("chathost.rs");
    for sig in ["pub async fn chat_attach(", "pub async fn chat_attach_data("] {
        let body = fn_body(src, sig);
        assert!(body.contains("upload_to_daemon("), "{sig} forwards to the daemon");
        for gone in ["store_attachment", "uploads::attach", "attachments_dir", "fs::write", "File::create"] {
            assert!(!body.contains(gone), "{sig} still reaches {gone}");
        }
        let gate = body.find("main_window_only(webview.label())").expect("the island gate stays");
        assert!(gate < body.find("upload_to_daemon(").unwrap());
    }
    assert!(fn_body(src, "async fn upload_to_daemon(").contains(".upload(&*route.conn"), "through the chat connection only");
    // a dropped path is read only when the OS reported it dropped on the island (one-shot)
    let attach = fn_body(src, "pub async fn chat_attach(");
    assert!(attach.find("NATIVE_DROPS").unwrap() < attach.find("read_picked_path(").unwrap());
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
    let rid = wire_request_id(link.sent().last().unwrap()).unwrap();
    for f in [
        json!({"type":"agent_state","busy":true,"status":"ready","paused":false}),
        json!({"type":"user_message","messageId":"s0-1","text":"hola","requestId":rid}),
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

// K2-05 boot follow-up F3 (deviation from Gentle Dot, reason «empty chat after a long boot»): Gentle
// Dot's UI asks for history only on connect (client.ts:72) and its daemon broadcasts models, not
// history, on ready (bridge.ts:1176-1186), so a boot longer than the 60 s history wait leaves the
// chat empty there too. The island asks for the newest page again when the engine goes not-ready → ready.
#[test]
fn chathost_f3_the_engine_becoming_ready_after_a_long_boot_rereads_the_newest_page_once() {
    let feed = ChatFeed::new(|_| {});
    let link: std::sync::Arc<FakeLink> = std::sync::Arc::new(FakeLink::new());
    let dyn_link: std::sync::Arc<dyn ChatLink + Send + Sync> = link.clone();
    feed.bind(std::sync::Arc::downgrade(&dyn_link));
    let callback = ChatFeed::reader_callback(&feed);
    // connected while the engine starts; the held read gave up (the daemon's 60 s wait)
    agent(&link, false, "starting");
    callback(link.view());
    link.frame(json!({"type":"error","code":"unavailable"}));
    callback(link.view());
    assert!(!link.sent().contains(&ChatCommand::History), "nothing to re-read while the engine still starts");
    agent(&link, false, "ready");
    callback(link.view());
    assert_eq!(link.sent().iter().filter(|c| **c == ChatCommand::History).count(), 1, "ready re-reads the newest page: {:?}", link.sent());
    // ready → ready (busy/idle changes) never re-reads
    agent(&link, true, "ready");
    callback(link.view());
    agent(&link, false, "ready");
    callback(link.view());
    page(&link, &[("s0-1", "user", "hola"), ("s0-2", "assistant", "buenas")], false);
    callback(link.view());
    assert_eq!(link.sent().iter().filter(|c| **c == ChatCommand::History).count(), 1, "{:?}", link.sent());
    // an engine restart that comes back ready re-reads once more
    agent(&link, false, "restarting");
    callback(link.view());
    agent(&link, false, "ready");
    callback(link.view());
    assert_eq!(link.sent().iter().filter(|c| **c == ChatCommand::History).count(), 2, "{:?}", link.sent());
}

#[test]
fn chathost_f3_a_connection_that_starts_ready_never_rereads_on_its_own() {
    let feed = ChatFeed::new(|_| {});
    let link: std::sync::Arc<FakeLink> = std::sync::Arc::new(FakeLink::new());
    let dyn_link: std::sync::Arc<dyn ChatLink + Send + Sync> = link.clone();
    feed.bind(std::sync::Arc::downgrade(&dyn_link));
    let callback = ChatFeed::reader_callback(&feed);
    // a lost connection, then a new one whose engine is already ready: the connection's own
    // get_history (agentconn.rs connect) covers it, the transition rule adds nothing
    callback(serde_json::to_value(ChatState::disconnected(crate::agentclient::Reason::Lost)).unwrap());
    callback(link.view());
    agent(&link, false, "ready");
    callback(link.view());
    assert!(!link.sent().contains(&ChatCommand::History), "{:?}", link.sent());
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
    own_record(&link, "s0-3");
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"r-otra"}));
    link.frame(json!({"type":"message_done","messageId":"m1"}));
    agent(&link, false, "ready");
    host.project(&link.view(), T0 + 40);
    page(&link, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "respuesta vieja"), ("s0-3", "user", "otra"), ("s0-4", "assistant", "r-otra")], false);
    host.project(&link.view(), T0 + 50);
    // turn C «hola» again, recorded this time
    let Routed::Answer(c) = host.route(&link, "main", &submit("hola", "req-f1e00003"), T0 + 60).unwrap() else { panic!() };
    agent(&link, true, "ready");
    own_record(&link, "s0-5");
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
                let recorded = json!({"type":"user_message","messageId":format!("s0-{}", log.len()),"text":text,"requestId":wire_request_id(c)});
                if text == "t0" {
                    // the first turn is cancelled before the engine answers (its prompt is recorded)
                    return vec![json!({"type":"agent_state","busy":true,"status":"ready","paused":false}), recorded];
                }
                log.push(("assistant".into(), format!("r-{text}")));
                let id = format!("m{}", log.len());
                vec![
                    json!({"type":"agent_state","busy":true,"status":"ready","paused":false}),
                    recorded,
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
    own_record(&link, "s0-3");
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"r-hola"}));
    link.frame(json!({"type":"message_done","messageId":"m1"}));
    agent(&link, false, "ready");
    host.project(&link.view(), T0 + 20);
    page(&link, &[("s0-1", "user", "otro cliente"), ("s0-2", "assistant", "r-otro"), ("s0-3", "user", "hola"), ("s0-4", "assistant", "r-hola")], false);
    let v = host.project(&link.view(), T0 + 30);
    let ts = turns(&v);
    assert_eq!(ts.len(), 2, "no duplicate: {v}");
    assert_eq!(ts[1]["turn_id"], a["turn_id"], "bound by its record id, the island's turn sorts at its record position: {v}");
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
    own_record(&link, "s0-5");
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
}

impl Live {
    /// `reply(text)`: the engine's reply to an island send (None = the island cancels it before
    /// any output; `record_cancelled` = the engine recorded the cancelled prompt anyway). Every
    /// prompt the engine records is announced as the daemon does (`user_message`, with the
    /// island's own `requestId`).
    fn new(log: Vec<(&'static str, String)>, reply: fn(&str) -> Option<String>, record_cancelled: bool) -> Live {
        let record = std::sync::Arc::new(Mutex::new(Record { log, max: |_| 100 }));
        let held = record.clone();
        let mut link = FakeLink::answering(move |c| {
            let mut r = held.lock().unwrap();
            match c {
                ChatCommand::History => vec![r.history()],
                ChatCommand::Send { text, .. } => {
                    let busy = json!({"type":"agent_state","busy":true,"status":"ready","paused":false});
                    let recorded = |r: &Record| json!({"type":"user_message","messageId":format!("s0-{}", r.log.len()),"text":text,"requestId":wire_request_id(c)});
                    match reply(text) {
                        Some(answer) => {
                            r.log.push(("user", text.clone()));
                            let own = recorded(&r);
                            r.log.push(("assistant", answer.clone()));
                            let id = format!("m{}", r.log.len());
                            vec![busy, own, json!({"type":"message_delta","messageId":id,"text":answer}), json!({"type":"message_done","messageId":id}), json!({"type":"agent_state","busy":false,"status":"ready","paused":false})]
                        }
                        None if record_cancelled => {
                            r.log.push(("user", text.clone()));
                            let own = recorded(&r);
                            vec![busy, own]
                        }
                        None => vec![busy],
                    }
                }
                ChatCommand::Abort => vec![json!({"type":"agent_state","busy":false,"status":"ready","paused":false})],
                ChatCommand::Earlier { before } => vec![r.earlier(before)],
                _ => vec![],
            }
        });
        link.unlimited = true;
        Live { record, link: std::sync::Arc::new(link) }
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
        let (record, id) = {
            let mut r = self.record.lock().unwrap();
            r.log.push(("user", prompt.to_owned()));
            let record = format!("s0-{}", r.log.len());
            r.log.push(("assistant", reply.to_owned()));
            (record, format!("x{}", r.log.len()))
        };
        for f in [
            json!({"type":"agent_state","busy":true,"status":"ready","paused":false}),
            json!({"type":"user_message","messageId":record,"text":prompt}),
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
        let (record, id) = {
            let mut r = live.record.lock().unwrap();
            r.log.push(("user", other.clone()));
            let record = format!("s0-{}", r.log.len());
            r.log.push(("assistant", theirs.clone()));
            (record, format!("x{}", r.log.len()))
        };
        live.link.frame(json!({"type":"agent_state","busy":true,"status":"ready","paused":false}));
        live.link.frame(json!({"type":"user_message","messageId":record,"text":other}));
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
    live.link.frame(json!({"type":"user_message","messageId":"s0-3","text":"hola"}));
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

// ---- K2-05 T4 S2 re-verify follow-ups (mwb5m1ps-8-5ta4): empty first message ----------------------
//
// (K2-05 bind by id: the B2-residual and N1 tests of f118b5f — `b2_residual`, `Trouble`,
// `followups_b2_residual_*`, `followups_n1_*`, `slow_read_link`, `submit_watching` — tested the
// pre-send read and the engine-cycle counting, both removed; their cases live on as `bind_*` below.)

#[test]
fn followups_an_island_reply_whose_first_message_is_empty_has_no_leading_blank_paragraph() {
    let log = vec![("user", "vieja".to_owned()), ("assistant", "r-vieja".to_owned())];
    let live = Live::new(log, |_| None, true);
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
    live.record.lock().unwrap().log.push(("assistant", "encontré esto".to_owned()));
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

// ---- K2-05 bind by id (re-verify mwbss5n0-a-z1tl: NEW-1, NEW-2, B2-steer) -----------------------
//
// The island binds its turn to the record ONLY by the daemon's `user_message{messageId, requestId}`
// (Gentle Dot bridge.ts onMessageStart): never by counting engine cycles, never by text. The fake
// daemon below speaks that protocol: every prompt the engine records is announced to the island with
// its record id, and with the island's own requestId only when the send was the island's.

/// The requestId a chat command carries on the wire (None when it carries none).
fn wire_request_id(c: &ChatCommand) -> Option<String> {
    serde_json::from_str::<Value>(c.line().trim()).ok()?.get("requestId")?.as_str().map(str::to_owned)
}

/// What the fake engine does with the island's next send.
#[derive(Clone, Copy, Debug, PartialEq)]
enum OnSend {
    /// Records the prompt and answers it.
    Reply(&'static str),
    /// The engine refuses the prompt: optimistic busy, quiet, `failed`; nothing recorded.
    Fail,
    /// The turn starts but the engine records nothing before the island cancels it.
    Unrecorded,
    /// The engine records the prompt, then the island cancels it before any answer.
    RecordedNoReply,
    /// F2: an older daemon (no `user_message` at all): the prompt is recorded and answered.
    ReplyUnannounced(&'static str),
    /// F2: the announcement of the island's prompt lost its `requestId` (as F1 did): recorded,
    /// announced to the island as anybody's prompt, and answered.
    ReplyAnonymous(&'static str),
}

/// A rotated chain: every row is one display row, ids `s<file>-<row of that file>` (the daemon's).
struct Chain {
    rows: Vec<(u32, &'static str, String)>,
    file: u32,
    on_send: OnSend,
    /// The next `refuse` newest-page reads are refused; the next `defer` are read now, answered later;
    /// the next `late` are read by the daemon only when the test delivers them (the race of NEW-1).
    refuse: usize,
    defer: usize,
    late: usize,
    deferred: Vec<Option<Value>>,
}

impl Chain {
    fn id_of(&self, at: usize) -> String {
        let file = self.rows[at].0;
        format!("s{file}-{}", self.rows[..=at].iter().filter(|r| r.0 == file).count())
    }
    fn push(&mut self, role: &'static str, text: &str) -> String {
        self.rows.push((self.file, role, text.to_owned()));
        self.id_of(self.rows.len() - 1)
    }
    fn page(&self, end: usize) -> (Vec<Value>, bool) {
        let from = end.saturating_sub(100);
        let messages = (from..end).map(|i| json!({"id": self.id_of(i), "role": self.rows[i].1, "text": self.rows[i].2})).collect();
        (messages, from > 0)
    }
    fn history(&self) -> Value {
        let (messages, more) = self.page(self.rows.len());
        json!({"type":"history","messages":messages,"hasEarlier":more})
    }
    fn earlier(&self, before: &str) -> Value {
        let (messages, more) = match (0..self.rows.len()).find(|&i| self.id_of(i) == before) {
            Some(at) => self.page(at),
            None => (vec![], false),
        };
        json!({"type":"earlier","before":before,"messages":messages,"hasEarlier":more})
    }
}

const BUSY: fn() -> Value = || json!({"type":"agent_state","busy":true,"status":"ready","paused":false});
const QUIET: fn() -> Value = || json!({"type":"agent_state","busy":false,"status":"ready","paused":false});

fn user_message(id: &str, text: &str, request_id: Option<String>) -> Value {
    let mut f = json!({"type":"user_message","messageId":id,"text":text});
    if let Some(r) = request_id {
        f["requestId"] = json!(r);
    }
    f
}

fn chain_link(rows: &[(&'static str, &str)]) -> (std::sync::Arc<FakeLink>, std::sync::Arc<Mutex<Chain>>) {
    chain_link_budget(rows, true)
}

/// `unlimited` = false keeps the island's own per-minute budget (the budget-spent cases).
fn chain_link_budget(rows: &[(&'static str, &str)], unlimited: bool) -> (std::sync::Arc<FakeLink>, std::sync::Arc<Mutex<Chain>>) {
    let mut chain = Chain { rows: vec![], file: 0, on_send: OnSend::Reply("r"), refuse: 0, defer: 0, late: 0, deferred: vec![] };
    for (role, text) in rows {
        chain.push(role, text);
    }
    let chain = std::sync::Arc::new(Mutex::new(chain));
    let held = chain.clone();
    let mut link = FakeLink::answering(move |c| {
        let mut d = held.lock().unwrap();
        match c {
            ChatCommand::History if d.refuse > 0 => {
                d.refuse -= 1;
                vec![json!({"type":"error","code":"failed"})]
            }
            ChatCommand::History if d.defer > 0 => {
                d.defer -= 1;
                let f = d.history();
                d.deferred.push(Some(f));
                vec![]
            }
            ChatCommand::History if d.late > 0 => {
                d.late -= 1;
                d.deferred.push(None);
                vec![]
            }
            ChatCommand::History => vec![d.history()],
            ChatCommand::Earlier { before } => vec![d.earlier(before)],
            ChatCommand::Send { text, .. } => {
                let rid = wire_request_id(c);
                match d.on_send {
                    OnSend::Reply(reply) => {
                        let id = d.push("user", text);
                        d.push("assistant", reply);
                        let m = format!("m{}", d.rows.len());
                        vec![BUSY(), user_message(&id, text, rid), json!({"type":"message_delta","messageId":m,"text":reply}), json!({"type":"message_done","messageId":m}), QUIET()]
                    }
                    OnSend::ReplyUnannounced(reply) | OnSend::ReplyAnonymous(reply) => {
                        let id = d.push("user", text);
                        d.push("assistant", reply);
                        let m = format!("m{}", d.rows.len());
                        let mut frames = vec![BUSY()];
                        if matches!(d.on_send, OnSend::ReplyAnonymous(_)) {
                            frames.push(user_message(&id, text, None));
                        }
                        frames.extend([json!({"type":"message_delta","messageId":m,"text":reply}), json!({"type":"message_done","messageId":m}), QUIET()]);
                        frames
                    }
                    OnSend::Fail => vec![BUSY(), QUIET(), json!({"type":"error","code":"failed"})],
                    OnSend::Unrecorded => vec![BUSY()],
                    OnSend::RecordedNoReply => {
                        let id = d.push("user", text);
                        vec![BUSY(), user_message(&id, text, rid)]
                    }
                }
            }
            ChatCommand::Abort => vec![QUIET()],
            _ => vec![],
        }
    });
    link.unlimited = unlimited;
    (std::sync::Arc::new(link), chain)
}

/// Another client's whole turn: its prompt (and optional steers) recorded and announced WITHOUT the
/// island's requestId, its replies streamed, quiet. `turn` = [(prompt, reply), (steer, reply)…].
fn foreign_turn(link: &FakeLink, chain: &Mutex<Chain>, turn: &[(&str, &str)]) {
    link.frame(BUSY());
    for (prompt, reply) in turn {
        let (id, m) = {
            let mut d = chain.lock().unwrap();
            let id = d.push("user", prompt);
            d.push("assistant", reply);
            (id, format!("x{}", d.rows.len()))
        };
        link.frame(user_message(&id, prompt, None));
        link.frame(json!({"type":"message_delta","messageId":m,"text":reply}));
        link.frame(json!({"type":"message_done","messageId":m}));
    }
    link.frame(QUIET());
}

fn deliver_deferred(link: &FakeLink, chain: &Mutex<Chain>) {
    let frames: Vec<Value> = {
        let mut d = chain.lock().unwrap();
        let pending = std::mem::take(&mut d.deferred);
        pending.into_iter().map(|f| f.unwrap_or_else(|| d.history())).collect()
    };
    for f in frames {
        link.frame(f);
    }
}

/// The production reader's work: project, then the host's own refresh (and status read).
fn tick(host: &ChatHost, link: &FakeLink, now: u64) -> Value {
    let v = host.project(&link.view(), now);
    host.route(link, "main", &Command::View, now).unwrap();
    v
}

/// The page's whole chat (newest window + every earlier page, the live window wins on a shared id).
fn whole_chat_of(host: &ChatHost, link: &FakeLink, now: u64) -> Vec<Value> {
    let v = host.project(&link.view(), now);
    let window = turns(&v);
    let mut older: Vec<Value> = vec![];
    let mut cursor = v["history_before"].clone();
    let mut guard = 0;
    while let Some(n) = cursor.as_u64() {
        guard += 1;
        assert!(guard < 100, "paging terminates");
        let cmd = Command::History { conversation_id: CHAT_CONVERSATION_ID.into(), before: Some(n) };
        let Routed::Answer(p) = host.route(link, "main", &cmd, now).unwrap() else { panic!() };
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

fn row(user: &str, reply: &str, state: &str) -> (String, String, String) {
    (user.to_owned(), reply.to_owned(), state.to_owned())
}

/// Right after (the troubled reads still refused or late), then once the reads recover: order and
/// content after the record arrives, after a page reload and after a reconnect; `own` = (row index,
/// the island turn id it must keep).
fn check_bound(host: &ChatHost, link: &FakeLink, chain: &Mutex<Chain>, expected: &[(String, String, String)], own: &[(usize, Value)], label: &str, now: u64) {
    let assert_ids = |ts: &[Value], when: &str| {
        for (at, id) in own {
            assert_eq!(ts[*at]["turn_id"], *id, "{label}, {when}: row {at} keeps the island's turn id: {:?}", shape(ts));
        }
    };
    // right after, with no read answered since the send: each island turn shows exactly once, with
    // its own text and end, after every turn the island already showed (never doubled, never
    // under another client's prompt)
    let ts = turns(&host.project(&link.view(), now));
    for (at, id) in own {
        let mine: Vec<&Value> = ts.iter().filter(|t| t["turn_id"] == *id).collect();
        assert_eq!(mine.len(), 1, "{label}, right after: the island's turn {id} shows once: {:?}", shape(&ts));
        let got = (mine[0]["user_text"].as_str().unwrap().to_owned(), mine[0]["reply"].as_str().unwrap().to_owned(), mine[0]["state"].as_str().unwrap().to_owned());
        assert_eq!(got, expected[*at], "{label}, right after");
    }
    let texts_right_after: Vec<_> = shape(&ts).into_iter().filter(|r| expected.contains(r)).collect();
    assert_eq!(texts_right_after.len(), ts.len(), "{label}, right after: nothing the record will not hold: {:?}", shape(&ts));
    // the reads recover (a late answer lands, refusals end, the island's budget window resets)
    {
        let mut d = chain.lock().unwrap();
        d.refuse = 0;
        d.defer = 0;
        d.late = 0;
    }
    link.state.lock().unwrap().rate_window.set(None);
    deliver_deferred(link, chain);
    // (a refused catch-up read is asked again once per status gap, a few seconds later)
    let now = now + 5_000;
    for k in 0..3 {
        tick(host, link, now + 10 + k);
    }
    let ts = turns(&host.project(&link.view(), now + 20));
    assert_eq!(shape(&ts), expected, "{label}: after the host's refresh");
    assert_ids(&ts, "after the host's refresh");
    assert_eq!(shape(&whole_chat_of(host, link, now + 30)), expected, "{label}: a page reload walks the same chat");
    // the connection drops and comes back: a fresh chat view and its own newest page
    {
        let mut st = ChatState::connected();
        st.apply(&QUIET());
        *link.state.lock().unwrap() = st;
    }
    host.project(&link.view(), now + 40);
    first_window(host, link);
    for k in 0..3 {
        tick(host, link, now + 50 + k);
    }
    let ts = turns(&host.project(&link.view(), now + 60));
    assert_eq!(shape(&ts), expected, "{label}: after a reconnect");
    assert_ids(&ts, "after a reconnect");
    assert_eq!(shape(&whole_chat_of(host, link, now + 70)), expected, "{label}: a page reload after the reconnect");
}

fn send_turn(host: &ChatHost, link: &FakeLink, text: &str, id: &str, now: u64) -> Value {
    let Routed::Answer(a) = host.route(link, "main", &submit(text, id), now).unwrap() else { panic!("{text}") };
    tick(host, link, now + 1);
    a["turn_id"].clone()
}

fn cancel_turn(host: &ChatHost, link: &FakeLink, now: u64) {
    let v = host.project(&link.view(), now);
    let active = v["active_turn"].as_str().unwrap_or_else(|| panic!("a turn is running: {v}")).to_owned();
    assert_eq!(host.route(link, "main", &Command::Cancel { turn_id: active }, now).unwrap(), Routed::Answer(json!({"cancelled": true})));
}

#[test]
fn bind_new1_a_failed_send_then_the_same_text_with_reads_refused_shows_each_turn_once() {
    let (link, chain) = chain_link(&[("user", "vieja"), ("assistant", "r-vieja")]);
    let host = ChatHost::new();
    first_window(&host, &link);
    tick(&host, &link, T0);
    chain.lock().unwrap().refuse = 3;
    chain.lock().unwrap().on_send = OnSend::Fail;
    let failed = send_turn(&host, &link, "hola", "req-n1a00001", T0 + 10);
    assert_eq!(last_turn(&host.project(&link.view(), T0 + 20))["state"], json!("error"), "the refused send ends with its error");
    chain.lock().unwrap().on_send = OnSend::Reply("r-hola");
    let sent = send_turn(&host, &link, "hola", "req-n1a00002", T0 + 30);
    let expected = vec![row("vieja", "r-vieja", "completed"), row("hola", "", "error"), row("hola", "r-hola", "completed")];
    check_bound(&host, &link, &chain, &expected, &[(1, failed), (2, sent)], "failed send then the same text", T0 + 100);
}

#[test]
fn bind_new1_a_rotation_and_another_clients_held_prompt_with_three_reads_refused_shows_each_turn_once() {
    let (link, chain) = chain_link(&[("user", "vieja"), ("assistant", "r-vieja")]);
    let host = ChatHost::new();
    first_window(&host, &link);
    tick(&host, &link, T0);
    chain.lock().unwrap().refuse = 3;
    // the rotation switch: a busy engine cycle that records no prompt; the daemon re-broadcasts the chat
    link.frame(BUSY());
    tick(&host, &link, T0 + 5);
    chain.lock().unwrap().file = 1;
    link.frame(QUIET());
    let rebroadcast = chain.lock().unwrap().history();
    link.frame(rebroadcast);
    tick(&host, &link, T0 + 10);
    // another client's prompt, held during the switch, is delivered now
    foreign_turn(&link, &chain, &[("hola", "r-otro")]);
    tick(&host, &link, T0 + 20);
    chain.lock().unwrap().on_send = OnSend::Reply("r-isla");
    let own = send_turn(&host, &link, "hola", "req-n1b00001", T0 + 30);
    let expected = vec![row("vieja", "r-vieja", "completed"), row("hola", "r-otro", "completed"), row("hola", "r-isla", "completed")];
    check_bound(&host, &link, &chain, &expected, &[(2, own)], "rotation + another client's held prompt", T0 + 100);
}

#[test]
fn bind_new1_a_slow_read_with_another_clients_whole_turn_inside_shows_it_once() {
    let (link, chain) = chain_link(&[("user", "vieja"), ("assistant", "r-vieja")]);
    let host = ChatHost::new();
    first_window(&host, &link);
    tick(&host, &link, T0);
    chain.lock().unwrap().on_send = OnSend::Reply("r-uno");
    let uno = send_turn(&host, &link, "uno", "req-n1c00001", T0 + 10);
    // the island's read goes out on a quiet engine; the daemon reads the record only after another
    // client's whole turn ran (the page holds «dos» though the read was asked before it)
    chain.lock().unwrap().late = 1;
    tick(&host, &link, T0 + 20);
    foreign_turn(&link, &chain, &[("dos", "dos-r")]);
    deliver_deferred(&link, &chain);
    tick(&host, &link, T0 + 30);
    chain.lock().unwrap().on_send = OnSend::Reply("r-tres");
    let tres = send_turn(&host, &link, "tres", "req-n1c00002", T0 + 40);
    let expected = vec![row("vieja", "r-vieja", "completed"), row("uno", "r-uno", "completed"), row("dos", "dos-r", "completed"), row("tres", "r-tres", "completed")];
    check_bound(&host, &link, &chain, &expected, &[(1, uno), (3, tres)], "a late read with another client's turn inside", T0 + 100);
}

#[test]
fn bind_b2_steer_another_clients_steer_with_the_same_text_never_takes_the_islands_turn() {
    for on_send in [OnSend::Unrecorded, OnSend::RecordedNoReply] {
        let label = format!("{on_send:?}");
        let (link, chain) = chain_link(&[("user", "vieja"), ("assistant", "r-vieja")]);
        let host = ChatHost::new();
        first_window(&host, &link);
        tick(&host, &link, T0);
        chain.lock().unwrap().refuse = 2;
        foreign_turn(&link, &chain, &[("pregunta", "r-pregunta"), ("hola", "r-steer")]);
        tick(&host, &link, T0 + 10);
        chain.lock().unwrap().on_send = on_send;
        let own = send_turn(&host, &link, "hola", "req-b2s00001", T0 + 20);
        cancel_turn(&host, &link, T0 + 30);
        let expected = vec![
            row("vieja", "r-vieja", "completed"),
            row("pregunta", "r-pregunta", "completed"),
            row("hola", "r-steer", "completed"),
            row("hola", "", "cancelled"),
        ];
        check_bound(&host, &link, &chain, &expected, &[(3, own)], &label, T0 + 100);
    }
}

#[test]
fn bind_new2_a_cancelled_unrecorded_turn_stays_after_the_islands_own_earlier_turn() {
    let (link, chain) = chain_link(&[("user", "vieja"), ("assistant", "r-vieja")]);
    let host = ChatHost::new();
    first_window(&host, &link);
    tick(&host, &link, T0);
    chain.lock().unwrap().refuse = 3;
    chain.lock().unwrap().on_send = OnSend::Reply("uno-r");
    let uno = send_turn(&host, &link, "uno", "req-n2a00001", T0 + 10);
    chain.lock().unwrap().on_send = OnSend::Unrecorded;
    let dos = send_turn(&host, &link, "dos", "req-n2a00002", T0 + 20);
    cancel_turn(&host, &link, T0 + 30);
    let expected = vec![row("vieja", "r-vieja", "completed"), row("uno", "uno-r", "completed"), row("dos", "", "cancelled")];
    check_bound(&host, &link, &chain, &expected, &[(1, uno), (2, dos)], "cancelled after the island's own turn", T0 + 100);
}

#[test]
fn bind_new2_a_cancelled_unrecorded_turn_stays_after_another_clients_earlier_turn() {
    let (link, chain) = chain_link(&[("user", "vieja"), ("assistant", "r-vieja")]);
    let host = ChatHost::new();
    first_window(&host, &link);
    tick(&host, &link, T0);
    chain.lock().unwrap().refuse = 3;
    foreign_turn(&link, &chain, &[("otra previa", "r-otra")]);
    tick(&host, &link, T0 + 10);
    chain.lock().unwrap().on_send = OnSend::Unrecorded;
    let dos = send_turn(&host, &link, "dos", "req-n2b00001", T0 + 20);
    cancel_turn(&host, &link, T0 + 30);
    let expected = vec![row("vieja", "r-vieja", "completed"), row("otra previa", "r-otra", "completed"), row("dos", "", "cancelled")];
    check_bound(&host, &link, &chain, &expected, &[(2, dos)], "cancelled after another client's turn", T0 + 100);
}

#[test]
fn bind_b2_identical_text_from_another_client_first_with_budget_spent_reads_refused_or_late() {
    for (spent, refuse, defer) in [(true, 0, 0), (false, 3, 0), (false, 0, 3)] {
        for on_send in [OnSend::Reply("r-isla"), OnSend::RecordedNoReply, OnSend::Unrecorded] {
            let label = format!("budget spent {spent}, refused {refuse}, late {defer}, {on_send:?}");
            let (link, chain) = chain_link_budget(&[("user", "vieja"), ("assistant", "r-vieja")], !spent);
            let host = ChatHost::new();
            first_window(&host, &link);
            tick(&host, &link, T0);
            if spent {
                // the island's whole read budget is spent: no read reaches the daemon, sends still do
                while link.command("main", &json!({"action":"chat_status"})).is_ok() {}
            }
            {
                let mut d = chain.lock().unwrap();
                d.refuse = refuse;
                d.defer = defer;
            }
            foreign_turn(&link, &chain, &[("hola", "r-otro")]);
            tick(&host, &link, T0 + 10);
            chain.lock().unwrap().on_send = on_send;
            let own = send_turn(&host, &link, "hola", "req-b2i00001", T0 + 20);
            let end = if let OnSend::Reply(_) = on_send {
                row("hola", "r-isla", "completed")
            } else {
                cancel_turn(&host, &link, T0 + 30);
                row("hola", "", "cancelled")
            };
            deliver_deferred(&link, &chain);
            let expected = vec![row("vieja", "r-vieja", "completed"), row("hola", "r-otro", "completed"), end];
            check_bound(&host, &link, &chain, &expected, &[(2, own)], &label, T0 + 100);
        }
    }
}

#[test]
fn bind_every_send_carries_a_fresh_request_id_and_only_its_own_user_message_binds_it() {
    let (link, chain) = chain_link(&[("user", "vieja"), ("assistant", "r-vieja")]);
    let host = ChatHost::new();
    first_window(&host, &link);
    tick(&host, &link, T0);
    chain.lock().unwrap().on_send = OnSend::RecordedNoReply;
    send_turn(&host, &link, "hola", "req-bid00001", T0 + 10);
    cancel_turn(&host, &link, T0 + 20);
    send_turn(&host, &link, "hola", "req-bid00001", T0 + 30); // the page's duplicate: never sent again
    send_turn(&host, &link, "hola", "req-bid00002", T0 + 40);
    cancel_turn(&host, &link, T0 + 50);
    let ids: Vec<Option<String>> = link.sent().iter().filter(|c| matches!(c, ChatCommand::Send { .. })).map(wire_request_id).collect();
    assert_eq!(ids.len(), 2, "{ids:?}");
    let (a, b) = (ids[0].clone().expect("a requestId on the wire"), ids[1].clone().expect("a requestId on the wire"));
    assert_ne!(a, b, "fresh per send");
    for id in [&a, &b] {
        assert!(!id.is_empty() && id.len() <= 64 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'), "the daemon's grammar: {id}");
    }
    // a user_message naming the same text but no requestId of the island never binds an island turn
    let foreign = { let mut d = chain.lock().unwrap(); d.push("user", "hola") };
    link.frame(BUSY());
    link.frame(user_message(&foreign, "hola", Some("otro-cliente".into())));
    link.frame(QUIET());
    let expected = vec![row("vieja", "r-vieja", "completed"), row("hola", "", "cancelled"), row("hola", "", "cancelled"), row("hola", "", "completed")];
    check_bound(&host, &link, &chain, &expected, &[], "fresh ids", T0 + 100);
}

// ---- K2-05 bind follow-ups (verifier mwbwcay1-c-olub F2/F3) ----------------------------------

/// F2: a turn that never binds (an older daemon sends no `user_message`; or the announcement lost
/// its requestId) shows ONCE, with its streamed reply, before and after the record carries it.
#[test]
fn bind_f2_an_unbound_turn_shows_once_with_its_streamed_reply() {
    for on_send in [OnSend::ReplyUnannounced("r-hola"), OnSend::ReplyAnonymous("r-hola")] {
        for refuse in [0, 3] {
            let label = format!("{on_send:?}, reads refused {refuse}");
            let (link, chain) = chain_link(&[("user", "vieja"), ("assistant", "r-vieja")]);
            let host = ChatHost::new();
            first_window(&host, &link);
            tick(&host, &link, T0);
            chain.lock().unwrap().refuse = refuse;
            // another client's identical prompt before the island's: never taken by the fallback
            foreign_turn(&link, &chain, &[("hola", "r-otro")]);
            tick(&host, &link, T0 + 10);
            chain.lock().unwrap().on_send = on_send;
            let own = send_turn(&host, &link, "hola", "req-f2000001", T0 + 20);
            let expected = vec![row("vieja", "r-vieja", "completed"), row("hola", "r-otro", "completed"), row("hola", "r-hola", "completed")];
            check_bound(&host, &link, &chain, &expected, &[(2, own)], &label, T0 + 100);
        }
    }
}

/// F2: while the unbound turn runs, its streamed output shows on it (never on the newest history
/// turn), and output that was already on screen when it was sent is never taken.
#[test]
fn bind_f2_an_unbound_turn_in_flight_shows_its_own_streamed_output_only() {
    let link = FakeLink::new();
    page(&link, &[("s0-1", "user", "vieja")], false);
    agent(&link, true, "ready");
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"antes"}));
    link.frame(json!({"type":"message_done","messageId":"m1"}));
    agent(&link, false, "ready");
    let host = ChatHost::new();
    host.project(&link.view(), T0);
    host.route(&link, "main", &submit("hola", "req-f2000002"), T0 + 10).unwrap();
    agent(&link, true, "ready");
    link.frame(json!({"type":"message_delta","messageId":"m2","text":"parte"}));
    let v = host.project(&link.view(), T0 + 20);
    let ts = turns(&v);
    assert_eq!(shape(&ts), vec![row("vieja", "antes", "completed"), row("hola", "parte", "streaming")], "{v}");
    assert_eq!(v["active_turn"], ts[1]["turn_id"]);
}

/// F2: an unbound send the daemon refused (its `failed` arrives after another client's output
/// started) ends with its error and never keeps that output.
#[test]
fn bind_f2_a_refused_unbound_send_never_keeps_another_clients_output() {
    let link = FakeLink::new();
    page(&link, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "r-vieja")], false);
    let host = ChatHost::new();
    host.project(&link.view(), T0);
    host.route(&link, "main", &submit("hola", "req-f2000003"), T0 + 10).unwrap();
    agent(&link, true, "ready");
    link.frame(json!({"type":"user_message","messageId":"s0-3","text":"otra"}));
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"ajena"}));
    host.project(&link.view(), T0 + 20);
    link.frame(json!({"type":"error","code":"failed"}));
    let ts = turns(&host.project(&link.view(), T0 + 30));
    let mine = ts.iter().find(|t| t["user_text"] == json!("hola")).expect("the island's turn shows");
    assert_eq!(mine["state"], json!("error"), "{ts:?}");
    assert_eq!(mine["reply"], json!(""), "another client's output is never the refused send's: {ts:?}");
}

/// F3: a refused catch-up read's `failed` counts against the read (never against a send whose turn
/// went quiet with no output), so the read is asked again a status gap later.
#[test]
fn bind_f3_a_refused_catch_up_read_after_a_silent_settled_send_is_asked_again() {
    let (link, chain) = chain_link(&[("user", "vieja"), ("assistant", "r-vieja")]);
    let host = ChatHost::new();
    first_window(&host, &link);
    tick(&host, &link, T0);
    // the island's turn is recorded, then cancelled before any output: its send is left settled
    chain.lock().unwrap().on_send = OnSend::RecordedNoReply;
    let own = send_turn(&host, &link, "hola", "req-f3000001", T0 + 10);
    chain.lock().unwrap().refuse = 1;
    cancel_turn(&host, &link, T0 + 20);
    let reads = |link: &FakeLink| link.sent().iter().filter(|c| matches!(c, ChatCommand::History)).count();
    tick(&host, &link, T0 + 30);
    assert_eq!(chain.lock().unwrap().refuse, 0, "the catch-up read went out and was refused");
    let refused = reads(&link);
    assert_eq!(link.view()["reads"]["failed"], json!(1), "the refusal is the read's: {}", link.view()["reads"]);
    // the production reader projects the view the refusal changed
    host.project(&link.view(), T0 + 31);
    for k in 0..3 {
        tick(&host, &link, T0 + 30 + STATUS_GAP + k);
    }
    assert!(reads(&link) > refused, "the refused catch-up read is asked again");
    let ts = turns(&host.project(&link.view(), T0 + 30 + STATUS_GAP + 10));
    assert_eq!(shape(&ts), vec![row("vieja", "r-vieja", "completed"), row("hola", "", "cancelled")]);
    assert_eq!(ts[1]["turn_id"], own);
}

const STATUS_GAP: u64 = 5_000;

// ---- K2-05 native-review advisory follow-ups (at 9e6aac6) -------------------------------------

/// The island's last send's wire requestId.
fn last_send_id(link: &FakeLink) -> String {
    link.sent().iter().rev().find(|c| matches!(c, ChatCommand::Send { .. })).and_then(wire_request_id).expect("a send went out")
}

/// Review F3: while another client's prompt is known to be in flight (announced without the island's
/// requestId), the island's unbound turn never shows that prompt's output: it waits (thinking), and
/// the refusal that names its send ends it with nothing taken.
#[test]
fn review_f3_an_unbound_turn_never_shows_another_prompts_output_before_its_refusal() {
    let link = FakeLink::new();
    page(&link, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "r-vieja")], false);
    let host = ChatHost::new();
    host.project(&link.view(), T0);
    host.route(&link, "main", &submit("hola", "req-rf300001"), T0 + 10).unwrap();
    // another client's prompt got to the daemon first: its record and output reach the island
    // before the island's own refusal does
    agent(&link, true, "ready");
    link.frame(json!({"type":"user_message","messageId":"s0-3","text":"otra"}));
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"ajena"}));
    for now in [T0 + 20, T0 + 30] {
        let ts = turns(&host.project(&link.view(), now));
        let mine = ts.iter().find(|t| t["user_text"] == json!("hola")).expect("the island's turn shows");
        assert_eq!(mine["reply"], json!(""), "another prompt's output is never the unbound turn's: {:?}", shape(&ts));
        assert_eq!(mine["state"], json!("thinking"), "{:?}", shape(&ts));
    }
    link.frame(json!({"type":"message_done","messageId":"m1"}));
    host.project(&link.view(), T0 + 40);
    let id = last_send_id(&link);
    link.frame(json!({"type":"error","code":"busy","requestId":id}));
    agent(&link, false, "ready");
    let ts = turns(&host.project(&link.view(), T0 + 50));
    let mine = ts.iter().find(|t| t["user_text"] == json!("hola")).expect("the island's turn shows");
    assert_eq!((mine["state"].clone(), mine["reply"].clone()), (json!("error"), json!("")), "{:?}", shape(&ts));
}

/// Review F3: the same with a run that settles before anything names the island's send: once the
/// engine is quiet and nothing refused it, the run that recorded a prompt after its send was its own.
#[test]
fn review_f3_an_unbound_turn_takes_its_runs_output_once_the_run_settled_unrefused() {
    let link = FakeLink::new();
    page(&link, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "r-vieja")], false);
    let host = ChatHost::new();
    host.project(&link.view(), T0);
    host.route(&link, "main", &submit("hola", "req-rf300002"), T0 + 10).unwrap();
    agent(&link, true, "ready");
    link.frame(json!({"type":"user_message","messageId":"s0-3","text":"hola"}));
    link.frame(json!({"type":"message_delta","messageId":"m1","text":"r-hola"}));
    let ts = turns(&host.project(&link.view(), T0 + 20));
    assert_eq!(shape(&ts).last().cloned(), Some(row("hola", "", "thinking")), "it waits while the run is ambiguous");
    link.frame(json!({"type":"message_done","messageId":"m1"}));
    agent(&link, false, "ready");
    let ts = turns(&host.project(&link.view(), T0 + 30));
    assert_eq!(shape(&ts), vec![row("vieja", "r-vieja", "completed"), row("hola", "r-hola", "completed")]);
}

/// Review F4: the connection drops after the island's send but before the daemon named its record;
/// after the reconnect the record carries the prompt (and another client's later turn): the island's
/// turn shows once, where its prompt was recorded, never beside or under another prompt.
#[test]
fn review_f4_an_unbound_turn_after_a_reconnect_shows_once_in_send_order() {
    let link = FakeLink::new();
    page(&link, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "r-vieja")], false);
    let host = ChatHost::new();
    host.project(&link.view(), T0);
    let Routed::Answer(a) = host.route(&link, "main", &submit("hola", "req-rf400001"), T0 + 10).unwrap() else { panic!() };
    agent(&link, true, "ready");
    host.project(&link.view(), T0 + 20);
    let lost = serde_json::to_value(ChatState::disconnected(crate::agentclient::Reason::Lost)).unwrap();
    let ts = turns(&host.project(&lost, T0 + 30));
    assert_eq!(shape(&ts).last().cloned(), Some(row("hola", "", "error")), "interrupted while down");
    // reconnected: the engine had recorded and answered it; another client's turn followed
    let again = FakeLink::new();
    page(&again, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "r-vieja"), ("s0-3", "user", "hola"), ("s0-4", "assistant", "r-hola"), ("s0-5", "user", "otra"), ("s0-6", "assistant", "r-otra")], false);
    for now in [T0 + 40, T0 + 5_000] {
        let ts = turns(&host.project(&again.view(), now));
        let users: Vec<&str> = ts.iter().map(|t| t["user_text"].as_str().unwrap()).collect();
        assert_eq!(users, vec!["vieja", "hola", "otra"], "once, in send order: {:?}", shape(&ts));
        assert_eq!(ts[1]["turn_id"], a["turn_id"], "the island keeps its own turn id");
        assert_eq!(ts[1]["reply"], json!("r-hola"));
        assert_eq!(ts[2]["reply"], json!("r-otra"), "the other prompt keeps its own reply");
    }
}

/// Review F4: the send never reached the record (another client's prompt is the next one recorded):
/// the island's interrupted turn stays once, right after what it knew when it sent, before that prompt.
#[test]
fn review_f4_an_unrecorded_unbound_turn_after_a_reconnect_never_takes_another_prompt() {
    let link = FakeLink::new();
    page(&link, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "r-vieja")], false);
    let host = ChatHost::new();
    host.project(&link.view(), T0);
    host.route(&link, "main", &submit("hola", "req-rf400002"), T0 + 10).unwrap();
    let lost = serde_json::to_value(ChatState::disconnected(crate::agentclient::Reason::Lost)).unwrap();
    host.project(&lost, T0 + 30);
    let again = FakeLink::new();
    page(&again, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "r-vieja"), ("s0-3", "user", "otra"), ("s0-4", "assistant", "r-otra")], false);
    let ts = turns(&host.project(&again.view(), T0 + 40));
    assert_eq!(shape(&ts), vec![row("vieja", "r-vieja", "completed"), row("hola", "", "error"), row("otra", "r-otra", "completed")]);
}

/// Review F6: the send's quiet signal and its `failed` arrive in separate reads, and a page read
/// goes out in between: the `failed` that names the send (requestId) ends the send, never the read.
#[test]
fn review_f6_a_failed_naming_the_send_ends_it_even_with_a_read_sent_after_its_quiet() {
    let link = FakeLink::new();
    page(&link, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "r-vieja")], false);
    let host = ChatHost::new();
    host.project(&link.view(), T0);
    host.route(&link, "main", &submit("hola", "req-rf600001"), T0 + 10).unwrap();
    agent(&link, true, "ready");
    agent(&link, false, "ready");
    host.project(&link.view(), T0 + 20);
    std::thread::sleep(std::time::Duration::from_millis(5));
    // the page's own read goes out after the quiet
    link.command("main", &json!({"action":"chat_history"})).unwrap();
    let id = last_send_id(&link);
    link.frame(json!({"type":"error","code":"failed","requestId":id}));
    page(&link, &[("s0-1", "user", "vieja"), ("s0-2", "assistant", "r-vieja")], false);
    let v = link.view();
    assert_eq!(v["reads"], json!({"answered":1,"failed":0}), "the read was answered, never refused");
    let ts = turns(&host.project(&v, T0 + 30));
    let mine = ts.iter().find(|t| t["user_text"] == json!("hola")).expect("the island's turn shows");
    assert_eq!(mine["state"], json!("error"), "the send's failed ends the send: {:?}", shape(&ts));
    assert_eq!(mine["error"]["code"], json!("failed"));
}

// ---- K2-05 U4b: the agent's questions inside the island chat --------------------------------

fn asking_link() -> FakeLink {
    let link = FakeLink::new();
    link.frame(json!({"type":"ask","id":"a-sel","kind":"select","title":"¿Qué rama?","options":["main","dev"]}));
    link.frame(json!({"type":"ask","id":"a-yes","kind":"confirm","title":"¿Borrar?","message":"Se borra notas.md"}));
    link.frame(json!({"type":"ask","id":"a-txt","kind":"input","title":"Nombre","placeholder":"tu nombre"}));
    link
}

fn answer(ask_id: &str, field: &str, value: Value) -> Value {
    let mut p = json!({"action":"answer","ask_id":ask_id});
    p[field] = value;
    p
}

/// U4b R4: chat:state carries every pending ask for the chat (closed fields, bounded) with
/// whether this island is already answering it; nothing else about the ask (no wire strings).
#[test]
fn chathost_u4b_the_projection_carries_every_pending_ask() {
    let link = asking_link();
    let v = ChatHost::new().project(&link.view(), T0);
    assert_eq!(
        v["asks"],
        json!([
            {"id":"a-sel","kind":"select","title":"¿Qué rama?","message":null,"placeholder":null,"options":["main","dev"],"answering":false},
            {"id":"a-yes","kind":"confirm","title":"¿Borrar?","message":"Se borra notas.md","placeholder":null,"options":[],"answering":false},
            {"id":"a-txt","kind":"input","title":"Nombre","message":null,"placeholder":"tu nombre","options":[],"answering":false},
        ])
    );
    // offline: no ask (the daemon replays the pending ones on the next connection)
    assert_eq!(ChatHost::new().project(&FakeLink::offline().view(), T0)["asks"], json!([]));
    // bounded: never more than the client's MAX_ASKS
    let many = FakeLink::new();
    for i in 0..40 {
        many.frame(json!({"type":"ask","id":format!("a-{i}"),"kind":"confirm","title":"t"}));
    }
    assert_eq!(ChatHost::new().project(&many.view(), T0)["asks"].as_array().unwrap().len(), MAX_ASKS);
}

/// U4b R5: the `answer` verb is a closed shape validated by chat.rs (ask id grammar, exactly one
/// of value / confirmed / cancelled, value bounded and free of control characters) and becomes
/// ONE `ui_response` for that ask through the chat client.
#[test]
fn chathost_u4b_answer_is_a_closed_verb_that_sends_one_ui_response() {
    use crate::chat::{parse_command, AskAnswer};
    assert_eq!(
        parse_command(&answer("a-sel", "value", json!("dev"))).unwrap(),
        Command::Answer { ask_id: "a-sel".into(), answer: AskAnswer::Value("dev".into()) }
    );
    assert_eq!(parse_command(&answer("a-yes", "confirmed", json!(false))).unwrap(), Command::Answer { ask_id: "a-yes".into(), answer: AskAnswer::Confirmed(false) });
    assert_eq!(parse_command(&answer("a-txt", "cancelled", json!(true))).unwrap(), Command::Answer { ask_id: "a-txt".into(), answer: AskAnswer::Cancelled });
    assert_eq!(parse_command(&answer("a-txt", "value", json!(""))).unwrap(), Command::Answer { ask_id: "a-txt".into(), answer: AskAnswer::Value(String::new()) }, "an empty input answer is an answer");
    let max: String = "ñ".repeat(crate::chat::ANSWER_MAX_UNITS);
    assert!(parse_command(&answer("a-txt", "value", json!(max))).is_ok());
    for bad in [
        answer("a-txt", "value", json!("x".repeat(crate::chat::ANSWER_MAX_UNITS + 1))),
        answer("a-txt", "value", json!("a\u{0000}b")),
        answer("a-txt", "value", json!(7)),
        answer("a-yes", "confirmed", json!("true")),
        answer("a-txt", "cancelled", json!(false)),
        answer("bad id!", "value", json!("x")),
        answer(&"a".repeat(129), "value", json!("x")),
        json!({"action":"answer","ask_id":"a-txt"}),
        json!({"action":"answer","ask_id":"a-txt","value":"x","cancelled":true}),
        json!({"action":"answer","ask_id":"a-txt","value":"x","extra":1}),
        json!({"action":"answer","value":"x"}),
    ] {
        assert_eq!(parse_command(&bad).map_err(|e| e.code), Err("invalid_input".into()), "{bad}");
    }
    // each kind sends exactly its ui_response
    let link = asking_link();
    let host = ChatHost::new();
    for (ask, field, value) in [("a-sel", "value", json!("dev")), ("a-yes", "confirmed", json!(true)), ("a-txt", "cancelled", json!(true))] {
        let cmd = parse_command(&answer(ask, field, value)).unwrap();
        assert_eq!(host.route(&link, "main", &cmd, T0).unwrap(), Routed::Answer(json!({"answered": true})));
    }
    let lines: Vec<String> = link.sent().iter().map(ChatCommand::line).collect();
    assert_eq!(
        lines,
        [
            "{\"type\":\"ui_response\",\"id\":\"a-sel\",\"value\":\"dev\"}\n",
            "{\"type\":\"ui_response\",\"id\":\"a-yes\",\"confirmed\":true}\n",
            "{\"type\":\"ui_response\",\"id\":\"a-txt\",\"cancelled\":true}\n",
        ]
    );
    // answering shows in the projection until the daemon resolves it
    let v = host.project(&link.view(), T0);
    assert!(v["asks"].as_array().unwrap().iter().all(|a| a["answering"] == json!(true)), "{v}");
}

/// U4b R6: an answer must name a pending ask, a select answer one of its shown options, a
/// confirm a boolean; a second answer to the same ask is refused and never reaches the daemon;
/// `ask_resolved` removes the ask; the settings window can never answer.
#[test]
fn chathost_u4b_answers_are_refused_for_closed_answered_or_mismatched_asks() {
    use crate::chat::parse_command;
    let link = asking_link();
    let host = ChatHost::new();
    let route = |p: Value| host.route(&link, "main", &parse_command(&p).unwrap(), T0).map_err(|e| e.code);
    assert_eq!(route(answer("a-gone", "value", json!("x"))), Err("ask_closed".into()), "never received");
    assert_eq!(route(answer("a-sel", "value", json!("prod"))), Err("answer_refused".into()), "an option never shown");
    assert_eq!(route(answer("a-yes", "value", json!("sí"))), Err("answer_refused".into()), "a confirm takes a boolean");
    assert_eq!(route(answer("a-sel", "confirmed", json!(true))), Err("answer_refused".into()), "a select never takes a boolean");
    assert!(link.sent().is_empty(), "nothing invalid reaches the daemon");
    // the settings window may never answer
    assert_eq!(
        host.route(&link, "settings", &parse_command(&answer("a-sel", "value", json!("dev"))).unwrap(), T0).map_err(|e| e.code),
        Err("answer_refused".into())
    );
    assert!(link.sent().is_empty());
    // answered once: the double click is refused before the wire
    assert!(route(answer("a-sel", "value", json!("dev"))).is_ok());
    assert_eq!(route(answer("a-sel", "value", json!("main"))), Err("ask_answered".into()));
    assert_eq!(route(answer("a-sel", "cancelled", json!(true))), Err("ask_answered".into()));
    assert_eq!(link.sent().len(), 1);
    // the daemon resolves it (answered here, by another client or expired): the card goes away
    link.frame(json!({"type":"ask_resolved","id":"a-sel"}));
    let ids: Vec<Value> = host.project(&link.view(), T0)["asks"].as_array().unwrap().iter().map(|a| a["id"].clone()).collect();
    assert_eq!(ids, [json!("a-yes"), json!("a-txt")]);
    assert_eq!(route(answer("a-sel", "value", json!("dev"))), Err("ask_closed".into()));
    // offline: nothing to answer
    assert_eq!(
        host.route(&FakeLink::offline(), "main", &parse_command(&answer("a-yes", "confirmed", json!(true))).unwrap(), T0).map_err(|e| e.code),
        Err("ask_closed".into())
    );
}

/// U4b R7: the answer spends the reserved send budget: a chat whose reads used up their share
/// can still answer the agent's question.
#[test]
fn chathost_u4b_an_answer_goes_through_when_reads_spent_their_share() {
    use crate::chat::parse_command;
    let link = asking_link();
    let reads = (CHAT_FRAMES_PER_MINUTE - CHAT_FRAMES_RESERVED) as usize;
    for _ in 0..reads {
        link.command("main", &json!({"action":"chat_status"})).unwrap();
    }
    assert!(link.command("main", &json!({"action":"chat_status"})).is_err(), "the read share is spent");
    let host = ChatHost::new();
    assert!(host.route(&link, "main", &parse_command(&answer("a-yes", "confirmed", json!(true))).unwrap(), T0).is_ok());
}

/// U4b R8: the user's typed answer travels verbatim: never white-labelled, never rewritten.
#[test]
fn chathost_u4b_the_typed_answer_is_sent_verbatim() {
    use crate::chat::parse_command;
    let link = asking_link();
    let typed = "mi Raspberry Pi con engram y Gentle Shell\nsegunda línea\t😀";
    ChatHost::new().route(&link, "main", &parse_command(&answer("a-txt", "value", json!(typed))).unwrap(), T0).unwrap();
    assert_eq!(link.sent(), vec![ChatCommand::UiResponse { ask_id: "a-txt".into(), answer: ChatAnswer::Value(typed.into()) }]);
}

/// U4b verifier F2: chat:state names the asks whose answer from THIS island the daemon accepted
/// (`answered_asks`), so the page shows an outcome only for those; an ask resolved without it
/// (expired, answered elsewhere, engine restart) or refused `unknown_ask` is not named. Offline:
/// none.
#[test]
fn chathost_u4b_the_projection_names_only_the_answers_the_daemon_accepted() {
    use crate::chat::parse_command;
    let link = asking_link();
    let host = ChatHost::new();
    assert_eq!(host.project(&link.view(), T0)["answered_asks"], json!([]));
    host.route(&link, "main", &parse_command(&answer("a-sel", "value", json!("dev"))).unwrap(), T0).unwrap();
    link.frame(json!({"type":"ask_resolved","id":"a-sel"}));
    link.frame(json!({"type":"ask_resolved","id":"a-yes"})); // expired / answered elsewhere
    host.route(&link, "main", &parse_command(&answer("a-txt", "value", json!("Ana"))).unwrap(), T0).unwrap();
    link.frame(json!({"type":"error","code":"unknown_ask"}));
    let v = host.project(&link.view(), T0);
    assert_eq!(v["answered_asks"], json!(["a-sel"]));
    assert_eq!(v["asks"], json!([]));
    assert_eq!(host.project(&FakeLink::offline().view(), T0)["answered_asks"], json!([]));
}

// ---- K2-05 attachments (L11 2a): upload to the daemon, send by its ids, chips on the turn ----

/// A daemon that stores every upload: answers the last chunk with `uploaded` and an id it issues.
fn storing_link() -> FakeLink {
    FakeLink::answering(|cmd| match cmd {
        ChatCommand::Upload { request_id, name, size, offset, data } => {
            let got = base64_len(data);
            if offset + got < *size {
                return vec![];
            }
            let id = format!("a-{:016x}", request_id.len() as u64 * 7 + *size);
            vec![json!({"type":"uploaded","requestId":request_id,"attachment":{"id":id,"name":name,"size":size,"mime":"image/png"}})]
        }
        _ => vec![],
    })
}

fn base64_len(data: &str) -> u64 {
    let pad = data.bytes().rev().take_while(|b| *b == b'=').count();
    (data.len() / 4 * 3 - pad) as u64
}

#[test]
fn chathost_attachments_a_file_goes_to_the_daemon_in_chunks_and_comes_back_as_its_id() {
    let link = storing_link();
    let host = ChatHost::new();
    let bytes = vec![7u8; UPLOAD_CHUNK_BYTES * 2 + 10];
    let got = host.upload(&link, "main", "../../informe.png", &bytes, 2_000).unwrap();
    assert_eq!(got["name"], json!("informe.png"), "only the last segment is ever sent as a name");
    assert_eq!(got["size"], json!(bytes.len()));
    assert!(got["id"].as_str().is_some_and(|i| i.starts_with("a-")));
    let chunks: Vec<(u64, usize)> = link.sent().iter().filter_map(|c| match c {
        ChatCommand::Upload { offset, data, .. } => Some((*offset, data.len())),
        _ => None,
    }).collect();
    assert_eq!(chunks.len(), 3);
    assert_eq!(chunks.iter().map(|c| c.0).collect::<Vec<_>>(), vec![0, UPLOAD_CHUNK_BYTES as u64, 2 * UPLOAD_CHUNK_BYTES as u64]);
    assert!(chunks.iter().all(|c| c.1 <= MAX_UPLOAD_CHUNK_CHARS));
    // the island checks the daemon's size bound first: nothing reaches the wire
    let before = link.sent().len();
    let big = vec![0u8; MAX_UPLOAD_FILE_BYTES + 1];
    let err = host.upload(&link, "main", "grande.bin", &big, 50).unwrap_err();
    assert_eq!(err.code, "file_too_large");
    assert!(err.safe_message.contains("25 MB"), "{}", err.safe_message);
    assert_eq!(link.sent().len(), before);
}

#[test]
fn chathost_attachments_daemon_refusals_are_spanish_and_settings_cannot_upload() {
    let link = FakeLink::answering(|cmd| match cmd {
        ChatCommand::Upload { request_id, .. } => vec![json!({"type":"error","code":"too_many_files","requestId":request_id})],
        _ => vec![],
    });
    let host = ChatHost::new();
    let err = host.upload(&link, "main", "x.txt", b"hola", 2_000).unwrap_err();
    assert_eq!(err.code, "too_many_files");
    assert!(err.safe_message.starts_with("Demasiados archivos"), "{}", err.safe_message);
    // the limit the user hits on the page (chat.js ATTACH_MAX, chat.rs MAX_ATTACHMENTS_PER_TURN), never another number
    assert!(err.safe_message.contains("hasta 5 por mensaje"), "{}", err.safe_message);
    assert!(!err.safe_message.contains("10"), "{}", err.safe_message);
    assert_eq!(host.upload(&link, "settings", "x.txt", b"hola", 50).unwrap_err().code, "send_refused");
    // no answer within the wait: a plain Spanish failure, never a hang
    let silent = FakeLink::new();
    assert_eq!(host.upload(&silent, "main", "x.txt", b"hola", 50).unwrap_err().code, "upload_failed");
    assert_eq!(host.upload(&FakeLink::offline(), "main", "x.txt", b"hola", 50).unwrap_err().code, "engine_unavailable");
}

#[test]
fn chathost_attachments_submit_carries_the_ids_and_the_turn_shows_the_chips() {
    let link = storing_link();
    let host = ChatHost::new();
    let file = host.upload(&link, "main", "foto.png", b"PNGDATA", 2_000).unwrap();
    let id = file["id"].as_str().unwrap().to_owned();
    let cmd = Command::Submit { text: "mirá".into(), client_request_id: "req-00000001".into(), attachments: vec![id.clone()] };
    host.route(&link, "main", &cmd, T0).unwrap();
    let send = link.sent().into_iter().rev().find(|c| matches!(c, ChatCommand::Send { .. })).unwrap();
    assert!(send.line().contains(&format!("\"attachments\":[\"{id}\"]")), "{}", send.line());
    let turn = last_turn(&host.project(&link.view(), T0));
    assert_eq!(turn["attachments"], json!([{"name":"foto.png","size":7,"mime":"image/png"}]));
    // files only: an empty text is a valid message
    link.frame(json!({"type":"agent_state","busy":false,"status":"ready","paused":false}));
    let host2 = ChatHost::new();
    let file2 = host2.upload(&link, "main", "solo.png", b"PNG", 2_000).unwrap();
    let only = Command::Submit { text: "".into(), client_request_id: "req-00000002".into(), attachments: vec![file2["id"].as_str().unwrap().to_owned()] };
    host2.route(&link, "main", &only, T0).unwrap();
    assert!(link.sent().last().unwrap().line().starts_with("{\"type\":\"send\",\"text\":\"\""));
    // without files an empty text is still refused
    assert!(host2.route(&link, "main", &submit("  ", "req-00000003"), T0 + 10_000).is_err());
}

#[test]
fn chathost_attachments_a_resend_after_the_daemon_refused_shows_the_chips_again() {
    let link = storing_link();
    let host = ChatHost::new();
    let file = host.upload(&link, "main", "foto.png", b"PNGDATA", 2_000).unwrap();
    let id = file["id"].as_str().unwrap().to_owned();
    let chip = json!([{"name":"foto.png","size":7,"mime":"image/png"}]);
    let with_file = |req: &str| Command::Submit { text: "mirá".into(), client_request_id: req.into(), attachments: vec![id.clone()] };
    host.route(&link, "main", &with_file("req-0000a001"), T0).unwrap();
    // the daemon refused the send (it never consumed the file): the errored row keeps its chips
    let rid = wire_request_id(link.sent().iter().rev().find(|c| matches!(c, ChatCommand::Send { .. })).unwrap()).unwrap();
    link.frame(json!({"type":"error","code":"busy","requestId":rid}));
    let refused = last_turn(&host.project(&link.view(), T0 + 10));
    assert_eq!(refused["state"], json!("error"));
    assert_eq!(refused["attachments"], chip);
    // the user resends the same files: the live row shows them again
    host.route(&link, "main", &with_file("req-0000a002"), T0 + 20).unwrap();
    let resent = last_turn(&host.project(&link.view(), T0 + 30));
    assert_ne!(resent["turn_id"], refused["turn_id"]);
    assert_eq!(resent["attachments"], chip, "{resent}");
}

#[test]
fn chathost_attachments_history_turns_show_their_chips_after_reload() {
    let link = FakeLink::new();
    link.frame(json!({"type":"history","hasEarlier":false,"messages":[
        {"id":"s0-1","role":"user","text":"mirá","activities":[],"attachments":[{"name":"foto.png","size":12,"mime":"image/png"}]},
        {"id":"s0-2","role":"assistant","text":"listo","activities":[]},
    ]}));
    let turn = last_turn(&ChatHost::new().project(&link.view(), T0));
    assert_eq!(turn["user_text"], json!("mirá"));
    assert_eq!(turn["attachments"], json!([{"name":"foto.png","size":12,"mime":"image/png"}]));
}

#[test]
fn chathost_attachments_discard_removes_an_unsent_file_on_the_daemon() {
    let link = storing_link();
    let host = ChatHost::new();
    let id = host.upload(&link, "main", "x.png", b"P", 2_000).unwrap()["id"].as_str().unwrap().to_owned();
    host.route(&link, "main", &Command::Discard { id: id.clone() }, T0).unwrap();
    assert_eq!(link.sent().last().unwrap().line(), format!("{{\"type\":\"upload_discard\",\"id\":\"{id}\"}}\n"));
}

#[test]
fn chathost_attachments_the_glue_never_writes_uploads_island_side() {
    let src = include_str!("chathost.rs");
    assert!(!src.contains("uploads::attach"), "the island never stores an attachment itself");
    assert!(!src.contains("attachments_dir"), "no island-side uploads folder");
    assert!(src.contains("NATIVE_DROPS"), "a dropped path is honoured only from the native drop set");
}

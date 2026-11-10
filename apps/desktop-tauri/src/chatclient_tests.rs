use super::*;
use crate::agentclient::Reason;
use serde_json::json;

// ---- the closed command set (only the main island window may chat) ---------

fn send_payload(text: &str) -> serde_json::Value {
    json!({"action":"chat_send","text":text,"clientRequestId":"c1"})
}

#[test]
fn chat_commands_are_a_closed_exact_set_for_the_main_window() {
    let asks = ChatState::connected();
    let ok = |payload: serde_json::Value| ChatState::connected().command(CHAT_WINDOW_LABEL, &payload);

    let cmd = ok(send_payload("hola Koda")).unwrap();
    assert!(matches!(cmd, ChatCommand::Send { ref text, ref client_request_id } if text == "hola Koda" && client_request_id == "c1"));
    assert_eq!(cmd.line(), "{\"type\":\"send\",\"text\":\"hola Koda\"}\n", "clientRequestId stays local, never on the wire");

    let cmd = ok(json!({"action":"chat_steer","text":"enfócate"})).unwrap();
    assert!(matches!(cmd, ChatCommand::Steer { ref text } if text == "enfócate"));

    let cmd = ok(json!({"action":"chat_abort"})).unwrap();
    assert!(matches!(cmd, ChatCommand::Abort));
    assert_eq!(cmd.line(), "{\"type\":\"abort\"}\n");

    let cmd = ok(json!({"action":"chat_history"})).unwrap();
    assert!(matches!(cmd, ChatCommand::History));
    assert_eq!(cmd.line(), "{\"type\":\"get_history\"}\n");

    let cmd = ok(json!({"action":"chat_earlier","before":"s0-12"})).unwrap();
    assert!(matches!(cmd, ChatCommand::Earlier { ref before } if before == "s0-12"));
    assert_eq!(cmd.line(), "{\"type\":\"get_earlier\",\"before\":\"s0-12\"}\n");

    let cmd = ok(json!({"action":"chat_status"})).unwrap();
    assert!(matches!(cmd, ChatCommand::Status));
    assert_eq!(cmd.line(), "{\"type\":\"status\"}\n");

    // exact limits mirrored from the daemon: 65536 UTF-16 units of text, no more
    let max_text: String = "a".repeat(MAX_TEXT_CHARS);
    assert!(ok(send_payload(&max_text)).is_ok());
    let _ = asks;
}

#[test]
fn chat_commands_refuse_every_wrong_window_and_unknown_verb() {
    let ok = |label: &str, payload: &serde_json::Value| ChatState::connected().command(label, payload);
    let payload = send_payload("hola");
    // the settings window keeps its own connection: it may never chat
    for bad in ["settings", "Settings", "SETTINGS", "settings2", "main2", "main ", " main", "", "nope"] {
        assert!(ok(bad, &payload).is_err(), "{bad:?} must be refused");
    }
    // a closed verb set: everything else is refused locally, before any wire byte
    for bad in [
        json!({"action":"new_conversation"}), // one continuous chat: the island never asks (L3/L10)
        json!({"action":"send","text":"hola"}), // the settings gate's verbs are not chat verbs
        json!({"action":"chat_new"}), json!({"action":"chat"}), json!({"action":"chat_send"}),
        json!({"action":"chat_abort","now":true}), json!({"action":"chat_history","page":2}),
        json!({"action":"chat_status","x":1}),
        json!(null), json!([]), json!("x"), json!({}),
    ] {
        assert!(ok(CHAT_WINDOW_LABEL, &bad).is_err(), "must refuse {bad}");
    }
    // extra keys are refused too (exact key sets)
    for bad in [
        json!({"action":"chat_send","text":"hola","extra":1}),
        json!({"action":"chat_abort","text":"x"}),
        json!({"action":"chat_earlier","before":"s0-1","x":1}),
    ] {
        assert!(ChatState::connected().command(CHAT_WINDOW_LABEL, &bad).is_err(), "must refuse {bad}");
    }
}

#[test]
fn chat_send_mirrors_the_daemon_text_limits() {
    let ok = |payload: serde_json::Value| ChatState::connected().command(CHAT_WINDOW_LABEL, &payload);
    // the daemon measures JS string length (UTF-16 units): 32769 astral chars = 65538 units > 65536
    let crab = "🦀";
    assert_eq!(crab.encode_utf16().count(), 2);
    let over: String = crab.repeat(MAX_TEXT_CHARS / 2 + 1);
    assert!(ok(send_payload(&over)).is_err(), "65538 UTF-16 units must be refused");
    let max: String = crab.repeat(MAX_TEXT_CHARS / 2);
    assert!(ok(send_payload(&max)).is_ok(), "exactly 65536 UTF-16 units is accepted");
    // empty and whitespace-only text never reaches the engine
    for bad in ["", "   ", "\n\t"] {
        assert!(ok(send_payload(bad)).is_err(), "must refuse {bad:?}");
    }
    assert!(ok(json!({"action":"chat_send","text":7})).is_err());
    // a clientRequestId is bounded (it is island-local correlation, never the wire)
    assert!(ok(json!({"action":"chat_send","text":"hola","clientRequestId":""})).is_err());
    assert!(ok(json!({"action":"chat_send","text":"hola","clientRequestId":"a b"})).is_err());
    assert!(ok(json!({"action":"chat_send","text":"hola","clientRequestId":"x".repeat(129)})).is_err());
}

#[test]
fn ui_responses_are_bound_to_a_received_unresolved_ask_and_its_shown_options() {
    let mut st = ChatState::connected();
    st.apply(&json!({"type":"ask","id":"a-1","kind":"select","title":"¿Continuar?","options":["Sí","No"]}));
    st.apply(&json!({"type":"ask","id":"a-2","kind":"confirm","title":"¿Borrar?"}));
    st.apply(&json!({"type":"ask","id":"a-3","kind":"input","title":"Tu nombre"}));

    // select: only a shown option travels, and only for the pending ask
    let cmd = st.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":"a-1","answer":"Sí"})).unwrap();
    assert!(matches!(cmd, ChatCommand::UiResponse { ref ask_id, answer: ChatAnswer::Value(ref v) } if ask_id == "a-1" && v == "Sí"));
    assert_eq!(cmd.line(), "{\"type\":\"ui_response\",\"id\":\"a-1\",\"value\":\"Sí\"}\n");
    // confirm: a closed boolean
    let cmd = st.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":"a-2","answer":true})).unwrap();
    assert!(matches!(cmd, ChatCommand::UiResponse { answer: ChatAnswer::Confirmed(true), .. }));
    assert_eq!(cmd.line(), "{\"type\":\"ui_response\",\"id\":\"a-2\",\"confirmed\":true}\n");
    // input: free text up to the daemon's answer cap
    let long: String = "x".repeat(MAX_ANSWER_CHARS);
    assert!(st.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":"a-3","answer":long})).is_ok());
    assert!(st.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":"a-3","answer":"x".repeat(MAX_ANSWER_CHARS + 1)})).is_err());
    // cancel is always allowed
    let cmd = st.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":"a-1","answer":null})).unwrap();
    assert!(matches!(cmd, ChatCommand::UiResponse { answer: ChatAnswer::Cancelled, .. }));
    assert_eq!(cmd.line(), "{\"type\":\"ui_response\",\"id\":\"a-1\",\"cancelled\":true}\n");

    // an answer for an ask the island never received is refused
    assert!(st.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":"unknown","answer":"Sí"})).is_err());
    // a select answer that was never shown is refused
    assert!(st.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":"a-1","answer":"Tal vez"})).is_err());
    // a confirm ask never takes a text answer
    assert!(st.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":"a-2","answer":"sí"})).is_err());
    assert!(st.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":"a-1","answer":7})).is_err());
    // a resolved ask is gone: fold the resolution, then the same answer is refused
    st.apply(&json!({"type":"ask_resolved","id":"a-1"}));
    assert!(st.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":"a-1","answer":"Sí"})).is_err());
    // the other asks survive one resolution
    assert!(st.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":"a-2","answer":false})).is_ok());
    // a malformed ask frame never registers an askable id
    let mut st2 = ChatState::connected();
    st2.apply(&json!({"type":"ask","id":"bad id!","kind":"select","title":"x","options":["a"]}));
    st2.apply(&json!({"type":"ask","id":"a-9","kind":"radio","title":"x","options":["a"]}));
    assert!(st2.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":"a-9","answer":"a"})).is_err());
}

#[test]
fn get_earlier_requires_a_daemon_page_id() {
    let ok = |payload: serde_json::Value| ChatState::connected().command(CHAT_WINDOW_LABEL, &payload);
    assert!(ok(json!({"action":"chat_earlier","before":"s0-1"})).is_ok());
    assert!(ok(json!({"action":"chat_earlier","before":"s17-2048"})).is_ok());
    for bad in ["s-1", "0-1", "s0-", "s0-x", "s0-1-2", "x0-1", "s0-1 ", " s0-1", "S0-1", "s99999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999-1"] {
        assert!(ok(json!({"action":"chat_earlier","before":bad})).is_err(), "must refuse {bad:?}");
    }
    assert!(ok(json!({"action":"chat_earlier","before":7})).is_err());
    // the canonical rule (`HISTORY_BEFORE` = /^s(0|[1-9]\d*)-(0|[1-9]\d*)$/):
    // no leading zeros anywhere — `s01-2` and `s0-01` never match the daemon's grammar
    for bad in ["s01-2", "s0-01", "s00-0", "s010-1"] {
        assert!(ok(json!({"action":"chat_earlier","before":bad})).is_err(), "must refuse {bad:?}");
    }
    // an id longer than the daemon's 128-char bound is refused
    let long = format!("s0-{}", "1".repeat(MAX_ID_CHARS));
    assert!(ok(json!({"action":"chat_earlier","before":long})).is_err());
}

// ---- frame folding into the allowlisted, serializable view ------------------

fn view(st: &ChatState) -> serde_json::Value {
    serde_json::to_value(st).expect("the view serializes")
}

#[test]
fn deltas_stream_by_message_id_and_done_finalizes_the_message() {
    let mut st = ChatState::connected();
    st.apply(&json!({"type":"message_delta","messageId":"m1","text":"Ho"}));
    st.apply(&json!({"type":"message_delta","messageId":"m1","text":"la"}));
    st.apply(&json!({"type":"message_delta","messageId":"m2","text":"otra"}));
    let v = view(&st);
    let texts: Vec<&str> = v["streaming"].as_array().unwrap().iter().filter_map(|s| s["text"].as_str()).collect();
    assert_eq!(texts, vec!["Hola", "otra"], "streaming text accumulates by message id");
    assert!(v["messages"].as_array().unwrap().is_empty());
    st.apply(&json!({"type":"message_done","messageId":"m1"}));
    let v = view(&st);
    let messages = v["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["id"], json!("m1"));
    assert_eq!(messages[0]["role"], json!("assistant"));
    assert_eq!(messages[0]["text"], json!("Hola"));
    assert_eq!(v["streaming"].as_array().unwrap().len(), 1, "the other stream keeps streaming");
    // a done for an id the island never streamed still lands once, honestly empty
    st.apply(&json!({"type":"message_done","messageId":"m1"}));
    st.apply(&json!({"type":"message_done","messageId":"m3"}));
    let v = view(&st);
    assert_eq!(v["messages"].as_array().unwrap().len(), 2, "a repeated done never duplicates");
    assert_eq!(v["messages"][1]["text"], json!(""));
}

#[test]
fn history_replaces_the_view_and_an_earlier_page_is_kept_whole_and_apart() {
    let mut st = ChatState::connected();
    st.apply(&json!({"type":"history","messages":[
        {"id":"s1-3","role":"assistant","text":"respuesta","activities":[{"id":"t1","kind":"read","title":"leyó notas.md","status":"done"}]},
        {"id":"s1-2","role":"user","text":"pregunta","earlier":true}
    ],"hasEarlier":true}));
    let v = view(&st);
    assert_eq!(v["messages"].as_array().unwrap().len(), 2);
    assert_eq!(v["hasEarlier"], json!(true));
    assert_eq!(v["messages"][0]["activities"][0]["kind"], json!("read"));
    st.apply(&json!({"type":"message_delta","messageId":"m9","text":"en vivo"}));
    // a second history frame REPLACES the view (rotation re-broadcast, a fresh get_history)
    st.apply(&json!({"type":"history","messages":[{"id":"s1-3","role":"assistant","text":"respuesta"}],"hasEarlier":true}));
    let v = view(&st);
    assert_eq!(v["messages"].as_array().unwrap().len(), 1, "history replaces, never appends");
    assert_eq!(v["streaming"].as_array().unwrap().len(), 0, "history replacing the view clears a half-streamed message: it can never finish");

    // Gentle Dot's model: an earlier page never enters the newest view; it is kept whole,
    // with its cursor, for the read that asked for it
    st.apply(&json!({"type":"earlier","before":"s1-3","messages":[
        {"id":"s0-9","role":"user","text":"más viejo","earlier":true}
    ],"hasEarlier":false}));
    let v = view(&st);
    let ids: Vec<&str> = v["messages"].as_array().unwrap().iter().filter_map(|m| m["id"].as_str()).collect();
    assert_eq!(ids, vec!["s1-3"], "the newest view is untouched");
    assert_eq!(v["hasEarlier"], json!(true), "the newest page's flag is untouched");
    assert_eq!(v["earlierPage"]["before"], json!("s1-3"));
    assert_eq!(v["earlierPage"]["messages"][0]["id"], json!("s0-9"));
    assert_eq!(v["earlierPage"]["hasEarlier"], json!(false));
}

#[test]
fn asks_queue_toasts_and_agent_state_fold_into_closed_views() {
    let mut st = ChatState::connected();
    st.apply(&json!({"type":"agent_state","busy":true,"status":"restarting","paused":true}));
    let v = view(&st);
    assert_eq!(v["agent"], json!({"busy":true,"status":"restarting","paused":true}));

    st.apply(&json!({"type":"queue","steering":2,"followUp":1}));
    assert_eq!(view(&st)["queue"], json!({"steering":2,"followUp":1}));

    st.apply(&json!({"type":"toast","level":"warning","message":"La pausa interrumpió el turno del agente."}));
    let v = view(&st);
    assert_eq!(v["toasts"].as_array().unwrap().len(), 1);
    assert_eq!(v["toasts"][0]["level"], json!("warning"));

    st.apply(&json!({"type":"ask","id":"a-1","kind":"select","title":"¿Continuar?","options":["Sí","No"]}));
    let v = view(&st);
    assert_eq!(v["pendingAsk"]["id"], json!("a-1"));
    assert_eq!(v["pendingAsk"]["options"], json!(["Sí","No"]));
    st.apply(&json!({"type":"ask_resolved","id":"a-1"}));
    assert_eq!(view(&st)["pendingAsk"], json!(null));

    // the engine's refusals fold into a closed code plus a counter
    st.apply(&json!({"type":"error","code":"busy"}));
    st.apply(&json!({"type":"error","code":"conversations_off"}));
    st.apply(&json!({"type":"error","code":"made_up"}));
    let v = view(&st);
    assert_eq!(v["lastError"], json!({"code":"failed","n":3}), "an unknown code reads as plain failed, never free text");
}

#[test]
fn live_activities_pair_by_call_id_and_land_on_the_message() {
    let mut st = ChatState::connected();
    st.apply(&json!({"type":"activity","name":"read","state":"running","callId":"t1"}));
    st.apply(&json!({"type":"activity","name":"read","state":"done","callId":"t1"}));
    st.apply(&json!({"type":"message_delta","messageId":"m1","text":"listo"}));
    st.apply(&json!({"type":"message_done","messageId":"m1"}));
    let v = view(&st);
    let activities = v["messages"][0]["activities"].as_array().unwrap();
    assert_eq!(activities.len(), 1, "running pairs into done by callId");
    assert_eq!(activities[0], json!({"id":"t1","kind":"other","title":"read","status":"done"}));
    // an off-vocabulary activity state is dropped, never guessed
    let mut st2 = ChatState::connected();
    st2.apply(&json!({"type":"activity","name":"read","state":"weird","callId":"t2"}));
    st2.apply(&json!({"type":"message_delta","messageId":"m1","text":"x"}));
    st2.apply(&json!({"type":"message_done","messageId":"m1"}));
    assert!(view(&st2)["messages"][0]["activities"].as_array().unwrap().is_empty());
}

#[test]
fn unknown_frames_and_unknown_keys_are_ignored() {
    let mut st = ChatState::connected();
    st.apply(&json!({"type":"conversations","conversations":[{"id":"x"}]}));
    st.apply(&json!({"type":"user_message","messageId":"u1","text":"eco"}));
    st.apply(&json!({"type":"message_delta","messageId":"m1","text":"hola","endpoint":"/evil/socket","token":"sekret","secret":"x"}));
    st.apply(&json!({"type":"history","messages":[],"hasEarlier":false,"token":"sekret","endpoint":"/evil"}));
    let v = view(&st);
    assert_eq!(v["messages"].as_array().unwrap().len(), 0, "the daemon never echoes user messages: the island adds its own");
    assert!(!serde_json::to_string(&st).unwrap().contains("sekret"));
    assert!(!serde_json::to_string(&st).unwrap().contains("/evil"));
}

#[test]
fn the_serialized_view_never_carries_the_token_or_the_endpoint() {
    let mut st = ChatState::connected();
    st.apply(&json!({"type":"agent_state","busy":false,"status":"ready","paused":false}));
    st.apply(&json!({"type":"message_delta","messageId":"m1","text":"texto"}));
    st.apply(&json!({"type":"ask","id":"a-1","kind":"select","title":"t","options":["a"]}));
    st.apply(&json!({"type":"toast","level":"info","message":"m"}));
    st.apply(&json!({"type":"queue","steering":0,"followUp":0}));
    st.apply(&json!({"type":"history","messages":[{"id":"s0-1","role":"user","text":"hola","attachments":[{"name":"f","size":1,"mime":"text/plain"}]}],"hasEarlier":false}));
    let text = serde_json::to_string(&st).unwrap();
    assert!(!text.contains("token"), "{text}");
    assert!(!text.contains("endpoint"), "{text}");
    // the view has no connection details, only a state name
    assert_eq!(view(&st)["connection"], json!("connected"));
    let lost = ChatState::disconnected(Reason::Lost);
    assert_eq!(serde_json::to_value(&lost).unwrap()["connection"], json!("lost"));
}

#[test]
fn the_view_stays_bounded() {
    let mut st = ChatState::connected();
    // a single over-long history page is clipped to the daemon's page bound (100)
    let messages: Vec<Value> = (0..150).map(|i| json!({"id":format!("s0-{i}"),"role":"user","text":"x"})).collect();
    st.apply(&json!({"type":"history","messages":messages,"hasEarlier":false}));
    assert_eq!(view(&st)["messages"].as_array().unwrap().len(), 100);

    // finished messages accumulate with a bound: the oldest fall off
    for i in 0..(MAX_MESSAGES + 10) {
        st.apply(&json!({"type":"message_done","messageId":format!("m{i}")}));
    }
    let v = view(&st);
    assert_eq!(v["messages"].as_array().unwrap().len(), MAX_MESSAGES, "the accumulated view is bounded");
    assert_eq!(v["messages"][0]["id"], json!("m10"), "the oldest messages fell off");

    // toasts are bounded
    for i in 0..(MAX_TOASTS + 10) {
        st.apply(&json!({"type":"toast","level":"info","message":format!("t{i}")}));
    }
    let toasts = view(&st)["toasts"].as_array().unwrap().clone();
    assert_eq!(toasts.len(), MAX_TOASTS);
    assert_eq!(toasts.last().unwrap()["message"], json!(format!("t{}", MAX_TOASTS + 9)), "the newest toasts survive");

    // streaming never grows past its bound (a defensive memory guard, not a semantic limit)
    for i in 0..(MAX_STREAM_MESSAGES + 10) {
        st.apply(&json!({"type":"message_delta","messageId":format!("m{i}"),"text":"x"}));
    }
    assert_eq!(view(&st)["streaming"].as_array().unwrap().len(), MAX_STREAM_MESSAGES);

    // one message's streamed text is bounded
    let mut st2 = ChatState::connected();
    let chunk = "x".repeat(MAX_STREAM_CHARS / 2);
    st2.apply(&json!({"type":"message_delta","messageId":"m1","text":chunk}));
    st2.apply(&json!({"type":"message_delta","messageId":"m1","text":chunk}));
    assert_eq!(view(&st2)["streaming"][0]["text"].as_str().unwrap().encode_utf16().count(), MAX_STREAM_CHARS);

    // long text is clipped to the daemon's 64 KiB ceiling, never splitting a surrogate
    let mut st3 = ChatState::connected();
    let crab = "🦀";
    let long: String = crab.repeat(MAX_TEXT_CHARS); // 128 KiB UTF-16 units
    st3.apply(&json!({"type":"history","messages":[{"id":"s0-1","role":"assistant","text":long}],"hasEarlier":false}));
    let text = view(&st3)["messages"][0]["text"].as_str().unwrap().to_string();
    assert_eq!(text.encode_utf16().count(), MAX_TEXT_CHARS);
    assert!(text.ends_with(crab), "the clip never leaves half a surrogate pair");
    // pending asks are bounded too
    let mut st4 = ChatState::connected();
    for i in 0..(MAX_ASKS + 5) {
        st4.apply(&json!({"type":"ask","id":format!("a-{i}"),"kind":"input","title":"t"}));
    }
    assert_eq!(st4.asks().len(), MAX_ASKS);
    assert!(st4.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":format!("a-{}", MAX_ASKS + 4),"answer":"x"})).is_err(), "an ask past the bound never registers");
}

// ---- K2-05 verifier findings: the island-side fixes ----------------------------------------

#[test]
fn an_earlier_page_without_a_cursor_is_ignored_and_never_reaches_the_newest_view() {
    let mut st = ChatState::connected();
    st.apply(&json!({"type":"history","messages":[{"id":"s0-5","role":"user","text":"nueva"}],"hasEarlier":true}));
    let before = st.revision();
    for frame in [
        json!({"type":"earlier","messages":[{"id":"s0-1","role":"user","text":"vieja"}],"hasEarlier":false}),
        json!({"type":"earlier","before":"m1","messages":[{"id":"s0-1","role":"user","text":"vieja"}],"hasEarlier":false}),
    ] {
        st.apply(&frame);
    }
    assert_eq!(st.revision(), before, "no cursor, no page");
    let v = view(&st);
    assert_eq!(v["earlierPage"], json!(null));
    assert_eq!(v["messages"].as_array().unwrap().len(), 1, "the newest view is untouched");
}

#[test]
fn history_reads_never_spend_the_budget_reserved_for_send_and_abort() {
    let st = ChatState::connected();
    let ok = |payload: serde_json::Value| st.command(CHAT_WINDOW_LABEL, &payload);
    let reads = CHAT_FRAMES_PER_MINUTE - CHAT_FRAMES_RESERVED;
    for i in 0..reads {
        assert!(ok(json!({"action":"chat_earlier","before":format!("s0-{}", i + 1)})).is_ok(), "read {i}");
    }
    for read in [json!({"action":"chat_earlier","before":"s0-1"}), json!({"action":"chat_history"}), json!({"action":"chat_status"})] {
        assert!(ok(read.clone()).is_err(), "paging stops short of the reserve: {read}");
    }
    assert!(ok(json!({"action":"chat_send","text":"hola","clientRequestId":"req-00000001"})).is_ok(), "a send still goes through");
    for _ in 1..CHAT_FRAMES_RESERVED {
        assert!(ok(json!({"action":"chat_abort"})).is_ok());
    }
    assert!(ok(json!({"action":"chat_abort"})).is_err(), "the whole budget stays bounded");
}

#[test]
fn ready_and_stopped_engine_states_clear_half_streamed_messages() {
    let mut st = ChatState::connected();
    st.apply(&json!({"type":"message_delta","messageId":"m1","text":"a medias"}));
    // the daemon's `ready` carries the agent state at handshake time: it folds like agent_state
    st.apply(&json!({"type":"ready","protocol":"island-agent/1","state":{"busy":false,"status":"starting","paused":false}}));
    assert_eq!(view(&st)["agent"], json!({"busy":false,"status":"starting","paused":false}));
    assert_eq!(view(&st)["streaming"].as_array().unwrap().len(), 1, "a live turn keeps streaming while the engine runs");
    // the engine stops: a half-streamed message can never finish, drop it honestly
    st.apply(&json!({"type":"agent_state","busy":false,"status":"stopped","paused":false}));
    assert_eq!(view(&st)["streaming"].as_array().unwrap().len(), 0);
    st.apply(&json!({"type":"message_delta","messageId":"m2","text":"otra"}));
    st.apply(&json!({"type":"agent_state","busy":false,"status":"restarting","paused":false}));
    assert_eq!(view(&st)["streaming"].as_array().unwrap().len(), 0, "a restart drops the half stream too");
    // a normal agent_state keeps streaming
    st.apply(&json!({"type":"message_delta","messageId":"m3","text":"tercera"}));
    st.apply(&json!({"type":"agent_state","busy":true,"status":"ready","paused":false}));
    assert_eq!(view(&st)["streaming"].as_array().unwrap().len(), 1);
    // and history replacing the view clears half streams as well
    st.apply(&json!({"type":"history","messages":[{"id":"s0-1","role":"user","text":"hola"}],"hasEarlier":false}));
    assert_eq!(view(&st)["streaming"].as_array().unwrap().len(), 0);
}

#[test]
fn history_rows_keep_the_earlier_and_clipped_flags() {
    let mut st = ChatState::connected();
    st.apply(&json!({"type":"history","messages":[
        {"id":"s0-1","role":"user","text":"hola","earlier":true},
        {"id":"s0-2","role":"assistant","text":"respuesta muy larga…","clipped":true}
    ],"hasEarlier":true}));
    let messages = view(&st)["messages"].as_array().unwrap().clone();
    assert_eq!(messages[0]["earlier"], json!(true), "the daemon's earlier flag travels to the UI");
    assert_eq!(messages[1]["clipped"], json!(true), "the daemon's clipped flag travels to the UI");
    // off-vocabulary flags never appear (booleans only)
    st.apply(&json!({"type":"history","messages":[{"id":"s0-3","role":"user","text":"x","earlier":"yes","clipped":1}],"hasEarlier":false}));
    let m = view(&st)["messages"][0].clone();
    assert!(m.get("earlier").is_none() && m.get("clipped").is_none(), "only the true booleans are allowlisted: {m}");
}

#[test]
fn live_tool_statuses_use_the_daemons_one_closed_vocabulary() {
    let mut st = ChatState::connected();
    // the daemon's live activity frames say `error`; its history rows say `failed`.
    // The view has ONE closed set (running/done/failed, historyMessageDto): no split.
    st.apply(&json!({"type":"activity","name":"run","state":"running","callId":"t1"}));
    st.apply(&json!({"type":"activity","name":"run","state":"error","callId":"t1"}));
    st.apply(&json!({"type":"activity","name":"read","state":"running","callId":"t2"}));
    st.apply(&json!({"type":"activity","name":"read","state":"failed","callId":"t2"}));
    st.apply(&json!({"type":"message_done","messageId":"m1"}));
    let activities = view(&st)["messages"][0]["activities"].as_array().unwrap().clone();
    assert_eq!(activities.len(), 2, "both live activities paired and landed");
    assert_eq!(activities[0], json!({"id":"t1","kind":"other","title":"run","status":"failed"}), "one closed status set, no error-vs-failed split");
    assert_eq!(activities[1], json!({"id":"t2","kind":"other","title":"read","status":"failed"}));
    // an off-vocabulary activity state is still dropped, never guessed
    let mut st2 = ChatState::connected();
    st2.apply(&json!({"type":"activity","name":"read","state":"weird","callId":"t2"}));
    st2.apply(&json!({"type":"message_done","messageId":"m9"}));
    assert!(view(&st2)["messages"][0]["activities"].as_array().unwrap().is_empty());
}

#[test]
fn a_line_the_daemon_would_drop_is_refused_by_the_island() {
    let ok = |payload: serde_json::Value| ChatState::connected().command(CHAT_WINDOW_LABEL, &payload);
    // 60,001 control characters: within the 64 Ki UTF-16 text cap, but 6 bytes each on the
    // wire once JSON-escaped — far over the daemon's 256 KiB inbound line bound, whose
    // excess the daemon answers by KILLING the connection. The island refuses locally.
    let bell: String = "\u{7}".repeat(60_001);
    assert!(ok(send_payload(&bell)).is_err(), "the serialized client line must be measured in bytes and refused");
    // ordinary text of the same UTF-16 length travels fine
    let plain: String = "a".repeat(60_001);
    assert!(ok(send_payload(&plain)).is_ok());
}

#[test]
fn ui_response_answers_with_the_exact_option_string_received() {
    let mut st = ChatState::connected();
    // control characters are stripped for DISPLAY only; the answer must carry the exact
    // string the ask frame had — the daemon matches its pending ask against what it sent
    st.apply(&json!({"type":"ask","id":"a-1","kind":"select","title":"¿Seguir?","options":["Sí\u{7}","No"]}));
    let v = view(&st);
    assert_eq!(v["pendingAsk"]["options"], json!(["Sí", "No"]), "the shown options are display-clean");
    // the page answers the shown label; the wire carries the exact string the frame received
    let cmd = st.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":"a-1","answer":"Sí"})).unwrap();
    assert_eq!(cmd.line(), "{\"type\":\"ui_response\",\"id\":\"a-1\",\"value\":\"Sí\\u0007\"}\n");
    // an unaltered option answers as itself
    let cmd = st.command(CHAT_WINDOW_LABEL, &json!({"action":"chat_ui_response","askId":"a-1","answer":"No"})).unwrap();
    assert_eq!(cmd.line(), "{\"type\":\"ui_response\",\"id\":\"a-1\",\"value\":\"No\"}\n");
}

#[test]
fn chat_commands_are_rate_limited_well_below_the_daemons_frame_drop() {
    let st = ChatState::connected();
    let ok = |payload: serde_json::Value| st.command(CHAT_WINDOW_LABEL, &payload);
    for i in 0..CHAT_FRAMES_PER_MINUTE {
        assert!(ok(json!({"action":"chat_abort"})).is_ok(), "command {i} within the island's own limit");
    }
    assert!(ok(json!({"action":"chat_abort"})).is_err(), "one more command trips the island's own limit, never the daemon's 240/min drop");
    // a fresh window lets the page chat again
    st.rate_window.set(None);
    assert!(ok(json!({"action":"chat_abort"})).is_ok());
    // refused commands are never sent: they consume no budget
    assert!(ok(json!({"action":"chat_send","text":""})).is_err());
    st.rate_window.set(None);
    assert!(ok(json!({"action":"chat_abort"})).is_ok(), "a refused command consumed no budget");
}

// ---- transport: a second connection for chat (unix round trip) --------------

#[cfg(unix)]
mod round_trip {
    use super::*;
    use crate::agentconn::ChatConn;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    static N: AtomicU64 = AtomicU64::new(0);

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    fn wait_for(conn: &ChatConn, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            let v = conn.view();
            if pred(&v) { return v; }
            assert!(Instant::now() < end, "timed out waiting for {what}; last view: {v}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// A fake daemon: reads LF frames, answers the scripted sequence, and records
    /// every line it received so the test can assert what actually traveled.
    fn fake_daemon(listener: UnixListener, received: std::sync::mpsc::Sender<String>) {
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            // 1. the handshake: hello with the token, then `ready`
            reader.read_line(&mut line).expect("hello");
            assert!(line.contains("\"type\":\"hello\"") && line.contains("t0k3n"), "hello must carry the token: {line}");
            let _ = received.send(line.trim().to_string());
            stream.write_all(b"{\"type\":\"ready\",\"seq\":1,\"state\":{\"busy\":false,\"status\":\"ready\",\"paused\":false},\"features\":{\"history\":true,\"conversations\":false}}\n").unwrap();
            // 2. command loop
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {
                        let _ = received.send(line.trim().to_string());
                        let frame: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
                        match frame.get("type").and_then(Value::as_str) {
                            Some("get_history") => {
                                stream.write_all(b"{\"type\":\"history\",\"seq\":2,\"messages\":[{\"id\":\"s0-1\",\"role\":\"user\",\"text\":\"hola anterior\"}],\"hasEarlier\":true}\n").unwrap();
                            }
                            Some("send") => {
                                stream.write_all(b"{\"type\":\"message_delta\",\"seq\":3,\"messageId\":\"m1\",\"text\":\"Ho\"}\n").unwrap();
                                stream.write_all(b"{\"type\":\"message_delta\",\"seq\":4,\"messageId\":\"m1\",\"text\":\"la\"}\n").unwrap();
                                stream.write_all(b"{\"type\":\"message_done\",\"seq\":5,\"messageId\":\"m1\"}\n").unwrap();
                                stream.write_all(b"{\"type\":\"agent_state\",\"seq\":6,\"busy\":false,\"status\":\"ready\",\"paused\":false}\n").unwrap();
                                stream.write_all(format!("{{\"type\":\"ask\",\"seq\":7,\"id\":\"a-1\",\"kind\":\"select\",\"title\":\"¿Seguir?\",\"options\":[\"Sí\",\"No\"]}}\n").as_bytes()).unwrap();
                            }
                            Some("ui_response") => {
                                stream.write_all(b"{\"type\":\"ask_resolved\",\"seq\":8,\"id\":\"a-1\"}\n").unwrap();
                            }
                            _ => {}
                        }
                    }
                }
            }
        });
    }

    #[test]
    fn a_fake_daemon_round_trip_handshakes_sends_and_folds() {
        let dir = std::env::temp_dir().join(format!("abito-chatclient-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(dir.join("runtime/p-AbCdEf")).unwrap();
        std::fs::set_permissions(dir.join("runtime"), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(dir.join("runtime/p-AbCdEf"), std::fs::Permissions::from_mode(0o700)).unwrap();
        let _tidy = Tmp(dir.clone());

        let endpoint = dir.join("runtime/p-AbCdEf/s");
        let listener = UnixListener::bind(&endpoint).expect("fake socket");
        let session = json!({"protocol":"island-agent/1","endpoint":endpoint.to_str().unwrap(),"token":"t0k3n","pid":std::process::id()});
        let session_path = dir.join("runtime/session.json");
        std::fs::write(&session_path, session.to_string()).unwrap();
        std::fs::set_permissions(&session_path, std::fs::Permissions::from_mode(0o600)).unwrap();

        let (tx, rx) = std::sync::mpsc::channel::<String>();
        fake_daemon(listener, tx);

        let conn = ChatConn::new(|_| {});
        conn.connect(&dir);
        wait_for(&conn, "connected", |v| v["connection"] == json!("connected"));
        // the late client asks get_history once it has handshook; the fold replaces the view
        let v = wait_for(&conn, "history", |v| v["messages"].as_array().is_some_and(|m| !m.is_empty()));
        assert_eq!(v["messages"][0]["text"], json!("hola anterior"));
        assert_eq!(v["hasEarlier"], json!(true));

        // only the main window may chat
        assert!(conn.command("settings", &json!({"action":"chat_send","text":"hola"})).is_err());
        assert!(conn.command("main", &json!({"action":"chat_new"})).is_err());

        // send → the fold turns deltas + done into one assistant message
        conn.command("main", &json!({"action":"chat_send","text":"hola Koda","clientRequestId":"c1"})).unwrap();
        let v = wait_for(&conn, "assistant message", |v| v["messages"].as_array().is_some_and(|m| m.iter().any(|x| x["role"] == json!("assistant"))));
        let answer = v["messages"].as_array().unwrap().iter().find(|x| x["role"] == json!("assistant")).unwrap();
        assert_eq!(answer["text"], json!("Hola"));
        assert_eq!(v["agent"]["status"], json!("ready"));

        // the pending ask answers and resolves
        wait_for(&conn, "ask", |v| v["pendingAsk"]["id"] == json!("a-1"));
        conn.command("main", &json!({"action":"chat_ui_response","askId":"a-1","answer":"Sí"})).unwrap();
        wait_for(&conn, "ask resolved", |v| v["pendingAsk"] == json!(null));

        // what actually traveled on the wire
        let lines: Vec<String> = rx.try_iter().collect();
        assert!(lines.iter().any(|l| l.contains("\"type\":\"send\",\"text\":\"hola Koda\"")), "the send line: {lines:?}");
        assert!(lines.iter().any(|l| l.contains("\"type\":\"get_earlier\"") == false && l.contains("\"type\":\"get_history\"")), "history was requested on connect");
        assert!(lines.iter().any(|l| l.contains("\"type\":\"ui_response\"") && l.contains("\"value\":\"Sí\"")));
        assert!(!lines.iter().any(|l| l.contains("clientRequestId")), "the correlation id never travels");

        // the view never carries the token or the endpoint
        let text = serde_json::to_string(&conn.view()).unwrap();
        assert!(!text.contains("t0k3n") && !text.contains("p-AbCdEf"), "the chat view never leaks session material: {text}");

        conn.close();
    }

    /// A fresh island dir with a session.json pointing at a freshly bound socket.
    fn island_dir(tag: &str) -> (PathBuf, UnixListener) {
        let dir = std::env::temp_dir().join(format!("abito-chatclient-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let leaf = format!("p-AbCdE{tag}");
        std::fs::create_dir_all(dir.join("runtime").join(&leaf)).unwrap();
        std::fs::set_permissions(dir.join("runtime"), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(dir.join("runtime").join(&leaf), std::fs::Permissions::from_mode(0o700)).unwrap();
        let endpoint = dir.join("runtime").join(&leaf).join("s");
        let listener = UnixListener::bind(&endpoint).expect("fake socket");
        let session = json!({"protocol":"island-agent/1","endpoint":endpoint.to_str().unwrap(),"token":"t0k3n","pid":std::process::id()});
        let session_path = dir.join("runtime/session.json");
        std::fs::write(&session_path, session.to_string()).unwrap();
        std::fs::set_permissions(&session_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        (dir, listener)
    }

    /// The verifier's connect shape: `ready`, the pending ask and the history page
    /// travel in ONE write — every complete line after `ready` must reach the fold.
    fn fake_daemon_burst(listener: UnixListener, received: std::sync::mpsc::Sender<String>) {
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).expect("hello");
            let _ = received.send(line.trim().to_string());
            stream.write_all(concat!(
                "{\"type\":\"ready\",\"seq\":1,\"state\":{\"busy\":false,\"status\":\"ready\",\"paused\":false},\"features\":{\"history\":true,\"conversations\":false}}\n",
                "{\"type\":\"ask\",\"seq\":2,\"id\":\"a-9\",\"kind\":\"confirm\",\"title\":\"¿Seguir?\"}\n",
                "{\"type\":\"history\",\"seq\":3,\"messages\":[{\"id\":\"s0-1\",\"role\":\"user\",\"text\":\"hola anterior\"}],\"hasEarlier\":true}\n",
            ).as_bytes()).unwrap();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => { let _ = received.send(line.trim().to_string()); }
                }
            }
        });
    }

    #[test]
    fn ready_and_later_frames_in_one_write_all_reach_the_view() {
        let (dir, listener) = island_dir("1");
        let _tidy = Tmp(dir.clone());
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        fake_daemon_burst(listener, tx);
        let conn = ChatConn::new(|_| {});
        conn.connect(&dir);
        // the ask that arrived in the same read as `ready` is registered and answerable
        wait_for(&conn, "pending ask from the burst", |v| v["pendingAsk"]["id"] == json!("a-9"));
        // the history page of the same burst folded too
        let v = wait_for(&conn, "history from the burst", |v| v["messages"].as_array().is_some_and(|m| !m.is_empty()));
        assert_eq!(v["messages"][0]["text"], json!("hola anterior"));
        // the agent status the `ready` frame carried folded as well
        assert_eq!(v["agent"]["status"], json!("ready"));
        // connect requested the newest history AND the agent status
        let lines: Vec<String> = rx.try_iter().collect();
        assert!(lines.iter().any(|l| l.contains("\"type\":\"get_history\"")), "{lines:?}");
        assert!(lines.iter().any(|l| l.contains("\"type\":\"status\"")), "status is requested on connect: {lines:?}");
        conn.close();
    }

    /// After the handshake the daemon sends one line over the island's 256 KiB reader
    /// bound (a hooks broadcast up to the daemon's own 1 MiB history bound), one
    /// malformed line, and then a frame that must still arrive.
    fn fake_daemon_noisy(listener: UnixListener, received: std::sync::mpsc::Sender<String>) {
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).expect("hello");
            let _ = received.send(line.trim().to_string());
            stream.write_all(b"{\"type\":\"ready\",\"seq\":1,\"state\":{\"busy\":false,\"status\":\"ready\",\"paused\":false},\"features\":{\"history\":true,\"conversations\":false}}\n").unwrap();
            std::thread::sleep(Duration::from_millis(80));
            let mut oversized = vec![b'x'; 280 * 1024];
            oversized.push(b'\n');
            let _ = stream.write_all(&oversized);
            let _ = stream.write_all(b"not json at all\n");
            let _ = stream.write_all(b"{\"type\":\"agent_state\",\"seq\":2,\"busy\":true,\"status\":\"starting\",\"paused\":false}\n");
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => { let _ = received.send(line.trim().to_string()); }
                }
            }
        });
    }

    #[test]
    fn oversized_and_malformed_lines_never_end_the_connection() {
        let (dir, listener) = island_dir("2");
        let _tidy = Tmp(dir.clone());
        let (tx, _rx) = std::sync::mpsc::channel::<String>();
        fake_daemon_noisy(listener, tx);
        let conn = ChatConn::new(|_| {});
        conn.connect(&dir);
        wait_for(&conn, "connected", |v| v["connection"] == json!("connected"));
        // the valid frame after the noise still folds
        let v = wait_for(&conn, "agent_state after the noise", |v| v["agent"]["busy"] == json!(true));
        assert_eq!(v["agent"]["status"], json!("starting"));
        // the connection is still up: a command travels, the view stays connected
        conn.command("main", &json!({"action":"chat_status"})).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(conn.view()["connection"], json!("connected"), "the connection survived oversized and malformed lines");
        conn.close();
    }

    /// Two identical `agent_state` frames, far enough apart to land in separate reads:
    /// the second must not emit the view again — bursts coalesce, unchanged folds don't.
    fn fake_daemon_echo_state(listener: UnixListener) {
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).expect("hello");
            stream.write_all(b"{\"type\":\"ready\",\"seq\":1,\"state\":{\"busy\":false,\"status\":\"ready\",\"paused\":false},\"features\":{\"history\":true,\"conversations\":false}}\n").unwrap();
            let state_frame = |seq: u64| format!("{{\"type\":\"agent_state\",\"seq\":{seq},\"busy\":true,\"status\":\"starting\",\"paused\":false}}\n");
            std::thread::sleep(Duration::from_millis(120));
            stream.write_all(state_frame(2).as_bytes()).unwrap();
            std::thread::sleep(Duration::from_millis(200));
            stream.write_all(state_frame(3).as_bytes()).unwrap();
            std::thread::sleep(Duration::from_millis(200));
            stream.write_all(b"{\"type\":\"agent_state\",\"seq\":4,\"busy\":false,\"status\":\"ready\",\"paused\":false}\n").unwrap();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
            }
        });
    }

    #[test]
    fn the_view_is_emitted_only_when_a_frame_changed_the_state() {
        let (dir, listener) = island_dir("3");
        let _tidy = Tmp(dir.clone());
        fake_daemon_echo_state(listener);
        let seen: std::sync::Arc<std::sync::Mutex<Vec<Value>>> = std::sync::Arc::default();
        let sink = seen.clone();
        let conn = ChatConn::new(move |v| { sink.lock().expect("seen lock").push(v); });
        conn.connect(&dir);
        wait_for(&conn, "final state", |v| v["agent"]["status"] == json!("ready") && v["agent"]["busy"] == json!(false));
        std::thread::sleep(Duration::from_millis(150));
        let seen = seen.lock().expect("seen lock").clone();
        for w in seen.windows(2) {
            assert_ne!(w[0], w[1], "an unchanged fold must never be emitted again: {seen:?}");
        }
        conn.close();
    }

    /// A daemon that answers the handshake and then broadcasts `agent_state` every
    /// 10 ms until told to stop (which closes the socket). The old reader's `changed`
    /// callback sleeps 300 ms on those views, so it is reliably INSIDE its emit when
    /// the next connect runs — after which the reconnect's stop flag is reset again:
    /// with one shared flag the old reader wakes, sees the reset flag and wipes the
    /// NEW connection's writer. Each connection's own flag/generation must prevent it.
    fn fake_daemon_broadcaster(listener: UnixListener, stop: std::sync::Arc<std::sync::atomic::AtomicBool>) {
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            if reader.read_line(&mut line).is_ok() {}
            stream.write_all(b"{\"type\":\"ready\",\"seq\":1,\"state\":{\"busy\":false,\"status\":\"ready\",\"paused\":false},\"features\":{\"history\":true,\"conversations\":false}}\n").unwrap();
            let mut seq = 1u64;
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => return,
                    Ok(_) => {}
                    Err(_) => {}
                }
                if stop.load(Ordering::SeqCst) { return; } // closes the socket: EOF for the old reader
                seq += 1;
                let _ = stream.write_all(format!("{{\"type\":\"agent_state\",\"seq\":{seq},\"busy\":true,\"status\":\"starting\",\"paused\":false}}\n").as_bytes());
                std::thread::sleep(Duration::from_millis(10));
            }
        });
    }

    #[test]
    fn a_reconnect_never_lets_an_old_reader_touch_the_new_connection() {
        let dir = std::env::temp_dir().join(format!("abito-chatclient-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(dir.join("runtime")).unwrap();
        std::fs::set_permissions(dir.join("runtime"), std::fs::Permissions::from_mode(0o700)).unwrap();
        let _tidy = Tmp(dir.clone());
        let conn = ChatConn::new(|v: Value| {
            // the old reader parks here on the old daemon's broadcast views, so it is
            // reliably INSIDE its emit when the next connect runs and resets the flag
            if v["agent"]["busy"] == json!(true) && v["agent"]["status"] == json!("starting") {
                std::thread::sleep(Duration::from_millis(300));
            }
        });
        let mut current_stop: Option<std::sync::Arc<std::sync::atomic::AtomicBool>> = None;
        for round in 0..3u32 {
            let leaf = format!("p-AbCdE{round}");
            std::fs::create_dir_all(dir.join("runtime").join(&leaf)).unwrap();
            std::fs::set_permissions(dir.join("runtime").join(&leaf), std::fs::Permissions::from_mode(0o700)).unwrap();
            let endpoint = dir.join("runtime").join(&leaf).join("s");
            let listener = UnixListener::bind(&endpoint).expect("fake socket");
            let session = json!({"protocol":"island-agent/1","endpoint":endpoint.to_str().unwrap(),"token":"t0k3n","pid":std::process::id()});
            let session_path = dir.join("runtime/session.json");
            std::fs::write(&session_path, session.to_string()).unwrap();
            std::fs::set_permissions(&session_path, std::fs::Permissions::from_mode(0o600)).unwrap();
            let (_tx, _rx) = std::sync::mpsc::channel::<String>();
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            fake_daemon_broadcaster(listener, stop.clone());
            conn.connect(&dir);
            wait_for(&conn, &format!("connected (round {round})"), |v| v["connection"] == json!("connected"));
            // the new connection's writer works
            conn.command("main", &json!({"action":"chat_status"})).unwrap();
            // the PREVIOUS daemon keeps broadcasting across this connect and only now
            // closes; its old reader, parked inside the emit callback, resumes onto a
            // reset stop flag
            if let Some(old) = current_stop.replace(stop) {
                old.store(true, Ordering::SeqCst);
            }
            // give the old reader time to observe the EOF (and, broken, to wipe us)
            std::thread::sleep(Duration::from_millis(500));
            assert_eq!(conn.view()["connection"], json!("connected"), "round {round}: the reconnect survived the old reader");
            conn.command("main", &json!({"action":"chat_status"})).unwrap();
        }
        conn.close();
    }
}

// ---- L3 (U2 re-verify): the revision change signal -----------------------------------------
// The connection readers decide whether to emit by comparing `ChatState::revision` before and
// after a read's frames, instead of serializing the whole chat state twice per read.

#[test]
fn a_noop_frame_never_bumps_the_chat_revision_but_a_real_change_does() {
    let mut st = ChatState::connected();
    let start = st.revision();
    // Unknown frames, and frames that fold to the exact view the state already holds,
    // are no-ops: the serialized view is unchanged AND the revision does not move.
    let view = serde_json::to_value(&st).unwrap();
    st.apply(&json!({"type":"totally_unknown"}));
    assert_eq!(st.revision(), start, "an unknown frame never bumps");
    st.apply(&json!({"type":"agent_state"})); // folds to the connected default (busy false, no status)
    assert_eq!(st.revision(), start, "an agent_state identical to the current view never bumps");
    assert_eq!(serde_json::to_value(&st).unwrap(), view, "a no-op frame leaves the view identical");
    st.apply(&json!({"type":"message_delta","messageId":"m1","text":""}));
    assert_eq!(st.revision(), start, "an empty delta never bumps");
    st.apply(&json!({"type":"message_delta","messageId":"m1"}));
    assert_eq!(st.revision(), start, "a delta without text never bumps");
    st.apply(&json!({"type":"message_delta","messageId":"m1","text":"hola"}));
    assert_eq!(st.revision(), start + 1, "a first delta for a new message bumps");
    st.apply(&json!({"type":"message_done","messageId":"m1"}));
    assert_eq!(st.revision(), start + 2, "landing a streamed message bumps");
    st.apply(&json!({"type":"message_done","messageId":"m1"}));
    assert_eq!(st.revision(), start + 2, "a duplicate done for an already-landed message never bumps");
    let after_done = st.revision();
    st.apply(&json!({"type":"ask","id":"bad id!","kind":"confirm","title":"t"}));
    assert_eq!(st.revision(), after_done, "a malformed ask is dropped without a bump");
    st.apply(&json!({"type":"ask_resolved","id":"never-seen"}));
    assert_eq!(st.revision(), after_done, "resolving an ask the island never held never bumps");

    // A real change bumps exactly once per changing fold, and the view moves with it.
    st.apply(&json!({"type":"message_delta","messageId":"m2","text":"hola"}));
    assert_eq!(st.revision(), after_done + 1, "a real change bumps");
    let after = serde_json::to_value(&st).unwrap();
    assert_ne!(after, view, "the changed view is really different");
    st.apply(&json!({"type":"agent_state","state":{"busy":true,"status":"ready","paused":false}}));
    assert_eq!(st.revision(), after_done + 2, "a state change bumps");
    // ...and the SAME state again does not: emit-on-change semantics are preserved exactly.
    st.apply(&json!({"type":"agent_state","state":{"busy":true,"status":"ready","paused":false}}));
    assert_eq!(st.revision(), after_done + 2, "a repeated identical fold never bumps");
}

#[test]
fn the_chat_revision_counter_never_leaks_into_the_serialized_view() {
    let mut st = ChatState::connected();
    st.apply(&json!({"type":"message_delta","messageId":"m1","text":"koda responde"}));
    st.apply(&json!({"type":"agent_state","state":{"busy":true,"status":"ready","paused":false}}));
    let bumped = serde_json::to_value(&st).unwrap();
    assert!(st.revision() > 0);
    assert!(bumped.get("revision").is_none(), "the change signal is internal: it must never reach the UI view");
}

// A trim/prepend/clear that lands on the same values still reports no change (the revision
// stays where it was), so reconnects and repeat history pages never spam the UI.
#[test]
fn a_history_page_that_changes_nothing_never_bumps_the_chat_revision() {
    let mut st = ChatState::connected();
    st.apply(&json!({"type":"history","messages":[{"id":"m1","role":"user","text":"hola"}],"hasEarlier":false}));
    let settled = st.revision();
    st.apply(&json!({"type":"history","messages":[{"id":"m1","role":"user","text":"hola"}],"hasEarlier":false}));
    assert_eq!(st.revision(), settled, "an identical history page never bumps");
    // an earlier page that brings nothing new (everything already known) is a no-op too
    st.apply(&json!({"type":"earlier","messages":[{"id":"m1","role":"user","text":"hola"}],"hasEarlier":false}));
    assert_eq!(st.revision(), settled, "an earlier page without fresh messages never bumps");
    // ...while a fresh page with new content does.
    st.apply(&json!({"type":"history","messages":[{"id":"m1","role":"user","text":"hola"},{"id":"m2","role":"assistant","text":"Ka"}],"hasEarlier":false}));
    assert!(st.revision() > settled, "a new page bumps");
}

// ---- K2-05 T4 U3 F5/R3/F4: the error ledger, the read answers, the loaded flag ----------------

#[test]
fn errors_are_attributed_to_the_oldest_waiting_command_that_can_answer_them() {
    let mut st = ChatState::connected();
    st.apply(&json!({"type":"agent_state","busy":false,"status":"ready","paused":false}));
    st.command("main", &json!({"action":"chat_history"})).unwrap();
    st.command("main", &send_payload("hola")).unwrap();
    // never a send's code: lastError moves, turnError does not
    st.apply(&json!({"type":"error","code":"unknown_ask"}));
    st.apply(&json!({"type":"error","code":"not_busy"}));
    assert_eq!(view(&st)["turnError"], json!({"code":null,"n":0}));
    assert_eq!(view(&st)["lastError"]["n"], json!(2));
    // FIFO: the history read (older) takes the first `unavailable`
    st.apply(&json!({"type":"error","code":"unavailable"}));
    assert_eq!(view(&st)["turnError"]["n"], json!(0));
    assert_eq!(view(&st)["reads"], json!({"answered":0,"failed":1}));
    st.apply(&json!({"type":"error","code":"unavailable"}));
    assert_eq!(view(&st)["turnError"], json!({"code":"unavailable","n":1}));
    // nothing waits any more: a stray error is nobody's
    st.apply(&json!({"type":"error","code":"failed"}));
    assert_eq!(view(&st)["turnError"]["n"], json!(1));
}

#[test]
fn an_accepted_turn_with_output_no_longer_claims_errors_but_a_silent_one_claims_failed() {
    let mut st = ChatState::connected();
    st.command("main", &send_payload("hola")).unwrap();
    st.apply(&json!({"type":"agent_state","busy":true,"status":"ready","paused":false}));
    st.apply(&json!({"type":"message_delta","messageId":"m1","text":"x"}));
    st.apply(&json!({"type":"agent_state","busy":false,"status":"ready","paused":false}));
    st.apply(&json!({"type":"error","code":"failed"}));
    assert_eq!(view(&st)["turnError"]["n"], json!(0), "a turn that produced output is done");
    // a prompt the engine rejected: busy then quiet with nothing, then `failed`
    st.command("main", &send_payload("otra")).unwrap();
    st.apply(&json!({"type":"agent_state","busy":true,"status":"ready","paused":false}));
    st.apply(&json!({"type":"agent_state","busy":false,"status":"ready","paused":false}));
    st.apply(&json!({"type":"error","code":"busy"}));
    assert_eq!(view(&st)["turnError"]["n"], json!(0), "only `failed` can follow a settled turn");
    st.apply(&json!({"type":"error","code":"failed"}));
    assert_eq!(view(&st)["turnError"], json!({"code":"failed","n":1}));
}

#[test]
fn requested_pages_count_as_answers_and_the_first_history_marks_the_view_loaded() {
    let mut st = ChatState::connected();
    assert_eq!(view(&st)["historyLoaded"], json!(false));
    st.apply(&json!({"type":"history","messages":[],"hasEarlier":false}));
    assert_eq!(view(&st)["historyLoaded"], json!(true), "an empty chat is a loaded chat");
    assert_eq!(view(&st)["reads"]["answered"], json!(0), "an unsolicited page answers nothing");
    st.command("main", &json!({"action":"chat_earlier","before":"s0-4"})).unwrap();
    st.apply(&json!({"type":"history","messages":[],"hasEarlier":false}));
    assert_eq!(view(&st)["reads"]["answered"], json!(0), "a broadcast history never answers an earlier read");
    let before = st.revision();
    st.apply(&json!({"type":"earlier","before":"s0-4","messages":[],"hasEarlier":false}));
    assert_eq!(view(&st)["reads"]["answered"], json!(1), "an identical page still answers the read (R3)");
    assert!(st.revision() > before, "and the answer is an event the reader emits");
    assert_eq!(view(&ChatState::disconnected(Reason::Lost))["historyLoaded"], json!(false));
}

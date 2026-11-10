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
fn history_replaces_the_view_and_earlier_prepends_deduped() {
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
    assert_eq!(v["streaming"].as_array().unwrap().len(), 1, "a live turn keeps streaming across a history replace");

    // earlier prepends the page and dedupes by id
    st.apply(&json!({"type":"earlier","before":"s1-3","messages":[
        {"id":"s0-9","role":"user","text":"más viejo","earlier":true},
        {"id":"s1-3","role":"assistant","text":"respuesta"} // already shown: skipped
    ],"hasEarlier":false}));
    let v = view(&st);
    let ids: Vec<&str> = v["messages"].as_array().unwrap().iter().filter_map(|m| m["id"].as_str()).collect();
    assert_eq!(ids, vec!["s0-9", "s1-3"], "earlier prepends without duplicating");
    assert_eq!(v["hasEarlier"], json!(false));
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
}

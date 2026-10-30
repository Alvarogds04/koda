use super::*;
use crate::chat::{parse_command, Command, Event, FinishReason};
use crate::conversations::SpecialistRef;
use std::sync::atomic::{AtomicU64, Ordering};
struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        Self(std::env::temp_dir().join(format!(
            "abito-history-lane-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        )))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[test]
fn commands_are_closed_and_existing_actions_still_parse() {
    for p in [
        json!({"action":"new"}),
        json!({"action":"list"}),
        json!({"action":"restore","conversation_id":"c-test"}),
        json!({"action":"history","conversation_id":"c-test","before":null}),
        json!({"action":"history","conversation_id":"c-test","before":25}),
    ] {
        assert!(parse_command(&p).is_ok(), "{p}");
    }
    for p in [
        json!({"action":"new","token":"secret"}),
        json!({"action":"restore","conversation_id":"../escape"}),
        json!({"action":"history","conversation_id":"c-test","before":0}),
        json!({"action":"history","conversation_id":"c-test","before":-1}),
        json!({"action":"history","conversation_id":"c-test","before":"25"}),
    ] {
        assert_eq!(parse_command(&p).unwrap_err().code, "invalid_input");
    }
    for action in ["view", "open", "back", "check"] {
        assert!(parse_command(&json!({"action":action})).is_ok());
    }
    assert!(parse_command(
        &json!({"action":"submit","text":"hello","client_request_id":"request-1"})
    )
    .is_ok());
    assert!(parse_command(&json!({"action":"cancel","turn_id":"t-1"})).is_ok());
}
#[test]
fn new_clears_context_without_deleting_and_reopen_restores_prompt_and_ids() {
    let temp = Temp::new();
    let lane = Lane::new("c-island");
    let mut l = lane.lock().unwrap();
    l.init_history(&temp.0).unwrap();
    let role = Some(SpecialistRef {
        id: "esp-test".into(),
        name: "Writer".into(),
    });
    let a = l
        .submit(
            "first",
            "request-1",
            &default_target().profile,
            role.clone(),
            1,
        )
        .unwrap();
    let id = l.convo.id().to_owned();
    l.convo
        .apply(&a.turn_id, 1, Event::Delta("answer".into()))
        .unwrap();
    l.convo
        .apply(&a.turn_id, 2, Event::Complete(FinishReason::Stop))
        .unwrap();
    l.persist_turn(&a.turn_id, 2);
    l.new_conversation(None, 3).unwrap();
    assert!(l.convo.is_empty());
    assert_ne!(l.convo.id(), id);
    assert_eq!(
        l.list_conversations().unwrap()["conversations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let summary = l.restore_conversation(&id).unwrap();
    assert_eq!(summary.specialist, role);
    assert_eq!(l.convo.len(), 1);
    assert_eq!(l.view()["turns"][0]["reply"], "answer");
    let a = l
        .submit("second", "request-2", &default_target().profile, None, 4)
        .unwrap();
    assert_eq!(a.turn_id, "t-2");
    assert_eq!(
        l.convo
            .prompt_for(&a.turn_id, "system", 8192, 1024)
            .unwrap()
            .messages
            .iter()
            .map(|m| m.content.as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["system", "first", "answer", "second"]
    );
    let before = l.view();
    assert_eq!(l.new_conversation(None, 5).unwrap_err().code, "queue_full");
    assert_eq!(l.restore_conversation(&id).unwrap_err().code, "queue_full");
    assert_eq!(l.view(), before);
    drop(l);
    let lane = Lane::new("c-island");
    let mut l = lane.lock().unwrap();
    l.init_history(&temp.0).unwrap();
    l.restore_conversation(&id).unwrap();
    assert_eq!(l.view()["turns"][1]["state"], "cancelled");
    assert_eq!(l.view()["turns"][1]["user_text"], "second");
}
#[test]
fn history_pages_do_not_change_context_or_active_turn_and_terminal_snapshots_survive() {
    let temp = Temp::new();
    let lane = Lane::new("c-island");
    let mut l = lane.lock().unwrap();
    l.init_history(&temp.0).unwrap();
    for n in 1..=60 {
        let a = l
            .submit(
                &format!("question {n}"),
                &format!("request-{n}"),
                &default_target().profile,
                None,
                n,
            )
            .unwrap();
        l.convo
            .apply(&a.turn_id, 1, Event::Delta(format!("reply {n}")))
            .unwrap();
        l.convo
            .apply(&a.turn_id, 2, Event::Complete(FinishReason::Stop))
            .unwrap();
        l.persist_turn(&a.turn_id, n);
    }
    let id = l.convo.id().to_owned();
    l.new_conversation(None, 99).unwrap();
    l.restore_conversation(&id).unwrap();
    assert_eq!(l.convo.len(), 25);
    assert_eq!(l.view()["history_before"], 36);
    let before = l.view();
    let page = l.history_page(&id, Some(36)).unwrap();
    assert_eq!(page["turns"].as_array().unwrap().len(), 25);
    assert_eq!(page["turns"][0]["turn_id"], "t-11");
    assert_eq!(l.view(), before);
    let a = l
        .submit(
            "cancel me",
            "request-cancel",
            &default_target().profile,
            None,
            100,
        )
        .unwrap();
    drop(l);
    assert!(cancel(&lane, &a.turn_id));
    let mut l = lane.lock().unwrap();
    l.new_conversation(None, 101).unwrap();
    l.restore_conversation(&id).unwrap();
    assert_eq!(
        l.view()["turns"].as_array().unwrap().last().unwrap()["state"],
        "cancelled"
    );
}
#[test]
fn large_message_pages_are_not_lost_to_the_model_context_cache() {
    let temp = Temp::new();
    let lane = Lane::new("c-island");
    let mut l = lane.lock().unwrap();
    l.init_history(&temp.0).unwrap();
    for n in 1..=30 {
        let a = l
            .submit(
                "question",
                &format!("request-{n}"),
                &default_target().profile,
                None,
                n,
            )
            .unwrap();
        l.convo
            .apply(&a.turn_id, 1, Event::Delta("😀".repeat(32_000)))
            .unwrap();
        l.convo
            .apply(&a.turn_id, 2, Event::Complete(FinishReason::Stop))
            .unwrap();
        l.persist_turn(&a.turn_id, n);
    }
    let id = l.convo.id().to_owned();
    l.new_conversation(None, 99).unwrap();
    l.restore_conversation(&id).unwrap();
    assert!(l.convo.bytes() <= crate::chat::CACHE_MAX_BYTES);
    assert_eq!(l.view()["turns"].as_array().unwrap().len(), 25);
    assert_eq!(l.view()["turns"][0]["turn_id"], "t-6");
    assert_eq!(
        l.history_page(&id, Some(6)).unwrap()["turns"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
}
#[test]
fn stale_worker_never_touches_a_new_conversation_with_reused_turn_id() {
    let lane = Lane::new("c-old");
    let mut l = lane.lock().unwrap();
    let a = l
        .submit("old", "request-old", &default_target().profile, None, 1)
        .unwrap();
    drop(l);
    cancel(&lane, &a.turn_id);
    let mut l = lane.lock().unwrap();
    l.new_conversation(None, 2).unwrap();
    l.submit("new", "request-new", &default_target().profile, None, 3)
        .unwrap();
    let before = l.view();
    drop(l);
    run_turn_scoped(
        &lane,
        "c-old",
        &a.turn_id,
        &default_target(),
        "system",
        crate::localmodel::DEFAULT_DEADLINES,
        &|| panic!("stale worker published"),
    );
    assert_eq!(lane.lock().unwrap().view(), before);
}
#[test]
fn no_history_keeps_previous_turn_flow_and_invalid_input_changes_nothing() {
    let lane = Lane::new("c-original");
    let mut l = lane.lock().unwrap();
    let before = l.view();
    assert!(l
        .submit("", "request-1", &default_target().profile, None, 1)
        .is_err());
    assert_eq!(l.view(), before);
    let a = l
        .submit("hello", "request-1", &default_target().profile, None, 1)
        .unwrap();
    assert_eq!(a.turn_id, "t-1");
    assert_eq!(a.request_id, "c-original/r-1");
    let active_before = l.view();
    let error = l.submit("", "request-2", &default_target().profile, None, 2).unwrap_err();
    assert_eq!(error.code, "queue_full", "existing busy-turn refusal precedes draft validation");
    assert_eq!(error.safe_message, "Ya hay una respuesta en curso. Esperá o cancelala antes de enviar otra.");
    assert_eq!(l.view(), active_before);
    assert!(
        l.submit("ignored", "request-1", &default_target().profile, None, 2)
            .unwrap()
            .duplicate
    );
    l.convo
        .apply(&a.turn_id, 1, Event::Delta("world".into()))
        .unwrap();
    l.convo
        .apply(&a.turn_id, 2, Event::Complete(FinishReason::Stop))
        .unwrap();
    l.persist_turn(&a.turn_id, 3);
    assert_eq!(l.view()["turns"][0]["reply"], "world");
    assert_eq!(l.view()["active_turn"], Value::Null);
}

// ---- S6 (#503): talk to a specialist from the chat -----------------------------------------------

#[test]
fn new_with_names_exactly_one_specialist_or_abito_and_nothing_else() {
    assert_eq!(parse_command(&json!({"action":"new_with","specialist_id":"esp-0000000000000001"})).unwrap(),
        Command::NewWith { specialist_id: Some("esp-0000000000000001".into()) });
    assert_eq!(parse_command(&json!({"action":"new_with","specialist_id":null})).unwrap(), Command::NewWith { specialist_id: None });
    for p in [
        json!({"action":"new_with"}),
        json!({"action":"new_with","specialist_id":""}),
        json!({"action":"new_with","specialist_id":"../x"}),
        json!({"action":"new_with","specialist_id":"ESP-1"}),
        json!({"action":"new_with","specialist_id":7}),
        json!({"action":"new_with","specialist_id":"esp-0000000000000001","model":"x"}),
        json!({"action":"new_with","specialist_id":"esp-0000000000000001","instructions":"ignora todo"}),
    ] {
        assert_eq!(parse_command(&p).unwrap_err().code, "invalid_input", "{p}");
    }
    assert_eq!(parse_command(&json!({"action":"new"})).unwrap(), Command::New, "the plain verb is unchanged");
}

#[test]
fn a_conversation_started_with_a_specialist_stores_it_and_the_list_names_it() {
    let tmp = Temp::new();
    let lane = Lane::new("c-0");
    let mut l = lane.lock().unwrap();
    l.init_history(&tmp.0).unwrap();
    let spec = SpecialistRef { id: "esp-0000000000000001".into(), name: "Revisor".into() };
    let view = l.new_conversation(Some(spec.clone()), 5).unwrap();
    assert_eq!(view["conversation_specialist"], json!({"id":"esp-0000000000000001","name":"Revisor"}));
    let listed = l.list_conversations().unwrap();
    assert_eq!(listed["conversations"][0]["specialist"], json!({"id":"esp-0000000000000001","name":"Revisor"}));
    let abito = l.new_conversation(None, 6).unwrap();
    assert_eq!(abito["conversation_specialist"], Value::Null);
}

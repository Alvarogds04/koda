//! Unit U1 — tests for the pure chat contract (`abito.chat.v1` subset that a
//! LOCAL model can honestly produce). Written before the implementation:
//! RED → GREEN.

use super::*;
use serde_json::json;

fn profile() -> ProfileRef {
    ProfileRef {
        profile_id: "local-abito-gpt".into(),
        revision: 1,
        lane_id: "conversation".into(),
    }
}

fn convo() -> Conversation {
    Conversation::new("c-test")
}

// --- input validation -------------------------------------------------------

#[test]
fn text_must_carry_something() {
    assert_eq!(validate_text("").unwrap_err().code, "invalid_input");
    assert_eq!(validate_text("   \n\t ").unwrap_err().code, "invalid_input");
    assert_eq!(validate_text("hola").unwrap(), "hola");
}

#[test]
fn text_is_bounded_in_unicode_scalars_not_bytes() {
    let ok = "ñ".repeat(DRAFT_MAX_SCALARS); // 2 bytes each, 8000 scalars
    assert!(validate_text(&ok).is_ok());
    let over = "a".repeat(DRAFT_MAX_SCALARS + 1);
    assert_eq!(validate_text(&over).unwrap_err().code, "invalid_input");
}

#[test]
fn text_rejects_control_characters_but_keeps_newlines_and_tabs() {
    assert!(validate_text("a\u{0}b").is_err());
    assert!(validate_text("a\u{1b}[31mb").is_err());
    assert!(validate_text("a\u{7f}b").is_err());
    assert_eq!(validate_text("a\r\nb\tc").unwrap(), "a\nb\tc");
}

#[test]
fn client_request_ids_are_bounded_tokens() {
    assert!(valid_client_request_id("req-0123456789ab"));
    assert!(!valid_client_request_id("short"));
    assert!(!valid_client_request_id(&"a".repeat(65)));
    assert!(!valid_client_request_id("req 0123456789ab"));
    assert!(!valid_client_request_id("req-ñ123456789ab"));
}

// --- submit / acceptance -------------------------------------------------------

#[test]
fn submit_assigns_native_ids_and_queues() {
    let mut c = convo();
    let a = c.submit("hola", "req-0000000001", &profile()).unwrap();
    assert!(!a.duplicate);
    assert_eq!(a.turn_id, "t-1");
    assert_eq!(a.request_id, "c-test/r-1");
    assert_eq!(a.profile_id, "local-abito-gpt");
    assert_eq!(a.profile_revision, 1);
    assert_eq!(a.lane_id, "conversation");
    let t = c.turn("t-1").unwrap();
    assert_eq!(t.state, TurnState::Queued);
    assert_eq!(t.user_text, "hola");
    assert_eq!(t.seq, 0);
}

#[test]
fn duplicate_client_request_id_returns_the_same_turn_not_a_new_job() {
    let mut c = convo();
    let a = c.submit("hola", "req-0000000001", &profile()).unwrap();
    let b = c.submit("hola otra vez", "req-0000000001", &profile()).unwrap();
    assert!(b.duplicate);
    assert_eq!(a.turn_id, b.turn_id);
    assert_eq!(c.len(), 1);
}

#[test]
fn only_one_turn_runs_per_conversation() {
    let mut c = convo();
    c.submit("uno", "req-0000000001", &profile()).unwrap();
    let e = c.submit("dos", "req-0000000002", &profile()).unwrap_err();
    assert_eq!(e.code, "queue_full");
    assert!(e.retryable);
    assert_eq!(c.len(), 1);
}

#[test]
fn a_new_turn_is_accepted_once_the_previous_one_is_terminal() {
    let mut c = convo();
    c.submit("uno", "req-0000000001", &profile()).unwrap();
    c.apply("t-1", 1, Event::Complete(FinishReason::Stop)).unwrap();
    let a = c.submit("dos", "req-0000000002", &profile()).unwrap();
    assert_eq!(a.turn_id, "t-2");
}

// --- events, sequencing, terminal states ---------------------------------------

#[test]
fn ordinary_turn_runs_thinking_streaming_completed() {
    let mut c = convo();
    c.submit("hola", "req-0000000001", &profile()).unwrap();
    c.apply("t-1", 1, Event::Thinking).unwrap();
    assert_eq!(c.turn("t-1").unwrap().state, TurnState::Thinking);
    c.apply("t-1", 2, Event::Delta("Ho".into())).unwrap();
    assert_eq!(c.turn("t-1").unwrap().state, TurnState::Streaming);
    c.apply("t-1", 3, Event::Delta("la".into())).unwrap();
    c.apply("t-1", 4, Event::Complete(FinishReason::Stop)).unwrap();
    let t = c.turn("t-1").unwrap();
    assert_eq!(t.state, TurnState::Completed);
    assert_eq!(t.reply, "Hola");
    assert_eq!(t.finish, Some(FinishReason::Stop));
    assert_eq!(t.seq, 4);
}

#[test]
fn regressing_duplicate_or_gapped_sequence_is_rejected() {
    let mut c = convo();
    c.submit("hola", "req-0000000001", &profile()).unwrap();
    c.apply("t-1", 1, Event::Thinking).unwrap();
    assert_eq!(c.apply("t-1", 1, Event::Thinking), Err(Reject::Regressing));
    assert_eq!(c.apply("t-1", 0, Event::Thinking), Err(Reject::Regressing));
    assert_eq!(c.apply("t-1", 3, Event::Delta("x".into())), Err(Reject::Gap));
    assert_eq!(c.turn("t-1").unwrap().reply, "");
}

#[test]
fn events_for_unknown_turns_or_after_terminal_are_rejected() {
    let mut c = convo();
    c.submit("hola", "req-0000000001", &profile()).unwrap();
    assert_eq!(c.apply("t-9", 1, Event::Thinking), Err(Reject::UnknownTurn));
    c.apply("t-1", 1, Event::Complete(FinishReason::Stop)).unwrap();
    assert_eq!(
        c.apply("t-1", 2, Event::Delta("tarde".into())),
        Err(Reject::AfterTerminal)
    );
    assert_eq!(c.turn("t-1").unwrap().reply, "");
}

#[test]
fn cancel_is_terminal_and_discards_later_deltas() {
    let mut c = convo();
    c.submit("hola", "req-0000000001", &profile()).unwrap();
    c.apply("t-1", 1, Event::Delta("parcial".into())).unwrap();
    assert!(c.cancel("t-1"));
    let t = c.turn("t-1").unwrap();
    assert_eq!(t.state, TurnState::Cancelled);
    assert_eq!(t.finish, Some(FinishReason::Cancelled));
    assert_eq!(
        c.apply("t-1", 2, Event::Delta(" más".into())),
        Err(Reject::AfterTerminal)
    );
    assert_eq!(c.turn("t-1").unwrap().reply, "parcial");
    // cancelling twice / an unknown turn never creates anything
    assert!(!c.cancel("t-1"));
    assert!(!c.cancel("t-7"));
    assert_eq!(c.len(), 1);
}

#[test]
fn error_is_terminal_and_keeps_only_the_safe_fields() {
    let mut c = convo();
    c.submit("hola", "req-0000000001", &profile()).unwrap();
    c.apply("t-1", 1, Event::Error(ChatError::local_model_unavailable()))
        .unwrap();
    let t = c.turn("t-1").unwrap();
    assert_eq!(t.state, TurnState::Error);
    let e = t.error.as_ref().unwrap();
    assert_eq!(e.code, "local_model_unavailable");
    assert!(e.retryable);
    // the safe message says plainly that nothing else was used
    assert!(e.safe_message.contains("No se usó ningún otro modelo"));
}

#[test]
fn waiting_approval_never_turns_into_execution_by_itself() {
    let mut c = convo();
    c.submit("hola", "req-0000000001", &profile()).unwrap();
    c.apply("t-1", 1, Event::Thinking).unwrap();
    c.apply("t-1", 2, Event::WaitingApproval).unwrap();
    assert_eq!(c.turn("t-1").unwrap().state, TurnState::WaitingApproval);
    // deltas while waiting are not a hidden transition back to streaming
    assert_eq!(
        c.apply("t-1", 3, Event::Delta("x".into())),
        Err(Reject::InvalidTransition)
    );
    // waiting is not terminal: a new turn is still refused
    assert_eq!(
        c.submit("otro", "req-0000000002", &profile()).unwrap_err().code,
        "queue_full"
    );
}

#[test]
fn thinking_after_streaming_is_an_invalid_transition() {
    let mut c = convo();
    c.submit("hola", "req-0000000001", &profile()).unwrap();
    c.apply("t-1", 1, Event::Delta("a".into())).unwrap();
    assert_eq!(c.apply("t-1", 2, Event::Thinking), Err(Reject::InvalidTransition));
}

#[test]
fn response_is_bounded_and_truncation_is_an_explicit_limit_state() {
    let mut c = convo();
    c.submit("hola", "req-0000000001", &profile()).unwrap();
    let big = "é".repeat(RESPONSE_MAX_SCALARS - 2);
    assert_eq!(c.apply("t-1", 1, Event::Delta(big)).unwrap(), Applied::Ok);
    assert_eq!(
        c.apply("t-1", 2, Event::Delta("abcd".into())).unwrap(),
        Applied::Truncated
    );
    let t = c.turn("t-1").unwrap();
    assert_eq!(t.reply.chars().count(), RESPONSE_MAX_SCALARS);
    assert_eq!(t.state, TurnState::Completed);
    assert_eq!(t.finish, Some(FinishReason::Limit));
}

// --- presentation cache -------------------------------------------------------

#[test]
fn presentation_cache_keeps_at_most_100_turns() {
    let mut c = convo();
    for n in 0..(CACHE_MAX_TURNS + 5) {
        let id = format!("req-{n:010}");
        let a = c.submit("hola", &id, &profile()).unwrap();
        c.apply(&a.turn_id, 1, Event::Complete(FinishReason::Stop)).unwrap();
    }
    assert_eq!(c.len(), CACHE_MAX_TURNS);
    assert_eq!(c.evicted(), 5);
    assert!(c.turn("t-1").is_none());
}

#[test]
fn presentation_cache_is_bounded_in_bytes_but_never_evicts_the_active_turn() {
    let mut c = convo();
    let text = "x".repeat(DRAFT_MAX_SCALARS);
    let mut n = 0;
    while c.bytes() <= CACHE_MAX_BYTES - DRAFT_MAX_SCALARS {
        n += 1;
        let a = c.submit(&text, &format!("req-{n:010}"), &profile()).unwrap();
        c.apply(&a.turn_id, 1, Event::Complete(FinishReason::Stop)).unwrap();
    }
    n += 1;
    let a = c.submit(&text, &format!("req-{n:010}"), &profile()).unwrap();
    assert!(c.bytes() <= CACHE_MAX_BYTES);
    assert!(c.turn(&a.turn_id).is_some());
    assert!(c.evicted() >= 1);
}

// --- prompt construction --------------------------------------------------------

#[test]
fn prompt_carries_system_history_and_the_new_message_in_order() {
    let mut c = convo();
    let a = c.submit("¿quién sos?", "req-0000000001", &profile()).unwrap();
    c.apply(&a.turn_id, 1, Event::Delta("Abito.".into())).unwrap();
    c.apply(&a.turn_id, 2, Event::Complete(FinishReason::Stop)).unwrap();
    let b = c.submit("¿y qué hacés?", "req-0000000002", &profile()).unwrap();
    let prompt = c.prompt_for(&b.turn_id, "SYS", 4096, 512).unwrap();
    let roles: Vec<&str> = prompt.messages.iter().map(|m| m.role).collect();
    assert_eq!(roles, ["system", "user", "assistant", "user"]);
    assert_eq!(prompt.messages[3].content, "¿y qué hacés?");
    assert_eq!(prompt.trimmed_turns, 0);
}

#[test]
fn failed_or_cancelled_turns_without_reply_do_not_enter_the_prompt() {
    let mut c = convo();
    let a = c.submit("uno", "req-0000000001", &profile()).unwrap();
    c.apply(&a.turn_id, 1, Event::Error(ChatError::inference_error()))
        .unwrap();
    let b = c.submit("dos", "req-0000000002", &profile()).unwrap();
    let prompt = c.prompt_for(&b.turn_id, "SYS", 4096, 512).unwrap();
    let roles: Vec<&str> = prompt.messages.iter().map(|m| m.role).collect();
    assert_eq!(roles, ["system", "user"]);
}

#[test]
fn history_over_budget_is_trimmed_visibly_never_by_growing_the_context() {
    let mut c = convo();
    for n in 1..=6 {
        let a = c
            .submit(&"palabra ".repeat(100), &format!("req-{n:010}"), &profile())
            .unwrap();
        c.apply(&a.turn_id, 1, Event::Delta("ok".into())).unwrap();
        c.apply(&a.turn_id, 2, Event::Complete(FinishReason::Stop)).unwrap();
    }
    let b = c.submit("último", "req-0000000099", &profile()).unwrap();
    // budget fits roughly two old turns plus the new message
    let prompt = c.prompt_for(&b.turn_id, "SYS", 1200, 400).unwrap();
    assert!(prompt.trimmed_turns > 0);
    assert!(prompt.estimated_tokens + 400 <= 1200);
    assert_eq!(prompt.messages.last().unwrap().content, "último");
    // the trimming is recorded on the turn so the UI can say it
    assert_eq!(c.turn(&b.turn_id).unwrap().trimmed_turns, prompt.trimmed_turns);
}

#[test]
fn a_message_that_cannot_fit_alone_is_a_context_limit_error() {
    let mut c = convo();
    let a = c
        .submit(&"x".repeat(DRAFT_MAX_SCALARS), "req-0000000001", &profile())
        .unwrap();
    let e = c.prompt_for(&a.turn_id, "SYS", 1000, 400).unwrap_err();
    assert_eq!(e.code, "context_limit");
    assert!(!e.retryable);
}

#[test]
fn token_estimate_is_conservative() {
    // ~3 UTF-8 bytes per token plus per-message overhead, rounded up
    assert_eq!(estimate_tokens(""), MESSAGE_OVERHEAD_TOKENS);
    assert_eq!(estimate_tokens("abc"), 1 + MESSAGE_OVERHEAD_TOKENS);
    assert_eq!(estimate_tokens("abcd"), 2 + MESSAGE_OVERHEAD_TOKENS);
    assert!(estimate_tokens(&"ñ".repeat(300)) >= 200);
}

// --- view projection --------------------------------------------------------------

#[test]
fn view_is_plain_data_with_states_as_contract_strings() {
    let mut c = convo();
    c.submit("hola", "req-0000000001", &profile()).unwrap();
    c.apply("t-1", 1, Event::Thinking).unwrap();
    let v = c.view();
    assert_eq!(v["conversation_id"], "c-test");
    assert_eq!(v["active_turn"], "t-1");
    let turn = &v["turns"][0];
    assert_eq!(turn["state"], "thinking");
    assert_eq!(turn["user_text"], "hola");
    assert_eq!(turn["reply"], "");
    assert!(turn["error"].is_null());
    // the client request id is the page's own token, not echoed back
    assert!(turn.get("client_request_id").is_none());
}

#[test]
fn state_strings_match_the_contract() {
    let all = [
        (TurnState::Queued, "queued"),
        (TurnState::Thinking, "thinking"),
        (TurnState::Streaming, "streaming"),
        (TurnState::WaitingApproval, "waiting_approval"),
        (TurnState::Completed, "completed"),
        (TurnState::Cancelled, "cancelled"),
        (TurnState::Error, "error"),
    ];
    for (state, text) in all {
        assert_eq!(serde_json::to_value(state).unwrap(), text);
    }
    assert!(TurnState::Completed.is_terminal());
    assert!(TurnState::Cancelled.is_terminal());
    assert!(TurnState::Error.is_terminal());
    assert!(!TurnState::WaitingApproval.is_terminal());
}

#[test]
fn lookup_answers_a_repeated_client_id_without_submitting() {
    let mut c = convo();
    assert!(c.lookup("req-0000000001").is_none());
    let a = c.submit("hola", "req-0000000001", &profile()).unwrap();
    let again = c.lookup("req-0000000001").unwrap();
    assert!(again.duplicate);
    assert_eq!(again.turn_id, a.turn_id);
    assert_eq!(c.len(), 1);
}

// --- chat_action IPC payload (validated in Rust, like desktop_action) -----------

#[test]
fn chat_commands_parse_with_exact_keys() {
    assert_eq!(parse_command(&json!({"action": "view"})).unwrap(), Command::View);
    assert_eq!(parse_command(&json!({"action": "open"})).unwrap(), Command::Open);
    assert_eq!(parse_command(&json!({"action": "back"})).unwrap(), Command::Back);
    assert_eq!(
        parse_command(&json!({"action": "submit", "text": "hola", "client_request_id": "req-0000000001"}))
            .unwrap(),
        Command::Submit { text: "hola".into(), client_request_id: "req-0000000001".into(), attachments: Vec::new() }
    );
    assert_eq!(
        parse_command(&json!({"action": "cancel", "turn_id": "t-3"})).unwrap(),
        Command::Cancel { turn_id: "t-3".into() }
    );
}

#[test]
fn chat_commands_refuse_smuggled_fields_unknown_actions_and_bad_shapes() {
    for bad in [
        json!(null),
        json!([]),
        json!({"action": "approve"}),
        json!({"action": "view", "x": 1}),
        json!({"action": "open", "endpoint": "http://evil:1"}),
        json!({"action": "submit", "text": "hola"}),
        json!({"action": "submit", "text": 5, "client_request_id": "req-0000000001"}),
        json!({"action": "submit", "text": "hola", "client_request_id": "req-0000000001", "model": "gpt-4"}),
        json!({"action": "cancel"}),
        json!({"action": "cancel", "turn_id": "x; rm"}),
        json!({"action": "cancel", "turn_id": "t-"}),
    ] {
        assert_eq!(parse_command(&bad).unwrap_err().code, "invalid_input", "{bad}");
    }
}

#[test]
fn chat_command_payload_is_size_capped_before_parsing_text() {
    let huge = "a".repeat(CHAT_COMMAND_MAX_BYTES);
    let e = parse_command(&json!({"action": "submit", "text": huge, "client_request_id": "req-0000000001"}))
        .unwrap_err();
    assert_eq!(e.code, "invalid_input");
}

#[test]
fn check_command_is_argument_free() {
    assert_eq!(parse_command(&json!({"action": "check"})).unwrap(), Command::Check);
    assert!(parse_command(&json!({"action": "check", "endpoint": "x"})).is_err());
}

// --- #343 shape pins: the attachment work must not change the old wire shape --

#[test]
fn plain_message_content_serializes_as_a_json_string() {
    // Pin: with no attachments, every prompt message keeps `content` as a
    // JSON string — never an array — and the completion body is byte-identical.
    let mut c = convo();
    let a = c.submit("hola", "req-shape-000001", &profile()).unwrap();
    c.apply(&a.turn_id, 1, Event::Delta("respuesta".into())).unwrap();
    c.apply(&a.turn_id, 2, Event::Complete(FinishReason::Stop)).unwrap();
    let b = c.submit("otra", "req-shape-000002", &profile()).unwrap();
    let p = c.prompt_for(&b.turn_id, "sistema", 8192, 1024).unwrap();
    assert_eq!(serde_json::to_value(&p.messages[0]).unwrap(), json!({"role":"system","content":"sistema"}));
    assert_eq!(serde_json::to_value(&p.messages[1]).unwrap(), json!({"role":"user","content":"hola"}));
    assert_eq!(serde_json::to_value(&p.messages[2]).unwrap(), json!({"role":"assistant","content":"respuesta"}));
    assert_eq!(serde_json::to_value(&p.messages[3]).unwrap(), json!({"role":"user","content":"otra"}));
    let body = crate::localmodel::completion_body("Abito-gpt", &p.messages, 1024);
    assert!(body.contains("\"content\":\"sistema\""), "{body}");
    assert!(body.contains("\"content\":\"hola\""), "{body}");
}

// --- #343: attachments through submit, prompts and the command set -----------

fn attachment(id: &str, name: &str, mime: &str, file: &str) -> Attachment {
    Attachment { id: id.into(), name: name.into(), mime: mime.into(), size: 12, file: file.into() }
}

#[test]
fn submit_accepts_ids_and_turns_carry_the_metadata() {
    let mut c = convo();
    let a = c.submit_with_attachments(
        "hola", "req-att-00000001", &profile(),
        vec![attachment("a-0123456789abcdef", "notas.txt", "text/plain", "0123456789abcdef-notas.txt")],
    ).unwrap();
    let turn = c.turn(&a.turn_id).unwrap();
    assert_eq!(turn.attachments.len(), 1);
    assert_eq!(turn.attachments[0].name, "notas.txt");
    // The wire shape with attachments is content parts, not a string.
    let p = c.prompt_for(&a.turn_id, "sistema", 8192, 1024).unwrap();
    let user = &p.messages[1];
    assert_eq!(user.role, "user");
    assert!(user.content.is_array(), "{}", user.content);
}

#[test]
fn submit_command_parses_the_optional_attachments_key() {
    let ok = json!({"action": "submit", "text": "hola", "client_request_id": "req-0000000001",
        "attachments": ["a-0123456789abcdef", "a-ffffffffffffffff"]});
    match parse_command(&ok).unwrap() {
        Command::Submit { attachments, .. } => assert_eq!(attachments.len(), 2),
        other => panic!("{other:?}"),
    }
    // No key: exactly the old command.
    match parse_command(&json!({"action": "submit", "text": "hola", "client_request_id": "req-0000000001"})).unwrap() {
        Command::Submit { attachments, .. } => assert!(attachments.is_empty()),
        other => panic!("{other:?}"),
    }
    for bad in [
        json!({"action": "submit", "text": "hola", "client_request_id": "req-0000000001", "attachments": ["b-0123456789abcdef"]}),
        json!({"action": "submit", "text": "hola", "client_request_id": "req-0000000001", "attachments": ["a-0123456789ABCDEF"]}),
        json!({"action": "submit", "text": "hola", "client_request_id": "req-0000000001", "attachments": ["a-0123456789abcdef", "a-0123456789abcdef"]}),
        json!({"action": "submit", "text": "hola", "client_request_id": "req-0000000001", "attachments": {}}),
        json!({"action": "submit", "text": "hola", "client_request_id": "req-0000000001", "attachments": ["a-0123456789abcdef"], "extra": 1}),
    ] {
        assert_eq!(parse_command(&bad).unwrap_err().code, "invalid_input", "{bad}");
    }
    // The per-turn cap is enforced at the command boundary.
    let many: Vec<String> = (0..6).map(|i| format!("a-{:016x}", i)).collect();
    let bad = json!({"action": "submit", "text": "hola", "client_request_id": "req-0000000001", "attachments": many});
    assert_eq!(parse_command(&bad).unwrap_err().code, "invalid_input");
}

#[test]
fn prompts_inline_text_attachments_and_note_missing_ones() {
    let mut c = convo();
    let a = c.submit_with_attachments(
        "resumí esto", "req-att-00000002", &profile(),
        vec![
            attachment("a-0123456789abcdef", "notas.txt", "text/plain", "0123456789abcdef-notas.txt"),
            attachment("a-ffffffffffffffff", "perdido.txt", "text/plain", "ffffffffffffffff-perdido.txt"),
        ],
    ).unwrap();
    let resolve = |att: &Attachment| (att.id == "a-0123456789abcdef").then(|| "contenido del archivo".to_string());
    let p = c.prompt_for_resolved(&a.turn_id, "sistema", 8192, 1024, &resolve).unwrap();
    let content = p.messages[1].content.as_array().unwrap();
    let text = content[0]["text"].as_str().unwrap();
    assert!(text.starts_with("resumí esto"), "{text}");
    assert!(text.contains("[Archivo adjunto: notas.txt]\ncontenido del archivo"), "{text}");
    assert!(text.contains("[Archivo adjunto: perdido.txt — el archivo ya no está disponible]"), "{text}");
    assert_eq!(content.len(), 1); // text only: no image parts
}

#[test]
fn prompts_build_image_parts_and_reserve_their_budget() {
    let mut c = convo();
    let a = c.submit_with_attachments(
        "mirá", "req-att-00000003", &profile(),
        vec![attachment("a-0123456789abcdef", "foto.png", "image/png", "0123456789abcdef-foto.png")],
    ).unwrap();
    let resolve = |att: &Attachment| (att.mime == "image/png").then(|| "data:image/png;base64,AAAA".to_string());
    let p = c.prompt_for_resolved(&a.turn_id, "sistema", 8192, 1024, &resolve).unwrap();
    let content = p.messages[1].content.as_array().unwrap();
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[1]["type"], "image_url");
    assert_eq!(content[1]["image_url"]["url"], "data:image/png;base64,AAAA");
    // The image cost enters the budget: a context too small for it errors honestly.
    // used ≈ estimate("sistema") + estimate("mirá") + IMAGE_TOKEN_ESTIMATE = 1037.
    let small = c.prompt_for_resolved(&a.turn_id, "sistema", IMAGE_TOKEN_ESTIMATE + 100, 100, &resolve);
    assert_eq!(small.unwrap_err().code, "context_limit");
}

#[test]
fn safe_errors_name_what_to_do() {
    assert!(ChatError::attachment_unavailable().safe_message.contains("ya no está disponible"));
    assert!(ChatError::vision_unsupported().safe_message.contains("no puede leer imágenes"));
}

// --- #418: tool calls and approval decisions as turn events -------------------

fn running_turn(c: &mut Conversation) -> String {
    let a = c.submit("hola", "req-0000000001", &profile()).unwrap();
    c.apply(&a.turn_id, 1, Event::Thinking).unwrap();
    a.turn_id
}

fn call(id: &str, name: &str, state: ToolState, summary: Option<&str>) -> Event {
    Event::ToolCall(ToolCall {
        call_id: id.into(),
        name: name.into(),
        state,
        summary: summary.map(str::to_string),
    })
}

#[test]
fn a_plain_turn_view_has_no_tool_or_approval_keys() {
    let mut c = convo();
    let t = running_turn(&mut c);
    c.apply(&t, 2, Event::Delta("ok".into())).unwrap();
    let v = c.view();
    let turn = v["turns"][0].as_object().unwrap();
    assert!(!turn.contains_key("tool_calls"));
    assert!(!turn.contains_key("approvals"));
}

#[test]
fn a_tool_call_event_surfaces_in_the_view_and_upserts_by_call_id() {
    let mut c = convo();
    let t = running_turn(&mut c);
    c.apply(&t, 2, call("call_1", "read", ToolState::Running, None)).unwrap();
    assert_eq!(c.view()["turns"][0]["tool_calls"], json!([{"call_id": "call_1", "name": "read", "state": "running"}]));
    c.apply(&t, 3, call("call_1", "read", ToolState::Failed, Some("La herramienta terminó con error."))).unwrap();
    let calls = c.view()["turns"][0]["tool_calls"].clone();
    assert_eq!(calls, json!([{"call_id": "call_1", "name": "read", "state": "failed", "summary": "La herramienta terminó con error."}]));
    // a finished call never goes back to running
    assert_eq!(c.apply(&t, 4, call("call_1", "read", ToolState::Running, None)), Err(Reject::InvalidTransition));
}

#[test]
fn unsafe_tool_events_are_rejected_and_change_nothing() {
    let mut c = convo();
    let t = running_turn(&mut c);
    let before = c.view();
    for bad in [
        call("bad id!", "read", ToolState::Running, None),
        call("", "read", ToolState::Running, None),
        call("call_1", "bash\nrm -rf /", ToolState::Running, None),
        call("call_1", &"n".repeat(65), ToolState::Running, None),
        call("call_1", "read", ToolState::Running, Some("line\nbreak")),
        call("call_1", "read", ToolState::Running, Some(&"s".repeat(241))),
    ] {
        assert_eq!(c.apply(&t, 2, bad), Err(Reject::Invalid));
    }
    assert_eq!(c.view(), before, "rejected events leave the turn and seq unchanged");
    assert!(c.apply(&t, 2, Event::Delta("x".into())).is_ok(), "seq 2 is still free");
}

#[test]
fn tool_calls_per_turn_are_bounded() {
    let mut c = convo();
    let t = running_turn(&mut c);
    for i in 0..MAX_TOOL_CALLS {
        c.apply(&t, 2 + i as u64, call(&format!("c{i}"), "read", ToolState::Done, None)).unwrap();
    }
    assert_eq!(c.apply(&t, 2 + MAX_TOOL_CALLS as u64, call("extra", "read", ToolState::Done, None)), Err(Reject::Invalid));
}

#[test]
fn approval_decisions_surface_once_per_request() {
    let mut c = convo();
    let t = running_turn(&mut c);
    let ev = |id: &str, d| Event::Approval(ApprovalDecision { request_id: id.into(), operation: "Enviar correo".into(), decision: d });
    c.apply(&t, 2, ev("req_1", Decision::Approved)).unwrap();
    assert_eq!(c.view()["turns"][0]["approvals"], json!([{"request_id": "req_1", "operation": "Enviar correo", "decision": "approved"}]));
    assert_eq!(c.apply(&t, 3, ev("req_1", Decision::Denied)), Err(Reject::InvalidTransition));
    let bad = Event::Approval(ApprovalDecision { request_id: "req_2".into(), operation: "a\u{0}b".into(), decision: Decision::Expired });
    assert_eq!(c.apply(&t, 3, bad), Err(Reject::Invalid));
    assert_eq!(c.view()["turns"][0]["approvals"].as_array().unwrap().len(), 1);
}

#[test]
fn tool_events_after_a_terminal_turn_are_refused() {
    let mut c = convo();
    let t = running_turn(&mut c);
    c.apply(&t, 2, Event::Complete(FinishReason::Stop)).unwrap();
    assert_eq!(c.apply(&t, 3, call("c1", "read", ToolState::Done, None)), Err(Reject::AfterTerminal));
}

// ---- #487: the window context rides with the FIRST user message, in every later prompt of that conversation ----

#[test]
fn context_prefixes_the_first_user_message_in_its_prompt_and_all_later_ones_but_not_the_stored_text() {
    let mut c = convo();
    let a = c.submit("hola", "req-0000000001", &profile()).unwrap();
    c.attach_context(&a.turn_id, "Context — App: Firefox, Window: Docs");
    let p = c.prompt_for(&a.turn_id, "SYS", 4096, 512).unwrap();
    assert_eq!(p.messages[1].content, "Context — App: Firefox, Window: Docs\n\nhola");
    c.apply(&a.turn_id, 1, Event::Delta("ok".into())).unwrap();
    c.apply(&a.turn_id, 2, Event::Complete(FinishReason::Stop)).unwrap();
    let b = c.submit("y ahora", "req-0000000002", &profile()).unwrap();
    let p = c.prompt_for(&b.turn_id, "SYS", 4096, 512).unwrap();
    assert_eq!(p.messages[0].content, "SYS", "the system text is untouched");
    assert_eq!(p.messages[1].content, "Context — App: Firefox, Window: Docs\n\nhola", "stays in the history like conversationMessages");
    assert_eq!(p.messages[3].content, "y ahora");
    assert_eq!(c.view()["turns"][0]["user_text"], "hola", "the stored and shown text has no context");
}

#[test]
fn a_conversation_without_context_prompts_exactly_as_before() {
    let mut c = convo();
    let a = c.submit("hola", "req-0000000001", &profile()).unwrap();
    assert_eq!(c.prompt_for(&a.turn_id, "SYS", 4096, 512).unwrap().messages[1].content, "hola");
}

#[test]
fn the_context_counts_against_the_token_budget() {
    let mut c = convo();
    let a = c.submit("hola", "req-0000000001", &profile()).unwrap();
    let plain = c.prompt_for(&a.turn_id, "SYS", 4096, 512).unwrap().estimated_tokens;
    c.attach_context(&a.turn_id, &"x".repeat(400));
    assert!(c.prompt_for(&a.turn_id, "SYS", 4096, 512).unwrap().estimated_tokens > plain + 50);
}

// --- S10 (L35): the page reports the chat height it wants (Coucou's growing prompt) ------------------------------------

#[test]
fn the_height_verb_is_exact_closed_and_integer_only() {
    assert_eq!(parse_command(&json!({"action": "height", "height": 280})).unwrap(), Command::Height { height: 280 });
    // the numbers are NOT trusted here either: out-of-range ones parse (Rust clamps them to Coucou's 240..300 later), but only integers
    assert_eq!(parse_command(&json!({"action": "height", "height": -5})).unwrap(), Command::Height { height: -5 });
    assert_eq!(parse_command(&json!({"action": "height", "height": 100000})).unwrap(), Command::Height { height: 100000 });
    for bad in [
        json!({"action": "height"}),
        json!({"action": "height", "height": "280"}),
        json!({"action": "height", "height": 280.5}),
        json!({"action": "height", "height": null}),
        json!({"action": "height", "height": true}),
        json!({"action": "height", "height": 280, "width": 640}),
        json!({"action": "height", "h": 280}),
        json!({"action": "height", "height": 4_294_967_296_i64}),
        json!({"action": "height", "height": [280]}),
    ] {
        assert!(parse_command(&bad).is_err(), "{bad} must be refused");
    }
}

// ---- S3 (#503): the page can show what the live context said on a turn --------------------------

#[test]
fn live_context_is_shown_on_its_turn_only_and_never_changes_the_user_text_or_the_prompt() {
    let mut c = convo();
    let a = c.submit("hola", "req-0000000001", &profile()).unwrap();
    c.attach_live(&a.turn_id, "Estado en vivo\n- Pi en api: trabajando", 2);
    let v = c.view();
    assert_eq!(v["turns"][0]["live_context"], json!({"text": "Estado en vivo\n- Pi en api: trabajando", "trimmed_lines": 2}));
    assert_eq!(v["turns"][0]["user_text"], "hola");
    assert_eq!(c.prompt_for(&a.turn_id, "SYS", 4096, 512).unwrap().messages[1].content, "hola", "the history never carries it");
    c.apply(&a.turn_id, 1, Event::Delta("ok".into())).unwrap();
    c.apply(&a.turn_id, 2, Event::Complete(FinishReason::Stop)).unwrap();
    let b = c.submit("otra", "req-0000000002", &profile()).unwrap();
    assert!(c.view()["turns"][1].get("live_context").is_none(), "a turn without the context has no key");
    let _ = b;
}

#[test]
fn a_turn_projection_without_live_context_is_unchanged() {
    let mut c = convo();
    c.submit("hola", "req-0000000001", &profile()).unwrap();
    assert!(c.view()["turns"][0].get("live_context").is_none());
}

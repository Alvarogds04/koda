//! K2-05 U5b — tests for what the island chat contract still parses.
//!
//! The in-memory conversation (`Conversation`, `Turn`, the turn states, the producer
//! `Event`, tool/approval receipts and the presentation cache) left with the 0.1
//! conversation store; its tests left with it. What is exercised here is the closed
//! `chat_action` verb set, the id shapes it validates and the typed safe errors.

use super::*;
use serde_json::json;

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

/// K2-05 U5b (was `conversations::valid_id`): the page still passes a conversation id
/// back in `restore`/`history`, so the shape stays even though the store is gone.
#[test]
fn conversation_ids_are_c_prefixed_tokens() {
    assert!(valid_conversation_id("c-koda"));
    assert!(valid_conversation_id("c-1712345678901234567-4242-0"));
    assert!(!valid_conversation_id("c-1"), "shorter than the 4-byte minimum");
    assert!(valid_conversation_id("c-12"), "the minimum accepted length is exactly 4 bytes");
    assert!(!valid_conversation_id("t-1234"), "turn ids are a different shape");
    assert!(!valid_conversation_id("c-"));
    assert!(!valid_conversation_id("c-../escape"));
    assert!(!valid_conversation_id(&format!("c-{}", "a".repeat(79))), "capped at 80 bytes");
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

/// The conversation verbs the host refuses (`conversations_off`: one continuous chat)
/// still PARSE here, with the id shape they always had — refusing is the host's job.
#[test]
fn conversation_verbs_parse_and_validate_the_id_shape() {
    assert_eq!(parse_command(&json!({"action": "new"})).unwrap(), Command::New);
    assert_eq!(parse_command(&json!({"action": "new_with", "specialist_id": null})).unwrap(), Command::NewWith { specialist_id: None });
    assert_eq!(parse_command(&json!({"action": "list"})).unwrap(), Command::List);
    assert_eq!(
        parse_command(&json!({"action": "restore", "conversation_id": "c-koda"})).unwrap(),
        Command::Restore { conversation_id: "c-koda".into() }
    );
    assert_eq!(
        parse_command(&json!({"action": "history", "conversation_id": "c-koda", "before": null})).unwrap(),
        Command::History { conversation_id: "c-koda".into(), before: None }
    );
    assert_eq!(
        parse_command(&json!({"action": "history", "conversation_id": "c-koda", "before": 12})).unwrap(),
        Command::History { conversation_id: "c-koda".into(), before: Some(12) }
    );
    for bad in [
        json!({"action": "restore", "conversation_id": "x"}),
        json!({"action": "restore", "conversation_id": "c-../x"}),
        json!({"action": "history", "conversation_id": "t-1", "before": null}),
        json!({"action": "history", "conversation_id": "c-koda", "before": 0}),
        json!({"action": "history", "conversation_id": "c-koda"}),
    ] {
        assert_eq!(parse_command(&bad).unwrap_err().code, "invalid_input", "{bad}");
    }
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
fn safe_errors_name_what_to_do() {
    assert!(ChatError::attachment_unavailable().safe_message.contains("ya no está disponible"));
    assert!(ChatError::vision_unsupported().safe_message.contains("no puede leer imágenes"));
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

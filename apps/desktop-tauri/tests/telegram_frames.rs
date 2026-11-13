//! K2-13 T6b-3 (S7, S10, S16, S18, S20): the Telegram and transcription frames in the island agent client.
//!
//! Two halves, both pure (no daemon, no socket, no window):
//! 1. the CLOSED command allowlist the page may use — the six Telegram verbs, `transcription_get`/`transcription_set`
//!    and nothing else. Every field is validated with the daemon's own rules before anything is written, an unknown
//!    field is NOT a command, and the ninth frame of the contract (`telegram_session`) is a REPLY: the island folds it
//!    into the host's keychain hand-off and never sends it;
//! 2. the FOLD of `telegram_status` / `transcription` into bounded closed views, plus the one rule that matters most:
//!    the session string NEVER lands in the state the WebView receives.
use koda_island::agentclient::{carriable_session, parse_ui_command, ClientState, UiCommand};
use serde_json::{json, Value};

const HASH: &str = "8f3c1d9ae2b74c05d61fa8b3c0e7d294";
const SESSION: &str = "AQAAAAAabcdef0123456789+/base64sessionstring==";

fn wire(payload: Value) -> Value {
    match parse_ui_command(&payload) {
        Ok(UiCommand::Wire(line)) => {
            let text = line.strip_suffix('\n').expect("every wire line ends in one LF");
            serde_json::from_str(text).expect("the wire line is one JSON object")
        }
        other => panic!("expected one wire command for {payload}, got {other:?}"),
    }
}

fn view(state: &ClientState) -> Value {
    serde_json::to_value(state).expect("ClientState serialises")
}

// ----- the closed command allowlist -------------------------------------------------------

#[test]
fn the_fieldless_verbs_are_one_closed_ask_each() {
    for verb in ["telegram_status", "telegram_logout", "transcription_get"] {
        assert_eq!(wire(json!({ "action": verb })), json!({ "type": verb }), "{verb}");
        for bad in [json!({ "action": verb, "id": "x" }), json!({ "action": verb, "force": true })] {
            assert!(parse_ui_command(&bad).is_err(), "{verb} must refuse {bad}");
        }
    }
}

#[test]
fn login_start_carries_the_three_fields_the_daemon_validates() {
    let line = wire(json!({ "action": "telegram_login_start", "apiId": 20405128, "apiHash": HASH, "phone": "+5491155554321" }));
    assert_eq!(
        line,
        json!({ "type": "telegram_login_start", "apiId": 20405128, "apiHash": HASH, "phone": "+5491155554321" })
    );
}

#[test]
fn an_api_id_outside_the_daemon_bounds_is_not_a_command() {
    for api_id in [json!(0), json!(-1), json!(2_147_483_648u64), json!(1.5), json!("20405128"), json!(null)] {
        let payload = json!({ "action": "telegram_login_start", "apiId": api_id, "apiHash": HASH, "phone": "+5491155554321" });
        assert!(parse_ui_command(&payload).is_err(), "apiId {api_id} must be refused");
    }
    for ok in [json!(1), json!(20405128), json!(2_147_483_647u64)] {
        let payload = json!({ "action": "telegram_login_start", "apiId": ok, "apiHash": HASH, "phone": "+5491155554321" });
        assert!(parse_ui_command(&payload).is_ok(), "apiId {ok} is valid");
    }
}

#[test]
fn the_api_hash_is_exactly_thirty_two_lowercase_hex() {
    for bad in [
        String::new(),
        "8f3c1d9ae2b74c05d61fa8b3c0e7d29".to_string(),   // 31
        format!("{HASH}0"),                                // 33
        HASH.to_uppercase(),                               // uppercase is not the daemon's contract
        "8f3c1d9ae2b74c05d61fa8b3c0e7d29z".to_string(),    // not hex
        " 8f3c1d9ae2b74c05d61fa8b3c0e7d29".to_string(),
    ] {
        let payload = json!({ "action": "telegram_login_start", "apiId": 1, "apiHash": bad, "phone": "+5491155554321" });
        assert!(parse_ui_command(&payload).is_err(), "apiHash {bad:?} must be refused");
    }
}

#[test]
fn the_phone_must_be_e164() {
    for bad in ["", "+", "+0123456789", "5491155554321", "+123456", "+54911555543211234", "+54 911 5555 4321", "+54911abc4321"] {
        let payload = json!({ "action": "telegram_login_start", "apiId": 1, "apiHash": HASH, "phone": bad });
        assert!(parse_ui_command(&payload).is_err(), "phone {bad:?} must be refused");
    }
    for ok in ["+549115555432", "+12025550123", "+123456789012345"] {
        let payload = json!({ "action": "telegram_login_start", "apiId": 1, "apiHash": HASH, "phone": ok });
        assert!(parse_ui_command(&payload).is_ok(), "phone {ok} is valid E.164");
    }
}

#[test]
fn a_login_payload_with_a_stray_field_is_not_a_command() {
    for bad in [
        json!({ "action": "telegram_login_start", "apiId": 1, "apiHash": HASH, "phone": "+5491155554321", "api_hash": HASH }),
        json!({ "action": "telegram_login_start", "apiId": 1, "apiHash": HASH }),
        json!({ "action": "telegram_login_code", "code": "48121", "password": "x" }),
        json!({ "action": "telegram_login_password", "password": "x", "code": "48121" }),
        json!({ "action": "telegram_session_restore", "apiId": 1, "apiHash": HASH, "session": SESSION, "phone": "+5491155554321" }),
    ] {
        assert!(parse_ui_command(&bad).is_err(), "must refuse {bad}");
    }
}

#[test]
fn the_code_and_the_password_are_bounded_and_lose_no_bound() {
    assert_eq!(
        wire(json!({ "action": "telegram_login_code", "code": "48121" })),
        json!({ "type": "telegram_login_code", "code": "48121" })
    );
    for bad in ["", &"1".repeat(33), "48\u{7}121", "4812\n1"] {
        assert!(parse_ui_command(&json!({ "action": "telegram_login_code", "code": bad })).is_err(), "code {bad:?}");
    }
    assert_eq!(
        wire(json!({ "action": "telegram_login_password", "password": "una contraseña de dos pasos ñ" })),
        json!({ "type": "telegram_login_password", "password": "una contraseña de dos pasos ñ" })
    );
    for bad in [String::new(), "x".repeat(1025), "con\u{0}trol".to_string()] {
        assert!(parse_ui_command(&json!({ "action": "telegram_login_password", "password": bad })).is_err(), "password len {}", bad.len());
    }
}

#[test]
fn a_restored_session_must_satisfy_the_daemons_carry_contract() {
    let line = wire(json!({ "action": "telegram_session_restore", "apiId": 1, "apiHash": HASH, "session": SESSION }));
    assert_eq!(line, json!({ "type": "telegram_session_restore", "apiId": 1, "apiHash": HASH, "session": SESSION }));
    for bad in [String::new(), "sesión".to_string(), "a\nb".to_string(), "x".repeat(4097)] {
        let payload = json!({ "action": "telegram_session_restore", "apiId": 1, "apiHash": HASH, "session": bad });
        assert!(parse_ui_command(&payload).is_err(), "session {} chars must be refused", bad.len());
    }
    assert!(carriable_session(&"x".repeat(4096)), "the daemon's own bound is accepted");
}

#[test]
fn transcription_set_travels_exactly_as_the_daemon_validates_it() {
    let local = wire(json!({ "action": "transcription_set", "setting": { "mode": "local-parakeet" } }));
    assert_eq!(local, json!({ "type": "transcription_set", "setting": { "mode": "local-parakeet", "language": "es" } }));
    let remote = wire(json!({ "action": "transcription_set",
        "setting": { "mode": "remote", "language": "en", "remote": { "accountId": "nan-cuenta", "model": "whisper" } } }));
    assert_eq!(remote, json!({ "type": "transcription_set",
        "setting": { "mode": "remote", "language": "en", "remote": { "accountId": "nan-cuenta", "model": "whisper" } } }));
}

#[test]
fn a_transcription_setting_off_contract_is_not_a_command() {
    for bad in [
        // S18: whisper-turbo was REMOVED from the contract — the page has no way to even offer it
        json!({ "action": "transcription_set", "setting": { "mode": "local-whisper-turbo" } }),
        json!({ "action": "transcription_set", "setting": { "mode": "remote" } }),
        json!({ "action": "transcription_set", "setting": { "mode": "local-parakeet", "remote": { "accountId": "a", "model": "m" } } }),
        json!({ "action": "transcription_set", "setting": { "mode": "local-parakeet", "baseUrl": "https://x" } }),
        json!({ "action": "transcription_set", "setting": { "mode": "local-parakeet", "language": "xx" } }),
        json!({ "action": "transcription_set", "setting": { "mode": "remote", "remote": { "accountId": "A", "model": "m" } } }),
        json!({ "action": "transcription_set", "setting": { "mode": "remote", "remote": { "accountId": "a", "model": "" } } }),
        json!({ "action": "transcription_set", "setting": { "mode": "remote", "remote": { "accountId": "a", "model": "m", "baseUrl": "https://x" } } }),
        json!({ "action": "transcription_set", "setting": "local-parakeet" }),
        json!({ "action": "transcription_set" }),
    ] {
        assert!(parse_ui_command(&bad).is_err(), "must refuse {bad}");
    }
}

// ----- the fold --------------------------------------------------------------------------

#[test]
fn a_status_folds_into_its_closed_view_and_nothing_else() {
    let mut state = ClientState::connected();
    state
        .apply(&json!({
            "type": "telegram_status", "state": "connected",
            "account": { "name": "Álvaro", "username": "alvaro" },
            "phone": "+5491155554321", "apiHash": HASH, "session": SESSION, "extra": { "anything": true }
        }))
        .unwrap();
    let telegram = &view(&state)["telegram"];
    assert_eq!(telegram["state"], json!("connected"));
    assert_eq!(telegram["account"], json!({ "name": "Álvaro", "username": "alvaro" }));
    let text = telegram.to_string();
    assert!(!text.contains("+5491155554321"), "the phone never reaches the page: {text}");
    assert!(!text.contains(HASH), "the api hash never reaches the page: {text}");
    assert!(!text.contains(SESSION), "the session never reaches the page: {text}");
    assert!(telegram.get("extra").is_none(), "an unknown field is dropped: {text}");
}

#[test]
fn an_off_vocabulary_status_changes_nothing() {
    let mut state = ClientState::connected();
    state.apply(&json!({ "type": "telegram_status", "state": "connected", "account": { "name": "Álvaro", "username": null } })).unwrap();
    let before = view(&state)["telegram"].clone();
    for bad in [
        json!({ "type": "telegram_status", "state": "logged_in" }),
        json!({ "type": "telegram_status" }),
        json!({ "type": "telegram_status", "state": 42 }),
    ] {
        state.apply(&bad).unwrap();
        assert_eq!(view(&state)["telegram"], before, "must not touch the view: {bad}");
    }
}

#[test]
fn the_account_name_is_bounded_and_a_bad_username_is_dropped() {
    let mut state = ClientState::connected();
    state.apply(&json!({ "type": "telegram_status", "state": "connected",
        "account": { "name": "x".repeat(500), "username": "con espacio" } })).unwrap();
    let account = &view(&state)["telegram"]["account"];
    assert!(account["name"].as_str().unwrap().chars().count() <= 80, "the name is clipped: {}", account["name"]);
    assert_eq!(account["username"], Value::Null, "an off-contract username becomes an honest unknown");
}

#[test]
fn the_flood_wait_detail_survives_and_stays_bounded() {
    let mut state = ClientState::connected();
    state.apply(&json!({ "type": "telegram_status", "state": "awaiting_code",
        "notice": "Telegram pidió esperar 3 minutos.", "retryAfterMinutes": 3 })).unwrap();
    let telegram = &view(&state)["telegram"];
    assert_eq!(telegram["notice"], json!("Telegram pidió esperar 3 minutos."));
    assert_eq!(telegram["retryAfterMinutes"], json!(3));
    for bad in [json!(0), json!(1441), json!("3")] {
        state.apply(&json!({ "type": "telegram_status", "state": "awaiting_code", "retryAfterMinutes": bad })).unwrap();
        assert!(view(&state)["telegram"].get("retryAfterMinutes").is_none(), "retryAfterMinutes {bad} is not a minute count");
    }
    state.apply(&json!({ "type": "telegram_status", "state": "awaiting_code", "notice": "ma\u{7}l" })).unwrap();
    assert!(view(&state)["telegram"].get("notice").is_none(), "a notice with a control character never reaches the page");
}

#[test]
fn the_session_reply_is_parked_for_the_host_and_never_serialised() {
    let mut state = ClientState::connected();
    state.apply(&json!({ "type": "telegram_session", "session": SESSION })).unwrap();
    let serialized = view(&state).to_string();
    assert!(!serialized.contains(SESSION), "the session must never be serialised into the page view: {serialized}");
    let parsed: Value = serde_json::from_str(&serialized).expect("the view is JSON");
    assert!(parsed.get("session").is_none(), "not even the key travels: {serialized}");
    assert!(state.has_pending_session());
    assert_eq!(state.take_session().as_deref(), Some(SESSION), "the host takes it once");
    assert!(!state.has_pending_session(), "and only once");
    assert!(state.take_session().is_none());
}

#[test]
fn debug_output_never_carries_a_secret() {
    // `{:?}` reaches panic messages, `assert_eq!` failures and any future `dbg!`: none of them may print a secret.
    let mut state = ClientState::connected();
    state.apply(&json!({ "type": "telegram_session", "session": SESSION })).unwrap();
    assert!(state.has_pending_session());
    let printed = format!("{state:?}");
    assert!(!printed.contains(SESSION), "the parked session must not be printed: {printed}");
    for payload in [
        json!({ "action": "telegram_login_start", "apiId": 20405128, "apiHash": HASH, "phone": "+5491155554321" }),
        json!({ "action": "telegram_login_code", "code": "48151" }),
        json!({ "action": "telegram_login_password", "password": "hunter2-2fa" }),
    ] {
        let command = parse_ui_command(&payload).expect("a valid Telegram command");
        let printed = format!("{command:?}");
        for secret in [HASH, "+5491155554321", "48151", "hunter2-2fa"] {
            assert!(!printed.contains(secret), "the command must not print {secret}: {printed}");
        }
    }
}

#[test]
fn the_session_reply_of_a_lying_daemon_is_dropped() {
    let mut state = ClientState::connected();
    for bad in [json!(""), json!("sesión"), json!("a\nb"), json!("x".repeat(4097)), json!(42)] {
        state.apply(&json!({ "type": "telegram_session", "session": bad })).unwrap();
        assert!(!state.has_pending_session(), "session {bad} is not one this island stores");
    }
}

#[test]
fn a_transcription_setting_folds_with_its_tools() {
    let mut state = ClientState::connected();
    state.apply(&json!({ "type": "transcription",
        "setting": { "mode": "local-parakeet", "language": "es" }, "ffmpeg": "available", "local": "available" })).unwrap();
    assert_eq!(
        view(&state)["transcription"],
        json!({ "setting": { "mode": "local-parakeet", "language": "es" }, "ffmpeg": "available", "local": "available" })
    );
    state.apply(&json!({ "type": "transcription",
        "setting": { "mode": "remote", "language": "en", "remote": { "accountId": "nan", "model": "whisper", "baseUrl": "https://x" } },
        "ffmpeg": "unavailable", "local": "available" })).unwrap();
    let remote = &view(&state)["transcription"];
    assert_eq!(remote["setting"]["remote"], json!({ "accountId": "nan", "model": "whisper" }), "a base URL never rides along");
    assert_eq!(remote["ffmpeg"], json!("unavailable"));
}

#[test]
fn an_off_vocabulary_transcription_frame_changes_nothing() {
    let mut state = ClientState::connected();
    state.apply(&json!({ "type": "transcription", "setting": { "mode": "local-parakeet", "language": "es" },
        "ffmpeg": "available", "local": "available" })).unwrap();
    let before = view(&state)["transcription"].clone();
    for bad in [
        // S18: the removed local Whisper option is not a mode any more
        json!({ "type": "transcription", "setting": { "mode": "local-whisper-turbo", "language": "es" }, "ffmpeg": "available", "local": "available" }),
        json!({ "type": "transcription", "setting": { "mode": "remote", "language": "es" }, "ffmpeg": "available", "local": "available" }),
        json!({ "type": "transcription", "setting": { "mode": "remote", "language": "es", "remote": { "accountId": "A", "model": "m" } }, "ffmpeg": "available", "local": "available" }),
        json!({ "type": "transcription", "setting": { "mode": "local-parakeet", "language": "es" }, "ffmpeg": "maybe", "local": "available" }),
        json!({ "type": "transcription", "setting": { "mode": "local-parakeet", "language": "es" }, "local": "available" }),
        json!({ "type": "transcription" }),
    ] {
        state.apply(&bad).unwrap();
        assert_eq!(view(&state)["transcription"], before, "must not touch the view: {bad}");
    }
}

#[test]
fn the_telegram_refusals_reach_the_page_as_closed_codes() {
    for code in [
        "telegram_login_other_connection",
        "telegram_flood_wait",
        "telegram_session_invalid",
        "telegram_code_invalid",
        "telegram_password_invalid",
        "telegram_credentials_invalid",
        "telegram_already_connected",
    ] {
        let mut state = ClientState::connected();
        state.apply(&json!({ "type": "error", "code": code })).unwrap();
        assert_eq!(view(&state)["last_error"]["code"], json!(code), "a refused Telegram verb is read by its code");
    }
    let mut state = ClientState::connected();
    state.apply(&json!({ "type": "error", "code": "telegram_anything" })).unwrap();
    assert_eq!(view(&state)["last_error"]["code"], json!("failed"), "an unknown code is never invented");
}

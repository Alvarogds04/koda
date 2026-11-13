//! K2-13 T6b-1 (S2/S3/S5/S13): the «Hoy» frames in the island agent client.
//!
//! Two halves, both pure (no daemon, no network, no window):
//! 1. the CLOSED command allowlist the page can use — `hoy_list`, `hoy_approve {id}`, `hoy_reject {id}` and
//!    nothing else: a `pin` (or any stray field) must never reach the daemon, and an id that is not a lowercase
//!    uuid is refused before anything is written to the socket;
//! 2. the FOLD of the daemon's `hoy` / `hoy_decided` / `hoy_approved` frames into one bounded, closed view the page
//!    renders as text: rows are rebuilt field by field, an off-vocabulary row is dropped (never sanitised into a
//!    lie), text loses its control and bidi characters, and the frame's own `truncated` flag survives.
use abito_island::agentclient::{parse_ui_command, ClientState, UiCommand};
use serde_json::{json, Value};

const A: &str = "0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b";
const B: &str = "11111111-2222-4333-8444-555555555555";
const C: &str = "22222222-3333-4444-8555-666666666666";
const D: &str = "33333333-4444-4555-8666-777777777777";
const E: &str = "44444444-5555-4666-8777-888888888888";

fn connected(items: Value) -> ClientState {
    let mut state = ClientState::connected();
    state.apply(&json!({ "type": "hoy", "items": items, "truncated": false })).expect("hoy frame folds");
    state
}

fn hoy(state: &ClientState) -> Value {
    let v = serde_json::to_value(state).expect("ClientState serialises");
    v.get("hoy").cloned().expect("the closed state carries a `hoy` view")
}

fn rows(state: &ClientState) -> Vec<Value> {
    hoy(state)["items"].as_array().cloned().expect("items is an array")
}

// ----- the closed command allowlist -------------------------------------------------------

#[test]
fn hoy_list_is_the_only_read_and_has_no_fields() {
    match parse_ui_command(&json!({ "action": "hoy_list" })) {
        Ok(UiCommand::Wire(w)) => assert_eq!(w, "{\"type\":\"hoy_list\"}\n"),
        other => panic!("hoy_list must be one closed ask, got {other:?}"),
    }
    for bad in [json!({"action": "hoy_list", "id": A}), json!({"action": "hoy_list", "all": true})] {
        assert!(parse_ui_command(&bad).is_err(), "must refuse {bad}");
    }
}

#[test]
fn approve_and_reject_carry_exactly_the_id() {
    for (action, line) in [
        ("hoy_approve", format!("{{\"type\":\"hoy_approve\",\"id\":\"{A}\"}}\n")),
        ("hoy_reject", format!("{{\"type\":\"hoy_reject\",\"id\":\"{A}\"}}\n")),
    ] {
        match parse_ui_command(&json!({ "action": action, "id": A })) {
            Ok(UiCommand::Wire(w)) => assert_eq!(w, line),
            other => panic!("{action} must be one closed line, got {other:?}"),
        }
    }
}

#[test]
fn no_pin_and_no_stray_field_can_ride_an_approval() {
    // Human decision L17 removed the PIN: the page has no way to even offer one.
    for bad in [
        json!({ "action": "hoy_approve", "id": A, "pin": "123456" }),
        json!({ "action": "hoy_reject", "id": A, "pin": "123456" }),
        json!({ "action": "hoy_approve", "id": A, "force": true }),
        json!({ "action": "hoy_approve" }),
        json!({ "action": "hoy_approve", "id": A, "note": "si" }),
    ] {
        assert!(parse_ui_command(&bad).is_err(), "must refuse {bad}");
    }
}

#[test]
fn the_id_must_be_a_lowercase_uuid() {
    for bad in ["", "not-a-uuid", "0B3A5C9E-8F27-4D11-9A0E-1C2D3E4F5A6B", "0b3a5c9e8f274d119a0e1c2d3e4f5a6b", "../../etc/passwd", &format!("{A} ")] {
        let payload = json!({ "action": "hoy_approve", "id": bad });
        assert!(parse_ui_command(&payload).is_err(), "must refuse id {bad:?}");
    }
}

// ----- the fold --------------------------------------------------------------------------

#[test]
fn a_proposal_keeps_its_action_target_and_text() {
    let state = connected(json!([{
        "id": A, "minikoda": "valmar", "kind": "proposal", "status": "pending",
        "text": "el balance sale el jueves y el precio está 8 % abajo",
        "action": "buy", "target": "10 CEDEARs de YPF", "createdAt": "2026-11-06T09:12:00.000Z"
    }]));
    let r = rows(&state);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["id"], json!(A));
    assert_eq!(r[0]["minikoda"], json!("valmar"));
    assert_eq!(r[0]["kind"], json!("proposal"));
    assert_eq!(r[0]["status"], json!("pending"));
    assert_eq!(r[0]["action"], json!("buy"));
    assert_eq!(r[0]["target"], json!("10 CEDEARs de YPF"));
    assert!(r[0]["text"].as_str().unwrap().starts_with("el balance"));
    assert_eq!(r[0]["createdAt"], json!("2026-11-06T09:12:00.000Z"));
}

#[test]
fn a_result_carries_no_action_and_no_target() {
    let state = connected(json!([{
        "id": B, "minikoda": "valmar", "kind": "result", "status": "approved",
        "text": "Ve margen en bonos CER.", "createdAt": "2026-11-06T09:30:00.000Z",
        "action": "delete", "target": "/etc/shadow"
    }]));
    let r = rows(&state);
    assert_eq!(r.len(), 1);
    assert!(r[0].get("action").is_none(), "a result never carries an action");
    assert!(r[0].get("target").is_none(), "a result never carries a target");
}

#[test]
fn off_vocabulary_rows_are_dropped_never_sanitised() {
    let state = connected(json!([
        { "id": "not-a-uuid", "minikoda": "valmar", "kind": "result", "status": "approved", "text": "x", "createdAt": "2026-11-06T09:30:00.000Z" },
        { "id": A, "minikoda": "../../etc", "kind": "result", "status": "approved", "text": "x", "createdAt": "2026-11-06T09:30:00.000Z" },
        { "id": A, "minikoda": "valmar", "kind": "notice", "status": "approved", "text": "x", "createdAt": "2026-11-06T09:30:00.000Z" },
        { "id": A, "minikoda": "valmar", "kind": "result", "status": "maybe", "text": "x", "createdAt": "2026-11-06T09:30:00.000Z" },
        { "id": A, "minikoda": "valmar", "kind": "proposal", "status": "pending", "text": "x", "action": "delete", "target": "todo", "createdAt": "2026-11-06T09:30:00.000Z" },
        { "id": A, "minikoda": "valmar", "kind": "proposal", "status": "pending", "text": "x", "createdAt": "2026-11-06T09:30:00.000Z" },
        "not even an object"
    ]));
    assert!(rows(&state).is_empty(), "no row survives: {:?}", rows(&state));
}

#[test]
fn text_loses_control_and_bidi_characters_and_is_capped() {
    let state = connected(json!([{
        "id": A, "minikoda": "valmar", "kind": "result", "status": "approved",
        "text": format!("hola\u{0}\u{202e}mu\u{7}\u{200b}ndo {}", "a".repeat(9000)),
        "createdAt": "2026-11-06T09:30:00.000Z"
    }]));
    let text = rows(&state)[0]["text"].as_str().unwrap().to_string();
    assert!(!text.contains('\u{0}') && !text.contains('\u{202e}') && !text.contains('\u{200b}') && !text.contains('\u{7}'), "{text:?}");
    assert!(text.starts_with("holamundo"), "{text:?}");
    assert!(text.chars().count() <= 4000, "text is capped ({} chars)", text.chars().count());
}

#[test]
fn text_loses_the_whole_unicode_format_set_and_the_separators() {
    // One representative of every Cf group — soft hyphen, Arabic letter mark, Arabic number sign, Mongolian vowel
    // separator, word joiner, tag letter, Egyptian and musical format controls, interlinear annotation — plus the
    // line/paragraph separators (Zl/Zp), which are not Cc and used to survive.
    let nasty = "comprar\u{ad}\u{61c}\u{600}\u{6dd}\u{890}\u{180e}\u{2060}\u{e0041}\u{13430}\u{1d173}\u{fff9}\u{2028}\u{2029} YPF";
    let state = connected(json!([{
        "id": A, "minikoda": "valmar", "kind": "result", "status": "approved", "text": nasty,
        "createdAt": "2026-11-06T09:30:00.000Z"
    }]));
    let text = rows(&state)[0]["text"].as_str().unwrap().to_string();
    for c in ['\u{ad}', '\u{61c}', '\u{600}', '\u{6dd}', '\u{890}', '\u{180e}', '\u{2060}', '\u{e0041}', '\u{13430}', '\u{1d173}', '\u{fff9}', '\u{2028}', '\u{2029}'] {
        assert!(!text.contains(c), "{c:?} must not reach the page: {text:?}");
    }
    assert_eq!(text, "comprar YPF");
}

#[test]
fn ordinary_text_keeps_its_accents_and_spaces() {
    let state = connected(json!([{
        "id": A, "minikoda": "valmar", "kind": "result", "status": "approved",
        "text": "ñandú, ¿qué tal? · año 2026", "createdAt": "2026-11-06T09:30:00.000Z"
    }]));
    assert_eq!(rows(&state)[0]["text"], json!("ñandú, ¿qué tal? · año 2026"));
}

#[test]
fn a_decision_is_final_and_pending_is_never_one() {
    let mut state = connected(json!([{
        "id": A, "minikoda": "valmar", "kind": "proposal", "status": "pending", "text": "comprar", "action": "buy",
        "target": "YPF", "createdAt": "2026-11-06T09:12:00.000Z"
    }]));
    // `pending` is a STATUS, not a decision: a frame that carries it decides nothing
    state.apply(&json!({ "type": "hoy_decided", "id": A, "status": "pending", "executedAt": "2026-11-06T09:46:00.000Z" })).unwrap();
    assert_eq!(rows(&state)[0]["status"], json!("pending"), "a pending status never decides anything");
    assert!(rows(&state)[0].get("decidedAt").is_none(), "and never stamps a decision");
    // pending -> approved is the one transition a proposal has
    state.apply(&json!({ "type": "hoy_decided", "id": A, "status": "approved" })).unwrap();
    assert_eq!(rows(&state)[0]["status"], json!("approved"));
    // a SECOND decision is ignored: the row keeps what the daemon recorded first
    state.apply(&json!({ "type": "hoy_decided", "id": A, "status": "rejected" })).unwrap();
    assert_eq!(rows(&state)[0]["status"], json!("approved"), "a decision is final");
    state.apply(&json!({ "type": "hoy_decided", "id": A, "status": "approved" })).unwrap();
    assert_eq!(rows(&state)[0]["status"], json!("approved"));
    // the execution record of the SAME decision still stamps its time
    let mut timed = connected(json!([{
        "id": A, "minikoda": "valmar", "kind": "proposal", "status": "pending", "text": "comprar", "action": "buy",
        "target": "YPF", "createdAt": "2026-11-06T09:12:00.000Z"
    }]));
    timed.apply(&json!({ "type": "hoy_decided", "id": A, "status": "approved" })).unwrap();
    timed.apply(&json!({ "type": "hoy_approved", "id": A, "executedAt": "2026-11-06T09:46:00.000Z" })).unwrap();
    assert_eq!(rows(&timed)[0]["status"], json!("approved"));
    assert_eq!(rows(&timed)[0]["decidedAt"], json!("2026-11-06T09:46:00.000Z"), "the execution record of the same decision still stamps its time");
    // ...and so is a rejected one
    let mut rejected = connected(json!([{
        "id": B, "minikoda": "valmar", "kind": "proposal", "status": "rejected", "text": "vender", "action": "sell",
        "target": "Pampa", "createdAt": "2026-11-06T09:13:00.000Z"
    }]));
    rejected.apply(&json!({ "type": "hoy_approved", "id": B, "executedAt": "2026-11-06T09:47:00.000Z" })).unwrap();
    assert_eq!(rows(&rejected)[0]["status"], json!("rejected"), "an execution record never re-opens a rejected row");
}

#[test]
fn provenance_is_a_closed_field_the_island_may_show() {
    // S19 / F4: the daemon says where a result's text came from, when it can. Three values, and the island shows a chip
    // for exactly those; anything else is dropped, never guessed at (the daemon validates it too).
    let state = connected(json!([
        { "id": A, "minikoda": "videos", "kind": "result", "status": "approved", "text": "uno", "createdAt": "2026-11-06T08:15:00.000Z", "provenance": "youtube_subtitles" },
        { "id": B, "minikoda": "videos", "kind": "result", "status": "approved", "text": "otro", "createdAt": "2026-11-06T08:16:00.000Z", "provenance": "made_up" },
        { "id": C, "minikoda": "videos", "kind": "result", "status": "approved", "text": "tercero", "createdAt": "2026-11-06T08:17:00.000Z", "provenance": "local_transcription" },
        { "id": D, "minikoda": "videos", "kind": "result", "status": "approved", "text": "cuarto", "createdAt": "2026-11-06T08:18:00.000Z", "provenance": "remote_transcription" },
        { "id": E, "minikoda": "videos", "kind": "result", "status": "approved", "text": "quinto", "createdAt": "2026-11-06T08:19:00.000Z" }
    ]));
    let r = rows(&state);
    assert_eq!(r[0]["provenance"], json!("youtube_subtitles"));
    assert!(r[1].get("provenance").is_none(), "an off-vocabulary provenance is dropped, never shown");
    assert_eq!(r[2]["provenance"], json!("local_transcription"));
    assert_eq!(r[3]["provenance"], json!("remote_transcription"), "the user's own transcribing account is a value too");
    assert!(r[4].get("provenance").is_none(), "a result whose source cannot be named carries no provenance at all");
}

#[test]
fn the_frame_order_is_kept_and_truncated_survives() {
    let mut state = ClientState::connected();
    state
        .apply(&json!({
            "type": "hoy", "truncated": true,
            "items": [
                { "id": A, "minikoda": "valmar", "kind": "proposal", "status": "pending", "text": "primera", "action": "buy", "target": "YPF", "createdAt": "2026-11-06T09:12:00.000Z" },
                { "id": B, "minikoda": "valmar", "kind": "result", "status": "approved", "text": "segunda", "createdAt": "2026-11-06T09:30:00.000Z" }
            ]
        }))
        .unwrap();
    let v = hoy(&state);
    assert_eq!(v["truncated"], json!(true));
    assert_eq!(rows(&state)[0]["text"], json!("primera"), "the daemon's order (pending first) is the island's order");
}

#[test]
fn a_malformed_frame_changes_nothing() {
    let mut state = ClientState::connected();
    state.apply(&json!({ "type": "hoy", "items": [] })).unwrap();
    let before = hoy(&state);
    for bad in [json!({"type": "hoy"}), json!({"type": "hoy", "items": "nope"}), json!({"type": "hoy", "items": {}, "truncated": true})] {
        state.apply(&bad).unwrap();
        assert_eq!(hoy(&state), before, "must not touch the view: {bad}");
    }
}

#[test]
fn a_decision_moves_the_row_without_a_second_ask() {
    let mut state = connected(json!([
        { "id": A, "minikoda": "valmar", "kind": "proposal", "status": "pending", "text": "comprar", "action": "buy", "target": "YPF", "createdAt": "2026-11-06T09:12:00.000Z" },
        { "id": B, "minikoda": "valmar", "kind": "proposal", "status": "pending", "text": "vender", "action": "sell", "target": "Pampa", "createdAt": "2026-11-06T09:13:00.000Z" }
    ]));
    state.apply(&json!({ "type": "hoy_decided", "id": B, "status": "rejected" })).unwrap();
    let r = rows(&state);
    assert_eq!(r[0]["status"], json!("pending"));
    assert_eq!(r[1]["status"], json!("rejected"), "the refused/decided row follows the daemon, not the click");
    state.apply(&json!({ "type": "hoy_approved", "id": A, "minikoda": "valmar", "action": "buy", "target": "YPF", "executedAt": "2026-11-06T09:46:00.000Z" })).unwrap();
    assert_eq!(rows(&state)[0]["status"], json!("approved"));
    // a decision for a row we do not hold changes nothing (never invents a row)
    state.apply(&json!({ "type": "hoy_decided", "id": "99999999-8888-4777-8666-555555555555", "status": "approved" })).unwrap();
    assert_eq!(rows(&state).len(), 2);
}

#[test]
fn an_off_shape_decision_changes_nothing() {
    let mut state = connected(json!([
        { "id": A, "minikoda": "valmar", "kind": "proposal", "status": "pending", "text": "comprar", "action": "buy", "target": "YPF", "createdAt": "2026-11-06T09:12:00.000Z" }
    ]));
    for bad in [
        json!({"type": "hoy_decided", "id": "../../x", "status": "approved"}),
        json!({"type": "hoy_decided", "id": A, "status": "maybe"}),
        json!({"type": "hoy_decided", "id": A}),
    ] {
        state.apply(&bad).unwrap();
    }
    assert_eq!(rows(&state)[0]["status"], json!("pending"));
}

#[test]
fn the_daemon_refusal_reaches_the_page_as_a_closed_code() {
    let mut state = ClientState::connected();
    state.apply(&json!({ "type": "error", "code": "not_pending" })).unwrap();
    let v = serde_json::to_value(&state).unwrap();
    assert_eq!(v["last_error"]["code"], json!("not_pending"), "a refused approval is read by its code");

    let mut state = ClientState::connected();
    state.apply(&json!({ "type": "error", "code": "unknown_item" })).unwrap();
    let v = serde_json::to_value(&state).unwrap();
    assert_eq!(v["last_error"]["code"], json!("unknown_item"));

    // never free text: anything outside the daemon's emitted set reads as `failed`
    let mut state = ClientState::connected();
    state.apply(&json!({ "type": "error", "code": "sudo rm -rf /" })).unwrap();
    let v = serde_json::to_value(&state).unwrap();
    assert_eq!(v["last_error"]["code"], json!("failed"));
}

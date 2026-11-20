//! K3-05 T5 (odd/tasks/k3-05-test-cleanup.md S5): the pure agent-client folds and commands.
//!
//! `hoy_client.rs`, `minikodas_client.rs` and `telegram_frames.rs` each held one family of pure island-client tests
//! (no daemon, no socket, no window) in its own test crate, so Cargo linked three binaries with the same
//! `koda_island::agentclient` + `serde_json` imports. They now share this file, one module per original file.
//!
//! The bodies moved verbatim: every test keeps its name, its helper, its constants and any attribute. They stay in
//! separate modules because the top-level items collide by design (`view` is a `ClientState` serialiser in two of them)
//! and the constants differ.

/// Moved verbatim from `tests/hoy_client.rs`.
mod hoy_client {
    //! K2-13 T6b-1 (S2/S3/S5/S13): the «Hoy» frames in the island agent client.
    //!
    //! Two halves, both pure (no daemon, no network, no window):
    //! 1. the CLOSED command allowlist the page can use — `hoy_list`, `hoy_approve {id}`, `hoy_reject {id}` and
    //!    nothing else: a `pin` (or any stray field) must never reach the daemon, and an id that is not a lowercase
    //!    uuid is refused before anything is written to the socket;
    //! 2. the FOLD of the daemon's `hoy` / `hoy_decided` / `hoy_approved` frames into one bounded, closed view the page
    //!    renders as text: rows are rebuilt field by field, an off-vocabulary row is dropped (never sanitised into a
    //!    lie), text loses its control and bidi characters, and the frame's own `truncated` flag survives.
    use koda_island::agentclient::{parse_ui_command, ClientState, UiCommand};
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
}

/// Moved verbatim from `tests/minikodas_client.rs`.
mod minikodas_client {
    //! welcome-minikodas T2 (odd/tasks/welcome-minikodas.md S4/S5): the «minikodas» list in the island agent client.
    //!
    //! Two halves, both pure (no daemon, no network, no window), the same shape as `hoy_client.rs`:
    //! 1. the CLOSED command the page may use to READ the list — `minikodas_list` with no fields — and nothing that
    //!    creates, launches, edits or deletes a Minikoda (launching could spend a model: out of scope, S5);
    //! 2. the FOLD of the daemon's `minikodas` frame into one bounded, closed view the page draws as plain discs with a
    //!    name: rows are rebuilt field by field, an off-vocabulary row is dropped, text loses control and bidi
    //!    characters, and the sensitive parts of a Minikoda (its prompt, summary, sources, kit, rules, model, run
    //!    reason) NEVER reach the page.
    use koda_island::agentclient::{parse_ui_command, ClientState, UiCommand};
    use serde_json::{json, Value};

    fn view(state: &ClientState) -> Value {
        let v = serde_json::to_value(state).expect("ClientState serialises");
        v.get("minikodas").cloned().expect("the closed state carries a `minikodas` view")
    }

    fn items(state: &ClientState) -> Vec<Value> {
        view(state)["items"].as_array().cloned().expect("items is an array")
    }

    fn fold(list: Value) -> ClientState {
        let mut state = ClientState::connected();
        state.apply(&json!({ "type": "minikodas", "minikodas": list })).expect("minikodas frame folds");
        state
    }

    fn full(id: &str, name: &str) -> Value {
        json!({
            "id": id, "name": name, "when": "cada lunes a las 9", "status": "active", "running": false,
            "reads": [{ "kind": "file", "source": "/home/alvaro/secreto.txt" }], "kit": ["gmail"], "never": ["SECRET-RULE"],
            "model": { "accountId": "SECRET-ACCOUNT" }, "createdAt": "2026-11-16T10:00:00.000Z",
            "lastRun": { "at": "2026-11-16T11:00:00.000Z", "outcome": "done", "reason": "SECRET-REASON" },
            "summary": { "sections": [{ "key": "k", "title": "t", "text": "SECRET-SUMMARY" }], "text": "SECRET-SUMMARY" },
            "prompt": "SECRET-PROMPT",
        })
    }

    // ----- the closed command ------------------------------------------------------------------

    #[test]
    fn minikodas_list_is_one_closed_read_with_no_fields() {
        match parse_ui_command(&json!({ "action": "minikodas_list" })) {
            Ok(UiCommand::Wire(w)) => assert_eq!(w, "{\"type\":\"minikodas_list\"}\n"),
            other => panic!("minikodas_list must be one closed ask, got {other:?}"),
        }
        for bad in [json!({"action": "minikodas_list", "id": "mk-1"}), json!({"action": "minikodas_list", "all": true})] {
            assert!(parse_ui_command(&bad).is_err(), "must refuse {bad}");
        }
    }

    #[test]
    fn nothing_that_changes_or_launches_a_minikoda_is_a_command() {
        for action in ["minikodas_create", "minikoda_create", "minikoda_run", "minikoda_launch", "minikoda_delete", "minikoda_approve", "minikodas_run"] {
            assert!(parse_ui_command(&json!({ "action": action, "id": "mk-1" })).is_err(), "{action} must not be a UI command");
        }
    }

    // ----- the fold ------------------------------------------------------------------------------

    #[test]
    fn the_view_is_null_until_the_daemon_answers() {
        let state = ClientState::connected();
        let v = serde_json::to_value(&state).unwrap();
        assert!(v.get("minikodas").map(Value::is_null).unwrap_or(false), "no `minikodas` answer yet → null, got {:?}", v.get("minikodas"));
    }

    #[test]
    fn a_row_is_rebuilt_field_by_field_and_the_sensitive_parts_never_reach_the_page() {
        let state = fold(json!([full("mk-correo", "Correo del lunes")]));
        let rows = items(&state);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0], json!({ "id": "mk-correo", "name": "Correo del lunes", "status": "active", "running": false, "lastRun": { "outcome": "done" } }));
        let all = serde_json::to_string(&state).unwrap();
        for secret in ["SECRET-PROMPT", "SECRET-SUMMARY", "SECRET-RULE", "SECRET-ACCOUNT", "SECRET-REASON", "secreto.txt", "cada lunes", "gmail"] {
            assert!(!all.contains(secret), "{secret:?} must never reach the page: {all}");
        }
    }

    #[test]
    fn a_draft_and_a_running_one_keep_their_closed_state() {
        let mut a = full("mk-a", "A"); a["status"] = json!("draft"); a["running"] = json!(true); a.as_object_mut().unwrap().remove("lastRun");
        let rows = items(&fold(json!([a])));
        assert_eq!(rows[0], json!({ "id": "mk-a", "name": "A", "status": "draft", "running": true }));
    }

    #[test]
    fn an_off_vocabulary_row_is_dropped_never_sanitised() {
        let mut bad_status = full("mk-b", "B"); bad_status["status"] = json!("hacked");
        let mut bad_id = full("../etc/passwd", "C");
        let mut no_name = full("mk-d", "D"); no_name.as_object_mut().unwrap().remove("name");
        let mut odd_outcome = full("mk-e", "E"); odd_outcome["lastRun"]["outcome"] = json!("exploded");
        bad_id["id"] = json!("../etc/passwd");
        let rows = items(&fold(json!([bad_status, bad_id, no_name, odd_outcome, full("mk-ok", "Bueno")])));
        let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["mk-e", "mk-ok"], "bad status, bad id and no name are dropped; a row with an unknown outcome stays WITHOUT lastRun");
        assert!(rows[0].get("lastRun").is_none(), "an outcome outside {{done, failed}} is not shown: {}", rows[0]);
    }

    #[test]
    fn the_name_loses_control_and_bidi_characters_and_is_capped() {
        let long = "x".repeat(200);
        let rows = items(&fold(json!([full("mk-1", "Hola\u{202E}\u{0007}\nmundo"), full("mk-2", &long)])));
        assert_eq!(rows[0]["name"], "Holamundo");
        assert_eq!(rows[1]["name"].as_str().unwrap().chars().count(), 80);
    }

    #[test]
    fn the_list_is_capped_at_32_and_says_so() {
        let many: Vec<Value> = (0..40).map(|i| full(&format!("mk-{i}"), &format!("M{i}"))).collect();
        let state = fold(json!(many));
        assert_eq!(items(&state).len(), 32);
        assert_eq!(view(&state)["truncated"], true);
        assert_eq!(view(&fold(json!([full("mk-1", "A")])))["truncated"], false);
    }

    #[test]
    fn a_frame_without_a_list_leaves_the_view_alone() {
        let mut state = fold(json!([full("mk-1", "A")]));
        state.apply(&json!({ "type": "minikodas" })).expect("a malformed frame is not an error");
        state.apply(&json!({ "type": "minikodas", "minikodas": "nope" })).expect("a non-list is not an error");
        assert_eq!(items(&state).len(), 1, "the last good view stays");
    }
}

/// Moved verbatim from `tests/telegram_frames.rs`.
mod telegram_frames {
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
}

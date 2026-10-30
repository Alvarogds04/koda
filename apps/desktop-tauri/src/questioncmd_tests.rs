use super::*;
use crate::protocol::Identity;
use crate::question::{self, HumanAnswer, Inbound};
use serde_json::json;

const ID: &str = "12345678-1234-4abc-8abc-123456789abc";
const NOW: u64 = 100_000;
fn slot(free: bool) -> QuestionSlot {
    let identity = Identity { project: "a".repeat(64), session_id: "session-1".into(), at: NOW as i64 };
    let body = json!({"v":1,"type":"question","questionVersion":1,"project":identity.project,
        "sessionId":"session-1","at":NOW,"id":ID,"kind":"question","text":"Pregunta",
        "options":[{"value":"private-a","label":"A","description":""},
                   {"value":"private-b","label":"B","description":""}],
        "allowFreeText":free,"expiresAt":NOW+30_000});
    let Inbound::Question(q) = question::decode(body.to_string().as_bytes(), &identity, NOW).unwrap() else { panic!() };
    let mut slot = QuestionSlot::new(); slot.admit(7, &identity, q, NOW).unwrap(); slot
}
#[test]
fn questioncmd_accepts_only_closed_shapes() {
    assert!(matches!(parse_command(&json!({"action":"view"})), Ok(Command::View)));
    assert!(matches!(parse_command(&json!({"action":"answer","id":ID,"index":3})),
        Ok(Command::Answer { index:3, .. })));
    assert!(matches!(parse_command(&json!({"action":"decline","id":ID})), Ok(Command::Decline { .. })));
    for action in ["text", "budget"] {
        assert!(parse_command(&json!({"action":action,"id":ID,"text":" literal\n🙂 "})).is_ok());
    }
}
#[test]
fn questioncmd_rejects_stowaways_and_automation() {
    for key in ["endpoint","scope","project","sessionId","token","value","source","human","isTrusted"] {
        let mut v = json!({"action":"answer","id":ID,"index":0}); v[key] = json!("opaque");
        assert!(parse_command(&v).is_err());
    }
    for v in [json!(null), json!([]), json!({"action":"auto_answer"}),
        json!({"action":"view","id":ID}), json!({"action":"answer","id":ID}),
        json!({"action":"decline","id":ID,"text":"x"}),
        json!({"action":"text","id":ID,"text":12})] { assert!(parse_command(&v).is_err()); }
}
#[test]
fn questioncmd_checks_indices_uuid_and_controls() {
    for index in [json!(-1), json!(4), json!(1.0), json!("1"), json!(true)] {
        assert!(parse_command(&json!({"action":"answer","id":ID,"index":index})).is_err());
    }
    for id in ["", "12345678-1234-3abc-8abc-123456789abc", "12345678-1234-4abc-7abc-123456789abc",
        "12345678-1234-4ABC-8abc-123456789abc", "not-a-uuid"] {
        assert!(parse_command(&json!({"action":"decline","id":id})).is_err());
    }
    for c in ['\0','\u{0008}','\u{000b}','\u{001f}','\u{007f}'] {
        for action in ["text","budget"] {
            assert!(parse_command(&json!({"action":action,"id":ID,"text":format!("x{c}")})).is_err());
        }
    }
}
#[test]
fn questioncmd_bounds_ipc_but_budget_accepts_invalid_drafts() {
    for text in ["".into(), " ".into(), "🙂".repeat(2001)] {
        assert!(parse_command(&json!({"action":"budget","id":ID,"text":text})).is_ok());
    }
    assert!(parse_command(&json!({"action":"budget","id":ID,"text":"x".repeat(MAX_REQUEST_BYTES)})).is_err());
}
#[test]
fn questioncmd_collapse_guard_matrix() {
    assert!(collapse_allowed(true, true));
    assert!(collapse_allowed(false, true));
    assert!(collapse_allowed(true, false));
    assert!(collapse_allowed(false, false));
}
#[test]
fn questioncmd_guarded_click_preserves_pending_chat_and_clears_press() {
    use crate::{core::{Core, WindowIo, ReleaseOutcome}, geometry::Rect};
    struct Io;
    impl WindowIo for Io {
        fn outer_position(&self) -> (i32, i32) { (0, 0) }
        fn size(&self) -> (i32, i32) { (672, 340) }
        fn scale(&self) -> f64 { 1.0 }
        fn set_outer_position(&self, _x: i32, _y: i32) { panic!("a click must not move the native window"); }
    }
    let area = Rect { x:0, y:0, w:1920, h:1080 };
    for (expanded, pending) in [(true,true), (true,false), (false,true), (false,false)] {
        for (cancelled, movement) in [(false, 0.0), (true, 0.0), (false, 200.0)] {
            let slot = slot(true);
            let before = (slot.active().unwrap().question().id().to_owned(), slot.active().unwrap().question().expires_at());
            let mut core = Core::new(); core.expanded = expanded; core.chat = expanded;
            core.press(&Io, (20.0, 20.0));
            let result = guarded_release(&mut core, &Io, area, (20.0 + movement, 20.0), cancelled, pending);
            assert!(!core.press_active());
            if cancelled || movement > 0.0 {
                assert!(matches!(result, ReleaseOutcome::Cancelled));
                assert_eq!((core.expanded, core.chat), (expanded, expanded));
            } else {
                assert!(matches!(result, ReleaseOutcome::Toggle(_)));
                assert_eq!(core.expanded, !expanded);
                assert!(!core.chat);
            }
            // Folding is presentation only: identity, deadline and pending view
            // stay intact, and a human can still answer before that deadline.
            assert_eq!((slot.active().unwrap().question().id().to_owned(), slot.active().unwrap().question().expires_at()), before);
            let active = slot.active().expect("folding must not consume the question");
            assert!(slot.prepare_answer(7, active.identity(), ID, HumanAnswer::Option { index: 0 }, NOW + 1).is_ok());
            assert!(matches!(slot.prepare_answer(7, active.identity(), ID, HumanAnswer::Option { index: 0 }, NOW + 30_000), Err(Error::Expired)));
        }
    }
}
#[test]
fn questioncmd_budget_exact_wire_boundary_without_mutation() {
    let slot = slot(true);
    let overhead = text_budget(&slot, ID, "", NOW).unwrap().bytes;
    // Multibyte text reaches the byte cap without exceeding 2000 codepoints.
    for target in [4096, 4097] {
        let room = target - overhead;
        let text = format!("{}{}", "🙂".repeat(room/4), "x".repeat(room%4));
        let budget = text_budget(&slot, ID, &text, NOW).unwrap();
        assert_eq!(budget.bytes, target);
        assert_eq!(budget.allowed, target == 4096);
        assert_eq!(budget.reason, if target == 4096 { None } else { Some("frame_too_large") });
        let active = slot.active().unwrap();
        let prepared = slot.prepare_answer(7, active.identity(), ID, HumanAnswer::Text { text }, NOW);
        if target == 4096 { assert_eq!(prepared.unwrap().line().len(), target+1); }
        else { assert!(matches!(prepared, Err(Error::FrameTooLarge))); }
        assert!(slot.active().is_some());
    }
}
#[test]
fn questioncmd_budget_literal_escaping_validation_and_privacy() {
    let slot = slot(true);
    for text in [" \"\\\n\t\r🙂 ", "\u{0085}", "\u{feff}x"] {
        let active = slot.active().unwrap();
        let prepared = slot.prepare_answer(7, active.identity(), ID, HumanAnswer::Text { text: text.into() }, NOW).unwrap();
        assert_eq!(text_budget(&slot, ID, text, NOW).unwrap().bytes, prepared.line().len()-1);
    }
    for text in ["", " \u{feff}", "x\0"] {
        let budget = text_budget(&slot, ID, text, NOW).unwrap();
        assert!(!budget.allowed); assert_eq!(budget.reason, Some("invalid_answer"));
    }
    assert!(!text_budget(&slot, ID, &"x".repeat(2001), NOW).unwrap().allowed);
    assert!(matches!(text_budget(&slot, "wrong-id", "secret", NOW), Err(Error::NotLive)));
    assert!(matches!(text_budget(&slot, ID, "secret", NOW+30_000), Err(Error::Expired)));
    assert!(!text_budget(&self::slot(false), ID, "x", NOW).unwrap().allowed);
    let v = serde_json::to_string(&text_budget(&slot, ID, "secret", NOW).unwrap()).unwrap();
    for secret in ["secret","session-1","private-a","project","source"] { assert!(!v.contains(secret)); }
    assert!(slot.active().is_some());
}

// ---- structured IPC: `answer_many` (multiSelect) and `answer_form` (questionnaire) -------------------

#[test]
fn answer_many_and_answer_form_accept_only_closed_bounded_shapes() {
    match parse_command(&json!({"action":"answer_many","id":ID,"indexes":[2,0]})).unwrap() {
        Command::AnswerMany { indexes, text, .. } => { assert_eq!(indexes, vec![2, 0]); assert!(text.is_none()); }
        _ => panic!(),
    }
    assert!(matches!(parse_command(&json!({"action":"answer_many","id":ID,"indexes":[],"text":"otra"})), Ok(Command::AnswerMany { .. })));
    let form = json!({"action":"answer_form","id":ID,"answers":[
        {"index":1}, {"indexes":[0,2]}, {"indexes":[1],"text":"x"}, {"text":"libre"}]});
    match parse_command(&form).unwrap() {
        Command::AnswerForm { answers, .. } => assert_eq!(answers.len(), 4),
        _ => panic!(),
    }
    for bad in [
        json!({"action":"answer_many","id":ID,"indexes":[0,1,2,3,0]}),          // more than 4 entries
        json!({"action":"answer_many","id":ID,"indexes":[-1]}), json!({"action":"answer_many","id":ID,"indexes":[4]}),
        json!({"action":"answer_many","id":ID,"indexes":["0"]}), json!({"action":"answer_many","id":ID,"indexes":0}),
        json!({"action":"answer_many","id":ID,"indexes":[0],"text":"bad\u{0000}"}),
        json!({"action":"answer_many","id":ID,"indexes":[0],"value":"v1"}),     // stowaway
        json!({"action":"answer_many","id":ID}),
        json!({"action":"answer_form","id":ID,"answers":[]}),
        json!({"action":"answer_form","id":ID,"answers":[{"index":0},{"index":0},{"index":0},{"index":0},{"index":0}]}),
        json!({"action":"answer_form","id":ID,"answers":[{"index":0,"indexes":[0]}]}),   // ambiguous entry
        json!({"action":"answer_form","id":ID,"answers":[{}]}),
        json!({"action":"answer_form","id":ID,"answers":[{"index":9}]}),
        json!({"action":"answer_form","id":ID,"answers":[{"value":"v1"}]}),
        json!({"action":"answer_form","id":ID,"answers":[{"text":"bad\u{007f}"}]}),
        json!({"action":"answer_form","id":ID,"answers":"x"}),
        json!({"action":"answer_form","id":ID,"answers":[{"index":0}],"source":"human"}),
    ] { assert!(parse_command(&bad).is_err(), "{bad}"); }
    // the old verbs are untouched
    assert!(matches!(parse_command(&json!({"action":"answer","id":ID,"index":3})), Ok(Command::Answer { index: 3, .. })));
}

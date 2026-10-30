//! Click is display-only: exact identity/kind, no answer or approval authority.
use abito_island::bridge::{parse_click, route_click, ClickKind};
use serde_json::json;

const ID: &str = "3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b";
const OTHER: &str = "7a1d2c3b-4e5f-4a6b-9c8d-1e2f3a4b5c6d";
const NOW: u64 = 2_000_000_000_000;

struct Measured;
impl abito_island::core::WindowIo for Measured {
    fn outer_position(&self) -> (i32,i32) { (100,0) }
    fn size(&self) -> (i32,i32) { (672,176) }
    fn scale(&self) -> f64 { 1.0 }
    fn set_outer_position(&self, _:i32, _:i32) { panic!("planning must not write native state") }
}
#[test]
fn click_open_never_collapses_hidden_stale_expanded_or_expanded_chat() {
    use abito_island::{core::Core, desktop::{plan_click_open, ClickPlan, IslandState}, geometry::Rect};
    let area = Rect { x:0,y:0,w:1920,h:1080 };
    for phase in [IslandState::Hidden,IslandState::Compact,IslandState::Expanded] {
        for expanded in [false,true] {
            let mut core = Core::new(); core.expanded = expanded; core.chat = expanded;
            let mut state = phase;
            let plan = plan_click_open(&mut core,&mut state,&Measured,area);
            if let ClickPlan::Expand(p) = plan { assert!(p.is_expand()); }
            assert!(core.expanded); assert!(!core.chat); assert_eq!(state,IslandState::Expanded);
        }
    }
    assert!(abito_island::desktop::click_plan_is_current(2,2,IslandState::Expanded));
    assert!(!abito_island::desktop::click_plan_is_current(2,3,IslandState::Expanded));
    assert!(!abito_island::desktop::click_plan_is_current(2,2,IslandState::Hidden));
}

#[test]
fn valid_click_routes_only_the_matching_live_host_view() {
    let question = json!({"pending":{"id":ID,"kind":"question","expires_at":NOW+1}});
    let notices = json!([{"id":OTHER,"expiresAt":NOW+1}]);
    let q = parse_click(&json!({"action":"click","id":ID,"kind":"question"})).unwrap();
    assert_eq!(route_click(&q, &question, &notices, NOW).unwrap(), ClickKind::Question);
    let n = parse_click(&json!({"action":"click","id":OTHER,"kind":"finished"})).unwrap();
    assert_eq!(route_click(&n, &question, &notices, NOW).unwrap(), ClickKind::Finished);
    // A Pi approval-kind question is still a QUESTION VIEW, never backend authority.
    let approval = json!({"pending":{"id":ID,"kind":"approval","expires_at":NOW+1}});
    assert_eq!(route_click(&q, &approval, &notices, NOW).unwrap(), ClickKind::Question);
}

#[test]
fn invalid_shapes_fail_closed_without_legacy_argument_smuggling() {
    for payload in [
        json!({"action":"click","id":ID}),
        json!({"action":"click","id":ID,"kind":"approval"}),
        json!({"action":"click","id":ID,"kind":"unknown"}),
        json!({"action":"click","id":"not-a-uuid","kind":"question"}),
        json!({"action":"click","id":ID.to_uppercase(),"kind":"question"}),
        json!({"action":"click","id":ID,"kind":"question","index":0}),
        json!({"action":"expand","id":ID,"kind":"question"}),
    ] {
        assert_eq!(parse_click(&payload).unwrap_err().code, "denied");
        assert!(abito_island::bridge::validate_payload(&payload).is_err());
    }
    assert!(parse_click(&json!({"action":"click","id":"a".repeat(513),"kind":"question"})).is_err());
    assert!(abito_island::bridge::validate_payload(&json!({"action":"expand"})).is_ok());
    assert!(abito_island::bridge::validate_payload(&json!({"action":"dismiss"})).is_ok());
}

#[test]
fn stale_expired_and_wrong_kind_ids_leave_host_snapshots_unchanged() {
    let question = json!({"pending":{"id":ID,"kind":"question","expires_at":NOW}});
    let notices = json!([{"id":OTHER,"expiresAt":NOW}]);
    let before = (question.clone(), notices.clone());
    for (id,kind) in [(ID,"question"),(OTHER,"finished"),(OTHER,"question"),(ID,"finished")] {
        let click = parse_click(&json!({"action":"click","id":id,"kind":kind})).unwrap();
        let error = route_click(&click, &question, &notices, NOW).unwrap_err();
        assert_eq!(error.code, "denied");
        assert_eq!(error.message, "Denied: notice is not current");
        assert_eq!((&question, &notices), (&before.0, &before.1));
    }
    let q = parse_click(&json!({"action":"click","id":ID,"kind":"question"})).unwrap();
    assert!(route_click(&q, &json!({"pending":null}), &json!([]), NOW).is_err());
    let n = parse_click(&json!({"action":"click","id":OTHER,"kind":"finished"})).unwrap();
    let queued = json!([{"id":ID,"expiresAt":NOW+1},{"id":OTHER,"expiresAt":NOW+1}]);
    assert!(route_click(&n, &json!({}), &queued, NOW).is_err());
    let duplicates = json!([{"id":OTHER,"sessionId":"one","expiresAt":NOW+1},{"id":OTHER,"sessionId":"two","expiresAt":NOW+1}]);
    assert!(route_click(&n, &json!({}), &duplicates, NOW).is_err());
    // An expired newly-arriving completion is not an opener either.
    let n = parse_click(&json!({"action":"click","id":OTHER,"kind":"finished"})).unwrap();
    assert!(route_click(&n, &json!({}), &notices, NOW).is_err());
}

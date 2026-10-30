use super::*;
use serde_json::json;

#[test]
fn the_closed_schema_accepts_exactly_the_recap_shapes() {
    assert_eq!(parse_command(&json!({"action":"view","since":0})), Some(Command::View(0)));
    assert_eq!(parse_command(&json!({"action":"prefs"})), Some(Command::Prefs));
    assert_eq!(parse_command(&json!({"action":"clear"})), Some(Command::Clear));
    assert_eq!(parse_command(&json!({"action":"reveal_saved"})), Some(Command::RevealSaved));
    assert_eq!(parse_command(&json!({"action":"set_enabled","enabled":false})), Some(Command::SetEnabled(false)));
    assert_eq!(parse_command(&json!({"action":"set_hide_projects","hide":true})), Some(Command::SetHideProjects(true)));
    assert_eq!(
        parse_command(&json!({"action":"mark_shown","week":"2026-10-05"})),
        Some(Command::MarkShown("2026-10-05".into()))
    );
    assert!(matches!(
        parse_command(&json!({"action":"save_png","data":"AAAA","week":"2026-10-05"})),
        Some(Command::SavePng { .. })
    ));
    for bad in [
        json!({"action":"view"}),
        json!({"action":"view","since":"0"}),
        json!({"action":"view","since":-1}),
        json!({"action":"prefs","x":1}),
        json!({"action":"mark_shown","week":"../../x"}),
        json!({"action":"set_enabled","enabled":"yes"}),
        json!({"action":"save_png","data":"AAAA","week":"bad"}),
        json!({"action":"save_png","data":"AAAA"}),
        json!({"action":"reveal_saved","path":"/"}),
        json!({"action":"nope"}),
        json!(1),
    ] {
        assert_eq!(parse_command(&bad), None, "{bad}");
    }
}

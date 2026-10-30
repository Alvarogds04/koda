use super::*;
use serde_json::json;

#[test]
fn the_closed_schema_accepts_only_known_plan_shapes() {
    assert_eq!(parse_command(&json!({"action":"codex"})), Some(Command::Codex));
    assert_eq!(parse_command(&json!({"action":"claude"})), Some(Command::Claude));
    for bad in [
        json!({"action":"codex","x":1}),
        json!({"action":"claude","path":"/tmp/x"}),
        json!({"action":"codex","path":"/bin/sh"}),
        json!({"action":"run"}),
        json!({}),
        json!("codex"),
        json!(null),
    ] {
        assert_eq!(parse_command(&bad), None, "{bad}");
    }
}

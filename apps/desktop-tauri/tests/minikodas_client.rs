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

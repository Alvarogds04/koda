use super::*;
use crate::geometry::Rect;
use crate::workarea::MonitorChoice;
use serde_json::json;

fn mon(key: &str, x: i32, y: i32, w: i32, h: i32) -> MonitorChoice {
    MonitorChoice { key: key.to_string(), rect: Rect { x, y, w, h } }
}

#[test]
fn the_payload_is_exactly_list() {
    assert!(parse_monitor(&json!({"action":"list"})).is_ok());
    for bad in [json!(null), json!("list"), json!({}), json!({"action":"set"}), json!({"action":1}),
        json!({"action":"list","monitor":"eDP-1"}), json!({"Action":"list"})] {
        let e = parse_monitor(&bad).expect_err(&bad.to_string());
        assert_eq!(e.code, "denied");
    }
}

#[test]
fn choices_carry_only_a_key_and_geometry_and_keep_the_first_of_a_duplicate_name() {
    let list = choices(&[
        mon("eDP-1", 0, 0, 1920, 1080),
        mon("HDMI-A-1", 1920, 0, 2560, 1440),
        mon("eDP-1", 5000, 0, 800, 600),   // same name: placement resolves to the first, so only that is offered
        mon("broken", 0, 0, 0, 1080),       // degenerate geometry can never be placed on
    ]);
    assert_eq!(list, json!([
        {"key":"eDP-1","x":0,"y":0,"width":1920,"height":1080},
        {"key":"HDMI-A-1","x":1920,"y":0,"width":2560,"height":1440},
    ]));
    assert_eq!(choices(&[]), json!([]));
}

#[test]
fn every_offered_key_is_one_prefs_would_accept() {
    // set_monitor validates the key; a key the picker offers must never be refused there.
    let long = "x".repeat(500);
    let list = choices(&[mon(&long, 0, 0, 10, 10), mon("DP-1", 0, 0, 10, 10)]);
    let keys: Vec<_> = list.as_array().unwrap().iter().map(|m| m["key"].as_str().unwrap().to_owned()).collect();
    assert_eq!(keys, vec!["DP-1".to_string()]);
}

#[test]
fn the_list_is_bounded() {
    let many: Vec<_> = (0..100).map(|i| mon(&format!("M-{i}"), i, 0, 10, 10)).collect();
    assert_eq!(choices(&many).as_array().unwrap().len(), MAX_MONITORS);
}

#[test]
fn gate_order_is_sender_then_payload_then_rate() {
    let mut rate = RateLimiter::new();
    let mut hits = 0;
    for (l, o, p) in [("other", "tauri://localhost/", json!({"action":"list"})),
        ("main", "https://example.test/", json!({"action":"list"})),
        ("settings", "tauri://localhost/", json!({"action":"nope"}))] {
        assert!(monitor_command(l, o, &p, &mut rate, 0, || { hits += 1; json!([]) }).is_err());
    }
    assert_eq!(hits, 0);
    for _ in 0..30 { rate.check(0).expect("rejects spend nothing"); }
    let mut rate = RateLimiter::new();
    for label in ["main", "settings"] {
        let out = monitor_command(label, "tauri://localhost/", &json!({"action":"list"}), &mut rate, 0, || json!([1])).unwrap();
        assert_eq!(out, json!({"monitors":[1]}));
    }
}

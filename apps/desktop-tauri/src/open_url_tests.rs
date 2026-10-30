use super::*;
use crate::bridge::{BridgeError, RateLimiter};
use serde_json::json;

#[test]
fn unsafe_urls_and_shapes_are_public_errors_without_opening_or_spending_budget() {
    let mut rate = RateLimiter::new();
    let mut opened = Vec::new();
    for payload in [json!({"url":"javascript:alert(1)"}), json!({"url":"data:text/html,x"}),
        json!({"url":"file:///tmp/x"}), json!({"url":"not-url"}), json!({"url":"https://"}),
        json!({"url":"https://example.test\n/x"}), json!({"url":"https://user:pw@example.test"}),
        json!({"url":"https://example.test", "extra":true}), json!({"url":1}), json!(null)] {
        let e = open_web_url("main", "tauri://localhost/", &payload, &mut rate, 0,
            |u| { opened.push(u.to_owned()); Ok(()) }).unwrap_err();
        assert_eq!(e.code, "denied");
        assert!(e.message.starts_with("Denied: "));
        assert!(opened.is_empty());
    }
    for _ in 0..30 { rate.check(0).expect("rejected input consumes no rate budget"); }
}

#[test]
fn sender_gate_and_existing_rate_gate_precede_mock_opener() {
    let mut rate = RateLimiter::new(); let mut opened = Vec::new();
    for (label, origin) in [("other", "tauri://localhost/"), ("main", "https://example.test/")] {
        let e = open_web_url(label, origin, &json!({"url":"https://example.test"}), &mut rate, 0,
            |u| { opened.push(u.to_owned()); Ok(()) }).unwrap_err();
        assert_eq!(e.code,"denied"); assert!(opened.is_empty());
    }
    for _ in 0..30 {
        open_web_url("main", "tauri://localhost/", &json!({"url":"https://example.test"}), &mut rate, 0,
            |u| { opened.push(u.to_owned()); Ok(()) }).unwrap();
    }
    assert_eq!(opened, vec!["https://example.test/";30]);
    let e = open_web_url("main", "tauri://localhost/", &json!({"url":"http://example.test/a?q=1"}), &mut rate, 0,
        |_| panic!("rate rejection must not open")).unwrap_err();
    assert_eq!(e, BridgeError::rate_exceeded()); assert_eq!(opened.len(),30);
    open_web_url("main", "tauri://localhost/", &json!({"url":"http://example.test/a?q=1"}), &mut rate, 1000,
        |u| { opened.push(u.to_owned()); Ok(()) }).unwrap();
    assert_eq!(opened.last().unwrap(), "http://example.test/a?q=1");
}

#[test]
fn opener_failure_is_a_public_error_not_false_success() {
    let e = open_web_url("main", "tauri://localhost/", &json!({"url":"https://example.test"}),
        &mut RateLimiter::new(), 0, |_| Err(BridgeError::denied("external opener unavailable"))).unwrap_err();
    assert_eq!(e.message, "Denied: external opener unavailable");
}

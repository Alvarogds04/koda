use super::*;
use crate::bridge::RateLimiter;
use serde_json::json;

const ORIGIN: &str = "tauri://localhost/";

#[test]
fn payload_is_closed_to_refresh_of_pulse_or_activity() {
    assert_eq!(parse_github(&json!({"action":"refresh","section":"pulse"})).unwrap(), Section::Pulse);
    assert_eq!(parse_github(&json!({"action":"refresh","section":"activity"})).unwrap(), Section::Activity);
    for bad in [json!(null), json!("refresh"), json!({}), json!({"action":"refresh"}),
        json!({"action":"refresh","section":"repos"}), json!({"action":"refresh","section":"pulse","query":"{x}"}),
        json!({"action":"graphql","section":"pulse"}), json!({"action":"refresh","section":1})] {
        assert_eq!(parse_github(&bad).expect_err(&bad.to_string()).code, "denied", "{bad}");
    }
}

#[test]
fn gh_argv_is_fixed_read_only_graphql_with_a_constant_query() {
    for (s, q) in [(Section::Pulse, crate::github::PULSE_QUERY), (Section::Activity, crate::github::ACTIVITY_QUERY)] {
        let argv = gh_args(s);
        assert_eq!(argv[0], "api");
        assert_eq!(argv[1], "graphql");
        assert!(argv.iter().any(|a| *a == format!("query={q}")));
        assert!(!argv.iter().any(|a| a.starts_with("--method") || a == "-X" || a.contains("mutation")));
        assert!(!q.contains("mutation"));
    }
}

#[test]
fn stale_sections_fetch_fresh_ones_serve_the_cache_and_failures_cache_nothing() {
    let mut cache = Cache::default();
    let mut calls = 0;
    let ok = |calls: &mut i32| { *calls += 1; Ok(json!({"data":{"viewer":{"login":"u","contributionsCollection":{"contributionCalendar":{"totalContributions":3,"weeks":[]}}}}})) };
    let a = cache.refresh(Section::Activity, 1_000, |_| ok(&mut calls)).unwrap();
    assert_eq!(a["fetched"], json!(true));
    assert_eq!(a["activity"]["total"], json!(3));
    let b = cache.refresh(Section::Activity, 1_000 + 299_000, |_| ok(&mut calls)).unwrap();
    assert_eq!(b["fetched"], json!(false), "fresh within 300 s");
    assert_eq!(calls, 1);
    let c = cache.refresh(Section::Activity, 1_000 + 301_000, |_| ok(&mut calls)).unwrap();
    assert_eq!(c["fetched"], json!(true));
    assert_eq!(calls, 2);

    let mut empty = Cache::default();
    let e = empty.refresh(Section::Pulse, 5, |_| Err(Unavailable::NotInstalled)).unwrap_err();
    assert_eq!(e, Unavailable::NotInstalled);
    let again = empty.refresh(Section::Pulse, 6, |_| Err(Unavailable::NotSignedIn));
    assert_eq!(again.unwrap_err(), Unavailable::NotSignedIn, "a failure is never cached");
    // an unparsable answer is an honest failure, not an empty success
    let bad = empty.refresh(Section::Pulse, 7, |_| Ok(json!({"data":null})));
    assert_eq!(bad.unwrap_err(), Unavailable::BadAnswer);
}

#[test]
fn gate_order_and_honest_unavailable_answer() {
    let mut rate = RateLimiter::new();
    let mut hits = 0;
    let mut cache = Cache::default();
    for (l, o, p) in [("other", ORIGIN, json!({"action":"refresh","section":"pulse"})),
        ("main", "https://x.test/", json!({"action":"refresh","section":"pulse"})),
        ("main", ORIGIN, json!({"action":"refresh","section":"zzz"}))] {
        assert!(github_command(l, o, &p, &mut rate, 0, &mut cache, |_| { hits += 1; Err(Unavailable::NotInstalled) }).is_err());
    }
    assert_eq!(hits, 0);
    for _ in 0..30 { rate.check(0).expect("rejects spend nothing"); }
    let mut rate = RateLimiter::new();
    let out = github_command("main", ORIGIN, &json!({"action":"refresh","section":"pulse"}), &mut rate, 0, &mut cache,
        |_| Err(Unavailable::NotInstalled)).unwrap();
    assert_eq!(out["available"], json!(false));
    assert_eq!(out["reason"], json!("gh_not_installed"));
}

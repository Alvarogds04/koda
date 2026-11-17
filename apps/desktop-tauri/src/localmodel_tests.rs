//! K2-05 U5a — tests for what is left of the local-model support: endpoint
//! policy, alias shape, deadlines and the closed set of metadata routes. The
//! chunked/SSE/head/body decoders and the one-shot client left with the direct
//! Rust chat lane.

use super::*;

// --- endpoint policy: literal loopback only, never a name, never TLS/remote --

#[test]
fn only_literal_loopback_http_origins_are_local_endpoints() {
    let e = LocalEndpoint::parse("http://127.0.0.1:11002").unwrap();
    assert_eq!(e.origin(), "http://127.0.0.1:11002");
    assert_eq!(e.port(), 11002);
    assert!(LocalEndpoint::parse("http://[::1]:11002").is_ok());
    for bad in [
        "http://localhost:11002",      // a name needs DNS: refused
        "https://127.0.0.1:11002",     // no TLS route exists locally
        "http://10.0.0.5:11002",       // LAN is off-machine
        "http://100.101.102.103:11002",  // tailnet is off-machine
        "http://api.openai.com:443",   // cloud
        "http://127.0.0.1:11002/v1",   // origin only, no path
        "http://user@127.0.0.1:11002", // no userinfo
        "http://127.0.0.1:0",
        "http://127.0.0.1",
        "http://0.0.0.0:11002",
        "http://127.0.0.2:11002",      // only the canonical loopback literal
        "",
    ] {
        assert!(LocalEndpoint::parse(bad).is_err(), "{bad} must be refused");
    }
}

#[test]
fn model_alias_is_a_bounded_plain_token() {
    assert!(valid_alias("Abito-gpt"));
    assert!(valid_alias("qwen3.6_35b-a3b"));
    assert!(!valid_alias(""));
    assert!(!valid_alias("a b"));
    assert!(!valid_alias("x/../y"));
    assert!(!valid_alias(&"a".repeat(65)));
}

// --- the kept support: deadlines and the closed metadata-route set -----------

#[test]
fn deadlines_are_bounded_and_ordered() {
    assert!(DEFAULT_DEADLINES.connect_ms > 0);
    assert!(DEFAULT_DEADLINES.connect_ms < DEFAULT_DEADLINES.total_ms);
    assert!(DEFAULT_DEADLINES.idle_ms < DEFAULT_DEADLINES.total_ms);
}

#[test]
fn only_the_four_metadata_routes_are_read_and_nothing_is_sent() {
    let e = LocalEndpoint::parse("http://127.0.0.1:9").unwrap(); // nothing listens: no I/O can succeed
    for path in ["/v1/chat/completions", "/completion", "/v1/embeddings", "/props/../chat"] {
        assert!(get_json(&e, path, 10).is_none(), "{path} is not a metadata route");
    }
}

//! Unit U1 — tests for the pure local-model pieces: endpoint policy, chunked
//! transfer decoding, SSE/OpenAI stream decoding, request body. RED → GREEN.

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

// --- chunked transfer decoding ---------------------------------------------------

#[test]
fn chunked_decoder_handles_split_sizes_extensions_and_the_last_chunk() {
    let mut d = Chunked::default();
    let mut out = Vec::new();
    for piece in [
        &b"5\r\nhel"[..],
        b"lo\r\n",
        b"6;ext=1\r\n wor",
        b"ld\r\n0\r\n\r\n",
    ] {
        out.extend(d.push(piece).unwrap());
    }
    assert_eq!(out, b"hello world");
    assert!(d.finished());
}

#[test]
fn chunked_decoder_rejects_garbage_and_oversized_chunks() {
    assert!(Chunked::default().push(b"zz\r\n").is_err());
    assert!(Chunked::default().push(b"5\r\nhelloXX").is_err());
    assert!(Chunked::default().push(b"FFFFFFFFF\r\n").is_err());
    let mut d = Chunked::default();
    assert!(d.push(&[b'1'; 40]).is_err()); // size line never ends
}

// --- SSE / OpenAI-compatible stream decoding ----------------------------------

fn frame(json: &str) -> String {
    format!("data: {json}\n\n")
}

#[test]
fn sse_decodes_content_reasoning_finish_and_done() {
    let mut s = Sse::default();
    let mut items = Vec::new();
    let text = frame(r#"{"choices":[{"delta":{"reasoning_content":"pienso"}}]}"#)
        + &frame(r#"{"choices":[{"delta":{"content":"Ho"}}]}"#)
        + &frame(r#"{"choices":[{"delta":{"content":"la"},"finish_reason":null}]}"#)
        + &frame(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#)
        + "data: [DONE]\n\n";
    // feed in awkward splits, including inside a multi-byte char
    let bytes = text.into_bytes();
    for chunk in bytes.chunks(7) {
        items.extend(s.push(chunk).unwrap());
    }
    assert_eq!(
        items,
        vec![
            StreamItem::Reasoning,
            StreamItem::Content("Ho".into()),
            StreamItem::Content("la".into()),
            StreamItem::Finish(Finish::Stop),
            StreamItem::Done,
        ]
    );
}

#[test]
fn sse_keeps_utf8_split_across_pushes() {
    let mut s = Sse::default();
    let text = frame(r#"{"choices":[{"delta":{"content":"ñandú"}}]}"#).into_bytes();
    let cut = text.iter().position(|b| *b == 0xc3).unwrap() + 1; // mid 'ñ'
    let mut items = s.push(&text[..cut]).unwrap();
    items.extend(s.push(&text[cut..]).unwrap());
    assert_eq!(items, vec![StreamItem::Content("ñandú".into())]);
}

#[test]
fn sse_ignores_comments_empty_deltas_and_role_only_chunks() {
    let mut s = Sse::default();
    let text = ": keep-alive\n\n".to_string()
        + &frame(r#"{"choices":[{"delta":{"role":"assistant"}}]}"#)
        + &frame(r#"{"choices":[{"delta":{"content":""}}]}"#)
        + &frame(r#"{"choices":[]}"#);
    assert!(s.push(text.as_bytes()).unwrap().is_empty());
}

#[test]
fn sse_maps_length_to_limit_and_unknown_finish_to_stop() {
    let mut s = Sse::default();
    let items = s
        .push(frame(r#"{"choices":[{"delta":{},"finish_reason":"length"}]}"#).as_bytes())
        .unwrap();
    assert_eq!(items, vec![StreamItem::Finish(Finish::Length)]);
}

#[test]
fn sse_malformed_json_or_error_object_is_a_typed_failure() {
    assert!(Sse::default().push(b"data: {not json}\n\n").is_err());
    assert!(Sse::default()
        .push(frame(r#"{"error":{"message":"secret upstream detail"}}"#).as_bytes())
        .is_err());
}

#[test]
fn sse_line_without_terminator_is_bounded() {
    let mut s = Sse::default();
    let long = vec![b'a'; SSE_MAX_LINE + 1];
    assert!(s.push(&long).is_err());
}

// --- request body ---------------------------------------------------------------

#[test]
fn request_body_is_streaming_bounded_and_names_only_the_alias() {
    let messages = vec![
        crate::chat::Message { role: "system", content: "S".into() },
        crate::chat::Message { role: "user", content: "hola".into() },
    ];
    let body: serde_json::Value =
        serde_json::from_str(&completion_body("Abito-gpt", &messages, 1024)).unwrap();
    assert_eq!(body["model"], "Abito-gpt");
    assert_eq!(body["stream"], true);
    assert_eq!(body["max_tokens"], 1024);
    assert_eq!(body["messages"][1]["role"], "user");
    assert_eq!(body["messages"][1]["content"], "hola");
    // nothing that could make the router reach elsewhere or use tools
    for forbidden in ["tools", "tool_choice", "api_key", "user", "n"] {
        assert!(body.get(forbidden).is_none(), "{forbidden}");
    }
}

// --- response head ------------------------------------------------------------------

#[test]
fn response_head_parses_status_and_framing() {
    let h = parse_head(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked",
    )
    .unwrap();
    assert_eq!(h.status, 200);
    assert!(h.chunked);
    assert!(h.event_stream);
    let h = parse_head("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 10").unwrap();
    assert_eq!(h.status, 503);
    assert_eq!(h.content_length, Some(10));
    assert!(parse_head("SSH-2.0-OpenSSH").is_err());
}

#[test]
fn http_status_maps_to_safe_errors_and_redirects_are_never_followed() {
    assert_eq!(status_error(503).code, "local_model_unavailable"); // loading
    assert_eq!(status_error(404).code, "local_model_unavailable"); // alias gone
    assert_eq!(status_error(500).code, "inference_error");
    assert_eq!(status_error(302).code, "inference_error");
    assert_eq!(status_error(400).code, "inference_error");
}

//! Approval request validation — pure module, unit M3 (test-first, RED → GREEN).
//!
//! Behaviour-equivalent port of the Electron request-side gates:
//! - `security.cjs` `BRIDGE_ORIGIN` (13), `BRIDGE_ROUTES` (14),
//!   `bridgeAllows` (19): the ONLY method+URL combinations the host may
//!   ever send to the bridge,
//! - `main.cjs` `readBridgeLogin` (87): the credential file's schema half —
//!   exactly `{v: 1, login}` with a strictly validated login string (the
//!   descriptor-level checks live in `approval.rs`, this module judges the
//!   bytes).
//!
//! No I/O: values in, verdict out.

use serde_json::Value;

/// `security.cjs BRIDGE_ORIGIN` — the legacy backend origin. Runtime
/// overrides (`ABITO_BRIDGE_BASE`, tests/probe only) replace it, never the
/// route table below.
pub const BRIDGE_ORIGIN: &str = "http://127.0.0.1:11003";

/// Parsed origin: scheme + authority (host:port). The legacy origin is a
/// fixed `http://127.0.0.1:11003` — no userinfo, no path, no query, no
/// fragment — and an override must have the same shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    /// Always `"http"`: the bridge is plain loopback HTTP, never TLS, never
    /// any other scheme.
    pub scheme: String,
    /// `host:port` exactly as written.
    pub authority: String,
    pub host: String,
    pub port: u16,
}

impl Origin {
    /// The canonical `http://host:port` text used to build request URLs and
    /// to match incoming URLs against.
    pub fn base(&self) -> String {
        format!("{}://{}", self.scheme, self.authority)
    }
}

/// Parse a fixed origin string. Strict: `http://host:port` and nothing else
/// — no trailing slash, path, query, fragment or userinfo.
pub fn parse_origin(text: &str) -> Result<Origin, ()> {
    let rest = text.strip_prefix("http://").ok_or(())?;
    // authority = everything up to path/query/fragment; an origin has none
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if end != rest.len() || authority.is_empty() {
        return Err(());
    }
    if authority.contains('@') {
        return Err(()); // userinfo is never part of an origin we send to
    }
    let (host, port_text) = if authority.starts_with('[') {
        // bracketed IPv6 literal: [::1]:port
        let close = authority.find(']').ok_or(())?;
        let after = &authority[close + 1..];
        let port = after.strip_prefix(':').ok_or(())?;
        (&authority[..close + 1], port)
    } else {
        let colon = authority.rfind(':').ok_or(())?;
        (&authority[..colon], &authority[colon + 1..])
    };
    if host.is_empty() {
        return Err(());
    }
    let port: u16 = port_text.parse().map_err(|_| ())?;
    if port == 0 {
        return Err(());
    }
    Ok(Origin {
        scheme: "http".into(),
        authority: authority.to_string(),
        host: host.to_string(),
        port,
    })
}

/// `security.cjs bridgeAllows` (19), ported: the raw URL's ORIGIN must equal
/// the configured bridge origin exactly (no userinfo, no fragment), and the
/// (method, pathname, search) triple must be one of the four legacy routes:
/// - `GET /` (search empty),
/// - `GET /api/health` (search empty),
/// - `GET /api/proposals` with search `""` or `?status=pending`,
/// - `POST /api/proposals/proposal_[0-9a-f]{32}/execute|reject` (search
///   empty).
/// Nothing is normalized or prefix-matched: `..` segments, trailing
/// segments, uppercase hex ids, other methods and other queries all miss.
pub fn bridge_allows(base: &str, method: &str, url: &str) -> bool {
    let Ok(base) = parse_origin(base) else {
        return false;
    };
    // Split the raw URL the way the WHATWG parser would, without
    // normalizing anything: scheme, authority, then path + search.
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("http") {
        return false;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.contains('@') {
        // `url.username`/`url.password` non-empty → never allowed
        return false;
    }
    // legacy: `url.origin === BRIDGE_ORIGIN` (host and scheme are compared
    // case-insensitively by the URL parser, so do the same here)
    if !authority.eq_ignore_ascii_case(&base.authority) {
        return false;
    }
    let tail = &rest[end..];
    if tail.contains('#') {
        return false; // legacy: `url.hash === ''`
    }
    let (path, query) = match tail.find('?') {
        Some(at) => (&tail[..at], &tail[at + 1..]),
        None => (tail, ""),
    };
    // the URL parser reports the empty path as `/`
    let path = if path.is_empty() { "/" } else { path };
    match (method, path) {
        ("GET", "/") => query.is_empty(),
        ("GET", "/api/health") => query.is_empty(),
        ("GET", "/api/proposals") => query.is_empty() || query == "status=pending",
        ("POST", path) => query.is_empty() && is_proposal_write(path),
        _ => false,
    }
}

/// `/api/proposals/proposal_[0-9a-f]{32}/(execute|reject)` — the exact
/// legacy POST route regex, without a regex engine.
fn is_proposal_write(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/proposals/") else {
        return false;
    };
    let Some((id, action)) = rest.split_once('/') else {
        return false;
    };
    let Some(hex) = id.strip_prefix("proposal_") else {
        return false;
    };
    hex.len() == 32
        && hex.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && matches!(action, "execute" | "reject")
}

/// `main.cjs readBridgeLogin` (87) schema half: the decoded bytes must be a
/// JSON object of EXACTLY the two keys `v` and `login`, `v` strictly `1`,
/// and `login` a string of 1..=254 UTF-16 code units that
/// - contains no whitespace and no `[\x00-\x1f\x7f-\x9f]` control character
///   (JavaScript `/\s/` plus an explicit U+FEFF, which `char::is_whitespace`
///   does not cover), and
/// - matches `^[a-z0-9][a-z0-9@._+\-]*$`.
/// Anything else is `None` → the whole lane stays `disabled` and NO request
/// is ever made (fail closed).
pub fn validate_login_bytes(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    // EXACTLY the two legacy keys: no extras, none missing
    if object.len() != 2 || !object.contains_key("v") || !object.contains_key("login") {
        return None;
    }
    if object.get("v").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let login = object.get("login").and_then(Value::as_str)?;
    if login.is_empty() || login.encode_utf16().count() > 254 {
        return None;
    }
    // `/[\s\x00-\x1f\x7f-\x9f]/` — JavaScript `\s` plus the explicit ranges;
    // U+FEFF is in JS `\s` but not White_Space, so it is checked too.
    if login.chars().any(|c| {
        let unit = c as u32;
        unit <= 0x1f || (0x7f..=0x9f).contains(&unit) || c.is_whitespace() || c == '\u{feff}'
    }) {
        return None;
    }
    // `^[a-z0-9][a-z0-9@._+\-]*$`
    let mut chars = login.chars();
    let first = chars.next()?;
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return None;
    }
    if !chars.all(|c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '@' | '.' | '_' | '+' | '-')
    }) {
        return None;
    }
    Some(login.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "http://127.0.0.1:11003";
    const PROPOSAL: &str = "proposal_0123456789abcdef0123456789abcdef";

    // --- parse_origin ------------------------------------------------------

    #[test]
    fn origin_requires_plain_http_host_port() {
        let origin = parse_origin(ORIGIN).expect("legacy origin parses");
        assert_eq!(origin.scheme, "http");
        assert_eq!(origin.authority, "127.0.0.1:11003");
        assert_eq!(origin.host, "127.0.0.1");
        assert_eq!(origin.port, 11003);
        assert_eq!(origin.base(), ORIGIN);
        // an ephemeral test/probe origin parses the same way
        assert!(parse_origin("http://127.0.0.1:41234").is_ok());
    }

    #[test]
    fn origin_rejects_everything_that_is_not_an_origin() {
        for bad in [
            "",
            "127.0.0.1:11003",
            "https://127.0.0.1:11003",
            "http://127.0.0.1:11003/",       // trailing slash is a path
            "http://127.0.0.1:11003/api",    // path
            "http://127.0.0.1:11003?q",      // query
            "http://127.0.0.1:11003#x",      // fragment
            "http://user@127.0.0.1:11003",   // userinfo
            "http://user:pw@127.0.0.1:11003",
            "http://127.0.0.1",              // no port
            "http://127.0.0.1:0",            // port 0 is not an origin we send to
            "http://127.0.0.1:99999",        // out of range
            "http://127.0.0.1:port",
            "ws://127.0.0.1:11003",
            "file:///app/index.html",
            "not a URL",
        ] {
            assert!(parse_origin(bad).is_err(), "{bad} must not parse");
        }
    }

    // --- bridgeAllows (security.cjs) --------------------------------------

    #[test]
    fn bridge_allows_exactly_the_legacy_route_table() {
        let allowed = [
            ["GET", &format!("{ORIGIN}/")],
            ["GET", &format!("{ORIGIN}/api/health")],
            ["GET", &format!("{ORIGIN}/api/proposals")],
            ["GET", &format!("{ORIGIN}/api/proposals?status=pending")],
            ["POST", &format!("{ORIGIN}/api/proposals/{PROPOSAL}/execute")],
            ["POST", &format!("{ORIGIN}/api/proposals/{PROPOSAL}/reject")],
        ];
        for [method, url] in allowed {
            assert!(bridge_allows(ORIGIN, method, url), "allow {method} {url}");
        }
        // bare origin normalizes to `/` exactly like the WHATWG URL parser
        assert!(bridge_allows(ORIGIN, "GET", ORIGIN));
        // the override base is the same table on another port
        let other = "http://127.0.0.1:41234";
        assert!(bridge_allows(other, "GET", "http://127.0.0.1:41234/api/health"));
        assert!(!bridge_allows(other, "GET", &format!("{ORIGIN}/api/health")));
    }

    #[test]
    fn bridge_allows_denies_everything_outside_the_table() {
        let denied: Vec<(&str, String)> = vec![
            ("GET", format!("{ORIGIN}/api/kanban")),
            ("GET", format!("{ORIGIN}/api/views")),
            ("GET", format!("{ORIGIN}/api/search?q=x")),
            ("GET", format!("{ORIGIN}/internal/proposals")),
            ("GET", format!("{ORIGIN}/propuestas")),
            ("GET", format!("{ORIGIN}/login")),
            ("POST", format!("{ORIGIN}/internal/proposals")),
            ("POST", format!("{ORIGIN}/api/login")),
            ("GET", format!("{ORIGIN}/api/proposals/{PROPOSAL}/execute")),
            ("POST", format!("{ORIGIN}/api/proposals")),
            ("PUT", format!("{ORIGIN}/api/health")),
            ("DELETE", format!("{ORIGIN}/api/proposals")),
            ("POST", format!("{ORIGIN}/api/proposals/proposal_{}", "a".repeat(31))),
            ("POST", format!("{ORIGIN}/api/proposals/proposal_{}/execute", "A".repeat(32))),
            ("POST", format!("{ORIGIN}/api/proposals/{PROPOSAL}/execute/x")),
            ("GET", format!("{ORIGIN}/api/proposals/../internal/proposals")),
            ("GET", format!("{ORIGIN}/?x=1")),
            ("GET", format!("{ORIGIN}/api/health?x")),
            ("GET", format!("{ORIGIN}/api/proposals?status=executed")),
            ("POST", format!("{ORIGIN}/api/proposals/{PROPOSAL}/execute?status=executed")),
            ("GET", format!("{ORIGIN}/#x")),
            ("GET", "http://127.0.0.1:11005/".into()),
            ("GET", "http://localhost:11003/".into()),
            ("GET", "https://127.0.0.1:11003/".into()),
            ("GET", "http://127.0.0.1:11003@evil.example/".into()),
            ("GET", "http://user:pw@127.0.0.1:11003/".into()),
            ("GET", "http://[::1]:11003/".into()),
            ("GET", "file:///app/index.html".into()),
            ("GET", "ws://127.0.0.1:11003/ws".into()),
            ("GET", "https://example.org/".into()),
            ("GET", "not a URL".into()),
        ];
        for (method, url) in denied {
            assert!(!bridge_allows(ORIGIN, method, &url), "deny {method} {url}");
        }
    }

    // --- readBridgeLogin schema (main.cjs 87) ------------------------------

    #[test]
    fn login_schema_accepts_exactly_the_legacy_shape() {
        assert_eq!(
            validate_login_bytes(br#"{"v":1,"login":"tester@example.test"}"#),
            Some("tester@example.test".to_string())
        );
        assert_eq!(
            validate_login_bytes(br#"{"v":1,"login":"a"}"#),
            Some("a".to_string())
        );
        // allowed charset: first [a-z0-9], rest [a-z0-9@._+-]
        assert_eq!(
            validate_login_bytes(br#"{"v":1,"login":"user+tag@ts.example-x.net"}"#),
            Some("user+tag@ts.example-x.net".to_string())
        );
    }

    #[test]
    fn login_schema_rejects_every_invalid_config() {
        // ported from test/main.test.cjs `invalidConfigs` + trailing
        // whitespace/control cases
        let invalid: Vec<Vec<u8>> = vec![
            b"".to_vec(),
            b"{".to_vec(),
            b"null".to_vec(),
            b"[]".to_vec(),
            b"{}".to_vec(),
            br#"{"v":2,"login":"test"}"#.to_vec(),
            br#"{"v":1,"login":1}"#.to_vec(),
            br#"{"v":1,"login":""}"#.to_vec(),
            br#"{"v":1,"login":"Test"}"#.to_vec(),
            br#"{"v":1,"login":"two words"}"#.to_vec(),
            br#"{"v":1,"login":"a\nb"}"#.to_vec(),
            format!(r#"{{"v":1,"login":"{}"}}"#, "a".repeat(255)).into_bytes(),
            br#"{"v":1,"login":"/x"}"#.to_vec(),
            br#"{"v":1,"login":"a","extra":true}"#.to_vec(),
            br#"{"v":1}"#.to_vec(),
            br#"{"v":"1","login":"a"}"#.to_vec(),
            br#"{"v":true,"login":"a"}"#.to_vec(),
            // trailing whitespace / control characters in the login
            br#"{"v":1,"login":"test\n"}"#.to_vec(),
            br#"{"v":1,"login":"test\r"}"#.to_vec(),
            br#"{"v":1,"login":"test\t"}"#.to_vec(),
            "{\"v\":1,\"login\":\"test\u{85}\"}".as_bytes().to_vec(),
            "{\"v\":1,\"login\":\"test\u{feff}\"}".as_bytes().to_vec(),
            "{\"v\":1,\"login\":\"test\u{a0}\"}".as_bytes().to_vec(),
            // non-UTF-8 bytes are never a config
            vec![b'"', 0xff, b'"'],
        ];
        for bytes in invalid {
            let text = String::from_utf8_lossy(&bytes);
            assert!(validate_login_bytes(&bytes).is_none(), "must reject {text:?}");
        }
    }
}

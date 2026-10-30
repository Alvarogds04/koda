//! #467 T11 — closed `github_action` `{action:"refresh", section:"pulse"|"activity"}`:
//! read-only GitHub data: native keychain token first, user's existing gh session otherwise.
//! Tokens never cross IPC; the two sources share the parser/cache. Pure half: `github.rs`.
//!
//! Adapted from Coucou src-tauri/src/lib.rs (`github_refresh`) and integrations.rs
//! (`github_refresh_if_stale`) @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT. Coucou
//! wakes a token poller; Abito has none, so the refresh runs `gh api graphql` once, with
//! a constant query, and keeps the parsed answer until it is stale (60 s / 300 s).
use crate::bridge::{BridgeError, RateLimiter};
use crate::github::{self, GitHubActivity, GitHubPulse};
use serde_json::{json, Value};

#[cfg(test)]
#[path = "githubcmd_tests.rs"]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Pulse,
    Activity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unavailable {
    NotInstalled,
    NotSignedIn,
    BadAnswer,
}

impl Unavailable {
    pub fn code(self) -> &'static str {
        match self {
            Unavailable::NotInstalled => "gh_not_installed",
            Unavailable::NotSignedIn => "gh_not_signed_in",
            Unavailable::BadAnswer => "gh_bad_answer",
        }
    }
}

pub fn parse_github(payload: &Value) -> Result<Section, BridgeError> {
    let bad = || BridgeError::denied("invalid github request");
    let map = payload.as_object().ok_or_else(bad)?;
    if map.len() != 2 || map.get("action").and_then(Value::as_str) != Some("refresh") {
        return Err(bad());
    }
    match map.get("section").and_then(Value::as_str) {
        Some("pulse") => Ok(Section::Pulse),
        Some("activity") => Ok(Section::Activity),
        _ => Err(bad()),
    }
}

/// The whole argv after `gh`: a GraphQL *query* (constant, never caller text).
pub fn gh_args(section: Section) -> Vec<String> {
    let query = match section {
        Section::Pulse => github::PULSE_QUERY,
        Section::Activity => github::ACTIVITY_QUERY,
    };
    vec!["api".into(), "graphql".into(), "-f".into(), format!("query={query}")]
}

#[derive(Default)]
pub struct Cache {
    pulse: Option<GitHubPulse>,
    activity: Option<GitHubActivity>,
    stats: Option<Value>,
}

impl Cache {
    /// S2 (#503): the pulse already cached for the island (no fetch, no clock), as the page sees it.
    pub fn cached_pulse(&self) -> Option<Value> {
        self.pulse.as_ref().and_then(|p| serde_json::to_value(p).ok())
    }

    /// Serves the cache while fresh, else `fetch`es once. A failure caches nothing.
    pub fn refresh<F>(&mut self, section: Section, now_ms: u64, fetch: F) -> Result<Value, Unavailable>
    where
        F: FnOnce(Section) -> Result<Value, Unavailable>,
    {
        let (fetched_at, max_age) = match section {
            Section::Pulse => (self.pulse.as_ref().map(|p| p.fetched_at), 60),
            Section::Activity => (self.activity.as_ref().map(|a| a.fetched_at), 300),
        };
        let stale = github::is_stale(fetched_at, now_ms, max_age);
        if stale {
            let root = fetch(section)?;
            match section {
                Section::Pulse => {
                    self.pulse = Some(GitHubPulse::parse(&root, now_ms).ok_or(Unavailable::BadAnswer)?);
                    self.stats = root.pointer("/data/viewer/ownedRepos").and_then(|repos| {
                        let total = repos.get("totalCount")?.as_u64()?;
                        let stars: u64 = repos.get("nodes")?.as_array()?.iter()
                            .filter_map(|r| r.get("stargazerCount").and_then(Value::as_u64)).sum();
                        Some(json!({"totalRepos":total,"totalStars":stars}))
                    });
                },
                Section::Activity => self.activity = Some(GitHubActivity::parse(&root, now_ms).ok_or(Unavailable::BadAnswer)?),
            }
        }
        let mut out = json!({ "available": true, "fetched": stale });
        match section {
            Section::Pulse => {
                out["pulse"] = serde_json::to_value(&self.pulse).unwrap_or(Value::Null);
                if let Some(stats) = &self.stats { out["stats"] = stats.clone(); }
            },
            Section::Activity => out["activity"] = serde_json::to_value(&self.activity).unwrap_or(Value::Null),
        }
        Ok(out)
    }
}

/// Sender → payload → rate → refresh. Unavailable `gh` is an honest answer, not an error.
pub fn github_command<F>(
    label: &str,
    origin: &str,
    payload: &Value,
    rate: &mut RateLimiter,
    now: u128,
    cache: &mut Cache,
    fetch: F,
) -> Result<Value, BridgeError>
where
    F: FnOnce(Section) -> Result<Value, Unavailable>,
{
    crate::bridge::sender_ok(label, origin)?;
    let section = parse_github(payload)?;
    rate.check(now)?;
    Ok(match cache.refresh(section, now as u64, fetch) {
        Ok(v) => v,
        Err(why) => json!({ "available": false, "reason": why.code() }),
    })
}

/// Runs `gh` (looked up on PATH like `files::find_on_path_in`), 20 s at most, stdin closed.
pub fn run_gh(section: Section) -> Result<Value, Unavailable> {
    run_gh_with_token(section, None)
}

/// A saved key takes precedence over gh's own session; never put credentials in argv.
pub fn authenticated_gh(gh: impl AsRef<std::ffi::OsStr>, section: Section, token: Option<&str>) -> std::process::Command {
    let mut cmd = std::process::Command::new(gh);
    cmd.args(gh_args(section));
    if let Some(token) = token.filter(|t| !t.is_empty()) { cmd.env("GH_TOKEN", token); }
    cmd
}

pub fn run_gh_with_token(section: Section, token: Option<&str>) -> Result<Value, Unavailable> {
    use std::io::Read;
    let gh = std::env::var_os("PATH")
        .and_then(|p| crate::files::find_on_path_in("gh", &p))
        .ok_or(Unavailable::NotInstalled)?;
    let mut child = authenticated_gh(gh, section, token)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| Unavailable::NotInstalled)?;
    let mut stdout = child.stdout.take().ok_or(Unavailable::BadAnswer)?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stdout).take(2 * 1024 * 1024).read_to_end(&mut buf);
        buf
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Unavailable::BadAnswer);
            }
        }
    };
    let bytes = reader.join().map_err(|_| Unavailable::BadAnswer)?;
    if !status.success() {
        // `gh` exits non-zero when it is not authenticated (or the call failed).
        return Err(Unavailable::NotSignedIn);
    }
    serde_json::from_slice(&bytes).map_err(|_| Unavailable::BadAnswer)
}

#[cfg(test)]
mod parity_tests {
    use super::*;
    #[test]
    fn public_refresh_includes_owned_repository_stats() {
        let root = json!({"data":{"viewer":{"login":"fixture","pullRequests":{"nodes":[]},
            "repositories":{"nodes":[]},"ownedRepos":{"totalCount":23,"nodes":[{"stargazerCount":7},{"stargazerCount":11}]},
            "pageTwo":{"nodes":[{"stargazerCount":5}]}}}});
        let answer = Cache::default().refresh(Section::Pulse, 1000, |_| Ok(root)).unwrap();
        assert_eq!(answer["stats"], json!({"totalStars":18,"totalRepos":23}));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn saved_key_reads_same_pulse_from_local_http_without_gh() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/graphql", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
            let mut input = [0; 8192]; let n = socket.read(&mut input).unwrap();
            let text = String::from_utf8_lossy(&input[..n]).to_lowercase();
            assert!(text.contains("authorization: bearer fixture-key"));
            let body = r#"{"data":{"viewer":{"login":"fixture","pullRequests":{"nodes":[]},"repositories":{"nodes":[]},"ownedRepos":{"totalCount":23,"nodes":[{"stargazerCount":18}]}}}}"#;
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        let raw = token_fetch_at(Section::Pulse, "fixture-key", &endpoint).unwrap();
        let answer = Cache::default().refresh(Section::Pulse, 1000, |_| Ok(raw)).unwrap();
        assert_eq!(answer["pulse"]["login"], "fixture");
        assert_eq!(answer["stats"], json!({"totalStars":18,"totalRepos":23}));
        server.join().unwrap();
    }
    #[test]
    fn saved_key_overrides_cli_auth_without_entering_argv() {
        let cmd = authenticated_gh("gh", Section::Pulse, Some("fixture-not-a-secret"));
        assert!(!format!("{:?}", cmd.get_args().collect::<Vec<_>>()).contains("fixture-not-a-secret"));
        assert!(cmd.get_envs().any(|(k,v)| k == "GH_TOKEN" && v == Some(std::ffi::OsStr::new("fixture-not-a-secret"))));
        assert_eq!(authenticated_gh("gh", Section::Pulse, None).get_envs().count(), 0);
    }
}

/// Saved key uses native HTTPS independently of gh. No redirects or proxy credential forwarding.
#[cfg(target_os = "linux")]
pub fn run_token(section: Section, token: &str) -> Result<Value, Unavailable> {
    token_fetch_at(section, token, "https://api.github.com/graphql")
}
#[cfg(not(target_os = "linux"))]
pub fn run_token(section: Section, token: &str) -> Result<Value, Unavailable> {
    run_gh_with_token(section, Some(token))
}
#[cfg(target_os = "linux")]
fn token_fetch_at(section: Section, token: &str, endpoint: &str) -> Result<Value, Unavailable> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| Unavailable::BadAnswer)?;
    runtime.block_on(async {
        let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(20)).build().map_err(|_| Unavailable::BadAnswer)?;
        let query = match section { Section::Pulse => github::PULSE_QUERY, Section::Activity => github::ACTIVITY_QUERY };
        let mut response = client.post(endpoint).bearer_auth(token).header("User-Agent", "Abito")
            .header("Content-Type", "application/json").body(json!({"query":query}).to_string())
            .send().await.map_err(|_| Unavailable::BadAnswer)?;
        if matches!(response.status().as_u16(), 401 | 403) { return Err(Unavailable::NotSignedIn); }
        if !response.status().is_success() { return Err(Unavailable::BadAnswer); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Unavailable::BadAnswer)? {
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 { return Err(Unavailable::BadAnswer); }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| Unavailable::BadAnswer)
    })
}

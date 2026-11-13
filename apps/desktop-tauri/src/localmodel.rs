//! K2-05 U5a — the local-model *client* is gone with the direct Rust chat
//! lane: nothing in Rust sends a prompt, streams a delta, cancels a turn or
//! decodes SSE any more (the daemon engine owns that).
//!
//! What is left is the same-machine endpoint vocabulary the local-model
//! registry (`models`) and the manual specialists still compile against; both
//! leave in U5b/U5d (K2-05 L59):
//! - [`LocalEndpoint`] only accepts `http://127.0.0.1:<port>` or
//!   `http://[::1]:<port>` — a literal loopback IP, so no DNS lookup can send
//!   a request off-machine; no TLS, no path, no userinfo,
//! - [`valid_alias`]: the alias shape the registry lists,
//! - [`get_json`]: the bounded, read-only metadata GETs (`/health`,
//!   `/v1/models`, `/props`, `/slots`) the models panel still reads.
//!
//! No credential is ever attached (the local router is unkeyed), no body is
//! sent by the reads, and there is no retry, redirect or fallback.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use serde_json::Value;

/// Deadlines for one turn. Kept for specialists/models until U5b/U5d (K2-05 L59):
/// the island state still carries them and the specialists' fixture builds them.
#[derive(Debug, Clone, Copy)]
pub struct Deadlines {
    pub connect_ms: u64,
    /// Longest silence between two received bytes (prompt processing
    /// included).
    pub idle_ms: u64,
    /// Whole turn.
    pub total_ms: u64,
}

pub const DEFAULT_DEADLINES: Deadlines = Deadlines {
    connect_ms: 1_500,
    idle_ms: 90_000,
    total_ms: 300_000,
};

/// A same-machine endpoint: literal loopback IP + port, plain HTTP.
/// Kept for specialists/models until U5b/U5d (K2-05 L59).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalEndpoint {
    addr: SocketAddr,
    origin: String,
}

impl LocalEndpoint {
    pub fn parse(text: &str) -> Result<Self, ()> {
        let authority = text.strip_prefix("http://").ok_or(())?;
        if authority.is_empty() || authority.contains(['/', '?', '#', '@']) {
            return Err(());
        }
        let addr: SocketAddr = authority.parse().map_err(|_| ())?;
        let loopback = match addr.ip() {
            IpAddr::V4(ip) => ip == Ipv4Addr::LOCALHOST,
            IpAddr::V6(ip) => ip == Ipv6Addr::LOCALHOST,
        };
        if !loopback || addr.port() == 0 {
            return Err(());
        }
        Ok(LocalEndpoint {
            addr,
            origin: text.to_string(),
        })
    }
    pub fn origin(&self) -> &str {
        &self.origin
    }
    pub fn port(&self) -> u16 {
        self.addr.port()
    }
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }
}

/// Model alias: 1..=64 of `[A-Za-z0-9._-]`.
/// Kept for specialists/models until U5b/U5d (K2-05 L59).
pub fn valid_alias(alias: &str) -> bool {
    (1..=64).contains(&alias.len())
        && alias
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

/// Bounded metadata read (`GET <path>` → JSON) from the same pinned endpoint:
/// no inference, no body sent, one attempt, short deadline. Used by the
/// model picker (U2). `None` on any failure.
pub fn get_json(endpoint: &LocalEndpoint, path: &str, deadline_ms: u64) -> Option<Value> {
    if !matches!(path, "/health" | "/v1/models" | "/props" | "/slots") {
        return None; // closed set of metadata routes, never inference
    }
    let origin = crate::requests::parse_origin(endpoint.origin()).ok()?;
    let active = crate::http::ActiveRequests::new();
    let response = crate::http::send(
        &origin,
        "GET",
        path,
        &[("Accept".to_string(), "application/json".to_string())],
        None,
        true,
        deadline_ms,
        &active,
    )
    .ok()?;
    if response.status != 200 {
        return None;
    }
    serde_json::from_slice(&response.body?).ok()
}

#[cfg(test)]
#[path = "localmodel_tests.rs"]
mod tests;

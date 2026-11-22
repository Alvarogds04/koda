//! Abito island — Electron → Rust + Tauri migration.
//!
//! Unit **M2** exposes the transport-facing modules as a library so the
//! socket integration tests (`tests/`) can bind a real receiver without a
//! GUI:
//! - [`protocol`] — pure framing/validation/quota/dedupe/expiry logic
//!   (ports of `core.cjs decode`/`NoticeStore` and the `transport.cjs`
//!   stream rules), unit-tested first (RED → GREEN),
//! - [`transport`] — the Unix-domain-socket receiver itself (permissions,
//!   owner checks, quotas, connection counting, identity-checked cleanup).
//!
//! The window/bridge modules live here too (they are pure enough to test
//! headless); `main.rs` is the Tauri wiring and `probe.rs` its read-back
//! script.

/// AC-08/K-C (S2, S6): the switch for the OLD engine path of agent requests — the QP/1 question lane
/// inside the receiver plus the `<runtime>/endpoint.json` handoff that installed hooks and producers
/// read. The human decided (21 Nov) that this path is DISABLED, not deleted: nothing is removed and
/// nothing is uninstalled, so setting this to exactly `1` restores every part of it.
///
/// It lives at the crate root because both halves are target-specific (`handoff` is the Unix socket
/// handoff on Unix and an inert stub elsewhere) and one switch must decide them the same way.
pub const LEGACY_AGENT_REQUESTS_ENV: &str = "KODA_LEGACY_AGENT_REQUESTS";

/// The switch as a pure function of one value: unit-testable without touching the process environment.
/// Only the exact value `1` turns the legacy path on; unset, empty, `0` and `true` are off.
pub fn legacy_agent_requests_switch(value: Option<&str>) -> bool {
    value == Some("1")
}

/// Is the legacy agent-request path enabled on this run? OFF by default: Koda answers agent requests
/// through jesscore, and the old path is disabled (not deleted) behind this one reversible switch.
pub fn legacy_agent_requests_enabled() -> bool {
    legacy_agent_requests_switch(std::env::var(LEGACY_AGENT_REQUESTS_ENV).ok().as_deref())
}

/// AC-08/K-C: publish `<runtime>/endpoint.json` only while the legacy path is on. With it off, an
/// installed hook or producer must find no endpoint at all, so it keeps its own terminal prompt
/// instead of connecting to a receiver that no longer answers questions.
pub fn should_publish_handoff(legacy_agent_requests: bool) -> bool {
    legacy_agent_requests
}

/// AC-08/K-F (S2, S6; human decision, 22 Nov, carried from jesscore): the switch for the OLD Pi extension install — the
/// `~/.pi/agent/extensions/koda-island` folder (and a 0.1 `abito-island` beside it) that the harness installer owns.
/// Koda stopped installing and managing it, and it is retired REVERSIBLY, exactly like [`LEGACY_AGENT_REQUESTS_ENV`]:
/// no code is deleted and the folder on disk is never touched, so setting this to exactly `1` restores the installer.
///
/// The installer itself (`apps/desktop-harness/src/install-claude.cjs`) and the daemon (`src/agents.cjs`) read the
/// same variable; here it only has to reach the node child that Settings spawns (`agents_direct::runtime`).
pub const LEGACY_PI_EXTENSION_ENV: &str = "KODA_LEGACY_PI_EXTENSION";

/// The switch as a pure function of one value: only the exact value `1` turns the legacy Pi install on; unset, empty,
/// `0`, `true` and every near-miss are off. Same rule as [`legacy_agent_requests_switch`].
pub fn legacy_pi_extension_switch(value: Option<&str>) -> bool {
    value == Some("1")
}

/// Is the legacy Pi extension install enabled on this run? OFF by default: Koda no longer installs that extension.
pub fn legacy_pi_extension_enabled() -> bool {
    legacy_pi_extension_switch(std::env::var(LEGACY_PI_EXTENSION_ENV).ok().as_deref())
}

pub mod agentclient;
pub mod agents_direct;
/// K2-05 T4 U2: the island chat client (closed chat commands + the allowlisted
/// chat view) — separate from agentclient by design; its transport is
/// `agentconn::ChatConn`, a second connection with its own fold callback.
pub mod chatclient;
/// K2-05 T4 U3: the chat host's routing tests (`ChatHost` lives in `chatclient`, the
/// Tauri glue in the binary's `chathost.rs`, covered here by source guards).
#[cfg(test)]
#[path = "chathost_tests.rs"]
mod chathost_tests;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub mod agentconn;
#[cfg(windows)]
#[path = "agentconn_win.rs"]
pub mod agentconn;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
#[path = "agentconn_unavailable.rs"]
pub mod agentconn;
pub mod winpolicy;
pub mod opener;
pub mod winipc;
pub mod winfs;
pub mod approval;
pub mod bridge;
pub mod card;
pub mod characterwin;
pub mod chat;
pub mod chatlane;
pub mod core;
pub mod desktop;
pub mod failure;
pub mod failure_cmd;
pub mod files;
pub mod contextwin;
pub mod focushost;
pub mod sessionterm;
#[cfg(target_os = "macos")]
pub mod sessionterm_mac;
#[cfg(windows)]
pub mod sessionterm_win;
pub mod github;
pub mod githubcmd;
pub mod calendar;
pub mod daemonhost;
pub mod nodefinder;
#[cfg(any(debug_assertions, feature = "probe"))]
pub mod fakebridge;
#[cfg(any(debug_assertions, feature = "probe"))]
pub mod fakemodel;
pub mod flow;
pub mod dictation_cmd;
pub mod geometry;
// HU-068: macOS publishes the same Unix-socket handoff as Linux (it has a receiver since M-T1); only Windows has none.
#[cfg(unix)]
pub mod handoff;
#[cfg(not(unix))]
#[path = "handoff_unavailable.rs"]
pub mod handoff;
pub mod hotkey;
pub mod http;
pub mod identity;
pub mod integrations;
pub mod integrations_net;
pub mod servicedetail;
pub mod localmodel;
pub mod cloudprofiles;
#[cfg(target_os = "linux")]
pub mod phone_link;
pub mod models;
pub mod monitors;
pub mod claude_plan;
pub mod codex_plan;
pub mod plan_cmd;
pub mod paused;
pub mod prefs;
pub mod protocol;
pub mod legacy_conversations;
pub mod legacy_identity;
pub mod legacy_recap;
pub mod secrets;
pub mod provider_oauth;
pub mod gmail_oauth;
pub mod gmail_api;
pub mod gmailcmd;
pub mod mailmigration;
pub mod oauthcmd;
pub mod sounds;
pub mod question;
pub mod spotify;
// K2-09: the same Spotify state from the other two systems — Windows reads the system media
// transport controls (spotify_smtc), macOS drives Spotify with AppleScript (spotify_mac). Both
// keep their pure parts outside the platform `cfg` so they are unit-tested on every OS.
pub mod spotify_mac;
pub mod spotify_smtc;
pub mod questioncmd;
pub mod requests;
pub mod renderenv;
pub mod retry;
pub mod speech;
pub mod transport_view;
pub mod uploads;
pub mod voicecmd;
pub mod voiceintent;
pub mod voicespeak;
// The real receiver: Linux/macOS use UDS (transport.rs); Windows uses named
// pipes with the S6 gate (transport_win.rs). Non-Linux/macOS/Windows targets
// keep the honest unavailable stub.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub mod transport;
#[cfg(windows)]
#[path = "transport_win.rs"]
pub mod transport;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
#[path = "transport_unavailable.rs"]
pub mod transport;
pub mod workarea;
/// K2-06: the host side of «capture my window» (refusal list, consent session, loopback tool server).
pub mod windowcapture;

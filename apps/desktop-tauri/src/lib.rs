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

pub mod agentclient;
pub mod agents_direct;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub mod agentconn;
#[cfg(windows)]
#[path = "agentconn_win.rs"]
pub mod agentconn;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
#[path = "agentconn_unavailable.rs"]
pub mod agentconn;
pub mod winpolicy;
pub mod winipc;
pub mod winfs;
pub mod approval;
pub mod bridge;
pub mod card;
pub mod characterwin;
pub mod chat;
pub mod chatlane;
pub mod chatsnapshot;
pub mod conversations;
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
pub mod daemonhost;
pub mod nodefinder;
pub mod nodeinstall;
pub mod piinstall;
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
pub mod cloudmodel;
pub mod cloudprofiles;
pub mod imapcmd;
pub mod mailcmd;
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
pub mod recap;
pub mod recap_cmd;
pub mod recap_spool;
pub mod secrets;
pub mod provider_oauth;
pub mod oauthcmd;
pub mod sounds;
pub mod question;
pub mod spotify;
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

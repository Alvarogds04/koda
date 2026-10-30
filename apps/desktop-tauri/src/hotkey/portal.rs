//! #305b — the XDG Desktop Portal `GlobalShortcuts` backend (the Wayland route).
//!
//! WHY a portal: an X11 grab on a Wayland session only receives the key while an
//! X11 window has the focus (the island runs under XWayland). The portal is the
//! compositor-blessed way to get a system-wide shortcut.
//!
//! DEPENDENCY CHOICE (documented, measured): `ashpd` is NOT in the offline cargo
//! registry and downloads are forbidden, so it cannot be used. `zbus 5.19` is
//! ALREADY compiled into the binary (via `tauri-plugin-single-instance`) and other
//! crates of this repo use it with `blocking-api`, so talking to the portal with
//! `zbus` directly adds ZERO new crates, leaves `Cargo.lock` untouched and keeps
//! the `--locked --offline` release build working. The protocol surface is small
//! (CreateSession, BindShortcuts, the Request `Response` signal, the `Activated`
//! signal), so a thin hand-written client is lighter and easier to audit than a
//! general portal library.
//!
//! The pure parts (tokens, request paths, response mapping, trigger text, backend
//! choice, signal filter) live here and are unit tested; the D-Bus I/O is in
//! [`client`] and is tested against a PRIVATE session bus with a fake portal.
use super::Session;

/// Our one shortcut's id inside the portal session.
pub const SHORTCUT_ID: &str = "toggle-island";

/// `/org/freedesktop/portal/desktop/request/SENDER/TOKEN`, sender `:1.234` → `1_234`.
pub fn sender_token(unique_name: &str) -> String {
    unique_name.trim_start_matches(':').replace('.', "_")
}

pub fn request_path(unique_name: &str, token: &str) -> String {
    format!("/org/freedesktop/portal/desktop/request/{}/{}", sender_token(unique_name), token)
}

/// A unique `[A-Za-z0-9_]+` token (never starts with a digit, ≤ 64 chars).
pub fn token(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("abito_{prefix}_{}_{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Granted,
    /// The human closed or declined the OS permission dialog.
    Denied,
    Failed,
}

/// `org.freedesktop.portal.Request::Response` code: 0 success, 1 user cancelled, 2 other.
pub fn outcome_of_response(code: u32) -> Outcome {
    match code {
        0 => Outcome::Granted,
        1 => Outcome::Denied,
        _ => Outcome::Failed,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortalState {
    Available,
    Unavailable,
    Denied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Portal,
    X11 { limited: bool },
}

/// One pure decision for both backends: the portal is primary on Wayland; the X11
/// grab is the honest fallback (limited there, complete on a real X11 session).
pub fn choose_backend(session: Session, portal: PortalState) -> Backend {
    match (session, portal) {
        (Session::Wayland, PortalState::Available) => Backend::Portal,
        (Session::Wayland, _) => Backend::X11 { limited: true },
        _ => Backend::X11 { limited: false },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutSignal {
    pub shortcut_id: String,
    pub activated: bool,
}

/// Only OUR shortcut's activation toggles the island (never its release, never another's).
pub fn is_our_activation(signal: &ShortcutSignal) -> bool {
    is_our_activation_for(signal, SHORTCUT_ID)
}

pub fn is_our_activation_for(signal: &ShortcutSignal, id: &str) -> bool {
    signal.activated && signal.shortcut_id == id
}

/// One shortcut inside the single portal session: its stable id, the human description GNOME shows and
/// the trigger Abito PREFERS (the human may pick another one in the OS dialog / Settings).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindRequest {
    pub id: String,
    pub description: String,
    pub trigger: String,
}

/// Everything one `BindShortcuts` must carry: every ENABLED, bound target, in catalog order. A disabled
/// or unbound target is never requested. ONE call for all of them is what lets the OS remember the
/// whole set, so its confirmation dialog appears once and not on every launch.
pub fn bind_requests(configs: &[(super::Target, super::HotkeyConfig)]) -> Vec<BindRequest> {
    configs
        .iter()
        .filter(|(_, c)| c.enabled && c.bound)
        .map(|(t, c)| BindRequest { id: t.portal_id().to_owned(), description: t.description().to_owned(), trigger: c.combo.portal_trigger() })
        .collect()
}

/// The target an `Activated` signal belongs to: only a PRESS of an id we bound; a release, an
/// unknown id (another app, an old session) or a target that was not requested routes nowhere.
pub fn route_activation(signal: &ShortcutSignal, bound: &[BindRequest]) -> Option<super::Target> {
    if !signal.activated {
        return None;
    }
    bound.iter().find(|b| b.id == signal.shortcut_id)?;
    super::Target::ALL.into_iter().find(|t| t.portal_id() == signal.shortcut_id)
}

/// While the OS dialog is open the limited X11 grab runs IN PARALLEL, so a dialog
/// nobody answers can never leave the shortcut without a route. Once the portal
/// really holds the shortcut the X11 grab is dropped (one press must not toggle
/// twice); if the portal gives up or the human declines, the X11 grab is promoted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortalPlan {
    KeepBoth,
    DropX11,
    PromoteX11 { reason: super::Status },
}

pub fn plan_for(portal_status: super::Status) -> PortalPlan {
    match portal_status {
        super::Status::Active => PortalPlan::DropX11,
        super::Status::PermissionDenied | super::Status::Unsupported => PortalPlan::PromoteX11 { reason: portal_status },
        _ => PortalPlan::KeepBoth,
    }
}

/// What the host does when the portal route fails AFTER it was chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fallback {
    Keep,
    /// Hand the shortcut to the X11 grab; remember why the portal gave up.
    ToX11 { portal_status: super::Status },
}

pub fn fallback_for(backend: Backend, status: super::Status) -> Fallback {
    match (backend, status) {
        (Backend::Portal, super::Status::PermissionDenied) | (Backend::Portal, super::Status::Unsupported) => Fallback::ToX11 { portal_status: status },
        _ => Fallback::Keep,
    }
}

#[cfg(target_os = "linux")]
pub mod client;

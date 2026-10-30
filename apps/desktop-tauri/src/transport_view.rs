//! Platform-independent views, errors, options, and runtime-name constants for
//! the notice transport. The Linux receiver and non-Linux unavailable backend
//! share this surface.

use crate::protocol::{self, Message};
use crate::question;
use crate::questioncmd::NativeTransition;
use std::fmt;
use std::path::PathBuf;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionOutcome {
    Busy, Expired, Disconnected, Cancelled, Sent, Answered, HumanCancelled,
    Rejected, AckLost, OutcomeUnknown,
}
#[derive(Clone, Serialize)]
pub struct QuestionOptionView { pub index: usize, pub label: String, pub description: String }
#[derive(Clone, Serialize)]
pub struct PendingQuestionView {
    pub id: String, pub kind: question::Kind, pub text: String,
    pub options: Vec<QuestionOptionView>, pub allow_free_text: bool, pub expires_at: u64,
    /// Who asks (P1): the validated slug and its display name.
    pub agent: String, pub agent_label: String,
    /// Project name of the asking session when the producer sent one (S3); absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    /// Structured questions: several options may be chosen (absent/false for a plain question).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub multi_select: bool,
    /// A questionnaire: one entry per question; the frame's own options/text-entry are empty then.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub form: Option<Vec<FormItemView>>,
    /// Longest free-text answer accepted, in characters (2000 plain, 4000 structured).
    pub free_text_max: usize,
}
#[derive(Clone, Serialize)]
pub struct FormItemView {
    pub header: String, pub text: String, pub options: Vec<QuestionOptionView>,
    pub multi_select: bool, pub allow_free_text: bool,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState { Sent }
#[derive(Clone, Serialize)]
pub struct QuestionDeliveryView { pub id: String, pub expires_at: u64, pub state: DeliveryState }
/// Only pending display text crosses this boundary. No scope, socket handle,
/// option token or answer text is serializable to the frontend.
#[derive(Clone, Serialize)]
pub struct QuestionSnapshot {
    pub pending: Option<PendingQuestionView>,
    /// Questions waiting BEHIND `pending`, oldest first, and their number.
    pub queued: Vec<PendingQuestionView>, pub queued_count: usize,
    pub deliveries: Vec<QuestionDeliveryView>,
    pub ready_connections: usize, pub notice: Option<QuestionOutcome>,
    pub native_transition: NativeTransition,
}
#[derive(Debug, PartialEq, Eq)]
pub enum HumanReplyError { Validation(question::Error), OutcomeUnknown }
impl fmt::Display for HumanReplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self { Self::Validation(e) => e.fmt(f), Self::OutcomeUnknown => f.write_str("outcome_unknown") }
    }
}
impl std::error::Error for HumanReplyError {}

/// Override env: transport runtime root (tests/probe).
pub const SOCKET_DIR_ENV: &str = "ABITO_SOCKET_DIR";

/// Runtime leaf names reserved by the packaged identities (packaged.cjs
/// `IDENTITIES`): the installed Preview owns `abito-desktop`, the technical
/// preview owns `abito-desktop-preview`.
pub const RESERVED_RUNTIME_NAMES: [&str; 2] = ["abito-desktop", "abito-desktop-preview"];

/// Errors, one per legacy `throw` string in transport.cjs where one exists.
#[derive(Debug)]
pub enum TransportError {
    /// `'Linux identity required'` — no OS uid (cannot happen on Linux).
    LinuxIdentityRequired,
    /// `'Unsafe directory chain'` — a parent is a symlink, foreign-owned or
    /// world-writable.
    UnsafeDirectoryChain,
    /// `'Private directory required'` — not exactly 0700 and ours.
    PrivateDirectoryRequired,
    /// `'Unexpected endpoint'` — path shape/ownership rules of verifyEndpoint.
    UnexpectedEndpoint,
    /// `'Unsafe socket'` — not an owned 0600 socket file.
    UnsafeSocket,
    /// `'Cleanup identity changed'` — the generated dir inode changed; do
    /// not remove anything.
    CleanupIdentityChanged,
    /// `'Cleanup socket changed'` — the endpoint is no longer the socket we
    /// bound; do not remove it.
    CleanupSocketChanged,
    /// `'Unix endpoint path too long'` — sockaddr_un holds 108 bytes.
    PathTooLong,
    /// Refused: path resolves into a reserved Preview runtime root.
    ReservedPreviewRoot,
    /// Refused: `ABITO_SOCKET_DIR` is not an absolute normalized path.
    InvalidOverride,
    /// No runtime root could be determined (no manifest dir).
    NoRuntimeRoot,
    /// No per-OS receiver exists yet; the reason explains the missing capability.
    Unavailable(&'static str),
    Io(std::io::Error),
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TransportError::LinuxIdentityRequired => write!(f, "Linux identity required"),
            TransportError::UnsafeDirectoryChain => write!(f, "Unsafe directory chain"),
            TransportError::PrivateDirectoryRequired => write!(f, "Private directory required"),
            TransportError::UnexpectedEndpoint => write!(f, "Unexpected endpoint"),
            TransportError::UnsafeSocket => write!(f, "Unsafe socket"),
            TransportError::CleanupIdentityChanged => write!(f, "Cleanup identity changed"),
            TransportError::CleanupSocketChanged => write!(f, "Cleanup socket changed"),
            TransportError::PathTooLong => write!(f, "Unix endpoint path too long"),
            TransportError::ReservedPreviewRoot => {
                write!(f, "Refusing reserved Preview runtime root")
            }
            TransportError::InvalidOverride => write!(f, "Unexpected endpoint"),
            TransportError::NoRuntimeRoot => write!(f, "No runtime directory"),
            TransportError::Unavailable(reason) => write!(f, "unavailable: {reason}"),
            TransportError::Io(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for TransportError {}

impl From<std::io::Error> for TransportError {
    fn from(error: std::io::Error) -> Self {
        TransportError::Io(error)
    }
}

/// Receiver options — the legacy `createTransport` argument list.
pub struct TransportOptions {
    pub runtime: PathBuf,
    pub project: String,
    pub handshake_ms: u64,
    pub idle_ms: u64,
    pub on_notice: Box<dyn Fn(Message) + Send + Sync>,
    pub on_connections: Box<dyn Fn(u32) + Send + Sync>,
    /// Invalidation only; callbacks run after all transport locks are dropped.
    pub on_question_change: Box<dyn Fn() + Send + Sync>,
}

impl TransportOptions {
    pub fn new(runtime: impl Into<PathBuf>, project: impl Into<String>) -> Self {
        TransportOptions {
            runtime: runtime.into(),
            project: project.into(),
            handshake_ms: protocol::HANDSHAKE_MS,
            idle_ms: protocol::IDLE_MS,
            on_notice: Box::new(|_| {}),
            on_connections: Box::new(|_| {}),
            on_question_change: Box::new(|| {}),
        }
    }

    pub fn handshake_ms(mut self, milliseconds: u64) -> Self {
        self.handshake_ms = milliseconds;
        self
    }

    pub fn idle_ms(mut self, milliseconds: u64) -> Self {
        self.idle_ms = milliseconds;
        self
    }

    pub fn on_notice(mut self, callback: impl Fn(Message) + Send + Sync + 'static) -> Self {
        self.on_notice = Box::new(callback);
        self
    }

    pub fn on_connections(mut self, callback: impl Fn(u32) + Send + Sync + 'static) -> Self {
        self.on_connections = Box::new(callback);
        self
    }

    pub fn on_question_change(mut self, callback: impl Fn() + Send + Sync + 'static) -> Self {
        self.on_question_change = Box::new(callback);
        self
    }
}

/// Own leaf of the installed app inside `$XDG_RUNTIME_DIR` (M4 packaging
/// plan §3): never one of [`RESERVED_RUNTIME_NAMES`].
pub const INSTALLED_RUNTIME_LEAF: &str = "abito-island";

/// Read-only report of one runtime root: socket files under generated
/// `p-XXXXXX` dirs. Never connects, never unlinks, never follows symlinks.
#[derive(Debug, Clone)]
pub struct PreviewScan {
    pub root: String,
    pub sockets: Vec<String>,
}

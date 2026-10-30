//! Honest unavailable transport backend for non-Linux targets.
//!
//! Windows' real answer (named pipes) and a macOS backend each remain separate
//! human decisions; this fallback never pretends that a receiver exists.

pub use crate::transport_view::{
    DeliveryState, HumanReplyError, PendingQuestionView, PreviewScan, QuestionDeliveryView,
    QuestionOptionView, QuestionOutcome, QuestionSnapshot, TransportError, TransportOptions,
    INSTALLED_RUNTIME_LEAF, RESERVED_RUNTIME_NAMES, SOCKET_DIR_ENV,
};

use crate::question;
use std::convert::Infallible;
use std::path::{Path, PathBuf};

const UNAVAILABLE_REASON: &str = "the local notice transport needs a per-OS receiver; this target has none in this port yet";

pub fn resolve_runtime() -> Result<PathBuf, TransportError> {
    Err(TransportError::Unavailable(UNAVAILABLE_REASON))
}

pub struct Transport {
    /// An uninhabited field proves that no transport can be constructed here.
    never: Infallible,
}

impl Transport {
    /// The `ABITO_DESKTOP_SOCKET=…` path the producer connects to.
    pub fn endpoint(&self) -> &Path {
        match self.never {}
    }

    pub fn runtime(&self) -> &Path {
        match self.never {}
    }

    pub fn question_snapshot(&self) -> QuestionSnapshot {
        match self.never {}
    }

    /// Read-only budget for the matching live slot. No prune, ticket commit,
    /// origin write or private scope is exposed. Send revalidates at its own time.
    pub fn question_text_budget(&self, _id: &str, _text: &str) -> Result<crate::questioncmd::TextBudget, question::Error> {
        match self.never {}
    }

    /// Atomic pending-question guard. The closure must not reenter transport
    /// or publish questions; an unpruned expired slot blocks until normal expiry.
    pub fn with_question_pending<T>(&self, _operation: impl FnOnce(bool) -> T) -> T {
        match self.never {}
    }

    /// Click-only navigation guard: without a transport there is never a current notice.
    pub fn with_question_click<T>(&self, _id: &str, _operation: impl FnOnce() -> T) -> Result<T, crate::bridge::BridgeError> {
        match self.never {}
    }

    /// Host-only entry points. UI supplies exactly an id and index/text, never
    /// scope/source/connection or an opaque wire token. Trusted human input must
    /// still be enforced by the later closed IPC/UI gate; this is not attestation.
    pub fn answer(&self, _id: &str, _index: usize) -> Result<(), HumanReplyError> {
        match self.never {}
    }

    pub fn answer_text(&self, _id: &str, _text: String) -> Result<(), HumanReplyError> {
        match self.never {}
    }

    pub fn answer_many(&self, _id: &str, _indexes: Vec<usize>, _text: Option<String>) -> Result<(), HumanReplyError> {
        match self.never {}
    }
    pub fn answer_form(&self, _id: &str, _answers: Vec<crate::question::ItemAnswer>) -> Result<(), HumanReplyError> {
        match self.never {}
    }
    pub fn decline(&self, _id: &str) -> Result<(), HumanReplyError> {
        match self.never {}
    }

    /// Linux `close()` stops accepting and performs identity-checked cleanup.
    /// This stub cannot own resources because no instance can be constructed.
    pub fn close(&self) -> Result<(), TransportError> {
        match self.never {}
    }

    /// No receiver, so no terminal origin is ever known (host-only lookup on the real backend).
    pub fn origin_for(&self, _request: &crate::focushost::OriginRequest) -> Option<crate::sessionterm::Origin> {
        match self.never {}
    }

    /// No receiver, so there are no notice origins to forget.
    pub fn forget_notice_origins(&self, _ids: &[String]) {
        match self.never {}
    }
}

pub fn create_transport(_options: TransportOptions) -> Result<Transport, TransportError> {
    Err(TransportError::Unavailable(UNAVAILABLE_REASON))
}

/// Same signature as the real backend's observed constructor; the observer is never called here.
pub fn create_transport_observed(options: TransportOptions,
    _on_failure: impl Fn(crate::protocol::TransportFailure) + Send + Sync + 'static,
) -> Result<Transport, TransportError> {
    create_transport(options)
}

/// No receiver on this target, so there is nothing to scan (honest empty, not a fake hit).
pub fn preview_scan() -> Vec<PreviewScan> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_resolution_fails_closed() {
        assert!(matches!(
            resolve_runtime(),
            Err(TransportError::Unavailable(
                "the local notice transport needs a per-OS receiver; this target has none in this port yet"
            ))
        ));
    }

    #[test]
    fn transport_creation_fails_closed() {
        let options = TransportOptions::new(PathBuf::new(), "test");
        assert!(matches!(
            create_transport(options),
            Err(TransportError::Unavailable(
                "the local notice transport needs a per-OS receiver; this target has none in this port yet"
            ))
        ));
    }
}

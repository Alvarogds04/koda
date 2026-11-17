//! The capture consent session (S6): idle until the user grants it, then valid for 30 minutes.
//!
//! Adapted from Gentle Dot `computer/session.rs`, MIT (without its yolo mode, which Koda does not have).

pub const SESSION_MS: u64 = 30 * 60 * 1000;

#[derive(Debug, Default)]
pub struct Session {
    ends_at: Option<u64>,
}

impl Session {
    pub fn is_active(&self, now_ms: u64) -> bool {
        self.ends_at.is_some_and(|end| now_ms < end)
    }

    /// Starts (or restarts) a session of `SESSION_MS`.
    pub fn grant(&mut self, now_ms: u64) {
        self.ends_at = Some(now_ms + SESSION_MS);
    }

    pub fn end(&mut self) {
        self.ends_at = None;
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;

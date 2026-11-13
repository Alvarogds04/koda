//! K2-10 T8 (L23, L24): the one-time removal of the 0.1 IMAP/SMTP mail accounts from the keychain.
//!
//! The human decided («15b») that updating to 0.2 deletes the mail accounts the 0.1 stored for its
//! IMAP/SMTP path, which 0.2 retired. Exactly the seven keys in [`RETIRED_KEYS`] are deleted and
//! nothing else in the keychain is read, written or removed. It is idempotent (a missing key is
//! not an error), makes one attempt per key per launch (never a loop), and reports `Done` only
//! when all seven are deleted or absent; the caller stores the «done» mark then, so a keychain
//! that failed once is cleaned on a later launch and a finished migration never touches the
//! keychain again. A failure never stops Koda and its log line carries no value and no key name.
use crate::secrets::SecretStore;

#[cfg(test)]
#[path = "mailmigration_tests.rs"]
mod tests;

/// The 0.1 mail accounts (IMAP read, SMTP send) and nothing else.
pub const RETIRED_KEYS: &[&str] = &["imap-host", "imap-user", "imap-password", "smtp-host", "smtp-user", "smtp-password", "smtp-from"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Every retired key is deleted or was never there: store the «done» mark.
    Done,
    /// The mark was already stored: nothing was touched.
    AlreadyDone,
    /// This many keys could not be deleted this launch; the mark stays unset and a later launch retries.
    Pending { failed: usize },
}
impl Outcome {
    /// A log line without any value or key name; empty when nothing happened.
    pub fn log_line(self) -> String {
        match self {
            Outcome::Done => "mail migration: the 0.1 mail accounts were removed from the keychain".into(),
            Outcome::AlreadyDone => String::new(),
            Outcome::Pending { failed } => format!("mail migration: {failed} of the 0.1 mail account entries could not be removed; will retry on the next launch"),
        }
    }
}

/// Runs the migration once for this launch. `done` is the stored mark.
pub fn run(store: &dyn SecretStore, done: bool) -> Outcome {
    if done { return Outcome::AlreadyDone; }
    // `delete` of a missing entry is Ok on every backend, so absence is never an error.
    let failed = RETIRED_KEYS.iter().filter(|key| store.delete(key).is_err()).count();
    if failed == 0 { Outcome::Done } else { Outcome::Pending { failed } }
}

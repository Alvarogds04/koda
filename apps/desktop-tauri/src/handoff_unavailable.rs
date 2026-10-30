//! P2 — the STABLE handoff of the receiver endpoint.
//!
//! This non-Linux stub preserves the API but cannot publish an endpoint because
//! no receiver exists here. The Linux implementation binds a fresh `<runtime>/p-XXXXXX/s` on every start, so a local consumer (an agent
//! hook) cannot know it in advance. After the bind we publish ONE file at a path that never
//! changes — `<runtime>/endpoint.json` — and remove it on exit:
//!
//! ```json
//! {"v":1,"endpoint":"<runtime>/p-XXXXXX/s","pid":<island pid>}
//! ```
//!
//! 0600, written to a temp file then `rename`d (readers never see a half file), closed key set.
//! It is a pointer, not an authority: the consumer still connects to the socket, which checks the
//! peer uid, and [`read`] refuses a stale file (socket gone, wrong shape). Nothing here makes a
//! path, a pid or a label trusted.

use std::io;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "endpoint.json";

/// `<runtime>/endpoint.json`.
// keep in sync with handoff.rs
pub fn path(runtime: &Path) -> PathBuf {
    runtime.join(FILE_NAME)
}

/// Publish `endpoint` for local consumers. The Linux implementation refuses anything that is not
/// the exact receiver socket of `runtime`, a non-private `runtime`, and a symlink at the target path.
/// This backend always returns `Unsupported` because it has no receiver.
pub fn publish(_runtime: &Path, _endpoint: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "endpoint handoff is a Unix-socket handoff; this target has no receiver",
    ))
}

/// The endpoint a consumer should connect to. No receiver can have published on this target.
pub fn read(_runtime: &Path) -> Option<PathBuf> {
    None
}

/// No-op under the honesty rule: `publish` can never have succeeded on this target.
pub fn clear(_runtime: &Path, _endpoint: &Path) {}

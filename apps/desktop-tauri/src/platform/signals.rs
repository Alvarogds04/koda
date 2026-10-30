//! Seam: clean-exit signal handling.
//!
//! The island deletes its own transport endpoint on the way out, so a signal
//! that kills the process with the default disposition would leave a stale
//! socket behind and the next launch would have to reason about a peer that is
//! not there. The handler therefore does the minimum that is safe to do in
//! signal context — one atomic store — and a watcher thread performs the actual
//! cleanup.
//!
//! Which requests can even reach us is OS policy, not our choice, so the two
//! implementations register different sets:
//!
//! - **unix**: `SIGINT` and `SIGTERM`, as the crate always has.
//! - **windows**: `SIGINT` only. The MSVC CRT raises `SIGINT` on Ctrl-C, but
//!   `SIGTERM` is never delivered by the operating system — registering a
//!   handler for it would install code that can only ever look like it works.
//!   Graceful exit on Windows comes from the window message path instead.

/// The handler shape both implementations accept. `libc::c_int` is the signal
/// number on every target this crate builds for.
pub(crate) type Handler = extern "C" fn(libc::c_int);

/// Register `handler` for the shutdown requests this OS can actually deliver.
#[cfg(unix)]
pub(crate) fn install(handler: Handler) {
    // SAFETY: the handler performs an atomic store and nothing else, which is
    // async-signal-safe; `signal()` merely replaces the disposition.
    unsafe {
        libc::signal(
            libc::SIGINT,
            handler as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGTERM,
            handler as *const () as libc::sighandler_t,
        );
    }
}

/// Register `handler` for the shutdown requests this OS can actually deliver.
#[cfg(windows)]
pub(crate) fn install(handler: Handler) {
    // SAFETY: same contract as the unix arm — one atomic store in the handler.
    // `sighandler_t` is `usize` here, so the handler travels as an address.
    unsafe {
        libc::signal(
            libc::SIGINT,
            handler as *const () as libc::sighandler_t,
        );
    }
}

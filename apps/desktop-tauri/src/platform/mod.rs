//! Per-OS seams (Windows port, 0.2).
//!
//! The crate was written Linux/X11-only: GDK forced to `x11`, geometry pinned
//! through GTK, work area read from `_NET_WORKAREA`, hotkey grabbed with
//! `XGrabKey` or the XDG portal. None of those primitives exist on Windows, and
//! they do not have drop-in equivalents with the same threading model, so the
//! port does not use `dyn Trait` here: each capability is **one name with two
//! implementations**, chosen at compile time by `#[cfg]`.
//!
//! - the `unix` implementation is the code this crate already had, delegated to
//!   unchanged (behaviour on Linux must stay byte-identical through the refactor),
//! - the `windows` implementation is either real Win32 (units U2/U3) or an
//!   honest [`Availability::Unavailable`] (decision D4): a capability this port
//!   deliberately does not implement. Never a fake success and never a silent
//!   retry — callers degrade the same way they already do for a missing hotkey
//!   backend.
//!
//! Units land one capability at a time; each one is verified by the Linux suite
//! (no behaviour change) and, from U1e on, by `cargo xwin check
//! --target x86_64-pc-windows-msvc` inside `packaging/windows/xbuild.sh`.

/// One OS-bound capability, as reported to the caller and to the status line.
///
/// On a Linux build only `Provided` is ever constructed (the `Unavailable` arm
/// lives in the `#[cfg(windows)]` implementation), so the variant is reported as
/// dead here while it is very much alive in the Windows compile. The allowance
/// is scoped to the non-Windows build, never to the type.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Availability {
    /// The platform layer compiled into this binary serves the capability.
    Provided,
    /// Not implemented on this OS in this port. The `&'static str` says which
    /// primitive is missing, so a human reading the log learns why, not just that.
    Unavailable(&'static str),
}

impl Availability {
    pub fn is_provided(self) -> bool {
        matches!(self, Self::Provided)
    }

    /// The reason a capability is missing, `None` when it is served.
    pub fn missing_reason(self) -> Option<&'static str> {
        match self {
            Self::Provided => None,
            Self::Unavailable(reason) => Some(reason),
        }
    }
}

pub(crate) mod audit;
pub(crate) mod fs;
pub(crate) mod signals;

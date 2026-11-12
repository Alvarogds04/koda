//! Linux (S8): which backend captures, in which order.
//!
//! 1. GNOME Wayland through Koda's own GNOME Shell extension (`gnome`): picks the window from the
//!    shell's focus history and paints it from inside the compositor, covered or not.
//! 2. X11 (`x11`): the existing backend, used when the session is really X11 or when the target
//!    itself came from X11. Under Wayland `$DISPLAY` is only XWayland, which sees nothing but
//!    XWayland windows, so a Wayland session never silently becomes an X11 one.
//! 3. The system screenshot portal (`portal`, `interactive=true`): the human picks the window in
//!    the desktop's own dialog. This is the fallback when the extension is not there at all.
//!
//! The order is per pick, and the target remembers where it came from, so a window picked by one
//! backend is always captured by that same backend.
use super::image;
use super::mcp::{CaptureError, Desktop, Shot, Target};
use super::{gnome, portal, x11};
use std::path::PathBuf;
use std::sync::Mutex;

/// Which backend a target (and therefore its capture) belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Extension,
    X11,
    Portal,
}

/// A real X11 session: an X server with no Wayland compositor in front of it. Returns `false` when
/// there is no display to capture on, even if the session says X11.
pub fn x11_session(session_type: Option<&str>, wayland_display: Option<&str>, display: Option<&str>) -> bool {
    match session_type {
        // A Wayland session always exports WAYLAND_DISPLAY, and `$DISPLAY` there is XWayland, which
        // sees nothing but XWayland windows: capturing through it would silently miss the window the
        // human is looking at, so the session type is believed before the display.
        Some("wayland") => false,
        Some("x11") => display.is_some(),
        _ => display.is_some() && wayland_display.is_none(),
    }
}

/// The Linux desktop: the three backends, tried in order, over the session bus and the display of
/// this machine (or of the private ones a test hands over).
pub struct LinuxDesktop {
    bus_address: Option<String>,
    display: Option<String>,
    runtime_dir: Option<String>,
    session_type: Option<String>,
    wayland_display: Option<String>,
    /// The target Koda picked and the backend that picked it: a target is captured where it came from.
    last: Mutex<Option<(Target, Source)>>,
}

impl LinuxDesktop {
    /// The real desktop: the user's own session bus, display and runtime directory.
    pub fn new() -> Self {
        LinuxDesktop {
            bus_address: None,
            display: std::env::var("DISPLAY").ok(),
            runtime_dir: std::env::var("XDG_RUNTIME_DIR").ok(),
            session_type: std::env::var("XDG_SESSION_TYPE").ok(),
            wayland_display: std::env::var("WAYLAND_DISPLAY").ok(),
            last: Mutex::new(None),
        }
    }

    /// A desktop with the environment fixed by the caller: a private bus, a private display, a
    /// private runtime directory (tests, and any future headless run).
    pub fn fixed(bus_address: Option<&str>, display: Option<&str>, runtime_dir: Option<&str>, session_type: Option<&str>) -> Self {
        LinuxDesktop {
            bus_address: bus_address.map(str::to_owned),
            display: display.map(str::to_owned),
            runtime_dir: runtime_dir.map(str::to_owned),
            session_type: session_type.map(str::to_owned),
            wayland_display: (session_type == Some("wayland")).then(|| "wayland-0".to_string()),
            last: Mutex::new(None),
        }
    }

    fn real_x11(&self) -> bool {
        x11_session(self.session_type.as_deref(), self.wayland_display.as_deref(), self.display.as_deref())
    }

    fn remember(&self, target: &Target, source: Source) {
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = Some((target.clone(), source));
    }

    /// Which backend a target belongs to: the one that picked it, or the best one this session has.
    pub fn source(&self, target: &Target) -> Source {
        if let Some((remembered, source)) = self.last.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            if remembered == target {
                return *source;
            }
        }
        if gnome::available(self.bus_address.as_deref()) {
            Source::Extension
        } else if self.real_x11() {
            Source::X11
        } else {
            Source::Portal
        }
    }

    fn capture_dir(&self) -> Result<PathBuf, CaptureError> {
        gnome::private_dir(self.runtime_dir.as_deref())
    }
}

impl Default for LinuxDesktop {
    fn default() -> Self {
        Self::new()
    }
}

/// The window the human was just looking at, from the best backend this session has.
///
/// An extension that answers «no window» is authoritative (it can see every window): that is
/// `NoWindow`, not a reason to ask the human to pick one. An extension that is absent, too old or
/// silent is not: then X11 (a real X11 session) or the system picker takes over.
impl Desktop for LinuxDesktop {
    fn pick_target(&self) -> Result<Target, CaptureError> {
        match gnome::pick(self.bus_address.as_deref()) {
            Ok(target) => {
                self.remember(&target, Source::Extension);
                return Ok(target);
            }
            Err(CaptureError::NoWindow) => {
                if self.real_x11() {
                    if let Ok(target) = x11::pick(self.display.as_deref()) {
                        self.remember(&target, Source::X11);
                        return Ok(target);
                    }
                }
                return Err(CaptureError::NoWindow);
            }
            Err(_) => {} // absent, too old or silent: the next backend
        }
        if self.real_x11() {
            return match x11::pick(self.display.as_deref()) {
                Ok(target) => {
                    self.remember(&target, Source::X11);
                    Ok(target)
                }
                Err(error) => Err(error),
            };
        }
        // Wayland (or a session we cannot see) without the extension: only the human knows which
        // window they mean, so the target is left open and the portal asks them.
        let target = Target { app_id: String::new(), app: String::new(), title: String::new(), handle: 0 };
        self.remember(&target, Source::Portal);
        Ok(target)
    }

    fn capture(&self, target: &Target) -> Result<Shot, CaptureError> {
        let raw = match self.source(target) {
            Source::Extension => gnome::capture(self.bus_address.as_deref(), &self.capture_dir()?, target.handle)?,
            Source::X11 => x11::capture(self.display.as_deref(), target.handle)?,
            Source::Portal => portal::capture(self.bus_address.as_deref())?,
        };
        let (png, width, height) = image::encode_png(&raw).ok_or_else(|| CaptureError::Failed("the window came back with no pixels".into()))?;
        Ok(Shot { png, width, height })
    }
}

#[cfg(test)]
#[path = "linux_tests.rs"]
mod tests;

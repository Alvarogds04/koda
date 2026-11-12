//! Linux (S8): which backend captures, in which order.
//!
//! 1. GNOME Wayland through Koda's own GNOME Shell extension (`gnome`): picks the window from the
//!    shell's focus history and paints it from inside the compositor, covered or not.
//! 2. X11 (`x11`): the existing backend, used when the session is really X11 or when the target
//!    itself came from X11. Under Wayland `$DISPLAY` is only XWayland, which sees nothing but
//!    XWayland windows, so a Wayland session never silently becomes an X11 one.
//!
//! A session with neither gets NO capture, on purpose. The system screenshot portal answers a
//! PICTURE, not a window identity, so nothing about it can be vetted against the refusal list (Koda
//! itself, the settings and login dialogs, the password managers): Koda refuses an unidentified
//! window, the same way Gentle Dot refuses `UNKNOWN_TARGET`, and says what is missing (turn on Koda's
//! GNOME extension, or use an X11 session). `portal.rs` still compiles and has its own tests, but
//! `LinuxDesktop` no longer reaches it: nobody may be invited to pick a window Koda then refuses.
//!
//! The order is per pick, and the target remembers where it came from, so a window picked by one
//! backend is always captured by that same backend.
use super::image;
use super::mcp::{CaptureError, Desktop, Shot, Target};
use super::{gnome, x11};
use std::path::PathBuf;
use std::sync::Mutex;

/// What Koda says when no backend can name the window: the portal would answer a picture with no app
/// identity, so the window is refused instead of captured.
pub const NO_IDENTITY: &str = "Koda cannot tell which app a window belongs to without its GNOME extension, so it will not capture it. Turn on Koda's GNOME extension (log out and in once) or use an X11 session.";

/// Which backend a target (and therefore its capture) belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Extension,
    X11,
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

/// The Linux desktop: the two backends, tried in order, over the session bus and the display of this
/// machine (or of the private ones a test hands over).
pub struct LinuxDesktop {
    bus_address: Option<String>,
    display: Option<String>,
    runtime_dir: Option<String>,
    session_type: Option<String>,
    wayland_display: Option<String>,
    /// This launch's token for Koda's own GNOME extension: `gnome::launch_token` in a real run.
    token: String,
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
            token: gnome::launch_token(),
            last: Mutex::new(None),
        }
    }

    /// A desktop with the environment fixed by the caller: a private bus, a private display, a
    /// private runtime directory (tests, and any future headless run). The extension token is the
    /// fixed test one: `with_token` is how a test says which launch it is.
    pub fn fixed(bus_address: Option<&str>, display: Option<&str>, runtime_dir: Option<&str>, session_type: Option<&str>) -> Self {
        LinuxDesktop {
            bus_address: bus_address.map(str::to_owned),
            display: display.map(str::to_owned),
            runtime_dir: runtime_dir.map(str::to_owned),
            session_type: session_type.map(str::to_owned),
            wayland_display: (session_type == Some("wayland")).then(|| "wayland-0".to_string()),
            token: gnome::TEST_TOKEN.to_string(),
            last: Mutex::new(None),
        }
    }

    /// This desktop's launch token, in place of the fixed test one: a test can then act as another
    /// Koda (or as any other program) and check that the extension refuses it.
    pub fn with_token(mut self, token: &str) -> Self {
        self.token = token.to_owned();
        self
    }

    fn real_x11(&self) -> bool {
        x11_session(self.session_type.as_deref(), self.wayland_display.as_deref(), self.display.as_deref())
    }

    fn remember(&self, target: &Target, source: Source) {
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = Some((target.clone(), source));
    }

    /// Which backend a target belongs to: the one that picked it, or the only one this session has.
    /// A session with neither the extension nor X11 has no way to name a window, and says so.
    pub fn source(&self, target: &Target) -> Result<Source, CaptureError> {
        if let Some((remembered, source)) = self.last.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            if remembered == target {
                return Ok(*source);
            }
        }
        if gnome::available(self.bus_address.as_deref()) {
            Ok(Source::Extension)
        } else if self.real_x11() {
            Ok(Source::X11)
        } else {
            Err(CaptureError::Unsupported(NO_IDENTITY.to_string()))
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
/// silent is not: then X11 (a real X11 session) takes over. With neither, Koda refuses: the system
/// picker would answer a picture with no app identity, and an unidentified window is never captured.
impl Desktop for LinuxDesktop {
    fn pick_target(&self) -> Result<Target, CaptureError> {
        match gnome::pick(self.bus_address.as_deref(), &self.token) {
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
            // The extension is there and refused us by name: another program holds it. Say so; the
            // next backend would hide the real reason behind a generic «turn on the extension».
            Err(CaptureError::Unsupported(why)) if why == gnome::NOT_ALLOWED => return Err(CaptureError::Unsupported(why)),
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
        // Wayland (or a session we cannot see) without the extension: the system picker would hand
        // back a picture with no app identity, so there is nothing Koda is allowed to capture.
        Err(CaptureError::Unsupported(NO_IDENTITY.to_string()))
    }

    fn capture(&self, target: &Target) -> Result<Shot, CaptureError> {
        let raw = match self.source(target)? {
            Source::Extension => gnome::capture(self.bus_address.as_deref(), &self.capture_dir()?, target.handle, &self.token)?,
            Source::X11 => x11::capture(self.display.as_deref(), target.handle)?,
        };
        let (png, width, height) = image::encode_png(&raw).ok_or_else(|| CaptureError::Failed("the window came back with no pixels".into()))?;
        Ok(Shot { png, width, height })
    }
}

#[cfg(test)]
#[path = "linux_tests.rs"]
mod tests;

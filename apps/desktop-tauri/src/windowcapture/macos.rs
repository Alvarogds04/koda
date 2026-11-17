//! macOS backend (S1, S7): ScreenCaptureKit, macOS 14 or newer, ONE window by `CGWindowID`.
//!
//! Adapted from Gentle Dot `apps/desktop/src-tauri/src/computer/macos.rs`,
//! Copyright (c) Gentleman Programming, MIT (see THIRD-PARTY-NOTICES in apps/desktop-daemon).
//! Gentle Dot photographs the display under the pointer, excluding its own windows;
//! Koda photographs the single window the user was looking at:
//! `SCContentFilter::initWithDesktopIndependentWindow` over the `SCWindow` whose `windowID` is the
//! chosen `CGWindowID`, so a covered window still gives its own pixels and the island is never in
//! the picture.
//!
//! Screen Recording is a system permission and macOS never asks for it by itself: the first capture
//! without it calls `CGRequestScreenCaptureAccess` (which shows the system prompt once per app) and
//! answers `CaptureError::PermissionMissing`, whose message in `mcp.rs` tells the user where to turn
//! it on. Builds are unsigned, so every Koda update loses the grant and asks again: that is S2.
//!
//! The window list is CoreGraphics' (`CGWindowListCopyWindowInfo`, the same reading `contextwin`
//! does), and it is used only to CHOOSE; the capture itself is ScreenCaptureKit's by id.
//! `CGWindowListCreateImage` is deliberately not used: Apple deprecated it in macOS 14 and marked it
//! obsolete in 15.

use super::image::{self, Raw};
use super::mcp::{CaptureError, Desktop, Shot, Target};
use block2::RcBlock;
use objc2::AnyThread;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::access::ScreenCaptureAccess;
use core_graphics::window::{
    copy_window_info, kCGNullWindowID, kCGWindowLayer, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
    kCGWindowName, kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID,
};
use objc2::rc::Retained;
use objc2::available;
use objc2_app_kit::NSRunningApplication;
use objc2_core_foundation::CFRetained;
use objc2_core_graphics::{CGDataProvider, CGImage};
use objc2_foundation::NSError;
use objc2_screen_capture_kit::{SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration};
use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::Duration;

/// A screenshot that does not arrive in this time is a failure, never a hang.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
/// `kCVPixelFormatType_32BGRA`: what `SCScreenshotManager` hands back and `image::Raw` reads.
const PIXEL_FORMAT_BGRA: u32 = u32::from_be_bytes(*b"BGRA");

/// What to tell the user on a macOS older than ScreenCaptureKit's window capture (S2).
pub const TOO_OLD: &str = "capturing a window needs macOS 14 (Sonoma) or later";

/// Values crossing from a ScreenCaptureKit completion handler to the waiting thread. The objects
/// are immutable snapshots, used by one thread at a time.
struct Handoff<T>(T);
unsafe impl<T> Send for Handoff<T> {}

/// A window as CoreGraphics lists it, topmost first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacWindow {
    /// The `CGWindowID` a capture is taken by.
    pub id: u32,
    pub pid: i32,
    pub app: String,
    pub bundle_id: String,
    pub title: String,
}

fn text(d: &CFDictionary<CFString, CFType>, key: CFStringRef) -> Option<String> {
    // SAFETY: the CG key constants are valid static CFStrings.
    let key = unsafe { CFString::wrap_under_get_rule(key) };
    d.find(&key)?.downcast::<CFString>().map(|s| s.to_string())
}

fn number(d: &CFDictionary<CFString, CFType>, key: CFStringRef) -> Option<i64> {
    // SAFETY: as above.
    let key = unsafe { CFString::wrap_under_get_rule(key) };
    d.find(&key)?.downcast::<CFNumber>().and_then(|n| n.to_i64())
}

/// The bundle id of a running app, through Launch Services. Empty for a process that is not an app
/// (an agent) or one macOS will not describe; the app name still carries the identity then.
fn bundle_id_of(pid: i32) -> String {
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .and_then(|app| app.bundleIdentifier())
        .map(|id| id.to_string())
        .unwrap_or_default()
}

/// Every on-screen window on the normal layer (0), topmost first, as CoreGraphics reports it.
/// Overlays, the menu bar, the Dock and Koda's own windows are left to `pick`.
pub fn windows() -> Result<Vec<MacWindow>, CaptureError> {
    let list = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    )
    .ok_or_else(|| CaptureError::Failed("the window list could not be read".into()))?;
    let mut rows = Vec::new();
    for item in list.iter() {
        // SAFETY: CGWindowListCopyWindowInfo returns an array of CFDictionary.
        let d: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };
        // Layer 0 = ordinary app windows (menu bar, Dock and overlays live on other layers).
        // SAFETY (all four keys): static CoreGraphics constants.
        if number(&d, unsafe { kCGWindowLayer }) != Some(0) {
            continue;
        }
        let Some(app) = text(&d, unsafe { kCGWindowOwnerName }) else { continue };
        let pid = number(&d, unsafe { kCGWindowOwnerPID }).unwrap_or(0) as i32;
        let id = number(&d, unsafe { kCGWindowNumber }).unwrap_or(0) as u32;
        // The title is only filled in once the human has granted Screen Recording; the app name and
        // the window id need no permission, so the choice works either way.
        let title = text(&d, unsafe { kCGWindowName }).unwrap_or_default();
        rows.push(MacWindow { id, pid, app: app.trim().to_string(), bundle_id: bundle_id_of(pid), title });
    }
    Ok(rows)
}

/// The topmost window a capture may take: not Koda's own process, a real window id, and an app name
/// (without one there is nothing to report and nothing to refuse by).
pub fn pick(own_pid: i32, rows: &[MacWindow]) -> Result<Target, CaptureError> {
    let row = rows
        .iter()
        .find(|row| row.id != 0 && row.pid != own_pid && !row.app.trim().is_empty())
        .ok_or(CaptureError::NoWindow)?;
    // The refusal list (S5) matches bundle ids on macOS, so the id is the bundle id when there is
    // one and the app name otherwise.
    let app_id = if row.bundle_id.trim().is_empty() { row.app.clone() } else { row.bundle_id.clone() };
    Ok(Target { app_id, app: row.app.clone(), title: row.title.clone(), handle: row.id as u64 })
}

/// Whether Screen Recording is granted (S2). When it is not, the system prompt is asked for once (it
/// reappears after every unsigned update) and the capture fails with a message that says what to do.
fn require_permission() -> Result<(), CaptureError> {
    let access = ScreenCaptureAccess;
    if access.preflight() {
        return Ok(());
    }
    // Returns the same answer as preflight; the prompt is the point of the call.
    let _ = access.request();
    Err(CaptureError::PermissionMissing)
}

fn shareable_content() -> Result<Retained<SCShareableContent>, CaptureError> {
    let (sender, receiver) = mpsc::channel();
    let handler = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        // SAFETY: ScreenCaptureKit passes valid (or null) objects to the handler.
        let content = unsafe { Retained::retain(content) };
        let error = unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string());
        let found = content.ok_or_else(|| error.unwrap_or_else(|| "no shareable content".into()));
        let _ = sender.send(Handoff(found));
    });
    // SAFETY: the handler matches the documented signature and outlives the call.
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };
    let Handoff(found) = receiver.recv_timeout(CAPTURE_TIMEOUT).map_err(|_| {
        CaptureError::Failed("the screen capture timed out".into())
    })?;
    found.map_err(|why| CaptureError::Failed(format!("the screen content cannot be listed: {why}")))
}

fn capture_image(
    filter: &SCContentFilter,
    config: &SCStreamConfiguration,
) -> Result<CFRetained<CGImage>, CaptureError> {
    let (sender, receiver) = mpsc::channel();
    let handler = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        // SAFETY: the image is valid for the handler's duration; retaining keeps it alive.
        let image = NonNull::new(image).map(|image| unsafe { CFRetained::retain(image) });
        let error = unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string());
        let found = image.ok_or_else(|| error.unwrap_or_else(|| "no image".into()));
        let _ = sender.send(Handoff(found));
    });
    // SAFETY: the handler matches the documented signature and outlives the call.
    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(filter, config, Some(&handler))
    };
    let Handoff(found) = receiver.recv_timeout(CAPTURE_TIMEOUT).map_err(|_| {
        CaptureError::Failed("the window capture timed out".into())
    })?;
    found.map_err(|why| CaptureError::Failed(format!("the window could not be captured: {why}")))
}

/// BGRA rows with `bytes_per_row` stride, packed into contiguous rows for `image::Raw`. `None` when
/// the buffer is shorter than the image.
pub fn compact(bytes: &[u8], width: u32, height: u32, bytes_per_row: usize) -> Option<Vec<u8>> {
    let (width, height) = (width as usize, height as usize);
    let row = width * 4;
    if width == 0 || height == 0 || bytes_per_row < row {
        return None;
    }
    if bytes.len() < bytes_per_row * (height - 1) + row {
        return None;
    }
    let mut packed = Vec::with_capacity(row * height);
    for y in 0..height {
        let start = y * bytes_per_row;
        packed.extend_from_slice(&bytes[start..start + row]);
    }
    Some(packed)
}

/// The captured image as `image::Raw`, dropping the row padding CoreGraphics adds.
fn raw_of(image: &CGImage) -> Result<Raw, CaptureError> {
    if CGImage::bits_per_pixel(Some(image)) != 32 {
        return Err(CaptureError::Failed("the capture is not 32-bit BGRA".into()));
    }
    let (width, height) = (CGImage::width(Some(image)) as u32, CGImage::height(Some(image)) as u32);
    let bytes_per_row = CGImage::bytes_per_row(Some(image));
    let provider = CGImage::data_provider(Some(image))
        .ok_or_else(|| CaptureError::Failed("the capture has no pixels".into()))?;
    let data = CGDataProvider::data(Some(&provider))
        .ok_or_else(|| CaptureError::Failed("the capture's pixels cannot be read".into()))?;
    let data = data.to_vec();
    let packed = compact(&data, width, height, bytes_per_row)
        .ok_or_else(|| CaptureError::Failed("the capture's pixels are incomplete".into()))?;
    Ok(Raw { width, height, bgra: true, data: packed })
}

/// The window's pixels by `CGWindowID`.
pub fn capture_window(handle: u64) -> Result<Raw, CaptureError> {
    // A malformed call is refused before anything reaches the OS: no permission prompt for an id
    // that cannot be a window.
    if handle == 0 || handle > u32::MAX as u64 {
        return Err(CaptureError::Failed("the window id is not a CGWindowID".into()));
    }
    require_permission()?;
    if !available!(macos = 14.0) {
        return Err(CaptureError::Unsupported(TOO_OLD.into()));
    }
    let content = shareable_content()?;
    let id = handle as u32;
    let windows = unsafe { content.windows() }.to_vec();
    let window = windows
        .iter()
        .find(|window| unsafe { window.windowID() } == id)
        .ok_or_else(|| CaptureError::Failed("the window is gone".into()))?;
    // One window, on its own: nothing of the desktop behind it and nothing of Koda's.
    // SAFETY: `window` is an SCWindow of this snapshot.
    let filter = unsafe { SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), window) };
    // The window's own size, capped: the model does not need a 4K picture, and neither does the wire.
    let frame = unsafe { window.frame() };
    let (width, height) =
        image::capped_size(frame.size.width.max(0.0) as u32, frame.size.height.max(0.0) as u32);
    if width == 0 || height == 0 {
        return Err(CaptureError::Failed("the window has no size".into()));
    }
    let config = unsafe { SCStreamConfiguration::new() };
    // SAFETY: plain property writes on a configuration this thread owns.
    unsafe {
        config.setWidth(width as usize);
        config.setHeight(height as usize);
        config.setPixelFormat(PIXEL_FORMAT_BGRA);
        // Koda photographs the window, not the pointer: the cursor is not part of the window's content.
        config.setShowsCursor(false);
    }
    let image = capture_image(&filter, &config)?;
    raw_of(&image)
}

/// The macOS desktop: window choice from CoreGraphics, pixels from ScreenCaptureKit.
pub struct MacDesktop {
    own_pid: i32,
}

impl MacDesktop {
    pub fn new() -> Self {
        MacDesktop { own_pid: std::process::id() as i32 }
    }
}

impl Default for MacDesktop {
    fn default() -> Self {
        Self::new()
    }
}

impl Desktop for MacDesktop {
    fn pick_target(&self) -> Result<Target, CaptureError> {
        pick(self.own_pid, &windows()?)
    }

    fn capture(&self, target: &Target) -> Result<Shot, CaptureError> {
        let raw = capture_window(target.handle)?;
        let (png, width, height) = image::encode_png(&raw)
            .ok_or_else(|| CaptureError::Failed("the window's pixels could not be saved".into()))?;
        Ok(Shot { png, width, height })
    }
}

#[cfg(test)]
#[path = "macos_tests.rs"]
mod tests;

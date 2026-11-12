//! Windows backend (S1, S5): choose the topmost window that is not Koda's, capture it by `HWND`.
//!
//! Adapted from Gentle Dot `apps/desktop/src-tauri/src/computer/win.rs`,
//! Copyright (c) Gentleman Programming, MIT (see THIRD-PARTY-NOTICES in apps/desktop-daemon).
//! Gentle Dot photographs the whole monitor under the pointer; Koda takes the ONE window the user
//! was looking at, by handle, so the island is never in the picture and no permission is asked.
//!
//! `PrintWindow(PW_RENDERFULLCONTENT)` hands back the window's own pixels even when it is covered.
//! Some windows (GPU-composited ones, some Store apps) answer with a black frame: the pixels are then
//! copied off the screen (`BitBlt` over `DWMWA_EXTENDED_FRAME_BOUNDS`, Windows 10 2004 or newer),
//! with Koda's own windows kept out of the copy (`WDA_EXCLUDEFROMCAPTURE`) for as long as the copy
//! takes, exactly as Gentle Dot keeps its windows out of a screenshot.
//!
//! A window's identity is its process: the executable's file stem, so the S5 refusal list matches
//! the same stems Gentle Dot matches (`bitwarden`, `keepass`, `consent`). A process Windows will not
//! describe (elevated, protected) is `blocklist::UNIDENTIFIED`, which is also refused.

use super::blocklist::UNIDENTIFIED;
use super::image::{self, Raw};
use super::mcp::{CaptureError, Desktop, Shot, Target};
use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, SRCCOPY,
};
use windows_sys::Win32::Storage::Xps::PrintWindow;
use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowDisplayAffinity, GetWindowLongW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, SetWindowDisplayAffinity, GWL_EXSTYLE, WDA_EXCLUDEFROMCAPTURE, WS_EX_TOOLWINDOW,
};

/// `PrintWindow`'s "the app paints its own content" flag. windows-sys 0.61.2 declares only
/// `PW_CLIENTONLY`, so the value comes from `winuser.h` (`PW_RENDERFULLCONTENT`).
const PW_RENDERFULLCONTENT: u32 = 0x0000_0002;

/// One top-level window as `EnumWindows` reports it, in z-order (topmost first).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub handle: u64,
    pub pid: u32,
    pub app: String,
    pub title: String,
    pub visible: bool,
    pub minimized: bool,
    pub cloaked: bool,
    pub tool: bool,
}

/// The app name of a window: the process's executable stem, or `blocklist::UNIDENTIFIED` when the
/// process cannot be queried, so S5 refuses it instead of treating it as a harmless app.
pub fn app_of(stem: &str) -> String {
    if stem.trim().is_empty() { UNIDENTIFIED.to_string() } else { stem.trim().to_string() }
}

/// Whether a capture may take this window: the visible, restored, un-cloaked window of another
/// process that is not a tool window (tray, IME, invisible helper). Cloaked is what Windows calls a
/// window of another virtual desktop, or one of the suspended Store apps: it has no pixels to show.
pub fn eligible(row: &Row, own_pid: u32) -> bool {
    row.handle != 0 && row.pid != 0 && row.pid != own_pid && row.visible && !row.minimized && !row.cloaked && !row.tool
}

/// The topmost window a capture may take, or `NoWindow` when every window is Koda's or unusable.
pub fn pick(own_pid: u32, rows: &[Row]) -> Result<Target, CaptureError> {
    let row = rows.iter().find(|row| eligible(row, own_pid)).ok_or(CaptureError::NoWindow)?;
    let app = app_of(&row.app);
    Ok(Target { app_id: app.clone(), app, title: row.title.clone(), handle: row.handle })
}

/// True when every pixel is black, which is what a composited window answers `PrintWindow` with.
pub fn looks_black(bgra: &[u8]) -> bool {
    !bgra.is_empty() && bgra.chunks_exact(4).all(|p| p[0] == 0 && p[1] == 0 && p[2] == 0)
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn title_of(hwnd: HWND) -> String {
    let mut buffer = [0u16; 512];
    // SAFETY: the buffer outlives the call and its length is passed.
    let length = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

/// The executable's file stem ("bitwarden" for `C:\...\Bitwarden.exe`), or empty when Windows will
/// not describe the process.
fn stem_of(pid: u32) -> String {
    // SAFETY: a failed OpenProcess (null) is handled; the handle is closed on every path.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return String::new();
        }
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
        CloseHandle(process);
        if ok == 0 {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    }
}

unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> i32 {
    // SAFETY: lparam is the `&mut Vec<Row>` passed by `rows` for this synchronous call.
    let out = &mut *(lparam as *mut Vec<Row>);
    // Everything is reported and `eligible` decides: the rule stays pure and is tested as such.
    let mut pid = 0u32;
    let mut cloaked_flag = 0u32;
    // SAFETY: plain queries on a window handle; a vanished window just reads as hidden.
    let (cloaked, visible, minimized, tool) = unsafe {
        GetWindowThreadProcessId(hwnd, &mut pid);
        // A cloaked window belongs to another virtual desktop, or to a suspended Store app: it has
        // no pixels to show.
        let cloaked = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED as u32, &mut cloaked_flag as *mut u32 as *mut _, 4) == 0
            && cloaked_flag != 0;
        (
            cloaked,
            IsWindowVisible(hwnd) != 0,
            IsIconic(hwnd) != 0,
            (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW != 0,
        )
    };
    let row = Row {
        handle: hwnd as usize as u64,
        pid,
        app: stem_of(pid),
        title: title_of(hwnd),
        visible,
        minimized,
        cloaked,
        tool,
    };
    out.push(row);
    1
}

/// Every top-level window, topmost first, or why Windows did not list them.
pub fn rows() -> Result<Vec<Row>, CaptureError> {
    let mut out: Vec<Row> = Vec::new();
    // SAFETY: EnumWindows is synchronous and `out` outlives it. It never stops early, so 0 is a
    // failure, and a list that may be missing windows is no list.
    let ok = unsafe { EnumWindows(Some(each), &mut out as *mut Vec<Row> as LPARAM) };
    if ok == 0 {
        return Err(CaptureError::Failed("Windows did not list its windows".into()));
    }
    Ok(out)
}

/// The GDI objects of one copy, released in reverse whatever happens.
struct Canvas {
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut core::ffi::c_void,
    width: u32,
    height: u32,
}

impl Canvas {
    /// A top-down 32-bit BGRA bitmap of `width × height`, selected into a memory context.
    fn new(width: u32, height: u32) -> Result<Canvas, CaptureError> {
        let failed = |why: &str| CaptureError::Failed(why.to_string());
        if width == 0 || height == 0 {
            return Err(failed("the window has no size"));
        }
        if width > 8_192 || height > 8_192 {
            return Err(failed("the window is too large to copy"));
        }
        // SAFETY: GDI calls with valid arguments; every handle is checked and released by Drop.
        unsafe {
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() {
                return Err(failed("the screen could not be read"));
            }
            let mut canvas = Canvas {
                screen,
                memory: std::ptr::null_mut(),
                bitmap: std::ptr::null_mut(),
                previous: std::ptr::null_mut(),
                bits: std::ptr::null_mut(),
                width,
                height,
            };
            canvas.memory = CreateCompatibleDC(screen);
            if canvas.memory.is_null() {
                return Err(failed("the copy could not be prepared"));
            }
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                // Negative: rows top to bottom, as `image::Raw` reads them.
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            };
            canvas.bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &mut canvas.bits, std::ptr::null_mut(), 0);
            if canvas.bitmap.is_null() || canvas.bits.is_null() {
                return Err(failed("the copy bitmap could not be created"));
            }
            let previous = SelectObject(canvas.memory, canvas.bitmap);
            // HGDI_ERROR is -1; without the bitmap selected the pixels read would not be the copy.
            if previous.is_null() || previous as isize == -1 {
                return Err(failed("the copy bitmap could not be selected"));
            }
            canvas.previous = previous;
            Ok(canvas)
        }
    }

    /// The pixels as BGRA rows, top row first.
    fn pixels(&self) -> Vec<u8> {
        // SAFETY: the DIB holds exactly width × height 32-bit pixels for as long as it is selected.
        unsafe { std::slice::from_raw_parts(self.bits as *const u8, self.width as usize * self.height as usize * 4) }
            .to_vec()
    }
}

impl Drop for Canvas {
    fn drop(&mut self) {
        // SAFETY: each handle was created above and is released once.
        unsafe {
            if !self.previous.is_null() {
                SelectObject(self.memory, self.previous);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            if !self.memory.is_null() {
                DeleteDC(self.memory);
            }
            if !self.screen.is_null() {
                ReleaseDC(std::ptr::null_mut(), self.screen);
            }
        }
    }
}

/// The window's rectangle on the screen, frame included (`DWMWA_EXTENDED_FRAME_BOUNDS`, which unlike
/// `GetWindowRect` has no invisible resize border).
fn screen_bounds(hwnd: HWND) -> Result<(i32, i32, i32, i32), CaptureError> {
    let mut rect: RECT = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    // SAFETY: `rect` is a valid out-pointer of the documented size.
    let by_dwm = unsafe {
        DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS as u32, &mut rect as *mut RECT as *mut _, 16)
    };
    if by_dwm < 0 {
        // SAFETY: as above; an old Windows without the DWM attribute still has a rectangle.
        if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
            return Err(CaptureError::Failed("the window has no rectangle".into()));
        }
    }
    let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
    if width <= 0 || height <= 0 {
        return Err(CaptureError::Failed("the window has no size".into()));
    }
    Ok((rect.left, rect.top, width, height))
}

/// Koda's own visible windows, kept out of every screen copy while the guard lives.
struct Excluded(Vec<(HWND, u32)>);

impl Drop for Excluded {
    fn drop(&mut self) {
        for &(hwnd, previous) in &self.0 {
            // SAFETY: restoring the affinity this capture read from Koda's own window.
            if unsafe { SetWindowDisplayAffinity(hwnd, previous) } == 0 {
                eprintln!("koda: a Koda window may stay out of the user's own screenshots");
            }
        }
    }
}

fn own_windows() -> Vec<HWND> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> i32 {
        // SAFETY: lparam is the `&mut Vec<HWND>` passed below, alive for the whole enumeration.
        let out = &mut *(lparam as *mut Vec<HWND>);
        out.push(hwnd);
        1
    }
    let mut handles: Vec<HWND> = Vec::new();
    // SAFETY: the callback only appends to `handles`, which outlives the call.
    unsafe { EnumWindows(Some(collect), &mut handles as *mut Vec<HWND> as LPARAM) };
    handles
}

/// Takes every visible window of Koda's out of screen copies, remembering what to restore.
fn exclude_own_windows() -> Excluded {
    let own = std::process::id();
    let mut changed = Vec::new();
    for hwnd in own_windows() {
        let mut pid = 0u32;
        let mut previous = 0u32;
        // SAFETY: plain queries and one change on Koda's own window.
        unsafe {
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid != own || IsWindowVisible(hwnd) == 0 {
                continue;
            }
            if GetWindowDisplayAffinity(hwnd, &mut previous) == 0 || previous == WDA_EXCLUDEFROMCAPTURE {
                continue;
            }
            if SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) != 0 {
                changed.push((hwnd, previous));
            }
        }
    }
    Excluded(changed)
}

/// The window's own pixels through `PrintWindow`, or `None` when it answered with a black frame.
fn print_window(hwnd: HWND, width: u32, height: u32) -> Result<Option<Raw>, CaptureError> {
    let canvas = Canvas::new(width, height)?;
    // SAFETY: a valid window handle, a memory context with the bitmap selected, and a documented flag.
    let copied = unsafe { PrintWindow(hwnd, canvas.memory, PW_RENDERFULLCONTENT) };
    let pixels = canvas.pixels();
    // A composited window answers 0 or a black frame: the pixels decide, not the return value.
    if copied == 0 || looks_black(&pixels) {
        return Ok(None);
    }
    Ok(Some(Raw { width, height, bgra: true, data: pixels }))
}

/// The window's rectangle copied off the screen, without Koda's windows in it.
fn screen_copy(hwnd: HWND) -> Result<Raw, CaptureError> {
    let (left, top, width, height) = screen_bounds(hwnd)?;
    // Koda's own windows are out of the copy from before it starts until it ends.
    let _excluded = exclude_own_windows();
    let canvas = Canvas::new(width as u32, height as u32)?;
    // SAFETY: both contexts are valid and the bitmap holds `width × height` 32-bit pixels.
    let copied = unsafe {
        BitBlt(canvas.memory, 0, 0, width, height, canvas.screen, left, top, SRCCOPY | CAPTUREBLT)
    };
    if copied == 0 {
        return Err(CaptureError::Failed("the window could not be copied off the screen".into()));
    }
    Ok(Raw { width: width as u32, height: height as u32, bgra: true, data: canvas.pixels() })
}

/// The window's pixels: its own drawing first, and the screen behind it when that comes back black.
pub fn capture_window(handle: u64) -> Result<Raw, CaptureError> {
    if handle == 0 {
        return Err(CaptureError::Failed("the window handle is empty".into()));
    }
    let hwnd = handle as usize as HWND;
    let (_, _, width, height) = screen_bounds(hwnd)?;
    if let Some(raw) = print_window(hwnd, width as u32, height as u32)? {
        return Ok(raw);
    }
    screen_copy(hwnd)
}

/// The Windows desktop: window choice through `EnumWindows`, pixels through `PrintWindow`/`BitBlt`.
pub struct WinDesktop;

impl Desktop for WinDesktop {
    fn pick_target(&self) -> Result<Target, CaptureError> {
        pick(std::process::id(), &rows()?)
    }

    fn capture(&self, target: &Target) -> Result<Shot, CaptureError> {
        let raw = capture_window(target.handle)?;
        let (png, width, height) = image::encode_png(&raw)
            .ok_or_else(|| CaptureError::Failed("the window's pixels could not be saved".into()))?;
        Ok(Shot { png, width, height })
    }
}

#[cfg(test)]
#[path = "win_tests.rs"]
mod tests;

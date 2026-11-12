//! GNOME Wayland capture (S8) through Koda's OWN GNOME Shell extension, `org.abito.Context`.
//!
//! WHY an extension: on a Wayland session no client can read another window's pixels, and the
//! screencast portal needs `pipewire`/`ashpd`, which are not in the offline crate set. The extension
//! runs inside the Shell, so it paints ONE window actor into a PNG (covered windows included) and
//! hands Koda a path. The pixels never travel as a D-Bus array: a window is megabytes.
//!
//! PRIVATE FILE, NOT A PUBLIC ONE. The extension writes into `$XDG_RUNTIME_DIR/koda-capture/`
//! (0700, inside the user's own 0700 runtime directory) with a fresh random name created with
//! `Gio.FileCreateFlags.PRIVATE` (0600). This side validates what comes back before reading a
//! byte, and deletes the file as soon as the pixels are in memory: `read_private_png` refuses
//! anything that is not an absolute path, not a direct child of the private directory, not a
//! regular file owned by this user, or readable by group/other; it opens with `O_NOFOLLOW`, so a
//! symlink cannot redirect the read, and it caps the size before reading.
//!
//! TRUST BOUNDARY (a deliberate, documented limit): `org.abito.Context` lives on the user's
//! session bus, so ANY process running as this user can call `CaptureWindow`. What stands in the way
//! is a random token Koda makes fresh on every launch and keeps in memory only: `Register(token)`
//! binds it to the calling D-Bus unique name, and `PickWindow`/`CaptureWindow` refuse with
//! `org.abito.Context.NotAllowed` unless the call carries that exact token. No process name, no
//! `/proc` lookup and no unreadable command line counts as Koda any more: only the token does.
//! Whoever registers first holds the extension until its connection leaves the bus, so a foreign
//! registration is a denial of service (`NOT_ALLOWED`: restart Koda), never a way in. Beyond the
//! token, `CaptureWindow` takes only an opaque window id (never a title, a command or a rectangle),
//! captures nothing but that one window, writes nowhere except the private directory, and exposes
//! no way to move, resize or close anything. A same-user process that can bypass all of this can
//! already screenshot the session itself, which is the boundary every other Linux path has too.
use super::image::Raw;
use super::mcp::{CaptureError, Target};
use crate::contextwin::{BUS_NAME, INTERFACE, OBJECT_PATH};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use zbus::blocking::{Connection, Proxy};

/// The extension method that binds Koda's per-launch token to this connection.
pub const REGISTER_METHOD: &str = "Register";
/// The extension's own refusal: this caller's token is not the one bound to the extension.
pub const NOT_ALLOWED_ERROR: &str = "org.abito.Context.NotAllowed";
/// What the human is told when another program registered with the extension first.
pub const NOT_ALLOWED: &str = "another program holds Koda's GNOME extension; restart Koda";
/// A fixed token for `LinuxDesktop::fixed` (tests, and any headless run that fixes its environment).
/// It is published on purpose and it is NOT a launch token: a real Koda always uses the random one.
pub const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

static LAUNCH_TOKEN: OnceLock<String> = OnceLock::new();

/// The extension method that answers which window the human was just looking at.
pub const PICK_METHOD: &str = "PickWindow";
/// The extension method that paints one window and answers the path of the PNG.
pub const CAPTURE_METHOD: &str = "CaptureWindow";
/// The extension answers from its focus history; anything slower is treated as absent.
pub const PICK_DEADLINE: Duration = Duration::from_millis(1500);
/// Painting one window through the compositor is fast, but the shell may be busy.
pub const CAPTURE_DEADLINE: Duration = Duration::from_secs(30);
/// The directory under `$XDG_RUNTIME_DIR` the extension writes captures into.
pub const DIR_NAME: &str = "koda-capture";
/// A window PNG is a few hundred KiB; anything this large is not one.
pub const MAX_PNG_BYTES: u64 = 32 * 1024 * 1024;

const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

fn unusable(why: &str) -> CaptureError {
    // "Unsupported" here means «this backend cannot answer», which is what makes the caller try
    // the next one; it is not shown to the human unless every backend says it.
    CaptureError::Unsupported(why.to_string())
}

fn refuse(why: &str) -> CaptureError {
    CaptureError::Failed(format!("the extension handed back a capture Koda will not read: {why}"))
}

/// `$XDG_RUNTIME_DIR/koda-capture`: the only place a capture is ever allowed to come from.
/// A shared place (`/tmp`) or an empty answer is refused: a window is not left where other
/// people can read it.
pub fn private_dir(runtime_dir: Option<&str>) -> Result<PathBuf, CaptureError> {
    let dir = runtime_dir
        .map(str::to_owned)
        .or_else(|| std::env::var("XDG_RUNTIME_DIR").ok())
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    if dir.is_empty() {
        return Err(unusable("this session has no XDG_RUNTIME_DIR to keep a private capture in"));
    }
    let path = Path::new(&dir);
    // XDG_RUNTIME_DIR belongs to this user and is 0700; /tmp is shared, so a capture left there
    // could be read by anyone on the machine.
    if path == Path::new("/tmp") || path == std::env::temp_dir() {
        return Err(unusable("the private directory cannot live in the shared temporary directory"));
    }
    Ok(path.join(DIR_NAME))
}

/// Is this the start of a PNG? Cheap check before any decoder sees the bytes.
pub fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(PNG_MAGIC)
}

/// The bytes of the PNG the extension wrote, or why Koda will not read them. Every rule is about
/// the OPENED FILE (fstat on the descriptor), never about the path we were handed.
pub fn read_private_png(dir: &Path, path: &Path, max: u64) -> Result<Vec<u8>, CaptureError> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    if !path.is_absolute() {
        return Err(refuse("the path is not absolute"));
    }
    // A DIRECT child of the private directory: `..` never climbs out, and neither does a sibling.
    if path.parent() != Some(dir) {
        return Err(refuse("the path is outside the private directory"));
    }
    // O_NOFOLLOW: a symlink planted in place of the capture is an error, never followed.
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| refuse(&format!("it cannot be opened ({e})")))?;
    let meta = file.metadata().map_err(|e| refuse(&format!("it cannot be examined ({e})")))?;
    if !meta.file_type().is_file() {
        return Err(refuse("it is not a regular file"));
    }
    // SAFETY: geteuid takes no arguments and cannot fail.
    if meta.uid() != unsafe { libc::geteuid() } {
        return Err(refuse("it belongs to another user"));
    }
    if meta.mode() & 0o077 != 0 {
        return Err(refuse("other users can read it"));
    }
    if meta.len() == 0 {
        return Err(refuse("it is empty"));
    }
    if meta.len() > max {
        return Err(refuse("it is too large to be a window image"));
    }
    use std::io::Read as _;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    // One byte past the cap: a file that grew after the check is refused, never read whole.
    let read = file.by_ref().take(max + 1).read_to_end(&mut bytes).map_err(|e| refuse(&format!("it cannot be read ({e})")))?;
    if read as u64 > max {
        return Err(refuse("it is too large to be a window image"));
    }
    if !is_png(&bytes) {
        return Err(refuse("it is not a PNG"));
    }
    Ok(bytes)
}

/// A PNG from the compositor as RGBA pixels, top row first.
pub fn decode_png(bytes: &[u8]) -> Result<Raw, CaptureError> {
    let failed = |why: String| CaptureError::Failed(format!("the window image could not be decoded: {why}"));
    if !is_png(bytes) {
        return Err(failed("it is not a PNG".into()));
    }
    let mut reader = png::Decoder::new(std::io::Cursor::new(bytes)).read_info().map_err(|e| failed(e.to_string()))?;
    let capacity = reader.output_buffer_size().ok_or_else(|| failed("its size is unreadable".into()))?;
    let mut buffer = vec![0u8; capacity];
    let info = reader.next_frame(&mut buffer).map_err(|e| failed(e.to_string()))?;
    if info.bit_depth != png::BitDepth::Eight {
        return Err(CaptureError::Unsupported(format!("the window image came back as {:?} pixels, not 8-bit ones", info.bit_depth)));
    }
    let (width, height) = (info.width, info.height);
    if width == 0 || height == 0 {
        return Err(failed("it has no pixels".into()));
    }
    let pixels = &buffer[..info.buffer_size()];
    let data = match info.color_type {
        png::ColorType::Rgba => pixels.to_vec(),
        png::ColorType::Rgb => {
            let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
            for pixel in pixels.chunks_exact(3) {
                rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 0xff]);
            }
            rgba
        }
        other => return Err(CaptureError::Unsupported(format!("the window image came back as {other:?} pixels, not RGB ones"))),
    };
    if data.len() != width as usize * height as usize * 4 {
        return Err(failed("its pixels do not match its size".into()));
    }
    Ok(Raw { width, height, bgra: false, data })
}

fn connect(bus_address: Option<&str>) -> Result<Connection, CaptureError> {
    match bus_address {
        Some(addr) => zbus::blocking::connection::Builder::address(addr).map_err(|e| unusable(&format!("the session bus is not reachable ({e})")))?.build().map_err(|e| unusable(&format!("the session bus is not reachable ({e})"))),
        None => Connection::session().map_err(|e| unusable(&format!("the session bus is not reachable ({e})"))),
    }
}

/// Only talk to a bus name somebody owns: never trigger activation of anything.
fn owns_bus(conn: &Connection) -> Result<bool, CaptureError> {
    let dbus = zbus::blocking::fdo::DBusProxy::new(conn).map_err(|e| unusable(&format!("the session bus is not reachable ({e})")))?;
    let name = zbus::names::BusName::try_from(BUS_NAME).map_err(|e| unusable(&format!("bad bus name ({e})")))?;
    dbus.name_has_owner(name).map_err(|e| unusable(&format!("the session bus did not answer ({e})")))
}

/// The token this launch of Koda registers with its own extension: 32 random bytes as hex, made once
/// per process, kept in memory only. It is never written to disk, never logged and never printed
/// with `Debug`, which is why it leaves this module only as an argument to a D-Bus call.
pub fn launch_token() -> String {
    LAUNCH_TOKEN.get_or_init(super::mcp::new_token).clone()
}

/// Did the extension refuse us by name, i.e. is its token somebody else's?
fn refused_by_name(error: &zbus::Error) -> bool {
    matches!(error, zbus::Error::MethodError(name, _, _) if name.as_str() == NOT_ALLOWED_ERROR)
}

/// Offer this launch's token. `false` means another registration is still live: not an error here,
/// because the call that follows is what answers whether we may pick or capture. The token is only
/// ever passed as an argument to the extension: it is never logged and never shown in an error.
fn register(proxy: &Proxy<'_>, token: &str) {
    let _: Result<bool, zbus::Error> = proxy.call(REGISTER_METHOD, &(token,));
}

/// Is the extension on the session bus right now? Presence only, no window data asked for.
pub fn available(bus_address: Option<&str>) -> bool {
    crate::contextwin::dbus::available(bus_address)
}

/// Ask the extension for the most recently focused window that is not Koda's.
///
/// `token` is this launch's token (`launch_token`): it is registered first so the extension knows
/// who is asking, and the same token travels with the question.
///
/// `Err(NoWindow)` is authoritative: the extension can see every window and there is none.
/// Any other error means «this backend cannot answer», so the caller may try the next one.
pub fn pick(bus_address: Option<&str>, token: &str) -> Result<Target, CaptureError> {
    let (addr, token) = (bus_address.map(str::to_owned), token.to_owned());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(pick_now(addr.as_deref(), &token));
    });
    rx.recv_timeout(PICK_DEADLINE).unwrap_or_else(|_| Err(unusable("the extension did not answer in time")))
}

fn pick_now(bus_address: Option<&str>, token: &str) -> Result<Target, CaptureError> {
    let conn = connect(bus_address)?;
    if !owns_bus(&conn)? {
        return Err(unusable("the extension is not running"));
    }
    let proxy = Proxy::new(&conn, BUS_NAME, OBJECT_PATH, INTERFACE).map_err(|e| unusable(&format!("the extension cannot be used ({e})")))?;
    register(&proxy, token);
    let (id, app_id, app, title): (u64, String, String, String) = proxy.call(PICK_METHOD, &(token,)).map_err(|e| {
        if refused_by_name(&e) {
            unusable(NOT_ALLOWED)
        } else {
            unusable(&format!("this version of the extension does not pick windows ({e})"))
        }
    })?;
    let candidate = crate::contextwin::Candidate { app_id: app_id.clone(), app_name: app.clone(), title: title.clone() };
    // Belt and braces: the extension already leaves Koda out, and nothing here trusts that.
    if id == 0 || app.trim().is_empty() || crate::contextwin::is_abito(&candidate) {
        return Err(CaptureError::NoWindow);
    }
    Ok(Target { app_id, app, title, handle: id })
}

/// Paint the window `id` through the extension and read the PNG it wrote. The file is deleted as
/// soon as its pixels are in memory. `token` is this launch's own, exactly as in `pick`.
pub fn capture(bus_address: Option<&str>, dir: &Path, id: u64, token: &str) -> Result<Raw, CaptureError> {
    let (tx, rx) = std::sync::mpsc::channel();
    let (addr, dir, token) = (bus_address.map(str::to_owned), dir.to_path_buf(), token.to_owned());
    std::thread::spawn(move || {
        let _ = tx.send(capture_now(addr.as_deref(), &dir, id, &token));
    });
    rx.recv_timeout(CAPTURE_DEADLINE).unwrap_or_else(|_| Err(unusable("the extension did not answer in time")))
}

fn capture_now(bus_address: Option<&str>, dir: &Path, id: u64, token: &str) -> Result<Raw, CaptureError> {
    let conn = connect(bus_address)?;
    if !owns_bus(&conn)? {
        return Err(unusable("the extension is not running"));
    }
    let proxy = Proxy::new(&conn, BUS_NAME, OBJECT_PATH, INTERFACE).map_err(|e| unusable(&format!("the extension cannot be used ({e})")))?;
    register(&proxy, token);
    let path: String = proxy.call(CAPTURE_METHOD, &(id, token)).map_err(|e| {
        if refused_by_name(&e) {
            unusable(NOT_ALLOWED)
        } else {
            CaptureError::Failed(format!("the extension could not capture that window ({e})"))
        }
    })?;
    let path = PathBuf::from(path);
    let bytes = read_and_discard(dir, &path, MAX_PNG_BYTES)?;
    decode_png(&bytes)
}

/// `read_private_png`, then the file is deleted WHETHER OR NOT it was accepted: it is the extension's
/// private capture, and a refused one must not stay in `$XDG_RUNTIME_DIR/koda-capture` (M1). Only a
/// direct child of the private directory is ever removed; a path outside it is not ours to delete,
/// and a planted symlink is removed itself, never its target.
pub fn read_and_discard(dir: &Path, path: &Path, max: u64) -> Result<Vec<u8>, CaptureError> {
    let result = read_private_png(dir, path, max);
    if path.is_absolute() && path.parent() == Some(dir) {
        let _ = std::fs::remove_file(path);
    }
    result
}

#[cfg(test)]
#[path = "gnome_tests.rs"]
mod tests;

//! The Wayland screenshot portal (`org.freedesktop.portal.Screenshot`, `interactive=true`): the
//! SYSTEM's own picker. **Koda no longer captures through it** (S8/L10): the portal answers a PICTURE,
//! not a window identity, so nothing can be vetted against the refusal list (Koda itself, the settings
//! and login dialogs, the password managers) and Koda refuses to capture a window it cannot identify,
//! the same way Gentle Dot refuses an `UNKNOWN_TARGET`. `linux` does not reach this module any more;
//! it stays here, compiled and unit-tested, as the documented protocol and as the place a future
//! identity-carrying portal API would land.
//!
//! What the portal could not do even when it was used: it never knew which app was picked, so the
//! only consent it expressed was the human's own click, per capture.
//!
//! The client copies the pattern of `hotkey::portal::client` (blocking `zbus`, no `ashpd`: it is
//! not in the offline crate set and `zbus` is already compiled in): `org.freedesktop.host.portal.
//! Registry.Register` for the app id, `Request::Response` subscribed BEFORE the call so a fast
//! answer is never lost, and the documented request path predicted from the connection's unique
//! name and our own handle token.
use super::gnome::{decode_png, is_png};
use super::image::Raw;
use super::mcp::CaptureError;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use zbus::blocking::{Connection, MessageIterator, Proxy};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

pub const DEST: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
pub const IFACE: &str = "org.freedesktop.portal.Screenshot";
const REQUEST_IFACE: &str = "org.freedesktop.portal.Request";
/// `org.freedesktop.host.portal.Registry`: how an app that is NOT sandboxed tells the portal its id.
const REGISTRY_IFACE: &str = "org.freedesktop.host.portal.Registry";
/// The id of Koda's installed `.desktop` (the tauri identifier), exactly as hotkey/portal sends it.
const APP_ID: &str = "com.abitog.AbitoTauri";

/// The human is choosing a window on screen: this is how long the dialog may stay open.
pub const PICK_WAIT: Duration = Duration::from_secs(180);
/// A window image is a few hundred KiB; anything this large is not one.
pub const MAX_PNG_BYTES: u64 = 32 * 1024 * 1024;
/// What the human is told when they close the picker instead of choosing a window.
pub const CANCELLED: &str = "you did not pick a window";

/// What the portal's `Response` means, once the `uri` in its results is read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Response {
    Saved(PathBuf),
    Cancelled,
    Failed,
}

/// `Response(code, results)`: 0 success with a `uri`, 1 the human cancelled, 2 anything else.
pub fn response(code: u32, uri: Option<&str>) -> Response {
    match code {
        0 => match uri.and_then(file_uri_to_path) {
            Some(path) => Response::Saved(path),
            // «Success» with no readable file is not a capture.
            None => Response::Failed,
        },
        1 => Response::Cancelled,
        _ => Response::Failed,
    }
}

/// `file:///a%20b/x.png` -> `/a b/x.png`. Anything that is not a local file is `None`.
pub fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.trim().strip_prefix("file://")?;
    // `file:///path` has an empty host; `file://localhost/path` names this machine. Anything else
    // is another computer's path, which is not the window the human picked here.
    let path = if rest.starts_with('/') { rest } else { rest.strip_prefix("localhost")? };
    if !path.starts_with('/') {
        return None;
    }
    let decoded = percent_decode(path);
    (!decoded.contains('\0')).then(|| PathBuf::from(decoded))
}

/// `%20` -> a space, `%C3%A9` -> `é`: the portal escapes anything that is not URI-safe.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&text[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The portal's own temporary screenshot is removed after it is read; a picture the human may want
/// to keep is not. Only the system temporary directory and our runtime directory count as
/// temporary: a portal that saved under `~/Pictures` saved a file for the human.
pub fn remove_if_temporary(path: &Path) {
    let runtime = std::env::var("XDG_RUNTIME_DIR").ok().map(PathBuf::from);
    let temporary = [Some(std::env::temp_dir()), runtime].into_iter().flatten().any(|root| path.parent() == Some(root.as_path()));
    if temporary {
        let _ = std::fs::remove_file(path);
    }
}

fn connect(bus_address: Option<&str>) -> Result<Connection, CaptureError> {
    match bus_address {
        Some(addr) => zbus::blocking::connection::Builder::address(addr).map_err(|e| CaptureError::Unsupported(format!("the screenshot portal is not reachable ({e})")))?.build().map_err(|e| CaptureError::Unsupported(format!("the screenshot portal is not reachable ({e})"))),
        None => Connection::session().map_err(|e| CaptureError::Unsupported(format!("the screenshot portal is not reachable ({e})"))),
    }
}

/// GNOME's portal refuses calls from a connection with no app id; best effort, as in hotkey/portal.
fn register_app_id(conn: &Connection) {
    if let Ok(registry) = Proxy::new(conn, DEST, PATH, REGISTRY_IFACE) {
        let options: HashMap<&str, Value<'_>> = HashMap::new();
        let _: zbus::Result<()> = registry.call("Register", &(APP_ID, options));
    }
}

/// Does this desktop implement the screenshot portal at all?
fn has_screenshot(conn: &Connection) -> bool {
    Proxy::new(conn, DEST, PATH, IFACE).ok().and_then(|p| p.get_property::<u32>("version").ok()).is_some_and(|version| version >= 1)
}

/// Wait as long as a human needs to choose a window, then read what the portal saved.
pub fn capture(bus_address: Option<&str>) -> Result<Raw, CaptureError> {
    capture_with_wait(bus_address, PICK_WAIT)
}

/// Same, with an explicit wait (tests, and any caller that must not block for minutes).
pub fn capture_with_wait(bus_address: Option<&str>, wait: Duration) -> Result<Raw, CaptureError> {
    let addr = bus_address.map(str::to_owned);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(ask(addr.as_deref(), wait));
    });
    // The dialog is the human's: the thread stops waiting at `wait`, and this cap is the backstop
    // for a portal that keeps the connection busy.
    rx.recv_timeout(wait + Duration::from_secs(2)).unwrap_or_else(|_| Err(CaptureError::Failed("the window picker was not answered".into())))
}

fn ask(bus_address: Option<&str>, wait: Duration) -> Result<Raw, CaptureError> {
    let conn = connect(bus_address)?;
    register_app_id(&conn);
    if !has_screenshot(&conn) {
        return Err(CaptureError::Unsupported("this desktop has no screenshot portal, so Koda cannot ask you to pick a window".into()));
    }
    let unique = conn.unique_name().ok_or_else(|| CaptureError::Unsupported("the session bus did not name this connection".into()))?.to_string();
    let token = crate::hotkey::portal::token("shot");
    let expected = crate::hotkey::portal::request_path(&unique, &token);
    // Subscribe BEFORE calling, or a fast Response is lost.
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface(REQUEST_IFACE)
        .map_err(|e| CaptureError::Unsupported(format!("the screenshot portal cannot be used ({e})")))?
        .member("Response")
        .map_err(|e| CaptureError::Unsupported(format!("the screenshot portal cannot be used ({e})")))?
        .path(expected.clone())
        .map_err(|e| CaptureError::Unsupported(format!("the screenshot portal cannot be used ({e})")))?
        .build();
    let mut answers = MessageIterator::for_match_rule(rule, &conn, Some(8)).map_err(|e| CaptureError::Unsupported(format!("the screenshot portal cannot be used ({e})")))?;
    let proxy = Proxy::new(&conn, DEST, PATH, IFACE).map_err(|e| CaptureError::Unsupported(format!("the screenshot portal cannot be used ({e})")))?;
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert("handle_token", Value::from(token.as_str()));
    // THE user picks the window, in the system's own dialog.
    options.insert("interactive", Value::from(true));
    options.insert("modal", Value::from(true));
    let handle: OwnedObjectPath = proxy
        .call("Screenshot", &("", options))
        .map_err(|e| CaptureError::Unsupported(format!("the screenshot portal refused ({e})")))?;
    // Portals older than 0.9 may answer another path than the predicted one; the documented one is
    // what the subscription above listens on, so an unexpected handle is a failure, not a guess.
    if handle.as_str() != expected {
        return Err(CaptureError::Failed("the screenshot portal answered an unexpected request".into()));
    }
    let deadline = Instant::now() + wait;
    if Instant::now() >= deadline {
        return Err(CaptureError::Failed("the window picker was not answered".into()));
    }
    // The match rule names the one request path and the one signal, so the next message IS the
    // answer: there is nothing to loop over, and the outer wait is what bounds a silent portal.
    let (code, results) = match answers.next() {
        Some(Ok(message)) => message
            .body()
            .deserialize::<(u32, HashMap<String, OwnedValue>)>()
            .map_err(|_| CaptureError::Failed("the window picker answered something Koda cannot read".into()))?,
        _ => return Err(CaptureError::Failed("the window picker closed without an answer".into())),
    };
    let uri = results.get("uri").and_then(|v| <String>::try_from(v.try_clone().ok()?).ok());
    match response(code, uri.as_deref()) {
        Response::Saved(path) => {
            let bytes = read_png_file(&path, MAX_PNG_BYTES)?;
            remove_if_temporary(&path);
            decode_png(&bytes)
        }
        Response::Cancelled => Err(CaptureError::Failed(CANCELLED.to_string())),
        Response::Failed => Err(CaptureError::Failed("the window picker did not return an image".into())),
    }
}

/// The portal's file, read with the same caps as any other capture: a regular file inside the
/// size budget that really is a PNG.
fn read_png_file(path: &Path, max: u64) -> Result<Vec<u8>, CaptureError> {
    let refuse = |why: &str| CaptureError::Failed(format!("the portal handed back a capture Koda will not read: {why}"));
    if !path.is_absolute() {
        return Err(refuse("the path is not absolute"));
    }
    let meta = std::fs::symlink_metadata(path).map_err(|e| refuse(&format!("it cannot be read ({e})")))?;
    if !meta.file_type().is_file() {
        return Err(refuse("it is not a regular file"));
    }
    if meta.len() == 0 {
        return Err(refuse("it is empty"));
    }
    if meta.len() > max {
        return Err(refuse("it is too large to be a window image"));
    }
    let bytes = std::fs::read(path).map_err(|e| refuse(&format!("it cannot be read ({e})")))?;
    if !is_png(&bytes) {
        return Err(refuse("it is not a PNG"));
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "portal_tests.rs"]
mod tests;

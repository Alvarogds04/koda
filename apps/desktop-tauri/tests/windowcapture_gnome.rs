//! K2-06 S8: the Linux backends against a PRIVATE session bus and a PRIVATE X server. The human's
//! session, bus, extension and display are never touched: the extension is a fake service that
//! speaks the same D-Bus contract, and the portal is a fake that follows the documented
//! Request/Response protocol.
#![cfg(target_os = "linux")]
use abito_island::windowcapture::linux::{LinuxDesktop, Source};
use abito_island::windowcapture::mcp::{CaptureError, Desktop, Target};
use abito_island::windowcapture::portal;
use std::collections::HashMap;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use x11rb::connection::Connection as _;
use x11rb::protocol::xproto::*;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use zbus::blocking::{connection, Connection as BusConnection};
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};

// ---- a private server -----------------------------------------------------------------------------

struct Bus {
    child: Child,
    address: String,
    dir: PathBuf,
}
impl Bus {
    fn start() -> Bus {
        static N: AtomicU32 = AtomicU32::new(0);
        // A SHORT private dir: sockaddr_un caps a socket path at 107 bytes and this worktree's path is long.
        let dir = PathBuf::from(std::env::var("HOME").expect("HOME")).join(format!(".kbus{}-{}", std::process::id() % 100000, N.fetch_add(1, Ordering::SeqCst)));
        std::fs::DirBuilder::new().mode(0o700).create(&dir).expect("a private bus dir");
        let sock = dir.join("s");
        let address = format!("unix:path={}", sock.display());
        let conf = dir.join("bus.conf");
        std::fs::write(&conf, format!("<!DOCTYPE busconfig PUBLIC \"-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN\" \"http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd\"><busconfig><type>session</type><listen>{address}</listen><auth>EXTERNAL</auth><policy context=\"default\"><allow send_destination=\"*\" eavesdrop=\"true\"/><allow eavesdrop=\"true\"/><allow own=\"*\"/></policy></busconfig>")).expect("write bus config");
        let child = Command::new("dbus-daemon")
            .args([&format!("--config-file={}", conf.display()), "--nofork", "--nopidfile"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("dbus-daemon is required (no skip, no fake)");
        for _ in 0..100 {
            if sock.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        Bus { child, address, dir }
    }
}
impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

struct Xvfb {
    child: Child,
    display: String,
}
impl Xvfb {
    fn start(n: u32) -> Xvfb {
        let display = format!(":{n}");
        let child = Command::new("Xvfb")
            .args([&display, "-screen", "0", "800x600x24", "-nolisten", "tcp"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("Xvfb is required (no skip, no fake)");
        for _ in 0..100 {
            if RustConnection::connect(Some(&display)).is_ok() {
                return Xvfb { child, display };
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("Xvfb did not start");
    }
}
impl Drop for Xvfb {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("koda-gnome-it-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("a private scratch directory");
    dir
}

fn png_of(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&rgb.repeat((width * height) as usize)).unwrap();
    }
    out
}

// ---- the fake extension: org.abito.Context --------------------------------------------------------

/// The one error the real extension raises for a caller that has not registered a good token.
#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.abito.Context")]
enum Refused {
    NotAllowed(String),
}

struct FakeExtension {
    picked: Mutex<(u64, String, String, String)>,
    png: Vec<u8>,
    dir: PathBuf,
    /// When set, the extension answers with this path instead of writing into its own directory.
    outside: Option<PathBuf>,
    captured: Arc<Mutex<Vec<u64>>>,
    /// The launch token that registered first, like the extension's own TokenGate.
    bound: Arc<Mutex<Option<String>>>,
}

/// Does this call carry the token the first caller bound? Empty or wrong is refused, like the real one.
fn permitted(bound: &Mutex<Option<String>>, token: &str) -> Result<(), Refused> {
    let bound = bound.lock().unwrap();
    match bound.as_deref() {
        Some(expected) if token == expected => Ok(()),
        Some(_) => Err(Refused::NotAllowed("that is not Koda's launch token".into())),
        None => Err(Refused::NotAllowed("no launch token has been registered".into())),
    }
}

#[zbus::interface(name = "org.abito.Context")]
impl FakeExtension {
    /// First caller wins: a token of a real length binds once, and only once.
    fn register(&self, token: String) -> bool {
        let mut bound = self.bound.lock().unwrap();
        if bound.is_some() || token.chars().count() < 32 {
            return false;
        }
        *bound = Some(token);
        true
    }

    fn pick_window(&self, token: String) -> Result<(u64, String, String, String), Refused> {
        permitted(&self.bound, &token)?;
        Ok(self.picked.lock().unwrap().clone())
    }

    fn capture_window(&self, id: u64, token: String) -> Result<String, Refused> {
        permitted(&self.bound, &token)?;
        self.captured.lock().unwrap().push(id);
        let path = match &self.outside {
            Some(path) => path.clone(),
            None => self.dir.join(format!("window-{id}-{}.png", std::process::id())),
        };
        std::fs::write(&path, &self.png).map_err(|e| Refused::NotAllowed(format!("no file could be written ({e})")))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| Refused::NotAllowed(format!("no private mode could be set ({e})")))?;
        Ok(path.to_string_lossy().into_owned())
    }
}

struct ExtensionState {
    captured: Arc<Mutex<Vec<u64>>>,
}

/// An extension from before v3: it answers window context but cannot pick or capture a window.
struct OldExtension;

#[zbus::interface(name = "org.abito.Context")]
impl OldExtension {
    fn get_recent_windows(&self) -> Vec<(String, String, String)> {
        vec![("firefox".to_owned(), "Firefox".to_owned(), "a page".to_owned())]
    }
}

fn serve_old_extension(bus: &Bus) {
    let conn = connection::Builder::address(bus.address.as_str())
        .unwrap()
        .name("org.abito.Context")
        .unwrap()
        .serve_at("/org/abito/Context", OldExtension)
        .unwrap()
        .build()
        .unwrap();
    std::mem::forget(conn);
}

fn serve_extension(bus: &Bus, picked: (u64, &str, &str, &str), png: Vec<u8>, dir: &Path, outside: Option<PathBuf>) -> ExtensionState {
    let fake = FakeExtension {
        picked: Mutex::new((picked.0, picked.1.to_owned(), picked.2.to_owned(), picked.3.to_owned())),
        png,
        dir: dir.to_path_buf(),
        outside,
        captured: Arc::new(Mutex::new(Vec::new())),
        bound: Arc::new(Mutex::new(None)),
    };
    let captured = fake.captured.clone();
    let conn = connection::Builder::address(bus.address.as_str())
        .unwrap()
        .name("org.abito.Context")
        .unwrap()
        .serve_at("/org/abito/Context", fake)
        .unwrap()
        .build()
        .unwrap();
    std::mem::forget(conn); // the service lives as long as the private bus does
    ExtensionState { captured }
}

// ---- the fake screenshot portal -------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Answer {
    Saved,
    Cancelled,
    Other,
    Silent,
}

struct FakePortal {
    answer: Answer,
    file: Option<PathBuf>,
    conn: OnceLock<BusConnection>,
    /// What the client asked for, in call order: `(interactive, handle_token present)`.
    asked: Arc<Mutex<Vec<(bool, bool)>>>,
}

#[zbus::interface(name = "org.freedesktop.portal.Screenshot")]
impl FakePortal {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        2
    }

    fn screenshot(&self, #[zbus(header)] hdr: zbus::message::Header<'_>, _parent: &str, options: HashMap<String, OwnedValue>) -> zbus::fdo::Result<OwnedObjectPath> {
        let interactive = options.get("interactive").and_then(|v| bool::try_from(v.try_clone().ok()?).ok()).unwrap_or(false);
        let token: String = options.get("handle_token").and_then(|v| String::try_from(v.try_clone().ok()?).ok()).unwrap_or_default();
        self.asked.lock().unwrap().push((interactive, !token.is_empty()));
        let sender = hdr.sender().map(|s| s.to_string()).unwrap_or_default();
        let path = format!("/org/freedesktop/portal/desktop/request/{}/{}", sender.trim_start_matches(':').replace('.', "_"), token);
        let conn = self.conn.get().expect("the fake portal connection").clone();
        let (answer, file) = (self.answer, self.file.clone());
        let answered = path.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            if answer == Answer::Silent {
                return; // the dialog stays open and is never answered
            }
            let code = match answer {
                Answer::Saved => 0u32,
                Answer::Cancelled => 1,
                _ => 2,
            };
            let mut results: HashMap<&str, Value<'_>> = HashMap::new();
            if let (Answer::Saved, Some(file)) = (answer, file) {
                results.insert("uri", Value::from(format!("file://{}", file.display())));
            }
            let _ = conn.emit_signal(
                None::<&str>,
                ObjectPath::try_from(answered.as_str()).unwrap(),
                "org.freedesktop.portal.Request",
                "Response",
                &(code, results),
            );
        });
        Ok(OwnedObjectPath::try_from(path).unwrap())
    }
}

fn serve_portal(bus: &Bus, answer: Answer, file: Option<PathBuf>) -> Arc<Mutex<Vec<(bool, bool)>>> {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let fake = FakePortal { answer, file, conn: OnceLock::new(), asked: asked.clone() };
    let conn = connection::Builder::address(bus.address.as_str())
        .unwrap()
        .name("org.freedesktop.portal.Desktop")
        .unwrap()
        .serve_at("/org/freedesktop/portal/desktop", fake)
        .unwrap()
        .build()
        .unwrap();
    let iface = conn.object_server().interface::<_, FakePortal>("/org/freedesktop/portal/desktop").unwrap();
    let _ = iface.get().conn.set(conn.clone());
    std::mem::forget(conn);
    asked
}

// ---- an X11 session -------------------------------------------------------------------------------

/// The connection is returned too: an X client that disconnects destroys its own windows
/// (close-down-mode `DestroyAll`), so the caller must keep it alive for as long as it needs them.
fn x11_window(display: &str, class: &[u8], color: u32, size: (u16, u16)) -> (RustConnection, u32) {
    // The probe connection in `Xvfb::start` disconnects, and an X server resets when its last client
    // goes away: the next connection may land during that reset, so it is retried.
    let mut attempt = 0;
    let (conn, screen) = loop {
        if let Ok(connected) = RustConnection::connect(Some(display)) {
            break connected;
        }
        attempt += 1;
        assert!(attempt < 100, "no X server answered at {display}");
        std::thread::sleep(Duration::from_millis(30));
    };
    let s = &conn.setup().roots[screen];
    let id = conn.generate_id().unwrap();
    conn.create_window(24, id, s.root, 10, 10, size.0, size.1, 0, WindowClass::INPUT_OUTPUT, 0, &CreateWindowAux::new().background_pixel(color)).unwrap();
    conn.change_property8(PropMode::REPLACE, id, AtomEnum::WM_CLASS, AtomEnum::STRING, class).unwrap();
    conn.map_window(id).unwrap();
    // No window manager runs on this Xvfb: the EWMH client list is ours to publish.
    let list = conn.intern_atom(false, b"_NET_CLIENT_LIST_STACKING").unwrap().reply().unwrap().atom;
    conn.change_property32(PropMode::REPLACE, s.root, list, AtomEnum::WINDOW, &[id]).unwrap();
    conn.flush().unwrap();
    (conn, id)
}

// ---- the tests ------------------------------------------------------------------------------------

#[test]
fn the_extension_contract_picks_a_window_and_hands_back_its_pixels() {
    let bus = Bus::start();
    let root = scratch("contract");
    let dir = root.join("koda-capture");
    std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
    let fake = serve_extension(&bus, (7, "firefox", "Firefox", "Mozilla — a page"), png_of(4, 3, [10, 20, 30]), &dir, None);
    let desktop = LinuxDesktop::fixed(Some(&bus.address), None, Some(root.to_str().unwrap()), Some("wayland"));

    let target: Target = desktop.pick_target().expect("the extension picks the window");
    assert_eq!((target.handle, target.app_id.as_str(), target.app.as_str(), target.title.as_str()), (7, "firefox", "Firefox", "Mozilla — a page"));
    assert_eq!(desktop.source(&target), Ok(Source::Extension));

    let shot = desktop.capture(&target).expect("the extension captures it");
    assert_eq!((shot.width, shot.height), (4, 3));
    assert!(shot.png.starts_with(&[0x89, b'P', b'N', b'G']), "the pixels arrive as a PNG");
    assert_eq!(*fake.captured.lock().unwrap(), vec![7u64], "the id that was picked is the id that is captured");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "the private capture file is gone after it is read");
}

#[test]
fn a_capture_the_extension_hands_out_from_outside_its_private_directory_is_refused() {
    let bus = Bus::start();
    let root = scratch("outside");
    let dir = root.join("koda-capture");
    std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
    // A path Koda never asked for: another app's screenshot, or a file replaced by someone else.
    let elsewhere = root.join("not-kodas.png");
    let fake = serve_extension(&bus, (9, "kterm", "KTerm", "shell"), png_of(2, 2, [1, 2, 3]), &dir, Some(elsewhere.clone()));
    let desktop = LinuxDesktop::fixed(Some(&bus.address), None, Some(root.to_str().unwrap()), Some("wayland"));
    let target = desktop.pick_target().unwrap();
    let error = desktop.capture(&target).expect_err("a path outside the private directory is never read");
    assert!(format!("{error:?}").contains("outside the private"), "{error:?}");
    assert!(elsewhere.exists(), "and the file is not deleted either");
    assert_eq!(*fake.captured.lock().unwrap(), vec![9u64]);
}

#[test]
fn the_extension_is_tried_before_x11() {
    let bus = Bus::start();
    let root = scratch("order");
    let dir = root.join("koda-capture");
    std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
    let fake = serve_extension(&bus, (11, "firefox", "Firefox", "a page"), png_of(3, 2, [7, 8, 9]), &dir, None);
    let x = Xvfb::start(96);
    let _x11 = x11_window(&x.display, b"xterm\0XTerm\0", 0x0000ff, (32, 24));
    let desktop = LinuxDesktop::fixed(Some(&bus.address), Some(&x.display), Some(root.to_str().unwrap()), Some("x11"));
    let target = desktop.pick_target().expect("a window");
    assert_eq!((target.app.as_str(), target.handle), ("Firefox", 11), "the extension's window wins over the X11 one");
    desktop.capture(&target).expect("captured through the extension");
    assert_eq!(*fake.captured.lock().unwrap(), vec![11u64]);
}

#[test]
fn without_the_extension_an_x11_session_picks_and_captures_its_window() {
    let bus = Bus::start(); // a bus with no org.abito.Context on it
    let x = Xvfb::start(95);
    let _x11 = x11_window(&x.display, b"foo\0Foo\0", 0x00ff00, (64, 48));
    let desktop = LinuxDesktop::fixed(Some(&bus.address), Some(&x.display), None, Some("x11"));
    let target = desktop.pick_target().expect("the X11 window");
    assert_eq!((target.app.as_str(), target.app_id.as_str()), ("Foo", "foo Foo"));
    assert_eq!(desktop.source(&target), Ok(Source::X11));
    let shot = desktop.capture(&target).expect("the X11 capture");
    assert_eq!((shot.width, shot.height), (64, 48));
}

#[test]
fn without_the_extension_or_x11_koda_refuses_because_it_cannot_identify_a_window() {
    // A live portal, ready to save a picture: Koda still refuses. A picture from the system picker has
    // no app identity, so nothing can be vetted against the refusal list, and Koda does not capture
    // what it cannot identify (Gentle Dot refuses an unidentified target the same way).
    let bus = Bus::start();
    let root = scratch("portal");
    let shot_file = std::env::temp_dir().join(format!("koda-portal-{}-shot.png", std::process::id()));
    std::fs::write(&shot_file, png_of(5, 4, [200, 100, 50])).unwrap();
    let asked = serve_portal(&bus, Answer::Saved, Some(shot_file.clone()));
    let desktop = LinuxDesktop::fixed(Some(&bus.address), None, Some(root.to_str().unwrap()), Some("wayland"));
    let error = desktop.pick_target().expect_err("Koda will not pick a window it cannot identify");
    let message = abito_island::windowcapture::mcp::error_message(&error);
    assert!(message.contains("cannot tell which app a window belongs to"), "{message}");
    assert!(message.contains("GNOME extension") && message.contains("X11"), "{message}");
    assert!(asked.lock().unwrap().is_empty(), "the system picker is never opened");
    assert!(shot_file.exists(), "and nothing was read from the portal");
}

#[test]
fn closing_the_system_picker_is_never_reached_because_koda_will_not_capture_an_unidentified_window() {
    // The cancel path still belongs to the portal (its own tests cover it), but no Koda flow gets there:
    // a Wayland session without the extension is refused before any dialog opens.
    let bus = Bus::start();
    let root = scratch("cancel");
    let asked = serve_portal(&bus, Answer::Cancelled, None);
    let desktop = LinuxDesktop::fixed(Some(&bus.address), None, Some(root.to_str().unwrap()), Some("wayland"));
    let error = desktop.pick_target().expect_err("nothing is picked, so no dialog is opened");
    assert!(matches!(error, CaptureError::Unsupported(_)), "{error:?}");
    assert!(asked.lock().unwrap().is_empty(), "the system picker is never opened");
}

#[test]
fn a_picker_nobody_answers_gives_up_instead_of_hanging() {
    let bus = Bus::start();
    serve_portal(&bus, Answer::Silent, None);
    let began = std::time::Instant::now();
    let error = portal::capture_with_wait(Some(&bus.address), Duration::from_millis(400)).expect_err("an unanswered picker is a failure");
    assert!(began.elapsed() < Duration::from_secs(10), "the wait is bounded");
    assert!(format!("{error:?}").contains("not answered"), "{error:?}");
}

#[test]
fn a_portal_that_is_not_there_is_reported_as_unsupported() {
    let bus = Bus::start();
    let error = portal::capture_with_wait(Some(&bus.address), Duration::from_millis(400)).expect_err("no portal, no capture");
    assert!(matches!(error, abito_island::windowcapture::mcp::CaptureError::Unsupported(_)), "{error:?}");
}

#[test]
fn an_older_extension_that_cannot_pick_is_refused_instead_of_falling_back_to_the_picker() {
    let bus = Bus::start();
    let root = scratch("old-extension");
    let shot_file = std::env::temp_dir().join(format!("koda-portal-{}-old.png", std::process::id()));
    std::fs::write(&shot_file, png_of(3, 3, [1, 2, 3])).unwrap();
    serve_old_extension(&bus); // v2: not absent, but it does not answer PickWindow
    let asked = serve_portal(&bus, Answer::Saved, Some(shot_file.clone()));
    let desktop = LinuxDesktop::fixed(Some(&bus.address), None, Some(root.to_str().unwrap()), Some("wayland"));
    // An extension that cannot pick is not a licence to capture a window nobody can name.
    let error = desktop.pick_target().expect_err("an unidentified window is never captured");
    let message = abito_island::windowcapture::mcp::error_message(&error);
    assert!(message.contains("cannot tell which app a window belongs to"), "{message}");
    assert!(asked.lock().unwrap().is_empty(), "the system picker is never opened");
    assert!(shot_file.exists(), "and nothing was read from the portal");
}

#[test]
fn a_client_with_a_different_launch_token_is_refused_and_never_captures() {
    let bus = Bus::start();
    let root = scratch("wrong-token");
    let dir = root.join("koda-capture");
    std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
    let fake = serve_extension(&bus, (5, "firefox", "Firefox", "a page"), png_of(2, 2, [1, 2, 3]), &dir, None);
    // Koda's own launch registers its token first and is answered.
    let koda = LinuxDesktop::fixed(Some(&bus.address), None, Some(root.to_str().unwrap()), Some("wayland"));
    let target = koda.pick_target().expect("the launch that registered is the one that picks");
    assert_eq!(target.handle, 5);
    // Another Koda (or any program) with a different token: the registration does not take, and every
    // question is refused by name.
    let other = LinuxDesktop::fixed(Some(&bus.address), None, Some(root.to_str().unwrap()), Some("wayland"))
        .with_token("a-different-launch-token-0123456789abcdef");
    let refused = other.pick_target().expect_err("a different token is not Koda");
    // The pick itself says why, not the generic «turn on the extension»: the extension IS there.
    let at_pick = abito_island::windowcapture::mcp::error_message(&refused);
    assert!(at_pick.contains("another program holds Koda's GNOME extension"), "{at_pick}");
    assert!(at_pick.contains("restart Koda"), "{at_pick}");
    assert!(!at_pick.contains("cannot tell which app"), "{at_pick}");
    let error = other.capture(&target).expect_err("a different token cannot capture either");
    let message = abito_island::windowcapture::mcp::error_message(&error);
    assert!(message.contains("another program holds Koda's GNOME extension"), "{message}");
    assert!(message.contains("restart Koda"), "{message}");
    assert!(fake.captured.lock().unwrap().is_empty(), "nothing was captured for the wrong token");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "and no capture file was ever written");
    // The launch that registered still works: a foreign token cannot lock Koda out of its own extension.
    let shot = koda.capture(&target).expect("the registering launch still captures");
    assert_eq!((shot.width, shot.height), (2, 2));
    assert_eq!(*fake.captured.lock().unwrap(), vec![5u64]);
}

#[test]
fn a_client_that_never_registered_and_sends_no_token_is_refused() {
    let bus = Bus::start();
    let root = scratch("no-token");
    let dir = root.join("koda-capture");
    std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
    let fake = serve_extension(&bus, (3, "kterm", "KTerm", "shell"), png_of(2, 2, [1, 2, 3]), &dir, None);
    let conn = connection::Builder::address(bus.address.as_str()).unwrap().build().unwrap();
    let proxy = zbus::blocking::Proxy::new(&conn, "org.abito.Context", "/org/abito/Context", "org.abito.Context").unwrap();
    // Nothing registered yet: no token, an empty token and any guess are all refused.
    for token in ["", "a-token-nobody-registered-0123456789abcdef"] {
        let picked: zbus::Result<(u64, String, String, String)> = proxy.call("PickWindow", &(token));
        assert!(format!("{:?}", picked.unwrap_err()).contains("org.abito.Context.NotAllowed"), "{token:?} must be refused");
        let captured: zbus::Result<String> = proxy.call("CaptureWindow", &(3u64, token));
        assert!(format!("{:?}", captured.unwrap_err()).contains("org.abito.Context.NotAllowed"), "{token:?} must not capture");
    }
    // A token that is too short is not a registration either, so it still holds no rights.
    let registered: bool = proxy.call("Register", &("short-token")).unwrap();
    assert!(!registered, "a short token cannot register");
    let picked: zbus::Result<(u64, String, String, String)> = proxy.call("PickWindow", &("short-token"));
    assert!(picked.is_err(), "a refused registration grants nothing");
    assert!(fake.captured.lock().unwrap().is_empty(), "no window was ever painted");
}

#[test]
fn an_extension_that_sees_no_window_is_believed() {
    let bus = Bus::start();
    let root = scratch("no-window");
    let dir = root.join("koda-capture");
    std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
    serve_extension(&bus, (0, "", "", ""), png_of(2, 2, [0, 0, 0]), &dir, None);
    // Wayland: the extension can see every window, so «none» is the answer, not a picker prompt.
    let wayland = LinuxDesktop::fixed(Some(&bus.address), None, Some(root.to_str().unwrap()), Some("wayland"));
    assert_eq!(wayland.pick_target(), Err(CaptureError::NoWindow));
    // A real X11 session with the extension enabled still has its own windows to fall back on.
    let x = Xvfb::start(94);
    let _x11 = x11_window(&x.display, b"gedit\0Gedit\0", 0x00ffff, (16, 16));
    let x11 = LinuxDesktop::fixed(Some(&bus.address), Some(&x.display), Some(root.to_str().unwrap()), Some("x11"));
    let target = x11.pick_target().expect("the X11 window behind an empty extension");
    assert_eq!(target.app, "Gedit");
}

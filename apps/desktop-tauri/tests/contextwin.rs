//! #487: the active-window reader against a FAKE extension on a PRIVATE session bus
//! (`dbus-daemon`) and against fake window data on a PRIVATE Xvfb. The human's bus and
//! display are never used; a missing runner fails loudly.
#![cfg(target_os = "linux")]
use abito_island::contextwin::{capture, dbus, x11, ActiveWindow, BUS_NAME, OBJECT_PATH};
use std::os::unix::fs::DirBuilderExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, CreateWindowAux, PropMode, WindowClass};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

struct Bus { child: Child, address: String, dir: std::path::PathBuf }
impl Bus {
    fn start() -> Bus {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::path::PathBuf::from(std::env::var("HOME").expect("HOME")).join(format!(".cbus{}-{}", std::process::id() % 100000, N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
        let sock = dir.join("s");
        let address = format!("unix:path={}", sock.display());
        let conf = dir.join("bus.conf");
        std::fs::write(&conf, format!("<!DOCTYPE busconfig PUBLIC \"-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN\" \"http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd\"><busconfig><type>session</type><listen>{address}</listen><auth>EXTERNAL</auth><policy context=\"default\"><allow send_destination=\"*\" eavesdrop=\"true\"/><allow eavesdrop=\"true\"/><allow own=\"*\"/></policy></busconfig>")).unwrap();
        let child = Command::new("dbus-daemon").args([&format!("--config-file={}", conf.display()), "--nofork", "--nopidfile"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("dbus-daemon is required (no skip, no fake)");
        for _ in 0..100 { if sock.exists() { break; } std::thread::sleep(Duration::from_millis(30)); }
        Bus { child, address, dir }
    }
}
impl Drop for Bus { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); let _ = std::fs::remove_dir_all(&self.dir); } }

struct Fake(Vec<(String, String, String)>, std::sync::Arc<AtomicU32>);
#[zbus::interface(name = "org.abito.Context")]
impl Fake {
    fn get_recent_windows(&self) -> Vec<(String, String, String)> { self.1.fetch_add(1, Ordering::SeqCst); self.0.clone() }
}
fn serve(bus: &Bus, rows: Vec<(&str, &str, &str)>) -> zbus::blocking::Connection {
    let rows = rows.into_iter().map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string())).collect();
    zbus::blocking::connection::Builder::address(bus.address.as_str()).unwrap()
        .name(BUS_NAME).unwrap().serve_at(OBJECT_PATH, Fake(rows, Default::default())).unwrap().build().unwrap()
}

struct Xvfb { child: Child, display: String }
impl Xvfb {
    fn start() -> Xvfb {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let n = 400 + (std::process::id() % 100) * 64 + NEXT.fetch_add(1, Ordering::SeqCst) % 64;
        let display = format!(":{n}");
        let child = Command::new("Xvfb").args([&display, "-screen", "0", "320x200x24", "-nolisten", "tcp", "-noreset"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("Xvfb is required (no skip, no fake)");
        for _ in 0..100 {
            if RustConnection::connect(Some(&display)).is_ok() { return Xvfb { child, display }; }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("Xvfb did not come up");
    }
}
impl Drop for Xvfb { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }

/// Create windows (bottom first) with class and title and publish them as the stacking list.
fn publish(x: &Xvfb, wins: &[(&str, &str, &str)]) -> RustConnection {
    let (conn, screen) = RustConnection::connect(Some(&x.display)).unwrap();
    let root = conn.setup().roots[screen].root;
    let atom = |n: &[u8]| conn.intern_atom(false, n).unwrap().reply().unwrap().atom;
    let (utf8, net_name, list) = (atom(b"UTF8_STRING"), atom(b"_NET_WM_NAME"), atom(b"_NET_CLIENT_LIST_STACKING"));
    let mut ids = Vec::new();
    for (inst, class, title) in wins {
        let id = conn.generate_id().unwrap();
        conn.create_window(0, id, root, 0, 0, 10, 10, 0, WindowClass::INPUT_OUTPUT, 0, &CreateWindowAux::new()).unwrap();
        conn.change_property8(PropMode::REPLACE, id, AtomEnum::WM_CLASS, AtomEnum::STRING, format!("{inst}\0{class}\0").as_bytes()).unwrap();
        conn.change_property8(PropMode::REPLACE, id, net_name, utf8, title.as_bytes()).unwrap();
        ids.push(id);
    }
    conn.change_property32(PropMode::REPLACE, root, list, AtomEnum::WINDOW, &ids).unwrap();
    conn.flush().unwrap();
    conn.get_input_focus().unwrap().reply().unwrap();
    conn
}

#[test]
fn the_extension_answer_wins_and_abito_is_skipped() {
    let bus = Bus::start();
    let _svc = serve(&bus, vec![("com.abitog.AbitoTauri", "Abito", "Abito"), ("firefox.desktop", "Firefox", "Docs")]);
    let got = capture(Some(&bus.address), Some(":9999")); // the X display does not exist: never reached
    assert_eq!(got, Some(ActiveWindow { app: "Firefox".into(), title: "Docs".into() }));
}

#[test]
fn no_extension_on_the_bus_is_absent_not_an_error_and_never_activates_anything() {
    let bus = Bus::start();
    assert_eq!(dbus::recent_windows(Some(&bus.address)), None);
}

#[test]
fn a_bad_bus_address_is_absent() {
    assert_eq!(dbus::recent_windows(Some("unix:path=/nonexistent/abito-none")), None);
}

#[test]
fn x11_fallback_returns_the_topmost_non_abito_window() {
    let bus = Bus::start(); // no extension
    let x = Xvfb::start();
    let _keep = publish(&x, &[("kate", "Kate", "notes.txt"), ("code", "Code", "main.rs"), ("abito", "AbitoTauri", "Abito")]);
    let got = capture(Some(&bus.address), Some(&x.display));
    assert_eq!(got, Some(ActiveWindow { app: "Code".into(), title: "main.rs".into() }));
    assert!(x11::recent_windows(Some(&x.display)).unwrap().len() == 3);
}

#[test]
fn x11_without_a_window_manager_list_gives_no_context() {
    let bus = Bus::start();
    let x = Xvfb::start();
    assert_eq!(capture(Some(&bus.address), Some(&x.display)), None);
}


#[test]
fn flow_uses_the_gnome_reader_on_wayland() {
    let bus = Bus::start();
    let _svc = serve(&bus, vec![("com.abitog.AbitoTauri", "Abito", "Abito"), ("org.example.Writer.desktop", "Writer", "Private title")]);
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "flow_gnome_child", "--nocapture"])
        .env("ABITO_TEST_CONTEXT_CHILD", "1")
        .env("DBUS_SESSION_BUS_ADDRESS", &bus.address)
        .env("XDG_SESSION_TYPE", "wayland")
        .env("DISPLAY", ":9999")
        .output().unwrap();
    assert!(child.status.success(), "{}", String::from_utf8_lossy(&child.stdout));
}

#[test]
fn flow_gnome_child() {
    if std::env::var("ABITO_TEST_CONTEXT_CHILD").ok().as_deref() != Some("1") { return; }
    use abito_island::flow::{self, Backend, System};
    assert_eq!(System.foreground_app(), Some(("org.example.writer".into(), "Writer".into())));
    assert_eq!(flow::running_apps(), vec![("org.example.writer".into(), "Writer".into())]);
}


#[test]
fn extension_availability_never_reads_windows() {
    let bus = Bus::start();
    assert!(!dbus::available(Some(&bus.address)));
    let reads = std::sync::Arc::new(AtomicU32::new(0));
    let _svc = zbus::blocking::connection::Builder::address(bus.address.as_str()).unwrap()
        .name(BUS_NAME).unwrap().serve_at(OBJECT_PATH, Fake(vec![], reads.clone())).unwrap().build().unwrap();
    assert!(dbus::available(Some(&bus.address)));
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    assert_eq!(dbus::recent_windows(Some(&bus.address)), Some(vec![]));
    assert_eq!(reads.load(Ordering::SeqCst), 1);
}

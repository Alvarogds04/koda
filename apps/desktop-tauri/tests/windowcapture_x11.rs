//! K2-06: the REAL X11 capture, on a PRIVATE Xvfb (never the human's display).
#![cfg(target_os = "linux")]
use koda_island::windowcapture::{image, mcp::CaptureError, x11};
use std::process::{Child, Command, Stdio};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::*;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

struct Xvfb { child: Child, display: String }
impl Xvfb {
    fn start(n: u32) -> Option<Self> {
        let display = format!(":{n}");
        let child = Command::new("Xvfb").args([&display, "-screen", "0", "800x600x24", "-nolisten", "tcp"])
            .stdout(Stdio::null()).stderr(Stdio::null()).spawn().ok()?;
        for _ in 0..100 {
            if RustConnection::connect(Some(&display)).is_ok() { return Some(Self { child, display }); }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        None
    }
}
impl Drop for Xvfb { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }

fn map_window(conn: &RustConnection, screen: usize, class: &[u8], color: u32, size: (u16, u16)) -> u32 {
    let s = &conn.setup().roots[screen];
    let id = conn.generate_id().unwrap();
    conn.create_window(24, id, s.root, 10, 10, size.0, size.1, 0, WindowClass::INPUT_OUTPUT, 0,
        &CreateWindowAux::new().background_pixel(color)).unwrap();
    conn.change_property8(PropMode::REPLACE, id, AtomEnum::WM_CLASS, AtomEnum::STRING, class).unwrap();
    conn.map_window(id).unwrap();
    conn.flush().unwrap();
    id
}

#[test]
fn captures_one_window_by_id_with_its_pixels_and_never_koda() {
    let Some(x) = Xvfb::start(97) else { panic!("Xvfb did not start") };
    let (conn, screen) = RustConnection::connect(Some(&x.display)).unwrap();
    // Without a window manager there is no _NET_CLIENT_LIST_STACKING: the pick has nothing to choose.
    assert_eq!(x11::pick(Some(&x.display)), Err(CaptureError::NoWindow));
    let target_id = map_window(&conn, screen, b"foo\0Foo\0", 0x00ff00, (64, 48));
    let raw = x11::capture(Some(&x.display), target_id as u64).unwrap();
    assert_eq!((raw.width, raw.height), (64, 48));
    let px = &raw.data[..4];
    assert_eq!((px[0], px[1], px[2]), (0x00, 0xff, 0x00), "B,G,R of a green window");
    let (png, w, h) = image::encode_png(&raw).unwrap();
    assert_eq!((w, h), (64, 48));
    assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
    // A window id that does not exist is a clean failure, not a panic.
    assert!(matches!(x11::capture(Some(&x.display), 0x7fff_fff0), Err(CaptureError::Failed(_))));
}

//! The visual probe must find its own window on a PRIVATE Xvfb that has NO window manager
//! (so no `_NET_CLIENT_LIST`): it falls back to walking the window tree for our `_NET_WM_PID`.
//! A window of ANOTHER pid with our title is still never ours.
#![cfg(target_os = "linux")] // Requires a private Linux Xvfb server.
use abito_island::workarea::{x11_find_own_window, OwnWindowError};
use std::process::{Command, Stdio};
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, CreateWindowAux, PropMode, WindowClass};
use x11rb::wrapper::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

#[test]
fn finds_own_window_without_a_window_manager_and_never_a_foreign_one() {
    let display = format!(":{}", 8200 + std::process::id() % 700);
    let mut xvfb = Command::new("Xvfb").args([&display, "-screen", "0", "320x200x24", "-nolisten", "tcp", "-noreset"])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("Xvfb is required (no skip, no fake)");
    let (conn, screen) = (0..100).find_map(|_| { std::thread::sleep(Duration::from_millis(50)); RustConnection::connect(Some(&display)).ok() }).expect("Xvfb up");
    std::env::set_var("DISPLAY", &display); // this file holds ONE test: the process env is ours alone
    let root = conn.setup().roots[screen].root;
    let intern = |n: &[u8]| conn.intern_atom(false, n).unwrap().reply().unwrap().atom;
    let (pid_atom, name_atom, utf8) = (intern(b"_NET_WM_PID"), intern(b"_NET_WM_NAME"), intern(b"UTF8_STRING"));
    let make = |pid: u32, title: &str| {
        let w = conn.generate_id().unwrap();
        conn.create_window(0, w, root, 0, 0, 78, 78, 0, WindowClass::INPUT_OUTPUT, 0, &CreateWindowAux::new()).unwrap();
        conn.change_property32(PropMode::REPLACE, w, pid_atom, AtomEnum::CARDINAL, &[pid]).unwrap();
        conn.change_property8(PropMode::REPLACE, w, name_atom, utf8, title.as_bytes()).unwrap();
        conn.map_window(w).unwrap();
        w
    };
    // 1) only a foreign window carries our title: refuse, never guess
    let foreign = make(std::process::id().wrapping_add(1), abito_island::workarea::WINDOW_TITLE);
    conn.flush().unwrap();
    assert_eq!(x11_find_own_window(abito_island::workarea::WINDOW_TITLE).err(), Some(OwnWindowError::NotFound), "a foreign window titled like ours is not ours");
    // 2) our own window appears: found by pid on a WM-less server
    let own = make(std::process::id(), abito_island::workarea::WINDOW_TITLE);
    conn.flush().unwrap();
    let found = x11_find_own_window(abito_island::workarea::WINDOW_TITLE).expect("own window found without _NET_CLIENT_LIST");
    assert_eq!(found.id, own);
    assert_ne!(found.id, foreign);
    let _ = xvfb.kill();
    let _ = xvfb.wait();
}

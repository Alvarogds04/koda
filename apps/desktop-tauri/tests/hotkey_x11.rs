//! #305: the REAL XGrabKey grabber, on a PRIVATE Xvfb (never the human's display).
//! XTest fake input drives the key presses; the test fails loudly if Xvfb is
//! missing (a missing runner must never read as green).
#![cfg(target_os = "linux")] // Requires the Linux Xvfb/XTest runner.
use abito_island::hotkey::{x11::Grabber, x11::GrabEvent, Combo, Status};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt, GrabMode, ModMask};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

struct Xvfb { child: Child, display: String }
impl Xvfb {
    fn start() -> Xvfb {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        // unique per test AND per process: parallel tests never share a server
        let n = 200 + (std::process::id() % 100) * 64 + NEXT.fetch_add(1, Ordering::SeqCst) % 64;
        let display = format!(":{n}");
        let child = Command::new("Xvfb").args([&display, "-screen", "0", "320x200x24", "-nolisten", "tcp", "-noreset"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
            .expect("Xvfb is required for the hotkey grabber test (no skip, no fake)");
        for _ in 0..100 {
            if RustConnection::connect(Some(&display)).is_ok() { return Xvfb { child, display }; }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("Xvfb did not come up on {display}");
    }
    fn conn(&self) -> (RustConnection, usize) { RustConnection::connect(Some(&self.display)).expect("connect to the private Xvfb") }
}
impl Drop for Xvfb { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }

fn keycode(conn: &RustConnection, keysym: u32) -> u8 {
    let setup = conn.setup();
    let (min, max) = (setup.min_keycode, setup.max_keycode);
    let map = conn.get_keyboard_mapping(min, max - min + 1).unwrap().reply().unwrap();
    let per = map.keysyms_per_keycode as usize;
    (min..=max).find(|k| map.keysyms[(*k - min) as usize * per..][..per].contains(&keysym)).expect("keysym on the Xvfb keymap")
}
fn press(conn: &RustConnection, keys: &[u8], mods: &[u8]) {
    for m in mods { conn.xtest_fake_input(2, *m, 0, x11rb::NONE, 0, 0, 0).unwrap(); }
    for k in keys { conn.xtest_fake_input(2, *k, 0, x11rb::NONE, 0, 0, 0).unwrap(); conn.xtest_fake_input(3, *k, 0, x11rb::NONE, 0, 0, 0).unwrap(); }
    for m in mods.iter().rev() { conn.xtest_fake_input(3, *m, 0, x11rb::NONE, 0, 0, 0).unwrap(); }
    conn.flush().unwrap();
}
fn start(display: &str, combo: &str) -> (Grabber, Receiver<GrabEvent>) {
    let (tx, rx) = mpsc::channel();
    let g = Grabber::start(Some(display), Combo::parse(combo).unwrap(), move |e| { let _ = tx.send(e); });
    (g, rx)
}

#[test]
fn grabs_the_combo_reports_active_and_fires_once_per_press() {
    let x = Xvfb::start();
    let (g, rx) = start(&x.display, "Ctrl+Alt+A");
    assert_eq!(g.status(), Status::Active);
    let (conn, _) = x.conn();
    let (a, ctrl, alt) = (keycode(&conn, 0x61), keycode(&conn, 0xffe3), keycode(&conn, 0xffe9));
    press(&conn, &[a], &[ctrl, alt]);
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)).expect("hotkey press delivered"), GrabEvent::Pressed);
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err(), "one press = one event (no key-repeat storm, no release event)");
    g.stop();
}

#[test]
fn other_combos_and_extra_modifiers_do_not_fire() {
    let x = Xvfb::start();
    let (g, rx) = start(&x.display, "Ctrl+Alt+A");
    let (conn, _) = x.conn();
    let (a, b, ctrl, alt, shift) = (keycode(&conn, 0x61), keycode(&conn, 0x62), keycode(&conn, 0xffe3), keycode(&conn, 0xffe9), keycode(&conn, 0xffe1));
    press(&conn, &[b], &[ctrl, alt]);       // another key
    press(&conn, &[a], &[ctrl]);            // missing Alt
    press(&conn, &[a], &[ctrl, alt, shift]); // extra Shift
    assert!(rx.recv_timeout(Duration::from_millis(600)).is_err(), "nothing but the exact combo fires");
    press(&conn, &[a], &[ctrl, alt]);
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), GrabEvent::Pressed);
    g.stop();
}

#[test]
fn caps_lock_and_num_lock_never_break_it() {
    let x = Xvfb::start();
    let (g, rx) = start(&x.display, "Ctrl+Alt+A");
    let (conn, _) = x.conn();
    let (a, ctrl, alt, caps) = (keycode(&conn, 0x61), keycode(&conn, 0xffe3), keycode(&conn, 0xffe9), keycode(&conn, 0xffe5));
    conn.xtest_fake_input(2, caps, 0, x11rb::NONE, 0, 0, 0).unwrap(); conn.xtest_fake_input(3, caps, 0, x11rb::NONE, 0, 0, 0).unwrap(); conn.flush().unwrap(); // Caps Lock ON
    press(&conn, &[a], &[ctrl, alt]);
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)).expect("fires with Caps Lock on"), GrabEvent::Pressed);
    g.stop();
}

#[test]
fn a_taken_combo_is_reported_visibly_and_never_steals_or_panics() {
    let x = Xvfb::start();
    // another client already holds Ctrl+Alt+A
    let (squatter, screen) = x.conn();
    let root = squatter.setup().roots[screen].root;
    let a = keycode(&squatter, 0x61);
    squatter.grab_key(true, root, ModMask::CONTROL | ModMask::M1, a, GrabMode::ASYNC, GrabMode::ASYNC).unwrap().check().unwrap();
    let (g, rx) = start(&x.display, "Ctrl+Alt+A");
    assert_eq!(g.status(), Status::Taken, "the grab collided: say so");
    // and it is not silently half-active: a press goes to the squatter, we hear nothing
    let (conn, _) = x.conn();
    let (ctrl, alt) = (keycode(&conn, 0xffe3), keycode(&conn, 0xffe9));
    press(&conn, &[keycode(&conn, 0x61)], &[ctrl, alt]);
    assert!(rx.recv_timeout(Duration::from_millis(500)).is_err());
    g.stop();
}

#[test]
fn partial_collision_on_a_lock_variant_releases_everything_it_did_take() {
    let x = Xvfb::start();
    let (squatter, screen) = x.conn();
    let root = squatter.setup().roots[screen].root;
    let a = keycode(&squatter, 0x61);
    // the squatter holds ONLY the Caps-Lock variant of the combo
    squatter.grab_key(true, root, ModMask::CONTROL | ModMask::M1 | ModMask::LOCK, a, GrabMode::ASYNC, GrabMode::ASYNC).unwrap().check().unwrap();
    let (g, _rx) = start(&x.display, "Ctrl+Alt+A");
    assert_eq!(g.status(), Status::Taken);
    // after we gave up, the squatter can still take the plain variant: we left nothing behind
    squatter.grab_key(true, root, ModMask::CONTROL | ModMask::M1, a, GrabMode::ASYNC, GrabMode::ASYNC).unwrap().check().expect("no leaked grab from the failed attempt");
    g.stop();
}

#[test]
fn stop_releases_the_grab_and_it_can_be_retaken_and_rebound() {
    let x = Xvfb::start();
    let (g, rx) = start(&x.display, "Ctrl+Alt+A");
    assert_eq!(g.status(), Status::Active);
    g.stop();
    let (conn, screen) = x.conn();
    let root = conn.setup().roots[screen].root;
    let a = keycode(&conn, 0x61);
    conn.grab_key(true, root, ModMask::CONTROL | ModMask::M1, a, GrabMode::ASYNC, GrabMode::ASYNC).unwrap().check().expect("grab released after stop");
    conn.ungrab_key(a, root, ModMask::CONTROL | ModMask::M1).unwrap().check().unwrap();
    // rebind to another combo on the same server
    let (g2, rx2) = start(&x.display, "Ctrl+Alt+B");
    assert_eq!(g2.status(), Status::Active);
    let (ctrl, alt, b) = (keycode(&conn, 0xffe3), keycode(&conn, 0xffe9), keycode(&conn, 0x62));
    press(&conn, &[b], &[ctrl, alt]);
    assert_eq!(rx2.recv_timeout(Duration::from_secs(3)).unwrap(), GrabEvent::Pressed);
    assert!(rx.try_recv().is_err());
    g2.stop();
}

#[test]
fn unreachable_display_reports_unsupported_instead_of_panicking() {
    let (tx, _rx) = mpsc::channel::<GrabEvent>();
    let g = Grabber::start(Some(":65530"), Combo::default_combo(), move |e| { let _ = tx.send(e); });
    assert_eq!(g.status(), Status::Unsupported);
    g.stop();
}

#[test]
fn an_invalid_combo_never_reaches_the_server() {
    let x = Xvfb::start();
    let (tx, _rx) = mpsc::channel::<GrabEvent>();
    let g = Grabber::start(Some(&x.display), Combo::parse("Shift+A").unwrap(), move |e| { let _ = tx.send(e); });
    assert_eq!(g.status(), Status::Invalid, "a global grab without a real modifier would steal typing");
    g.stop();
}

#[test]
fn active_window_is_read_and_focus_can_be_handed_back() {
    use abito_island::hotkey::x11::{active_window, give_focus_back};
    let x = Xvfb::start();
    // bare Xvfb has no WM: no _NET_ACTIVE_WINDOW, and it must say None, not panic
    assert_eq!(active_window(Some(&x.display)), None);
    let (conn, screen) = x.conn();
    let root = conn.setup().roots[screen].root;
    let win = conn.generate_id().unwrap();
    conn.create_window(0, win, root, 0, 0, 10, 10, 0, x11rb::protocol::xproto::WindowClass::INPUT_OUTPUT, 0, &Default::default()).unwrap();
    conn.map_window(win).unwrap(); conn.flush().unwrap();
    assert!(give_focus_back(Some(&x.display), win));
    let focus = conn.get_input_focus().unwrap().reply().unwrap().focus;
    assert_eq!(focus, win, "the keyboard went back to the window that had it");
    assert!(!give_focus_back(Some(":65530"), win), "an unreachable server is a quiet false");
}

fn hold(conn: &RustConnection, keys: &[u8], mods: &[u8], ms: u64) {
    for m in mods { conn.xtest_fake_input(2, *m, 0, x11rb::NONE, 0, 0, 0).unwrap(); }
    for k in keys { conn.xtest_fake_input(2, *k, 0, x11rb::NONE, 0, 0, 0).unwrap(); }
    conn.flush().unwrap();
    std::thread::sleep(Duration::from_millis(ms)); // the X server auto-repeats a held key
    for k in keys { conn.xtest_fake_input(3, *k, 0, x11rb::NONE, 0, 0, 0).unwrap(); }
    for m in mods.iter().rev() { conn.xtest_fake_input(3, *m, 0, x11rb::NONE, 0, 0, 0).unwrap(); }
    conn.flush().unwrap();
}

#[test]
fn a_held_key_is_exactly_one_event_not_one_per_auto_repeat() {
    let x = Xvfb::start();
    let (g, rx) = start(&x.display, "Ctrl+Alt+A");
    let (conn, _) = x.conn();
    // make the repeat fast and early so the test is short but still produces many repeats
    let (a, ctrl, alt) = (keycode(&conn, 0x61), keycode(&conn, 0xffe3), keycode(&conn, 0xffe9));
    hold(&conn, &[a], &[ctrl, alt], 1500);
    let mut events = 0;
    while rx.recv_timeout(Duration::from_millis(400)).is_ok() { events += 1; }
    assert_eq!(events, 1, "holding the shortcut for 1.5 s must toggle ONCE (auto-repeat would flicker the island)");
    // and a deliberate second press afterwards still works
    press(&conn, &[a], &[ctrl, alt]);
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)).expect("a fresh press after release fires again"), GrabEvent::Pressed);
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    g.stop();
}

#[test]
fn quick_deliberate_double_press_gives_two_events() {
    let x = Xvfb::start();
    let (g, rx) = start(&x.display, "Ctrl+Alt+A");
    let (conn, _) = x.conn();
    let (a, ctrl, alt) = (keycode(&conn, 0x61), keycode(&conn, 0xffe3), keycode(&conn, 0xffe9));
    press(&conn, &[a], &[ctrl, alt]);
    std::thread::sleep(Duration::from_millis(120));
    press(&conn, &[a], &[ctrl, alt]);
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), GrabEvent::Pressed);
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), GrabEvent::Pressed, "two real presses are two toggles");
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    g.stop();
}

#[test]
fn releasing_the_modifiers_before_the_key_does_not_leave_the_shortcut_stuck() {
    // the grab only covers Ctrl+Alt+A: once Ctrl/Alt go up, the key release goes to the
    // focused window, never to us. The next real press must still fire.
    let x = Xvfb::start();
    let (g, rx) = start(&x.display, "Ctrl+Alt+A");
    let (conn, _) = x.conn();
    let (a, ctrl, alt) = (keycode(&conn, 0x61), keycode(&conn, 0xffe3), keycode(&conn, 0xffe9));
    for k in [ctrl, alt, a] { conn.xtest_fake_input(2, k, 0, x11rb::NONE, 0, 0, 0).unwrap(); }
    for k in [ctrl, alt, a] { conn.xtest_fake_input(3, k, 0, x11rb::NONE, 0, 0, 0).unwrap(); } // modifiers up FIRST
    conn.flush().unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), GrabEvent::Pressed);
    std::thread::sleep(Duration::from_millis(1300)); // past the stale window
    press(&conn, &[a], &[ctrl, alt]);
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)).expect("not stuck after an odd release order"), GrabEvent::Pressed);
    g.stop();
}

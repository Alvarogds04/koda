//! #470: the Spotify client against a FAKE Spotify (MPRIS) on a PRIVATE session bus. The human's
//! bus and player are never touched. Adapted from Coucou src-tauri/src/spotify.rs @434d6a2b
//! (fake player test), Copyright (c) 2026 Louis Raillé, MIT.
#![cfg(target_os = "linux")]
use abito_island::spotify::{Action, Client, PlayerState};
use std::collections::HashMap;
use std::os::unix::fs::DirBuilderExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use zbus::blocking::{connection, Connection};
use zbus::zvariant::{ObjectPath, OwnedValue, Value};

struct Bus { child: Child, address: String, dir: std::path::PathBuf }
impl Bus {
    fn start() -> Bus {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"))
            .join(format!(".abus{}-{}", std::process::id() % 100000, N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
        let sock = dir.join("s");
        let address = format!("unix:path={}", sock.display());
        let conf = dir.join("bus.conf");
        std::fs::write(&conf, format!("<!DOCTYPE busconfig PUBLIC \"-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN\" \"http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd\"><busconfig><type>session</type><listen>{address}</listen><auth>EXTERNAL</auth><policy context=\"default\"><allow send_destination=\"*\" eavesdrop=\"true\"/><allow eavesdrop=\"true\"/><allow own=\"*\"/></policy></busconfig>")).expect("bus config");
        let child = Command::new("dbus-daemon")
            .args([&format!("--config-file={}", conf.display()), "--nofork", "--nopidfile"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().expect("dbus-daemon is required (no skip, no fake)");
        for _ in 0..100 { if sock.exists() { break; } std::thread::sleep(Duration::from_millis(30)); }
        Bus { child, address, dir }
    }
}
impl Drop for Bus {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); let _ = std::fs::remove_dir_all(&self.dir); }
}

/// What the fake Spotify remembers and was asked.
struct Fake { calls: Arc<Mutex<Vec<String>>>, playing: bool, position: i64, shuffle: bool, volume: f64, conn: std::sync::OnceLock<Connection> }

#[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
impl Fake {
    fn play_pause(&mut self) {
        self.calls.lock().unwrap().push("PlayPause".into());
        self.playing = !self.playing;
        self.position += 1_000_000;
        let conn = self.conn.get().unwrap().clone();
        let status = if self.playing { "Playing" } else { "Paused" };
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            let mut changed: HashMap<&str, Value<'_>> = HashMap::new();
            changed.insert("PlaybackStatus", Value::from(status));
            let _ = conn.emit_signal(None::<&str>, "/org/mpris/MediaPlayer2", "org.freedesktop.DBus.Properties", "PropertiesChanged",
                &("org.mpris.MediaPlayer2.Player", changed, Vec::<String>::new()));
        });
    }
    fn next(&self) { self.calls.lock().unwrap().push("Next".into()); }
    fn previous(&self) { self.calls.lock().unwrap().push("Previous".into()); }
    fn set_position(&mut self, track: ObjectPath<'_>, us: i64) {
        self.calls.lock().unwrap().push(format!("SetPosition {track} {us}"));
        self.position = us;
    }
    #[zbus(property)]
    fn shuffle(&self) -> bool { self.shuffle }
    #[zbus(property)]
    fn set_shuffle(&mut self, on: bool) { self.calls.lock().unwrap().push(format!("Shuffle {on}")); self.shuffle = on; }
    #[zbus(property)]
    fn volume(&self) -> f64 { self.volume }
    #[zbus(property)]
    fn set_volume(&mut self, v: f64) { self.calls.lock().unwrap().push(format!("Volume {v}")); self.volume = v; }
    #[zbus(property)]
    fn loop_status(&self) -> String { "None".into() }
    #[zbus(property)]
    fn set_loop_status(&mut self, v: String) { self.calls.lock().unwrap().push(format!("Loop {v}")); }
    #[zbus(property)]
    fn playback_status(&self) -> String { if self.playing { "Playing" } else { "Paused" }.into() }
    #[zbus(property)]
    fn position(&self) -> i64 { self.position }
    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, OwnedValue> {
        let mut m: HashMap<String, OwnedValue> = HashMap::new();
        m.insert("mpris:trackid".into(), Value::from(ObjectPath::try_from("/com/spotify/track/fake1").unwrap()).try_into().unwrap());
        m.insert("mpris:length".into(), Value::from(180_000_000u64).try_into().unwrap());
        m.insert("xesam:title".into(), Value::from("Fake Song (Live)").try_into().unwrap());
        m.insert("xesam:artist".into(), Value::from(vec!["Fake Artist".to_string(), "Guest".to_string()]).try_into().unwrap());
        m.insert("xesam:album".into(), Value::from("Fake Album").try_into().unwrap());
        m
    }
}

fn fake(bus: &Bus, calls: Arc<Mutex<Vec<String>>>) -> Connection {
    let conn = connection::Builder::address(bus.address.as_str()).unwrap()
        .serve_at("/org/mpris/MediaPlayer2", Fake { calls, playing: true, position: 30_000_000, shuffle: false, volume: 0.8, conn: Default::default() })
        .unwrap().name("org.mpris.MediaPlayer2.spotify").unwrap().build().unwrap();
    let iface = conn.object_server().interface::<_, Fake>("/org/mpris/MediaPlayer2").unwrap();
    iface.get().conn.set(conn.clone()).ok();
    conn
}

fn client(bus: &Bus) -> (Client, mpsc::Receiver<PlayerState>) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    (Client::new(Some(&bus.address), move |s| { let _ = tx.lock().unwrap().send(s.clone()); }), rx)
}

fn until(rx: &mpsc::Receiver<PlayerState>, ok: impl Fn(&PlayerState) -> bool) -> PlayerState {
    let end = std::time::Instant::now() + Duration::from_secs(4);
    loop {
        let left = end.saturating_duration_since(std::time::Instant::now());
        let s = rx.recv_timeout(left).expect("the state the test waits for");
        if ok(&s) { return s; }
    }
}

#[test]
fn it_follows_and_drives_a_fake_spotify() {
    let bus = Bus::start();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let spotify = fake(&bus, calls.clone());
    let (client, rx) = client(&bus);

    // Not started: controls refuse.
    assert!(!client.control(Action::Next));

    client.start();
    let s = until(&rx, |s| s.running && s.track.is_some());
    let t = s.track.clone().unwrap();
    assert_eq!((t.id.as_str(), t.title.as_str(), t.artist.as_str()), ("spotify:track:fake1", "Fake Song", "Fake Artist, Guest"));
    assert_eq!(t.duration, 180.0);
    assert!(s.playing);
    assert_eq!(s.volume, 80);
    assert_eq!(s.position, 30.0);

    // A control goes out; Spotify's PropertiesChanged comes back and the position is re-read.
    assert!(client.control(Action::PlayPause));
    let s = until(&rx, |s| !s.playing);
    assert_eq!(s.position, 31.0);

    assert!(client.control(Action::Next));
    assert!(client.control(Action::Previous));
    assert!(client.control(Action::Seek(60.0)));
    assert_eq!(until(&rx, |s| s.position == 60.0).position, 60.0);
    assert!(client.control(Action::Shuffle(true)));
    assert!(until(&rx, |s| s.shuffle).shuffle);
    assert!(client.control(Action::Volume(25)));
    assert_eq!(until(&rx, |s| s.volume == 25).volume, 25);
    assert!(client.control(Action::Repeat(true)));
    assert!(client.refresh().is_some());
    assert!(!client.control(Action::View), "view/stop are not controls");
    assert_eq!(
        *calls.lock().unwrap(),
        vec!["PlayPause", "Next", "Previous", "SetPosition /com/spotify/track/fake1 60000000", "Shuffle true", "Volume 0.25", "Loop Playlist"]
    );

    // Spotify quits: nothing plays any more and controls refuse.
    spotify.release_name("org.mpris.MediaPlayer2.spotify").unwrap();
    let s = until(&rx, |s| !s.running);
    assert_eq!(s.track, None);
    assert!(!client.control(Action::Next));

    // Stopped: it says so and the controls refuse; a second stop is a no-op.
    client.stop();
    assert!(!client.active());
    assert_eq!(until(&rx, |s| !s.running).track, None);
    assert!(!client.control(Action::Next));
    client.stop();
}

#[test]
fn it_picks_up_spotify_that_starts_after_the_listener() {
    let bus = Bus::start();
    let (client, rx) = client(&bus);
    client.start();
    assert!(!client.control(Action::Next), "no Spotify yet");
    let calls = Arc::new(Mutex::new(Vec::new()));
    let _spotify = fake(&bus, calls);
    let s = until(&rx, |s| s.running && s.track.is_some());
    assert_eq!(s.track.unwrap().title, "Fake Song");
    client.stop();
}

#[test]
fn a_foreign_peer_cannot_impersonate_spotify() {
    let bus = Bus::start();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let _spotify = fake(&bus, calls);
    let (client, rx) = client(&bus);
    client.start();
    until(&rx, |s| s.running && s.track.is_some());
    // Another peer broadcasts a forged PropertiesChanged: it must not move the state.
    let evil = connection::Builder::address(bus.address.as_str()).unwrap().build().unwrap();
    let mut forged: HashMap<&str, Value<'_>> = HashMap::new();
    forged.insert("Volume", Value::from(0.01f64));
    evil.emit_signal(None::<&str>, "/org/mpris/MediaPlayer2", "org.freedesktop.DBus.Properties", "PropertiesChanged",
        &("org.mpris.MediaPlayer2.Player", forged, Vec::<String>::new())).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(client.state().volume, 80);
    client.stop();
}

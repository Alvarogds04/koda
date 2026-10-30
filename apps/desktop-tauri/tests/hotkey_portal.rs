//! #305b: the portal client against a FAKE xdg-desktop-portal on a PRIVATE session
//! bus (`dbus-daemon`, its own socket). The human's bus and keyboard are never used.
//! The fake follows the documented Request/Response protocol, including the OS
//! permission dialog (accept / decline / never answered).
#![cfg(target_os = "linux")] // Requires the Linux private-bus D-Bus runner.
use abito_island::hotkey::{portal::client::{probe, PortalGrabber, PortalHub}, portal::{bind_requests, route_activation, PortalState, ShortcutSignal, SHORTCUT_ID}, Combo, Status};
use std::collections::HashMap;
use std::os::unix::fs::DirBuilderExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;
use zbus::blocking::{connection, Connection};
use zbus::object_server::SignalEmitter;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};

struct Bus { child: Child, address: String, _dir: std::path::PathBuf }
impl Bus {
    fn start() -> Bus {
        static N: AtomicU32 = AtomicU32::new(0);
        // a SHORT private dir: sockaddr_un caps a socket path at 107 bytes and this worktree's path is long
        let dir = std::path::PathBuf::from(std::env::var("HOME").expect("HOME")).join(format!(".abus{}-{}", std::process::id() % 100000, N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
        let sock = dir.join("s");
        let address = format!("unix:path={}", sock.display());
        // A bare config with NO <servicedir>: `--session` alone loads the system's activatable services,
        // so on a machine with xdg-desktop-portal installed the "missing portal" bus auto-starts the real one.
        let conf = dir.join("bus.conf");
        std::fs::write(&conf, format!("<!DOCTYPE busconfig PUBLIC \"-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN\" \"http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd\"><busconfig><type>session</type><listen>{address}</listen><auth>EXTERNAL</auth><policy context=\"default\"><allow send_destination=\"*\" eavesdrop=\"true\"/><allow eavesdrop=\"true\"/><allow own=\"*\"/></policy></busconfig>", address = address)).expect("write bus config");
        let child = Command::new("dbus-daemon").args([&format!("--config-file={}", conf.display()), "--nofork", "--nopidfile"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("dbus-daemon is required (no skip, no fake)");
        for _ in 0..100 { if sock.exists() { break; } std::thread::sleep(Duration::from_millis(30)); }
        Bus { child, address, _dir: dir }
    }
}
impl Drop for Bus { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); let _ = std::fs::remove_dir_all(&self._dir); } }

#[derive(Clone, Copy, PartialEq)]
enum Dialog { Accept, Decline, Silent, FailCreate }

struct FakePortal { strict_app_id: bool, version_delay: Duration, dialog: Dialog, binds: Arc<std::sync::Mutex<Vec<(String, String)>>>, conn: std::sync::OnceLock<Connection>, state: Arc<ServerState> }

/// Everything one fake portal remembers; NEVER shared between tests running in parallel.
#[derive(Default)]
struct ServerState { trigger_overrides: std::sync::Mutex<HashMap<String, String>>, bind_calls: std::sync::Mutex<Vec<Vec<String>>>, descriptions: std::sync::Mutex<HashMap<String, String>>, active_session: std::sync::Mutex<Option<String>>, last_sender: std::sync::Mutex<String>, registered: std::sync::Mutex<HashMap<String, String>> }

#[zbus::interface(name = "org.freedesktop.portal.GlobalShortcuts")]
impl FakePortal {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 { std::thread::sleep(self.version_delay); 1 }

    fn create_session(&self, #[zbus(header)] hdr: zbus::message::Header<'_>, options: HashMap<String, OwnedValue>) -> zbus::fdo::Result<OwnedObjectPath> {
        // Like GNOME's portal: a caller with no app id is refused ("An app id is required").
        let caller = hdr.sender().map(|s| s.to_string()).unwrap_or_default();
        if self.strict_app_id && !self.state.registered.lock().unwrap().contains_key(&caller) {
            return Err(zbus::fdo::Error::AccessDenied("An app id is required".into()));
        }
        if let Some(sender) = hdr.sender() { *self.state.last_sender.lock().unwrap() = sender.as_str().trim_start_matches(':').replace('.', "_"); }
        let token: String = options.get("handle_token").and_then(|v| String::try_from(v.try_clone().ok()?).ok()).unwrap();
        let sess_tok: String = options.get("session_handle_token").and_then(|v| String::try_from(v.try_clone().ok()?).ok()).unwrap();
        let conn = self.conn.get().unwrap().clone();
        let path = format!("/org/freedesktop/portal/desktop/request/{}/{}", self.state.last_sender.lock().unwrap().clone(), token);
        let session = format!("/org/freedesktop/portal/desktop/session/{}/{}", self.state.last_sender.lock().unwrap().clone(), sess_tok);
        let dialog = self.dialog;
        let p2 = path.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            let code = if dialog == Dialog::FailCreate { 2u32 } else { 0 };
            let mut results: HashMap<&str, Value<'_>> = HashMap::new();
            results.insert("session_handle", Value::from(session.as_str()));
            let _ = conn.emit_signal(None::<&str>, ObjectPath::try_from(p2.as_str()).unwrap(), "org.freedesktop.portal.Request", "Response", &(code, results));
        });
        Ok(OwnedObjectPath::try_from(path).unwrap())
    }

    fn bind_shortcuts(&self, #[zbus(header)] hdr: zbus::message::Header<'_>, session: ObjectPath<'_>, shortcuts: Vec<(String, HashMap<String, OwnedValue>)>, _parent: String, options: HashMap<String, OwnedValue>) -> OwnedObjectPath {
        if let Some(sender) = hdr.sender() { *self.state.last_sender.lock().unwrap() = sender.as_str().trim_start_matches(':').replace('.', "_"); }
        let token: String = options.get("handle_token").and_then(|v| String::try_from(v.try_clone().ok()?).ok()).unwrap();
        let mut answered: Vec<(String, HashMap<String, Value<'static>>)> = Vec::new();
        self.state.bind_calls.lock().unwrap().push(shortcuts.iter().map(|(id, _)| id.clone()).collect());
        for (id, props) in &shortcuts {
            let trigger: String = props.get("preferred_trigger").and_then(|v| String::try_from(v.try_clone().ok()?).ok()).unwrap_or_default();
            self.binds.lock().unwrap().push((id.clone(), trigger.clone()));
            let description=props.get("description").and_then(|v|String::try_from(v.try_clone().ok()?).ok()).unwrap_or_default();
            self.state.descriptions.lock().unwrap().insert(id.clone(),description);
            // like GNOME: the combination the HUMAN picked wins over the preferred one
            let shown = self.state.trigger_overrides.lock().unwrap().get(id).cloned().unwrap_or(trigger);
            let mut p: HashMap<String, Value<'static>> = HashMap::new();
            p.insert("trigger_description".into(), Value::from(shown));
            answered.push((id.clone(), p));
        }
        let conn = self.conn.get().unwrap().clone();
        let path = format!("/org/freedesktop/portal/desktop/request/{}/{}", self.state.last_sender.lock().unwrap().clone(), token);
        let dialog = self.dialog;
        let st = self.state.clone();
        let p2 = path.clone();
        let session = session.to_string();
        std::thread::spawn(move || {
            // the OS permission dialog: the human takes a moment
            std::thread::sleep(Duration::from_millis(250));
            let code = match dialog { Dialog::Accept => 0u32, Dialog::Decline => 1, Dialog::Silent => return, Dialog::FailCreate => 2 };
            let mut results: HashMap<&str, Value<'_>> = HashMap::new();
            if code == 0 { results.insert("shortcuts", Value::from(answered)); }
            let _ = conn.emit_signal(None::<&str>, ObjectPath::try_from(p2.as_str()).unwrap(), "org.freedesktop.portal.Request", "Response", &(code, results));
            if code == 0 { st.active_session.lock().unwrap().replace(session); }
        });
        OwnedObjectPath::try_from(path).unwrap()
    }
}


/// `org.freedesktop.host.portal.Registry`: how a NON-sandboxed app tells the portal its app id (the id of its .desktop).
struct FakeRegistry { state: Arc<ServerState> }
#[zbus::interface(name = "org.freedesktop.host.portal.Registry")]
impl FakeRegistry {
    fn register(&self, #[zbus(header)] hdr: zbus::message::Header<'_>, app_id: String, _options: HashMap<String, OwnedValue>) -> zbus::fdo::Result<()> {
        let caller = hdr.sender().map(|s| s.to_string()).unwrap_or_default();
        let mut known = self.state.registered.lock().unwrap();
        if known.contains_key(&caller) { return Err(zbus::fdo::Error::Failed("Connection already associated with an application ID".into())); }
        known.insert(caller, app_id);
        Ok(())
    }
}

fn serve(bus: &Bus, dialog: Dialog) -> (Connection, Arc<std::sync::Mutex<Vec<(String, String)>>>) {
    serve_slow(bus, dialog, Duration::ZERO)
}

fn serve_slow(bus: &Bus, dialog: Dialog, version_delay: Duration) -> (Connection, Arc<std::sync::Mutex<Vec<(String, String)>>>) {
    let binds = Arc::new(std::sync::Mutex::new(Vec::new()));
    let state = Arc::new(ServerState::default());
    STATES.lock().unwrap().insert(bus.address.clone(), state.clone());
    let registry_state = state.clone();
    let portal = FakePortal { strict_app_id: true, version_delay, dialog, binds: binds.clone(), conn: std::sync::OnceLock::new(), state };
    let conn = connection::Builder::address(bus.address.as_str()).unwrap().name("org.freedesktop.portal.Desktop").unwrap()
        .serve_at("/org/freedesktop/portal/desktop", portal).unwrap()
        .serve_at("/org/freedesktop/portal/desktop", FakeRegistry { state: registry_state }).unwrap().build().unwrap();
    let iface = conn.object_server().interface::<_, FakePortal>("/org/freedesktop/portal/desktop").unwrap();
    let _ = iface.get().conn.set(conn.clone());
    (conn, binds)
}

static STATES: std::sync::LazyLock<std::sync::Mutex<HashMap<String, Arc<ServerState>>>> = std::sync::LazyLock::new(Default::default);
/// The session a given private bus currently has bound (per bus, so parallel tests never collide).
fn active_session(bus: &Bus) -> Option<String> { STATES.lock().unwrap().get(&bus.address)?.active_session.lock().unwrap().clone() }

/// Fire `Activated` for `id` the way the portal does, for the bus's bound session.
fn activate(conn: &Connection, id: &str) {
    let session = ACTIVE_NOW.with(|c| c.borrow().clone()).expect("a bound session");
    let opts: HashMap<&str, Value<'_>> = HashMap::new();
    conn.emit_signal(None::<&str>, "/org/freedesktop/portal/desktop", "org.freedesktop.portal.GlobalShortcuts", "Activated",
        &(ObjectPath::try_from(session.as_str()).unwrap(), id, 12345u64, opts)).unwrap();
}

#[test]
fn probe_distinguishes_an_available_portal_from_a_missing_one() {
    let bus = Bus::start();
    assert_eq!(probe(Some(&bus.address)), PortalState::Unavailable, "no portal on the bus yet");
    let _srv = serve(&bus, Dialog::Accept);
    assert_eq!(probe(Some(&bus.address)), PortalState::Available);
    assert_eq!(probe(Some("unix:path=/nonexistent/bus")), PortalState::Unavailable, "no bus at all is a quiet Unavailable");
}

thread_local! { static ACTIVE_NOW: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) }; }
fn remember(bus: &Bus) { let s = active_session(bus); ACTIVE_NOW.with(|c| *c.borrow_mut() = s); }
fn wait_status(g: &PortalGrabber, want: Status, ms: u64) -> bool {
    let end = std::time::Instant::now() + Duration::from_millis(ms);
    while std::time::Instant::now() < end { if g.status() == want { return true; } std::thread::sleep(Duration::from_millis(20)); }
    false
}
fn start(bus: &Bus, combo: &str) -> (PortalGrabber, mpsc::Receiver<()>) {
    let (tx, rx) = mpsc::channel();
    let g = PortalGrabber::start(Some(&bus.address), Combo::parse(combo).unwrap(), move || { let _ = tx.send(()); });
    (g, rx)
}

#[test]
fn accepting_the_os_dialog_binds_our_shortcut_and_activation_toggles_once() {
    let bus = Bus::start();
    let (srv_conn, binds) = serve(&bus, Dialog::Accept);
    let (g, rx) = start(&bus, "Ctrl+Alt+A");
    assert!(wait_status(&g, Status::PermissionPending, 1500) || g.status() == Status::Active, "the OS dialog is open: tell the human");
    assert!(wait_status(&g, Status::Active, 3000), "accepted once → active; got {:?}", g.status());
    remember(&bus);
    assert_eq!(binds.lock().unwrap().as_slice(), &[(SHORTCUT_ID.to_string(), "CTRL+ALT+a".to_string())], "the configured combo is what the portal is asked for");
    activate(&srv_conn, SHORTCUT_ID);
    rx.recv_timeout(Duration::from_secs(3)).expect("our activation reaches the island");
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    activate(&srv_conn, "someone-else");
    assert!(rx.recv_timeout(Duration::from_millis(400)).is_err(), "another app's shortcut never toggles the island");
    g.stop();
}

#[test]
fn declining_the_os_dialog_is_reported_not_hidden() {
    let bus = Bus::start();
    let _srv = serve(&bus, Dialog::Decline);
    let (g, rx) = start(&bus, "Ctrl+Alt+A");
    assert!(wait_status(&g, Status::PermissionDenied, 3000), "got {:?}", g.status());
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    g.stop();
}

#[test]
fn a_dialog_nobody_answers_stays_pending_and_never_pretends_to_be_active() {
    let bus = Bus::start();
    let _srv = serve(&bus, Dialog::Silent);
    let (g, _rx) = start(&bus, "Ctrl+Alt+A");
    std::thread::sleep(Duration::from_millis(900));
    assert_eq!(g.status(), Status::PermissionPending);
    g.stop();
}

#[test]
fn a_portal_that_fails_session_creation_is_unsupported() {
    let bus = Bus::start();
    let _srv = serve(&bus, Dialog::FailCreate);
    let (g, _rx) = start(&bus, "Ctrl+Alt+A");
    assert!(wait_status(&g, Status::Unsupported, 3000), "got {:?}", g.status());
    g.stop();
}

#[test]
fn no_bus_means_unsupported_without_panicking() {
    let g = PortalGrabber::start(Some("unix:path=/nonexistent/bus"), Combo::default_combo(), || {});
    assert!(wait_status(&g, Status::Unsupported, 3000), "got {:?}", g.status());
    g.stop();
}

/// READ-ONLY check against the human's REAL session bus: is the portal there and does it
/// speak GlobalShortcuts? It asks for NO permission (no CreateSession/BindShortcuts), so
/// the OS dialog never opens. Skipped (loudly) when there is no session bus at all.
#[test]
fn the_real_session_portal_is_probed_read_only() {
    let state = probe(None);
    eprintln!("real session portal GlobalShortcuts: {state:?}");
    assert!(matches!(state, PortalState::Available | PortalState::Unavailable));
}

/// `Activated` for an explicit session handle, emitted from `conn` (not necessarily the portal).
fn activate_as(conn: &Connection, session: &str, id: &str) {
    let opts: HashMap<&str, Value<'_>> = HashMap::new();
    conn.emit_signal(None::<&str>, "/org/freedesktop/portal/desktop", "org.freedesktop.portal.GlobalShortcuts", "Activated",
        &(ObjectPath::try_from(session).unwrap(), id, 1u64, opts)).unwrap();
}
fn other_client(bus: &Bus) -> Connection {
    connection::Builder::address(bus.address.as_str()).unwrap().build().unwrap()
}

#[test]
fn an_activation_for_another_session_never_toggles_our_island() {
    let bus = Bus::start();
    let (srv, _b) = serve(&bus, Dialog::Accept);
    let (g, rx) = start(&bus, "Ctrl+Alt+A");
    assert!(wait_status(&g, Status::Active, 3000));
    remember(&bus);
    // same shortcut id, but a DIFFERENT session handle (another app's session)
    activate_as(&srv, "/org/freedesktop/portal/desktop/session/1_999/someone_elses", SHORTCUT_ID);
    assert!(rx.recv_timeout(Duration::from_millis(500)).is_err(), "another session's activation must be ignored");
    // ours still works
    activate(&srv, SHORTCUT_ID);
    rx.recv_timeout(Duration::from_secs(3)).expect("our own session still toggles");
    g.stop();
}

#[test]
fn an_activation_emitted_by_a_client_that_is_not_the_portal_is_ignored() {
    let bus = Bus::start();
    let (srv, _b) = serve(&bus, Dialog::Accept);
    let (g, rx) = start(&bus, "Ctrl+Alt+A");
    assert!(wait_status(&g, Status::Active, 3000));
    remember(&bus);
    let session = active_session(&bus).unwrap();
    let impostor = other_client(&bus);
    activate_as(&impostor, &session, SHORTCUT_ID); // right session, right id, WRONG sender
    assert!(rx.recv_timeout(Duration::from_millis(500)).is_err(), "only the owner of org.freedesktop.portal.Desktop may activate");
    activate(&srv, SHORTCUT_ID);
    rx.recv_timeout(Duration::from_secs(3)).expect("the real portal still works");
    g.stop();
}

#[test]
fn after_a_rebind_the_old_session_cannot_fire_and_the_new_one_fires_once() {
    let bus = Bus::start();
    let (srv, _b) = serve(&bus, Dialog::Accept);
    let (g1, rx1) = start(&bus, "Ctrl+Alt+A");
    assert!(wait_status(&g1, Status::Active, 3000));
    let old_session = active_session(&bus).unwrap();
    g1.stop();
    let (g2, rx2) = start(&bus, "Ctrl+Alt+B");
    assert!(wait_status(&g2, Status::Active, 3000));
    let new_session = active_session(&bus).unwrap();
    assert_ne!(old_session, new_session);
    activate_as(&srv, &old_session, SHORTCUT_ID);
    assert!(rx2.recv_timeout(Duration::from_millis(500)).is_err(), "the OLD combination (old session) must not toggle through the new grabber");
    assert!(rx1.recv_timeout(Duration::from_millis(200)).is_err(), "and the stopped grabber stays silent");
    activate_as(&srv, &new_session, SHORTCUT_ID);
    rx2.recv_timeout(Duration::from_secs(3)).expect("the new combination fires");
    assert!(rx2.recv_timeout(Duration::from_millis(300)).is_err(), "exactly once");
    g2.stop();
}

#[test]
fn a_slow_portal_cannot_freeze_the_caller_probe_is_time_boxed() {
    use abito_island::hotkey::portal::client::probe_with_timeout;
    let bus = Bus::start();
    let _srv = serve_slow(&bus, Dialog::Accept, Duration::from_secs(4));
    let t0 = std::time::Instant::now();
    let state = probe_with_timeout(Some(&bus.address), Duration::from_millis(400));
    assert_eq!(state, PortalState::Unavailable, "no answer in time = unavailable, the X11 grab covers it");
    assert!(t0.elapsed() < Duration::from_secs(2), "returned at the cap, not when the portal finally answered: {:?}", t0.elapsed());
    // a prompt portal still answers inside the cap
    let bus2 = Bus::start();
    let _srv2 = serve(&bus2, Dialog::Accept);
    assert_eq!(probe_with_timeout(Some(&bus2.address), Duration::from_secs(2)), PortalState::Available);
}


/// L42: GNOME's portal refuses CreateSession from a connection with no app id ("An app id is required"). Abito never
/// registered one, so on GNOME Wayland the portal answered NotAllowed, the shortcut fell back to the limited X11 grab
/// (which sees no keys while another app has the focus) and the human's global shortcut never worked. The client now
/// registers its app id (the id of the installed .desktop) with org.freedesktop.host.portal.Registry first.
#[test]
fn the_client_registers_its_app_id_so_a_strict_portal_accepts_the_session() {
    let bus = Bus::start();
    let (srv_conn, _binds) = serve(&bus, Dialog::Accept);
    let (g, rx) = start(&bus, "Ctrl+Alt+A");
    assert!(wait_status(&g, Status::Active, 4000), "a strict portal needs the app id: got {:?}", g.status());
    remember(&bus);
    let registered: Vec<String> = STATES.lock().unwrap().get(&bus.address).unwrap().registered.lock().unwrap().values().cloned().collect();
    assert_eq!(registered, vec!["com.abitog.AbitoTauri".to_string()], "exactly Abito's own id, once");
    activate(&srv_conn, SHORTCUT_ID);
    rx.recv_timeout(Duration::from_secs(3)).expect("and the activation reaches the island");
    g.stop();
}

#[test]
fn a_portal_without_the_registry_still_works_like_before() {
    // Older portals (and the Flatpak/systemd cases where the id is already known) have no Registry or refuse a second
    // registration: that is never a failure of the shortcut, the session is created regardless.
    let bus = Bus::start();
    let binds = Arc::new(std::sync::Mutex::new(Vec::new()));
    let state = Arc::new(ServerState::default());
    STATES.lock().unwrap().insert(bus.address.clone(), state.clone());
    let portal = FakePortal { strict_app_id: false, version_delay: Duration::ZERO, dialog: Dialog::Accept, binds, conn: std::sync::OnceLock::new(), state };
    let conn = connection::Builder::address(bus.address.as_str()).unwrap().name("org.freedesktop.portal.Desktop").unwrap()
        .serve_at("/org/freedesktop/portal/desktop", portal).unwrap().build().unwrap();
    let iface = conn.object_server().interface::<_, FakePortal>("/org/freedesktop/portal/desktop").unwrap();
    let _ = iface.get().conn.set(conn.clone());
    let (g, _rx) = start(&bus, "Ctrl+Alt+A");
    assert!(wait_status(&g, Status::Active, 4000), "no Registry on the bus: the shortcut still binds; got {:?}", g.status());
    g.stop();
}

#[test]
fn every_catalog_action_sends_its_own_human_description_to_the_portal() {
    use abito_island::hotkey::{Target,HotkeyConfig};
    let expected = ["Mostrar u ocultar la isla de Koda", "Enviar Koda al escritorio o traerlo a casa",
        "Abrir el chat de Koda", "Ir al permiso o pregunta pendiente", "Enfocar una terminal abierta",
        "Ir a la siguiente pestaña", "Ir a la pestaña anterior", "Silenciar o activar el sonido de Koda",
        "Abrir o cerrar el guardarropa"];
    let bus=Bus::start();
    let _server=serve(&bus,Dialog::Accept);
    for (target,description) in Target::ALL.into_iter().zip(expected) {
        let grab=PortalGrabber::start_with_id(Some(&bus.address),HotkeyConfig::default_for(target).combo,target.portal_id(),||{});
        assert!(wait_status(&grab,Status::Active,3000),"{:?}",grab.status());
        let server=STATES.lock().unwrap().get(&bus.address).unwrap().clone();
        assert_eq!(server.descriptions.lock().unwrap().get(target.portal_id()).map(String::as_str),Some(description));
        grab.stop();
    }
}

// ---- one session, one BindShortcuts for every enabled target ------------------------------------------
fn hub(bus: &Bus) -> (PortalHub, mpsc::Receiver<String>) {
    let (tx, rx) = mpsc::channel();
    let tx = std::sync::Mutex::new(tx);
    let hub = PortalHub::new(Some(&bus.address), move |id, bound| {
        let sig = ShortcutSignal { shortcut_id: id.to_owned(), activated: true };
        if let Some(target) = route_activation(&sig, bound) { let _ = tx.lock().unwrap().send(target.id().to_owned()); }
    });
    (hub, rx)
}
fn all_targets() -> Vec<(abito_island::hotkey::Target, abito_island::hotkey::HotkeyConfig)> {
    abito_island::hotkey::Target::ALL.into_iter().map(|t| (t, abito_island::hotkey::HotkeyConfig::default_for(t))).collect()
}
fn hub_wait(h: &PortalHub, want: Status, ms: u64) -> bool {
    let end = std::time::Instant::now() + Duration::from_millis(ms);
    while std::time::Instant::now() < end { if h.status() == want { return true; } std::thread::sleep(Duration::from_millis(20)); }
    false
}

#[test]
fn every_enabled_target_is_bound_in_one_bind_call_of_one_session() {
    let bus = Bus::start();
    let (srv, _binds) = serve(&bus, Dialog::Accept);
    let (h, rx) = hub(&bus);
    h.apply(bind_requests(&all_targets()), false);
    assert!(hub_wait(&h, Status::Active, 4000), "{:?}", h.status());
    let state = STATES.lock().unwrap().get(&bus.address).unwrap().clone();
    let calls = state.bind_calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1, "ONE BindShortcuts for the whole set (one OS dialog), not one per target");
    assert_eq!(calls[0], abito_island::hotkey::Target::ALL.iter().map(|t| t.portal_id().to_string()).collect::<Vec<_>>());
    remember(&bus);
    for t in abito_island::hotkey::Target::ALL {
        activate(&srv, t.portal_id());
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).as_deref(), Ok(t.id()), "the press reaches the target that owns the id");
    }
    activate(&srv, "someone-else");
    assert!(rx.recv_timeout(Duration::from_millis(400)).is_err(), "an unknown id fires nothing");
    h.stop();
}

#[test]
fn applying_the_same_set_again_keeps_the_session_and_never_asks_twice() {
    let bus = Bus::start();
    let _srv = serve(&bus, Dialog::Accept);
    let (h, _rx) = hub(&bus);
    h.apply(bind_requests(&all_targets()), false);
    assert!(hub_wait(&h, Status::Active, 4000));
    h.apply(bind_requests(&all_targets()), true);
    std::thread::sleep(Duration::from_millis(500));
    let state = STATES.lock().unwrap().get(&bus.address).unwrap().clone();
    assert_eq!(state.bind_calls.lock().unwrap().len(), 1, "an identical set is a no-op");
    assert_eq!(h.status(), Status::Active);
    let mut fewer = all_targets();
    fewer[1].1.enabled = false;
    h.apply(bind_requests(&fewer), false);
    assert!(hub_wait(&h, Status::Active, 4000));
    let calls = state.bind_calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 2);
    assert!(!calls[1].contains(&abito_island::hotkey::Target::DesktopToggle.portal_id().to_string()), "a disabled target is not bound");
    h.stop();
}

#[test]
fn the_trigger_the_human_picked_in_the_os_is_read_back() {
    let bus = Bus::start();
    let _srv = serve(&bus, Dialog::Accept);
    STATES.lock().unwrap().get(&bus.address).unwrap().trigger_overrides.lock().unwrap().insert(SHORTCUT_ID.into(), "Ctrl+Shift+N".into());
    let (h, _rx) = hub(&bus);
    assert_eq!(h.effective_trigger(SHORTCUT_ID), None, "nothing is claimed before the OS answered");
    h.apply(bind_requests(&all_targets()), false);
    assert!(hub_wait(&h, Status::Active, 4000));
    assert_eq!(h.effective_trigger(SHORTCUT_ID).as_deref(), Some("Ctrl+Shift+N"));
    assert_eq!(h.effective_trigger(abito_island::hotkey::Target::DesktopToggle.portal_id()).as_deref(), Some("CTRL+ALT+d"));
    h.stop();
}

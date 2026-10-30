//! The D-Bus half of the portal backend: `CreateSession` → `BindShortcuts` →
//! listen for `Activated`. Blocking `zbus`, its own thread, never panics.
//!
//! The OS shows a permission dialog on the first `BindShortcuts`: the human must
//! accept ONCE. Until the Response arrives the status is `PermissionPending`; a
//! declined dialog is `PermissionDenied` (visible, and the caller falls back).
use super::{outcome_of_response, request_path, token, BindRequest, Outcome, PortalState, SHORTCUT_ID};
use crate::hotkey::{Combo, Status};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zbus::blocking::{Connection, MessageIterator, Proxy};
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};

const DEST: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const IFACE: &str = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST_IFACE: &str = "org.freedesktop.portal.Request";
/// `org.freedesktop.host.portal.Registry`: how an app that is NOT sandboxed tells the portal its app id.
const REGISTRY_IFACE: &str = "org.freedesktop.host.portal.Registry";
/// The id of Abito's installed `.desktop` (`com.abitog.AbitoTauri.desktop`, the tauri identifier).
const APP_ID: &str = "com.abitog.AbitoTauri";

/// GNOME's portal refuses a `GlobalShortcuts.CreateSession` from a connection with no app id ("An app id is
/// required"), and a process started from a `.desktop` file is not given one. Without this the session was
/// refused, the shortcut fell back to the limited X11 grab (blind while another app has the focus on Wayland)
/// and the human's global shortcut never worked. Best effort: an older portal without the Registry, an id the
/// portal already knows (Flatpak, systemd scope) or a `.desktop` it cannot find all answer an error, and none of
/// those is a reason to give up the session: it is attempted exactly as before.
fn register_app_id(conn: &Connection) {
    if let Ok(registry) = Proxy::new(conn, DEST, PATH, REGISTRY_IFACE) {
        let options: HashMap<&str, Value<'_>> = HashMap::new();
        let _: zbus::Result<()> = registry.call("Register", &(APP_ID, options));
    }
}
/// How long the human gets to answer the OS dialog before we stop waiting.
pub const PERMISSION_WAIT: Duration = Duration::from_secs(120);

const S_PENDING: u8 = 1;
const S_ACTIVE: u8 = 2;
const S_DENIED: u8 = 3;
const S_UNSUPPORTED: u8 = 4;

/// How long startup may wait for the portal to say it exists.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Is the portal reachable and does it implement GlobalShortcuts? (No permission asked.)
pub fn probe(bus_address: Option<&str>) -> PortalState {
    probe_with_timeout(bus_address, PROBE_TIMEOUT)
}

/// Same, with a hard cap: the D-Bus call runs on its own thread and the caller returns at
/// the cap with `Unavailable` (a portal that answers `version` in 40 s must not freeze the
/// island at startup; the X11 grab covers the shortcut meanwhile).
pub fn probe_with_timeout(bus_address: Option<&str>, cap: Duration) -> PortalState {
    let (tx, rx) = std::sync::mpsc::channel();
    let addr = bus_address.map(str::to_owned);
    std::thread::spawn(move || {
        let state = (|| {
            let conn = connect(addr.as_deref()).ok()?;
            let proxy = Proxy::new(&conn, DEST, PATH, IFACE).ok()?;
            proxy.get_property::<u32>("version").ok().filter(|v| *v >= 1).map(|_| PortalState::Available)
        })()
        .unwrap_or(PortalState::Unavailable);
        let _ = tx.send(state);
    });
    rx.recv_timeout(cap).unwrap_or(PortalState::Unavailable)
}

/// The unique name that currently owns `org.freedesktop.portal.Desktop`: the ONLY sender
/// whose `Activated` signals we believe.
fn portal_owner(conn: &Connection) -> Option<String> {
    let dbus = zbus::blocking::fdo::DBusProxy::new(conn).ok()?;
    let name = zbus::names::BusName::try_from(DEST).ok()?;
    dbus.get_name_owner(name).ok().map(|o| o.to_string())
}

fn connect(bus_address: Option<&str>) -> zbus::Result<Connection> {
    match bus_address {
        Some(addr) => zbus::blocking::connection::Builder::address(addr)?.build(),
        None => Connection::session(),
    }
}

fn call_request(conn: &Connection, proxy: &Proxy<'_>, method: &str, body: &(impl serde::Serialize + zbus::zvariant::DynamicType), handle_token: &str, deadline: Instant, stop: &AtomicBool) -> Option<(u32, HashMap<String, OwnedValue>)> {
    let unique = conn.unique_name()?.to_string();
    let expected = request_path(&unique, handle_token);
    // subscribe BEFORE calling, or a fast Response is lost
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface(REQUEST_IFACE).ok()?
        .member("Response").ok()?
        .path(expected.clone()).ok()?
        .build();
    let mut it = MessageIterator::for_match_rule(rule, conn, Some(8)).ok()?;
    let reply: OwnedObjectPath = proxy.call(method, body).ok()?;
    // portals older than 0.9 may return a different path than the predicted one; the match rule
    // above uses the predicted (documented) path, so an unexpected handle is treated as a failure
    if reply.as_str() != expected {
        return None;
    }
    loop {
        if stop.load(Ordering::SeqCst) || Instant::now() >= deadline {
            return None;
        }
        match it.next() {
            Some(Ok(msg)) => {
                if let Ok((code, results)) = msg.body().deserialize::<(u32, HashMap<String, OwnedValue>)>() {
                    return Some((code, results));
                }
            }
            _ => return None,
        }
    }
}

/// What every session thread shares with its hub. A thread of a REPLACED session carries an old
/// `gen`, so it can no longer change the status the human sees.
#[derive(Default)]
struct Shared {
    status: AtomicU8,
    gen: AtomicU64,
    effective: Mutex<HashMap<String, String>>,
    binds: Mutex<Vec<BindRequest>>,
}
impl Shared {
    fn put(&self, gen: u64, s: u8) {
        if self.gen.load(Ordering::SeqCst) == gen {
            self.status.store(s, Ordering::SeqCst);
        }
    }
}

type OnPress = Arc<dyn Fn(&str, &[BindRequest]) + Send + Sync>;

/// ONE portal session carrying EVERY shortcut. The OS remembers the whole set it was handed
/// in a single `BindShortcuts`, so its confirmation dialog shows once and not on every launch
/// (one session per shortcut left the other ids unknown to the OS forever).
/// `apply` is idempotent: the same set keeps the live session; a different set replaces it.
pub struct PortalHub {
    bus_address: Option<String>,
    on_press: OnPress,
    shared: Arc<Shared>,
    running: Mutex<Option<Arc<AtomicBool>>>,
}

impl PortalHub {
    /// `on_press(id, bound)` runs for every activation of an id of OUR session.
    pub fn new(bus_address: Option<&str>, on_press: impl Fn(&str, &[BindRequest]) + Send + Sync + 'static) -> PortalHub {
        PortalHub { bus_address: bus_address.map(str::to_owned), on_press: Arc::new(on_press), shared: Arc::new(Shared::default()), running: Mutex::new(None) }
    }

    /// Make the live session carry exactly `binds`. Same set and a live (or pending) session: nothing
    /// happens, so no second dialog. A failed session is retried only when `retry_failed` (a human action).
    pub fn apply(&self, binds: Vec<BindRequest>, retry_failed: bool) {
        let mut running = self.running.lock().expect("portal hub lock");
        let failed = matches!(self.shared.status.load(Ordering::SeqCst), S_DENIED | S_UNSUPPORTED);
        if running.is_some() && *self.shared.binds.lock().expect("portal binds lock") == binds && (!failed || !retry_failed) {
            return;
        }
        if let Some(old) = running.take() {
            old.store(true, Ordering::SeqCst);
        }
        let gen = self.shared.gen.fetch_add(1, Ordering::SeqCst) + 1;
        self.shared.effective.lock().expect("portal effective lock").clear();
        *self.shared.binds.lock().expect("portal binds lock") = binds.clone();
        if binds.is_empty() {
            self.shared.status.store(S_UNSUPPORTED, Ordering::SeqCst);
            return;
        }
        self.shared.status.store(S_PENDING, Ordering::SeqCst);
        let stop = Arc::new(AtomicBool::new(false));
        *running = Some(stop.clone());
        let (shared, addr, on_press) = (self.shared.clone(), self.bus_address.clone(), self.on_press.clone());
        // detached: it may be parked in a blocking read; it ends with the process or the next signal
        std::thread::spawn(move || run_session(addr.as_deref(), binds, &shared, gen, &stop, &on_press));
    }

    /// Close the session (the keys go back to the OS) and forget the bound set.
    pub fn stop(&self) {
        let mut running = self.running.lock().expect("portal hub lock");
        if let Some(old) = running.take() {
            old.store(true, Ordering::SeqCst);
        }
        self.shared.gen.fetch_add(1, Ordering::SeqCst);
        self.shared.binds.lock().expect("portal binds lock").clear();
        self.shared.effective.lock().expect("portal effective lock").clear();
    }

    pub fn status(&self) -> Status {
        match self.shared.status.load(Ordering::SeqCst) {
            S_PENDING => Status::PermissionPending,
            S_ACTIVE => Status::Active,
            S_DENIED => Status::PermissionDenied,
            _ => Status::Unsupported,
        }
    }

    /// The combination the OS says is bound to `id` (the human may have picked another one than
    /// the one we preferred), as the portal reports it. `None` until the bind was answered.
    pub fn effective_trigger(&self, id: &str) -> Option<String> {
        self.shared.effective.lock().expect("portal effective lock").get(id).cloned()
    }
}

/// `a(sa{sv})` of a `BindShortcuts` / `ListShortcuts` result → `id → trigger_description`.
fn triggers_of(results: &HashMap<String, OwnedValue>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(list) = results.get("shortcuts").and_then(|v| v.try_clone().ok()) else { return out };
    let Ok(list) = <Vec<(String, HashMap<String, OwnedValue>)>>::try_from(list) else { return out };
    for (id, props) in list {
        if let Some(text) = props.get("trigger_description").and_then(|v| <String>::try_from(v.try_clone().ok()?).ok()) {
            if !text.is_empty() {
                out.insert(id, text);
            }
        }
    }
    out
}

fn run_session(bus_address: Option<&str>, binds: Vec<BindRequest>, shared: &Shared, gen: u64, stop: &AtomicBool, on_press: &OnPress) {
    let fail = |s: u8| shared.put(gen, s);
    let Ok(conn) = connect(bus_address) else { return fail(S_UNSUPPORTED) };
    register_app_id(&conn);
    let Ok(proxy) = Proxy::new(&conn, DEST, PATH, IFACE) else { return fail(S_UNSUPPORTED) };
    let deadline = Instant::now() + PERMISSION_WAIT;

    // 1) CreateSession
    let (req_tok, sess_tok) = (token("req"), token("sess"));
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert("handle_token", Value::from(req_tok.as_str()));
    options.insert("session_handle_token", Value::from(sess_tok.as_str()));
    let Some((code, results)) = call_request(&conn, &proxy, "CreateSession", &(options,), &req_tok, deadline, stop) else { return fail(S_UNSUPPORTED) };
    if outcome_of_response(code) != Outcome::Granted {
        return fail(if outcome_of_response(code) == Outcome::Denied { S_DENIED } else { S_UNSUPPORTED });
    }
    let session: String = match results.get("session_handle").and_then(|v| <String>::try_from(v.try_clone().ok()?).ok()) {
        Some(s) => s,
        None => return fail(S_UNSUPPORTED),
    };
    let Ok(session_path) = ObjectPath::try_from(session.as_str()) else { return fail(S_UNSUPPORTED) };

    // subscribe to Activated BEFORE binding so no press is lost
    let act_rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface(IFACE).ok()
        .and_then(|b| b.member("Activated").ok())
        .map(|b| b.build());
    let Some(act_rule) = act_rule else { return fail(S_UNSUPPORTED) };
    let Ok(activations) = MessageIterator::for_match_rule(act_rule, &conn, Some(16)) else { return fail(S_UNSUPPORTED) };

    // 2) ONE BindShortcuts with every shortcut: THIS is where the OS dialog appears (accept once)
    let bind_tok = token("bind");
    let shortcuts: Vec<(&str, HashMap<&str, Value<'_>>)> = binds
        .iter()
        .map(|b| {
            let mut props: HashMap<&str, Value<'_>> = HashMap::new();
            props.insert("description", Value::from(b.description.as_str()));
            props.insert("preferred_trigger", Value::from(b.trigger.as_str()));
            (b.id.as_str(), props)
        })
        .collect();
    let mut bind_opts: HashMap<&str, Value<'_>> = HashMap::new();
    bind_opts.insert("handle_token", Value::from(bind_tok.as_str()));
    shared.put(gen, S_PENDING);
    let Some((code, answer)) = call_request(&conn, &proxy, "BindShortcuts", &(&session_path, shortcuts, "", bind_opts), &bind_tok, deadline, stop) else { return fail(S_UNSUPPORTED) };
    match outcome_of_response(code) {
        Outcome::Granted => {
            if shared.gen.load(Ordering::SeqCst) == gen {
                *shared.effective.lock().expect("portal effective lock") = triggers_of(&answer);
            }
            shared.put(gen, S_ACTIVE)
        }
        Outcome::Denied => return fail(S_DENIED),
        Outcome::Failed => return fail(S_UNSUPPORTED),
    }

    // 3) listen. An activation counts only if it comes from the portal's own bus name AND names OUR
    // session (another app's session, an impostor on the bus, or the session of a previous bind must
    // never fire a shortcut). Which of OUR ids it was is the caller's routing.
    let owner = portal_owner(&conn);
    for msg in activations {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(msg) = msg else { break };
        let sender = msg.header().sender().map(|s| s.to_string());
        if owner.is_none() || sender != owner {
            continue;
        }
        if let Ok((sig_session, sig_id, _ts, _opts)) = msg.body().deserialize::<(OwnedObjectPath, String, u64, HashMap<String, OwnedValue>)>() {
            if sig_session.as_str() == session_path.as_str() {
                on_press(&sig_id, &binds);
            }
        }
    }
}

/// A single-shortcut session, the shape the first backend had; now a one-entry [`PortalHub`].
pub struct PortalGrabber {
    hub: PortalHub,
}

impl PortalGrabber {
    /// Create the session, bind our shortcut (the OS asks the human once) and listen.
    /// `bus_address` None = the user's session bus; Some(addr) = a private bus (tests).
    pub fn start(bus_address: Option<&str>, combo: Combo, on_press: impl Fn() + Send + 'static) -> PortalGrabber {
        Self::start_with_id(bus_address, combo, SHORTCUT_ID, on_press)
    }

    pub fn start_with_id(bus_address: Option<&str>, combo: Combo, id: &str, on_press: impl Fn() + Send + 'static) -> PortalGrabber {
        let own = id.to_owned();
        let on_press = Mutex::new(on_press);
        let hub = PortalHub::new(bus_address, move |fired, _| {
            if super::is_our_activation_for(&super::ShortcutSignal { shortcut_id: fired.to_owned(), activated: true }, &own) {
                (on_press.lock().expect("press callback lock"))();
            }
        });
        let description = crate::hotkey::Target::ALL.into_iter().find(|t| t.portal_id() == id).map(|t| t.description()).unwrap_or("Atajo de Koda");
        hub.apply(vec![BindRequest { id: id.to_owned(), description: description.to_owned(), trigger: combo.portal_trigger() }], false);
        PortalGrabber { hub }
    }

    pub fn status(&self) -> Status {
        self.hub.status()
    }

    /// Stop listening (the session thread is detached, see [`PortalHub::apply`]).
    pub fn stop(self) {
        self.hub.stop();
    }
}

impl Drop for PortalGrabber {
    fn drop(&mut self) {
        self.hub.stop();
    }
}

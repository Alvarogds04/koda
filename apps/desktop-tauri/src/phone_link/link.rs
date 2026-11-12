// Adapted from Coucou windows/src-tauri/src/phone_link/link.rs @71b773f, Copyright (c) 2026 Rhytam Biswas, MIT
// (the phone link files carry that holder; protocol: Coucou docs/ANDROID_LINK.md).
//
// The live link: the one switch the app flips. While it is on, ONE dedicated thread owns a current-thread Tokio
// runtime — no reactor or task of the phone link ever runs on the island's threads, and switching it off joins that
// thread, so nothing of ours outlives the switch (S3 «arranca APAGADO»).
//
// The identity and the token come from the keystore on every start and are never cached anywhere else. The token
// leaves this module inside the pairing link and its QR only: never a log, never a JSON field of its own.
use super::hub::Hub;
use super::pairing::{self, SecretStore};
use super::server::{self, Features, Shared};
use super::source;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tokio::sync::oneshot;

/// Slice A/B offers no optional capability in `welcome` yet: the capabilities slice turns this into the human's
/// switches. An empty trait impl is what the server expects.
struct NoFeatures;
impl Features for NoFeatures {}

/// How long a switched-off link lets its open connections write their last line before the socket goes away.
/// Bounded on purpose: switching off must never wait on a phone.
const STOP_GRACE: std::time::Duration = std::time::Duration::from_millis(150);

/// What `enable` left running, plus the closed reason it did not.
#[derive(Default)]
struct On {
    stop: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    shared: Option<Arc<Shared>>,
    fingerprint: String,
    name: String,
    port: u16,
    error: Option<&'static str>,
}

pub struct Link {
    hub: Arc<Hub>,
    /// The human's wish, as this object knows it: what `status` reports as `enabled`.
    enabled: AtomicBool,
    /// One switch operation at a time, held across the whole of `enable`, `disable` and `unlink`. Without it a
    /// second enable that loses the bind reports `port_in_use` and clears what the first one started, and a disable
    /// can slip under an enable that has not bound yet and leave the link running after the human turned it off.
    life: Mutex<()>,
    on: Mutex<On>,
}

impl Link {
    pub fn new() -> Link {
        Link { hub: Hub::new(), enabled: AtomicBool::new(false), life: Mutex::new(()), on: Mutex::new(On::default()) }
    }

    /// The sessions hub every connection subscribes to (the same object the app publishes into).
    pub fn hub(&self) -> Arc<Hub> {
        self.hub.clone()
    }

    /// Whether a listener and its runtime are up.
    pub fn running(&self) -> bool {
        self.lock().shared.is_some()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, On> {
        self.on.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The lifecycle lock. Lock order is `life` → `on` → the hub, and nothing ever takes them the other way.
    fn life(&self) -> std::sync::MutexGuard<'_, ()> {
        self.life.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Records the closed reason and answers it. Nothing is left running, and the wish stays on, so the next
    /// start tries again instead of pretending the human turned it off.
    ///
    /// Every caller holds the lifecycle lock with no listener up, so this never reaches a running link; it guards
    /// that anyway, because a failed attempt must never tear down a listener that is serving a phone.
    fn failed(&self, error: &'static str) -> &'static str {
        let mut on = self.lock();
        if on.shared.is_none() {
            on.stop = None;
            on.thread = None;
            on.port = 0;
        }
        on.error = Some(error);
        error
    }

    /// Reports why the last change did not happen without touching what is running (a refused `unlink` keeps the
    /// listener and the token it already has).
    fn note_error(&self, error: &'static str) {
        self.lock().error = Some(error);
    }

    /// Starts listening on `bind` (`0.0.0.0:47821` in the app; `127.0.0.1:0` in tests, where the bound port is
    /// then reported by [`Link::status`]). Idempotent: a running link is left exactly as it is.
    pub fn enable(&self, store: &dyn SecretStore, bind: SocketAddr) -> Result<(), &'static str> {
        let _life = self.life();
        self.enabled.store(true, Ordering::SeqCst);
        if self.running() {
            return Ok(());
        }
        let identity = match pairing::load_or_create_identity(store) {
            Ok(identity) => identity,
            Err(_) => return Err(self.failed("keystore")),
        };
        let token = match pairing::token(store) {
            Ok(token) => token,
            Err(_) => return Err(self.failed("keystore")),
        };
        let acceptor = match server::tls_acceptor(&identity) {
            Ok(acceptor) => acceptor,
            Err(_) => return Err(self.failed("tls")),
        };
        let name = pairing::computer_name();
        let shared = Shared::with_hub(self.hub.clone(), token, name.clone(), Arc::new(NoFeatures));
        let served = shared.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u16, &'static str>>();
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let spawned = std::thread::Builder::new().name("phone-link".into()).spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else {
                let _ = ready_tx.send(Err("runtime"));
                return;
            };
            runtime.block_on(async move {
                let listener = match tokio::net::TcpListener::bind(bind).await {
                    Ok(listener) => listener,
                    // Any bind failure is the same closed answer: the port is not ours to use.
                    Err(_) => {
                        let _ = ready_tx.send(Err("port_in_use"));
                        return;
                    }
                };
                let Ok(local) = listener.local_addr() else {
                    let _ = ready_tx.send(Err("port_in_use"));
                    return;
                };
                // The accept loop is spawned first, so it makes progress from the moment this thread blocks below.
                let handle = server::serve(listener, acceptor, served);
                let _ = ready_tx.send(Ok(local.port()));
                // The link stays on until it is switched off; the runtime lives exactly that long.
                let _ = stop_rx.await;
                // `disable`/`unlink` queued the last line (why the link ends) before this signal: that bounded grace is
                // what lets each connection's writer flush it, so the phone is told instead of just seeing a dead socket.
                tokio::time::sleep(STOP_GRACE).await;
                handle.stop();
            });
        });
        let thread = match spawned {
            Ok(thread) => thread,
            Err(_) => return Err(self.failed("runtime")),
        };
        // Binding is the thread's first act: this wait is one syscall, never a hang.
        match ready_rx.recv().unwrap_or(Err("runtime")) {
            Ok(port) => {
                let mut on = self.lock();
                on.stop = Some(stop_tx);
                on.thread = Some(thread);
                on.shared = Some(shared);
                on.fingerprint = identity.fingerprint;
                on.name = name;
                on.port = port;
                on.error = None;
                Ok(())
            }
            Err(error) => {
                let _ = stop_tx.send(());
                let _ = thread.join();
                Err(self.failed(error))
            }
        }
    }

    /// Switches off: the phones are told why their link ended, the listener stops and the thread is joined. Under
    /// the lifecycle lock, so an enable that is still in flight either finished (and is now stopped) or starts
    /// afterwards with the wish already off.
    pub fn disable(&self) {
        let _life = self.life();
        self.enabled.store(false, Ordering::SeqCst);
        let (stop, thread, shared) = {
            let mut on = self.lock();
            let taken = (on.stop.take(), on.thread.take(), on.shared.take());
            on.port = 0;
            on.error = None;
            taken
        };
        if shared.is_some() {
            self.hub.kick_all("closed", "the phone link was turned off");
        }
        if let Some(stop) = stop {
            let _ = stop.send(());
        }
        if let Some(thread) = thread {
            let _ = thread.join();
        }
    }

    /// Forgets the paired phone: a fresh token locks out whatever held the old one, without touching the
    /// certificate (so nothing must be reinstalled — the phone pairs again with the new link).
    ///
    /// If the keystore refuses the new token nothing happened: the link keeps running with the token it already
    /// has, so a failed unlink never knocks a paired phone off a link the human switched on.
    pub fn unlink(&self, store: &dyn SecretStore) -> Result<(), &'static str> {
        let _life = self.life();
        let token = match pairing::new_token(store) {
            Ok(token) => token,
            Err(_) => {
                self.note_error("keystore");
                return Err("keystore");
            }
        };
        let shared = {
            let mut on = self.lock();
            let shared = on.shared.clone();
            if shared.is_some() {
                on.error = None;
            }
            shared
        };
        if let Some(shared) = shared {
            *shared.token.lock().unwrap_or_else(|e| e.into_inner()) = token;
            self.hub.kick_all("auth", "this computer was unpaired");
        }
        Ok(())
    }

    /// The island's session snapshot (the `sessions` half of the agent view) to the phones. The hub drops a list
    /// whose content did not move, so publishing on every agent change costs one comparison.
    pub fn publish_sessions(&self, view: &Value, now: u64) {
        source::publish(&self.hub, view, now);
    }

    /// What Ajustes reads: `{enabled, running, port, host, name, link, qrSvg, clients, error}`. The link is built
    /// from this computer's LAN address, the one the phone must reach.
    pub fn status(&self) -> Value {
        self.status_for(pairing::lan_address().map(|ip| ip.to_string()))
    }

    /// [`Link::status`] with the address given: the LAN address in the app, an explicit one in tests and in a
    /// machine with no network at all (then `link` and `qrSvg` are null rather than a link nobody could use).
    pub fn status_for(&self, host: Option<String>) -> Value {
        // Lock order: `on` then the hub. Nothing in the hub ever takes `on`, so the two cannot deadlock.
        let on = self.lock();
        let running = on.shared.is_some();
        let link = match (&on.shared, host.as_deref()) {
            (Some(shared), Some(host)) => {
                let token = shared.token.lock().unwrap_or_else(|e| e.into_inner()).clone();
                Some(pairing::pairing_link(host, on.port, &on.fingerprint, &token, &on.name))
            }
            _ => None,
        };
        let qr_svg = link.as_deref().and_then(pairing::qr_svg);
        json!({
            "enabled": self.enabled.load(Ordering::SeqCst),
            "running": running,
            "port": on.port,
            "host": host,
            "name": if running { on.name.clone() } else { pairing::computer_name() },
            "link": link,
            "qrSvg": qr_svg,
            "clients": self.hub.clients(),
            "error": on.error,
        })
    }
}

impl Default for Link {
    fn default() -> Self {
        Link::new()
    }
}

impl Drop for Link {
    /// The app going away must not leave a port behind.
    fn drop(&mut self) {
        self.disable();
    }
}

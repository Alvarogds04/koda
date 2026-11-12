//! K2 S5 host: the app's half of the phone link — the switch the page calls, the startup, and the session feed.
//!
//! S3/D3: the link is OFF until the human turns it on in Ajustes › Teléfono Android; before that nothing listens on
//! the LAN, nothing is announced and no timer runs.
//! S5/D5: the phone does NOT get its own daemon connection (the daemon allows two clients, and the island already
//! uses them): it hangs off Ajustes' one `AgentConn`, which this host creates at startup through the shared
//! constructor, so the phone has sessions without Ajustes ever being opened.
//!
//! S6: Linux only in 0.2. Everywhere else the command answers the closed "unsupported" status and nothing runs.
use crate::{now_ms, AppState};
use abito_island::bridge::{self, BridgeError};
use serde_json::{json, Value};
// `phone_link_action` takes the handle on every platform (S6: it answers `unsupported` off Linux), so the import
// is unconditional; the traits and the Linux-only module below are not.
use tauri::{AppHandle, State};

#[cfg(target_os = "linux")]
use abito_island::phone_link::ids::DEFAULT_PORT;
#[cfg(target_os = "linux")]
use abito_island::phone_link::{ids, keystore, link::Link, server::Features};
#[cfg(target_os = "linux")]
use std::net::SocketAddr;
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(target_os = "linux")]
use std::sync::Arc;
#[cfg(target_os = "linux")]
use std::time::Duration;
#[cfg(target_os = "linux")]
use tauri::{Emitter, Manager};

/// The status event the Teléfono page listens to.
pub(crate) const PHONE_STATE: &str = "phone:state";
/// D6: the only window `phone:state` is sent to — it carries the pairing link with the token.
pub(crate) const PHONE_STATE_TARGET: &str = crate::settingswindow::SETTINGS_LABEL;

/// The closed payload of `phone_link_action`: exactly `{"action":"status"|"enable"|"disable"|"unlink"}`.
pub(crate) fn parse_action(payload: &Value) -> Option<&'static str> {
    let obj = payload.as_object()?;
    if obj.len() != 1 {
        return None;
    }
    match obj.get("action")?.as_str()? {
        "status" => Some("status"),
        "enable" => Some("enable"),
        "disable" => Some("disable"),
        "unlink" => Some("unlink"),
        _ => None,
    }
}

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo completar la acción del enlace con el teléfono.".into() }
}

/// S6: on a platform that does not run the link the page gets one honest, closed answer.
#[cfg(not(target_os = "linux"))]
fn unsupported() -> Result<Value, BridgeError> {
    // `mdns` keeps the shape of the Linux status (S7): nothing is announced where no listener runs.
    Ok(json!({"enabled": false, "running": false, "port": 0, "host": null, "name": null,
        "link": null, "qrSvg": null, "clients": 0, "error": "unsupported", "mdns": "off"}))
}

/// The phone link's one command. The same sender gate and rate limiter as every other host command; the socket,
/// certificate and keychain work always runs off the WebView thread.
#[tauri::command]
pub async fn phone_link_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let action = parse_action(&payload).ok_or_else(|| err("invalid_schema"))?;

    #[cfg(target_os = "linux")]
    {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || act(&handle, action)).await.map_err(|_| err("phone_aborted"))?
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, action);
        unsupported()
    }
}

/// How often a running link asks the daemon for the session list again. The hub only sends what changed.
#[cfg(target_os = "linux")]
const TICK: Duration = Duration::from_secs(2);
/// A link whose connection is gone retries on its own clock, so a missing daemon cannot make this spin.
#[cfg(target_os = "linux")]
const RECONNECT: u64 = 30_000;
/// S11/§11: how often the plans are read for the phone while «Uso de los planes» is on. The first read comes with the
/// first tick after the link is up, so a phone that pairs at once does not wait a whole minute for its pills.
#[cfg(target_os = "linux")]
const USAGE_EVERY_MS: u64 = 60_000;

/// S11/§6.0: what this desktop offers the phone, read again on every `hello` (`server::Features::offered` is called
/// once per connection), so a switch the human flips is in force at the next one — the phone reconnects, and the
/// capabilities are negotiated per connection by design.
///
/// It reads Ajustes' prefs every time; nothing is cached, so there is no stale answer to go wrong. TODAY it offers
/// `usage` and nothing else: `details` (T3) and `answers` / `diffs` / `services` / `chat` (T4/T5) are still pending
/// human decisions, and the ONE place they will be turned on is the list below.
#[cfg(target_os = "linux")]
pub(crate) struct PrefsFeatures {
    read: Box<dyn Fn() -> abito_island::prefs::Prefs + Send + Sync>,
}

#[cfg(target_os = "linux")]
impl PrefsFeatures {
    pub(crate) fn new(read: impl Fn() -> abito_island::prefs::Prefs + Send + Sync + 'static) -> PrefsFeatures {
        PrefsFeatures { read: Box::new(read) }
    }
}

#[cfg(target_os = "linux")]
impl Features for PrefsFeatures {
    fn offered(&self) -> Vec<&'static str> {
        let prefs = (self.read)();
        let mut caps: Vec<&'static str> = Vec::new();
        // S11: the Claude and Codex plan pills.
        if prefs.phone_usage() {
            caps.push(ids::CAP_USAGE);
        }
        // Pending human decisions (T3 `details`, T4/T5 `answers`, `diffs`, `services`, `chat`) are offered from here,
        // each behind its own switch, once the decision exists. Nothing else in the link decides what is offered.
        caps
    }
}

/// The live link in Tauri's shared state. `last_connect` is the ticker's own backoff, in epoch ms; `last_usage` is
/// when the plans were last read for the phone (0 = never), so the 60 s clock is kept across ticks.
#[cfg(target_os = "linux")]
pub struct PhoneHost {
    link: Link,
    last_connect: AtomicU64,
    last_usage: AtomicU64,
}

#[cfg(target_os = "linux")]
impl PhoneHost {
    /// The app's host. The features seam reads Ajustes' prefs on every hello; the decision seam stays the link's
    /// default (every `decision` and `answer` is refused) until the approvals relay is wired (T4/T5).
    fn app(app: &AppHandle) -> PhoneHost {
        let handle = app.clone();
        let features = Arc::new(PrefsFeatures::new(move || crate::settingshost::voice_prefs_snapshot(&handle)));
        PhoneHost {
            link: Link::with_features(features),
            last_connect: AtomicU64::new(0),
            last_usage: AtomicU64::new(0),
        }
    }
}

#[cfg(target_os = "linux")]
fn link_of(app: &AppHandle) -> State<'_, PhoneHost> {
    app.state::<PhoneHost>()
}

/// Setup: the link's state exists from now on, and a stored «on» starts it — off the main thread, because making
/// the certificate, reading the keystore and binding a port are not the window's work.
#[cfg(target_os = "linux")]
pub fn start(app: &AppHandle) {
    if app.try_state::<PhoneHost>().is_none() {
        app.manage(PhoneHost::app(app));
    }
    spawn_ticker(app.clone());
    if !wanted(app) {
        return; // S3: off until the human says so.
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        enable(&handle);
    });
}

/// Exit (`RunEvent::Exit`): the port closes with the app, so nothing of ours outlives it.
#[cfg(target_os = "linux")]
pub fn stop(app: &AppHandle) {
    if let Some(host) = app.try_state::<PhoneHost>() {
        host.link.disable();
    }
}

/// S5/D5: the shared `AgentConn` callback. The phone reads the same `sessions` projection the island draws, so
/// whatever the island shows flows to it by extending that one mapping (never a second source).
#[cfg(target_os = "linux")]
pub(crate) fn publish_sessions(app: &AppHandle, view: &Value) {
    let Some(host) = app.try_state::<PhoneHost>() else { return };
    host.link.publish_sessions(&view["sessions"], abito_island::phone_link::server::now_ms());
}

#[cfg(target_os = "linux")]
fn wanted(app: &AppHandle) -> bool {
    crate::settingshost::voice_prefs_snapshot(app).phone_link()
}

/// The switch's own preference, through the same transaction and atomic writer as every other setting.
#[cfg(target_os = "linux")]
fn persist(app: &AppHandle, on: bool) -> Result<(), BridgeError> {
    crate::settingshost::voice_prefs_command(app, &abito_island::prefs::Command::SetPhoneLink(on))
        .map(|_| ())
        .ok_or_else(|| err("save_failed"))
}

#[cfg(target_os = "linux")]
fn act(app: &AppHandle, action: &'static str) -> Result<Value, BridgeError> {
    match action {
        "status" => Ok(link_of(app).link.status()),
        "enable" => {
            // The wish is recorded first: a taken port must not read as «the human turned it off».
            persist(app, true)?;
            enable(app);
            finish(app)
        }
        "disable" => {
            persist(app, false)?;
            link_of(app).link.disable();
            finish(app)
        }
        "unlink" => {
            let link = link_of(app);
            link.link.unlink(&keystore::keychain()).map_err(|_| err("unlink_failed"))?;
            // S3: a link that is off feeds nobody, so an unlink must not create or connect Ajustes' `AgentConn`
            // for it (that is the pair of daemon clients nobody asked for).
            if link.link.running() {
                ensure_agent(app);
            }
            finish(app)
        }
        _ => Err(err("invalid_schema")),
    }
}

/// The status after a change, told to every page on `phone:state` (neither the switch nor the page ever guesses).
#[cfg(target_os = "linux")]
fn finish(app: &AppHandle) -> Result<Value, BridgeError> {
    let value = link_of(app).link.status();
    // D6: the status carries the pairing link (and so the token): only the Ajustes window gets it, never a broadcast.
    let _ = app.emit_to(PHONE_STATE_TARGET, PHONE_STATE, value.clone());
    Ok(value)
}

/// Binds `0.0.0.0:47821` (the contract's port): every non-LAN peer is already dropped by `server::is_local`, and
/// the Android emulator reaches the host's loopback as 10.0.2.2.
#[cfg(target_os = "linux")]
fn enable(app: &AppHandle) {
    let bound = link_of(app).link.enable(&keystore::keychain(), SocketAddr::from(([0, 0, 0, 0], DEFAULT_PORT)));
    if bound.is_ok() {
        ensure_agent(app);
    }
}

/// S5 «creándolo al arranque»: the one `AgentConn` is created through the shared constructor (so it carries the
/// phone callback) and connected here. The slot is only TRIED — a busy slot belongs to the UI's own call, and this
/// attempt is dropped rather than waited for.
#[cfg(target_os = "linux")]
fn ensure_agent(app: &AppHandle) {
    let now = abito_island::phone_link::server::now_ms();
    let host = link_of(app);
    let last = host.last_connect.load(Ordering::SeqCst);
    if last != 0 && now.saturating_sub(last) < RECONNECT {
        return; // the last connect is still fresh: this tick does not even try for the slot
    }
    let state = app.state::<AppState>();
    let Ok(mut guard) = state.settings.agent.try_lock() else { return };
    // Stamped only now that the slot is ours: a tick that could not take it must try again on the next one
    // instead of pushing the next attempt 30 s away.
    host.last_connect.store(now, Ordering::SeqCst);
    let conn = guard.get_or_insert_with(|| crate::settingshost::agent_conn(app));
    if conn.view().get("connection").and_then(Value::as_str) == Some("connected") {
        return;
    }
    if let Some(reason) = app.state::<abito_island::daemonhost::HostSlot>().failure() {
        conn.startup_failed(reason);
        return;
    }
    let root = abito_island::agentconn::island_root(
        std::env::var("ABITO_ISLAND_DIR").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    );
    if let Some(root) = root {
        conn.connect(&root);
    }
}

/// While the link is on, ask the one `AgentConn` for the session list again. The reply folds into the agent state
/// and the shared callback pushes it to the phones; a list whose content did not change is not sent again.
#[cfg(target_os = "linux")]
fn tick(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Ok(guard) = state.settings.agent.try_lock() else { return }; // busy: this tick is skipped
    let Some(conn) = guard.as_ref() else { return };
    if conn.view().get("connection").and_then(Value::as_str) != Some("connected") {
        return;
    }
    if let Ok(command) = abito_island::agentclient::parse_ui_command(&json!({"action": "sessions_list"})) {
        let _ = conn.send(&command);
    }
}

#[cfg(target_os = "linux")]
fn spawn_ticker(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        if crate::quitting() {
            return;
        }
        let Some(host) = app.try_state::<PhoneHost>() else { return };
        if !host.link.running() {
            continue; // nothing of ours runs while the link is off (S3)
        }
        tick(&app);
        ensure_agent(&app);
        usage_tick(&app); // S11: and no plan is read while its own switch is off
    });
}

/// S11/§11: while the link is running AND «Uso de los planes» is on, read the plans and tell the phones. Nothing is
/// read while either switch is off: no file, no process, nothing on the wire.
///
/// Claude comes from the status-line channel (`claude_plan`: a local file with a 10 minute freshness rule). Codex is
/// asked ONLY when its own pill switch is also on (`show_codex_plan_in_notch`), because that read spawns the user's
/// own `codex app-server`; its process-wide BUSY guard is what keeps it from ever running alongside the island's own
/// plan card — a busy answer is skipped for this tick, never queued.
#[cfg(target_os = "linux")]
fn usage_tick(app: &AppHandle) {
    let Some(host) = app.try_state::<PhoneHost>() else { return };
    let prefs = crate::settingshost::voice_prefs_snapshot(app);
    if !prefs.phone_usage() {
        return;
    }
    let now = abito_island::phone_link::server::now_ms();
    let last = host.last_usage.load(Ordering::SeqCst);
    if last != 0 && now.saturating_sub(last) < USAGE_EVERY_MS {
        return;
    }
    host.last_usage.store(now, Ordering::SeqCst);
    let claude = abito_island::transport::resolve_runtime()
        .ok()
        .and_then(|runtime| abito_island::claude_plan::read(&runtime));
    let codex = prefs.show_codex_plan_in_notch().then(abito_island::codex_plan::read).flatten();
    host.link.publish_usage(abito_island::phone_link::usage::line(claude.as_ref(), codex.as_ref(), now as i64));
}

#[cfg(test)]
mod tests {
    use super::parse_action;
    use serde_json::json;

    /// K2 T6 (S11/§6.0): the capability seam answers from Ajustes' prefs on EVERY hello — never a cached copy — and
    /// today it offers `usage` and nothing else, because every other capability is still a human decision.
    #[test]
    #[cfg(target_os = "linux")]
    fn the_features_seam_reads_the_switch_on_every_hello_and_offers_only_what_is_wired() {
        use abito_island::phone_link::server::Features;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        let on = Arc::new(AtomicBool::new(false));
        let read = {
            let on = on.clone();
            move || abito_island::prefs::Prefs { phone_usage: on.load(Ordering::SeqCst).then_some(true), ..Default::default() }
        };
        let features = super::PrefsFeatures::new(read);
        assert!(features.offered().is_empty(), "S11: off by default, so nothing of the plans is offered");
        on.store(true, Ordering::SeqCst);
        assert_eq!(features.offered(), vec!["usage"], "the switch is on: exactly the capability behind it");
        on.store(false, Ordering::SeqCst);
        assert!(features.offered().is_empty(), "read again on every call: no cached answer");
        on.store(true, Ordering::SeqCst);
        for cap in ["details", "answers", "diffs", "services", "chat"] {
            assert!(!features.offered().contains(&cap), "{cap} is still a human decision and is never offered");
        }
    }

    /// D6: `phone:state` (it carries the link with the token) goes to the Ajustes window only, never to every webview.
    #[test]
    fn the_phone_state_event_reaches_only_the_settings_window() {
        assert_eq!(super::PHONE_STATE_TARGET, "settings");
        assert_eq!(super::PHONE_STATE, "phone:state");
        let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/phonehost.rs")).unwrap();
        let body = src.split("#[cfg(test)]").next().unwrap(); // the host itself, not this test's own strings
        let code: String = body.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        assert!(!code.contains(".emit("), "no broadcast emit in the phone host");
        assert_eq!(code.matches(".emit_to(PHONE_STATE_TARGET, PHONE_STATE,").count(), 1, "one targeted send");
        assert_eq!(code.matches(".emit_to(").count(), 1, "no other window is ever sent the status");
    }

    /// The closed schema of the one phone-link command: exactly one action out of four, no coercion.
    #[test]
    fn the_phone_link_payload_is_a_closed_one_key_command() {
        for (payload, action) in [
            (json!({"action": "status"}), "status"),
            (json!({"action": "enable"}), "enable"),
            (json!({"action": "disable"}), "disable"),
            (json!({"action": "unlink"}), "unlink"),
        ] {
            assert_eq!(parse_action(&payload), Some(action), "{payload}");
        }
        for bad in [
            json!({}),
            json!({"action": "start"}),
            json!({"action": "ENABLE"}),
            json!({"action": 1}),
            json!({"action": null}),
            json!({"action": "status", "port": 47821}),
            json!({"action": "enable", "action2": "disable"}),
            json!("status"),
            json!(["status"]),
            json!(null),
        ] {
            assert_eq!(parse_action(&bad), None, "{bad} is not a valid phone link command");
        }
    }
}

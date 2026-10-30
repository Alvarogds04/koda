//! The dictation key: a shortcut held through the desktop's GlobalShortcuts
//! portal. The desktop says when it is pressed (`Activated`) and released
//! (`Deactivated`), which is all hold-to-talk needs. The app never watches the
//! keyboard: the user chooses the keys in the desktop's own dialog.
//!
//! Adapted from Coucou src-tauri/src/flow/wayland.rs @434d6a2b,
//! Copyright (c) 2026 Louis Raillé, MIT, rewritten on `zbus` (already in the
//! tree) with the sender and session checks of `hotkey::portal::client`.
//! Blocking `zbus`, its own thread, never panics.

#[cfg(target_os = "linux")]
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Instant;
#[cfg(target_os = "linux")]
use std::time::Duration;

// Windows has no XDG portal and no zbus: the D-Bus half is unix-only; Windows gets a `listen`
// stub below that reports `KeyStatus::Unsupported` (the page already renders that state).
#[cfg(target_os = "linux")]
use zbus::blocking::{Connection, MessageIterator, Proxy};
#[cfg(target_os = "linux")]
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};

use super::KeyEvent;
#[cfg(target_os = "linux")]
use crate::hotkey::portal::{outcome_of_response, request_path, token, Outcome};

#[cfg(target_os = "linux")]
const DEST: &str = "org.freedesktop.portal.Desktop";
#[cfg(target_os = "linux")]
const PATH: &str = "/org/freedesktop/portal/desktop";
#[cfg(target_os = "linux")]
const IFACE: &str = "org.freedesktop.portal.GlobalShortcuts";
#[cfg(target_os = "linux")]
const REQUEST_IFACE: &str = "org.freedesktop.portal.Request";
pub const SHORTCUT_ID: &str = "abito-dictate";
#[cfg(target_os = "linux")]
const WAIT: Duration = Duration::from_secs(120);

/// A portal signal as the listener sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signal<'a> {
    pub member: &'a str,
    pub shortcut_id: &'a str,
    pub from_portal: bool,
    pub our_session: bool,
}

/// Only OUR shortcut, from the portal's own bus name and OUR session, moves the
/// dictation: another app's shortcut or an impostor on the bus never does.
pub fn classify(s: &Signal<'_>) -> Option<KeyEvent> {
    if !s.from_portal || !s.our_session || s.shortcut_id != SHORTCUT_ID {
        return None;
    }
    match s.member {
        "Activated" => Some(KeyEvent::Down),
        "Deactivated" => Some(KeyEvent::Up),
        _ => None,
    }
}

/// What the user can be told about the key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStatus {
    Pending,
    Active,
    Denied,
    Unsupported,
}

/// The held shortcut. Dropping it stops listening.
pub struct HoldKey {
    status: Arc<std::sync::atomic::AtomicU8>,
    stop: Arc<AtomicBool>,
}

impl HoldKey {
    pub fn status(&self) -> KeyStatus {
        match self.status.load(Ordering::SeqCst) {
            1 => KeyStatus::Pending,
            2 => KeyStatus::Active,
            3 => KeyStatus::Denied,
            _ => KeyStatus::Unsupported,
        }
    }
}

impl Drop for HoldKey {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

#[cfg(target_os = "linux")]
fn call_request(
    conn: &Connection,
    proxy: &Proxy<'_>,
    method: &str,
    body: &(impl serde::Serialize + zbus::zvariant::DynamicType),
    handle_token: &str,
    stop: &AtomicBool,
) -> Option<(u32, HashMap<String, OwnedValue>)> {
    let deadline = Instant::now() + WAIT;
    let unique = conn.unique_name()?.to_string();
    let expected = request_path(&unique, handle_token);
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface(REQUEST_IFACE)
        .ok()?
        .member("Response")
        .ok()?
        .path(expected.clone())
        .ok()?
        .build();
    let mut it = MessageIterator::for_match_rule(rule, conn, Some(8)).ok()?;
    let reply: OwnedObjectPath = proxy.call(method, body).ok()?;
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

/// Asks the desktop for the shortcut (it shows its own dialog the first time)
/// and sends `Down` / `Up` to `tx` while the user holds it.
#[cfg(target_os = "linux")]
pub fn listen(tx: Sender<(KeyEvent, Instant)>, description: &str, trigger: &str) -> HoldKey {
    let status = Arc::new(std::sync::atomic::AtomicU8::new(1));
    let stop = Arc::new(AtomicBool::new(false));
    let (t_status, t_stop) = (status.clone(), stop.clone());
    let (description, trigger) = (description.to_string(), trigger.to_string());
    let _ = std::thread::Builder::new().name("abito-dictation-key".into()).spawn(move || {
        let fail = |s: u8| t_status.store(s, Ordering::SeqCst);
        let Ok(conn) = Connection::session() else { return fail(4) };
        let Ok(proxy) = Proxy::new(&conn, DEST, PATH, IFACE) else { return fail(4) };

        let (req, sess) = (token("dreq"), token("dsess"));
        let mut options: HashMap<&str, Value<'_>> = HashMap::new();
        options.insert("handle_token", Value::from(req.as_str()));
        options.insert("session_handle_token", Value::from(sess.as_str()));
        let Some((code, results)) = call_request(&conn, &proxy, "CreateSession", &(options,), &req, &t_stop) else { return fail(4) };
        if outcome_of_response(code) != Outcome::Granted {
            return fail(4);
        }
        let Some(session) = results.get("session_handle").and_then(|v| <String>::try_from(v.try_clone().ok()?).ok()) else { return fail(4) };
        let Ok(session_path) = ObjectPath::try_from(session.as_str()) else { return fail(4) };

        // Subscribe before binding so no press is lost.
        let rule_for = |member: &'static str| {
            zbus::MatchRule::builder().msg_type(zbus::message::Type::Signal).interface(IFACE).ok().and_then(|b| b.member(member).ok()).map(|b| b.build())
        };
        let (Some(act), Some(deact)) = (rule_for("Activated"), rule_for("Deactivated")) else { return fail(4) };
        let (Ok(acts), Ok(deacts)) = (MessageIterator::for_match_rule(act, &conn, Some(16)), MessageIterator::for_match_rule(deact, &conn, Some(16))) else {
            return fail(4);
        };

        let bind = token("dbind");
        let mut shortcut: HashMap<&str, Value<'_>> = HashMap::new();
        shortcut.insert("description", Value::from(description.as_str()));
        shortcut.insert("preferred_trigger", Value::from(trigger.as_str()));
        let mut opts: HashMap<&str, Value<'_>> = HashMap::new();
        opts.insert("handle_token", Value::from(bind.as_str()));
        let Some((code, _)) = call_request(&conn, &proxy, "BindShortcuts", &(&session_path, vec![(SHORTCUT_ID, shortcut)], "", opts), &bind, &t_stop) else {
            return fail(4);
        };
        match outcome_of_response(code) {
            Outcome::Granted => t_status.store(2, Ordering::SeqCst),
            Outcome::Denied => return fail(3),
            Outcome::Failed => return fail(4),
        }

        let owner = zbus::blocking::fdo::DBusProxy::new(&conn)
            .ok()
            .and_then(|d| zbus::names::BusName::try_from(DEST).ok().and_then(|n| d.get_name_owner(n).ok()))
            .map(|o| o.to_string());
        // Two iterators, one per signal: merge them on two small threads into one channel.
        let (merge_tx, merge_rx) = std::sync::mpsc::channel::<(&'static str, zbus::Message)>();
        for (name, iter) in [("Activated", acts), ("Deactivated", deacts)] {
            let m = merge_tx.clone();
            let _ = std::thread::spawn(move || {
                for msg in iter.flatten() {
                    if m.send((name, msg)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(merge_tx);
        while !t_stop.load(Ordering::SeqCst) {
            let Ok((member, msg)) = merge_rx.recv_timeout(Duration::from_millis(500)) else { continue };
            let sender = msg.header().sender().map(|s| s.to_string());
            let Ok((sig_session, id, _ts, _opts)) = msg.body().deserialize::<(OwnedObjectPath, String, u64, HashMap<String, OwnedValue>)>() else { continue };
            let signal = Signal {
                member,
                shortcut_id: &id,
                from_portal: owner.is_some() && sender == owner,
                our_session: sig_session.as_str() == session_path.as_str(),
            };
            if let Some(event) = classify(&signal) {
                let _ = tx.send((event, Instant::now()));
            }
        }
    });
    HoldKey { status, stop }
}

/// Windows: there is no portal, so no hold-to-talk key is held (status `Unsupported`, value 4).
#[cfg(not(target_os = "linux"))]
pub fn listen(_tx: Sender<(KeyEvent, Instant)>, _description: &str, _trigger: &str) -> HoldKey {
    HoldKey { status: Arc::new(std::sync::atomic::AtomicU8::new(4)), stop: Arc::new(AtomicBool::new(false)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig<'a>(member: &'a str, id: &'a str, portal: bool, ours: bool) -> Signal<'a> {
        Signal { member, shortcut_id: id, from_portal: portal, our_session: ours }
    }

    #[test]
    fn press_and_release_of_our_shortcut_are_down_and_up() {
        assert_eq!(classify(&sig("Activated", SHORTCUT_ID, true, true)), Some(KeyEvent::Down));
        assert_eq!(classify(&sig("Deactivated", SHORTCUT_ID, true, true)), Some(KeyEvent::Up));
    }

    #[test]
    fn anything_not_ours_is_ignored() {
        assert_eq!(classify(&sig("Activated", "toggle-island", true, true)), None);
        assert_eq!(classify(&sig("Activated", SHORTCUT_ID, false, true)), None);
        assert_eq!(classify(&sig("Activated", SHORTCUT_ID, true, false)), None);
        assert_eq!(classify(&sig("ShortcutsChanged", SHORTCUT_ID, true, true)), None);
    }
}

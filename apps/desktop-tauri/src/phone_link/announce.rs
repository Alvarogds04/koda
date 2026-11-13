//! K2 S7 / D1: the mDNS announcement of §3.2 of the link contract.
//!
//! While — and only while — the link is on, this computer announces one DNS-SD service so a phone that lost the
//! address in its QR can find it again: service type `_abito._tcp` (`ids::MDNS_SERVICE`), instance name = the same
//! computer name the pairing link carries, the listening port, TXT `fp` = the **first 16** lowercase hex characters
//! of the certificate SHA-256 and TXT `v` = the protocol version. The announcement is a hint, never a credential:
//! the phone still pins the full fingerprint over TLS, so a lookalike that copies the id learns nothing.
//!
//! The record is built by a pure function (so the wire shape is unit-tested without touching the network) and
//! [`Mdns`] is the only place that opens a multicast socket: with the link off there is no daemon at all (S3).

use super::ids;
use super::server::PROTOCOL;
use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::time::Duration;

/// `Discovery.FP_ID_LEN` on the phone: how many hex characters of the certificate SHA-256 the TXT record carries.
pub const FP_ID_LEN: usize = 16;
/// A DNS label holds at most 63 bytes; the host record's label is cut to fit instead of failing registration.
const HOST_LABEL_MAX: usize = 63;
/// How long stopping waits for the daemon to take the goodbye away. Bounded on purpose: switching the link off
/// must never wait on the network.
const STOP_WAIT: Duration = Duration::from_millis(200);

/// Exactly what §3.2 puts on the wire, plus the host record the addresses hang from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    /// The DNS-SD form of [`ids::MDNS_SERVICE`]: `_abito._tcp.local.`
    pub service: String,
    /// The computer's name, cut like the one in the pairing link (never a second source for it).
    pub instance: String,
    /// `<sanitized computer name>.local.` — the name the announced addresses belong to.
    pub host: String,
    /// The listening port: the one the OS really gave the listener, never a wish.
    pub port: u16,
    /// The first [`FP_ID_LEN`] characters of the certificate fingerprint, lowercase hex.
    pub fp: String,
    /// The protocol version as text (`"1"`), from the one constant the TLS handshake compares against.
    pub v: String,
}

/// The announcement of this computer on `port`: the pure half of S7, so its shape is testable without a socket.
pub fn record(instance: &str, port: u16, fingerprint: &str) -> Record {
    let name = instance.trim();
    Record {
        service: format!("{}.local.", ids::MDNS_SERVICE),
        instance: if name.is_empty() { ids::DEFAULT_NAME.to_string() } else { name.to_string() },
        host: format!("{}.local.", host_label(name)),
        port,
        fp: fp16(fingerprint),
        v: PROTOCOL.to_string(),
    }
}

/// The first [`FP_ID_LEN`] characters of the fingerprint, lowercase: the phone compares exactly this.
pub fn fp16(fingerprint: &str) -> String {
    fingerprint.chars().take(FP_ID_LEN).collect::<String>().to_ascii_lowercase()
}

/// The computer name as a DNS label: everything DNS does not allow becomes `-`, runs collapse, it is lowercased,
/// cut to fit a label, and it never starts or ends with `-`. An unusable name falls back to the one the rest of
/// the link uses, so the host record is never empty (an mDNS host of `.local.` is refused by the daemon).
pub fn host_label(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if out.len() >= HOST_LABEL_MAX {
            break;
        }
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let label = out.trim_matches('-');
    if label.is_empty() {
        ids::DEFAULT_NAME.to_ascii_lowercase()
    } else {
        label.to_string()
    }
}

/// One live announcement: registered while this value exists, gone once it is stopped or dropped.
pub trait Announcement: Send + Sync {
    fn stop(&mut self);
}

/// How the link announces itself. The app hands in [`Mdns`]; tests hand in a fake, so no unit test opens a
/// multicast socket or starts a daemon.
pub trait Advertise: Send + Sync {
    fn announce(&self, record: &Record) -> Result<Box<dyn Announcement>, String>;
}

/// The real announcer: one [`ServiceDaemon`] per announcement, so nothing of it exists while the link is off.
pub struct Mdns;

impl Advertise for Mdns {
    fn announce(&self, record: &Record) -> Result<Box<dyn Announcement>, String> {
        Ok(Box::new(Announcer::announce(record)?))
    }
}

/// Registers the record with a fresh daemon; stopping (or dropping) unregisters it and shuts the daemon down.
pub struct Announcer {
    daemon: ServiceDaemon,
    /// The registered name, as the daemon keys it (the instance name plus the service type).
    fullname: String,
    stopped: bool,
}

impl Announcer {
    pub fn announce(record: &Record) -> Result<Announcer, String> {
        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        // No addresses of our own: `enable_addr_auto` makes the daemon fill them from this host's interfaces and
        // keep them current, so a laptop that changes Wi-Fi announces the address it now has.
        let info = ServiceInfo::new(
            &record.service,
            &record.instance,
            &record.host,
            (),
            record.port,
            &[("fp", record.fp.as_str()), ("v", record.v.as_str())] as &[(&str, &str)],
        )
        .map_err(|e| e.to_string())?
        .enable_addr_auto();
        let fullname = info.get_fullname().to_string();
        daemon.register(info).map_err(|e| e.to_string())?;
        Ok(Announcer { daemon, fullname, stopped: false })
    }

    /// Unregister first, then shut the daemon down: in that order the goodbye is what the network sees. Idempotent
    /// (a stopped announcer is dropped right after) and bounded, because the link switch is never held by mDNS.
    fn shut(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        if let Ok(status) = self.daemon.unregister(&self.fullname) {
            let _ = status.recv_timeout(STOP_WAIT);
        }
        if let Ok(status) = self.daemon.shutdown() {
            let _ = status.recv_timeout(STOP_WAIT);
        }
    }
}

impl Announcement for Announcer {
    fn stop(&mut self) {
        self.shut();
    }
}

impl Drop for Announcer {
    fn drop(&mut self) {
        self.shut();
    }
}

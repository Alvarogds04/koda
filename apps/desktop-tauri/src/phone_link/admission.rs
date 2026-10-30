// Adapted from Coucou windows/src-tauri/src/phone_link/admission.rs @71b773f, Copyright (c) 2026 Rhytam Biswas, MIT
// (the phone link files carry that holder; protocol: Coucou docs/ANDROID_LINK.md).
// Who may open a connection, and for how long it may stay unauthenticated (docs/ANDROID_LINK.md, "Admission").
//
// The server accepts connections from the local network before it knows who is calling. Left alone, one noisy or
// hostile device could fill every slot with silent connections and keep the paired phone out. So:
//   * one source address may hold at most 2 connections that have not yet said a valid hello;
//   * strangers (addresses that never authenticated) share a pool of 4 such connections, so at least half of the
//     8 slots are always left for a phone the computer already knows;
//   * an address that authenticated before is remembered (in memory only, 8 addresses) and is not held to the
//     stranger pool;
//   * when the pool is getting full the TLS handshake and the hello get 3 s instead of 10 s, so a flood of silent
//     connections frees its slots fast.
// Pure bookkeeping: no sockets, no clock, so every rule is a unit test.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const MAX_CONNECTIONS: usize = 8;
/// Connections from one address that have not yet sent a valid hello.
pub const MAX_UNAUTH_PER_ADDRESS: usize = 2;
/// Unauthenticated connections from addresses that never authenticated, all together.
pub const MAX_UNAUTH_STRANGERS: usize = 4;
/// Addresses remembered as "authenticated before".
pub const KNOWN_ADDRESSES: usize = 8;
pub const PATIENT: Duration = Duration::from_secs(10);
pub const HURRIED: Duration = Duration::from_secs(3);

#[derive(Default)]
struct State {
    total: usize,
    strangers_unauth: usize,
    unauth: HashMap<IpAddr, usize>,
    known: VecDeque<IpAddr>,
}

#[derive(Default)]
pub struct Admission {
    state: Mutex<State>,
}

fn canonical(ip: IpAddr) -> IpAddr {
    ip.to_canonical()
}

impl Admission {
    pub fn new() -> Arc<Admission> {
        Arc::new(Admission::default())
    }

    /// A slot for this caller, or None (the connection is closed unserved). The slot is given back when the ticket drops.
    pub fn admit(self: &Arc<Self>, ip: IpAddr) -> Option<Ticket> {
        let ip = canonical(ip);
        let mut s = self.state.lock().unwrap();
        if s.total >= MAX_CONNECTIONS {
            return None;
        }
        if s.unauth.get(&ip).copied().unwrap_or(0) >= MAX_UNAUTH_PER_ADDRESS {
            return None;
        }
        let stranger = !s.known.contains(&ip);
        if stranger && s.strangers_unauth >= MAX_UNAUTH_STRANGERS {
            return None;
        }
        // Looked at before this caller is counted: "is the pool getting full already?"
        let hurried = s.total + 2 >= MAX_CONNECTIONS || s.strangers_unauth * 2 >= MAX_UNAUTH_STRANGERS;
        s.total += 1;
        *s.unauth.entry(ip).or_insert(0) += 1;
        if stranger {
            s.strangers_unauth += 1;
        }
        Some(Ticket {
            admission: self.clone(),
            ip,
            stranger,
            unauthenticated: Mutex::new(true),
            wait: if hurried { HURRIED } else { PATIENT },
        })
    }

    #[cfg(test)]
    pub fn counts(&self) -> (usize, usize) {
        let s = self.state.lock().unwrap();
        (s.total, s.strangers_unauth)
    }

    #[cfg(test)]
    pub fn knows(&self, ip: IpAddr) -> bool {
        self.state.lock().unwrap().known.contains(&canonical(ip))
    }
}

/// One accepted connection's slot.
pub struct Ticket {
    admission: Arc<Admission>,
    ip: IpAddr,
    stranger: bool,
    unauthenticated: Mutex<bool>,
    wait: Duration,
}

impl Ticket {
    /// How long the TLS handshake and then the hello may take (shorter when the pool is nearly full).
    pub fn wait(&self) -> Duration {
        self.wait
    }

    /// The caller said a valid hello: it no longer counts against the unauthenticated limits and its address is
    /// remembered, so a flood from elsewhere cannot keep it out.
    pub fn authenticated(&self) {
        let mut flag = self.unauthenticated.lock().unwrap();
        if !*flag {
            return;
        }
        *flag = false;
        let mut s = self.admission.state.lock().unwrap();
        release_unauth(&mut s, self.ip, self.stranger);
        s.known.retain(|k| *k != self.ip);
        s.known.push_front(self.ip);
        s.known.truncate(KNOWN_ADDRESSES);
    }
}

fn release_unauth(s: &mut State, ip: IpAddr, stranger: bool) {
    if let Some(n) = s.unauth.get_mut(&ip) {
        *n -= 1;
        if *n == 0 {
            s.unauth.remove(&ip);
        }
    }
    if stranger {
        s.strangers_unauth -= 1;
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let mut s = self.admission.state.lock().unwrap();
        s.total -= 1;
        if *self.unauthenticated.lock().unwrap() {
            release_unauth(&mut s, self.ip, self.stranger);
        }
    }
}

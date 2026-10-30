//! #490 phone link, LAN only and off by default (NotchBuddy feature 17; the cloud relay is NOT ported, S5).
//! Adapted from Coucou windows/src-tauri/src/phone_link/* @71b773f, Copyright (c) 2026 Rhytam Biswas, MIT.
//!
//! Slice A: wire identifiers (`ids`), pairing (certificate + token + link + QR), admission bookkeeping
//! and the TLS server's way in. While the link is off nothing listens, nothing is announced and no timer runs.
pub mod admission;
pub mod hub;
pub mod ids;
pub mod pairing;
pub mod server;
pub mod source;

use ring::digest;

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Constant-time equality, so a token or fingerprint cannot be guessed byte by byte.
pub fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    // The length is not secret (tokens and fingerprints have a fixed size).
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// SHA-256 as lowercase hex (the certificate fingerprint the phone pins).
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(digest::digest(&digest::SHA256, bytes).as_ref())
}

#[cfg(test)]
mod tests;

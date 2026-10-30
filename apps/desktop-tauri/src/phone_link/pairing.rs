// Adapted from Coucou windows/src-tauri/src/phone_link/pairing.rs @71b773f, Copyright (c) 2026 Rhytam Biswas, MIT
// (the phone link files carry that holder; protocol: Coucou docs/ANDROID_LINK.md).
// The phone link's identity: a TLS certificate made once, and the pairing token.
//
// Both live in the OS keystore (Credential Manager, Secret Service), never in a
// file and never in settings.json. If the keystore is not there the link simply
// does not start — there is no fallback to disk.
//
// The certificate is self-signed and has no name: the phone does not check a
// host name or an authority, it accepts exactly the certificate whose SHA-256 it
// was given in the pairing link (certificate pinning). So it only has to be
// generated once and kept; if it is lost, phones pair again.

use ring::digest;
use ring::rand::{SecureRandom, SystemRandom};

use super::hex;

pub const CERT_KEY: &str = "phone-link-cert";
pub const PRIVATE_KEY: &str = "phone-link-key";
pub const TOKEN_KEY: &str = "phone-link-token";

/// Where the secrets are kept. The app's implementation is the OS keystore
/// (secrets.rs); tests use memory.
pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
}

/// The certificate and its key, as the TLS server needs them.
#[derive(Clone)]
pub struct Identity {
    pub cert_der: Vec<u8>,
    pub key_der: Vec<u8>,
    /// Lowercase hex SHA-256 of the certificate: the `fp` of the pairing link.
    pub fingerprint: String,
}

/// The certificate already made, else a new one — stored before it is used.
pub fn load_or_create_identity(store: &dyn SecretStore) -> Result<Identity, String> {
    if let (Some(cert), Some(key)) = (store.get(CERT_KEY), store.get(PRIVATE_KEY)) {
        if let (Some(cert_der), Some(key_der)) = (unhex(&cert), unhex(&key)) {
            // A key that no longer parses means a damaged entry: start over.
            if rcgen::KeyPair::try_from(key_der.as_slice()).is_ok() {
                let fingerprint = hex(digest::digest(&digest::SHA256, &cert_der).as_ref());
                return Ok(Identity { cert_der, key_der, fingerprint });
            }
        }
    }
    let key_pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).map_err(|e| e.to_string())?;
    params.distinguished_name.push(rcgen::DnType::CommonName, super::ids::CERT_CN);
    params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    params.not_after = rcgen::date_time_ymd(2124, 1, 1);
    let cert = params.self_signed(&key_pair).map_err(|e| e.to_string())?;
    let cert_der = cert.der().to_vec();
    let key_der = key_pair.serialize_der();
    // Key first: a certificate without its key is useless, the reverse is harmless.
    store.set(PRIVATE_KEY, &hex(&key_der))?;
    store.set(CERT_KEY, &hex(&cert_der))?;
    let fingerprint = hex(digest::digest(&digest::SHA256, &cert_der).as_ref());
    Ok(Identity { cert_der, key_der, fingerprint })
}

/// The pairing token: the stored one, else a new one.
pub fn token(store: &dyn SecretStore) -> Result<String, String> {
    if let Some(t) = store.get(TOKEN_KEY).filter(|t| is_token(t)) {
        return Ok(t);
    }
    new_token(store)
}

/// A fresh token. Whatever phone held the old one is locked out.
pub fn new_token(store: &dyn SecretStore) -> Result<String, String> {
    let token = random_token()?;
    store.set(TOKEN_KEY, &token)?;
    Ok(token)
}

/// 16 to 128 characters of `[A-Za-z0-9_-]` (docs/ANDROID_LINK.md).
pub fn is_token(s: &str) -> bool {
    (16..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn random_token() -> Result<String, String> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bytes = [0u8; 32];
    SystemRandom::new().fill(&mut bytes).map_err(|_| "no secure random source".to_string())?;
    // 64 symbols, so a byte's low six bits are uniform: 32 symbols = 192 bits.
    Ok(bytes.iter().map(|b| ALPHABET[(b & 63) as usize] as char).collect())
}

/// `<scheme>://pair?v=1&host=…&port=…&fp=…&token=…&name=…` (scheme: ids.rs). No relay fields: the relay is not ported (S5).
pub fn pairing_link(host: &str, port: u16, fingerprint: &str, token: &str, name: &str) -> String {
    format!(
        "{}://pair?v=1&host={}&port={port}&fp={fingerprint}&token={token}&name={}",
        super::ids::SCHEME,
        percent_encode(host),
        percent_encode(name)
    )
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b':') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The link as a QR code, an SVG the settings window shows.
pub fn qr_svg(link: &str) -> Option<String> {
    let code = qrcode::QrCode::new(link.as_bytes()).ok()?;
    Some(
        code.render::<qrcode::render::svg::Color>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .dark_color(qrcode::render::svg::Color("#000000"))
            .light_color(qrcode::render::svg::Color("#ffffff"))
            .build(),
    )
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 == 1 || s.is_empty() || !s.is_ascii() {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

/// This computer's address on the local network: the one the OS would use to
/// reach the outside. Connecting a UDP socket sends nothing; it only makes the
/// OS pick the interface.
pub fn lan_address() -> Option<std::net::IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then_some(ip)
}

/// The name the phone shows for this computer.
pub fn computer_name() -> String {
    let name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|n| !n.trim().is_empty())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|n| n.trim().to_string()))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| super::ids::DEFAULT_NAME.to_string());
    name.chars().take(48).collect()
}

//! The phone link's wire identifiers, in ONE place (#490). Owner decision (L36, «Protocolo propio de Abito»):
//! Abito's own identifiers, no Coucou naming anywhere. The messages themselves stay Coucou's protocol v1
//! (adapted, see mod.rs), so a future Abito phone app can port the Android client. There is no phone client
//! yet: the link ships ready and off by default.

/// `<scheme>://pair?v=1&host=…`
pub const SCHEME: &str = "abito";
/// mDNS / DNS-SD service type announced while the link is on.
pub const MDNS_SERVICE: &str = "_abito._tcp";
/// Common name of the self-signed certificate (the phone pins the SHA-256, never the name).
pub const CERT_CN: &str = "Abito phone link";
/// What the phone shows for this computer when the hostname is unusable.
pub const DEFAULT_NAME: &str = "Abito";

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
/// The port the desktop listens on, and the one the pairing link and the announcement carry (§1).
pub const DEFAULT_PORT: u16 = 47821;

/// The optional capabilities a phone and the desktop name to each other, in the contract's canonical order (§6.0).
/// ONE list: the wire values live here, the phone's `Protocol.CAPABILITIES` is the same list, and a capability is
/// only in force when both sides name it. `chat`, `answers`, `diffs`, `usage` and `services` have nothing to serve
/// yet (slices C to E); `details` is what this slice adds.
pub const CAPS: [&str; 6] = [CAP_CHAT, CAP_DETAILS, CAP_ANSWERS, CAP_DIFFS, CAP_USAGE, CAP_SERVICES];
/// The Chat screen: `chatModels`/`chatSend`/`chatCancel`/`chatReset` and their answers (§13).
pub const CAP_CHAT: &str = "chat";
/// `steps`, `finalLine`, `project` and `color` on each session, and the phone's session details screen (§7).
pub const CAP_DETAILS: &str = "details";
/// Answering Claude Code's questions from the phone: `question` / `answer` (§9).
pub const CAP_ANSWERS: &str = "answers";
/// `files` on each session and `getDiff` → `diff` (§10).
pub const CAP_DIFFS: &str = "diffs";
/// The Claude and Codex plan pills: `usage` (§11).
pub const CAP_USAGE: &str = "usage";
/// The read-only service cards: `services` (§12).
pub const CAP_SERVICES: &str = "services";

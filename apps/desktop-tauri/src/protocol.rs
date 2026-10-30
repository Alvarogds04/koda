//! Pure protocol module for the Pi → desktop notice transport — unit M2.
//!
//! Port of the behaviour-carrying half of the committed Electron sources
//! (read-only, `worktrees/legacy-electron/apps/desktop`):
//! - `core.cjs` `LIMITS` (line 3), `token`/`sessionToken` (lines 6-7),
//!   `decode` (lines 10-33), `NoticeStore` (lines 35-60),
//! - `transport.cjs` stream framing (lines 63-86: batch cap, newline
//!   splitting, oversized tail) and the per-connection frame quota
//!   (lines 73-75).
//!
//! Pure module by contract: no sockets, no clock — `now` is always passed in,
//! so every window (freshness, expiry, rate) is unit-testable without sleep.
//! The unit tests mirror the applicable cases of the legacy
//! `test/core.test.cjs` and the framing cases of `test/transport.test.cjs`,
//! and were written test-first (RED → GREEN).
//!
//! Protocol, unchanged wire format: newline-delimited JSON frames,
//! `{"v":1,"type",…,"project","sessionId","at"[,"id"]}`; `hello` opens the
//! handshake, the receiver answers one exact `{"v":1,"type":"ready"}\n`,
//! then `heartbeat`/`settled` frames follow; `settled` and (S4/T2) `attention`
//! can become a notice. **A settled turn is never a successful task or a passed
//! test** — the notice text stays generic (display only).
//!
//! S4/T2 (human L3, option A «Solo aviso para Codex»): an agent that can only
//! ask in its own terminal (Codex) sends an `attention` notice instead of a
//! question — one short title + detail (e.g. «Codex te pide permiso … Respondé
//! en la terminal»), never a decision and never a deadline — and a later
//! `attention_clear` frame takes it away once the prompt was resolved. The
//! island still answers nothing for that agent.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;

use serde::Serialize;
use serde_json::Value;

// --- LIMITS (core.cjs line 3: byte-for-byte values) ------------------------

pub const FRAME_BYTES: usize = 512;
/// S4/T2: bounds of an `attention` notice text, in chars (one 512-byte frame still caps the whole thing).
pub const ATTENTION_TITLE_MAX: usize = 64;
pub const ATTENTION_DETAIL_MAX: usize = 200;
pub const FRESH_MS: u64 = 15_000;
/// Two processes never read the same clock: the hook stamps `at`, the island compares it with its own `now` (and the other way
/// round). On Windows `Date.now()`/`GetSystemTime` of two processes differ by a few milliseconds, so an honest frame could land
/// "in the future" or "before the question" and be refused. A skew this small is tolerated on those bounds; staleness
/// (`FRESH_MS`) and a far-future stamp stay rejected. Mirrors CLOCK_SKEW_MS (1000) in desktop-harness/src/client.cjs and desktop-pi.
pub const CLOCK_SKEW_MS: u64 = 1_000;
pub const EXPIRY_MS: u64 = 60_000;
pub const QUEUE: usize = 8;
pub const DEDUPE: usize = 256;
pub const CONNECTIONS: usize = 4;
pub const FRAMES_PER_MINUTE: u32 = 120;
pub const HANDSHAKE_MS: u64 = 3_000;
pub const IDLE_MS: u64 = 30_000;
/// transport.cjs line 66: a batch is bounded at `frameBytes * 8` even when it
/// contains many individually valid frames.
pub const BATCH_FACTOR: usize = 8;
/// transport.cjs line 74: the per-connection frame window.
pub const RATE_WINDOW_MS: u64 = 60_000;
/// transport.cjs line 81: the exact handshake answer, newline included
/// (adapter.cjs compares the bytes literally and closes on any deviation).
pub const READY_LINE: &[u8] = b"{\"v\":1,\"type\":\"ready\"}\n";

// --- identity helpers (core.cjs lines 4-7) ---------------------------------

/// `core.cjs projectId`: SHA-256 of the real path, lowercase hex — the same
/// bytes `createHash('sha256').update(cwd).digest('hex')` produces in Node.
pub fn project_id(cwd: &str) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;
    let digest = Sha256::digest(cwd.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// `core.cjs sessionToken`: session ids are labels, never paths —
/// `[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?`, at most 128 chars.
pub fn session_token(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let bytes = value.as_bytes();
    let last = bytes.len() - 1;
    bytes.iter().enumerate().all(|(index, &byte)| {
        if byte.is_ascii_alphanumeric() {
            return true; // first and last must be alphanumeric; checked by position below
        }
        index != 0 && index != last && matches!(byte, b'.' | b'_' | b'-')
    })
}

/// `core.cjs token`: event ids are `[a-zA-Z0-9_-]{1,128}`.
pub fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

// --- messages ---------------------------------------------------------------

/// One decoded wire frame. `kind` is the `type` field on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Message {
    #[serde(rename = "v")]
    pub v: i64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "project")]
    pub project: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "at")]
    pub at: i64,
    #[serde(rename = "id", skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// S10 (L25): OPTIONAL display name of the project (basename of the cwd), only on `settled`, only together with
    /// `agent`. Display text; `project` retains the informational path hash.
    #[serde(rename = "projectName", skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    /// S10 (L25): OPTIONAL slug of the agent that settled (`[a-z0-9][a-z0-9._-]{0,31}`); the label is derived from it.
    #[serde(rename = "agent", skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// S4/T2: OPTIONAL display text of an `attention` notice. Never present on any other frame, and never a decision:
    /// the island shows it and the agent answers in its own terminal.
    #[serde(rename = "title", skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(rename = "detail", skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// S10 (L25): the optional display name of a project — a basename, at most 64 chars of `[A-Za-z0-9._ -]`,
/// starting and ending with a non-space. Anything else refuses the whole frame.
pub fn project_name_ok(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes.first() != Some(&b' ')
        && bytes.last() != Some(&b' ')
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b' ' | b'-'))
}

/// S4/T2: the text of an `attention` notice is ONE visible line of plain text — bounded, non-blank and free of control
/// characters (C0/C1, tab, newline) and of the bidi/format characters that could reorder what the human reads. Markup is
/// not a special case: the island writes every notice field with `textContent` only, so `<b>` is just text.
pub fn notice_text_ok(value: &str, max: usize) -> bool {
    let count = value.chars().count();
    count > 0
        && count <= max
        && !value.trim().is_empty()
        && value.chars().all(|c| {
            !c.is_control()
                && !matches!(c as u32,
                    0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x2069 | 0xFEFF)
        })
}

/// The handshake a connection proved: afterwards every frame must match this
/// session and may not be older than the hello (`core.cjs decode`, identity
/// branch: "Invalid session or replay").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub project: String,
    pub session_id: String,
    pub at: i64,
}

/// Rejections, one per legacy `throw` message in `core.cjs decode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    /// `'Invalid frame'`: more than `frameBytes` bytes.
    FrameTooLarge,
    /// `'Invalid frame'`: not valid UTF-8 JSON (fatal decoder in core.cjs).
    InvalidFrame,
    /// `'Invalid message'`: parsed but not a JSON object.
    InvalidMessage,
    /// `'Invalid schema or scope'`: key set, `v`, project, session, timestamp.
    InvalidSchemaOrScope,
    /// `'Handshake required'`: non-hello before an identity exists.
    HandshakeRequired,
    /// `'Invalid session or replay'`: post-handshake session/time violation.
    InvalidSessionOrReplay,
    /// `'Invalid event id'`: `settled` without a valid `id`.
    InvalidEventId,
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            DecodeError::FrameTooLarge | DecodeError::InvalidFrame => "Invalid frame",
            DecodeError::InvalidMessage => "Invalid message",
            DecodeError::InvalidSchemaOrScope => "Invalid schema or scope",
            DecodeError::HandshakeRequired => "Handshake required",
            DecodeError::InvalidSessionOrReplay => "Invalid session or replay",
            DecodeError::InvalidEventId => "Invalid event id",
        };
        write!(f, "{text}")
    }
}

impl std::error::Error for DecodeError {}

/// Parse one frame. The island project is informational, not an access filter;
/// subsequent frames remain bound to the connection identity proved by hello.
pub fn decode(
    bytes: &[u8],
    project: &str,
    identity: Option<&Identity>,
    now: u64,
) -> Result<Message, DecodeError> {
    // Size gate first (core.cjs line 11), then a fatal UTF-8 JSON parse —
    // a decoding failure and a non-object are distinct legacy throws.
    if bytes.len() > FRAME_BYTES {
        return Err(DecodeError::FrameTooLarge);
    }
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| DecodeError::InvalidFrame)?;
    let Value::Object(object) = value else {
        return Err(DecodeError::InvalidMessage);
    };
    // Exact key set: `id` only participates when `type` is exactly "settled"
    // (core.cjs line 16: keys.length must equal Object.keys().length).
    let kind = object.get("type").and_then(Value::as_str);
    let mut keys: Vec<&str> = vec!["v", "type", "project", "sessionId", "at"];
    if kind == Some("settled") || kind == Some(KIND_ATTENTION) {
        keys.push("id");
        // S4/T2: an attention notice carries its own one-line display text.
        if kind == Some(KIND_ATTENTION) {
            keys.push("title");
            keys.push("detail");
        }
        // S10 (L25): the two display keys travel together, or not at all (an old frame stays valid).
        if object.contains_key("projectName") || object.contains_key("agent") {
            keys.push("projectName");
            keys.push("agent");
        }
    }
    if object.len() != keys.len() || !keys.iter().all(|key| object.contains_key(*key)) {
        return Err(DecodeError::InvalidSchemaOrScope);
    }
    // The remaining schema half of the combined legacy condition: every
    // violation is the same `Invalid schema or scope` throw.
    if json_integer(object.get("v")) != Some(1) {
        return Err(DecodeError::InvalidSchemaOrScope);
    }
    let expected_project = project;
    let project = object
        .get("project")
        .and_then(Value::as_str)
        .ok_or(DecodeError::InvalidSchemaOrScope)?;
    let session_id = object
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or(DecodeError::InvalidSchemaOrScope)?;
    let at = json_integer(object.get("at")).ok_or(DecodeError::InvalidSchemaOrScope)?;
    let (project_name, agent) = if object.contains_key("projectName") {
        let name = object.get("projectName").and_then(Value::as_str).filter(|v| project_name_ok(v));
        let agent = object.get("agent").and_then(Value::as_str).filter(|v| crate::question::agent_slug_ok(v));
        match (name, agent) {
            (Some(n), Some(a)) => (Some(n.to_string()), Some(a.to_string())),
            _ => return Err(DecodeError::InvalidSchemaOrScope),
        }
    } else {
        (None, None)
    };
    let (title, detail) = if kind == Some(KIND_ATTENTION) {
        let title = object
            .get("title")
            .and_then(Value::as_str)
            .filter(|value| notice_text_ok(value, ATTENTION_TITLE_MAX));
        let detail = object
            .get("detail")
            .and_then(Value::as_str)
            .filter(|value| notice_text_ok(value, ATTENTION_DETAIL_MAX));
        match (title, detail) {
            (Some(title), Some(detail)) => (Some(title.to_string()), Some(detail.to_string())),
            _ => return Err(DecodeError::InvalidSchemaOrScope),
        }
    } else {
        (None, None)
    };
    let message = Message {
        v: 1,
        kind: kind.unwrap_or_default().to_string(),
        project: project.to_string(),
        session_id: session_id.to_string(),
        at,
        id: object.get("id").and_then(Value::as_str).map(str::to_string),
        project_name,
        agent,
        title,
        detail,
    };
    validate(&message, expected_project, identity, now)?;
    Ok(message)
}

/// The validation half of `decode`, reusable at the `NoticeStore::accept`
/// boundary (core.cjs re-decodes there so callers cannot bypass
/// normalization).
pub fn validate(
    message: &Message,
    _project: &str,
    identity: Option<&Identity>,
    now: u64,
) -> Result<(), DecodeError> {
    // --- schema + scope (core.cjs lines 18-22) ---
    if message.v != 1
        || message.project.len() != 64
        || !message.project.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !session_token(&message.session_id)
        || !safe_integer(message.at)
        || message.at as i128 > now as i128
        || (message.at as i128) < (now.saturating_sub(FRESH_MS) as i128)
    {
        return Err(DecodeError::InvalidSchemaOrScope);
    }
    // --- identity phase (core.cjs lines 24-29) ---
    match identity {
        None => {
            if message.kind != "hello" {
                return Err(DecodeError::HandshakeRequired);
            }
        }
        Some(proved) => {
            if !matches!(
                message.kind.as_str(),
                "heartbeat" | "settled" | KIND_ATTENTION | KIND_ATTENTION_CLEAR
            ) {
                return Err(DecodeError::InvalidSessionOrReplay);
            }
            if message.session_id != proved.session_id || message.project != proved.project {
                return Err(DecodeError::InvalidSessionOrReplay);
            }
            if message.at < proved.at {
                return Err(DecodeError::InvalidSessionOrReplay);
            }
        }
    }
    // --- settlement event id (core.cjs line 31) ---
    // `settled` and `attention` both carry the event id the human dismisses it by; `attention_clear` is session-scoped.
    if (message.kind == "settled" || message.kind == KIND_ATTENTION)
        && !message
            .id
            .as_deref()
            .map(token)
            .unwrap_or(false)
    {
        return Err(DecodeError::InvalidEventId);
    }
    Ok(())
}

/// `Number.isSafeInteger`: an integer magnitude within 2^53 − 1. JSON
/// numbers without a decimal/exponent parse straight to integers; the rest
/// must be integral finite floats (parity with JS's rounding-free checks).
fn json_integer(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                return (integer.abs() <= MAX_SAFE_INTEGER).then_some(integer);
            }
            let float = number.as_f64()?;
            if float.fract() == 0.0 && float.is_finite() && float.abs() <= MAX_SAFE_INTEGER as f64 {
                Some(float as i64)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Largest integer JavaScript still calls a safe integer (2^53 − 1).
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn safe_integer(value: i64) -> bool {
    value.abs() <= MAX_SAFE_INTEGER
}

// --- framing (transport.cjs lines 63-86) ------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramingError {
    /// line 66: `pending + chunk > frameBytes * 8` — destroy before reading.
    BatchCap,
    /// line 86: after all complete frames are yielded, a remainder longer
    /// than `frameBytes` can never become a valid frame — destroy.
    OversizedTail,
}

/// Result of one inbound chunk: complete frames in arrival order, plus a
/// fatal condition the connection must honour **after** those frames are
/// processed (legacy processes every complete line first, then checks the
/// tail).
#[derive(Debug, PartialEq, Eq)]
pub struct Framed {
    pub frames: Vec<Vec<u8>>,
    pub fatal: Option<FramingError>,
}

/// Newline-delimited stream framer with the legacy batch/tail bounds.
pub struct Framer {
    pending: Vec<u8>,
}

impl Framer {
    pub fn new() -> Self {
        Framer {
            pending: Vec::new(),
        }
    }

    /// Feed one read from the socket. `Err` means the connection dies before
    /// this chunk is looked at at all (batch cap is checked first, exactly
    /// like transport.cjs line 66).
    pub fn push(&mut self, chunk: &[u8]) -> Result<Framed, FramingError> {
        if self.pending.len() + chunk.len() > FRAME_BYTES * BATCH_FACTOR {
            return Err(FramingError::BatchCap);
        }
        self.pending.extend_from_slice(chunk);
        let mut frames = Vec::new();
        while let Some(end) = self.pending.iter().position(|&byte| byte == b'\n') {
            // The newline is framing, not payload (transport.cjs line 69).
            let frame: Vec<u8> = self.pending.drain(..=end).collect();
            frames.push(frame[..end].to_vec());
        }
        // Line 86 runs AFTER every complete frame of this chunk was yielded.
        let fatal = if self.pending.len() > FRAME_BYTES {
            Some(FramingError::OversizedTail)
        } else {
            None
        };
        Ok(Framed { frames, fatal })
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

impl Default for Framer {
    fn default() -> Self {
        Self::new()
    }
}

// --- per-connection frame quota (transport.cjs lines 73-75) -----------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaError {
    /// `'Rate exceeded'` — the connection is destroyed (legacy `throw`
    /// inside the data handler ends the socket).
    RateExceeded,
}

/// Fixed one-minute window, one per connection: reset only when the current
/// window is at least 60 000 ms old, every frame (valid or not) counts, and
/// frame `FRAMES_PER_MINUTE + 1` is rejected.
pub struct FrameQuota {
    frames: u32,
    period_start_ms: u128,
}

impl FrameQuota {
    pub fn new(now_ms: u128) -> Self {
        FrameQuota {
            frames: 0,
            period_start_ms: now_ms,
        }
    }

    pub fn check(&mut self, now_ms: u128) -> Result<(), QuotaError> {
        // transport.cjs lines 74-75: fixed window, every frame counts,
        // rejected frames keep consuming budget.
        if now_ms.saturating_sub(self.period_start_ms) >= RATE_WINDOW_MS as u128 {
            self.frames = 0;
            self.period_start_ms = now_ms;
        }
        self.frames += 1;
        if self.frames > FRAMES_PER_MINUTE {
            return Err(QuotaError::RateExceeded);
        }
        Ok(())
    }
}

// --- notice store (core.cjs lines 35-60) ------------------------------------

/// One displayed notice. The text is fixed and generic on purpose:
/// settling a turn never claims the task went well or the tests passed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub id: String,
    pub session_id: String,
    /// Informational producer project; absent for synthetic transport notices.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub at: i64,
    pub expires_at: i64,
    /// S4/T2: owned, because an `attention` notice displays the producer's (validated) text; every other kind uses a
    /// fixed `'static` sentence.
    pub title: Cow<'static, str>,
    pub detail: Cow<'static, str>,
    pub emotion: &'static str,
    /// #373 GD032: INTERNAL classification, single source in Rust. It never
    /// reaches the wire and never comes from it (the wire contract above is
    /// byte-compatible); the UI renders exactly what this model admits.
    pub severity: &'static str,
    /// `settled` (a wire completion) or `transport` (the app's own failure
    /// notice). The UI renders no other kind.
    pub kind: &'static str,
    /// S10 (L25): display-only, from the wire when the producer sent them (additive; skipped when absent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

pub const NOTICE_TITLE: &str = "Pi terminó su turno";
pub const NOTICE_DETAIL: &str =
    "No confirma que la tarea haya salido bien ni que las pruebas hayan pasado.";
pub const NOTICE_EMOTION: &str = "idle";

// --- #373 GD032: internal severity/kind (never on the wire) -----------------

/// Closed severity set the UI classifies (info | warning | error). A wire
/// `settled` notice is always `info`, so existing notices render unchanged.
pub const SEVERITY_INFO: &str = "info";
pub const SEVERITY_WARNING: &str = "warning";
pub const SEVERITY_ERROR: &str = "error";

/// The only kinds that ever enter the queue; the UI admits the same set.
pub const KIND_SETTLED: &str = "settled";
pub const KIND_TRANSPORT: &str = "transport";
/// S4/T2: the notice kind of an agent that asks in its own terminal (Codex). Display only, never an answer surface.
pub const KIND_ATTENTION: &str = "attention";
/// S4/T2: the frame that takes a session's attention notices away once its prompt was resolved.
pub const KIND_ATTENTION_CLEAR: &str = "attention_clear";
/// The expression an attention notice wears: it points at the terminal, it is not an error.
pub const ATTENTION_EMOTION: &str = "sun";

/// Synthetic session label for the transport-failure notice (a label, never
/// a path; satisfies `session_token`).
const TRANSPORT_SESSION: &str = "transport";

/// #373 OD006 — why the local notice transport failed.
/// `Unavailable`: the receiver could not start (main.cjs `unavailable`);
/// no retry exists, so the notice persists until the human dismisses it.
/// `ConnectionLost`: an established Pi connection dropped mid-run; the
/// notice clears itself when a session reconnects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportFailure {
    Unavailable,
    ConnectionLost,
}

impl TransportFailure {
    fn title(self) -> &'static str {
        match self {
            TransportFailure::Unavailable => "Avisos caídos",
            TransportFailure::ConnectionLost => "Conexión caída",
        }
    }
    fn detail(self) -> &'static str {
        match self {
            TransportFailure::Unavailable => {
                "El canal local de avisos no pudo iniciarse; no se hizo ninguna conexión con Pi. \
                 El aviso permanece mientras el transporte siga caído."
            }
            TransportFailure::ConnectionLost => {
                "Se cortó la conexión con Pi. El transporte se restablece cuando una sesión de Pi \
                 vuelve a conectarse; también podés descartar este aviso."
            }
        }
    }
}

/// Bounded queue (8) + session-scoped dedupe (256) + one-minute expiry —
/// ported from `core.cjs NoticeStore`.
pub struct NoticeStore {
    project: String,
    queue: Vec<Notice>,
    seen: HashMap<(String, String), u64>,
    /// Last reported count detects recovery (0 -> >0). Failure comes from
    /// the receiver's abnormal-exit classification, not normal hook EOF.
    connections: u32,
    /// Distinct transport-failure events (per-event dismissal identity).
    transport_events: u64,
    /// Host-only lifecycle cursor, bounded by the queue; never part of a serialized notice.
    origin_snapshot_ids: Vec<String>,
}

impl NoticeStore {
    pub fn new(project: impl Into<String>) -> Self {
        NoticeStore {
            project: project.into(),
            queue: Vec::new(),
            seen: HashMap::new(),
            connections: 0,
            transport_events: 0,
            origin_snapshot_ids: Vec::new(),
        }
    }

    /// Drop expired queue entries and expired dedupe keys (core.cjs line 37).
    pub fn prune(&mut self, now: u64) {
        self.queue.retain(|entry| entry.expires_at > now as i64);
        self.seen.retain(|_, expiry| *expiry > now);
    }

    /// Re-validate at this boundary, ignore anything but `settled`, dedupe by
    /// `sessionId:id`, saturate at `DEDUPE`, enqueue bounded by `QUEUE`.
    /// Returns true only for a notice that actually entered the queue.
    pub fn accept(&mut self, event: &Message, now: u64) -> bool {
        self.prune(now);
        // Also validate at this boundary: callers cannot bypass normalization
        // (core.cjs line 43 re-decodes the event with `now` as the clock).
        let boundary = Identity {
            project: event.project.clone(),
            session_id: event.session_id.clone(),
            at: now.saturating_sub(FRESH_MS) as i64,
        };
        if validate(event, &self.project, Some(&boundary), now).is_err() {
            return false;
        }
        // S4/T2: the clearing frame is not a notice — it takes this session's attention notices away. It reports `true`
        // because it changed what the island shows (the app republishes the snapshot it just cleared).
        if event.kind == KIND_ATTENTION_CLEAR {
            self.clear_attention(&event.session_id);
            return true;
        }
        if event.kind != "settled" && event.kind != KIND_ATTENTION {
            return false; // a hello or heartbeat is never a notice
        }
        let Some(id) = event.id.clone() else {
            return false;
        };
        let key = (event.session_id.clone(), id.clone());
        if self.seen.contains_key(&key) || self.seen.len() >= DEDUPE {
            return false;
        }
        self.seen.insert(key, now + EXPIRY_MS);
        let notice = if event.kind == KIND_ATTENTION {
            Notice {
                id,
                session_id: event.session_id.clone(),
                project: Some(event.project.clone()),
                at: event.at,
                expires_at: event.at.saturating_add(EXPIRY_MS as i64),
                // The producer's own (validated) line: it names the agent and points at the terminal.
                title: Cow::Owned(event.title.clone().unwrap_or_default()),
                detail: Cow::Owned(event.detail.clone().unwrap_or_default()),
                emotion: ATTENTION_EMOTION,
                severity: SEVERITY_WARNING,
                kind: KIND_ATTENTION,
                project_name: event.project_name.clone(),
                agent: event.agent.clone(),
            }
        } else {
            Notice {
                id,
                session_id: event.session_id.clone(),
                project: Some(event.project.clone()),
                at: event.at,
                expires_at: event.at.saturating_add(EXPIRY_MS as i64),
                title: Cow::Borrowed(match event.agent.as_deref() {
                    Some("claude-code") => "Claude Code terminó",
                    Some("codex") => "Codex terminó",
                    _ => NOTICE_TITLE,
                }),
                detail: Cow::Borrowed(NOTICE_DETAIL),
                emotion: NOTICE_EMOTION,
                // GD032: a wire settled completion is informational; existing
                // notices therefore render exactly as before.
                severity: SEVERITY_INFO,
                kind: KIND_SETTLED,
                project_name: event.project_name.clone(),
                agent: event.agent.clone(),
            }
        };
        // S4/T2: a pending prompt LEADS the strip — the human must see it at once — like a transport failure; a settled
        // completion keeps its historical place at the back.
        if event.kind == KIND_ATTENTION {
            self.queue.insert(0, notice);
        } else {
            self.queue.push(notice);
        }
        self.trim();
        true
    }

    /// Bounded by `QUEUE`. A transport failure and an attention notice are never the victim: the OLDEST `settled`
    /// notice goes first, and only a queue made of protected notices is trimmed from the back.
    fn trim(&mut self) {
        while self.queue.len() > QUEUE {
            match self.queue.iter().position(|entry| entry.kind == KIND_SETTLED) {
                Some(index) => {
                    self.queue.remove(index);
                }
                None => {
                    self.queue.pop();
                }
            }
        }
    }

    /// S4/T2: the prompt was resolved (`Stop`): every attention notice of this session goes away at once. The dedupe map
    /// is untouched, so the same event id can never come back.
    pub fn clear_attention(&mut self, session_id: &str) {
        self.queue
            .retain(|entry| !(entry.kind == KIND_ATTENTION && entry.session_id == session_id));
    }

    // --- #373 OD006: transport failure lifecycle -------------------------

    /// Surface ONE transport failure: a state-derived error notice at the
    /// FRONT of the queue (the existing `dismiss` verb acts on the queue
    /// head, so dismissal works per failure event), never expiring while the
    /// failure lasts. Only a NEW event inserts a new id: once the human
    /// dismisses it, plain snapshots never bring it back.
    pub fn transport_failed(&mut self, failure: TransportFailure, now: u64) {
        self.transport_events += 1;
        // one failure notice at a time: replace any previous one
        self.queue.retain(|entry| entry.kind != KIND_TRANSPORT);
        self.queue.insert(0, Notice {
            id: format!("transport-{}", self.transport_events),
            session_id: TRANSPORT_SESSION.to_string(),
            project: None,
            at: now as i64,
            // state-derived: it lives as long as the failure does
            expires_at: i64::MAX,
            title: Cow::Borrowed(failure.title()),
            detail: Cow::Borrowed(failure.detail()),
            emotion: "error",
            severity: SEVERITY_ERROR,
            kind: KIND_TRANSPORT,
            project_name: None,
            agent: None,
        });
        // Still bounded by QUEUE — but the failure leads and is never the
        // victim: drop the OLDEST settled notice instead (the legacy
        // front-drain would delete the failure itself, at the front). An
        // attention notice is protected too (S4/T2).
        self.trim();
    }

    /// The transport recovered: the failure notice clears itself.
    pub fn transport_recovered(&mut self) {
        self.queue.retain(|entry| entry.kind != KIND_TRANSPORT);
    }

    /// Presence alone cannot distinguish a completed hook from a failed
    /// producer. The receiver reports failures explicitly; reconnect clears.
    pub fn connections_changed(&mut self, count: u32, _now: u64) {
        if count > 0 && self.connections == 0 {
            self.transport_recovered();
        }
        self.connections = count;
    }

    /// Pruned copy of the queue, oldest first (main.cjs snapshot order).
    pub fn snapshot(&mut self, now: u64) -> Vec<Notice> {
        self.prune(now);
        self.queue.clone()
    }

    /// Remove one exact notice (`id` + `sessionId`); dedupe is untouched, so
    /// a dismissed event can never reappear (core.test.cjs line 45).
    pub fn dismiss(&mut self, id: &str, session_id: &str, now: u64) {
        self.prune(now);
        self.queue
            .retain(|entry| !(entry.id == id && entry.session_id == session_id));
    }

    /// #437: dismiss the notice with EXACTLY this id (the notices list view's
    /// per-row ×). An unknown id is refused with ZERO mutation — never a
    /// first-notice fallback (coordinator decision, T6.6 #437). Answers true
    /// only when that exact notice was removed.
    pub fn dismiss_exact(&mut self, id: &str, now: u64) -> bool {
        self.prune(now);
        let Some(entry) = self.queue.iter().find(|entry| entry.id == id) else {
            return false;
        };
        let session_id = entry.session_id.clone();
        self.dismiss(id, &session_id, now);
        true
    }

    /// Called under the app queue lock while building a snapshot. Only previously observed
    /// ids can be removed, protecting accepted-but-not-yet-published transport origins.
    pub fn removed_origin_ids(&mut self, ids: &[String]) -> Vec<String> {
        let previous = std::mem::replace(&mut self.origin_snapshot_ids, ids.iter().take(QUEUE).cloned().collect());
        previous.into_iter().filter(|id| !ids.contains(id)).collect()
    }

    pub fn project(&self) -> &str {
        &self.project
    }
}

// --- tests: written first, RED then GREEN -----------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const NOW: u64 = 100_000;

    fn project() -> String {
        project_id("/project")
    }

    fn hello_value(project: &str) -> Value {
        json!({"v":1, "type":"hello", "project":project, "sessionId":"session-1", "at":NOW})
    }

    fn settled_value(project: &str) -> Value {
        json!({"v":1, "type":"settled", "project":project, "sessionId":"session-1",
               "at":NOW, "id":"event-1"})
    }

    fn parse(value: &Value, project: &str, identity: Option<&Identity>, now: u64) -> Result<Message, DecodeError> {
        decode(value.to_string().as_bytes(), project, identity, now)
    }

    fn identity_of(project: &str) -> Identity {
        Identity {
            project: project.to_string(),
            session_id: "session-1".to_string(),
            at: NOW as i64,
        }
    }

    #[test]
    fn r21_origin_lifecycle_cursor_never_forgets_a_notice_before_it_is_published() {
        let mut store = NoticeStore::new(project());
        assert!(store.removed_origin_ids(&[]).is_empty());
        assert!(store.removed_origin_ids(&["new".into()]).is_empty());
        assert_eq!(store.removed_origin_ids(&[]), vec!["new"]);
        assert!(store.removed_origin_ids(&[]).is_empty());
        store.removed_origin_ids(&vec!["x".into(); QUEUE + 10]);
        assert_eq!(store.origin_snapshot_ids.len(), QUEUE);
    }

    #[test]
    fn r0_foreign_project_reaches_notice_and_keeps_project_metadata() {
        let foreign = project_id("/another-folder");
        let island = project();
        let hello = parse(&hello_value(&foreign), &island, None, NOW).expect("foreign hello");
        let identity = identity_of(&hello.project);
        let event = parse(&settled_value(&foreign), &island, Some(&identity), NOW).expect("foreign settled");
        let mut store = NoticeStore::new(island);
        assert!(store.accept(&event, NOW), "foreign notice admitted at store boundary");
        // The original project remains available independently of its display name.
        assert_eq!(serde_json::to_value(&store.snapshot(NOW)[0]).unwrap()["project"], foreign);
    }

    #[test]
    fn r0_malformed_project_ids_are_rejected_even_if_island_matches() {
        for bad in ["".to_string(), "a".repeat(63), "a".repeat(65), "g".repeat(64), "A".repeat(64)] {
            assert_eq!(parse(&hello_value(&bad), &bad, None, NOW), Err(DecodeError::InvalidSchemaOrScope));
        }
    }

    #[test]
    fn r0_invalid_session_and_event_tokens_still_fail_closed() {
        let island = project();
        let mut hello = hello_value(&island);
        hello["sessionId"] = json!("../bad");
        assert_eq!(parse(&hello, &island, None, NOW), Err(DecodeError::InvalidSchemaOrScope));
        let mut event = settled_value(&island);
        event["id"] = json!("bad/token");
        assert_eq!(parse(&event, &island, Some(&identity_of(&island)), NOW), Err(DecodeError::InvalidEventId));
    }

    // ported from legacy test/core.test.cjs:19
    #[test]
    fn strict_handshake_schema_scope_identity_bytes_and_timestamps() {
        let project = project();
        let hello = hello_value(&project);
        let parsed = parse(&hello, &project, None, NOW).expect("a strict handshake is accepted");
        assert_eq!(parsed.session_id, "session-1");
        for bad in [
            json!(null),
            json!([]),
            json!({}),
            json!({"v":2, "type":"hello", "project":project, "sessionId":"session-1", "at":NOW}),
            json!({"v":1, "type":"hello", "project":"g".repeat(64), "sessionId":"session-1", "at":NOW}),
            json!({"v":1, "type":"hello", "project":project, "sessionId":"", "at":NOW}),
            json!({"v":1, "type":"hello", "project":project, "sessionId":"../secret", "at":NOW}),
            json!({"v":1, "type":"hello", "project":project, "sessionId":"session-1", "at":NOW, "text":"private"}),
            json!({"v":1, "type":"hello", "project":project, "sessionId":"session-1", "at":NOW + 1}),
            json!({"v":1, "type":"hello", "project":project, "sessionId":"session-1", "at":NOW - (FRESH_MS + 1)}),
        ] {
            assert!(parse(&bad, &project, None, NOW).is_err(), "must reject {bad}");
        }
        // byte-level gates: oversized frame and invalid UTF-8
        let oversized = vec![b'x'; FRAME_BYTES + 1];
        assert!(decode(&oversized, &project, None, NOW).is_err());
        assert!(decode(&[0xff], &project, None, NOW).is_err());
        // a settlement is not a handshake
        let complete = settled_value(&project);
        assert!(parse(&complete, &project, None, NOW).is_err(), "handshake required");
        let identity = identity_of(&project);
        let wrong_session = json!({"v":1, "type":"settled", "project":project,
                                   "sessionId":"other", "at":NOW, "id":"event-1"});
        assert!(parse(&wrong_session, &project, Some(&identity), NOW).is_err());
        let replay = json!({"v":1, "type":"settled", "project":project,
                            "sessionId":"session-1", "at":NOW - 1, "id":"event-1"});
        assert!(parse(&replay, &project, Some(&identity), NOW).is_err(), "at < identity.at is replay");
        assert!(parse(&hello, &project, Some(&identity), NOW).is_err(), "hello after handshake");
        // and the happy post-handshake path really works
        assert!(parse(&complete, &project, Some(&identity), NOW).is_ok());
    }

    // ported from legacy test/core.test.cjs:35
    #[test]
    fn only_generic_settlement_never_proves_success() {
        let project = project();
        let identity = identity_of(&project);
        let event = parse(&settled_value(&project), &project, Some(&identity), NOW).expect("settled");
        let mut store = NoticeStore::new(project.clone());
        assert!(store.accept(&event, NOW));
        let notice = store.snapshot(NOW).into_iter().next().expect("one notice");
        assert_eq!(notice.title, "Pi terminó su turno");
        assert!(notice.detail.starts_with("No confirma"), "generic detail: {}", notice.detail);
        assert!(notice.detail.contains("pruebas"), "generic detail: {}", notice.detail);
        assert_eq!(notice.emotion, "idle");
        // a stowaway key, a custom text or an action verb is a schema error —
        // the producer can never narrate an outcome or ask for an approval.
        for extra in [
            json!({"v":1, "type":"settled", "project":project, "sessionId":"session-1", "at":NOW, "id":"event-1", "success":true}),
            json!({"v":1, "type":"settled", "project":project, "sessionId":"session-1", "at":NOW, "id":"event-1", "text":"<script>secret</script>"}),
            json!({"v":1, "type":"settled", "project":project, "sessionId":"session-1", "at":NOW, "id":"event-1", "action":"approve"}),
        ] {
            assert!(parse(&extra, &project, Some(&identity), NOW).is_err(), "must reject {extra}");
        }
        let wrong_type = json!({"v":1, "type":"tests_passed", "project":project, "sessionId":"session-1", "at":NOW, "id":"event-1"});
        assert!(parse(&wrong_type, &project, Some(&identity), NOW).is_err());
        assert!(parse(&wrong_type, &project, None, NOW).is_err());
    }

    // #437: per-row dismissal in the notices list view needs an exact-id dismiss
    // that REFUSES an unknown id with zero mutation — the list's × must never
    // fall back to the first notice (coordinator decision, T6.6 #437).
    #[test]
    fn dismiss_exact_removes_only_that_notice_and_refuses_unknown_ids() {
        let project = project();
        let identity = identity_of(&project);
        let decode_at = |value: &Value, now: u64| {
            decode(value.to_string().as_bytes(), &project, Some(&identity), now)
        };
        let mut store = NoticeStore::new(project.clone());
        for id in ["event-1", "event-2"] {
            let value = json!({"v":1, "type":"settled", "project":project,
                               "sessionId":"session-1", "at":NOW, "id":id});
            let message = decode_at(&value, NOW).expect("valid settled");
            assert!(store.accept(&message, NOW), "{id} admitted");
        }
        assert_eq!(store.snapshot(NOW).len(), 2);
        // an unknown id is refused and changes NOTHING (never a first-notice fallback)
        assert!(!store.dismiss_exact("event-9", NOW));
        assert_eq!(store.snapshot(NOW).len(), 2, "an unknown id never mutates the queue");
        // the exact id removes exactly that notice; the other one stays
        assert!(store.dismiss_exact("event-1", NOW));
        let left = store.snapshot(NOW);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, "event-2");
    }

    // ported from legacy test/core.test.cjs:41
    #[test]
    fn bounded_queue_session_scoped_dedupe_expiry_and_saturation() {
        let project = project();
        let identity = identity_of(&project);
        let decode_at = |value: &Value, now: u64| decode(value.to_string().as_bytes(), &project, Some(&identity), now);
        let event = decode_at(&settled_value(&project), NOW).expect("settled");
        let mut store = NoticeStore::new(project.clone());
        assert!(store.accept(&event, NOW));
        let event_id = event.id.clone().expect("settled carries id");
        store.dismiss(&event_id, &event.session_id, NOW);
        assert!(!store.accept(&event, NOW), "a dismissed event stays deduped");
        let other_session = json!({"v":1, "type":"settled", "project":project,
                                   "sessionId":"session-2", "at":NOW, "id":"event-1"});
        // legacy passes the raw object straight to store.accept; decode it
        // with session-2's own proved identity instead (the store boundary
        // re-validates per event session anyway).
        let identity_2 = Identity {
            project: project.clone(),
            session_id: "session-2".to_string(),
            at: NOW as i64,
        };
        let other = decode(other_session.to_string().as_bytes(), &project, Some(&identity_2), NOW)
            .expect("session-2 settled");
        assert!(store.accept(&other, NOW), "dedupe is session-scoped");
        for i in 0..DEDUPE {
            let value = json!({"v":1, "type":"settled", "project":project,
                               "sessionId":"session-1", "at":NOW, "id":format!("id-{i}")});
            let message = decode_at(&value, NOW).expect("valid settled");
            store.accept(&message, NOW);
        }
        assert_eq!(store.snapshot(NOW).len(), QUEUE, "queue bounded at 8");
        let overflow = json!({"v":1, "type":"settled", "project":project,
                              "sessionId":"session-1", "at":NOW, "id":"overflow"});
        let overflow = decode_at(&overflow, NOW).expect("valid settled");
        assert!(!store.accept(&overflow, NOW), "dedupe map saturates at 256");
        assert_eq!(store.snapshot(NOW + EXPIRY_MS + 1).len(), 0, "notices expire at one minute");
        assert!(!store.accept(&event, NOW + EXPIRY_MS + 1), "expired dedupe but stale timestamp");
        let fresh = json!({"v":1, "type":"settled", "project":project,
                           "sessionId":"session-1", "at":(NOW + EXPIRY_MS + 1), "id":"fresh"});
        let identity_fresh = Identity {
            project: project.clone(),
            session_id: "session-1".to_string(),
            at: (NOW + EXPIRY_MS + 1 - FRESH_MS) as i64,
        };
        let fresh = decode(fresh.to_string().as_bytes(), &project, Some(&identity_fresh), NOW + EXPIRY_MS + 1)
            .expect("fresh settled");
        assert!(store.accept(&fresh, NOW + EXPIRY_MS + 1));
        // identity.time moved forward: the old event no longer validates
        let hello_new = Identity {
            project: project.clone(),
            session_id: "session-1".to_string(),
            at: (NOW + 1) as i64,
        };
        assert!(decode(serde_json::to_string(&event).unwrap().as_bytes(), &project, Some(&hello_new), NOW + 1).is_err());
    }

    // ported from legacy test/core.test.cjs:57
    #[test]
    fn heartbeats_cannot_create_notices_or_extend_expiry() {
        let project = project();
        let identity = identity_of(&project);
        let heartbeat_value = json!({"v":1, "type":"heartbeat", "project":project,
                                     "sessionId":"session-1", "at":NOW});
        let heartbeat = parse(&heartbeat_value, &project, Some(&identity), NOW).expect("valid heartbeat");
        let settled = parse(&settled_value(&project), &project, Some(&identity), NOW).expect("settled");
        let mut store = NoticeStore::new(project.clone());
        assert!(!store.accept(&heartbeat, NOW), "a heartbeat is never a notice");
        assert!(store.accept(&settled, NOW));
        let late = json!({"v":1, "type":"heartbeat", "project":project,
                          "sessionId":"session-1", "at":NOW + EXPIRY_MS});
        let late = parse(&late, &project, Some(&identity), NOW + EXPIRY_MS).expect("still in window");
        assert!(!store.accept(&late, NOW + EXPIRY_MS));
        assert!(store.snapshot(NOW + EXPIRY_MS).is_empty(), "heartbeats never extend expiry");
    }

    // ported from legacy test/core.test.cjs:244
    #[test]
    fn supported_session_ids_are_labels_never_paths() {
        let project = project();
        let ok = json!({"v":1, "type":"hello", "project":project, "sessionId":"session.1", "at":NOW});
        assert!(parse(&ok, &project, None, NOW).is_ok());
        for bad in [".", "..", ".hidden", "a/b", "a\\b", " a ", "a\n"] {
            let value = json!({"v":1, "type":"hello", "project":project, "sessionId":bad, "at":NOW});
            assert!(parse(&value, &project, None, NOW).is_err(), "must reject {bad:?}");
        }
    }

    // ported from legacy test/core.test.cjs:6 (token) + core.cjs:5
    #[test]
    fn project_id_matches_node_sha256_and_event_ids_are_bounded() {
        // sha256("/project") as computed by Node: createHash('sha256').update('/project')
        assert_eq!(
            project_id("/project"),
            "ea0135bca5e3bd815f5b7b8f8c83d86f584697bc29e0cc3b30937153abef2844"
        );
        for ok in ["a", "event-1", "f".repeat(128).as_str(), "A_9-z"] {
            assert!(token(ok), "token must accept {ok:?}");
        }
        for bad in ["", "with space", "plus+sign", "f".repeat(129).as_str(), "ñ"] {
            assert!(!token(bad), "token must reject {bad:?}");
        }
        assert!(session_token("session.1"));
        assert!(session_token("s"));
        assert!(!session_token(""));
        assert!(!session_token("f".repeat(129).as_str()));
    }

    // ported from legacy test/transport.test.cjs:100 (fragmented greeting)
    #[test]
    fn framing_handles_fragments_without_losing_frames() {
        let project = project();
        let greeting = format!("{}\n", hello_value(&project));
        let bytes = greeting.as_bytes();
        let mut framer = Framer::new();
        let first = framer.push(&bytes[..12]).expect("batch ok");
        assert!(first.frames.is_empty(), "no line yet");
        assert!(first.fatal.is_none());
        let second = framer.push(&bytes[12..]).expect("batch ok");
        assert_eq!(second.frames.len(), 1);
        assert_eq!(second.frames[0], &bytes[..bytes.len() - 1], "newline is framing, not payload");
        // a frame may be exactly frameBytes long (legacy rejects only >512)
        let mut framer = Framer::new();
        let mut exact = vec![b'a'; FRAME_BYTES];
        exact.push(b'\n');
        let framed = framer.push(&exact).expect("batch ok");
        assert_eq!(framed.frames.len(), 1);
        assert_eq!(framed.frames[0].len(), FRAME_BYTES);
        assert!(framed.fatal.is_none());
        // two frames in one chunk keep their order
        let mut framer = Framer::new();
        let joined = format!("{greeting}{greeting}");
        let framed = framer.push(joined.as_bytes()).expect("batch ok");
        assert_eq!(framed.frames.len(), 2);
        assert!(framed.fatal.is_none());
    }

    // ported from legacy transport.cjs:66 and :86
    #[test]
    fn batch_cap_and_oversized_tail_close_after_complete_frames() {
        // complete frames are yielded FIRST, then the oversized tail is fatal
        // (legacy processes every line in the while loop, checks the tail after)
        let mut framer = Framer::new();
        let mut chunk = b"{}\n".to_vec();
        chunk.extend(vec![b'z'; 600]);
        let framed = framer.push(&chunk).expect("batch under cap");
        assert_eq!(framed.frames.len(), 1, "the complete frame is still delivered");
        assert_eq!(framed.fatal, Some(FramingError::OversizedTail));
        // pending + chunk strictly greater than frameBytes * 8 dies before reading
        let mut framer = Framer::new();
        framer.push(&vec![b'd'; FRAME_BYTES * BATCH_FACTOR - 1]).expect("under cap");
        assert_eq!(
            framer.push(&vec![b'e'; 2]).unwrap_err(),
            FramingError::BatchCap
        );
        // exactly at the cap is not a batch error — the tail gate reports it
        let mut framer = Framer::new();
        framer.push(&vec![b'd'; FRAME_BYTES * BATCH_FACTOR - 6]).expect("under cap");
        let framed = framer.push(&vec![b'e'; 6]).expect("exactly at the cap");
        assert!(framed.frames.is_empty());
        assert_eq!(framed.fatal, Some(FramingError::OversizedTail));
    }

    // --- #373 OD006/GD032: internal severity model + transport failure ---

    #[test]
    fn settled_notice_names_real_agent() {
        for (agent, title) in [
            ("claude-code", "Claude Code terminó"),
            ("codex", "Codex terminó"),
            ("pi", NOTICE_TITLE),
            ("other", NOTICE_TITLE),
        ] {
            let project = project();
            let mut value = settled_value(&project);
            value["agent"] = json!(agent);
            value["projectName"] = json!("api");
            let identity = identity_of(&project);
            let event = parse(&value, &project, Some(&identity), NOW).expect("settled");
            let mut store = NoticeStore::new(project);
            assert!(store.accept(&event, NOW));
            let notice = store.snapshot(NOW).remove(0);
            assert_eq!(notice.title, title, "agent {agent}");
            assert_eq!(notice.project_name.as_deref(), Some("api"));
        }
    }

    // The wire format is a contract other producers rely on: a `settled`
    // frame must decode and re-encode to the exact same bytes, and severity/
    // kind are INTERNAL fields of the in-app Notice that never reach (nor
    // come from) the wire.
    #[test]
    fn settled_wire_frames_round_trip_byte_identically() {
        let project = project();
        let identity = identity_of(&project);
        let frame = format!(
            r#"{{"v":1,"type":"settled","project":"{project}","sessionId":"session-1","at":{NOW},"id":"event-1"}}"#
        );
        let message = decode(frame.as_bytes(), &project, Some(&identity), NOW).expect("settled");
        assert_eq!(
            serde_json::to_string(&message).expect("re-encode"),
            frame,
            "the settled wire frame is byte-identical before and after"
        );
        // and the internal fields are not part of the wire message at all
        let wire = serde_json::to_string(&message).expect("re-encode");
        assert!(!wire.contains("severity"));
        assert!(!wire.contains("kind"));
    }

    // accept() rejects exactly what it rejected before: every kind other
    // than `settled`, at decode AND at the store boundary (defense in depth).
    #[test]
    fn admission_rejects_exactly_the_same_frames_as_before() {
        let project = project();
        let identity = identity_of(&project);
        let mut store = NoticeStore::new(project.clone());
        // Engine-facing / unknown types: rejected at decode in BOTH phases
        // (with and without the handshake) and at the store boundary.
        for kind in ["toast", "message_delta", "nope", "tests_passed"] {
            let frame = format!(
                r#"{{"v":1,"type":"{kind}","project":"{project}","sessionId":"session-1","at":{NOW}}}"#
            );
            assert!(
                decode(frame.as_bytes(), &project, Some(&identity), NOW).is_err(),
                "decode must reject {kind}"
            );
            assert!(
                decode(frame.as_bytes(), &project, None, NOW).is_err(),
                "decode without handshake must reject {kind}"
            );
            let message = Message {
                v: 1,
                kind: kind.to_string(),
                project: project.clone(),
                session_id: "session-1".to_string(),
                at: NOW as i64,
                id: None,
                project_name: None,
                agent: None,
                title: None,
                detail: None,
            };
            assert!(!store.accept(&message, NOW), "accept must reject {kind}");
        }
        // hello and heartbeat stay legal WIRE frames (handshake / keepalive)
        // — decode accepts them in their own phase, exactly as before —
        // but neither is ever admitted as a notice.
        let hello = parse(&hello_value(&project), &project, None, NOW).expect("hello decodes");
        let heartbeat_value = json!({"v":1, "type":"heartbeat", "project":project,
                                     "sessionId":"session-1", "at":NOW});
        let heartbeat = parse(&heartbeat_value, &project, Some(&identity), NOW)
            .expect("heartbeat decodes after the handshake");
        assert!(!store.accept(&hello, NOW), "a hello is never a notice");
        assert!(!store.accept(&heartbeat, NOW), "a heartbeat is never a notice");
        // a stowaway `id` on a non-settled type is still a schema error
        let toast_with_id = format!(
            r#"{{"v":1,"type":"toast","project":"{project}","sessionId":"session-1","at":{NOW},"id":"event-1"}}"#
        );
        assert!(decode(toast_with_id.as_bytes(), &project, Some(&identity), NOW).is_err());
        // the settled happy path still admits exactly one notice
        let settled = parse(&settled_value(&project), &project, Some(&identity), NOW).expect("settled");
        assert!(store.accept(&settled, NOW));
        assert_eq!(store.snapshot(NOW).len(), 1);
    }

    // GD032: severity/kind live on the notice model, single source in Rust.
    // A wire `settled` notice defaults to severity `info` / kind `settled`
    // (existing notices render unchanged); the UI only renders what this
    // model admits.
    #[test]
    fn notice_model_carries_internal_severity_and_kind() {
        let project = project();
        let identity = identity_of(&project);
        let event = parse(&settled_value(&project), &project, Some(&identity), NOW).expect("settled");
        let mut store = NoticeStore::new(project.clone());
        assert!(store.accept(&event, NOW));
        let notice = store.snapshot(NOW).into_iter().next().expect("one notice");
        assert_eq!(notice.severity, "info", "existing settled notices are informational");
        assert_eq!(notice.kind, "settled");
        let value = serde_json::to_value(&notice).expect("serializes");
        assert_eq!(value["severity"], "info");
        assert_eq!(value["kind"], "settled");
        // the closed severity set the UI classifies
        for severity in [SEVERITY_INFO, SEVERITY_WARNING, SEVERITY_ERROR] {
            assert!(matches!(severity, "info" | "warning" | "error"));
        }
    }

    // OD006: a transport failure is a STATE-DERIVED error notice at the FRONT
    // of the queue: it appears on an abnormal drop, clears itself when the
    // transport recovers, never expires while the failure lasts, and a human
    // dismissal hides it until the NEXT distinct failure event.
    #[test]
    fn transport_failure_notice_appears_clears_and_is_dismissible_per_event() {
        let project = project();
        let identity = identity_of(&project);
        let event = parse(&settled_value(&project), &project, Some(&identity), NOW).expect("settled");
        let mut store = NoticeStore::new(project.clone());
        assert!(store.accept(&event, NOW));
        // boot with no Pi is not a failure; connecting is not a failure
        store.connections_changed(0, NOW);
        store.connections_changed(1, NOW);
        {
            let list = store.snapshot(NOW);
            assert_eq!(list.len(), 1, "only the settled notice");
            assert_eq!(list[0].kind, "settled");
        }
        // An abnormal DROP: the receiver explicitly reports the failure.
        store.connections_changed(0, NOW + 1);
        store.transport_failed(TransportFailure::ConnectionLost, NOW + 1);
        let failure;
        {
            let list = store.snapshot(NOW + 1);
            assert_eq!(list.len(), 2, "failure + settled");
            assert_eq!(list[0].kind, "transport", "the failure leads the strip");
            assert_eq!(list[0].severity, "error");
            assert_eq!(list[1].kind, "settled", "existing notices stay queued behind");
            failure = list[0].clone();
        }
        // while the failure lasts it never ages out (the settled one does)
        {
            let list = store.snapshot(NOW + EXPIRY_MS + 2);
            assert_eq!(list.len(), 1, "the settled notice expired, the failure did not");
            assert_eq!(list[0].kind, "transport");
        }
        // dismissal: exact (id + session), the settled notice is untouched
        store.connections_changed(1, NOW + 3); // recovery first: clears it
        assert!(store.snapshot(NOW + 3).iter().all(|n| n.kind != "transport"),
            "recovery clears the failure notice by itself");
        store.connections_changed(0, NOW + 4); // abnormal drop again
        store.transport_failed(TransportFailure::ConnectionLost, NOW + 4);
        let second;
        {
            let list = store.snapshot(NOW + 4);
            assert_eq!(list[0].kind, "transport");
            second = list[0].clone();
        }
        assert_ne!(second.id, failure.id, "a later distinct drop is a new event id");
        assert!(store.dismiss_exact(&second.id, NOW + 5), "transport-N supports exact × dismissal");
        assert!(store.snapshot(NOW + 5).iter().all(|n| n.kind != "transport"),
            "the human dismissed this failure event");
        // still down: snapshots never re-insert a dismissed event
        assert!(store.snapshot(NOW + 6).iter().all(|n| n.kind != "transport"),
            "a dismissed failure event stays dismissed while the state is unchanged");
        store.connections_changed(1, NOW + 7); // recovery
        store.connections_changed(0, NOW + 8); // the NEXT abnormal drop
        store.transport_failed(TransportFailure::ConnectionLost, NOW + 8);
        let third = store.snapshot(NOW + 8).into_iter().next().expect("notice");
        assert_eq!(third.kind, "transport");
        assert_ne!(third.id, second.id, "a later distinct drop shows again");
    }

    // OD006: the startup receiver failure (main.cjs `unavailable = true`).
    // No retry exists (out of scope for #373), so the notice is inserted once
    // and persists; dismissal hides it and nothing re-inserts it.
    #[test]
    fn unavailable_transport_inserts_one_persistent_notice() {
        let project = project();
        let mut store = NoticeStore::new(project.clone());
        store.transport_failed(TransportFailure::Unavailable, NOW);
        let first;
        {
            let list = store.snapshot(NOW + EXPIRY_MS + 1);
            assert_eq!(list.len(), 1);
            assert_eq!(list[0].severity, "error");
            assert_eq!(list[0].kind, "transport");
            assert_eq!(list[0].title, "Avisos caídos");
            first = list[0].clone();
        }
        store.dismiss(&first.id, &first.session_id, NOW + 2);
        assert!(store.snapshot(NOW + 3).is_empty(), "dismissed and never re-inserted");
    }

    // The failure notice must survive a full queue without ever evicting
    // itself: the legacy front-drain would delete it (it sits at the front).
    #[test]
    fn a_full_queue_keeps_the_failure_and_drops_the_oldest_settled() {
        let project = project();
        let identity = identity_of(&project);
        let mut store = NoticeStore::new(project.clone());
        for i in 0..QUEUE {
            let value = json!({"v":1, "type":"settled", "project":project,
                               "sessionId":"session-1", "at":NOW, "id":format!("id-{i}")});
            let message = decode(value.to_string().as_bytes(), &project, Some(&identity), NOW)
                .expect("valid settled");
            assert!(store.accept(&message, NOW));
        }
        assert_eq!(store.snapshot(NOW).len(), QUEUE);
        store.connections_changed(1, NOW);
        store.connections_changed(0, NOW + 1);
        store.transport_failed(TransportFailure::ConnectionLost, NOW + 1); // abnormal exit evidence
        let list = store.snapshot(NOW + 1);
        assert_eq!(list.len(), QUEUE, "still bounded at QUEUE");
        assert_eq!(list[0].kind, "transport", "the failure leads and survives");
        assert_eq!(list[1].id, "id-1", "the OLDEST settled notice was evicted, exactly as before");
        assert_eq!(list.last().expect("last").id, "id-7");
    }

    // ported from legacy transport.cjs:73-75
    #[test]
    fn frame_quota_is_a_fixed_one_minute_window_per_connection() {
        let mut quota = FrameQuota::new(1_000);
        for i in 0..FRAMES_PER_MINUTE {
            quota.check(1_000 + u128::from(i))
                .unwrap_or_else(|e| panic!("frame {i} inside the window: {e:?}"));
        }
        assert_eq!(quota.check(1_500).unwrap_err(), QuotaError::RateExceeded);
        // rejected attempts keep consuming budget inside the same window
        assert_eq!(quota.check(1_600).unwrap_err(), QuotaError::RateExceeded);
        // fixed window: exactly period + 60 000 resets the counter
        assert!(quota.check(61_000).is_ok());
        assert!(quota.check(61_001).is_ok());
    }

    // --- S10 (L25): optional display keys on `settled` ------------------------

    fn proved() -> Identity {
        Identity { project: project(), session_id: "session-1".into(), at: NOW as i64 }
    }
    fn settled_with(name: Value, agent: Value) -> Value {
        let mut v = settled_value(&project());
        v["projectName"] = name;
        v["agent"] = agent;
        v
    }

    #[test]
    fn an_old_settled_frame_is_accepted_unchanged_and_carries_no_display_fields() {
        let message = parse(&settled_value(&project()), &project(), Some(&proved()), NOW).expect("old frame stays valid");
        assert_eq!((message.project_name, message.agent), (None, None));
    }

    #[test]
    fn a_settled_frame_with_both_display_fields_is_accepted_and_reaches_the_notice() {
        let frame = settled_with(json!("my-project"), json!("claude-code"));
        let message = parse(&frame, &project(), Some(&proved()), NOW).expect("new frame is valid");
        assert_eq!(message.project_name.as_deref(), Some("my-project"));
        assert_eq!(message.agent.as_deref(), Some("claude-code"));
        let mut store = NoticeStore::new(project());
        assert!(store.accept(&message, NOW));
        let notice = &store.snapshot(NOW)[0];
        assert_eq!((notice.project_name.as_deref(), notice.agent.as_deref()), (Some("my-project"), Some("claude-code")));
        let value = serde_json::to_value(notice).unwrap();
        assert_eq!(value["projectName"], "my-project");
        assert_eq!(value["agent"], "claude-code");
    }

    #[test]
    fn an_old_notice_serializes_without_the_new_keys() {
        let message = parse(&settled_value(&project()), &project(), Some(&proved()), NOW).unwrap();
        let mut store = NoticeStore::new(project());
        assert!(store.accept(&message, NOW));
        let value = serde_json::to_value(&store.snapshot(NOW)[0]).unwrap();
        assert!(value.get("projectName").is_none() && value.get("agent").is_none(), "{value}");
    }

    #[test]
    fn every_display_field_out_of_format_refuses_the_whole_frame() {
        let long = "a".repeat(65);
        for name in [json!(""), json!(" lead"), json!("trail "), json!("a/b"), json!("a\u{0}b"), json!("<b>"), json!(long), json!(7), json!(null), json!("ñandú")] {
            let frame = settled_with(name.clone(), json!("pi"));
            assert_eq!(parse(&frame, &project(), Some(&proved()), NOW), Err(DecodeError::InvalidSchemaOrScope), "projectName {name}");
        }
        let long_agent = "a".repeat(33);
        for agent in [json!(""), json!("Pi"), json!("-pi"), json!("a b"), json!("a/b"), json!(long_agent), json!(1), json!(null)] {
            let frame = settled_with(json!("proj"), agent.clone());
            assert_eq!(parse(&frame, &project(), Some(&proved()), NOW), Err(DecodeError::InvalidSchemaOrScope), "agent {agent}");
        }
    }

    #[test]
    fn the_two_display_fields_travel_together_and_an_unknown_key_is_still_refused() {
        let mut only_name = settled_value(&project());
        only_name["projectName"] = json!("proj");
        assert_eq!(parse(&only_name, &project(), Some(&proved()), NOW), Err(DecodeError::InvalidSchemaOrScope));
        let mut only_agent = settled_value(&project());
        only_agent["agent"] = json!("pi");
        assert_eq!(parse(&only_agent, &project(), Some(&proved()), NOW), Err(DecodeError::InvalidSchemaOrScope));
        let mut extra = settled_with(json!("proj"), json!("pi"));
        extra["extra"] = json!(1);
        assert_eq!(parse(&extra, &project(), Some(&proved()), NOW), Err(DecodeError::InvalidSchemaOrScope));
        // the display keys exist only on `settled`
        let mut hello = hello_value(&project());
        hello["projectName"] = json!("proj");
        hello["agent"] = json!("pi");
        assert_eq!(parse(&hello, &project(), None, NOW), Err(DecodeError::InvalidSchemaOrScope));
    }

    // --- S4/T2: the «attention» notice (Codex asks in its own terminal) -----------------------

    fn attention_value(id: &str) -> Value {
        json!({"v":1, "type":"attention", "project":project(), "sessionId":"session-1", "at":NOW, "id":id,
               "title":"Codex te pide permiso", "detail":"Bash: npm install · Respondé en la terminal",
               "projectName":"my-project", "agent":"codex"})
    }

    #[test]
    fn attention_notice_is_admitted_with_its_text_and_leads_the_strip() {
        let project = project();
        let identity = identity_of(&project);
        let settled = parse(&settled_value(&project), &project, Some(&identity), NOW).expect("settled");
        let mut store = NoticeStore::new(project.clone());
        assert!(store.accept(&settled, NOW), "the finished notice is queued");
        let event = parse(&attention_value("attn-1"), &project, Some(&identity), NOW).expect("attention decodes");
        assert_eq!(event.title.as_deref(), Some("Codex te pide permiso"));
        assert_eq!(event.detail.as_deref(), Some("Bash: npm install · Respondé en la terminal"));
        assert!(store.accept(&event, NOW), "the attention notice is admitted");
        let list = store.snapshot(NOW);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].kind, "attention", "a pending prompt leads the strip");
        assert_eq!(list[1].kind, "settled", "the finished notice keeps its place behind it");
        assert_eq!(list[0].title, "Codex te pide permiso");
        assert_eq!(list[0].detail, "Bash: npm install · Respondé en la terminal");
        assert_eq!(list[0].severity, "warning", "the strip wears the sun tone");
        assert_eq!(list[0].emotion, "sun");
        assert_eq!(list[0].agent.as_deref(), Some("codex"));
        assert_eq!(list[0].project_name.as_deref(), Some("my-project"));
        assert_eq!(list[0].expires_at, NOW as i64 + EXPIRY_MS as i64, "a notice ages out like any other");
        // the wire text reaches the UI, the toast is dismissible by its own id
        let value = serde_json::to_value(&list[0]).expect("serializes");
        assert_eq!(value["kind"], "attention");
        assert_eq!(value["title"], "Codex te pide permiso");
        assert!(store.dismiss_exact("attn-1", NOW));
        assert!(store.snapshot(NOW).iter().all(|n| n.kind != "attention"));
        // an attention notice is never a settled completion: its own dedupe key, and it is not a decision
        assert!(!store.accept(&event, NOW), "the same event id never queues twice");
    }

    #[test]
    fn attention_frames_reject_malformed_text_keys_and_scope() {
        let project = project();
        let identity = identity_of(&project);
        let base = attention_value("attn-1");
        let variants: Vec<(&str, Value)> = vec![
            ("no detail", { let mut v = base.clone(); v.as_object_mut().unwrap().remove("detail"); v }),
            ("no title", { let mut v = base.clone(); v.as_object_mut().unwrap().remove("title"); v }),
            ("no id", { let mut v = base.clone(); v.as_object_mut().unwrap().remove("id"); v }),
            ("blank title", { let mut v = base.clone(); v["title"] = json!("  "); v }),
            ("empty detail", { let mut v = base.clone(); v["detail"] = json!(""); v }),
            ("control char", { let mut v = base.clone(); v["detail"] = json!("a\u{7}b"); v }),
            ("newline", { let mut v = base.clone(); v["detail"] = json!("a\nb"); v }),
            ("tab", { let mut v = base.clone(); v["detail"] = json!("a\tb"); v }),
            ("bidi", { let mut v = base.clone(); v["title"] = json!("a\u{202e}b"); v }),
            ("zero width", { let mut v = base.clone(); v["detail"] = json!("a\u{200b}b"); v }),
            ("long title", { let mut v = base.clone(); v["title"] = json!("a".repeat(ATTENTION_TITLE_MAX + 1)); v }),
            ("long detail", { let mut v = base.clone(); v["detail"] = json!("a".repeat(ATTENTION_DETAIL_MAX + 1)); v }),
            ("non-string title", { let mut v = base.clone(); v["title"] = json!(7); v }),
            ("stowaway key", { let mut v = base.clone(); v["decision"] = json!("allow"); v }),
            ("stowaway option", { let mut v = base.clone(); v["options"] = json!([]); v }),
            ("bad projectName", { let mut v = base.clone(); v["projectName"] = json!("a/b"); v }),
            ("agent only", { let mut v = base.clone(); v.as_object_mut().unwrap().remove("projectName"); v }),
        ];
        for (name, value) in variants {
            assert!(parse(&value, &project, Some(&identity), NOW).is_err(), "must reject: {name}");
        }
        // the display keys belong to `settled` and `attention`, never to a hello or a heartbeat
        let mut hello = hello_value(&project);
        hello["title"] = json!("Codex te pide permiso");
        hello["detail"] = json!("Respondé en la terminal");
        assert_eq!(parse(&hello, &project, None, NOW), Err(DecodeError::InvalidSchemaOrScope));
        // and an attention frame is not a handshake
        assert_eq!(parse(&attention_value("attn-1"), &project, None, NOW), Err(DecodeError::HandshakeRequired));
        // the accept boundary re-validates: a hand-built Message cannot smuggle a kind the wire refuses
        let mut store = NoticeStore::new(project.clone());
        let smoke = Message { v: 1, kind: KIND_ATTENTION.to_string(), project: project.clone(),
            session_id: "session-1".into(), at: NOW as i64, id: Some("attn-9".into()),
            project_name: None, agent: None, title: None, detail: None };
        assert!(store.accept(&smoke, NOW), "the store admits the validated shape");
        assert_eq!(store.snapshot(NOW)[0].title, "", "an absent title stays empty, never invented");
    }

    #[test]
    fn attention_clear_removes_only_this_sessions_attention_notices() {
        let project = project();
        let identity = identity_of(&project);
        let mut store = NoticeStore::new(project.clone());
        let settled = parse(&settled_value(&project), &project, Some(&identity), NOW).expect("settled");
        assert!(store.accept(&settled, NOW));
        assert!(store.accept(&parse(&attention_value("attn-1"), &project, Some(&identity), NOW).unwrap(), NOW));
        // a second session (its own proved identity) with its own pending prompt
        let other = json!({"v":1, "type":"attention", "project":project, "sessionId":"session-2", "at":NOW,
                           "id":"attn-2", "title":"Codex te pregunta", "detail":"Respondé en la terminal"});
        let identity_2 = Identity { project: project.clone(), session_id: "session-2".into(), at: NOW as i64 };
        let other = decode(other.to_string().as_bytes(), &project, Some(&identity_2), NOW).expect("session-2 attention");
        assert!(store.accept(&other, NOW));
        assert_eq!(store.snapshot(NOW).iter().filter(|n| n.kind == "attention").count(), 2);
        // the clearing frame is session-scoped and needs no id
        let clear = json!({"v":1, "type":"attention_clear", "project":project, "sessionId":"session-1", "at":NOW});
        let clear = parse(&clear, &project, Some(&identity), NOW).expect("clear decodes");
        assert!(store.accept(&clear, NOW), "a clear changes what the island shows");
        let left = store.snapshot(NOW);
        assert_eq!(left.iter().filter(|n| n.kind == "attention").count(), 1, "session-1's notice is gone");
        assert_eq!(left.iter().find(|n| n.kind == "attention").unwrap().id, "attn-2", "session-2 keeps its own");
        assert_eq!(left.iter().filter(|n| n.kind == "settled").count(), 1, "the finished notice is untouched");
        // idempotent: clearing again changes nothing and still reports the frame was handled
        assert!(store.accept(&clear, NOW));
        assert_eq!(store.snapshot(NOW).len(), 2);
        // a stowaway key on the clear frame is refused
        let mut extra = json!({"v":1, "type":"attention_clear", "project":project, "sessionId":"session-1", "at":NOW});
        extra["id"] = json!("attn-1");
        assert!(parse(&extra, &project, Some(&identity), NOW).is_err());
    }

    #[test]
    fn attention_stays_bounded_and_never_evicts_a_transport_failure() {
        let project = project();
        let identity = identity_of(&project);
        let mut store = NoticeStore::new(project.clone());
        for i in 0..QUEUE {
            let value = json!({"v":1, "type":"settled", "project":project, "sessionId":"session-1", "at":NOW, "id":format!("id-{i}")});
            let message = decode(value.to_string().as_bytes(), &project, Some(&identity), NOW).expect("settled");
            assert!(store.accept(&message, NOW));
        }
        let attention = parse(&attention_value("attn-1"), &project, Some(&identity), NOW).expect("attention");
        assert!(store.accept(&attention, NOW));
        let list = store.snapshot(NOW);
        assert_eq!(list.len(), QUEUE, "still bounded");
        assert_eq!(list[0].kind, "attention", "the prompt leads");
        assert_eq!(list[1].id, "id-1", "the OLDEST settled notice was the victim");
        store.connections_changed(1, NOW);
        store.connections_changed(0, NOW + 1);
        store.transport_failed(TransportFailure::ConnectionLost, NOW + 1);
        let list = store.snapshot(NOW + 1);
        assert_eq!(list[0].kind, "transport", "a real failure still leads");
        assert!(list.iter().any(|n| n.kind == "attention"), "the pending prompt is not the victim either");
        assert_eq!(list.len(), QUEUE);
    }

    #[test]
    fn attention_text_rule_keeps_the_spanish_sentence_and_refuses_invisible_reordering() {
        for ok in ["Codex te pide permiso", "Bash: npm install · Respondé en la terminal", "¿Qué alcance?"] {
            assert!(notice_text_ok(ok, ATTENTION_DETAIL_MAX), "must accept {ok:?}");
        }
        for bad in ["", "   ", "a\u{0}b", "a\nb", "a\tb", "a\u{202e}b", "a\u{200b}b", "a\u{2066}b", "a\u{feff}b"] {
            assert!(!notice_text_ok(bad, ATTENTION_DETAIL_MAX), "must refuse {bad:?}");
        }
        assert!(notice_text_ok(&"é".repeat(ATTENTION_DETAIL_MAX), ATTENTION_DETAIL_MAX), "the bound counts chars, not bytes");
        assert!(!notice_text_ok(&"é".repeat(ATTENTION_DETAIL_MAX + 1), ATTENTION_DETAIL_MAX));
    }

}

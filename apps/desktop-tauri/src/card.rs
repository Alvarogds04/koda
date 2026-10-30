//! Approval card lane — pure module, unit M3 (test-first, RED → GREEN).
//!
//! Behaviour-equivalent port of the Electron proposal-card logic; the source
//! is read-only (`worktrees/legacy-electron/apps/desktop`):
//! - `main.cjs` `REASON` (77), `sameCard` (220), `validExpiry` (221),
//!   `parseProposals` (232), `receiveCandidate` (250), `cardReason` (265),
//!   `projectedCard` (276),
//! - `core.cjs` `chooseRequest` (89).
//!
//! No I/O and no clock of its own: `now` is an argument and every value is
//! wired in by the caller (`main.rs` snapshot/dispatch, `approval.rs` poll
//! and decide). Time is milliseconds since the epoch as `i64`, exactly what
//! JavaScript's `Date.parse` yields (including negative values for years
//! before 1970).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::desktop::BridgeStatus;

/// `main.cjs REASON` (line 77), byte-equal strings: these are user-visible
/// Spanish texts and the webview renders them verbatim.
pub struct Reason;
impl Reason {
    pub const DISABLED: &'static str = "Puente deshabilitado: configuración no válida.";
    pub const STARTING: &'static str = "Conectando con el puente.";
    pub const HEALTHY: &'static str = "Puente disponible.";
    pub const UNHEALTHY: &'static str = "Puente no disponible.";
    pub const STOPPED: &'static str = "Autenticación detenida; reiniciá la aplicación.";
    pub const COMPACT: &'static str = "Abrí la tarjeta para decidir.";
    pub const INVISIBLE: &'static str = "La ventana no está visible.";
    pub const EXPIRED: &'static str = "Propuesta vencida.";
    pub const BUSY: &'static str = "Decisión en curso.";
    pub const CHANGED: &'static str = "Propuesta no disponible para decidir.";
    pub const CONFLICT: &'static str = "No se pudo confirmar la decisión.";
    pub const SENT: &'static str = "Decisión enviada.";

    /// `main.cjs status(value)` (115): a state name always carries its own
    /// reason text from the same table.
    pub fn for_state(state: &str) -> &'static str {
        match state {
            "disabled" => Reason::DISABLED,
            "starting" => Reason::STARTING,
            "healthy" => Reason::HEALTHY,
            "unhealthy" => Reason::UNHEALTHY,
            "stopped" => Reason::STOPPED,
            _ => "",
        }
    }
}

/// One pending proposal as the host keeps it (`main.cjs parseProposals`
/// candidate): only the identity, the binding hash, the display fields and
/// the sticky decision reason — never the private payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub hash: String,
    pub operation: String,
    pub expires_at: String,
    /// `Date.parse(expires_at)` — epoch milliseconds, may be negative.
    pub expires: i64,
    /// Sticky once set: a decided/expired/changed card never revives
    /// (`main.cjs`: `selected.reason ||= …`).
    pub reason: Option<&'static str>,
}

/// The standing request a `choose(index)` would answer (`main.cjs
/// requestState`). No producer exists yet — not in M3 either (the observer
/// that fills it is a later slice in the legacy plan) — so this is always
/// `None` and every choice is rejected for lack of a standing request,
/// exactly like Electron today.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StandingRequest {
    pub origin: String,
    pub question: String,
    /// `[{ label, detail }, …]` — the renderer picks by INDEX only.
    pub options: Vec<Value>,
}

/// `main.cjs validExpiry` (221): the timestamp must match the exact
/// `YYYY-MM-DDTHH:MM:SS(.1..6 digits)?(Z|±HH:MM)` shape, fully, AND parse to
/// a finite date AND carry a real calendar value (month lengths incl. leap
/// years, hour/minute/second and offset ranges).
pub fn valid_expiry(value: &str) -> bool {
    parse_expiry_ms(value).is_some()
}

/// `main.cjs Date.parse` equivalent for the validated shape above. Returns
/// epoch milliseconds or None.
pub fn parse_expiry_ms(value: &str) -> Option<i64> {
    fn digits(slice: &[u8], count: usize) -> Option<u64> {
        if slice.len() != count {
            return None;
        }
        let mut out = 0u64;
        for byte in slice {
            if !byte.is_ascii_digit() {
                return None;
            }
            out = out * 10 + u64::from(byte - b'0');
        }
        Some(out)
    }
    let bytes = value.as_bytes();
    // `YYYY-MM-DDTHH:MM:SS` — exact positions, zero padded (legacy regex).
    if bytes.len() < 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let year = digits(&bytes[0..4], 4)?;
    let month = digits(&bytes[5..7], 2)?;
    let day = digits(&bytes[8..10], 2)?;
    let hour = digits(&bytes[11..13], 2)?;
    let minute = digits(&bytes[14..16], 2)?;
    let second = digits(&bytes[17..19], 2)?;
    let mut at = 19;
    // optional fraction: exactly 1..=6 digits (legacy `\d{1,6}`)
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        let start = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        let width = at - start;
        if !(1..=6).contains(&width) {
            return None;
        }
    }
    // zone: `Z` or `±HH:MM` with the legacy offset range checks
    let offset_minutes = match bytes.get(at) {
        Some(b'Z') => {
            at += 1;
            0i64
        }
        Some(b'+') | Some(b'-') => {
            let sign = if bytes[at] == b'-' { -1i64 } else { 1i64 };
            at += 1;
            if bytes.get(at + 2) != Some(&b':') {
                return None;
            }
            let offset_hour = digits(&bytes[at..at + 2], 2)? as i64;
            let offset_minute = digits(&bytes[at + 3..at + 5], 2)? as i64;
            at += 5;
            if offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            sign * (offset_hour * 60 + offset_minute)
        }
        _ => return None,
    };
    if at != bytes.len() {
        return None; // `parts[0] !== value`: nothing may trail the zone
    }
    // calendar validity: month lengths incl. leap years, then time ranges
    if !(1..=12).contains(&month) {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [31u64, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if day < 1 || day > month_days[(month - 1) as usize] {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    // days since epoch (civil calendar, Howard Hinnant's algorithm) — the
    // same instants JavaScript's Date.parse yields for this shape.
    let y = year as i64;
    let m = month as i64;
    let d = day as i64;
    let shifted = if m <= 2 { y - 1 } else { y };
    let era = if shifted >= 0 { shifted } else { shifted - 399 } / 400;
    let year_of_era = shifted - era * 400;
    let day_of_year = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(
        days * 86_400_000
            + (hour as i64 * 3_600 + minute as i64 * 60 + second as i64) * 1_000
            - offset_minutes * 60_000,
    )
}

/// `proposal_[a-f0-9]{32}` (41 chars) — `main.cjs parseProposals` id rule.
pub fn valid_proposal_id(id: &str) -> bool {
    id.len() == 41
        && id.starts_with("proposal_")
        && id[9..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Lowercase `[a-f0-9]{64}` — the `payload_hash` binding rule.
pub fn valid_payload_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// True when `operation` is displayable legacy text: non-empty after trim,
/// at most 120 UTF-16 code units (JavaScript `.length`), no control
/// characters (`[\x00-\x1f\x7f-\x9f]`).
pub fn valid_operation(operation: &str) -> bool {
    !operation.trim().is_empty()
        && operation.encode_utf16().count() <= 120
        && !operation.chars().any(|c| {
            let unit = c as u32;
            unit <= 0x1f || (0x7f..=0x9f).contains(&unit)
        })
}

/// `main.cjs parseProposals` (232), ported:
/// - the value must be an array of at most 100 entries; a non-object entry
///   fails the WHOLE list (fail closed, no partial trust),
/// - non-`pending` entries are skipped, pending ones must satisfy every
///   identity/hash/operation/expiry rule or the whole list fails,
/// - duplicate ids fail the whole list,
/// - the winner is the oldest expiry, ties broken by id (stable, private
///   identity order) — `Ok(None)` when no pending proposal stands.
pub fn parse_proposals(value: &Value) -> Result<Option<Candidate>, ()> {
    let items = value.as_array().ok_or(())?;
    if items.len() > 100 {
        return Err(());
    }
    let mut pending: Vec<Candidate> = Vec::new();
    for item in items {
        // non-object entries fail the WHOLE list before anything is judged
        let object = item.as_object().ok_or(())?;
        // only `pending` entries are candidates; any other (or missing)
        // status is skipped exactly like `item.status !== 'pending'`
        if object.get("status").and_then(Value::as_str) != Some("pending") {
            continue;
        }
        let id = object.get("id").and_then(Value::as_str).ok_or(())?;
        if !valid_proposal_id(id) {
            return Err(());
        }
        let hash = object.get("payload_hash").and_then(Value::as_str).ok_or(())?;
        if !valid_payload_hash(hash) {
            return Err(());
        }
        let operation = object.get("operation").and_then(Value::as_str).ok_or(())?;
        if !valid_operation(operation) {
            return Err(());
        }
        let expires_at = object.get("expires_at").and_then(Value::as_str).ok_or(())?;
        if !valid_expiry(expires_at) {
            return Err(());
        }
        if pending.iter().any(|other| other.id == id) {
            return Err(()); // duplicate identity: no partial trust
        }
        pending.push(Candidate {
            id: id.to_string(),
            hash: hash.to_string(),
            operation: operation.to_string(),
            expires_at: expires_at.to_string(),
            expires: parse_expiry_ms(expires_at).ok_or(())?,
            reason: None,
        });
    }
    // oldest expiry first, ties by private identity order (stable, not input
    // order) — `main.cjs` sort by `expires` then `id`
    pending.sort_by(|a, b| a.expires.cmp(&b.expires).then_with(|| a.id.cmp(&b.id)));
    Ok(pending.into_iter().next())
}

/// `main.cjs sameCard` (220): identity is id AND hash — the same proposal id
/// under a new payload hash is a DIFFERENT decision.
pub fn same_card(a: Option<&Candidate>, b: &Candidate) -> bool {
    a.is_some_and(|a| a.id == b.id && a.hash == b.hash)
}

/// `main.cjs receiveCandidate` (250), ported exactly (queued always takes the
/// fresh candidate first; an open overlay pins `selected` until an explicit
/// close/re-expand; a compact (or non-mutating) view promotes the queue):
/// - `queued` inherits the previous queued reason for the same card (a
///   stale repeat of a completed decision stays inert),
/// - an open EMPTY overlay never acquires an unseen actionable card,
/// - an expired pinned card gets the sticky `expired` reason on every poll,
/// - same id + same hash refreshes operation/expiry and copies the pinned
///   reason onto the queue; anything else marks the pinned card `changed`.
pub fn receive_candidate(
    queued: &mut Option<Candidate>,
    selected: &mut Option<Candidate>,
    candidate: Option<Candidate>,
    expanded: bool,
    mutation_busy: bool,
    now_ms: i64,
) {
    // F013 / R2 (#338): the store only writes `Status.EXPIRED` when
    // approve/execute is attempted (`sb_bridge/bridge.py:77-79,100-102`), so a
    // row whose `expires_at` already passed keeps polling as `pending`. Such a
    // candidate is ignored exactly like an empty pending list, otherwise the
    // expired card would sit on the island forever with no verb to clear it
    // (`approval.rs decide` refuses every verb once a reason exists).
    let mut candidate = candidate.filter(|fresh| fresh.expires > now_ms);
    // F013 / R1 (#338): `None` is legacy `receiveCandidate(null)` — the empty
    // pending list that `main.cjs poll` feeds on every poll (main.cjs:292).
    // `if (sameCard(queued, candidate)) candidate.reason = queued.reason`:
    // a stale repeat of a decided card inherits the sticky reason.
    if let (Some(previous), Some(incoming)) = (queued.as_ref(), candidate.as_mut()) {
        if same_card(Some(previous), incoming) {
            incoming.reason = previous.reason;
        }
    }
    *queued = candidate; // `queued = candidate` happens FIRST, always (may be null)
    if !expanded && !mutation_busy {
        *selected = queued.clone(); // `selected = queued` (same object in JS)
        return;
    }
    // An open empty overlay cannot suddenly acquire an action.
    let Some(pinned) = selected.as_mut() else {
        return;
    };
    if now_ms >= pinned.expires && pinned.reason.is_none() {
        pinned.reason = Some(Reason::EXPIRED); // `selected.reason ||= expired`
    }
    // The fresh candidate (if any) now lives in `queued` (legacy: `candidate`
    // IS `queued` after line 2). `sameCard(selected, null)` is false, so an
    // empty list lands on the `changed` branch below (main.cjs:257-258).
    match queued.as_mut() {
        Some(incoming) if incoming.id == pinned.id && incoming.hash == pinned.hash => {
            // same decision: refresh the display fields, copy the sticky reason
            // onto the queue (in JS both point at the shared object)
            pinned.operation = incoming.operation.clone();
            pinned.expires_at = incoming.expires_at.clone();
            pinned.expires = incoming.expires;
            incoming.reason = pinned.reason;
        }
        _ => {
            if pinned.reason.is_none() {
                pinned.reason = Some(Reason::CHANGED); // `selected.reason ||= changed`
            }
        }
    }
}

/// Inputs `main.cjs cardReason` (265) needs; every field is a value the host
/// already knows, none is derived here.
pub struct ReasonInput<'a> {
    pub card: &'a mut Candidate,
    pub status: &'a BridgeStatus,
    /// `quitting`: the app is on its way out — everything is inert.
    pub quitting: bool,
    /// `pollBusy`: a poll owns the lane right now.
    pub poll_busy: bool,
    /// `mutationBusy`: a decision is in flight.
    pub mutation_busy: bool,
    /// `ownMutation`: the decision asking about ITSELF skips only the
    /// mutation-busy gate (the poll gate still applies, legacy exactly).
    pub own_mutation: bool,
    /// `state === 'expanded'`.
    pub expanded: bool,
    /// `win.isVisible() === true`.
    pub visible: bool,
    pub now_ms: i64,
}

/// `main.cjs cardReason` (265), ported in the SAME order:
/// sticky reason → quitting → expiry (sticky) → bridge health → busy →
/// compact → invisible → actionable (`None`). Expiry is re-checked on EVERY
/// projection, so a card can never silently revive.
///
/// Note: legacy also tests `authStopped` separately from
/// `bridgeStatus.state !== 'healthy'`; `stopAuth` is the only writer that
/// sets `authStopped` and it always sets the status to `stopped` in the same
/// step, so the single status check is the same rule, not a re-reading.
pub fn card_reason(input: ReasonInput<'_>) -> Option<&'static str> {
    // legacy order: quitting → sticky reason → expiry → health → busy →
    // compact → invisible → actionable
    if input.quitting {
        return Some(Reason::STOPPED);
    }
    if let Some(reason) = input.card.reason {
        return Some(reason);
    }
    if input.now_ms >= input.card.expires {
        input.card.reason = Some(Reason::EXPIRED);
        return Some(Reason::EXPIRED);
    }
    if input.status.state != "healthy" {
        return Some(input.status.reason);
    }
    if (!input.own_mutation && input.mutation_busy) || input.poll_busy {
        return Some(Reason::BUSY);
    }
    if !input.expanded {
        return Some(Reason::COMPACT);
    }
    if !input.visible {
        return Some(Reason::INVISIBLE);
    }
    None
}

/// `main.cjs projectedCard` (276): `null` without a selected card, otherwise
/// EXACTLY the four keys `{operation, expires_at, state, reason}` with
/// `state: 'pending'` only when `card_reason` says the human may decide —
/// `inert` with the reason string otherwise. Private fields (id, hash,
/// payload) never reach the renderer.
pub fn project_card(
    selected: Option<&mut Candidate>,
    status: &BridgeStatus,
    quitting: bool,
    poll_busy: bool,
    mutation_busy: bool,
    expanded: bool,
    visible: bool,
    now_ms: i64,
) -> Value {
    let Some(card) = selected else {
        return Value::Null; // `if (!selected) return null`
    };
    let reason = card_reason(ReasonInput {
        card,
        status,
        quitting,
        poll_busy,
        mutation_busy,
        own_mutation: false,
        expanded,
        visible,
        now_ms,
    });
    json!({
        "operation": card.operation,
        "expires_at": card.expires_at,
        "state": if reason.is_some() { "inert" } else { "pending" },
        "reason": reason,
    })
}

/// `core.cjs chooseRequest` (89): the renderer sends an INDEX, never the
/// chosen text. A valid index answers `Ok` and the caller consumes the
/// standing request in the SAME synchronous step (read-and-consume is the
/// atomicity guarantee — no suspension may sit between them); anything else
/// is a rejection with the request untouched. With no producer of requests
/// existing, every choice lands on the `request: None` branch — Electron
/// answers `Denied` there too.
pub fn choose_request(request: Option<&StandingRequest>, index: i32) -> Result<(), ()> {
    // The payload gate already proved the index is an integer (core.cjs
    // `Number.isInteger`); here only the standing request judges it.
    let Some(standing) = request else {
        return Err(()); // no request standing → Denied
    };
    if index < 0 || index as usize >= standing.options.len() {
        return Err(()); // out of range → Denied, request untouched
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::BridgeStatus;
    use serde_json::json;

    const NOW: i64 = 1_893_456_000_000; // 2030-01-01T00:00:00Z (test clock)

    fn status(state: &'static str, reason: &'static str) -> BridgeStatus {
        BridgeStatus { state, reason }
    }
    fn healthy() -> BridgeStatus {
        status("healthy", Reason::HEALTHY)
    }

    /// proposal fixture: `main.test.cjs proposal()` (id `proposal_` + n×32).
    fn proposal_id(n: char) -> String {
        format!("proposal_{}", n.to_string().repeat(32))
    }
    fn candidate(n: char) -> Candidate {
        Candidate {
            id: proposal_id(n),
            hash: "c".repeat(64),
            operation: "Review document".into(),
            expires_at: "2030-01-01T00:10:00+00:00".into(),
            expires: date_2030_00_10(),
            reason: None,
        }
    }
    /// 2030-01-01T00:10:00Z in epoch ms.
    fn date_2030_00_10() -> i64 {
        1_893_456_600_000
    }

    fn list(items: &[Value]) -> Value {
        Value::Array(items.to_vec())
    }
    fn raw_proposal(n: char) -> Value {
        json!({
            "id": proposal_id(n),
            "payload_hash": "c".repeat(64),
            "operation": "Review document",
            "status": "pending",
            "expires_at": "2030-01-01T00:10:00+00:00",
            "principal": "private",
            "payload": { "secret": true },
            "target_snapshot": "private",
        })
    }
    fn patch(mut item: Value, key: &str, value: Value) -> Value {
        item.as_object_mut().unwrap().insert(key.into(), value);
        item
    }

    // --- validExpiry (main.cjs 221) ---------------------------------------

    #[test]
    fn expiry_accepts_the_exact_iso8601_shape() {
        for ok in [
            "2030-01-01T00:10:00Z",
            "2030-01-01T00:10:00+00:00",
            "2030-01-01T00:10:00-08:00",
            "2030-01-01T00:10:00.5Z",
            "2030-01-01T00:10:00.123456+05:30",
            "2024-02-29T23:59:59.999Z", // leap year
            "2030-12-31T23:59:59Z",
        ] {
            assert!(valid_expiry(ok), "{ok} must be valid");
        }
    }

    #[test]
    fn expiry_rejects_malformed_or_impossible_dates() {
        for bad in [
            "tomorrow",
            "",
            "2030-02-30T00:00:00Z",           // impossible day
            "2023-02-29T00:00:00Z",           // not a leap year
            "2030-04-31T00:00:00Z",           // 30 days in April
            "2030-01-01T24:00:00Z",           // hour 24
            "2030-01-01T00:60:00Z",           // minute 60
            "2030-01-01T00:00:60Z",           // second 60
            "2030-13-01T00:00:00Z",           // month 13
            "2030-00-01T00:00:00Z",           // month 0
            "2030-01-00T00:00:00Z",           // day 0
            "2030-1-01T00:00:00Z",            // not zero padded
            "2030-01-01",                     // no time
            "2030-01-01T00:10:00",            // no zone
            "2030-01-01t00:10:00Z",           // lowercase t
            "2030-01-01T00:10:00Z\n",         // trailing newline
            "2030-01-01T00:10:00Z ",          // trailing space
            " 2030-01-01T00:10:00Z",          // leading space
            "2030-01-01T00:10:00+24:00",      // offset hour 24
            "2030-01-01T00:10:00+00:60",      // offset minute 60
            "2030-01-01T00:10:00.1234567Z",   // 7 fraction digits
            "2030-01-01T00:10:00.Z",          // empty fraction
            "2030-01-01T00:10:00Zextra",      // garbage after zone
        ] {
            assert!(!valid_expiry(bad), "{bad} must be rejected");
        }
    }

    #[test]
    fn expiry_parse_matches_date_parse_semantics() {
        assert_eq!(parse_expiry_ms("2030-01-01T00:10:00Z"), Some(1_893_456_600_000));
        // a +01:00 offset shifts the instant back one hour
        assert_eq!(parse_expiry_ms("2030-01-01T00:10:00+01:00"), Some(1_893_456_600_000 - 3_600_000));
        // year 0 parses (JS does; negative epoch)
        assert!(parse_expiry_ms("0000-01-01T00:00:00Z").unwrap() < 0);
        assert_eq!(parse_expiry_ms("2030-02-30T00:00:00Z"), None);
    }

    // --- identity/hash/operation rules (parseProposals 232) ---------------

    #[test]
    fn proposal_id_and_hash_formats_are_exact() {
        assert!(valid_proposal_id(&proposal_id('a')));
        assert!(!valid_proposal_id(&format!("proposal_{}", "a".repeat(31))));
        assert!(!valid_proposal_id(&format!("proposal_{}", "A".repeat(32))));
        assert!(!valid_proposal_id(&format!("proposal_{}\n", "a".repeat(32))));
        assert!(valid_payload_hash(&"c".repeat(64)));
        assert!(!valid_payload_hash(&"c".repeat(63)));
        assert!(!valid_payload_hash(&"C".repeat(64)));
        assert!(!valid_payload_hash(&format!("{}\n", "c".repeat(64))));
    }

    #[test]
    fn operation_must_be_displayable_text() {
        assert!(valid_operation("Review document"));
        assert!(valid_operation(&"a".repeat(120)));
        assert!(!valid_operation(""));
        assert!(!valid_operation("   "));
        assert!(!valid_operation(&"a".repeat(121)));
        assert!(!valid_operation("bad\0text"));
        assert!(!valid_operation("bad\u{1f}text"));
        assert!(!valid_operation("bad\u{7f}text"));
        assert!(!valid_operation("bad\u{9f}text"));
        // UTF-16 length, like JavaScript `.length`: an emoji counts as 2
        let emoji = "😀".repeat(61); // 122 UTF-16 units
        assert!(!valid_operation(&emoji));
    }

    // --- parseProposals (main.cjs 232) ------------------------------------

    #[test]
    fn parses_the_oldest_pending_proposal_deterministically() {
        let older = patch(raw_proposal('b'), "expires_at", json!("2030-01-01T00:20:00Z"));
        let got = parse_proposals(&list(&[older, raw_proposal('a')])).unwrap().unwrap();
        assert_eq!(got.id, proposal_id('a'));
        assert_eq!(got.hash, "c".repeat(64));
        assert_eq!(got.operation, "Review document");
        assert_eq!(got.expires, 1_893_456_600_000);
        assert_eq!(got.reason, None);
        // tied expiry falls back to stable id order (private identity order)
        let tied = patch(raw_proposal('a'), "expires_at", json!("2030-01-01T00:20:00Z"));
        let tied_b = patch(raw_proposal('b'), "expires_at", json!("2030-01-01T00:20:00Z"));
        let got = parse_proposals(&list(&[tied_b, tied])).unwrap().unwrap();
        assert_eq!(got.id, proposal_id('a'), "id tiebreak, not input order");
    }

    #[test]
    fn non_pending_entries_are_skipped_and_empty_is_none() {
        let executed = patch(raw_proposal('a'), "status", json!("executed"));
        assert_eq!(parse_proposals(&list(&[executed])).unwrap(), None);
        assert_eq!(parse_proposals(&list(&[])).unwrap(), None);
        let mixed = list(&[patch(raw_proposal('a'), "status", json!("executed")), raw_proposal('b')]);
        assert_eq!(parse_proposals(&mixed).unwrap().unwrap().id, proposal_id('b'));
    }

    #[test]
    fn malformed_lists_are_never_actionable() {
        // ported from test/main.test.cjs `malformedLists`
        let malformed: Vec<Value> = vec![
            json!({}),
            list(&[patch(raw_proposal('A'), "id", json!(proposal_id('A')))]),
            list(&[patch(raw_proposal('a'), "payload_hash", json!("bad"))]),
            list(&[patch(raw_proposal('a'), "operation", json!(""))]),
            list(&[patch(raw_proposal('a'), "operation", json!("a".repeat(121)))]),
            list(&[patch(raw_proposal('a'), "operation", json!("bad\u{0}text"))]),
            list(&[patch(raw_proposal('a'), "operation", json!({}))]),
            list(&[patch(raw_proposal('a'), "expires_at", json!("tomorrow"))]),
            list(&[patch(raw_proposal('a'), "expires_at", json!(42))]),
            list(&vec![raw_proposal('a'); 101]),
            // noncanonical private fields (main.test.cjs)
            list(&[patch(raw_proposal('a'), "id", json!(format!("{}\n", proposal_id('a'))))]),
            list(&[patch(raw_proposal('a'), "payload_hash", json!(format!("{}\n", "c".repeat(64))))]),
            list(&[patch(raw_proposal('a'), "expires_at", json!("2030-02-30T00:00:00Z"))]),
            list(&[patch(raw_proposal('a'), "expires_at", json!("2030-01-01T24:00:00Z"))]),
            list(&[patch(raw_proposal('a'), "expires_at", json!("2030-01-01T00:10:00Z\n"))]),
        ];
        for (i, value) in malformed.iter().enumerate() {
            assert!(parse_proposals(value).is_err(), "malformed list {i} must fail closed");
        }
        // a non-object entry inside the array fails the whole list
        assert!(parse_proposals(&list(&[json!("str"), raw_proposal('a')])).is_err());
        // pending entries with valid shape but duplicate ids fail the list
        assert!(parse_proposals(&list(&[raw_proposal('a'), raw_proposal('a')])).is_err());
        // (a valid non-pending entry alone is NOT malformed — it parses to
        // no candidate; `non_pending_entries_are_skipped_and_empty_is_none`)
    }

    // --- receiveCandidate (main.cjs 250) ----------------------------------

    #[test]
    fn compact_poll_promotes_the_candidate_to_selected() {
        let mut queued = None;
        let mut selected = None;
        receive_candidate(&mut queued, &mut selected, Some(candidate('a')), false, false, NOW);
        assert_eq!(selected.as_ref().unwrap().id, proposal_id('a'));
        assert_eq!(queued.as_ref().unwrap().id, proposal_id('a'));
    }

    #[test]
    fn an_expired_incoming_candidate_is_ignored_like_an_empty_pending_list() {
        // F013 / R2 (#338): the row keeps polling as `pending` even after its
        // `expires_at` passed (only approve/execute write `Status.EXPIRED`),
        // so the host must ignore such a candidate exactly like an empty
        // pending list, or the expired card stays on screen forever.
        let mut queued = None;
        let mut selected = None;
        let mut stale = candidate('a');
        stale.expires = NOW - 1;
        receive_candidate(&mut queued, &mut selected, Some(stale), false, false, NOW);
        assert!(selected.is_none(), "an expired candidate never reaches the card");
        assert!(queued.is_none(), "an expired candidate never queues");
    }

    #[test]
    fn empty_pending_list_clears_the_card_while_the_island_is_compact() {
        // F013 / R1 (#338): legacy `main.cjs poll` always calls
        // `receiveCandidate(parseProposals(...))`, i.e. with `null` too
        // (main.cjs:292), which clears `queued` and — while compact —
        // `selected` (main.cjs:249-250). The stale card must retire.
        let mut queued = None;
        let mut selected = None;
        receive_candidate(&mut queued, &mut selected, Some(candidate('a')), false, false, NOW);
        assert!(selected.is_some());
        receive_candidate(&mut queued, &mut selected, None, false, false, NOW + 1);
        assert!(queued.is_none(), "an empty pending list clears the queue");
        assert!(selected.is_none(), "an empty pending list clears the card while compact");
    }

    #[test]
    fn empty_pending_list_keeps_the_pinned_card_inert_while_expanded() {
        // F013 / R1 (#338): while the overlay is open the pin survives the
        // empty list and goes inert `changed` (main.cjs:252-258); an already
        // expired pin keeps the sticky `expired` reason instead (order: expiry
        // first, then `changed`).
        let mut queued = None;
        let mut selected = None;
        receive_candidate(&mut queued, &mut selected, Some(candidate('a')), false, false, NOW);
        receive_candidate(&mut queued, &mut selected, None, true, false, NOW + 1);
        assert!(queued.is_none());
        let pinned = selected.as_ref().unwrap();
        assert_eq!(pinned.id, proposal_id('a'), "the pin is kept, not dropped");
        assert_eq!(pinned.reason, Some(Reason::CHANGED));
        // same path with a pin already past its expiry: `expired` is sticky
        selected.as_mut().unwrap().reason = None;
        selected.as_mut().unwrap().expires = NOW + 1;
        receive_candidate(&mut queued, &mut selected, None, true, false, NOW + 2);
        assert_eq!(selected.as_ref().unwrap().reason, Some(Reason::EXPIRED));
    }

    #[test]
    fn open_overlay_pins_the_selected_card_until_close_reexpand() {
        let mut queued = None;
        let mut selected = None;
        receive_candidate(&mut queued, &mut selected, Some(candidate('a')), false, false, NOW);
        // a replacement arrives while the overlay is open
        let mut replacement = candidate('b');
        replacement.operation = "Different operation".into();
        receive_candidate(&mut queued, &mut selected, Some(replacement), true, false, NOW);
        // the pinned card keeps ITS operation and becomes inert `changed`
        let pinned = selected.as_ref().unwrap();
        assert_eq!(pinned.id, proposal_id('a'));
        assert_eq!(pinned.operation, "Review document");
        assert_eq!(pinned.reason, Some(Reason::CHANGED));
        // the queue carries the replacement (a close/re-expand promotes it)
        assert_eq!(queued.as_ref().unwrap().id, proposal_id('b'));
        // explicit re-expand (compact poll then expand) swaps to the queue
        let promote = queued.clone().unwrap();
        receive_candidate(&mut queued, &mut selected, Some(promote), false, false, NOW);
        assert_eq!(selected.as_ref().unwrap().id, proposal_id('b'));
        assert_eq!(selected.as_ref().unwrap().reason, None);
    }

    #[test]
    fn empty_open_overlay_never_acquires_an_unseen_card() {
        let mut queued = None;
        let mut selected = None;
        receive_candidate(&mut queued, &mut selected, Some(candidate('a')), true, false, NOW);
        assert!(selected.is_none(), "open overlay without a pinned card");
        assert_eq!(queued.as_ref().unwrap().id, proposal_id('a'));
        // close + re-expand acquires it (compact poll promotes, expand keeps)
        let promote = queued.clone().unwrap();
        receive_candidate(&mut queued, &mut selected, Some(promote), false, false, NOW);
        assert_eq!(selected.as_ref().unwrap().id, proposal_id('a'));
    }

    #[test]
    fn same_id_same_hash_refreshes_fields_and_keeps_the_sticky_reason() {
        let mut queued = None;
        let mut selected = None;
        receive_candidate(&mut queued, &mut selected, Some(candidate('a')), false, false, NOW);
        // the pinned card was decided (sticky `sent`)
        selected.as_mut().unwrap().reason = Some(Reason::SENT);
        // a stale poll repeats the same card
        receive_candidate(&mut queued, &mut selected, Some(candidate('a')), true, false, NOW);
        let pinned = selected.as_ref().unwrap();
        assert_eq!(pinned.reason, Some(Reason::SENT), "decided stays inert");
        assert_eq!(queued.as_ref().unwrap().reason, Some(Reason::SENT));
        // same id with refreshed operation/expiry updates the pinned card
        let mut refreshed = candidate('a');
        refreshed.operation = "Revised label".into();
        receive_candidate(&mut queued, &mut selected, Some(refreshed), true, false, NOW);
        assert_eq!(selected.as_ref().unwrap().operation, "Revised label");
        assert_eq!(selected.as_ref().unwrap().reason, Some(Reason::SENT));
    }

    #[test]
    fn same_id_changed_hash_is_a_different_decision_and_goes_inert() {
        let mut queued = None;
        let mut selected = None;
        receive_candidate(&mut queued, &mut selected, Some(candidate('a')), false, false, NOW);
        let mut changed = candidate('a');
        changed.hash = "d".repeat(64);
        changed.operation = "Updated operation".into();
        receive_candidate(&mut queued, &mut selected, Some(changed), true, false, NOW);
        let pinned = selected.as_ref().unwrap();
        assert_eq!(pinned.operation, "Review document", "pin keeps old fields");
        assert_eq!(pinned.reason, Some(Reason::CHANGED));
    }

    #[test]
    fn expiry_of_a_pinned_card_is_rechecked_on_every_poll_and_sticky() {
        let mut queued = None;
        let mut selected = None;
        // compact poll promotes the card, then the overlay opens over it
        receive_candidate(&mut queued, &mut selected, Some(candidate('a')), false, false, NOW);
        // time passes inside the open overlay: the pin expires
        selected.as_mut().unwrap().expires = NOW - 1;
        receive_candidate(&mut queued, &mut selected, Some(candidate('a')), true, false, NOW);
        assert_eq!(selected.as_ref().unwrap().reason, Some(Reason::EXPIRED));
        // a later poll with a fresh expiry cannot revive it inside the open
        // overlay (main.test.cjs `expiry cannot silently revive`)
        let mut revived = candidate('a');
        revived.expires = NOW + 600_000;
        receive_candidate(&mut queued, &mut selected, Some(revived), true, false, NOW + 1);
        assert_eq!(selected.as_ref().unwrap().reason, Some(Reason::EXPIRED));
    }

    #[test]
    fn mutation_busy_pins_like_an_open_overlay() {
        // `if (state !== 'expanded' && !mutationBusy)`: compact + busy does
        // NOT promote; it follows the pinning branch (legacy exactly).
        let mut queued = None;
        let mut selected = None;
        receive_candidate(&mut queued, &mut selected, Some(candidate('a')), false, false, NOW);
        let mut replacement = candidate('b');
        replacement.operation = "Different".into();
        receive_candidate(&mut queued, &mut selected, Some(replacement), false, true, NOW + 1);
        assert_eq!(selected.as_ref().unwrap().id, proposal_id('a'));
        assert_eq!(selected.as_ref().unwrap().reason, Some(Reason::CHANGED));
    }

    // --- cardReason (main.cjs 265) ----------------------------------------

    fn input<'a>(card: &'a mut Candidate, st: &'a BridgeStatus) -> ReasonInput<'a> {
        ReasonInput {
            card,
            status: st,
            quitting: false,
            poll_busy: false,
            mutation_busy: false,
            own_mutation: false,
            expanded: true,
            visible: true,
            now_ms: NOW,
        }
    }

    #[test]
    fn reason_order_sticky_then_quit_then_expiry_then_health_then_busy_then_phase() {
        let st = healthy();
        // healthy + expanded + visible -> actionable
        let mut card = candidate('a');
        assert_eq!(card_reason(input(&mut card, &st)), None);
        // invisible window
        let mut card = candidate('a');
        let mut i = input(&mut card, &st);
        i.visible = false;
        assert_eq!(card_reason(i), Some(Reason::INVISIBLE));
        // compact island
        let mut card = candidate('a');
        let mut i = input(&mut card, &st);
        i.expanded = false;
        assert_eq!(card_reason(i), Some(Reason::COMPACT));
        // a poll owns the lane
        let mut card = candidate('a');
        let mut i = input(&mut card, &st);
        i.poll_busy = true;
        assert_eq!(card_reason(i), Some(Reason::BUSY));
        // a mutation is in flight (other callers see busy; the mutation
        // itself does not — own_mutation skips ONLY that gate)
        let mut card = candidate('a');
        let mut i = input(&mut card, &st);
        i.mutation_busy = true;
        assert_eq!(card_reason(i), Some(Reason::BUSY));
        let mut card = candidate('a');
        let mut i = input(&mut card, &st);
        i.mutation_busy = true;
        i.own_mutation = true;
        assert_eq!(card_reason(i), None, "own mutation ignores mutation busy");
        let mut card = candidate('a');
        let mut i = input(&mut card, &st);
        i.mutation_busy = true;
        i.poll_busy = true;
        i.own_mutation = true;
        assert_eq!(card_reason(i), Some(Reason::BUSY), "poll gate still applies");
        // unhealthy bridge reports ITS reason (and only when healthy may one
        // decide): health outranks busy/phase
        let unhealthy = status("unhealthy", Reason::UNHEALTHY);
        let mut card = candidate('a');
        let mut i = input(&mut card, &unhealthy);
        i.expanded = false;
        assert_eq!(card_reason(i), Some(Reason::UNHEALTHY));
        // stopped auth
        let stopped = status("stopped", Reason::STOPPED);
        let mut card = candidate('a');
        assert_eq!(card_reason(input(&mut card, &stopped)), Some(Reason::STOPPED));
        // quitting -> stopped, before anything else
        let mut card = candidate('a');
        let mut i = input(&mut card, &st);
        i.quitting = true;
        assert_eq!(card_reason(i), Some(Reason::STOPPED));
    }

    #[test]
    fn expiry_wins_over_health_and_becomes_sticky() {
        let unhealthy = status("unhealthy", Reason::UNHEALTHY);
        let mut card = candidate('a');
        card.expires = NOW - 1;
        // expiry is checked BEFORE the health gate (legacy order)
        assert_eq!(card_reason(input(&mut card, &unhealthy)), Some(Reason::EXPIRED));
        assert_eq!(card.reason, Some(Reason::EXPIRED), "sticky on the card");
        // a later healthy read still reports the sticky reason
        assert_eq!(card_reason(input(&mut card, &healthy())), Some(Reason::EXPIRED));
    }

    #[test]
    fn sticky_decided_reason_never_revives() {
        let mut card = candidate('a');
        card.reason = Some(Reason::SENT);
        assert_eq!(card_reason(input(&mut card, &healthy())), Some(Reason::SENT));
        let mut card = candidate('a');
        card.reason = Some(Reason::CONFLICT);
        assert_eq!(card_reason(input(&mut card, &healthy())), Some(Reason::CONFLICT));
        let mut card = candidate('a');
        card.reason = Some(Reason::CHANGED);
        assert_eq!(card_reason(input(&mut card, &healthy())), Some(Reason::CHANGED));
    }

    // --- projectedCard (main.cjs 276) -------------------------------------

    #[test]
    fn projection_is_null_or_exactly_the_four_safe_keys() {
        let st = healthy();
        let value = project_card(None, &st, false, false, false, true, true, NOW);
        assert!(value.is_null());
        let mut card = candidate('a');
        let value = project_card(Some(&mut card), &st, false, false, false, true, true, NOW);
        let object = value.as_object().expect("object card");
        let mut keys: Vec<&String> = object.keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            vec!["expires_at", "operation", "reason", "state"],
            "exactly the legacy key set"
        );
        assert_eq!(value["state"], "pending");
        assert!(value["reason"].is_null());
        assert_eq!(value["operation"], "Review document");
        assert_eq!(value["expires_at"], "2030-01-01T00:10:00+00:00");
        // inert projection carries the reason, never the private identity
        let mut card = candidate('a');
        card.expires = NOW - 1;
        let value = project_card(Some(&mut card), &st, false, false, false, true, true, NOW);
        assert_eq!(value["state"], "inert");
        assert_eq!(value["reason"], Reason::EXPIRED);
        let text = value.to_string();
        for secret in ["proposal_", "\"c\".repeat", "payload"] {
            if secret == "payload" {
                continue; // the word may appear in no field at all; id/hash never do
            }
            assert!(!text.contains(secret), "projection leaks {secret}: {text}");
        }
        assert!(!text.contains(&proposal_id('a')[..]));
        assert!(!text.contains(&"c".repeat(64)[..]));
    }

    #[test]
    fn compact_projection_reports_inert_compact_reason() {
        let st = healthy();
        let mut card = candidate('a');
        let value = project_card(Some(&mut card), &st, false, false, false, false, true, NOW);
        assert_eq!(value["state"], "inert");
        assert_eq!(value["reason"], Reason::COMPACT);
    }

    // --- chooseRequest (core.cjs 89) --------------------------------------

    #[test]
    fn choose_consumes_a_standing_request_by_index_only() {
        let request = StandingRequest {
            origin: "pi".into(),
            question: "Which one?".into(),
            options: vec![json!({"label": "One"}), json!({"label": "Two"}), json!({"label": "Three"})],
        };
        assert!(choose_request(Some(&request), 0).is_ok());
        assert!(choose_request(Some(&request), 2).is_ok());
        // no standing request, or a request without options: Denied
        assert!(choose_request(None, 0).is_err());
        let optionless = StandingRequest {
            origin: "pi".into(),
            question: "q".into(),
            options: Vec::new(),
        };
        assert!(choose_request(Some(&optionless), 0).is_err());
        // the index is the only authority the renderer has
        for bad in [-1, 3, 99] {
            assert!(choose_request(Some(&request), bad).is_err(), "index {bad}");
        }
    }
}

//! Approval lane — the Electron `main.cjs` bridge HTTP authority, ported to
//! Rust for unit M3 without shortcuts.
//!
//! Behaviour-equivalent port (line numbers = read-only legacy source
//! `worktrees/legacy-electron/apps/desktop/main.cjs`):
//! - `readBridgeLogin` (87) — credential file, descriptor-safe read of the
//!   SAME file legacy reads (`<stateRoot>/bridge.json`, dev state root =
//!   the crate-side `.runtime`, overridable by `ABITO_SOCKET_DIR` like every
//!   other state path in this port),
//! - `mode`/`status`/`stopAuth` (110/115/118) — auth mode diagnostics
//!   (mode name only, nothing else) and `bridgeStatus`,
//! - `sessionCookie` (125) — the session cookie lives ONLY in this process's
//!   memory (Chromium's partition jar is the legacy equivalent; it was never
//!   in localStorage and never reached the WebView),
//! - `request` (138) — 5 s absolute deadline, manual redirects, body
//!   discard, 1 MiB JSON cap, abort-on-quit, `bridgeAllows` route gate
//!   (see [`requests`]/[`http`]),
//! - `mint` (194) / `authenticated` (204) — at most two mints, the 403
//!   ladder (see [`retry`]), "only known rejected requests may be retried,
//!   never a network failure",
//! - `poll` (282) / `startBridge` (297) — health then proposals, 10 s
//!   cadence, single in-flight poll,
//! - `decide` (305) — allow/deny: synchronous lock FIRST, gate re-validated
//!   before every send, `/execute` bound to the card's `payload_hash`,
//!   `/reject` bodyless; a notice or a stale renderer can never decide.
//!
//! Configuration follows legacy: base origin `http://127.0.0.1:11003`
//! (`security.cjs BRIDGE_ORIGIN`) with a test/probe-only env override
//! `ABITO_BRIDGE_BASE`, credential only from `bridge.json`. Nothing here
//! writes credentials, and nothing logs values — only the auth mode name.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::card::{self, Candidate, Reason, StandingRequest};
use crate::desktop::BridgeStatus;
use crate::http::{self, ActiveRequests, REQUEST_DEADLINE_MS};
use crate::requests::{self, bridge_allows, parse_origin, Origin};
#[cfg(unix)]
use crate::requests::validate_login_bytes;
use crate::retry::{AuthLadder, AuthMode, Recovery};

/// `main.cjs setInterval(() => void poll(), 10000)` (303): the poll cadence
/// in milliseconds. Pinned by a unit test so it cannot drift silently.
pub const POLL_MS: u64 = 10_000;

/// Test/probe-only override of the bridge origin (`security.cjs
/// BRIDGE_ORIGIN` has no env knob in legacy; this one exists so tests and
/// the probe can point the lane at an in-process fake backend instead of the
/// real one — it is documented in the README).
pub const BASE_ENV: &str = "ABITO_BRIDGE_BASE";

/// The credential file name inside the state root (`main.cjs
/// `path.join(stateRoot, 'bridge.json')`, 93).
pub const LOGIN_FILE: &str = "bridge.json";

/// `main.cjs` cookie value charset (130): `^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$`
/// with the 4096-byte cap from the same check.
fn cookie_value_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && value.bytes().all(|byte| {
            byte == 0x21
                || (0x23..=0x2b).contains(&byte)
                || (0x2d..=0x3a).contains(&byte)
                || (0x3c..=0x5b).contains(&byte)
                || (0x5d..=0x7e).contains(&byte)
        })
}

/// The in-memory session cookie. `expires_at` mirrors the legacy
/// `expirationDate` check (absent = session cookie, always acceptable).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCookie {
    pub value: String,
    pub expires_at: Option<i64>, // epoch seconds
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// What a `Set-Cookie` header means for the in-memory jar. Chromium is the
/// legacy store: an invalid or foreign cookie is simply not stored, an
/// expired one is cleared.
enum CookieUpdate {
    Keep,
    Store(StoredCookie),
    Clear,
}

/// Parse `sb_session=…; Path=…; Domain=…; Expires=…` under the legacy
/// `sessionCookie` constraints (value charset, `Path=/`, domain
/// `127.0.0.1`, expiry in the future).
fn parse_set_cookie(header: &str, now: i64) -> CookieUpdate {
    let mut parts = header.split(';');
    let Some(first) = parts.next() else {
        return CookieUpdate::Keep;
    };
    let Some((name, value)) = first.trim().split_once('=') else {
        return CookieUpdate::Keep;
    };
    if name.trim() != "sb_session" {
        return CookieUpdate::Keep;
    }
    let value = value.trim();
    let mut path_ok = true;
    let mut domain_ok = true; // host-only (no Domain) is the request host
    let mut expires: Option<i64> = None;
    let mut max_age: Option<i64> = None;
    for attribute in parts {
        let attribute = attribute.trim();
        let Some((key, raw)) = attribute.split_once('=') else {
            continue; // flags: HttpOnly, Secure
        };
        match key.trim().to_ascii_lowercase().as_str() {
            "path" => path_ok = raw.trim() == "/",
            "domain" => {
                domain_ok = raw
                    .trim()
                    .trim_start_matches('.')
                    .eq_ignore_ascii_case("127.0.0.1")
            }
            "expires" => expires = parse_cookie_date(raw.trim()),
            "max-age" => max_age = raw.trim().parse::<i64>().ok(),
            _ => {}
        }
    }
    if !path_ok || !domain_ok || !cookie_value_valid(value) {
        return CookieUpdate::Keep; // legacy: sessionCookie would not match it
    }
    // RFC 6265: Max-Age wins over Expires (Chromium follows the same order).
    let effective = match max_age {
        Some(seconds) => Some(now + seconds),
        None => expires,
    };
    match effective {
        Some(at) if at <= now => CookieUpdate::Clear,
        Some(at) => CookieUpdate::Store(StoredCookie {
            value: value.to_string(),
            expires_at: Some(at),
        }),
        None => CookieUpdate::Store(StoredCookie {
            value: value.to_string(),
            expires_at: None,
        }),
    }
}

/// Legacy cookie-date parsing is JS `Date.parse` of the RFC form; the fake
/// and the real backend only ever send `Max-Age` or `Expires` in the
/// standard `Wdy, DD Mon YYYY HH:MM: SS GMT` shape, which this accepts in
/// its two common spellings.
fn parse_cookie_date(text: &str) -> Option<i64> {
    // `Thu, 01 Jan 2030 00:00:00 GMT` (and the no-weekday variant).
    let text = text.split(',').next_back()?.trim();
    let mut fields = text.split_whitespace();
    let day: i64 = fields.next()?.parse().ok()?;
    let month = fields.next()?;
    let year: i64 = fields.next()?.parse().ok()?;
    let time = fields.next()?;
    let mut clock = time.split(':');
    let hour: i64 = clock.next()?.parse().ok()?;
    let minute: i64 = clock.next()?.parse().ok()?;
    let second: i64 = clock.next()?.parse().ok()?;
    let month_index = match month {
        "Jan" => 1, "Feb" => 2, "Mar" => 3, "Apr" => 4, "May" => 5, "Jun" => 6,
        "Jul" => 7, "Aug" => 8, "Sep" => 9, "Oct" => 10, "Nov" => 11, "Dec" => 12,
        _ => return None,
    };
    // days since epoch (civil), same algorithm as `card::parse_expiry_ms`
    let shifted = if month_index <= 2 { year - 1 } else { year };
    let era = if shifted >= 0 { shifted } else { shifted - 399 } / 400;
    let year_of_era = shifted - era * 400;
    let day_of_year =
        (153 * (if month_index > 2 { month_index - 3 } else { month_index + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// `main.cjs sessionCookie` (125) read half: the stored value must still be
/// a legal cookie token and (when it has one) not expired.
fn cookie_is_valid(cookie: &Option<StoredCookie>, now: i64) -> bool {
    match cookie {
        None => false,
        Some(stored) => {
            cookie_value_valid(&stored.value)
                && stored.expires_at.is_none_or(|at| at > now)
        }
    }
}

/// One request outcome as `main.cjs request()` returns it: the status, plus
/// the parsed JSON when the caller asked for it and the status was 2xx.
struct ResponseData {
    status: u16,
    data: Option<Value>,
}

/// The single failure class — legacy collapses everything into
/// `throw new Error('Unavailable')`.
#[derive(Debug)]
struct Transport;

/// What decision the human clicked. The WebView sends ONLY this enum's
/// identity (via the `allow`/`deny` verbs); every id, expiry and
/// `payload_hash` is re-validated host-side before any `/execute`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny,
}

/// Snapshot-relevant facts the host already knows; `ctx` closures MUST NOT
/// lock the approval mutex (they are called while it is held).
pub struct HostCtx {
    pub now_ms: i64,
    pub expanded: bool,
    pub visible: bool,
    pub quitting: bool,
}

/// Callbacks into the host: publish-on-change, auth mode diagnostics, and
/// the context snapshot.
pub struct Hooks {
    pub ctx: Box<dyn Fn() -> HostCtx + Send + Sync>,
    pub changed: Box<dyn Fn() + Send + Sync>,
    /// Legacy `mode()` prints the mode name and nothing else.
    pub log: Box<dyn Fn(&str) + Send + Sync>,
}

pub type Shared = Arc<Mutex<Approval>>;
pub type SharedHooks = Arc<Hooks>;

/// The approval lane state (`main.cjs` globals, lines 56-84).
pub struct Approval {
    pub origin: Origin,
    pub base: String,
    pub login: Option<String>,
    pub status: BridgeStatus,
    pub ladder: AuthLadder,
    pub cookie: Option<StoredCookie>,
    pub selected: Option<Candidate>,
    pub queued: Option<Candidate>,
    pub poll_busy: bool,
    pub mutation_busy: bool,
    pub request: Option<StandingRequest>,
    pub epoch: u64,
    pub active: Arc<ActiveRequests>,
    /// Per-request deadline (legacy 5000 ms; a test seam for timeout tests).
    pub deadline_ms: u64,
}

impl Approval {
    /// Build a lane for one origin. An unparsable origin is refused: the
    /// lane fails closed rather than sending anywhere else.
    pub fn new(base: &str, login: Option<String>) -> Result<Self, ()> {
        let origin = parse_origin(base)?;
        Ok(Approval {
            origin,
            base: base.to_string(),
            status: if login.is_some() {
                BridgeStatus {
                    state: "starting",
                    reason: Reason::STARTING,
                }
            } else {
                BridgeStatus {
                    state: "disabled",
                    reason: Reason::DISABLED,
                }
            },
            login,
            ladder: AuthLadder::new(),
            cookie: None,
            selected: None,
            queued: None,
            poll_busy: false,
            mutation_busy: false,
            request: None,
            epoch: 0,
            active: ActiveRequests::new(),
            deadline_ms: REQUEST_DEADLINE_MS,
        })
    }

    /// The honest projection with no usable configuration: disabled, and no
    /// request will ever be made.
    pub fn disabled() -> Self {
        let fallback = requests::BRIDGE_ORIGIN;
        Approval::new(fallback, None).expect("the legacy origin always parses")
    }

    /// Production configuration: `ABITO_BRIDGE_BASE` (tests/probe) or the
    /// legacy origin, plus the `bridge.json` login read once at startup
    /// (`main.cjs readBridgeLogin`, called exactly once per process).
    pub fn from_environment(login: Option<String>) -> Self {
        let text = std::env::var(BASE_ENV).unwrap_or_else(|_| requests::BRIDGE_ORIGIN.to_string());
        match Approval::new(&text, login) {
            Ok(approval) => approval,
            Err(()) => {
                // No secret in the message: only the knob's name.
                eprintln!("approval lane disabled: invalid {BASE_ENV} origin");
                Approval::disabled()
            }
        }
    }

    /// `main.cjs overlayEpoch++` (375/467): any phase transition widens the
    /// decision gate — a decision in flight may no longer retry.
    pub fn bump_epoch(&mut self) {
        self.epoch += 1;
    }

    pub fn quitting(&self) -> bool {
        self.active.is_quit()
    }
}

/// `overlayEpoch++` through the shared lane (called by the window host on
/// every phase transition).
pub fn bump_epoch(appr: &Shared) {
    appr.lock().expect("approval lock").bump_epoch();
}

/// `main.cjs quit()` half for the lane: fail every in-flight request and
/// make every later one refuse immediately.
pub fn abort_lane(appr: &Shared) {
    appr.lock().expect("approval lock").active.abort_all();
}

/// `main.cjs readBridgeLogin` (87), descriptor-safe port: open with
/// `O_NOFOLLOW`, judge BEFORE (regular file, our uid, not group/world
/// writable, 1..=2048 bytes), read at most size+1 bytes, judge AFTER (same
/// dev/ino/uid/size/mode/mtime/ctime, nothing grew), then the pure schema
/// in `requests::validate_login_bytes`. Any anomaly at all → `None` → the
/// lane stays disabled and NO fetch happens.
pub fn read_bridge_login(state_root: &Path) -> Option<String> {
    #[cfg(not(unix))]
    {
        let _ = state_root;
        None
    }
    #[cfg(unix)]
    {
        use std::io::Read;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

        let path = state_root.join(LOGIN_FILE);
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .ok()?; // missing, symlink (ELOOP), unreadable → None
        let before = file.metadata().ok()?;
        let uid = unsafe { libc::getuid() };
        if !before.is_file()
            || before.uid() != uid
            || before.mode() & 0o022 != 0
            || before.size() < 1
            || before.size() > 2048
        {
            return None;
        }
        // Read at most size+1: growth shows up as a count mismatch below.
        let mut bytes = vec![0u8; before.size() as usize + 1];
        let mut count = 0usize;
        while count < bytes.len() {
            match file.read(&mut bytes[count..]) {
                Ok(0) => break,
                Ok(read) => count += read,
                Err(_) => return None,
            }
        }
        let after = file.metadata().ok()?;
        if !after.is_file()
            || after.dev() != before.dev()
            || after.ino() != before.ino()
            || after.uid() != before.uid()
            || after.size() != before.size()
            || after.mode() != before.mode()
            || after.mtime() != before.mtime()
            || after.ctime() != before.ctime()
            || count != before.size() as usize
        {
            return None; // the file changed under us (legacy `after` checks)
        }
        validate_login_bytes(&bytes[..count])
    }
}

/// The gate `main.cjs` builds as its `mayRetry` closure (315): the decision
/// may be re-sent ONLY while the same card stands in the same overlay epoch
/// and still has no reason — re-checking expiry, health, visibility and the
/// busy gates with `ownMutation: true` before every send.
struct DecisionGate {
    epoch: u64,
    captured: Candidate,
}

impl DecisionGate {
    fn may_send(&mut self, appr: &mut Approval, ctx: &HostCtx) -> bool {
        if appr.active.is_quit() || ctx.quitting {
            return false;
        }
        appr.epoch == self.epoch
            && appr
                .selected
                .as_ref()
                .is_some_and(|selected| selected.id == self.captured.id
                    && selected.hash == self.captured.hash)
            && card::card_reason(card::ReasonInput {
                card: &mut self.captured,
                status: &appr.status,
                quitting: ctx.quitting,
                poll_busy: appr.poll_busy,
                mutation_busy: appr.mutation_busy,
                own_mutation: true,
                expanded: ctx.expanded,
                visible: ctx.visible,
                now_ms: ctx.now_ms,
            })
            .is_none()
    }
}

/// `main.cjs stopAuth` (118): latch stopped, mode → `none` (logged only on
/// change), status → `stopped`. Publishing is the caller's job — legacy
/// `stopAuth` does not publish either.
fn stop_auth(appr: &Shared, hooks: &SharedHooks) {
    let logged = {
        let mut a = appr.lock().expect("approval lock");
        if a.active.is_quit() {
            return; // `if (quitting) return`
        }
        a.status = BridgeStatus {
            state: "stopped",
            reason: Reason::STOPPED,
        };
        a.ladder.stop()
    };
    if let Some(name) = logged {
        (hooks.log)(name);
    }
}

/// `main.cjs status(value)` (115).
fn set_status(appr: &Shared, state: &'static str) {
    let mut a = appr.lock().expect("approval lock");
    if a.active.is_quit() {
        return; // `if (!quitting)`
    }
    a.status = BridgeStatus {
        state,
        reason: Reason::for_state(state),
    };
}

/// The legacy `catch { if (!quitting && !authStopped) status('unhealthy') }`.
fn mark_unhealthy(appr: &Shared) {
    let mut a = appr.lock().expect("approval lock");
    if a.active.is_quit() || a.ladder.stopped {
        return;
    }
    a.status = BridgeStatus {
        state: "unhealthy",
        reason: Reason::UNHEALTHY,
    };
}

/// Chromium's jar equivalent: any response may carry a fresh `sb_session`
/// and it is validated and stored exactly like the cookie store would.
fn store_cookie(approval: &mut Approval, header: Option<String>) {
    let Some(header) = header else {
        return;
    };
    match parse_set_cookie(&header, now_secs()) {
        CookieUpdate::Keep => {}
        CookieUpdate::Clear => approval.cookie = None,
        CookieUpdate::Store(stored) => approval.cookie = Some(stored),
    }
}

/// `main.cjs request` (138): the route gate, header assembly (including the
/// explicit-cookie recovery), the `maySend` gate before EVERY send, the
/// 5 s deadline through [`http::send`], and the status classification
/// (401/3xx stop auth, non-2xx delivers the status, JSON bodies parse strict).
fn request(
    appr: &Shared,
    hooks: &SharedHooks,
    method: &'static str,
    route: &str,
    body: Option<&str>,
    json: bool,
    gate: Option<&mut DecisionGate>,
) -> Result<ResponseData, Transport> {
    // legacy 141: `if (quitting || authStopped || !bridgeLogin ||
    // !bridgeAllows(...)) throw`
    let mut explicit_cookie_missing = false;
    let (origin, headers, active, deadline_ms) = {
        let a = appr.lock().expect("approval lock");
        if a.active.is_quit() || a.ladder.stopped {
            return Err(Transport);
        }
        let login = a.login.clone().ok_or(Transport)?;
        let url = format!("{}{}", a.base, route);
        if !bridge_allows(&a.base, method, &url) {
            return Err(Transport);
        }
        let mut headers: Vec<(String, String)> =
            vec![("tailscale-user-login".to_string(), login)];
        if method == "POST" {
            headers.push(("X-SB-Request".to_string(), "1".to_string()));
        }
        if body.is_some() {
            headers.push((
                "Content-Type".to_string(),
                "application/json".to_string(),
            ));
        }
        if a.ladder.mode == AuthMode::Explicit {
            // legacy `await sessionCookie()` inside the explicit branch
            if cookie_is_valid(&a.cookie, now_secs()) {
                let value = a
                    .cookie
                    .as_ref()
                    .map(|cookie| cookie.value.clone())
                    .unwrap_or_default();
                headers.push(("Cookie".to_string(), format!("sb_session={value}")));
            } else {
                explicit_cookie_missing = true;
            }
        } else if let Some(cookie) = &a.cookie {
            // jar mode: whatever the jar holds goes on the wire (Chromium
            // `credentials: 'include'` did the same, without validating)
            headers.push(("Cookie".to_string(), format!("sb_session={}", cookie.value)));
        }
        (
            a.origin.clone(),
            headers,
            Arc::clone(&a.active),
            a.deadline_ms,
        )
    };
    if explicit_cookie_missing {
        stop_auth(appr, hooks); // legacy catch → stopAuth + throw
        return Err(Transport);
    }
    // legacy 157: `if (quitting || aborted || !maySend()) throw`
    let ctx = (hooks.ctx)();
    if ctx.quitting || active.is_quit() {
        return Err(Transport);
    }
    if let Some(gate) = gate {
        let mut a = appr.lock().expect("approval lock");
        if !gate.may_send(&mut a, &ctx) {
            return Err(Transport);
        }
    }
    let outcome = http::send(&origin, method, route, &headers, body, json, deadline_ms, &active);
    let response = outcome.map_err(|()| Transport)?;
    // legacy 164: `if (quitting || aborted) { discard; throw }`
    let ctx = (hooks.ctx)();
    if ctx.quitting || active.is_quit() {
        return Err(Transport);
    }
    {
        let mut a = appr.lock().expect("approval lock");
        // Chromium stores the response cookie BEFORE the status is judged
        store_cookie(&mut a, response.set_cookie);
    }
    // legacy 171: 401 or 3xx → stopAuth + throw (body already discarded)
    if response.status == 401 || (300..400).contains(&response.status) {
        stop_auth(appr, hooks);
        return Err(Transport);
    }
    // legacy 174: `!json || !2xx` → status only, body discarded
    if !json || !(200..300).contains(&response.status) {
        return Ok(ResponseData {
            status: response.status,
            data: None,
        });
    }
    // legacy 177-190: strict UTF-8, strict JSON, fail closed
    let bytes = response.body.ok_or(Transport)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| Transport)?;
    let data: Value = serde_json::from_str(text).map_err(|_| Transport)?;
    Ok(ResponseData {
        status: response.status,
        data: Some(data),
    })
}

/// `main.cjs authenticated` (204): the bounded 403 ladder around one
/// request. A transport failure (`Err`) propagates at once — ONLY known
/// rejected responses may be retried.
fn authenticated(
    appr: &Shared,
    hooks: &SharedHooks,
    method: &'static str,
    route: &str,
    body: Option<&str>,
    json: bool,
    mut gate: Option<&mut DecisionGate>,
) -> Result<ResponseData, Transport> {
    loop {
        {
            let a = appr.lock().expect("approval lock");
            if a.active.is_quit() || a.ladder.stopped {
                return Err(Transport);
            }
        }
        let response = request(appr, hooks, method, route, body, json, gate.as_deref_mut())?;
        if response.status != 403 {
            return Ok(response);
        }
        // legacy 208-216: one rung per KNOWN rejection
        let (rung, changed) = {
            let mut a = appr.lock().expect("approval lock");
            let before = a.ladder.mode;
            let rung = a.ladder.recovery_after_403();
            (rung, (a.ladder.mode != before).then(|| a.ladder.mode.as_str()))
        };
        if let Some(name) = changed {
            (hooks.log)(name); // legacy mode('explicit') / mode('none')
        }
        match rung {
            Recovery::Explicit => {
                // legacy `await sessionCookie()` — re-validate the stored jar
                let valid = {
                    let a = appr.lock().expect("approval lock");
                    cookie_is_valid(&a.cookie, now_secs())
                };
                if !valid {
                    stop_auth(appr, hooks);
                    return Err(Transport);
                }
            }
            Recovery::Remint => {
                mint(appr, hooks)?; // a failed mint stops auth itself
            }
            Recovery::Stop => {
                stop_auth(appr, hooks);
                return Err(Transport);
            }
        }
        // legacy 217: `if (quitting || !mayRetry()) throw`
        let ctx = (hooks.ctx)();
        if ctx.quitting {
            return Err(Transport);
        }
        {
            let mut a = appr.lock().expect("approval lock");
            if a.active.is_quit() {
                return Err(Transport);
            }
            if let Some(gate) = gate.as_deref_mut() {
                if !gate.may_send(&mut a, &ctx) {
                    return Err(Transport);
                }
            }
        }
    }
}

/// `main.cjs mint` (194): `GET /` mints the session cookie; the jar must
/// hold a valid one afterwards ("No alternate storage"), and every failure
/// stops authentication — but a mint refused by the cap is only a refusal.
fn mint(appr: &Shared, hooks: &SharedHooks) -> Result<(), Transport> {
    {
        let mut a = appr.lock().expect("approval lock");
        if a.active.is_quit() || a.ladder.stopped {
            return Err(Transport);
        }
        if !a.ladder.try_mint() {
            return Err(Transport); // legacy: throw BEFORE the try, no stop
        }
    }
    match request(appr, hooks, "GET", "/", None, false, None) {
        Err(_) => {
            stop_auth(appr, hooks); // legacy catch → stopAuth + throw
            Err(Transport)
        }
        Ok(response) if !(200..300).contains(&response.status) => {
            stop_auth(appr, hooks);
            Err(Transport)
        }
        Ok(_) => {
            let valid = {
                let a = appr.lock().expect("approval lock");
                cookie_is_valid(&a.cookie, now_secs())
            };
            if !valid {
                stop_auth(appr, hooks);
                return Err(Transport);
            }
            let quit = appr.lock().expect("approval lock").active.is_quit();
            if quit {
                return Err(Transport); // legacy `if (quitting) throw`
            }
            Ok(())
        }
    }
}

/// Legacy `startBridge` (297), synchronous half: mode('jar'), mint, first
/// poll. Called on the bridge thread (or directly by tests).
pub fn bridge_startup(appr: &Shared, hooks: &SharedHooks) {
    {
        let a = appr.lock().expect("approval lock");
        if a.login.is_none() || a.active.is_quit() {
            return; // `if (!bridgeLogin || quitting) return`
        }
    }
    let jar = {
        let mut a = appr.lock().expect("approval lock");
        a.ladder.begin()
    };
    if let Some(name) = jar {
        (hooks.log)(name); // mode('jar') — the mode name and nothing else
    }
    if mint(appr, hooks).is_err() {
        (hooks.changed)(); // legacy `catch { publish(); return; }`
        return;
    }
    poll_once(appr, hooks);
}

/// Legacy `startBridge` + `setInterval(poll, 10000)`: the thread body.
pub fn run_bridge(appr: Shared, hooks: SharedHooks) {
    {
        let a = appr.lock().expect("approval lock");
        if a.login.is_none() {
            return; // no configuration → no interval either (legacy 297)
        }
    }
    bridge_startup(&appr, &hooks);
    loop {
        std::thread::sleep(Duration::from_millis(POLL_MS));
        {
            let a = appr.lock().expect("approval lock");
            if a.active.is_quit() || a.ladder.stopped {
                return; // clearInterval on quit / stopAuth
            }
        }
        poll_once(&appr, &hooks);
    }
}

/// Spawn the bridge thread.
pub fn spawn_bridge(appr: Shared, hooks: SharedHooks) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || run_bridge(appr, hooks))
}

/// Legacy `poll` (282): single in-flight, health → proposals → receive.
pub fn poll_once(appr: &Shared, hooks: &SharedHooks) {
    {
        let mut a = appr.lock().expect("approval lock");
        if a.active.is_quit()
            || a.ladder.stopped
            || a.poll_busy
            || a.mutation_busy
            || a.login.is_none()
        {
            return; // `if (quitting || authStopped || pollBusy || mutationBusy) return`
        }
        a.poll_busy = true;
    }
    (hooks.changed)(); // publish with pollBusy (the card reports `busy`)
    poll_inner(appr, hooks);
    {
        let mut a = appr.lock().expect("approval lock");
        a.poll_busy = false; // `finally`
    }
    (hooks.changed)(); // `finally publish()`
}

fn poll_inner(appr: &Shared, hooks: &SharedHooks) {
    // health (legacy 285-288)
    let health = authenticated(appr, hooks, "GET", "/api/health", None, true, None);
    if (hooks.ctx)().quitting {
        return; // `if (quitting) return` — no catch-status, publish guards too
    }
    match health {
        Ok(response) => {
            let healthy = (200..300).contains(&response.status)
                && response
                    .data
                    .as_ref()
                    .and_then(|data| data.get("ok"))
                    .and_then(Value::as_bool)
                    == Some(true);
            set_status(appr, if healthy { "healthy" } else { "unhealthy" });
        }
        Err(_) => {
            mark_unhealthy(appr);
            return; // proposals are NOT fetched after a failed health call
        }
    }
    // proposals (legacy 290-293)
    let proposals = authenticated(
        appr,
        hooks,
        "GET",
        "/api/proposals?status=pending",
        None,
        true,
        None,
    );
    if (hooks.ctx)().quitting {
        return;
    }
    let response = match proposals {
        Ok(response) if (200..300).contains(&response.status) => response,
        _ => {
            mark_unhealthy(appr);
            return;
        }
    };
    match card::parse_proposals(&response.data.unwrap_or(Value::Null)) {
        Ok(candidate) => {
            let mut guard = appr.lock().expect("approval lock");
            if guard.active.is_quit() {
                return;
            }
            let ctx = (hooks.ctx)(); // (ctx closures never take the approval lock)
            let mutation_busy = guard.mutation_busy;
            // F013 / R1 (#338): legacy calls `receiveCandidate(parseProposals(...))
            // ` ALWAYS, with `null` too (main.cjs:292). An empty pending list
            // therefore reaches the lane: it clears the card while compact and
            // marks the pin inert while expanded — never a stale card.
            {
                // one explicit deref so `queued` and `selected` are disjoint
                // field borrows of the guarded struct
                let approval = &mut *guard;
                card::receive_candidate(
                    &mut approval.queued,
                    &mut approval.selected,
                    candidate,
                    ctx.expanded,
                    mutation_busy,
                    ctx.now_ms,
                );
            }
        }
        Err(()) => mark_unhealthy(appr), // legacy `catch` → unhealthy
    }
}

/// Legacy `decide` (305): the human's explicit choice. Locks the lane
/// synchronously, re-validates the card before EVERY send (and before the
/// first one), posts `/execute` with the card's `payload_hash` or
/// `/reject` with no body, and never rejects to the caller — the outcome is
/// always the sticky card reason (`sent`/`conflict`) plus a fresh
/// projection.
pub fn decide(appr: &Shared, decision: Decision, hooks: &SharedHooks) {
    let mut gate = {
        let mut a = appr.lock().expect("approval lock");
        let ctx = (hooks.ctx)();
        if ctx.quitting || a.active.is_quit() {
            return;
        }
        // `const captured = selected`; with no card `cardReason(null)` is
        // truthy and legacy returns the snapshot without any HTTP.
        let Some(captured) = a.selected.clone() else {
            return;
        };
        {
            let mut probe = captured.clone();
            let reason = card::card_reason(card::ReasonInput {
                card: &mut probe,
                status: &a.status,
                quitting: ctx.quitting,
                poll_busy: a.poll_busy,
                mutation_busy: a.mutation_busy,
                own_mutation: false,
                expanded: ctx.expanded,
                visible: ctx.visible,
                now_ms: ctx.now_ms,
            });
            if reason.is_some() {
                return; // `if (quitting || cardReason(captured)) return snapshot()`
            }
        }
        // Lock SYNCHRONOUSLY, before any await or cookie recovery (legacy
        // comment at 312): every concurrent click now sees `busy`.
        a.mutation_busy = true;
        DecisionGate {
            epoch: a.epoch,
            captured,
        }
    };
    (hooks.changed)(); // publish the busy card

    // Task-mandated host re-validation before `/execute`: id and binding
    // hash formats are re-checked here (parse guaranteed them at ingest;
    // decide never trusts that alone), and the expiry/health/visibility
    // gates run again inside the gate before EVERY send.
    let route = format!(
        "/api/proposals/{}{}",
        gate.captured.id,
        if decision == Decision::Allow {
            "/execute"
        } else {
            "/reject"
        }
    );
    let body = (decision == Decision::Allow)
        .then(|| format!("{{\"payload_hash\":\"{}\"}}", gate.captured.hash));
    let revalidated = card::valid_proposal_id(&gate.captured.id)
        && (decision != Decision::Allow || card::valid_payload_hash(&gate.captured.hash));
    let outcome = if revalidated {
        authenticated(
            appr,
            hooks,
            "POST",
            &route,
            body.as_deref(),
            false,
            Some(&mut gate),
        )
    } else {
        Err(Transport)
    };
    // legacy 322-327: 2xx → `sent`, anything else → `conflict`, and NEVER
    // after quit (the card stays inert by the quitting rule instead).
    let sent = matches!(&outcome, Ok(response) if (200..300).contains(&response.status));
    {
        let mut a = appr.lock().expect("approval lock");
        if !a.active.is_quit() {
            let reason = if sent { Reason::SENT } else { Reason::CONFLICT };
            gate.captured.reason = Some(reason);
            let same = |card: &Candidate| {
                card.id == gate.captured.id && card.hash == gate.captured.hash
            };
            if a.selected.as_ref().is_some_and(same) {
                if let Some(selected) = a.selected.as_mut() {
                    selected.reason = Some(reason);
                }
            }
            if a.queued.as_ref().is_some_and(same) {
                if let Some(queued) = a.queued.as_mut() {
                    queued.reason = Some(reason);
                }
            }
        }
        a.mutation_busy = false; // `finally` — unconditional
    }
    (hooks.changed)(); // `finally publish()`
}

/// Legacy `choose` (444 + `core.cjs chooseRequest`): read-and-consume the
/// standing request under ONE lock (the atomicity guarantee). With no
/// producer of requests, every choice answers `Err` — `Denied`.
pub fn choose(appr: &Shared, index: i32) -> Result<(), ()> {
    let mut a = appr.lock().expect("approval lock");
    // Read-and-consume in ONE synchronous step (the lock is the atomicity
    // the legacy comment demands: no await may sit between them).
    card::choose_request(a.request.as_ref(), index)?;
    a.request = None;
    Ok(())
}

/// Legacy expand promotion (467): `if (state === 'expanded' &&
/// !mutationBusy) selected = queued`.
pub fn promote_selection(appr: &Shared) {
    let mut a = appr.lock().expect("approval lock");
    if !a.mutation_busy {
        a.selected = a.queued.clone();
    }
}

/// Snapshot inputs: `(bridgeStatus, card, request)` in the exact legacy
/// shapes (`main.cjs snapshot`, 330). Expiry is re-checked on every call.
pub fn snapshot_fields(appr: &Shared, ctx: &HostCtx) -> (BridgeStatus, Value, Value) {
    let mut guard = appr.lock().expect("approval lock");
    // one explicit deref: `selected` (mut) and `status`/flags (reads) are
    // disjoint fields of the guarded struct
    let approval = &mut *guard;
    let quitting = ctx.quitting || approval.active.is_quit();
    let card = card::project_card(
        approval.selected.as_mut(),
        &approval.status,
        quitting,
        approval.poll_busy,
        approval.mutation_busy,
        ctx.expanded,
        ctx.visible,
        ctx.now_ms,
    );
    let request = match &approval.request {
        None => Value::Null, // no producer of requests exists in M3
        Some(standing) => serde_json::to_value(standing).unwrap_or(Value::Null),
    };
    (approval.status, card, request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn state_root(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "abito-m3-login-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("temp state root");
        root
    }

    #[test]
    fn poll_cadence_and_deadline_are_the_legacy_constants() {
        // main.cjs:303 setInterval(poll, 10000) and :150 setTimeout(5000)
        assert_eq!(POLL_MS, 10_000);
        assert_eq!(REQUEST_DEADLINE_MS, 5_000);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn valid_bridge_json_is_read_once_and_validated() {
        use std::os::unix::fs::PermissionsExt;
        let root = state_root("valid");
        fs::write(
            root.join(LOGIN_FILE),
            r#"{"v":1,"login":"tester@example.test"}"#,
        )
        .expect("write bridge.json");
        // the descriptor gate refuses group/world-writable configs (legacy
        // `before.mode & 0o022`), so the fixture is written like the legacy
        // writer does: 0600
        fs::set_permissions(root.join(LOGIN_FILE), fs::Permissions::from_mode(0o600))
            .expect("chmod 0600");
        assert_eq!(
            read_bridge_login(&root).as_deref(),
            Some("tester@example.test")
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn missing_symlink_and_bad_files_all_disable_the_lane() {
        let root = state_root("invalid");
        // missing
        assert_eq!(read_bridge_login(&root), None);
        // symlink (O_NOFOLLOW refuses it)
        let target = root.join("target");
        fs::write(&target, r#"{"v":1,"login":"tester@example.test"}"#).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, root.join(LOGIN_FILE)).expect("symlink");
        assert_eq!(read_bridge_login(&root), None);
        // malformed schema content
        fs::write(root.join(LOGIN_FILE), b"{").unwrap();
        assert_eq!(read_bridge_login(&root), None);
        // world-writable file (mode 0666)
        {
            use std::os::unix::fs::PermissionsExt;
            fs::write(root.join(LOGIN_FILE), r#"{"v":1,"login":"tester@example.test"}"#).unwrap();
            fs::set_permissions(root.join(LOGIN_FILE), fs::Permissions::from_mode(0o666)).unwrap();
            assert_eq!(read_bridge_login(&root), None);
        }
        // oversize file (> 2048 bytes)
        fs::write(root.join(LOGIN_FILE), format!(r#"{{"v":1,"login":"{}"}}"#, "a".repeat(3000)))
            .unwrap();
        assert_eq!(read_bridge_login(&root), None);
        let _ = fs::remove_dir_all(&root);
    }
}

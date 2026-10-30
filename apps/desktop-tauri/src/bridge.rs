//! Command-side port of the Electron IPC gate — unit M1b, pure module.
//!
//! Electron equivalents (read-only source, `worktrees/legacy-electron`):
//! - `core.cjs` `ipcPayloadValid` / `validateIPC` (lines 67-76): a closed set
//!   of actions, a closed payload shape (`choose` is the only verb carrying an
//!   argument and it is only ever an integer), and an exact sender check
//!   (event.sender === expected sender, main frame, exact page URL).
//! - `main.cjs` `ipcMain.handle('desktop:action', …)`: validate first, then a
//!   rate gate of 30 calls per fixed 1-second window (`Rate exceeded`).
//! - `security.cjs`: nothing outside the expected local origin may interact
//!   with the app.
//!
//! Tauri cannot compare `event.sender` objects, so the sender half is ported
//! as two exact string checks — the window label and the current page URL —
//! which the command reads from the live webview. Everything here is pure so
//! the checks are unit-testable without a webview.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The exact actions `preload.cjs` can ever name (ACTIONS in core.cjs), plus
/// the additive `autoClose` verb (#336).
/// `onState` is a facade-only subscription verb and never an IPC action.
pub const ACTIONS: [&str; 12] = [
    "snapshot",
    "expand",
    "close",
    "hide",
    "quit",
    "dismiss",
    "allow",
    "deny",
    "choose",
    "animateAnyway",
    "respectSystemMotion",
    "autoClose",
];

/// Hard cap for one action payload in bytes, mirroring core.cjs
/// `LIMITS.frameBytes` (512). The largest legitimate frame is
/// `{"action":"respectSystemMotion"}` (34 bytes); a stowaway key large enough
/// to matter is rejected before anything else looks at it.
pub const MAX_ACTION_BYTES: usize = 512;

/// Rate gate: 30 calls per fixed 1s window (main.cjs: `++calls > 30` throws).
pub const RATE_LIMIT_PER_WINDOW: u32 = 30;
pub const RATE_WINDOW_MS: u128 = 1_000;

/// One of the closed action set. `None` from [`Action::from_name`] is a
/// rejection: the renderer never gets to name an arbitrary verb.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Snapshot,
    Expand,
    Close,
    Hide,
    Quit,
    Dismiss,
    Allow,
    Deny,
    Choose,
    AnimateAnyway,
    RespectSystemMotion,
    /// #336 T1b: the island's inactivity close. Argument-free like `close`,
    /// but admitted by its own atomic protected-state check (never the legacy
    /// explicit-close denial path).
    AutoClose,
}

impl Action {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "snapshot" => Some(Action::Snapshot),
            "expand" => Some(Action::Expand),
            "close" => Some(Action::Close),
            "hide" => Some(Action::Hide),
            "quit" => Some(Action::Quit),
            "dismiss" => Some(Action::Dismiss),
            "allow" => Some(Action::Allow),
            "deny" => Some(Action::Deny),
            "choose" => Some(Action::Choose),
            "animateAnyway" => Some(Action::AnimateAnyway),
            "respectSystemMotion" => Some(Action::RespectSystemMotion),
            "autoClose" => Some(Action::AutoClose),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Action::Snapshot => "snapshot",
            Action::Expand => "expand",
            Action::Close => "close",
            Action::Hide => "hide",
            Action::Quit => "quit",
            Action::Dismiss => "dismiss",
            Action::Allow => "allow",
            Action::Deny => "deny",
            Action::Choose => "choose",
            Action::AnimateAnyway => "animateAnyway",
            Action::RespectSystemMotion => "respectSystemMotion",
            Action::AutoClose => "autoClose",
        }
    }
}

/// Typed rejection. The webview sees it as the JSON object `{ code, message }`
/// (the command's `Err` serializes straight into the rejected invoke promise),
/// so callers can branch on `code` instead of parsing prose.
///
/// Codes:
/// - `denied`        — Electron's `throw new Error('Denied')`, with the reason
///                     attached (unknown key/action, bad index, oversized
///                     payload, wrong window label, wrong origin).
/// - `rate-exceeded` — Electron's `throw new Error('Rate exceeded')`.
/// - `not-yet-wired` — verb whose backing system (M3 approval bridge; the
///                     M2 notice transport exists and `dismiss` is wired)
///                     does not exist yet; never faked as success.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
}

impl BridgeError {
    pub fn denied(reason: &str) -> Self {
        BridgeError {
            code: "denied".to_string(),
            message: format!("Denied: {reason}"),
        }
    }

    pub fn rate_exceeded() -> Self {
        BridgeError {
            code: "rate-exceeded".to_string(),
            message: "Rate exceeded".to_string(),
        }
    }

    pub fn not_yet_wired(verb: &str, unit: &str) -> Self {
        BridgeError {
            code: "not-yet-wired".to_string(),
            message: format!("Not yet wired: `{verb}` lands with {unit}"),
        }
    }
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for BridgeError {}

/// `core.cjs ipcPayloadValid`, ported:
/// 1. size gate first (new, task-mandated: oversized payloads are rejected
///    before any structural work),
/// 2. payload must be a JSON object (not null, not an array, not a scalar),
/// 3. `action` must be present and a member of the closed action set,
/// 4. `choose` carries exactly one key beside `action` — an integer `index`;
///    every other action carries no other key at all (a known action cannot
///    smuggle a payload).
///
/// Returns the action and, for `choose` only, its index.
pub fn validate_payload(payload: &Value) -> Result<(Action, Option<i32>), BridgeError> {
    // 1. size gate first: measured on the canonical JSON re-encoding of the
    //    payload the command received, so a stowaway key cannot buy parsing
    //    or dispatch work before being turned away.
    let encoded = serde_json::to_string(payload).unwrap_or_default();
    if encoded.len() > MAX_ACTION_BYTES {
        return Err(BridgeError::denied("payload too large"));
    }
    // 2. object shape
    let Value::Object(map) = payload else {
        return Err(BridgeError::denied("payload must be an object"));
    };
    // 3. closed action set
    let name = map
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::denied("missing string `action` key"))?;
    let action =
        Action::from_name(name).ok_or_else(|| BridgeError::denied("unknown action"))?;
    // 4. closed payload shape
    if action == Action::Choose {
        // exactly { action, index } with an integer index; anything else is a
        // malformed frame, not a choice (core.cjs ipcPayloadValid).
        if map.len() != 2 || !map.contains_key("index") {
            return Err(BridgeError::denied(
                "choose carries exactly one integer `index`",
            ));
        }
        let index = map
            .get("index")
            .and_then(Value::as_i64)
            .filter(|v| *v >= i64::from(i32::MIN) && *v <= i64::from(i32::MAX))
            .ok_or_else(|| BridgeError::denied("`index` must be an integer"))?;
        Ok((action, Some(index as i32)))
    } else {
        // argument-free verbs: no stowaway keys, a known action cannot smuggle
        // a payload (core.cjs: keys.length === 1).
        if map.len() != 1 {
            return Err(BridgeError::denied("unknown key"));
        }
        Ok((action, None))
    }
}

/// Display-only notice navigation. Deliberately separate from the legacy
/// argument-free action set: a fieldless click can never reach dispatch_verb.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClickKind { Question, Finished }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Click { pub id: String, pub kind: ClickKind }

/// #437: the `dismiss` verb, display-only like the click. Argument-free
/// (exactly {action}) it keeps the M2 behaviour: the FIRST notice goes. With
/// exactly one extra key — a string `id` validated against the NOTICE id
/// domain (protocol::token, the same rule the wire and NoticeStore::accept
/// enforce on settled event ids: [a-zA-Z0-9_-]{1,128}, #450) — EXACTLY that
/// notice is dismissed.
/// Anything else (a stowaway key, a non-string or malformed id, another
/// action, a non-object) is refused: the list view's × must never fall back
/// to the first notice (coordinator decision, T6.6 #437).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dismiss { pub id: Option<String> }

pub fn parse_dismiss(payload: &Value) -> Result<Dismiss, BridgeError> {
    if serde_json::to_vec(payload).unwrap_or_default().len() > MAX_ACTION_BYTES {
        return Err(BridgeError::denied("payload too large"));
    }
    let map = payload
        .as_object()
        .ok_or_else(|| BridgeError::denied("dismiss must be an object"))?;
    if map.get("action").and_then(Value::as_str) != Some("dismiss") {
        return Err(BridgeError::denied("dismiss requires the dismiss action"));
    }
    match map.len() {
        1 => Ok(Dismiss { id: None }),
        2 if map.contains_key("id") => {
            let id = map["id"]
                .as_str()
                .ok_or_else(|| BridgeError::denied("invalid notice id"))?;
            // #450: the notice store admits settled notices with ids like
            // `event-1`; the boundary must accept every id the store admits,
            // so validate against the NOTICE id domain (protocol::token),
            // not the question UUID validator.
            if !crate::protocol::token(id) {
                return Err(BridgeError::denied("invalid notice id"));
            }
            Ok(Dismiss { id: Some(id.into()) })
        }
        _ => Err(BridgeError::denied("dismiss carries at most one `id` key")),
    }
}

/// Exact new boundary. Legacy validate_payload is unchanged. Reuse the
/// canonical question ID validator without executing any question command.
pub fn parse_click(payload: &Value) -> Result<Click, BridgeError> {
    if serde_json::to_vec(payload).unwrap_or_default().len() > MAX_ACTION_BYTES {
        return Err(BridgeError::denied("payload too large"));
    }
    let map = payload.as_object().ok_or_else(|| BridgeError::denied("click must be an object"))?;
    if map.len() != 3 || map.get("action").and_then(Value::as_str) != Some("click")
        || !map.contains_key("id") || !map.contains_key("kind") {
        return Err(BridgeError::denied("click requires exactly action, id, kind"));
    }
    let kind = match map["kind"].as_str() {
        Some("question") => ClickKind::Question,
        Some("finished") => ClickKind::Finished,
        _ => return Err(BridgeError::denied("unknown notice kind")),
    };
    let id = map["id"].as_str().ok_or_else(|| BridgeError::denied("invalid notice id"))?;
    crate::questioncmd::parse_command(&serde_json::json!({"action":"decline","id":id}))
        .map_err(|_| BridgeError::denied("invalid notice id"))?;
    Ok(Click { id: id.into(), kind })
}

/// Resolve a fresh host projection only; never use renderer metadata as
/// authority. Finished is the store discriminator (not a wire kind). First-only
/// routing and ambiguous cross-session IDs fail closed. Does not mutate data.
/// The native question path instead holds the active-slot guard atomically.
pub fn route_click(click: &Click, question: &Value, notices: &Value, now: u64) -> Result<ClickKind, BridgeError> {
    let live = match click.kind {
        ClickKind::Question => question.get("pending").is_some_and(|p|
            p["id"].as_str() == Some(&click.id)
                && matches!(p["kind"].as_str(), Some("question" | "approval"))
                && p["expires_at"].as_u64().is_some_and(|expiry| expiry > now)),
        ClickKind::Finished => notices.as_array().is_some_and(|entries|
            entries.first().is_some_and(|n| n["id"].as_str() == Some(&click.id)
                && n["expiresAt"].as_u64().is_some_and(|expiry| expiry > now))
                && entries.iter().filter(|n| n["id"].as_str() == Some(&click.id)).count() == 1),
    };
    if live { Ok(click.kind) } else { Err(BridgeError::denied("notice is not current")) }
}

/// Sender half of `core.cjs validateIPC` + the origin rule of `security.cjs`:
/// only the main window, loaded on the exact local app page, may call the
/// host. The label and URL are read from the live webview by the command, so
/// a stray webview (or a webview that somehow navigated away) is rejected.
pub fn sender_ok(label: &str, url: &str) -> Result<(), BridgeError> {
    // #366 F093: the Rust-created settings window shares the SAME gate under
    // its own exact label; the URL allowlist below is untouched.
    if label != "main" && label != "settings" {
        return Err(BridgeError::denied("wrong window label"));
    }
    if !page_url_allowed(url) && !(label == "settings" && settings_page_url_allowed(url)) {
        return Err(BridgeError::denied("wrong origin"));
    }
    Ok(())
}

/// The settings window's own page (`settings.html`). Admitted ONLY together
/// with the exact `settings` label (see `sender_ok`): the main window never
/// accepts it. Exact string, no prefix, query, fragment or trailing character.
pub fn settings_page_url_allowed(url: &str) -> bool {
    url == "tauri://localhost/settings.html" || (cfg!(windows) && windows_settings_url(url))
}

/// #503 T1: WebView2 cannot host the `tauri://` scheme, so on Windows Tauri serves the same pages from
/// `http://tauri.localhost/` (`useHttpsScheme` is not set, so never https). Exact strings only, no prefix, query,
/// fragment, port or userinfo. These helpers are compiled everywhere so the tests run on any host, but they are
/// only consulted under `cfg!(windows)`: the Linux allowlist is untouched.
pub fn windows_page_url(url: &str) -> bool {
    matches!(url, "http://tauri.localhost/" | "http://tauri.localhost/index.html")
}

pub fn windows_settings_url(url: &str) -> bool {
    url == "http://tauri.localhost/settings.html"
}

/// Closed allowlist for the page URL the bridge accepts. Electron compared
/// one exact `file://…/index.html` string; Tauri's loader normalizes the app
/// URL differently depending on entry point, so the allowlist is the exact
/// set of those normalizations of the same single page — no prefix matching,
/// no query, no fragment (Electron rejected `index.html#extra` too).
pub fn page_url_allowed(url: &str) -> bool {
    // Exact closed set: `tauri://localhost` with no path, `/`, or
    // `/index.html` — the same one page, in the three normalizations the
    // Tauri/WebKitGTK loader reports (pinned by the probe's webview_url
    // evidence). No prefix matching: `…localhostx`, `#fragment`, `?query`,
    // other paths, other hosts and other schemes are all outside the set.
    matches!(
        url,
        "tauri://localhost" | "tauri://localhost/" | "tauri://localhost/index.html"
    ) || (cfg!(windows) && windows_page_url(url))
}

/// `main.cjs` rate gate, ported verbatim in behaviour: a fixed 1-second window
/// (not sliding); the window resets only when a call arrives at least 1000ms
/// after the window started; every attempt increments the counter, so a
/// rejected call still consumes budget.
#[derive(Debug)]
pub struct RateLimiter {
    calls: u32,
    window_started_ms: Option<u128>,
}

impl RateLimiter {
    pub const fn new() -> Self {
        RateLimiter {
            calls: 0,
            window_started_ms: None,
        }
    }

    pub fn check(&mut self, now_ms: u128) -> Result<(), BridgeError> {
        // Fixed 1s window, verbatim main.cjs ordering: reset when the current
        // window is at least RATE_WINDOW_MS old, then always increment, then
        // reject past the limit.
        match self.window_started_ms {
            Some(start) if now_ms.saturating_sub(start) < RATE_WINDOW_MS => {}
            _ => {
                self.calls = 0;
                self.window_started_ms = Some(now_ms);
            }
        }
        self.calls += 1;
        if self.calls > RATE_LIMIT_PER_WINDOW {
            Err(BridgeError::rate_exceeded())
        } else {
            Ok(())
        }
    }
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn action(name: &str) -> Value {
        json!({ "action": name })
    }

    fn deny_reason(payload: &Value) -> String {
        match validate_payload(payload) {
            Ok(v) => panic!("expected rejection, got {v:?}"),
            Err(e) => e.message,
        }
    }

    // --- payload shape (ported from test/core.test.cjs) -------------------

    #[test]
    fn accepts_the_closed_action_set() {
        for name in ACTIONS {
            // `choose` is the one verb that carries an argument
            let payload = if name == "choose" {
                json!({ "action": "choose", "index": 0 })
            } else {
                action(name)
            };
            let (got, index) =
                validate_payload(&payload).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(got.name(), name);
            assert_eq!(
                index,
                if name == "choose" { Some(0) } else { None },
                "{name} argument shape"
            );
        }
    }

    #[test]
    fn accepts_choose_with_exactly_one_integer() {
        let (got, index) = validate_payload(&json!({ "action": "choose", "index": 2 })).unwrap();
        assert_eq!(got, Action::Choose);
        assert_eq!(index, Some(2));
        // negative and zero are integers too; the standing-request check (M3)
        // decides validity later, exactly like core.chooseRequest.
        assert_eq!(
            validate_payload(&json!({ "action": "choose", "index": -1 })).unwrap().1,
            Some(-1)
        );
    }

    #[test]
    fn rejects_non_object_payloads() {
        for payload in [json!(null), json!([]), json!("quit"), json!(0), json!(true)] {
            let reason = deny_reason(&payload);
            assert!(reason.contains("object"), "got: {reason}");
        }
    }

    #[test]
    fn rejects_unknown_actions() {
        // {action:'approve'}, {action:'open',url}, {action:'move',dx,dy} from
        // the legacy matrix, plus a payload that tries to name a URL.
        for payload in [
            json!({ "action": "approve" }),
            json!({ "action": "open", "url": "https://x" }),
            json!({ "action": "move", "dx": 1, "dy": 2 }),
        ] {
            let reason = deny_reason(&payload);
            assert!(reason.contains("unknown action"), "got: {reason}");
        }
    }

    #[test]
    fn rejects_missing_action_key() {
        for payload in [json!({}), json!({ "index": 3 })] {
            let reason = deny_reason(&payload);
            assert!(reason.contains("action"), "got: {reason}");
        }
    }

    #[test]
    fn rejects_stowaway_keys_on_argument_free_actions() {
        // A known action cannot smuggle a payload: extra keys are denied even
        // when the action itself is valid.
        for payload in [
            json!({ "action": "hide", "extra": true }),
            json!({ "action": "expand", "index": 0 }),
            json!({ "action": "snapshot", "text": "open the door" }),
        ] {
            let reason = deny_reason(&payload);
            assert!(reason.contains("key"), "got: {reason}");
        }
    }

    #[test]
    fn rejects_malformed_choose_frames() {
        // choose is the only action with an argument, and it is only ever an
        // integer: missing, string, float or stowaway keys are malformed
        // frames, not choices.
        for payload in [
            json!({ "action": "choose" }),
            json!({ "action": "choose", "index": "1" }),
            json!({ "action": "choose", "index": 1.5 }),
            json!({ "action": "choose", "index": 1, "revision": 3 }),
            json!({ "action": "choose", "text": "open the door" }),
            json!({ "action": "choose", "index": null }),
        ] {
            let reason = deny_reason(&payload);
            assert!(
                reason.contains("index") || reason.contains("key"),
                "got: {reason}"
            );
        }
    }

    #[test]
    fn rejects_oversized_payloads_before_anything_else() {
        let pad = "a".repeat(MAX_ACTION_BYTES + 64);
        let reason = deny_reason(&json!({ "action": "snapshot", "pad": pad }));
        assert!(reason.contains("large"), "got: {reason}");
        // even an unknown action behind a huge frame reports the size first
        let reason = deny_reason(&json!({ "action": "approve", "pad": pad }));
        assert!(reason.contains("large"), "got: {reason}");
        // exactly at the cap is still structural validation
        assert!(validate_payload(&action("snapshot")).is_ok());
    }

    // --- #336 T1b-a: the additive autoClose verb ---------------------------

    /// #336 L15: `autoClose` joins the closed action set as an argument-free
    /// verb. Validation is identical to every other no-argument verb: a
    /// stowaway key is still a malformed frame. The atomic admission that
    /// decides it (protected state + core) lives in the command dispatch,
    /// not here.
    #[test]
    fn autoclose_is_an_argument_free_member_of_the_closed_action_set() {
        assert_eq!(ACTIONS.len(), 12);
        assert!(ACTIONS.contains(&"autoClose"));
        let (got, index) =
            validate_payload(&json!({ "action": "autoClose" })).expect("autoClose validates");
        assert_eq!(got.name(), "autoClose");
        assert_eq!(index, None, "autoClose never carries an argument");
        assert_eq!(Action::from_name("autoClose").map(|a| a.name()), Some("autoClose"));
        // no smuggled payload: {action:'autoClose', force:true} is a denial
        let reason = deny_reason(&json!({ "action": "autoClose", "force": true }));
        assert!(reason.contains("key"), "got: {reason}");
    }

    // --- sender / origin (ported from validateIPC + security.cjs) ---------

    /// #503 T1: the Windows origin (`http://tauri.localhost/`) is admitted by exact string only; every look-alike stays refused.
    #[test]
    fn windows_origin_is_exact_and_lookalikes_are_refused() {
        for url in ["http://tauri.localhost/", "http://tauri.localhost/index.html"] {
            assert!(windows_page_url(url), "{url}");
            assert!(!windows_settings_url(url), "{url}");
        }
        assert!(windows_settings_url("http://tauri.localhost/settings.html"));
        assert!(!windows_page_url("http://tauri.localhost/settings.html"));
        for url in [
            "https://tauri.localhost/", "http://tauri.localhost", "http://tauri.localhost.evil.com/", "http://tauri.localhost@evil.com/",
            "http://evil.com@tauri.localhost/", "http://tauri.localhost:8080/", "http://tauri.localhost:80/", "http://tauri.localhostx/",
            "http://tauri.localhost/other.html", "http://tauri.localhost/index.html?x=1", "http://tauri.localhost/index.html#x",
            "http://tauri.localhost//", "http://tauri.localhost/index.html/", "http://TAURI.localhost/", "http://user:pw@tauri.localhost/", "",
        ] {
            assert!(!windows_page_url(url) && !windows_settings_url(url), "{url} must be refused");
        }
    }

    /// The host cfg picks the allowlist: on non-Windows hosts the Windows origin is refused by the real gate, and the Linux set
    /// is exactly what it was; on Windows the same gate admits the Windows origin for main and settings.
    #[test]
    fn windows_origin_reaches_the_gate_only_on_windows() {
        let win = cfg!(windows);
        assert_eq!(sender_ok("main", "http://tauri.localhost/").is_ok(), win);
        assert_eq!(sender_ok("main", "http://tauri.localhost/index.html").is_ok(), win);
        assert_eq!(sender_ok("settings", "http://tauri.localhost/settings.html").is_ok(), win);
        assert!(sender_ok("main", "http://tauri.localhost/settings.html").is_err());
        assert!(sender_ok("main", "http://tauri.localhost.evil.com/").is_err());
        assert!(sender_ok("settings", "http://tauri.localhost@evil.com/settings.html").is_err());
        for url in ["tauri://localhost", "tauri://localhost/", "tauri://localhost/index.html"] {
            assert!(page_url_allowed(url), "{url}");
        }
        assert!(settings_page_url_allowed("tauri://localhost/settings.html"));
        assert!(!page_url_allowed("tauri://localhost/settings.html"));
    }

    #[test]
    fn sender_requires_the_main_window_on_the_exact_local_page() {
        for url in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html",
        ] {
            assert!(sender_ok("main", url).is_ok(), "{url}");
        }
    }

    /// #366 F093: the settings window (created by Rust only, same page) shares
    /// the SAME sender gate under its own exact label. Only the exact lowercase
    /// "settings" is admitted; look-alikes stay refused, and the URL allowlist
    /// is untouched (a foreign URL on the settings label is still an origin
    /// denial, with the same message as before).
    #[test]
    fn f093_the_settings_label_shares_the_same_gate_exact_only() {
        for url in ["tauri://localhost", "tauri://localhost/", "tauri://localhost/index.html"] {
            assert!(sender_ok("settings", url).is_ok(), "{url}");
        }
        // look-alikes and every other label stay refused
        for label in ["Settings", "SETTINGS", "settings2", "main2", "main ", " main", "", "settings-window"] {
            assert!(sender_ok(label, "tauri://localhost/index.html").is_err(), "{label:?} must be refused");
        }
        // the URL allowlist is untouched: a foreign URL on the settings label is an origin denial
        for url in ["https://evil.example/", "tauri://localhost/other.html", "", "tauri://localhost/index.html?x=1"] {
            let err = sender_ok("settings", url).expect_err(url);
            assert_eq!(err.code, "denied", "{url}");
            assert!(err.message.contains("origin"), "{url}: {err}");
        }
        // the original behaviour for "main" is byte-identical
        assert!(sender_ok("main", "tauri://localhost/index.html").is_ok());
        let err = sender_ok("main", "tauri://localhost/other.html").expect_err("main foreign url");
        assert_eq!(err.code, "denied");
    }

    /// The settings window's own page: admitted for the exact `settings` label
    /// only, as one exact string; `main` and every other label refuse it.
    #[test]
    fn settings_page_is_admitted_only_for_the_settings_label_exact() {
        assert!(sender_ok("settings", "tauri://localhost/settings.html").is_ok());
        // the island page keeps working for the settings label until the swap lands
        assert!(sender_ok("settings", "tauri://localhost/index.html").is_ok());
        // main never accepts the settings page
        let err = sender_ok("main", "tauri://localhost/settings.html").expect_err("main");
        assert_eq!(err.code, "denied");
        assert!(err.message.contains("origin"));
        // exact string only
        for url in [
            "tauri://localhost/settings.html?q=1",
            "tauri://localhost/settings.html#frag",
            "tauri://localhost/settings.html/",
            "tauri://localhost/settings.htmlx",
            "tauri://localhost/Settings.html",
            "tauri://localhost//settings.html",
            "https://evil.example/settings.html",
            "file:///app/settings.html",
        ] {
            let err = sender_ok("settings", url).expect_err(url);
            assert!(err.message.contains("origin"), "{url}: {err}");
        }
        // any other label is refused on the settings page, by label
        for label in ["Settings", "settings2", "second", "", "settings "] {
            assert!(sender_ok(label, "tauri://localhost/settings.html").is_err(), "{label:?}");
        }
        // the general allowlist itself is unchanged
        assert!(!page_url_allowed("tauri://localhost/settings.html"));
    }

    #[test]
    fn sender_rejects_wrong_label_or_origin() {
        assert!(sender_ok("second", "tauri://localhost").is_err());
        assert!(sender_ok("", "tauri://localhost").is_err());
        // origin variants Electron would never have accepted either
        for url in [
            "https://evil.example/",
            "file:///app/index.html",
            "tauri://localhost/index.html#extra",
            "tauri://localhost/index.html?x=1",
            "tauri://localhost.evil/",
            "http://tauri.localhost/",
            "tauri://localhost/other.html",
            "",
        ] {
            let err = sender_ok("main", url).expect_err(url);
            assert_eq!(err.code, "denied", "{url}");
            assert!(err.message.contains("origin"), "{url}: {err}");
        }
    }

    #[test]
    fn page_url_allowlist_is_exact_not_prefix() {
        assert!(page_url_allowed("tauri://localhost/index.html"));
        assert!(page_url_allowed("tauri://localhost/"));
        assert!(page_url_allowed("tauri://localhost"));
        // nothing else, ever: no prefix matches, no trailing segments
        assert!(!page_url_allowed("tauri://localhost/index.html/"));
        assert!(!page_url_allowed("tauri://localhostx"));
        assert!(!page_url_allowed("tauri://localhost//"));
    }

    // --- rate gate (ported from main.cjs) ---------------------------------

    #[test]
    fn rate_gate_allows_thirty_then_rejects() {
        let mut rl = RateLimiter::new();
        for i in 0..RATE_LIMIT_PER_WINDOW {
            rl.check(1_000 + u128::from(i)).unwrap_or_else(|e| panic!("call {i}: {e}"));
        }
        let err = rl.check(1_050).expect_err("call 31 must be rejected");
        assert_eq!(err.code, "rate-exceeded");
        assert_eq!(err.message, "Rate exceeded");
        // rejected attempts keep consuming budget inside the window
        assert!(rl.check(1_060).is_err());
    }

    #[test]
    fn rate_gate_window_resets_after_one_second() {
        let mut rl = RateLimiter::new();
        for i in 0..RATE_LIMIT_PER_WINDOW {
            rl.check(5_000 + u128::from(i)).unwrap();
        }
        assert!(rl.check(5_010).is_err());
        // fixed window: exactly at window start + 1000ms the counter resets
        assert!(rl.check(6_000).is_ok());
    }

    #[test]
    fn rate_gate_window_is_fixed_not_sliding() {
        let mut rl = RateLimiter::new();
        rl.check(0).unwrap();
        // a second call 900ms later still shares the window that started at 0
        for i in 1..RATE_LIMIT_PER_WINDOW {
            rl.check(900 + u128::from(i)).unwrap();
        }
        assert!(rl.check(999).is_err());
        assert!(rl.check(1_000).is_ok());
    }

    // --- #437: `dismiss` gains an optional exact notice id (per-row × in the
    // notices list view). Exactly {action} or {action, id}: an unknown/malformed
    // id or any stowaway key is refused; never a silent first-notice fallback.
    const DISMISS_ID: &str = "3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b";

    #[test]
    fn parse_dismiss_is_argument_free_or_carries_exactly_one_valid_id() {
        assert_eq!(parse_dismiss(&json!({"action": "dismiss"})).unwrap().id, None);
        assert_eq!(
            parse_dismiss(&json!({"action": "dismiss", "id": DISMISS_ID})).unwrap().id,
            Some(DISMISS_ID.to_string())
        );
        // #450: a UUID is just one member of the notice id domain; non-UUID
        // ids the store admits pass too (covered boundary-to-store below).
        for bad in [
            json!({"action": "dismiss", "id": 7}),
            json!({"action": "dismiss", "id": null}),
            json!({"action": "dismiss", "id": DISMISS_ID, "kind": "finished"}),
            json!({"action": "dismiss", "index": 1}),
            json!({"action": "click", "id": DISMISS_ID}),
            json!("dismiss"),
        ] {
            assert!(parse_dismiss(&bad).is_err(), "{bad} must be refused");
        }
    }

    // --- #450 (S3): the dismiss `id` is a NOTICE id, not a question UUID.
    // The notice store admits settled notices with ids like `event-1` (the
    // wire id domain, protocol::token: [a-zA-Z0-9_-]{1,128}); the boundary
    // must accept EVERY id the store admits, and keep refusing everything
    // else with the same `invalid notice id` error.
    #[test]
    fn parse_dismiss_accepts_notice_ids_the_store_admits() {
        // boundary-to-store: a non-UUID id the store admits as a settled
        // notice passes parse_dismiss and dismiss_exact removes exactly it.
        let project = crate::protocol::project_id("/project");
        let mut store = crate::protocol::NoticeStore::new(project.clone());
        let event = crate::protocol::Message {
            v: 1,
            kind: "settled".into(),
            project: project.clone(),
            session_id: "session-1".into(),
            at: 1_000,
            id: Some("event-1".into()),
            project_name: None,
            agent: None,
            // S4/T2: the wire text of an `attention` notice; none on a `settled` frame.
            title: None,
            detail: None,
        };
        let other = crate::protocol::Message {
            id: Some("event-2".into()),
            ..event.clone()
        };
        assert!(store.accept(&event, 1_000), "the store admits event-1");
        assert!(store.accept(&other, 1_000), "the store admits event-2");

        let dismiss = parse_dismiss(&json!({"action": "dismiss", "id": "event-1"}))
            .expect("an admitted notice id must pass the boundary");
        assert_eq!(dismiss.id.as_deref(), Some("event-1"));
        assert!(store.dismiss_exact(dismiss.id.as_deref().unwrap(), 1_000));
        let left = store.snapshot(1_000);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, "event-2");
    }

    #[test]
    fn parse_dismiss_still_rejects_ids_outside_the_notice_id_domain() {
        for bad in [
            "",
            "with space",
            "f".repeat(129).as_str(),
            "bad\u{7}id",
        ] {
            let error = parse_dismiss(&json!({"action": "dismiss", "id": bad}))
                .expect_err("{bad:?} must be refused");
            assert_eq!(error.code, "denied");
            assert_eq!(error.message, "Denied: invalid notice id");
        }
    }

    // --- typed error surface ----------------------------------------------

    #[test]
    fn errors_serialize_to_code_and_message_for_the_webview() {
        let value = serde_json::to_value(BridgeError::denied("unknown key")).unwrap();
        assert_eq!(value["code"], "denied");
        assert_eq!(value["message"], "Denied: unknown key");
        // `dismiss` is wired since M2; the typed not-yet-wired shape remains
        // for the M3 verbs (allow/deny/choose).
        let wired = BridgeError::not_yet_wired("allow", "M3");
        assert_eq!(wired.code, "not-yet-wired");
        assert!(wired.message.contains("allow"));
    }
}

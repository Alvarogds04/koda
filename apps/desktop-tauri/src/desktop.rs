//! Island state machine and snapshot projection — unit M1b.
//!
//! Port of the Electron state handling that `preload.cjs` consumers read:
//! - `core.cjs transition(state, action)` — the only writer of the phase,
//! - `main.cjs snapshot()` / `view()` — the exact snapshot shape sent on
//!   `desktop:state` and returned by the `snapshot` action.
//!
//! Pure module: no window-system calls, values are wired in by `main.rs`.

use serde::Serialize;
use serde_json::Value;

/// The island phase, exactly the three strings Electron publishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IslandState {
    Compact,
    Expanded,
    Hidden,
}

impl IslandState {
    pub fn as_str(self) -> &'static str {
        match self {
            IslandState::Compact => "compact",
            IslandState::Expanded => "expanded",
            IslandState::Hidden => "hidden",
        }
    }

    /// `main.cjs view()`: the renderer draws exactly two shapes — the full
    /// island only when expanded, the small bubble otherwise (including
    /// hidden: a hidden window keeps its shape).
    pub fn view(self) -> &'static str {
        match self {
            IslandState::Expanded => "island",
            IslandState::Compact | IslandState::Hidden => "bubble",
        }
    }
}

/// `core.cjs transition(state, action)`, ported from Electron with the
/// #266 S2 Path B extension:
/// - `hide` always hides (immediate, unchanged: hotkey contract #305),
/// - `restore` always lands compact,
/// - `expand` opens from compact AND now reveals from hidden — page-driven,
///   only for genuinely new questions/notices (the event gate is the
///   frontend's reveal gate); the host still never opens anything on its own,
/// - `close` only closes from expanded,
/// - everything else is a no-op (a notice or a decision can never name a verb
///   and can never restore the capsule by itself).
pub fn transition(state: IslandState, action: &str) -> IslandState {
    match action {
        "hide" => IslandState::Hidden,
        "restore" => IslandState::Compact,
        "expand" if matches!(state, IslandState::Compact | IslandState::Hidden) => {
            IslandState::Expanded
        }
        "close" if state == IslandState::Expanded => IslandState::Compact,
        _ => state,
    }
}

/// Declared branding, byte-equal to the single declaration Electron reads
/// (`src/sb_bridge/branding.py`: `BRANDING = Branding(product="Second Brain",
/// assistant="Abito")`); the Tauri app never executes Python, it embeds the
/// same validated values.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Branding {
    pub product: &'static str,
    pub assistant: &'static str,
}

pub const BRANDING: Branding = Branding {
    product: "Abito",
    assistant: "Abito",
};

/// `main.cjs bridgeStatus` (83): the lane's health projection, fed by the
/// M3 approval state (`starting`/`healthy`/`unhealthy`/`stopped`, or
/// `disabled` when no bridge configuration exists).
#[derive(Debug, Clone, Copy, Serialize)]
pub struct BridgeStatus {
    pub state: &'static str,
    pub reason: &'static str,
}

/// The honest projection with no approval configuration at all (legacy
/// `bridgeLogin` absent): `disabled`, and Electron's own reason string.
pub const BRIDGE_DISABLED: BridgeStatus = BridgeStatus {
    state: "disabled",
    reason: "Puente deshabilitado: configuración no válida.",
};

/// The exact snapshot shape `main.cjs snapshot()` returns (13 keys):
/// - `notices`/`connections`/`unavailable`: fed by the M2 transport,
/// - `bridgeStatus`/`card`/`request`: fed by the M3 approval lane (unit M1b
///   projected the honest `disabled`/`null` because the lane did not exist
///   yet; now every value comes from the live lane, never from here),
/// - the rest is the M1b state machine, unchanged.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub state: &'static str,
    pub view: &'static str,
    /// The docked edge the app has placement evidence for, or null when the
    /// X server did not answer (never a guess — same honesty rule as
    /// Electron's `confirmPlacement`).
    pub anchor: Option<&'static str>,
    pub request: Value,
    pub motion_override: bool,
    pub branding: Branding,
    pub connections: u32,
    pub unavailable: bool,
    pub notices: Vec<Value>,
    pub bridge_status: BridgeStatus,
    pub card: Value,
}

impl Snapshot {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        revision: u64,
        phase: IslandState,
        anchor: Option<&'static str>,
        motion_override: bool,
        connections: u32,
        unavailable: bool,
        notices: Vec<Value>,
        bridge_status: BridgeStatus,
        card: Value,
        request: Value,
    ) -> Self {
        Snapshot {
            revision,
            state: phase.as_str(),
            view: phase.view(),
            anchor,
            request,
            motion_override,
            branding: BRANDING,
            connections,
            unavailable,
            notices,
            bridge_status,
            card,
        }
    }
}

/// Q1 — what a second launch (single-instance argv) asks for.
/// `Restore` (default): bring the island back compact and visible WITHOUT
/// taking keyboard focus from the app the human is in. `Chat`: the exact
/// argv `<exe> --chat` is the deliberate "Open Abito chat and type" request
/// (e.g. a shortcut the human binds in GNOME settings — no global hook of
/// ours): open the chat and focus the composer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchIntent {
    Restore,
    Chat,
}

impl LaunchIntent {
    pub fn takes_focus(self) -> bool {
        self == LaunchIntent::Chat
    }
}

pub fn launch_intent(argv: &[String]) -> LaunchIntent {
    match argv {
        [_, flag] if flag == "--chat" => LaunchIntent::Chat,
        _ => LaunchIntent::Restore,
    }
}

/// #304: Abito animates ALWAYS by default. `motion.json` is `{"v":1,"override":bool}`;
/// `override: false` is the human's explicit choice to honor the SYSTEM reduced-motion
/// preference (the `respectSystemMotion` setting). Absent, unreadable or corrupt
/// config means the default: animate (the system value, which WebKit derives from
/// GtkSettings, is never inherited unasked).
pub fn motion_override_from_config(text: Option<&str>) -> bool {
    text.and_then(|t| serde_json::from_str::<Value>(t).ok())
        .and_then(|v| v.get("override").and_then(Value::as_bool))
        .unwrap_or(true)
}

/// #266 S2 Path B: what the Expand dispatch must do when the capsule was
/// Hidden. Pure so the invariant "a reveal never collapses" is deterministic
/// without a window system. The native `core.expanded` flag survives a hide
/// (hide is only `window.hide()`), so it can disagree with the resting
/// expectation:
/// - hidden from compact → run the normal toggle funnel (grow, then show);
/// - hidden while the core still says expanded → the native rect already
///   carries the overview geometry; a blind toggle would emit a COLLAPSE plan
///   and leave phase Expanded over a compact window. Show in place instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HiddenReveal {
    GrowThenShow,
    ShowInPlace,
}

pub fn hidden_reveal(core_expanded: bool) -> HiddenReveal {
    if core_expanded {
        HiddenReveal::ShowInPlace
    } else {
        HiddenReveal::GrowThenShow
    }
}

/// Click is OPEN-ONLY, never legacy Expand's promotion/toggle funnel.
/// Call with captured measurements only, under the admitted identity guard.
#[derive(Debug)]
pub enum ClickPlan {
    Expand(crate::core::TogglePlan),
    Overview(crate::core::ViewPlan),
    Show(crate::geometry::Edge),
}
pub fn plan_click_open(core: &mut crate::core::Core, phase: &mut IslandState,
    measured: &dyn crate::core::WindowIo, area: crate::geometry::Rect) -> ClickPlan {
    let plan = if !core.expanded {
        ClickPlan::Expand(core.toggle(measured, area))
    } else if let Some(view) = core.plan_view(measured, area, false) {
        ClickPlan::Overview(view)
    } else { ClickPlan::Show(core.edge) };
    *phase = IslandState::Expanded;
    plan
}
/// A reserved commit token fences native application/deferred work. Hide's
/// phase fence also rejects a newer Hide that did not increment generation.
pub fn click_plan_is_current(token: u64, generation: u64, phase: IslandState) -> bool {
    token == generation && phase == IslandState::Expanded
}

/// F025: closed URL payload. Tauri re-exports the existing url crate's real
/// parser; controls/credentials are refused before normalization.
pub fn validated_web_url(payload: &Value) -> Result<String, crate::bridge::BridgeError> {
    use crate::bridge::BridgeError;
    let map = payload.as_object().ok_or_else(|| BridgeError::denied("URL payload must be an object"))?;
    if map.len() != 1 { return Err(BridgeError::denied("URL payload carries only url")); }
    let raw = map.get("url").and_then(Value::as_str)
        .ok_or_else(|| BridgeError::denied("URL must be a string"))?;
    if raw.is_empty() || raw.len() > 2000 || raw.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(BridgeError::denied("invalid web URL"));
    }
    let url = tauri::Url::parse(raw).map_err(|_| BridgeError::denied("invalid web URL"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() {
        return Err(BridgeError::denied("only credential-free http/https URLs are allowed"));
    }
    Ok(url.to_string())
}

/// Sender -> validation -> existing rate guard -> opener. Invalid calls spend
/// no rate budget and cannot reach the injected effect (mocked in tests).
pub fn open_web_url<F>(label: &str, origin: &str, payload: &Value,
    rate: &mut crate::bridge::RateLimiter, now: u128, opener: F,
) -> Result<(), crate::bridge::BridgeError>
where F: FnOnce(&str) -> Result<(), crate::bridge::BridgeError> {
    crate::bridge::sender_ok(label, origin)?;
    let url = validated_web_url(payload)?;
    rate.check(now)?;
    opener(&url)
}

#[cfg(test)]
#[path = "open_url_tests.rs"]
mod open_url_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn motion_defaults_to_animate_and_only_an_explicit_false_honors_the_system() {
        assert!(motion_override_from_config(None), "no config file: animate");
        assert!(motion_override_from_config(Some("")), "empty: animate");
        assert!(motion_override_from_config(Some("not json")), "corrupt: animate");
        assert!(motion_override_from_config(Some("{}")), "no key: animate");
        assert!(motion_override_from_config(Some(r#"{"v":1,"override":"no"}"#)), "wrong type: animate");
        assert!(motion_override_from_config(Some(r#"{"v":1,"override":true}"#)));
        assert!(!motion_override_from_config(Some(r#"{"v":1,"override":false}"#)), "the human's explicit opt-in to the system value");
    }

    #[test]
    fn transition_matrix_is_the_electron_one() {
        // ported from legacy test/core.test.cjs; #266 S2 Path B extends it:
        // the host `expand` verb may now ALSO reveal a Hidden island
        // (page-driven, only for genuinely new questions/notices — the event
        // gate lives in the frontend; the host never opens on its own).
        assert_eq!(
            transition(IslandState::Compact, "expand"),
            IslandState::Expanded
        );
        assert_eq!(
            transition(IslandState::Expanded, "close"),
            IslandState::Compact
        );
        assert_eq!(
            transition(IslandState::Expanded, "hide"),
            IslandState::Hidden
        );
        assert_eq!(
            transition(IslandState::Hidden, "notice"),
            IslandState::Hidden,
            "a notice itself is still never a verb: only an explicit expand reveals"
        );
        assert_eq!(
            transition(IslandState::Compact, "notice"),
            IslandState::Compact
        );
        assert_eq!(
            transition(IslandState::Hidden, "restore"),
            IslandState::Compact
        );
        assert_eq!(
            transition(IslandState::Hidden, "expand"),
            IslandState::Expanded,
            "#266: expand reveals from Hidden too, visible and phase must agree"
        );
        assert_eq!(
            transition(IslandState::Expanded, "approve"),
            IslandState::Expanded
        );
    }

    #[test]
    fn hidden_reveal_never_collapses_a_stale_expanded_core() {
        // #266 Path B: `expand` arrives while Hidden and the phase was set to
        // Expanded. The native `core.expanded` flag can be STALE in two
        // directions (hidden from compact, or hidden from the overview).
        // Running the toggle funnel blindly would emit a COLLAPSE plan for a
        // reveal (and desync visibility from phase): the pure decision says
        // show-in-place when the core is already expanded, grow-then-show
        // when it is compact. The reveal must NEVER collapse.
        assert_eq!(hidden_reveal(true), HiddenReveal::ShowInPlace);
        assert_eq!(hidden_reveal(false), HiddenReveal::GrowThenShow);
    }

    #[test]
    fn view_is_a_projection_of_state() {
        assert_eq!(IslandState::Expanded.view(), "island");
        assert_eq!(IslandState::Compact.view(), "bubble");
        assert_eq!(IslandState::Hidden.view(), "bubble");
    }

    #[test]
    fn snapshot_has_the_exact_electron_key_set() {
        let value = serde_json::to_value(Snapshot::new(7, IslandState::Compact, Some("top"), false, 0, true, Vec::new(), BRIDGE_DISABLED, Value::Null, Value::Null))
            .expect("snapshot serializes");
        let mut keys: Vec<String> = value.as_object().expect("object").keys().cloned().collect();
        keys.sort();
        let mut expected = vec![
            "revision",
            "state",
            "view",
            "anchor",
            "request",
            "motionOverride",
            "branding",
            "connections",
            "unavailable",
            "notices",
            "bridgeStatus",
            "card",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected);
        assert_eq!(value["revision"], 7);
        assert_eq!(value["state"], "compact");
        assert_eq!(value["view"], "bubble");
        assert_eq!(value["anchor"], "top");
        assert!(value["request"].is_null());
        assert!(value["card"].is_null());
        assert_eq!(value["notices"], serde_json::json!([]));
        assert_eq!(value["connections"], 0);
        assert_eq!(value["motionOverride"], false);
        assert_eq!(value["branding"]["product"], "Abito");
        assert_eq!(value["branding"]["assistant"], "Abito");
        assert_eq!(value["bridgeStatus"]["state"], "disabled");
    }

    #[test]
    fn snapshot_tracks_phase_and_anchor_evidence() {
        let expanded =
            serde_json::to_value(Snapshot::new(3, IslandState::Expanded, None, true, 0, true, Vec::new(), BRIDGE_DISABLED, Value::Null, Value::Null))
                .unwrap();
        assert_eq!(expanded["state"], "expanded");
        assert_eq!(expanded["view"], "island");
        assert!(expanded["anchor"].is_null(), "no evidence -> null, never a guess");
        assert_eq!(expanded["motionOverride"], true);
        let hidden = serde_json::to_value(Snapshot::new(4, IslandState::Hidden, Some("bottom"), false, 0, true, Vec::new(), BRIDGE_DISABLED, Value::Null, Value::Null))
            .unwrap();
        assert_eq!(hidden["state"], "hidden");
        assert_eq!(hidden["view"], "bubble");
        assert_eq!(hidden["anchor"], "bottom");
    }

    #[test]
    fn snapshot_carries_received_notices_and_connection_state() {
        // M2: the transport feeds these three fields; the shape stays closed.
        let notice = serde_json::json!({
            "id": "event-1", "sessionId": "session-1", "at": 1_700_000_000_000_i64,
            "expiresAt": 1_700_000_060_000_i64, "title": "Pi terminó su turno",
            "detail": "No confirma que la tarea haya salido bien ni que las pruebas hayan pasado.",
            "emotion": "idle"
        });
        let value = serde_json::to_value(Snapshot::new(
            9,
            IslandState::Compact,
            Some("top"),
            false,
            1,     // one handshaked Pi connection
            false, // receiver running
            vec![notice],
            BRIDGE_DISABLED,
            Value::Null,
            Value::Null,
        ))
        .unwrap();
        assert_eq!(value["connections"], 1);
        assert_eq!(value["unavailable"], false);
        assert_eq!(value["notices"].as_array().expect("array").len(), 1);
        assert_eq!(value["notices"][0]["title"], "Pi terminó su turno");
        assert_eq!(value["notices"][0]["emotion"], "idle");
        // a notice changes nothing else: no request, no card, no state
        // transition — it only displays.
        assert!(value["request"].is_null());
        assert!(value["card"].is_null());
        assert_eq!(value["state"], "compact");
        // receiver failure is reported honestly
        let failed = serde_json::to_value(Snapshot::new(
            10,
            IslandState::Compact,
            None,
            false,
            0,
            true,
            Vec::new(),
            BRIDGE_DISABLED,
            Value::Null,
            Value::Null,
        ))
        .unwrap();
        assert_eq!(failed["unavailable"], true);
        assert_eq!(failed["notices"], serde_json::json!([]));
    }

    #[test]
    fn snapshot_carries_the_live_approval_lane_verbatim() {
        // M3: bridgeStatus/card/request come from the lane, never from here.
        let bridge_status = BridgeStatus {
            state: "healthy",
            reason: "Puente disponible.",
        };
        let card = serde_json::json!({
            "operation": "Review document",
            "expires_at": "2999-12-31T23:59:59Z",
            "state": "pending",
            "reason": null,
        });
        let value = serde_json::to_value(Snapshot::new(
            11,
            IslandState::Expanded,
            Some("top"),
            false,
            0,
            false,
            Vec::new(),
            bridge_status,
            card,
            Value::Null,
        ))
        .unwrap();
        assert_eq!(value["bridgeStatus"]["state"], "healthy");
        assert_eq!(value["bridgeStatus"]["reason"], "Puente disponible.");
        assert_eq!(value["card"]["state"], "pending");
        assert!(value["request"].is_null());
        // and the M1b shape is still exactly the legacy key set (12 keys)
        assert_eq!(value.as_object().expect("object").len(), 12);
    }

    // --- Q1: second launch = explicit activation, never an implicit focus --

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn plain_second_launch_restores_without_focus() {
        assert_eq!(launch_intent(&args(&["abito-island"])), LaunchIntent::Restore);
        assert_eq!(launch_intent(&args(&[])), LaunchIntent::Restore);
        assert!(!LaunchIntent::Restore.takes_focus());
    }

    #[test]
    fn only_the_exact_chat_flag_is_a_deliberate_typing_request() {
        assert_eq!(launch_intent(&args(&["abito-island", "--chat"])), LaunchIntent::Chat);
        assert!(LaunchIntent::Chat.takes_focus());
        for other in [
            vec!["abito-island", "--chat=1"],
            vec!["abito-island", "--CHAT"],
            vec!["abito-island", "chat"],
            vec!["abito-island", "--chat", "--probe"],
            vec!["abito-island", "--focus"],
        ] {
            assert_eq!(launch_intent(&args(&other)), LaunchIntent::Restore, "{other:?}");
        }
    }
}

//! #305 — configurable GLOBAL hotkey (show/hide the island) on X11.
//!
//! Layers:
//! - this file, PURE: the combination model, its closed key set, the X11
//!   modifier masks and keysyms, the persisted config (fail closed to the
//!   default) and the toggle decision;
//! - [`x11`]: the real `XGrabKey` grabber on its own connection (tested on a
//!   PRIVATE Xvfb with XTest, never on the human's display);
//! - `hotkeyhost.rs` (binary): wiring to the island's own `Hide`/`restore`.
//!
//! Honest limit: on a Wayland session the island runs under XWayland and an
//! X11 grab only receives the key while an X11 window has the keyboard focus.
//! [`Session::limited`] says so; the UI shows «Atajo limitado». The proper
//! Wayland route is the XDG GlobalShortcuts portal (a separate dependency
//! decision, not made here).
use serde::Serialize;
use std::fmt;

#[cfg(test)]
#[path = "hotkey_tests.rs"]
mod tests;

pub mod foreground;
pub mod gnome;
pub mod portal;
pub mod x11;
// U3a: the Win32 grabber seam; its whole body is cfg(windows)-gated, so this
// mount compiles empty everywhere else (same pattern as the x11/portal files).
pub mod win32;
// HU-053: the macOS Carbon twin; its whole body is cfg(target_os = "macos")-gated.
pub mod macos;

const MAX_INPUT: usize = 64;
const SHIFT: u8 = 1;
const CTRL: u8 = 2;
const ALT: u8 = 4;
const SUPER: u8 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Letter(u8), // b'A'..=b'Z'
    Digit(u8),  // b'0'..=b'9'
    F(u8),      // 1..=12
    Space,
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComboError {
    Empty,
    TooLong,
    UnknownToken,
    NoKey,
    TwoKeys,
    DuplicateModifier,
    NeedsModifier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Combo {
    mods: u8,
    key: Key,
}

impl Combo {
    pub fn default_combo() -> Combo {
        Combo { mods: CTRL | ALT, key: Key::Letter(b'A') }
    }

    /// Parse `Ctrl+Alt+A` style text: case-insensitive, any order, closed key
    /// set (A–Z, 0–9, F1–F12, Space). Anything else is refused.
    pub fn parse(text: &str) -> Result<Combo, ComboError> {
        if text.len() > MAX_INPUT {
            return Err(ComboError::TooLong);
        }
        if text.trim().is_empty() {
            return Err(ComboError::Empty);
        }
        // only printable ASCII and plain spaces: a newline, tab or control byte is junk
        if !text.bytes().all(|b| b == b' ' || (0x21..=0x7e).contains(&b)) {
            return Err(ComboError::UnknownToken);
        }
        let (mut mods, mut key) = (0u8, None);
        for raw in text.split('+') {
            let token = raw.trim_matches(' ');
            if token.is_empty() {
                return Err(ComboError::UnknownToken);
            }
            let lower = token.to_ascii_lowercase();
            let modifier = match lower.as_str() {
                "ctrl" | "control" => Some(CTRL),
                "alt" | "option" => Some(ALT),
                "shift" => Some(SHIFT),
                "super" | "meta" | "win" | "cmd" | "command" => Some(SUPER),
                _ => None,
            };
            if let Some(bit) = modifier {
                if mods & bit != 0 {
                    return Err(ComboError::DuplicateModifier);
                }
                mods |= bit;
                continue;
            }
            let parsed = match lower.as_bytes() {
                [c @ b'a'..=b'z'] => Key::Letter(c.to_ascii_uppercase()),
                [c @ b'0'..=b'9'] => Key::Digit(*c),
                _ if lower == "space" => Key::Space,
                _ if lower == "left" => Key::Left,
                _ if lower == "right" => Key::Right,
                [b'f', rest @ ..] if !rest.is_empty() && rest.iter().all(u8::is_ascii_digit) => {
                    let n: u8 = lower[1..].parse().map_err(|_| ComboError::UnknownToken)?;
                    if !(1..=12).contains(&n) || (rest.len() > 1 && rest[0] == b'0') {
                        return Err(ComboError::UnknownToken);
                    }
                    Key::F(n)
                }
                _ => return Err(ComboError::UnknownToken),
            };
            if key.replace(parsed).is_some() {
                return Err(ComboError::TwoKeys);
            }
        }
        Ok(Combo { mods, key: key.ok_or(ComboError::NoKey)? })
    }

    /// A GLOBAL grab must carry a real modifier, or it would steal plain
    /// typing from every application. Shift alone does not count.
    pub fn validate(&self) -> Result<(), ComboError> {
        if self.mods & (CTRL | ALT | SUPER) == 0 {
            return Err(ComboError::NeedsModifier);
        }
        Ok(())
    }

    /// X11 modifier mask: Shift 1, Control 4, Mod1 (Alt) 8, Mod4 (Super) 0x40.
    pub fn x11_modifiers(&self) -> u16 {
        let mut m = 0u16;
        if self.mods & SHIFT != 0 { m |= 0x01; }
        if self.mods & CTRL != 0 { m |= 0x04; }
        if self.mods & ALT != 0 { m |= 0x08; }
        if self.mods & SUPER != 0 { m |= 0x40; }
        m
    }

    /// The `xdg-shortcuts` trigger text the portal's `preferred_trigger` takes:
    /// uppercase modifiers joined with `+`, then the XKB keysym name of the key.
    pub fn portal_trigger(&self) -> String {
        let mut out = String::new();
        for (bit, name) in [(CTRL, "CTRL"), (ALT, "ALT"), (SHIFT, "SHIFT"), (SUPER, "LOGO")] {
            if self.mods & bit != 0 {
                out.push_str(name);
                out.push('+');
            }
        }
        match self.key {
            Key::Letter(c) => out.push(c.to_ascii_lowercase() as char),
            Key::Digit(c) => out.push(c as char),
            Key::F(n) => out.push_str(&format!("F{n}")),
            Key::Space => out.push_str("space"),
            Key::Left => out.push_str("Left"),
            Key::Right => out.push_str("Right"),
        }
        out
    }

    pub fn keysym(&self) -> u32 {
        match self.key {
            Key::Letter(c) => u32::from(c.to_ascii_lowercase()),
            Key::Digit(c) => u32::from(c),
            Key::Space => 0x20,
            Key::Left => 0xff51,
            Key::Right => 0xff53,
            Key::F(n) => 0xffbe + u32::from(n) - 1,
        }
    }

    /// Win32 `RegisterHotKey` fsModifiers, per the SDK `winuser.h` (MOD_ALT 0x1,
    /// MOD_CONTROL 0x2, MOD_SHIFT 0x4, MOD_WIN **0x8** — not the 0x8000 hook bit).
    /// `MOD_NOREPEAT` is a registration option, not a combo mapping: the win32
    /// grabber adds it there, as the clean twin of the X11 RepeatGuard.
    pub fn win_modifiers(&self) -> u32 {
        let mut m = 0u32;
        if self.mods & ALT != 0 { m |= 0x0001; }
        if self.mods & CTRL != 0 { m |= 0x0002; }
        if self.mods & SHIFT != 0 { m |= 0x0004; }
        if self.mods & SUPER != 0 { m |= 0x0008; }
        m
    }

    /// Win32 virtual-key code for `RegisterHotKey`. The SDK header pins the
    /// identity: VK_0–VK_9 are ASCII '0'–'9', VK_A–VK_Z ASCII 'A'–'Z',
    /// VK_SPACE 0x20, VK_F1..VK_F12 are 0x70..0x7B.
    pub fn win_vk(&self) -> u32 {
        match self.key {
            Key::Letter(c) => u32::from(c.to_ascii_uppercase()),
            Key::Digit(c) => u32::from(c),
            Key::Space => 0x20,
            Key::Left => 0x25,
            Key::Right => 0x27,
            Key::F(n) => 0x70 + u32::from(n) - 1,
        }
    }

    /// Carbon modifier mask for `RegisterEventHotKey` (HIToolbox Events.h): cmdKey 0x100,
    /// shiftKey 0x200, optionKey 0x800, controlKey 0x1000. Super maps to Command.
    pub fn mac_modifiers(&self) -> u32 {
        let mut m = 0u32;
        if self.mods & SUPER != 0 { m |= 0x100; }
        if self.mods & SHIFT != 0 { m |= 0x200; }
        if self.mods & ALT != 0 { m |= 0x800; }
        if self.mods & CTRL != 0 { m |= 0x1000; }
        m
    }

    /// Carbon virtual key code (kVK_*): the PHYSICAL ANSI key, not a character.
    pub fn mac_keycode(&self) -> u32 {
        // Indexed A..Z, then 0..9 (kVK_ANSI_*), then F1..F12.
        const LETTERS: [u32; 26] = [0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46,
            45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6];
        const DIGITS: [u32; 10] = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25];
        const FKEYS: [u32; 12] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];
        match self.key {
            Key::Letter(c) => LETTERS[usize::from(c.to_ascii_uppercase() - b'A')],
            Key::Digit(c) => DIGITS[usize::from(c - b'0')],
            Key::Space => 49,
            Key::Left => 123,
            Key::Right => 124,
            Key::F(n) => FKEYS[usize::from(n) - 1],
        }
    }

    /// An event state matches when the real modifiers are exactly ours; lock
    /// bits (Caps/Num) are ignored, any other modifier makes it another shortcut.
    pub fn matches_state(&self, state: u16) -> bool {
        (state & !LOCK_BITS) & 0x00ff == self.x11_modifiers() && (state & !LOCK_BITS) & !0x00ff & 0x1f00 == 0
    }
}

impl fmt::Display for Combo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (bit, name) in [(CTRL, "Ctrl"), (ALT, "Alt"), (SHIFT, "Shift"), (SUPER, "Super")] {
            if self.mods & bit != 0 {
                write!(f, "{name}+")?;
            }
        }
        match self.key {
            Key::Letter(c) | Key::Digit(c) => write!(f, "{}", c as char),
            Key::F(n) => write!(f, "F{n}"),
            Key::Space => f.write_str("Space"),
            Key::Left => f.write_str("Left"),
            Key::Right => f.write_str("Right"),
        }
    }
}

const LOCK_BITS: u16 = 0x02 | 0x10; // LockMask (Caps) + Mod2 (Num)

/// Every Caps/Num combination must be grabbed: a grab is per exact modifier state.
pub fn lock_variants() -> [u16; 4] {
    [0, 0x02, 0x10, 0x12]
}

/// The independently persisted global bindings. IDs are also the dispatch contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    ToggleIsland,
    DesktopToggle,
    OpenChat,
    GoToAlert,
    JumpToTerminal,
    NextPill,
    PrevPill,
    MuteToggle,
    WardrobeToggle,
}

impl Target {
    pub const ALL: [Self; 9] = [Self::ToggleIsland, Self::DesktopToggle, Self::OpenChat,
        Self::GoToAlert, Self::JumpToTerminal, Self::NextPill, Self::PrevPill,
        Self::MuteToggle, Self::WardrobeToggle];
    pub fn id(self) -> &'static str {
        match self {
            Self::ToggleIsland => "toggleIsland", Self::DesktopToggle => "desktopToggle",
            Self::OpenChat => "openChat", Self::GoToAlert => "goToAlert",
            Self::JumpToTerminal => "jumpToTerminal", Self::NextPill => "nextPill",
            Self::PrevPill => "prevPill", Self::MuteToggle => "muteToggle",
            Self::WardrobeToggle => "wardrobeToggle",
        }
    }
    pub fn description(self) -> &'static str {
        match self {
            Self::ToggleIsland => "Mostrar u ocultar la isla de Koda",
            Self::DesktopToggle => "Enviar Koda al escritorio o traerlo a casa",
            Self::OpenChat => "Abrir el chat de Koda",
            Self::GoToAlert => "Ir al permiso o pregunta pendiente",
            Self::JumpToTerminal => "Enfocar una terminal abierta",
            Self::NextPill => "Ir a la siguiente pestaña",
            Self::PrevPill => "Ir a la pestaña anterior",
            Self::MuteToggle => "Silenciar o activar el sonido de Koda",
            Self::WardrobeToggle => "Abrir o cerrar el guardarropa",
        }
    }
    pub fn portal_id(self) -> &'static str {
        match self {
            Self::ToggleIsland => portal::SHORTCUT_ID,
            Self::DesktopToggle => "toggle-desktop-character",
            _ => self.id(),
        }
    }
}

// ---- persisted config ------------------------------------------------------------
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HotkeyConfig {
    pub combo: Combo,
    pub enabled: bool,
    /// False after an explicit unbind; disabled-but-bound still reserves its combo.
    pub bound: bool,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        HotkeyConfig { combo: Combo::default_combo(), enabled: true, bound: true }
    }
}

impl HotkeyConfig {
    pub fn default_for(target: Target) -> Self {
        match target {
            Target::ToggleIsland => Self::default(),
            Target::DesktopToggle => Self { combo: Combo { mods: CTRL | ALT, key: Key::Letter(b'D') }, enabled: true, bound: true },
            // Preserve Abito's existing Ctrl+Alt+A island binding. The alert gets
            // Shift rather than silently taking that already-working shortcut.
            Target::GoToAlert => Self { combo: Combo { mods: CTRL | ALT | SHIFT, key: Key::Letter(b'A') }, enabled: true, bound: true },
            _ => Self { combo: Combo { mods: CTRL | ALT, key: match target {
                Target::OpenChat => Key::Space, Target::JumpToTerminal => Key::Letter(b'T'),
                Target::NextPill => Key::Right, Target::PrevPill => Key::Left,
                Target::MuteToggle => Key::Letter(b'S'), Target::WardrobeToggle => Key::Letter(b'G'),
                _ => unreachable!(),
            } }, enabled: true, bound: true },
        }
    }

    /// `hotkey.json` = `{"v":1,"combo":"Ctrl+Alt+A","enabled":true}`. Absent,
    /// unreadable, corrupt, wrong version or an invalid combo = the default.
    pub fn from_text(text: Option<&str>) -> HotkeyConfig {
        Self::from_text_for(text, Target::ToggleIsland)
    }

    pub fn from_text_for(text: Option<&str>, target: Target) -> HotkeyConfig {
        let parsed = text
            .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
            .and_then(|v| {
                if v.get("v").and_then(serde_json::Value::as_u64) != Some(1) {
                    return None;
                }
                let combo = Combo::parse(v.get("combo")?.as_str()?).ok()?;
                combo.validate().ok()?;
                let enabled = v.get("enabled").and_then(serde_json::Value::as_bool).unwrap_or(true);
                let bound = v.get("bound").and_then(serde_json::Value::as_bool).unwrap_or(true);
                Some(HotkeyConfig { combo, enabled: enabled && bound, bound })
            });
        parsed.unwrap_or_else(|| Self::default_for(target))
    }

    pub fn to_text(&self) -> String {
        serde_json::json!({ "v": 1, "combo": self.combo.to_string(), "enabled": self.enabled, "bound": self.bound }).to_string()
    }
}

// ---- status shown to the human --------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Disabled,
    Active,
    Taken,
    Invalid,
    Unsupported,
    /// Portal backend: the OS permission dialog is open; the human must accept once.
    PermissionPending,
    /// Portal backend: the human declined the OS dialog.
    PermissionDenied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Session {
    Wayland,
    X11,
    Unknown,
}

impl Session {
    /// XWayland only delivers a global X11 grab while an X11 window is focused.
    pub fn limited(self) -> bool {
        self == Session::Wayland
    }
}

pub fn session_kind(xdg_session_type: Option<&str>, wayland_display: Option<&str>) -> Session {
    match xdg_session_type.map(str::to_ascii_lowercase).as_deref() {
        Some("wayland") => Session::Wayland,
        Some("x11") => Session::X11,
        Some(_) => Session::Unknown,
        None if wayland_display.is_some_and(|d| !d.is_empty()) => Session::Wayland,
        None => Session::Unknown,
    }
}

// ---- one physical press, one toggle ----------------------------------------------------------
/// While the portal's OS dialog is open BOTH routes (the portal's `Activated` and the limited X11 grab) are
/// armed so the shortcut is never without a route. With the island focused a single physical press can then
/// reach the host twice, once from each backend: Hide, then Show. The human sees «it opens but does not hide».
/// Reports of the same press inside this window are ONE press.
pub const PRESS_DEDUP_MS: u64 = 250;

#[derive(Debug, Default)]
pub struct PressGate {
    last_accepted: Option<u64>,
}

impl PressGate {
    pub const fn new_const() -> PressGate {
        PressGate { last_accepted: None }
    }
    /// `now_ms` = any monotonic-enough millisecond clock. True = a real press that must toggle. The window
    /// is measured from the last ACCEPTED press (a dropped duplicate never extends it), and a clock that
    /// goes backwards never blocks the shortcut.
    pub fn accept(&mut self, now_ms: u64) -> bool {
        if let Some(last) = self.last_accepted {
            if now_ms >= last && now_ms - last < PRESS_DEDUP_MS {
                return false;
            }
        }
        self.last_accepted = Some(now_ms);
        true
    }
}

// ---- what the hotkey does ------------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToggleDecision {
    Show,
    Hide,
    Ignore,
}

/// Hidden → show (a pending question is preserved by `restore`). Visible →
/// hide, unless a question is waiting for the human: that keeps the island open.
pub fn toggle_decision(hidden: bool, question_pending: bool) -> ToggleDecision {
    match (hidden, question_pending) {
        (true, _) => ToggleDecision::Show,
        (false, true) => ToggleDecision::Ignore,
        (false, false) => ToggleDecision::Hide,
    }
}

// ---- the closed IPC the settings UI (#308) will call ---------------------------------------
/// `hotkey_action` payload: exactly `{action:"view"}`, `{action:"enable"}`,
/// `{action:"disable"}`, `{action:"reset"}`, `{action:"suspend"}`, `{action:"resume"}` or `{action:"set",combo:"<text>"}`.
/// Nothing else, no extra keys, no oversize input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    View,
    Enable,
    Disable,
    // The Linux catalog host owns clear; the separate Windows host is unchanged.
    #[cfg(target_os = "linux")]
    Clear,
    Reset,
    Set(Combo),
    /// #467: Ajustes is recording a new combination — let go of the grab meanwhile so the
    /// keys reach the recorder. Config is untouched; `Resume` (or the timeout) takes it back.
    Suspend,
    Resume,
}

/// How long a suspension may last before the shortcut is taken back on its own, so a
/// recorder that never reports back (window closed, page crashed) cannot leave it off.
pub const SUSPEND_MAX_MS: u64 = 60_000;

/// Pure bookkeeping of the suspension: a token per suspend, so a timeout armed by an
/// older suspension can never end a newer one.
#[derive(Debug, Default)]
pub struct SuspendGate {
    token: u64,
    active: bool,
}

impl SuspendGate {
    pub fn is_suspended(&self) -> bool { self.active }
    pub fn suspend(&mut self) -> u64 {
        self.token += 1;
        self.active = true;
        self.token
    }
    /// True when this call ended a suspension.
    pub fn resume(&mut self) -> bool { std::mem::replace(&mut self.active, false) }
    /// True when `token` is the live suspension and it just ended.
    pub fn expire(&mut self, token: u64) -> bool {
        self.active && self.token == token && self.resume()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandError {
    InvalidSchema,
    InvalidCombo,
    NeedsModifier,
    ComboInUse,
}

impl CommandError {
    pub fn code(self) -> &'static str {
        match self {
            CommandError::InvalidSchema => "invalid_schema",
            CommandError::InvalidCombo => "invalid_combo",
            CommandError::NeedsModifier => "needs_modifier",
            CommandError::ComboInUse => "combo_in_use",
        }
    }
}

/// Additive routing: the legacy exact-key schema is unchanged.
pub fn parse_targeted(payload: &serde_json::Value) -> Result<(Target, Command), CommandError> {
    let mut map = payload.as_object().ok_or(CommandError::InvalidSchema)?.clone();
    let target = match map.remove("id") {
        None => Target::ToggleIsland,
        Some(serde_json::Value::String(id)) => Target::ALL.into_iter().find(|t| t.id() == id).ok_or(CommandError::InvalidSchema)?,
        _ => return Err(CommandError::InvalidSchema),
    };
    parse_command(&serde_json::Value::Object(map)).map(|command| (target, command))
}

/// Disabled-but-bound configurations still reserve their combination; cleared ones do not.
pub fn check_combo_available(combo: Combo, other: &HotkeyConfig) -> Result<(), CommandError> {
    if other.bound && combo == other.combo { Err(CommandError::ComboInUse) } else { Ok(()) }
}

pub fn parse_command(payload: &serde_json::Value) -> Result<Command, CommandError> {
    let map = payload.as_object().ok_or(CommandError::InvalidSchema)?;
    let action = map.get("action").and_then(serde_json::Value::as_str).ok_or(CommandError::InvalidSchema)?;
    let exact = |n: usize| if map.len() == n { Ok(()) } else { Err(CommandError::InvalidSchema) };
    match action {
        "view" => exact(1).map(|_| Command::View),
        "enable" => exact(1).map(|_| Command::Enable),
        "disable" => exact(1).map(|_| Command::Disable),
        #[cfg(target_os = "linux")]
        "clear" => exact(1).map(|_| Command::Clear),
        "reset" => exact(1).map(|_| Command::Reset),
        "suspend" => exact(1).map(|_| Command::Suspend),
        "resume" => exact(1).map(|_| Command::Resume),
        "set" => {
            exact(2)?;
            let text = map.get("combo").and_then(serde_json::Value::as_str).ok_or(CommandError::InvalidSchema)?;
            let combo = Combo::parse(text).map_err(|_| CommandError::InvalidCombo)?;
            combo.validate().map_err(|_| CommandError::NeedsModifier)?;
            Ok(Command::Set(combo))
        }
        _ => Err(CommandError::InvalidSchema),
    }
}

/// What the island shows about the shortcut (never a secret, never a path).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct View {
    pub combo: String,
    pub enabled: bool,
    pub status: Status,
    /// True when the X11 fallback runs on Wayland: XWayland delivers the grab only
    /// while an X11 window is focused. The portal backend is never limited.
    pub limited: bool,
    /// Which route holds the shortcut: `portal` (XDG GlobalShortcuts) or `x11` (XGrabKey).
    pub backend: &'static str,
    /// Why the portal route was dropped (the human declined the OS dialog, or the
    /// portal failed), so the chip can keep saying it after the X11 fallback took over.
    pub portal_note: Option<Status>,
    /// The combination the OS reports as really bound (the human may have changed it in GNOME's
    /// settings). `None` until the OS answered or when the portal does not hold the shortcut.
    pub effective: Option<String>,
}

/// The status a configuration implies before any grab happened.
pub fn idle_status(cfg: &HotkeyConfig) -> Status {
    if cfg.enabled { Status::Unsupported } else { Status::Disabled }
}

/// After the island is shown by the hotkey: did the window manager hand it the
/// keyboard although nobody asked for it? (`deliberate` = an explicit typing intent.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusAction {
    Leave,
    GiveBack,
}

pub fn focus_after_show(focused: bool, deliberate: bool) -> FocusAction {
    if focused && !deliberate { FocusAction::GiveBack } else { FocusAction::Leave }
}

pub fn backend_name(b: portal::Backend) -> &'static str {
    match b {
        portal::Backend::Portal => "portal",
        portal::Backend::X11 { .. } => "x11",
    }
}

pub fn backend_limited(b: portal::Backend) -> bool {
    matches!(b, portal::Backend::X11 { limited: true })
}

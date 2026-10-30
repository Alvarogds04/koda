//! #315 — tray state derivation and glyph icons (F098/GD011).
//!
//! The tray icon reflects the app with four states, per
//! `docs/desktop-visual-language.md` §10.3 — four glyphs distinguished by
//! SHAPE, not only by color:
//! - `idle` (Listo, `--go` #bdee63): clean ring,
//! - `working` (En curso, `--island-live` #63b3ff): dashed ring,
//! - `needs-attention` (Espera tu sí, `--sun` #ffd23f): ring + badge dot,
//! - `disconnected` (No disponible, `--faint` #6f6d66): dimmed ring + slash.
//!
//! Everything here is pure and headless-testable; `trayhost` wires it to the
//! real TrayIcon. Non-Unix builds run the same pure code (tests cover it) and
//! get an honest no-op tray host.

use serde::{Deserialize, Serialize};

/// The tray state vocabulary, exactly the four names of §10.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrayState {
    Idle,
    Working,
    NeedsAttention,
    Disconnected,
}

impl TrayState {
    // The state-name vocabulary is part of the #315 contract and asserted by
    // tests; production reads the enum directly, so keep this method for the
    // contract check without a dead-code warning in release builds.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn as_str(self) -> &'static str {
        match self {
            TrayState::Idle => "idle",
            TrayState::Working => "working",
            TrayState::NeedsAttention => "needs-attention",
            TrayState::Disconnected => "disconnected",
        }
    }

    /// Stable index for the atomic last-state cache (never a guess: the
    /// unknown value fails closed to [`TrayState::Disconnected`], the honest
    /// "we cannot tell" glyph).
    pub fn from_index(index: u8) -> Self {
        match index {
            0 => TrayState::Idle,
            1 => TrayState::Working,
            2 => TrayState::NeedsAttention,
            _ => TrayState::Disconnected,
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn to_index(self) -> u8 {
        match self {
            TrayState::Idle => 0,
            TrayState::Working => 1,
            TrayState::NeedsAttention => 2,
            TrayState::Disconnected => 3,
        }
    }

    /// Human tooltip line, the island's established Spanish copy.
    pub fn label(self) -> &'static str {
        match self {
            TrayState::Idle => "Koda — Listo",
            TrayState::Working => "Koda — En curso",
            TrayState::NeedsAttention => "Koda — Espera tu sí",
            TrayState::Disconnected => "Koda — No disponible",
        }
    }
}

/// The tray state derivation (§10.3 priority):
/// 1. `needs-attention` — a pending approval card or a pending question asks
///    for the human's decision, over everything else;
/// 2. `disconnected` — the agent connection is anything but
///    `connected`/`working` (no_daemon, not_connected, outdated, error,
///    unavailable…), or the local transport failed: unknown maps here too
///    (fail closed, never a guess);
/// 3. `working` — connected and a turn is in flight;
/// 4. `idle` — connected and nothing pending.
pub fn derive(
    connection: &str,
    card_pending: bool,
    question_pending: bool,
    transport_unavailable: bool,
) -> TrayState {
    // 1. a decision the human owes wins over every machine state
    if card_pending || question_pending {
        return TrayState::NeedsAttention;
    }
    // 2. only these two names are a live connection; everything else (and an
    //    unknown name) fails closed to the honest unavailable glyph
    let live = matches!(connection, "connected" | "working");
    if !live || transport_unavailable {
        return TrayState::Disconnected;
    }
    // 3/4. connected and nothing pending: busy or ready
    if connection == "working" {
        TrayState::Working
    } else {
        TrayState::Idle
    }
}

/// An RGBA glyph (straight alpha, row-major).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Glyph {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// HU-056: the tray icon is Koda Chibi, one pose per tray state (the four §10.3 states keep their meaning and are told apart by pose and
/// the little badge Koda carries, not only by colour): idle = `termino` (calm, tail up), working = `trabaja`, needs-attention = `espera`
/// (the «?» badge), disconnected = `error` (the red badge). Frames are cut from the same sheets the island ships
/// (`tools/gen-koda-tray.py`), so the pixel art is identical to the island's.
const KODA_CELLS: [u32; 3] = [16, 24, 32];

fn koda_frame(state: TrayState, cell: u32) -> &'static [u8] {
    macro_rules! f {
        ($s:literal) => {
            match cell {
                16 => &include_bytes!(concat!("tray_koda/", $s, "-16.rgba"))[..],
                24 => &include_bytes!(concat!("tray_koda/", $s, "-24.rgba"))[..],
                _ => &include_bytes!(concat!("tray_koda/", $s, "-32.rgba"))[..],
            }
        };
    }
    match state {
        TrayState::Idle => f!("idle"),
        TrayState::Working => f!("working"),
        TrayState::NeedsAttention => f!("needs-attention"),
        TrayState::Disconnected => f!("disconnected"),
    }
}

/// The sheet cell (16, 24 or 32 px) a platform's tray should receive. Only whole-number scales of the pixel art are ever handed to the
/// OS: Linux trays ask for 16/22/24 px (24 is the largest exact cell they scale down from); the macOS menu bar draws 16 pt, so 32 px is
/// exactly 16 pt @2x (and 18 pt @2x = 36 px sits within the OS's own scaling of that frame); Windows asks 16 px at 100 %, 24 at 150 %
/// and 32 at 200 %, so 32 px is the exact 200 % frame and Windows scales it down by whole-pixel sampling.
pub fn koda_cell_for_platform() -> u32 {
    if cfg!(target_os = "linux") {
        24
    } else {
        32
    }
}

pub fn glyph_rgba_sized(state: TrayState, cell: u32) -> Glyph {
    let cell = if KODA_CELLS.contains(&cell) { cell } else { 32 };
    Glyph {
        width: cell,
        height: cell,
        rgba: koda_frame(state, cell).to_vec(),
    }
}

pub fn glyph_rgba(state: TrayState) -> Glyph {
    glyph_rgba_sized(state, koda_cell_for_platform())
}

/// One entry of the tray menu: a plain item, a check item (autostart) or a separator. Pure data: the same spec builds the real menu on
/// every platform and is tested natively everywhere.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuEntry {
    Item(&'static str, &'static str),
    Check(&'static str, &'static str),
    Separator,
}

/// HU-048: the tray menu. Identical on every platform except for «Arrancar al iniciar sesión», which is offered only where the autostart
/// toggle really works (`autostart_supported`: a desktop entry on Linux/macOS today). Windows has no Run-key implementation, so the item
/// and its separator are omitted there rather than shown and failing. «Salir» is always last.
pub fn menu_spec(autostart_supported: bool) -> Vec<MenuEntry> {
    let mut menu = vec![MenuEntry::Item("tray-show", "Mostrar Koda"), MenuEntry::Item("tray-hide", "Ocultar"), MenuEntry::Separator];
    if autostart_supported {
        menu.push(MenuEntry::Check("tray-autostart", "Arrancar al iniciar sesión"));
        menu.push(MenuEntry::Separator);
    }
    menu.push(MenuEntry::Item("tray-quit", "Salir"));
    menu
}

#[cfg(test)]
#[path = "tray_tests.rs"]
mod tests;

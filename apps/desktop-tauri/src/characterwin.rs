//! Desktop character geometry (#486, NotchBuddy feature 1).
//!
//! Adapted from Coucou windows/src-tauri/src/desktop.rs (`logic`) and
//! windows/src/mochi/desktop-logic.ts @71b773f, Copyright (c) 2026 Louis Raillé, MIT.
//! Pure functions only: the window lives in `characterhost.rs`. Abito draws its own clay
//! character; nothing of Mochi is copied (LICENSE-ASSETS.md).

#[cfg(test)]
#[path = "characterwin_tests.rs"]
mod tests;

// Adapted from Coucou NotchBuddy/Sources/App/IslandWindowController.swift @71b773f, Copyright (c) 2026 Louis Raillé, MIT.
#[derive(Debug, PartialEq, Eq)]
pub enum DropOutcome { Home, AttachAndReturn, Install }

/// Island hit wins; an explicit window drop never installs or changes the saved spot.
pub fn drop_outcome(over_island: bool, window_found: bool, _from: &str) -> DropOutcome {
    if over_island { DropOutcome::Home } else if window_found { DropOutcome::AttachAndReturn } else { DropOutcome::Install }
}

/// Side of the square window, logical pixels (DesktopMochiLogic.panelSize).
pub const SIZE: f64 = 120.0;
/// Kept between the character and the edges of the work area (clampMargin).
pub const MARGIN: f64 = 24.0;
/// To and from the island (DesktopMochi.swift: 0.45 s).
pub const FLIGHT_MS: u64 = 450;
/// Settling into the spot after a drop (0.25 s, with a little overshoot).
pub const SNAP_MS: u64 = 250;
pub const TICK_MS: u64 = 16;
/// Radius of the clickable body, as a fraction of the window side.
pub const BODY_RADIUS_FRACTION: f64 = 0.24;

fn dist2(a: (f64, f64), b: (f64, f64)) -> f64 {
    (a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn contains(&self, p: (f64, f64)) -> bool {
        p.0 >= self.x && p.0 < self.x + self.w && p.1 >= self.y && p.1 < self.y + self.h
    }
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
}

/// A connected display: whole area, usable part, and physical px per logical px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Display {
    pub frame: Rect,
    pub work: Rect,
    pub scale: f64,
}

pub fn is_over_body(local: (f64, f64), size: f64) -> bool {
    let c = size / 2.0;
    let r = size * BODY_RADIUS_FRACTION;
    let (dx, dy) = (local.0 - c, local.1 - c);
    dx * dx + dy * dy <= r * r
}
pub fn clamp_origin(origin: (f64, f64), size: f64, work: Rect, margin: f64) -> (f64, f64) {
    (
        origin.0.max(work.x + margin).min(work.x + work.w - size - margin),
        origin.1.max(work.y + margin).min(work.y + work.h - size - margin),
    )
}
pub fn settle(origin: (f64, f64), displays: &[Display], size: f64, margin: f64) -> (f64, f64) {
    let Some(first) = displays.first() else { return origin };
    let half = size * first.scale / 2.0;
    let probe = (origin.0 + half, origin.1 + half);
    let near = displays.iter().copied().find(|d| d.frame.contains(probe)).or_else(|| {
        displays.iter().copied().min_by(|a, b| dist2(probe, a.work.center()).total_cmp(&dist2(probe, b.work.center())))
    });
    match near {
        Some(d) => clamp_origin(origin, size * d.scale, d.work, margin * d.scale),
        None => origin,
    }
}
pub fn restore_spot(spot: (f64, f64), displays: &[Display], size: f64, margin: f64) -> Option<(f64, f64)> {
    displays.iter().find_map(|d| {
        let s = size * d.scale;
        d.frame
            .contains((spot.0 + s / 2.0, spot.1 + s / 2.0))
            .then(|| clamp_origin(spot, s, d.work, margin * d.scale))
    })
}
pub fn default_spot(d: &Display, size: f64, margin: f64) -> (f64, f64) {
    let (s, m) = (size * d.scale, margin * d.scale);
    (d.work.x + d.work.w - s - m, d.work.y + d.work.h - s - m)
}
/// The island window's rectangle: dropping the character on it sends it home.
pub fn is_home_drop(cursor: (f64, f64), island: Rect) -> bool {
    island.contains(cursor)
}
/// Window top-left when the character sits in the island: centred under its top edge.
pub fn island_spot(island_center_x: f64, island_top: f64, size: f64, scale: f64) -> (f64, f64) {
    (island_center_x - size * scale / 2.0, island_top)
}
pub fn ease_in_out(t: f64) -> f64 {
    if t < 0.5 { 4.0 * t * t * t } else { 1.0 - (-2.0 * t + 2.0).powi(3) / 2.0 }
}
pub fn ease_out_back(t: f64) -> f64 {
    let c1 = 1.3;
    let c3 = c1 + 1.0;
    1.0 + c3 * (t - 1.0).powi(3) + c1 * (t - 1.0).powi(2)
}
pub fn lerp(a: (f64, f64), b: (f64, f64), t: f64) -> (f64, f64) {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}
/// X11 drag: screen coordinates are global; the window moves in physical pixels.
pub fn drag_top_left(origin: (f64, f64), screen: (f64, f64), screen_at_press: (f64, f64), dpr: f64) -> (f64, f64) {
    (origin.0 + (screen.0 - screen_at_press.0) * dpr, origin.1 + (screen.1 - screen_at_press.1) * dpr)
}

/// The page that draws the character (exact; no query, no fragment).
pub const PAGE: &str = "desktop-character.html";
/// The window label, created by Rust only.
pub const LABEL: &str = "character";
/// Largest absolute coordinate any command accepts (physical or logical px).
pub const COORD_LIMIT: f64 = 1_000_000.0;

#[derive(Debug, PartialEq, Eq)]
pub struct WrongSender;

/// Gate of the verbs the character's own page may call: exact label and exact page.
pub fn character_sender_ok(label: &str, url: &str) -> Result<(), WrongSender> {
    if label == LABEL && (url == concat!("tauri://localhost/", "desktop-character.html") || (cfg!(windows) && windows_page(label, url))) {
        Ok(())
    } else {
        Err(WrongSender)
    }
}

pub fn valid_point(x: f64, y: f64) -> Option<(f64, f64)> {
    (x.is_finite() && y.is_finite() && x.abs() <= COORD_LIMIT && y.abs() <= COORD_LIMIT).then_some((x, y))
}

pub fn spot_to_pref(spot: (f64, f64)) -> (i32, i32) {
    (spot.0.round() as i32, spot.1.round() as i32)
}

pub fn pref_to_spot(spot: (i32, i32)) -> (f64, f64) {
    (spot.0 as f64, spot.1 as f64)
}

/// Cursor (screen, physical) → window-local css px, for the page's gaze.
pub fn cursor_local(cursor: (f64, f64), window: (f64, f64), scale: f64) -> (f64, f64) {
    let k = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    ((cursor.0 - window.0) / k, (cursor.1 - window.1) / k)
}

/// Top-left of a window of `size` logical px centred on `center` (physical px).
pub fn centred_on(center: (f64, f64), size: f64, scale: f64) -> (f64, f64) {
    let half = size * scale / 2.0;
    (center.0 - half, center.1 - half)
}

/// A point in the island window (css px) → screen physical px.
pub fn client_to_screen(client: (f64, f64), island_origin: (f64, f64), scale: f64) -> (f64, f64) {
    (island_origin.0 + client.0 * scale, island_origin.1 + client.1 * scale)
}

/// The clay states the island may ask the character window to show (closed list).
pub fn valid_state(s: &str) -> bool {
    matches!(
        s,
        "idle" | "listen" | "think" | "speak" | "reject" | "confirm" | "error" | "working" | "searching" | "approval" | "question" | "finished" | "ratelimit" | "sleeping" | "dizzy"
    )
}

/// The emotes the island may trigger on the character window (closed list).
pub fn valid_emote(s: &str) -> bool {
    matches!(s, "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed")
}

/// Input region of the character window: the round body only, as scanline rectangles
/// (window-local physical px), so everything around it is click-through.
pub fn body_input_rects(size: f64, scale: f64) -> Vec<(i16, i16, u16, u16)> {
    let k = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let side = (size * k).round();
    let (c, r) = (side / 2.0, side * BODY_RADIUS_FRACTION);
    let step = (side / 30.0).max(1.0);
    let mut out = Vec::new();
    let mut y = (c - r).floor();
    while y < (c + r).ceil() {
        // the widest chord of the band: the row nearest the centre
        let mid = if y + step <= c { y + step } else if y >= c { y } else { c };
        let dy = mid - c;
        let half = (r * r - dy * dy).max(0.0).sqrt();
        let (x0, x1) = ((c - half).floor().max(0.0), (c + half).ceil().min(side));
        let h = step.min(side - y);
        if x1 > x0 && h > 0.0 && y >= 0.0 {
            out.push((x0 as i16, y as i16, (x1 - x0) as u16, h as u16));
        }
        y += step;
    }
    out
}

/// Whether the gaze poll thread of generation `mine` keeps running. It ends when a newer
/// show took over, the app is quitting, or the character window is gone or hidden, so a
/// path that hides the window without bumping the generation can never leak the thread.
pub fn gaze_should_run(current: u64, mine: u64, quitting: bool, window_present: bool, visible: bool) -> bool {
    current == mine && !quitting && window_present && visible
}

/// Navigation the app's lock admits for the character windows: each Rust-created window loads
/// exactly its own page (the character, and the click-through highlight border), nothing else.
pub fn navigation_allowed(label: &str, url: &str) -> bool {
    matches!(
        (label, url),
        ("character", "tauri://localhost/desktop-character.html") | ("character-highlight", "tauri://localhost/desktop-highlight.html")
    ) || (cfg!(windows) && windows_page(label, url))
}

/// #503 T1: the same two pages under the Windows origin (`http://tauri.localhost/`, see `bridge::windows_page_url`). Compiled on every
/// host so tests run anywhere; only consulted under `cfg!(windows)`.
pub fn windows_page(label: &str, url: &str) -> bool {
    matches!(
        (label, url),
        ("character", "http://tauri.localhost/desktop-character.html") | ("character-highlight", "http://tauri.localhost/desktop-highlight.html")
    )
}

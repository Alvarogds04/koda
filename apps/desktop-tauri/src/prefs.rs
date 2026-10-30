//! Non-secret island preferences, stored as v1. Missing or invalid fields use
//! their own defaults: sound ON, no display name, no color overrides, no remembered
//! island position and the system theme (#380). Names are explicit input,
//! never obtained from accounts, the OS, or another profile.
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[cfg(test)]
#[path = "prefs_tests.rs"]
mod tests;

pub const FILE: &str = "prefs.json";
pub const DISPLAY_NAME_MAX: usize = 80;

// #345 immutable catalog identities, shared contract with frontend/pill-catalog.js.
// Platform eligibility is declaration-only; it never means connected.
// 0.2.1 (S3): Ajustes offers the CLIs only as «Herramienta principal» (Claude Code, Codex, Gemini CLI, Hermes). Cursor and Antigravity stay
// ACCEPTED when already stored so no saved choice is lost; the page just no longer offers them.
pub const MAIN_PILLS: [&str; 6] = ["integration_claude", "agent_cursor", "agent_antigravity", "agent_codex", "agent_gemini", "agent_hermes"];
pub const DEFAULT_MAIN_PILL: &str = "integration_claude";
pub const DEFAULT_DECLARED_PILLS: [&str; 4] = ["integration_resend", "integration_n8n", "integration_vercel", "integration_github"];

/// #415 WU2: created blobs — label + optional palette colour entries the human
/// creates by hand (e.g. «Abito GitHub», «Abito Reviewer», «Abito correo»). A created
/// blob carries NO agent behaviour: it is a named, colourable, ordered entry only.
pub const MAX_CUSTOM_BLOBS: usize = 8;
pub const MAX_BLOB_NAME_CHARS: usize = 40;
const CUSTOM_BLOBS: &str = "custom_blobs";

/// #442 T7.4: the specialists (agents) on the island, in order — at most three ids. The
/// shape mirrors the specialist id contract (`specialists::valid_id`); membership against the
/// live specialist store is the host's job. Absent = the default (first three stored), and an
/// untouched file keeps its bytes.
pub const MAX_ISLAND_AGENTS: usize = 3;
const ISLAND_AGENTS: &str = "island_agents";

/// #442 T7.4: the principal's «Qué hace». Same bounds as a specialist's instructions
/// (1..=2000 chars, `\n`/`\t` allowed, every other control refused). DECLARATIVE ONLY: like
/// the specialists' instructions of #375 nothing applies it yet. Absent = none; an empty
/// command clears it and no empty key is ever written.
pub const MAX_ABITO_INSTRUCTIONS_CHARS: usize = 2000;
const ABITO_INSTRUCTIONS: &str = "abito_instructions";

fn clean_instructions(text: &str) -> Result<Option<String>, CommandError> {
    if text.chars().any(|c| c.is_control() && c != '\n' && c != '\t') { return Err(CommandError); }
    let t = text.trim();
    if t.chars().count() > MAX_ABITO_INSTRUCTIONS_CHARS { return Err(CommandError); }
    Ok((!t.is_empty()).then(|| t.to_owned()))
}

fn valid_agent_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty() && b.len() <= 32
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'-' | b'_'))
        && !RESERVED.contains(&id) && id != "abito" && id != "koda"
}

/// Stored order that survives validation: clean ids only, deduplicated, capped. A non-array is absent.
fn island_agents_from(value: Option<&Value>) -> Option<Vec<String>> {
    let list = value?.as_array()?;
    let mut out: Vec<String> = Vec::new();
    for id in list.iter().filter_map(Value::as_str) {
        if valid_agent_id(id) && !out.iter().any(|x| x == id) && out.len() < MAX_ISLAND_AGENTS {
            out.push(id.to_owned());
        }
    }
    Some(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomBlob {
    pub name: String,
    /// One of `COLORS`, or none (a colourless blob must stay reversible).
    pub color: Option<String>,
}

/// The closed blob-name shape: bounded plain text like every other human name —
/// trimmed, no controls, at most `MAX_BLOB_NAME_CHARS` scalars — and never the
/// principal's name: «Abito» itself is the main blob and cannot be created (so it
/// can never be deleted either).
fn valid_blob_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_BLOB_NAME_CHARS
        && name.trim() == name
        && !name.chars().any(char::is_control)
        && !name.eq_ignore_ascii_case("abito")
        && !name.eq_ignore_ascii_case("koda") // Koda 0.1 T2: the principal's visible name
}

fn valid_blob_color(color: &Option<String>) -> bool {
    color.as_deref().is_none_or(|c| normalize_chosen_color(c).is_some())
}

/// The stored blob entries that survive validation, deduplicated case-insensitively
/// (first wins) and capped. Everything else is dropped; nothing here can panic.
fn custom_blobs_from(value: Option<&Value>) -> Vec<CustomBlob> {
    let mut out: Vec<CustomBlob> = Vec::new();
    let Some(list) = value.and_then(Value::as_array) else { return out };
    for entry in list {
        let Some(map) = entry.as_object() else { continue };
        let (Some(name), color) = (map.get("name").and_then(Value::as_str), map.get("color").and_then(Value::as_str)) else { continue };
        if !valid_blob_name(name) || out.len() >= MAX_CUSTOM_BLOBS
            || out.iter().any(|b| b.name.eq_ignore_ascii_case(name)) {
            continue;
        }
        let color = color.and_then(normalize_chosen_color);
        out.push(CustomBlob { name: name.to_owned(), color });
    }
    out
}
pub const PILL_IDS: [&str; 25] = [
    "integration_claude", "agent_cursor", "agent_antigravity", "agent_codex",
    "agent_gemini", "agent_copilot", "agent_muse", "agent_opencode", "agent_amp",
    "agent_hermes", "agent_claude-desktop", "ai_anthropic", "ai_google", "ai_openai",
    "ai_ollama", "ai_lmstudio", "integration_resend", "integration_n8n",
    "integration_vercel", "integration_github", "integration_notion",
    "integration_calcom", "integration_stripe", "integration_music", "integration_spotify",
];
pub fn pill_offered(id: &str) -> bool {
    PILL_IDS.contains(&id) && id != "integration_music" &&
        (id != "agent_claude-desktop" || cfg!(target_os = "windows")) &&
        (id != "integration_spotify" || cfg!(target_os = "linux"))
}

/// Closed stored chosen-colour catalog. Defaults remain absent and are painted by CSS.
pub const COLORS: [&str; 10] = HEX_PALETTE;

/// Coucou core/pill-colors.ts @434d6a2b palette (MIT, Louis Raillé, 2026).
/// Closed chosen-colour catalog; legacy names exist only as migration inputs.
pub const HEX_PALETTE: [&str; 10] = [
    "#F5F6F8", "#F4505E", "#F29B38", "#FACC15", "#4ADE80", "#2DD4BF", "#38BDF8", "#818CF8",
    "#C084FC", "#E879F9",
];
const LEGACY_NAMES: [(&str, &str); 5] = [
    ("green", "#4ADE80"),
    ("blue", "#38BDF8"),
    ("mint", "#2DD4BF"),
    ("orange", "#F29B38"),
    ("purple", "#C084FC"),
];

/// Pure chosen-colour normalization; callers still own identity/type validation.
/// A legacy name is migrated, never persisted as the chosen colour.
pub fn normalize_chosen_color(raw: &str) -> Option<String> {
    if let Some((_, hex)) = LEGACY_NAMES.iter().find(|(name, _)| *name == raw) {
        return Some((*hex).to_owned());
    }
    let digits = raw.strip_prefix('#').unwrap_or(raw);
    if digits.len() != 6 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let hex = format!("#{}", digits.to_ascii_uppercase());
    HEX_PALETTE.contains(&hex.as_str()).then_some(hex)
}

/// The optional colour map. It is absent from a file nobody customised, so an untouched
/// `prefs.json` keeps exactly the bytes it had before #384.
const AVATAR_COLORS: &str = "avatar_colors";

/// #264 (GD049): the optional remembered island position (physical px). Absent from a
/// file nobody has dragged, so an untouched `prefs.json` keeps exactly the bytes it had
/// before #264 as well.
const POSITION: &str = "position";

/// A plausible virtual-desktop coordinate in physical px: no real monitor
/// arrangement reaches this, so a larger value is corrupt data, never a desktop.
const POSITION_LIMIT: u32 = 1_000_000;
/// G16: whole seconds the folded island waits before hiding at the edge.
const ABSENCE_SECONDS: std::ops::RangeInclusive<u16> = 5..=300;
const ABSENCE_DEFAULT_SECONDS: u16 = 10;
/// HU-057 S9: the closed island-size set.
fn valid_island_size(s: &str) -> bool { matches!(s, "s" | "m" | "l" | "auto") }

fn valid_absence_seconds(v: u16) -> bool { ABSENCE_SECONDS.contains(&v) }
/// The new key wins; an invalid or absent one falls back to the pre-change `absence_minutes` (1–120 minutes, x 60, clamped to 300).
fn absence_seconds_from(v: &Value) -> Option<u16> {
    let new = v.get("absence_seconds").and_then(Value::as_u64).and_then(|s| u16::try_from(s).ok()).filter(|s| valid_absence_seconds(*s));
    new.or_else(|| {
        let minutes = v.get("absence_minutes").and_then(Value::as_u64).and_then(|m| u16::try_from(m).ok()).filter(|m| (1..=120).contains(m))?;
        Some((minutes * 60).min(*ABSENCE_SECONDS.end()))
    })
}

/// The optional theme mode key (#380). Absent = `system`, and absence is preserved.
const THEME: &str = "theme";

/// #414: the chosen models of the connected providers (Ajustes → Modelos), per provider.
/// Absent from a file nobody customised, so an untouched `prefs.json` keeps exactly the
/// bytes it had.
const CHOSEN_MODELS: &str = "chosen_models";
/// The provider key is the engine's own strict_id shape; ids keep their catalogue spelling.
const MAX_PROVIDER_ID: usize = 64;
const MAX_MODEL_ID: usize = 200;
/// Bounds so the preference can never outgrow the panel that renders it.
const MAX_MODELS_PER_PROVIDER: usize = 64;
const MAX_PROVIDERS: usize = 32;

/// #389 (GD012): the monitor the human chose for the island (Ajustes → Panel), stored as
/// the platform's stable monitor name (see `workarea::monitor_key`). Absent = the island's
/// current monitor (the behaviour before #389), and absence is preserved. A stored key the
/// island cannot see right now is NOT dropped: the fallback happens at placement, so a
/// redocked laptop restores the choice; only a hostile shape is refused here.
const MONITOR: &str = "monitor";
pub const MAX_MONITOR_KEY: usize = 64;

/// T6.2: the remembered own-window size bounds (logical px). The min matches the
/// window's own `min_inner_size`; the max is beyond any plausible desktop window
/// a human would choose, so a larger value is corrupt data, never a choice.
pub const SETTINGS_WINDOW_SIZE_MIN: (u32, u32) = (720, 480);
pub const SETTINGS_WINDOW_SIZE_MAX: (u32, u32) = (3840, 2400);
const SETTINGS_WINDOW_SIZE: &str = "settings_window_size";

/// #380: the closed theme mode. `System` is the DEFAULT and is also what an absent
/// `theme` field means, so a file nobody changed never grows the key.
pub const THEMES: [&str; 3] = ["system", "light", "dark"];

/// The stored theme mode: an explicit choice, or nothing at all (= system).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

impl Theme {
    pub fn as_str(self) -> &'static str {
        match self {
            Theme::System => "system",
            Theme::Light => "light",
            Theme::Dark => "dark",
        }
    }

    /// Closed enum: only the three known modes parse, everything else is refused.
    pub fn parse(value: &str) -> Option<Theme> {
        match value {
            "system" => Some(Theme::System),
            "light" => Some(Theme::Light),
            "dark" => Some(Theme::Dark),
            _ => None,
        }
    }
}

/// Identities are the same closed slug shape the frontend enforces (avatar-colors.js
/// `IDENTITY`): bounded, lowercase, no path or control characters.
const MAX_IDENTITY: usize = 32;

/// The connector/provider identities (avatar-colors.js `PROVIDERS`, settings-view.js
/// `AGENT_IDS`, notify-view.js `KNOWN_AGENTS`). They are NOT sub-Abitos, so the store refuses
/// to hold a colour for one: keeping a preference the panel would never apply would be a
/// silent lie in the file.
const PROVIDERS: [&str; 5] = ["claude-code", "codex", "copilot-cli", "opencode", "pi"];

/// Keys that must never travel from a preferences file into a plain object's prototype.
const RESERVED: [&str; 3] = ["__proto__", "prototype", "constructor"];

#[derive(Debug, Clone, PartialEq)]
pub struct Prefs {
    /// Sound is ON by default (human decision): only a stored, explicit `"sound": false` silences it.
    pub sound: bool,
    /// Optional v1 gain; absence retains the engine default without rewriting old files.
    pub gain: Option<f64>,
    pub display_name: Option<String>,
    /// Canonical identity -> validated color. Orphan keys are retained, not cleaned up.
    pub avatar_colors: BTreeMap<String, String>,
    /// #264: the origin the human last dragged the island to, physical px. Written by
    /// the native drag path only (see [`Command::SetPosition`]), never from the WebView.
    pub position: Option<(i32, i32)>,
    /// Absent keys retain defaults without growing untouched v1 files.
    pub main_pill: Option<String>,
    pub declared_pills: Option<Vec<String>>,
    /// #346 F033: canonical pill id -> validated palette colour (one of COLORS).
    /// Unknown ids and non-palette values are dropped on load; empty is never written.
    pub pill_colors: BTreeMap<String, String>,
    /// #380 optional theme mode. `None` means the default (`system`) and is never written,
    /// so an untouched or unknown-valued file keeps the bytes it had.
    pub theme: Option<Theme>,
    /// #414: per provider, the model ids the human chose in Ajustes → Modelos. `None`
    /// means nothing was chosen, and nothing is written for it.
    pub chosen_models: Option<BTreeMap<String, Vec<String>>>,
    /// #336 T1b-a: the configured inactivity delay in seconds: 0 is «Nunca»
    /// (#438) and the rest is 5..=120. `None` means the default 15 and is never
    /// written, so an untouched file keeps its bytes.
    pub auto_close_seconds: Option<u16>,
    /// #336 T1b-a: whether a trusted mouse entry may open the settled compact island.
    /// `None` means the default (off) and is never written.
    pub open_on_hover: Option<bool>,
    /// HU-057 S9: island size `s|m|l|auto`; `None` means `auto` and is never written.
    pub island_size: Option<String>,
    /// G16: optional whole seconds the folded island waits before it hides at the edge (5–300); absent means ten seconds.
    /// A file written before this change carries `absence_minutes` instead: it is still READ (minutes x 60, clamped to 300) and
    /// never written again, so the file converts the first time it is saved.
    pub absence_seconds: Option<u16>,
    /// #415 WU2: the blobs the human created by hand (label + optional palette colour),
    /// in creation order. `None` means none, and nothing is written for it, so an
    /// untouched file keeps its bytes.
    pub custom_blobs: Option<Vec<CustomBlob>>,
    /// #389: the platform monitor name the island was pinned to (Ajustes → Panel).
    /// `None` means the default placement (the island's current monitor) and is never
    /// written, so an untouched file keeps its bytes.
    pub monitor: Option<String>,
/// #366 F093: whether Ajustes opens in its own window instead of inside the island.
/// `None` means the default (in-island, #408) and is never written, so an untouched
/// file keeps its bytes.
pub settings_window: Option<bool>,
    /// Open Settings on manual launch only; login autostart stays quiet.
    pub open_settings_at_launch: Option<bool>,
    /// T6.2: the remembered inner size of the own Ajustes window, in LOGICAL px
    /// (as `inner_size`/`min_inner_size` take them). Absent from a file nobody
    /// resized the window in, so an untouched `prefs.json` keeps its bytes; a
    /// stored size outside the bounds below is hostile data, dropped on load —
    /// fitting the CURRENT screen is the opening path's job (`settingswindow::opening_size`).
    pub settings_window_size: Option<(u32, u32)>,
    /// #442 T7.4: ordered ids (at most three) of the specialists on the island. `None` means
    /// the default and is never written, so an untouched file keeps its bytes.
    pub island_agents: Option<Vec<String>>,
    /// #442 T7.4: the principal's declarative «Qué hace». `None` is the default, never written.
    pub abito_instructions: Option<String>,
    /// S10 (L30): whether the Claude plan-usage pill shows in the island header (Coucou's `showPlanInNotch`).
    /// `None` means the default (off) and is never written, so an untouched file keeps its bytes.
    pub show_plan_in_notch: Option<bool>,
    /// S10 (L30): whether the Codex plan-usage pill shows. Turning it on lets the island ask the user's own
    /// `codex app-server` for its rate limits, so it is an explicit opt-in. `None` means off and is never written.
    pub show_codex_plan_in_notch: Option<bool>,
    /// #487: opt-in to read the previous window's app and title for the chat (NotchBuddy feature 8).
    /// `None` means off and is never written.
    pub window_context: Option<bool>,
    /// S5 (#503): the chat's live-state context (sessions + integrations). `None` means ON; only `false` is written.
    pub live_context: Option<bool>,
    /// #486 W2 (Coucou `desktopMochi`): the character lives on the desktop and where it
    /// sits, physical px. `None` = lives in the island (off) and is never written.
    pub desktop_character: Option<DesktopCharacter>,
}

/// #486 W2: the saved state of the desktop character. Written by the native drop path
/// only (see [`Command::SetDesktopCharacter`]), never from the WebView.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DesktopCharacter {
    pub on: bool,
    pub spot: Option<(i32, i32)>,
}

const DESKTOP_CHARACTER: &str = "desktop_character";

/// A closed shape: `{"on":bool}` plus an optional bounded `{"x","y"}` spot; anything else
/// reads as absent (the character stays in the island).
fn desktop_character_from(value: Option<&Value>) -> Option<DesktopCharacter> {
    let map = value?.as_object()?;
    if map.keys().any(|k| k != "on" && k != "spot") { return None; }
    let on = map.get("on")?.as_bool()?;
    let spot = match map.get("spot") {
        None => None,
        some => Some(position_from(some)?),
    };
    Some(DesktopCharacter { on, spot })
}

impl Default for Prefs {
    /// Every field keeps the value `#[derive(Default)]` gave it (absent / empty) except `sound`, which starts ON.
    fn default() -> Self {
        Prefs {
            sound: true,
            gain: None,
            display_name: None,
            avatar_colors: BTreeMap::new(),
            position: None,
            main_pill: None,
            declared_pills: None,
            pill_colors: BTreeMap::new(),
            theme: None,
            chosen_models: None,
            auto_close_seconds: None,
            open_on_hover: None,
            island_size: None,
            absence_seconds: None,
            custom_blobs: None,
            monitor: None,
            settings_window: None,
            open_settings_at_launch: None,
            settings_window_size: None,
            island_agents: None,
            abito_instructions: None,
            show_plan_in_notch: None,
            show_codex_plan_in_notch: None,
            window_context: None,
            live_context: None,
            desktop_character: None,
        }
    }
}

fn validated_name(value: &str) -> Result<Option<String>, CommandError> {
    if value.chars().count() > DISPLAY_NAME_MAX || value.chars().any(char::is_control) {
        return Err(CommandError);
    }
    let name = value.trim();
    Ok((!name.is_empty()).then(|| name.to_owned()))
}

/// The closed identity shape (avatar-colors.js `IDENTITY`): one leading lowercase letter or
/// digit, then letters, digits, `.`, `_` or `-`, at most 32 characters, never a prototype key
/// and never a provider/CLI slug.
fn valid_identity(identity: &str) -> bool {
    if identity.is_empty()
        || identity.len() > MAX_IDENTITY
        || RESERVED.contains(&identity)
        || PROVIDERS.contains(&identity)
    {
        return false;
    }
    let mut bytes = identity.bytes();
    let Some(first) = bytes.next() else { return false };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_' || b == b'-')
}

/// The provider key of a chosen-models entry: the engine's own strict_id shape — bounded,
/// lowercase slug, never a prototype key.
fn valid_provider_id(id: &str) -> bool {
    if id.is_empty() || id.len() > MAX_PROVIDER_ID || RESERVED.contains(&id) {
        return false;
    }
    let bytes = id.as_bytes();
    // the last byte is alphanumeric too: a trailing separator ("dot.") is not a slug
    if !(bytes[bytes.len() - 1].is_ascii_lowercase() || bytes[bytes.len() - 1].is_ascii_digit()) {
        return false;
    }
    let mut bytes = id.bytes();
    let Some(first) = bytes.next() else { return false };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
}

/// A model id keeps its catalogue spelling (several engines key theirs "vendor/model"),
/// bounded ASCII with no whitespace or control characters.
fn valid_model_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= MAX_MODEL_ID && id.trim() == id
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/' | b':'))
}

/// The chosen-models entries that survive validation, deduplicated, one provider at a time.
/// A provider past the per-provider cap is dropped whole (a catalogue that big is not a
/// human choice); the map overall is capped by dropping the rest one by one.
fn chosen_models_from(value: Option<&Value>) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    let Some(map) = value.and_then(Value::as_object) else { return out };
    for (provider, models) in map {
        if !valid_provider_id(provider) || out.len() >= MAX_PROVIDERS {
            continue;
        }
        let Some(list) = models.as_array() else { continue };
        let mut clean: Vec<String> = Vec::new();
        for id in list {
            if let Some(id) = id.as_str() {
                if valid_model_id(id) && !clean.iter().any(|x| x == id) {
                    clean.push(id.to_string());
                }
            }
        }
        if clean.len() > MAX_MODELS_PER_PROVIDER {
            continue;
        }
        if !clean.is_empty() {
            out.insert(provider.clone(), clean);
        }
    }
    out
}

/// The stored monitor key is the platform monitor name verbatim: bounded, trimmed,
/// no control characters and never a prototype key. Unknown or disconnected names
/// still parse — the placement fallback owns "unknown" (`workarea::chosen_area`),
/// never the store; only hostile shapes are refused.
pub fn valid_monitor_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().count() <= MAX_MONITOR_KEY
        && key.trim() == key
        && !key.chars().any(char::is_control)
        && !RESERVED.contains(&key)
}

/// `unsigned_abs` instead of `abs`: `i32::MIN.abs()` overflows, and a damaged file
/// must never panic the island.
fn valid_position(x: i32, y: i32) -> bool {
    x.unsigned_abs() <= POSITION_LIMIT && y.unsigned_abs() <= POSITION_LIMIT
}

/// T6.2: the remembered window size is bounded on BOTH axes; everything else is
/// corrupt data and reads as no remembered size.
fn valid_settings_window_size(w: u32, h: u32) -> bool {
    (SETTINGS_WINDOW_SIZE_MIN.0..=SETTINGS_WINDOW_SIZE_MAX.0).contains(&w)
        && (SETTINGS_WINDOW_SIZE_MIN.1..=SETTINGS_WINDOW_SIZE_MAX.1).contains(&h)
}

/// The stored size, accepted only as a complete, bounded `{"w":..,"h":..}` pair —
/// a closed shape, like the IPC schema and #264's position, so a padded, truncated
/// or wrongly typed object reads as *no remembered size* (the 960x640 default).
fn settings_window_size_from(value: Option<&Value>) -> Option<(u32, u32)> {
    let map = value?.as_object()?;
    if map.len() != 2 {
        return None;
    }
    let w = u32::try_from(map.get("w")?.as_u64()?).ok()?;
    let h = u32::try_from(map.get("h")?.as_u64()?).ok()?;
    valid_settings_window_size(w, h).then_some((w, h))
}

/// The stored position, accepted only as a complete, bounded `{"x":..,"y":..}` pair —
/// a closed shape, like the IPC schema, so a padded, truncated or wrongly typed object
/// reads as *no position* (the default placement) instead of a guess.
fn position_from(value: Option<&Value>) -> Option<(i32, i32)> {
    let map = value?.as_object()?;
    if map.len() != 2 {
        return None;
    }
    let x = i32::try_from(map.get("x")?.as_i64()?).ok()?;
    let y = i32::try_from(map.get("y")?.as_i64()?).ok()?;
    valid_position(x, y).then_some((x, y))
}

/// The stored colours that survive validation. Everything else is dropped, and nothing here can
/// panic on a hostile or damaged preferences file.
fn colors_from(value: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(map) = value.and_then(Value::as_object) else { return out };
    for (identity, color) in map {
        let Some(color) = color.as_str() else { continue };
        if valid_identity(identity) && normalize_chosen_color(color).is_some() {
            out.insert(identity.clone(), normalize_chosen_color(color).unwrap());
        }
    }
    out
}

/// #346: pill colours are stricter than the avatar map — only a real catalog id with a
/// palette colour survives, so an unknown pill or an off-set colour reads as *no colour*
/// and never grows the stored catalogue (the `main_pill` reading rule, mirrored).
fn pill_colors_from(value: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(map) = value.and_then(Value::as_object) else { return out };
    for (id, color) in map {
        let Some(color) = color.as_str() else { continue };
        if PILL_IDS.contains(&id.as_str()) && normalize_chosen_color(color).is_some() {
            out.insert(id.clone(), normalize_chosen_color(color).unwrap());
        }
    }
    out
}

impl Prefs {
    pub fn gain(&self) -> f64 { self.gain.filter(|n| valid_gain(*n)).unwrap_or(0.12) }

    pub fn main_pill(&self) -> &str {
        self.main_pill.as_deref().filter(|id| MAIN_PILLS.contains(id)).unwrap_or(DEFAULT_MAIN_PILL)
    }

    pub fn declared_pills(&self) -> Vec<String> {
        let defaults: Vec<String> = DEFAULT_DECLARED_PILLS.iter().map(|id| id.to_string()).collect();
        let mut clean = Vec::new();
        for id in self.declared_pills.as_ref().unwrap_or(&defaults) {
            if id != self.main_pill() && pill_offered(id) && !clean.contains(id) {
                clean.push(id.clone());
            }
        }
        clean
    }

    fn valid_pill_choices(&self) -> bool {
        self.main_pill.as_deref().is_none_or(|id| MAIN_PILLS.contains(&id)) &&
            self.declared_pills.as_ref().is_none_or(|ids| *ids == self.declared_pills())
    }
    /// #415 WU2: the WebView projection of the created blobs (validated names and
    /// palette names only); nothing created is null, like every optional field.
    pub fn custom_blobs_view(&self) -> Value {
        match &self.custom_blobs {
            Some(blobs) => Value::Array(blobs.iter().map(|b| json!({"name": b.name, "color": b.color})).collect()),
            None => Value::Null,
        }
    }
    /// #442 T7.4: the WebView projection of the island order; absent is null.
    pub fn island_agents_view(&self) -> Value {
        match &self.island_agents {
            Some(ids) => json!(ids),
            None => Value::Null,
        }
    }
    /// #442 T7.4: the WebView projection of the principal's «Qué hace»; absent is null.
    pub fn abito_instructions_view(&self) -> Value {
        match &self.abito_instructions {
            Some(text) => json!(text),
            None => Value::Null,
        }
    }
    /// The effective mode: an absent or unreadable field is `system`.
    pub fn theme(&self) -> Theme { self.theme.unwrap_or_default() }

    /// #336: the effective delay — an absent or out-of-range stored value reads
    /// as the public contract's default of 15 seconds. #438: 0 is «Nunca» — a
    /// real accepted value, never clamped.
    pub fn auto_close_seconds(&self) -> u16 {
        self.auto_close_seconds.filter(|s| *s == 0 || (5..=120).contains(s)).unwrap_or(15)
    }

    /// #336: the effective hover policy — absent means off.
    pub fn open_on_hover(&self) -> bool { self.open_on_hover.unwrap_or(false) }
    /// HU-057 S9: the effective island size; absent or foreign means `auto`.
    pub fn island_size(&self) -> &str {
        self.island_size.as_deref().filter(|s| valid_island_size(s)).unwrap_or("auto")
    }
    pub fn absence_seconds(&self) -> u16 { self.absence_seconds.filter(|v| valid_absence_seconds(*v)).unwrap_or(ABSENCE_DEFAULT_SECONDS) }

    /// S10 (L30): the effective plan-pill policy — absent means off.
    pub fn show_plan_in_notch(&self) -> bool { self.show_plan_in_notch.unwrap_or(false) }
    /// S10 (L30): the effective Codex pill policy — absent means off (no `codex app-server` is ever started).
    pub fn show_codex_plan_in_notch(&self) -> bool { self.show_codex_plan_in_notch.unwrap_or(false) }
    pub fn window_context(&self) -> bool { self.window_context.unwrap_or(false) }
    pub fn live_context(&self) -> bool { self.live_context.unwrap_or(true) }

    /// #366 F093: the effective Ajustes placement — absent means in-island (#408).
    pub fn settings_window_on(&self) -> bool { self.settings_window.unwrap_or(false) }
    pub fn open_settings_at_launch(&self) -> bool { self.open_settings_at_launch.unwrap_or(false) }

    pub fn from_text(text: Option<&str>) -> Prefs {
        let v = text.and_then(|t| serde_json::from_str::<Value>(t).ok());
        let Some(v) = v else { return Prefs::default() };
        if v.get("v").and_then(Value::as_u64) != Some(1) {
            return Prefs::default();
        }
        let mut prefs = Prefs {
            sound: v.get("sound").and_then(Value::as_bool).unwrap_or(true),
            gain: v.get("gain").and_then(Value::as_f64).filter(|n| valid_gain(*n)),
            avatar_colors: colors_from(v.get(AVATAR_COLORS)),
            display_name: v.get("display_name").and_then(Value::as_str)
                .and_then(|name| validated_name(name).ok()).flatten(),
            position: position_from(v.get(POSITION)),
            main_pill: v.get("main_pill").and_then(Value::as_str)
                .filter(|id| MAIN_PILLS.contains(id)).map(str::to_owned),
            declared_pills: v.get("declared_pills").and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_owned).collect()),
            pill_colors: pill_colors_from(v.get("pill_colors")),
            theme: v.get(THEME).and_then(Value::as_str).and_then(Theme::parse),
            chosen_models: Some(chosen_models_from(v.get(CHOSEN_MODELS))),
            auto_close_seconds: v.get("auto_close_seconds").and_then(Value::as_u64)
                .and_then(|s| u16::try_from(s).ok()).filter(|s| *s == 0 || (5..=120).contains(s)),
            open_on_hover: v.get("open_on_hover").and_then(Value::as_bool),
            island_size: v.get("island_size").and_then(Value::as_str).filter(|s| valid_island_size(s)).map(str::to_string),
            absence_seconds: absence_seconds_from(&v),
            custom_blobs: {
                let blobs = custom_blobs_from(v.get(CUSTOM_BLOBS));
                (!blobs.is_empty()).then_some(blobs)
            },
            monitor: v.get(MONITOR).and_then(Value::as_str)
                .filter(|key| valid_monitor_key(key)).map(str::to_owned),
            settings_window: v.get("settings_window").and_then(Value::as_bool),
            open_settings_at_launch: v.get("open_settings_at_launch").and_then(Value::as_bool).filter(|on| *on),
            settings_window_size: settings_window_size_from(v.get(SETTINGS_WINDOW_SIZE)),
            island_agents: island_agents_from(v.get(ISLAND_AGENTS)),
            abito_instructions: v.get(ABITO_INSTRUCTIONS).and_then(Value::as_str)
                .and_then(|text| clean_instructions(text).ok()).flatten(),
            show_plan_in_notch: v.get("show_plan_in_notch").and_then(Value::as_bool),
            show_codex_plan_in_notch: v.get("show_codex_plan_in_notch").and_then(Value::as_bool),
            window_context: v.get("window_context").and_then(Value::as_bool),
            live_context: v.get("live_context").and_then(Value::as_bool),
            desktop_character: desktop_character_from(v.get(DESKTOP_CHARACTER)),
        };
        if prefs.declared_pills.is_some() { prefs.declared_pills = Some(prefs.declared_pills()); }
        // A map whose every entry was dropped reads as absent: an untouched file keeps its bytes.
        if prefs.chosen_models.as_ref().is_some_and(|m| m.is_empty()) {
            prefs.chosen_models = None;
        }
        prefs
    }

    pub fn to_text(&self) -> String {
        let mut v = json!({"v": 1, "sound": self.sound});
        if let Some(gain) = self.gain.filter(|n| valid_gain(*n)) {
            v["gain"] = json!(gain);
        }
        if let Some(name) = &self.display_name {
            v["display_name"] = json!(name);
        }
        if !self.avatar_colors.is_empty() {
            v[AVATAR_COLORS] = json!(colors_from(Some(&json!(self.avatar_colors))));
        }
        if let Some((x, y)) = self.position.filter(|(x, y)| valid_position(*x, *y)) {
            v[POSITION] = json!({"x": x, "y": y});
        }
        if self.main_pill.is_some() { v["main_pill"] = json!(self.main_pill()); }
        if self.declared_pills.is_some() { v["declared_pills"] = json!(self.declared_pills()); }
        if !self.pill_colors.is_empty() { v["pill_colors"] = json!(pill_colors_from(Some(&json!(self.pill_colors)))); }
        if let Some(theme) = self.theme {
            v[THEME] = json!(theme.as_str());
        }
        if let Some(map) = &self.chosen_models {
            if !map.is_empty() {
                v[CHOSEN_MODELS] = json!(map);
            }
        }
        if let Some(seconds) = self.auto_close_seconds.filter(|s| *s == 0 || (5..=120).contains(s)) {
            v["auto_close_seconds"] = json!(seconds);
        }
        if let Some(seconds) = self.absence_seconds.filter(|v| valid_absence_seconds(*v)) { v["absence_seconds"] = json!(seconds); }
        if let Some(hover) = self.open_on_hover {
            v["open_on_hover"] = json!(hover);
        }
        if let Some(size) = self.island_size.as_deref().filter(|s| valid_island_size(s)) {
            v["island_size"] = json!(size);
        }
        if let Some(blobs) = &self.custom_blobs {
            if !blobs.is_empty() {
                v[CUSTOM_BLOBS] = json!(blobs.iter().map(|b| match &b.color {
                    Some(color) => json!({"name": b.name, "color": color}),
                    None => json!({"name": b.name}),
                }).collect::<Vec<_>>());
            }
        }
        if let Some(monitor) = &self.monitor {
            v[MONITOR] = json!(monitor);
        }
        if let Some(on) = self.settings_window {
            v["settings_window"] = json!(on);
        }
        if self.open_settings_at_launch() { v["open_settings_at_launch"] = json!(true); }
        if let Some((w, h)) = self.settings_window_size.filter(|(w, h)| valid_settings_window_size(*w, *h)) {
            v[SETTINGS_WINDOW_SIZE] = json!({"w": w, "h": h});
        }
        if let Some(ids) = &self.island_agents {
            v[ISLAND_AGENTS] = json!(ids);
        }
        if let Some(text) = &self.abito_instructions {
            v[ABITO_INSTRUCTIONS] = json!(text);
        }
        if let Some(on) = self.show_plan_in_notch {
            v["show_plan_in_notch"] = json!(on);
        }
        if let Some(on) = self.show_codex_plan_in_notch {
            v["show_codex_plan_in_notch"] = json!(on);
        }
        if let Some(on) = self.window_context {
            v["window_context"] = json!(on);
        }
        if let Some(on) = self.live_context {
            v["live_context"] = json!(on);
        }
        if let Some(c) = self.desktop_character.filter(|c| c.spot.is_none_or(|(x, y)| valid_position(x, y))) {
            v[DESKTOP_CHARACTER] = match c.spot {
                Some((x, y)) => json!({"on": c.on, "spot": {"x": x, "y": y}}),
                None => json!({"on": c.on}),
            };
        }
        v.to_string()
    }
}

fn valid_gain(n: f64) -> bool { n.is_finite() && (0.0..=0.2).contains(&n) }

/// #435: the `order` payload of the reorder commands — exactly an array of strings.
/// Membership against the live state is apply's job (parse never sees it).
fn ordered_strings(value: Option<&Value>) -> Result<Vec<String>, CommandError> {
    value.and_then(Value::as_array).ok_or(CommandError)?
        .iter()
        .map(|item| item.as_str().map(str::to_owned).ok_or(CommandError))
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    View,
    SoundOn,
    SoundOff,
    SetSoundGain(f64),
    SetDisplayName(String),
    SetAvatarColor { identity: String, color: String },
    ClearAvatarColor { identity: String },
    /// #264: the native drag path remembers where the island was released. Deliberately
    /// NOT produced by [`parse_command`]: the WebView can read neither the position nor
    /// the fact that one is stored.
    SetPosition(i32, i32),
    SetMainPill(String),
    ToggleDeclaredPill(String),
    /// #346 F033: colour of one offered pill, or its removal (palette name in, key out).
    SetPillColor { id: String, color: String },
    ClearPillColor(String),
    SetTheme(Theme),
    /// #415 WU2: a created blob — label + optional palette colour, appended in
    /// creation order. The principal «Abito» is never creatable.
    CreateBlob { name: String, color: Option<String> },
    /// #415 WU2: removes exactly the named created blob; an unknown name is refused.
    DeleteBlob { name: String },
    /// #415 WU2: the closed-palette colour of one created blob, or its removal
    /// (empty string clears — a colourless blob must stay reversible).
    SetBlobColor { name: String, color: String },
    /// #435: the persisted declared order — exactly the currently declared ids,
    /// reordered. A strict permutation is the only accepted input.
    ReorderDeclaredPills(Vec<String>),
    /// #435: the persisted created-blob order — exactly the stored names (exact,
    /// case-sensitive), reordered. A strict permutation is the only accepted input.
    ReorderBlobs(Vec<String>),
    /// #414: the WHOLE list of one provider replaces what is stored; an empty list clears it.
    SetChosenModels { provider: String, models: Vec<String> },
    /// #336 T1b-a: the island's inactivity interaction as one exact closed
    /// shape — integer `auto_close_seconds` 0 («Nunca», #438) or 5..=120 and
    /// `open_on_hover`.
    SetIslandInteraction { auto_close_seconds: u16, open_on_hover: bool },
    /// HU-057 S9: the island size, closed set `s|m|l|auto`.
    SetIslandSize(String),
    SetAbsenceSeconds(u16),
    /// #389: the platform monitor name the island is pinned to (Ajustes → Panel).
    /// A choice is only ever one of the keys the island itself saw and offered;
    /// falling back when a stored key is no longer connected is placement's job.
    SetMonitor(String),
    /// #389: back to the default behaviour — the island's current monitor.
    ClearMonitor,
    /// #366 F093: whether Ajustes opens in its own window (opt-in). `false`
    /// stores the default (in-island) as no key at all.
    SetSettingsWindow(bool),
    SetOpenSettingsAtLaunch(bool),
    // Host-only filesystem effects, never copied into prefs.json.
    AutostartView,
    SetAutostart(bool),
    /// S10 (L30): show or hide the Claude plan-usage pill in the island header. `false` stores no key.
    SetShowPlanInNotch(bool),
    /// S10 (L30): show or hide the Codex plan-usage pill (an opt-in to `codex app-server`). `false` stores no key.
    SetShowCodexPlanInNotch(bool),
    SetWindowContext(bool),
    SetLiveContext(bool),
    /// #486 W2: the desktop character left or returned to the island, and the spot it sits
    /// at. Deliberately NOT produced by [`parse_command`]: only the native drop path saves
    /// it. `on:false` with no spot is the default and stores no key.
    SetDesktopCharacter { on: bool, spot: Option<(i32, i32)> },
    /// T6.2: the remembered inner size of the own Ajustes window (logical px).
    /// Deliberately NOT produced by [`parse_command`]: the WebView can read
    /// neither the size nor the fact that one is stored — the size comes from
    /// the window's own resize events, never from the page (like #264's position).
    SetSettingsWindowSize(u32, u32),
    /// #442 T7.4: the specialists on the island, in order: at most three unique, well-shaped ids.
    /// Membership against the live specialist store is checked by the host (it owns that store).
    SetIslandAgents(Vec<String>),
    /// #442 T7.4: a deleted specialist leaves the island order. Rust-internal (the specialists
    /// host sends it after a delete): deliberately NOT produced by [`parse_command`].
    PruneIslandAgent(String),
    /// #442 T7.4: the principal's «Qué hace»; an empty (or blank) text clears it.
    SetAbitoInstructions(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandError;

/// Closed schema: existing actions take one key; set_display_name takes exactly
/// action + display_name (string, <=80 scalars, no controls). Blank clears it.
/// set_avatar_color takes exactly action + identity + color; clear_avatar_color
/// takes exactly action + identity. Pill choices take exactly action + id:
/// set_main_pill (workspace only), toggle_declared_pill (offered catalog only).
/// set_pill_color takes exactly action + id + color (a palette colour, offered catalog only),
/// clear_pill_color exactly action + id (same gate).
/// apply checks main exclusion/capacity under the transaction gate. All writers
/// apply checks main exclusion/capacity under the transaction gate. set_theme takes exactly
/// action + theme with one of the three closed modes. All writers retain the other known
/// typed optional fields; unknown file keys are dropped. #415 WU2: create_blob takes
/// exactly action + name (+ optional color, a palette colour), delete_blob exactly
/// action + name, set_blob_color exactly action + name + color (a palette colour or "").
/// #435: reorder_declared_pills takes exactly action + order (an array of strings,
/// a strict permutation of the currently declared ids — checked at apply) and
/// reorder_blobs takes exactly action + order (a strict permutation of the stored
/// created-blob names, exact case — checked at apply).
/// #389: set_monitor takes exactly action + monitor (a bounded platform monitor name),
/// clear_monitor exactly action.
pub fn parse_command(payload: &Value) -> Result<Command, CommandError> {
    let map = payload.as_object().ok_or(CommandError)?;
    match map.get("action").and_then(Value::as_str) {
        Some("view") if map.len() == 1 => Ok(Command::View),
        Some("autostart_view") if map.len() == 1 => Ok(Command::AutostartView),
        Some(action @ ("set_open_settings_at_launch" | "set_autostart")) if map.len() == 2 => {
            let on = map.get("enabled").and_then(Value::as_bool).ok_or(CommandError)?;
            Ok(if action == "set_autostart" { Command::SetAutostart(on) } else { Command::SetOpenSettingsAtLaunch(on) })
        }
        Some("sound_on") if map.len() == 1 => Ok(Command::SoundOn),
        Some("sound_off") if map.len() == 1 => Ok(Command::SoundOff),
        Some("set_sound_gain") if map.len() == 2 => {
            let gain = map.get("gain").and_then(Value::as_f64).ok_or(CommandError)?;
            if !valid_gain(gain) { return Err(CommandError); }
            Ok(Command::SetSoundGain(gain))
        }
        Some("set_display_name") if map.len() == 2 => {
            let name = map.get("display_name").and_then(Value::as_str).ok_or(CommandError)?;
            validated_name(name)?;
            Ok(Command::SetDisplayName(name.to_owned()))
        }
        Some("set_avatar_color") if map.len() == 3 => {
            let identity = map.get("identity").and_then(Value::as_str).ok_or(CommandError)?;
            let color = map.get("color").and_then(Value::as_str).ok_or(CommandError)?;
            if !valid_identity(identity) || !normalize_chosen_color(color).is_some() {
                return Err(CommandError);
            }
            Ok(Command::SetAvatarColor { identity: identity.to_string(), color: normalize_chosen_color(color).unwrap() })
        }
        Some("clear_avatar_color") if map.len() == 2 => {
            let identity = map.get("identity").and_then(Value::as_str).ok_or(CommandError)?;
            if !valid_identity(identity) {
                return Err(CommandError);
            }
            Ok(Command::ClearAvatarColor { identity: identity.to_string() })
        }
        Some(action @ ("set_main_pill" | "toggle_declared_pill")) if map.len() == 2 => {
            let id = map.get("id").and_then(Value::as_str).ok_or(CommandError)?;
            if action == "set_main_pill" {
                if !MAIN_PILLS.contains(&id) { return Err(CommandError); }
                Ok(Command::SetMainPill(id.to_owned()))
            } else {
                if !pill_offered(id) { return Err(CommandError); }
                Ok(Command::ToggleDeclaredPill(id.to_owned()))
            }
        }
        Some("set_pill_color") if map.len() == 3 => {
            let id = map.get("id").and_then(Value::as_str).ok_or(CommandError)?;
            let color = map.get("color").and_then(Value::as_str).ok_or(CommandError)?;
            if !pill_offered(id) || !normalize_chosen_color(color).is_some() {
                return Err(CommandError);
            }
            Ok(Command::SetPillColor { id: id.to_owned(), color: normalize_chosen_color(color).unwrap_or_default() })
        }
        Some("clear_pill_color") if map.len() == 2 => {
            let id = map.get("id").and_then(Value::as_str).ok_or(CommandError)?;
            if !pill_offered(id) {
                return Err(CommandError);
            }
            Ok(Command::ClearPillColor(id.to_owned()))
        }
        Some("set_theme") if map.len() == 2 => {
            let theme = map.get("theme").and_then(Value::as_str).ok_or(CommandError)?;
            Ok(Command::SetTheme(Theme::parse(theme).ok_or(CommandError)?))
        }
        // #415 WU2: created blobs. The colour key is optional but must be a real
        // palette name when present; the name gate runs at parse AND at apply.
        Some("create_blob") if map.len() == 2 || map.len() == 3 => {
            let name = map.get("name").and_then(Value::as_str).ok_or(CommandError)?;
            if !valid_blob_name(name) {
                return Err(CommandError);
            }
            let color = if map.len() == 3 {
                let color = map.get("color").and_then(Value::as_str).ok_or(CommandError)?;
                if !normalize_chosen_color(color).is_some() { return Err(CommandError); }
                normalize_chosen_color(color)
            } else { None };
            Ok(Command::CreateBlob { name: name.to_owned(), color })
        }
        Some("delete_blob") if map.len() == 2 => {
            let name = map.get("name").and_then(Value::as_str).ok_or(CommandError)?;
            if !valid_blob_name(name) {
                return Err(CommandError);
            }
            Ok(Command::DeleteBlob { name: name.to_owned() })
        }
        Some("set_blob_color") if map.len() == 3 => {
            let name = map.get("name").and_then(Value::as_str).ok_or(CommandError)?;
            let color = map.get("color").and_then(Value::as_str).ok_or(CommandError)?;
            if !valid_blob_name(name) || !(color.is_empty() || normalize_chosen_color(color).is_some()) {
                return Err(CommandError);
            }
            Ok(Command::SetBlobColor { name: name.to_owned(), color: normalize_chosen_color(color).unwrap_or_default() })
        }
        // #435: the persisted order. Parse validates only the closed shape (exactly
        // action + order, an array of strings — parse_command never sees the live
        // state); apply is the strict permutation gate.
        Some(action @ ("reorder_declared_pills" | "reorder_blobs")) if map.len() == 2 => {
            let order = ordered_strings(map.get("order"))?;
            if action == "reorder_declared_pills" {
                Ok(Command::ReorderDeclaredPills(order))
            } else {
                Ok(Command::ReorderBlobs(order))
            }
        }
        Some("set_chosen_models") if map.len() == 3 => {
            let provider = map.get("provider").and_then(Value::as_str).ok_or(CommandError)?;
            let models = map.get("models").and_then(Value::as_array).ok_or(CommandError)?;
            if !valid_provider_id(provider) || models.len() > MAX_MODELS_PER_PROVIDER {
                return Err(CommandError);
            }
            let mut clean: Vec<String> = Vec::new();
            for id in models {
                let id = id.as_str().ok_or(CommandError)?;
                if !valid_model_id(id) {
                    return Err(CommandError);
                }
                if !clean.iter().any(|x| x == id) {
                    clean.push(id.to_string());
                }
            }
            Ok(Command::SetChosenModels { provider: provider.to_string(), models: clean })
        }
        Some("set_absence_seconds") if map.len() == 2 => {
            let seconds = map.get("seconds").and_then(Value::as_u64).ok_or(CommandError)?;
            let seconds = u16::try_from(seconds).map_err(|_| CommandError)?;
            if !valid_absence_seconds(seconds) { return Err(CommandError); }
            Ok(Command::SetAbsenceSeconds(seconds))
        }
        // #336 T1b-a: exactly action + auto_close_seconds + open_on_hover.
        // `as_u64` already refuses floats, strings, null and negatives; the
        // accepted set is {0} («Nunca», #438) ∪ 5..=120, matching the public
        // scheduler contract.
        Some("set_island_size") if map.len() == 2 => {
            let size = map.get("island_size").and_then(Value::as_str).ok_or(CommandError)?;
            if !valid_island_size(size) { return Err(CommandError); }
            Ok(Command::SetIslandSize(size.to_string()))
        }
        Some("set_island_interaction") if map.len() == 3 => {
            let seconds = map.get("auto_close_seconds").and_then(Value::as_u64).ok_or(CommandError)?;
            if !(seconds == 0 || (5..=120).contains(&seconds)) {
                return Err(CommandError);
            }
            let hover = map.get("open_on_hover").and_then(Value::as_bool).ok_or(CommandError)?;
            Ok(Command::SetIslandInteraction { auto_close_seconds: seconds as u16, open_on_hover: hover })
        }
        // #389: the chosen panel monitor. The value gate runs at parse AND at apply.
        Some("set_monitor") if map.len() == 2 => {
            let monitor = map.get("monitor").and_then(Value::as_str).ok_or(CommandError)?;
            if !valid_monitor_key(monitor) {
                return Err(CommandError);
            }
            Ok(Command::SetMonitor(monitor.to_owned()))
        }
        Some("clear_monitor") if map.len() == 1 => Ok(Command::ClearMonitor),
        // #366 F093: exactly action + settings_window (a bool). No coercion: a
        // number, string or null is refused and changes nothing.
        Some("set_settings_window") if map.len() == 2 => {
            let on = map.get("settings_window").and_then(Value::as_bool).ok_or(CommandError)?;
            Ok(Command::SetSettingsWindow(on))
        }
        // S10 (L30): exactly action + show_plan_in_notch (a bool); no coercion.
        Some("set_show_plan_in_notch") if map.len() == 2 => {
            let on = map.get("show_plan_in_notch").and_then(Value::as_bool).ok_or(CommandError)?;
            Ok(Command::SetShowPlanInNotch(on))
        }
        Some("set_show_codex_plan_in_notch") if map.len() == 2 => {
            let on = map.get("show_codex_plan_in_notch").and_then(Value::as_bool).ok_or(CommandError)?;
            Ok(Command::SetShowCodexPlanInNotch(on))
        }
        // #487: exactly action + window_context (a bool); no coercion.
        Some("set_window_context") if map.len() == 2 => {
            let on = map.get("window_context").and_then(Value::as_bool).ok_or(CommandError)?;
            Ok(Command::SetWindowContext(on))
        }
        // S5 (#503): exactly action + live_context (a bool); no coercion.
        Some("set_live_context") if map.len() == 2 => {
            let on = map.get("live_context").and_then(Value::as_bool).ok_or(CommandError)?;
            Ok(Command::SetLiveContext(on))
        }
        // #442 T7.4: exactly action + order (≤3 unique well-shaped ids).
        Some("set_island_agents") if map.len() == 2 => {
            let order = ordered_strings(map.get("order"))?;
            if !valid_island_order(&order) { return Err(CommandError); }
            Ok(Command::SetIslandAgents(order))
        }
        // #442 T7.4: exactly action + text (a string; the bounds gate runs here and in apply).
        Some("set_abito_instructions") if map.len() == 2 => {
            let text = map.get("text").and_then(Value::as_str).ok_or(CommandError)?;
            clean_instructions(text)?;
            Ok(Command::SetAbitoInstructions(text.to_owned()))
        }
        _ => Err(CommandError),
    }
}

fn valid_island_order(order: &[String]) -> bool {
    order.len() <= MAX_ISLAND_AGENTS
        && order.iter().all(|id| valid_agent_id(id))
        && order.iter().collect::<std::collections::HashSet<_>>().len() == order.len()
}

/// Change only the selected field. Validate direct callers as well as IPC input.
pub fn apply(current: &Prefs, command: &Command) -> Result<Prefs, CommandError> {
    let mut next = current.clone();
    match command {
        Command::View => {}
        Command::AutostartView | Command::SetAutostart(_) => return Err(CommandError),
        Command::SetOpenSettingsAtLaunch(on) => next.open_settings_at_launch = on.then_some(true),
        Command::SoundOn => next.sound = true,
        Command::SoundOff => next.sound = false,
        Command::SetSoundGain(gain) => {
            if !valid_gain(*gain) { return Err(CommandError); }
            next.gain = Some(*gain);
        }
        Command::SetDisplayName(name) => next.display_name = validated_name(name)?,
        Command::SetAvatarColor { identity, color } => {
            if !valid_identity(identity) || !normalize_chosen_color(color).is_some() {
                return Err(CommandError);
            }
            next.avatar_colors.insert(identity.clone(), normalize_chosen_color(color).unwrap());
        }
        Command::ClearAvatarColor { identity } => {
            if !valid_identity(identity) { return Err(CommandError); }
            next.avatar_colors.remove(identity);
        }
        Command::SetPosition(x, y) => {
            if !valid_position(*x, *y) { return Err(CommandError); }
            next.position = Some((*x, *y));
        }
        Command::SetMainPill(id) => {
            if !current.valid_pill_choices() || !MAIN_PILLS.contains(&id.as_str()) { return Err(CommandError); }
            if id != current.main_pill() {
                next.main_pill = Some(id.clone());
                if current.declared_pills().contains(id) {
                    next.declared_pills = Some(current.declared_pills().into_iter().filter(|x| x != id).collect());
                }
            }
        }
        Command::ToggleDeclaredPill(id) => {
            if !current.valid_pill_choices() || !pill_offered(id) || id == current.main_pill() { return Err(CommandError); }
            let mut ids = current.declared_pills();
            if ids.contains(id) { ids.retain(|x| x != id); }
            else {
                ids.push(id.clone());
            }
            next.declared_pills = Some(ids);
        }
        Command::SetTheme(theme) => next.theme = Some(*theme),
        Command::SetChosenModels { provider, models } => {
            if !valid_provider_id(provider) {
                return Err(CommandError);
            }
            // Deduplicate here too: apply is the direct-caller boundary as well as the
            // IPC one (parse_command already deduplicates for the wire).
            let mut clean: Vec<String> = Vec::new();
            for m in models {
                if !valid_model_id(m) {
                    return Err(CommandError);
                }
                if !clean.contains(m) {
                    clean.push(m.clone());
                }
            }
            if clean.len() > MAX_MODELS_PER_PROVIDER {
                return Err(CommandError);
            }
            let mut map = current.chosen_models.clone().unwrap_or_default();
            if clean.is_empty() {
                map.remove(provider);
            } else {
                map.insert(provider.clone(), clean);
            }
            next.chosen_models = if map.is_empty() { None } else { Some(map) };
        }
        Command::SetPillColor { id, color } => {
            if !pill_offered(id) || !normalize_chosen_color(color).is_some() {
                return Err(CommandError);
            }
            next.pill_colors.insert(id.clone(), normalize_chosen_color(color).unwrap());
        }
        Command::ClearPillColor(id) => {
            if !pill_offered(id) { return Err(CommandError); }
            next.pill_colors.remove(id);
        }
        Command::SetAbsenceSeconds(seconds) => {
            if !valid_absence_seconds(*seconds) { return Err(CommandError); }
            next.absence_seconds = Some(*seconds);
        }
        // #336 T1b-a: both fields commit together under the same gate; the
        // range/type checks already ran at parse and run again here for
        // direct callers, exactly like every other typed command. #438:
        // accepted values are {0} («Nunca») ∪ 5..=120.
        Command::SetIslandSize(size) => {
            if !valid_island_size(size) { return Err(CommandError); }
            next.island_size = Some(size.clone());
        }
        Command::SetIslandInteraction { auto_close_seconds, open_on_hover } => {
            if !(*auto_close_seconds == 0 || (5..=120).contains(auto_close_seconds)) { return Err(CommandError); }
            next.auto_close_seconds = Some(*auto_close_seconds);
            next.open_on_hover = Some(*open_on_hover);
        }
        // #415 WU2: created blobs. The name/colour gates ran at parse and run again
        // here for direct callers; a duplicate (case-insensitive), the principal's
        // name, a ninth blob and an unknown delete are refused without any change.
        Command::CreateBlob { name, color } => {
            if !valid_blob_name(name) || !valid_blob_color(color) { return Err(CommandError); }
            let mut blobs = current.custom_blobs.clone().unwrap_or_default();
            if blobs.len() >= MAX_CUSTOM_BLOBS || blobs.iter().any(|b| b.name.eq_ignore_ascii_case(name)) {
                return Err(CommandError);
            }
            blobs.push(CustomBlob { name: name.clone(), color: color.as_deref().and_then(normalize_chosen_color) });
            next.custom_blobs = Some(blobs);
        }
        Command::DeleteBlob { name } => {
            if !valid_blob_name(name) { return Err(CommandError); }
            let mut blobs = current.custom_blobs.clone().unwrap_or_default();
            let before = blobs.len();
            blobs.retain(|b| b.name != *name);
            if blobs.len() == before { return Err(CommandError); }
            next.custom_blobs = (!blobs.is_empty()).then_some(blobs);
        }
        Command::SetBlobColor { name, color } => {
            if !valid_blob_name(name) || !(color.is_empty() || normalize_chosen_color(color).is_some()) {
                return Err(CommandError);
            }
            let mut blobs = current.custom_blobs.clone().unwrap_or_default();
            let Some(blob) = blobs.iter_mut().find(|b| b.name == *name) else { return Err(CommandError); };
            blob.color = normalize_chosen_color(color);
            next.custom_blobs = Some(blobs);
        }
        // #435: the persisted order — a strict permutation of the currently stored
        // list. Anything else (duplicates, unknowns, a different set or size) is
        // refused without any change, exactly like every other closed command.
        Command::ReorderDeclaredPills(order) => {
            if !current.valid_pill_choices() { return Err(CommandError); }
            let ids = current.declared_pills();
            if order.len() != ids.len()
                || !order.iter().all(|id| ids.contains(id))
                || order.iter().collect::<std::collections::HashSet<_>>().len() != order.len()
            {
                return Err(CommandError);
            }
            next.declared_pills = Some(order.clone());
        }
        Command::ReorderBlobs(names) => {
            let blobs = current.custom_blobs.clone().unwrap_or_default();
            if names.len() != blobs.len()
                || !names.iter().all(|name| blobs.iter().any(|b| &b.name == name))
                || names.iter().collect::<std::collections::HashSet<_>>().len() != names.len()
            {
                return Err(CommandError);
            }
            next.custom_blobs = (!blobs.is_empty()).then_some({
                let mut reordered = Vec::with_capacity(names.len());
                for name in names {
                    let Some(blob) = blobs.iter().find(|b| &b.name == name) else { return Err(CommandError); };
                    reordered.push(blob.clone());
                }
                reordered
            });
        }
        // #389: the value gate ran at parse and runs again here for direct
        // callers; clearing always succeeds and never writes the key.
        Command::SetMonitor(monitor) => {
            if !valid_monitor_key(monitor) { return Err(CommandError); }
            next.monitor = Some(monitor.clone());
        }
        Command::ClearMonitor => next.monitor = None,
        // #366 F093: `false` is the default, so it stores no key at all (an
        // untouched file keeps its bytes) — the same rule as every optional field.
        Command::SetSettingsWindow(on) => next.settings_window = on.then_some(true),
        Command::SetShowPlanInNotch(on) => next.show_plan_in_notch = on.then_some(true),
        Command::SetShowCodexPlanInNotch(on) => next.show_codex_plan_in_notch = on.then_some(true),
        Command::SetWindowContext(on) => next.window_context = on.then_some(true),
        Command::SetLiveContext(on) => next.live_context = (!on).then_some(false),
        Command::SetDesktopCharacter { on, spot } => {
            if spot.is_some_and(|(x, y)| !valid_position(x, y)) { return Err(CommandError); }
            next.desktop_character = (*on || spot.is_some()).then_some(DesktopCharacter { on: *on, spot: *spot });
        }
        // T6.2: the value gate ran nowhere else — apply is the ONLY boundary for
        // this Rust-side command, so the bounds check runs here for every caller.
        Command::SetSettingsWindowSize(w, h) => {
            if !valid_settings_window_size(*w, *h) { return Err(CommandError); }
            next.settings_window_size = Some((*w, *h));
        }
        Command::SetIslandAgents(order) => {
            if !valid_island_order(order) { return Err(CommandError); }
            next.island_agents = Some(order.clone());
        }
        Command::SetAbitoInstructions(text) => next.abito_instructions = clean_instructions(text)?,
        Command::PruneIslandAgent(id) => {
            if let Some(ids) = next.island_agents.as_mut() { ids.retain(|x| x != id); }
        }
    }
    Ok(next)
}

/// Persistence precedes publication. The caller retains current on error and
/// installs the returned value only on success. View/idempotent writes skip disk.
pub fn update(current: &Prefs, command: &Command, persist: impl FnOnce(&Prefs) -> bool) -> Result<Prefs, CommandError> {
    let next = apply(current, command)?;
    if next != *current && !persist(&next) {
        return Err(CommandError);
    }
    Ok(next)
}

/// Serialize a whole preference command, including its publication. Every writer
/// must share the same gate and state mutex. The callback runs with the state
/// mutex released (chat may re-read it), but with the gate held: another command
/// cannot commit or publish ahead of this snapshot. Callbacks must not re-enter
/// transact. Failed persistence never installs state or invokes publish.
pub fn transact(
    serial: &std::sync::Mutex<()>,
    current: &std::sync::Mutex<Prefs>,
    command: &Command,
    persist: impl FnOnce(&Prefs) -> bool,
    publish: impl FnOnce(&Prefs),
) -> Result<Prefs, CommandError> {
    let _serial = serial.lock().expect("prefs transaction lock");
    let (next, changed) = {
        let mut current = current.lock().expect("prefs lock");
        let next = update(&current, command, persist)?;
        let changed = next != *current;
        *current = next.clone();
        (next, changed)
    };
    if changed {
        publish(&next);
    }
    Ok(next)
}

#[cfg(test)]
mod island_size_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_is_auto_and_never_written() {
        assert_eq!(Prefs::default().island_size(), "auto");
        assert!(!Prefs::default().to_text().contains("island_size"));
    }

    #[test]
    fn closed_set_and_zero_mutation_on_unknown() {
        for ok in ["s", "m", "l", "auto"] {
            assert!(parse_command(&json!({"action":"set_island_size","island_size":ok})).is_ok(), "{ok}");
        }
        for bad in [json!("xl"), json!("S"), json!(""), json!(1), json!(null), json!("auto ")] {
            assert!(parse_command(&json!({"action":"set_island_size","island_size":bad})).is_err(), "{bad}");
        }
        assert!(parse_command(&json!({"action":"set_island_size"})).is_err());
        assert!(parse_command(&json!({"action":"set_island_size","island_size":"m","x":1})).is_err());
        let current = apply(&Prefs::default(), &Command::SetIslandSize("l".into())).unwrap();
        assert!(apply(&current, &Command::SetIslandSize("huge".into())).is_err());
        assert_eq!(current.island_size(), "l");
    }

    #[test]
    fn persistence_round_trip_and_foreign_value_falls_back() {
        let p = apply(&Prefs::default(), &Command::SetIslandSize("s".into())).unwrap();
        let back = Prefs::from_text(Some(&p.to_text()));
        assert_eq!(back.island_size(), "s");
        let foreign = Prefs::from_text(Some(r#"{"v":1,"island_size":"giant"}"#));
        assert_eq!(foreign.island_size(), "auto");
        assert!(!foreign.to_text().contains("island_size"));
    }
}

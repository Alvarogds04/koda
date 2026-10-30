//! #327 — manual specialized sub-Abitos: the pure store behind them.
//! #375 — each dot additionally carries a bounded plain-text default Space name and a closed,
//! DECLARATIVE-ONLY permission set (read-only by default). Neither field is executed, injected or
//! enforced anywhere: absent new fields are today's behaviour byte-identically, and hostile stored
//! values are dropped, never executed.
//! #376 — each dot may additionally carry a closed list of extra Space NAMES (multi-Space access),
//! also DECLARATIVE-ONLY: bounded plain text like the default Space, capped count, no enforcement
//! here. Absent or empty is today's behaviour.
//!
//! A specialist is a role the HUMAN creates and chooses by hand: a display name, the instructions
//! that specialise it, and optionally which verified local model it uses. Nothing here delegates,
//! spawns, schedules or widens a permission: choosing a role only changes what the next turn says
//! and which local model answers it.
//!
//! Contract (`specialists.json`, one concern per file like `prefs.json` / `models-selection.json`):
//! - the id is opaque, lowercase ASCII, `^[a-z0-9][a-z0-9._-]{0,31}$`, generated ONCE at creation
//!   and stable across renames. It is never derived from the display name, the provider or a CLI id,
//!   and the reserved identities (`abito` the principal, the engine CLIs, the prototype keys) are
//!   refused: a specialist can never impersonate the principal. #384 resolves the COLOUR for this
//!   same id (`avatar_colors`); this module carries no colour logic at all;
//! - `active: null` IS the principal (Abito). A specialist is never created already chosen;
//! - name 1..40 and instructions 1..2000 characters, instructions may keep normal line breaks and
//!   tabs (a section of a prompt is genuinely multiline); other C0/C1 controls and DEL are refused;
//! - only a genuinely absent file loads as a healthy empty store. Existing invalid/unreadable
//!   data returns a load error; the host blocks mutations rather than overwriting it;
//! - every refused command returns `CommandError` and leaves the previous store byte-identical.

use serde_json::{json, Value};
use std::path::Path;

use abito_island::models::valid_profile_id;

pub const FILE: &str = "specialists.json";
pub const MAX_SPECIALISTS: usize = 24;
pub const MAX_NAME_CHARS: usize = 40;
pub const MAX_INSTRUCTIONS_CHARS: usize = 2000;
pub const MAX_SPACE_CHARS: usize = 80;
/// #376 — the closed cap on a dot's extra Space NAMES. There is no registry to resolve against:
/// the bound only keeps the declarative list and the file size finite.
pub const MAX_SPACES: usize = 8;
pub const ID_MAX_LEN: usize = 32;
/// A closed payload is far smaller than this; the cap only stops a hostile one before it parses.
const MAX_PAYLOAD_BYTES: usize = 16 * 1024;
/// Maximum compact v1 output, derived from the complete accepted contract. serde_json writes
/// Unicode scalars as at most four UTF-8 bytes; allowed escaped characters (quote, backslash,
/// LF/TAB) use two bytes. Other controls, which would need six-byte escapes, are rejected.
/// IDs are ASCII (32), model IDs ASCII (64, models::valid_profile_id); string quotes and JSON
/// punctuation come from the empty templates. Include every inter-record comma and active ID.
/// #375: the template carries the empty Space string and the empty permission array; the budget
/// adds the widest Space name (4×80) and the widest closed permission array (36 bytes).
/// #376: it also carries the empty extra-Space list; the budget adds the widest closed list
/// (8 names of 4×80 bytes each, quotes, commas and brackets counted) beyond that `[]`.
const RECORD_JSON_BYTES: usize = r#"{"id":"","name":"","instructions":"","model":"","space":"","spaces":[],"permissions":[]}"#.len();
const PERMISSIONS_ARRAY_MAX: usize = r#"["read","write","network","execute"]"#.len();
const SPACES_ARRAY_EXTRA: usize = 2 + MAX_SPACES * (4 * MAX_SPACE_CHARS + 2) + (MAX_SPACES - 1) - 2;
const STORE_JSON_BYTES: usize = r#"{"v":1,"active":"","specialists":[]}"#.len();
pub(crate) const MAX_FILE_BYTES: usize = STORE_JSON_BYTES + ID_MAX_LEN
    + MAX_SPECIALISTS * (RECORD_JSON_BYTES + ID_MAX_LEN + 64
        + 4 * (MAX_NAME_CHARS + MAX_INSTRUCTIONS_CHARS + MAX_SPACE_CHARS)
        + PERMISSIONS_ARRAY_MAX - 2
        + SPACES_ARRAY_EXTRA)
    + (MAX_SPECIALISTS - 1);

/// The identities a specialist may never take: the principal of the island, the engine CLIs the
/// connectors screen already talks to (#306), and the prototype keys no plain object should take.
const FORBIDDEN_IDS: [&str; 8] = [
    "abito",
    "pi",
    "claude-code",
    "codex",
    "opencode",
    "__proto__",
    "prototype",
    "constructor",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    Read,
    Write,
    Network,
    Execute,
}

impl Permission {
    /// The closed vocabulary, in the canonical storage order.
    pub const ALL: [Permission; 4] = [Self::Read, Self::Write, Self::Network, Self::Execute];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Network => "network",
            Self::Execute => "execute",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "read" => Some(Self::Read),
            "write" => Some(Self::Write),
            "network" => Some(Self::Network),
            "execute" => Some(Self::Execute),
            _ => None,
        }
    }
}

/// #375 — read-only is the default AND the floor: an absent, empty or hostile stored set degrades
/// to exactly this. DECLARATIVE ONLY: nothing here grants, executes, injects or enforces anything.
pub const READ_ONLY: [Permission; 1] = [Permission::Read];

/// The canonical storage order is `ALL`'s order, whatever the input order was.
pub fn canonical_permissions(list: &[Permission]) -> Vec<Permission> {
    Permission::ALL.iter().filter(|p| list.contains(p)).copied().collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Specialist {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub model: Option<String>,
    /// #375 — the dot's default Space NAME: bounded plain text, declarative only. There is no
    /// Space registry to reference and nothing resolves or applies it today.
    pub space: Option<String>,
    /// #376 — the dot's extra Space NAMES (multi-Space access), beyond the default one: bounded
    /// plain text, deduplicated, capped, DECLARATIVE ONLY. Nothing resolves, grants or enforces
    /// them here; an absent or empty list is today's behaviour.
    pub spaces: Vec<String>,
    /// #375 — a closed, DECLARATIVE-ONLY permission subset; never empty (read-only is the floor).
    pub permissions: Vec<Permission>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Store {
    /// `None` = the principal (Abito) is the role in use.
    pub active: Option<String>,
    pub items: Vec<Specialist>,
}

impl Store {
    pub fn find(&self, id: &str) -> Option<&Specialist> {
        self.items.iter().find(|s| s.id == id)
    }

    /// The role in use, if a real record backs `active`.
    pub fn active(&self) -> Option<&Specialist> {
        self.active.as_deref().and_then(|id| self.find(id))
    }

    /// Fail closed: absent, unreadable, corrupt, wrongly versioned or wrong-shaped text is an
    /// empty store. Invalid records are dropped (the file is never rewritten by a read) and an
    /// active id with no surviving record is no role at all.
    pub fn from_text(text: Option<&str>) -> Store {
        let Some(text) = text else { return Store::default() };
        let Ok(v) = serde_json::from_str::<Value>(text) else { return Store::default() };
        if v.get("v").and_then(Value::as_u64) != Some(1) {
            return Store::default();
        }
        let Some(list) = v.get("specialists").and_then(Value::as_array) else {
            return Store::default();
        };
        let mut items: Vec<Specialist> = Vec::new();
        for raw in list {
            if items.len() == MAX_SPECIALISTS {
                break;
            }
            let Some(record) = record(raw) else { continue };
            if items.iter().any(|s| s.id == record.id) {
                continue; // the first record with an id wins; a duplicate never shadows it
            }
            items.push(record);
        }
        let active = v
            .get("active")
            .and_then(Value::as_str)
            .filter(|id| valid_id(id) && items.iter().any(|s| s.id == *id))
            .map(str::to_string);
        Store { active, items }
    }

    /// One line, deterministic field set. Only the validated, trimmed values are written.
    pub fn to_text(&self) -> String {
        let items: Vec<Value> = self
            .items
            .iter()
            .map(|s| {
                json!({
                    "id": s.id,
                    "name": s.name,
                    "instructions": s.instructions,
                    "model": s.model,
                    "space": s.space,
                    "spaces": s.spaces,
                    "permissions": s.permissions.iter().map(|p| p.as_str()).collect::<Vec<_>>(),
                })
            })
            .collect();
        json!({"v": 1, "active": self.active, "specialists": items}).to_string()
    }
}

fn record(raw: &Value) -> Option<Specialist> {
    let map = raw.as_object()?;
    let id = map.get("id").and_then(Value::as_str)?;
    if !valid_id(id) {
        return None;
    }
    let name = map.get("name").and_then(Value::as_str)?;
    let instructions = map.get("instructions").and_then(Value::as_str)?;
    if !valid_name(name) || !valid_instructions(instructions) {
        return None;
    }
    let model = match map.get("model") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return None,
    };
    if model.as_deref().is_some_and(|m| !valid_profile_id(m)) {
        return None;
    }
    // #375 — the new fields are OPTIONAL: absent (or absent in an old record) is today's
    // behaviour. A hostile STORED value is dropped, never executed: the record survives, the
    // Space value becomes absent and the permission set degrades to the read-only default.
    // Unlike the mutations, stored duplicates collapse instead of refusing: a read never loses
    // a role that was valid when it was written.
    let space = match map.get("space") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if valid_space(s) => Some(s.trim().to_string()),
        _ => None,
    };
    let permissions = match map.get("permissions") {
        None | Some(Value::Null) => READ_ONLY.to_vec(),
        Some(Value::Array(items)) => {
            let mut out = Vec::new();
            for item in items {
                match item.as_str().and_then(Permission::parse) {
                    Some(p) if !out.contains(&p) => out.push(p),
                    Some(_) => {}
                    // One unrecognized or non-string element drops the WHOLE set to read-only:
                    // a hostile value can never smuggle in a partially parsed grant.
                    None => {
                        out.clear();
                        break;
                    }
                }
            }
            if out.is_empty() { READ_ONLY.to_vec() } else { canonical_permissions(&out) }
        }
        _ => READ_ONLY.to_vec(),
    };
    let spaces = match map.get("spaces") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut out = Vec::new();
            for item in items {
                // One unrecognized or hostile element drops the WHOLE stored list, exactly like
                // the permission set: a hostile value can never smuggle in a partial grant.
                match item.as_str().filter(|s| valid_space(s)) {
                    Some(s) => {
                        let name = s.trim().to_string();
                        if !out.contains(&name) {
                            out.push(name);
                        }
                    }
                    None => {
                        out.clear();
                        break;
                    }
                }
                // An over-cap STORED list is truncated, never fatal (a read never loses a role).
                if out.len() == MAX_SPACES {
                    break;
                }
            }
            out
        }
        _ => Vec::new(),
    };
    Some(Specialist {
        id: id.to_string(),
        name: name.trim().to_string(),
        instructions: instructions.trim().to_string(),
        model,
        space,
        spaces,
        permissions,
    })
}

// --- identity and text rules ---------------------------------------------------------------------

pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    if b.is_empty() || b.len() > ID_MAX_LEN {
        return false;
    }
    if !(b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) {
        return false;
    }
    if !b
        .iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'-' | b'_'))
    {
        return false;
    }
    !FORBIDDEN_IDS.contains(&id)
}

/// `allow_breaks`: instructions may keep `\n` and `\t` (a prompt section is multiline); every other
/// control in C0/C1 and DEL is refused, in the RAW text, before trimming — a character that `trim`
/// would swallow is still refused instead of silently disappearing on the way to the store.
fn has_control(text: &str, allow_breaks: bool) -> bool {
    text.chars()
        .any(|c| c.is_control() && !(allow_breaks && (c == '\n' || c == '\t')))
}

pub fn valid_name(name: &str) -> bool {
    if has_control(name, false) {
        return false;
    }
    let trimmed = name.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= MAX_NAME_CHARS
}

pub fn valid_instructions(text: &str) -> bool {
    if has_control(text, true) {
        return false;
    }
    let trimmed = text.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= MAX_INSTRUCTIONS_CHARS
}

/// #375 — a Space NAME is bounded plain text like the display name: every control in C0/C1 and
/// DEL is refused in the raw text, the trimmed value must be 1..80 characters. It is declarative
/// only: nothing resolves, applies or executes it.
pub fn valid_space(text: &str) -> bool {
    if has_control(text, false) {
        return false;
    }
    let trimmed = text.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= MAX_SPACE_CHARS
}

/// #375 — a permission set is never empty (read-only is the floor), always canonical, and a
/// mutation only ever accepts the closed vocabulary.
fn valid_permissions(permissions: &[Permission]) -> bool {
    !permissions.is_empty() && canonical_permissions(permissions) == permissions
}

/// #376 — an extra-Space list is bounded plain text throughout: every name passes `valid_space`,
/// the list carries no duplicates (first occurrence wins) and never exceeds MAX_SPACES. An EMPTY
/// list is valid: no extra Spaces, the default Space only (today's behaviour).
fn valid_spaces(spaces: &[String]) -> bool {
    spaces.len() <= MAX_SPACES && spaces.iter().all(|s| valid_space(s)) && canonical_spaces(spaces) == spaces
}

/// First-occurrence dedup, preserving input order: names carry no canonical order of their own.
fn canonical_spaces(spaces: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for s in spaces {
        if !out.contains(s) {
            out.push(s.clone());
        }
    }
    out
}

fn valid_model(model: &Option<String>) -> bool {
    model.as_deref().is_none_or(valid_profile_id)
}

// --- the closed command set ----------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    View,
    Create {
        id: String,
        name: String,
        instructions: String,
        model: Option<String>,
        space: Option<String>,
        spaces: Vec<String>,
        permissions: Vec<Permission>,
    },
    Update {
        id: String,
        name: String,
        instructions: String,
        model: Option<String>,
        space: Option<String>,
        spaces: Vec<String>,
        permissions: Vec<Permission>,
    },
    Delete {
        id: String,
    },
    /// `None` = go back to the principal.
    Select {
        id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandError;

/// Exactly `view` / `create` / `update` / `delete` / `select`. #375: create/update carry the new
/// fields OPTIONALLY, so today's exact five-key shape is accepted unchanged (absent = no Space and
/// the read-only default); six- and seven-key shapes add `space` and/or `permissions`. The id,
/// model and new-field SHAPES are checked here as well as in the mutations, so a malformed request
/// never reaches them.
pub fn parse_command(payload: &Value) -> Result<Command, CommandError> {
    if serde_json::to_vec(payload).map_or(true, |b| b.len() > MAX_PAYLOAD_BYTES) {
        return Err(CommandError);
    }
    let map = payload.as_object().ok_or(CommandError)?;
    let action = map.get("action").and_then(Value::as_str).ok_or(CommandError)?;
    match (action, map.len()) {
        ("view", 1) => Ok(Command::View),
        ("create", n) if (5..=8).contains(&n) => {
            if !known_draft_keys(map) { return Err(CommandError); }
            let (id, name, instructions, model, space, spaces, permissions) = draft_fields(map)?;
            Ok(Command::Create { id, name, instructions, model, space, spaces, permissions })
        }
        ("update", n) if (5..=8).contains(&n) => {
            if !known_draft_keys(map) { return Err(CommandError); }
            let (id, name, instructions, model, space, spaces, permissions) = draft_fields(map)?;
            Ok(Command::Update { id, name, instructions, model, space, spaces, permissions })
        }
        ("delete", 2) => {
            let id = map.get("id").and_then(Value::as_str).ok_or(CommandError)?;
            if !valid_id(id) {
                return Err(CommandError);
            }
            Ok(Command::Delete { id: id.to_string() })
        }
        ("select", 2) => match map.get("id") {
            Some(Value::Null) => Ok(Command::Select { id: None }),
            Some(Value::String(id)) if valid_id(id) => Ok(Command::Select { id: Some(id.clone()) }),
            _ => Err(CommandError),
        },
        _ => Err(CommandError),
    }
}

/// #375 — the OPTIONAL new fields: absent/null = no Space and the read-only default; an empty
/// Space string clears the name; anything hostile (controls, overlong, wrong type, a permission
/// outside the closed vocabulary, a duplicate) is refused, never silently kept.
fn draft_space(map: &serde_json::Map<String, Value>) -> Result<Option<String>, CommandError> {
    match map.get("space") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) if valid_space(s) => Ok(Some(s.trim().to_string())),
        Some(_) => Err(CommandError),
    }
}

fn draft_spaces(map: &serde_json::Map<String, Value>) -> Result<Vec<String>, CommandError> {
    match map.get("spaces") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => {
            if items.len() > MAX_SPACES {
                return Err(CommandError);
            }
            let mut out = Vec::new();
            for item in items {
                let s = item.as_str().ok_or(CommandError)?;
                if !valid_space(s) {
                    return Err(CommandError);
                }
                let name = s.trim().to_string();
                if out.contains(&name) {
                    return Err(CommandError);
                }
                out.push(name);
            }
            Ok(out)
        }
        Some(_) => Err(CommandError),
    }
}

fn draft_permissions(map: &serde_json::Map<String, Value>) -> Result<Vec<Permission>, CommandError> {
    match map.get("permissions") {
        None | Some(Value::Null) => Ok(READ_ONLY.to_vec()),
        Some(Value::Array(items)) => {
            let mut out = Vec::new();
            for item in items {
                let p = item.as_str().and_then(Permission::parse).ok_or(CommandError)?;
                if out.contains(&p) {
                    return Err(CommandError);
                }
                out.push(p);
            }
            Ok(if out.is_empty() { READ_ONLY.to_vec() } else { canonical_permissions(&out) })
        }
        Some(_) => Err(CommandError),
    }
}

type Draft = (String, String, String, Option<String>, Option<String>, Vec<String>, Vec<Permission>);

/// The optional #375 fields widen the accepted SHAPE, never the vocabulary: any key outside the
/// known set is refused, so `extra:1` can never ride in as a sixth field.
fn known_draft_keys(map: &serde_json::Map<String, Value>) -> bool {
    map.keys().all(|k| matches!(k.as_str(), "action" | "id" | "name" | "instructions" | "model" | "space" | "spaces" | "permissions"))
}

fn draft_fields(map: &serde_json::Map<String, Value>) -> Result<Draft, CommandError> {
    let id = map.get("id").and_then(Value::as_str).ok_or(CommandError)?;
    if !valid_id(id) {
        return Err(CommandError);
    }
    let name = map.get("name").and_then(Value::as_str).ok_or(CommandError)?;
    let instructions = map
        .get("instructions")
        .and_then(Value::as_str)
        .ok_or(CommandError)?;
    let model = match map.get("model") {
        Some(Value::Null) => None,
        Some(Value::String(m)) if valid_profile_id(m) => Some(m.clone()),
        _ => Err(CommandError)?,
    };
    Ok((id.to_string(), name.to_string(), instructions.to_string(), model, draft_space(map)?, draft_spaces(map)?, draft_permissions(map)?))
}

// --- mutations: pure, fail closed, never partially applied ---------------------------------------

/// Creating is NOT choosing: the new role is available from now on, the active one does not move.
pub fn create(store: &Store, s: Specialist) -> Result<Store, CommandError> {
    if !valid_id(&s.id) || store.find(&s.id).is_some() {
        return Err(CommandError);
    }
    if !valid_name(&s.name)
        || !valid_instructions(&s.instructions)
        || !valid_model(&s.model)
        || s.space.as_deref().is_some_and(|space| !valid_space(space))
        || !valid_spaces(&s.spaces)
        || !valid_permissions(&s.permissions)
    {
        return Err(CommandError);
    }
    if store.items.len() >= MAX_SPECIALISTS {
        return Err(CommandError);
    }
    let mut next = store.clone();
    next.items.push(Specialist {
        id: s.id,
        name: s.name.trim().to_string(),
        instructions: s.instructions.trim().to_string(),
        model: s.model,
        space: s.space,
        spaces: s.spaces,
        permissions: s.permissions,
    });
    Ok(next)
}

/// The id is the identity: a rename (or a new specialty, model, Space or permission set) never
/// moves it, and the role in use stays in use.
pub fn update(
    store: &Store,
    id: &str,
    name: &str,
    instructions: &str,
    model: Option<String>,
    space: Option<String>,
    spaces: Vec<String>,
    permissions: Vec<Permission>,
) -> Result<Store, CommandError> {
    if !valid_id(id) || store.find(id).is_none() {
        return Err(CommandError);
    }
    if !valid_name(name)
        || !valid_instructions(instructions)
        || !valid_model(&model)
        || space.as_deref().is_some_and(|s| !valid_space(s))
        || !valid_spaces(&spaces)
        || !valid_permissions(&permissions)
    {
        return Err(CommandError);
    }
    let mut next = store.clone();
    if let Some(s) = next.items.iter_mut().find(|s| s.id == id) {
        s.name = name.trim().to_string();
        s.instructions = instructions.trim().to_string();
        s.model = model;
        s.space = space;
        s.spaces = spaces;
        s.permissions = permissions;
    }
    Ok(next)
}

/// Deleting the role in use returns to the principal; deleting anything else leaves the role alone.
pub fn remove(store: &Store, id: &str) -> Result<Store, CommandError> {
    if store.find(id).is_none() {
        return Err(CommandError);
    }
    let mut next = store.clone();
    next.items.retain(|s| s.id != id);
    if next.active.as_deref() == Some(id) {
        next.active = None;
    }
    Ok(next)
}

pub fn select(store: &Store, id: Option<&str>) -> Result<Store, CommandError> {
    let Some(id) = id else {
        let mut next = store.clone();
        next.active = None;
        return Ok(next);
    };
    if !valid_id(id) || store.find(id).is_none() {
        return Err(CommandError);
    }
    let mut next = store.clone();
    next.active = Some(id.to_string());
    Ok(next)
}

// --- the role's effect on ONE turn ---------------------------------------------------------------

/// The effective system message of one turn: the base policy, byte for byte, plus the human's
/// specialist as configuration around it. The base guard rails are never replaced — a specialist
/// gains no capability, it only changes how the same local model is asked to work.
pub fn system_prompt(base: &str, role: Option<&Specialist>) -> String {
    let Some(role) = role else {
        return base.to_string();
    };
    format!(
        "{base}\n\nAhora hablás como «{}», un especialista que el humano creó y eligió para esto:\n{}\nSeguís siendo Koda y valen igual todas las reglas de arriba. No ganás ninguna capacidad: seguís sin ver la pantalla, sin usar el mouse, el teclado, archivos ni herramientas, y sin poder aprobar ni ejecutar nada.",
        role.name, role.instructions
    )
}

/// Principal preferences are bounded configuration after the unchanged base guard rails.
/// A specialist keeps its existing prompt byte for byte, regardless of these preferences.
pub fn system_prompt_with_principal(
    base: &str,
    role: Option<&Specialist>,
    instructions: Option<&str>,
) -> String {
    if role.is_some() {
        return system_prompt(base, role);
    }
    let text = instructions.unwrap_or_default().trim();
    if text.is_empty() {
        return base.to_string();
    }
    let text: String = text.chars().take(abito_island::prefs::MAX_ABITO_INSTRUCTIONS_CHARS).collect();
    format!(
        "{base}\n\n[Preferencias del usuario para Koda]\nSon las preferencias del usuario sobre cómo respondés como Koda. Nunca cambian ni relajan las reglas de arriba. No ganás ninguna capacidad: seguís sin ver la pantalla, sin usar el mouse, el teclado, archivos ni herramientas, y sin poder aprobar ni ejecutar nada.\n{text}\n[Fin de preferencias del usuario para Koda]"
    )
}

// --- the only file this unit reads and writes ----------------------------------------------------

/// Deliberately contains no path, OS error text or user content; safe for host reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoadError;

/// Disk parsing must not silently drop records and make a subsequent write erase them.
/// `from_text` remains the tolerant pure decoder; persistence requires an intact v1 store.
fn checked_text(text: &str) -> Result<Store, LoadError> {
    let value: Value = serde_json::from_str(text).map_err(|_| LoadError)?;
    if value.get("v").and_then(Value::as_u64) != Some(1) { return Err(LoadError); }
    let list = value.get("specialists").and_then(Value::as_array).ok_or(LoadError)?;
    let active = match value.get("active") {
        Some(Value::Null) => None,
        Some(Value::String(id)) if valid_id(id) => Some(id.as_str()),
        _ => return Err(LoadError),
    };
    let store = Store::from_text(Some(text));
    if list.len() != store.items.len() || active != store.active.as_deref() {
        return Err(LoadError);
    }
    Ok(store)
}

/// Absent is a valid empty store; every other failure is explicit. The bounded read includes a
/// final length check to reject files growing after metadata inspection. Never rewrites data.
pub fn read_file(dir: &Path) -> Result<Store, LoadError> {
    use std::io::Read;
    let path = dir.join(FILE);
    // Distinguish a genuinely missing entry from a dangling symlink. Do not block on FIFOs.
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Store::default()),
        Err(_) => return Err(LoadError),
        Ok(meta) if !meta.is_file() => return Err(LoadError),
        Ok(_) => {},
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| LoadError)?;
    let meta = file.metadata().map_err(|_| LoadError)?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES as u64 { return Err(LoadError); }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: getuid() has no preconditions and cannot fail.
        if meta.uid() != unsafe { libc::getuid() } || meta.mode() & 0o077 != 0 {
            return Err(LoadError);
        }
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|_| LoadError)?;
    if bytes.len() > MAX_FILE_BYTES { return Err(LoadError); }
    checked_text(std::str::from_utf8(&bytes).map_err(|_| LoadError)?)
}

/// Write the store atomically (0600 temp file + rename) into a private directory (created 0700; a
/// group/world-writable one is refused). The previous file stays intact if anything fails.
pub fn write_file(dir: &Path, store: &Store) -> Result<(), String> {
    let text = store.to_text();
    if text.len() > MAX_FILE_BYTES || checked_text(&text).as_ref() != Ok(store) {
        return Err("specialist store exceeds or violates the persisted format".into());
    }
    // A failed load is not authorization to replace the original data. The host also latches
    // startup failures, including when the invalid file subsequently disappears.
    read_file(dir).map_err(|_| "existing specialist store is unreadable".to_string())?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| e.to_string())?;
        let meta = std::fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
        if !meta.is_dir() || meta.permissions().mode() & 0o022 != 0 {
            return Err("config dir is not a private directory".into());
        }
        let tmp = dir.join(format!(".{FILE}.{}.tmp", std::process::id()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        let result = file
            .write_all(text.as_bytes())
            .and_then(|()| file.sync_all())
            .and_then(|()| std::fs::rename(&tmp, dir.join(FILE)));
        if let Err(e) = result {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!(".{FILE}.{}.tmp", std::process::id()));
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, dir.join(FILE)).map_err(|e| e.to_string())
    }
}

// --- the write path shared with the host ---------------------------------------------------------

/// Persist FIRST and commit to memory only if the file was really written: a failed write leaves
/// the previous roles (and the role in use) exactly as they were and reports it, so the panel can
/// never announce a specialist that was not saved. Nowhere to persist (the probe, or no config
/// dir) is a memory-only change that SAYS it was not saved.
pub fn commit(
    current: &std::sync::Mutex<Store>,
    persisted: &std::sync::atomic::AtomicBool,
    dir: Option<&Path>,
    next: Store,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    match dir {
        Some(dir) => match write_file(dir, &next) {
            Ok(()) => {
                *current.lock().expect("specialists lock") = next;
                persisted.store(true, Ordering::SeqCst);
                Ok(())
            }
            Err(e) => {
                persisted.store(false, Ordering::SeqCst);
                Err(e)
            }
        },
        None => {
            *current.lock().expect("specialists lock") = next;
            persisted.store(false, Ordering::SeqCst);
            Ok(())
        }
    }
}

#[cfg(test)]
#[path = "specialists_tests.rs"]
mod tests;

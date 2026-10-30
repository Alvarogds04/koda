//! Unit U2 — self-hosted model selection, pure (no I/O beyond the explicit
//! `read_*` helpers at the bottom, which only READ local files).
//!
//! Contract (docs/abito-features.md §4, `abito.models.v1` subset):
//! - the registry lists ONLY verified same-machine routes. Today exactly one
//!   is selectable: `http://127.0.0.1:11002` / `Abito-gpt` (parent inventory
//!   2026-10-08). Ports 11014 (identity unknown) and 11017 (did not answer)
//!   appear as disabled diagnostics from that inventory — they are never
//!   probed, scanned or selectable. No cloud route, no key field, no secret,
//! - "listed" is not "ready": the gate separates `ready` / `queue` (slot
//!   busy, a send waits) from `needs_load` (asleep, or listed but not
//!   loaded — Abito never loads, downloads or evicts), `unknown` (state
//!   unreadable — nothing is sent) and `unavailable` (router down / alias
//!   gone — never substituted),
//! - the resource line is what the machine reports (RAM from
//!   `/proc/meminfo`, GPU VRAM/GTT from the amdgpu sysfs counters); unknown
//!   stays unknown,
//! - a router-listed alias outside the registry is shown, never selectable.

use serde::Serialize;
use serde_json::{json, Value};

use crate::chat::ChatError;
use crate::chatlane::{gigabytes, ISLAND_MAX_OUTPUT_TOKENS};
use crate::localmodel::valid_alias;

/// At most this many router-listed models are shown.
pub const MAX_LISTED: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A verified local route the human may select.
    Selectable,
    /// Inventory diagnostic: shown disabled, never contacted.
    Diagnostic {
        state: &'static str,
        note: &'static str,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub profile_id: &'static str,
    pub revision: u64,
    pub origin: &'static str,
    pub alias: Option<&'static str>,
    pub role: &'static str,
    pub lane_id: &'static str,
    pub kind: Kind,
}

impl Entry {
    pub fn selectable(&self) -> bool {
        self.kind == Kind::Selectable && self.alias.is_some()
    }
}

/// The verified local inventory. Adding a route here is a reviewed code
/// change (its owner verified endpoint, alias and local-only execution).
pub const REGISTRY: &[Entry] = &[
    Entry {
        profile_id: "local-abito-gpt",
        revision: 1,
        origin: "http://127.0.0.1:11002",
        alias: Some("Abito-gpt"),
        role: "conversation",
        lane_id: "conversation",
        kind: Kind::Selectable,
    },
    Entry {
        profile_id: "diag-11014",
        revision: 1,
        origin: "http://127.0.0.1:11014",
        alias: None,
        role: "diagnostic",
        lane_id: "none",
        kind: Kind::Diagnostic {
            state: "unknown",
            note: "Responde 404 en la raíz; modelo y API sin identificar. No se consulta ni se puede elegir.",
        },
    },
    Entry {
        profile_id: "diag-11017",
        revision: 1,
        origin: "http://127.0.0.1:11017",
        alias: None,
        role: "diagnostic",
        lane_id: "none",
        kind: Kind::Diagnostic {
            state: "unavailable",
            note: "No respondió en el inventario. No se reintenta, no se arranca y no se puede elegir.",
        },
    },
];

pub fn valid_profile_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The selectable registry entry for `profile_id`, or `profile_missing`.
pub fn select<'a>(registry: &'a [Entry], profile_id: &str) -> Result<&'a Entry, ChatError> {
    if !valid_profile_id(profile_id) {
        return Err(ChatError::profile_missing());
    }
    registry
        .iter()
        .find(|e| e.profile_id == profile_id && e.selectable())
        .ok_or_else(ChatError::profile_missing)
}

// --- router metadata -------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Listed {
    pub id: String,
    pub size: Option<u64>,
    pub n_params: Option<u64>,
    pub n_ctx: Option<u64>,
    pub n_ctx_train: Option<u64>,
    pub ftype: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RouterMeta {
    pub reachable: bool,
    pub listed: Vec<Listed>,
    pub loaded_alias: Option<String>,
    pub sleeping: Option<bool>,
    pub busy: Option<bool>,
    pub slots_total: Option<u64>,
    pub n_ctx: Option<u64>,
    pub vision: Option<bool>,
}

impl RouterMeta {
    fn listed(&self, alias: &str) -> Option<&Listed> {
        self.listed.iter().find(|l| l.id == alias)
    }
}

/// Parse the four metadata reads (`None` = that read failed). An unreachable
/// router yields no facts at all — nothing is invented.
pub fn parse_router(
    health: Option<&Value>,
    models: Option<&Value>,
    props: Option<&Value>,
    slots: Option<&Value>,
) -> RouterMeta {
    let reachable =
        health.and_then(|h| h.get("status")).and_then(Value::as_str) == Some("ok");
    if !reachable {
        return RouterMeta::default();
    }
    let u = |v: &Value, p: &str| v.pointer(p).and_then(Value::as_u64);
    let listed: Vec<Listed> = models
        .and_then(|m| m.get("data"))
        .and_then(Value::as_array)
        .map(|data| {
            data.iter()
                .filter_map(|m| {
                    let id = m.get("id")?.as_str()?;
                    valid_alias(id).then(|| Listed {
                        id: id.to_string(),
                        size: u(m, "/meta/size"),
                        n_params: u(m, "/meta/n_params"),
                        n_ctx: u(m, "/meta/n_ctx"),
                        n_ctx_train: u(m, "/meta/n_ctx_train"),
                        ftype: m
                            .pointer("/meta/ftype")
                            .and_then(Value::as_str)
                            .filter(|s| s.len() <= 64)
                            .map(str::to_string),
                    })
                })
                .take(MAX_LISTED)
                .collect()
        })
        .unwrap_or_default();
    let loaded_alias = props
        .and_then(|p| p.get("model_alias"))
        .and_then(Value::as_str)
        .filter(|a| valid_alias(a))
        .map(str::to_string);
    let slot_list = slots.and_then(Value::as_array);
    let n_ctx = slot_list
        .and_then(|s| s.first())
        .and_then(|s| s.get("n_ctx"))
        .and_then(Value::as_u64)
        .or_else(|| {
            loaded_alias
                .as_deref()
                .and_then(|a| listed.iter().find(|l| l.id == a))
                .and_then(|l| l.n_ctx)
        });
    RouterMeta {
        reachable,
        loaded_alias,
        sleeping: props.and_then(|p| p.get("is_sleeping")).and_then(Value::as_bool),
        busy: slot_list.map(|s| {
            s.iter()
                .any(|slot| slot.get("is_processing").and_then(Value::as_bool) == Some(true))
        }),
        slots_total: props
            .and_then(|p| p.get("total_slots"))
            .and_then(Value::as_u64)
            .or_else(|| slot_list.map(|s| s.len() as u64)),
        n_ctx,
        vision: props
            .and_then(|p| p.pointer("/modalities/vision"))
            .and_then(Value::as_bool),
        listed,
    }
}

// --- resources ------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Gpu {
    pub vram_total: u64,
    pub vram_used: u64,
    pub gtt_total: u64,
    pub gtt_used: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Resources {
    pub mem_total: Option<u64>,
    pub mem_available: Option<u64>,
    pub gpu: Option<Gpu>,
}

/// `(MemTotal, MemAvailable)` in bytes from `/proc/meminfo` text.
pub fn parse_meminfo(text: &str) -> (Option<u64>, Option<u64>) {
    let field = |name: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(name))
            .and_then(|rest| rest.trim().strip_suffix("kB"))
            .and_then(|n| n.trim().parse::<u64>().ok())
            .map(|kb| kb * 1024)
    };
    (field("MemTotal:"), field("MemAvailable:"))
}

/// One sysfs counter (a decimal byte count).
pub fn parse_counter(text: &str) -> Option<u64> {
    text.trim().parse().ok()
}

pub fn resources_text(r: &Resources) -> String {
    let ram = match (r.mem_available, r.mem_total) {
        (Some(a), Some(t)) => format!("RAM disponible {} de {}", gigabytes(a), gigabytes(t)),
        _ => "RAM: desconocida".to_string(),
    };
    let gpu = match r.gpu {
        Some(g) => format!(
            "GPU: VRAM {}/{} · GTT {}/{}",
            gigabytes(g.vram_used).trim_end_matches(" GB"),
            gigabytes(g.vram_total),
            gigabytes(g.gtt_used).trim_end_matches(" GB"),
            gigabytes(g.gtt_total),
        ),
        None => "GPU: desconocida".to_string(),
    };
    format!("{ram} · {gpu}")
}

// --- the gate ----------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Gate {
    pub state: &'static str,
    pub message: String,
}

impl Gate {
    pub fn can_send(&self) -> bool {
        matches!(self.state, "ready" | "queue")
    }
}

fn load_cost(meta: &RouterMeta, alias: &str, res: &Resources) -> String {
    let size = meta
        .listed(alias)
        .and_then(|l| l.size)
        .map(|b| format!("~{} en memoria", gigabytes(b)))
        .unwrap_or_else(|| "un tamaño desconocido".to_string());
    let ram = res
        .mem_available
        .map(|a| format!(" (RAM disponible {})", gigabytes(a)))
        .unwrap_or_default();
    format!("usarlo exigiría cargar {size}{ram}")
}

/// Resource/queue gate for one selectable alias on its router.
pub fn gate(alias: &str, meta: &RouterMeta, res: &Resources) -> Gate {
    let g = |state, message: String| Gate { state, message };
    if !meta.reachable {
        return g(
            "unavailable",
            "El router local no responde: este modelo no está disponible. No se usa ningún otro modelo."
                .to_string(),
        );
    }
    let loaded = meta.loaded_alias.as_deref();
    if loaded != Some(alias) && meta.listed(alias).is_none() {
        return g(
            "unavailable",
            format!("{alias} no está en el router local. No se usa ningún otro modelo."),
        );
    }
    let Some(loaded) = loaded else {
        return g(
            "unknown",
            "No se pudo leer qué modelo está cargado: no se envía nada.".to_string(),
        );
    };
    if loaded != alias {
        return g(
            "needs_load",
            format!(
                "{alias} está listado pero no cargado: {}. Koda no carga, descarga ni desaloja modelos; el cargado es {loaded}.",
                load_cost(meta, alias, res)
            ),
        );
    }
    match meta.sleeping {
        Some(true) => {
            return g(
                "needs_load",
                format!(
                    "{alias} está dormido: {}. Koda no carga modelos; despertalo desde su servicio.",
                    load_cost(meta, alias, res)
                ),
            )
        }
        Some(false) => {}
        None => {
            return g(
                "unknown",
                "No se sabe si el modelo está despierto: no se envía nada.".to_string(),
            )
        }
    }
    let Some(ctx) = meta.n_ctx else {
        return g(
            "unknown",
            "No se conoce el contexto del modelo: no se envía nada.".to_string(),
        );
    };
    if meta.busy == Some(true) {
        let slots = meta.slots_total.unwrap_or(1);
        return g(
            "queue",
            format!("Cargado, atendiendo otro pedido: un mensaje espera en su cola ({slots} ranura/s, sin espera garantizada)."),
        );
    }
    g(
        "ready",
        format!("Cargado y libre · contexto {ctx} tokens."),
    )
}

// --- listing --------------------------------------------------------------------------

fn diag_gate(state: &'static str, note: &'static str) -> Gate {
    Gate {
        state,
        message: note.to_string(),
    }
}

/// The redacted metadata the WebView receives (`models.list_metadata`).
/// `metas` holds the router reads of SELECTABLE origins only.
pub fn listing(
    registry: &[Entry],
    metas: &[(String, RouterMeta)],
    res: &Resources,
    selected: Option<&str>,
    revision: u64,
) -> Value {
    let unreachable = RouterMeta::default();
    let meta_of = |origin: &str| {
        metas
            .iter()
            .find(|(o, _)| o == origin)
            .map(|(_, m)| m)
            .unwrap_or(&unreachable)
    };
    let mut profiles = Vec::new();
    for e in registry {
        match (e.kind, e.alias) {
            (Kind::Selectable, Some(alias)) => {
                let m = meta_of(e.origin);
                let l = m.listed(alias);
                let loaded = m.loaded_alias.as_deref() == Some(alias);
                profiles.push(json!({
                    "profile_id": e.profile_id,
                    "profile_revision": e.revision,
                    "origin": e.origin,
                    "alias": alias,
                    "role": e.role,
                    "selectable": true,
                    "gate": gate(alias, m, res),
                    "context_tokens": if loaded { m.n_ctx } else { l.and_then(|l| l.n_ctx) },
                    "context_train_tokens": l.and_then(|l| l.n_ctx_train),
                    "max_output_tokens": ISLAND_MAX_OUTPUT_TOKENS,
                    "size_bytes": l.and_then(|l| l.size),
                    "params": l.and_then(|l| l.n_params),
                    "quantization": l.and_then(|l| l.ftype.clone()),
                    "vision": if loaded { m.vision } else { None },
                    "slots_total": if loaded { m.slots_total } else { None },
                    "note": Value::Null,
                }));
                for other in m.listed.iter().filter(|l| {
                    !registry
                        .iter()
                        .any(|r| r.origin == e.origin && r.alias == Some(l.id.as_str()))
                }) {
                    profiles.push(json!({
                        "profile_id": Value::Null,
                        "origin": e.origin,
                        "alias": other.id,
                        "role": "unverified",
                        "selectable": false,
                        "gate": gate(&other.id, m, res),
                        "context_tokens": other.n_ctx,
                        "size_bytes": other.size,
                        "note": "Listado por el router pero no verificado para Koda: no se puede elegir.",
                    }));
                }
            }
            (Kind::Diagnostic { state, note }, _) => profiles.push(json!({
                "profile_id": e.profile_id,
                "origin": e.origin,
                "alias": Value::Null,
                "role": e.role,
                "selectable": false,
                "gate": diag_gate(state, note),
                "note": "Inventario del 2026-10-08, sin consultar.",
            })),
            _ => {}
        }
    }
    let selectable = registry.iter().filter(|e| e.selectable()).count();
    let choice_note = if selectable <= 1 {
        "Hoy hay un solo modelo local verificado: una sola opción no es una elección. Para elegir de verdad hace falta otro alias local verificado, o cargar otro modelo existente con autorización explícita."
    } else {
        "Elegí qué modelo local conversa con Koda. Se aplica desde el próximo mensaje."
    };
    json!({
        "revision": revision,
        "selected": selected,
        "profiles": profiles,
        "resources": res,
        "resources_text": resources_text(res),
        "choice_note": choice_note,
        "remote": "Sin nube y sin claves: sólo modelos de esta máquina.",
    })
}

// --- IPC -----------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelsCommand {
    /// Last listing (no network).
    List,
    /// Re-read metadata from the selectable local routers (no inference).
    Refresh,
    /// Select a registered profile for the conversation role.
    Select { profile_id: String },
}

pub fn parse_models_command(payload: &Value) -> Result<ModelsCommand, ChatError> {
    let bad = || ChatError::invalid_input("Pedido de modelos inválido.");
    if serde_json::to_vec(payload).map_or(true, |b| b.len() > 256) {
        return Err(bad());
    }
    let map = payload.as_object().ok_or_else(bad)?;
    let action = map.get("action").and_then(Value::as_str).ok_or_else(bad)?;
    match (action, map.len()) {
        ("list", 1) => Ok(ModelsCommand::List),
        ("refresh", 1) => Ok(ModelsCommand::Refresh),
        ("select", 2) => {
            let id = map
                .get("profile_id")
                .and_then(Value::as_str)
                .filter(|id| valid_profile_id(id))
                .ok_or_else(bad)?;
            Ok(ModelsCommand::Select {
                profile_id: id.to_string(),
            })
        }
        _ => Err(bad()),
    }
}

// --- persisted selection (the ONLY file this unit writes) ----------------------

/// `{"v":1,"selected":"<profile_id>"}`. Absent → the approved initial
/// profile; present but corrupt or naming an unknown profile → NO selection
/// (the chat says so; nothing is substituted).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Saved {
    Absent,
    Selected(String),
    Invalid,
}

pub fn parse_saved(bytes: Option<&[u8]>) -> Saved {
    let Some(bytes) = bytes else {
        return Saved::Absent;
    };
    let Ok(v) = serde_json::from_slice::<Value>(bytes) else {
        return Saved::Invalid;
    };
    let ok_shape = v.as_object().is_some_and(|m| m.len() == 2) && v.get("v") == Some(&json!(1));
    match v.get("selected").and_then(Value::as_str) {
        Some(id) if ok_shape && valid_profile_id(id) => Saved::Selected(id.to_string()),
        _ => Saved::Invalid,
    }
}

pub fn saved_bytes(profile_id: &str) -> Vec<u8> {
    json!({"v": 1, "selected": profile_id}).to_string().into_bytes()
}

/// Resolve the startup selection against the registry.
pub fn initial_selection(saved: &Saved) -> Option<&'static Entry> {
    match saved {
        Saved::Absent => select(REGISTRY, "local-abito-gpt").ok(),
        Saved::Selected(id) => select(REGISTRY, id).ok(),
        Saved::Invalid => None,
    }
}

/// The selection file name inside the app config dir (dir 0700, file 0600).
pub const SELECTION_FILE: &str = "models-selection.json";

/// Read the saved selection: `O_NOFOLLOW`, regular file, owned by us, no
/// group/world bits, ≤256 bytes — anything else is `Invalid` (fail closed).
#[cfg(unix)]
pub fn read_saved_file(dir: &std::path::Path) -> Saved {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let path = dir.join(SELECTION_FILE);
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path);
    let file = match file {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Saved::Absent,
        Err(_) => return Saved::Invalid,
    };
    let Ok(meta) = file.metadata() else {
        return Saved::Invalid;
    };
    // regular file, ours, not group/world accessible, small.
    // SAFETY: getuid() has no preconditions and cannot fail.
    if !meta.is_file()
        || meta.uid() != unsafe { libc::getuid() }
        || meta.mode() & 0o077 != 0
        || meta.len() > 256
    {
        return Saved::Invalid;
    }
    let mut bytes = Vec::new();
    if file.take(257).read_to_end(&mut bytes).is_err() {
        return Saved::Invalid;
    }
    parse_saved(Some(&bytes))
}

/// Write the selection atomically (0600 temp file + rename) into a private
/// directory (created 0700; a group/world-writable one is refused).
#[cfg(unix)]
pub fn write_saved_file(dir: &std::path::Path, profile_id: &str) -> Result<(), String> {
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
    let tmp = dir.join(format!(".{SELECTION_FILE}.{}.tmp", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    let result = file
        .write_all(&saved_bytes(profile_id))
        .and_then(|()| file.sync_all())
        .and_then(|()| std::fs::rename(&tmp, dir.join(SELECTION_FILE)));
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

// --- local reads (read-only, no network) -----------------------------------------

pub fn read_resources() -> Resources {
    let (mem_total, mem_available) = std::fs::read_to_string("/proc/meminfo")
        .map(|t| parse_meminfo(&t))
        .unwrap_or((None, None));
    Resources {
        mem_total,
        mem_available,
        gpu: read_gpu(),
    }
}

fn read_gpu() -> Option<Gpu> {
    let mut cards: Vec<_> = std::fs::read_dir("/sys/class/drm")
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("card") && n[4..].bytes().all(|b| b.is_ascii_digit()))
        .collect();
    cards.sort();
    cards.into_iter().find_map(|card| {
        let read = |f: &str| {
            std::fs::read_to_string(format!("/sys/class/drm/{card}/device/{f}"))
                .ok()
                .and_then(|t| parse_counter(&t))
        };
        Some(Gpu {
            vram_total: read("mem_info_vram_total")?,
            vram_used: read("mem_info_vram_used")?,
            gtt_total: read("mem_info_gtt_total")?,
            gtt_used: read("mem_info_gtt_used")?,
        })
    })
}

/// Metadata reads for one selectable origin (four bounded GETs, no
/// inference, never a diagnostic port).
pub fn read_router(origin: &str) -> RouterMeta {
    let Ok(endpoint) = crate::localmodel::LocalEndpoint::parse(origin) else {
        return RouterMeta::default();
    };
    let get = |p| crate::localmodel::get_json(&endpoint, p, crate::chatlane::PREFLIGHT_DEADLINE_MS);
    let health = get("/health");
    if health.is_none() {
        return RouterMeta::default();
    }
    parse_router(
        health.as_ref(),
        get("/v1/models").as_ref(),
        get("/props").as_ref(),
        get("/slots").as_ref(),
    )
}

/// Read every SELECTABLE registry origin once (deduplicated).
pub fn read_all(registry: &[Entry]) -> Vec<(String, RouterMeta)> {
    let mut out: Vec<(String, RouterMeta)> = Vec::new();
    for e in registry.iter().filter(|e| e.selectable()) {
        if !out.iter().any(|(o, _)| o == e.origin) {
            out.push((e.origin.to_string(), read_router(e.origin)));
        }
    }
    out
}

#[cfg(test)]
#[path = "models_tests.rs"]
mod tests;

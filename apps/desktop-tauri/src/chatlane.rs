//! Unit U1 — the chat lane: one conversation, one LOCAL model, one turn at a
//! time. Glue between the pure contract ([`crate::chat`]), the loopback
//! client ([`crate::localmodel`]) and the host (publish hook).
//!
//! Per turn, in order, with no hidden step:
//! 1. `submit` (native ids, duplicate client id → same turn, running turn →
//!    `queue_full`),
//! 2. preflight: four bounded metadata GETs on the SAME pinned endpoint
//!    (`/health`, `/props`, `/slots`, `/v1/models`) → [`assess`]. Router down
//!    → `local_model_unavailable`; model asleep (a send would make the router
//!    load ~18 GB) → `resource_authorization_required`, nothing is loaded;
//!    another alias loaded → unavailable, never substituted,
//! 3. bounded prompt against the model's REAL context (visible trimming),
//! 4. exactly one streamed `POST /v1/chat/completions`; no retry, no
//!    fallback — a failure ends the turn with a safe error.
//!
//! There is no Pi chat producer on the desktop: this lane is the local-model
//! conversation only. The Pi adapter remains a marked future dependency.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::chat::{ChatError, Conversation, Event, FinishReason, ProfileRef};
use crate::conversations::{Store, Summary, SpecialistRef, PAGE_SIZE};
use crate::localmodel::{self, Cancel, Deadlines, Ended, Finish, LocalEndpoint, StreamItem};

/// Output cap for one island answer (bounded; the profile may lower it).
pub const ISLAND_MAX_OUTPUT_TOKENS: usize = 1024;

/// The one verified local route today (parent inventory 2026-10-08):
/// llama.cpp router on loopback, alias `Abito-gpt`. U2's picker selects
/// among verified local profiles; nothing here can name a remote one.
pub const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:11002";
pub const DEFAULT_ALIAS: &str = "Abito-gpt";

pub enum TargetSelection { Local(Target), Cloud(crate::cloudmodel::CloudTarget) }
pub fn default_selection() -> TargetSelection { TargetSelection::Local(default_target()) }
#[allow(clippy::too_many_arguments)]
pub fn run_selected(lane: &SharedLane, turn_id: &str, target: &TargetSelection, source: &dyn crate::cloudmodel::CredentialSource, system: &str, deadlines: Deadlines, publish: &(dyn Fn() + Send + Sync)) {
    match target {
        TargetSelection::Local(local) => run_turn(lane, turn_id, local, system, deadlines, publish),
        TargetSelection::Cloud(cloud) => crate::cloudmodel::run_turn(lane, turn_id, cloud, source, system, deadlines, publish),
    }
}

/// The default local target (`local-abito-gpt`, revision 1).
pub fn default_target() -> Target {
    Target {
        endpoint: LocalEndpoint::parse(DEFAULT_ENDPOINT).expect("default endpoint is loopback"),
        alias: DEFAULT_ALIAS.to_string(),
        profile: ProfileRef {
            profile_id: "local-abito-gpt".to_string(),
            revision: 1,
            lane_id: "conversation".to_string(),
        },
        max_output: ISLAND_MAX_OUTPUT_TOKENS,
    }
}
/// Metadata preflight deadline per GET.
pub const PREFLIGHT_DEADLINE_MS: u64 = 1_500;

/// The system message: who Koda is here and, honestly, what it cannot do.
pub const SYSTEM_PROMPT: &str = "Te llamas Koda y eres el asistente de la app Koda, \
una isla que vive en la parte superior del escritorio. \
Responde en español neutro, breve y en texto plano (sin Markdown). \
Funcionas con un modelo local de esta máquina. \
Conoces todo lo que trae la app Koda para poder explicar dónde está cada cosa: \
el chat (este), los especialistas que se eligen en el chat, \
el dictado con su atajo de teclado (transcribe tu voz en local), \
los comandos de voz con «OK Koda» (música, abrir apps, buscar en la web, preguntarte), \
las respuestas habladas, la música de Spotify, \
las integraciones con GitHub, Vercel, Stripe, n8n, Resend, Notion y Cal.com (píldoras en la isla con su tarjeta), \
el correo (bandeja IMAP, responder y enviar), el enlace con el teléfono, \
el personaje de escritorio, los avisos y preguntas de los agentes Pi, Claude Code y Codex, \
el resumen semanal, los sonidos de la isla y la ventana de Ajustes, donde se configura todo. \
Si en Ajustes se activa, recibes como contexto la ventana activa (app, título y dirección). \
Si en Ajustes está activo el contexto en vivo (lo está de fábrica), cada mensaje del usuario trae al final de estas instrucciones \
un resumen del estado en vivo de la app, solo de lectura: agentes de código (proyecto, estado, preguntas pendientes, qué terminó) \
e integraciones conectadas (GitHub, Vercel, n8n, Resend, Stripe, Notion, Cal.com, correo). \
Úsalo para decirle qué le toca hacer ahora. Si no hay resumen, no sabes qué está pasando: dilo, no lo inventes. \
No ves la pantalla, no puedes usar el mouse, el teclado, archivos ni herramientas, \
y no puedes aprobar ni ejecutar nada: si te piden una acción, explica en qué parte de \
la app se hace y que desde este chat no puedes hacerla.";

/// Cloud-only identity replacement; the local system prompt above remains byte-identical.
pub const CLOUD_MODEL_PROMPT: &str = "Funcionas con el proveedor de nube elegido en Koda. ";

/// S1 (#503): the turn's effective system message plus the live-state snapshot. Disabled, or with
/// nothing to say, the system message is returned byte-identical.
pub fn with_live_context(system: &str, enabled: bool, snapshot: Option<&crate::chatsnapshot::Snapshot>) -> String {
    match snapshot.filter(|_| enabled) {
        Some(s) => format!("{system}\n\n{}", s.text),
        None => system.to_string(),
    }
}

/// Spanish decimal gigabytes with one decimal (`18,2 GB`).
pub fn gigabytes(bytes: u64) -> String {
    let tenths = (bytes as f64 / 1e8).round() as u64;
    format!("{},{} GB", tenths / 10, tenths % 10)
}

/// What the preflight established for one send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ready {
    pub context_limit: usize,
    pub busy: bool,
    pub size_bytes: Option<u64>,
    /// #343: the router's own `/modalities/vision` (same source the model
    /// picker chips use). `Some(true)` is the ONLY value that lets an image
    /// attachment reach the request; anything else refuses with a safe error.
    pub vision: Option<bool>,
}

fn model_entry<'a>(models: Option<&'a Value>, alias: &str) -> Option<&'a Value> {
    models?
        .get("data")?
        .as_array()?
        .iter()
        .find(|m| m.get("id").and_then(Value::as_str) == Some(alias))
}

/// Pure preflight decision over the four metadata answers (`None` = the
/// read failed). Unknown never means "probably fine": it refuses.
pub fn assess(
    alias: &str,
    health: Option<&Value>,
    props: Option<&Value>,
    slots: Option<&Value>,
    models: Option<&Value>,
) -> Result<Ready, ChatError> {
    if health.and_then(|h| h.get("status")).and_then(Value::as_str) != Some("ok") {
        return Err(ChatError::local_model_unavailable());
    }
    let entry = model_entry(models, alias);
    let size_bytes = entry
        .and_then(|m| m.pointer("/meta/size"))
        .and_then(Value::as_u64);
    let Some(props) = props else {
        return Err(ChatError::resource_authorization_required(
            "No se pudo leer el estado del modelo local; no se envió nada.",
        ));
    };
    if props.get("model_alias").and_then(Value::as_str) != Some(alias) {
        return Err(ChatError::local_model_unavailable());
    }
    match props.get("is_sleeping").and_then(Value::as_bool) {
        Some(false) => {}
        Some(true) => {
            let size = size_bytes
                .map(|b| format!(" (~{} en memoria)", gigabytes(b)))
                .unwrap_or_default();
            return Err(ChatError::resource_authorization_required(&format!(
                "El modelo local está dormido: enviar lo cargaría{size}. No se cargó nada; despertalo vos desde su servicio si querés usarlo."
            )));
        }
        None => {
            return Err(ChatError::resource_authorization_required(
                "No se sabe si el modelo local está cargado; no se envió nada.",
            ))
        }
    }
    let slot_list = slots.and_then(Value::as_array);
    let slot_ctx = slot_list
        .and_then(|s| s.first())
        .and_then(|s| s.get("n_ctx"))
        .and_then(Value::as_u64);
    let model_ctx = entry
        .and_then(|m| m.pointer("/meta/n_ctx"))
        .and_then(Value::as_u64);
    let Some(context_limit) = slot_ctx.or(model_ctx) else {
        return Err(ChatError::resource_authorization_required(
            "No se conoce el contexto del modelo local; no se envió nada.",
        ));
    };
    let busy = slot_list.is_some_and(|s| {
        s.iter()
            .any(|slot| slot.get("is_processing").and_then(Value::as_bool) == Some(true))
    });
    Ok(Ready {
        context_limit: context_limit as usize,
        busy,
        size_bytes,
        vision: props.pointer("/modalities/vision").and_then(Value::as_bool),
    })
}

/// The selected local target a turn is frozen to.
#[derive(Debug, Clone)]
pub struct Target {
    pub endpoint: LocalEndpoint,
    pub alias: String,
    pub profile: ProfileRef,
    pub max_output: usize,
}

/// Read the four metadata routes from the target (bounded, no inference).
pub fn preflight(target: &Target) -> Result<Ready, ChatError> {
    let get = |path| localmodel::get_json(&target.endpoint, path, PREFLIGHT_DEADLINE_MS);
    let health = get("/health");
    if health.is_none() {
        return Err(ChatError::local_model_unavailable());
    }
    let props = get("/props");
    let slots = get("/slots");
    let models = get("/v1/models");
    assess(
        &target.alias,
        health.as_ref(),
        props.as_ref(),
        slots.as_ref(),
        models.as_ref(),
    )
}

/// What the chat may say about the local model BEFORE anyone sends:
/// `unchecked` (never read), `ready`, `busy` (a send waits in its queue),
/// `unavailable` (router down / alias gone — Send disabled, nothing else is
/// tried), `blocked` (asleep or unknown state — Send disabled, nothing is
/// loaded).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Availability {
    pub state: &'static str,
    pub message: String,
}

impl Availability {
    pub fn unchecked() -> Self {
        Availability {
            state: "unchecked",
            message: "Todavía no se comprobó el modelo local.".to_string(),
        }
    }
    pub fn can_send(&self) -> bool {
        matches!(self.state, "ready" | "busy")
    }
}

/// Pure mapping from a preflight result to what the chat shows.
pub fn availability_of(result: &Result<Ready, ChatError>) -> Availability {
    match result {
        Ok(r) if r.busy => Availability {
            state: "busy",
            message: "Modelo local listo, atendiendo otro pedido: tu mensaje esperaría en su cola."
                .to_string(),
        },
        Ok(_) => Availability {
            state: "ready",
            message: "Modelo local listo.".to_string(),
        },
        Err(e) if e.code == "local_model_unavailable" => Availability {
            state: "unavailable",
            message: e.safe_message.clone(),
        },
        Err(e) => Availability {
            state: "blocked",
            message: e.safe_message.clone(),
        },
    }
}

/// Mutable lane state behind one mutex.
#[derive(Debug)]
pub struct Lane {
    pub convo: Conversation,
    pub(crate) cancel: Option<(String, Arc<Cancel>)>,
    /// Last preflight shown to the human (`busy` → "en cola").
    pub queue_note: Option<String>,
    /// Last availability read (metadata only).
    pub availability: Availability,
    history: Option<Store>,
    summary: Option<Summary>,
    restored_page: Vec<crate::chat::Turn>,
    history_before: Option<u64>,
    history_skipped: usize,
    history_problem: Option<String>,
    role_notice: Option<String>,
}

pub type SharedLane = Arc<Mutex<Lane>>;

impl Lane {
    pub fn new(conversation_id: &str) -> SharedLane {
        Arc::new(Mutex::new(Lane {
            convo: Conversation::new(conversation_id),
            cancel: None,
            queue_note: None,
            availability: Availability::unchecked(),
            history: None, summary: None, restored_page: Vec::new(), history_before: None, history_skipped: 0, history_problem: None, role_notice: None,
        }))
    }

    pub fn init_history(&mut self, dir: &std::path::Path) -> Result<(), ChatError> {
        match Store::open(dir) {
            Ok(store) => { self.history = Some(store); Ok(()) },
            Err(_) => { self.history_problem = Some("No se pudo abrir el historial privado; los mensajes de esta sesión no se guardarán.".into()); Err(history_error()) }
        }
    }
    pub fn new_conversation(&mut self, specialist: Option<SpecialistRef>, now: u64) -> Result<Value, ChatError> {
        if self.convo.active().is_some() { return Err(ChatError::queue_full()); }
        // In probe/no-store mode the previous in-memory chat remains usable, never real-user I/O.
        let summary = match &mut self.history {
            Some(store) => Some(store.create(specialist, now).map_err(|_| history_error())?),
            None if self.history_problem.is_some() => return Err(history_error()),
            None => None,
        };
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let id = summary.as_ref().map(|s| s.id.clone()).unwrap_or_else(|| format!("c-memory-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        self.convo = Conversation::new(&id); self.summary = summary;
        self.restored_page.clear(); self.role_notice = None;
        self.history_before = None; self.history_skipped = 0; self.queue_note = None; self.cancel = None;
        Ok(self.view())
    }
    pub fn conversation_summary(&self, id: &str) -> Result<Summary, ChatError> {
        if self.convo.active().is_some() { return Err(ChatError::queue_full()); }
        self.history.as_ref().ok_or_else(history_error)?.summary(id).map_err(|_| history_error())
    }
    pub fn prepare_conversation(&self, id: &str) -> Result<(Summary, crate::conversations::Page), ChatError> {
        let summary = self.conversation_summary(id)?;
        let page = self.history.as_ref().unwrap().page(id, None, PAGE_SIZE).map_err(|_| history_error())?;
        Ok((summary, page))
    }
    pub fn activate_conversation(&mut self, summary: Summary, page: crate::conversations::Page) {
        self.restored_page = page.turns.clone();
        self.convo = Conversation::restore(&summary.id, page.turns);
        self.summary = Some(summary); self.history_before = page.before; self.history_skipped = page.skipped;
        self.queue_note = None; self.cancel = None; self.role_notice = None;
    }
    pub fn restore_conversation(&mut self, id: &str) -> Result<Summary, ChatError> {
        let (summary, page) = self.prepare_conversation(id)?;
        self.activate_conversation(summary.clone(), page);
        Ok(summary)
    }
    pub fn history_page(&self, id: &str, before: Option<u64>) -> Result<Value, ChatError> {
        let page = self.history.as_ref().ok_or_else(history_error)?.page(id, before, PAGE_SIZE).map_err(|_| history_error())?;
        let projection = Conversation::project_history(id, page.turns);
        Ok(json!({"conversation_id":id,"turns":projection["turns"],"before":page.before,"skipped":page.skipped}))
    }
    pub fn list_conversations(&self) -> Result<Value, ChatError> {
        match &self.history {
            Some(store) => { let (items, skipped) = store.list().map_err(|_| history_error())?; Ok(json!({"conversations":items,"skipped":skipped})) },
            None if self.history_problem.is_some() => Err(history_error()),
            None => Ok(json!({"conversations":[],"skipped":0})),
        }
    }
    pub fn submit(&mut self, text: &str, client: &str, profile: &ProfileRef, specialist: Option<SpecialistRef>, now: u64) -> Result<crate::chat::Accepted, ChatError> {
        self.submit_with_attachments(text, client, profile, specialist, now, Vec::new())
    }

    /// #343 — [`submit`] with attachment metadata already resolved from the
    /// uploads directory (chathost does the resolution; the page only sends
    /// ids). The same refusals apply; attachments never change ids or the
    /// duplicate rule, and the cap is re-checked here as defense in depth.
    pub fn submit_with_attachments(&mut self, text: &str, client: &str, profile: &ProfileRef, specialist: Option<SpecialistRef>, now: u64, attachments: Vec<crate::chat::Attachment>) -> Result<crate::chat::Accepted, ChatError> {
        if let Some(accepted) = self.convo.lookup(client) { return Ok(accepted); }
        // Refused input never creates a file, advances IDs or changes the visible context.
        if !crate::chat::valid_client_request_id(client) { return Err(ChatError::invalid_input("Identificador de envío inválido.")); }
        if self.convo.active().is_some() { return Err(ChatError::queue_full()); }
        crate::chat::validate_text(text)?;
        if attachments.len() > crate::chat::MAX_ATTACHMENTS_PER_TURN {
            return Err(ChatError::invalid_input("Son demasiados archivos adjuntos: hasta 5 por mensaje."));
        }
        if self.history.is_some() && self.summary.is_none() { self.new_conversation(specialist, now)?; }
        let accepted = self.convo.submit_with_attachments(text, client, profile, attachments)?;
        self.persist_turn(&accepted.turn_id, now);
        Ok(accepted)
    }
    pub fn persist_turn(&mut self, turn_id: &str, now: u64) {
        let Some(turn) = self.convo.turn(turn_id) else { return; };
        let Some(store) = &mut self.history else { return; };
        if store.append(self.convo.id(), turn, now).is_err() {
            self.history_problem = Some("No se pudo guardar todo el historial; conservá una copia de los mensajes de esta sesión.".into());
        }
    }
    pub fn history_notice(&mut self, text: &str) { self.role_notice = Some(text.into()); }
    pub fn history_failure(&mut self, text: &str) { self.history_problem = Some(text.into()); }

    pub fn view(&self) -> Value {
        let mut v = self.convo.view();
        if !self.restored_page.is_empty() {
            let page = Conversation::project_history(self.convo.id(), self.restored_page.clone());
            let mut turns = std::collections::BTreeMap::new();
            for t in page["turns"].as_array().unwrap().iter().chain(v["turns"].as_array().unwrap()) {
                if let Some(n) = t["turn_id"].as_str().and_then(|id| id.strip_prefix("t-")?.parse::<u64>().ok()) { turns.insert(n, t.clone()); }
            }
            v["turns"] = json!(turns.into_values().collect::<Vec<_>>());
        }
        v["queue_note"] = json!(self.queue_note);
        v["availability"] = json!(self.availability);
        v["history_before"] = json!(self.history_before);
        v["history_skipped"] = json!(self.history_skipped);
        v["history_problem"] = json!(self.history_problem.as_ref().or(self.role_notice.as_ref()));
        v["history_persisted"] = json!(self.history.is_some());
        v["conversation_specialist"] = json!(self.summary.as_ref().and_then(|s| s.specialist.as_ref()));
        v
    }
}

fn history_error() -> ChatError {
    ChatError { code: "history_unavailable".into(), safe_message: "No se pudo leer o guardar el historial de conversaciones.".into(), retryable: false }
}
pub fn history_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Read availability (metadata only) and store it. Never sends a prompt.
pub fn check(lane: &SharedLane, target: &Target) -> Availability {
    let a = availability_of(&preflight(target));
    lane.lock().expect("chat lane lock").availability = a.clone();
    a
}

/// Request cancellation of the running turn: terminal at once (later deltas
/// discarded), socket shut down best-effort. Already-consumed compute cannot
/// be reclaimed — the UI says so.
pub fn cancel(lane: &SharedLane, turn_id: &str) -> bool {
    let mut l = lane.lock().expect("chat lane lock");
    let done = l.convo.cancel(turn_id);
    if let Some((id, handle)) = &l.cancel {
        if id == turn_id {
            handle.cancel();
        }
    }
    if done {
        l.queue_note = None;
        l.persist_turn(turn_id, history_now());
    }
    done
}

/// Run one accepted turn to its end on the CURRENT thread (callers spawn a
/// thread). `system` is the effective system message of THIS turn — the base
/// policy plus the specialist the human chose when there is one — already
/// frozen by the caller at submit; `publish` is called after every visible
/// change.
pub fn run_turn(
    lane: &SharedLane,
    turn_id: &str,
    target: &Target,
    system: &str,
    deadlines: Deadlines,
    publish: &(dyn Fn() + Send + Sync),
) {
    let conversation_id = lane.lock().expect("chat lane lock").convo.id().to_owned();
    run_turn_scoped_uploads(lane, &conversation_id, turn_id, target, system, deadlines, publish, None);
}

/// Frozen conversation identity prevents a cancelled worker from touching a new conversation's t-1.
#[allow(clippy::too_many_arguments)]
pub fn run_turn_scoped(
    lane: &SharedLane, conversation_id: &str, turn_id: &str, target: &Target,
    system: &str, deadlines: Deadlines, publish: &(dyn Fn() + Send + Sync),
) {
    run_turn_scoped_uploads(lane, conversation_id, turn_id, target, system, deadlines, publish, None);
}

/// #343 — [`run_turn_scoped`] with the island's uploads directory: image
/// attachments need a model with the vision modality (a refusal is a safe
/// error turn, never a silent drop) and both text and image contents are
/// read back from the uploads directory once per prompt. `None` (no island)
/// resolves every attachment to an honest "no disponible" note.
#[allow(clippy::too_many_arguments)]
pub fn run_turn_scoped_uploads(
    lane: &SharedLane, conversation_id: &str, turn_id: &str, target: &Target,
    system: &str, deadlines: Deadlines, publish: &(dyn Fn() + Send + Sync),
    uploads_dir: Option<&std::path::Path>,
) {
    let handle = Arc::new(Cancel::new());
    {
        let mut l = lane.lock().expect("chat lane lock");
        if l.convo.id() != conversation_id || l.convo.turn(turn_id).is_none_or(|t| t.state.is_terminal()) { return; }
        l.cancel = Some((turn_id.to_string(), Arc::clone(&handle)));
    }
    let apply = |event: Event| -> bool {
        let mut l = lane.lock().expect("chat lane lock");
        if l.convo.id() != conversation_id { return false; }
        let Some(seq) = l.convo.turn(turn_id).map(|t| t.seq + 1) else {
            return false;
        };
        let applied = l.convo.apply(turn_id, seq, event);
        let truncated = matches!(applied, Ok(crate::chat::Applied::Truncated));
        let terminal = l
            .convo
            .turn(turn_id)
            .is_none_or(|t| t.state.is_terminal());
        if terminal {
            l.queue_note = None;
            if applied.is_ok() { l.persist_turn(turn_id, history_now()); }
        }
        drop(l);
        publish();
        if truncated {
            handle.cancel(); // limit reached: stop reading, never re-request
        }
        !terminal
    };

    // 1. thinking: preflight + prompt processing
    if !apply(Event::Thinking) {
        return;
    }
    let checked = preflight(target);
    {
        let mut l = lane.lock().expect("chat lane lock");
        if l.convo.id() != conversation_id { return; }
        l.availability = availability_of(&checked);
    }
    let ready = match checked {
        Ok(r) => r,
        Err(e) => {
            apply(Event::Error(e));
            return;
        }
    };
    {
        let mut l = lane.lock().expect("chat lane lock");
        if l.convo.id() != conversation_id { return; }
        l.queue_note = ready.busy.then(|| {
            "El modelo local está atendiendo otro pedido: tu mensaje espera en su cola.".to_string()
        });
    }
    publish();
    // #343: the submitted turn's image attachments need a model that can
    // actually read them. The preflight's /modalities/vision is the only
    // source; anything else refuses BEFORE building the prompt.
    let wants_vision = {
        let l = lane.lock().expect("chat lane lock");
        if l.convo.id() != conversation_id { return; }
        l.convo.turn(turn_id).is_some_and(|t| t.attachments.iter().any(|a| a.mime.starts_with("image/")))
    };
    if wants_vision && ready.vision != Some(true) {
        apply(Event::Error(crate::chat::ChatError::vision_unsupported()));
        return;
    }
    // Resolve attachment contents once per id (bounded reads INSIDE the
    // uploads directory only; missing files become honest notes in the text).
    let mut contents: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Some(dir) = uploads_dir {
        let attachments: Vec<crate::chat::Attachment> = {
            let l = lane.lock().expect("chat lane lock");
            if l.convo.id() != conversation_id { return; }
            l.convo.attachments()
        };
        for a in attachments {
            if contents.contains_key(&a.id) { continue; }
            let resolved = if a.mime == "text/plain" {
                crate::uploads::stored_text(dir, &a)
            } else if a.mime.starts_with("image/") && ready.vision == Some(true) {
                crate::uploads::stored_data_url(dir, &a)
            } else {
                None
            };
            if let Some(content) = resolved { contents.insert(a.id.clone(), content); }
        }
    }
    let resolve = |a: &crate::chat::Attachment| contents.get(&a.id).cloned();
    let prompt = {
        let mut l = lane.lock().expect("chat lane lock");
        if l.convo.id() != conversation_id { return; }
        l.convo.prompt_for_resolved(
            turn_id,
            system,
            ready.context_limit,
            target.max_output,
            &resolve,
        )
    };
    let prompt = match prompt {
        Ok(p) => p,
        Err(e) => {
            apply(Event::Error(e));
            return;
        }
    };
    if handle.is_cancelled() {
        return;
    }

    // 2. exactly one streamed request
    let mut on_item = |item: &StreamItem| {
        if let StreamItem::Content(text) = item {
            let mut l = lane.lock().expect("chat lane lock");
            if l.convo.id() != conversation_id { return; }
            l.queue_note = None;
            drop(l);
            apply(Event::Delta(text.clone()));
        }
    };
    let ended = localmodel::stream_chat(
        &target.endpoint,
        &target.alias,
        &prompt.messages,
        target.max_output,
        deadlines,
        &handle,
        &mut on_item,
    );
    match ended {
        Ended::Finished(Finish::Stop) => {
            apply(Event::Complete(FinishReason::Stop));
        }
        Ended::Finished(Finish::Length) => {
            apply(Event::Complete(FinishReason::Limit));
        }
        Ended::Cancelled => {
            // cancel() already made the turn terminal; a truncation cancel
            // completed it with `limit`. Nothing else to record.
            publish();
        }
        Ended::Failed(e) => {
            if e.code == "local_model_unavailable" {
                let mut l = lane.lock().expect("chat lane lock");
                if l.convo.id() == conversation_id { l.availability = availability_of(&Err(e.clone())); }
            }
            apply(Event::Error(e));
        }
    }
    let mut l = lane.lock().expect("chat lane lock");
    if l.convo.id() == conversation_id && l.cancel.as_ref().is_some_and(|(id, _)| id == turn_id) {
        l.cancel = None;
    }
}

#[cfg(test)]
#[path = "chatlane_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "chat_history_tests.rs"]
mod history_tests;

//! K2-05 U5a — the direct Rust chat lane is GONE. The island chat talks to the
//! daemon engine (`chathost` → `chatclient`): one continuous chat, no
//! conversation list, no local/cloud send path in Rust.
//!
//! What is left here is only the shared vocabulary that the local-model
//! registry (`models`) and the manual specialists (`specialists`) still
//! compile against; both leave in U5b/U5d (K2-05 L59). Nothing in this module
//! sends, streams, cancels, prompts or stores a turn.

use std::sync::{Arc, Mutex};

use crate::chat::ProfileRef;
use crate::localmodel::LocalEndpoint;

/// Output cap for one island answer (bounded; the profile may lower it).
/// Kept for specialists/models until U5b/U5d (K2-05 L59).
pub const ISLAND_MAX_OUTPUT_TOKENS: usize = 1024;

/// Metadata preflight deadline per GET, still used by the local registry's
/// read-only router reads. Kept for specialists/models until U5b/U5d (K2-05 L59).
pub const PREFLIGHT_DEADLINE_MS: u64 = 1_500;

/// The system message: who Koda is here and, honestly, what it cannot do.
/// Kept for specialists/models until U5b/U5d (K2-05 L59).
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
/// Kept for specialists/models until U5b/U5d (K2-05 L59).
pub const CLOUD_MODEL_PROMPT: &str = "Funcionas con el proveedor de nube elegido en Koda. ";

/// Spanish decimal gigabytes with one decimal (`18,2 GB`).
/// Kept for specialists/models until U5b/U5d (K2-05 L59).
pub fn gigabytes(bytes: u64) -> String {
    let tenths = (bytes as f64 / 1e8).round() as u64;
    format!("{},{} GB", tenths / 10, tenths % 10)
}

/// The local target a turn used to be frozen to.
/// Kept for specialists/models until U5b/U5d (K2-05 L59).
#[derive(Debug, Clone)]
pub struct Target {
    pub endpoint: LocalEndpoint,
    pub alias: String,
    pub profile: ProfileRef,
    pub max_output: usize,
}

/// What the chat may say about the local model BEFORE anyone sends.
/// Kept for specialists/models until U5b/U5d (K2-05 L59): the models panel resets
/// it when the selection changes and the probe reads it back.
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

/// The island's chat lane state. U5a emptied it: the chat's turns live in the
/// daemon engine, so only the last availability read survives.
/// Kept for specialists/models until U5b/U5d (K2-05 L59).
#[derive(Debug)]
pub struct Lane {
    /// Last availability read (metadata only).
    pub availability: Availability,
}

pub type SharedLane = Arc<Mutex<Lane>>;

impl Lane {
    pub fn new(_conversation_id: &str) -> SharedLane {
        Arc::new(Mutex::new(Lane {
            availability: Availability::unchecked(),
        }))
    }
}

#[cfg(test)]
#[path = "chatlane_tests.rs"]
mod tests;

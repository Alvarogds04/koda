//! Voice commands: a pure parser (Spanish and English) from a transcript to an
//! intent, and a pure planner from an intent plus the current state to a closed set
//! of effects. Nothing here touches a device, the network or Tauri.
//!
//! Adapted from Coucou NotchBuddy Voice/{IntentParser,VoiceIntent,EntityResolver,
//! VoiceQuery,VoiceActionRunner}.swift @71b773f, Copyright (c) 2026 Louis Raillé, MIT.
//! The French tables are replaced by Spanish ones; the English ones are kept.

use crate::prefs::{pill_offered, MAIN_PILLS, PILL_IDS};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Es,
    En,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Topic {
    Stripe,
    Github,
    Vercel,
    Resend,
    N8n,
    Notion,
    Calcom,
    Agents,
    ClaudePlan,
    CodexPlan,
    Music,
    Pills,
    WeatherToday,
    WeatherTomorrow,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Intent {
    MusicPlay,
    MusicPause,
    MusicNext,
    MusicPrevious,
    MusicSearch(String),
    MusicPlaylist(String),
    MusicVolumeUp,
    MusicVolumeDown,
    MusicSetVolume(u8),
    PillAdd(String),
    PillAddMultiple(Vec<String>),
    PillRemove(String),
    PillRemoveMultiple(Vec<String>),
    PillSetMain(String),
    PillReplace { old: String, new: String },
    PillOnly(Vec<String>),
    Query(Topic),
    OpenApp(String),
    WebSearch(String),
    AskAbito(String),
    Unknown,
}

// ── Normalisation ─────────────────────────────────────────────────────────────

fn fold(c: char) -> char {
    match c {
        'á' | 'à' | 'ä' | 'â' => 'a',
        'é' | 'è' | 'ë' | 'ê' => 'e',
        'í' | 'ì' | 'ï' | 'î' => 'i',
        'ó' | 'ò' | 'ö' | 'ô' => 'o',
        'ú' | 'ù' | 'ü' | 'û' => 'u',
        'ñ' => 'n',
        'ç' => 'c',
        other => other,
    }
}

pub fn normalise(s: &str) -> String {
    let t: String = s
        .to_lowercase()
        .chars()
        .map(|c| if matches!(c, '\'' | '’' | '-') { ' ' } else { fold(c) })
        .filter(|c| c.is_alphanumeric() || *c == ' ')
        .collect();
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// One entry per spoken word: the normalised form and the word as spelled (edges trimmed).
fn tokens(raw: &str) -> Vec<(String, String)> {
    raw.split(|c: char| c.is_whitespace() || matches!(c, '\'' | '’' | '-'))
        .filter_map(|w| {
            let n = normalise(w);
            if n.is_empty() {
                return None;
            }
            let r = w.trim_matches(|c: char| !c.is_alphanumeric()).to_string();
            Some((n, r))
        })
        .collect()
}

fn seq_at(words: &[String], seq: &[&str], i: usize) -> bool {
    i + seq.len() <= words.len() && words[i..i + seq.len()].iter().zip(seq).all(|(a, b)| a == b)
}

fn find_seq(words: &[String], seq: &[&str]) -> Option<usize> {
    if seq.is_empty() || seq.len() > words.len() {
        return None;
    }
    (0..=words.len() - seq.len()).find(|&i| seq_at(words, seq, i))
}

fn matches_any(words: &[String], table: &[&[&str]]) -> bool {
    table.iter().any(|s| find_seq(words, s).is_some())
}

/// Longest trigger first; the words after it (normalised and as spelled).
fn extract_after(words: &[String], raws: &[String], triggers: &[&[&str]]) -> Option<(String, String)> {
    let mut sorted: Vec<&&[&str]> = triggers.iter().collect();
    sorted.sort_by_key(|t| std::cmp::Reverse(t.len()));
    for t in sorted {
        if t.len() >= words.len() {
            continue;
        }
        for i in 0..=words.len() - t.len() {
            if seq_at(words, t, i) {
                let norm = words[i + t.len()..].join(" ");
                let raw = if i + t.len() < raws.len() { raws[i + t.len()..].join(" ") } else { String::new() };
                if !norm.is_empty() {
                    return Some((norm, raw));
                }
            }
        }
    }
    None
}

const ARTICLES: &[&str] = &[
    "del", "de", "la", "el", "los", "las", "lo", "un", "una", "unos", "unas", "algo", "some", "the", "a", "an", "pildora",
    "pildoras", "pill", "pills", "mi", "mis",
];

fn strip_articles(s: &str) -> String {
    let mut w: Vec<&str> = s.split(' ').filter(|x| !x.is_empty()).collect();
    while w.first().is_some_and(|f| ARTICLES.contains(f)) {
        w.remove(0);
    }
    w.join(" ")
}

fn strip_articles_raw(s: &str) -> String {
    let mut w: Vec<&str> = s.split(' ').filter(|x| !x.is_empty()).collect();
    while w.first().is_some_and(|f| ARTICLES.contains(&normalise(f).as_str())) {
        w.remove(0);
    }
    w.join(" ")
}

fn split_conj(s: &str) -> Vec<String> {
    let mut parts = vec![];
    let mut cur: Vec<&str> = vec![];
    for w in s.split(' ').filter(|x| !x.is_empty()) {
        if w == "y" || w == "e" || w == "and" {
            if !cur.is_empty() {
                parts.push(cur.join(" "));
                cur.clear();
            }
        } else {
            cur.push(w);
        }
    }
    if !cur.is_empty() {
        parts.push(cur.join(" "));
    }
    parts
}

// ── Pills ─────────────────────────────────────────────────────────────────────

/// (id, spoken name), the same names as the pill catalog the island shows.
pub const PILL_NAMES: [(&str, &str); 25] = [
    ("integration_claude", "VS Code"),
    ("agent_cursor", "Cursor"),
    ("agent_antigravity", "Antigravity"),
    ("agent_codex", "Codex"),
    ("agent_gemini", "Gemini CLI"),
    ("agent_copilot", "Copilot CLI"),
    ("agent_muse", "Muse Code"),
    ("agent_opencode", "OpenCode"),
    ("agent_amp", "Amp"),
    ("agent_hermes", "Hermes"),
    ("agent_claude-desktop", "Claude Desktop"),
    ("ai_anthropic", "Anthropic"),
    ("ai_google", "Google AI"),
    ("ai_openai", "OpenAI"),
    ("ai_ollama", "Ollama"),
    ("ai_lmstudio", "LM Studio"),
    ("integration_resend", "Resend"),
    ("integration_n8n", "n8n"),
    ("integration_vercel", "Vercel"),
    ("integration_github", "GitHub"),
    ("integration_notion", "Notion"),
    ("integration_calcom", "Cal.com"),
    ("integration_stripe", "Stripe"),
    ("integration_music", "Apple Music"),
    ("integration_spotify", "Spotify"),
];

const ALIASES: &[(&str, &str)] = &[
    ("claude", "integration_claude"),
    ("claude code", "integration_claude"),
    ("vs code", "integration_claude"),
    ("vscode", "integration_claude"),
    ("v s code", "integration_claude"),
    ("visual studio code", "integration_claude"),
    ("visual studio", "integration_claude"),
    ("ves code", "integration_claude"),
    ("gemini", "agent_gemini"),
    ("copilot", "agent_copilot"),
    ("muse", "agent_muse"),
    ("hermes", "agent_hermes"),
    ("amp", "agent_amp"),
    ("opencode", "agent_opencode"),
    ("antigravity", "agent_antigravity"),
    ("codex", "agent_codex"),
    ("claude desktop", "agent_claude-desktop"),
    ("google", "ai_google"),
    ("openai", "ai_openai"),
    ("open ai", "ai_openai"),
    ("ollama", "ai_ollama"),
    ("lmstudio", "ai_lmstudio"),
    ("anthropic", "ai_anthropic"),
    ("github", "integration_github"),
    ("gt", "integration_github"),
    ("g t", "integration_github"),
    ("git hub", "integration_github"),
    ("jit hub", "integration_github"),
    ("gitub", "integration_github"),
    ("guit hub", "integration_github"),
    ("vercel", "integration_vercel"),
    ("notion", "integration_notion"),
    ("stripe", "integration_stripe"),
    ("resend", "integration_resend"),
    ("n8n", "integration_n8n"),
    ("calcom", "integration_calcom"),
    ("cal", "integration_calcom"),
    ("spotify", "integration_spotify"),
];

fn levenshtein(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut prev = row[0];
        row[0] = i;
        for j in 1..=b.len() {
            let t = row[j];
            row[j] = if a[i - 1] == b[j - 1] { prev } else { prev.min(row[j]).min(row[j - 1]) + 1 };
            prev = t;
        }
    }
    row[b.len()]
}

fn pool(workspace_only: bool) -> Vec<(&'static str, String)> {
    PILL_NAMES
        .iter()
        .filter(|(id, _)| pill_offered(id) && (!workspace_only || MAIN_PILLS.contains(id)))
        .map(|(id, n)| (*id, normalise(n)))
        .collect()
}

fn resolve_in(query: &str, workspace_only: bool) -> Option<String> {
    let q = normalise(query);
    let pool = pool(workspace_only);
    if pool.is_empty() || q.is_empty() {
        return None;
    }
    if let Some((_, id)) = ALIASES.iter().find(|(a, _)| *a == q) {
        if pool.iter().any(|(pid, _)| pid == id) {
            return Some(id.to_string());
        }
    }
    if let Some((id, _)) = pool.iter().find(|(_, n)| *n == q) {
        return Some(id.to_string());
    }
    let words: Vec<&(&str, String)> = pool.iter().filter(|(_, n)| n.split(' ').any(|w| w == q)).collect();
    if words.len() == 1 {
        return Some(words[0].0.to_string());
    }
    if words.len() > 1 {
        return None;
    }
    let mut best: Option<(&str, usize)> = None;
    let mut second: Option<usize> = None;
    for (id, n) in &pool {
        let d = levenshtein(&q, n);
        if best.is_none_or(|(_, bd)| d < bd) {
            second = best.map(|(_, bd)| bd);
            best = Some((id, d));
        } else if second.is_none_or(|sd| d < sd) {
            second = Some(d);
        }
    }
    let (id, d) = best?;
    let tol = if q.chars().count() <= 4 { 1 } else { 2 };
    (d <= tol && second.is_none_or(|s| s > tol)).then(|| id.to_string())
}

/// Resolves a spoken name to a pill id (aliases, exact, whole word, then edit distance).
pub fn resolve_pill(query: &str) -> Option<String> {
    resolve_in(query, false)
}

fn resolve_workspace(query: &str) -> Option<String> {
    resolve_in(query, true)
}

fn pill_name(id: &str) -> &'static str {
    PILL_NAMES.iter().find(|(i, _)| *i == id).map(|(_, n)| *n).unwrap_or("?")
}

// ── Tables ────────────────────────────────────────────────────────────────────

const INTERJECTIONS: &[&str] = &[
    "vale", "ok", "okay", "bueno", "pues", "oye", "hey", "gracias", "venga", "entonces", "eh", "vamos", "yes", "so", "well", "um",
    "uh", "thanks", "si", "bien",
];

const POLITE: &[&[&str]] = &[
    &["quiero", "que", "me"],
    &["quiero", "que"],
    &["necesito", "que"],
    &["me", "puedes"],
    &["me", "podrias"],
    &["puedes"],
    &["podrias"],
    &["i", "want", "you", "to"],
    &["could", "you"],
    &["can", "you"],
    &["would", "you"],
    &["please"],
];

const VERB_MAP: &[(&str, &str)] = &[
    ("poner", "pon"), ("pones", "pon"), ("ponme", "pon"), ("ponga", "pon"), ("ponlo", "pon"), ("ponla", "pon"),
    ("anadir", "anade"), ("anades", "anade"), ("anademe", "anade"), ("agregar", "agrega"), ("agregas", "agrega"),
    ("quitar", "quita"), ("quitas", "quita"), ("quitame", "quita"), ("eliminar", "elimina"), ("eliminas", "elimina"),
    ("borrar", "borra"), ("borras", "borra"), ("activar", "activa"), ("activas", "activa"), ("desactivar", "desactiva"),
    ("desactivas", "desactiva"), ("ocultar", "oculta"), ("ocultas", "oculta"), ("sacar", "saca"), ("retirar", "retira"),
    ("mostrar", "muestra"), ("muestrame", "muestra"), ("ensenar", "ensena"), ("reproducir", "reproduce"),
    ("reproduces", "reproduce"), ("abrir", "abre"), ("abres", "abre"), ("buscar", "busca"), ("buscas", "busca"),
    ("pausar", "pausa"), ("subir", "sube"), ("subes", "sube"), ("bajar", "baja"), ("bajas", "baja"),
    ("reemplazar", "reemplaza"), ("reemplazas", "reemplaza"), ("sustituir", "sustituye"), ("cambiar", "cambia"),
    ("cambias", "cambia"), ("dejar", "deja"), ("dejas", "deja"), ("pasar", "pasa"), ("pasas", "pasa"),
    ("saltar", "salta"), ("parar", "para"), ("paras", "para"), ("detener", "deten"), ("usar", "usa"), ("utilizar", "utiliza"),
    ("escuchar", "escucha"),
];

const PAUSE: &[&[&str]] = &[&["pausa"], &["pause"], &["en", "pausa"], &["stop", "the", "music"], &["stop", "music"], &["deten", "la", "musica"], &["detiene", "la", "musica"]];
/// Words that only mean "pause" when they open the phrase.
const PAUSE_FIRST: &[&str] = &["para", "stop", "deten", "detente", "silencio"];
const NEXT: &[&[&str]] = &[&["siguiente"], &["proxima"], &["proximo"], &["next"], &["skip"], &["salta"], &["pasa", "a", "la", "siguiente"]];
const PREV: &[&[&str]] = &[&["anterior"], &["previous"], &["atras"], &["canciones", "anterior"], &["vuelve", "atras"], &["back"]];
const VOL_UP: &[&[&str]] = &[&["sube", "el", "volumen"], &["sube", "el", "sonido"], &["sube", "la", "musica"], &["sube", "volumen"], &["mas", "fuerte"], &["mas", "alto"], &["mas", "volumen"], &["volume", "up"], &["louder"], &["turn", "up"]];
const VOL_DOWN: &[&[&str]] = &[&["baja", "el", "volumen"], &["baja", "el", "sonido"], &["baja", "la", "musica"], &["baja", "volumen"], &["menos", "fuerte"], &["mas", "bajo"], &["menos", "volumen"], &["volume", "down"], &["quieter"], &["turn", "down"]];
const PLAYLIST: &[&[&str]] = &[
    &["pon", "la", "playlist"], &["reproduce", "la", "playlist"], &["pon", "la", "lista"], &["reproduce", "la", "lista"],
    &["pon", "playlist"], &["reproduce", "playlist"], &["play", "playlist"], &["start", "playlist"], &["play", "the", "playlist"],
];
const PILL_MAIN: &[&[&str]] = &[&["pasa", "a"], &["pasa", "al"], &["cambia", "a"], &["cambia", "al"], &["switch", "to"], &["change", "to"], &["usa"], &["utiliza"], &["use"]];
const MUSIC_PILL: &[&[&str]] = &[&["pon"], &["reproduce"], &["play"], &["start"], &["resume"], &["reanuda"], &["lanza"]];
const ADD_ONLY: &[&[&str]] = &[&["activa"], &["muestra"], &["ensena"], &["agrega"], &["anade"], &["add"], &["enable"], &["show"], &["activate"]];
const REMOVE: &[&[&str]] = &[&["quita"], &["elimina"], &["borra"], &["desactiva"], &["oculta"], &["saca"], &["retira"], &["ya", "no", "necesito"], &["remove"], &["disable"], &["hide"], &["delete"]];
const PLAY_PREFIXES: &[&[&str]] = &[
    &["pon", "musica"], &["reproduce", "musica"], &["dale", "al", "play"], &["dale", "al", "reproducir"], &["play", "music"],
    &["start", "music"], &["resume", "music"], &["resume"], &["reanuda"], &["reanuda", "la", "musica"], &["play", "some", "music"],
    &["pon", "algo", "de", "musica"], &["pon", "un", "poco", "de", "musica"], &["dale", "play"], &["reproduce"],
];
const BARE_MUSIC: &[&str] = &["pon", "reproduce", "play", "start", "resume", "reanuda", "lanza", "play"];
const GENERIC_MUSIC: &[&str] = &["musica", "cancion", "canciones", "sonido", "music", "audio", "song", "songs", "algo de musica", "un poco de musica"];

// ── Questions ─────────────────────────────────────────────────────────────────

const ACTION_VERBS: &[&str] = &[
    "anade", "anadir", "agrega", "agregar", "quita", "quitar", "elimina", "eliminar", "borra", "borrar", "pon", "poner", "ponme",
    "reproduce", "reproducir", "reemplaza", "reemplazar", "activa", "activar", "desactiva", "desactivar", "oculta", "abre",
    "abrir", "envia", "enviar", "escribe", "redacta", "cambia", "deja", "add", "remove", "play", "open", "send", "write", "compose",
    "draft", "email", "muestra",
];

const QUESTION_MARKERS: &[&str] = &[
    "cuanto", "cuanta", "cuantos", "cuantas", "cual", "cuales", "que", "como", "dime", "dame", "muestrame", "hay", "esta", "estan",
    "how", "what", "whats", "did", "is", "are", "any", "tell me", "show me", "estado", "status", "quien",
];

fn topic_of(raw: &str) -> Option<Topic> {
    let norm = normalise(raw);
    let words: Vec<&str> = norm.split(' ').collect();
    if norm.is_empty() {
        return None;
    }
    let text = format!(" {norm} ");
    let has = |s: &str| text.contains(&format!(" {s} "));
    let has_any = |l: &[&str]| l.iter().any(|s| has(s));
    if words.iter().any(|w| ACTION_VERBS.contains(w)) {
        return None;
    }
    let asks = raw.trim().ends_with('?') || has_any(QUESTION_MARKERS);
    if has_any(&["tiempo hace", "que tiempo", "el tiempo", "clima", "meteo", "weather", "llueve", "llover", "lluvia", "paraguas", "temperatura", "hace calor", "hace frio", "pronostico", "forecast", "rain", "umbrella"]) {
        return Some(if has_any(&["manana", "tomorrow"]) { Topic::WeatherTomorrow } else { Topic::WeatherToday });
    }
    if !asks {
        return None;
    }
    if has("stripe") { return Some(Topic::Stripe); }
    if has_any(&["github", "git hub", "gt"]) { return Some(Topic::Github); }
    if has("vercel") { return Some(Topic::Vercel); }
    if has("resend") { return Some(Topic::Resend); }
    if has_any(&["n8n", "n 8 n", "workflow", "workflows", "automatizacion", "automatizaciones"]) { return Some(Topic::N8n); }
    if has("notion") { return Some(Topic::Notion); }
    if has_any(&["cal com", "calcom", "reunion", "reuniones", "cita", "citas", "agenda", "meeting", "meetings", "booking", "bookings", "reserva", "reservas"]) { return Some(Topic::Calcom); }
    if has_any(&["cuota", "limite", "limites", "plan", "quota", "usage", "uso"]) {
        return Some(if has("codex") { Topic::CodexPlan } else { Topic::ClaudePlan });
    }
    if has_any(&["claude", "codex", "cursor", "gemini", "copilot", "vs code", "vscode", "agente", "agentes", "agent", "agents", "sesion", "sesiones", "session", "sessions"]) { return Some(Topic::Agents); }
    if has_any(&["dinero", "vendido", "vendi", "ventas", "venta", "ingresos", "gane", "cobrado", "pagos", "saldo", "money", "sales", "revenue", "earned", "payments", "balance", "sell", "sold"]) { return Some(Topic::Stripe); }
    if has_any(&["estrella", "estrellas", "star", "stars", "pull request", "pull requests", "pr", "prs", "repo", "repos", "ci"]) { return Some(Topic::Github); }
    if has_any(&["despliegue", "despliegues", "deploy", "deployment", "push"]) { return Some(Topic::Vercel); }
    if has_any(&["mail", "mails", "email", "emails", "correo", "correos"]) && has_any(&["cuantos", "cuantas", "how many", "ultimos", "ultimo", "last", "enviados", "sent", "entregados", "delivered"]) { return Some(Topic::Resend); }
    if has_any(&["cancion", "musica", "titulo", "tema", "song", "track", "playing", "suena", "suenan", "escucho", "ecoute"]) { return Some(Topic::Music); }
    if has_any(&["pildora", "pildoras", "pill", "pills"]) { return Some(Topic::Pills); }
    None
}

// ── Web search and apps ───────────────────────────────────────────────────────

const WEB_HEADS: &[&[&str]] = &[
    &["puedes"], &["podrias"], &["me", "puedes"], &["me", "podrias"], &["quiero", "que"], &["i", "want", "you", "to"],
    &["can", "you"], &["could", "you"], &["would", "you"], &["ok"], &["okay"], &["vale"], &["oye"], &["hey"], &["bueno"],
    &["please"], &["por", "favor"], &["haz", "una", "busqueda"], &["haz", "me", "una", "busqueda"], &["do", "a", "web", "search"],
    &["do", "a", "search"], &["busca", "me"], &["buscame"], &["busca"], &["buscar"], &["googlea"], &["googlear"], &["investiga"],
    &["averigua"], &["mira"], &["search"], &["look", "it", "up"], &["look", "up"], &["google"], &["find", "out"], &["find"], &["check"],
    &["en", "internet"], &["por", "internet"], &["en", "la", "web"], &["en", "google"], &["en", "linea"], &["internet"], &["la", "web"],
    &["on", "the", "internet"], &["on", "the", "web"], &["the", "internet"], &["the", "web"], &["online"], &["on", "google"],
    &["informacion", "sobre"], &["info", "sobre"], &["information", "about"], &["info", "about"], &["info", "on"],
    &["para", "mi"], &["for", "me"], &["me"], &["for"], &["about"], &["sobre"],
];
const WEB_TAILS: &[&[&str]] = &[
    &["en", "internet"], &["por", "internet"], &["en", "la", "web"], &["en", "google"], &["en", "linea"], &["on", "the", "internet"],
    &["on", "the", "web"], &["on", "internet"], &["on", "google"], &["online"], &["internet"], &["por", "favor"], &["porfa"],
    &["please"], &["para", "mi"], &["for", "me"], &["gracias"], &["thanks"], &["thank", "you"],
];

fn web_query(raw: &str) -> Option<String> {
    let toks = tokens(raw);
    let n: Vec<String> = toks.iter().map(|t| t.0.clone()).collect();
    if n.is_empty() {
        return None;
    }
    let joined = format!(" {} ", n.join(" "));
    let web_words = [" internet ", " web ", " google ", " googlea ", " en linea ", " online ", " look up ", " look it up "];
    if !web_words.iter().any(|w| joined.contains(w)) {
        return None;
    }
    let verbs = ["busca", "buscar", "busques", "buscame", "googlea", "googlear", "investiga", "averigua", "mira", "search", "look", "find", "check", "haz", "do"];
    if !(n.iter().any(|w| verbs.contains(&w.as_str())) || n[0] == "google") {
        return None;
    }
    let (mut h, mut t) = (0usize, n.len());
    let mut changed = true;
    while changed && h < t {
        changed = false;
        for seq in WEB_HEADS {
            if h + seq.len() <= t && seq_at(&n, seq, h) {
                h += seq.len();
                changed = true;
                break;
            }
        }
        for seq in WEB_TAILS {
            if t >= h + seq.len() && seq_at(&n, seq, t - seq.len()) {
                t -= seq.len();
                changed = true;
                break;
            }
        }
    }
    if h >= t {
        return Some(String::new());
    }
    Some(toks[h..t].iter().map(|x| x.1.clone()).collect::<Vec<_>>().join(" "))
}

fn app_to_open(raw: &str) -> Option<String> {
    let toks = tokens(raw);
    let i = toks.iter().position(|(n, _)| matches!(n.as_str(), "abre" | "abrir" | "open"))?;
    let mut start = i + 1;
    while start < toks.len() && matches!(toks[start].0.as_str(), "me" | "la" | "el" | "app" | "aplicacion" | "the" | "appli" | "programa" | "mi") {
        start += 1;
    }
    if start >= toks.len() {
        return None;
    }
    let name = toks[start..].iter().map(|t| t.1.clone()).collect::<Vec<_>>().join(" ");
    (!name.is_empty()).then_some(name)
}

fn ask_abito(raw: &str) -> Option<String> {
    let toks = tokens(raw);
    let i = toks.iter().position(|(n, _)| matches!(n.as_str(), "abito" | "abbito"))?;
    let lead: Vec<&str> = toks[..i].iter().map(|t| t.0.as_str()).collect();
    let ok = matches!(lead.as_slice(), ["ask"] | ["preguntale", "a"] | ["pregunta", "a"] | ["preguntale", "al"] | ["dile", "a"] | ["tell"] | ["ask", "to"])
        || (lead.len() >= 2 && matches!(lead[lead.len() - 2..], [_, "a"] | [_, "to"]) && lead.iter().any(|w| matches!(*w, "preguntale" | "pregunta" | "ask" | "dile")));
    if !ok || i + 1 >= toks.len() {
        return None;
    }
    let tail = toks[i + 1..].iter().map(|t| t.1.clone()).collect::<Vec<_>>().join(" ");
    let first = toks[i + 1].0.as_str();
    let tail = if matches!(first, "que" | "to") && toks.len() > i + 2 && lead.first().is_some_and(|l| *l == "dile" || *l == "tell") {
        toks[i + 2..].iter().map(|t| t.1.clone()).collect::<Vec<_>>().join(" ")
    } else {
        tail
    };
    (!tail.is_empty()).then_some(tail)
}

// ── The parser ────────────────────────────────────────────────────────────────

fn ids_of(clean: &str) -> Vec<String> {
    split_conj(clean).iter().filter_map(|p| {
        let p = strip_articles(p);
        if p.is_empty() { None } else { resolve_pill(&p) }
    }).collect()
}

fn extract_volume(w: &[String]) -> Option<u8> {
    let vi = w.iter().position(|x| x == "volumen" || x == "volume")?;
    let (ni, n) = w.iter().enumerate().rev().find_map(|(i, x)| x.parse::<u32>().ok().map(|n| (i, n)))?;
    (vi < ni && n <= 100).then_some(n as u8)
}

fn extract_replace(w: &[String]) -> Option<(String, String)> {
    for start in ["reemplaza", "sustituye", "replace", "cambia", "swap", "intercambia"] {
        let Some(si) = w.iter().position(|x| x == start) else { continue };
        let rest = &w[si + 1..];
        for sep in ["por", "for", "with", "by", "con", "contra"] {
            let Some(pi) = rest.iter().position(|x| x == sep) else { continue };
            if pi == 0 || pi + 1 >= rest.len() {
                continue;
            }
            let e1 = strip_articles(&rest[..pi].join(" "));
            let e2 = strip_articles(&rest[pi + 1..].join(" "));
            if let (Some(a), Some(b)) = (resolve_pill(&e1), resolve_pill(&e2)) {
                return Some((a, b));
            }
        }
    }
    None
}

fn extract_instead_of(w: &[String]) -> Option<(String, String)> {
    let markers: &[&[&str]] = &[&["en", "lugar", "de"], &["en", "lugar", "del"], &["en", "vez", "de"], &["en", "vez", "del"], &["instead", "of"]];
    let lead = ["pon", "anade", "agrega", "activa", "muestra", "put", "add", "use", "usa", "utiliza"];
    let noise = ["la", "el", "los", "las", "pildora", "pildoras", "the", "pill", "me"];
    for m in markers {
        let Some(i) = find_seq(w, m) else { continue };
        if i == 0 || i + m.len() >= w.len() {
            continue;
        }
        let left: Vec<&str> = w[..i].iter().map(String::as_str).filter(|x| !lead.contains(x) && !noise.contains(x)).collect();
        let right: Vec<&str> = w[i + m.len()..].iter().map(String::as_str).filter(|x| !noise.contains(x)).collect();
        if left.is_empty() || right.is_empty() {
            continue;
        }
        if let (Some(new), Some(old)) = (resolve_pill(&left.join(" ")), resolve_pill(&right.join(" "))) {
            if new != old {
                return Some((old, new));
            }
        }
    }
    None
}

fn extract_only(w: &[String]) -> Option<Vec<String>> {
    let starts: &[&[&str]] = &[&["deja", "solo"], &["deja", "solamente"], &["quedate", "solo", "con"], &["mantén", "solo"], &["manten", "solo"], &["quedate", "con"], &["keep", "only"], &["deja", "solo", "las"]];
    for s in starts {
        let Some(i) = find_seq(w, s) else { continue };
        let rest = w[i + s.len()..].join(" ");
        let ids: Vec<String> = ids_of(&rest);
        if !ids.is_empty() {
            return Some(ids);
        }
    }
    None
}

fn strip_trailing_location(w: &mut Vec<String>, r: &mut Vec<String>) {
    let Some(i) = w.iter().rposition(|x| x == "en" || x == "dentro") else { return };
    if i == 0 {
        return;
    }
    let tail: Vec<&str> = w[i + 1..].iter().map(String::as_str).collect();
    let art = ["las", "los", "la", "el"];
    let places = ["pildoras", "pildora", "notch", "isla", "barra", "lista"];
    let ok = (tail.len() == 1 && art.contains(&tail[0])) || (tail.len() == 2 && art.contains(&tail[0]) && places.contains(&tail[1]));
    if ok {
        w.truncate(i);
        r.truncate(i);
    }
}

fn strip_trailing_instead(w: &mut Vec<String>, r: &mut Vec<String>) {
    for t in [&["en", "su", "lugar"][..], &["en", "su", "vez"], &["instead"]] {
        if w.len() > t.len() && seq_at(w, t, w.len() - t.len()) {
            let n = w.len() - t.len();
            w.truncate(n);
            r.truncate(n);
            return;
        }
    }
}

pub fn parse(raw: &str) -> Intent {
    let toks = tokens(&raw.replace("por favor", " ").replace("Por favor", " "));
    if toks.is_empty() {
        return Intent::Unknown;
    }
    if let Some(q) = ask_abito(raw) {
        return Intent::AskAbito(q);
    }
    if let Some(q) = web_query(raw) {
        return Intent::WebSearch(q);
    }
    if let Some(t) = topic_of(raw) {
        return Intent::Query(t);
    }
    if let Some(app) = app_to_open(raw) {
        return Intent::OpenApp(app);
    }
    // defilter: possessives become articles
    let (mut w, mut r): (Vec<String>, Vec<String>) = (vec![], vec![]);
    for (n, x) in toks {
        match n.as_str() {
            "porfa" | "pls" | "stp" => {}
            "mi" => { w.push("la".into()); r.push(x); }
            "mis" => { w.push("las".into()); r.push(x); }
            _ => { w.push(n); r.push(x); }
        }
    }
    if w.is_empty() {
        return Intent::Unknown;
    }
    strip_trailing_location(&mut w, &mut r);
    strip_trailing_instead(&mut w, &mut r);
    if w.is_empty() {
        return Intent::Unknown;
    }
    while w.len() > 1 && INTERJECTIONS.contains(&w[0].as_str()) {
        w.remove(0);
        if !r.is_empty() { r.remove(0); }
    }
    for p in POLITE {
        if seq_at(&w, p, 0) && w.len() > p.len() {
            w.drain(..p.len());
            r.drain(..p.len().min(r.len()));
            break;
        }
    }
    if w.is_empty() {
        return Intent::Unknown;
    }
    for x in w.iter_mut() {
        if let Some((_, to)) = VERB_MAP.iter().find(|(f, _)| f == x) {
            *x = to.to_string();
        }
    }

    // replace pill: "pon X en lugar de Y"
    if let Some((old, new)) = extract_instead_of(&w) {
        return Intent::PillReplace { old, new };
    }

    // "quiero escuchar Drake" / "listen to Drake"
    if let Some(i) = w.iter().rposition(|x| x == "escucha" || x == "listen") {
        if i > 0 || w.len() > 1 {
            let arts = ["del", "de", "la", "el", "los", "las", "un", "una", "algo", "to", "a", "some", "the"];
            let mut rn: Vec<String> = w[i + 1..].to_vec();
            let mut rr: Vec<String> = r[(i + 1).min(r.len())..].to_vec();
            while rn.first().is_some_and(|f| arts.contains(&f.as_str())) {
                rn.remove(0);
                if !rr.is_empty() { rr.remove(0); }
            }
            if !rn.is_empty() {
                if GENERIC_MUSIC.contains(&rn.join(" ").as_str()) {
                    return Intent::MusicPlay;
                }
                let name = if rr.is_empty() { rn.join(" ") } else { rr.join(" ") };
                return Intent::MusicSearch(name);
            }
        }
    }

    // transport
    if matches_any(&w, PAUSE) || PAUSE_FIRST.contains(&w[0].as_str()) {
        return Intent::MusicPause;
    }
    if matches_any(&w, NEXT) { return Intent::MusicNext; }
    if matches_any(&w, PREV) { return Intent::MusicPrevious; }
    if matches_any(&w, VOL_UP) { return Intent::MusicVolumeUp; }
    if matches_any(&w, VOL_DOWN) { return Intent::MusicVolumeDown; }
    if let Some(p) = extract_volume(&w) { return Intent::MusicSetVolume(p); }

    // "… en Spotify" / "… on Spotify"
    for prep in ["en", "on"] {
        if let Some(i) = w.iter().rposition(|x| x == prep) {
            if i + 1 < w.len() && resolve_pill(&w[i + 1..].join(" ")).as_deref() == Some("integration_spotify") {
                return Intent::MusicPlay;
            }
        }
    }

    // main pill
    if w.iter().any(|x| x == "principal") {
        if let Some(si) = w.iter().position(|x| x == "a" || x == "al" || x == "sobre" || x == "en" || x == "por") {
            if si + 1 < w.len() {
                let clean = strip_articles(&w[si + 1..].join(" "));
                if let Some(id) = resolve_workspace(&clean) { return Intent::PillSetMain(id); }
            }
        }
        if let Some(ci) = w.iter().position(|x| x == "como" || x == "de" || x == "en") {
            let from = usize::from(w.len() > 1 && matches!(w[0].as_str(), "pon" | "usa" | "utiliza" | "pasa" | "cambia" | "make" | "set"));
            if ci > from {
                let clean = strip_articles(&w[from..ci].join(" "));
                if let Some(id) = resolve_workspace(&clean) { return Intent::PillSetMain(id); }
            }
        }
    }
    if w.iter().any(|x| x == "main") && (w.iter().any(|x| x == "pill") || w.iter().any(|x| x == "pildora")) {
        let noise = ["make", "set", "as", "my", "the", "main", "pill", "to", "switch", "change", "use", "put", "is", "be", "should", "please", "now", "la"];
        let rest = w.iter().filter(|x| !noise.contains(&x.as_str())).cloned().collect::<Vec<_>>().join(" ");
        if !rest.is_empty() {
            if let Some(id) = resolve_workspace(&rest) { return Intent::PillSetMain(id); }
        }
    }

    if let Some((old, new)) = extract_replace(&w) { return Intent::PillReplace { old, new }; }
    if let Some(ids) = extract_only(&w) { return Intent::PillOnly(ids); }

    // playlist
    if let Some((norm, rawt)) = extract_after(&w, &r, PLAYLIST) {
        let clean = strip_articles(&norm);
        let clean_raw = strip_articles_raw(&rawt);
        if !clean.is_empty() {
            return Intent::MusicPlaylist(if clean_raw.is_empty() { clean } else { clean_raw });
        }
        return Intent::MusicPlaylist(String::new());
    }
    if w.last().is_some_and(|l| l == "playlist" || l == "playlists" || l == "lista") {
        if let Some(v) = w.iter().position(|x| ["pon", "reproduce", "play", "start", "lanza"].contains(&x.as_str())) {
            let fillers = ["my", "the", "a", "la", "el", "las", "los", "una", "un"];
            let name = (v + 1..w.len() - 1).filter(|&i| !fillers.contains(&w[i].as_str())).map(|i| r.get(i).cloned().unwrap_or_else(|| w[i].clone())).collect::<Vec<_>>().join(" ");
            return Intent::MusicPlaylist(name);
        }
    }

    // main-only verbs
    if let Some((norm, _)) = extract_after(&w, &r, PILL_MAIN) {
        let clean = strip_articles(&norm);
        if !clean.is_empty() {
            return match resolve_workspace(&clean) { Some(id) => Intent::PillSetMain(id), None => Intent::Unknown };
        }
    }

    // ambiguous verbs: pill first, then music
    if let Some((norm, rawt)) = extract_after(&w, &r, MUSIC_PILL) {
        let has_pill_word = w.iter().any(|x| x == "pildora" || x == "pill");
        let has_main = w.iter().any(|x| x == "principal");
        let clean = strip_articles(&norm);
        let clean_raw = strip_articles_raw(&rawt);
        if !clean.is_empty() {
            let ids = ids_of(&clean);
            if split_conj(&clean).len() >= 2 && ids.len() >= 2 { return Intent::PillAddMultiple(ids); }
            if GENERIC_MUSIC.contains(&clean.as_str()) { return Intent::MusicPlay; }
            if let Some(id) = resolve_pill(&clean) {
                if id == "integration_spotify" || id == "integration_music" { return Intent::MusicPlay; }
            }
            if has_pill_word && !has_main {
                return resolve_pill(&clean).map(Intent::PillAdd).unwrap_or(Intent::Unknown);
            }
            if let Some(id) = resolve_workspace(&clean) { return Intent::PillSetMain(id); }
            if let Some(id) = resolve_pill(&clean) { return Intent::PillAdd(id); }
            return Intent::MusicSearch(if clean_raw.is_empty() { clean } else { clean_raw });
        }
    }

    for (table, remove) in [(REMOVE, true), (ADD_ONLY, false)] {
        if let Some((norm, _)) = extract_after(&w, &r, table) {
            let clean = strip_articles(&norm);
            if !clean.is_empty() {
                let ids = ids_of(&clean);
                if split_conj(&clean).len() >= 2 && ids.len() >= 2 {
                    return if remove { Intent::PillRemoveMultiple(ids) } else { Intent::PillAddMultiple(ids) };
                }
                return match resolve_pill(&clean) {
                    Some(id) => if remove { Intent::PillRemove(id) } else { Intent::PillAdd(id) },
                    None => Intent::Unknown,
                };
            }
        }
    }

    if matches_any(&w, PLAY_PREFIXES) { return Intent::MusicPlay; }
    if w.len() == 1 && BARE_MUSIC.contains(&w[0].as_str()) { return Intent::MusicPlay; }
    Intent::Unknown
}

const SEGMENT_VERBS: &[&str] = &[
    "anade", "anadir", "agrega", "pon", "poner", "ponme", "activa", "activar", "quita", "quitar", "elimina", "borra", "oculta", "desactiva",
    "reproduce", "reproducir", "add", "remove", "put", "enable", "disable", "play", "pausa", "pause", "abre", "open",
];

fn split_on_action_verbs(segment: &str) -> Vec<String> {
    let words: Vec<&str> = segment.split_whitespace().collect();
    let mut parts: Vec<Vec<&str>> = vec![];
    let mut cur: Vec<&str> = vec![];
    let mut has_verb = false;
    for w in words {
        let is_verb = SEGMENT_VERBS.contains(&normalise(w).as_str());
        if is_verb && has_verb {
            parts.push(std::mem::take(&mut cur));
            has_verb = false;
        }
        cur.push(w);
        if is_verb { has_verb = true; }
    }
    if !cur.is_empty() { parts.push(cur); }
    let joins = ["y", "luego", "despues", "and", "then", "ademas"];
    parts.into_iter().filter_map(|mut p| {
        while p.last().is_some_and(|l| joins.contains(&normalise(l).as_str())) { p.pop(); }
        while p.first().is_some_and(|f| joins.contains(&normalise(f).as_str())) { p.remove(0); }
        (!p.is_empty()).then(|| p.join(" "))
    }).collect()
}

/// "pausa y añade Notion" → two intents. None when it is one command ("añade Notion y Stripe").
pub fn parse_multi(raw: &str) -> Option<Vec<Intent>> {
    let conj = ["y", "luego", "despues", "and", "then"];
    let mut intents = vec![];
    let pieces: Vec<String> = raw.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).flat_map(|c| split_on_action_verbs(&c)).collect();
    for piece in pieces {
        let words: Vec<String> = piece.split_whitespace().map(String::from).collect();
        let mut parts: Vec<Vec<String>> = vec![];
        let mut cur: Vec<String> = vec![];
        for w in words {
            if conj.contains(&normalise(&w).as_str()) {
                if !cur.is_empty() { parts.push(std::mem::take(&mut cur)); }
            } else {
                cur.push(w);
            }
        }
        if !cur.is_empty() { parts.push(cur); }
        let sub: Vec<Intent> = parts.iter().map(|p| parse(&p.join(" "))).collect();
        if parts.len() >= 2 && sub.iter().all(|i| *i != Intent::Unknown) {
            intents.extend(sub);
            continue;
        }
        let whole = parse(&piece);
        if whole == Intent::Unknown { return None; }
        intents.push(whole);
    }
    (intents.len() >= 2).then_some(intents)
}

// ── Language ──────────────────────────────────────────────────────────────────

pub fn detect_lang(raw: &str) -> Lang {
    let es_words = ["el", "la", "los", "las", "de", "que", "por", "favor", "pon", "pausa", "sube", "baja", "anade", "quita", "abre", "busca", "musica", "cancion", "siguiente", "anterior", "una", "un", "mi", "con", "en", "y", "oye", "vale", "puedes", "reproduce", "quiero", "como", "cual", "cuantos", "cuantas"];
    let en_words = ["the", "please", "play", "pause", "add", "remove", "open", "search", "music", "song", "next", "previous", "and", "what", "how", "my", "can", "you", "some", "turn", "up", "down", "volume", "set"];
    let norm = normalise(raw);
    let toks: Vec<&str> = norm.split(' ').collect();
    let es = toks.iter().filter(|t| es_words.contains(t)).count() + usize::from(raw.chars().any(|c| "áéíóúñ¿¡".contains(c)));
    let en = toks.iter().filter(|t| en_words.contains(t)).count();
    if en > es { Lang::En } else { Lang::Es }
}

// ── Planning ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct World {
    pub main: String,
    /// The pills shown next to the main one (at most four).
    pub active: Vec<String>,
    pub music_running: bool,
    pub playing: bool,
    pub volume: u8,
    pub now_playing: Option<(String, Option<String>)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MusicOp {
    PlayPause,
    Next,
    Previous,
    Volume(u8),
}

/// Everything a voice command may do. The host executes these and nothing else.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Music(MusicOp),
    TogglePill(String),
    SetMainPill(String),
    /// Always an https URL built here.
    OpenUrl(String),
    /// A binary from the closed allowlist.
    OpenApp(&'static str),
    AskChat(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Success,
    Failure,
    Question(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Pending {
    RemoveWhich { to_add: String },
    WhichPlaylist,
    WebQuery,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub effects: Vec<Effect>,
    pub result: Outcome,
    pub message: String,
    pub pending: Option<Pending>,
}

fn t(lang: Lang, es: &str, en: &str) -> String {
    match lang { Lang::Es => es, Lang::En => en }.to_string()
}

fn ok(lang: Lang, es: &str, en: &str, effects: Vec<Effect>) -> Plan {
    Plan { effects, result: Outcome::Success, message: t(lang, es, en), pending: None }
}
fn fail(lang: Lang, es: &str, en: &str) -> Plan {
    Plan { effects: vec![], result: Outcome::Failure, message: t(lang, es, en), pending: None }
}
fn ask(lang: Lang, es: &str, en: &str, pending: Pending) -> Plan {
    let q = t(lang, es, en);
    Plan { effects: vec![], result: Outcome::Question(q.clone()), message: q, pending: Some(pending) }
}

fn encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// The closed list of apps a voice command may start: spoken names → binary.
const APPS: &[(&[&str], &str)] = &[
    (&["firefox"], "firefox"),
    (&["chrome", "google chrome"], "google-chrome"),
    (&["chromium"], "chromium"),
    (&["visual studio code", "vs code", "vscode", "code"], "code"),
    (&["spotify"], "spotify"),
    (&["terminal", "consola"], "gnome-terminal"),
    (&["archivos", "files", "nautilus", "explorador de archivos"], "nautilus"),
    (&["calculadora", "calculator"], "gnome-calculator"),
    (&["configuracion", "ajustes", "settings"], "gnome-control-center"),
    (&["cursor"], "cursor"),
    (&["slack"], "slack"),
    (&["discord"], "discord"),
    (&["telegram"], "telegram-desktop"),
    (&["obsidian"], "obsidian"),
    (&["figma"], "figma-linux"),
];

pub fn resolve_app(name: &str) -> Option<&'static str> {
    let n = normalise(name);
    APPS.iter().find(|(names, _)| names.contains(&n.as_str())).map(|(_, bin)| *bin)
}

fn music_gate(lang: Lang, w: &World, effects: Vec<Effect>, es: &str, en: &str) -> Plan {
    if !w.music_running {
        return fail(lang, "No hay ningún reproductor de música abierto.", "No music player is open.");
    }
    ok(lang, es, en, effects)
}

fn names(ids: &[String]) -> String {
    ids.iter().map(|i| pill_name(i)).collect::<Vec<_>>().join(", ")
}

pub fn plan(intent: &Intent, w: &World, lang: Lang) -> Plan {
    match intent {
        Intent::MusicPlay => {
            if w.playing {
                ok(lang, "Ya está sonando.", "Already playing.", vec![])
            } else if w.music_running {
                ok(lang, "Reproduciendo.", "Playing.", vec![Effect::Music(MusicOp::PlayPause)])
            } else {
                ok(lang, "Abriendo Spotify.", "Opening Spotify.", vec![Effect::OpenApp("spotify")])
            }
        }
        Intent::MusicPause => {
            if !w.music_running { return fail(lang, "No hay ningún reproductor de música abierto.", "No music player is open."); }
            let e = if w.playing { vec![Effect::Music(MusicOp::PlayPause)] } else { vec![] };
            ok(lang, "Música en pausa.", "Music paused.", e)
        }
        Intent::MusicNext => music_gate(lang, w, vec![Effect::Music(MusicOp::Next)], "Siguiente canción.", "Next track."),
        Intent::MusicPrevious => music_gate(lang, w, vec![Effect::Music(MusicOp::Previous)], "Canción anterior.", "Previous track."),
        Intent::MusicVolumeUp => {
            let v = w.volume.saturating_add(10).min(100);
            music_gate(lang, w, vec![Effect::Music(MusicOp::Volume(v))], "Volumen arriba.", "Volume up.")
        }
        Intent::MusicVolumeDown => {
            let v = w.volume.saturating_sub(10);
            music_gate(lang, w, vec![Effect::Music(MusicOp::Volume(v))], "Volumen abajo.", "Volume down.")
        }
        Intent::MusicSetVolume(p) => {
            let mut plan = music_gate(lang, w, vec![Effect::Music(MusicOp::Volume(*p))], "", "");
            if plan.result == Outcome::Success { plan.message = format!("{p} %"); }
            plan
        }
        Intent::MusicSearch(name) => {
            let url = format!("https://open.spotify.com/search/{}", encode(name));
            ok(lang, &format!("Buscando {name} en Spotify."), &format!("Searching {name} on Spotify."), vec![Effect::OpenUrl(url)])
        }
        Intent::MusicPlaylist(name) if name.trim().is_empty() => ask(lang, "¿Qué playlist pongo?", "Which playlist?", Pending::WhichPlaylist),
        Intent::MusicPlaylist(name) => {
            let url = format!("https://open.spotify.com/search/{}/playlists", encode(name));
            ok(lang, &format!("Buscando la playlist {name}."), &format!("Looking for the playlist {name}."), vec![Effect::OpenUrl(url)])
        }
        Intent::PillAdd(id) => {
            if w.active.contains(id) { return ok(lang, "Esa píldora ya está activa.", "That pill is already on.", vec![]); }
            let n = pill_name(id);
            ok(lang, &format!("{n} añadida."), &format!("{n} added."), vec![Effect::TogglePill(id.clone())])
        }
        Intent::PillAddMultiple(ids) => {
            let mut added = vec![];
            let mut effects = vec![];
            for id in ids {
                if w.active.contains(id) { continue; }
                added.push(id.clone());
                effects.push(Effect::TogglePill(id.clone()));
            }
            if added.is_empty() { return fail(lang, "No he entendido.", "I didn't get that."); }
            let n = names(&added);
            ok(lang, &format!("{n} añadidas."), &format!("{n} added."), effects)
        }
        Intent::PillRemove(id) => {
            if !w.active.contains(id) { return fail(lang, "Esa píldora no está activa.", "That pill is not on."); }
            let n = pill_name(id);
            ok(lang, &format!("{n} quitada."), &format!("{n} removed."), vec![Effect::TogglePill(id.clone())])
        }
        Intent::PillRemoveMultiple(ids) => {
            let removed: Vec<String> = ids.iter().filter(|i| w.active.contains(i)).cloned().collect();
            if removed.is_empty() { return fail(lang, "No he entendido.", "I didn't get that."); }
            let n = names(&removed);
            ok(lang, &format!("{n} quitadas."), &format!("{n} removed."), removed.into_iter().map(Effect::TogglePill).collect())
        }
        Intent::PillSetMain(id) => {
            let n = pill_name(id);
            ok(lang, &format!("{n} es ahora la píldora principal."), &format!("{n} is now the main pill."), vec![Effect::SetMainPill(id.clone())])
        }
        Intent::PillReplace { old, new } => {
            let mut e = vec![];
            if w.active.contains(old) { e.push(Effect::TogglePill(old.clone())); }
            if !w.active.contains(new) { e.push(Effect::TogglePill(new.clone())); }
            let (a, b) = (pill_name(old), pill_name(new));
            ok(lang, &format!("{a} → {b}"), &format!("{a} → {b}"), e)
        }
        Intent::PillOnly(ids) => {
            let mut e: Vec<Effect> = w.active.iter().filter(|a| !ids.contains(a)).map(|a| Effect::TogglePill(a.clone())).collect();
            e.extend(ids.iter().filter(|i| !w.active.contains(i)).map(|i| Effect::TogglePill(i.clone())));
            let n = names(ids);
            ok(lang, &format!("Solo {n}."), &format!("Only {n}."), e)
        }
        Intent::Query(topic) => query(*topic, w, lang),
        Intent::OpenApp(name) => match resolve_app(name) {
            Some(bin) => ok(lang, &format!("Abriendo {name}."), &format!("Opening {name}."), vec![Effect::OpenApp(bin)]),
            None => fail(lang, &format!("No sé abrir {name}."), &format!("I can't open {name}.")),
        },
        Intent::WebSearch(q) if q.trim().is_empty() => ask(lang, "¿Qué busco?", "What should I look up?", Pending::WebQuery),
        Intent::WebSearch(q) => {
            let url = format!("https://www.google.com/search?q={}", encode(q));
            ok(lang, &format!("Buscando {q}."), &format!("Searching for {q}."), vec![Effect::OpenUrl(url)])
        }
        Intent::AskAbito(text) => ok(lang, "Se lo pregunto a Koda.", "Asking Abito.", vec![Effect::AskChat(text.clone())]),
        Intent::Unknown => fail(lang, "No te he entendido.", "I didn't get that."),
    }
}

fn query(topic: Topic, w: &World, lang: Lang) -> Plan {
    match topic {
        Topic::Music => match &w.now_playing {
            Some((title, artist)) => {
                let by = artist.as_ref().map(|a| format!(" — {a}")).unwrap_or_default();
                ok(lang, &format!("Suena {title}{by}."), &format!("Playing {title}{by}."), vec![])
            }
            None => ok(lang, "No suena nada ahora mismo.", "Nothing is playing right now.", vec![]),
        },
        Topic::Pills => {
            let mut ids = vec![w.main.clone()];
            ids.extend(w.active.iter().cloned());
            let n = names(&ids);
            ok(lang, &format!("Tienes: {n}."), &format!("You have: {n}."), vec![])
        }
        _ => fail(lang, "Todavía no puedo consultar eso desde aquí.", "I can't look that up from here yet."),
    }
}

/// Handles the answer to a follow-up question. `asked_again` is true once the question
/// was repeated (it is never asked a third time).
pub fn answer_with(pending: &Pending, transcript: &str, w: &World, lang: Lang, asked_again: bool) -> Plan {
    if transcript.trim().is_empty() {
        return ok(lang, "Vale, lo dejamos.", "Okay, never mind.", vec![]);
    }
    match pending {
        Pending::WebQuery => plan(&Intent::WebSearch(transcript.trim().to_string()), w, lang),
        Pending::WhichPlaylist => {
            let mut name = transcript.trim().to_string();
            if let Intent::MusicPlaylist(n) = parse(transcript) { if !n.is_empty() { name = n; } }
            for p in ["la playlist ", "mi playlist ", "playlist ", "the playlist "] {
                if name.to_lowercase().starts_with(p) { name = name[p.len()..].to_string(); }
            }
            plan(&Intent::MusicPlaylist(name), w, lang)
        }
        Pending::RemoveWhich { to_add } => {
            let entity = match parse(transcript) {
                Intent::PillRemove(id) | Intent::PillAdd(id) => Some(id),
                _ => resolve_pill(&strip_articles(&normalise(transcript))),
            }.filter(|id| w.active.contains(id));
            let Some(entity) = entity else {
                if !asked_again {
                    return ask(lang, "¿Cuál quito?", "Which one should I remove?", pending.clone());
                }
                return fail(lang, "No he entendido.", "I didn't get that.");
            };
            let mut effects = vec![Effect::TogglePill(entity.clone())];
            if !w.active.contains(to_add) { effects.push(Effect::TogglePill(to_add.clone())); }
            let (a, b) = (pill_name(&entity), pill_name(to_add));
            ok(lang, &format!("{a} → {b}"), &format!("{a} → {b}"), effects)
        }
    }
}

pub fn answer(pending: &Pending, transcript: &str, w: &World, lang: Lang) -> Plan {
    answer_with(pending, transcript, w, lang, true)
}

/// What the host gives a voice session: the current state and the power to act.
pub trait Hands {
    fn world(&self) -> World;
    /// Executes one effect; false when it could not be done.
    fn apply(&self, effect: &Effect) -> bool;
}

/// What the island shows and says after a command.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub outcome: Outcome,
    pub message: String,
    /// The microphone must listen again, without the wake phrase (a question is open).
    pub rearm: bool,
    pub lang: Lang,
}

#[derive(Default)]
pub struct Session {
    pub pending: Option<Pending>,
    asked_again: bool,
    lang: Option<Lang>,
}

impl Session {
    pub fn timeout(&mut self) {
        self.pending = None;
        self.asked_again = false;
    }

    fn finish(&mut self, plan: Plan, hands: &dyn Hands, lang: Lang) -> Reply {
        let mut message = plan.message.clone();
        for e in &plan.effects {
            if !hands.apply(e) {
                message = t(lang, "No he podido hacerlo.", "I couldn't do that.");
                return Reply { outcome: Outcome::Failure, message, rearm: false, lang };
            }
        }
        let rearm = plan.pending.is_some();
        if rearm {
            self.asked_again = self.pending.is_some();
        } else {
            self.asked_again = false;
        }
        self.pending = plan.pending;
        Reply { outcome: plan.result, message, rearm, lang }
    }

    pub fn handle(&mut self, transcript: &str, hands: &dyn Hands) -> Reply {
        let lang = detect_lang(transcript);
        let lang = if transcript.split_whitespace().count() < 2 { self.lang.unwrap_or(lang) } else { lang };
        self.lang = Some(lang);
        if let Some(p) = self.pending.take() {
            let asked_again = self.asked_again;
            let plan = answer_with(&p, transcript, &hands.world(), lang, asked_again);
            return self.finish(plan, hands, lang);
        }
        let intents = parse_multi(transcript).unwrap_or_else(|| vec![parse(transcript)]);
        let mut last = None;
        let mut messages = vec![];
        for intent in &intents {
            let mut plan = plan(intent, &hands.world(), lang);
            if *intent == Intent::Unknown {
                plan.message = format!("{} «{}»", t(lang, "No te he entendido:", "I didn't get that:"), transcript.trim());
            }
            let r = self.finish(plan, hands, lang);
            messages.push(r.message.clone());
            let stop = r.rearm || r.outcome == Outcome::Failure;
            last = Some(r);
            if stop { break; }
        }
        let mut r = last.expect("at least one intent");
        r.message = messages.join(" · ");
        r
    }
}

#[allow(dead_code)]
fn _all_pill_ids_have_names() -> bool {
    PILL_IDS.iter().all(|i| PILL_NAMES.iter().any(|(p, _)| p == i))
}

#[cfg(test)]
#[path = "voiceintent_tests.rs"]
mod tests;

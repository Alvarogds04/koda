//! S1–S3 — the bounded, read-only snapshot of live state the chat adds to a turn.
//!
//! Pure: it only formats values the island ALREADY holds (the agent sessions view, the pending
//! question, the settled notices, the cached GitHub pulse and the cached integration updates). It
//! never reads the network, a keychain or a file. It deliberately drops everything the chat must
//! not see: tokens, mail bodies and subjects, attendee data, payment descriptions, diffs.
use serde_json::Value;

/// Hard cap of the snapshot text, in characters (≈ 450 tokens of Spanish).
pub const MAX_CHARS: usize = 1_800;

/// What the island holds right now. Every field is optional/empty when that source is absent.
#[derive(Debug, Default, Clone)]
pub struct LiveInputs {
    pub sessions: Value,
    pub question: Value,
    pub notices: Vec<Value>,
    pub github: Option<Value>,
    pub integrations: Vec<Value>,
    pub unread_mail: Option<u32>,
}

/// The built snapshot: the text the model gets and what the human can inspect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub text: String,
    /// Lines left out to respect [`MAX_CHARS`] (visible in the disclosure).
    pub trimmed_lines: usize,
}

const MAX_ROWS: usize = 8;
const MAX_ITEMS: usize = 5;
const HEADER: &str = "Estado en vivo de la app (solo lectura):";

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// One word that looks like a credential or a link: never forwarded.
fn secretish(word: &str) -> Option<&'static str> {
    let w = word.trim_matches(|c: char| !c.is_alphanumeric());
    let lower = w.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some("[enlace]");
    }
    let known = ["sk_", "pk_", "rk_", "ghp_", "gho_", "ghs_", "github_pat_", "xoxb-", "xoxp-", "re_", "secret_", "ntn_"];
    let tokenish = w.chars().count() >= 20
        && w.chars().all(|c| c.is_ascii_alphanumeric() || "_-.=+/".contains(c))
        && w.chars().any(|c| c.is_ascii_digit())
        && w.chars().any(|c| c.is_ascii_alphabetic());
    let prefixed = w.len() >= 12 && known.iter().any(|k| lower.starts_with(k));
    (tokenish || prefixed).then_some("[oculto]")
}

/// Single line, no control characters, no credential-looking words, at most `max` characters.
fn clip(raw: &str, max: usize) -> String {
    let flat: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let cleaned = flat
        .split_whitespace()
        .map(|w| match secretish(w) {
            Some(mask) => mask.to_string(),
            None => w.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.chars().count() > max {
        format!("{}…", cleaned.chars().take(max).collect::<String>())
    } else {
        cleaned
    }
}

fn kind_label(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "pi" => "Pi",
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "gemini" => "Gemini",
        _ => return None,
    })
}

fn ci_label(v: Option<&str>) -> &'static str {
    match v {
        Some("success") => "ok",
        Some("failure") => "fallando",
        Some("pending") => "en curso",
        _ => "sin dato",
    }
}

fn review_label(v: Option<&str>) -> &'static str {
    match v {
        Some("approved") => "aprobado",
        Some("changesRequested") => "cambios pedidos",
        Some("pending") => "pendiente",
        _ => "sin revisión",
    }
}

fn more(lines: &mut Vec<String>, total: usize, shown: usize, indent: &str) {
    if total > shown {
        lines.push(format!("{indent}… y {} más", total - shown));
    }
}

fn agents(sessions: &Value) -> Vec<String> {
    let Some(rows) = sessions.get("rows").and_then(Value::as_array) else { return Vec::new() };
    let rows: Vec<&Value> = rows.iter().filter(|r| str_at(r, "kind").and_then(kind_label).is_some()).collect();
    let mut out = Vec::new();
    for r in rows.iter().take(MAX_ROWS) {
        let label = str_at(r, "kind").and_then(kind_label).unwrap_or("Agente");
        let state = match str_at(r, "state") {
            Some("running") => "trabajando",
            Some("sleeping") => "en espera",
            Some("stopped") => "detenida",
            Some("zombie") => "colgada",
            _ => "estado desconocido",
        };
        let place = str_at(r, "cwd").map(|c| format!(" en {}", clip(c, 64))).unwrap_or_default();
        let step = (str_at(r, "state") == Some("running"))
            .then(|| r.pointer("/tools/steps").and_then(Value::as_array).and_then(|s| s.last()).and_then(|s| str_at(s, "name")))
            .flatten()
            .map(|n| format!(" (último paso: {})", clip(n, 64)))
            .unwrap_or_default();
        out.push(format!("- {label}{place}: {state}{step}"));
    }
    let total = sessions.get("total").and_then(Value::as_u64).map(|t| t as usize).unwrap_or(0).max(rows.len());
    let shown = out.len();
    more(&mut out, total, shown, "- ");
    out
}

fn questions(q: &Value) -> Vec<String> {
    let Some(p) = q.get("pending").filter(|p| p.is_object()) else { return Vec::new() };
    let who = clip(str_at(p, "agent_label").unwrap_or("Un agente"), 40);
    let project = str_at(p, "project_name").map(|n| format!(" (proyecto {})", clip(n, 64))).unwrap_or_default();
    let options: Vec<String> = p
        .get("options")
        .and_then(Value::as_array)
        .map(|o| o.iter().filter_map(|o| str_at(o, "label")).take(6).map(|l| clip(l, 40)).collect())
        .unwrap_or_default();
    let options = if options.is_empty() { String::new() } else { format!(" Opciones: {}", options.join(" / ")) };
    let queued = q.get("queued_count").and_then(Value::as_u64).filter(|n| *n > 0).map(|n| format!(" (+{n} en cola)")).unwrap_or_default();
    vec![format!("- {who}{project} pregunta: «{}»{options}{queued}", clip(str_at(p, "text").unwrap_or(""), 200))]
}

fn finished(notices: &[Value]) -> Vec<String> {
    let settled: Vec<&Value> = notices.iter().filter(|n| str_at(n, "kind") == Some("settled")).collect();
    let mut out: Vec<String> = settled
        .iter()
        .take(MAX_ITEMS)
        .map(|n| {
            let project = str_at(n, "projectName").map(|p| format!(" (proyecto {})", clip(p, 64))).unwrap_or_default();
            format!("- {}{project}", clip(str_at(n, "title").unwrap_or("Un agente terminó"), 80))
        })
        .collect();
    let shown = out.len();
    more(&mut out, settled.len(), shown, "- ");
    out
}

fn pr_line(pr: &Value, with_state: bool) -> Option<String> {
    let repo = str_at(pr, "repo")?;
    let number = pr.get("number").and_then(Value::as_i64)?;
    let draft = if pr.get("isDraft").and_then(Value::as_bool) == Some(true) { " (borrador)" } else { "" };
    let mut line = format!("  · {}#{number} «{}»{draft}", clip(repo, 64), clip(str_at(pr, "title").unwrap_or(""), 80));
    if with_state {
        line.push_str(&format!(": CI {}, {}", ci_label(str_at(pr, "ci")), review_label(str_at(pr, "review"))));
    }
    Some(line)
}

fn github(g: &Value) -> Vec<String> {
    let list = |k: &str| g.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let (mine, review, main) = (list("myPRs"), list("toReview"), list("mainCI"));
    if !g.is_object() || (mine.is_empty() && review.is_empty() && main.is_empty()) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (name, items, state) in [("Mis PR", &mine, true), ("Pendientes de mi revisión", &review, false)] {
        if items.is_empty() {
            continue;
        }
        out.push(format!("- {name}: {}", items.len()));
        let lines: Vec<String> = items.iter().filter_map(|p| pr_line(p, state)).take(MAX_ITEMS).collect();
        let shown = lines.len();
        out.extend(lines);
        more(&mut out, items.len(), shown, "  ");
    }
    if !main.is_empty() {
        let parts: Vec<String> = main
            .iter()
            .filter_map(|r| Some(format!("{} {}", clip(str_at(r, "repo")?, 64), ci_label(str_at(r, "ci")))))
            .take(MAX_ITEMS)
            .collect();
        out.push(format!("- CI de la rama principal: {}", parts.join("; ")));
    }
    out
}

fn money(minor: i64, currency: &str) -> String {
    let (sign, abs) = if minor < 0 { ("-", -minor) } else { ("", minor) };
    format!("{sign}{},{:02} {}", abs / 100, abs % 100, clip(&currency.to_uppercase(), 8))
}

/// One short line per connected service. `None` = nothing worth saying (not connected).
fn integration(u: &Value) -> Option<String> {
    let id = str_at(u, "id")?.strip_prefix("integration_")?;
    let name = match id {
        "vercel" => "Vercel",
        "n8n" => "n8n",
        "stripe" => "Stripe",
        "resend" => "Resend",
        "notion" => "Notion",
        "calcom" => "Cal.com",
        _ => return None,
    };
    let state = str_at(u, "state").unwrap_or("ready");
    if state == "missing_key" {
        return None;
    }
    if state == "error" {
        return Some(format!("- {name}: no se pudo consultar"));
    }
    let d = u.get("data")?;
    let first = |k: &str| d.get(k).and_then(Value::as_array).and_then(|a| a.first());
    let body = match id {
        "vercel" => {
            let dep = first("deployments")?;
            let st = match str_at(dep, "state") {
                Some("READY") => "salió bien",
                Some("ERROR") => "falló",
                Some("CANCELED") => "se canceló",
                _ => return None,
            };
            let branch = str_at(dep, "branch").map(|b| format!(" (rama {})", clip(b, 40))).unwrap_or_default();
            format!("último deploy {} {st}{branch}", clip(str_at(dep, "projectName")?, 64))
        }
        "n8n" => format!("{} {}", clip(str_at(d, "workflow")?, 64), clip(str_at(d, "status")?, 24)),
        "stripe" => {
            let p = first("payments")?;
            format!("último pago {}", money(p.get("amount").and_then(Value::as_i64)?, str_at(p, "currency")?))
        }
        "resend" => {
            let total = d.get("total").and_then(Value::as_i64).map(|t| format!("{t} correos enviados")).unwrap_or_else(|| "correos enviados".into());
            let last = first("emails").and_then(|e| str_at(e, "lastEvent")).filter(|e| !e.is_empty()).map(|e| format!(", último {}", clip(e, 24))).unwrap_or_default();
            format!("{total}{last}")
        }
        "notion" => format!("última página editada «{}»", clip(str_at(first("pages")?, "title")?, 80)),
        _ => {
            let b = first("bookings")?;
            format!("próxima reunión «{}» {}", clip(str_at(b, "title").unwrap_or("Reunión"), 60), clip(str_at(b, "start")?, 32))
        }
    };
    let old = if state == "stale" { " (dato antiguo)" } else { "" };
    Some(format!("- {name}: {body}{old}"))
}

/// Build the snapshot, or `None` when there is nothing to say (no sessions, no questions, nothing
/// connected). Sections are ordered by priority; over [`MAX_CHARS`] the lowest-priority lines go
/// first and the cut is announced at the end and counted.
pub fn build(inputs: &LiveInputs) -> Option<Snapshot> {
    let mut sections: Vec<(String, Vec<String>)> = vec![
        ("Agentes de código:".into(), agents(&inputs.sessions)),
        ("Preguntas pendientes:".into(), questions(&inputs.question)),
        ("Terminaron hace poco (el aviso no confirma que salió bien):".into(), finished(&inputs.notices)),
    ];
    let login = inputs.github.as_ref().and_then(|g| str_at(g, "login")).map(|l| format!("GitHub (@{}):", clip(l, 40)));
    sections.push((login.unwrap_or_else(|| "GitHub:".into()), inputs.github.as_ref().map(github).unwrap_or_default()));
    sections.push(("Integraciones:".into(), inputs.integrations.iter().filter_map(integration).collect()));
    sections.push(("Correo:".into(), Vec::new()));
    let mail = inputs.unread_mail.map(|n| format!("Correo: {n} sin leer"));
    if sections.iter().all(|(_, l)| l.is_empty()) && mail.is_none() {
        return None;
    }
    let render = |sections: &[(String, Vec<String>)], note: Option<usize>| {
        let mut out = vec![HEADER.to_string()];
        for (title, lines) in sections.iter().filter(|(t, l)| !l.is_empty() && t != "Correo:") {
            out.push(title.clone());
            out.extend(lines.iter().cloned());
        }
        if let Some(m) = &mail {
            out.push(m.clone());
        }
        if let Some(n) = note {
            out.push(format!("(contexto recortado: {n} líneas omitidas)"));
        }
        out.join("\n")
    };
    let mut trimmed = 0usize;
    let mut text = render(&sections, None);
    while text.chars().count() > MAX_CHARS {
        let Some(last) = sections.iter_mut().rev().find(|(_, l)| !l.is_empty()) else { break };
        last.1.pop();
        trimmed += 1;
        text = render(&sections, Some(trimmed));
    }
    Some(Snapshot { text, trimmed_lines: trimmed })
}

#[cfg(test)]
#[path = "chatsnapshot_tests.rs"]
mod tests;

//! #489 / S2(14) the Mac side of "services up close": the detail of Vercel, GitHub and n8n with
//! the actions Coucou offers on their items, and the runner that performs them.
//!
//! Adapted from Coucou NotchBuddy/Sources/App/PhoneLink/ServiceDetailRunner.swift and
//! NotchBuddy/Sources/CoucouKit/ServiceDetail.swift @71b773f, Copyright (c) 2026 Louis Raillé,
//! MIT. In Coucou these actions exist only from the phone (confirmation and Face ID live on the
//! phone, the Mac executes); nothing here is shown on the island (human decision, parent L-B).
//! Differences from the Swift: transport-agnostic (a [`Request`] list instead of CloudKit
//! records), the HTTP client and the key store are injected, error lines say Abito, and every
//! id that ends up inside a URL path must be a plain token (`[A-Za-z0-9._-]`).
//!
//! # Contract for the phone link (W6 #490)
//!
//! ```text
//! let mut runner = Runner::default();               // one per phone link, keeps the last details
//! let published = runner.handle(requests, now_ms, &Net, &Keychain);   // blocking: call off the UI thread
//! // `published` = the details to send to the phone, in order; each one carries `lastAction`.
//! runner.forget();                                  // when the phone link is switched off
//! ```
//! * A [`Request`] is `{id, pill_id, kind, target, requested_at_ms}`. `kind == "refresh"` asks for
//!   the detail of `pill_id`; any other kind is an action. `id` must be unique per phone request:
//!   an id is acted on once (the transport-agnostic stand-in for Coucou deleting the CloudKit
//!   record on read).
//! * Only [`PHONE_SERVICES`] are served. A request older than [`MAX_AGE_MS`] (5 min) is ignored
//!   without a reply. Several refreshes of one service in a batch count once. Requests run oldest
//!   first.
//! * An action runs only if it was offered on an item of the LAST detail published for that
//!   service and its kind is one of [`ALLOWED_KINDS`]; otherwise nothing is sent and the reply is
//!   "Not done". After an action the runner waits [`Runner::pause`] (2 s) and publishes the detail
//!   again with the result in `lastAction`.
//! * The confirmation text and `destructive` flag of each action ride in the published detail
//!   (`ActionDef.confirm`): the PHONE asks before sending the request. The Mac never asks.
//! * Detail JSON is `serde_json::to_value(&detail)` (camelCase, Coucou's field names). Dates are
//!   milliseconds since the epoch. Stripe, Resend, Cal.com and Notion answer "Not available from
//!   the iPhone yet." until their read-only details are ported.
//! * Nothing here moves money or sends an email; keys never leave the Mac.
use crate::integrations::{n8n_base, Http};
use crate::secrets::SecretStore;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

#[cfg(test)]
#[path = "servicedetail_tests.rs"]
mod tests;

/// The request kind that asks for a detail instead of an action.
pub const REFRESH: &str = "refresh";
/// A request must be younger than this (Coucou: 5 minutes).
pub const MAX_AGE_MS: u64 = 5 * 60 * 1000;
/// Every action the phone can ask for. Nothing moves money or sends an email.
pub const ALLOWED_KINDS: [&str; 9] = [
    "vercel.redeploy", "vercel.promote", "vercel.cancel", "github.rerun", "github.approve", "github.merge",
    "n8n.activate", "n8n.deactivate", "n8n.retry",
];
/// Coucou `PillCatalog.phoneServices`.
pub const PHONE_SERVICES: [&str; 7] = [
    "integration_github", "integration_stripe", "integration_vercel", "integration_resend", "integration_calcom",
    "integration_n8n", "integration_notion",
];
const SEEN_CAP: usize = 2000;

// ── Wire types (Coucou ServiceDetail.swift) ───────────────────────────────────

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Ok,
    Warning,
    Error,
    Info,
    Idle,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionDef {
    pub kind: String,
    pub title: String,
    pub symbol: String,
    pub target: String,
    pub destructive: bool,
    pub confirm: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub label: String,
    pub value: String,
    pub tone: Tone,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub title: String,
    pub subtitle: String,
    pub tone: Tone,
    pub date: Option<i64>,
    pub url: Option<String>,
    pub badge: Option<String>,
    pub actions: Vec<ActionDef>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub title: String,
    pub items: Vec<Item>,
    pub footer: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub title: String,
    pub ok: bool,
    pub message: String,
    pub date: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub pill_id: String,
    pub stats: Vec<Stat>,
    pub sections: Vec<Section>,
    pub fetched_at: u64,
    pub error: Option<String>,
    pub last_action: Option<ActionResult>,
}

impl Detail {
    fn empty(pill_id: &str, now: u64) -> Detail {
        Detail { pill_id: pill_id.into(), stats: vec![], sections: vec![], fetched_at: now, error: None, last_action: None }
    }
    /// The action offered on one of the items, if any (Coucou `ServiceDetail.offered`).
    pub fn offered(&self, kind: &str, target: &str) -> Option<&ActionDef> {
        self.sections.iter().flat_map(|s| &s.items).flat_map(|i| &i.actions).find(|a| a.kind == kind && a.target == target)
    }
}

/// One thing the phone asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: String,
    pub pill_id: String,
    pub kind: String,
    pub target: String,
    pub requested_at_ms: u64,
}

// ── Failures ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Failure {
    status: u16,
    message: String,
}

fn fail(message: &str) -> Failure {
    Failure { status: 0, message: message.into() }
}

/// Coucou `ServiceAPI.describe`, with Abito's name.
fn describe(f: &Failure) -> String {
    match f.status {
        401 => {
            if f.message.to_lowercase().contains("restricted") {
                "This key can only send emails. Use a Full access key in Abito's Settings on your Mac to see them here.".into()
            } else {
                "The key was refused (401). Check it in Abito's Settings on your Mac.".into()
            }
        }
        403 => format!("Not allowed with this key (403). {}", f.message),
        404 => "Not found (404).".into(),
        status => {
            if f.message.is_empty() {
                format!("Error {status}")
            } else {
                f.message.chars().take(160).collect()
            }
        }
    }
}

fn secret(store: &dyn SecretStore, name: &str, service: &str) -> Result<String, Failure> {
    store
        .read(name)
        .ok()
        .flatten()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| fail(&format!("No {service} key on your Mac. Add it in Abito's Settings.")))
}

/// Coucou `request`: JSON in, JSON out; an empty body is `{}`; a refusal carries the service's own message.
fn call(http: &dyn Http, method: &str, url: &str, headers: &[(&str, &str)], body: Option<Value>) -> Result<Value, Failure> {
    let mut all: Vec<(&str, &str)> = headers.to_vec();
    let text = body.map(|b| b.to_string());
    if text.is_some() {
        all.push(("Content-Type", "application/json"));
    }
    let response = http.send(method, url, &all, text.as_deref()).map_err(|_| fail("Couldn't reach the service."))?;
    if !(200..300).contains(&response.status) {
        let json: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
        let message = json
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| json.get("error").and_then(|e| e.get("message")).and_then(Value::as_str))
            .or_else(|| json.get("error").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| response.body.chars().take(200).collect());
        return Err(Failure { status: response.status, message });
    }
    if response.body.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&response.body).map_err(|_| fail("Unexpected answer from the service."))
}

// ── Small helpers ─────────────────────────────────────────────────────────────

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    }
}

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// A string or integer id as text.
fn id_text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(t) => Some(t.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// A plain token that may sit in a URL path: never `/`, `..`, whitespace or anything exotic.
fn safe(segment: &str) -> bool {
    !segment.is_empty() && segment != "." && segment != ".." && segment.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn encode(text: &str, keep: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) || keep.as_bytes().contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// RFC 3339 / ISO 8601 with optional fraction and offset → milliseconds.
fn parse_iso_ms(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b't' || b[10] == b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |a: usize, z: usize| text.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut rest = &text[19..];
    let mut millis = 0;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
        millis = format!("{digits:0<3}")[..3].parse::<i64>().ok()?;
        rest = &frac[digits.len()..];
    }
    let offset = match rest {
        "" | "Z" | "z" => 0,
        r if (r.starts_with('+') || r.starts_with('-')) && r.len() >= 3 => {
            let sign = if r.starts_with('-') { -1 } else { 1 };
            let hh = r.get(1..3)?.parse::<i64>().ok()?;
            let mm = r.get(3..)?.trim_start_matches(':').parse::<i64>().unwrap_or(0);
            sign * (hh * 3600 + mm * 60)
        }
        _ => return None,
    };
    Some(((days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se - offset) * 1000) + millis)
}

/// Coucou `date(_)`: epoch seconds or milliseconds, or an ISO string.
fn date(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => {
            let x = n.as_f64()?;
            Some(if x > 1e11 { x as i64 } else { (x * 1000.0) as i64 })
        }
        Value::String(t) => parse_iso_ms(t),
        _ => None,
    }
}

fn tone_if(count: usize, tone: Tone) -> Tone {
    if count > 0 { tone } else { Tone::Idle }
}

fn action(kind: &str, title: &str, symbol: &str, target: String, destructive: bool, confirm: Option<String>) -> ActionDef {
    ActionDef { kind: kind.into(), title: title.into(), symbol: symbol.into(), target, destructive, confirm }
}

// ── Reading ───────────────────────────────────────────────────────────────────

/// The detail of one service; never fails — a problem becomes `detail.error` (Coucou `detail(for:)`).
pub fn detail_for(pill_id: &str, http: &dyn Http, store: &dyn SecretStore, now: u64) -> Detail {
    let result = match pill_id {
        "integration_vercel" => vercel(http, store, now),
        "integration_github" => github(http, store, now),
        "integration_n8n" => n8n(http, store, now),
        _ => Err(fail("Not available from the iPhone yet.")),
    };
    result.unwrap_or_else(|f| Detail { error: Some(describe(&f)), ..Detail::empty(pill_id, now) })
}

fn vercel_headers(store: &dyn SecretStore) -> Result<Vec<(&'static str, String)>, Failure> {
    let token = secret(store, "vercel-token", "Vercel")?;
    Ok(vec![("Authorization", format!("Bearer {token}")), ("Accept", "application/json".into())])
}

fn refs<'a>(h: &'a [(&'static str, String)]) -> Vec<(&'a str, &'a str)> {
    h.iter().map(|(k, v)| (*k, v.as_str())).collect()
}

fn vercel(http: &dyn Http, store: &dyn SecretStore, now: u64) -> Result<Detail, Failure> {
    let owned = vercel_headers(store)?;
    let headers = refs(&owned);
    let list = call(http, "GET", "https://api.vercel.com/v6/deployments?limit=20", &headers, None)?;
    let projects: Vec<Value> = call(http, "GET", "https://api.vercel.com/v9/projects?limit=20", &headers, None)
        .ok()
        .and_then(|v| v.get("projects").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let (mut ready, mut failed, mut building) = (0usize, 0usize, 0usize);
    let mut items = Vec::new();
    for d in list.get("deployments").and_then(Value::as_array).cloned().unwrap_or_default() {
        let Some(uid) = s(&d, "uid") else { continue };
        let name = s(&d, "name").unwrap_or("Deployment");
        let state = s(&d, "state").or_else(|| s(&d, "readyState")).unwrap_or("").to_uppercase();
        let target = s(&d, "target");
        let meta = d.get("meta").cloned().unwrap_or(json!({}));
        let message = s(&meta, "githubCommitMessage").unwrap_or("");
        let branch = s(&meta, "githubCommitRef").unwrap_or("");
        let creator = d.get("creator").and_then(|c| s(c, "username")).unwrap_or("");
        let mut tone = Tone::Idle;
        let mut actions = Vec::new();
        let redeploy = || action("vercel.redeploy", "Redeploy", "arrow.clockwise", format!("{uid}|{name}|{}", target.unwrap_or("")), false, None);
        match state.as_str() {
            "READY" => {
                ready += 1;
                tone = Tone::Ok;
                actions.push(redeploy());
                if target != Some("production") {
                    actions.push(action(
                        "vercel.promote", "Promote to production", "arrow.up.circle", format!("{uid}|{name}"), false,
                        Some("A new production build starts from this deployment, using your production environment variables.".into()),
                    ));
                }
            }
            "ERROR" => {
                failed += 1;
                tone = Tone::Error;
                actions.push(redeploy());
            }
            "BUILDING" | "QUEUED" | "INITIALIZING" => {
                building += 1;
                tone = Tone::Warning;
                actions.push(action("vercel.cancel", "Cancel build", "xmark.circle", uid.to_string(), true, Some("Stop this build?".into())));
            }
            _ => {}
        }
        let subtitle = [branch, message.lines().next().unwrap_or(""), creator].iter().filter(|p| !p.is_empty()).cloned().collect::<Vec<_>>().join(" · ");
        items.push(Item {
            title: name.into(),
            subtitle: if subtitle.is_empty() { capitalized(&state) } else { subtitle },
            tone,
            date: date(d.get("created").or_else(|| d.get("createdAt"))),
            url: s(&d, "url").map(|u| format!("https://{u}")),
            badge: Some(if target == Some("production") { "Production".into() } else if state == "READY" { "Preview".into() } else { capitalized(&state) }),
            actions,
        });
    }
    let project_items: Vec<Item> = projects
        .iter()
        .take(20)
        .map(|p| Item {
            title: s(p, "name").unwrap_or("Project").into(),
            subtitle: s(p, "framework").map(capitalized).unwrap_or_default(),
            tone: Tone::Idle,
            date: date(p.get("updatedAt")),
            url: None,
            badge: None,
            actions: vec![],
        })
        .collect();
    let mut sections = vec![Section { title: "Deployments".into(), items, footer: None }];
    if !project_items.is_empty() {
        sections.push(Section { title: format!("Projects · {}", project_items.len()), items: project_items, footer: None });
    }
    let stat = |label: &str, value: usize, tone: Tone| Stat { label: label.into(), value: value.to_string(), tone };
    Ok(Detail {
        stats: vec![stat("Ready", ready, Tone::Ok), stat("Building", building, tone_if(building, Tone::Warning)), stat("Failed", failed, tone_if(failed, Tone::Error)), stat("Projects", projects.len(), Tone::Idle)],
        sections,
        ..Detail::empty("integration_vercel", now)
    })
}

fn github_headers(store: &dyn SecretStore) -> Result<Vec<(&'static str, String)>, Failure> {
    let token = secret(store, "github-token", "GitHub")?;
    Ok(vec![
        ("Authorization", format!("Bearer {token}")),
        ("Accept", "application/vnd.github+json".into()),
        ("X-GitHub-Api-Version", "2022-11-28".into()),
    ])
}

fn github(http: &dyn Http, store: &dyn SecretStore, now: u64) -> Result<Detail, Failure> {
    let owned = github_headers(store)?;
    let headers = refs(&owned);
    let user = call(http, "GET", "https://api.github.com/user", &headers, None)?;
    let login = s(&user, "login").unwrap_or("").to_string();
    let search = |query: String| -> Vec<Value> {
        let url = format!("https://api.github.com/search/issues?q={}&per_page=10&sort=updated", encode(&query, ":"));
        call(http, "GET", &url, &headers, None).ok().and_then(|v| v.get("items").and_then(Value::as_array).cloned()).unwrap_or_default()
    };
    let pull_ref = |item: &Value| -> Option<String> {
        let repo_url = s(item, "repository_url")?;
        let number = item.get("number")?.as_i64()?;
        let parts: Vec<&str> = repo_url.split('/').collect();
        (parts.len() >= 2).then(|| format!("{}/{}#{number}", parts[parts.len() - 2], parts[parts.len() - 1]))
    };
    let mine = search(format!("is:pr is:open author:{login} archived:false"));
    let asked = search(format!("is:pr is:open review-requested:{login} archived:false"));
    let mine_items: Vec<Item> = mine
        .iter()
        .filter_map(|item| {
            let r = pull_ref(item)?;
            let draft = item.get("draft").and_then(Value::as_bool).unwrap_or(false);
            Some(Item {
                title: s(item, "title").unwrap_or("Pull request").into(),
                subtitle: r.clone(),
                tone: if draft { Tone::Idle } else { Tone::Info },
                date: date(item.get("updated_at")),
                url: s(item, "html_url").map(str::to_string),
                badge: draft.then(|| "Draft".to_string()),
                actions: if draft { vec![] } else { vec![action("github.merge", "Squash and merge", "arrow.triangle.merge", r.clone(), false, Some(format!("Merge {r} into its base branch?")))] },
            })
        })
        .collect();
    let asked_items: Vec<Item> = asked
        .iter()
        .filter_map(|item| {
            let r = pull_ref(item)?;
            let author = item.get("user").and_then(|u| s(u, "login")).unwrap_or("");
            Some(Item {
                title: s(item, "title").unwrap_or("Pull request").into(),
                subtitle: if author.is_empty() { r.clone() } else { format!("{r} · {author}") },
                tone: Tone::Warning,
                date: date(item.get("updated_at")),
                url: s(item, "html_url").map(str::to_string),
                badge: None,
                actions: vec![action("github.approve", "Approve", "checkmark.seal", r, false, None)],
            })
        })
        .collect();
    let repos: Vec<String> = call(http, "GET", "https://api.github.com/user/repos?sort=pushed&per_page=5&affiliation=owner,collaborator", &headers, None)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|r| s(r, "full_name").map(str::to_string))
        .collect();
    let mut run_items = Vec::new();
    let mut failing = 0usize;
    for repo in &repos {
        let url = format!("https://api.github.com/repos/{repo}/actions/runs?per_page=3");
        let runs = call(http, "GET", &url, &headers, None).ok().and_then(|v| v.get("workflow_runs").and_then(Value::as_array).cloned()).unwrap_or_default();
        for run in runs {
            let Some(id) = run.get("id").and_then(Value::as_i64) else { continue };
            let status = s(&run, "status").unwrap_or("");
            let conclusion = s(&run, "conclusion").unwrap_or("");
            let mut tone = Tone::Idle;
            let mut actions = Vec::new();
            if status != "completed" {
                tone = Tone::Warning;
            } else if conclusion == "success" {
                tone = Tone::Ok;
            } else if conclusion == "failure" || conclusion == "timed_out" {
                tone = Tone::Error;
                failing += 1;
                actions.push(action("github.rerun", "Re-run failed jobs", "arrow.clockwise", format!("{repo}/{id}"), false, None));
            }
            let label = if status == "completed" { conclusion } else { status }.replace('_', " ");
            run_items.push(Item {
                title: s(&run, "name").unwrap_or("Workflow").into(),
                subtitle: format!("{repo} · {}", s(&run, "head_branch").unwrap_or("")),
                tone,
                date: date(run.get("created_at")),
                url: s(&run, "html_url").map(str::to_string),
                badge: Some(capitalized(&label)),
                actions,
            });
        }
    }
    let mut sections = Vec::new();
    let (mine_count, asked_count) = (mine_items.len(), asked_items.len());
    if !asked_items.is_empty() {
        sections.push(Section { title: "Reviews asked of you".into(), items: asked_items, footer: None });
    }
    sections.push(Section {
        title: "Your pull requests".into(),
        footer: mine_items.is_empty().then(|| "No open pull request.".to_string()),
        items: mine_items,
    });
    if !run_items.is_empty() {
        sections.push(Section { title: "CI on your latest repos".into(), items: run_items, footer: None });
    }
    let stat = |label: &str, value: usize, tone: Tone| Stat { label: label.into(), value: value.to_string(), tone };
    Ok(Detail {
        stats: vec![
            stat("Your PRs", mine_count, Tone::Info),
            stat("Reviews", asked_count, tone_if(asked_count, Tone::Warning)),
            stat("CI failing", failing, if failing > 0 { Tone::Error } else { Tone::Ok }),
        ],
        sections,
        ..Detail::empty("integration_github", now)
    })
}

/// (key, base URL without a trailing slash) for n8n; the address must pass the same safety rule as the poller.
fn n8n_access(store: &dyn SecretStore) -> Result<(String, String), Failure> {
    let key = secret(store, "n8n-api-key", "n8n")?;
    let raw = secret(store, "n8n-url", "n8n")?;
    let base = n8n_base(&raw).ok_or_else(|| fail("The n8n address on your Mac isn't safe to use. Use https, or http on localhost."))?;
    Ok((key, base))
}

fn n8n(http: &dyn Http, store: &dyn SecretStore, now: u64) -> Result<Detail, Failure> {
    let (key, base) = n8n_access(store)?;
    let headers = [("X-N8N-API-KEY", key.as_str()), ("Accept", "application/json")];
    let mut workflows: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut url = format!("{base}/api/v1/workflows?limit=250");
        if let Some(c) = &cursor {
            url.push_str(&format!("&cursor={}", encode(c, "")));
        }
        let page = call(http, "GET", &url, &headers, None)?;
        workflows.extend(page.get("data").and_then(Value::as_array).cloned().unwrap_or_default());
        cursor = s(&page, "nextCursor").filter(|c| !c.is_empty()).map(str::to_string);
        if cursor.is_none() || workflows.len() >= 5_000 {
            break;
        }
    }
    let mut names: HashMap<String, String> = HashMap::new();
    let mut active = 0usize;
    let mut workflow_items: Vec<Item> = Vec::new();
    for w in &workflows {
        let Some(id) = id_text(w.get("id")) else { continue };
        let name = s(w, "name").unwrap_or("Workflow").to_string();
        names.insert(id.clone(), name.clone());
        if w.get("isArchived").and_then(Value::as_bool).unwrap_or(false) {
            continue; // archived workflows are listed but can't be turned on
        }
        let is_active = w.get("active").and_then(Value::as_bool).unwrap_or(false);
        if is_active {
            active += 1;
        }
        let act = if is_active {
            action("n8n.deactivate", "Turn off", "pause.circle", id.clone(), true, Some(format!("Stop {name} from running?")))
        } else {
            action("n8n.activate", "Turn on", "play.circle", id.clone(), false, None)
        };
        workflow_items.push(Item {
            title: name,
            subtitle: String::new(),
            tone: if is_active { Tone::Ok } else { Tone::Idle },
            date: date(w.get("updatedAt")),
            url: Some(format!("{base}/workflow/{id}")),
            badge: Some(if is_active { "Active" } else { "Off" }.into()),
            actions: vec![act],
        });
    }
    let executions = call(http, "GET", &format!("{base}/api/v1/executions?limit=15"), &headers, None)
        .ok()
        .and_then(|v| v.get("data").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let mut failed = 0usize;
    let mut execution_items = Vec::new();
    for e in &executions {
        let Some(id) = id_text(e.get("id")) else { continue };
        let workflow_id = id_text(e.get("workflowId")).unwrap_or_default();
        let status = s(e, "status").map(str::to_string).unwrap_or_else(|| if e.get("finished").and_then(Value::as_bool).unwrap_or(false) { "success" } else { "error" }.into());
        let is_failure = matches!(status.as_str(), "error" | "crashed" | "failed");
        if is_failure {
            failed += 1;
        }
        execution_items.push(Item {
            title: names.get(&workflow_id).cloned().unwrap_or_else(|| format!("Workflow {workflow_id}")),
            subtitle: format!("Execution {id}"),
            tone: if is_failure { Tone::Error } else if status == "success" { Tone::Ok } else { Tone::Warning },
            date: date(e.get("startedAt")),
            url: Some(format!("{base}/workflow/{workflow_id}/executions/{id}")),
            badge: Some(capitalized(&status)),
            actions: if is_failure { vec![action("n8n.retry", "Retry", "arrow.clockwise", id, false, None)] } else { vec![] },
        });
    }
    let total = workflow_items.len();
    workflow_items.sort_by_key(|i| std::cmp::Reverse(i.date.unwrap_or(i64::MIN)));
    workflow_items.truncate(50);
    let stat = |label: &str, value: usize, tone: Tone| Stat { label: label.into(), value: value.to_string(), tone };
    Ok(Detail {
        stats: vec![stat("Workflows", total, Tone::Idle), stat("Active", active, Tone::Ok), stat("Failed runs", failed, tone_if(failed, Tone::Error))],
        sections: vec![
            Section { title: "Latest runs".into(), items: execution_items, footer: None },
            Section { title: "Workflows".into(), items: workflow_items, footer: None },
        ],
        ..Detail::empty("integration_n8n", now)
    })
}

// ── Acting ────────────────────────────────────────────────────────────────────

/// Runs one action and returns the short line for the phone (Coucou `ServiceAPI.perform`).
fn perform(kind: &str, target: &str, http: &dyn Http, store: &dyn SecretStore) -> Result<String, Failure> {
    let url_of = |json: &Value| s(json, "url").map(str::to_string);
    match kind {
        "vercel.redeploy" | "vercel.promote" => {
            let parts: Vec<&str> = target.split('|').collect();
            let want = if kind == "vercel.redeploy" { 3 } else { 2 };
            if parts.len() != want {
                return Err(fail("Unknown deployment"));
            }
            let owned = vercel_headers(store)?;
            let body = if kind == "vercel.redeploy" {
                let mut m = Map::new();
                m.insert("name".into(), json!(parts[1]));
                m.insert("deploymentId".into(), json!(parts[0]));
                if !parts[2].is_empty() {
                    m.insert("target".into(), json!(parts[2]));
                }
                Value::Object(m)
            } else {
                // Vercel only promotes production builds in place: a preview is rebuilt for production, as `vercel promote` does.
                json!({"deploymentId": parts[0], "name": parts[1], "target": "production", "meta": {"action": "promote"}})
            };
            let answer = call(http, "POST", "https://api.vercel.com/v13/deployments", &refs(&owned), Some(body))?;
            Ok(match (url_of(&answer), kind) {
                (Some(u), "vercel.redeploy") => format!("Building {u}"),
                (Some(u), _) => format!("Building {u} for production"),
                (None, "vercel.redeploy") => "New deployment started".into(),
                (None, _) => "Production build started".into(),
            })
        }
        "vercel.cancel" => {
            if !safe(target) {
                return Err(fail("Unknown deployment"));
            }
            let owned = vercel_headers(store)?;
            call(http, "PATCH", &format!("https://api.vercel.com/v12/deployments/{target}/cancel"), &refs(&owned), None)?;
            Ok("Build canceled".into())
        }
        "github.rerun" => {
            // "owner/repo/123"
            let parts: Vec<&str> = target.split('/').collect();
            if parts.len() != 3 || !safe(parts[0]) || !safe(parts[1]) || !parts[2].chars().all(|c| c.is_ascii_digit()) || parts[2].is_empty() {
                return Err(fail("Unknown run"));
            }
            let owned = github_headers(store)?;
            call(http, "POST", &format!("https://api.github.com/repos/{}/{}/actions/runs/{}/rerun-failed-jobs", parts[0], parts[1], parts[2]), &refs(&owned), None)?;
            Ok("Failed jobs started again".into())
        }
        "github.approve" | "github.merge" => {
            // "owner/repo#12"
            let pieces: Vec<&str> = target.split('#').collect();
            let repo: Vec<&str> = pieces.first().map(|p| p.split('/').collect()).unwrap_or_default();
            if pieces.len() != 2 || repo.len() != 2 || !safe(repo[0]) || !safe(repo[1]) || pieces[1].is_empty() || !pieces[1].chars().all(|c| c.is_ascii_digit()) {
                return Err(fail("Unknown pull request"));
            }
            let owned = github_headers(store)?;
            if kind == "github.approve" {
                call(http, "POST", &format!("https://api.github.com/repos/{}/pulls/{}/reviews", pieces[0], pieces[1]), &refs(&owned), Some(json!({"event": "APPROVE"})))?;
                return Ok("Approved".into());
            }
            call(http, "PUT", &format!("https://api.github.com/repos/{}/pulls/{}/merge", pieces[0], pieces[1]), &refs(&owned), Some(json!({"merge_method": "squash"})))?;
            Ok("Merged".into())
        }
        "n8n.activate" | "n8n.deactivate" | "n8n.retry" => {
            if !safe(target) {
                return Err(fail("This action isn't available"));
            }
            let (key, base) = n8n_access(store)?;
            let headers = [("X-N8N-API-KEY", key.as_str()), ("Accept", "application/json")];
            match kind {
                "n8n.activate" => {
                    call(http, "POST", &format!("{base}/api/v1/workflows/{target}/activate"), &headers, None)?;
                    Ok("Turned on".into())
                }
                "n8n.deactivate" => {
                    call(http, "POST", &format!("{base}/api/v1/workflows/{target}/deactivate"), &headers, None)?;
                    Ok("Turned off".into())
                }
                _ => match call(http, "POST", &format!("{base}/api/v1/executions/{target}/retry"), &headers, None) {
                    Ok(_) => Ok("Running again".into()),
                    // POST /api/v1/executions/{id}/retry only exists from n8n 1.112.0.
                    Err(f) if f.status == 404 || f.status == 405 => Err(fail("Couldn't retry this run. It may have been deleted, or your n8n is older than 1.112, which is needed to retry from the iPhone.")),
                    Err(f) => Err(f),
                },
            }
        }
        _ => Err(fail("This action isn't available")),
    }
}

/// Keeps the last detail per service and answers the phone's requests (Coucou `ServiceDetailRunner`).
pub struct Runner {
    last: HashMap<String, Detail>,
    done: HashSet<String>,
    order: VecDeque<String>,
    /// Coucou gives the service a moment before showing where things are.
    pub pause: Duration,
}

impl Default for Runner {
    fn default() -> Self {
        Runner { last: HashMap::new(), done: HashSet::new(), order: VecDeque::new(), pause: Duration::from_secs(2) }
    }
}

impl Runner {
    /// Stops: forgets every detail and every request id (Coucou `stop()`).
    pub fn forget(&mut self) {
        self.last.clear();
        self.done.clear();
        self.order.clear();
    }

    fn take_once(&mut self, id: &str) -> bool {
        if !self.done.insert(id.to_string()) {
            return false;
        }
        self.order.push_back(id.to_string());
        while self.order.len() > SEEN_CAP {
            if let Some(old) = self.order.pop_front() {
                self.done.remove(&old);
            }
        }
        true
    }

    /// Handles a batch of phone requests; returns the details to publish, in order.
    pub fn handle(&mut self, mut requests: Vec<Request>, now_ms: u64, http: &dyn Http, store: &dyn SecretStore) -> Vec<Detail> {
        requests.sort_by_key(|r| r.requested_at_ms);
        let mut out = Vec::new();
        let mut refreshed: HashSet<String> = HashSet::new();
        for r in requests {
            if now_ms >= r.requested_at_ms.saturating_add(MAX_AGE_MS) || !PHONE_SERVICES.contains(&r.pill_id.as_str()) || !self.take_once(&r.id) {
                continue;
            }
            if r.kind == REFRESH {
                if !refreshed.insert(r.pill_id.clone()) {
                    continue;
                }
                let previous = self.last.get(&r.pill_id).and_then(|d| d.last_action.clone());
                out.push(self.publish(&r.pill_id, previous, now_ms, http, store));
            } else {
                out.push(self.run(&r, now_ms, http, store));
            }
        }
        out
    }

    fn run(&mut self, r: &Request, now_ms: u64, http: &dyn Http, store: &dyn SecretStore) -> Detail {
        let prefix = format!("{}.", r.pill_id.replace("integration_", ""));
        let offered = self.last.get(&r.pill_id).and_then(|d| d.offered(&r.kind, &r.target)).cloned();
        let Some(offered) = offered.filter(|_| ALLOWED_KINDS.contains(&r.kind.as_str()) && r.kind.starts_with(&prefix)) else {
            let result = ActionResult { title: "Not done".into(), ok: false, message: "This action isn't offered any more. The list was refreshed.".into(), date: now_ms };
            return self.publish(&r.pill_id, Some(result), now_ms, http, store);
        };
        let result = match perform(&r.kind, &r.target, http, store) {
            Ok(message) => ActionResult { title: offered.title, ok: true, message, date: now_ms },
            Err(f) => ActionResult { title: offered.title, ok: false, message: describe(&f), date: now_ms },
        };
        if !self.pause.is_zero() {
            std::thread::sleep(self.pause);
        }
        self.publish(&r.pill_id, Some(result), now_ms, http, store)
    }

    fn publish(&mut self, pill_id: &str, last_action: Option<ActionResult>, now_ms: u64, http: &dyn Http, store: &dyn SecretStore) -> Detail {
        let mut detail = detail_for(pill_id, http, store, now_ms);
        detail.last_action = last_action;
        self.last.insert(pill_id.to_string(), detail.clone());
        detail
    }
}

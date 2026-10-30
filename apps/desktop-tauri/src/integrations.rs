//! #489 integration pollers: n8n and Vercel (more services follow in later slices). Pure and
//! network-free: every poller takes an [`Http`] seam and the key store, and returns the
//! [`Update`] the island card consumes. The host (`integrationshost.rs`) owns the real HTTP
//! client, the timers and the event emission.
//!
//! Adapted from Coucou windows/src-tauri/src/integrations.rs @71b773f, Copyright (c) 2026 Louis
//! Raillé, MIT. Differences: the HTTP client and the key store are injected (no network in
//! tests), Spanish messages, the n8n base URL must pass `files::n8n_url` (https, or loopback
//! http, no credentials) before any request is made, and a service polls only when the human
//! declared its pill and saved its key.
use crate::secrets::SecretStore;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

#[cfg(test)]
#[path = "integrations_tests.rs"]
mod tests;

/// Island event carrying one [`Update`].
pub const UPDATE_EVENT: &str = "integration:update";

/// A finished HTTP exchange; the body is already size-capped by the client.
#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

/// Why no response arrived (connection, TLS, timeout). Carries no URL on purpose: a
/// self-hosted base URL can hold a secret path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetError(pub String);

/// The HTTP seam. `send` takes GET, POST, PUT or PATCH (anything else is refused by the real
/// client); `get` and `post_json` are conveniences over it.
pub trait Http {
    fn send(&self, method: &str, url: &str, headers: &[(&str, &str)], body: Option<&str>) -> Result<Response, NetError>;
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response, NetError> {
        self.send("GET", url, headers, None)
    }
    fn post_json(&self, url: &str, headers: &[(&str, &str)], body: &str) -> Result<Response, NetError> {
        self.send("POST", url, headers, Some(body))
    }
}

/// What the island receives. `event` is set only when something actually changed: it drives
/// the pill badge and the sound.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub id: &'static str,
    pub data: Value,
    pub error: Option<String>,
    pub event: Option<Event>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub success: bool,
    pub label: String,
    pub detail: Option<String>,
}

pub const N8N: &str = "integration_n8n";
pub const VERCEL: &str = "integration_vercel";

/// (pill id, first-run delay s, interval s): Coucou's cadence.
pub const STRIPE: &str = "integration_stripe";
pub const RESEND: &str = "integration_resend";
pub const NOTION: &str = "integration_notion";
pub const CALCOM: &str = "integration_calcom";

pub const POLLERS: [(&str, u64, u64); 6] =
    [(N8N, 3, 15), (VERCEL, 5, 30), (STRIPE, 6, 30), (RESEND, 6, 60), (CALCOM, 8, 300), (NOTION, 9, 300)];

/// Remembers the newest id per service so an event fires once, not on every poll. The very
/// first load only fills the card.
#[derive(Default)]
pub struct Seen(Mutex<HashMap<&'static str, String>>);

impl Seen {
    pub fn is_new(&self, key: &'static str, id: &str) -> bool {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match map.insert(key, id.to_string()) {
            Some(previous) => previous != id,
            None => false,
        }
    }
    pub fn forget(&self, key: &'static str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
    }
}

fn key(store: &dyn SecretStore, name: &str) -> Option<String> {
    store.read(name).ok().flatten().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// The card's error line for a refused request.
pub fn status_error(code: u16, forbidden_hint: &str) -> String {
    match code {
        401 => "Clave de API no válida (401)".to_string(),
        403 => forbidden_hint.to_string(),
        _ => format!("Error de API {code}"),
    }
}

fn failed(id: &'static str, error: String) -> Update {
    Update { id, data: json!({}), error: Some(error), event: None }
}

/// Runs the poller for `id`; `None` when the service is unknown, has no key, or has nothing
/// to say this round.
pub fn poll(id: &str, http: &dyn Http, store: &dyn SecretStore, seen: &Seen) -> Option<Update> {
    match id {
        N8N => poll_n8n(http, store, seen),
        VERCEL => poll_vercel(http, store, seen),
        STRIPE => poll_stripe(http, store, seen),
        RESEND => poll_resend(http, store),
        NOTION => poll_notion(http, store),
        CALCOM => poll_calcom(http, store),
        _ => None,
    }
}

// ── Vercel ────────────────────────────────────────────────────────────────────

pub fn poll_vercel(http: &dyn Http, store: &dyn SecretStore, seen: &Seen) -> Option<Update> {
    let token = key(store, "vercel-token")?;
    let auth = format!("Bearer {token}");
    let response = http
        .get("https://api.vercel.com/v6/deployments?limit=5", &[("Authorization", &auth), ("Accept", "application/json")])
        .ok()?;
    if !(200..300).contains(&response.status) {
        return Some(failed(VERCEL, status_error(response.status, "El token no tiene acceso")));
    }
    let json: Value = serde_json::from_str(&response.body).unwrap_or(json!({}));
    let deployments = vercel_deployments(&json);
    let event = deployments.first().and_then(|latest| {
        let id = latest.get("id")?.as_str()?;
        if !seen.is_new("vercel", id) {
            return None;
        }
        Some(Event {
            success: latest.get("state")?.as_str()? == "READY",
            label: latest.get("projectName")?.as_str()?.to_string(),
            detail: None,
        })
    });
    Some(Update { id: VERCEL, data: json!({ "deployments": deployments }), error: None, event })
}

/// Only finished deployments (READY, ERROR, CANCELED), newest first as Vercel sends them.
pub fn vercel_deployments(json: &Value) -> Vec<Value> {
    const TERMINAL: [&str; 3] = ["READY", "ERROR", "CANCELED"];
    let Some(list) = json.get("deployments").and_then(Value::as_array) else { return vec![] };
    list.iter()
        .filter_map(|d| {
            let state = d.get("state")?.as_str()?;
            if !TERMINAL.contains(&state) {
                return None;
            }
            let meta = d.get("meta");
            let pick = |keys: [&str; 3]| {
                meta.and_then(|m| keys.iter().find_map(|k| m.get(*k).and_then(Value::as_str))).map(str::to_string)
            };
            Some(json!({
                "id": d.get("uid")?.as_str()?,
                "projectName": d.get("name")?.as_str()?,
                "url": d.get("url").and_then(Value::as_str).unwrap_or(""),
                "state": state,
                "createdAt": d.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0),
                "commitMessage": pick(["githubCommitMessage", "gitlabCommitMessage", "bitbucketCommitMessage"]),
                "branch": pick(["githubCommitRef", "gitlabCommitRef", "bitbucketBranch"]),
            }))
        })
        .collect()
}

// ── n8n ───────────────────────────────────────────────────────────────────────

/// The validated base URL, no trailing slash. `None` for anything `files::n8n_url` refuses.
pub fn n8n_base(raw: &str) -> Option<String> {
    crate::files::n8n_url(raw.trim()).map(|u| u.trim_end_matches('/').to_string())
}

fn n8n_get(http: &dyn Http, url: &str, api_key: &str) -> Option<Value> {
    let response = http.get(url, &[("X-N8N-API-KEY", api_key), ("Accept", "application/json")]).ok()?;
    if !(200..300).contains(&response.status) {
        return None;
    }
    serde_json::from_str(&response.body).ok()
}

pub fn poll_n8n(http: &dyn Http, store: &dyn SecretStore, seen: &Seen) -> Option<Update> {
    let api_key = key(store, "n8n-api-key")?;
    let base = n8n_base(&key(store, "n8n-url")?)?;
    // Same two shapes as the Swift poller: the public API first, then /rest.
    let mut items = None;
    for url in [
        format!("{base}/api/v1/executions?limit=1&includeData=false"),
        format!("{base}/rest/executions?limit=1&includeData=false"),
    ] {
        let Some(json) = n8n_get(http, &url, &api_key) else { continue };
        items = match &json {
            Value::Object(o) => o.get("data").and_then(Value::as_array).cloned(),
            Value::Array(a) => Some(a.clone()),
            _ => None,
        };
        if items.is_some() {
            break;
        }
    }
    let first = items?.into_iter().next()?;
    let id = match first.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => return None,
    };
    let status = first.get("status").and_then(Value::as_str).unwrap_or("");
    if !["success", "error", "crashed", "canceled", "failed"].contains(&status) || !seen.is_new("n8n", &id) {
        return None;
    }
    let success = status == "success";
    let mut name = "Workflow".to_string();
    let mut detail = None;
    for url in [
        format!("{base}/api/v1/executions/{id}?includeData=true"),
        format!("{base}/api/v1/executions/{id}"),
        format!("{base}/rest/executions/{id}?includeData=true"),
        format!("{base}/rest/executions/{id}"),
    ] {
        let Some(json) = n8n_get(http, &url, &api_key) else { continue };
        name = json
            .get("workflowData")
            .and_then(|w| w.get("name"))
            .and_then(Value::as_str)
            .or_else(|| json.get("name").and_then(Value::as_str))
            .unwrap_or("Workflow")
            .to_string();
        detail = n8n_detail(&json, success);
        break;
    }
    Some(Update {
        id: N8N,
        data: json!({ "workflow": name, "status": status }),
        error: None,
        event: Some(Event { success, label: name, detail }),
    })
}

fn n8n_detail(json: &Value, success: bool) -> Option<String> {
    let result = json.get("data")?.get("resultData")?;
    if !success {
        if let Some(error) = result.get("error") {
            let message = error.get("message").and_then(Value::as_str).unwrap_or("");
            if let Some(node) = error.get("node").and_then(|n| n.get("name")).and_then(Value::as_str) {
                if !node.is_empty() {
                    return Some(format!("{node}\n{message}"));
                }
            }
            return Some(message.to_string());
        }
        for (node, value) in result.get("runData")?.as_object()? {
            if let Some(message) = value
                .as_array()
                .and_then(|a| a.first())
                .and_then(|r| r.get("error"))
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
            {
                return Some(format!("{node}\n{message}"));
            }
        }
        return None;
    }
    let last_node = result.get("lastNodeExecuted")?.as_str()?;
    let items = result
        .get("runData")?
        .get(last_node)?
        .as_array()?
        .first()?
        .get("data")?
        .get("main")?
        .as_array()?
        .first()?
        .as_array()?;
    let count = items.len();
    let header = format!("→ {last_node} · {count} item{}", if count == 1 { "" } else { "s" });
    let fields = items
        .first()
        .and_then(|i| i.get("json"))
        .and_then(Value::as_object)
        .map(|obj| obj.iter().take(4).map(|(k, v)| format!("{k}: {}", fmt_value(v))).collect::<Vec<_>>().join("\n"))
        .filter(|s| !s.is_empty());
    Some(match fields {
        Some(f) => format!("{header}\n{f}"),
        None => header,
    })
}

fn fmt_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.chars().take(50).collect(),
        Value::Array(a) => format!("[{}]", a.len()),
        Value::Object(_) => "{…}".into(),
        other => other.to_string(),
    }
}

// ── Stripe ────────────────────────────────────────────────────────────────────

fn ok(r: &Response) -> bool {
    (200..300).contains(&r.status)
}

pub fn poll_stripe(http: &dyn Http, store: &dyn SecretStore, seen: &Seen) -> Option<Update> {
    use base64::Engine;
    let secret = key(store, "stripe-api-key")?;
    let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{secret}:")));
    let headers = [("Authorization", auth.as_str())];
    let balance = match http.get("https://api.stripe.com/v1/balance", &headers) {
        Ok(r) if ok(&r) => serde_json::from_str::<Value>(&r.body).unwrap_or(json!({})),
        Ok(r) => return Some(failed(STRIPE, status_error(r.status, "Usá una clave secreta (sk_live_…, no pk_live_…)"))),
        Err(e) => return Some(failed(STRIPE, format!("Sin conexión: {}", e.0))),
    };
    let buckets: Vec<&Value> = ["available", "pending"]
        .iter()
        .filter_map(|k| balance.get(*k).and_then(Value::as_array))
        .flatten()
        .collect();
    let currency = buckets.first().and_then(|b| b.get("currency")).and_then(Value::as_str).unwrap_or("eur").to_string();
    let amount: i64 = buckets.iter().filter_map(|b| b.get("amount").and_then(Value::as_i64)).sum();
    let charges = http.get("https://api.stripe.com/v1/charges?limit=3", &headers).ok().filter(ok)?;
    let json: Value = serde_json::from_str(&charges.body).unwrap_or(json!({}));
    let payments: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|c| {
                    let description = c
                        .get("description")
                        .and_then(Value::as_str)
                        .or_else(|| c.get("billing_details").and_then(|b| b.get("name")).and_then(Value::as_str));
                    Some(json!({
                        "id": c.get("id")?.as_str()?,
                        "amount": c.get("amount")?.as_i64()?,
                        "currency": c.get("currency")?.as_str()?,
                        "description": description,
                        "createdAt": c.get("created").and_then(Value::as_i64).unwrap_or(0) * 1000,
                        "status": c.get("status").and_then(Value::as_str).unwrap_or("succeeded"),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    let newest = payments.first().and_then(|p| p.get("id")).and_then(Value::as_str).unwrap_or("");
    let event = if !newest.is_empty() && seen.is_new("stripe", newest) {
        let label = payments[0].get("description").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| {
            format!("{:.2}", payments[0].get("amount").and_then(Value::as_i64).unwrap_or(0) as f64 / 100.0)
        });
        Some(Event { success: true, label, detail: None })
    } else {
        None
    };
    Some(Update { id: STRIPE, data: json!({ "balance": amount, "currency": currency, "payments": payments }), error: None, event })
}

// ── Resend ────────────────────────────────────────────────────────────────────

pub fn poll_resend(http: &dyn Http, store: &dyn SecretStore) -> Option<Update> {
    let secret = key(store, "resend-api-key")?;
    let auth = format!("Bearer {secret}");
    let r = http.get("https://api.resend.com/emails?limit=100", &[("Authorization", &auth), ("Accept", "application/json")]).ok()?;
    if !ok(&r) {
        return Some(failed(RESEND, status_error(r.status, "La clave no tiene acceso")));
    }
    let json: Value = serde_json::from_str(&r.body).unwrap_or(json!({}));
    let total = json.get("total").or_else(|| json.get("count")).and_then(Value::as_i64);
    let emails: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(5)
                .filter_map(|e| {
                    let to = match e.get("to") {
                        Some(Value::Array(a)) => a.clone(),
                        Some(Value::String(s)) => vec![Value::String(s.clone())],
                        _ => vec![],
                    };
                    Some(json!({
                        "id": e.get("id")?.as_str()?,
                        "to": to,
                        "subject": e.get("subject").and_then(Value::as_str).unwrap_or(""),
                        "createdAt": e.get("created_at").and_then(Value::as_str).unwrap_or(""),
                        "lastEvent": e.get("last_event").and_then(Value::as_str).unwrap_or(""),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Update { id: RESEND, data: json!({ "emails": emails, "total": total }), error: None, event: None })
}

// ── Notion ────────────────────────────────────────────────────────────────────

pub fn poll_notion(http: &dyn Http, store: &dyn SecretStore) -> Option<Update> {
    let token = key(store, "notion-api-key")?;
    let auth = format!("Bearer {token}");
    let body = json!({ "sort": { "direction": "descending", "timestamp": "last_edited_time" }, "page_size": 3 }).to_string();
    let r = http
        .post_json(
            "https://api.notion.com/v1/search",
            &[("Authorization", &auth), ("Notion-Version", "2022-06-28"), ("Content-Type", "application/json")],
            &body,
        )
        .ok()?;
    if !ok(&r) {
        return Some(failed(NOTION, status_error(r.status, "La integración no tiene acceso")));
    }
    let json: Value = serde_json::from_str(&r.body).unwrap_or(json!({}));
    let pages: Vec<Value> = json
        .get("results")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(notion_page).collect())
        .unwrap_or_default();
    Some(Update { id: NOTION, data: json!({ "pages": pages }), error: None, event: None })
}

fn notion_page(obj: &Value) -> Option<Value> {
    let id = obj.get("id")?.as_str()?;
    let first_text = |v: Option<&Value>| {
        v.and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|t| t.get("plain_text"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let mut title = "Sin título".to_string();
    if obj.get("object").and_then(Value::as_str) == Some("database") {
        if let Some(t) = first_text(obj.get("title")) {
            title = t;
        }
    } else if let Some(props) = obj.get("properties").and_then(Value::as_object) {
        if let Some(t) = props
            .values()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("title"))
            .find_map(|p| first_text(p.get("title")))
        {
            title = t;
        }
    }
    let emoji = obj
        .get("icon")
        .filter(|i| i.get("type").and_then(Value::as_str) == Some("emoji"))
        .and_then(|i| i.get("emoji"))
        .and_then(Value::as_str);
    Some(json!({
        "id": id,
        "title": title,
        "emoji": emoji,
        "lastEditedAt": obj.get("last_edited_time").and_then(Value::as_str)?,
        "url": obj.get("url").and_then(Value::as_str).unwrap_or("https://notion.so"),
    }))
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

pub fn poll_calcom(http: &dyn Http, store: &dyn SecretStore) -> Option<Update> {
    let secret = key(store, "calcom-api-key")?;
    let auth = format!("Bearer {secret}");
    let r = http
        .get("https://api.cal.com/v2/bookings?status=upcoming", &[("Authorization", &auth), ("cal-api-version", "2024-08-13")])
        .ok()?;
    if !ok(&r) {
        return Some(failed(CALCOM, status_error(r.status, "La clave no tiene acceso")));
    }
    let json: Value = serde_json::from_str(&r.body).unwrap_or(json!({}));
    let bookings: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|b| {
                    let start = b.get("start").or_else(|| b.get("startTime")).and_then(Value::as_str)?;
                    let attendee = b.get("attendees").and_then(Value::as_array).and_then(|a| a.first());
                    let notes = b
                        .get("responses")
                        .and_then(|r| r.get("notes"))
                        .and_then(|n| n.get("value"))
                        .and_then(Value::as_str)
                        .or_else(|| b.get("description").and_then(Value::as_str))
                        .filter(|s| !s.is_empty());
                    Some(json!({
                        "id": b.get("id").map(|v| v.to_string()).unwrap_or_default(),
                        "title": b.get("title").and_then(Value::as_str).unwrap_or("Reunión"),
                        "start": start,
                        "status": b.get("status").and_then(Value::as_str).unwrap_or("accepted"),
                        "attendeeName": attendee.and_then(|a| a.get("name")).and_then(Value::as_str),
                        "attendeeEmail": attendee.and_then(|a| a.get("email")).and_then(Value::as_str),
                        "attendeeNotes": notes,
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Update { id: CALCOM, data: json!({ "bookings": bookings }), error: None, event: None })
}

// ── Command surface ───────────────────────────────────────────────────────────

/// `integration_action` payload: `{action:"view"}` answers every cached update;
/// `{action:"refresh", id}` polls one service now (only a declared one with a key).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    View,
    Refresh(&'static str),
}

pub fn parse_command(payload: &Value) -> Option<Command> {
    let map = payload.as_object()?;
    match map.get("action")?.as_str()? {
        "view" if map.len() == 1 => Some(Command::View),
        "refresh" if map.len() == 2 => {
            let id = map.get("id")?.as_str()?;
            POLLERS.iter().find(|(known, _, _)| *known == id).map(|(known, _, _)| Command::Refresh(known))
        }
        _ => None,
    }
}

/// True when the human put this service's pill on the island (main or declared).
pub fn declared(prefs: &crate::prefs::Prefs, id: &str) -> bool {
    prefs.main_pill() == id || prefs.declared_pills().iter().any(|p| p == id)
}

/// Snapshot envelope for the island, with explicit lifecycle metadata.
pub fn refresh_snapshot(id: &str, http: &dyn Http, store: &dyn SecretStore, seen: &Seen, previous: Option<&Value>, now: u64) -> Value {
    let required = match id {
        N8N => "n8n-api-key", VERCEL => "vercel-token", STRIPE => "stripe-api-key",
        RESEND => "resend-api-key", NOTION => "notion-api-key", CALCOM => "calcom-api-key",
        _ => return Value::Null,
    };
    if key(store, required).is_none() || (id == N8N && key(store,"n8n-url").and_then(|u|n8n_base(&u)).is_none()) {
        return json!({"id":id,"data":{},"error":null,"event":null,"state":"missing_key","updatedAt":null});
    }
    struct Observed<'a> { inner: &'a dyn Http, failed: std::cell::Cell<bool> }
    impl Http for Observed<'_> {
        fn send(&self, method: &str, url: &str, headers: &[(&str,&str)], body: Option<&str>) -> Result<Response,NetError> {
            let result = self.inner.send(method,url,headers,body);
            if result.as_ref().map(|r| !(200..300).contains(&r.status) || serde_json::from_str::<Value>(&r.body).is_err()).unwrap_or(true) {
                self.failed.set(true);
            }
            result
        }
    }
    let observed = Observed { inner:http, failed:std::cell::Cell::new(false) };
    let update = poll(id,&observed,store,seen);
    let error = update.as_ref().and_then(|u|u.error.clone());
    if let Some(update) = update.filter(|u|u.error.is_none()) {
        if !observed.failed.get() {
            let mut value = serde_json::to_value(update).unwrap_or(Value::Null);
            value["state"] = json!("ready"); value["updatedAt"] = json!(now);
            return value;
        }
    }
    let mut value = previous.filter(|v|v["id"]==id && v["updatedAt"].is_u64()).cloned()
        .unwrap_or_else(||json!({"id":id,"data":{},"updatedAt":null}));
    value["state"] = json!(if value["updatedAt"].is_u64() { "stale" } else { "error" });
    value["error"] = json!(error.unwrap_or_else(||"No se pudo actualizar la integración.".into()));
    value["event"] = Value::Null;
    // n8n may report no change after a successful request; keep its last data.
    if id == N8N && !observed.failed.get() {
        value["state"] = json!("ready"); value["error"] = Value::Null; value["updatedAt"] = json!(now);
    }
    value
}

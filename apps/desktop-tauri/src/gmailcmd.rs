//! K2-10 T4 — the closed `gmail_action` boundary: sign-in with the user's OWN Google Cloud
//! desktop client (S4), the read-only list and detail (S1, S5–S7, S9) and «Responder» through
//! the 3-OS opener (S2). Everything secret stays behind the keychain entry `gmail-oauth`
//! (`gmail_oauth`): this module never returns a token, a client secret or a client id — at
//! most a masked prefix, which is what the page needs to show WHICH client is configured.
//!
//! The shape is the house one (`oauthcmd`): a closed schema, one fixed slot for the pending
//! sign-in (replacing a flow drops its listener BEFORE binding again) and an `apply` that takes
//! everything else injected, so the whole lifecycle is testable without a window, a browser or
//! a network. Errors are stable codes (`GmailError::code`, `ApiError::code`), never text from
//! Google. Nothing here needs the Integrations pause (S11): the mail has its own entry in
//! `paused.rs` and is NOT paused, and the command is reachable from the island AND from the
//! own Ajustes window (the host gates with the shared sender gate, not `main_window_only`).
use crate::gmail_api::{self, Filter, GmailHttp};
use crate::gmail_oauth::{self, Client, GmailAuth, GmailError, Status};
use crate::secrets::SecretStore;
use serde_json::{json, Value};
use std::sync::Mutex;

#[cfg(test)]
#[path = "gmailcmd_tests.rs"]
mod tests;

/// Same bound as `gmail_api`: a message id is bounded ASCII, never a path.
pub const MAX_ID: usize = 64;
/// Largest client id / secret accepted from the page (`gmail_oauth::parse_client` is the authority).
pub const MAX_CLIENT_ID: usize = 256;
pub const MAX_CLIENT_SECRET: usize = 128;
/// Longest `mailto:` handed to the opener.
pub const MAX_MAILTO: usize = 4096;
/// Characters of the client id a masked prefix may show (enough to recognise it, useless alone).
pub const MASK_CHARS: usize = 6;

/// One closed action of the page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cmd {
    Status,
    /// The pasted desktop client (id + optional secret), already validated.
    SetClient(Client),
    Begin,
    Poll,
    Cancel,
    Forget,
    Inbox(Filter),
    Message(String),
    Reply(String),
    /// The mail counter's last visit, ms since the epoch.
    Seen(u64),
}

/// A message id `gmail_api` will accept: never empty, never a path, never anything but ASCII.
fn id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The closed schema. Exactly the documented keys per action and nothing else: an unknown
/// action, an extra key, a wrongly typed value, an oversized string or a control character is
/// refused whole (`None`), so a padded payload can never reach the keychain or the network.
pub fn parse(value: &Value) -> Option<Cmd> {
    let map = value.as_object()?;
    let action = map.get("action")?.as_str()?;
    let only = |keys: &[&str]| map.keys().all(|k| keys.contains(&k.as_str()));
    match action {
        "status" | "begin" | "poll" | "cancel" | "forget" if map.len() == 1 => Some(match action {
            "status" => Cmd::Status,
            "begin" => Cmd::Begin,
            "poll" => Cmd::Poll,
            "cancel" => Cmd::Cancel,
            _ => Cmd::Forget,
        }),
        // `parse_client` is the authority on shape (the `…apps.googleusercontent.com` suffix, the
        // bounded alphanumeric secret); the bounds here keep an oversized string out of the JSON
        // parse path as well.
        "set_client" if (2..=3).contains(&map.len()) && only(&["action", "clientId", "clientSecret"]) => {
            let id = map.get("clientId")?.as_str()?;
            if id.len() > MAX_CLIENT_ID + 8 { return None }
            let secret = match map.get("clientSecret") {
                None => None,
                Some(value) => Some(value.as_str()?),
            };
            if secret.is_some_and(|s| s.len() > MAX_CLIENT_SECRET) { return None }
            Some(Cmd::SetClient(gmail_oauth::parse_client(id, secret)?))
        }
        "inbox" if map.len() == 2 && only(&["action", "filter"]) => {
            Some(Cmd::Inbox(match map.get("filter")?.as_str()? {
                "nuevos" => Filter::Nuevos,
                "importantes" => Filter::Importantes,
                "personas" => Filter::DePersonas,
                "todos" => Filter::Todos,
                _ => return None,
            }))
        }
        "message" | "reply" if map.len() == 2 && only(&["action", "id"]) => {
            let id = map.get("id")?.as_str()?.to_owned();
            if !id_ok(&id) { return None }
            Some(if action == "message" { Cmd::Message(id) } else { Cmd::Reply(id) })
        }
        "seen" if map.len() == 2 && only(&["action", "atMs"]) => {
            // 0 is «never visited», not a visit: it could only un-count mail as new.
            let at_ms = map.get("atMs")?.as_u64()?;
            (at_ms > 0).then_some(Cmd::Seen(at_ms))
        }
        _ => None,
    }
}

/// `mailto:` is validated HERE because `desktop::validated_web_url` admits only http(s): the
/// scheme must be exactly `mailto:` and no control character or whitespace may ride along
/// (a `mailto:` cannot then smuggle a second header or a shell argument).
pub fn safe_mailto(url: &str) -> bool {
    url.len() <= MAX_MAILTO
        && url.starts_with("mailto:")
        && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Where the counter's «last visit» lives (prefs, host-only). Separated so the whole command is
/// testable without a prefs file.
pub trait Seen {
    /// The stored mark, ms since the epoch; 0 means «never visited».
    fn last_seen_ms(&self) -> u64;
    /// Remembers a later visit. An earlier one is refused (monotonic), and a storage failure is
    /// `Err` — it never answers as if it had been saved.
    fn remember(&self, at_ms: u64) -> Result<(), ()>;
}

/// Everything the command needs from its host, injected (no window, no Tauri, no globals).
pub struct Env<'a> {
    /// The same keychain the auth uses; read again for the masked client id and `hasSecret`.
    pub store: &'a (dyn SecretStore + Sync),
    pub auth: &'a GmailAuth<'a>,
    pub http: &'a dyn GmailHttp,
    /// Wall clock, ms since the epoch (the counter and the monotonic mark).
    pub now_ms: &'a (dyn Fn() -> u64 + Sync),
    /// Opens an URL with the system handler: the browser for `begin`, the mail client for
    /// `mailto:`. `false` means it could not be opened (the page then shows the URL).
    pub opener: &'a dyn Fn(&str) -> bool,
    pub seen: &'a dyn Seen,
}

/// The single pending sign-in. Authorization material is never Debug output.
#[derive(Default)]
pub struct Flows {
    pending: Mutex<Option<gmail_oauth::Pending>>,
}
impl std::fmt::Debug for Flows {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Flows(<redacted>)") }
}
#[cfg(test)]
impl Flows {
    /// How many pending sign-ins are held (there is exactly one slot).
    pub fn pending_count(&self) -> usize { self.pending.lock().map(|slot| usize::from(slot.is_some())).unwrap_or(0) }
}

impl Flows {
    /// One closed action. `Err` is only «this host cannot answer» (a poisoned slot): every
    /// refusal of the outside world is an `{ok:false, reason}` answer with a stable code.
    pub fn apply(&self, env: &Env<'_>, cmd: Cmd) -> Result<Value, &'static str> {
        let mut slot = self.pending.lock().map_err(|_| "unavailable")?;
        Ok(match cmd {
            Cmd::Status => status_answer(env),
            Cmd::SetClient(client) => match env.auth.set_client(&client) {
                Ok(()) => status_answer(env),
                Err(e) => failure(e.code()),
            },
            Cmd::Begin => {
                // A new sign-in replaces the old one: its listener is dropped BEFORE binding again.
                slot.take();
                match env.auth.begin() {
                    Ok(begun) => {
                        let opened = (env.opener)(&begun.auth_url);
                        let auth_url = begun.auth_url;
                        *slot = Some(begun.pending);
                        if opened {
                            json!({"ok": true, "state": "waiting", "browserOpened": true})
                        } else {
                            // No browser: the human can open it by hand and the loopback still answers.
                            json!({"ok": true, "state": "waiting", "browserOpened": false, "authUrl": auth_url})
                        }
                    }
                    Err(e) => failure(e.code()),
                }
            }
            Cmd::Poll => match slot.as_mut() {
                None => json!({"ok": true, "state": "none"}),
                Some(pending) => {
                    let answer = poll_answer(env.auth.complete_loopback(pending));
                    if answer["ok"] != json!(true) || answer["state"] != json!("waiting") { slot.take(); }
                    answer
                }
            },
            Cmd::Cancel => {
                slot.take();
                json!({"ok": true, "state": "none"})
            }
            Cmd::Forget => {
                slot.take();
                match env.auth.forget() {
                    Ok(()) => json!({"ok": true, "state": "no_client"}),
                    Err(e) => failure(e.code()),
                }
            }
            Cmd::Inbox(filter) => {
                let last_seen_ms = env.seen.last_seen_ms();
                match gmail_api::inbox(env.auth, env.http, filter, last_seen_ms) {
                    Ok(inbox) => json!({
                        "ok": true,
                        "messages": inbox.messages.iter().map(summary_json).collect::<Vec<_>>(),
                        "newCount": inbox.new_count,
                        "newCountCapped": inbox.new_count_capped,
                        "unreadCount": inbox.unread_count,
                        "lastSeenMs": last_seen_ms,
                    }),
                    Err(e) => failure(e.code()),
                }
            }
            Cmd::Message(id) => match gmail_api::message(env.auth, env.http, &id) {
                Ok(detail) => json!({"ok": true, "detail": detail_json(&detail)}),
                Err(e) => failure(e.code()),
            },
            Cmd::Reply(id) => match gmail_api::message(env.auth, env.http, &id) {
                Ok(detail) => match gmail_api::reply_mailto(&detail) {
                    Some(url) if safe_mailto(&url) => json!({"ok": true, "opened": (env.opener)(&url)}),
                    _ => failure("invalid"),
                },
                Err(e) => failure(e.code()),
            },
            Cmd::Seen(at_ms) => {
                // Monotonic and never in the future: a late answer or a clock that stepped back
                // cannot make already-seen mail «new» again, and the page cannot hide new mail by
                // claiming a visit that has not happened.
                let at = at_ms.min((env.now_ms)()).max(env.seen.last_seen_ms());
                match env.seen.remember(at) {
                    Ok(()) => json!({"ok": true, "lastSeenMs": at}),
                    Err(()) => failure("prefs"),
                }
            }
        })
    }
}

/// What ONE loopback poll means to the page. Split out of [`Flows::apply`] because the finished
/// branch needs a real browser callback, and every branch must be pinned.
fn poll_answer(result: Result<bool, GmailError>) -> Value {
    match result {
        Ok(false) => json!({"ok": true, "state": "waiting"}),
        Ok(true) => json!({"ok": true, "state": "done"}),
        Err(e) => failure(e.code()),
    }
}

fn failure(code: &'static str) -> Value { json!({"ok": false, "reason": code}) }

fn state_of(status: Status) -> &'static str {
    match status {
        Status::NoClient => "no_client",
        Status::SignedOut => "signed_out",
        Status::Connected => "connected",
        Status::Reconnect => "reconnect",
    }
}

/// The signed-in state plus — at most — a masked client id and whether a secret is stored.
///
/// `GmailAuth` never hands its entry out, so the mask is read here again, read-only, with a
/// defensive parse: an entry shape this module does not recognise yields NO mask (it never
/// guesses, and it never returns a whole client id).
fn status_answer(env: &Env<'_>) -> Value {
    let Ok(state) = env.auth.status() else { return failure("keychain") };
    let (client_id, has_secret) = stored_client(env.store);
    json!({"ok": true, "state": state_of(state), "clientId": client_id, "hasSecret": has_secret})
}

fn stored_client(store: &(dyn SecretStore + Sync)) -> (Value, bool) {
    let Ok(Some(text)) = store.read(gmail_oauth::KEY) else { return (Value::Null, false) };
    let Ok(entry) = serde_json::from_str::<Value>(&text) else { return (Value::Null, false) };
    let has_secret = entry.get("client_secret").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    let masked = entry.get("client_id").and_then(Value::as_str).filter(|id| !id.is_empty())
        .map(|id| json!(format!("{}…", id.chars().take(MASK_CHARS).collect::<String>())));
    (masked.unwrap_or(Value::Null), has_secret)
}

fn summary_json(summary: &gmail_api::Summary) -> Value {
    json!({
        "id": summary.id,
        "from": summary.from_name,
        "address": summary.from_address,
        "subject": summary.subject,
        "snippet": summary.snippet,
        "dateMs": summary.internal_date_ms,
        "unread": summary.unread,
        "important": summary.important,
    })
}

fn detail_json(detail: &gmail_api::Detail) -> Value {
    json!({
        "id": detail.id,
        "from": detail.from_name,
        "address": detail.from_address,
        "subject": detail.subject,
        "replySubject": detail.reply_subject,
        "body": detail.body,
        "bodyTruncated": detail.body_truncated,
        "dateMs": detail.internal_date_ms,
        "unread": detail.unread,
        "important": detail.important,
        "links": detail.links.iter().map(|link| json!({
            "text": link.text,
            "url": link.url,
            "domain": link.domain,
            "sameAsSender": link.same_as_sender,
        })).collect::<Vec<_>>(),
    })
}

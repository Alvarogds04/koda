use super::*;
use crate::secrets::StoreError;
use crate::integrations::{Http, NetError, Response};
use std::cell::RefCell;
use std::collections::BTreeMap;

const NOW: u64 = 1_800_000_000_000;

#[derive(Default)]
struct Keys(BTreeMap<String, String>);
impl SecretStore for Keys {
    fn read(&self, k: &str) -> Result<Option<String>, StoreError> { Ok(self.0.get(k).cloned()) }
    fn write(&self, _: &str, _: &str) -> Result<(), StoreError> { unreachable!("the runner never writes keys") }
    fn delete(&self, _: &str) -> Result<(), StoreError> { unreachable!("the runner never deletes keys") }
}
fn keys(pairs: &[(&str, &str)]) -> Keys { Keys(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()) }

#[derive(Clone, Debug)]
struct Call { method: String, url: String, headers: Vec<(String, String)>, body: Option<Value> }

/// Scripted fake: (method, url substring) → status, body. First match wins; no match = offline.
struct Fake { routes: Vec<(&'static str, &'static str, u16, String)>, log: RefCell<Vec<Call>> }
impl Fake {
    fn new(routes: Vec<(&'static str, &'static str, u16, &str)>) -> Fake {
        Fake { routes: routes.into_iter().map(|(m, u, s, b)| (m, u, s, b.to_string())).collect(), log: RefCell::new(vec![]) }
    }
    fn calls(&self) -> Vec<Call> { self.log.borrow().clone() }
    fn mutations(&self) -> Vec<Call> { self.calls().into_iter().filter(|c| c.method != "GET").collect() }
}
impl Http for Fake {
    fn send(&self, method: &str, url: &str, headers: &[(&str, &str)], body: Option<&str>) -> Result<Response, NetError> {
        self.log.borrow_mut().push(Call {
            method: method.into(), url: url.into(),
            headers: headers.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(),
            body: body.map(|b| serde_json::from_str(b).expect("bodies are JSON")),
        });
        self.routes.iter().find(|(m, u, _, _)| *m == method && url.contains(u)).map(|(_, _, s, b)| Response { status: *s, body: b.clone() })
            .ok_or(NetError("offline".into()))
    }
}

fn runner() -> Runner { let mut r = Runner::default(); r.pause = std::time::Duration::ZERO; r }
fn refresh(id: &str, pill: &str, at: u64) -> Request { Request { id: id.into(), pill_id: pill.into(), kind: REFRESH.into(), target: String::new(), requested_at_ms: at } }
fn act(id: &str, pill: &str, kind: &str, target: &str, at: u64) -> Request { Request { id: id.into(), pill_id: pill.into(), kind: kind.into(), target: target.into(), requested_at_ms: at } }
fn actions_of(d: &Detail) -> Vec<&ActionDef> { d.sections.iter().flat_map(|s| &s.items).flat_map(|i| &i.actions).collect() }

// ── Vercel fixtures ───────────────────────────────────────────────────────────

const VERCEL_LIST: &str = r#"{"deployments":[
 {"uid":"dpl_1","name":"web","url":"web-1.vercel.app","state":"READY","created":1700000000000,"meta":{"githubCommitMessage":"fix\nmore","githubCommitRef":"main"},"creator":{"username":"ana"}},
 {"uid":"dpl_2","name":"web","url":"web-2.vercel.app","state":"READY","target":"production","createdAt":1700000001000},
 {"uid":"dpl_3","name":"api","state":"ERROR"},
 {"uid":"dpl_4","name":"api","state":"BUILDING"},
 {"uid":"dpl_5","name":"api","state":"CANCELED"},
 {"name":"no-uid","state":"READY"}]}"#;
const VERCEL_PROJECTS: &str = r#"{"projects":[{"name":"web","framework":"nextjs","updatedAt":1700000000000}]}"#;
fn vercel_routes() -> Vec<(&'static str, &'static str, u16, &'static str)> {
    vec![("GET", "v6/deployments", 200, VERCEL_LIST), ("GET", "v9/projects", 200, VERCEL_PROJECTS)]
}
fn vercel_keys() -> Keys { keys(&[("vercel-token", " tok ")]) }

#[test]
fn only_the_nine_coucou_kinds_exist() {
    assert_eq!(ALLOWED_KINDS, ["vercel.redeploy", "vercel.promote", "vercel.cancel", "github.rerun", "github.approve", "github.merge", "n8n.activate", "n8n.deactivate", "n8n.retry"]);
    assert_eq!(PHONE_SERVICES, ["integration_github", "integration_stripe", "integration_vercel", "integration_resend", "integration_calcom", "integration_n8n", "integration_notion"]);
    assert_eq!(MAX_AGE_MS, 300_000);
}

#[test]
fn vercel_detail_offers_exactly_coucous_actions_with_their_confirmations() {
    let http = Fake::new(vercel_routes());
    let d = detail_for("integration_vercel", &http, &vercel_keys(), NOW);
    assert_eq!(d.error, None);
    let by_kind = |k: &str, t: &str| actions_of(&d).into_iter().find(|a| a.kind == k && a.target == t).cloned();
    let redeploy = by_kind("vercel.redeploy", "dpl_1|web|").unwrap();
    assert_eq!((redeploy.title.as_str(), redeploy.destructive, redeploy.confirm.clone()), ("Redeploy", false, None));
    let promote = by_kind("vercel.promote", "dpl_1|web").unwrap();
    assert_eq!(promote.title, "Promote to production");
    assert_eq!(promote.confirm.as_deref(), Some("A new production build starts from this deployment, using your production environment variables."));
    assert!(by_kind("vercel.redeploy", "dpl_2|web|production").is_some(), "production redeploy keeps its target");
    assert!(by_kind("vercel.promote", "dpl_2|web").is_none(), "a production deployment is not promoted again");
    assert!(by_kind("vercel.redeploy", "dpl_3|api|").is_some(), "failed builds can be redeployed");
    let cancel = by_kind("vercel.cancel", "dpl_4").unwrap();
    assert_eq!((cancel.title.as_str(), cancel.destructive, cancel.confirm.as_deref()), ("Cancel build", true, Some("Stop this build?")));
    assert!(actions_of(&d).iter().all(|a| !a.target.contains("dpl_5")), "canceled: nothing offered");
    assert_eq!(actions_of(&d).len(), 5);
    let first = &d.sections[0].items[0];
    assert_eq!((first.title.as_str(), first.subtitle.as_str(), first.badge.as_deref()), ("web", "main · fix · ana", Some("Preview")));
    assert_eq!(first.url.as_deref(), Some("https://web-1.vercel.app"));
    assert_eq!(d.sections[0].items[1].badge.as_deref(), Some("Production"));
    assert_eq!(d.sections[0].items[2].subtitle, "Error");
    assert_eq!(d.sections[1].title, "Projects · 1");
    assert_eq!(d.stats.iter().map(|s| (s.label.as_str(), s.value.as_str())).collect::<Vec<_>>(), [("Ready", "2"), ("Building", "1"), ("Failed", "1"), ("Projects", "1")]);
    assert_eq!(http.calls()[0].headers, [("Authorization".to_string(), "Bearer tok".to_string()), ("Accept".to_string(), "application/json".to_string())]);
}

#[test]
fn a_missing_key_is_a_detail_error_naming_abito_settings() {
    let http = Fake::new(vec![]);
    let d = detail_for("integration_vercel", &http, &keys(&[]), NOW);
    assert_eq!(d.error.as_deref(), Some("No Vercel key on your Mac. Add it in Abito's Settings."));
    assert!(http.calls().is_empty());
    let unknown = detail_for("integration_stripe", &http, &keys(&[]), NOW);
    assert_eq!(unknown.error.as_deref(), Some("Not available from the iPhone yet."));
}

// ── Runner: rules ─────────────────────────────────────────────────────────────

#[test]
fn an_action_before_any_detail_was_published_is_refused_and_nothing_is_sent() {
    let http = Fake::new(vercel_routes());
    let mut r = runner();
    let out = r.handle(vec![act("a", "integration_vercel", "vercel.cancel", "dpl_4", NOW - 1000)], NOW, &http, &vercel_keys());
    assert!(http.mutations().is_empty());
    let last = out.last().unwrap().last_action.clone().unwrap();
    assert_eq!((last.title.as_str(), last.ok, last.message.as_str()), ("Not done", false, "This action isn't offered any more. The list was refreshed."));
}

#[test]
fn only_what_was_offered_on_the_last_detail_runs() {
    let http = Fake::new(vercel_routes());
    let mut r = runner();
    r.handle(vec![refresh("r", "integration_vercel", NOW - 10)], NOW, &http, &vercel_keys());
    for (i, (kind, target)) in [("vercel.cancel", "dpl_1"), ("vercel.promote", "dpl_2|web"), ("vercel.delete", "dpl_1"), ("github.merge", "o/r#1"), ("vercel.redeploy", "dpl_1|web|production")].iter().enumerate() {
        let out = r.handle(vec![act(&format!("x{i}"), "integration_vercel", kind, target, NOW - 10)], NOW, &http, &vercel_keys());
        assert_eq!(out.last().unwrap().last_action.as_ref().unwrap().title, "Not done", "{kind} {target}");
    }
    assert!(http.mutations().is_empty());
}

#[test]
fn age_once_and_unknown_pills() {
    let http = Fake::new(vercel_routes());
    let mut r = runner();
    r.handle(vec![refresh("r", "integration_vercel", NOW)], NOW, &http, &vercel_keys());
    let cancel = |id: &str, at: u64| act(id, "integration_vercel", "vercel.cancel", "dpl_4", at);
    let patch = ("PATCH", "v12/deployments/dpl_4/cancel", 200, "{}");
    let mut routes = vercel_routes(); routes.insert(0, patch);
    let http = Fake::new(routes);
    // 5 minutes old (not < 5 min): ignored without even a reply
    assert!(r.handle(vec![cancel("old", NOW - MAX_AGE_MS)], NOW, &http, &vercel_keys()).is_empty());
    // just under: runs
    assert_eq!(r.handle(vec![cancel("ok", NOW - MAX_AGE_MS + 1)], NOW, &http, &vercel_keys()).len(), 1);
    assert_eq!(http.mutations().len(), 1);
    // the same request id again: never twice
    assert!(r.handle(vec![cancel("ok", NOW - 5)], NOW, &http, &vercel_keys()).is_empty());
    assert_eq!(http.mutations().len(), 1);
    // a pill the phone link does not serve
    assert!(r.handle(vec![act("z", "integration_spotify", "vercel.cancel", "dpl_4", NOW)], NOW, &http, &vercel_keys()).is_empty());
    assert!(r.handle(vec![refresh("n", "integration_claude", NOW)], NOW, &http, &vercel_keys()).is_empty());
}

#[test]
fn several_refreshes_of_one_service_count_once_and_keep_the_last_action() {
    let http = Fake::new(vercel_routes());
    let mut r = runner();
    let out = r.handle(vec![refresh("1", "integration_vercel", NOW - 3), refresh("2", "integration_vercel", NOW - 2), refresh("3", "integration_vercel", NOW - 1)], NOW, &http, &vercel_keys());
    assert_eq!(out.len(), 1);
    assert_eq!(http.calls().iter().filter(|c| c.url.contains("v6/deployments")).count(), 1);
    assert_eq!(out[0].last_action, None);
}

#[test]
fn requests_run_oldest_first() {
    let mut routes = vec![("PATCH", "v12/deployments/dpl_4/cancel", 200, "{}"), ("POST", "v13/deployments", 200, r#"{"url":"n.vercel.app"}"#)];
    routes.extend(vercel_routes());
    let http = Fake::new(routes);
    let mut r = runner();
    r.handle(vec![refresh("r", "integration_vercel", NOW)], NOW, &http, &vercel_keys());
    r.handle(vec![act("b", "integration_vercel", "vercel.redeploy", "dpl_3|api|", NOW - 10), act("a", "integration_vercel", "vercel.cancel", "dpl_4", NOW - 20)], NOW, &http, &vercel_keys());
    let methods: Vec<String> = http.mutations().into_iter().map(|c| c.method).collect();
    assert_eq!(methods, ["PATCH", "POST"]);
}

// ── Runner: Vercel endpoints and result lines ─────────────────────────────────

fn run_one(http: &Fake, store: &Keys, pill: &str, kind: &str, target: &str) -> (Detail, Vec<Call>) {
    let mut r = runner();
    r.handle(vec![refresh("r", pill, NOW - 10)], NOW, http, store);
    let before = http.mutations().len();
    let out = r.handle(vec![act("go", pill, kind, target, NOW - 5)], NOW, http, store);
    (out.last().unwrap().clone(), http.mutations().into_iter().skip(before).collect())
}

#[test]
fn vercel_redeploy_promote_cancel_hit_the_exact_endpoints() {
    let mut routes = vec![("PATCH", "api.vercel.com/v12/deployments/dpl_4/cancel", 200, ""), ("POST", "api.vercel.com/v13/deployments", 200, r#"{"url":"web-new.vercel.app"}"#)];
    routes.extend(vercel_routes());
    let http = Fake::new(routes);
    let (d, m) = run_one(&http, &vercel_keys(), "integration_vercel", "vercel.redeploy", "dpl_1|web|");
    assert_eq!((m[0].method.as_str(), m[0].url.as_str()), ("POST", "https://api.vercel.com/v13/deployments"));
    assert_eq!(m[0].body, Some(json!({"name":"web","deploymentId":"dpl_1"})), "empty target is omitted");
    assert_eq!(m[0].headers, [("Authorization".to_string(), "Bearer tok".to_string()), ("Accept".to_string(), "application/json".to_string()), ("Content-Type".to_string(), "application/json".to_string())]);
    let last = d.last_action.unwrap();
    assert_eq!((last.title.as_str(), last.ok, last.message.as_str()), ("Redeploy", true, "Building web-new.vercel.app"));
    assert!(d.fetched_at > 0 && d.error.is_none(), "the detail is published again after the action");

    let (d, m) = run_one(&http, &vercel_keys(), "integration_vercel", "vercel.redeploy", "dpl_2|web|production");
    assert_eq!(m[0].body, Some(json!({"name":"web","deploymentId":"dpl_2","target":"production"})));
    assert_eq!(d.last_action.unwrap().message, "Building web-new.vercel.app");

    let (d, m) = run_one(&http, &vercel_keys(), "integration_vercel", "vercel.promote", "dpl_1|web");
    assert_eq!(m[0].body, Some(json!({"deploymentId":"dpl_1","name":"web","target":"production","meta":{"action":"promote"}})));
    let last = d.last_action.unwrap();
    assert_eq!((last.title.as_str(), last.message.as_str()), ("Promote to production", "Building web-new.vercel.app for production"));

    let (d, m) = run_one(&http, &vercel_keys(), "integration_vercel", "vercel.cancel", "dpl_4");
    assert_eq!((m[0].method.as_str(), m[0].url.as_str(), m[0].body.clone()), ("PATCH", "https://api.vercel.com/v12/deployments/dpl_4/cancel", None));
    let last = d.last_action.unwrap();
    assert_eq!((last.title.as_str(), last.ok, last.message.as_str()), ("Cancel build", true, "Build canceled"));
}

#[test]
fn vercel_without_a_url_in_the_answer_uses_the_plain_lines() {
    let mut routes = vec![("POST", "v13/deployments", 200, "{}")];
    routes.extend(vercel_routes());
    let http = Fake::new(routes);
    assert_eq!(run_one(&http, &vercel_keys(), "integration_vercel", "vercel.redeploy", "dpl_1|web|").0.last_action.unwrap().message, "New deployment started");
    assert_eq!(run_one(&http, &vercel_keys(), "integration_vercel", "vercel.promote", "dpl_1|web").0.last_action.unwrap().message, "Production build started");
}

#[test]
fn api_failures_become_the_phones_line_never_the_key() {
    for (status, body, text) in [
        (401, r#"{"message":"bad"}"#, "The key was refused (401). Check it in Abito's Settings on your Mac."),
        (401, r#"{"error":{"message":"restricted_api_key"}}"#, "This key can only send emails. Use a Full access key in Abito's Settings on your Mac to see them here."),
        (403, r#"{"error":{"message":"no scope"}}"#, "Not allowed with this key (403). no scope"),
        (404, "{}", "Not found (404)."),
        (500, r#"{"error":"boom"}"#, "boom"),
        (502, "", "Error 502"),
    ] {
        let mut routes = vec![("PATCH", "cancel", status, body)];
        routes.extend(vercel_routes());
        let http = Fake::new(routes);
        let last = run_one(&http, &vercel_keys(), "integration_vercel", "vercel.cancel", "dpl_4").0.last_action.unwrap();
        assert_eq!((last.title.as_str(), last.ok, last.message.as_str()), ("Cancel build", false, text), "{status}");
        assert!(!format!("{last:?}").contains("tok"));
    }
    let http = Fake::new(vercel_routes()); // PATCH has no route: offline
    let last = run_one(&http, &vercel_keys(), "integration_vercel", "vercel.cancel", "dpl_4").0.last_action.unwrap();
    assert!(!last.ok);
}

#[test]
fn an_offered_target_with_path_characters_is_never_put_in_a_url() {
    let list = r#"{"deployments":[{"uid":"a/../../x","name":"web","state":"BUILDING"}]}"#;
    let http = Fake::new(vec![("GET", "v6/deployments", 200, list), ("PATCH", "cancel", 200, "{}")]);
    let (d, m) = run_one(&http, &vercel_keys(), "integration_vercel", "vercel.cancel", "a/../../x");
    assert!(m.is_empty());
    assert_eq!(d.last_action.unwrap().message, "Unknown deployment");
}

// ── GitHub ────────────────────────────────────────────────────────────────────

fn github_routes() -> Vec<(&'static str, &'static str, u16, &'static str)> {
    vec![
        ("GET", "api.github.com/user/repos", 200, r#"[{"full_name":"o/r"},{"full_name":"o/other"}]"#),
        ("GET", "api.github.com/user", 200, r#"{"login":"ana"}"#),
        ("GET", "author:ana", 200, r#"{"items":[
           {"title":"Add x","number":12,"repository_url":"https://api.github.com/repos/o/r","html_url":"https://github.com/o/r/pull/12","draft":false,"updated_at":"2026-10-19T10:00:00Z"},
           {"title":"WIP","number":13,"repository_url":"https://api.github.com/repos/o/r","draft":true}]}"#),
        ("GET", "review-requested:ana", 200, r#"{"items":[{"title":"Fix y","number":7,"repository_url":"https://api.github.com/repos/o/z","user":{"login":"bob"}}]}"#),
        ("GET", "/repos/o/r/actions/runs", 200, r#"{"workflow_runs":[
           {"id":77,"name":"CI","status":"completed","conclusion":"failure","head_branch":"main"},
           {"id":78,"name":"CI","status":"completed","conclusion":"success","head_branch":"main"},
           {"id":79,"name":"CI","status":"in_progress","head_branch":"dev"},
           {"id":80,"name":"CI","status":"completed","conclusion":"timed_out","head_branch":"dev"}]}"#),
        ("GET", "/repos/o/other/actions/runs", 200, r#"{"workflow_runs":[]}"#),
    ]
}
fn github_keys() -> Keys { keys(&[("github-token", "ghp_x")]) }

#[test]
fn github_detail_offers_merge_approve_and_rerun() {
    let http = Fake::new(github_routes());
    let d = detail_for("integration_github", &http, &github_keys(), NOW);
    assert_eq!(d.error, None);
    let merge: Vec<_> = actions_of(&d).into_iter().filter(|a| a.kind == "github.merge").collect();
    assert_eq!(merge.len(), 1, "a draft has no merge");
    assert_eq!((merge[0].title.as_str(), merge[0].target.as_str(), merge[0].confirm.as_deref()), ("Squash and merge", "o/r#12", Some("Merge o/r#12 into its base branch?")));
    let approve: Vec<_> = actions_of(&d).into_iter().filter(|a| a.kind == "github.approve").collect();
    assert_eq!((approve[0].target.as_str(), approve[0].confirm.clone(), approve[0].title.as_str()), ("o/z#7", None, "Approve"));
    let rerun: Vec<_> = actions_of(&d).into_iter().filter(|a| a.kind == "github.rerun").map(|a| a.target.clone()).collect();
    assert_eq!(rerun, ["o/r/77", "o/r/80"], "failure and timed_out only");
    assert_eq!(d.sections.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(), ["Reviews asked of you", "Your pull requests", "CI on your latest repos"]);
    assert_eq!(d.sections[1].items[1].badge.as_deref(), Some("Draft"));
    assert_eq!(d.sections[0].items[0].subtitle, "o/z#7 · bob");
    assert_eq!(d.stats.iter().map(|s| (s.label.as_str(), s.value.as_str())).collect::<Vec<_>>(), [("Your PRs", "2"), ("Reviews", "1"), ("CI failing", "2")]);
    let first = &http.calls()[0];
    assert_eq!(first.url, "https://api.github.com/user");
    assert!(first.headers.contains(&("Authorization".into(), "Bearer ghp_x".into())));
    assert!(first.headers.contains(&("X-GitHub-Api-Version".into(), "2022-11-28".into())));
}

#[test]
fn github_actions_hit_the_exact_rest_endpoints() {
    let mut routes = vec![
        ("PUT", "api.github.com/repos/o/r/pulls/12/merge", 200, r#"{"merged":true}"#),
        ("POST", "api.github.com/repos/o/z/pulls/7/reviews", 200, "{}"),
        ("POST", "api.github.com/repos/o/r/actions/runs/77/rerun-failed-jobs", 201, ""),
    ];
    routes.extend(github_routes());
    let http = Fake::new(routes);
    let (d, m) = run_one(&http, &github_keys(), "integration_github", "github.merge", "o/r#12");
    assert_eq!((m[0].method.as_str(), m[0].url.as_str(), m[0].body.clone()), ("PUT", "https://api.github.com/repos/o/r/pulls/12/merge", Some(json!({"merge_method":"squash"}))));
    let last = d.last_action.unwrap();
    assert_eq!((last.title.as_str(), last.ok, last.message.as_str()), ("Squash and merge", true, "Merged"));
    let (d, m) = run_one(&http, &github_keys(), "integration_github", "github.approve", "o/z#7");
    assert_eq!((m[0].method.as_str(), m[0].url.as_str(), m[0].body.clone()), ("POST", "https://api.github.com/repos/o/z/pulls/7/reviews", Some(json!({"event":"APPROVE"}))));
    assert_eq!(d.last_action.unwrap().message, "Approved");
    let (d, m) = run_one(&http, &github_keys(), "integration_github", "github.rerun", "o/r/77");
    assert_eq!((m[0].method.as_str(), m[0].url.as_str(), m[0].body.clone()), ("POST", "https://api.github.com/repos/o/r/actions/runs/77/rerun-failed-jobs", None));
    assert_eq!(d.last_action.unwrap().message, "Failed jobs started again");
    assert!(m[0].headers.contains(&("Authorization".into(), "Bearer ghp_x".into())));
}

// ── n8n ───────────────────────────────────────────────────────────────────────

fn n8n_routes() -> Vec<(&'static str, &'static str, u16, &'static str)> {
    vec![
        ("GET", "n8n.example.com/api/v1/workflows?limit=250", 200, r#"{"data":[
           {"id":"w1","name":"Nightly","active":true,"updatedAt":"2026-10-19T10:00:00Z"},
           {"id":2,"name":"Off","active":false,"updatedAt":"2026-10-18T10:00:00Z"},
           {"id":"w3","name":"Old","isArchived":true}],"nextCursor":null}"#),
        ("GET", "n8n.example.com/api/v1/executions?limit=15", 200, r#"{"data":[
           {"id":"41","workflowId":"w1","status":"error","startedAt":"2026-10-19T10:00:00Z"},
           {"id":42,"workflowId":2,"status":"success"}]}"#),
    ]
}
fn n8n_keys() -> Keys { keys(&[("n8n-api-key", "nk"), ("n8n-url", "https://n8n.example.com/")]) }

#[test]
fn n8n_detail_offers_activate_deactivate_and_retry() {
    let http = Fake::new(n8n_routes());
    let d = detail_for("integration_n8n", &http, &n8n_keys(), NOW);
    assert_eq!(d.error, None);
    let off = actions_of(&d).into_iter().find(|a| a.kind == "n8n.deactivate").unwrap();
    assert_eq!((off.target.as_str(), off.title.as_str(), off.destructive, off.confirm.as_deref()), ("w1", "Turn off", true, Some("Stop Nightly from running?")));
    let on = actions_of(&d).into_iter().find(|a| a.kind == "n8n.activate").unwrap();
    assert_eq!((on.target.as_str(), on.title.as_str(), on.destructive, on.confirm.clone()), ("2", "Turn on", false, None));
    let retry: Vec<_> = actions_of(&d).into_iter().filter(|a| a.kind == "n8n.retry").map(|a| a.target.clone()).collect();
    assert_eq!(retry, ["41"], "only the failed execution");
    assert_eq!(actions_of(&d).len(), 3, "an archived workflow offers nothing");
    assert_eq!(d.sections[0].title, "Latest runs");
    assert_eq!(d.sections[0].items[0].title, "Nightly");
    assert_eq!(d.sections[0].items[0].url.as_deref(), Some("https://n8n.example.com/workflow/w1/executions/41"));
    assert_eq!(d.stats.iter().map(|s| (s.label.as_str(), s.value.as_str())).collect::<Vec<_>>(), [("Workflows", "2"), ("Active", "1"), ("Failed runs", "1")]);
    assert_eq!(http.calls()[0].headers, [("X-N8N-API-KEY".to_string(), "nk".to_string()), ("Accept".to_string(), "application/json".to_string())]);
}

#[test]
fn n8n_actions_hit_the_exact_endpoints_and_retry_explains_old_versions() {
    let mut routes = vec![
        ("POST", "n8n.example.com/api/v1/workflows/w1/deactivate", 200, "{}"),
        ("POST", "n8n.example.com/api/v1/workflows/2/activate", 200, "{}"),
        ("POST", "n8n.example.com/api/v1/executions/41/retry", 200, "{}"),
    ];
    routes.extend(n8n_routes());
    let http = Fake::new(routes);
    let (d, m) = run_one(&http, &n8n_keys(), "integration_n8n", "n8n.deactivate", "w1");
    assert_eq!((m[0].method.as_str(), m[0].url.as_str()), ("POST", "https://n8n.example.com/api/v1/workflows/w1/deactivate"));
    assert_eq!(d.last_action.unwrap().message, "Turned off");
    assert_eq!(run_one(&http, &n8n_keys(), "integration_n8n", "n8n.activate", "2").0.last_action.unwrap().message, "Turned on");
    let (d, m) = run_one(&http, &n8n_keys(), "integration_n8n", "n8n.retry", "41");
    assert_eq!(m[0].url, "https://n8n.example.com/api/v1/executions/41/retry");
    assert_eq!(d.last_action.unwrap().message, "Running again");

    for status in [404, 405] {
        let mut routes = vec![("POST", "executions/41/retry", status, "{}")];
        routes.extend(n8n_routes());
        let last = run_one(&Fake::new(routes), &n8n_keys(), "integration_n8n", "n8n.retry", "41").0.last_action.unwrap();
        assert!(!last.ok);
        assert_eq!(last.message, "Couldn't retry this run. It may have been deleted, or your n8n is older than 1.112, which is needed to retry from the iPhone.");
    }
}

#[test]
fn an_unsafe_n8n_address_is_refused_before_any_request() {
    for bad in ["http://n8n.example.com", "http://192.168.1.5:5678", "https://u:p@n8n.example.com", "n8n.example.com"] {
        let http = Fake::new(n8n_routes());
        let d = detail_for("integration_n8n", &http, &keys(&[("n8n-api-key", "k"), ("n8n-url", bad)]), NOW);
        assert_eq!(d.error.as_deref(), Some("The n8n address on your Mac isn't safe to use. Use https, or http on localhost."), "{bad}");
        assert!(http.calls().is_empty(), "{bad}");
    }
}

#[test]
fn forget_drops_everything_so_stale_offers_cannot_run() {
    let mut routes = vec![("PATCH", "cancel", 200, "{}")];
    routes.extend(vercel_routes());
    let http = Fake::new(routes);
    let mut r = runner();
    r.handle(vec![refresh("r", "integration_vercel", NOW)], NOW, &http, &vercel_keys());
    r.forget();
    let out = r.handle(vec![act("a", "integration_vercel", "vercel.cancel", "dpl_4", NOW)], NOW, &http, &vercel_keys());
    assert_eq!(out.last().unwrap().last_action.as_ref().unwrap().title, "Not done");
    assert!(http.mutations().is_empty());
}

#[test]
fn the_wire_shape_is_camel_case_with_swift_field_names() {
    let a = ActionDef { kind: "vercel.cancel".into(), title: "Cancel build".into(), symbol: "xmark.circle".into(), target: "d".into(), destructive: true, confirm: Some("Stop this build?".into()) };
    assert_eq!(serde_json::to_value(&a).unwrap(), json!({"kind":"vercel.cancel","title":"Cancel build","symbol":"xmark.circle","target":"d","destructive":true,"confirm":"Stop this build?"}));
    let d = Detail { pill_id: "integration_n8n".into(), stats: vec![], sections: vec![], fetched_at: 5, error: None, last_action: None };
    assert_eq!(serde_json::to_value(&d).unwrap(), json!({"pillId":"integration_n8n","stats":[],"sections":[],"fetchedAt":5,"error":null,"lastAction":null}));
}

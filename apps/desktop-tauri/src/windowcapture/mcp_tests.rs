use super::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const TOKEN: &str = "secret-token";
const NOW: u64 = 1_700_000_000_000;

struct FakeDesktop {
    target: Mutex<Result<Target, CaptureError>>,
    captures: AtomicUsize,
    result: Mutex<Result<Shot, CaptureError>>,
}
impl Desktop for FakeDesktop {
    fn pick_target(&self) -> Result<Target, CaptureError> {
        self.target.lock().unwrap().clone()
    }
    fn capture(&self, _target: &Target) -> Result<Shot, CaptureError> {
        self.captures.fetch_add(1, Ordering::SeqCst);
        self.result.lock().unwrap().clone()
    }
}

struct FakeDialogs {
    allow: bool,
    asked: AtomicUsize,
}
impl Dialogs for FakeDialogs {
    fn ask_grant(&self) -> bool {
        self.asked.fetch_add(1, Ordering::SeqCst);
        self.allow
    }
}

struct Rig {
    helper: Helper,
    desktop: Arc<FakeDesktop>,
    dialogs: Arc<FakeDialogs>,
    clock: Arc<AtomicU64>,
    enabled: Arc<std::sync::atomic::AtomicBool>,
}

fn target(app_id: &str, app: &str) -> Target {
    Target { app_id: app_id.into(), app: app.into(), title: "doc".into(), handle: 1 }
}

fn shot() -> Shot {
    Shot { png: vec![0x89, b'P', b'N', b'G'], width: 640, height: 400 }
}

fn rig_with(allow: bool, target: Result<Target, CaptureError>) -> Rig {
    let desktop = Arc::new(FakeDesktop { target: Mutex::new(target), captures: AtomicUsize::new(0), result: Mutex::new(Ok(shot())) });
    let dialogs = Arc::new(FakeDialogs { allow, asked: AtomicUsize::new(0) });
    let clock = Arc::new(AtomicU64::new(NOW));
    let enabled = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let (c, e) = (clock.clone(), enabled.clone());
    let helper = Helper::new(
        desktop.clone(),
        dialogs.clone(),
        Arc::new(move || c.load(Ordering::SeqCst)),
        Arc::new(move || e.load(Ordering::SeqCst)),
        TOKEN.into(),
    );
    Rig { helper, desktop, dialogs, clock, enabled }
}

fn rig() -> Rig {
    rig_with(true, Ok(target("firefox", "Firefox")))
}

fn post(rig: &Rig, authorization: Option<&str>, body: &str) -> HttpReply {
    rig.helper.handle(&HttpRequest { method: "POST", path: "/mcp", authorization, body })
}

impl Rig {
    fn call(&self, name: &str) -> Value {
        let body = json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": name, "arguments": {}}}).to_string();
        let reply = post(self, Some(&format!("Bearer {TOKEN}")), &body);
        assert_eq!(reply.status, 200, "{reply:?}");
        reply.body.unwrap()
    }
}

fn text(body: &Value) -> String {
    body["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string()
}

#[test]
fn requests_without_the_bearer_token_are_refused() {
    let rig = rig();
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).to_string();
    for authorization in [None, Some("Bearer wrong"), Some(TOKEN), Some("Basic secret-token")] {
        assert_eq!(post(&rig, authorization, &body).status, 401, "{authorization:?}");
    }
    assert_eq!(post(&rig, Some("Bearer secret-token"), &body).status, 200);
    assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), 0);
}

#[test]
fn only_post_to_mcp_is_served() {
    let rig = rig();
    let auth = Some("Bearer secret-token");
    assert_eq!(rig.helper.handle(&HttpRequest { method: "GET", path: "/mcp", authorization: auth, body: "" }).status, 405);
    assert_eq!(rig.helper.handle(&HttpRequest { method: "POST", path: "/other", authorization: auth, body: "{}" }).status, 404);
}

#[test]
fn the_only_tool_is_screenshot_my_window() {
    let rig = rig();
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).to_string();
    let reply = post(&rig, Some("Bearer secret-token"), &body).body.unwrap();
    let names: Vec<&str> = reply["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, [TOOL]);
}

#[test]
fn any_other_tool_is_refused_and_captures_nothing() {
    let rig = rig();
    let body = rig.call("click");
    assert_eq!(body["error"]["code"], -32602);
    assert_eq!(rig.dialogs.asked.load(Ordering::SeqCst), 0);
    assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), 0);
}

#[test]
fn a_capture_returns_the_image_and_the_app() {
    let rig = rig();
    let body = rig.call(TOOL);
    let content = body["result"]["content"].as_array().unwrap();
    assert_eq!(content[0]["type"], "image");
    assert_eq!(content[0]["mimeType"], "image/png");
    assert!(content[0]["data"].as_str().is_some_and(|d| !d.is_empty()));
    let meta: Value = serde_json::from_str(content[1]["text"].as_str().unwrap()).unwrap();
    assert_eq!(meta["frontApp"], "Firefox");
}

#[test]
fn without_a_grant_nothing_is_captured() {
    let rig = rig_with(false, Ok(target("firefox", "Firefox")));
    let body = rig.call(TOOL);
    assert_eq!(body["result"]["isError"], true);
    assert!(text(&body).contains("did not allow"), "{body}");
    assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), 0);
}

#[test]
fn the_grant_is_asked_once_per_session_and_again_after_thirty_minutes() {
    let rig = rig();
    rig.call(TOOL);
    rig.call(TOOL);
    assert_eq!(rig.dialogs.asked.load(Ordering::SeqCst), 1);
    rig.clock.store(NOW + crate::windowcapture::session::SESSION_MS - 1, Ordering::SeqCst);
    rig.call(TOOL);
    assert_eq!(rig.dialogs.asked.load(Ordering::SeqCst), 1);
    rig.clock.store(NOW + crate::windowcapture::session::SESSION_MS, Ordering::SeqCst);
    rig.call(TOOL);
    assert_eq!(rig.dialogs.asked.load(Ordering::SeqCst), 2);
    assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), 4);
}

#[test]
fn a_sensitive_app_is_refused_and_not_captured() {
    // 1Password is on the macOS, Windows and Linux lists alike (KeePassXC is not on Gentle Dot's macOS
    // list), so this rule is exercised on whatever platform runs the test.
    let rig = rig_with(true, Ok(target("1password", "1Password")));
    let body = rig.call(TOOL);
    assert_eq!(body["result"]["isError"], true);
    assert!(text(&body).contains("1Password"), "{body}");
    assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), 0);
}

#[test]
fn with_the_option_off_nothing_is_captured_and_nothing_is_asked() {
    let rig = rig();
    rig.enabled.store(false, Ordering::SeqCst);
    let body = rig.call(TOOL);
    assert_eq!(body["result"]["isError"], true);
    assert!(text(&body).contains("turned off"), "{body}");
    assert_eq!(rig.dialogs.asked.load(Ordering::SeqCst), 0);
    assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), 0);
}

#[test]
fn a_missing_screen_permission_says_what_is_missing_and_how_to_fix_it() {
    let rig = rig();
    *rig.desktop.result.lock().unwrap() = Err(CaptureError::PermissionMissing);
    let t = text(&rig.call(TOOL));
    assert!(t.contains("permission"), "{t}");
    assert!(t.contains("settings") || t.contains("Settings"), "{t}");
    assert!(t.contains("again"), "{t}");
}

#[test]
fn no_other_window_to_capture_is_a_clear_error() {
    let rig = rig_with(true, Err(CaptureError::NoWindow));
    let t = text(&rig.call(TOOL));
    assert!(t.contains("window"), "{t}");
    assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), 0);
}

#[test]
fn tokens_are_long_random_and_fresh() {
    let (a, b) = (new_token(), new_token());
    assert_eq!(a.len(), 64);
    assert_ne!(a, b);
}

// M3: two calls at the same time ask for the permission once.
#[test]
fn two_simultaneous_calls_ask_for_the_permission_only_once() {
    struct Slow(AtomicUsize);
    impl Dialogs for Slow {
        fn ask_grant(&self) -> bool {
            self.0.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(80));
            true
        }
    }
    let desktop = Arc::new(FakeDesktop { target: Mutex::new(Ok(target("firefox", "Firefox"))), captures: AtomicUsize::new(0), result: Mutex::new(Ok(shot())) });
    let dialogs = Arc::new(Slow(AtomicUsize::new(0)));
    let helper = Arc::new(Helper::new(desktop.clone(), dialogs.clone(), Arc::new(|| NOW), Arc::new(|| true), TOKEN.into()));
    let body = json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": TOOL, "arguments": {}}}).to_string();
    let threads: Vec<_> = (0..4).map(|_| {
        let (helper, body) = (helper.clone(), body.clone());
        std::thread::spawn(move || helper.handle(&HttpRequest { method: "POST", path: "/mcp", authorization: Some("Bearer secret-token"), body: &body }))
    }).collect();
    for t in threads { assert_eq!(t.join().unwrap().status, 200); }
    assert_eq!(dialogs.0.load(Ordering::SeqCst), 1);
    assert_eq!(desktop.captures.load(Ordering::SeqCst), 4);
}

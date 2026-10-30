#![cfg(target_os = "linux")]
// Linux-only integration: real receiver sockets, SO_PEERCRED, and XDG runtime policy.

//! Opt-in integration with the external REAL Node producer, not a Pi/UI e2e.
//! Default runs deliberately ignore these tests; --ignored requires the source
//! directory and Node and fails loudly if either is unavailable (no fallback).
mod common;
use abito_island::{protocol, transport::{self, Transport, TransportOptions}};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct Fixture {
    receiver: Transport, leaf: common::fixture_leaf::Leaf, runtime: PathBuf, cwd: PathBuf, project: String,
    connections: Arc<AtomicU32>, notices: Arc<AtomicU32>,
}
impl Fixture {
    fn new() -> Self {
        let source = PathBuf::from(std::env::var("ABITO_PI_PRODUCER_DIR")
            .expect("opt-in test requires ABITO_PI_PRODUCER_DIR; no fake producer fallback"));
        assert!(source.is_absolute() && source.is_dir(), "explicit producer directory required");
        for name in ["adapter.cjs", "questions.cjs"] { assert!(source.join(name).is_file(), "real producer source required"); }
        // Main's hardening, kept: the base honours the ABITO_SOCKET_DIR override, must stay
        // inside this checkout (never an installed root), be canonical and pass directory_chain.
        let cwd = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
        let base = std::env::var_os("ABITO_SOCKET_DIR").map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_TARGET_TMPDIR")));
        assert!(base.is_absolute() && base.starts_with(&cwd), "fixtures stay in this checkout, never installed roots");
        assert_eq!(base.canonicalize().unwrap(), base, "no symlink or unnormalized fixture base");
        transport::directory_chain(&base).unwrap();
        // N7, kept: an exclusive, self-cleaning short leaf INSIDE that resolved base (removed on
        // drop, abandoned leaves reclaimed), never CARGO_TARGET_TMPDIR directly.
        let leaf = common::fixture_leaf::Leaf::alloc(&base, "n");
        let runtime = leaf.path().to_path_buf();
        let project = protocol::project_id(cwd.to_str().unwrap());
        let connections = Arc::new(AtomicU32::new(0)); let notices = Arc::new(AtomicU32::new(0));
        let c = connections.clone(); let n = notices.clone();
        let options = TransportOptions::new(&runtime, &project)
            .on_connections(move |count| { c.store(count, Ordering::SeqCst); })
            .on_notice(move |_| { n.fetch_add(1, Ordering::SeqCst); });
        let receiver = transport::create_transport(options).unwrap();
        Self { receiver, leaf, runtime, cwd, project, connections, notices }
    }
    fn start(&self, mode: &str) -> Harness { self.start_as(mode, &self.cwd, "qp-real-session") }
    fn start_as(&self, mode: &str, cwd: &Path, session: &str) -> Harness {
        let child = Command::new("node")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("test-node/pi-question-producer.cjs"))
            .arg(self.receiver.endpoint()).arg(&self.runtime).arg(cwd).arg(mode).arg(session)
            .current_dir(&self.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().expect("opt-in test requires Node; no skip or fake fallback");
        Harness::new(child)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.receiver.close().unwrap();
        // Only socket fixtures were created: anything but the leaf's own owner
        // marker left behind fails the test rather than being silently deleted.
        let leftovers: Vec<_> = std::fs::read_dir(&self.runtime).map(|d| d.flatten().map(|e| e.file_name()).filter(|n| n != ".owner").collect()).unwrap_or_default();
        if !std::thread::panicking() { assert!(leftovers.is_empty(), "fixture leaf not clean after close: {leftovers:?}"); }
        let _ = &self.leaf; // removed when the field drops
    }
}
struct Harness { child: Child, lines: mpsc::Receiver<String> }
impl Harness {
    fn new(mut child: Child) -> Self {
        let stdout = child.stdout.take().unwrap(); let (send, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).take(16384).lines() {
                let Ok(line) = line else { break; };
                if send.send(line).is_err() { break; }
            }
        });
        Self { child, lines }
    }
    fn next(&self) -> Value {
        let line = self.lines.recv_timeout(Duration::from_secs(10)).expect("bounded Node protocol result");
        assert!(!line.contains("QP2_PRIVATE_QUESTION_CANARY"), "never log question text");
        serde_json::from_str(&line).expect("metadata/result JSON only")
    }
    fn finish(&mut self) {
        self.child.stdin.take().unwrap().write_all(b"finish\n").unwrap();
        let end = Instant::now()+Duration::from_secs(3);
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() { break status; }
            assert!(Instant::now()<end, "Node must exit after test control finish");
            std::thread::sleep(Duration::from_millis(10));
        };
        let mut stderr = String::new();
        self.child.stderr.take().unwrap().take(8192).read_to_string(&mut stderr).unwrap();
        assert!(status.success(), "Node exit: {status}; diagnostic: {stderr}");
        assert!(stderr.is_empty(), "producer must not log private payloads");
        assert!(self.lines.recv_timeout(Duration::from_millis(100)).is_err(), "no extra transcript output");
    }
}
impl Drop for Harness {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}
fn wait(mut condition: impl FnMut() -> bool) {
    let end = Instant::now()+Duration::from_secs(3);
    while !condition() { assert!(Instant::now()<end, "receiver state deadline"); std::thread::sleep(Duration::from_millis(10)); }
}

#[test]
#[ignore = "requires ABITO_PI_PRODUCER_DIR and Node"]
fn real_producer_question_host_answer_and_ack() {
    for (mode, level2) in [("questions",false), ("questions-level2",true)] {
    let f = Fixture::new(); let mut node = f.start(mode);
    let started = node.next();
    assert_eq!(started["phase"], "question_pending", "producer status: {}", started["status"]);
    assert_eq!(started["project"], f.project); assert_eq!(started["sessionId"], "qp-real-session");
    let ready = if level2 { "{\"v\":1,\"type\":\"questions_ready\",\"questionVersion\":1,\"busyReason\":1}\n" }
        else { "{\"v\":1,\"type\":\"questions_ready\",\"questionVersion\":1}\n" };
    assert_eq!(started["received"], json!(["{\"v\":1,\"type\":\"ready\"}\n", ready]));
    let hello: Value = serde_json::from_str(started["questionsHello"].as_str().unwrap()).unwrap();
    assert_eq!(hello.get("busyReason"), level2.then(|| json!(1)).as_ref());
    assert_eq!(hello.as_object().unwrap().len(), if level2 {7} else {6});
    let id = started["id"].as_str().unwrap().to_string();
    wait(|| f.receiver.question_snapshot().pending.as_ref().is_some_and(|q| q.id == id));
    let view = f.receiver.question_snapshot();
    assert_eq!(view.pending.as_ref().unwrap().options[1].label, "Second");
    assert!(!serde_json::to_string(&view).unwrap().contains("opaque-real"), "host view never exposes tokens");
    // Callable Rust host API only: this is NOT a trusted WebView click.
    f.receiver.answer(&id, 1).unwrap();
    let completed = node.next();
    assert_eq!(completed["result"], json!({"status":"answered","id":id,
        "answer":{"type":"option","value":"opaque-real-B"}}));
    assert_eq!(completed["ack"], json!({"id":id,"status":"answered"}));
    assert_eq!(completed["diagnostics"], json!([{"id":id,"reason":"answered"}]));
    let types: Vec<_> = completed["types"].as_array().unwrap().iter()
        .filter(|t| **t != json!("heartbeat")).cloned().collect();
    assert_eq!(types, vec![json!("hello"), json!("questions_hello"), json!("question"), json!("question_resolved")]);
    wait(|| {
        let view = f.receiver.question_snapshot();
        view.pending.is_none() && view.deliveries.is_empty()
            && view.notice == Some(transport::QuestionOutcome::Answered) && view.ready_connections == 1
    });
    assert_eq!(f.connections.load(Ordering::SeqCst), 1, "ACK must clear receipt before disconnect");
    assert!(f.receiver.answer(&id, 1).is_err(), "ACK does not resurrect answerability");
    assert!(!serde_json::to_string(&f.receiver.question_snapshot()).unwrap().contains("QP2_PRIVATE_QUESTION_CANARY"));
    node.finish(); wait(|| f.connections.load(Ordering::SeqCst) == 0);
    }
}

#[test]
#[ignore = "requires ABITO_PI_PRODUCER_DIR and Node"]
fn real_producer_default_flag_off_exact_v1_and_unavailable() {
    let f = Fixture::new(); let mut node = f.start("legacy"); let report = node.next();
    assert_eq!(report["result"], json!({"status":"unavailable"}));
    assert_eq!(report["project"], f.project); assert_eq!(report["sessionId"], "qp-real-session");
    assert_eq!(report["received"], json!(["{\"v\":1,\"type\":\"ready\"}\n"]));
    assert_eq!(report["diagnostics"], json!([]));
    for kind in ["hello", "heartbeat", "settled"] {
        let raw = report["legacy"][kind].as_str().unwrap(); let frame: Value = serde_json::from_str(raw).unwrap();
        let suffix = if kind == "settled" {
            let id = frame["id"].as_str().unwrap(); assert!(protocol::token(id)); format!(",\"id\":\"{id}\"")
        } else { String::new() };
        let expected = format!("{{\"v\":1,\"type\":\"{kind}\",\"project\":\"{}\",\"sessionId\":\"qp-real-session\",\"at\":{}{suffix}}}\n", f.project, frame["at"].as_u64().unwrap());
        assert_eq!(raw, expected, "unchanged v1 fields, order and newline");
        assert!(raw.len()-1 <= 512);
    }
    wait(|| f.connections.load(Ordering::SeqCst) == 1 && f.notices.load(Ordering::SeqCst) == 1);
    let view = f.receiver.question_snapshot();
    assert_eq!(view.ready_connections, 0); assert!(view.pending.is_none() && view.deliveries.is_empty());
    assert!(!serde_json::to_string(&view).unwrap().contains("opaque-real"));
    node.finish(); wait(|| f.connections.load(Ordering::SeqCst) == 0);
}

fn wire(stream: &mut UnixStream, value: Value) {
    stream.write_all(format!("{value}\n").as_bytes()).unwrap();
}
fn wire_line(stream: &mut UnixStream) -> Vec<u8> {
    let mut bytes = Vec::new(); let mut byte = [0];
    loop {
        match stream.read(&mut byte).unwrap() {
            0 => return bytes,
            _ => { bytes.push(byte[0]); if byte[0] == b'\n' { return bytes; } }
        }
    }
}
fn epoch_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 }

#[test]
#[ignore = "requires ABITO_PI_PRODUCER_DIR and Node"]
fn real_producer_foreign_project_reaches_question_and_answer() {
    let f = Fixture::new(); let mut node = f.start_as("questions", &f.runtime, "foreign-project");
    let report = node.next();
    assert_eq!(report["phase"], "question_pending");
    assert_ne!(report["project"], f.project, "actual producer hashes its different real cwd");
    assert_eq!(report["project"], protocol::project_id(f.runtime.to_str().unwrap()));
    assert_eq!(report["sessionId"], "foreign-project");
    let id = report["id"].as_str().unwrap();
    wait(|| f.receiver.question_snapshot().pending.as_ref().is_some_and(|q| q.id == id));
    f.receiver.answer(id, 1).unwrap();
    let done = node.next();
    assert_eq!(done["result"], json!({"status":"answered","id":id,
        "answer":{"type":"option","value":"opaque-real-B"}}));
    assert_eq!(done["ack"], json!({"id":id,"status":"answered"}));
    node.finish();
}

#[test]
#[ignore = "requires ABITO_PI_PRODUCER_DIR and Node"]
fn real_producer_sessions_global_busy_and_cross_origin_cannot_consume() {
    for mode in ["questions", "questions-level2"] {
        let f = Fixture::new(); let mut owner = f.start_as(mode, &f.cwd, "owner-session");
        let first = owner.next(); let id = first["id"].as_str().unwrap().to_string();
        assert_eq!(first["sessionId"], "owner-session");
        wait(|| f.receiver.question_snapshot().pending.as_ref().is_some_and(|q| q.id == id));
        let mut other = f.start_as(mode, &f.cwd, "other-session");
        let second = other.next(); let blocked = other.next();
        assert_ne!(second["id"], id); assert_eq!(second["sessionId"], "other-session");
        assert_eq!(blocked["result"], json!({"status":"busy","id":second["id"]}));
        assert!(blocked["ack"].is_null(), "global busy is not a human answer or ACK");
        let closed: Value = serde_json::from_str(blocked["closedReply"].as_str().unwrap()).unwrap();
        assert_eq!(closed["sessionId"], "other-session"); assert_eq!(closed["id"], second["id"]);
        assert_eq!(closed.as_object().unwrap().len(), 9, "ordinary global busy has no native detail at either level");
        assert!(f.receiver.answer(second["id"].as_str().unwrap(), 1).is_err());
        // Same-UID raw probes model malicious cross-origin claims; they are not
        // fake replacements for either real Node producer or the Rust receiver.
        // Both a cloned session label and a different session must lack the
        // originating connection's authority to cancel/ACK/reject this id.
        for session in ["owner-session", "probe-other-session"] {
            let mut probe = UnixStream::connect(f.receiver.endpoint()).unwrap();
            probe.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            wire(&mut probe, json!({"v":1,"type":"hello","project":f.project,"sessionId":session,"at":epoch_ms()}));
            assert_eq!(wire_line(&mut probe), protocol::READY_LINE);
            wire(&mut probe, json!({"v":1,"type":"questions_hello","project":f.project,"sessionId":session,"at":epoch_ms(),"questionVersion":1}));
            assert_eq!(wire_line(&mut probe), b"{\"v\":1,\"type\":\"questions_ready\",\"questionVersion\":1}\n");
            wire(&mut probe, json!({"v":1,"type":"question_cancel","project":f.project,"sessionId":session,"at":epoch_ms(),"questionVersion":1,"id":id,"reason":"cancelled"}));
            wire(&mut probe, json!({"v":1,"type":"question_resolved","project":f.project,"sessionId":session,"at":epoch_ms(),"questionVersion":1,"id":id,"status":"answered"}));
            wire(&mut probe, json!({"v":1,"type":"question_answer_rejected","project":f.project,"sessionId":session,"at":epoch_ms(),"questionVersion":1,"id":id,"reason":"invalid_answer"}));
            // A wrong-session frame then closes this probe. EOF proves the
            // receiver processed the preceding claims, not just that we took
            // an early snapshot before they arrived.
            wire(&mut probe, json!({"v":1,"type":"question_cancel","project":f.project,"sessionId":"wrong-scope","at":epoch_ms(),"questionVersion":1,"id":id,"reason":"cancelled"}));
            assert!(wire_line(&mut probe).is_empty());
            let view = f.receiver.question_snapshot();
            assert_eq!(view.pending.as_ref().unwrap().id, id);
            // The host view intentionally exposes no session/token fields;
            // owner metadata and the subsequent real result prove routing.
            assert!(view.deliveries.is_empty());
            wait(|| f.connections.load(Ordering::SeqCst) == 2);
        }
        f.receiver.answer(&id, 1).unwrap();
        let done = owner.next();
        assert_eq!(done["result"], json!({"status":"answered","id":id,"answer":{"type":"option","value":"opaque-real-B"}}));
        assert_eq!(done["ack"], json!({"id":id,"status":"answered"}));
        wait(|| { let view = f.receiver.question_snapshot(); view.pending.is_none() && view.deliveries.is_empty()
            && view.notice == Some(transport::QuestionOutcome::Answered) });
        assert_eq!(f.connections.load(Ordering::SeqCst), 2, "real owner ACK consumed before socket closure");
        assert!(f.receiver.answer(&id, 0).is_err(), "cannot decide twice");
        other.finish(); owner.finish(); wait(|| f.connections.load(Ordering::SeqCst) == 0);
    }
}

#![cfg(target_os = "linux")]
// Linux-only integration: real receiver sockets, SO_PEERCRED, and XDG runtime policy.

//! QP.2: owner-only fake producers, real private UDS, no app or model.
mod common;
use abito_island::{protocol, question, transport::{self, Transport, TransportOptions}};
use serde_json::{json, Value};
use std::io::{Read, Write, ErrorKind};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak, Barrier};

const ID: &str = "12345678-1234-4abc-8abc-123456789abc";
const OTHER: &str = "12345678-1234-4abc-9abc-123456789abd";
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 }
struct Fixture { transport: Arc<Transport>, leaf: common::fixture_leaf::Leaf, root: PathBuf, project: String, changes: Arc<AtomicU64>, notices: Arc<Mutex<protocol::NoticeStore>>, counts: Arc<Mutex<Vec<u32>>> }
impl Fixture {
    fn new() -> Self { Self::with_callback_close(false) }
    fn with_callback_close(close_from_callback: bool) -> Self { Self::build(close_from_callback, 90_000) }
    fn build(close_from_callback: bool, idle_ms: u64) -> Self {
        // Three-byte leaves keep sockaddr_un within 107 bytes in this long
        // worktree. The leaf is exclusive, self-cleaning (drop, even while
        // panicking) and abandoned leaves of dead runs are reclaimed (N7).
        let leaf = common::fixture_leaf::Leaf::alloc(&PathBuf::from(env!("CARGO_TARGET_TMPDIR")), "q");
        let root = leaf.path().to_path_buf();
        let project = protocol::project_id("question-receiver-test");
        let holder: Arc<Mutex<Option<Weak<Transport>>>> = Arc::new(Mutex::new(None));
        let changes = Arc::new(AtomicU64::new(0));
        let callback_holder = holder.clone(); let callback_changes = changes.clone();
        let notices = Arc::new(Mutex::new(protocol::NoticeStore::new(&project)));
        let counts = Arc::new(Mutex::new(Vec::new()));
        let observed_notices = notices.clone(); let observed_counts = counts.clone();
        let options = TransportOptions::new(&root, &project).idle_ms(idle_ms).on_connections(move |count| {
            observed_notices.lock().unwrap().connections_changed(count, now());
            observed_counts.lock().unwrap().push(count);
        }).on_question_change(move || {
            callback_changes.fetch_add(1, Ordering::SeqCst);
            let weak = callback_holder.lock().unwrap().clone();
            // Reentrant read proves the question mutex was dropped before the
            // observer runs. Weak avoids making the receiver own itself.
            if let Some(transport) = weak.and_then(|weak| weak.upgrade()) {
                if close_from_callback { transport.close().unwrap(); }
                let _ = transport.question_snapshot();
            }
        });
        let failed_notices = notices.clone();
        let transport = Arc::new(transport::create_transport_observed(options, move |failure| {
            failed_notices.lock().unwrap().transport_failed(failure, now());
        }).unwrap());
        *holder.lock().unwrap() = Some(Arc::downgrade(&transport));
        Self { transport, leaf, root, project, changes, notices, counts }
    }
    fn base(&self, kind: &str, session: &str) -> Value {
        json!({"v":1,"type":kind,"project":self.project,"sessionId":session,"at":now()})
    }
    fn qp(&self, kind: &str, session: &str, id: &str) -> Value {
        let mut v = self.base(kind, session); v["questionVersion"] = json!(1);
        if kind != "questions_hello" { v["id"] = json!(id); }
        v
    }
    fn question(&self, session: &str, id: &str) -> Value {
        let mut v = self.qp("question", session, id);
        v["kind"] = json!("question"); v["text"] = json!("Private question");
        v["options"] = json!([{"value":"opaque-A","label":"First","description":"One"}, {"value":"opaque-B","label":"Second","description":"Two"}]);
        v["allowFreeText"] = json!(true); v["expiresAt"] = json!(now()+30_000); v
    }
    fn connect_level2(&self, session: &str) -> UnixStream {
        let mut s = self.connect(session, false);
        let mut hello = self.qp("questions_hello", session, ID); hello["busyReason"] = json!(1);
        send(&mut s, &hello);
        assert_eq!(line(&mut s), b"{\"v\":1,\"type\":\"questions_ready\",\"questionVersion\":1,\"busyReason\":1}\n");
        s
    }
    fn connect(&self, session: &str, opt_in: bool) -> UnixStream {
        let mut s = UnixStream::connect(self.transport.endpoint()).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        send(&mut s, &self.base("hello", session));
        assert_eq!(line(&mut s), protocol::READY_LINE);
        if opt_in {
            send(&mut s, &self.qp("questions_hello", session, ID));
            assert_eq!(line(&mut s), question::QUESTIONS_READY_LINE);
        }
        s
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.transport.close().unwrap();
        // Only socket fixtures were created: anything but the leaf's own owner
        // marker left behind (a file, a transcript) fails the test, as before.
        let leftovers: Vec<_> = std::fs::read_dir(&self.root).map(|d| d.flatten().map(|e| e.file_name()).filter(|n| n != ".owner").collect()).unwrap_or_default();
        if !std::thread::panicking() { assert!(leftovers.is_empty(), "fixture leaf not clean after close: {leftovers:?}"); }
        let _ = &self.leaf; // removed when the field drops, right after this body
    }
}
fn send(s: &mut UnixStream, v: &Value) { s.write_all(format!("{v}\n").as_bytes()).unwrap(); }
fn line(s: &mut UnixStream) -> Vec<u8> {
    let mut out = Vec::new(); let mut b = [0];
    loop { match s.read(&mut b) { Ok(1) => { out.push(b[0]); if b[0] == b'\n' { return out; } }, Ok(0) => return out, other => panic!("read line: {other:?}") } }
}
fn quiet(s: &mut UnixStream) {
    s.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
    let mut b = [0]; let e = s.read(&mut b).expect_err("no extra bytes and no EOF");
    assert!(matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut));
    s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
}
fn closed(s: &mut UnixStream) { assert!(line(s).is_empty(), "must fail closed without reply"); }
fn wait(mut f: impl FnMut() -> bool) {
    let end = Instant::now()+Duration::from_secs(3);
    while !f() { assert!(Instant::now()<end, "state deadline"); std::thread::sleep(Duration::from_millis(10)); }
}

#[test]
fn r0_same_uid_foreign_project_reaches_question_and_routes_answer() {
    let f = Fixture::new();
    let foreign = protocol::project_id("/some-other-project");
    assert_ne!(foreign, f.project);
    let mut s = UnixStream::connect(f.transport.endpoint()).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let foreign_frame = |mut frame: Value| { frame["project"] = json!(foreign); frame };
    send(&mut s, &foreign_frame(f.base("hello", "foreign-session")));
    assert_eq!(line(&mut s), protocol::READY_LINE, "same-uid foreign hello accepted");
    send(&mut s, &foreign_frame(f.qp("questions_hello", "foreign-session", ID)));
    assert_eq!(line(&mut s), question::QUESTIONS_READY_LINE);
    send(&mut s, &foreign_frame(f.question("foreign-session", ID)));
    pending(&f, ID);
    f.transport.answer(ID, 1).unwrap();
    let answer = reply(&mut s);
    assert_eq!(answer["project"], foreign, "question retains its originating project");
    assert_eq!(answer["sessionId"], "foreign-session");
    assert_eq!(answer["answer"]["value"], "opaque-B");
}

#[test]
fn r24_manual_folds_keep_the_pending_snapshot_deadline_and_live_answer() {
    use abito_island::{core::{Core, WindowIo, ReleaseOutcome}, geometry::Rect, questioncmd};
    struct Io;
    impl WindowIo for Io {
        fn outer_position(&self) -> (i32, i32) { (0, 0) }
        fn size(&self) -> (i32, i32) { (672, 340) }
        fn scale(&self) -> f64 { 1.0 }
        fn set_outer_position(&self, _: i32, _: i32) { panic!("fold must not move the window"); }
    }
    for short_click in [false, true] {
        let f = Fixture::new();
        let mut producer = f.connect("session-1", true);
        send(&mut producer, &f.question("session-1", ID)); pending(&f, ID);
        let before = serde_json::to_value(f.transport.question_snapshot()).unwrap();
        let area = Rect { x: 0, y: 0, w: 1920, h: 1080 };
        let mut core = Core::new(); core.expanded = true;
        f.transport.with_question_pending(|pending| {
            assert!(pending);
            if short_click {
                core.press(&Io, (20.0, 20.0));
                assert!(matches!(questioncmd::guarded_release(&mut core, &Io, area,
                    (20.0, 20.0), false, pending), ReleaseOutcome::Toggle(_)));
            } else {
                assert!(questioncmd::collapse_allowed(core.expanded, pending));
                core.toggle(&Io, area);
            }
            assert!(!core.expanded);
        });
        quiet(&mut producer); // no question_closed/cancel/expire or default answer
        let after = serde_json::to_value(f.transport.question_snapshot()).unwrap();
        assert_eq!(after["pending"], before["pending"], "same question and original deadline for Responder");
        assert_eq!(after["deliveries"], before["deliveries"]);
        assert_eq!(after["notice"], before["notice"]);
        core.toggle(&Io, area); // compact Responder reopens without replacing the question
        assert!(core.expanded);
        f.transport.answer(ID, 1).unwrap();
        let answer = reply(&mut producer);
        assert_eq!(answer["type"], "answer");
        assert_eq!(answer["source"], "human");
        assert_eq!(answer["answer"]["value"], "opaque-B");
    }
}

#[test]
fn question_level2_busy_stays_minimal_with_fixed_native_geometry() {
    let f = Fixture::new();
    let mut old = f.connect("same-session", true); let mut new = f.connect_level2("same-session");
    send(&mut new, &f.question("same-session", ID)); pending(&f, ID);
    assert_eq!(f.transport.question_snapshot().native_transition, abito_island::questioncmd::NativeTransition::Idle);
    // the same connection asking again gets the minimal busy frame (no busyReason)
    send(&mut new, &f.question("same-session", OTHER)); let busy = reply(&mut new);
    assert_eq!(busy["reason"], "busy"); assert_eq!(busy["source"], "system");
    assert!(busy.get("busyReason").is_none()); assert_eq!(busy.as_object().unwrap().len(), 9);
    pending(&f, ID);
    // another connection of the same session now waits instead of being refused
    send(&mut old, &f.question("same-session", OTHER)); quiet(&mut old);
    wait(|| f.transport.question_snapshot().queued_count == 1);
    pending(&f, ID);
}
#[test]
fn question_level2_malformed_capability_and_duplicate_negotiation_fail_closed() {
    let f = Fixture::new();
    for bad in [json!(null),json!(0),json!(true),json!("1"),json!(1.0),json!(1.5),json!(2)] {
        let mut s = f.connect("session-1", false);
        let mut hello = f.qp("questions_hello", "session-1", ID); hello["busyReason"] = bad;
        send(&mut s, &hello); closed(&mut s);
    }
    for mode in ["duplicate","extra","oversize"] {
        let mut s = f.connect("session-1", false);
        let mut hello = f.qp("questions_hello", "session-1", ID); hello["busyReason"] = json!(1);
        let raw = match mode {
            "duplicate" => hello.to_string().replacen("{", "{\"busyReason\":1,", 1),
            "extra" => { hello["source"] = json!("human"); hello.to_string() },
            _ => { let raw = hello.to_string(); format!("{raw}{}", " ".repeat(4097-raw.len())) },
        };
        s.write_all(format!("{raw}\n").as_bytes()).unwrap(); closed(&mut s);
    }
    let mut s = f.connect_level2("session-1");
    send(&mut s, &f.qp("questions_hello", "session-1", ID)); closed(&mut s);
}
#[test]
fn legacy_ready_has_no_unsolicited_capability() {
    let f = Fixture::new(); let mut s = f.connect("session-1", false); quiet(&mut s);
    send(&mut s, &f.base("heartbeat", "session-1")); quiet(&mut s);
}
#[test]
fn question_opt_in_body_can_be_exact4096() {
    let f = Fixture::new(); let mut s = f.connect("session-1", false);
    let hello = f.qp("questions_hello", "session-1", ID).to_string();
    let body = format!("{hello}{}\n", " ".repeat(4096-hello.len()));
    for chunk in body.as_bytes().chunks(113) { s.write_all(chunk).unwrap(); }
    assert_eq!(line(&mut s), question::QUESTIONS_READY_LINE);
}

#[test]
fn scoped_opt_in_is_exact_and_only_once() {
    let f = Fixture::new(); let mut s = f.connect("session-1", true); quiet(&mut s);
    send(&mut s, &f.qp("questions_hello", "session-1", ID)); closed(&mut s);
}

fn pending(f: &Fixture, id: &str) {
    wait(|| f.transport.question_snapshot().pending.as_ref().is_some_and(|q| q.id == id));
}
fn reply(s: &mut UnixStream) -> Value { serde_json::from_slice(&line(s)).unwrap() }
#[test]
fn fragmented_exact4096_question_and_original_socket_answer_once() {
    let f = Fixture::new(); let mut a = f.connect("same-session", true);
    let mut b = f.connect("same-session", true);
    let q = f.question("same-session", ID).to_string();
    let body = format!("{q}{}\n", " ".repeat(4096-q.len()));
    for chunk in body.as_bytes().chunks(113) { a.write_all(chunk).unwrap(); }
    pending(&f, ID);
    let view = f.transport.question_snapshot();
    assert_eq!(view.pending.unwrap().options[1].label, "Second");
    assert!(!serde_json::to_string(&f.transport.question_snapshot()).unwrap().contains("opaque-"));
    assert!(f.transport.answer(OTHER, 1).is_err());
    assert!(f.transport.answer(ID, 9).is_err());
    f.transport.answer(ID, 1).unwrap();
    let v = reply(&mut a);
    assert_eq!(v["id"], ID); assert_eq!(v["source"], "human");
    assert_eq!(v["answer"], json!({"type":"option","value":"opaque-B"}));
    quiet(&mut b);
    assert!(f.transport.answer(ID, 0).is_err());
    let view = f.transport.question_snapshot();
    assert!(view.pending.is_none()); assert_eq!(view.deliveries.len(), 1);
    assert_eq!(serde_json::to_value(&view.deliveries[0]).unwrap()["state"], "sent");
}
#[test]
fn other_connections_queue_behind_and_only_the_same_connection_or_overflow_is_busy() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true);
    let mut b = f.connect("session-1", true); let mut c = f.connect("session-2", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    // a second question on the SAME connection: busy to its origin, nothing stored, text never leaks
    let mut q = f.question("session-1", OTHER); q["text"] = json!("second private content");
    send(&mut a, &q); let v = reply(&mut a);
    assert_eq!(v["reason"], "busy"); assert_eq!(v["source"], "system"); assert_eq!(v["id"], OTHER);
    assert_eq!(f.transport.question_snapshot().notice, Some(transport::QuestionOutcome::Busy));
    assert!(!serde_json::to_string(&f.transport.question_snapshot()).unwrap().contains("second private content"));
    assert_eq!(f.transport.question_snapshot().queued_count, 0);
    // other connections (same or other session) wait behind the first: no reply, shown one at a time
    send(&mut b, &f.question("session-1", OTHER)); quiet(&mut b);
    let third = "12345678-1234-4abc-8abc-123456789abe";
    send(&mut c, &f.question("session-2", third)); quiet(&mut c);
    wait(|| f.transport.question_snapshot().queued_count == 2);
    let snap = f.transport.question_snapshot();
    assert_eq!(snap.pending.as_ref().unwrap().id, ID);
    assert_eq!(snap.queued.iter().map(|q| q.id.as_str()).collect::<Vec<_>>(), vec![OTHER, third]);
    // answering the head promotes the next and leaves the last one waiting
    f.transport.decline(ID).unwrap();
    wait(|| f.transport.question_snapshot().pending.as_ref().is_some_and(|p| p.id == OTHER));
    assert_eq!(f.transport.question_snapshot().queued_count, 1);
}
#[test]
fn missing_opt_in_scope_uuid_extras_and_oversize_fail_closed() {
    let f = Fixture::new();
    let mut old = f.connect("session-1", false);
    send(&mut old, &f.question("session-1", ID)); closed(&mut old);
    for mode in 0..6 {
        let mut s = f.connect("session-1", true); let mut q = f.question("session-1", ID);
        match mode {
            0 => q["sessionId"] = json!("other"),
            1 => q["project"] = json!("f".repeat(64)),
            2 => q["id"] = json!("wrong-uuid"),
            3 => q["source"] = json!("human"),
            4 => q["questionVersion"] = json!(2),
            _ => {},
        }
        if mode == 5 {
            let raw = q.to_string(); s.write_all(format!("{raw}{}\n", " ".repeat(4097-raw.len())).as_bytes()).unwrap();
        } else { send(&mut s, &q); }
        closed(&mut s); assert!(f.transport.question_snapshot().pending.is_none());
    }
    let mut s = f.connect("session-1", false);
    send(&mut s, &f.qp("questions_hello", "other", ID)); closed(&mut s);
}
#[test]
fn legacy_limits_and_schema_remain_after_opt_in() {
    let f = Fixture::new(); let mut s = f.connect("session-1", true);
    send(&mut s, &f.base("heartbeat", "session-1")); quiet(&mut s);
    let raw = f.base("heartbeat", "session-1").to_string();
    s.write_all(format!("{raw}{}\n", " ".repeat(513-raw.len())).as_bytes()).unwrap(); closed(&mut s);
    let mut s = f.connect("session-1", true); let mut v = f.base("settled", "session-1");
    v["id"] = json!("event-1"); v["questionVersion"] = json!(1); send(&mut s, &v); closed(&mut s);
}
#[test]
fn human_decline_ack_correlation_and_new_pending_survives_old_ack() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true); let mut b = f.connect("session-1", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    let mut ack = f.qp("question_resolved", "session-1", ID); ack["status"] = json!("human_cancelled");
    send(&mut a, &ack); quiet(&mut a); pending(&f, ID); // unsolicited ACK cannot consume pending
    f.transport.decline(ID).unwrap(); let v = reply(&mut a);
    assert_eq!(v["type"], "question_closed"); assert_eq!(v["source"], "human"); assert_eq!(v["reason"], "cancelled");
    assert!(v.get("answer").is_none()); assert!(f.transport.decline(ID).is_err());
    send(&mut b, &ack); quiet(&mut b); assert_eq!(f.transport.question_snapshot().deliveries.len(), 1);
    send(&mut b, &f.question("session-1", OTHER)); pending(&f, OTHER);
    send(&mut a, &ack);
    wait(|| f.transport.question_snapshot().deliveries.is_empty()); pending(&f, OTHER);
    assert_eq!(f.transport.question_snapshot().notice, Some(transport::QuestionOutcome::HumanCancelled));
}
#[test]
fn rejection_only_correct_sent_origin_never_resurrects() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true); let mut b = f.connect("session-1", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID); f.transport.answer(ID, 0).unwrap(); reply(&mut a);
    let mut rejected = f.qp("question_answer_rejected", "session-1", ID); rejected["reason"] = json!("invalid_answer");
    send(&mut b, &rejected); quiet(&mut b); assert_eq!(f.transport.question_snapshot().deliveries.len(), 1);
    send(&mut b, &f.question("session-1", OTHER)); pending(&f, OTHER);
    send(&mut a, &rejected); wait(|| f.transport.question_snapshot().deliveries.is_empty()); pending(&f, OTHER);
    assert_eq!(f.transport.question_snapshot().notice, Some(transport::QuestionOutcome::Rejected));
    assert!(f.transport.answer(ID, 0).is_err());
}
#[test]
fn cancel_and_disconnect_revoke_only_origin_pending_or_delivery() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true); let mut b = f.connect("session-1", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    let mut cancel = f.qp("question_cancel", "session-1", ID); cancel["reason"] = json!("cancelled");
    send(&mut b, &cancel); quiet(&mut b); pending(&f, ID);
    send(&mut a, &cancel); wait(|| f.transport.question_snapshot().pending.is_none()); quiet(&mut a);
    send(&mut a, &f.question("session-1", OTHER)); pending(&f, OTHER); drop(b); pending(&f, OTHER);
    drop(a); wait(|| f.transport.question_snapshot().pending.is_none());
    let mut a = f.connect("session-1", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID); f.transport.answer(ID, 0).unwrap(); reply(&mut a);
    drop(a); wait(|| f.transport.question_snapshot().deliveries.is_empty());
    assert_eq!(f.transport.question_snapshot().notice, Some(transport::QuestionOutcome::Disconnected));
}
#[test]
fn free_text_whole4096_and4097_rejected_before_write() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    let overhead = json!({"v":1,"type":"answer","questionVersion":1,"project":f.project,"sessionId":"session-1","at":now(),"id":ID,"source":"human","answer":{"type":"text","text":""}}).to_string().len();
    let budget = 4096-overhead; let text = format!("{}{}", "🙂".repeat(budget/4), "a".repeat(budget%4));
    assert!(f.transport.answer_text(ID, format!("{text}a")).is_err()); quiet(&mut a); pending(&f, ID);
    f.transport.answer_text(ID, text.clone()).unwrap(); let bytes = line(&mut a); assert_eq!(bytes.len(), 4097);
    let v: Value = serde_json::from_slice(&bytes).unwrap(); assert_eq!(v["answer"]["text"], text);
    let mut ack = f.qp("question_resolved", "session-1", ID); ack["status"] = json!("answered"); send(&mut a, &ack);
    wait(|| f.transport.question_snapshot().deliveries.is_empty());
    assert_eq!(f.transport.question_snapshot().notice, Some(transport::QuestionOutcome::Answered));
}
#[test]
fn unanswered_expiry_has_no_default_and_late_click_fails() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    let deadline = f.transport.question_snapshot().pending.unwrap().expires_at;
    std::thread::sleep(Duration::from_millis(deadline.saturating_sub(now())+80));
    assert!(f.transport.question_snapshot().pending.is_none());
    assert_eq!(f.transport.question_snapshot().notice, Some(transport::QuestionOutcome::Expired));
    assert!(f.transport.answer(ID, 0).is_err()); quiet(&mut a);
    assert!(!serde_json::to_string(&f.transport.question_snapshot()).unwrap().contains("Private question"));
}
#[test]
fn question_callback_can_close_receiver_without_joining_itself() {
    let f = Fixture::with_callback_close(true);
    let mut a = f.connect("session-1", true);
    closed(&mut a);
    wait(|| !f.transport.endpoint().exists());
    wait(|| f.transport.question_snapshot().ready_connections == 0);
}

#[test]
fn simultaneous_human_replies_are_consumed_once_and_callbacks_are_reentrant() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true);
    wait(|| f.transport.question_snapshot().ready_connections == 1);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    let barrier = Arc::new(Barrier::new(3));
    let first = f.transport.clone(); let second = f.transport.clone();
    let b1 = barrier.clone(); let b2 = barrier.clone();
    let t1 = std::thread::spawn(move || { b1.wait(); first.answer(ID, 0) });
    let t2 = std::thread::spawn(move || { b2.wait(); second.decline(ID) });
    barrier.wait(); let results = [t1.join().unwrap(), t2.join().unwrap()];
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    reply(&mut a); quiet(&mut a); assert!(f.transport.question_snapshot().pending.is_none());
    drop(a); wait(|| f.transport.question_snapshot().ready_connections == 0);
    assert!(f.changes.load(Ordering::SeqCst) >= 4); // ready, pending, sent, disconnect
}
#[test]
fn bounded_delivery_receipts_are_not_evicted_or_reused_before_ack() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true);
    let ids: Vec<_> = (0..9).map(|i| format!("12345678-1234-4abc-8abc-{i:012x}")).collect();
    for id in &ids[..8] {
        send(&mut a, &f.question("session-1", id)); pending(&f, id); f.transport.answer(id, 0).unwrap(); reply(&mut a);
    }
    assert_eq!(f.transport.question_snapshot().deliveries.len(), 8);
    for id in [&ids[8], &ids[0]] {
        send(&mut a, &f.question("session-1", id)); assert_eq!(reply(&mut a)["reason"], "busy");
    }
    assert!(f.transport.question_snapshot().pending.is_none());
    let mut ack = f.qp("question_resolved", "session-1", &ids[0]); ack["status"] = json!("human_cancelled");
    send(&mut a, &ack); quiet(&mut a); assert_eq!(f.transport.question_snapshot().deliveries.len(), 8);
    ack["status"] = json!("answered"); send(&mut a, &ack);
    wait(|| f.transport.question_snapshot().deliveries.len() == 7);
    send(&mut a, &f.question("session-1", &ids[8])); pending(&f, &ids[8]);
}
#[test]
fn scoped_cancel_removes_sent_but_never_other_pending_and_early_expiry_is_ignored() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true); let mut b = f.connect("session-2", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    let mut cancel = f.qp("question_cancel", "session-1", ID); cancel["reason"] = json!("expired");
    send(&mut a, &cancel); quiet(&mut a); pending(&f, ID);
    f.transport.answer(ID, 0).unwrap(); reply(&mut a);
    send(&mut b, &f.question("session-2", OTHER)); pending(&f, OTHER);
    cancel["reason"] = json!("cancelled"); send(&mut a, &cancel);
    wait(|| f.transport.question_snapshot().deliveries.is_empty()); pending(&f, OTHER); quiet(&mut a);
}
#[test]
fn question_frames_share_original_120_per_minute_quota() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true);
    let mut cancel = f.qp("question_cancel", "session-1", ID); cancel["reason"] = json!("cancelled");
    // hello + questions_hello + 118 frames = 120. Each bounded write is
    // below both batch limits; the next complete frame is the rate failure.
    for _ in 0..118 { send(&mut a, &cancel); }
    quiet(&mut a); send(&mut a, &cancel); closed(&mut a);
}

#[test]
fn lost_ack_is_never_answerable_and_removed_at_original_deadline() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    let deadline = f.transport.question_snapshot().pending.unwrap().expires_at;
    f.transport.answer(ID, 0).unwrap(); reply(&mut a); assert!(f.transport.answer(ID, 0).is_err());
    std::thread::sleep(Duration::from_millis(deadline.saturating_sub(now())+80));
    assert!(f.transport.question_snapshot().deliveries.is_empty());
    assert_eq!(f.transport.question_snapshot().notice, Some(transport::QuestionOutcome::AckLost)); quiet(&mut a);
}
#[test]
fn the_view_names_who_asks_agent_and_project_and_old_producers_stay_unlabelled() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true); let mut b = f.connect("session-2", true);
    let mut q = f.question("session-1", ID); q["agent"] = json!("codex"); q["projectName"] = json!("proyecto-beta");
    send(&mut a, &q); pending(&f, ID);
    send(&mut b, &f.question("session-2", OTHER)); // an old producer: no agent, no projectName
    wait(|| f.transport.question_snapshot().queued_count == 1);
    let v = serde_json::to_value(f.transport.question_snapshot()).unwrap();
    assert_eq!(v["pending"]["agent"], "codex"); assert_eq!(v["pending"]["agent_label"], "Codex");
    assert_eq!(v["pending"]["project_name"], "proyecto-beta");
    assert_eq!(v["queued"][0]["agent"], "pi"); assert!(v["queued"][0].get("project_name").is_none());
    // a refused project name never reaches the view
    let mut c = f.connect("session-3", true);
    let mut bad = f.question("session-3", "12345678-1234-4abc-8abc-123456789abf"); bad["projectName"] = json!("a/b");
    send(&mut c, &bad); closed(&mut c);
    assert_eq!(f.transport.question_snapshot().queued_count, 1);
}

// ---- structured: negotiated multiSelect / questionnaire over the real socket ---------------------
fn opts_json(n: usize) -> Value {
    Value::Array((0..n).map(|i| json!({"value":format!("v{}", i + 1),"label":format!("Opción {}", i + 1),"description":""})).collect())
}
fn structured_connect(f: &Fixture, session: &str) -> UnixStream {
    let mut s = f.connect(session, false);
    let mut hello = f.qp("questions_hello", session, ID); hello["structured"] = json!(1);
    send(&mut s, &hello);
    let ready = reply(&mut s);
    assert_eq!(ready["type"], "questions_ready"); assert_eq!(ready["structured"], json!(1));
    s
}
#[test]
fn structured_multi_select_and_questionnaire_roundtrip_and_old_clients_are_refused() {
    let f = Fixture::new();
    // multiSelect: answered with a list, delivered whole to the origin
    let mut a = structured_connect(&f, "session-1");
    let mut q = f.question("session-1", ID); q["multiSelect"] = json!(true); q["options"] = opts_json(3); q["allowFreeText"] = json!(false);
    send(&mut a, &q); pending(&f, ID);
    let v = serde_json::to_value(f.transport.question_snapshot()).unwrap();
    assert_eq!(v["pending"]["multi_select"], json!(true)); assert_eq!(v["pending"]["free_text_max"], json!(4000));
    assert!(f.transport.answer_many(ID, vec![0, 0], None).is_err(), "duplicates are refused");
    pending(&f, ID);
    f.transport.answer_many(ID, vec![2, 0], None).unwrap();
    let got = reply(&mut a);
    assert_eq!(got["answer"], json!({"type":"options","values":["v1","v3"]}));
    // questionnaire: one queue slot, all-or-nothing
    let form = json!([{"header":"Ruta","text":"¿Ruta?","options":opts_json(2)},{"header":"Extras","text":"¿Extras?","options":opts_json(3),"multiSelect":true,"allowFreeText":true}]);
    let mut b = structured_connect(&f, "session-2");
    let mut fq = f.question("session-2", OTHER); fq["questions"] = form; fq["options"] = json!([]); fq["allowFreeText"] = json!(false);
    send(&mut b, &fq); pending(&f, OTHER);
    let v = serde_json::to_value(f.transport.question_snapshot()).unwrap();
    assert_eq!(v["pending"]["form"].as_array().unwrap().len(), 2);
    assert_eq!(v["pending"]["form"][1]["multi_select"], json!(true)); assert_eq!(v["queued_count"], json!(0));
    assert!(f.transport.answer_form(OTHER, vec![abito_island::question::ItemAnswer::Option { index: 0 }]).is_err(), "partial answer refused");
    pending(&f, OTHER);
    f.transport.answer_form(OTHER, vec![abito_island::question::ItemAnswer::Option { index: 1 },
        abito_island::question::ItemAnswer::Options { indexes: vec![2], text: Some("y más".into()) }]).unwrap();
    let got = reply(&mut b);
    assert_eq!(got["answer"], json!({"type":"form","answers":[{"type":"option","value":"v2"},{"type":"options","values":["v3"],"text":"y más"}]}));
    // a connection that did NOT negotiate it is closed on a structured field (old behaviour for unknown shapes)
    let mut old = f.connect("session-3", true);
    let mut bad = f.question("session-3", "12345678-1234-4abc-8abc-123456789abf"); bad["multiSelect"] = json!(true);
    send(&mut old, &bad); closed(&mut old);
    // and old frames keep working on a structured connection
    let mut c = structured_connect(&f, "session-4");
    send(&mut c, &f.question("session-4", "12345678-1234-4abc-8abc-123456789ac0")); pending(&f, "12345678-1234-4abc-8abc-123456789ac0");
}

// R16: hook sockets end after one exchange; counts alone are not failures.
#[test]
fn completed_hook_exchange_closes_without_transport_failure() {
    for mode in ["answered", "declined", "cancelled", "expired", "settled"] {
        let f = Fixture::new(); let mut s = f.connect("hook", mode != "settled");
        if mode == "settled" {
            let mut v = f.base("settled", "hook"); v["id"] = json!(ID);
            send(&mut s, &v);
            // A heartbeat behind settled plus quiet ensures the callback ran.
            send(&mut s, &f.base("heartbeat", "hook")); quiet(&mut s);
        } else {
            let q = f.question("hook", ID);
            send(&mut s, &q); pending(&f, ID);
            match mode {
                "answered" | "declined" => {
                    if mode == "answered" { f.transport.answer(ID, 0).unwrap(); }
                    else { f.transport.decline(ID).unwrap(); }
                    reply(&mut s);
                    let mut ack = f.qp("question_resolved", "hook", ID);
                    ack["status"] = json!(if mode == "answered" { "answered" } else { "human_cancelled" });
                    send(&mut s, &ack);
                    wait(|| f.transport.question_snapshot().deliveries.is_empty());
                }
                "cancelled" => {
                    let mut cancel = f.qp("question_cancel", "hook", ID); cancel["reason"] = json!("cancelled");
                    send(&mut s, &cancel);
                    wait(|| f.transport.question_snapshot().pending.is_none());
                }
                _ => {
                    std::thread::sleep(Duration::from_millis(q["expiresAt"].as_u64().unwrap().saturating_sub(now()) + 80));
                    wait(|| f.transport.question_snapshot().pending.is_none());
                }
            }
        }
        wait(|| f.counts.lock().unwrap().last() == Some(&1));
        drop(s); wait(|| f.counts.lock().unwrap().last() == Some(&0));
        assert!(f.notices.lock().unwrap().snapshot(now()).iter().all(|n| n.kind != "transport"), "normal {mode} hook close is silent");
    }
}

#[test]
fn abnormal_disconnect_still_notifies_and_reconnect_clears() {
    for mode in ["pending", "unacknowledged", "malformed", "partial"] {
        let f = Fixture::new(); let mut s = f.connect("producer", true);
        if matches!(mode, "pending" | "unacknowledged") {
            send(&mut s, &f.question("producer", ID)); pending(&f, ID);
            if mode == "unacknowledged" { f.transport.answer(ID, 0).unwrap(); reply(&mut s); }
        } else {
            s.write_all(if mode == "malformed" { b"invalid\n" } else { b"{" }).unwrap();
        }
        drop(s); wait(|| f.counts.lock().unwrap().last() == Some(&0));
        wait(|| f.notices.lock().unwrap().snapshot(now()).iter().any(|n| n.kind == "transport"));
        let _reconnected = f.connect("recovery", false);
        wait(|| f.counts.lock().unwrap().last() == Some(&1));
        assert!(f.notices.lock().unwrap().snapshot(now()).iter().all(|n| n.kind != "transport"), "0->1 recovers");
    }
}

#[test]
fn r24b_a_connection_waiting_for_a_human_answer_outlives_the_idle_lease() {
    let f = Fixture::build(false, 600); // idle lease far shorter than the question
    let mut producer = f.connect("session-1", true);
    send(&mut producer, &f.question("session-1", ID)); pending(&f, ID);
    std::thread::sleep(Duration::from_millis(1800)); // three leases of silence
    assert!(f.transport.question_snapshot().pending.as_ref().is_some_and(|q| q.id == ID),
        "a live question must not be revoked by the silent idle lease");
    quiet(&mut producer);
    f.transport.answer(ID, 0).unwrap();
    let answer = reply(&mut producer);
    assert_eq!(answer["type"], "answer");
    assert_eq!(answer["answer"]["value"], "opaque-A");
}

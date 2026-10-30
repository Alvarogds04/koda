use super::*;
use crate::chat::{Conversation, Event, FinishReason, ProfileRef};
use std::sync::atomic::{AtomicU64, Ordering};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "abito-conversations-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn turn(n: u64, text: &str) -> Turn {
    let mut c = Conversation::new("test");
    let a = c
        .submit(
            text,
            "request-test",
            &ProfileRef {
                profile_id: "local-test".into(),
                revision: 1,
                lane_id: "conversation".into(),
            },
        )
        .unwrap();
    c.apply(&a.turn_id, 1, Event::Delta("answer <script> plain".into()))
        .unwrap();
    c.apply(&a.turn_id, 2, Event::Complete(FinishReason::Stop))
        .unwrap();
    let mut t = c.turn(&a.turn_id).unwrap().clone();
    t.turn_id = format!("t-{n}");
    t
}
#[test]
fn create_list_title_order_and_specialist_survive_restart() {
    let temp = Temp::new();
    let dir = temp.0.join("history");
    let mut s = Store::open(&dir).unwrap();
    let first = s
        .create(
            Some(SpecialistRef {
                id: "writer".into(),
                name: "Writer".into(),
            }),
            10,
        )
        .unwrap();
    let second = s.create(None, 20).unwrap();
    assert_ne!(first.id, second.id);
    let text = format!("\n {}", "😀".repeat(85));
    s.append(&first.id, &turn(1, &text), 30).unwrap();
    let s = Store::open(&dir).unwrap();
    let (list, skipped) = s.list().unwrap();
    assert_eq!(skipped, 0);
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].id, first.id);
    assert_eq!(list[0].title, format!("{}…", "😀".repeat(80)));
    assert_eq!(list[0].specialist.as_ref().unwrap().id, "writer");
    assert_eq!(list[0].last_activity, 30);
    assert_eq!(
        s.page(&first.id, None, 25).unwrap().turns[0].user_text,
        text
    );
    assert!(s.page(&second.id, None, 25).unwrap().turns.is_empty());
    assert!(dir.join("index.json").is_file());
}
#[test]
fn paging_is_bounded_chronological_and_snapshot_updates_do_not_duplicate() {
    let temp = Temp::new();
    let mut s = Store::open(&temp.0.join("history")).unwrap();
    let c = s.create(None, 1).unwrap();
    for n in 1..=61 {
        s.append(&c.id, &turn(n, &format!("question {n}")), n)
            .unwrap();
    }
    let mut t = turn(61, "question 61");
    t.reply = "updated".into();
    s.append(&c.id, &t, 99).unwrap();
    let p = s.page(&c.id, None, 25).unwrap();
    assert_eq!(p.turns.len(), 25);
    assert_eq!(p.turns[0].turn_id, "t-37");
    assert_eq!(p.turns[24].reply, "updated");
    assert_eq!(p.before, Some(37));
    let p = s.page(&c.id, p.before, 25).unwrap();
    assert_eq!(p.turns[0].turn_id, "t-12");
    assert_eq!(p.before, Some(12));
    let p = s.page(&c.id, p.before, 25).unwrap();
    assert_eq!(p.turns.len(), 11);
    assert_eq!(p.before, None);
    assert_eq!(s.page(&c.id, None, 999).unwrap().turns.len(), MAX_PAGE_SIZE);
    assert!(s.page(&c.id, None, 0).is_err());
    assert_eq!(s.list().unwrap().0[0].turns, 61);
}
#[test]
fn corrupt_and_truncated_records_are_reported_and_never_erase_good_history() {
    use std::io::Write;
    let temp = Temp::new();
    let dir = temp.0.join("history");
    let mut s = Store::open(&dir).unwrap();
    let c = s.create(None, 1).unwrap();
    s.append(&c.id, &turn(1, "first"), 2).unwrap();
    let file = dir.join(format!("{}.jsonl", c.id));
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .unwrap();
    f.write_all(b"not json\n{\"truncated\":").unwrap();
    drop(f);
    std::fs::write(dir.join("index.json"), "broken").unwrap();
    let mut s = Store::open(&dir).unwrap();
    let p = s.page(&c.id, None, 25).unwrap();
    assert_eq!(p.skipped, 2);
    assert_eq!(p.turns.len(), 1);
    s.append(&c.id, &turn(2, "second"), 3).unwrap();
    let p = s.page(&c.id, None, 25).unwrap();
    assert_eq!(p.turns.len(), 2);
    assert_eq!(p.skipped, 2);
    assert_eq!(s.list().unwrap().0[0].title, "first");
}
#[test]
fn corrupt_turn_counters_cannot_overflow_or_escape_paging_precision() {
    use std::io::Write;
    let temp = Temp::new();
    let dir = temp.0.join("history");
    let mut s = Store::open(&dir).unwrap();
    let c = s.create(None, 1).unwrap();
    s.append(&c.id, &turn(1, "first"), 2).unwrap();
    let path = dir.join(format!("{}.jsonl", c.id));
    let text = std::fs::read_to_string(&path).unwrap();
    let record = text.lines().last().unwrap().replace("\"number\":1", "\"number\":18446744073709551615");
    writeln!(std::fs::OpenOptions::new().append(true).open(path).unwrap(), "{record}").unwrap();
    let p = s.page(&c.id, None, 25).unwrap();
    assert_eq!(p.skipped, 1);
    assert_eq!(p.turns.len(), 1);
    assert_eq!(p.turns[0].turn_id, "t-1");
    let mut convo = Conversation::restore(&c.id, p.turns);
    let a = convo.submit("second", "request-next", &ProfileRef { profile_id:"local-test".into(),revision:1,lane_id:"conversation".into() }).unwrap();
    assert_eq!(a.turn_id, "t-2");
}
#[test]
fn unsafe_ids_and_invalid_turns_do_not_change_files_or_counters() {
    let temp = Temp::new();
    let mut s = Store::open(&temp.0.join("history")).unwrap();
    let c = s.create(None, 1).unwrap();
    let before = std::fs::read(s.dir.join(format!("{}.jsonl", c.id))).unwrap();
    assert!(s.page("../other", None, 25).is_err());
    assert!(s.append("../other", &turn(1, "safe"), 2).is_err());
    let mut t = turn(1, "safe");
    t.turn_id = "../other".into();
    assert!(s.append(&c.id, &t, 2).is_err());
    assert_eq!(
        std::fs::read(s.dir.join(format!("{}.jsonl", c.id))).unwrap(),
        before
    );
    assert_eq!(s.list().unwrap().0[0].turns, 0);
}
#[cfg(unix)]
#[test]
fn private_modes_and_symlink_refusal() {
    use std::os::unix::fs::{symlink, MetadataExt};
    let temp = Temp::new();
    let dir = temp.0.join("history");
    let mut s = Store::open(&dir).unwrap();
    let c = s.create(None, 1).unwrap();
    s.append(&c.id, &turn(1, "private"), 2).unwrap();
    assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
    for file in ["index.json".to_string(), format!("{}.jsonl", c.id)] {
        assert_eq!(
            std::fs::metadata(dir.join(file)).unwrap().mode() & 0o777,
            0o600
        );
    }
    let outside = temp.0.join("outside");
    std::fs::write(&outside, "untouched").unwrap();
    std::fs::remove_file(dir.join(format!("{}.jsonl", c.id))).unwrap();
    symlink(&outside, dir.join(format!("{}.jsonl", c.id))).unwrap();
    assert!(s.append(&c.id, &turn(2, "refused"), 3).is_err());
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "untouched");
    symlink(&dir, temp.0.join("link")).unwrap();
    assert!(Store::open(&temp.0.join("link")).is_err());
}

// --- #343 shape pins: attachment metadata must not change the old record shape --

#[test]
fn old_turn_records_without_attachments_still_load_and_plain_turns_gain_no_key() {
    let temp = Temp::new();
    let dir = temp.0.join("history"); // Store::open creates and tightens it
    let mut store = Store::open(&dir).unwrap();
    let convo = store.create(None, 1).unwrap();
    // A plain turn through the public API persists a record with NO
    // `attachments` key at all (byte-shape preserved for older readers).
    store.append(&convo.id, &turn(1, "texto viejo"), 2).unwrap();
    let file = dir.join(format!("{}.jsonl", convo.id));
    let contents = std::fs::read_to_string(&file).unwrap();
    let turn_line = contents.lines().find(|l| l.contains("\"kind\":\"turn\"")).unwrap();
    assert!(!turn_line.contains("attachments"), "{turn_line}");

    // A record in the OLD shape (attachments key stripped) still loads, with
    // zero attachments — nothing is invented.
    std::fs::write(&file, contents).unwrap();
    let reopened = Store::open(&dir).unwrap();
    let summary = reopened.summary(&convo.id).unwrap();
    let page = reopened.page(&convo.id, None, PAGE_SIZE).unwrap();
    assert_eq!(summary.turns, 1);
    assert_eq!(page.turns[0].user_text, "texto viejo");
    assert_eq!(page.turns[0].reply, "answer <script> plain");
    assert!(page.turns[0].attachments.is_empty());
}

#[test]
fn attachment_metadata_round_trips_and_forged_records_are_refused() {
    let temp = Temp::new();
    let dir = temp.0.join("history"); // Store::open creates and tightens it
    let mut store = Store::open(&dir).unwrap();
    let convo = store.create(None, 1).unwrap();
    let mut t = turn(1, "con adjunto");
    t.attachments = vec![crate::chat::Attachment {
        id: "a-0123456789abcdef".into(),
        name: "notas.txt".into(),
        mime: "text/plain".into(),
        size: 9,
        file: "0123456789abcdef-notas.txt".into(),
    }];
    store.append(&convo.id, &t, 2).unwrap();
    let file = dir.join(format!("{}.jsonl", convo.id));
    let reopened = Store::open(&dir).unwrap();
    let page = reopened.page(&convo.id, None, PAGE_SIZE).unwrap();
    assert_eq!(page.turns[0].attachments.len(), 1);
    assert_eq!(page.turns[0].attachments[0].file, "0123456789abcdef-notas.txt");

    // Stripping the attachments key turns the record into a valid OLD one.
    let contents = std::fs::read_to_string(&file).unwrap();
    let stripped = contents
        .lines()
        .map(|l| match l.find(",\"attachments\":[") {
            Some(i) => {
                let end = l[i..].find("]").map(|e| i + e + 1).unwrap_or(l.len());
                format!("{}{}", &l[..i], &l[end..])
            }
            None => l.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&file, format!("{stripped}\n")).unwrap();
    let reopened = Store::open(&dir).unwrap();
    let page = reopened.page(&convo.id, None, PAGE_SIZE).unwrap();
    assert_eq!(page.turns.len(), 1);
    assert!(page.turns[0].attachments.is_empty(), "the old shape loads with zero attachments");

    // A record whose attachment breaks the stored-name grammar is corrupt:
    // forged from the ORIGINAL record (the one that carries the key).
    let forged = contents.replace("0123456789abcdef-notas.txt", "0123456789abcdef-../escape.txt");
    assert_ne!(forged, contents, "the forged edit must actually change the record");
    std::fs::write(&file, forged).unwrap();
    let reopened = Store::open(&dir).unwrap();
    let page = reopened.page(&convo.id, None, PAGE_SIZE).unwrap();
    assert_eq!(page.turns.len(), 0, "the forged record is skipped, never loaded");
}

// --- #418 shape pins: tool calls and approvals use the optional-key pattern ----

fn card_turn() -> Turn {
    let mut t = turn(1, "con herramientas");
    t.tool_calls = vec![
        crate::chat::ToolCall { call_id: "call_1".into(), name: "read".into(), state: crate::chat::ToolState::Done, summary: None },
        crate::chat::ToolCall { call_id: "call_2".into(), name: "bash".into(), state: crate::chat::ToolState::Failed, summary: Some("La herramienta terminó con error.".into()) },
    ];
    t.approvals = vec![crate::chat::ApprovalDecision { request_id: "req_1".into(), operation: "Enviar correo".into(), decision: crate::chat::Decision::Denied }];
    t
}

#[test]
fn plain_turns_write_no_tool_or_approval_keys_and_old_records_load() {
    let temp = Temp::new();
    let dir = temp.0.join("history");
    let mut store = Store::open(&dir).unwrap();
    let convo = store.create(None, 1).unwrap();
    store.append(&convo.id, &turn(1, "texto viejo"), 2).unwrap();
    let contents = std::fs::read_to_string(dir.join(format!("{}.jsonl", convo.id))).unwrap();
    let line = contents.lines().find(|l| l.contains("\"kind\":\"turn\"")).unwrap();
    assert!(!line.contains("tool_calls") && !line.contains("approvals"), "{line}");
    let page = Store::open(&dir).unwrap().page(&convo.id, None, PAGE_SIZE).unwrap();
    assert!(page.turns[0].tool_calls.is_empty() && page.turns[0].approvals.is_empty());
}

#[test]
fn tool_calls_and_approvals_round_trip_through_history() {
    let temp = Temp::new();
    let dir = temp.0.join("history");
    let mut store = Store::open(&dir).unwrap();
    let convo = store.create(None, 1).unwrap();
    store.append(&convo.id, &card_turn(), 2).unwrap();
    let page = Store::open(&dir).unwrap().page(&convo.id, None, PAGE_SIZE).unwrap();
    assert_eq!(page.turns[0].tool_calls, card_turn().tool_calls);
    assert_eq!(page.turns[0].approvals, card_turn().approvals);
}

#[test]
fn unsafe_cards_are_refused_on_write_and_forged_records_are_skipped_on_read() {
    let temp = Temp::new();
    let dir = temp.0.join("history");
    let mut store = Store::open(&dir).unwrap();
    let convo = store.create(None, 1).unwrap();
    let mut bad = card_turn();
    bad.tool_calls[0].name = "bash\nrm".into();
    assert!(store.append(&convo.id, &bad, 2).is_err());
    let file = dir.join(format!("{}.jsonl", convo.id));
    assert!(!std::fs::read_to_string(&file).unwrap().contains("\"kind\":\"turn\""), "a refused turn writes nothing");
    store.append(&convo.id, &card_turn(), 3).unwrap();
    let contents = std::fs::read_to_string(&file).unwrap();
    for (from, to) in [("\"state\":\"done\"", "\"state\":\"sneaky\""), ("\"decision\":\"denied\"", "\"decision\":\"maybe\""), ("\"call_1\"", "\"bad id\"")] {
        let forged = contents.replace(from, to);
        assert_ne!(forged, contents, "{from}");
        std::fs::write(&file, forged).unwrap();
        let page = Store::open(&dir).unwrap().page(&convo.id, None, PAGE_SIZE).unwrap();
        assert!(page.turns.is_empty(), "{from}: forged record is skipped");
    }
}

use super::*;
use serde_json::json;

const HOUR: i64 = 3600;
/// Monday 5 October 2026, 00:00 UTC — the exact zone does not matter here.
const T0: i64 = 1_791_158_400;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("abito-recap-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn event(name: &str, session: &str, extra: Value) -> Value {
    let mut v = json!({ "hook_event_name": name, "session_id": session, "cwd": "/home/me/code/abito" });
    if let (Some(obj), Value::Object(more)) = (v.as_object_mut(), extra) {
        obj.extend(more);
    }
    v
}

fn on_disk(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn a_turn_is_counted_from_prompt_to_stop() {
    let dir = scratch("turn");
    let file = dir.join("recap.json");
    let mut r = Recap::load(file.clone(), T0);
    r.observe(&event("UserPromptSubmit", "s1", json!({ "prompt": "secret plan" })), T0);
    r.observe(&event("PreToolUse", "s1", json!({ "tool_name": "Bash", "tool_input": { "command": "rm -rf /tmp/x" } })), T0 + 10);
    r.observe(&event("PreToolUse", "s1", json!({ "tool_name": "Read" })), T0 + 20);
    r.observe(&event("PreToolUse", "s1", json!({ "tool_name": "AskUserQuestion" })), T0 + 25);
    r.observe(&event("PostToolUse", "s1", json!({ "tool_name": "Edit", "tool_input": {
        "file_path": "/home/me/code/abito/a.rs", "old_string": "a\nb\nc", "new_string": "a\nB\nc\nd" } })), T0 + 30);
    r.observe(&event("PostToolUse", "s1", json!({ "tool_name": "Write", "tool_input": {
        "file_path": "/home/me/code/abito/b.rs", "content": "one\ntwo\nthree\n" } })), T0 + 40);
    r.observe(&event("PostToolUse", "s1", json!({ "tool_name": "Edit", "tool_input": {
        "file_path": "/home/me/code/abito/a.rs", "old_string": "x", "new_string": "y" } })), T0 + 50);
    r.observe(&event("Stop", "s1", json!({})), T0 + HOUR);

    let view = r.view(0);
    assert_eq!(view.turns, vec![Turn {
        agent: "integration_claude".into(),
        project: "abito".into(),
        start: T0,
        end: T0 + HOUR,
        files_changed: 2,
        lines_added: 2 + 3 + 1,
        lines_removed: 1 + 1,
        commands_run: 1,
        questions: 1,
    }]);

    // Only counts and names reach the disk.
    let written = std::fs::read_to_string(&file).unwrap();
    for secret in ["secret plan", "rm -rf", "a.rs", "/home/me", "one\\ntwo"] {
        assert!(!written.contains(secret), "{secret} must not be stored");
    }
    assert_eq!(on_disk(&file)["turns"][0]["project"], "abito");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn concurrent_sessions_and_agents_are_kept_apart() {
    let dir = scratch("sessions");
    let mut r = Recap::load(dir.join("recap.json"), T0);
    r.observe(&event("UserPromptSubmit", "a", json!({})), T0);
    r.observe(&event("UserPromptSubmit", "b", json!({ "abito_agent": "gemini", "cwd": "C:\\Users\\me\\side-project\\" })), T0 + 60);
    r.observe(&event("PreToolUse", "b", json!({ "abito_agent": "gemini", "tool_name": "run_shell_command" })), T0 + 70);
    r.observe(&event("Stop", "a", json!({})), T0 + 120);
    r.observe(&event("Stop", "b", json!({ "abito_agent": "gemini" })), T0 + 180);
    let turns = r.view(0).turns;
    assert_eq!(turns.len(), 2);
    assert_eq!((turns[0].agent.as_str(), turns[0].commands_run), ("integration_claude", 0));
    assert_eq!(turns[1].agent, "agent_gemini");
    assert_eq!(turns[1].project, "side-project");
    assert_eq!(turns[1].commands_run, 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn invalid_or_reserved_agent_tags_fall_back_to_claude_code() {
    for tag in ["claude", "Gemini", "has space", "a-very-long-agent-name-over-24"] {
        assert_eq!(agent_id(&json!({ "abito_agent": tag })), "integration_claude", "{tag}");
    }
    assert_eq!(agent_id(&json!({ "abito_agent": "codex" })), "agent_codex");
}

#[test]
fn a_turn_counts_for_the_pill_it_showed_on() {
    // Claude Code in Cursor's terminal is the Cursor pill, as in hooks.ts.
    assert_eq!(agent_id(&json!({ "term_editor": "cursor" })), "agent_cursor");
    // An explicit agent wins over the terminal it runs in.
    assert_eq!(agent_id(&json!({ "abito_agent": "claude-desktop", "term_editor": "cursor" })), "agent_claude-desktop");
    assert_eq!(agent_id(&json!({ "abito_agent": "copilot" })), "agent_copilot");
    assert_eq!(agent_id(&json!({})), "integration_claude");
}

#[test]
fn a_turn_silent_for_two_hours_ends_at_its_last_event() {
    let dir = scratch("stale");
    let mut r = Recap::load(dir.join("recap.json"), T0);
    r.observe(&event("UserPromptSubmit", "s1", json!({})), T0);
    r.observe(&event("PreToolUse", "s1", json!({ "tool_name": "Bash" })), T0 + 600);
    // Next event, from another session, three hours later.
    r.observe(&event("UserPromptSubmit", "s2", json!({})), T0 + 3 * HOUR);
    let turns = r.view(0).turns;
    assert_eq!(turns.len(), 1);
    assert_eq!((turns[0].start, turns[0].end), (T0, T0 + 600));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn decisions_are_recorded_with_the_agent_that_asked() {
    let dir = scratch("decisions");
    let mut r = Recap::load(dir.join("recap.json"), T0);
    r.note_request("r1", &json!({ "abito_agent": "codex" }));
    r.record_decision("r1", "always", T0);
    r.record_decision("unknown", "deny", T0 + 1);
    r.record_decision("r3", "maybe", T0 + 2);
    r.note_request("r4", &json!({}));
    r.forget_request("r4");
    let d = r.view(0).decisions;
    assert_eq!(d.len(), 2);
    assert_eq!((d[0].agent.as_str(), d[0].decision.as_str()), ("agent_codex", "allow"));
    assert_eq!((d[1].agent.as_str(), d[1].decision.as_str()), ("integration_claude", "deny"));
    assert!(r.requests.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn twelve_weeks_are_kept_and_older_entries_pruned() {
    let dir = scratch("prune");
    let file = dir.join("recap.json");
    let mut r = Recap::load(file.clone(), T0);
    let old = T0 - WINDOW_SECS - 1;
    let edge = T0 - WINDOW_SECS;
    for start in [old, edge, T0 - HOUR] {
        r.history.turns.push(Turn {
            agent: "integration_claude".into(), project: "p".into(), start, end: start + 60,
            files_changed: 0, lines_added: 0, lines_removed: 0, commands_run: 0, questions: 0,
        });
    }
    r.history.decisions.push(Decision { agent: "integration_claude".into(), date: old, decision: "allow".into() });
    r.prune(T0);
    r.save();
    assert_eq!(r.view(0).turns.iter().map(|t| t.start).collect::<Vec<_>>(), [edge, T0 - HOUR]);
    assert!(r.view(0).decisions.is_empty());
    // Loading later prunes again.
    let later = Recap::load(file, T0 + 2 * HOUR);
    assert_eq!(later.view(0).turns.len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_history_never_grows_past_its_cap() {
    let dir = scratch("cap");
    let mut r = Recap::load(dir.join("recap.json"), T0);
    for i in 0..(MAX_TURNS as i64 + 5) {
        r.history.turns.push(Turn {
            agent: "a".into(), project: "p".into(), start: T0 - i, end: T0,
            files_changed: 0, lines_added: 0, lines_removed: 0, commands_run: 0, questions: 0,
        });
    }
    r.prune(T0);
    assert_eq!(r.history.turns.len(), MAX_TURNS);
    // The oldest went.
    assert_eq!(r.history.turns.first().unwrap().start, T0 - MAX_TURNS as i64 + 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn names_are_cut_short_and_cleaned() {
    let long = "x".repeat(200);
    assert_eq!(project_name(&format!("/a/{long}")).chars().count(), MAX_NAME_CHARS);
    assert_eq!(project_name("/a/b\u{7}c/"), "bc");
    assert_eq!(project_name(""), "");
    assert_eq!(project_name("C:\\work\\korus"), "korus");
}

#[test]
fn line_counts_match_the_diff_engine() {
    assert_eq!(line_diff("a\nb\nc", "a\nb\nc"), (0, 0));
    assert_eq!(line_diff("a\nb\nc", "a\nx\nc"), (1, 1));
    assert_eq!(line_diff("", "a\nb\n"), (2, 0));
    assert_eq!(line_diff("a\r\nb\r\n", "a\nb\nc\n"), (1, 0));
    // Too big to diff: everything counts.
    let big_old = "l\n".repeat(3000);
    let big_new = "l\n".repeat(1500);
    assert_eq!(line_diff(&big_old, &big_new), (1500, 3000));
    assert_eq!(file_change("Read", &json!({ "file_path": "/x" })), None);
    assert_eq!(file_change("Edit", &json!({ "file_path": "/x", "old_string": "a", "new_string": "a" })), None);
    let multi = json!({ "file_path": "/x", "edits": [
        { "old_string": "a", "new_string": "b" }, { "old_string": "", "new_string": "c\nd" } ] });
    assert_eq!(file_change("MultiEdit", &multi), Some(("/x".into(), 3, 1)));
}

#[test]
fn a_disabled_history_records_nothing_and_clear_keeps_the_prefs() {
    let dir = scratch("disabled");
    let file = dir.join("recap.json");
    let mut r = Recap::load(file.clone(), T0);
    r.observe(&event("UserPromptSubmit", "s", json!({})), T0);
    r.observe(&event("Stop", "s", json!({})), T0 + 60);
    r.set_hide_projects(true);
    r.mark_shown("2026-10-05");
    r.mark_shown("not a week");
    r.clear();
    assert!(r.view(0).turns.is_empty());
    let reloaded = Recap::load(file.clone(), T0);
    assert_eq!(reloaded.prefs(), &Prefs { enabled: true, hide_projects: true, last_shown_week: "2026-10-05".into() });

    r.set_enabled(false);
    r.observe(&event("UserPromptSubmit", "s", json!({})), T0);
    r.observe(&event("Stop", "s", json!({})), T0 + 60);
    r.note_request("r", &json!({}));
    r.record_decision("r", "allow", T0);
    assert!(r.view(0).turns.is_empty() && r.view(0).decisions.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_corrupt_file_is_set_aside_and_writes_leave_nothing_behind() {
    let dir = scratch("corrupt");
    let file = dir.join("recap.json");
    std::fs::write(&file, b"{ not json").unwrap();
    let mut r = Recap::load(file.clone(), T0);
    assert!(r.view(0).turns.is_empty());
    let names = |d: &Path| -> Vec<String> {
        let mut n: Vec<String> = std::fs::read_dir(d).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        n.sort();
        n
    };
    let aside = names(&dir);
    assert_eq!(aside.len(), 1);
    assert!(aside[0].starts_with("recap.json.corrupt-"), "{aside:?}");
    assert_eq!(std::fs::read(dir.join(&aside[0])).unwrap(), b"{ not json");

    r.observe(&event("UserPromptSubmit", "s", json!({})), T0);
    r.observe(&event("Stop", "s", json!({})), T0 + 60);
    let mut expected = vec!["recap.json".to_string(), aside[0].clone()];
    expected.sort();
    assert_eq!(names(&dir), expected);
    assert_eq!(on_disk(&file)["schemaVersion"], 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn base64_round_trips_and_rejects_junk() {
    assert_eq!(decode_base64("data:image/png;base64,aGVsbG8=").unwrap(), b"hello");
    assert_eq!(decode_base64("aGk=").unwrap(), b"hi");
    assert_eq!(decode_base64("YWJj").unwrap(), b"abc");
    assert!(decode_base64("a$b").is_none());
    assert!(decode_base64("aGk=aGk=").is_none());
}

#[test]
fn a_saved_image_never_replaces_an_existing_file() {
    let dir = scratch("png");
    let missing = dir.join("missing");
    let png = "data:image/png;base64,iVBORw0KGgo=";
    let first = save_png(&[missing.clone(), dir.clone()], png, "2026-10-05").unwrap();
    let second = save_png(&[dir.clone()], png, "2026-10-05").unwrap();
    assert_eq!(first, dir.join("Koda weekly recap 2026-10-05.png"));
    assert_eq!(second, dir.join("Koda weekly recap 2026-10-05 (2).png"));
    // The week is a date or nothing: no path tricks through it.
    let third = save_png(&[dir.clone()], png, "../../x").unwrap();
    assert_eq!(third, dir.join("Koda weekly recap.png"));
    // Not a PNG: refused.
    assert!(save_png(&[dir.clone()], "data:image/png;base64,aGVsbG8=", "").is_err());
    assert!(save_png(&[missing], png, "").is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_settled_turn_is_counted_without_tool_counts_and_respects_enabled() {
    let dir = scratch("settled");
    let file = dir.join("recap.json");
    let mut r = Recap::load(file.clone(), T0);
    r.record_settled("agent_pi", "my-proj\u{7}", T0 + 5);
    let v = r.view(0);
    assert_eq!(v.turns.len(), 1);
    assert_eq!(v.turns[0].project, "my-proj");
    assert_eq!((v.turns[0].files_changed, v.turns[0].commands_run, v.turns[0].questions), (0, 0, 0));
    r.set_enabled(false);
    r.record_settled("agent_pi", "x", T0 + 9);
    assert_eq!(r.view(0).turns.len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn utc_stamp_and_picture_dirs_are_plain() {
    assert_eq!(utc_stamp(T0), "20261005-000000");
    assert_eq!(utc_stamp(0), "19700101-000000");
}

fn rec(event: &str, session: &str, extra: Value) -> Value {
    let mut v = json!({"v": 1, "at": 0, "event": event, "session": session, "project": "proj"});
    if let (Some(o), Value::Object(m)) = (v.as_object_mut(), extra) {
        o.extend(m);
    }
    v
}

#[test]
fn reduced_hook_events_count_a_whole_turn_from_prompt_to_stop() {
    let dir = scratch("reduced");
    let file = dir.join("recap.json");
    let mut r = Recap::load(file.clone(), T0);
    r.observe_reduced(&rec("prompt", "s", json!({})), T0 + 10);
    r.observe_reduced(&rec("tool", "s", json!({"kind":"command"})), T0 + 20);
    r.observe_reduced(&rec("tool", "s", json!({"kind":"question"})), T0 + 25);
    r.observe_reduced(&rec("tool", "s", json!({"kind":"edit","added":3,"removed":1,"file":"aaaa"})), T0 + 30);
    r.observe_reduced(&rec("tool", "s", json!({"kind":"edit","added":2,"removed":0,"file":"aaaa"})), T0 + 40);
    r.observe_reduced(&rec("tool", "s", json!({"kind":"edit","added":1,"removed":1,"file":"bbbb"})), T0 + 45);
    r.observe_reduced(&rec("tool", "s", json!({"kind":"other"})), T0 + 46);
    r.observe_reduced(&rec("stop", "s", json!({})), T0 + 60);
    let t = &r.view(0).turns;
    assert_eq!(t.len(), 1);
    assert_eq!(
        (t[0].agent.as_str(), t[0].project.as_str(), t[0].start, t[0].end),
        ("integration_claude", "proj", T0 + 10, T0 + 60)
    );
    assert_eq!((t[0].files_changed, t[0].lines_added, t[0].lines_removed, t[0].commands_run, t[0].questions), (2, 6, 2, 1, 1));
    assert_eq!(on_disk(&file)["turns"][0]["filesChanged"], 2);
    // nothing but counts and the two names reach the disk
    assert!(!std::fs::read_to_string(&file).unwrap().contains("aaaa"));
}

#[test]
fn reduced_events_respect_enabled_and_reject_bad_shapes() {
    let dir = scratch("reduced2");
    let mut r = Recap::load(dir.join("recap.json"), T0);
    for bad in [json!(1), json!({"event":"prompt"}), json!({"v":2,"event":"prompt","session":"s"}), rec("nope", "s", json!({})), rec("tool", "s", json!({"kind":"x"})), rec("prompt", "", json!({}))] {
        r.observe_reduced(&bad, T0 + 1);
        r.observe_reduced(&rec("stop", "s", json!({})), T0 + 2);
        assert!(r.view(0).turns.is_empty(), "{bad}");
    }
    r.set_enabled(false);
    r.observe_reduced(&rec("prompt", "s", json!({})), T0 + 3);
    r.observe_reduced(&rec("stop", "s", json!({})), T0 + 4);
    assert!(r.view(0).turns.is_empty());
}

#[test]
fn a_settled_notice_right_after_hook_events_is_not_counted_twice() {
    let dir = scratch("dedupe");
    let mut r = Recap::load(dir.join("recap.json"), T0);
    r.observe_reduced(&rec("prompt", "s", json!({})), T0 + 10);
    r.observe_reduced(&rec("stop", "s", json!({})), T0 + 20);
    r.record_settled("agent_pi", "proj", T0 + 21);
    assert_eq!(r.view(0).turns.len(), 1);
    // far from any hook event the Pi/other turn is counted
    r.record_settled("agent_pi", "proj", T0 + 500);
    assert_eq!(r.view(0).turns.len(), 2);
}

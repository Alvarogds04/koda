use super::*;
use crate::speech::ModelState;
fn prefs() -> Value { serde_json::to_value(Prefs::default()).unwrap() }
fn models(state: ModelState) -> ModelsStatus { ModelsStatus { parakeet: state, download_mb: 670 } }
#[test]
fn dictation_closed_actions_and_key_mapping() {
    for (name, expected) in [("status", Command::Status), ("download_model", Command::Download),
        ("remove_model", Command::Remove), ("hands_free", Command::Key(flow::KeyEvent::HandsFree)),
        ("finish", Command::Key(flow::KeyEvent::Finish)), ("cancel", Command::Key(flow::KeyEvent::Cancel))] {
        assert_eq!(parse_command(&json!({"action":name}), &[], false), Some(expected));
        assert!(parse_command(&json!({"action":name,"extra":0}), &[], false).is_none());
    }
    for bad in [json!(null), json!([]), json!({}), json!({"action":1}), json!({"action":"other"})] {
        assert!(parse_command(&bad, &[], false).is_none());
    }
}
#[test]
fn dictation_prefs_are_exact_and_device_names_injected() {
    let parse = |p| parse_command(&json!({"action":"set_prefs","prefs":p}), &["Mic".into()], false);
    assert_eq!(parse(prefs()), Some(Command::SetPrefs(Prefs::default())));
    for days in [0,7,30,365,-1] { let mut p=prefs(); p["keepDays"]=json!(days); assert!(parse(p).is_some()); }
    for (field, values) in [("key", vec![json!("right_ctrl"),json!("right_alt"),json!("right_shift"),json!("left_ctrl_super")]),
        ("edge", vec![json!("bottom"),json!("left"),json!("right")]),
        ("defaultStyle", vec![json!("verbatim"),json!("natural"),json!("polished")]),
        ("mic", vec![json!(""),json!("Mic")])] {
        for value in values { let mut p=prefs(); p[field]=value; assert!(parse(p).is_some()); }
    }
    for (field, value) in [("key",json!("bad")),("edge",json!("top")),("defaultStyle",json!("bad")),
        ("keepDays",json!(90)),("keepDays",json!(1)),("keepDays",json!(30.5)),("cleanup",json!(true)),
        ("mic",json!("missing")),("mic",json!("x".repeat(201))),("enabled",json!(1)),("extra",json!(0)),("cleanup",json!("false")),
        ("mic",json!(null)),("edge",json!(null)),("key",json!(null)),("defaultStyle",json!(null)),
        ("keepDays",json!("30")),("keepDays",json!(-2))] {
        let mut p=prefs(); p[field]=value; assert!(parse(p).is_none(), "{field}");
    }
    for bad in [json!(null), json!([]), json!("prefs")] { assert!(parse(bad).is_none()); }
    let mut unknown = prefs(); unknown.as_object_mut().unwrap().remove("key"); unknown["other"] = json!("right_ctrl");
    assert!(parse(unknown).is_none());
    for field in prefs().as_object().unwrap().keys() {
        let mut p=prefs(); p.as_object_mut().unwrap().remove(field); assert!(parse(p).is_none());
    }
    assert!(parse_command(&json!({"action":"set_prefs","prefs":prefs(),"extra":0}), &[], false).is_none());
}
#[test]
fn dictation_status_shape_and_key_states() {
    let mut p=Prefs::default();
    let v=status_json(&p, models(ModelState::Missing), KeyStatus::Denied, vec![], false);
    assert_eq!(v, json!({"prefs":{"enabled":false,"key":"right_ctrl","edge":"bottom","mic":"",
        "keepDays":30,"cleanup":false,"defaultStyle":"natural","summaryEngine":"off","openAtLaunch":false,
        "voice":false,"voiceOutput":"off","voiceGender":"female"},"models":{"parakeet":{"state":"missing"},
        "downloadMb":670},"keys":"ok","hasClaudeKey":false,"mics":[],"platform":"linux","autostarted":false}));
    p.enabled=true;
    for (key, name) in [(KeyStatus::Active,"ok"),(KeyStatus::Pending,"pending"),(KeyStatus::Denied,"denied"),(KeyStatus::Unsupported,"unsupported")] {
        let v=status_json(&p, models(ModelState::Ready), key, vec![InputDevice{name:"Mic".into(),default:true}], false);
        assert_eq!(v["keys"], name); assert_eq!(v["mics"],json!([{"name":"Mic","default":true}]));
    }
}
#[test]
fn dictation_events_pin_names_and_payloads() {
    use flow::{Phase::*, Note::*, Update};
    for (phase, name) in [(Idle,"idle"),(Listening,"listening"),(Locked,"locked"),(Thinking,"thinking"),(Copied,"copied"),(Failed,"failed")] {
        assert_eq!(event(Update::Phase(phase)), ("dictation:phase",json!({"phase":name})));
    }
    for (note, name) in [(NeedModel,"needModel"),(NoMicrophone,"noMicrophone"),(ClipboardRefused,"clipboardRefused")] {
        assert_eq!(event(Update::Note(note)), ("dictation:note",json!({"note":name})));
    }
    assert_eq!(event(Update::Level(0.25)), ("dictation:level",json!({"level":0.25})));
    assert_eq!(event(Update::Bands([0.5;9])), ("dictation:bands",json!({"bands":vec![0.5;9]})));
    for (state, expected) in [(ModelState::Missing,json!({"state":"missing"})),
        (ModelState::Ready,json!({"state":"ready"})),
        (ModelState::Downloading{fraction:0.5},json!({"state":"downloading","fraction":0.5})),
        (ModelState::Failed{error:"failed".into()},json!({"state":"failed","error":"failed"}))] {
        assert_eq!(models_event(models(state)), ("dictation:models",json!({"parakeet":expected,"downloadMb":670})));
    }
}
#[test]
fn dictation_lifecycle_starts_and_drops_only_on_transitions() {
    use std::{rc::Rc, cell::Cell};
    struct Fake(Rc<Cell<usize>>);
    impl Drop for Fake { fn drop(&mut self) { self.0.set(self.0.get()+1); } }
    let starts=Cell::new(0); let stops=Rc::new(Cell::new(0));
    let start=|| { starts.set(starts.get()+1); Fake(stops.clone()) };
    let mut e=Engine { running:None };
    for enabled in [false,true,true,false,false,true] { e.set_enabled(enabled, start); }
    assert_eq!(starts.get(),2); assert_eq!(stops.get(),1);
    drop(e); assert_eq!(stops.get(),2);
}
#[test]
fn dictation_plan_never_asks_the_host_to_start_or_stop_under_its_lock() {
    // The planner only DECIDES while the host lock is held; starting (portal, thread, model preload)
    // and stopping (a join that waits for a transcription) happen outside it, on what the plan returns.
    let mut e: Engine<u8> = Engine { running: None };
    assert!(matches!(e.plan(false, false), Plan::Keep), "off and nothing running: nothing to do");
    assert!(matches!(e.plan(true, false), Plan::Start), "enabled and idle: the caller starts it outside the lock");
    assert!(matches!(e.plan(true, true), Plan::Keep), "a start already in flight is never doubled");
    assert!(e.install(7, true).is_none(), "installed while still wanted");
    assert!(matches!(e.plan(true, false), Plan::Keep), "already running: same-state write does not restart");
    assert!(matches!(e.plan(false, false), Plan::Stop(7)), "disabling hands the running value out, to be dropped outside the lock");
    assert!(e.running.is_none());
    assert_eq!(e.install(9, false), Some(9), "a start that is no longer wanted comes back to be dropped, not installed");
    assert!(e.running.is_none());
    assert!(matches!(e.plan(false, true), Plan::Keep), "disabling during a start: nothing running to stop yet");
}

#[test]
fn dictation_data_schemas_are_closed() {
    let valid = vec![json!({"action":"history"}), json!({"action":"stats"}),
        json!({"action":"words"}), json!({"action":"snippets"}), json!({"action":"styles"}),
        json!({"action":"delete_entry","id":"abc_12-3"}),
        json!({"action":"clear_history","everything":false}),
        json!({"action":"set_words","words":{"words":["Claude Code"],"replacements":[{"id":"r","from":"a","to":"b"}]}}),
        json!({"action":"set_snippets","snippets":[{"id":"s","trigger":"signature","text":"Hi"}]}),
        json!({"action":"set_styles","styles":[{"id":"app","name":"App","style":"natural"}]})];
    for v in &valid {
        assert!(parse_command(v, &[], false).is_some(), "{v}");
        let mut extra = v.clone(); extra["extra"] = json!(true);
        assert!(parse_command(&extra, &[], false).is_none());
        for key in v.as_object().unwrap().keys().filter(|k| *k != "action") {
            let mut missing = v.clone(); missing.as_object_mut().unwrap().remove(key);
            assert!(parse_command(&missing, &[], false).is_none());
            let mut wrong = v.clone(); wrong[key] = json!(null);
            assert!(parse_command(&wrong, &[], false).is_none());
        }
    }
    for id in ["".into(), "x".repeat(65), "../file".into(), "é".into()] {
        assert!(parse_command(&json!({"action":"delete_entry","id":id}), &[], false).is_none());
    }
    for value in [json!(0), json!("false"), json!(null)] {
        assert!(parse_command(&json!({"action":"clear_history","everything":value}), &[], false).is_none());
    }
    for (action, field, item, limits) in [
        ("set_words", "replacements", json!({"id":"r","from":"a","to":"b"}), vec![("id",64),("from",200),("to",200)]),
        ("set_snippets", "snippets", json!({"id":"s","trigger":"hello","text":"hi"}), vec![("id",64),("trigger",80),("text",4000)]),
        ("set_styles", "styles", json!({"id":"a","name":"App","style":"verbatim"}), vec![("id",80),("name",80)])] {
        let wrap = |items: Value| if action == "set_words" {
            json!({"action":action,"words":{"words":[],"replacements":items}})
        } else { json!({"action":action,field:items}) };
        for (key, limit) in limits {
            let mut boundary = item.clone(); boundary[key] = json!("x".repeat(limit));
            assert!(parse_command(&wrap(json!([boundary.clone()])), &[], false).is_some());
            boundary[key] = json!("x".repeat(limit+1));
            assert!(parse_command(&wrap(json!([boundary])), &[], false).is_none());
        }
        for key in item.as_object().unwrap().keys() {
            let mut missing = item.clone(); missing.as_object_mut().unwrap().remove(key);
            assert!(parse_command(&wrap(json!([missing])), &[], false).is_none());
            let mut wrong = item.clone(); wrong[key] = json!(false);
            assert!(parse_command(&wrap(json!([wrong])), &[], false).is_none());
        }
        let mut extra = item.clone(); extra["extra"] = json!(0);
        assert!(parse_command(&wrap(json!([extra])), &[], false).is_none());
        assert!(parse_command(&wrap(json!([null])), &[], false).is_none());
        let max = if field == "replacements" { 500 } else if field == "snippets" { 200 } else { 100 };
        let items: Vec<_> = (0..max).map(|i| { let mut v=item.clone();
            if field == "snippets" { v["trigger"]=json!(format!("trigger {i}")); } v }).collect();
        assert!(parse_command(&wrap(json!(items)), &[], false).is_some());
        let mut too_many=items; too_many.push(item);
        assert!(parse_command(&wrap(json!(too_many)), &[], false).is_none());
    }
    for words in [json!(["x".repeat(81)]), json!(["C++"]), json!([1]), json!(vec!["ok";501])] {
        assert!(parse_command(&json!({"action":"set_words","words":{"words":words,"replacements":[]}}), &[], false).is_none());
    }
    for words in [json!({"words":[],"replacements":[],"extra":0}), json!({"words":[]})] {
        assert!(parse_command(&json!({"action":"set_words","words":words}), &[], false).is_none());
    }
    assert!(parse_command(&json!({"action":"set_words","words":{"words":vec!["é".repeat(80);500],"replacements":[]}}), &[], false).is_some());
    for snippets in [json!([{"id":"s","trigger":"","text":""}]),
        json!([{"id":"s","trigger":"hello","text":""},{"id":"t","trigger":"hello","text":""}])] {
        assert!(parse_command(&json!({"action":"set_snippets","snippets":snippets}), &[], false).is_none());
    }
    for style in ["verbatim","natural","polished","bad"] {
        assert_eq!(parse_command(&json!({"action":"set_styles","styles":[{"id":"a","name":"A","style":style}]}), &[], false).is_some(), style != "bad");
    }
}

#[test]
fn dictation_data_views_and_mutations() {
    use flow::{store::{tests::temp_store, DayStats, Entry}, text::Day};
    let (mut s, dir) = temp_store();
    let today = Day { year: 2026, month: 3, day: 1 };
    for (back, words) in [(0,90),(1,45),(6,45),(7,90),(29,180),(30,450)] {
        s.stats.days.insert(today.minus(back).key(), DayStats { words, seconds:60.0, dictations:1 });
    }
    s.stats.apps.insert("editor".into(), 900);
    let stats = stats_json(&s, today);
    let total = |words, seconds, dictations| json!({"words":words,"seconds":seconds,
        "dictations":dictations,"wordsPerMinute":text::words_per_minute(words, seconds),
        "minutesSaved":text::minutes_saved(words, seconds)});
    let daily: Vec<_> = (0..30).rev().map(|back| (today.minus(back).key(), match back {
        0 | 7 => 90, 1 | 6 => 45, 29 => 180, _ => 0 })).collect();
    assert_eq!(stats, json!({"week":total(180,180.0,3),"month":total(450,300.0,5),
        "all":total(900,360.0,6),"daily":daily,"apps":{"editor":900},"streak":2}));
    s.history = (0..301).rev().map(|n| Entry { id:n.to_string(),date:n,text:format!("text {n}"),
        app:None,words:2,seconds:1.0 }).collect();
    let history = history_json(&s);
    assert_eq!(history.as_array().unwrap().len(), 300);
    assert_eq!(history[0], json!({"id":"300","date":300,"text":"text 300","app":null,"words":2,"seconds":1.0}));
    assert_eq!(history[299]["id"], "1");
    s.prefs.keep_days = 0;
    assert_eq!(history_json(&s), json!([]));
    s.prefs.keep_days = -1;
    let run = |s: &mut flow::store::Store, p: Value| data_action(parse_command(&p, &[], false).unwrap(), s, today);
    assert_eq!(run(&mut s, json!({"action":"delete_entry","id":"300"})), json!({"ok":true}));
    assert_eq!(s.history[0].id, "299");
    for (set, get, field, value) in [
        ("set_snippets","snippets","snippets",json!([{"id":"s","trigger":"hi","text":"Hello"}])),
        ("set_styles","styles","styles",json!([{"id":"a","name":"App","style":"polished"}])),
        ("set_words","words","words",json!({"words":["Hello"],"replacements":[]}))] {
        assert_eq!(run(&mut s, json!({"action":set,field:value})), json!({"ok":true}));
        assert_eq!(run(&mut s, json!({"action":get})), value);
    }
    assert_eq!(run(&mut s, json!({"action":"clear_history","everything":false})), json!({"ok":true}));
    assert!(s.history.is_empty());
    assert_eq!(s.totals(None).0, 900);
    assert_eq!(run(&mut s, json!({"action":"clear_history","everything":true})), json!({"ok":true}));
    assert_eq!(s.totals(None), (0,0.0,0));
    assert!(s.stats.apps.is_empty());
    let empty = stats_json(&s, today);
    assert_eq!(empty["week"], total(0,0.0,0));
    assert_eq!(empty["streak"], 0);
    assert!(empty["daily"].as_array().unwrap().iter().all(|d| d[1] == 0));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn dictation_cleanup_requires_key_and_running_apps_is_closed() {
    for present in [false, true] {
        for enabled in [false, true] {
            let mut p = prefs(); p["cleanup"] = json!(enabled);
            assert_eq!(parse_command(&json!({"action":"set_prefs","prefs":p}), &[], present).is_some(), !enabled || present);
        }
        for bad in [json!(null), json!(1), json!("true")] {
            let mut p = prefs(); p["cleanup"] = bad;
            assert!(parse_command(&json!({"action":"set_prefs","prefs":p}), &[], present).is_none());
        }
        assert_eq!(status_json(&Prefs::default(), models(ModelState::Missing), KeyStatus::Active, vec![], present)["hasClaudeKey"], present);
    }
    assert_eq!(running_apps_json(vec![]), json!([]));
    assert_eq!(running_apps_json(vec![("slack".into(), "Slack".into())]), json!([{"id":"slack","name":"Slack"}]));
    assert_eq!(parse_command(&json!({"action":"running_apps"}), &[], false), Some(Command::RunningApps));
    assert!(parse_command(&json!({"action":"running_apps","extra":true}), &[], false).is_none());
}

#[test]
fn dictation_clipboard_actions_are_closed() {
    for payload in [json!({"action":"copy_entry","id":"entry-1"}), json!({"action":"copy_last"})] {
        assert!(parse_command(&payload, &[], false).is_some(), "{payload}");
    }
    for payload in [json!({"action":"copy_entry"}), json!({"action":"copy_entry","id":""}),
        json!({"action":"copy_entry","id":"../secret"}), json!({"action":"copy_entry","id":"ok","text":"injected"}),
        json!({"action":"copy_last","text":"injected"})] {
        assert!(parse_command(&payload, &[], false).is_none());
    }
}

#[test]
fn dictation_clipboard_selects_stored_text_without_recording() {
    let (mut store, _dir) = flow::store::tests::temp_store();
    store.record("uno", None, 1.0, flow::store::today(), 100);
    store.record("dos", None, 1.0, flow::store::today(), 200);
    let id = store.history[1].id.clone();
    assert_eq!(clipboard_text(&Command::CopyEntry(id), &store).as_deref(), Some("uno"));
    assert_eq!(clipboard_text(&Command::CopyLast, &store).as_deref(), Some("dos"));
    assert_eq!(clipboard_text(&Command::CopyEntry("missing".into()), &store), None);
    assert_eq!(store.history.len(), 2);
    store.clear_history();
    assert_eq!(clipboard_text(&Command::CopyLast, &store), None);
}

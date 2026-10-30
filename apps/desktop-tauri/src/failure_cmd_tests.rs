use super::*;
use serde_json::json;

fn env() -> Env { Env { version: "0.2.0".into(), os: "Ubuntu".into(), session: "x11".into(), home: "/home/a".into(), user: "alvaro".into() } }
fn stored(step: &str, at: u64) -> Stored { Stored { record: failure::record_failure("island", step, failure::Reason::AgentLost, None, None, &env(), at), count: 1 } }
fn tmp(tag: &str) -> std::path::PathBuf { let d = std::env::temp_dir().join(format!("abito-fcmd-{}-{tag}", std::process::id())); let _ = std::fs::remove_dir_all(&d); d }

#[test]
fn schema_accepts_only_the_closed_shapes() {
    let fp = "3fa9c01b7d2e";
    assert_eq!(parse_command(&json!({"action":"view"})), Some(Command::View));
    assert_eq!(parse_command(&json!({"action":"preview"})), Some(Command::Preview(None)));
    assert_eq!(parse_command(&json!({"action":"preview","fingerprint":fp})), Some(Command::Preview(Some(fp.into()))));
    assert_eq!(parse_command(&json!({"action":"later","fingerprint":fp})), Some(Command::Later(fp.into())));
    assert_eq!(parse_command(&json!({"action":"never","fingerprint":fp})), Some(Command::Never(fp.into())));
    assert_eq!(parse_command(&json!({"action":"set_enabled","enabled":false})), Some(Command::SetEnabled(false)));
    assert_eq!(parse_command(&json!({"action":"send","title":" t ","body":"b"})), Some(Command::Send { title: "t".into(), body: "b".into() }));
}

#[test]
fn schema_refuses_everything_else() {
    let fp = "3fa9c01b7d2e";
    for bad in [json!(null), json!({}), json!({"action":"view","x":1}), json!({"action":"nope"}),
        json!({"action":"later"}), json!({"action":"later","fingerprint":"XYZ"}), json!({"action":"never","fingerprint":"3FA9C01B7D2E"}),
        json!({"action":"never","fingerprint":fp,"x":1}), json!({"action":"preview","fingerprint":"../etc"}),
        json!({"action":"set_enabled","enabled":"yes"}), json!({"action":"send","title":"","body":"b"}),
        json!({"action":"send","title":"a\nb","body":"b"}), json!({"action":"send","title":"t","body":"  "}),
        json!({"action":"send","title":"t","body":"x".repeat(BODY_MAX + 1)}), json!({"action":"send","title":"x".repeat(TITLE_MAX + 1),"body":"b"}),
        json!({"action":"send","title":"t","body":"a\u{0}b"}), json!({"action":"send","title":"t","body":"b","url":"https://evil.example"})] {
        assert_eq!(parse_command(&bad), None, "{bad}");
    }
}

#[test]
fn prefs_default_on_round_trip_and_ignore_garbage() {
    let d = tmp("prefs");
    assert_eq!(Prefs::load(&d), Prefs::default());
    assert!(Prefs::default().enabled);
    let mut p = Prefs::default(); p.enabled = false; p.muted.insert("3fa9c01b7d2e".into());
    p.save(&d).unwrap();
    assert_eq!(Prefs::load(&d), p);
    std::fs::write(d.join(PREFS_FILE), r#"{"enabled":"x","muted":["bad","3fa9c01b7d2e",5]}"#).unwrap();
    let q = Prefs::load(&d);
    assert!(q.enabled && q.muted.len() == 1);
    std::fs::write(d.join(PREFS_FILE), "not json").unwrap();
    assert_eq!(Prefs::load(&d), Prefs::default());
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn pending_hides_muted_postponed_and_everything_when_the_switch_is_off() {
    let (a, b, c) = (stored("agent-lost", 10), stored("agent-refused", 30), stored("agent-no-answer", 20));
    let all = vec![a.clone(), b.clone(), c.clone()];
    let none = BTreeSet::new();
    let steps = |v: Vec<Stored>| v.iter().map(|s| s.record.step.clone()).collect::<Vec<_>>();
    assert_eq!(steps(pending(&all, &Prefs::default(), &none)), ["agent-refused", "agent-no-answer", "agent-lost"], "newest first");
    let mut prefs = Prefs::default();
    prefs.muted.insert(failure::fingerprint_of(&b.record));
    let mut later = BTreeSet::new(); later.insert(failure::fingerprint_of(&c.record));
    assert_eq!(steps(pending(&all, &prefs, &later)), ["agent-lost"]);
    prefs.enabled = false;
    assert!(pending(&all, &prefs, &none).is_empty(), "switch off: no notice at all");
}

#[test]
fn manual_report_has_a_neutral_record_and_a_known_fingerprint_finds_its_own() {
    let s = stored("panic", 5);
    let fp = failure::fingerprint_of(&s.record);
    assert_eq!(record_for(&[s.clone()], Some(&fp), &env(), 9), Some(s.record.clone()));
    assert_eq!(record_for(&[s.clone()], Some("000000000000"), &env(), 9), None);
    let m = record_for(&[], None, &env(), 9).unwrap();
    assert_eq!((m.step.as_str(), m.at_secs), ("manual-report", 9));
}

#[test]
fn context_lines_are_the_other_failures_oldest_first() {
    let (a, b, c) = (stored("agent-lost", 1), stored("agent-refused", 3), stored("agent-no-answer", 2));
    let lines = context_lines(&[b.clone(), a.clone(), c.clone()], &a.record);
    assert_eq!(lines, ["[island/agent-no-answer] agent daemon connection lost", "[island/agent-refused] agent daemon connection lost"]);
}

#[test]
fn prefs_file_is_created_private() {
    use std::os::unix::fs::PermissionsExt;
    let d = tmp("prefsmode");
    Prefs::default().save(&d).unwrap();
    let mode = std::fs::metadata(d.join(PREFS_FILE)).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn what_leaves_the_machine_is_redacted_again_whatever_the_caller_sends() {
    let e = env();
    let edited_title = "[island] crash for alice@example.com in /home/dev/x";
    let edited_body = "I added: key sk-ant-api03-AbCdEfGhIjKlMnOpQrSt\nfile /home/dev/Apps/a.rs\nmail bob@corp.io\nhost 100.64.0.7 nas.tail1.ts.net\nowner alvaro";
    let out = outgoing(edited_title, edited_body, &e.home, &e.user);
    let clipboard = out.clipboard.clone();
    let IssueUrl::Url(url) = &out.url else { panic!("short text fits") };
    // decode the URL so percent-encoding cannot hide a leak
    let decoded = url.replace("%2F", "/").replace("%40", "@").replace("%20", " ").replace("%0A", "\n");
    for text in [&clipboard, url, &decoded] {
        for leaked in ["sk-ant", "alvaro", "alice@", "bob@", "100.64.0.7", "ts.net", "AbCdEf"] {
            assert!(!text.contains(leaked), "leaked {leaked}: {text}");
        }
    }
    assert!(clipboard.contains("<secret>") && clipboard.contains("<email>") && clipboard.contains("~/Apps/a.rs"), "{clipboard}");
}

#[test]
fn outgoing_is_idempotent_on_already_redacted_text() {
    let e = env();
    let once = outgoing("t <secret> ~/x <email>", "b <ip> <host> <user>", &e.home, &e.user);
    assert_eq!(once.clipboard, "t <secret> ~/x <email>\n\nb <ip> <host> <user>");
}

#[test]
fn percent_encoded_secrets_are_decoded_then_redacted_before_the_url_and_clipboard() {
    let e = env();
    let out = outgoing("[island] crash %2Fhome%2Fdev%2Fx", "path %2Fhome%2Fdev%2FApps\nmail dev%40example.com\nkey sk%2Dant%2Dapi03%2DAbCdEfGhIjKlMnOpQrSt\ndouble %252Fhome%252Falvaro", &e.home, &e.user);
    let IssueUrl::Url(url) = &out.url else { panic!("fits") };
    for text in [&out.clipboard, url] {
        for leaked in ["alvaro", "AbCdEf", "sk-ant", "sk%2Dant", "%40example", "example.com"] {
            assert!(!text.contains(leaked), "leaked {leaked}: {text}");
        }
    }
    assert!(out.clipboard.contains("~/x") && out.clipboard.contains("<email>") && out.clipboard.contains("<secret>"), "{}", out.clipboard);
    assert!(!out.clipboard.lines().next().unwrap_or("").is_empty());
    let nl = outgoing("a%0Ab", "c", &e.home, &e.user);
    assert_eq!(nl.clipboard.lines().next(), Some("a b"), "a decoded newline cannot split the title");
}

#[test]
fn deeper_encoded_text_never_passes_through_the_outgoing_path() {
    let e = env();
    // 4-level encoding of "/home/dev": three decode passes leave %2F behind
    let deep = "%2525252Fhome%2525252Falvaro";
    let out = outgoing(deep, &format!("body {deep}"), &e.home, &e.user);
    let IssueUrl::Url(url) = &out.url else { panic!("fits") };
    for text in [&out.clipboard, url] {
        assert!(!text.contains("alvaro") && !text.contains("%2F") && !text.contains("%252F") && !text.contains("2525"), "{text}");
    }
    assert!(out.clipboard.contains("%<enc>"), "{}", out.clipboard);
}

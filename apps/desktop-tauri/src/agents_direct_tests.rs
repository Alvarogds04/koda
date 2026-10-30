use super::*;
use serde_json::json;
use std::path::PathBuf;

#[test]
fn output_cap_is_enforced_at_the_reader_not_an_unbounded_queue() {
    struct Flood(usize);
    impl std::io::Read for Flood {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.0 += buf.len();
            buf.fill(b'x');
            Ok(buf.len())
        }
    }
    let mut flood = Flood(0);
    assert!(read_capped(&mut flood, 4096).is_err());
    assert_eq!(flood.0, 4097, "read only the cap plus one overflow sentinel");
    assert_eq!(read_capped(&mut &b"ok"[..], 2).unwrap(), b"ok");
}

const H: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn only_the_four_agent_actions_are_taken_and_validated_by_the_existing_grammar() {
    assert_eq!(parse(&json!({"action":"agents_list"})), Some(Ok(DirectOp::List)));
    assert_eq!(parse(&json!({"action":"hooks_preview"})), Some(Ok(DirectOp::List)));
    assert_eq!(parse(&json!({"action":"agent_disconnect","agentId":"codex"})), Some(Ok(DirectOp::Disconnect { id: "codex".into() })));
    assert_eq!(parse(&json!({"action":"agent_connect","agentId":"claude-code"})), Some(Err(CommandError)));
    assert_eq!(parse(&json!({"action":"agent_connect","agentId":"codex","plan_hash":H})), Some(Ok(DirectOp::Connect { id: "codex".into(), plan_hash: Some(H.into()) })));
    // everything else goes to the engine path untouched
    for other in [json!({"action":"view"}), json!({"action":"refresh"}), json!({"action":"connectors_list"}), json!({"action":"models_list"}), json!({"nope":1})] {
        assert_eq!(parse(&other), None, "{other}");
    }
    // a taken action with a hostile id / hash / extra field is refused, never forwarded
    for bad in [json!({"action":"agent_connect","agentId":"pi"}), json!({"action":"agent_connect","agentId":"../x"}), json!({"action":"agent_connect","agentId":"codex","plan_hash":"zz"}),
        json!({"action":"agent_connect","agentId":"codex","argv":["--evil"]}), json!({"action":"agents_list","x":1}), json!({"action":"agent_disconnect","agentId":"codex","plan_hash":H})] {
        assert_eq!(parse(&bad), Some(Err(CommandError)), "{bad}");
    }
}

#[test]
fn argv_is_the_closed_grammar_of_the_node_entry() {
    assert_eq!(DirectOp::List.args(), ["list"]);
    assert_eq!(DirectOp::Connect { id: "codex".into(), plan_hash: Some(H.into()) }.args(), ["connect", "codex", H]);
    assert_eq!(DirectOp::Connect { id: "codex".into(), plan_hash: None }.args(), ["connect", "codex"]);
    assert_eq!(DirectOp::Disconnect { id: "claude-code".into() }.args(), ["disconnect", "claude-code"]);
    assert!(!DirectOp::List.mutates() && DirectOp::Disconnect { id: "codex".into() }.mutates());
}

#[test]
fn the_script_is_the_one_beside_the_installed_daemon_never_a_path_from_outside() {
    let exe = PathBuf::from("/opt/abito/abito-island");
    let got = script_beside(&exe).unwrap();
    #[cfg(not(target_os = "macos"))]
    assert_eq!(got, PathBuf::from("/opt/abito/desktop-daemon/src/agents-direct.cjs"));
    #[cfg(target_os = "macos")]
    assert!(got.ends_with("Resources/desktop-daemon/src/agents-direct.cjs"));
}

#[test]
fn missing_node_is_a_per_row_runtime_view_not_an_engine_error() {
    let gate = Gate::new();
    let view = perform_with(&gate, &DirectOp::List, &Runtime { node: None, script: Some("/x".into()), env: vec![] });
    assert_eq!(view["agentsRuntime"], "node_missing");
    assert_eq!(view["directAgents"], json!([]));
    assert!(view.get("connection").is_none(), "never touches the engine connection state");
    assert!(!view.to_string().contains("Pi") && !view.to_string().contains("pi_missing"));
}

#[test]
fn missing_script_reads_failed() {
    let gate = Gate::new();
    let view = perform_with(&gate, &DirectOp::List, &Runtime { node: Some("/bin/sh".into()), script: None, env: vec![] });
    assert_eq!(view["agentsRuntime"], "failed");
}

#[cfg(unix)]
mod run {
    use super::*;
    use std::time::Duration;
    fn sh(body: &str) -> Runtime {
        let dir = std::env::temp_dir().join(format!("abito-direct-{}-{:x}", std::process::id(), body.len() ^ body.bytes().map(u64::from).sum::<u64>() as usize));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake.sh");
        std::fs::write(&script, body).unwrap();
        Runtime { node: Some("/bin/sh".into()), script: Some(script), env: vec![("ABITO_TEST".into(), "1".into())] }
    }
    const OK: &str = r#"printf '%s\n' '{"agents":{"type":"agents","agents":[{"id":"codex","state":"not_connected","backup":false,"detail":null}]},"hooks":{"type":"hooks","clients":[]}}'"#;

    #[test]
    fn a_good_answer_is_folded_and_the_argv_reaches_the_script() {
        let gate = Gate::new();
        let rt = sh(&format!("[ \"$1\" = connect ] && [ \"$2\" = codex ] && [ \"$3\" = {H} ] || exit 7\n{OK}\n"));
        let view = perform_with(&gate, &DirectOp::Connect { id: "codex".into(), plan_hash: Some(H.into()) }, &rt);
        assert_eq!(view["agentsRuntime"], "ok");
        assert_eq!(view["directAgents"][0]["id"], "codex");
    }

    #[test]
    fn an_independent_row_state_does_not_depend_on_anything_but_its_own_answer() {
        let gate = Gate::new();
        let view = perform_with(&gate, &DirectOp::List, &sh(OK));
        assert_eq!(view["directAgents"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn nonzero_exit_garbage_and_oversize_read_failed() {
        for body in ["exit 1", "echo not json", "echo '{\"agents\":1}'", "head -c 700000 /dev/zero | tr '\\0' x"] {
            let gate = Gate::new();
            let view = perform_with(&gate, &DirectOp::List, &sh(body));
            assert_eq!(view["agentsRuntime"], "failed", "{body}");
        }
    }

    #[test]
    fn a_hung_script_is_killed_at_the_deadline() {
        let started = std::time::Instant::now();
        let out = run_bounded(Path::new("/bin/sh"), &["-c".into(), "sleep 30".into()], &[], Duration::from_millis(300), 1024);
        assert!(out.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn an_early_eof_is_normal_the_child_is_still_awaited() {
        // stdout closed first, exit later: success with the full answer, not a failure
        let out = run_bounded(Path::new("/bin/sh"), &["-c".into(), "echo hi; exec >&-; sleep 0.3; exit 0".into()], &[], Duration::from_secs(5), 1024).unwrap();
        assert_eq!(String::from_utf8(out).unwrap().trim(), "hi");
    }

    #[test]
    fn a_descendant_holding_stdout_after_the_parent_exits_is_cut_off_and_killed() {
        let marker = std::env::temp_dir().join(format!("abito-desc-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let script = format!("echo ok; (sleep 3; echo late > {}) & exit 0", marker.display());
        let started = Instant::now();
        let out = run_bounded(Path::new("/bin/sh"), &["-c".into(), script], &[], Duration::from_secs(20), 1024);
        assert!(out.is_err(), "a lingering descendant is a failure");
        assert!(started.elapsed() < Duration::from_secs(2), "bounded by the grace, not by the descendant: {:?}", started.elapsed());
        std::thread::sleep(Duration::from_millis(3500));
        assert!(!marker.exists(), "the descendant was killed with the tree");
    }

    #[test]
    fn oversize_output_is_cut_and_fails_promptly() {
        let started = Instant::now();
        let out = run_bounded(Path::new("/bin/sh"), &["-c".into(), "yes | head -c 5000000; sleep 30".into()], &[], Duration::from_secs(20), 4096);
        assert!(out.is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_hung_parent_with_a_descendant_is_killed_with_its_tree_at_the_deadline() {
        let started = Instant::now();
        let out = run_bounded(Path::new("/bin/sh"), &["-c".into(), "sleep 30 & sleep 30".into()], &[], Duration::from_millis(300), 1024);
        assert!(out.is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn the_child_gets_only_the_allowlisted_environment() {
        std::env::set_var("SECRET_TOKEN", "leak");
        let out = run_bounded(Path::new("/bin/sh"), &["-c".into(), "echo \"$SECRET_TOKEN|$ABITO_TEST\"".into()], &[("ABITO_TEST".into(), "yes".into())], Duration::from_secs(5), 1024).unwrap();
        assert_eq!(String::from_utf8(out).unwrap().trim(), "|yes");
    }

    #[test]
    fn a_fresh_list_is_reused_briefly_but_a_mutation_always_runs() {
        let gate = Gate::new();
        let counter = std::env::temp_dir().join(format!("abito-direct-count-{}", std::process::id()));
        let _ = std::fs::remove_file(&counter);
        let rt = sh(&format!("echo x >> {}\n{OK}\n", counter.display()));
        perform_with(&gate, &DirectOp::List, &rt);
        perform_with(&gate, &DirectOp::List, &rt);
        assert_eq!(std::fs::read_to_string(&counter).unwrap().lines().count(), 1, "second list served from the 1.5 s cache");
        perform_with(&gate, &DirectOp::Disconnect { id: "codex".into() }, &rt);
        perform_with(&gate, &DirectOp::List, &rt);
        assert_eq!(std::fs::read_to_string(&counter).unwrap().lines().count(), 2, "the mutation ran (never cached) and its fresh answer is what the next list reuses");
    }
}

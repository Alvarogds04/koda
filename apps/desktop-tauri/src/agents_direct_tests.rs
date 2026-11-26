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

// K3-09 M1: the route runs the ENGINE's `agents-direct.cjs`, located exactly as `engine/docs/PROTOCOL.md`
// («Engine locator and island directory») fixes it: `<lib>` = `ABITO_ENGINE_DIR` when it is an absolute path, else
// `<home>/.local/lib/abito-core`; node is `<lib>/runtime/node`; the entry is `<lib>/engine/src/agents-direct.cjs`.
// Nothing here is a path from PATH, the CWD, the page or the engine's own environment. `[obs]`
#[test]
fn the_engine_is_located_by_the_protocol_contract_never_a_path_from_outside() {
    let home = Path::new("/home/u");
    // The override wins, and it needs no home of its own.
    assert_eq!(install_root(Some(Path::new("/opt/abito/lib")), Some(home)), Some(PathBuf::from("/opt/abito/lib")));
    assert_eq!(install_root(Some(Path::new("/opt/abito/lib")), None), Some(PathBuf::from("/opt/abito/lib")));
    // The documented default prefix otherwise.
    assert_eq!(install_root(None, Some(home)), Some(PathBuf::from("/home/u/.local/lib/abito-core")));
    // A relative or empty value is IGNORED and the default is used: resolving it against the CWD is exactly the
    // path-from-outside hole this module closes, and a front that guessed would run an engine nobody installed.
    for bad in ["", ".", "./", "./engine", "../engine", "engine", "~/.local/lib/abito-core"] {
        assert_eq!(install_root(Some(Path::new(bad)), Some(home)), Some(PathBuf::from("/home/u/.local/lib/abito-core")), "{bad:?}");
    }
    // No engine at all: no path is invented.
    assert_eq!(install_root(None, None), None);
    assert_eq!(install_root(Some(Path::new("rel")), None), None);
    // The two things the route runs are DERIVED from <lib>, never discovered.
    let lib = Path::new("/home/u/.local/lib/abito-core");
    assert_eq!(runtime_node(lib), lib.join("runtime").join(format!("node{}", std::env::consts::EXE_SUFFIX)));
    assert_eq!(direct_script(lib), lib.join("engine").join("src").join("agents-direct.cjs"));
}

fn empty_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("abito-engine-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// K3-09 M1 (S2): with no engine installed the user gets a CLOSED `agentsRuntime` value the page already renders —
/// `node_missing` when `<lib>/runtime/node` is not there, `failed` when it is but the entry is not. No new vocabulary,
/// and Ajustes never blocks on it.
#[test]
fn a_missing_engine_reads_the_closed_runtime_vocabulary() {
    let lib = empty_dir("nothing");
    let rt = runtime_at(Some(&lib), Some(&lib), false);
    assert_eq!((rt.node.is_none(), rt.script.is_none()), (true, true));
    let view = perform_with(&Gate::new(), &DirectOp::List, &rt);
    assert_eq!(view["agentsRuntime"], "node_missing");
    assert_eq!(view["directAgents"], json!([]));
    assert_eq!(view["directHooks"], json!([]));

    // runtime/node present, the entry absent: the node runs nothing, the view says so.
    std::fs::create_dir_all(lib.join("runtime")).unwrap();
    std::fs::write(lib.join(format!("runtime/node{}", std::env::consts::EXE_SUFFIX)), b"not really node").unwrap();
    let rt = runtime_at(Some(&lib), Some(&lib), false);
    assert!(rt.node.is_some() && rt.script.is_none());
    assert_eq!(perform_with(&Gate::new(), &DirectOp::List, &rt)["agentsRuntime"], "failed");
}

#[test]
fn a_node_and_an_entry_found_under_the_install_root_are_the_ones_the_route_runs() {
    let lib = empty_dir("complete");
    std::fs::create_dir_all(lib.join("runtime")).unwrap();
    std::fs::create_dir_all(lib.join("engine/src")).unwrap();
    std::fs::write(lib.join(format!("runtime/node{}", std::env::consts::EXE_SUFFIX)), b"node").unwrap();
    std::fs::write(lib.join("engine/src/agents-direct.cjs"), b"entry").unwrap();
    let rt = runtime_at(Some(&lib), Some(&lib), false);
    assert_eq!(rt.node.as_deref(), Some(runtime_node(&lib).as_path()));
    assert_eq!(rt.script.as_deref(), Some(direct_script(&lib).as_path()));
    // the child's HOME is the home the locator used, and the island dir follows the same home (on Windows the island
    // root is the documented %LOCALAPPDATA% policy, so only its absoluteness is claimed here)
    let env: std::collections::HashMap<_, _> = rt.env.iter().cloned().collect();
    assert_eq!(env.get("HOME").map(String::as_str), lib.to_str());
    #[cfg(not(windows))]
    assert_eq!(env.get("KODA_ISLAND_DIR").map(String::as_str), lib.join(".abito").to_str());
    #[cfg(windows)]
    assert!(env.get("KODA_ISLAND_DIR").map_or(true, |d| Path::new(d.as_str()).is_absolute()));
    assert!(!env.contains_key(crate::LEGACY_PI_EXTENSION_ENV), "off is the absence of the variable");
}

#[test]
fn missing_node_is_a_per_row_runtime_view_not_an_engine_error() {
    let gate = Gate::new();
    let view = perform_with(&gate, &DirectOp::List, &Runtime { node: None, script: Some("/x".into()), env: vec![], legacy_pi: false });
    assert_eq!(view["agentsRuntime"], "node_missing");
    assert_eq!(view["directAgents"], json!([]));
    assert!(view.get("connection").is_none(), "never touches the engine connection state");
    assert!(!view.to_string().contains("Pi") && !view.to_string().contains("pi_missing"));
}

#[test]
fn missing_script_reads_failed() {
    let gate = Gate::new();
    let view = perform_with(&gate, &DirectOp::List, &Runtime { node: Some("/bin/sh".into()), script: None, env: vec![], legacy_pi: false });
    assert_eq!(view["agentsRuntime"], "failed");
}

#[cfg(unix)]
mod run {
    use super::*;
    use std::time::Duration;
    fn sh_with(body: &str, legacy_pi: bool) -> Runtime {
        // One directory per CALL: tests run in parallel and `fs::write` truncates, so two tests that happen to share a
        // body must never share a script path (a half-written script would read as a spurious `failed`).
        static CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("abito-direct-{}-{}", std::process::id(), CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake.sh");
        std::fs::write(&script, body).unwrap();
        Runtime { node: Some("/bin/sh".into()), script: Some(script), env: vec![("KODA_TEST".into(), "1".into())], legacy_pi }
    }
    fn sh(body: &str) -> Runtime {
        sh_with(body, false)
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
        let out = run_bounded(Path::new("/bin/sh"), &["-c".into(), "echo \"$SECRET_TOKEN|$KODA_TEST\"".into()], &[("KODA_TEST".into(), "yes".into())], Duration::from_secs(5), 1024).unwrap();
        assert_eq!(String::from_utf8(out).unwrap().trim(), "|yes");
    }

    // --- K3-09 M1 — the K-F shim in Rust (retirar con AC-08b: abito-island -> abito-pi) ---------------------------
    // The one daemon-side rule the engine does NOT have is K-F: while `KODA_LEGACY_PI_EXTENSION` is off (the default),
    // the retired `~/.pi/agent/extensions/koda-island` install is never touched. Koda's node entry enforced it inside
    // its own AgentsManager; the engine has no Pi policy (`engine/docs/PROTOCOL.md`, «Pi policy»), so the switch is now
    // enforced HERE, on the one route Settings uses: a `pi` mutation spawns nothing at all, and the Pi row always reads
    // `unavailable` / `legacy_pi_extension_off` — never the engine's own `error`/`install_failed`. `[obs]`
    const ENGINE_ANSWER: &str = r#"printf '%s\n' '{"agents":{"type":"agents","agents":[{"id":"codex","state":"not_connected","backup":false,"detail":null},{"id":"pi","state":"error","backup":false,"detail":"install_failed"}]},"hooks":{"type":"hooks","clients":[]}}'"#;

    fn marker(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("abito-direct-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }
    fn rows(view: &Value) -> &Vec<Value> {
        view["directAgents"].as_array().unwrap()
    }
    fn row<'a>(view: &'a Value, id: &str) -> &'a Value {
        rows(view).iter().find(|r| r["id"] == json!(id)).unwrap_or_else(|| panic!("no {id} row in {view}"))
    }

    #[test]
    fn while_the_pi_switch_is_off_a_pi_mutation_runs_nothing_and_the_pi_row_stays_disabled() {
        let ran = marker("pi-mutation");
        let rt = sh(&format!("echo ran >> {}\n{ENGINE_ANSWER}\n", ran.display()));
        assert!(!rt.legacy_pi, "the product default is OFF");
        // the page asks `agents_list` before it renders a row, so this is the table the human is looking at
        let gate = Gate::new();
        assert_eq!(rows(&perform_with(&gate, &DirectOp::List, &rt)).len(), 2);
        for op in [DirectOp::Connect { id: "pi".into(), plan_hash: Some(H.into()) }, DirectOp::Disconnect { id: "pi".into() }] {
            let view = perform_with(&gate, &op, &rt);
            assert_eq!(std::fs::read_to_string(&ran).unwrap().lines().count(), 1, "{op:?} spawned the engine: the shim must refuse it before any child runs");
            assert_eq!(view["agentsRuntime"], "ok", "nothing failed: the action is refused, not broken");
            assert_eq!(rows(&view).len(), 2, "no row is lost by the refusal");
            assert_eq!(row(&view, "codex")["state"], "not_connected");
            assert_eq!(row(&view, "pi")["state"], "unavailable");
            assert_eq!(row(&view, "pi")["detail"], "legacy_pi_extension_off");
            assert_eq!(row(&view, "pi")["backup"], json!(false));
        }
        // even with nothing cached the refusal never spawns: it answers the closed 'ok' view with no rows to offer
        let fresh = marker("pi-mutation-cold");
        let cold = sh(&format!("echo ran >> {}\n{ENGINE_ANSWER}\n", fresh.display()));
        let view = perform_with(&Gate::new(), &DirectOp::Connect { id: "pi".into(), plan_hash: Some(H.into()) }, &cold);
        assert!(!fresh.exists(), "a cold refusal never spawns either");
        assert_eq!(view["agentsRuntime"], "ok");
        assert_eq!(rows(&view).len(), 0, "nothing is invented for a table nobody read");
        // every other agent is a real operation on the same route: nothing was muted for them
        let ran = marker("codex-mutation");
        let rt = sh(&format!("echo ran >> {}\n{ENGINE_ANSWER}\n", ran.display()));
        perform_with(&Gate::new(), &DirectOp::Disconnect { id: "codex".into() }, &rt);
        assert!(ran.exists(), "a codex mutation still runs the engine");
    }

    #[test]
    fn a_refused_pi_mutation_republishes_the_last_list_so_no_row_is_lost() {
        // the same claim as above, from the page's point of view: the rows it rendered survive the refusal verbatim
        let ran = marker("pi-cached");
        let rt = sh(&format!("echo ran >> {}\n{ENGINE_ANSWER}\n", ran.display()));
        let gate = Gate::new();
        let listed = perform_with(&gate, &DirectOp::List, &rt);
        let view = perform_with(&gate, &DirectOp::Connect { id: "pi".into(), plan_hash: Some(H.into()) }, &rt);
        assert_eq!(listed["directHooks"], view["directHooks"]);
        assert_eq!(rows(&listed).len(), rows(&view).len());
        assert_eq!(row(&view, "pi")["detail"], "legacy_pi_extension_off");
    }

    #[test]
    fn while_the_pi_switch_is_off_the_list_publishes_the_disabled_pi_row_whatever_the_engine_says() {
        let view = perform_with(&Gate::new(), &DirectOp::List, &sh(ENGINE_ANSWER));
        assert_eq!(view["agentsRuntime"], "ok");
        let pi = row(&view, "pi");
        // the engine has no Pi policy: left alone its row reads error/install_failed, and the human would be offered a
        // «Reintentar» button that runs that install. The shim publishes the one true row instead.
        assert_eq!(pi["state"], "unavailable");
        assert_eq!(pi["detail"], "legacy_pi_extension_off");
        assert_eq!(pi["backup"], json!(false));
        assert_eq!(pi["plan_hash"], Value::Null, "a disabled row never carries a plan");
        assert_eq!(pi["summary"], Value::Null);
        assert_eq!(row(&view, "codex")["state"], "not_connected");
    }

    #[test]
    fn with_the_pi_switch_on_the_engine_row_and_the_real_run_are_back() {
        // ON is the old path: the engine's own answer is published untouched and a pi mutation really runs.
        let view = perform_with(&Gate::new(), &DirectOp::List, &sh_with(ENGINE_ANSWER, true));
        assert_eq!(row(&view, "pi")["state"], "error");
        let ran = marker("pi-on");
        let rt = sh_with(&format!("echo ran >> {}\n{ENGINE_ANSWER}\n", ran.display()), true);
        perform_with(&Gate::new(), &DirectOp::Connect { id: "pi".into(), plan_hash: Some(H.into()) }, &rt);
        assert!(ran.exists(), "switch ON: the legacy install is reachable again");
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

// --- AC-08/K-F (S2, S6): the retired Pi install behind ONE switch, enforced by this host ---------------------------
// Koda stopped installing `~/.pi/agent/extensions/koda-island` behind ONE reversible switch, exactly like K-C.
// K3-09 M1: the entry this route runs is the ENGINE's, and the engine has no Pi policy, so the switch is read HERE and
// the rule is applied HERE (`perform_with` refuses a `pi` mutation and [`force_pi_row`] publishes the disabled row).
// It is still forwarded to the child while it is ON — that is the path the installer itself reads — and only while it is
// ON, so the child's closed allowlist does not grow a variable to flip.

#[test]
fn the_legacy_pi_extension_switch_is_on_only_for_the_exact_value_one() {
    assert!(!crate::legacy_pi_extension_switch(None), "unset: off");
    assert!(!crate::legacy_pi_extension_switch(Some("")), "empty: off");
    assert!(!crate::legacy_pi_extension_switch(Some("0")), "explicit zero: off");
    assert!(!crate::legacy_pi_extension_switch(Some("true")), "only \"1\" is the switch");
    assert!(!crate::legacy_pi_extension_switch(Some(" 1")), "no trimming, no near-misses");
    assert!(crate::legacy_pi_extension_switch(Some("1")), "the documented value: on");
}

#[test]
fn the_direct_route_forwards_the_pi_switch_only_while_it_is_on() {
    // `runtime()` reads the real process environment, so the variable is set, read and removed inside this ONE test.
    let saved = std::env::var_os(crate::LEGACY_PI_EXTENSION_ENV);
    std::env::remove_var(crate::LEGACY_PI_EXTENSION_ENV);
    let off = runtime();
    assert!(!off.env.iter().any(|(k, _)| k == crate::LEGACY_PI_EXTENSION_ENV), "off (the default): the child's closed allowlist is unchanged");
    std::env::set_var(crate::LEGACY_PI_EXTENSION_ENV, "1");
    let on = runtime();
    // a value that is not exactly "1" is off, so it is not forwarded either
    std::env::set_var(crate::LEGACY_PI_EXTENSION_ENV, "true");
    let near_miss = runtime();
    match saved {
        Some(v) => std::env::set_var(crate::LEGACY_PI_EXTENSION_ENV, v),
        None => std::env::remove_var(crate::LEGACY_PI_EXTENSION_ENV),
    }
    assert!(on.env.iter().any(|(k, v)| k == crate::LEGACY_PI_EXTENSION_ENV && v == "1"), "on: exactly \"1\" reaches the manager");
    assert!(!near_miss.env.iter().any(|(k, _)| k == crate::LEGACY_PI_EXTENSION_ENV), "a near-miss is not forwarded");
}

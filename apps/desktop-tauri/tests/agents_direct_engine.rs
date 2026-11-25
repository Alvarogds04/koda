#![cfg(unix)]
//! K3-09 M1 (S1, S5): Ajustes → Agentes runs the ENGINE's `agents-direct.cjs`, not a Koda copy.
//!
//! These tests spawn the REAL engine entry, from a fixture install root laid out exactly as `engine/docs/PROTOCOL.md`
//! («Engine locator and island directory») describes — `<lib>/engine/…` plus `<lib>/runtime/node` — and prove the two
//! things the migration must not lose: the same two closed frames as before, and Koda's K-F Pi policy, which the engine
//! does not have, enforced on this route while the switch is off.
//!
//! The engine tree is taken from the first of: `ABITO_ENGINE_DIR`, `~/Apps/abito-core/repo`, `~/.local/lib/abito-core`.
//! Nothing here is faked: no marker, no stub answer, no weakened assertion. Without a current tree the test fails
//! loudly and says how to point it at one.
use koda_island::agents_direct::{self, DirectOp, Gate, Runtime};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("koda-engine-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// `<lib>` of a real, current engine tree: it holds `engine/src/agents-direct.cjs` AND the hooks installer the engine
/// derives from its own location (`engine/harness/bin/abito-hook.cjs`). A tree with the entry but no harness is an
/// OUTDATED install (no `install.sh` can produce it: it refuses an archive without the harness) and would read every
/// agent `unavailable`, so it is skipped, never used as a fixture.
fn engine_root() -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::var_os("ABITO_ENGINE_DIR") {
        candidates.push(PathBuf::from(dir));
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join("Apps/abito-core/repo"));
        candidates.push(home.join(".local/lib/abito-core"));
    }
    candidates
        .iter()
        .find(|candidate| {
            candidate.join("engine/src/agents-direct.cjs").is_file() && candidate.join("engine/harness/bin/abito-hook.cjs").is_file()
        })
        .cloned()
        .unwrap_or_else(|| {
            panic!(
                "no current engine tree found: set ABITO_ENGINE_DIR to a directory holding engine/src/agents-direct.cjs \
                 and engine/harness/bin/abito-hook.cjs (checked {candidates:?})"
            )
        })
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("copy dir");
    for entry in std::fs::read_dir(from).expect("read dir") {
        let entry = entry.expect("entry");
        let name = entry.file_name();
        // the engine's own node_modules and its test suite are not part of what the front runs (the entry requires only
        // its siblings under engine/src and engine/harness)
        if name == "node_modules" || name == "test" {
            continue;
        }
        let (src, dst) = (entry.path(), to.join(&name));
        match entry.file_type().expect("type") {
            t if t.is_dir() => copy_tree(&src, &dst),
            _ => {
                std::fs::copy(&src, &dst).expect("copy file");
            }
        }
    }
}

/// A fixture install root with the real engine and the real node the engine ships.
fn fixture(tag: &str) -> (PathBuf, PathBuf) {
    let source = engine_root();
    let lib = temp_dir(&format!("lib-{tag}"));
    copy_tree(&source.join("engine"), &lib.join("engine"));
    std::fs::create_dir_all(lib.join("runtime")).expect("runtime dir");
    let node = source.join("runtime/node");
    let node = if node.is_file() {
        node
    } else {
        koda_island::daemonhost::discover("node", std::env::var_os("PATH").as_deref(), std::env::var_os("HOME").as_deref())
            .expect("a node to run the fixture engine with")
    };
    std::os::unix::fs::symlink(node, lib.join("runtime/node")).expect("fixture runtime node");
    // HOME is the home the engine reads: a private temp one, never the machine's own hooks
    let home = temp_dir(&format!("home-{tag}"));
    (lib, home)
}

fn rows(view: &Value) -> &Vec<Value> {
    view["directAgents"].as_array().expect("directAgents")
}
fn row<'a>(view: &'a Value, id: &str) -> &'a Value {
    let wanted = Value::from(id);
    rows(view).iter().find(|r| r["id"] == wanted).unwrap_or_else(|| panic!("no {id} row in {view}"))
}

#[test]
fn the_real_engine_answers_the_list_and_kodas_pi_row_is_forced_while_the_switch_is_off() {
    let (lib, home) = fixture("list");
    let off: Runtime = agents_direct::runtime_at(Some(&lib), Some(&home), false);
    let view = agents_direct::perform_with(&Gate::new(), &DirectOp::List, &off);

    assert_eq!(view["agentsRuntime"], "ok", "{view}");
    let ids: Vec<&str> = rows(&view).iter().filter_map(|r| r["id"].as_str()).collect();
    assert_eq!(ids, ["claude-code", "codex", "statusline", "copilot-cli", "opencode", "pi"], "the engine's own closed list");
    // the SAME two closed frames as the Koda copy printed: both keys fold, and the hooks frame travels too
    assert!(!view["directHooks"].as_array().expect("directHooks").is_empty(), "the hooks frame still folds");

    // The engine has NO Pi policy: left alone its row is error/install_failed, which the page would offer as a retry.
    let on = agents_direct::runtime_at(Some(&lib), Some(&home), true);
    let engine_view = agents_direct::perform_with(&Gate::new(), &DirectOp::List, &on);
    assert_eq!(row(&engine_view, "pi")["state"], "error", "the engine's own Pi row: {engine_view}");

    // Koda's K-F row, on the route Settings uses, whatever the engine says.
    let pi = row(&view, "pi");
    assert_eq!(pi["state"], "unavailable");
    assert_eq!(pi["detail"], "legacy_pi_extension_off");
    assert_eq!(pi["backup"], false);
    assert!(pi["plan_hash"].is_null() && pi["summary"].is_null(), "a disabled row offers no plan: {pi}");
    // every other row is the engine's answer, untouched
    assert_eq!(row(&view, "codex")["state"], row(&engine_view, "codex")["state"]);
}

#[test]
fn a_pi_mutation_with_the_switch_off_touches_the_retired_pi_folder_not_at_all() {
    let (lib, home) = fixture("pi-off");
    // the retired folder the switch exists for, with content that must survive byte for byte
    let folder = home.join(".pi/agent/extensions/koda-island");
    std::fs::create_dir_all(&folder).expect("pi folder");
    let kept = folder.join("index.ts");
    std::fs::write(&kept, "// the human's own extension\n").expect("write marker");
    let off = agents_direct::runtime_at(Some(&lib), Some(&home), false);
    let gate = Gate::new();
    let listed = agents_direct::perform_with(&gate, &DirectOp::List, &off);
    let hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    for op in [DirectOp::Connect { id: "pi".into(), plan_hash: Some(hash.into()) }, DirectOp::Disconnect { id: "pi".into() }] {
        let view = agents_direct::perform_with(&gate, &op, &off);
        assert_eq!(rows(&view).len(), rows(&listed).len(), "the table the human sees survives the refusal: {op:?}");
        assert_eq!(row(&view, "pi")["detail"], "legacy_pi_extension_off", "{op:?}");
        assert_eq!(std::fs::read_to_string(&kept).expect("intact"), "// the human's own extension\n", "{op:?}");
    }
    // nothing was planned, backed up, removed or audited for it
    assert!(!home.join(".pi/agent/abito-backups").exists(), "no backup was made for the retired folder");
    assert!(!home.join(".koda/audit/hook-installs.jsonl").exists(), "nothing was applied, so nothing was audited");
}

#[test]
fn an_engine_root_that_is_not_there_reads_the_closed_runtime_value_without_spawning() {
    // no engine installed: the page must still render Ajustes (condition b) with a value it already knows
    let lib = temp_dir("lib-absent");
    let home = temp_dir("home-absent");
    let rt = agents_direct::runtime_at(Some(&lib), Some(&home), false);
    assert!(rt.node.is_none() && rt.script.is_none());
    let view = agents_direct::perform_with(&Gate::new(), &DirectOp::List, &rt);
    assert_eq!(view["agentsRuntime"], "node_missing", "the closed value the page renders per row: {view}");
    assert!(rows(&view).is_empty());
}

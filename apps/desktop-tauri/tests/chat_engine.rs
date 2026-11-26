#![cfg(target_os = "linux")]
// Linux-only integration: Unix agent sockets and the Linux session/daemon policy.

//! K3-09 M4a: Koda's chat client (the real `ChatConn` + `ChatFeed` + `ChatHost`, the code `chathost` runs) against the REAL
//! Jesscore engine daemon (`engine/src/daemon.cjs`, abito-core `release/0.2`) on a TEMPORARY island seeded exactly like a
//! Koda 0.2 island (`state.json` + a rotation chain of two session files), with the engine's FAKE agent child
//! (`engine/test/fixtures/fake-agent.cjs`): no provider, no network, no credential, never the installed engine and never the
//! real `~/.abito` (or the legacy `~/.koda`).
//!
//! What it proves for the migration (the engine now has several conversations, Koda keeps ONE continuous chat):
//!   * `ready` arrives and Koda's fieldless `get_history` returns the WHOLE old chat (both chain files);
//!   * a `send` streams the reply and completes;
//!   * the engine's first boot wrote `conversations.json` (0600) with exactly one conversation, `c0`, open, and left the
//!     old session files untouched (the open one only grows by the new turn; `state.json` still names it and its chain).
//!
//! The tree comes from `ABITO_ENGINE_DIR`, `~/Apps/abito-core/repo` or `~/.local/lib/abito-core`. Without one the test SKIPS
//! loudly (a `SKIPPED` line on stderr, visible with `--nocapture`); `KODA_REQUIRE_ENGINE=1` turns that skip into a failure.
//! The engine is started through a three-line launcher (`new Daemon({..., linkFront: false})`, the engine's own tests-only
//! seam) so the suite never opens the phone front's real port.

use koda_island::agentconn::ChatConn;
use koda_island::chat::{parse_command, Command};
use koda_island::chatclient::{ChatFeed, ChatLink, Routed, CHAT_CONVERSATION_ID};
use serde_json::{json, Value};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as Proc, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn engine_tree() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::var_os("ABITO_ENGINE_DIR") {
        candidates.push(PathBuf::from(dir));
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join("Apps/abito-core/repo"));
        candidates.push(home.join(".local/lib/abito-core"));
    }
    let found = candidates
        .iter()
        .find(|c| {
            c.join("engine/src/daemon.cjs").is_file()
                && c.join("engine/src/conversations.cjs").is_file()
                && c.join("engine/test/fixtures/fake-agent.cjs").is_file()
        })
        .cloned();
    if found.is_none() {
        let say = format!(
            "no current engine tree found: set ABITO_ENGINE_DIR to a directory holding engine/src/daemon.cjs, \
             engine/src/conversations.cjs and engine/test/fixtures/fake-agent.cjs (checked {candidates:?})"
        );
        assert!(std::env::var_os("KODA_REQUIRE_ENGINE").is_none_or(|v| v.is_empty() || v == "0"), "{say}");
        eprintln!("SKIPPED (engine-backed test did not run): {say}");
    }
    found
}

struct Island {
    base: PathBuf,
    root: PathBuf,
    child: Option<Child>,
}

fn session_line(role: &str, text: &str) -> String {
    format!("{}\n", json!({"type": "message", "message": {"role": role, "content": [{"type": "text", "text": text}]}}))
}

fn write_private(path: &Path, bytes: &[u8], mode: u32) {
    std::fs::write(path, bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

impl Island {
    /// A SHORT private temp base (the socket path is capped at 107 bytes) holding the seeded island.
    fn start(tree: &Path) -> Island {
        static N: AtomicU32 = AtomicU32::new(0);
        let base = std::env::temp_dir().join(format!("kme{}-{}", std::process::id() % 100000, N.fetch_add(1, Ordering::SeqCst)));
        std::fs::DirBuilder::new().mode(0o700).create(&base).expect("private base");
        let root = base.join("i");
        std::fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let sessions = root.join("sessions");
        std::fs::DirBuilder::new().mode(0o700).create(&sessions).unwrap();
        // a Koda 0.2 island: one chat that rotated once — older.jsonl is the chain, open.jsonl is the open file
        let older = sessions.join("older.jsonl");
        let open = sessions.join("open.jsonl");
        write_private(&older, format!("{}{}", session_line("user", "primera"), session_line("assistant", "uno")).as_bytes(), 0o600);
        write_private(&open, format!("{}{}", session_line("user", "segunda"), session_line("assistant", "dos")).as_bytes(), 0o600);
        let state = json!({"sessionFile": open, "chains": { open.to_string_lossy(): [older] }});
        write_private(&root.join("state.json"), format!("{state}\n").as_bytes(), 0o600);

        let node = String::from_utf8(Proc::new("sh").args(["-c", "command -v node"]).output().unwrap().stdout).unwrap();
        let node = node.trim().to_string();
        assert!(!node.is_empty(), "node is required to run the engine");
        let fake = tree.join("engine/test/fixtures/fake-agent.cjs");
        // the fake engine's stdout passes through a line adapter that adds the `message_end` record a real engine sends
        // (same device as chat_daemon.rs): the white-label stream filter holds a short reply until the message ends
        let adapter = r#"const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{process.stdout.write(l+'\n');try{if(JSON.parse(l).type==='message_update')process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant'}})+'\n')}catch{}});"#;
        let wrapper = base.join("fake-engine.sh");
        write_private(
            &wrapper,
            format!("#!/bin/sh\n\"{n}\" \"{f}\" \"$@\" | exec \"{n}\" -e \"{a}\"\n", n = node, f = fake.display(), a = adapter.replace('"', "\\\"")).as_bytes(),
            0o755,
        );
        write_private(&root.join("config.json"), json!({"command": wrapper}).to_string().as_bytes(), 0o600);
        // the launcher: the engine's own Daemon, with the tests-only `linkFront: false` seam (no real port is opened)
        let launcher = base.join("launch.cjs");
        write_private(
            &launcher,
            br#"const [, , engine, root] = process.argv;
const { Daemon } = require(engine + "/src/daemon.cjs");
const { daemonOptions } = require(engine + "/src/cli.cjs");
const d = new Daemon({ ...daemonOptions(root, (l) => process.stderr.write(l + "\n")), linkFront: false });
d.start().then(() => process.stderr.write("up\n"), (e) => { process.stderr.write("boot failed: " + e.message + "\n"); process.exit(1); });
process.on("SIGTERM", () => d.stop().finally(() => process.exit(0)));
"#,
            0o600,
        );
        let child = Proc::new(&node)
            .arg(&launcher)
            .arg(tree.join("engine"))
            .arg(&root)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap())
            .env("HOME", &base)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn the engine launcher");
        let island = Island { base, root: root.clone(), child: Some(child) };
        let end = Instant::now() + Duration::from_secs(30);
        while !root.join("runtime/session.json").exists() {
            assert!(Instant::now() < end, "the engine never published session.json");
            std::thread::sleep(Duration::from_millis(50));
        }
        island
    }
}

impl Drop for Island {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            // SAFETY: plain signal to a child we spawned and still own.
            unsafe { libc::kill(c.id() as i32, libc::SIGTERM) };
            let end = Instant::now() + Duration::from_secs(3);
            while Instant::now() < end && !matches!(c.try_wait(), Ok(Some(_))) {
                std::thread::sleep(Duration::from_millis(30));
            }
            let _ = c.kill();
            let _ = c.wait();
        }
        // only the private temp base this test created, and only when its name is ours
        if self.base.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("kme")) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }
}

struct Chat {
    feed: Arc<ChatFeed>,
    conn: Arc<ChatConn>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

impl Chat {
    fn connect(island: &Island) -> Chat {
        let feed = ChatFeed::new(|_projected| {});
        let conn = Arc::new(ChatConn::new(ChatFeed::reader_callback(&feed)));
        let link: Arc<dyn ChatLink + Send + Sync> = conn.clone();
        feed.bind(Arc::downgrade(&link));
        conn.connect(&island.root);
        assert_eq!(conn.view()["connection"], json!("connected"), "the chat connection handshakes with the engine");
        Chat { feed, conn }
    }
    fn action(&self, caller: &str, payload: Value) -> Result<Routed, String> {
        let cmd: Command = parse_command(&payload).map_err(|e| e.code)?;
        self.feed.host().route(&*self.conn, caller, &cmd, now_ms()).map_err(|e| e.code)
    }
    fn state(&self) -> Value {
        self.feed.host().project(&ChatLink::view(&*self.conn), now_ms())
    }
    fn wait(&self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            let v = self.state();
            if pred(&v) {
                return v;
            }
            assert!(Instant::now() < end, "timed out waiting for {what}; last chat:state: {v}");
            std::thread::sleep(Duration::from_millis(40));
        }
    }
}

fn texts(v: &Value, key: &str) -> Vec<String> {
    v["turns"].as_array().unwrap_or(&vec![]).iter().filter_map(|t| t[key].as_str().map(str::to_string)).collect()
}

#[test]
fn the_real_engine_serves_koda_one_continuous_chat_from_a_seeded_0_2_island_as_c0_without_touching_its_files() {
    let Some(tree) = engine_tree() else { return };
    let island = Island::start(&tree);
    let sessions = island.root.join("sessions");
    let older_before = std::fs::read(sessions.join("older.jsonl")).unwrap();
    let open_before = std::fs::read(sessions.join("open.jsonl")).unwrap();

    let chat = Chat::connect(&island);
    // ready + the whole old chat (the open file AND its rotation chain), through the fieldless get_history Koda sends
    let v = chat.wait("the engine is ready with the old chat", |v| v["producer"]["pi"] == json!("ready") && v["turns"].as_array().is_some_and(|t| t.len() == 2));
    assert_eq!(v["conversation_id"], json!(CHAT_CONVERSATION_ID), "Koda keeps its one conversation id");
    assert_eq!(texts(&v, "user_text"), ["primera", "segunda"], "the chain's turn first, then the open file's: {v}");
    assert_eq!(texts(&v, "reply"), ["uno", "dos"]);
    let Routed::Answer(page) = chat.action("main", json!({"action": "history", "conversation_id": CHAT_CONVERSATION_ID, "before": null})).unwrap() else {
        panic!("a history page")
    };
    assert_eq!(page["turns"].as_array().unwrap().len(), 2, "get_history over the wire: {page}");

    // the engine's first boot indexed the island: exactly one conversation, c0, open, 0600 — and moved no session file
    let index_path = island.root.join("conversations.json");
    let index: Value = serde_json::from_slice(&std::fs::read(&index_path).expect("conversations.json written at boot")).unwrap();
    assert_eq!(index["open"], json!("c0"), "{index}");
    let items = index["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "one chat in, one conversation out: {index}");
    assert_eq!(items[0]["id"], json!("c0"));
    assert_eq!(std::fs::metadata(&index_path).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::read(sessions.join("older.jsonl")).unwrap(), older_before, "the chain file is byte-identical");
    assert_eq!(std::fs::read(sessions.join("open.jsonl")).unwrap(), open_before, "nothing is written before the first send");
    let state: Value = serde_json::from_slice(&std::fs::read(island.root.join("state.json")).unwrap()).unwrap();
    assert!(state["sessionFile"].as_str().is_some_and(|s| s.ends_with("sessions/open.jsonl")), "state.json still names the open chat: {state}");
    assert_eq!(state["chains"].as_object().map(|c| c.len()), Some(1), "its rotation chain survives: {state}");

    // a send over the same chat: the engine's reply streams in and completes
    let Routed::Answer(accepted) = chat.action("main", json!({"action": "submit", "text": "¿Quién sos?", "client_request_id": "req-m4a-0001"})).unwrap() else {
        panic!("submit answers the page")
    };
    assert_eq!(accepted["duplicate"], json!(false));
    let done = chat.wait("the reply completed", |v| v["turns"].as_array().and_then(|t| t.last()).is_some_and(|t| t["user_text"] == json!("¿Quién sos?") && t["state"] == json!("completed")));
    assert_eq!(done["active_turn"], json!(null));
    // the old files only ever grow: the chain file is untouched, the open one keeps its first bytes
    assert_eq!(std::fs::read(sessions.join("older.jsonl")).unwrap(), older_before);
    assert!(std::fs::read(sessions.join("open.jsonl")).unwrap().starts_with(&open_before), "the open file keeps every byte it had");
    // still one conversation after a turn: Koda never created another
    let after: Value = serde_json::from_slice(&std::fs::read(&index_path).unwrap()).unwrap();
    assert_eq!(after["items"].as_array().unwrap().len(), 1, "{after}");
}

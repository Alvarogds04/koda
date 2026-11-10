#![cfg(target_os = "linux")]
// Linux-only integration: Unix agent sockets and the Linux session/daemon policy.

//! K2-05 T4 U3: the island chat host's dispatcher (`chatclient::ChatHost`, the code
//! `chathost::chat_action` runs) against the REAL daemon of this worktree
//! (`apps/desktop-daemon/src/cli.cjs run`) with the FAKE engine
//! (`test/fixtures/fake-agent.cjs`) in a private temp island. No provider, no network,
//! no credential. Every verb goes through the real `chat::parse_command`, the real
//! `ChatConn` (window-gated with the caller's label) and the real wire.
//!
//! The island setup mirrors `tests/agent_daemon.rs` (`Island::start`), with its own base
//! name shape (`.akchat<pid>-<n>`) so neither test's cleanup can touch the other's.

use abito_island::agentconn::ChatConn;
use abito_island::chat::{parse_command, Command};
use abito_island::chatclient::{ChatHost, ChatLink, Routed, CHAT_CONVERSATION_ID};
use serde_json::{json, Value};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as Proc, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn daemon_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../desktop-daemon")
}

const PREFIX: &str = ".akchat";

struct Island {
    root: PathBuf,
    child: Option<Child>,
}

impl Island {
    /// A SHORT private root (the socket path is capped at 107 bytes); `engine_args` are
    /// passed to the fake engine (e.g. `--prompt-holds`). With `message_end`, the fake
    /// engine's stdout passes through a line adapter that adds the `message_end` record
    /// a real engine sends after its last `message_update` (the fixture never sends one,
    /// and the daemon's white-label stream filter holds a short reply until the message
    /// ends): the reply then streams to the island exactly as a real one does.
    fn start(engine_args: &str, message_end: bool) -> Island {
        static N: AtomicU32 = AtomicU32::new(0);
        static SWEPT: std::sync::Once = std::sync::Once::new();
        SWEPT.call_once(sweep_abandoned);
        let home = PathBuf::from(std::env::var("HOME").expect("HOME"));
        let base = home.join(format!("{PREFIX}{}-{}", std::process::id() % 100000, N.fetch_add(1, Ordering::SeqCst)));
        std::fs::DirBuilder::new().mode(0o700).create(&base).expect("private island base");
        let root = base.join("i");
        std::fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let wrapper = base.join("fake-engine.sh");
        let fake = daemon_dir().join("test/fixtures/fake-agent.cjs");
        let node = String::from_utf8(Proc::new("sh").args(["-c", "command -v node"]).output().unwrap().stdout).unwrap();
        let script = if message_end {
            let adapter = r#"const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{process.stdout.write(l+'\n');try{if(JSON.parse(l).type==='message_update')process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant'}})+'\n')}catch{}});"#;
            format!("#!/bin/sh\n\"{n}\" \"{f}\" {engine_args} \"$@\" | exec \"{n}\" -e \"{a}\"\n", n = node.trim(), f = fake.display(), a = adapter.replace('"', "\\\""))
        } else {
            format!("#!/bin/sh\nexec \"{}\" \"{}\" {engine_args} \"$@\"\n", node.trim(), fake.display())
        };
        std::fs::write(&wrapper, script).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::write(root.join("config.json"), json!({"command": wrapper}).to_string()).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.join("config.json"), std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let child = Proc::new(node.trim())
            .arg(daemon_dir().join("src/cli.cjs"))
            .arg("run")
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap())
            .env("HOME", &base)
            .env("ABITO_ISLAND_DIR", &root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("node is required (no skip, no fake)");
        let island = Island { root: root.clone(), child: Some(child) };
        let end = Instant::now() + Duration::from_secs(20);
        while !root.join("runtime/session.json").exists() {
            assert!(Instant::now() < end, "the daemon never published session.json");
            std::thread::sleep(Duration::from_millis(50));
        }
        island
    }

    /// The fake engine's open session file (created on the daemon's first get_state).
    fn session_file(&self) -> PathBuf {
        fn find(dir: &Path, out: &mut Vec<PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                let p = e.path();
                let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
                if meta.is_dir() {
                    find(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("fake-session-") && n.ends_with(".jsonl")) {
                    out.push(p);
                }
            }
        }
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            let mut found = vec![];
            find(&self.root, &mut found);
            if found.len() == 1 {
                return found.remove(0);
            }
            assert!(Instant::now() < end, "expected one engine session file, found {found:?}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn stop_daemon(&mut self) {
        if let Some(mut c) = self.child.take() {
            let pid = c.id() as i32;
            // SAFETY: plain signal to a child we spawned and still own.
            unsafe { libc::kill(pid, libc::SIGTERM) };
            let end = Instant::now() + Duration::from_secs(3);
            while Instant::now() < end {
                if matches!(c.try_wait(), Ok(Some(_))) {
                    std::thread::sleep(Duration::from_millis(150));
                    return;
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            let _ = c.kill();
            let _ = c.wait();
            std::thread::sleep(Duration::from_millis(150));
        }
    }
}

impl Drop for Island {
    fn drop(&mut self) {
        self.stop_daemon();
        if let Some(base) = self.root.parent() {
            remove_ours(base);
        }
    }
}

/// Exact shape `.akchat<pid>-<n>`, a real directory (never a symlink), owned by us.
fn is_our_island_base(base: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let name = base.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let shape = name.strip_prefix(PREFIX).and_then(|r| r.split_once('-')).is_some_and(|(pid, n)| {
        !pid.is_empty() && !n.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()) && n.bytes().all(|b| b.is_ascii_digit())
    });
    let Ok(meta) = std::fs::symlink_metadata(base) else { return false };
    // SAFETY: getuid has no preconditions and cannot fail.
    shape && meta.is_dir() && !meta.file_type().is_symlink() && meta.uid() == unsafe { libc::getuid() }
}

fn remove_ours(base: &Path) {
    if is_our_island_base(base) {
        let _ = std::fs::remove_dir_all(base);
    }
}

/// Islands of earlier runs whose test process is gone (a panicking test must not leak).
fn sweep_abandoned() {
    let home = PathBuf::from(std::env::var("HOME").expect("HOME"));
    let Ok(entries) = std::fs::read_dir(&home) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix(PREFIX) else { continue };
        let pid = rest.split('-').next().and_then(|p| p.parse::<u32>().ok());
        let alive = pid.is_some_and(|p| p == std::process::id() % 100000 || Path::new(&format!("/proc/{p}")).exists());
        if !alive {
            remove_ours(&e.path());
        }
    }
}

/// The chat as the island runs it: one `ChatConn`, one `ChatHost`, and every connection
/// change re-projected like `chathost::publish_chat` (the `chat:state` emissions are
/// recorded so the test can see what the page would have received).
struct Chat {
    host: Arc<ChatHost>,
    conn: ChatConn,
    emitted: Arc<Mutex<Vec<Value>>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

impl Chat {
    fn connect(island: &Island) -> Chat {
        let host = Arc::new(ChatHost::new());
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let (h, e) = (host.clone(), emitted.clone());
        let conn = ChatConn::new(move |view| {
            let projected = h.project(&view, now_ms());
            e.lock().unwrap().push(projected);
        });
        conn.connect(&island.root);
        assert_eq!(conn.view()["connection"], json!("connected"), "the chat connection handshakes");
        Chat { host, conn, emitted }
    }

    /// One page call, exactly as `chat_action` does it: the page payload through
    /// `chat::parse_command`, then the route with the caller's window label.
    fn action(&self, caller: &str, payload: Value) -> Result<Routed, String> {
        let cmd: Command = parse_command(&payload).map_err(|e| e.code)?;
        self.host.route(&self.conn, caller, &cmd, now_ms()).map_err(|e| e.code)
    }

    fn state(&self) -> Value {
        self.host.project(&ChatLink::view(&self.conn), now_ms())
    }

    fn wait(&self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            let v = self.state();
            if pred(&v) {
                return v;
            }
            assert!(Instant::now() < end, "timed out waiting for {what}; last chat:state: {v}; daemon chat view: {}", ChatLink::view(&self.conn));
            std::thread::sleep(Duration::from_millis(40));
        }
    }
}

fn last_turn(v: &Value) -> Value {
    v["turns"].as_array().and_then(|t| t.last()).cloned().unwrap_or(Value::Null)
}

const REPLY: &str = "hola 😀 línea\u{2028}separada\u{2029}fin";

fn session_line(role: &str, text: &str) -> String {
    format!("{}\n", json!({"type": "message", "message": {"role": role, "content": [{"type": "text", "text": text}]}}))
}

#[test]
fn submit_streams_the_engine_reply_into_chat_state_and_history_takes_the_turn_over() {
    let island = Island::start("", true);
    let chat = Chat::connect(&island);
    let ready = chat.wait("the engine is ready", |v| v["producer"]["pi"] == json!("ready"));
    assert_eq!(ready["availability"]["state"], json!("ready"));
    assert_eq!(ready["conversation_id"], json!(CHAT_CONVERSATION_ID));
    assert_eq!(ready["turns"], json!([]), "a fresh engine session has no turns");

    // the settings window can never chat, even with a live connection
    assert_eq!(
        chat.action("settings", json!({"action": "submit", "text": "hola", "client_request_id": "req-settings01"})).unwrap_err(),
        "send_refused"
    );
    assert_eq!(chat.state()["turns"], json!([]));
    // one continuous chat: the conversation-list verbs are refused before the daemon
    for payload in [json!({"action": "new"}), json!({"action": "list"}), json!({"action": "new_with", "specialist_id": null}), json!({"action": "restore", "conversation_id": "c-otra"})] {
        assert_eq!(chat.action("main", payload.clone()).unwrap_err(), "conversations_off", "{payload}");
    }

    // submit → the engine's streamed reply lands in the submitted turn
    let Routed::Answer(accepted) = chat.action("main", json!({"action": "submit", "text": "¿Quién sos?", "client_request_id": "req-chat-0001"})).unwrap() else {
        panic!("submit answers the page")
    };
    assert_eq!(accepted["duplicate"], json!(false));
    let turn_id = accepted["turn_id"].clone();
    let done = chat.wait("the reply completed", |v| last_turn(v)["state"] == json!("completed") && last_turn(v)["reply"] == json!(REPLY));
    let t = last_turn(&done);
    assert_eq!(t["turn_id"], turn_id);
    assert_eq!(t["user_text"], json!("¿Quién sos?"));
    assert_eq!(done["active_turn"], json!(null));
    assert_eq!(done["producer"]["pi"], json!("ready"));
    // the page received the reply through the chat:state stream, not only by asking
    let emitted = chat.emitted.lock().unwrap().clone();
    assert!(
        emitted.iter().any(|v| last_turn(v)["reply"] == json!(REPLY)),
        "a chat:state emission carried the streamed reply"
    );
    for v in &emitted {
        assert!(v.get("conversation_id").is_some() && v.get("availability").is_some() && v.get("producer").is_some());
    }

    // the engine's own session now holds the turn: history reads it back and the
    // island's turn keeps its id (one continuous chat, S2)
    let file = island.session_file();
    let mut lines = session_line("user", "¿Quién sos?");
    lines.push_str(&session_line("assistant", REPLY));
    std::fs::write(&file, lines).unwrap();
    let Routed::Answer(page) = chat.action("main", json!({"action": "history", "conversation_id": CHAT_CONVERSATION_ID, "before": null})).unwrap() else {
        panic!("a history page")
    };
    let turns = page["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 1, "the confirmed turn, not a duplicate: {page}");
    assert_eq!(turns[0]["turn_id"], turn_id);
    assert_eq!(turns[0]["user_text"], json!("¿Quién sos?"));
    assert_eq!(turns[0]["reply"], json!(REPLY));
    assert_eq!(chat.state()["turns"].as_array().unwrap().len(), 1);

    // a second connection (a relaunched island) reads the same chat from the daemon
    let again = Chat::connect(&island);
    let v = again.wait("history on connect", |v| v["turns"].as_array().is_some_and(|t| t.len() == 1));
    assert_eq!(last_turn(&v)["user_text"], json!("¿Quién sos?"));
    assert_eq!(last_turn(&v)["reply"], json!(REPLY));
}

#[test]
fn cancel_aborts_the_running_turn_on_the_engine_and_keeps_its_flushed_tail() {
    let log_dir = PathBuf::from(std::env::var("HOME").unwrap()).join(format!("{PREFIX}{}-9{}", std::process::id() % 100000, std::process::id() % 1000));
    std::fs::DirBuilder::new().mode(0o700).create(&log_dir).unwrap();
    struct Tidy(PathBuf);
    impl Drop for Tidy {
        fn drop(&mut self) {
            remove_ours(&self.0);
        }
    }
    let _tidy = Tidy(log_dir.clone());
    let cmd_log = log_dir.join("engine-commands.jsonl");
    // the engine starts the answer and never finishes it (a long turn)
    let island = Island::start(&format!("--prompt-holds --cmd-log \"{}\"", cmd_log.display()), false);
    let chat = Chat::connect(&island);
    chat.wait("the engine is ready", |v| v["producer"]["pi"] == json!("ready"));
    let Routed::Answer(accepted) = chat.action("main", json!({"action": "submit", "text": "contame algo largo", "client_request_id": "req-chat-0002"})).unwrap() else {
        panic!("submit answers the page")
    };
    let turn_id = accepted["turn_id"].clone();
    let running = chat.wait("the engine works on the turn", |v| v["producer"]["pi"] == json!("busy"));
    assert_eq!(running["active_turn"], turn_id);
    assert_eq!(running["availability"]["state"], json!("busy"));
    assert_eq!(last_turn(&running)["state"], json!("thinking"));
    // a second submit while a turn runs is refused locally
    assert_eq!(chat.action("main", json!({"action": "submit", "text": "otra", "client_request_id": "req-chat-0003"})).unwrap_err(), "queue_full");
    // the settings window cannot cancel either
    assert_eq!(chat.action("settings", json!({"action": "cancel", "turn_id": turn_id})).unwrap_err(), "send_refused");
    let Routed::Answer(cancelled) = chat.action("main", json!({"action": "cancel", "turn_id": turn_id})).unwrap() else { panic!("cancel answers") };
    assert_eq!(cancelled, json!({"cancelled": true}));
    let v = chat.state();
    assert_eq!(last_turn(&v)["state"], json!("cancelled"));
    assert_eq!(v["active_turn"], json!(null));
    // the engine got the abort, and the part of the answer it had produced still lands
    // in the cancelled turn (the daemon flushes the held tail once)
    let end = Instant::now() + Duration::from_secs(10);
    while !std::fs::read_to_string(&cmd_log).unwrap_or_default().lines().any(|l| l.contains("\"type\":\"abort\"")) {
        assert!(Instant::now() < end, "the engine never received the abort");
        std::thread::sleep(Duration::from_millis(40));
    }
    let v = chat.wait("the flushed tail", |v| last_turn(v)["reply"] == json!(REPLY));
    assert_eq!(last_turn(&v)["state"], json!("cancelled"));
    assert_eq!(last_turn(&v)["turn_id"], turn_id);
    assert_eq!(
        chat.action("main", json!({"action": "cancel", "turn_id": turn_id})).unwrap(),
        Routed::Answer(json!({"cancelled": false})),
        "nothing left to cancel"
    );
}

#[test]
fn a_missing_daemon_reads_as_an_unavailable_engine_and_refuses_the_send() {
    let mut island = Island::start("", false);
    island.stop_daemon();
    let host = ChatHost::new();
    let conn = ChatConn::new(|_| {});
    conn.connect(&island.root);
    let v = host.project(&ChatLink::view(&conn), now_ms());
    assert_eq!(v["producer"]["pi"], json!("unavailable"));
    assert_eq!(v["availability"]["state"], json!("unavailable"));
    let cmd = parse_command(&json!({"action": "submit", "text": "hola", "client_request_id": "req-chat-0004"})).unwrap();
    assert_eq!(host.route(&conn, "main", &cmd, now_ms()).unwrap_err().code, "engine_unavailable");
    assert_eq!(host.project(&ChatLink::view(&conn), now_ms())["turns"], json!([]));
}

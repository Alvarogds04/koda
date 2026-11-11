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
use abito_island::chatclient::{ChatFeed, ChatHost, ChatLink, Routed, CHAT_CONVERSATION_ID};
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

/// The chat as the island runs it (`chathost::start_conn`): one `ChatConn` whose reader
/// callback is the PRODUCTION `ChatFeed::reader_callback` (R2), bound back to the
/// connection for the host's own history refresh; the `chat:state` emissions are recorded
/// so the test can see what the page would have received.
struct Chat {
    feed: Arc<ChatFeed>,
    conn: Arc<ChatConn>,
    emitted: Arc<Mutex<Vec<Value>>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

impl Chat {
    fn connect(island: &Island) -> Chat {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let e = emitted.clone();
        let feed = ChatFeed::new(move |projected| e.lock().unwrap().push(projected));
        let conn = Arc::new(ChatConn::new(ChatFeed::reader_callback(&feed)));
        let link: Arc<dyn ChatLink + Send + Sync> = conn.clone();
        feed.bind(Arc::downgrade(&link));
        conn.connect(&island.root);
        assert_eq!(conn.view()["connection"], json!("connected"), "the chat connection handshakes");
        assert!(feed.connected(), "the reader handed the connected view to the feed");
        Chat { feed, conn, emitted }
    }

    /// One page call, exactly as `chat_action` does it: the page payload through
    /// `chat::parse_command`, then the route with the caller's window label.
    fn action(&self, caller: &str, payload: Value) -> Result<Routed, String> {
        let cmd: Command = parse_command(&payload).map_err(|e| e.code)?;
        self.feed.host().route(&*self.conn, caller, &cmd, now_ms()).map_err(|e| e.code)
    }

    fn state(&self) -> Value {
        self.feed.host().project(&ChatLink::view(&*self.conn), now_ms())
    }

    fn wait(&self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            let v = self.state();
            if pred(&v) {
                return v;
            }
            assert!(Instant::now() < end, "timed out waiting for {what}; last chat:state: {v}; daemon chat view: {}", ChatLink::view(&*self.conn));
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

/// F4 (verifier mwanung2-19-7bou): a daemon that goes away mid-turn interrupts the turn
/// (never `completed` with an empty reply) and the island keeps showing the last known
/// history instead of shrinking the view to its own turns.
#[test]
fn a_daemon_stop_mid_turn_interrupts_the_turn_and_keeps_the_last_known_history() {
    let mut island = Island::start("--prompt-holds", false);
    let chat = Chat::connect(&island);
    chat.wait("the engine is ready", |v| v["producer"]["pi"] == json!("ready"));
    let file = island.session_file();
    let mut lines = session_line("user", "primera");
    lines.push_str(&session_line("assistant", "respuesta primera"));
    std::fs::write(&file, lines).unwrap();
    chat.action("main", json!({"action": "history", "conversation_id": CHAT_CONVERSATION_ID, "before": null})).unwrap();
    chat.wait("the daemon history", |v| v["turns"].as_array().is_some_and(|t| t.len() == 1));
    let Routed::Answer(accepted) = chat.action("main", json!({"action": "submit", "text": "segunda", "client_request_id": "req-chat-0005"})).unwrap() else {
        panic!("submit answers the page")
    };
    chat.wait("the turn runs", |v| v["producer"]["pi"] == json!("busy"));
    island.stop_daemon();
    let v = chat.wait("the turn is interrupted", |v| last_turn(v)["state"] == json!("error"));
    let turns = v["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2, "the last known history stays: {v}");
    assert_eq!(turns[0]["user_text"], json!("primera"));
    assert_eq!(turns[0]["reply"], json!("respuesta primera"));
    assert_eq!(turns[1]["turn_id"], accepted["turn_id"]);
    assert_eq!(turns[1]["error"]["code"], json!("interrupted"));
    assert_eq!(v["producer"]["pi"], json!("unavailable"));
    assert!(!chat.feed.connected(), "the keeper sees the loss from the handed-over view");
}

/// B1/B2 (U4 verifier): deep paging over the REAL daemon's `pageHistory` (byte budget
/// 192 KiB: ~7 KB replies make ~48-message pages, uneven where turns have no reply).
/// Two full passes newest → first: after every page the chat:state window is still the
/// newest contiguous turns, and each pass reaches every turn exactly once, in order, each
/// with its own reply (ORDER and CONTENT compared, never sorted).
#[test]
fn deep_paging_over_the_real_daemon_pages_reaches_every_turn_in_order_twice() {
    const TOTAL: usize = 320;
    let island = Island::start("", false);
    let chat = Chat::connect(&island);
    chat.wait("the engine is ready", |v| v["producer"]["pi"] == json!("ready"));
    let pad = "x".repeat(7_000);
    let mut lines = String::new();
    let mut expected: Vec<(String, String)> = vec![];
    for k in 0..TOTAL {
        lines.push_str(&session_line("user", &format!("p{k}")));
        let reply = if k % 7 == 3 || k % 11 == 5 { String::new() } else { format!("r-p{k} {pad}") };
        if !reply.is_empty() {
            lines.push_str(&session_line("assistant", &reply));
        }
        expected.push((format!("p{k}"), reply));
    }
    std::fs::write(island.session_file(), lines).unwrap();
    chat.action("main", json!({"action": "history", "conversation_id": CHAT_CONVERSATION_ID, "before": null})).unwrap();
    // the daemon's OWN newest page was cut by its byte budget, not by the 100-message limit
    let daemon_page = ChatLink::view(&*chat.conn)["messages"].as_array().map(Vec::len).unwrap_or(0);
    assert!(daemon_page > 0 && daemon_page < 100, "the byte budget, not the 100-message limit, cut the page: {daemon_page}");
    println!("daemon newest page: {daemon_page} messages");
    let texts = |ts: &[Value]| -> Vec<(String, String)> {
        ts.iter().map(|t| (t["user_text"].as_str().unwrap_or("?").to_owned(), t["reply"].as_str().unwrap_or("?").to_owned())).collect()
    };
    let mut page_sizes = vec![];
    for pass in 1..=2 {
        let v = chat.state();
        let mut shown = v["turns"].as_array().cloned().unwrap_or_default();
        assert_eq!(texts(&shown), expected[TOTAL - shown.len()..].to_vec(), "pass {pass}: the newest window");
        let mut cursor = v["history_before"].clone();
        let mut pages = 0;
        while let Some(n) = cursor.as_u64() {
            pages += 1;
            assert!(pages <= 60, "pass {pass}: paging terminates");
            let Routed::Answer(p) = chat.action("main", json!({"action": "history", "conversation_id": CHAT_CONVERSATION_ID, "before": n})).unwrap() else {
                panic!("a page")
            };
            let ts = p["turns"].as_array().cloned().unwrap_or_default();
            assert!(!ts.is_empty(), "pass {pass}: a page with a cursor is never empty: {p}");
            if pass == 1 {
                page_sizes.push(ts.len());
            }
            let window = chat.state()["turns"].as_array().cloned().unwrap_or_default();
            assert_eq!(texts(&window), expected[TOTAL - window.len()..].to_vec(), "pass {pass} page {pages}: chat:state stays the newest contiguous turns");
            let mut next = ts;
            next.extend(shown);
            shown = next;
            cursor = p["before"].clone();
        }
        assert_eq!(texts(&shown), expected, "pass {pass}: every turn once, in order, each with its own reply");
    }
    println!("pass-1 host page sizes (turns): {page_sizes:?}");
}

/// K2-05 bind by id, end to end over the REAL daemon and the fake engine that records and persists
/// its messages the way Pi does (`--persist-messages`): two clients send the SAME text, one after the
/// other. The daemon names each recorded prompt (`user_message`) and gives the island's `requestId`
/// back only on its own; the island's turn is the second «hola» — right after, after a newest page,
/// after a reconnect, and over the earlier pages too. Nothing is written to the session by the test.
#[test]
fn two_clients_sending_identical_text_each_keep_their_own_turn_by_the_daemons_record_id() {
    let island = Island::start("--persist-messages", true);
    let chat = Chat::connect(&island);
    chat.wait("the engine is ready", |v| v["producer"]["pi"] == json!("ready"));
    let other = Chat::connect(&island);
    other.wait("the engine is ready for the other client", |v| v["producer"]["pi"] == json!("ready"));
    let Routed::Answer(theirs) = other.action("main", json!({"action": "submit", "text": "hola", "client_request_id": "req-other-bid1"})).unwrap() else {
        panic!("submit answers the page")
    };
    other.wait("the other client's turn completed", |v| last_turn(v)["state"] == json!("completed") && last_turn(v)["reply"] == json!(REPLY));
    chat.wait("the island saw the other turn end", |v| v["producer"]["pi"] == json!("ready"));
    // what the island's connection was told: the other client's prompt, by its record id, no requestId
    let recorded = ChatLink::view(&*chat.conn)["recorded"].clone();
    assert_eq!(recorded, json!([{"id": "s0-1"}]), "the other client's record reaches the island without a requestId");
    let Routed::Answer(mine) = chat.action("main", json!({"action": "submit", "text": "hola", "client_request_id": "req-chat-bid01"})).unwrap() else {
        panic!("submit answers the page")
    };
    chat.wait("the island's turn completed", |v| {
        v["turns"].as_array().is_some_and(|ts| ts.iter().any(|t| t["turn_id"] == mine["turn_id"] && t["state"] == json!("completed")))
    });
    let own = ChatLink::view(&*chat.conn)["recorded"].clone();
    assert_eq!(own[1]["id"], json!("s0-3"), "the island's own prompt is the third row of the record: {own}");
    assert!(own[1]["requestId"].as_str().is_some_and(|r| !r.is_empty()), "with the island's own requestId: {own}");
    let done = |u: &str| (u.to_owned(), REPLY.to_owned(), "completed".to_owned());
    let shape = |turns: &[Value]| -> Vec<(String, String, String)> {
        turns.iter().map(|t| (t["user_text"].as_str().unwrap().into(), t["reply"].as_str().unwrap().into(), t["state"].as_str().unwrap().into())).collect()
    };
    let check = |c: &Chat, when: &str| {
        let Routed::Answer(page) = c.action("main", json!({"action": "history", "conversation_id": CHAT_CONVERSATION_ID, "before": null})).unwrap() else {
            panic!("{when}: a history page")
        };
        let turns = page["turns"].as_array().unwrap().clone();
        assert_eq!(shape(&turns), vec![done("hola"), done("hola")], "{when}: the record's two turns, once each: {page}");
        turns
    };
    let turns = check(&chat, "the island, newest page");
    assert_eq!(turns[1]["turn_id"], mine["turn_id"], "the island's turn is the second «hola»");
    assert_ne!(turns[0]["turn_id"], mine["turn_id"], "the other client's prompt never takes it");
    let turns = check(&other, "the other client, newest page");
    assert_eq!(turns[0]["turn_id"], theirs["turn_id"], "and the other client's turn is the first «hola» on its own host");
    // a reconnect: a new connection, its own newest page; the record ids still name the turns
    chat.conn.connect(&island.root);
    let v = chat.wait("the newest page after the reconnect", |v| v["turns"].as_array().is_some_and(|t| t.len() == 2));
    let turns = v["turns"].as_array().unwrap();
    assert_eq!(shape(turns), vec![done("hola"), done("hola")], "after a reconnect: {v}");
    assert_eq!(turns[1]["turn_id"], mine["turn_id"], "after a reconnect the island's turn is still the second «hola»");
}

/// The same race with the island's read budget SPENT before the other client's turn (no history
/// read can reach the daemon): the island's turn is still bound by the daemon's own announcement.
#[test]
fn a_spent_read_budget_never_lets_the_islands_turn_take_another_clients_identical_prompt() {
    let island = Island::start("--persist-messages", true);
    let chat = Chat::connect(&island);
    chat.wait("the engine is ready", |v| v["producer"]["pi"] == json!("ready"));
    let other = Chat::connect(&island);
    other.wait("the engine is ready for the other client", |v| v["producer"]["pi"] == json!("ready"));
    let mut spent = 0;
    while ChatLink::command(&*chat.conn, "main", &json!({"action": "chat_status"})).is_ok() {
        spent += 1;
        assert!(spent <= 120, "the read budget is bounded");
    }
    assert!(ChatLink::command(&*chat.conn, "main", &json!({"action": "chat_history"})).is_err(), "a plain read is refused now");
    other.action("main", json!({"action": "submit", "text": "hola", "client_request_id": "req-other-0002"})).unwrap();
    other.wait("the other client's turn completed", |v| last_turn(v)["state"] == json!("completed") && last_turn(v)["reply"] == json!(REPLY));
    chat.wait("the island saw the other turn end", |v| v["producer"]["pi"] == json!("ready"));
    let Routed::Answer(accepted) = chat.action("main", json!({"action": "submit", "text": "hola", "client_request_id": "req-chat-b2r01"})).unwrap() else {
        panic!("a send is never refused because the reads spent their budget")
    };
    let v = chat.wait("the island's turn completed", |v| {
        v["turns"].as_array().is_some_and(|ts| ts.iter().any(|t| t["turn_id"] == accepted["turn_id"] && t["state"] == json!("completed")))
    });
    let mine: Vec<&Value> = v["turns"].as_array().unwrap().iter().filter(|t| t["turn_id"] == accepted["turn_id"]).collect();
    assert_eq!(mine.len(), 1, "the island's turn shows once: {v}");
    assert_eq!((mine[0]["user_text"].clone(), mine[0]["reply"].clone()), (json!("hola"), json!(REPLY)));
    // the read window resets (a reconnect starts a fresh budget): the record, in order, ids kept
    chat.conn.connect(&island.root);
    let v = chat.wait("the newest page after the reconnect", |v| v["turns"].as_array().is_some_and(|t| t.len() == 2));
    let turns = v["turns"].as_array().unwrap();
    let shape: Vec<(String, String)> = turns.iter().map(|t| (t["user_text"].as_str().unwrap().into(), t["reply"].as_str().unwrap().into())).collect();
    assert_eq!(shape, vec![("hola".to_owned(), REPLY.to_owned()), ("hola".to_owned(), REPLY.to_owned())], "{v}");
    assert_eq!(turns[1]["turn_id"], accepted["turn_id"], "the island's turn is the second «hola»");
    assert_ne!(turns[0]["turn_id"], accepted["turn_id"]);
}

/// K2-05 U4b: the agent's question inside the island chat, end to end over the REAL daemon with
/// the fake engine (`--ask-on-prompt`): the engine asks during the turn; chat:state carries the
/// card, white-labelled by the daemon; a relaunched island (a second connection, the page reload)
/// gets the pending ask replayed and answers it; the engine receives the user's text verbatim and
/// finishes the turn; the card goes away on BOTH connections (ask_resolved), and the first one's
/// late answer is refused as closed.
#[test]
fn the_agents_question_is_shown_replayed_on_reconnect_answered_once_and_closed_everywhere() {
    let log_dir = PathBuf::from(std::env::var("HOME").unwrap()).join(format!("{PREFIX}{}-8{}", std::process::id() % 100000, std::process::id() % 1000));
    std::fs::DirBuilder::new().mode(0o700).create(&log_dir).unwrap();
    struct Tidy(PathBuf);
    impl Drop for Tidy {
        fn drop(&mut self) {
            remove_ours(&self.0);
        }
    }
    let _tidy = Tidy(log_dir.clone());
    let cmd_log = log_dir.join("engine-commands.jsonl");
    let island = Island::start(&format!("--ask-on-prompt --cmd-log \"{}\"", cmd_log.display()), true);
    let chat = Chat::connect(&island);
    chat.wait("the engine is ready", |v| v["producer"]["pi"] == json!("ready"));
    assert_eq!(chat.state()["asks"], json!([]));
    let Routed::Answer(accepted) = chat.action("main", json!({"action": "submit", "text": "guardá esto", "client_request_id": "req-ask-0001"})).unwrap() else {
        panic!("submit answers the page")
    };
    let asked = chat.wait("the agent's question", |v| v["asks"].as_array().is_some_and(|a| a.len() == 1));
    let ask = asked["asks"][0].clone();
    assert_eq!(ask["kind"], json!("input"));
    assert_eq!(ask["title"], json!("Koda necesita un nombre"), "hidden engine names never reach the card");
    assert_eq!(ask["placeholder"], json!("nombre para memory"));
    assert_eq!(ask["answering"], json!(false));
    assert_eq!(asked["active_turn"], accepted["turn_id"], "the turn waits for the answer");
    assert!(chat.emitted.lock().unwrap().iter().any(|v| v["asks"].as_array().is_some_and(|a| a.len() == 1)), "the page got the card through chat:state");
    let ask_id = ask["id"].as_str().unwrap().to_owned();

    // the island relaunches (page reload / reconnect): the daemon replays the pending ask
    let again = Chat::connect(&island);
    let replayed = again.wait("the replayed question", |v| v["asks"].as_array().is_some_and(|a| a.len() == 1));
    assert_eq!(replayed["asks"][0]["id"], json!(ask_id));
    assert_eq!(replayed["asks"][0]["title"], json!("Koda necesita un nombre"));

    // answering after the reconnect works; the typed text is the user's own, sent as typed
    let typed = "mi Raspberry Pi con engram y Gentle Shell";
    assert_eq!(again.action("main", json!({"action": "answer", "ask_id": ask_id, "value": typed})).unwrap(), Routed::Answer(json!({"answered": true})));
    assert_eq!(again.action("main", json!({"action": "answer", "ask_id": ask_id, "value": "otra"})).unwrap_err(), "ask_answered", "answered once");
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        let log = std::fs::read_to_string(&cmd_log).unwrap_or_default();
        if let Some(line) = log.lines().find(|l| l.contains("\"extension_ui_response\"")) {
            let got: Value = serde_json::from_str(line).unwrap();
            assert_eq!(got, json!({"type": "extension_ui_response", "id": ask_id, "value": typed}), "the engine got the user's text verbatim");
            break;
        }
        assert!(Instant::now() < end, "the engine never received the answer");
        std::thread::sleep(Duration::from_millis(40));
    }
    assert_eq!(std::fs::read_to_string(&cmd_log).unwrap().matches("extension_ui_response").count(), 1, "one answer reached the engine");
    // the card goes away on both connections; the turn finishes with the engine's reply
    again.wait("the card closed on the answering island", |v| v["asks"] == json!([]));
    let done = chat.wait("the card closed and the turn finished on the first connection", |v| {
        v["asks"] == json!([]) && last_turn(v)["state"] == json!("completed") && last_turn(v)["reply"] == json!(format!("recibí {} caracteres", typed.encode_utf16().count()))
    });
    assert_eq!(last_turn(&done)["turn_id"], accepted["turn_id"]);
    assert_eq!(chat.action("main", json!({"action": "answer", "ask_id": ask_id, "cancelled": true})).unwrap_err(), "ask_closed", "a late answer from another window is refused");
}

use super::*;
use serde_json::json;

// ---- session.json (the host handoff) -----------------------------------------------------
/// A valid daemon endpoint for THIS platform: a Unix socket path, or on Windows the named pipe `server.cjs` generates (HU-062).
fn endpoint() -> &'static str {
    if cfg!(windows) { r"\\.\pipe\abito-0123456789abcdef0123456789abcdef" } else { "/run/x/p-AbCdEf/s" }
}
fn session(over: serde_json::Value) -> String {
    let mut v = json!({"protocol":"island-agent/1","endpoint":endpoint(),"token":"t0k3n","pid":4242,"procStart":"98765","startedAt":1700000000000u64});
    for (k, val) in over.as_object().unwrap() { v[k] = val.clone(); }
    v.to_string()
}

#[test]
fn session_file_is_parsed_strictly_and_fails_closed() {
    let ok = Session::parse(&session(json!({}))).unwrap();
    assert_eq!(ok.endpoint, endpoint());
    assert_eq!(ok.pid, 4242);
    for bad in [session(json!({"protocol":"island-agent/2"})), session(json!({"protocol":null})), session(json!({"token":""})),
                session(json!({"token":7})), session(json!({"endpoint":""})), session(json!({"endpoint":"relative/s"})),
                session(json!({"endpoint":"/run/x/../../etc/s"})), session(json!({"endpoint":"/run/x/p-AbCdEf/other"})),
                session(json!({"endpoint":format!("{}\u{0}", endpoint())})), session(json!({"pid":0})), session(json!({"pid":-3})),
                session(json!({"pid":"x"})), "".into(), "not json".into(), "[]".into(), "{}".into(), "null".into()] {
        assert!(Session::parse(&bad).is_err(), "must refuse {bad}");
    }
    // an oversized file is never parsed
    assert!(Session::parse(&"x".repeat(MAX_SESSION_BYTES + 1)).is_err());
}

#[test]
fn the_endpoint_shape_follows_the_platform() {
    let unix = "/run/x/p-AbCdEf/s";
    let pipe = r"\\.\pipe\abito-0123456789abcdef0123456789abcdef";
    assert_eq!(endpoint_ok(unix), !cfg!(windows), "a Unix socket path is valid only off Windows");
    assert_eq!(endpoint_ok(pipe), cfg!(windows), "the daemon pipe is valid only on Windows");
    // refused everywhere: a near-miss of each shape
    for bad in [r"\\.\pipe\abito-0123456789ABCDEF0123456789abcdef", r"\\.\pipe\abito-0123", r"\\.\pipe\other-0123456789abcdef0123456789abcdef", "/run/x/p-AbCdEf/other"] {
        assert!(!endpoint_ok(bad), "must refuse {bad}");
    }
}

#[test]
fn the_token_never_appears_in_debug_output_or_serialized_state() {
    let s = Session::parse(&session(json!({"token":"super-secret-token"}))).unwrap();
    assert!(!format!("{s:?}").contains("super-secret-token"), "Debug must redact the token");
    let st = ClientState::disconnected(Reason::NoDaemon);
    assert!(!serde_json::to_string(&st).unwrap().contains("token"));
}

// ---- handshake / frame codec ----------------------------------------------------------------
#[test]
fn hello_frame_is_exact() {
    let line = hello_line("t0k3n");
    assert_eq!(line, "{\"type\":\"hello\",\"protocol\":\"island-agent/1\",\"token\":\"t0k3n\"}\n");
}

#[test]
fn frames_are_split_on_lf_only_and_bounded() {
    let mut buf = FrameBuffer::default();
    assert_eq!(buf.push(b"{\"type\":\"a\"}\n{\"ty").unwrap().len(), 1);
    let rest = buf.push(b"pe\":\"b\"}\n").unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0]["type"], "b");
    // a CR is data, not a separator
    let mut b2 = FrameBuffer::default();
    assert!(b2.push(b"{\"type\":\"a\"}\r\n").unwrap().len() == 1);
    // a line without LF over the cap is a protocol error (never grows unbounded)
    let mut b3 = FrameBuffer::default();
    assert_eq!(b3.push(&vec![b'x'; MAX_FRAME_BYTES + 1]), Err(FrameError::TooLarge));
    // garbage JSON is an error, not a skip
    let mut b4 = FrameBuffer::default();
    assert_eq!(b4.push(b"not json\n"), Err(FrameError::Malformed));
    let mut b5 = FrameBuffer::default();
    assert_eq!(b5.push(b"[1,2]\n"), Err(FrameError::Malformed), "a frame is an object");
}

// ---- closed command set (what the UI may ask) -----------------------------------------------------
#[test]
fn ui_commands_are_a_closed_exact_set() {
    let ok = |v: serde_json::Value| parse_ui_command(&v).map(|c| c.line().trim_end().to_string());
    // `view` and `refresh` are local: view reads the state, refresh asks the daemon for the lists
    assert!(matches!(parse_ui_command(&json!({"action":"view"})), Ok(UiCommand::View)));
    assert!(matches!(parse_ui_command(&json!({"action":"refresh"})), Ok(UiCommand::Refresh)));
    assert_eq!(UiCommand::Refresh.refresh_lines().len(), 5);
    assert!(UiCommand::Refresh.refresh_lines().iter().any(|l| l == "{\"type\":\"providers_list\"}\n"));
    for (payload, wire) in [
        (json!({"action":"account_create","provider":"anthropic","label":"Personal"}), r#"{"type":"account_create","provider":"anthropic","label":"Personal"}"#),
        (json!({"action":"auth_start","accountId":"personal","method":"api_key"}), r#"{"type":"auth_start","accountId":"personal","method":"api_key"}"#),
        (json!({"action":"auth_cancel","flowId":"f-1"}), r#"{"type":"auth_cancel","flowId":"f-1"}"#),
        (json!({"action":"account_logout","accountId":"personal"}), r#"{"type":"account_logout","accountId":"personal"}"#),
        (json!({"action":"account_remove","accountId":"personal"}), r#"{"type":"account_remove","accountId":"personal"}"#),
        (json!({"action":"profile_select","id":"main"}), r#"{"type":"profile_select","id":"main"}"#),
        (json!({"action":"profile_deactivate"}), r#"{"type":"profile_deactivate"}"#),
        (json!({"action":"connectors_list"}), r#"{"type":"connectors_list"}"#),
        (json!({"action":"settings_get"}), r#"{"type":"settings_get"}"#),
        // HU-041: the reviewed custom gateway frames (no secret ever rides them)
        (json!({"action":"custom_account_create","label":"Mi servidor","baseUrl":"https://gateway.example/v1"}), r#"{"type":"custom_account_create","label":"Mi servidor","baseUrl":"https://gateway.example/v1"}"#),
        (json!({"action":"custom_account_create","label":"Local","baseUrl":"http://127.0.0.1:4000/v1"}), r#"{"type":"custom_account_create","label":"Local","baseUrl":"http://127.0.0.1:4000/v1"}"#),
        (json!({"action":"custom_endpoint_set","accountId":"gw","baseUrl":"http://[::1]:4000"}), r#"{"type":"custom_endpoint_set","accountId":"gw","baseUrl":"http://[::1]:4000"}"#),
        (json!({"action":"custom_models_refresh","accountId":"gw"}), r#"{"type":"custom_models_refresh","accountId":"gw"}"#),
    ] {
        assert_eq!(ok(payload.clone()).unwrap(), wire, "{payload}");
    }
}

#[test]
fn ui_commands_reject_everything_else() {
    for bad in [json!(null), json!([]), json!("x"), json!({}), json!({"action":1}), json!({"action":"send"}), json!({"action":"abort"}),
                json!({"action":"new_conversation"}), json!({"action":"ui_response"}), json!({"action":"settings_set","hotkey":"Ctrl+A"}),
                json!({"action":"local_account_create","label":"x","baseUrl":"http://127.0.0.1:1/v1","modelIds":["m"]}),
                json!({"action":"hello","token":"x"}), json!({"action":"auth_start","accountId":"a"}),
                json!({"action":"auth_start","accountId":"a","method":"password"}), json!({"action":"auth_start","accountId":"A B","method":"oauth"}),
                json!({"action":"account_create","provider":"p","label":""}), json!({"action":"account_create","provider":"p","label":"x\ny"}),
                json!({"action":"account_create","provider":"p","label":"x".repeat(81)}), json!({"action":"profile_select","id":"../x"}),
                json!({"action":"refresh","extra":1}), json!({"action":"connectors_list","also":true})] {
        assert!(parse_ui_command(&bad).is_err(), "must refuse {bad}");
    }
}

// ---- the secret path: ONLY auth_reply, never echoed ------------------------------------------------------
#[test]
fn auth_reply_carries_the_secret_to_the_daemon_and_nowhere_else() {
    let cmd = parse_ui_command(&json!({"action":"auth_reply","flowId":"f-1","promptId":"p-1","value":"sk-live-SECRET"})).unwrap();
    let line = cmd.line();
    assert_eq!(line, "{\"type\":\"auth_reply\",\"flowId\":\"f-1\",\"promptId\":\"p-1\",\"value\":\"sk-live-SECRET\"}\n");
    // the command's Debug (what a log line would print) never shows the value
    assert!(!format!("{cmd:?}").contains("sk-live-SECRET"), "Debug of a command must redact the secret value");
    // bounds: empty / control chars / oversized are refused before anything is sent
    for v in ["", &"x".repeat(MAX_REPLY_CHARS + 1)] {
        assert!(parse_ui_command(&json!({"action":"auth_reply","flowId":"f","promptId":"p","value":v})).is_err());
    }
    assert!(parse_ui_command(&json!({"action":"auth_reply","flowId":"f","promptId":"p","value":"a\u{0}b"})).is_err());
    assert!(parse_ui_command(&json!({"action":"auth_reply","flowId":"f","promptId":"p"})).is_err());
}

// ---- what the UI sees: allowlisted view, no token/endpoint/secret ---------------------------------------------
#[test]
fn view_state_never_carries_session_material() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"providers","providers":[{"id":"anthropic","name":"Anthropic","methods":["api_key","oauth"],"configured":false}]})).unwrap();
    st.apply(&json!({"type":"accounts","accounts":[{"accountId":"personal","label":"Personal","provider":"anthropic","authMethod":"api_key","configured":true}]})).unwrap();
    let text = serde_json::to_string(&st).unwrap();
    for forbidden in ["token", "endpoint", "baseUrl", "apiKey", "secret\":\"", "Authorization"] {
        assert!(!text.contains(forbidden), "view state leaked {forbidden}: {text}");
    }
    assert!(text.contains("Personal") && text.contains("anthropic"));
}

#[test]
fn auth_prompt_exposes_whether_it_is_secret_but_never_a_value() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"auth_started","flowId":"f-1"})).unwrap();
    st.apply(&json!({"type":"auth_prompt","flowId":"f-1","promptId":"p-1","accountId":"personal","kind":"input","message":"Pegá tu API key","secret":true})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["auth"]["prompt"]["secret"], json!(true));
    assert_eq!(v["auth"]["prompt"]["message"], json!("Pegá tu API key"));
    assert!(v["auth"]["prompt"].get("value").is_none());
    // done clears the prompt and keeps only the outcome
    st.apply(&json!({"type":"auth_done","flowId":"f-1","accountId":"personal","ok":true})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert!(v["auth"]["prompt"].is_null());
    assert_eq!(v["auth"]["last"]["ok"], json!(true));
}

#[test]
fn oauth_events_are_shown_but_only_as_links_to_open_not_as_executable_content() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"auth_started","flowId":"f-2"})).unwrap();
    st.apply(&json!({"type":"auth_event","flowId":"f-2","kind":"url","url":"https://example.com/device","userCode":"ABCD-1234","message":"Abrí el enlace"})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["auth"]["event"]["userCode"], json!("ABCD-1234"));
    assert_eq!(v["auth"]["event"]["url"], json!("https://example.com/device"));
    // a non-https url is dropped from the view (the UI would render it as a link)
    st.apply(&json!({"type":"auth_event","flowId":"f-2","kind":"url","url":"javascript:alert(1)"})).unwrap();
    assert!(serde_json::to_value(&st).unwrap()["auth"]["event"]["url"].is_null());
}

#[test]
fn unknown_or_malformed_server_frames_are_ignored_not_fatal_and_never_forwarded_raw() {
    let mut st = ClientState::connected();
    let before = serde_json::to_value(&st).unwrap();
    for junk in [json!({"type":"message_delta","text":"hi"}), json!({"type":"nope"}), json!({}), json!({"type":7}), json!({"type":"toast","level":"info","message":"x"})] {
        let _ = st.apply(&junk);
    }
    assert_eq!(serde_json::to_value(&st).unwrap(), before, "chat/other frames never alter the settings view");
}

#[test]
fn connectors_are_shown_as_unavailable_honestly_when_the_daemon_says_so() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"error","code":"unavailable"})).unwrap_or(());
    st.note_connectors_error("unavailable");
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["connectors"]["state"], json!("unavailable"));
    st.apply(&json!({"type":"connectors","schema":"abito-connectors/view/1","catalog":[],"connectors":[
        {"id":"gmail","label":"Gmail","catalog_key":"gmail","mode":"read_only","enabled":true,"status":{"state":"connected"},"revision":3,"configured":true}]})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["connectors"]["state"], json!("ready"));
    assert_eq!(v["connectors"]["items"][0]["label"], json!("Gmail"));
    assert_eq!(v["connectors"]["items"][0]["status"], json!("connected"));
}

#[test]
fn disconnected_state_explains_why_with_a_closed_vocabulary() {
    for (r, text) in [(Reason::NoDaemon, "no_daemon"), (Reason::BadSession, "bad_session"), (Reason::Refused, "refused"), (Reason::Lost, "lost")] {
        assert_eq!(serde_json::to_value(ClientState::disconnected(r)).unwrap()["connection"], json!(text));
    }
    assert_eq!(serde_json::to_value(ClientState::connected()).unwrap()["connection"], json!("connected"));
}

// ---- the engine's refusals reach the panel (so it never announces success it did not get) ----
#[test]
fn a_command_error_from_the_engine_is_kept_as_a_closed_code_with_a_counter() {
    let mut st = ClientState::connected();
    assert_eq!(serde_json::to_value(&st).unwrap()["last_error"], json!({"code": null, "n": 0}));
    for (n, code) in ["failed", "busy", "bad_request", "rate_limited", "store_not_private"].iter().enumerate() {
        st.apply(&json!({"type":"error","code":code})).unwrap();
        let v = serde_json::to_value(&st).unwrap();
        assert_eq!(v["last_error"], json!({"code": code, "n": n + 1}), "{code}");
    }
    // the same code twice is still a NEW event: the counter is how the page tells them apart
    st.apply(&json!({"type":"error","code":"failed"})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["last_error"]["n"], json!(6));
}

#[test]
fn an_unknown_or_hostile_error_code_never_reaches_the_page_as_text() {
    let mut st = ClientState::connected();
    for bad in [json!("<script>"), json!("a".repeat(500)), json!(7), json!(null), json!({"x":1})] {
        st.apply(&json!({"type":"error","code":bad})).unwrap();
    }
    st.apply(&json!({"type":"error"})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["last_error"]["code"], json!("failed"), "anything outside the daemon's closed set reads as plain `failed`");
    let text = v["last_error"].to_string();
    assert!(!text.contains("script") && text.len() < 60, "{text}");
}

#[test]
fn a_connection_that_drops_starts_a_clean_error_slate() {
    let mut st = ClientState::disconnected(Reason::Lost);
    assert_eq!(serde_json::to_value(&st).unwrap()["last_error"], json!({"code": null, "n": 0}));
    st.apply(&json!({"type":"error","code":"unavailable"})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["last_error"]["code"], json!("unavailable"));
}

// ---- #310: connect Claude Code / Codex / OpenCode with one click (island-agent/1 `agents`) ----------------
#[test]
fn the_agent_commands_are_a_closed_set_with_an_id_allowlist() {
    assert!(matches!(parse_ui_command(&json!({"action":"agents_list"})), Ok(UiCommand::Wire(w)) if w == "{\"type\":\"agents_list\"}\n"));
    for (action, id) in [("agent_connect", "claude-code"), ("agent_connect", "codex"), ("agent_connect", "opencode"), ("agent_disconnect", "codex")] {
        match parse_ui_command(&json!({"action": action, "agentId": id})) {
            Ok(UiCommand::Wire(w)) => assert_eq!(w, format!("{{\"type\":\"{action}\",\"agentId\":\"{id}\"}}\n")),
            other => panic!("{action} {id}: {other:?}"),
        }
    }
    for bad in [json!({"action":"agent_connect"}), json!({"action":"agent_connect","agentId":"rm -rf"}), json!({"action":"agent_connect","agentId":"Codex"}),
                json!({"action":"agent_connect","agentId":"../x"}), json!({"action":"agent_connect","agentId":""}), json!({"action":"agent_connect","agentId":7}),
                json!({"action":"agent_connect","agentId":"codex","command":"x"}), json!({"action":"agent_connect","agentId":"codex","path":"/etc"}),
                json!({"action":"agents_list","x":1}), json!({"action":"agent_install","agentId":"codex"})] {
        assert!(parse_ui_command(&bad).is_err(), "must refuse {bad}");
    }
}

#[test]
fn copilot_cli_connects_like_the_others_and_its_row_survives_the_fold() {
    for action in ["agent_connect", "agent_disconnect"] {
        assert!(matches!(parse_ui_command(&json!({"action": action, "agentId": "copilot-cli"})), Ok(UiCommand::Wire(_))), "{action}");
    }
    assert!(parse_ui_command(&json!({"action":"agent_connect","agentId":"copilot"})).is_err(), "only the catalogue id");
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"agents","agents":[{"id":"copilot-cli","state":"not_connected","backup":false,"detail":null,"plan_hash":"ab".repeat(32),"summary":"Adds the Abito hooks (permissionRequest, sessionEnd) to ~/.copilot/hooks/abito-island.json. A backup is made first."}]})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["agents"][0]["id"], json!("copilot-cli"));
}

#[test]
fn an_agents_frame_is_folded_into_a_flat_closed_view() {
    let mut st = ClientState::connected();
    assert_eq!(serde_json::to_value(&st).unwrap()["agents"], json!(null), "unknown until the engine says so");
    st.apply(&json!({"type":"agents","agents":[
        {"id":"claude-code","name":"<b>x</b>","state":"connected","backup":true,"detail":null,"path":"/home/a/.claude/settings.json","hook":"rm -rf /"},
        {"id":"codex","state":"outdated","backup":false,"detail":null},
        {"id":"opencode","state":"error","backup":false,"detail":"not_writable"}]})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["agents"][0], json!({"id":"claude-code","state":"connected","backup":true,"detail":null,"plan_hash":null,"summary":null,"reviewable":true,"trust_review":false}), "no name, path or hook line reaches the page");
    assert_eq!(v["agents"][2], json!({"id":"opencode","state":"error","backup":false,"detail":"not_writable","plan_hash":null,"summary":null,"reviewable":true,"trust_review":false}));
    let text = v["agents"].to_string();
    assert!(!text.contains("rm -rf") && !text.contains("/home/") && !text.contains("<b>"), "{text}");
}

#[test]
fn hostile_agent_entries_are_dropped_or_clamped() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"agents","agents":[
        {"id":"evil","state":"connected"}, {"id":"codex","state":"<img>"}, {"id":"codex","state":"connected"}, {"id":7,"state":"connected"},
        {"id":"opencode","state":"error","detail":"<script>"}, "junk", null]})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    let list = v["agents"].as_array().unwrap();
    assert_eq!(list.len(), 2, "{list:?}");
    assert_eq!(list[0], json!({"id":"codex","state":"error","backup":false,"detail":null,"plan_hash":null,"summary":null,"reviewable":true,"trust_review":false}), "an unknown state reads as error; a duplicate keeps the first");
    assert_eq!(list[1]["detail"], json!(null), "an unknown detail never reaches the page");
    // a non-array leaves the previous view alone
    st.apply(&json!({"type":"agents","agents":"nope"})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["agents"].as_array().unwrap().len(), 2);
    // at most the three known agents
    let many: Vec<_> = (0..50).map(|_| json!({"id":"codex","state":"connected"})).collect();
    st.apply(&json!({"type":"agents","agents":many})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["agents"].as_array().unwrap().len(), 1);
}

#[test]
fn a_connection_that_drops_forgets_the_agents() {
    assert_eq!(serde_json::to_value(ClientState::disconnected(Reason::Lost)).unwrap()["agents"], json!(null));
}

// ---- #436 T6.5: the read-only hooks preview (R4): one closed ask, a bounded closed view ----------
#[test]
fn hooks_preview_is_a_closed_read_only_command_and_nothing_else() {
    assert!(matches!(parse_ui_command(&json!({"action":"hooks_preview"})), Ok(UiCommand::Wire(w)) if w == "{\"type\":\"hooks_preview\"}\n"));
    // read-only: install/remove never parse, and the ask carries no other field
    for bad in [json!({"action":"hooks_preview","agentId":"codex"}), json!({"action":"hooks_preview","x":1}),
                json!({"action":"hooks_install","clientId":"codex"}), json!({"action":"hooks_remove","clientId":"codex"}),
                json!({"action":"hooks_preview","clientId":"codex"})] {
        assert!(parse_ui_command(&bad).is_err(), "must refuse {bad}");
    }
}

#[test]
fn a_hooks_frame_is_folded_into_a_bounded_closed_view() {
    let mut st = ClientState::connected();
    assert_eq!(serde_json::to_value(&st).unwrap()["hooks"], json!(null), "unknown until the engine says so");
    st.apply(&json!({"type":"hooks","clients":[
        {"id":"claude-code","name":"Claude Code","mechanism":"harness","state":"connected","detail":null,"backup":true,
         "install":{"summary":"Adds the Abito hooks","plan_hash":"0".repeat(64),"diff":["+ rm -rf /"]},
         "remove":{"summary":"Removes","plan_hash":"0".repeat(64),"diff":["- /home/a/.claude/settings.json"]}},
        {"id":"gemini-cli","name":"x","mechanism":"artifact","state":"not_connected","detail":null},
        {"id":"amp","name":"x","mechanism":"artifact","state":"unavailable","detail":"unsupported_platform"}]})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["hooks"][0], json!({"id":"claude-code","state":"connected","mechanism":"harness","detail":null,"backup":true}),
        "no name, path, diff or plan ever reaches the page");
    assert_eq!(v["hooks"][1], json!({"id":"gemini-cli","state":"not_connected","mechanism":"artifact","detail":null,"backup":false}));
    assert_eq!(v["hooks"][2]["detail"], json!("unsupported_platform"), "the hooks detail set is wider than the agents one");
    let text = v["hooks"].to_string();
    assert!(!text.contains("rm -rf") && !text.contains("/home/") && !text.contains("Claude"), "{text}");
}

#[test]
fn hostile_hook_entries_are_dropped_never_invented() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"hooks","clients":[
        {"id":"evil","state":"connected"}, {"id":"codex","state":"<img>"}, {"id":"codex","state":"connected","mechanism":"carrier_pigeon"},
        {"id":"codex","state":"connected","mechanism":"harness"}, {"id":7,"state":"connected"}, "junk", null]})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    let list = v["hooks"].as_array().unwrap();
    assert_eq!(list.len(), 1, "{list:?}");
    assert_eq!(list[0], json!({"id":"codex","state":"connected","mechanism":"harness","detail":null,"backup":false}),
        "an unknown state or mechanism drops the row; a duplicate keeps the first");
    // a non-array leaves the previous view alone; the client-side cap is 8 like the daemon's
    st.apply(&json!({"type":"hooks","clients":"nope"})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["hooks"].as_array().unwrap().len(), 1);
    let many: Vec<_> = (0..12).map(|_| json!({"id":"amp","state":"connected","mechanism":"artifact"})).collect();
    st.apply(&json!({"type":"hooks","clients":many})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["hooks"].as_array().unwrap().len(), 1, "one entry per known id");
}

#[test]
fn a_connection_that_drops_forgets_the_hooks() {
    assert_eq!(serde_json::to_value(ClientState::disconnected(Reason::Lost)).unwrap()["hooks"], json!(null));
}

// ---- #310 final contract (H2b): the plan the human sees travels back with the click ---------------------------
const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[test]
fn agent_connect_may_carry_the_plan_hash_the_page_rendered_and_nothing_else() {
    match parse_ui_command(&json!({"action":"agent_connect","agentId":"codex","plan_hash":HASH})) {
        Ok(UiCommand::Wire(w)) => assert_eq!(w, format!("{{\"type\":\"agent_connect\",\"agentId\":\"codex\",\"plan_hash\":\"{HASH}\"}}\n")),
        other => panic!("{other:?}"),
    }
    // still valid without it (the engine then applies a fresh preview: opt-in)
    assert!(parse_ui_command(&json!({"action":"agent_connect","agentId":"codex"})).is_ok());
    for bad in [json!(""), json!("abc"), json!(HASH.to_uppercase()), json!(format!("{HASH}0")), json!(&HASH[..63]), json!("g".repeat(64)), json!(7), json!(null), json!(["x"])] {
        assert!(parse_ui_command(&json!({"action":"agent_connect","agentId":"codex","plan_hash":bad})).is_err(), "must refuse plan_hash {bad}");
    }
    // a disconnect carries no plan: the engine previews the REMOVE plan itself
    assert!(parse_ui_command(&json!({"action":"agent_disconnect","agentId":"codex","plan_hash":HASH})).is_err());
    assert!(parse_ui_command(&json!({"action":"agent_connect","agentId":"codex","plan_hash":HASH,"path":"/etc"})).is_err());
}

#[test]
fn the_agents_view_carries_the_plan_for_the_states_that_offer_a_button() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"agents","agents":[
        {"id":"claude-code","name":"x","state":"not_connected","backup":false,"detail":null,"plan_hash":HASH,
         "summary":"Adds the Abito hooks (PermissionRequest, Stop) to ~/.claude/settings.json. A backup is made first.","reviewable":true,"trust_review":false},
        {"id":"codex","state":"connected","backup":true,"detail":null,"trust_review":true,"plan_hash":HASH,"summary":"must not be forwarded for connected"},
        {"id":"opencode","state":"unavailable","backup":false,"detail":null}]})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["agents"][0]["plan_hash"], json!(HASH));
    assert_eq!(v["agents"][0]["reviewable"], json!(true));
    assert!(v["agents"][0]["summary"].as_str().unwrap().starts_with("Adds the Abito hooks"));
    assert_eq!(v["agents"][1]["trust_review"], json!(true));
    assert_eq!(v["agents"][1]["plan_hash"], json!(null), "no plan for a state without a button");
    assert_eq!(v["agents"][1]["summary"], json!(null));
    assert_eq!(v["agents"][2]["plan_hash"], json!(null));
}

#[test]
fn a_plan_that_does_not_look_like_ours_never_reaches_the_page() {
    let mut st = ClientState::connected();
    for (hash, summary) in [("zz", "ok"), (&HASH.to_uppercase()[..], "ok"), (HASH, "<script>alert(1)</script>"), (HASH, "line one\nline two"), (HASH, &"x".repeat(2000)[..])] {
        st.apply(&json!({"type":"agents","agents":[{"id":"codex","state":"not_connected","plan_hash":hash,"summary":summary,"reviewable":true}]})).unwrap();
        let e = &serde_json::to_value(&st).unwrap()["agents"][0];
        let ok = e["plan_hash"] == json!(hash) && e["summary"] == json!(summary);
        assert!(!ok || (hash == HASH && summary.len() < 400 && !summary.contains(['<', '\n'])), "{hash} / {summary}");
        if e["plan_hash"].is_null() { assert!(e["summary"].is_null(), "no hash, no summary: the page never shows an unverifiable plan"); }
    }
}

#[test]
fn the_three_new_details_are_part_of_the_closed_set() {
    let mut st = ClientState::connected();
    for d in ["config_invalid", "not_writable", "backup_failed", "plan_changed", "audit_unavailable", "install_failed", "unsupported_platform", "unsafe_target", "install_unverified", "foreign_extension", "unsafe_folder"] {
        st.apply(&json!({"type":"agents","agents":[{"id":"codex","state":"error","detail":d}]})).unwrap();
        assert_eq!(serde_json::to_value(&st).unwrap()["agents"][0]["detail"], json!(d), "{d}");
    }
    st.apply(&json!({"type":"agents","agents":[{"id":"codex","state":"error","detail":"stderr: /home/a/secret"}]})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["agents"][0]["detail"], json!(null));
}

#[test]
fn an_unsafe_folder_is_forwarded_only_with_a_closed_reason_and_for_that_detail() {
    let mut st = ClientState::connected();
    let get = |st: &ClientState, k: &str| serde_json::to_value(st).unwrap()["agents"][0].get(k).cloned().unwrap_or(json!(null));
    st.apply(&json!({"type":"agents","agents":[{"id":"pi","state":"error","detail":"unsafe_folder","folder":"/home/u/.pi","folder_reason":"writable"}]})).unwrap();
    assert_eq!((get(&st, "folder"), get(&st, "folder_reason")), (json!("/home/u/.pi"), json!("writable")));
    for bad in [
        json!({"detail":"unsafe_folder","folder":"/home/u/.pi","folder_reason":"nope"}),
        json!({"detail":"unsafe_folder","folder":"/a\nb","folder_reason":"acl"}),
        json!({"detail":"unsafe_folder","folder":"","folder_reason":"acl"}),
        json!({"detail":"install_failed","folder":"/home/u/.pi","folder_reason":"acl"}),
    ] {
        let mut a = json!({"id":"pi","state":"error"});
        a.as_object_mut().unwrap().extend(bad.as_object().unwrap().clone());
        st.apply(&json!({"type":"agents","agents":[a]})).unwrap();
        assert_eq!((get(&st, "folder"), get(&st, "folder_reason")), (json!(null), json!(null)), "{bad}");
    }
}

// ---- #414: the connected providers' catalogue (Ajustes → Modelos) -----------------------------------------

#[test]
fn the_models_list_command_is_closed_and_exact() {
    assert!(matches!(parse_ui_command(&json!({"action":"models_list"})), Ok(UiCommand::Wire(w)) if w == "{\"type\":\"models_list\"}\n"));
    for bad in [
        json!({"action":"models_list","providerId":"anthropic"}),
        json!({"action":"models_list","accountId":"a1"}),
        json!({"action":"models_list","x":1}),
        json!({"action":"models"}),
        json!({"action":1}),
        json!("models_list"),
    ] {
        assert!(parse_ui_command(&bad).is_err(), "{bad} is not a valid models_list command");
    }
}

#[test]
fn a_models_frame_is_folded_into_a_bounded_closed_view() {
    let mut st = ClientState::connected();
    assert_eq!(serde_json::to_value(&st).unwrap()["models"], json!(null), "unknown until the engine says so");
    st.apply(&json!({"type":"models","models":[
        {"provider":"anthropic","id":"claude-sonnet-4-5","name":"Claude Sonnet 4.5","reasoning":true,"input":["text","image"],"contextWindow":200000},
        {"provider":"openai","id":"gpt-5.2","name":"GPT-5.2","reasoning":false,"input":[],"contextWindow":128000}]})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["models"][0], json!({"provider":"anthropic","id":"claude-sonnet-4-5","name":"Claude Sonnet 4.5","reasoning":true,"contextWindow":200000}),
        "the closed projection: no input matrix or anything else the frame carried");
    assert_eq!(v["models"][1]["reasoning"], json!(false), "an absent flag reads as false, never as unknown");
}

#[test]
fn hostile_model_entries_are_dropped_or_clamped() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"models","models":[
        {"provider":"anthropic","id":"ok-1","name":"Ok 1"},
        {"id":"no-provider","name":"No provider"},
        {"provider":"openai","id":"<img src=x>","name":"x"},
        {"provider":"anthropic","id":"ok-2","name":42},
        "not an object"]})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    let list = v["models"].as_array().unwrap();
    assert_eq!(list.len(), 2, "only rows with a provider and a string id survive");
    assert_eq!(list[0]["id"], json!("ok-1"));
    assert_eq!(list[1]["id"], json!("ok-2"), "a non-string name is clipped to null, the row stays");
    assert_eq!(list[1]["name"], json!(null));
    // bounded: the engine's own 2000-row cap is the client's too
    let many: Vec<Value> = (0..2100).map(|i| json!({"provider":"p","id":format!("m{i}"),"name":"m"})).collect();
    st.apply(&json!({"type":"models","models":many})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["models"].as_array().unwrap().len(), 2000);
    // a malformed frame changes nothing
    st.apply(&json!({"type":"models","models":"nope"})).unwrap();
    st.apply(&json!({"type":"models"})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["models"].as_array().unwrap().len(), 2000);
}

#[test]
fn a_connection_that_drops_forgets_the_models() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"models","models":[{"provider":"p","id":"m1","name":"M1"}]})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["models"].as_array().unwrap().len(), 1);
    assert_eq!(serde_json::to_value(ClientState::disconnected(Reason::Lost)).unwrap()["models"], json!(null));
}

#[test]
fn the_sessions_list_command_is_closed_and_exact() {
    assert!(matches!(parse_ui_command(&json!({"action":"sessions_list"})), Ok(UiCommand::Wire(w)) if w == "{\"type\":\"sessions_list\"}\n"));
    for bad in [
        json!({"action":"sessions_list","cwd":"/etc"}),
        json!({"action":"sessions_list","x":1}),
        json!({"action":"sessions"}),
        json!({"action":1}),
        json!("sessions_list"),
    ] {
        assert!(parse_ui_command(&bad).is_err(), "{bad} is not a valid sessions_list command");
    }
}

#[test]
fn a_sessions_frame_is_folded_into_a_bounded_closed_view() {
    let mut st = ClientState::connected();
    assert_eq!(serde_json::to_value(&st).unwrap()["sessions"], json!(null), "unknown until the engine says so");
    st.apply(&json!({"type":"sessions","schema":"abito-sessions/view/1","truncated":false,"sessions":[
        {"id":"s-0123abcd","kind":"pi","cwd":"mi-proyecto","state":"sleeping","origin":"herdr","cmdline":"SECRETMARK"},
        {"id":"s-ffffffff","kind":"claude-code","cwd":null,"state":"running","origin":null}]})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["sessions"]["rows"][0], json!({"id":"s-0123abcd","kind":"pi","cwd":"mi-proyecto","state":"sleeping","origin":"herdr"}),
        "the closed projection: nothing else the frame carried (no cmdline, no paths)");
    assert_eq!(v["sessions"]["rows"][1]["cwd"], json!(null), "an absent cwd reads as null, the row stays");
    assert_eq!(v["sessions"]["rows"][1]["origin"], json!(null));
    assert_eq!(v["sessions"]["truncated"], json!(false), "the frame's own truncation flag travels");
}

#[test]
fn hostile_session_rows_are_dropped_or_clamped() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"sessions","schema":"abito-sessions/view/1","truncated":true,"sessions":[
        {"id":"s-0123abcd","kind":"pi","cwd":"ok","state":"sleeping","origin":"tmux"},
        {"id":"not-an-id","kind":"pi","cwd":"x","state":"sleeping","origin":null},
        {"id":"s-11111111","kind":"bash","cwd":"x","state":"sleeping","origin":null},
        {"id":"s-22222222","kind":"pi","cwd":"x","state":"dancing","origin":null},
        {"id":"s-33333333","kind":"pi","cwd":"a/b","state":"sleeping","origin":null},
        {"id":"s-44444444","kind":"pi","cwd":"x","state":"sleeping","origin":"a\u{0}b"},
        42]})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    let list = v["sessions"]["rows"].as_array().unwrap();
    assert_eq!(list.len(), 1, "only the well-formed row survives");
    assert_eq!(list[0]["id"], json!("s-0123abcd"));
    // bounded: the daemon's own 64-row cap is the client's too
    let many: Vec<Value> = (0..70).map(|i| json!({"id":format!("s-{i:08x}"),"kind":"pi","cwd":"p","state":"sleeping","origin":null})).collect();
    st.apply(&json!({"type":"sessions","schema":"abito-sessions/view/1","truncated":true,"sessions":many})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["sessions"]["rows"].as_array().unwrap().len(), 64);
    assert_eq!(v["sessions"]["truncated"], json!(true), "the frame's truncation flag travels with the cap");
    // a malformed frame changes nothing
    st.apply(&json!({"type":"sessions","schema":"other","sessions":[],"truncated":false})).unwrap();
    st.apply(&json!({"type":"sessions","sessions":"nope"})).unwrap();
    st.apply(&json!({"type":"sessions"})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["sessions"]["rows"].as_array().unwrap().len(), 64);
}

#[test]
fn a_connection_that_drops_forgets_the_sessions() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"sessions","schema":"abito-sessions/view/1","truncated":false,"sessions":[
        {"id":"s-0123abcd","kind":"pi","cwd":"p","state":"sleeping","origin":null}]})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["sessions"]["rows"].as_array().unwrap().len(), 1);
    assert_eq!(serde_json::to_value(ClientState::disconnected(Reason::Lost)).unwrap()["sessions"], json!(null));
}

/// L32e: the two notify-only Claude Code integrations (weekly recap hooks, status-line relay) are installable from the
/// UI with the same closed flow, and their state reaches the page. Only their exact ids; nothing else widens.
#[test]
fn recap_and_statusline_are_closed_agent_ids_with_the_same_flow() {
    for id in ["recap", "statusline"] {
        match parse_ui_command(&json!({"action":"agent_connect","agentId":id,"plan_hash":HASH})) {
            Ok(UiCommand::Wire(w)) => assert_eq!(w, format!("{{\"type\":\"agent_connect\",\"agentId\":\"{id}\",\"plan_hash\":\"{HASH}\"}}\n")),
            _ => panic!("{id} connect must be accepted with its plan hash"),
        }
        assert!(parse_ui_command(&json!({"action":"agent_disconnect","agentId":id})).is_ok(), "{id} disconnect");
    }
    for bad in ["Recap", "recap ", "statusLine", "status-line", "claude", "../recap"] {
        assert!(parse_ui_command(&json!({"action":"agent_connect","agentId":bad})).is_err(), "must refuse {bad}");
    }
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"agents","agents":[
        {"id":"recap","state":"not_connected","backup":false,"plan_hash":HASH,"summary":"Adds notify-only hooks.","reviewable":true},
        {"id":"statusline","state":"connected","backup":true}, {"id":"evil","state":"connected","backup":false}]})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["agents"].as_array().unwrap().len(), 2, "only the closed ids reach the page");
    assert_eq!(v["agents"][0]["id"], "recap");
    assert_eq!(v["agents"][1]["state"], "connected");
}

#[test]
fn session_tool_history_is_closed_and_invalid_streams_are_unavailable() {
    let mut st = ClientState::connected();
    let mut row = json!({"id":"s-0123abcd","kind":"pi","cwd":"p","state":"running","origin":null,
        "tools":{"total":2,"steps":[{"index":1,"name":"read","state":"done","args":"private"},{"index":2,"name":"bash","state":"running"}]}});
    let frame = |r: &Value| json!({"type":"sessions","schema":SESSIONS_SCHEMA,"truncated":false,"sessions":[r]});
    st.apply(&frame(&row)).unwrap();
    let tools = &st.sessions_view()["rows"][0]["tools"];
    assert_eq!(tools["total"], 2);
    assert_eq!(tools["steps"][0].get("args"), None);
    for bad in [json!({"total":2,"steps":[]}), json!({"total":1,"steps":[{"index":1,"name":"/private","state":"done"}]}), json!({"total":1,"steps":[{"index":1,"name":"read","state":"invented"}]})] {
        row["tools"] = bad;
        st.apply(&frame(&row)).unwrap();
        assert!(st.sessions_view()["rows"][0].get("tools").is_none());
    }
}

#[test]
fn a_truncated_sessions_frame_carries_the_real_total_and_only_then() {
    let mut st = ClientState::connected();
    let many: Vec<Value> = (0..64).map(|i| json!({"id":format!("s-{i:08x}"),"kind":"pi","cwd":"p","state":"sleeping","origin":null})).collect();
    st.apply(&json!({"type":"sessions","schema":"abito-sessions/view/1","truncated":true,"total":70,"sessions":many})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["sessions"]["total"], json!(70));
    // not truncated: a stray total never travels
    st.apply(&json!({"type":"sessions","schema":"abito-sessions/view/1","truncated":false,"total":70,"sessions":[]})).unwrap();
    assert!(serde_json::to_value(&st).unwrap()["sessions"].get("total").is_none());
    // truncated without a total: honestly absent
    st.apply(&json!({"type":"sessions","schema":"abito-sessions/view/1","truncated":true,"sessions":[]})).unwrap();
    assert!(serde_json::to_value(&st).unwrap()["sessions"].get("total").is_none());
    // a total smaller than the rows, or beyond the scanner's bound, is dropped, never trusted
    for bad in [json!(3), json!(5000), json!(-1), json!("70"), json!(70.5)] {
        let rows: Vec<Value> = (0..5).map(|i| json!({"id":format!("s-{i:08x}"),"kind":"pi","cwd":"p","state":"sleeping","origin":null})).collect();
        st.apply(&json!({"type":"sessions","schema":"abito-sessions/view/1","truncated":true,"total":bad,"sessions":rows})).unwrap();
        assert!(serde_json::to_value(&st).unwrap()["sessions"].get("total").is_none(), "{bad}");
    }
}

// ---- HU-015: the daemon-free route folds its two frames with the SAME closed rules ----------------------
mod direct {
    use super::*;
    const H: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn fold_direct_keeps_only_the_closed_view_under_its_own_keys() {
        let out = json!({
            "agents": {"type":"agents","agents":[
                {"id":"claude-code","state":"not_connected","backup":false,"detail":null,"plan_hash":H,"summary":"Adds the Abito hooks (PermissionRequest, Stop) to ~/.claude/settings.json. A backup is made first.","reviewable":true},
                {"id":"codex","state":"connected","backup":true,"detail":null},
                {"id":"pi","state":"connected"},
                {"id":"unknown-agent","state":"connected"},
                {"id":"codex","state":"error"}]},
            "hooks": {"type":"hooks","clients":[{"id":"gemini-cli","state":"connected","mechanism":"artifact","detail":null},{"id":"evil","state":"connected","mechanism":"artifact"}]},
        });
        let view = fold_direct(&out).expect("folds");
        assert_eq!(view["agentsRuntime"], "ok");
        let ids: Vec<&str> = view["directAgents"].as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["claude-code", "codex", "pi"], "unknown ids and duplicates dropped");
        assert_eq!(view["directAgents"][0]["plan_hash"], H);
        assert_eq!(view["directAgents"][1]["state"], "connected");
        assert_eq!(view["directHooks"].as_array().unwrap().len(), 1);
        // never the engine's own keys: the daemon's pushed state must not be able to overwrite these
        assert!(view.get("agents").is_none() && view.get("hooks").is_none());
    }

    #[test]
    fn fold_direct_refuses_garbage_instead_of_inventing_state() {
        for bad in [json!(null), json!({}), json!({"agents":{"type":"agents"},"hooks":{"type":"hooks","clients":[]}}), json!({"error":"failed"}), json!({"agents":"x","hooks":"y"})] {
            assert!(fold_direct(&bad).is_none(), "{bad}");
        }
    }
}

#[test]
fn custom_gateway_frames_are_validated_like_the_daemon() {
    let urls_bad = ["http://gateway.example/v1", "http://localhost:4000/v1", "http://192.168.1.2/v1", "http://127.1/v1", "http://2130706433/v1",
        "http://0x7f000001/v1", "ftp://gateway.example/v1", "javascript:alert(1)", "file:///tmp/a", "https://user:pw@gateway.example/v1",
        "https://gateway.example/v1?key=x", "https://gateway.example/v1#x", "https://gateway.example/%2e%2e/v1", "https://gateway.example/a/../v1",
        "https://gateway.example/./v1", "https://exam ple.com/v1", "https://gateway.example\\@evil.com/v1", "https://éxample.com/v1",
        "https://gateway.example:0/v1", "https://gateway.example:65536/v1", "https:///v1", "", "https://gateway.example/v1/ x", "http://127.0.0.1:99999/v1"];
    for url in urls_bad {
        assert!(parse_ui_command(&json!({"action":"custom_account_create","label":"x","baseUrl":url})).is_err(), "create {url}");
        assert!(parse_ui_command(&json!({"action":"custom_endpoint_set","accountId":"gw","baseUrl":url})).is_err(), "endpoint {url}");
    }
    // Accepted by the daemon's validateCustomBaseUrl as well (checked with node while writing this test).
    for url in ["https://gateway.example/v1", "http://127.0.0.1:4000/v1", "http://[::1]:4000", "https://gateway.example/", "https://Gateway.Example:443/v1/", "http://127.0.0.1", "https://1.2.3.4/v1", "https://[2001:db8::1]/v1"] {
        assert!(parse_ui_command(&json!({"action":"custom_account_create","label":"x","baseUrl":url})).is_ok(), "{url}");
    }
    for bad in [json!({"action":"custom_account_create","label":"","baseUrl":"https://g.example/v1"}), json!({"action":"custom_account_create","label":"x\ny","baseUrl":"https://g.example/v1"}),
        json!({"action":"custom_account_create","label":"x","baseUrl":"https://g.example/v1","apiKey":"sk-secret"}),
        json!({"action":"custom_account_create","label":"x","baseUrl":"https://g.example/v1","accountId":"gw"}),
        json!({"action":"custom_account_create","label":"x"}), json!({"action":"custom_endpoint_set","accountId":"../x","baseUrl":"https://g.example/v1"}),
        json!({"action":"custom_endpoint_set","baseUrl":"https://g.example/v1"}), json!({"action":"custom_models_refresh","accountId":"A B"}),
        json!({"action":"custom_models_refresh"}), json!({"action":"custom_models_refresh","accountId":"gw","extra":1})] {
        assert!(parse_ui_command(&bad).is_err(), "must refuse {bad}");
    }
}

#[test]
fn labels_are_measured_in_utf16_units_like_the_daemon() {
    // The daemon counts JS string length (UTF-16 units): 40 emoji = 80 units (ok), 41 = 82 (refused).
    let frame = |label: String| json!({"action":"custom_account_create","label":label,"baseUrl":"https://g.example/v1"});
    assert!(parse_ui_command(&frame("\u{1F600}".repeat(40))).is_ok());
    assert!(parse_ui_command(&frame("\u{1F600}".repeat(41))).is_err());
    assert!(parse_ui_command(&json!({"action":"account_create","provider":"p","label":"\u{1F600}".repeat(41)})).is_err());
    assert!(parse_ui_command(&frame("a".repeat(80))).is_ok());
    assert!(parse_ui_command(&frame("a".repeat(81))).is_err());
}

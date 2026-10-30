use super::*;

fn create_command(n: usize) -> Command {
    Command::Create { id: format!("esp-{n:016x}"), name: format!("Role {n}"), instructions: "Read carefully.\nCite sources.".into(), model: None, space: Some(format!("Space {n}")), spaces: Vec::new(), permissions: specialists::READ_ONLY.to_vec() }
}

#[test]
fn failed_startup_blocks_every_mutation_without_events_or_disk_writes() {
    let root = std::env::temp_dir().join(format!("specialists-load-error-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    for (case, bytes) in [("corrupt", b"{broken".to_vec()), ("oversized", vec![b'x'; 1024 * 1024])] {
        let dir = root.join(case);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(specialists::FILE);
        std::fs::write(&path, &bytes).unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let host = SpecialistsHost::default();
        host.load(Some(&dir));
        let mut events = Vec::new();
        let view = host.execute(Some(&dir), models::REGISTRY, Command::View, |v| events.push(v.clone())).unwrap();
        assert_eq!(view, json!({"v":1,"active":null,"specialists":[],"persisted":false,"load_error":true}));
        let before = host.snapshot();
        let commands = [create_command(1),
            Command::Update { id:"esp-0000000000000001".into(), name:"new".into(), instructions:"new".into(), model:None, space:None, spaces:Vec::new(), permissions:specialists::READ_ONLY.to_vec() },
            Command::Delete { id:"esp-0000000000000001".into() },
            Command::Select { id:Some("esp-0000000000000001".into()) },
            Command::Select { id:None }];
        for command in commands {
            let error = host.execute(Some(&dir), models::REGISTRY, command, |v| events.push(v.clone())).unwrap_err();
            assert_eq!(error.code, "load_error");
            assert_eq!(error.message, "No se pudieron cargar los especialistas; no se cambió nada.");
            assert_eq!(host.snapshot(), before);
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        }
        assert!(events.is_empty(), "no success publication, including view");
        // A user moving the bad file out of the way does not clear the in-memory latch.
        std::fs::rename(&path, dir.join("original-preserved.json")).unwrap();
        let error = host.execute(Some(&dir), models::REGISTRY, create_command(2), |v| events.push(v.clone())).unwrap_err();
        assert_eq!(error.code, "load_error");
        assert!(!path.exists());
        assert_eq!(std::fs::read(dir.join("original-preserved.json")).unwrap(), bytes);
        assert!(events.is_empty());
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_store_startup_is_healthy_and_allows_persisted_creation() {
    let dir = std::env::temp_dir().join(format!("specialists-missing-{}", std::process::id()));
    let host = SpecialistsHost::default();
    host.load(Some(&dir));
    assert_eq!(host.view()["load_error"], false);
    let mut events = Vec::new();
    let view = host.execute(Some(&dir), models::REGISTRY, create_command(1), |v| events.push(v.clone())).unwrap();
    assert_eq!(view["persisted"], true);
    assert_eq!(events, vec![view]);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn host_restart_preserves_the_maximum_serialized_store() {
    let dir = std::env::temp_dir().join(format!("specialists-host-capacity-{}", std::process::id()));
    let host = SpecialistsHost::default();
    host.load(Some(&dir));
    const MODEL_ID: &str = "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm";
    assert_eq!(MODEL_ID.len(), 64);
    let mut entry = models::REGISTRY[0];
    entry.profile_id = MODEL_ID;
    let registry = [entry]; // metadata only, never invokes a model
    let mut events = 0;
    for n in 0..specialists::MAX_SPECIALISTS {
        let command = specialists::parse_command(&json!({"action":"create", "id":format!("e{n:031x}"),
            "name":"🦀".repeat(40), "instructions":"🦀".repeat(2000), "model":MODEL_ID,
            "space":"🦀".repeat(specialists::MAX_SPACE_CHARS),
            "spaces":(0..specialists::MAX_SPACES).map(|k| char::from_u32(0x1F980 + k as u32).unwrap().to_string().repeat(specialists::MAX_SPACE_CHARS)).collect::<Vec<_>>(),
            "permissions":["read","write","network","execute"]})).unwrap();
        host.execute(Some(&dir), &registry, command, |_| events += 1).unwrap();
    }
    host.execute(Some(&dir), &registry, Command::Select { id:Some(format!("e{:031x}",23)) }, |_| events += 1).unwrap();
    assert_eq!(events, 25);
    assert_eq!(std::fs::metadata(dir.join(specialists::FILE)).unwrap().len(), specialists::MAX_FILE_BYTES as u64);
    let expected = host.snapshot();
    let restored = SpecialistsHost::default();
    restored.load(Some(&dir));
    assert_eq!(restored.snapshot(), expected);
    assert_eq!(restored.view()["load_error"], false);
    assert_eq!(restored.view()["persisted"], true);
    restored.execute(Some(&dir), &registry, Command::Select { id:None }, |_| events += 1).unwrap();
    assert_eq!(events, 26);
    assert_eq!(restored.snapshot().items, expected.items);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn startup_io_failure_is_not_a_missing_store() {
    let dir = std::env::temp_dir().join(format!("specialists-host-io-{}", std::process::id()));
    let path = dir.join(specialists::FILE);
    std::fs::create_dir_all(&path).unwrap(); // an existing non-file must not become healthy absence
    let host = SpecialistsHost::default();
    host.load(Some(&dir));
    assert_eq!(host.view()["load_error"], true);
    assert_eq!(host.view()["persisted"], false);
    let error = host.execute(Some(&dir), models::REGISTRY, create_command(1), |_| panic!("unexpected publication")).unwrap_err();
    assert_eq!(error.code, "load_error");
    assert!(path.is_dir());
    assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn concurrent_commands_publish_complete_monotonic_snapshots() {
    let host = std::sync::Arc::new(SpecialistsHost::default());
    let events = std::sync::Arc::new(Mutex::new(Vec::new()));
    let handles: Vec<_> = (0..12).map(|n| {
        let host = host.clone();
        let events = events.clone();
        std::thread::spawn(move || host.execute(None, models::REGISTRY, create_command(n), |v| {
            events.lock().unwrap().push(v["specialists"].as_array().unwrap().len());
        }).unwrap())
    }).collect();
    for handle in handles { handle.join().unwrap(); }
    assert_eq!(*events.lock().unwrap(), (1..=12).collect::<Vec<_>>());
    assert_eq!(host.snapshot().items.len(), 12);
}

#[test]
fn stale_model_selection_refuses_without_mutation_or_publication() {
    let host = SpecialistsHost::default();
    host.execute(None, models::REGISTRY, create_command(1), |_| {}).unwrap();
    // Simulate a formerly valid registry entry disappearing after restart.
    host.store.lock().unwrap().items[0].model = Some("local-gone".into());
    let before = host.snapshot();
    let mut published = false;
    let result = host.execute(None, models::REGISTRY, Command::Select { id: Some("esp-0000000000000001".into()) }, |_| published = true);
    assert_eq!(result.unwrap_err().code, "model_missing");
    assert_eq!(host.snapshot(), before);
    assert!(!published);
}

#[test]
fn one_frozen_role_supplies_both_model_and_instructions() {
    let host = SpecialistsHost::default();
    let mut other = models::REGISTRY[0];
    other.profile_id = "local-specialist"; // test-only registry, never contacted
    let registry = [models::REGISTRY[0], other];
    let mut command = create_command(1);
    if let Command::Create { ref mut model, .. } = command { *model = Some("local-specialist".into()); }
    host.execute(None, &registry, command, |_| {}).unwrap();
    host.execute(None, &registry, Command::Select { id: Some("esp-0000000000000001".into()) }, |_| {}).unwrap();
    let frozen = host.role();
    host.execute(None, &registry, Command::Select { id: None }, |_| {}).unwrap();
    let fallback = modelshost::target_of(&models::REGISTRY[0]);
    let (target, prompt) = resolve_turn(frozen.as_ref(), fallback.clone(), &registry, "BASE", None).unwrap();
    assert_eq!(target.unwrap().profile.profile_id, "local-specialist");
    assert!(prompt.starts_with("BASE"));
    assert!(prompt.contains("Role 1"));
    let (principal, next) = resolve_turn(host.role().as_ref(), fallback, &registry, "BASE", None).unwrap();
    assert_eq!(principal.unwrap().profile.profile_id, "local-abito-gpt");
    assert_eq!(next, "BASE");
    assert!(resolve_turn(frozen.as_ref(), None, models::REGISTRY, "BASE", None).is_err());
}

#[test]
fn ipc_dispatcher_persists_before_events_and_failure_keeps_disk_and_roles() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../evidence/integration-327-342-384/runtime");
    let dir = root.join(format!("host-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let host = SpecialistsHost::default();
    let mut events = 0;
    host.execute(Some(&dir), models::REGISTRY, create_command(1), |_| {
        events += 1;
        assert_eq!(specialists::read_file(&dir).unwrap(), host.snapshot());
    }).unwrap();
    let before = host.snapshot();
    let bytes = std::fs::read(dir.join(specialists::FILE)).unwrap();
    // A temp-file collision must refuse the write, not truncate the existing file.
    let collision = dir.join(format!(".{}.{}.tmp", specialists::FILE, std::process::id()));
    std::fs::write(&collision, b"sentinel").unwrap();
    let err = host.execute(Some(&dir), models::REGISTRY, create_command(2), |_| events += 1).unwrap_err();
    assert_eq!(err.code, "not_saved");
    assert_eq!(err.message, "No se pudo guardar el especialista; no se cambió nada.");
    assert_eq!(host.snapshot(), before);
    assert_eq!(std::fs::read(dir.join(specialists::FILE)).unwrap(), bytes);
    assert_eq!(std::fs::read(&collision).unwrap(), b"sentinel");
    assert_eq!(events, 1);
    assert_eq!(specialists::read_file(&dir).unwrap(), before);
    std::fs::remove_dir_all(dir).unwrap();
}

fn principal_test_state(instructions: &str) -> AppState {
    use crate::*;
    let project = "principal-prompt-test".to_string();
    let prefs = abito_island::prefs::Prefs::from_text(Some(
        &json!({"v": 1, "abito_instructions": instructions}).to_string(),
    ));
    AppState {
        core: Mutex::new(Core::new()),
        work_area: Mutex::new(Rect { x: 0, y: 0, w: 0, h: 0 }),
        monitor: Mutex::new(Rect { x: 0, y: 0, w: 0, h: 0 }),
        window_h: std::sync::atomic::AtomicI32::new(crate::geometry::ISLAND_WINDOW.1),
        requested: Mutex::new(Requested::default()),
        evidence: Mutex::new(None),
        initial_pin: AtomicBool::new(false),
        user_touch: AtomicBool::new(false),
        generation: AtomicU64::new(0),
        phase: Mutex::new(IslandState::Compact),
        motion_override: AtomicBool::new(true),
        revision: AtomicU64::new(0),
        last_published: Mutex::new(String::new()),
        rate: Mutex::new(bridge::RateLimiter::new()),
        facade: Mutex::new(None),
        notices: Mutex::new(protocol::NoticeStore::new(project.clone())),
        connections: AtomicU32::new(0),
        unavailable: AtomicBool::new(false),
        transport: Mutex::new(None),
        project,
        approval: Arc::new(Mutex::new(approval::Approval::new("http://127.0.0.1:1", None).unwrap())),
        hooks: Mutex::new(None),
        #[cfg(any(debug_assertions, feature = "probe"))]
        probe_fake: Mutex::new(None),
        chat: chatlane::Lane::new("c-principal-test"),
        chat_target: Mutex::new(None),
        chat_cloud: Mutex::new(None),
        chat_rate: Mutex::new(bridge::RateLimiter::new()),
        hotkey: hotkeyhost::HotkeyHost::default(),
        settings: settingshost::with_test_prefs(prefs),
        specialists: SpecialistsHost::default(),
        chat_deadlines: Mutex::new(chathost::default_deadlines()),
        chat_context: Mutex::new(Default::default()),
        chat_probe: Mutex::new(Vec::new()),
        models_registry: Mutex::new(models::REGISTRY.to_vec()),
        models_last: Mutex::new(Value::Null),
        models_revision: AtomicU64::new(0),
        models_persisted: AtomicBool::new(false),
    }
}

#[test]
fn turn_snapshot_applies_preferences_only_to_principal_and_freezes_the_prompt() {
    let instructions = "Contestá con ejemplos.\nConservá los saltos.";
    let mut state = principal_test_state(instructions);
    let base = abito_island::chatlane::SYSTEM_PROMPT;
    let (target, frozen, association) = turn_snapshot(&state, base).unwrap();
    assert!(target.is_none());
    assert!(association.is_none());
    assert!(frozen.starts_with(base));
    assert!(frozen.contains(instructions));
    state.specialists.execute(None, models::REGISTRY, create_command(1), |_| {}).unwrap();
    state.specialists.execute(None, models::REGISTRY, Command::Select {
        id: Some("esp-0000000000000001".into()),
    }, |_| {}).unwrap();
    let (_, prompt, association) = turn_snapshot(&state, base).unwrap();
    let role = state.specialists.role().unwrap();
    assert_eq!(prompt, specialists::system_prompt(base, Some(&role)));
    assert!(!prompt.contains(instructions));
    assert_eq!(association.unwrap().id, role.id);
    state.settings = crate::settingshost::with_test_prefs(abito_island::prefs::Prefs::default());
    state.specialists.execute(None, models::REGISTRY, Command::Select { id: None }, |_| {}).unwrap();
    assert_eq!(turn_snapshot(&state, base).unwrap().1, base);
    assert!(frozen.contains(instructions), "later edits cannot change an existing turn");
}

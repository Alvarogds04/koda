//! #327 — the pure contracts of the specialists store. Written before the implementation
//! (RED → GREEN): identity, bounds, fail-closed parsing, the closed command set, «invalid input
//! never mutates», the effective system prompt and the private persistence.
//! #375 — each specialist dot additionally carries a bounded plain-text default Space name and a
//! closed, DECLARATIVE-ONLY permission set (read-only by default). Nothing executes them.
use super::*;
use serde_json::json;
use std::path::PathBuf;

fn spec(id: &str) -> Specialist {
    Specialist {
        id: id.to_string(),
        name: "Investigador".to_string(),
        instructions: "Buscá fuentes y citá.".to_string(),
        model: Some("local-abito-gpt".to_string()),
        space: Some("Investigación".to_string()),
        spaces: Vec::new(),
        permissions: vec![Permission::Read],
    }
}

fn store() -> Store {
    let mut s = Store::default();
    s.items.push(spec("esp-0011223344556677"));
    s.items.push(Specialist {
        id: "esp-8899aabbccddeeff".to_string(),
        name: "Editor".to_string(),
        instructions: "Corregí sin cambiar el sentido.".to_string(),
        model: None,
        space: None,
        spaces: Vec::new(),
        permissions: READ_ONLY.to_vec(),
    });
    s
}

fn tmpdir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("abito-specialists-{}-{tag}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // a config dir is PRIVATE: the store refuses a group/world-writable one, so the fixture is one
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    dir
}

// ---- identity ---------------------------------------------------------------------------------

#[test]
fn an_id_is_opaque_lowercase_ascii_and_never_a_reserved_identity() {
    assert!(valid_id("esp-0011223344556677"));
    assert!(valid_id("a"));
    assert!(valid_id(&"a".repeat(ID_MAX_LEN)));
    assert!(!valid_id(&"a".repeat(ID_MAX_LEN + 1)), "the avatar contract caps the id at 32 characters");
    for bad in ["", "A", "Esp-x", "esp x", "-esp", ".esp", "_esp", "esp\u{e1}", "esp/1", "esp:1"] {
        assert!(!valid_id(bad), "{bad:?} must not be a valid id");
    }
    // the avatar contract allows `.`, `_` and `-` anywhere after the first character
    assert!(valid_id("esp-0011223344556677.x"));
    // the principal and the engine CLIs: a specialist can never take those identities
    for bad in ["abito", "pi", "claude-code", "codex", "opencode", "__proto__", "prototype", "constructor"] {
        assert!(!valid_id(bad), "{bad:?} is reserved");
    }
}

#[test]
fn name_and_instructions_are_bounded_and_refuse_dangerous_controls() {
    assert!(valid_name("Investigador"));
    assert!(valid_name(&"x".repeat(MAX_NAME_CHARS)));
    assert!(!valid_name(&"x".repeat(MAX_NAME_CHARS + 1)));
    assert!(valid_name(&format!("  {}  ", "x".repeat(MAX_NAME_CHARS))), "the limit is on the trimmed name");
    for bad in ["", "   ", "x\u{0}", "x\u{7}", "x\u{1b}", "x\u{7f}", "x\u{9f}", "x\n", "x\t", "x\r"] {
        assert!(!valid_name(bad), "{bad:?} must not be a valid name");
    }
    assert!(valid_instructions("Primero leé.\nDespués resumí.\n\tCon sangría."), "normal line breaks and tabs are fine");
    assert!(valid_instructions(&"x".repeat(MAX_INSTRUCTIONS_CHARS)));
    assert!(!valid_instructions(&"x".repeat(MAX_INSTRUCTIONS_CHARS + 1)));
    for bad in ["", "  ", "x\u{0}", "x\u{7}", "x\u{1b}", "x\u{b}", "x\u{c}", "x\u{d}", "x\u{7f}", "x\u{9f}"] {
        assert!(!valid_instructions(bad), "{bad:?} must not be valid instructions");
    }
}

#[test]
fn space_is_bounded_plain_text_with_no_controls_and_permissions_are_a_closed_read_only_default() {
    assert_eq!(READ_ONLY, [Permission::Read], "read-only is the default permission set");
    assert!(valid_space("Investigación"));
    assert!(valid_space(&"x".repeat(MAX_SPACE_CHARS)));
    assert!(!valid_space(&"x".repeat(MAX_SPACE_CHARS + 1)), "the Space name is bounded plain text");
    for bad in ["", "   ", "x\u{0}", "x\u{7}", "x\u{1b}", "x\u{7f}", "x\u{9f}", "x\n", "x\t", "x\r"] {
        assert!(!valid_space(bad), "{bad:?} must not be a valid Space name");
    }
    // The closed vocabulary: exactly four permissions, nothing else ever parses.
    assert_eq!(Permission::ALL.len(), 4);
    assert_eq!(Permission::parse("read"), Some(Permission::Read));
    assert_eq!(Permission::parse("write"), Some(Permission::Write));
    assert_eq!(Permission::parse("network"), Some(Permission::Network));
    assert_eq!(Permission::parse("execute"), Some(Permission::Execute));
    for bad in ["", "READ", "Read", "admin", "root", "shell", "files", "exec", "net", "*"] {
        assert_eq!(Permission::parse(bad), None, "{bad:?} is not in the closed permission set");
    }
    // Canonical storage order is the declared ALL order, whatever the input order was.
    assert_eq!(canonical_permissions(&[Permission::Execute, Permission::Read, Permission::Network]),
        vec![Permission::Read, Permission::Network, Permission::Execute]);
}

#[test]
fn hostile_stored_space_and_permissions_are_dropped_and_records_still_load_read_only() {
    // A record whose NEW fields are hostile survives: the value is dropped, never executed.
    let hostile_space = json!({"v":1,"active":null,"specialists":[
        {"id":"esp-0011223344556677","name":"Válido","instructions":"ok","model":null,"space":"x\u{0}y"},
        {"id":"esp-8899aabbccddeeff","name":"Largo","instructions":"ok","model":null,"space":"x".repeat(MAX_SPACE_CHARS + 1)},
        {"id":"esp-ffeeddccbbaa9988","name":"Tipo","instructions":"ok","model":null,"space":7},
        {"id":"esp-f0f0f0f0f0f0f0f0","name":"Vacío","instructions":"ok","model":null,"space":"   "}
    ]}).to_string();
    let s = Store::from_text(Some(&hostile_space));
    assert_eq!(s.items.len(), 4, "a hostile NEW field never invalidates the whole record");
    for item in &s.items {
        assert_eq!(item.space, None, "a hostile stored Space value is dropped, never executed");
    }
    // A hostile permission set falls back to read-only; absent stays the read-only default.
    let hostile_permissions = json!({"v":1,"active":null,"specialists":[
        {"id":"esp-0011223344556677","name":"Uno","instructions":"ok","model":null,"permissions":["read","root"]},
        {"id":"esp-8899aabbccddeeff","name":"Dos","instructions":"ok","model":null,"permissions":[7]},
        {"id":"esp-ffeeddccbbaa9988","name":"Tres","instructions":"ok","model":null,"permissions":"read"},
        {"id":"esp-f0f0f0f0f0f0f0f0","name":"Cuatro","instructions":"ok","model":null,"permissions":[]},
        {"id":"esp-abababababababab","name":"Cinco","instructions":"ok","model":null}
    ]}).to_string();
    let s = Store::from_text(Some(&hostile_permissions));
    assert_eq!(s.items.len(), 5);
    for item in &s.items {
        assert_eq!(item.permissions, READ_ONLY.to_vec(), "every hostile, empty or absent set degrades to read-only");
    }
    // Tolerant reads keep every recognised value and deduplicate stored duplicates.
    let rich = json!({"v":1,"active":null,"specialists":[
        {"id":"esp-0011223344556677","name":"Rico","instructions":"ok","model":null,
         "space":"  Mi espacio  ","permissions":["execute","network","execute"]}
    ]}).to_string();
    let s = Store::from_text(Some(&rich));
    assert_eq!(s.items[0].space.as_deref(), Some("Mi espacio"), "the stored Space name is trimmed");
    assert_eq!(s.items[0].permissions, vec![Permission::Network, Permission::Execute], "stored duplicates collapse, canonical order wins");
}

// ---- #376 — the optional closed list of extra Space names (DECLARATIVE ONLY) --------------------

fn draft_spaces_of(command: &Command) -> &[String] {
    match command {
        Command::Create { spaces, .. } | Command::Update { spaces, .. } => spaces,
        _ => panic!("not a draft command"),
    }
}

#[test]
fn spaces_is_an_optional_closed_list_of_bounded_names() {
    // Absent or empty is today's behaviour: no extra Spaces, nothing else changes.
    let absent = json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null});
    assert!(draft_spaces_of(&parse_command(&absent).unwrap()).is_empty());
    let empty = json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"spaces":[]});
    assert!(draft_spaces_of(&parse_command(&empty).unwrap()).is_empty());
    let granted = json!({"action":"update","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,
        "spaces":["Investigación","Archivo"],"permissions":["read"]});
    assert_eq!(draft_spaces_of(&parse_command(&granted).unwrap()), ["Investigación", "Archivo"]);
    // Values are bounded plain text like the default Space name, and are stored trimmed.
    let trimmed = json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,
        "spaces":["  Archivo  "]});
    assert_eq!(draft_spaces_of(&parse_command(&trimmed).unwrap()), ["Archivo"]);
    // The list is closed: duplicates, hostile names, wrong shapes and over-cap lists are refused,
    // and an unknown key can never ride in next to it.
    let over: Vec<String> = (0..MAX_SPACES + 1).map(|k| format!("s{k:079}")).collect();
    for bad in [
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"spaces":["A","A"]}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"spaces":["ok","x\u{0}y"]}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"spaces":["x\n"]}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"spaces":["x".repeat(MAX_SPACE_CHARS + 1)]}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"spaces":[7]}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"spaces":"Archivo"}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"spaces":over}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"spaces":["A"],"extra":1}),
    ] {
        assert_eq!(parse_command(&bad), Err(CommandError), "{bad} must be refused");
    }
}

#[test]
fn create_and_update_carry_the_closed_space_list_or_refuse_without_mutating() {
    let before = store();
    let mut granted = spec("esp-ffeeddccbbaa9988");
    granted.spaces = vec!["Investigación".into(), "Archivo".into()];
    let after = create(&before, granted).unwrap();
    assert_eq!(after.find("esp-ffeeddccbbaa9988").unwrap().spaces, ["Investigación", "Archivo"]);
    assert_eq!(before, store(), "the previous store is untouched");
    // every refusal leaves the store EXACTLY as it was
    for bad_spaces in [
        vec!["A".to_string(), "A".to_string()],
        vec!["x\u{0}y".to_string()],
        vec!["x".repeat(MAX_SPACE_CHARS + 1)],
        (0..MAX_SPACES + 1).map(|k| format!("s{k:079}")).collect::<Vec<String>>(),
    ] {
        let mut bad = spec("esp-ffeeddccbbaa9988");
        bad.spaces = bad_spaces;
        assert_eq!(create(&before, bad).unwrap_err(), CommandError);
        assert_eq!(before, store());
    }
    // update replaces the whole list; an empty list clears it back to the default Space only
    let updated = update(&before, "esp-0011223344556677", "Investigador", "Buscá", None, None, vec!["Nuevo".to_string()], READ_ONLY.to_vec()).unwrap();
    assert_eq!(updated.find("esp-0011223344556677").unwrap().spaces, ["Nuevo"]);
    let cleared = update(&before, "esp-0011223344556677", "Investigador", "Buscá", None, None, Vec::new(), READ_ONLY.to_vec()).unwrap();
    assert!(cleared.find("esp-0011223344556677").unwrap().spaces.is_empty());
    assert_eq!(before, store(), "the caller's store is never touched");
}

#[test]
fn stored_spaces_are_tolerant_read_only_data_and_deduplicate() {
    // An OLD record without the field keeps loading, with no extra Spaces.
    let old = json!({"v":1,"active":null,"specialists":[
        {"id":"esp-0011223344556677","name":"Viejo","instructions":"ok","model":null}]}).to_string();
    assert_eq!(Store::from_text(Some(&old)).items[0].spaces, Vec::<String>::new());
    // A hostile STORED value is dropped, never executed: the record survives, the list empties.
    let text = json!({"v":1,"active":null,"specialists":[
        {"id":"esp-0011223344556677","name":"Hostil","instructions":"ok","model":null,"spaces":["ok","x\u{0}y"]},
        {"id":"esp-8899aabbccddeeff","name":"Tipo","instructions":"ok","model":null,"spaces":"Archivo"},
        {"id":"esp-ffeeddccbbaa9988","name":"Dup","instructions":"ok","model":null,"spaces":["B","A","B"]},
        {"id":"esp-f0f0f0f0f0f0f0f0","name":"Trim","instructions":"ok","model":null,"spaces":["  A  ","B"]},
        {"id":"esp-abababababababab","name":"Cap","instructions":"ok","model":null,
         "spaces":(0..MAX_SPACES + 3).map(|k| format!("s{k:079}")).collect::<Vec<_>>()}
    ]}).to_string();
    let s = Store::from_text(Some(&text));
    assert_eq!(s.items.len(), 5, "a hostile Space list never invalidates the whole record");
    assert_eq!(s.items[0].spaces, Vec::<String>::new(), "one hostile element drops the whole stored list");
    assert_eq!(s.items[1].spaces, Vec::<String>::new(), "a wrongly typed value drops to none");
    assert_eq!(s.items[2].spaces, ["B", "A"], "stored duplicates collapse, first occurrence wins");
    assert_eq!(s.items[3].spaces, ["A", "B"], "stored values are trimmed");
    assert_eq!(s.items[4].spaces.len(), MAX_SPACES, "an over-cap STORED list is truncated, never fatal");
}

#[test]
fn the_space_list_round_trips_through_the_store_file() {
    let mut s = store();
    s.items[0].spaces = vec!["Investigación".into(), "Archivo".into()];
    assert_eq!(Store::from_text(Some(&s.to_text())), s, "a full round trip keeps the Space list");
    assert!(s.to_text().contains("\"spaces\""), "the list is persisted, not just held in memory");
    assert_eq!(Store::from_text(Some(&Store::default().to_text())), Store::default());
}

// ---- store ------------------------------------------------------------------------------------

#[test]
fn the_store_fails_closed_and_round_trips() {
    assert_eq!(Store::from_text(None), Store::default(), "an absent file is an empty store, not an error");
    for bad in ["", "not json", "{}", "[]", "null", r#"{"v":2,"specialists":[]}"#, r#"{"v":1}"#, r#"{"v":1,"specialists":{}}"#, r#"{"v":1,"active":null,"specialists":"x"}"#] {
        assert_eq!(Store::from_text(Some(bad)), Store::default(), "{bad:?} must read as an empty store");
    }
    let s = store();
    assert_eq!(Store::from_text(Some(&s.to_text())), s, "a full round trip keeps every field");
    assert!(!s.to_text().contains('\n'), "one line, no surprises");
    assert_eq!(store().find("esp-8899aabbccddeeff").unwrap().name, "Editor");
    assert!(store().find("esp-ffffffffffffffff").is_none());
}

#[test]
fn bad_records_and_unknown_active_ids_are_dropped_without_taking_the_store_down() {
    let text = json!({"v":1,"active":"esp-ffffffffffffffff","specialists":[
        {"id":"abito","name":"Principal falso","instructions":"x","model":null},
        {"id":"ESP-MAYUS","name":"Mayúsculas","instructions":"x","model":null},
        {"id":"esp-0011223344556677","name":"  ","instructions":"x","model":null},
        {"id":"esp-8899aabbccddeeff","name":"Editor","instructions":"x","model":"NUBE"},
        {"id":"esp-ffeeddccbbaa9988","name":"Válido","instructions":"ok","model":null},
        {"id":"esp-ffeeddccbbaa9988","name":"Duplicado","instructions":"ok","model":null}
    ]}).to_string();
    let s = Store::from_text(Some(&text));
    assert_eq!(s.items.len(), 1, "one valid, deduplicated record survives");
    assert_eq!(s.items[0].name, "Válido");
    assert_eq!(s.active, None, "an active id with no surviving record is no role");
}

#[test]
fn the_store_is_capped_and_a_valid_active_role_is_kept() {
    let items: Vec<Specialist> = (0..MAX_SPECIALISTS + 5)
        .map(|n| Specialist { id: format!("esp-{n:016x}"), name: format!("Rol {n}"), instructions: "ok".into(), model: None, space: None, spaces: Vec::new(), permissions: READ_ONLY.to_vec() })
        .collect();
    let text = json!({"v":1,"active":"esp-0000000000000001","specialists": items.iter().map(|s| json!({
        "id": s.id, "name": s.name, "instructions": s.instructions, "model": s.model })).collect::<Vec<_>>() }).to_string();
    let s = Store::from_text(Some(&text));
    assert_eq!(s.items.len(), MAX_SPECIALISTS);
    assert_eq!(s.active.as_deref(), Some("esp-0000000000000001"));
}

#[test]
fn the_command_set_is_closed_and_exact() {
    assert_eq!(parse_command(&json!({"action":"view"})), Ok(Command::View));
    let create = json!({"action":"create","id":"esp-0011223344556677","name":"Investigador","instructions":"Buscá","model":"local-abito-gpt"});
    let null_model = json!({"action":"create","id":"esp-0011223344556677","name":"Investigador","instructions":"Buscá","model":null});
    assert_eq!(parse_command(&json!({"action":"select","id":null})), Ok(Command::Select { id: None }));
    assert_eq!(parse_command(&json!({"action":"select","id":"esp-0011223344556677"})), Ok(Command::Select { id: Some("esp-0011223344556677".into()) }));
    assert_eq!(parse_command(&json!({"action":"delete","id":"esp-0011223344556677"})), Ok(Command::Delete { id: "esp-0011223344556677".into() }));
    // #375: the new fields are OPTIONAL. Today's exact five-key shape is accepted unchanged and
    // means no Space and the read-only default; six- and seven-key shapes carry them.
    assert_eq!(parse_command(&create), Ok(Command::Create {
        id: "esp-0011223344556677".into(), name: "Investigador".into(), instructions: "Buscá".into(),
        model: Some("local-abito-gpt".into()), space: None, spaces: Vec::new(), permissions: READ_ONLY.to_vec() }));
    assert_eq!(parse_command(&null_model), Ok(Command::Create {
        id: "esp-0011223344556677".into(), name: "Investigador".into(), instructions: "Buscá".into(),
        model: None, space: None, spaces: Vec::new(), permissions: READ_ONLY.to_vec() }));
    let with_space = json!({"action":"create","id":"esp-0011223344556677","name":"Investigador","instructions":"Buscá","model":null,"space":"Investigación"});
    assert_eq!(parse_command(&with_space), Ok(Command::Create {
        id: "esp-0011223344556677".into(), name: "Investigador".into(), instructions: "Buscá".into(),
        model: None, space: Some("Investigación".into()), spaces: Vec::new(), permissions: READ_ONLY.to_vec() }));
    let with_all = json!({"action":"update","id":"esp-0011223344556677","name":"Investigador","instructions":"Buscá","model":null,"space":null,"permissions":["network","read","execute"]});
    assert_eq!(parse_command(&with_all), Ok(Command::Update {
        id: "esp-0011223344556677".into(), name: "Investigador".into(), instructions: "Buscá".into(),
        model: None, space: None, spaces: Vec::new(), permissions: vec![Permission::Read, Permission::Network, Permission::Execute] }));
    let cleared_space = json!({"action":"update","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"space":""});
    assert_eq!(parse_command(&cleared_space), Ok(Command::Update {
        id: "esp-0011223344556677".into(), name: "n".into(), instructions: "i".into(),
        model: None, space: None, spaces: Vec::new(), permissions: READ_ONLY.to_vec() }), "an empty Space string clears the name");
    for bad in [
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"space":"x\u{0}"}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"space":"x\n"}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"space":"x".repeat(MAX_SPACE_CHARS + 1)}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"space":7}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"permissions":["read","root"]}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"permissions":[7]}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"permissions":"read"}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"permissions":["read","read"]}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"permissions":["read"],"space":"x","extra":1}),
    ] {
        assert_eq!(parse_command(&bad), Err(CommandError), "{bad} must be refused");
    }
    for bad in [
        json!(null), json!([]), json!("view"), json!({}), json!({"action":1}), json!({"action":"view","x":1}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i"}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":null,"extra":1}),
        json!({"action":"create","id":1,"name":"n","instructions":"i","model":null}),
        json!({"action":"create","id":"esp-0011223344556677","name":1,"instructions":"i","model":null}),
        json!({"action":"create","id":"esp-0011223344556677","name":"n","instructions":"i","model":7}),
        json!({"action":"update","id":"esp-0011223344556677","name":"n","instructions":"i"}),
        json!({"action":"delete"}),
        json!({"action":"delete","id":1}),
        json!({"action":"select"}),
        json!({"action":"select","id":1}),
        json!({"action":"select","id":"esp-0011223344556677","extra":1}),
    ] {
        assert_eq!(parse_command(&bad), Err(CommandError), "{bad} must be refused");
    }
}

// ---- mutations: fail closed, never partially applied ------------------------------------------

#[test]
fn create_needs_a_fresh_valid_id_and_never_activates_by_itself() {
    let before = store();
    let after = create(&before, spec("esp-ffeeddccbbaa9988")).unwrap();
    assert_eq!(after.items.len(), 3);
    assert_eq!(after.active, None, "creating is not choosing");
    assert_eq!(after.find("esp-ffeeddccbbaa9988").unwrap().name, "Investigador");
    assert_eq!(before.items.len(), 2, "the previous store is untouched");
    // every refusal leaves the store EXACTLY as it was
    for bad in [spec("esp-0011223344556677"), spec("abito"), spec("ESP-1"), spec("")] {
        assert_eq!(create(&before, bad).unwrap_err(), CommandError);
        assert_eq!(before, store());
    }
    let mut nameless = spec("esp-ffeeddccbbaa9988");
    nameless.name = "  ".into();
    assert_eq!(create(&before, nameless), Err(CommandError));
    let mut wordy = spec("esp-ffeeddccbbaa9988");
    wordy.instructions = "x".repeat(MAX_INSTRUCTIONS_CHARS + 1);
    assert_eq!(create(&before, wordy), Err(CommandError));
    let mut invented = spec("esp-ffeeddccbbaa9988");
    invented.model = Some("NUBE-gpt".into());
    assert_eq!(create(&before, invented), Err(CommandError), "an unverified model id is refused");
    let mut spaced = spec("esp-ffeeddccbbaa9988");
    spaced.space = Some("x\u{0}".into());
    assert_eq!(create(&before, spaced), Err(CommandError), "a hostile Space name is refused, never stored");
    let mut permless = spec("esp-ffeeddccbbaa9988");
    permless.permissions = Vec::new();
    assert_eq!(create(&before, permless), Err(CommandError), "an empty permission set is not a set; read-only is the floor");
    assert_eq!(before, store());
}

#[test]
fn create_refuses_a_full_store() {
    let mut s = Store::default();
    for n in 0..MAX_SPECIALISTS {
        s.items.push(Specialist { id: format!("esp-{n:016x}"), name: format!("Rol {n}"), instructions: "ok".into(), model: None, space: None, spaces: Vec::new(), permissions: READ_ONLY.to_vec() });
    }
    assert_eq!(create(&s, spec("esp-ffeeddccbbaa9988")), Err(CommandError));
    assert_eq!(s.items.len(), MAX_SPECIALISTS);
}

#[test]
fn update_keeps_the_id_and_the_active_role() {
    let mut before = store();
    before.active = Some("esp-0011223344556677".to_string());
    let after = update(&before, "esp-0011223344556677", "Investigador serio", "Buscá y citá.\nSin adornos.", Some("local-abito-gpt".to_string()), Some("Investigación".to_string()), Vec::new(), vec![Permission::Read, Permission::Network]).unwrap();
    assert_eq!(after.find("esp-0011223344556677").unwrap().id, "esp-0011223344556677", "renaming never moves the id");
    assert_eq!(after.find("esp-0011223344556677").unwrap().name, "Investigador serio");
    assert_eq!(after.find("esp-0011223344556677").unwrap().space.as_deref(), Some("Investigación"));
    assert_eq!(after.find("esp-0011223344556677").unwrap().permissions, vec![Permission::Read, Permission::Network]);
    assert_eq!(after.active, before.active);
    assert_eq!(after.items.len(), 2);
    for (id, name, instructions, model, space, spaces, permissions) in [
        ("esp-ffffffffffffffff", "n", "i", None, None, Vec::new(), READ_ONLY.to_vec()),
        ("esp-0011223344556677", "  ", "i", None, None, Vec::new(), READ_ONLY.to_vec()),
        ("esp-0011223344556677", "n", "", None, None, Vec::new(), READ_ONLY.to_vec()),
        ("esp-0011223344556677", "n", "i", Some("NUBE".to_string()), None, Vec::new(), READ_ONLY.to_vec()),
        ("esp-0011223344556677", "n", "i", None, Some("x\u{0}".to_string()), Vec::new(), READ_ONLY.to_vec()),
        ("esp-0011223344556677", "n", "i", None, None, Vec::new(), Vec::new()),
        ("esp-0011223344556677", "n", "i", None, None, Vec::new(), vec![Permission::Read, Permission::Read]),
    ] {
        assert_eq!(update(&before, id, name, instructions, model, space, spaces, permissions), Err(CommandError), "{id}/{name}");
        assert_eq!(before, store_with_active(), "a refused update changes nothing");
    }
}

fn store_with_active() -> Store {
    let mut s = store();
    s.active = Some("esp-0011223344556677".to_string());
    s
}

#[test]
fn delete_and_select_move_the_active_role_coherently() {
    let before = store_with_active();
    let after = remove(&before, "esp-0011223344556677").unwrap();
    assert_eq!(after.items.len(), 1);
    assert_eq!(after.active, None, "deleting the role in use returns to the principal");
    assert_eq!(remove(&before, "esp-ffffffffffffffff"), Err(CommandError));
    assert_eq!(before, store_with_active());
    let chosen = select(&before, Some("esp-8899aabbccddeeff")).unwrap();
    assert_eq!(chosen.active.as_deref(), Some("esp-8899aabbccddeeff"));
    assert_eq!(select(&before, Some("esp-ffffffffffffffff")), Err(CommandError), "an unknown role is not a role");
    assert_eq!(before, store_with_active());
    assert_eq!(select(&before, None).unwrap().active, None, "going back to the principal is explicit");
    assert_eq!(select(&before, Some("abito")), Err(CommandError));
}

// ---- the role's effect on a turn ---------------------------------------------------------------

#[test]
fn the_principal_prompt_is_unchanged_and_a_role_is_added_around_it() {
    const BASE: &str = "Sos Koda, el compañero de escritorio. No podés aprobar ni ejecutar nada.";
    assert_eq!(system_prompt(BASE, None), BASE, "without a specialist the principal's prompt is byte for byte the same");
    let role = spec("esp-0011223344556677");
    let with_role = system_prompt(BASE, Some(&role));
    assert!(with_role.starts_with(BASE), "the base policy comes first and is never replaced");
    assert!(with_role.contains("Investigador"), "the visible name is in the prompt");
    assert!(with_role.contains("Buscá fuentes y citá."), "the instructions are in the prompt");
    assert!(with_role.contains("aprobar"), "the base guard rails are restated, not dropped");
    assert!(with_role.ends_with('\n') || with_role.len() > BASE.len());
    assert!(with_role.len() < 4096, "the effective prompt stays bounded");
}

// ---- persistence ------------------------------------------------------------------------------

#[test]
fn full_unicode_capacity_survives_restart_with_every_field_and_active_role() {
    let dir = tmpdir("unicode-capacity");
    let mut expected = Store::default();
    for n in 0..MAX_SPECIALISTS {
        let payload = json!({"action":"create", "id":format!("e{n:031x}"),
            "name":"🦀".repeat(MAX_NAME_CHARS),
            "instructions":"🦀".repeat(MAX_INSTRUCTIONS_CHARS), "model":"m".repeat(64),
            "space":"🦀".repeat(MAX_SPACE_CHARS),
            "spaces":(0..MAX_SPACES).map(|k| char::from_u32(0x1F980 + k as u32).unwrap().to_string().repeat(MAX_SPACE_CHARS)).collect::<Vec<_>>(),
            "permissions":["read","write","network","execute"]});
        let Command::Create { id, name, instructions, model, space, spaces, permissions } = parse_command(&payload).unwrap() else { panic!() };
        expected = create(&expected, Specialist { id, name, instructions, model, space, spaces, permissions }).unwrap();
    }
    expected = select(&expected, Some(&expected.items[23].id)).unwrap();
    assert_eq!(expected.to_text().len(), MAX_FILE_BYTES, "maximum UTF-8 fields, IDs, Space names and permission sets saturate the derived bound");
    write_file(&dir, &expected).unwrap();
    let restored = read_file(&dir).unwrap();
    eprintln!("accepted={} saved_bytes={} restored={}", expected.items.len(), std::fs::metadata(dir.join(FILE)).unwrap().len(), restored.items.len());
    assert_eq!(restored, expected, "all IDs, text, models, Space names, permissions and active must survive restart");
    std::fs::remove_dir_all(dir).unwrap();
}


#[test]
fn json_escaped_fields_roundtrip_and_one_byte_above_the_file_bound_is_refused() {
    let dir = tmpdir("escaped-boundary");
    let mut expected = Store::default();
    for n in 0..MAX_SPECIALISTS {
        expected = create(&expected, Specialist {
            id: format!("e{n:031x}"), name: "\"\\".repeat(20),
            instructions: format!("{}\"", "\"\\\n\t".repeat(500)).chars().skip(1).collect(),
            model: Some("m".repeat(64)),
            space: Some("\"\\".repeat(MAX_SPACE_CHARS / 2)),
            spaces: (0..MAX_SPACES).map(|k| format!("\"\\{}", format!("{:078}", k))).collect(),
            permissions: Permission::ALL.to_vec(),
        }).unwrap();
    }
    expected = select(&expected, Some(&expected.items[0].id)).unwrap();
    write_file(&dir, &expected).unwrap();
    assert_eq!(read_file(&dir).unwrap(), expected);
    let path = dir.join(FILE);
    let mut bytes = expected.to_text().into_bytes();
    bytes.resize(MAX_FILE_BYTES, b' ');
    std::fs::write(&path, &bytes).unwrap();
    assert_eq!(read_file(&dir).unwrap(), expected, "exact file bound accepts valid JSON");
    bytes.push(b' ');
    std::fs::write(&path, &bytes).unwrap();
    assert_eq!(read_file(&dir), Err(LoadError), "one byte beyond cap is refused even for valid JSON");
    assert!(write_file(&dir, &Store::default()).is_err(), "a failed load cannot authorize overwrite");
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn invalid_existing_data_is_not_silently_sanitized_or_overwritten() {
    let dir = tmpdir("invalid-load");
    let path = dir.join(FILE);
    write_file(&dir, &store()).unwrap();
    let invalid = [
        b"not json".to_vec(), vec![0xff],
        br#"{"v":2,"active":null,"specialists":[]}"#.to_vec(),
        br#"{"v":1,"active":null,"specialists":[{}]}"#.to_vec(),
        br#"{"v":1,"active":"unknown","specialists":[]}"#.to_vec(),
    ];
    for bytes in invalid {
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(read_file(&dir), Err(LoadError));
        assert!(write_file(&dir, &Store::default()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_oversized_write_preserves_disk_memory_and_persistence_failure() {
    use std::sync::{Mutex, atomic::{AtomicBool, Ordering}};
    let dir = tmpdir("oversized-write");
    let before = store_with_active();
    write_file(&dir, &before).unwrap();
    let bytes = std::fs::read(dir.join(FILE)).unwrap();
    let current = Mutex::new(before.clone());
    let persisted = AtomicBool::new(true);
    let mut oversized = before.clone();
    oversized.items[0].instructions = "x".repeat(1024 * 1024);
    assert!(commit(&current, &persisted, Some(&dir), oversized).is_err());
    assert_eq!(std::fs::read(dir.join(FILE)).unwrap(), bytes);
    assert_eq!(*current.lock().unwrap(), before);
    assert!(!persisted.load(Ordering::SeqCst));
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_saved_file_is_private_and_a_restart_reads_what_was_written() {
    let dir = tmpdir("store");
    let mut s = store();
    s.active = Some("esp-8899aabbccddeeff".to_string());
    write_file(&dir, &s).unwrap();
    let path = dir.join(FILE);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the store is private to the human");
    }
    assert_eq!(read_file(&dir).unwrap(), s, "a restart sees the same roles and the same active role");
    // a corrupt or hostile file fails closed: no roles, no crash
    std::fs::write(&path, b"{not json").unwrap();
    assert_eq!(read_file(&dir), Err(LoadError));
    std::fs::write(&path, b"{}").unwrap();
    assert_eq!(read_file(&dir), Err(LoadError));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read_file(&dir), Err(LoadError), "a world-readable store is not trusted");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_absent_file_is_not_an_error_and_a_symlink_is_refused() {
    let dir = tmpdir("absent");
    assert_eq!(read_file(&dir), Ok(Store::default()));
    #[cfg(unix)]
    {
        let target = dir.join("elsewhere.json");
        std::fs::write(&target, store().to_text()).unwrap();
        std::os::unix::fs::symlink(&target, dir.join(FILE)).unwrap();
        assert_eq!(read_file(&dir), Err(LoadError), "a symlinked store is never followed");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_failed_write_keeps_the_previous_role_and_never_claims_a_saved_one() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    let before = store_with_active();
    let current = Mutex::new(before.clone());
    let persisted = AtomicBool::new(true);
    // a group/world-writable directory is refused: the store must stay exactly as it was
    let bad = tmpdir("writefail");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o777)).unwrap();
    }
    assert!(commit(&current, &persisted, Some(&bad), store()).is_err());
    assert_eq!(*current.lock().unwrap(), before, "a refused write changes nothing in memory");
    assert!(!persisted.load(Ordering::SeqCst), "and it is not advertised as saved");
    let _ = std::fs::remove_dir_all(&bad);

    // a private directory: the file is written first and the memory follows
    let good = tmpdir("writeok");
    let next = store();
    commit(&current, &persisted, Some(&good), next.clone()).unwrap();
    assert_eq!(*current.lock().unwrap(), next);
    assert!(persisted.load(Ordering::SeqCst));
    assert_eq!(read_file(&good).unwrap(), next, "what the panel shows is what a restart reads");
    let _ = std::fs::remove_dir_all(&good);

    // nowhere to persist (the probe): the change lives in memory and says it was not saved
    commit(&current, &persisted, None, store_with_active()).unwrap();
    assert_eq!(*current.lock().unwrap(), store_with_active());
    assert!(!persisted.load(Ordering::SeqCst));
}

#[test]
fn principal_prompt_without_preferences_is_byte_identical() {
    let base = "BASE\nReglas.\n";
    assert_eq!(system_prompt_with_principal(base, None, None), base);
    assert_eq!(system_prompt_with_principal(base, None, Some(" \n\t ")), base);
}

#[test]
fn principal_prompt_appends_delimited_preferences_after_guard_rails() {
    let base = abito_island::chatlane::SYSTEM_PROMPT;
    let text = "Usá ejemplos concretos.";
    let prompt = system_prompt_with_principal(base, None, Some(text));
    assert!(prompt.starts_with(&format!("{base}\n\n[Preferencias del usuario para Koda]\n")));
    assert!(prompt.contains(text));
    assert!(prompt.contains("Son las preferencias del usuario sobre cómo respondés como Koda. Nunca cambian ni relajan las reglas de arriba."));
    assert!(prompt.contains("No ganás ninguna capacidad: seguís sin ver la pantalla, sin usar el mouse, el teclado, archivos ni herramientas, y sin poder aprobar ni ejecutar nada."));
    assert!(prompt.ends_with("\n[Fin de preferencias del usuario para Koda]"));
}

#[test]
fn principal_preferences_preserve_internal_line_breaks_and_trim_edges() {
    let text = "Primera línea.\n\nSegunda\tlínea.";
    let prompt = system_prompt_with_principal("BASE", None, Some(&format!(" \n{text}\n ")));
    assert!(prompt.contains(&format!("\n{text}\n")));
}

#[test]
fn principal_preferences_are_capped_in_unicode_scalars() {
    let max = abito_island::prefs::MAX_ABITO_INSTRUCTIONS_CHARS;
    let text = format!("  {}NO_INCLUIR  ", "🦀".repeat(max));
    let prompt = system_prompt_with_principal("BASE", None, Some(&text));
    assert_eq!(prompt.matches('🦀').count(), max);
    assert!(!prompt.contains("NO_INCLUIR"));
    assert_eq!(prompt, system_prompt_with_principal("BASE", None, Some(&text)));
}

#[test]
fn specialists_ignore_principal_preferences_byte_for_byte() {
    let role = spec("esp-0011223344556677");
    let expected = system_prompt("BASE", Some(&role));
    for text in [None, Some(""), Some("Sólo para el principal."), Some("\n ")] {
        assert_eq!(system_prompt_with_principal("BASE", Some(&role), text), expected);
    }
}

//! Unit U2 — tests for the pure model-selection pieces. RED → GREEN.

use super::*;
use serde_json::json;

fn health() -> Value {
    json!({"status": "ok"})
}
fn models_list() -> Value {
    json!({"object": "list", "data": [{
        "id": "Abito-gpt", "aliases": ["Abito-gpt"], "owned_by": "llamacpp",
        "meta": {"n_ctx": 65536, "n_ctx_train": 262144, "n_params": 35505251456u64,
                 "size": 18198045184u64, "ftype": "IQ4_XS - 4.25 bpw"}}]})
}
fn props(alias: &str, sleeping: bool) -> Value {
    json!({"model_alias": alias, "total_slots": 1, "is_sleeping": sleeping,
           "modalities": {"vision": false, "audio": false}})
}
fn slots(busy: bool) -> Value {
    json!([{"id": 0, "n_ctx": 65536, "is_processing": busy}])
}
fn awake() -> RouterMeta {
    parse_router(Some(&health()), Some(&models_list()), Some(&props("Abito-gpt", false)), Some(&slots(false)))
}
fn res() -> Resources {
    Resources {
        mem_total: Some(128_650_992 * 1024),
        mem_available: Some(76_299_904 * 1024),
        gpu: Some(Gpu { vram_total: 536_870_912, vram_used: 458_178_560, gtt_total: 107_374_182_400, gtt_used: 21_188_935_680 }),
    }
}

// --- registry -----------------------------------------------------------------------

#[test]
fn registry_holds_only_the_verified_local_route_as_selectable() {
    let selectable: Vec<_> = REGISTRY.iter().filter(|e| e.selectable()).collect();
    assert_eq!(selectable.len(), 1);
    let e = selectable[0];
    assert_eq!(e.profile_id, "local-abito-gpt");
    assert_eq!(e.origin, "http://127.0.0.1:11002");
    assert_eq!(e.alias, Some("Abito-gpt"));
    assert_eq!(e.role, "conversation");
    // every entry is literal loopback: no cloud, no LAN, no key field exists
    for e in REGISTRY {
        assert!(crate::localmodel::LocalEndpoint::parse(e.origin).is_ok(), "{}", e.origin);
    }
}

#[test]
fn unidentified_ports_are_disabled_diagnostics_never_selectable() {
    let p11014 = REGISTRY.iter().find(|e| e.origin.ends_with(":11014")).unwrap();
    let p11017 = REGISTRY.iter().find(|e| e.origin.ends_with(":11017")).unwrap();
    assert!(!p11014.selectable() && !p11017.selectable());
    assert_eq!(p11014.alias, None);
    assert!(matches!(p11014.kind, Kind::Diagnostic { state: "unknown", .. }));
    assert!(matches!(p11017.kind, Kind::Diagnostic { state: "unavailable", .. }));
}

// --- router metadata ---------------------------------------------------------------

#[test]
fn router_metadata_is_parsed_from_the_four_reads() {
    let m = awake();
    assert!(m.reachable);
    assert_eq!(m.loaded_alias.as_deref(), Some("Abito-gpt"));
    assert_eq!(m.sleeping, Some(false));
    assert_eq!(m.busy, Some(false));
    assert_eq!(m.slots_total, Some(1));
    assert_eq!(m.n_ctx, Some(65536));
    assert_eq!(m.vision, Some(false));
    assert_eq!(m.listed.len(), 1);
    let l = &m.listed[0];
    assert_eq!(l.id, "Abito-gpt");
    assert_eq!(l.size, Some(18_198_045_184));
    assert_eq!(l.n_params, Some(35_505_251_456));
    assert_eq!(l.n_ctx_train, Some(262_144));
    assert_eq!(l.ftype.as_deref(), Some("IQ4_XS - 4.25 bpw"));
}

#[test]
fn unreachable_router_has_no_invented_facts() {
    let m = parse_router(None, None, None, None);
    assert!(!m.reachable);
    assert!(m.listed.is_empty());
    assert_eq!(m.loaded_alias, None);
    assert_eq!(m.n_ctx, None);
}

#[test]
fn listed_entries_are_bounded_and_need_a_valid_alias() {
    let many: Vec<Value> = (0..200).map(|n| json!({"id": format!("m{n}")})).collect();
    let mut bad = many.clone();
    bad.push(json!({"id": "has space"}));
    let m = parse_router(Some(&health()), Some(&json!({"data": bad})), None, None);
    assert_eq!(m.listed.len(), MAX_LISTED);
    assert!(m.listed.iter().all(|l| crate::localmodel::valid_alias(&l.id)));
}

// --- resources -------------------------------------------------------------------------

#[test]
fn meminfo_is_parsed_in_bytes() {
    let text = "MemTotal:       128650992 kB\nMemFree:  7000 kB\nMemAvailable:   76299904 kB\n";
    assert_eq!(parse_meminfo(text), (Some(128_650_992 * 1024), Some(76_299_904 * 1024)));
    assert_eq!(parse_meminfo("garbage"), (None, None));
}

#[test]
fn gpu_counters_parse_or_stay_unknown() {
    assert_eq!(parse_counter("536870912\n"), Some(536_870_912));
    assert_eq!(parse_counter("x"), None);
    assert_eq!(parse_counter(""), None);
}

#[test]
fn resources_are_shown_in_plain_spanish_numbers() {
    let text = resources_text(&res());
    assert!(text.contains("RAM disponible 78,1 GB de 131,7 GB"), "{text}");
    assert!(text.contains("GPU: VRAM 0,5/0,5 GB · GTT 21,2/107,4 GB"), "{text}");
    let unknown = resources_text(&Resources { mem_total: None, mem_available: None, gpu: None });
    assert!(unknown.contains("RAM: desconocida"));
    assert!(unknown.contains("GPU: desconocida"));
}

// --- the gate ------------------------------------------------------------------------

#[test]
fn loaded_awake_idle_alias_is_ready() {
    let g = gate("Abito-gpt", &awake(), &res());
    assert_eq!(g.state, "ready");
    assert!(g.can_send());
}

#[test]
fn busy_slot_is_queue_with_a_visible_note() {
    let m = parse_router(Some(&health()), Some(&models_list()), Some(&props("Abito-gpt", false)), Some(&slots(true)));
    let g = gate("Abito-gpt", &m, &res());
    assert_eq!(g.state, "queue");
    assert!(g.can_send());
    assert!(g.message.contains("cola"));
}

#[test]
fn a_sleeping_model_needs_a_load_that_abito_never_does() {
    let m = parse_router(Some(&health()), Some(&models_list()), Some(&props("Abito-gpt", true)), Some(&slots(false)));
    let g = gate("Abito-gpt", &m, &res());
    assert_eq!(g.state, "needs_load");
    assert!(!g.can_send());
    assert!(g.message.contains("~18,2 GB"), "{}", g.message);
    assert!(g.message.contains("78,1 GB"), "{}", g.message);
    assert!(g.message.contains("no carga"), "{}", g.message);
}

#[test]
fn a_listed_but_not_loaded_alias_is_listed_not_ready() {
    let mut listing = models_list();
    listing["data"].as_array_mut().unwrap().push(json!({"id": "Otro", "meta": {"size": 4_000_000_000u64}}));
    let m = parse_router(Some(&health()), Some(&listing), Some(&props("Abito-gpt", false)), Some(&slots(false)));
    let g = gate("Otro", &m, &res());
    assert_eq!(g.state, "needs_load");
    assert!(!g.can_send());
    let gone = gate("Fantasma", &m, &res());
    assert_eq!(gone.state, "unavailable");
}

#[test]
fn unknown_sleep_state_or_unreachable_router_never_sends() {
    let m = parse_router(Some(&health()), Some(&models_list()), None, Some(&slots(false)));
    assert_eq!(gate("Abito-gpt", &m, &res()).state, "unknown");
    let down = parse_router(None, None, None, None);
    let g = gate("Abito-gpt", &down, &res());
    assert_eq!(g.state, "unavailable");
    assert!(!g.can_send());
    assert!(g.message.contains("No se usa ningún otro modelo"));
}

// --- listing + selection -----------------------------------------------------------

#[test]
fn listing_names_the_one_option_honestly() {
    let metas = vec![("http://127.0.0.1:11002".to_string(), awake())];
    let v = listing(REGISTRY, &metas, &res(), Some("local-abito-gpt"), 7);
    assert_eq!(v["revision"], 7);
    assert_eq!(v["selected"], "local-abito-gpt");
    assert!(v["choice_note"].as_str().unwrap().contains("una sola opción no es una elección"));
    let profiles = v["profiles"].as_array().unwrap();
    let abito = profiles.iter().find(|p| p["profile_id"] == "local-abito-gpt").unwrap();
    assert_eq!(abito["selectable"], true);
    assert_eq!(abito["gate"]["state"], "ready");
    assert_eq!(abito["alias"], "Abito-gpt");
    assert_eq!(abito["origin"], "http://127.0.0.1:11002");
    assert_eq!(abito["context_tokens"], 65536);
    assert_eq!(abito["max_output_tokens"], crate::chatlane::ISLAND_MAX_OUTPUT_TOKENS);
    assert_eq!(abito["vision"], false);
    assert_eq!(abito["size_bytes"], 18_198_045_184u64);
    let diag = profiles.iter().find(|p| p["origin"] == "http://127.0.0.1:11014").unwrap();
    assert_eq!(diag["selectable"], false);
    assert_eq!(diag["gate"]["state"], "unknown");
    // nothing in the listing can carry a secret
    let text = v.to_string();
    for word in ["key", "token\"", "secret", "password", "https://"] {
        assert!(!text.to_lowercase().contains(word), "{word}");
    }
}

#[test]
fn router_listed_aliases_outside_the_registry_are_shown_but_not_selectable() {
    let mut listing_json = models_list();
    listing_json["data"].as_array_mut().unwrap().push(json!({"id": "Otro"}));
    let m = parse_router(Some(&health()), Some(&listing_json), Some(&props("Abito-gpt", false)), Some(&slots(false)));
    let v = listing(REGISTRY, &[("http://127.0.0.1:11002".into(), m)], &res(), None, 1);
    let extra = v["profiles"].as_array().unwrap().iter().find(|p| p["alias"] == "Otro").unwrap();
    assert_eq!(extra["selectable"], false);
    assert!(extra["note"].as_str().unwrap().contains("no verificado"));
    assert!(v["selected"].is_null());
}

#[test]
fn selection_accepts_only_registered_selectable_profiles() {
    assert_eq!(select(REGISTRY, "local-abito-gpt").unwrap().profile_id, "local-abito-gpt");
    for bad in ["", "local-otro", "diag-11014", "diag-11017", "../x"] {
        assert_eq!(select(REGISTRY, bad).unwrap_err().code, "profile_missing", "{bad}");
    }
}

#[test]
fn profile_ids_are_bounded_tokens() {
    assert!(valid_profile_id("local-abito-gpt"));
    assert!(!valid_profile_id("Local Abito"));
    assert!(!valid_profile_id(&"a".repeat(65)));
}

// --- IPC + persistence -----------------------------------------------------------

#[test]
fn models_commands_are_closed_and_exact() {
    assert_eq!(parse_models_command(&json!({"action": "list"})).unwrap(), ModelsCommand::List);
    assert_eq!(parse_models_command(&json!({"action": "refresh"})).unwrap(), ModelsCommand::Refresh);
    assert_eq!(
        parse_models_command(&json!({"action": "select", "profile_id": "local-abito-gpt"})).unwrap(),
        ModelsCommand::Select { profile_id: "local-abito-gpt".into() }
    );
    for bad in [
        json!({"action": "select"}),
        json!({"action": "select", "profile_id": "x", "origin": "http://api.openai.com:80"}),
        json!({"action": "select", "profile_id": "Has Space"}),
        json!({"action": "add", "origin": "http://127.0.0.1:1"}),
        json!({"action": "set_key", "key": "sk-xxx"}),
        json!({"action": "list", "x": 1}),
        json!("list"),
    ] {
        assert!(parse_models_command(&bad).is_err(), "{bad}");
    }
}

#[test]
fn saved_selection_fails_closed() {
    assert_eq!(parse_saved(None), Saved::Absent);
    assert_eq!(parse_saved(Some(&saved_bytes("local-abito-gpt"))), Saved::Selected("local-abito-gpt".into()));
    assert_eq!(parse_saved(Some(b"{")), Saved::Invalid);
    assert_eq!(parse_saved(Some(br#"{"v":2,"selected":"local-abito-gpt"}"#)), Saved::Invalid);
    assert_eq!(parse_saved(Some(br#"{"v":1,"selected":"local-abito-gpt","key":"x"}"#)), Saved::Invalid);
    // absent -> the approved initial profile; unknown or invalid -> NOTHING
    assert_eq!(initial_selection(&Saved::Absent).unwrap().profile_id, "local-abito-gpt");
    assert!(initial_selection(&Saved::Selected("local-gone".into())).is_none());
    assert!(initial_selection(&Saved::Selected("diag-11014".into())).is_none());
    assert!(initial_selection(&Saved::Invalid).is_none());
}

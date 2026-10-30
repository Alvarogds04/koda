//! Unit U1 — tests for the pure preflight decision (metadata only, no
//! inference). RED → GREEN.

use super::*;
use serde_json::json;

#[test]
fn selected_default_keeps_local_request_bytes() {
    let TargetSelection::Local(selected) = default_selection() else { panic!("default must remain local") };
    let old = default_target();
    assert_eq!(selected.endpoint.origin(), old.endpoint.origin());
    assert_eq!(selected.profile, old.profile);
    assert_eq!(crate::localmodel::completion_body(&selected.alias, &[], selected.max_output).as_bytes(), br#"{"chat_template_kwargs":{"enable_thinking":false},"max_tokens":1024,"messages":[],"model":"Abito-gpt","stream":true}"#);
}


fn health() -> Value {
    json!({"status": "ok"})
}
fn props(sleeping: bool) -> Value {
    json!({"model_alias": "Abito-gpt", "total_slots": 1, "is_sleeping": sleeping})
}
fn slots(busy: bool) -> Value {
    json!([{"id": 0, "n_ctx": 65536, "is_processing": busy}])
}
fn models() -> Value {
    json!({"data": [{"id": "Abito-gpt", "meta": {"n_ctx": 65536, "size": 18198045184u64}}]})
}

#[test]
fn awake_idle_model_is_ready_with_its_real_context() {
    let r = assess("Abito-gpt", Some(&health()), Some(&props(false)), Some(&slots(false)), Some(&models()))
        .unwrap();
    assert_eq!(r.context_limit, 65536);
    assert!(!r.busy);
    assert_eq!(r.size_bytes, Some(18198045184));
}

#[test]
fn unreachable_router_is_unavailable_and_nothing_else_is_tried() {
    let e = assess("Abito-gpt", None, None, None, None).unwrap_err();
    assert_eq!(e.code, "local_model_unavailable");
}

#[test]
fn a_sleeping_model_is_never_loaded_silently() {
    let e = assess("Abito-gpt", Some(&health()), Some(&props(true)), Some(&slots(false)), Some(&models()))
        .unwrap_err();
    assert_eq!(e.code, "resource_authorization_required");
    assert!(e.safe_message.contains("dormido"));
    assert!(e.safe_message.contains("18,2 GB"));
    assert!(e.safe_message.contains("No se cargó nada"));
}

#[test]
fn a_busy_slot_is_reported_as_queue_not_hidden() {
    let r = assess("Abito-gpt", Some(&health()), Some(&props(false)), Some(&slots(true)), Some(&models()))
        .unwrap();
    assert!(r.busy);
}

#[test]
fn a_different_alias_on_the_endpoint_is_not_substituted() {
    let other = json!({"model_alias": "Otro", "is_sleeping": false});
    let e = assess("Abito-gpt", Some(&health()), Some(&other), Some(&slots(false)), Some(&models()))
        .unwrap_err();
    assert_eq!(e.code, "local_model_unavailable");
}

#[test]
fn unknown_state_or_context_refuses_instead_of_guessing() {
    let e = assess("Abito-gpt", Some(&health()), None, Some(&slots(false)), Some(&models()))
        .unwrap_err();
    assert_eq!(e.code, "resource_authorization_required");
    let e = assess("Abito-gpt", Some(&health()), Some(&props(false)), None, None).unwrap_err();
    assert_eq!(e.code, "resource_authorization_required");
}

#[test]
fn context_falls_back_to_the_model_listing_when_slots_are_hidden() {
    let r = assess("Abito-gpt", Some(&health()), Some(&props(false)), None, Some(&models())).unwrap();
    assert_eq!(r.context_limit, 65536);
}

#[test]
fn bytes_are_shown_in_spanish_gigabytes() {
    assert_eq!(gigabytes(18_198_045_184), "18,2 GB");
    assert_eq!(gigabytes(536_870_912), "0,5 GB");
}

#[test]
fn availability_maps_the_preflight_honestly() {
    let ok = Ok(Ready { context_limit: 65536, busy: false, size_bytes: None, vision: None });
    let busy = Ok(Ready { context_limit: 65536, busy: true, size_bytes: None, vision: None });
    assert_eq!(availability_of(&ok).state, "ready");
    assert_eq!(availability_of(&busy).state, "busy");
    let down = availability_of(&Err(ChatError::local_model_unavailable()));
    assert_eq!(down.state, "unavailable");
    assert!(down.message.contains("No se usó ningún otro modelo"));
    let asleep = availability_of(&Err(ChatError::resource_authorization_required("dormido")));
    assert_eq!(asleep.state, "blocked");
    assert!(availability_of(&ok).can_send());
    assert!(availability_of(&busy).can_send());
    assert!(!down.can_send());
    assert!(!asleep.can_send());
    assert!(!Availability::unchecked().can_send());
    assert_eq!(Availability::unchecked().state, "unchecked");
}

/// Human L52: «quiero que me hable español neutro». The persona speaks neutral
/// Spanish (no voseo) and names itself plainly, so the model never answers «Me llamo Sos Abito».
#[test]
fn system_prompt_asks_for_neutral_spanish_and_names_abito_plainly() {
    let p = super::SYSTEM_PROMPT;
    assert!(p.contains("español neutro"), "{p}");
    assert!(p.starts_with("Te llamas Koda"), "{p}");
    for voseo in ["rioplatense", "Sos ", "Respondé", "Corrés", "podés", "explicá"] {
        assert!(!p.contains(voseo), "voseo left in the prompt: {voseo}");
    }
}

/// Human L54: «el agente de abito no tiene en contexto todas las funciones nuevas [...] que siempre
/// se llame abito y la app se llamara abito». The prompt names only Abito (app and assistant) and
/// knows every feature the app ships, so it can explain where each one is.
#[test]
fn system_prompt_names_only_abito_and_knows_the_app_features() {
    let p = super::SYSTEM_PROMPT;
    assert!(!p.contains("Second Brain"), "{p}");
    assert!(p.contains("la app Koda"), "{p}");
    for feature in ["dictado", "OK Koda", "Spotify", "GitHub", "Vercel", "Stripe", "n8n", "Notion",
        "Cal.com", "correo", "teléfono", "personaje de escritorio", "Claude Code", "Codex", "Pi",
        "especialistas", "Ajustes", "ventana activa"] {
        assert!(p.contains(feature), "the prompt does not mention {feature}");
    }
}

// ---- S1/S4 (#503): the live-state context rides in the turn's system message --------------------

fn snap() -> crate::chatsnapshot::Snapshot {
    crate::chatsnapshot::Snapshot { text: "Estado en vivo de la app (solo lectura):\n- Pi en api: trabajando".into(), trimmed_lines: 0 }
}

#[test]
fn live_context_is_appended_after_the_system_message_and_leaves_it_intact() {
    let out = super::with_live_context("SYS", true, Some(&snap()));
    assert_eq!(out, "SYS\n\nEstado en vivo de la app (solo lectura):\n- Pi en api: trabajando");
}

#[test]
fn disabled_or_empty_live_context_adds_nothing_at_all() {
    assert_eq!(super::with_live_context("SYS", false, Some(&snap())), "SYS", "switch off: byte-identical");
    assert_eq!(super::with_live_context("SYS", true, None), "SYS", "nothing to say: byte-identical");
}

#[test]
fn the_prompt_says_it_knows_the_live_state_and_still_cannot_act() {
    let p = super::SYSTEM_PROMPT;
    assert!(p.contains("resumen del estado en vivo"), "{p}");
    assert!(p.contains("agentes de código"), "{p}");
    assert!(p.contains("integraciones conectadas"), "{p}");
    assert!(p.contains("solo de lectura"), "{p}");
    assert!(p.contains("no puedes aprobar ni ejecutar nada"), "{p}");
    assert!(p.contains("explica en qué parte de la app se hace"), "{p}");
    assert!(p.contains("Si no hay resumen, no sabes qué está pasando: dilo, no lo inventes."), "{p}");
}

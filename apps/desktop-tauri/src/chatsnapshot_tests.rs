//! S1–S3 tests: exact text for a fixed state, the size bound with visible trimming, and that
//! nothing secret (tokens, mail bodies/subjects, attendee data) ever reaches the snapshot.
use super::*;
use serde_json::json;

fn sessions() -> Value {
    json!({"rows":[
        {"id":"s-0a1b2c3d","kind":"claude-code","cwd":"abito","state":"running","origin":"tmux",
         "tools":{"total":2,"steps":[{"index":1,"name":"Read","state":"done"},{"index":2,"name":"Bash","state":"running"}]}},
        {"id":"s-1a1b2c3d","kind":"pi","cwd":"api","state":"sleeping","origin":null}
    ],"truncated":false})
}
fn question() -> Value {
    json!({"available":true,"queued_count":1,"pending":{"agent_label":"Pi","project_name":"api",
        "text":"¿Aplico la migración?","options":[{"index":0,"label":"Sí","description":"x"},{"index":1,"label":"No","description":"y"}]}})
}
fn notices() -> Vec<Value> {
    vec![json!({"kind":"settled","title":"Pi terminó su turno","projectName":"api"}),
         json!({"kind":"transport","title":"Se perdió la conexión"})]
}
fn github() -> Value {
    json!({"login":"alvaro",
      "myPRs":[{"id":"o/sb#12","repo":"o/sb","number":12,"title":"Chat con contexto","isDraft":true,"ci":"failure","review":"changesRequested","url":"https://x"}],
      "toReview":[{"id":"o/api#3","repo":"o/api","number":3,"title":"Arreglo","isDraft":false,"ci":"success","review":"pending","url":"https://x"}],
      "mainCI":[{"repo":"o/sb","branch":"main","ci":"success","url":"u"},{"repo":"o/api","branch":"main","ci":"failure","url":"u"}]})
}
fn integrations() -> Vec<Value> {
    vec![
      json!({"id":"integration_vercel","state":"ready","data":{"deployments":[{"id":"d1","projectName":"web","state":"ERROR","branch":"main","commitMessage":"secreto: arreglo","url":"https://v"}]}}),
      json!({"id":"integration_n8n","state":"stale","data":{"workflow":"Backup","status":"success"}}),
      json!({"id":"integration_stripe","state":"ready","data":{"balance":12345,"currency":"eur","payments":[{"id":"p","amount":2500,"currency":"eur","description":"Cliente Juan Pérez","status":"succeeded"}]}}),
      json!({"id":"integration_resend","state":"ready","data":{"total":40,"emails":[{"id":"e","to":["ana@x.com"],"subject":"Asunto privado","lastEvent":"delivered"}]}}),
      json!({"id":"integration_notion","state":"ready","data":{"pages":[{"id":"n","title":"Plan 0.2","url":"https://n"}]}}),
      json!({"id":"integration_calcom","state":"ready","data":{"bookings":[{"id":"1","title":"Demo","start":"2026-10-12T09:00:00Z","status":"accepted","attendeeName":"Lucía","attendeeEmail":"lucia@x.com","attendeeNotes":"nota privada"}]}}),
      json!({"id":"integration_stripe_x","state":"missing_key","data":{}}),
    ]
}
fn full() -> LiveInputs {
    LiveInputs { sessions: sessions(), question: question(), notices: notices(), github: Some(github()), integrations: integrations(), unread_mail: Some(3) }
}

#[test]
fn exact_text_for_a_fixed_state() {
    let s = build(&full()).unwrap();
    let expected = "\
Estado en vivo de la app (solo lectura):
Agentes de código:
- Claude Code en abito: trabajando (último paso: Bash)
- Pi en api: en espera
Preguntas pendientes:
- Pi (proyecto api) pregunta: «¿Aplico la migración?» Opciones: Sí / No (+1 en cola)
Terminaron hace poco (el aviso no confirma que salió bien):
- Pi terminó su turno (proyecto api)
GitHub (@alvaro):
- Mis PR: 1
  · o/sb#12 «Chat con contexto» (borrador): CI fallando, cambios pedidos
- Pendientes de mi revisión: 1
  · o/api#3 «Arreglo»
- CI de la rama principal: o/sb ok; o/api fallando
Integraciones:
- Vercel: último deploy web falló (rama main)
- n8n: Backup success (dato antiguo)
- Stripe: último pago 25,00 EUR
- Resend: 40 correos enviados, último delivered
- Notion: última página editada «Plan 0.2»
- Cal.com: próxima reunión «Demo» 2026-10-12T09:00:00Z
Correo: 3 sin leer";
    assert_eq!(s.text, expected);
    assert_eq!(s.trimmed_lines, 0);
}

#[test]
fn nothing_secret_or_private_reaches_the_text() {
    let t = build(&full()).unwrap().text;
    for banned in ["secreto", "Juan", "ana@x.com", "Asunto privado", "lucia@x.com", "Lucía", "nota privada", "12345", "https://"] {
        assert!(!t.contains(banned), "{banned} leaked: {t}");
    }
}

#[test]
fn token_like_words_are_redacted_everywhere() {
    let mut i = LiveInputs::default();
    i.question = json!({"available":true,"queued_count":0,"pending":{"agent_label":"Pi","text":"usa ghp_abcdefghijklmnopqrstuvwxyz0123456789 ya","options":[]}});
    let t = build(&i).unwrap().text;
    assert!(!t.contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
    assert!(t.contains("[oculto]"));
}

#[test]
fn nothing_connected_and_no_sessions_means_no_snapshot() {
    assert_eq!(build(&LiveInputs::default()), None);
    let i = LiveInputs { sessions: json!({"rows":[],"truncated":false}), question: json!({"available":true,"pending":null,"queued_count":0}), ..Default::default() };
    assert_eq!(build(&i), None);
}

#[test]
fn integrations_not_connected_are_absent() {
    let i = LiveInputs { integrations: vec![json!({"id":"integration_vercel","state":"missing_key","data":{}})], ..Default::default() };
    assert_eq!(build(&i), None);
}

#[test]
fn an_integration_that_failed_is_said_plainly() {
    let i = LiveInputs { integrations: vec![json!({"id":"integration_vercel","state":"error","data":{},"error":"token=abc"})], ..Default::default() };
    let t = build(&i).unwrap().text;
    assert!(t.contains("- Vercel: no se pudo consultar"));
    assert!(!t.contains("token=abc"));
}

#[test]
fn the_text_is_bounded_and_trimming_is_counted() {
    let rows: Vec<Value> = (0..60).map(|n| json!({"id":format!("s-{n:08x}"),"kind":"pi","cwd":"p".repeat(60),"state":"running","origin":null})).collect();
    let prs: Vec<Value> = (0..40).map(|n| json!({"id":"a","repo":"o/r","number":n,"title":"t".repeat(150),"isDraft":false,"ci":"pending","review":"pending"})).collect();
    let mut i = LiveInputs { sessions: json!({"rows":rows,"truncated":true,"total":200}), github: Some(json!({"login":"a","myPRs":prs.clone(),"toReview":prs,"mainCI":[]})),
        notices: (0..9).map(|n| json!({"kind":"settled","title":"Pi terminó su turno","projectName":format!("proyecto-largo-{n}-{}","z".repeat(40))})).collect(), ..Default::default() };
    i.question = question();
    let s = build(&i).unwrap();
    assert!(s.text.chars().count() <= MAX_CHARS, "{}", s.text.chars().count());
    assert!(s.text.contains("Preguntas pendientes:"), "questions have priority over everything");
    assert!(s.text.contains("… y 192 más"), "{}", s.text);
    assert!(s.trimmed_lines > 0, "len {}", s.text.chars().count());
    assert!(s.text.ends_with(&format!("(contexto recortado: {} líneas omitidas)", s.trimmed_lines)));
}

#[test]
fn a_long_question_is_clipped() {
    let i = LiveInputs { question: json!({"available":true,"queued_count":0,"pending":{"agent_label":"Pi","text":"x".repeat(900),"options":[]}}), ..Default::default() };
    let t = build(&i).unwrap().text;
    assert!(t.contains(&format!("«{}…»", "x".repeat(200))));
}

#[test]
fn foreign_shapes_never_panic() {
    let i = LiveInputs { sessions: json!("x"), question: json!(5), notices: vec![json!(null)], github: Some(json!([])), integrations: vec![json!({"id":7})], unread_mail: None };
    assert_eq!(build(&i), None);
}

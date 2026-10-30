//! Koda 0.1 T2 (human, 30-oct: «solo koda»): the app wakes ONLY to «Koda». «Abito» no longer wakes it.
//! This is the CORPUS the parent asked to measure before committing: real, common Spanish phrases that contain
//! the phonetic neighbours of «Koda» must NEVER be rewritten into the name nor wake the app, and the real
//! activation phrases must. The built-in word is a corrector (`words::correct`) and a matcher (`wake::match_wake`,
//! `voicecmd::split_wake`): all three are exercised here, because a rename that updates only one of them leaves a
//! mismatch the user would hear as «it does not wake».
use super::wake::match_wake;
use super::words::{correct, BUILT_IN};
use crate::voicecmd::split_wake;

/// Neighbours that are REAL words (or common transcriptions) and must stay as spoken.
const NEIGHBOURS: &[&str] = &[
    "toda la carpeta", "una coda", "la moda", "una boda", "una soda", "cola de impresión", "todo", "coda",
    "toda", "soda", "moda", "boda", "roda", "cola", "coca", "copa", "coma", "cosa", "toca", "toma", "joda",
    "Toda la tarde", "Una boda de verdad", "la cola está llena", "hoy toca limpiar", "sin coda ni nada",
    "mi moda favorita", "pásame la soda", "la roda del barco", "cola de caballo", "cola de pago",
];

#[test]
fn the_built_in_word_is_koda_and_only_koda() {
    assert_eq!(BUILT_IN, "Koda");
}

#[test]
fn neighbours_of_koda_are_never_rewritten_into_the_name() {
    for t in NEIGHBOURS {
        assert_eq!(correct(t, &[]), *t, "«{t}» must stay exactly as heard");
    }
}

#[test]
fn neighbours_never_wake_the_app_even_after_an_ok_word_or_as_a_vocative() {
    for n in ["toda", "coda", "soda", "moda", "boda", "roda", "cola", "coca", "todo"] {
        for t in [format!("ok {n} abre el chat"), format!("hey {n} qué hora es"), format!("oye {n} abrí el chat"), format!("{n}, abrí el chat"), format!("{n} abre el chat")] {
            for tolerance in 0..=2 {
                assert_eq!(match_wake(&t, tolerance), None, "«{t}» (tolerance {tolerance}) must not wake");
            }
            assert_eq!(split_wake(&t), None, "«{t}» must not wake through voicecmd");
        }
    }
}

#[test]
fn the_real_activation_phrases_wake_and_keep_the_command() {
    for (heard, tail) in [
        ("Koda, abrí el chat", "abrí el chat"),
        ("oye Koda", ""),
        ("oye Koda, qué hora es", "qué hora es"),
        ("ok koda abrí el chat", "abrí el chat"),
        ("okay Koda silenciá el sonido", "silenciá el sonido"),
        ("hey KODA mostrame las notas", "mostrame las notas"),
        ("koda, abrí el chat", "abrí el chat"),
    ] {
        assert_eq!(match_wake(heard, 1).as_deref(), Some(tail), "«{heard}» must wake");
    }
    for heard in ["ok koda abrí el chat", "oye Koda, qué hora es", "hey koda silenciá"] {
        assert!(split_wake(heard).is_some(), "«{heard}» must wake through voicecmd too");
    }
}

#[test]
fn coda_is_a_real_word_and_never_the_name_but_a_trained_person_can_teach_it() {
    // MEASURED trade-off (parent 30-oct): «Coda, la sección final…» is ordinary Spanish; waking on it would fire the app in the middle of dictation.
    for t in ["Coda, abrí el chat", "una coda abrí el chat", "coda", "la coda es la parte final", "ok coda abrí el chat", "Coda, una pieza breve para cerrar"] {
        for tolerance in 0..=2 {
            assert_eq!(match_wake(t, tolerance), None, "«{t}» must not wake (tolerance {tolerance})");
        }
        assert_eq!(correct(t, &[]), t, "«{t}» must stay as heard");
    }
    // ... a person whose recogniser spells the name «coda» teaches it once (Entrenamiento de voz) and then it wakes for THEM only.
    let learned = super::train::Learned { names: vec!["coda".to_string()], ..Default::default() };
    assert_eq!(super::wake::match_wake_with("ok coda abrí el chat", 1, &learned).as_deref(), Some("abrí el chat"));
    assert_eq!(match_wake("ok coda abrí el chat", 1), None, "and only for them");
}

#[test]
fn abito_no_longer_wakes_the_app() {
    for t in ["ok abito abrí el chat", "oye Abito", "hey abito qué hora es", "Abito, abrí el chat", "okabito", "ok habito", "ok avito", "Habito, ¿qué hora es?"] {
        for tolerance in 0..=2 {
            assert_eq!(match_wake(t, tolerance), None, "«{t}» (tolerance {tolerance}) must NOT wake any more");
        }
        assert_eq!(split_wake(t), None, "«{t}» must NOT wake through voicecmd any more");
    }
    // and the corrector no longer turns the old spellings into a name
    for t in ["Habito, ¿qué hora es?", "ok avito", "Yavito, ¿qué hora es?", "ok ya vito"] {
        let fixed = correct(t, &[]);
        assert!(!fixed.contains("Abito") && !fixed.contains("Koda"), "«{t}» is not any name now, got «{fixed}»");
    }
}

#[test]
fn near_spellings_the_recogniser_gives_for_koda_are_corrected_to_koda() {
    for (heard, fixed) in [("ok koda abrí el chat", "ok Koda abrí el chat"), ("oye kodá", "oye Koda"), ("ok qoda", "ok Koda"), ("Koda, hola", "Koda, hola")] {
        assert_eq!(correct(heard, &[]), fixed, "{heard}");
    }
}

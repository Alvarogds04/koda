use super::catalog::{find, DEFAULT_MODEL};
use super::*;
use std::sync::{Mutex, MutexGuard};

/// The active model and language are PROCESS-WIDE (`active_slot`), and cargo runs a binary's tests in parallel threads:
/// without this lock `a_model_in_use_cannot_be_deleted…` and `choosing_a_model_or_language…` step on each other about a
/// third of the runs (the delete-in-use test saw the other test's model and deleted a model that was no longer in use).
/// These tests therefore never run at the same time, and a poisoned lock still runs the next one.
fn serial() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[test]
fn choosing_a_model_or_language_changes_what_is_active_and_unknown_ids_are_ignored() {
    let _serial = serial();
    set_active(DEFAULT_MODEL, "es");
    assert_eq!(active(), (DEFAULT_MODEL.to_string(), "es".to_string()));
    set_active("whisper-small", "en");
    assert_eq!(active(), ("whisper-small".to_string(), "en".to_string()));
    set_active("../etc/passwd", "klingon");
    assert_eq!(active(), ("whisper-small".to_string(), "en".to_string()), "invalid choices change nothing");
    set_active(DEFAULT_MODEL, "es");
}

#[test]
fn looking_at_a_model_never_starts_a_download_and_unknown_ids_are_missing() {
    // The state reflects the disk (Ready if the user downloaded it) or Missing; never Downloading by itself.
    assert!(!matches!(model_state("whisper-small"), ModelState::Downloading { .. }));
    assert_eq!(model_state("nope"), ModelState::Missing);
}

#[test]
fn cancelling_a_download_that_is_not_running_is_harmless_and_unknown_models_cannot_be_downloaded() {
    cancel_model("whisper-turbo");
    assert!(download_model("../x", |_| {}).is_err());
    assert!(!matches!(model_state("whisper-turbo"), ModelState::Downloading { .. }));
}

#[test]
fn a_model_in_use_cannot_be_deleted_and_an_unused_one_can() {
    let _serial = serial();
    set_active("whisper-base", "es");
    assert!(delete_model("whisper-base").is_err(), "in use");
    set_active(DEFAULT_MODEL, "es");
    assert!(delete_model("whisper-base").is_ok(), "unused and absent is fine");
    assert!(delete_model("nope").is_err());
}

#[test]
fn custom_words_are_kept_clean_and_koda_is_always_built_in() {
    set_custom_words(&["  Kubernetes ".into(), "kubernetes".into(), "x".into()]);
    assert_eq!(super::words::correct("usa kubernetis", &words_for_test()), "usa Kubernetes");
    // Koda 0.1 T2
    assert_eq!(super::words::correct("Qoda, qué hora es", &words_for_test()), "Koda, qué hora es");
    set_custom_words(&[]);
}

fn words_for_test() -> Vec<String> {
    words_slot().lock().unwrap().clone()
}

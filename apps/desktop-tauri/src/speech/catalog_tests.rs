use super::catalog::*;

fn scratch(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("abito-catalog-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn every_model_is_official_pinned_https_and_lists_what_the_user_needs_to_choose() {
    assert!(entries().len() >= 4);
    assert_eq!(entries()[0].id, DEFAULT_MODEL, "Parakeet stays the default until a comparison says otherwise");
    for e in entries() {
        assert!(!e.name.is_empty() && !e.note.is_empty() && !e.license.is_empty() && e.size_mb() > 0, "{}", e.id);
        assert!(e.languages.contains(&"es"), "{} must handle Spanish", e.id);
        for f in e.set.files {
            assert_eq!(f.sha256.len(), 64, "{}", f.name);
            assert!(f.url.starts_with("https://huggingface.co/csukuangfj/sherpa-onnx-"), "{}", f.url);
            // Pinned to a commit, never to a moving branch.
            assert!(!f.url.contains("/resolve/main/"), "{}", f.url);
        }
    }
    let ids: Vec<_> = entries().iter().map(|e| e.id).collect();
    for want in ["parakeet-tdt-0.6b-v3-int8", "whisper-base", "whisper-small", "whisper-turbo"] {
        assert!(ids.contains(&want), "{want}");
    }
    let mut sorted = ids.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), ids.len(), "unique ids");
}

#[test]
fn only_whisper_can_be_forced_to_a_language_and_parakeet_says_so() {
    assert!(!find(DEFAULT_MODEL).unwrap().forces_language);
    for id in ["whisper-base", "whisper-small", "whisper-turbo"] {
        assert!(find(id).unwrap().forces_language, "{id}");
    }
}

#[test]
fn sizes_add_up_and_nothing_is_downloaded_by_looking() {
    let small = find("whisper-small").unwrap();
    assert_eq!(small.set.total_size(), 112_442_483 + 262_226_114 + 816_730);
    let root = scratch("empty");
    for e in entries() {
        assert_eq!(state_in(e, &root), Installed::No, "{}", e.id);
    }
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0, "reading the state creates nothing");
}

#[test]
fn a_model_counts_as_installed_only_with_every_file_at_its_size_and_delete_removes_it() {
    let root = scratch("present");
    let base = find("whisper-base").unwrap();
    let dir = base.set.dir_in(&root);
    std::fs::create_dir_all(&dir).unwrap();
    for f in base.set.files {
        std::fs::write(dir.join(f.name), vec![0u8; 3]).unwrap();
    }
    assert_eq!(state_in(base, &root), Installed::No, "wrong sizes are not a model");
    assert!(delete_in(base, &root).is_ok());
    assert!(!dir.exists());
    assert!(delete_in(base, &root).is_ok(), "deleting twice is fine");
}

// ── What the user chose ───────────────────────────────────────────────────────

#[test]
fn language_and_model_default_to_spanish_and_parakeet() {
    let p = SpeechPrefs::default();
    assert_eq!((p.language.as_str(), p.model.as_str()), ("es", DEFAULT_MODEL));
    assert!(p.words.is_empty());
}

#[test]
fn the_choice_is_saved_loaded_and_a_hostile_file_falls_back_to_safe_values() {
    let d = scratch("prefs");
    assert_eq!(load_prefs_in(&d), SpeechPrefs::default());
    let p = SpeechPrefs { language: "en".into(), model: "whisper-small".into(), words: vec!["Kubernetes".into()] };
    save_prefs_in(&d, &p).unwrap();
    assert_eq!(load_prefs_in(&d), p);
    assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1, "one small JSON");
    std::fs::write(d.join(PREFS_FILE), r#"{"language":"klingon","model":"../../etc/passwd","words":["ok","Kubernetes","kubernetes"]}"#).unwrap();
    let l = load_prefs_in(&d);
    assert_eq!((l.language.as_str(), l.model.as_str()), ("es", DEFAULT_MODEL));
    assert_eq!(l.words, vec!["Kubernetes".to_string()]);
    std::fs::write(d.join(PREFS_FILE), "{ nope").unwrap();
    assert_eq!(load_prefs_in(&d), SpeechPrefs::default());
}

#[test]
fn only_known_languages_are_accepted_and_auto_is_an_explicit_choice() {
    for l in ["es", "en", "fr", "de", "it", "pt", "ca", "auto"] {
        assert!(valid_language(l), "{l}");
    }
    for l in ["", "ES", "spanish", "es-ES", "xx"] {
        assert!(!valid_language(l), "{l}");
    }
}

#[test]
fn the_language_a_model_runs_with_is_forced_only_where_the_model_allows_it() {
    assert_eq!(effective_language(find("whisper-small").unwrap(), "es"), Some("es"));
    assert_eq!(effective_language(find("whisper-small").unwrap(), "auto"), None);
    assert_eq!(effective_language(find(DEFAULT_MODEL).unwrap(), "es"), None);
}

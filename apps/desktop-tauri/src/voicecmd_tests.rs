use super::*;
use serde_json::json;

fn dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("abito-voice-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

#[test]
fn voice_is_off_by_default_with_the_system_voice() {
    let p = VoicePrefs::default();
    assert!(!p.enabled);
    assert_eq!(p.output, Output::System);
    assert_eq!(p.gender, Gender::Female);
}

#[test]
fn the_closed_parser_accepts_only_the_known_shapes() {
    assert_eq!(parse_command(&json!({"action":"status"})), Some(Command::Status));
    assert_eq!(parse_command(&json!({"action":"download_model"})), Some(Command::Download));
    assert_eq!(parse_command(&json!({"action":"remove_model"})), Some(Command::Remove));
    let prefs = json!({"enabled":true,"output":"elevenlabs","gender":"male","sensitivity":70});
    assert_eq!(
        parse_command(&json!({"action":"set_prefs","prefs":prefs})),
        Some(Command::SetPrefs(VoicePrefs { enabled: true, output: Output::ElevenLabs, gender: Gender::Male, sensitivity: 70 }))
    );
}

#[test]
fn anything_else_is_rejected() {
    for bad in [
        json!({"action":"status","x":1}),
        json!({"action":"nope"}),
        json!({"action":"set_prefs"}),
        json!({"action":"set_prefs","prefs":{"enabled":true,"output":"loud","gender":"male","sensitivity":50}}),
        json!({"action":"set_prefs","prefs":{"enabled":"yes","output":"off","gender":"male","sensitivity":50}}),
        json!({"action":"set_prefs","prefs":{"enabled":true,"output":"off","gender":"male","sensitivity":50,"extra":1}}),
        json!({"action":"set_prefs","prefs":{"enabled":true,"output":"off","gender":"male"}}),
        json!([]),
        json!("status"),
    ] {
        assert_eq!(parse_command(&bad), None, "{bad}");
    }
}

#[test]
fn prefs_round_trip_and_a_corrupt_file_falls_back_to_off() {
    let d = dir("prefs");
    let p = VoicePrefs { enabled: true, output: Output::Off, gender: Gender::Male, sensitivity: 20 };
    save_prefs_in(&d, &p).unwrap();
    assert_eq!(load_prefs_in(&d), p);
    std::fs::write(d.join("voice.json"), "{not json").unwrap();
    assert_eq!(load_prefs_in(&d), VoicePrefs::default());
}

#[test]
fn the_wake_phrase_is_split_from_the_command() {
    // Koda 0.1 T2
    assert_eq!(split_wake("ok koda pon música"), Some("pon música".to_string()));
    assert_eq!(split_wake("Okay, Koda: añade una pastilla"), Some("añade una pastilla".to_string()));
    assert_eq!(split_wake("ok koda"), Some(String::new()));
    assert_eq!(split_wake("koda pon música"), None);
    assert_eq!(split_wake("ok abito pon música"), None, "Abito no longer wakes");
    assert_eq!(split_wake("hola qué tal"), None);
}

#[test]
fn sensitivity_defaults_to_the_middle_and_is_clamped() {
    assert_eq!(VoicePrefs::default().sensitivity, 50);
    let c = |v: serde_json::Value| parse_command(&json!({"action":"set_prefs","prefs":{"enabled":false,"output":"off","gender":"male","sensitivity":v}}));
    assert!(matches!(c(json!(0)), Some(Command::SetPrefs(p)) if p.sensitivity == 0));
    assert!(matches!(c(json!(100)), Some(Command::SetPrefs(p)) if p.sensitivity == 100));
    assert!(matches!(c(json!(250)), Some(Command::SetPrefs(p)) if p.sensitivity == 100), "clamped, not rejected");
    assert_eq!(c(json!(-1)), None);
    assert_eq!(c(json!(1.5)), None);
    assert_eq!(c(json!("50")), None);
}

#[test]
fn an_old_prefs_file_without_sensitivity_still_loads_with_the_default() {
    let d = dir("old");
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("voice.json"), r#"{"enabled":true,"output":"off","gender":"male"}"#).unwrap();
    let p = load_prefs_in(&d);
    assert!(p.enabled);
    assert_eq!(p.sensitivity, 50);
}

#[test]
fn the_training_commands_are_closed_and_take_no_arguments() {
    for (a, c) in [("train_record", Command::TrainRecord), ("train_undo", Command::TrainUndo), ("train_cancel", Command::TrainCancel), ("train_finish", Command::TrainFinish), ("train_reset", Command::TrainReset)] {
        assert_eq!(parse_command(&json!({ "action": a })), Some(c));
        assert_eq!(parse_command(&json!({ "action": a, "x": 1 })), None, "{a} with an extra field");
    }
    // The previous commands are untouched.
    assert_eq!(parse_command(&json!({ "action": "status" })), Some(Command::Status));
    assert_eq!(parse_command(&json!({ "action": "train" })), None);
}

#[test]
fn the_speech_commands_accept_only_catalog_models_known_languages_and_short_word_lists() {
    let ok = json!({ "action": "set_speech", "speech": { "language": "es", "model": "whisper-small", "words": ["Kubernetes"] } });
    assert_eq!(parse_command(&ok), Some(Command::SetSpeech { language: "es".into(), model: "whisper-small".into(), words: vec!["Kubernetes".into()] }));
    for bad in [
        json!({ "action": "set_speech", "speech": { "language": "xx", "model": "whisper-small", "words": [] } }),
        json!({ "action": "set_speech", "speech": { "language": "es", "model": "../x", "words": [] } }),
        json!({ "action": "set_speech", "speech": { "language": "es", "model": "whisper-small", "words": [1] } }),
        json!({ "action": "set_speech", "speech": { "language": "es", "model": "whisper-small", "words": ["x".repeat(41)] } }),
        json!({ "action": "set_speech", "speech": { "language": "es", "model": "whisper-small" } }),
        json!({ "action": "set_speech", "speech": { "language": "es", "model": "whisper-small", "words": [], "z": 1 } }),
        json!({ "action": "model_download", "id": "nope" }),
        json!({ "action": "model_download" }),
        json!({ "action": "model_delete", "id": "whisper-small", "x": 1 }),
    ] {
        assert_eq!(parse_command(&bad), None, "{bad}");
    }
    assert_eq!(parse_command(&json!({ "action": "model_download", "id": "whisper-small" })), Some(Command::ModelDownload("whisper-small".into())));
    assert_eq!(parse_command(&json!({ "action": "model_cancel", "id": "whisper-turbo" })), Some(Command::ModelCancel("whisper-turbo".into())));
    assert_eq!(parse_command(&json!({ "action": "model_delete", "id": "whisper-base" })), Some(Command::ModelDelete("whisper-base".into())));
}

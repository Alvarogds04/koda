use super::*;
use serde_json::json;
use std::path::PathBuf;

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("abito-sounds-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn the_closed_schema_accepts_exactly_four_shapes() {
    assert_eq!(parse_command(&json!({"action":"list"})), Some(Command::List));
    assert_eq!(parse_command(&json!({"action":"reveal"})), Some(Command::Reveal));
    assert_eq!(parse_command(&json!({"action":"reload"})), Some(Command::Reload));
    assert_eq!(
        parse_command(&json!({"action":"read","name":"notice"})),
        Some(Command::Read("notice"))
    );
    for bad in [
        json!({"action":"read","name":"../notice"}),
        json!({"action":"read","name":"Notice"}),
        json!({"action":"read","name":"snd.notice"}),
        json!({"action":"read","name":"unknown"}),
        json!({"action":"read"}),
        json!({"action":"list","extra":1}),
        json!({"action":"reveal","path":"/etc"}),
        json!({"action":"delete"}),
        json!("list"),
        json!(null),
    ] {
        assert_eq!(parse_command(&bad), None, "{bad}");
    }
}

#[test]
fn a_file_named_like_a_cue_is_found_in_the_first_format_listed() {
    let dir = scratch("pick");
    std::fs::write(dir.join("notice.mp3"), b"mp3").unwrap();
    std::fs::write(dir.join("notice.wav"), b"wav").unwrap();
    assert_eq!(custom_file(&dir, "notice"), Some(dir.join("notice.wav")));
    std::fs::write(dir.join("reply.m4a"), b"m4a").unwrap();
    assert_eq!(custom_file(&dir, "reply"), Some(dir.join("reply.m4a")));
    assert_eq!(custom_file(&dir, "error"), None);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unusable_entries_are_never_read() {
    let dir = scratch("guard");
    std::fs::write(dir.join("sent.wav"), b"").unwrap();
    std::fs::create_dir_all(dir.join("think.wav")).unwrap();
    std::fs::write(dir.join("listen.txt"), b"x").unwrap();
    std::fs::write(dir.join("expired.wav"), vec![0u8; MAX_BYTES as usize + 1]).unwrap();
    for stem in ["sent", "think", "listen", "expired"] {
        assert_eq!(custom_file(&dir, stem), None, "{stem}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_symlink_is_never_followed_out_of_the_folder() {
    let dir = scratch("link");
    let secret = dir.join("secret.txt");
    std::fs::write(&secret, b"top secret").unwrap();
    std::os::unix::fs::symlink(&secret, dir.join("confirm.wav")).unwrap();
    assert_eq!(custom_file(&dir, "confirm"), None);
    assert!(read(&dir, "confirm").is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn list_and_read_answer_only_stems_and_the_file_bytes() {
    let dir = scratch("apply");
    std::fs::write(dir.join("reject.ogg"), b"OggS-bytes").unwrap();
    std::fs::write(dir.join("attention.wav"), b"RIFF").unwrap();
    assert_eq!(list(&dir), vec!["attention", "reject"]);
    let answer = read(&dir, "reject").unwrap();
    assert_eq!(answer["name"], "reject");
    assert_eq!(answer["mime"], "audio/ogg");
    assert_eq!(answer["data"], "T2dnUy1ieXRlcw==");
    assert!(read(&dir, "error").is_err());
    // a missing folder is an empty list, not an error
    assert!(list(&dir.join("nope")).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn every_cue_of_the_sound_engine_has_a_stem() {
    // Compare the exported catalog, including computed cue definitions, not source spelling.
    let output = std::process::Command::new("node").args(["-e",
        "console.log(JSON.stringify(require(process.argv[1]).CUE_IDS))",
        concat!(env!("CARGO_MANIFEST_DIR"), "/frontend/sound-engine.js")]).output().unwrap();
    assert!(output.status.success());
    let mut ids: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
    ids.sort();
    let mut expected: Vec<String> = STEMS.iter().map(|s| format!("snd.{s}")).collect();
    expected.sort();
    assert_eq!(ids, expected);
    assert_eq!(STEMS.len(), 37);
    for new in ["open", "close", "peek", "hover", "pop", "tick", "love"] {
        assert!(STEMS.contains(&new), "{new} is an overridable cue (L42)");
    }
}

#[test]
fn every_reference_cue_stem_accepts_a_private_custom_override() {
    let dir = std::env::temp_dir().join(format!("abito-all-cues-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for stem in ["peek", "open", "close", "hover", "blip", "slap", "annoyed", "dizzy", "greet",
        "work", "finish", "error", "approval", "question", "approve", "gulp", "tick", "send",
        "love", "pop", "proud", "wink", "yawn", "attach", "think", "search", "rate", "sleep", "greeting"] {
        assert!(matches!(parse_command(&json!({"action":"read","name":stem})), Some(Command::Read(_))), "{stem}");
        std::fs::write(dir.join(format!("{stem}.wav")), b"own-audio").unwrap();
        assert!(list(&dir).contains(&stem), "{stem}");
        assert_eq!(read(&dir, stem).unwrap()["data"], "b3duLWF1ZGlv");
    }
}

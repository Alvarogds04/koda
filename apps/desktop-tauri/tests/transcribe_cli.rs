//! K2-13 (S8, S15, S16): the `abito-transcribe` helper binary as the daemon runs it: argv in, ONE JSON line out.
//! Every case runs against an empty private model store (XDG_DATA_HOME in a temp dir): nothing is downloaded and the
//! user's real store is never read. The real-model run is opt-in: ABITO_TRANSCRIBE_WAV=<16 kHz mono WAV> uses the
//! user's existing store (`$XDG_DATA_HOME/abito/Models`, read-only) and prints the text.
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const BIN: &str = env!("CARGO_BIN_EXE_abito-transcribe");

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("abito-transcribe-cli-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn run(data_home: &Path, args: &[&str]) -> (Output, serde_json::Value) {
    let mut cmd = Command::new(BIN);
    cmd.args(args)
        .env_clear()
        // The same private folder on every OS: HOME/XDG_DATA_HOME on Linux and macOS, LOCALAPPDATA on Windows (where
        // the data folder is `%LOCALAPPDATA%\abito-data` and HOME is never read, so without this the helper answered
        // `model_missing` on the Windows CI runner).
        .env("HOME", data_home)
        .env("XDG_DATA_HOME", data_home)
        .env("LOCALAPPDATA", data_home)
        // A dead proxy: if anything tried the network, it would fail instead of reaching it.
        .env("HTTPS_PROXY", "http://127.0.0.1:9");
    // Not the store's path, but a cleared environment without SystemRoot makes some Win32 lookups in the child fail.
    if let Some(root) = std::env::var_os("SystemRoot") {
        cmd.env("SystemRoot", root);
    }
    let out = cmd.output().expect("run abito-transcribe");
    let stdout = String::from_utf8(out.stdout.clone()).unwrap();
    assert_eq!(stdout.lines().count(), 1, "exactly one JSON line on stdout: {stdout:?}");
    let json = serde_json::from_str(stdout.trim()).expect("stdout is JSON");
    (out, json)
}

/// The data folder's name for this OS: `abito-data` on Windows (never `abito`: that is the island's protected root
/// there), `abito` everywhere else.
fn data_leaf() -> &'static str {
    if cfg!(windows) {
        "abito-data"
    } else {
        "abito"
    }
}

fn silent_wav(path: &Path, seconds: usize) {
    let data = vec![0u8; seconds * 16_000 * 2];
    let mut b = Vec::new();
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&((36 + data.len()) as u32).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&16_000u32.to_le_bytes());
    b.extend_from_slice(&32_000u32.to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(data.len() as u32).to_le_bytes());
    b.extend_from_slice(&data);
    std::fs::write(path, b).unwrap();
}

#[test]
fn without_a_data_folder_the_helper_answers_model_missing_and_never_uses_a_relative_path() {
    // The daemon gives this binary its temporary work folder as cwd (transcribe.cjs). Koda must never resolve the
    // store relative to it: a fake store sitting under `<cwd>/.local/share` has to stay invisible when the
    // environment names no absolute folder (on Windows a GUI app has no HOME, which is the bug this covers).
    let d = scratch("nodata");
    let vad = d.join(".local/share/abito/Models/silero-vad");
    std::fs::create_dir_all(&vad).unwrap();
    let file = std::fs::File::create(vad.join("silero_vad.onnx")).unwrap();
    file.set_len(643_854).unwrap(); // the detector's pinned size: a relative fallback would report it present
    drop(file);
    let out = Command::new(BIN)
        .args(["status"])
        .env_clear() // no HOME, no XDG_DATA_HOME, no LOCALAPPDATA
        .current_dir(&d)
        .output()
        .expect("run abito-transcribe");
    let stdout = String::from_utf8(out.stdout.clone()).unwrap();
    assert_eq!(stdout.lines().count(), 1, "one JSON line: {stdout:?}");
    let json: serde_json::Value = serde_json::from_str(stdout.trim()).expect("stdout is JSON");
    assert_eq!((out.status.code(), json["error"].as_str()), (Some(1), Some("model_missing")), "{stdout}");
    assert_eq!(json["vad"], serde_json::Value::Null, "the store under the working directory is never read");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_model_that_is_not_downloaded_is_model_missing_and_nothing_is_fetched() {
    let d = scratch("missing");
    let wav = d.join("a.wav");
    silent_wav(&wav, 1);
    let (out, json) = run(&d, &["transcribe", wav.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(json["error"], "model_missing");
    let (_, json) = run(&d, &["transcribe", "--model", "whisper-turbo", "--language", "es", wav.to_str().unwrap()]);
    assert_eq!(json["error"], "model_missing");
    assert!(!d.join(data_leaf()).join("Models").exists(), "transcribe never creates or fills the model store");
    let (out, json) = run(&d, &["status"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(json["model"], "parakeet-tdt-0.6b-v3-int8");
    assert_eq!(json["present"], false);
    assert_eq!(json["vad"], false);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn bad_input_is_refused_before_any_model_is_looked_at() {
    let d = scratch("input");
    let (out, json) = run(&d, &["transcribe", d.join("nope.wav").to_str().unwrap()]);
    assert_eq!((out.status.code(), json["error"].as_str()), (Some(1), Some("bad_input")));
    let (_, json) = run(&d, &["transcribe", d.to_str().unwrap()]);
    assert_eq!(json["error"], "bad_input", "a directory is not an input");
    #[cfg(unix)]
    {
        let wav = d.join("a.wav");
        silent_wav(&wav, 1);
        let link = d.join("link.wav");
        std::os::unix::fs::symlink(&wav, &link).unwrap();
        let (_, json) = run(&d, &["transcribe", link.to_str().unwrap()]);
        assert_eq!(json["error"], "bad_input", "a symlink is never followed");
    }
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn usage_errors_exit_2_with_a_json_line_and_never_echo_the_input() {
    let d = scratch("usage");
    // An ABSOLUTE input on every OS (a literal like `/abs/…` is relative on Windows, where the helper would answer
    // `usage` for the wrong reason and never reach the language check this case is about).
    let absolute = d.join("secret-name.wav");
    let absolute = absolute.to_str().unwrap();
    let cases: [&[&str]; 4] = [
        &["transcribe"],
        &["transcribe", "rel/secret-name.wav"],
        &["transcribe", "--model", "whisper-turbo", absolute],
        &["frobnicate"],
    ];
    for args in cases {
        let (out, json) = run(&d, args);
        let code = json["error"].as_str().unwrap().to_string();
        assert!(["usage", "language_required"].contains(&code.as_str()), "{args:?} -> {code}");
        assert!(!String::from_utf8_lossy(&out.stdout).contains("secret-name"));
        assert!(!String::from_utf8_lossy(&out.stderr).contains("secret-name"));
    }
    let (out, json) = run(&d, &["transcribe", "--model", "whisper-small", absolute]);
    assert_eq!((out.status.code(), json["error"].as_str()), (Some(1), Some("unknown_model")));
    let _ = std::fs::remove_dir_all(&d);
}

/// Opt-in real run (models already in the user's store; nothing is downloaded): ABITO_TRANSCRIBE_WAV=<wav>
/// [ABITO_TRANSCRIBE_MODEL=whisper-turbo ABITO_TRANSCRIBE_LANGUAGE=es] cargo test --test transcribe_cli -- --nocapture
#[test]
fn real_model_run_when_asked() {
    let Ok(wav) = std::env::var("ABITO_TRANSCRIBE_WAV") else {
        eprintln!("skipped: set ABITO_TRANSCRIBE_WAV to run the real model");
        return;
    };
    let model = std::env::var("ABITO_TRANSCRIBE_MODEL").unwrap_or_else(|_| "parakeet-tdt-0.6b-v3-int8".into());
    let language = std::env::var("ABITO_TRANSCRIBE_LANGUAGE").unwrap_or_else(|_| "es".into());
    let mut cmd = Command::new(BIN);
    cmd.args(["transcribe", "--model", &model, "--language", &language, &wav]);
    let out = cmd.output().expect("run");
    let stdout = String::from_utf8(out.stdout).unwrap();
    eprintln!("{stdout}");
    let json: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(out.status.code(), Some(0), "{json}");
    assert!(json["text"].as_str().unwrap().len() > 3);
    for s in json["segments"].as_array().unwrap() {
        assert!(s["end"].as_f64().unwrap() - s["start"].as_f64().unwrap() <= 25.0 + 1e-6);
    }
}

// abito-island build script.
//
// Two jobs:
//  1. tauri-build: validates tauri.conf.json, capabilities and the static frontendDist (no cargo-tauri CLI here).
//  2. K2-13 (S8, S15; decisions L22/L23): keep espeak-ng out of the shipped binaries.
//
// sherpa-onnx-sys 1.13.8 links prebuilt static libraries that carry the TTS path: piper_phonemize, espeak-ng
// (GPL-3.0) and its ucd tables. Koda only ever *recognises* speech (Parakeet, Whisper, Silero VAD, the dictation
// wake word) and never synthesises it, yet those archives were linked into abito-island and abito-transcribe.
// Upstream publishes the same v1.13.8 libraries built with -DSHERPA_ONNX_ENABLE_TTS=OFF for each shipped target, so
// this script stages those in `target/sherpa-onnx-no-tts/lib` and `.cargo/config.toml` points the island crate's
// rustc-link-lib list at them (static:-bundle=..., without espeak-ng, piper_phonemize or ucd). Two details make that
// work without touching CI:
//
//   * `-bundle` keeps the archives out of sherpa-onnx-sys's rlib, so the final link resolves them from the staged
//     directory instead of from whatever archive the crate downloaded for itself;
//   * the staged directory is ours, filled here from the pinned, sha256-verified upstream archive, so nothing is
//     written into the crate's own cache and a missing download fails the link loudly instead of silently linking
//     the TTS build.
//
// The pinned name + sha256 of each archive lives in packaging/sherpa-onnx-no-tts.sha256. darwin is deliberately
// untouched: its libraries and the Mac session are pending (L12), and the script says so instead of pretending.
// test-node/sherpa-tts-free-check.cjs fails the checks if espeak symbols reach a binary anyway.

use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

fn main() {
    stage_tts_free_sherpa();
    tauri_build::build()
}

const SHERPA_VERSION: &str = "1.13.8";
const RELEASE_BASE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const PIN_FILE: &str = "packaging/sherpa-onnx-no-tts.sha256";
/// Where the TTS-free archives are staged. `.cargo/config.toml` names the same path in `rustc-link-search`; both
/// are relative to this crate, which is the workspace root, so the linker resolves them from the same directory.
const STAGE_DIR: &str = "target/sherpa-onnx-no-tts/lib";

fn stage_tts_free_sherpa() {
    println!("cargo:rerun-if-changed={PIN_FILE}");
    // docs.rs sets DOCS_RS=1: no native libraries are linked there (sherpa-onnx-sys skips them too).
    if env::var_os("DOCS_RS").is_some() {
        return;
    }
    let Some(target) = target() else {
        println!(
            "cargo:warning=K2-13: this target has no TTS-free sherpa-onnx libraries staged (the macOS libraries and \
             the Mac session are pending), so espeak-ng is still linked here. linux-x64 and win-x64 ship without it."
        );
        return;
    };
    let Ok(crate_dir) = env::var("CARGO_MANIFEST_DIR") else {
        panic!("K2-13: CARGO_MANIFEST_DIR is unset, so the TTS-free sherpa-onnx libraries cannot be staged")
    };
    let crate_dir = PathBuf::from(crate_dir);
    match stage(&crate_dir, &target) {
        Ok(Outcome::AlreadyStaged) => {}
        Ok(Outcome::Staged) => println!(
            "cargo:warning=K2-13: staged the TTS-free sherpa-onnx libraries from {} in {}: the island and the \
             transcription helper link no espeak-ng, piper_phonemize or ucd code",
            target.archive,
            STAGE_DIR
        ),
        Err(error) => panic!("K2-13: cannot stage the TTS-free sherpa-onnx libraries: {error}"),
    }
}

/// One shipped target: the TTS-free archive to stage, and the library file suffix its linker expects.
struct Target {
    /// Archive name in the upstream release, as pinned in packaging/sherpa-onnx-no-tts.sha256.
    archive: String,
    suffix: &'static str,
}

fn target() -> Option<Target> {
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let (platform, suffix) = match (os.as_str(), arch.as_str()) {
        ("linux", "x86_64") => ("linux-x64-static", "a"),
        ("windows", "x86_64") => ("win-x64-static-MT-Release", "lib"),
        // darwin-arm64 comes with the Mac session (L12): the libraries exist upstream, the build is not verified here.
        _ => return None,
    };
    Some(Target {
        archive: format!("sherpa-onnx-v{SHERPA_VERSION}-{platform}-no-tts-lib.tar.bz2"),
        suffix,
    })
}

enum Outcome {
    AlreadyStaged,
    Staged,
}

fn stage(crate_dir: &Path, target: &Target) -> Result<Outcome, String> {
    let stage_dir = crate_dir.join(STAGE_DIR);
    let stamp = stage_dir.join(".staged");
    let pinned = pinned_sha256(&crate_dir.join(PIN_FILE), &target.archive)?;
    if fs::read_to_string(&stamp).is_ok_and(|text| text.trim() == format!("{} {pinned}", target.archive)) {
        return Ok(Outcome::AlreadyStaged);
    }

    let cache_dir = crate_dir.join("target/sherpa-onnx-no-tts/archives");
    fs::create_dir_all(&cache_dir).map_err(|e| format!("cannot create {}: {e}", cache_dir.display()))?;
    let archive_path = cache_dir.join(&target.archive);
    if !archive_path.is_file() {
        download(&format!("{RELEASE_BASE_URL}/v{SHERPA_VERSION}/{}", target.archive), &archive_path)?;
    }
    let digest = sha256_file(&archive_path)?;
    if digest != pinned {
        return Err(format!(
            "{} has sha256 {digest}, the pin in {PIN_FILE} says {pinned}; refusing to link an unverified archive",
            archive_path.display()
        ));
    }

    fs::create_dir_all(&stage_dir).map_err(|e| format!("cannot create {}: {e}", stage_dir.display()))?;
    let unpacked = unpack_native_libraries(&archive_path, &stage_dir, target)?;
    fs::write(&stamp, format!("{} {pinned}\n", target.archive))
        .map_err(|e| format!("cannot write {}: {e}", stamp.display()))?;
    eprintln!("K2-13: {unpacked} TTS-free sherpa-onnx libraries staged in {}", stage_dir.display());
    Ok(Outcome::Staged)
}

fn pinned_sha256(pin_file: &Path, archive: &str) -> Result<String, String> {
    let text = fs::read_to_string(pin_file).map_err(|e| format!("cannot read {}: {e}", pin_file.display()))?;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split_whitespace();
        if let (Some(digest), Some(name)) = (fields.next(), fields.next()) {
            if name == archive {
                return Ok(digest.to_ascii_lowercase());
            }
        }
    }
    Err(format!("{} has no pin for {archive}", pin_file.display()))
}

fn download(url: &str, destination: &Path) -> Result<(), String> {
    eprintln!("K2-13: downloading TTS-free sherpa-onnx libraries from {url}");
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout(Duration::from_secs(900))
        .try_proxy_from_env(true)
        .build();
    let response = agent.get(url).call().map_err(|e| format!("download from {url} failed: {e}"))?;
    let partial = destination.with_extension("part");
    let mut reader = response.into_reader();
    let mut file = fs::File::create(&partial).map_err(|e| format!("cannot write {}: {e}", partial.display()))?;
    io::copy(&mut reader, &mut file).map_err(|e| format!("cannot write {}: {e}", partial.display()))?;
    file.sync_all().map_err(|e| format!("cannot flush {}: {e}", partial.display()))?;
    fs::rename(&partial, destination).map_err(|e| format!("cannot rename {}: {e}", partial.display()))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Unpack the `lib/` members of the archive into `stage_dir`. Only plain file names are written, so no entry can
/// escape the directory, and nothing but a native library is accepted.
fn unpack_native_libraries(archive: &Path, stage_dir: &Path, target: &Target) -> Result<usize, String> {
    let file = fs::File::open(archive).map_err(|e| format!("cannot open {}: {e}", archive.display()))?;
    let decoder = bzip2::read::BzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    let entries = tar.entries().map_err(|e| format!("cannot read {}: {e}", archive.display()))?;
    let mut staged = 0;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("cannot read {}: {e}", archive.display()))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path().map_err(|e| format!("bad entry in {}: {e}", archive.display()))?.into_owned();
        let Some(name) = library_file_name(&path, target) else { continue };
        let destination = stage_dir.join(&name);
        let partial = stage_dir.join(format!(".{name}.part"));
        {
            let mut out = fs::File::create(&partial)
                .map_err(|e| format!("cannot write {}: {e}", partial.display()))?;
            io::copy(&mut entry, &mut out).map_err(|e| format!("cannot write {}: {e}", partial.display()))?;
            out.sync_all().map_err(|e| format!("cannot flush {}: {e}", partial.display()))?;
        }
        fs::rename(&partial, &destination)
            .map_err(|e| format!("cannot rename {}: {e}", destination.display()))?;
        staged += 1;
    }
    if staged == 0 {
        return Err(format!("{} contained no native library", archive.display()));
    }
    Ok(staged)
}

fn library_file_name(path: &Path, target: &Target) -> Option<String> {
    if path.parent()?.file_name()?.to_str()? != "lib" {
        return None;
    }
    if path.components().any(|component| matches!(component, Component::ParentDir)) {
        return None;
    }
    let name = path.file_name()?.to_str()?;
    if !name.ends_with(&format!(".{}", target.suffix)) || name.starts_with('.') {
        return None;
    }
    Some(name.to_string())
}

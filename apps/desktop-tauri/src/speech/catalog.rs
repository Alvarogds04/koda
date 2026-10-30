//! The speech-model picker (Handy-style): which models exist, what each costs and allows, which one
//! the user chose, and the language it listens in. Nothing here downloads by itself: a download is
//! always an explicit click (see `download`), checked against a pinned SHA-256.
//!
//! Model list and the "pick, download, delete" flow follow Handy's model selector
//! (https://github.com/cjpais/handy, MIT, Copyright (c) 2025 CJ Pais). Files come from the
//! official sherpa-onnx exports of k2-fsa's maintainer on Hugging Face, pinned to a commit.
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::words::clean_words;
use super::{ModelFile, ModelSet, PARAKEET};

pub const DEFAULT_MODEL: &str = "parakeet-tdt-0.6b-v3-int8";
pub const PREFS_FILE: &str = "speech.json";
pub const LANGUAGES: &[&str] = &["es", "en", "fr", "de", "it", "pt", "ca", "auto"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Parakeet,
    Whisper,
}

pub struct Entry {
    pub id: &'static str,
    pub name: &'static str,
    pub engine: Engine,
    pub set: &'static ModelSet,
    /// Languages it understands (codes from `LANGUAGES`, minus «auto»).
    pub languages: &'static [&'static str],
    /// Whether the language can be fixed instead of guessed (Parakeet v3 cannot).
    pub forces_language: bool,
    pub license: &'static str,
    /// Speed / accuracy, in the user's words.
    pub note: &'static str,
}

impl Entry {
    pub fn size_mb(&self) -> u64 {
        self.set.total_size() / 1_000_000
    }
}

static WHISPER_BASE: ModelSet = ModelSet {
    id: "whisper-base-int8",
    files: &[
        ModelFile { name: "base-encoder.int8.onnx", url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc/base-encoder.int8.onnx", size: 29120534, sha256: "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11" },
        ModelFile { name: "base-decoder.int8.onnx", url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc/base-decoder.int8.onnx", size: 130672026, sha256: "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d" },
        ModelFile { name: "base-tokens.txt", url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc/base-tokens.txt", size: 816730, sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126" },
    ],
};
static WHISPER_SMALL: ModelSet = ModelSet {
    id: "whisper-small-int8",
    files: &[
        ModelFile { name: "small-encoder.int8.onnx", url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/8f3c18b358db4d1f2fc1eae49d75cd20989e4309/small-encoder.int8.onnx", size: 112442483, sha256: "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9" },
        ModelFile { name: "small-decoder.int8.onnx", url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/8f3c18b358db4d1f2fc1eae49d75cd20989e4309/small-decoder.int8.onnx", size: 262226114, sha256: "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee" },
        ModelFile { name: "small-tokens.txt", url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/8f3c18b358db4d1f2fc1eae49d75cd20989e4309/small-tokens.txt", size: 816730, sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126" },
    ],
};
static WHISPER_TURBO: ModelSet = ModelSet {
    id: "whisper-turbo-int8",
    files: &[
        ModelFile { name: "turbo-encoder.int8.onnx", url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-turbo/resolve/2ca6ff69fc878651b770880507669577ac41c2ff/turbo-encoder.int8.onnx", size: 674716297, sha256: "b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b" },
        ModelFile { name: "turbo-decoder.int8.onnx", url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-turbo/resolve/2ca6ff69fc878651b770880507669577ac41c2ff/turbo-decoder.int8.onnx", size: 361080764, sha256: "20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547" },
        ModelFile { name: "turbo-tokens.txt", url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-turbo/resolve/2ca6ff69fc878651b770880507669577ac41c2ff/turbo-tokens.txt", size: 816730, sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126" },
    ],
};

const WHISPER_LANGS: &[&str] = &["es", "en", "fr", "de", "it", "pt", "ca"];

static ENTRIES: [Entry; 4] = [
    Entry { id: DEFAULT_MODEL, name: "Parakeet v3", engine: Engine::Parakeet, set: &PARAKEET, languages: &["es", "en", "fr", "de", "it", "pt"], forces_language: false, license: "CC-BY-4.0 (NVIDIA)", note: "Rápido y preciso en inglés; elige el idioma solo, a veces se equivoca con acento español." },
    Entry { id: "whisper-base", name: "Whisper base", engine: Engine::Whisper, set: &WHISPER_BASE, languages: WHISPER_LANGS, forces_language: true, license: "MIT (OpenAI)", note: "Muy liviano y veloz; menos preciso. Idioma fijo." },
    Entry { id: "whisper-small", name: "Whisper small", engine: Engine::Whisper, set: &WHISPER_SMALL, languages: WHISPER_LANGS, forces_language: true, license: "MIT (OpenAI)", note: "Buen equilibrio para español. Idioma fijo." },
    Entry { id: "whisper-turbo", name: "Whisper turbo", engine: Engine::Whisper, set: &WHISPER_TURBO, languages: WHISPER_LANGS, forces_language: true, license: "MIT (OpenAI)", note: "El más preciso; pesado y más lento. Idioma fijo." },
];

pub fn entries() -> &'static [Entry] {
    &ENTRIES
}

pub fn find(id: &str) -> Option<&'static Entry> {
    ENTRIES.iter().find(|e| e.id == id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Installed {
    Yes,
    No,
}

/// Reads the disk only; never creates anything.
pub fn state_in(entry: &Entry, root: &Path) -> Installed {
    let dir = entry.set.dir_in(root);
    if entry.set.files.iter().all(|f| std::fs::metadata(dir.join(f.name)).map(|m| m.len() == f.size).unwrap_or(false)) {
        Installed::Yes
    } else {
        Installed::No
    }
}

pub fn delete_in(entry: &Entry, root: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(entry.set.dir_in(root)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

pub fn valid_language(l: &str) -> bool {
    LANGUAGES.contains(&l)
}

/// The language code handed to the model: only when the model can be told, and not for «auto».
pub fn effective_language(entry: &Entry, language: &str) -> Option<&'static str> {
    if !entry.forces_language {
        return None;
    }
    LANGUAGES.iter().copied().find(|l| *l == language && *l != "auto")
}

// ── What the user chose ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SpeechPrefs {
    pub language: String,
    pub model: String,
    pub words: Vec<String>,
}

impl Default for SpeechPrefs {
    fn default() -> Self {
        Self { language: "es".into(), model: DEFAULT_MODEL.into(), words: vec![] }
    }
}

impl SpeechPrefs {
    pub fn sanitised(mut self) -> Self {
        if !valid_language(&self.language) {
            self.language = "es".into();
        }
        if find(&self.model).is_none() {
            self.model = DEFAULT_MODEL.into();
        }
        self.words = clean_words(&self.words);
        self
    }
}

pub fn load_prefs_in(dir: &Path) -> SpeechPrefs {
    std::fs::read_to_string(dir.join(PREFS_FILE)).ok().and_then(|t| serde_json::from_str::<SpeechPrefs>(&t).ok()).map(SpeechPrefs::sanitised).unwrap_or_default()
}

pub fn save_prefs_in(dir: &Path, prefs: &SpeechPrefs) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(prefs).map_err(std::io::Error::other)?;
    let tmp = dir.join(format!("{PREFS_FILE}.tmp"));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, dir.join(PREFS_FILE))
}

//! Local speech to text for dictation: NVIDIA's Parakeet (25 languages)
//! through sherpa-onnx.
//!
//! Adapted from Coucou src-tauri/src/speech/mod.rs @434d6a2b,
//! Copyright (c) 2026 Louis Raillé, MIT. Dictation only: the call notetaker's
//! diarization models and word timings are not ported.
//!
//! Nothing is downloaded until the user asks for it (`download` is only ever
//! called from an explicit user action). The files come over HTTPS from
//! Hugging Face at a pinned revision, are checked against their size and
//! SHA-256 before they are used, and live in `$XDG_DATA_HOME/abito/Models`
//! (default `~/.local/share/abito/Models`). From then on everything runs offline.

pub mod audio;
pub mod catalog;
pub mod train;
pub mod words;
pub mod wake;
#[cfg(test)]
mod catalog_tests;
#[cfg(test)]
mod models_tests;
#[cfg(test)]
mod train_tests;
#[cfg(test)]
mod words_tests;
#[cfg(test)]
mod wake_tests;
#[cfg(test)]
mod koda_word_tests;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig, OfflineWhisperModelConfig};

/// Every model works on 16 kHz mono.
pub const SAMPLE_RATE: u32 = 16_000;

pub struct ModelFile {
    pub name: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// A set of files downloaded together.
pub struct ModelSet {
    pub id: &'static str,
    pub files: &'static [ModelFile],
}

impl ModelSet {
    pub fn dir(&self) -> PathBuf {
        self.dir_in(&models_dir())
    }

    pub fn dir_in(&self, root: &Path) -> PathBuf {
        root.join(self.id)
    }

    pub fn path(&self, name: &str) -> String {
        self.dir().join(name).to_string_lossy().to_string()
    }

    pub fn total_size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }

    /// Every file is there with its size (the hash was checked when it came in).
    pub fn is_present(&self) -> bool {
        self.files.iter().all(|f| std::fs::metadata(self.dir().join(f.name)).map(|m| m.len() == f.size).unwrap_or(false))
    }
}

/// Parakeet TDT 0.6B v3, int8: the dictation and the calls' words (about 670 MB).
pub static PARAKEET: ModelSet = ModelSet {
    id: "parakeet-tdt-0.6b-v3-int8",
    files: &[
        ModelFile {
            name: "encoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/encoder.int8.onnx",
            size: 652_184_281,
            sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
        },
        ModelFile {
            name: "decoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/decoder.int8.onnx",
            size: 11_845_275,
            sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
        },
        ModelFile {
            name: "joiner.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/joiner.int8.onnx",
            size: 6_355_277,
            sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/tokens.txt",
            size: 93_939,
            sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
        },
    ],
};

/// Abito's data folder: `$XDG_DATA_HOME/abito` (default `~/.local/share/abito`).
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from(".local/share"));
    base.join("abito")
}

pub fn models_dir() -> PathBuf {
    data_dir().join("Models")
}

// ── Verified download ─────────────────────────────────────────────────────────

/// Checks a file as its bytes arrive: never more than the expected size, and
/// the SHA-256 must match when it ends. A file that fails is never used.
pub struct Verifier {
    expected_size: u64,
    expected_sha256: &'static str,
    hash: Sha256,
    got: u64,
}

impl Verifier {
    pub fn new(file: &ModelFile) -> Self {
        Self { expected_size: file.size, expected_sha256: file.sha256, hash: Sha256::new(), got: 0 }
    }

    /// Feeds a chunk; false when the file is already bigger than expected.
    pub fn update(&mut self, chunk: &[u8]) -> bool {
        self.got += chunk.len() as u64;
        if self.got > self.expected_size {
            return false;
        }
        self.hash.update(chunk);
        true
    }

    pub fn bytes(&self) -> u64 {
        self.got
    }

    pub fn finish(self) -> bool {
        if self.got != self.expected_size {
            return false;
        }
        let hex: String = self.hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        hex == self.expected_sha256
    }
}

// ── Download state ────────────────────────────────────────────────────────────

/// What the Settings page shows about the model.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum ModelState {
    Missing,
    Downloading { fraction: f64 },
    Ready,
    Failed { error: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsStatus {
    pub parakeet: ModelState,
    /// Size of the download in MB.
    pub download_mb: u64,
}

struct Downloads {
    running: bool,
    fraction: f64,
    error: Option<String>,
}

fn downloads() -> &'static Mutex<Downloads> {
    static D: OnceLock<Mutex<Downloads>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(Downloads { running: false, fraction: 0.0, error: None }))
}

pub fn status() -> ModelsStatus {
    let d = downloads().lock().unwrap();
    let parakeet = if d.running {
        ModelState::Downloading { fraction: d.fraction }
    } else if PARAKEET.is_present() {
        ModelState::Ready
    } else if let Some(error) = &d.error {
        ModelState::Failed { error: error.clone() }
    } else {
        ModelState::Missing
    };
    ModelsStatus { parakeet, download_mb: PARAKEET.total_size() / 1_000_000 }
}

/// The model and language the user chose (Ajustes → Voz); Parakeet and Spanish until they pick.
fn active_slot() -> &'static Mutex<(String, String)> {
    static A: OnceLock<Mutex<(String, String)>> = OnceLock::new();
    A.get_or_init(|| Mutex::new((catalog::DEFAULT_MODEL.to_string(), "es".to_string())))
}

pub fn active() -> (String, String) {
    active_slot().lock().unwrap().clone()
}

fn active_set() -> &'static ModelSet {
    catalog::find(&active().0).map(|e| e.set).unwrap_or(&PARAKEET)
}

/// Switches the model / language; the loaded recognizer is dropped so the next use loads the new one.
/// An unknown model or language changes nothing.
pub fn set_active(model: &str, language: &str) {
    if catalog::find(model).is_none() || !catalog::valid_language(language) {
        return;
    }
    let next = (model.to_string(), language.to_string());
    let mut a = active_slot().lock().unwrap();
    if *a != next {
        *a = next;
        drop(a);
        unload();
    }
}

pub fn is_ready() -> bool {
    active_set().is_present()
}

// ── The picker's own downloads (any catalog model; explicit click, cancellable) ──

struct ModelDl {
    running: bool,
    fraction: f64,
    error: Option<String>,
    cancel: bool,
}

fn model_dls() -> &'static Mutex<std::collections::HashMap<&'static str, ModelDl>> {
    static M: OnceLock<Mutex<std::collections::HashMap<&'static str, ModelDl>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

pub fn model_state(id: &str) -> ModelState {
    let Some(entry) = catalog::find(id) else { return ModelState::Missing };
    if let Some(d) = model_dls().lock().unwrap().get(entry.id) {
        if d.running {
            return ModelState::Downloading { fraction: d.fraction };
        }
    }
    if entry.set.is_present() {
        return ModelState::Ready;
    }
    match model_dls().lock().unwrap().get(entry.id).and_then(|d| d.error.clone()) {
        Some(error) => ModelState::Failed { error },
        None => ModelState::Missing,
    }
}

/// Starts the download of one catalog model on a background thread. ONLY from an explicit user action.
pub fn download_model(id: &str, on_change: impl Fn(ModelState) + Send + 'static) -> Result<(), String> {
    let entry = catalog::find(id).ok_or("unknown model")?;
    {
        let mut m = model_dls().lock().unwrap();
        let d = m.entry(entry.id).or_insert(ModelDl { running: false, fraction: 0.0, error: None, cancel: false });
        if d.running {
            return Ok(());
        }
        *d = ModelDl { running: true, fraction: 0.0, error: None, cancel: false };
    }
    let id = entry.id;
    on_change(model_state(id));
    std::thread::Builder::new()
        .name("abito-model-pick-download".into())
        .spawn(move || {
            let result = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())
                .and_then(|rt| rt.block_on(fetch_set(entry.set, &|f| {
                    if let Some(d) = model_dls().lock().unwrap().get_mut(id) {
                        d.fraction = f;
                    }
                    on_change(model_state(id));
                }, &|| model_dls().lock().unwrap().get(id).is_some_and(|d| d.cancel))));
            if let Some(d) = model_dls().lock().unwrap().get_mut(id) {
                d.running = false;
                d.error = result.err();
            }
            on_change(model_state(id));
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Stops a running download; the partial file is discarded.
pub fn cancel_model(id: &str) {
    if let Some(d) = model_dls().lock().unwrap().get_mut(id) {
        if d.running {
            d.cancel = true;
        }
    }
}

/// Deletes a downloaded model. The one in use cannot be deleted.
pub fn delete_model(id: &str) -> Result<(), String> {
    let entry = catalog::find(id).ok_or("unknown model")?;
    if active().0 == entry.id {
        return Err("that model is in use".into());
    }
    if model_state(id) != ModelState::Missing && matches!(model_state(id), ModelState::Downloading { .. }) {
        return Err("it is downloading".into());
    }
    catalog::delete_in(entry, &models_dir()).map_err(|e| e.to_string())?;
    if let Some(d) = model_dls().lock().unwrap().get_mut(entry.id) {
        d.error = None;
    }
    Ok(())
}

async fn fetch_set(set: &ModelSet, progress: &dyn Fn(f64), cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    use futures_util::StreamExt;
    let total = set.total_size();
    let mut done: u64 = 0;
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .user_agent(concat!("Abito/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let dir = set.dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut last = Instant::now();
    for file in set.files {
        let path = dir.join(file.name);
        if std::fs::metadata(&path).map(|m| m.len() == file.size).unwrap_or(false) {
            done += file.size;
            continue;
        }
        let part = dir.join(format!("{}.part", file.name));
        let response = client.get(file.url).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("{}: HTTP {}", file.name, response.status().as_u16()));
        }
        let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut verifier = Verifier::new(file);
        let mut stream = response.bytes_stream();
        let mut ok = true;
        while let Some(chunk) = stream.next().await {
            if cancelled() {
                drop(out);
                let _ = std::fs::remove_file(&part);
                return Err("cancelled".into());
            }
            let chunk = chunk.map_err(|e| e.to_string())?;
            if !verifier.update(&chunk) {
                ok = false;
                break;
            }
            out.write_all(&chunk).map_err(|e| e.to_string())?;
            if last.elapsed() > Duration::from_millis(250) {
                last = Instant::now();
                progress((done + verifier.bytes()) as f64 / total as f64);
            }
        }
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        if !ok || !verifier.finish() {
            let _ = std::fs::remove_file(&part);
            return Err(format!("{}: the file that came in is not the expected one", file.name));
        }
        std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
        done += file.size;
    }
    Ok(())
}

/// Downloads what is missing on a background thread and calls `on_change`
/// with the new status as it moves. Call it ONLY from an explicit user action.
pub fn download(on_change: impl Fn(ModelsStatus) + Send + 'static) {
    {
        let mut d = downloads().lock().unwrap();
        if d.running {
            return;
        }
        d.running = true;
        d.fraction = 0.0;
        d.error = None;
    }
    on_change(status());
    let spawned = std::thread::Builder::new().name("abito-model-download".into()).spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())
            .and_then(|rt| rt.block_on(download_all(&on_change)));
        {
            let mut d = downloads().lock().unwrap();
            d.running = false;
            if let Err(err) = &result {
                d.error = Some(err.clone());
            }
        }
        if result.is_ok() {
            preload();
        }
        on_change(status());
    });
    if let Err(e) = spawned {
        let mut d = downloads().lock().unwrap();
        d.running = false;
        d.error = Some(e.to_string());
    }
}

async fn download_all(on_change: &impl Fn(ModelsStatus)) -> Result<(), String> {
    use futures_util::StreamExt;
    let total = PARAKEET.total_size();
    let mut done: u64 = 0;
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .user_agent(concat!("Abito/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let mut last_emit = Instant::now();
    let dir = PARAKEET.dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for file in PARAKEET.files {
        let path = dir.join(file.name);
        if std::fs::metadata(&path).map(|m| m.len() == file.size).unwrap_or(false) {
            done += file.size;
            continue;
        }
        let part = dir.join(format!("{}.part", file.name));
        let response = client.get(file.url).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("{}: HTTP {}", file.name, response.status().as_u16()));
        }
        let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut verifier = Verifier::new(file);
        let mut stream = response.bytes_stream();
        let mut ok = true;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            if !verifier.update(&chunk) {
                ok = false;
                break;
            }
            out.write_all(&chunk).map_err(|e| e.to_string())?;
            if last_emit.elapsed() > Duration::from_millis(250) {
                last_emit = Instant::now();
                downloads().lock().unwrap().fraction = (done + verifier.bytes()) as f64 / total as f64;
                on_change(status());
            }
        }
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        if !ok || !verifier.finish() {
            let _ = std::fs::remove_file(&part);
            return Err(format!("{}: the file that came in is not the expected one", file.name));
        }
        std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
        done += file.size;
    }
    Ok(())
}

/// Deletes the model (Settings → Remove the model).
pub fn remove() {
    unload();
    let _ = std::fs::remove_dir_all(PARAKEET.dir());
    downloads().lock().unwrap().error = None;
}

// ── Recognition ───────────────────────────────────────────────────────────────

fn recognizer_slot() -> &'static Mutex<Option<Arc<OfflineRecognizer>>> {
    static R: OnceLock<Mutex<Option<Arc<OfflineRecognizer>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

/// Serialises loading: two callers never load the 650 MB model twice.
fn load_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

fn threads() -> i32 {
    std::thread::available_parallelism().map(|n| n.get().clamp(1, 4) as i32).unwrap_or(2)
}

/// The loaded recognizer, loading it on first use (about 2 s).
pub fn recognizer() -> Option<Arc<OfflineRecognizer>> {
    if let Some(r) = recognizer_slot().lock().unwrap().clone() {
        return Some(r);
    }
    if !active_set().is_present() {
        return None;
    }
    let _guard = load_lock().lock().unwrap();
    if let Some(r) = recognizer_slot().lock().unwrap().clone() {
        return Some(r);
    }
    let (id, language) = active();
    let entry = catalog::find(&id)?;
    let mut config = OfflineRecognizerConfig::default();
    match entry.engine {
        catalog::Engine::Parakeet => {
            config.model_config.transducer = OfflineTransducerModelConfig {
                encoder: Some(PARAKEET.path("encoder.int8.onnx")),
                decoder: Some(PARAKEET.path("decoder.int8.onnx")),
                joiner: Some(PARAKEET.path("joiner.int8.onnx")),
            };
            config.model_config.tokens = Some(PARAKEET.path("tokens.txt"));
            config.model_config.model_type = Some("nemo_transducer".into());
        }
        catalog::Engine::Whisper => {
            let file = |suffix: &str| entry.set.files.iter().find(|f| f.name.ends_with(suffix)).map(|f| entry.set.path(f.name));
            config.model_config.whisper = OfflineWhisperModelConfig {
                encoder: file("-encoder.int8.onnx"),
                decoder: file("-decoder.int8.onnx"),
                // Fixed language when the user chose one; empty lets Whisper guess.
                language: Some(catalog::effective_language(entry, &language).unwrap_or("").to_string()),
                task: Some("transcribe".into()),
                ..Default::default()
            };
            config.model_config.tokens = file("-tokens.txt");
            config.model_config.model_type = Some("whisper".into());
        }
    }
    config.model_config.num_threads = threads();
    let r = OfflineRecognizer::create(&config).map(Arc::new);
    *recognizer_slot().lock().unwrap() = r.clone();
    r
}

/// Loads the model in the background, so the first dictation is not slowed down.
pub fn preload() {
    if !active_set().is_present() || recognizer_slot().lock().unwrap().is_some() {
        return;
    }
    std::thread::spawn(|| {
        let _ = recognizer();
    });
}

/// Frees the model's memory (dictation turned off, model removed).
pub fn unload() {
    *recognizer_slot().lock().unwrap() = None;
}

/// Longest stretch given to the model at once. Longer audio is cut where it is
/// quietest, near this length.
const MAX_CHUNK_SECONDS: f64 = 28.0;

fn words_slot() -> &'static Mutex<Vec<String>> {
    static W: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(vec![]))
}

/// The user's custom words (Ajustes → Voz); «Abito» is always built in.
pub fn set_custom_words(words: &[String]) {
    *words_slot().lock().unwrap() = words::clean_words(words);
}

/// What the recognizer heard, with the custom words (and «Abito») corrected: the text every
/// consumer wants. Training uses `transcribe_raw` so it sees the model's own spelling.
pub fn transcribe(samples: &[f32]) -> Option<String> {
    let raw = transcribe_raw(samples)?;
    Some(words::correct(&raw, &words_slot().lock().unwrap()))
}

/// Transcribes 16 kHz mono audio; None when the model is not there.
pub fn transcribe_raw(samples: &[f32]) -> Option<String> {
    let rec = recognizer()?;
    let mut text = String::new();
    for (_, chunk) in audio::split_for_model(samples, SAMPLE_RATE, MAX_CHUNK_SECONDS) {
        if chunk.len() < (SAMPLE_RATE as usize) / 4 {
            continue;
        }
        let stream = rec.create_stream();
        stream.accept_waveform(SAMPLE_RATE as i32, chunk);
        rec.decode(&stream);
        let Some(result) = stream.get_result() else { continue };
        let piece = result.text.trim();
        if !piece.is_empty() {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(piece);
        }
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn file_for(data: &'static [u8]) -> ModelFile {
        let hex: String = Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect();
        ModelFile { name: "x", url: "https://example.invalid/x", size: data.len() as u64, sha256: Box::leak(hex.into_boxed_str()) }
    }

    #[test]
    fn a_file_is_accepted_only_when_size_and_hash_match() {
        let f = file_for(b"hello world");
        let mut v = Verifier::new(&f);
        assert!(v.update(b"hello "));
        assert!(v.update(b"world"));
        assert!(v.finish());
    }

    #[test]
    fn a_wrong_hash_or_a_short_file_is_refused() {
        let f = file_for(b"hello world");
        let mut v = Verifier::new(&f);
        v.update(b"hello w0rld");
        assert!(!v.finish());
        let mut v = Verifier::new(&f);
        v.update(b"hello");
        assert!(!v.finish());
    }

    #[test]
    fn a_file_bigger_than_expected_is_cut_off() {
        let f = file_for(b"abc");
        let mut v = Verifier::new(&f);
        assert!(!v.update(b"abcd"));
    }

    #[test]
    fn the_download_is_https_only_pinned_and_adds_up() {
        assert_eq!(PARAKEET.total_size(), 652_184_281 + 11_845_275 + 6_355_277 + 93_939);
        for f in PARAKEET.files {
            assert_eq!(f.sha256.len(), 64, "{}", f.name);
            assert!(f.url.starts_with("https://huggingface.co/"), "{}", f.name);
        }
    }

    #[test]
    fn nothing_is_present_in_an_empty_folder_and_status_is_missing() {
        let dir = std::env::temp_dir().join(format!("abito-models-{}", std::process::id()));
        assert!(!PARAKEET.files.iter().all(|f| std::fs::metadata(PARAKEET.dir_in(&dir).join(f.name)).is_ok()));
        // Nothing starts a download by itself: status() only reads.
        assert!(!downloads().lock().unwrap().running);
    }
}

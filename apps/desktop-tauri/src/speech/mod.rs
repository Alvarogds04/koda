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
//! SHA-256 before they are used, and live in the data folder's `Models`
//! (`data_dir()`: `$XDG_DATA_HOME/abito` or `~/.local/share/abito` on Linux
//! and macOS — unchanged by K2-04 — `%LOCALAPPDATA%\abito-data` on Windows: never
//! `%LOCALAPPDATA%\koda` (the island's protected root `%LOCALAPPDATA%\Koda`) and never
//! `%LOCALAPPDATA%\abito` (the Koda 0.1 island root, left on disk untouched); see
//! `data_dir_for`). From then on everything runs offline.

pub mod audio;
pub mod catalog;
pub mod train;
pub mod transcribe;
pub mod words;
pub mod wake;
#[cfg(test)]
mod catalog_tests;
#[cfg(test)]
mod transcribe_tests;
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

use std::ffi::OsString;
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
        try_models_dir().is_some_and(|root| self.is_present_in(&root))
    }

    /// The same check against a store the caller resolved, so it can answer "no" instead of panicking.
    pub fn is_present_in(&self, root: &Path) -> bool {
        self.files.iter().all(|f| std::fs::metadata(self.dir_in(root).join(f.name)).map(|m| m.len() == f.size).unwrap_or(false))
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

/// The OS whose data-folder layout is being resolved. Passed in, never read from `cfg!(…)` inside the resolver,
/// so one test binary covers every OS's rules on the machine that runs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Linux,
    MacOs,
    Windows,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::MacOs
        } else {
            Os::Linux
        }
    }
}

/// The data folder cannot be located: the environment has no absolute folder for it. Koda never guesses a
/// working-directory-relative one (see `data_dir`), so the caller decides what to answer instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoDataDir;

impl std::fmt::Display for NoDataDir {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "no absolute data folder in the environment (LOCALAPPDATA or USERPROFILE on Windows, XDG_DATA_HOME or \
             HOME elsewhere)"
        )
    }
}

impl std::error::Error for NoDataDir {}

/// The data folder's name on Windows. NOT `koda` (the island's protected root `%LOCALAPPDATA%\Koda`) and NOT `abito`
/// (the Koda 0.1 island root, still on disk after the update): on case-insensitive NTFS either of those would be the
/// same folder as an island root, which is a different thing entirely (see `data_dir_for`).
pub const WINDOWS_DATA_LEAF: &str = "abito-data";
/// The data folder's name everywhere else: the store dictation, the flow store and the helper already use (K2-04 did
/// not rename it, so Windows keeps the `abito` family too instead of inventing a second spelling).
pub const DATA_LEAF: &str = "abito";

/// `<base>/<leaf>` for `os`, read through `var` (an environment lookup) instead of the process environment.
///
/// - Windows: `%LOCALAPPDATA%\abito-data`, else `%USERPROFILE%\AppData\Local\abito-data`. A Windows GUI app gets no
///   `HOME` (and the transcription helper runs with the daemon's temporary work folder as its working directory), which
///   is exactly why the Linux chain cannot be reused there: it produced `<work>/.local/share/abito/Models` and every
///   Minikoda answered `model_missing`. The leaf is `abito-data`, never `koda` and never `abito`: NTFS is
///   case-insensitive, so `%LOCALAPPDATA%\koda` IS `%LOCALAPPDATA%\Koda`, the island's private root, and
///   `%LOCALAPPDATA%\abito` IS `%LOCALAPPDATA%\Abito`, the Koda 0.1 island root that the update leaves on disk
///   untouched (K2-04 S1). That root is created — or
///   accepted — with an explicit protected owner-only DACL (`abito-private-session`), and the island verifies it
///   fail-closed (`winpolicy::dacl_private`: owner plus every ACE principal must be the user, SYSTEM or
///   Administrators). A data folder created there first by Node/`std::fs` inherits the whole `%LOCALAPPDATA%` profile
///   DACL instead, so the island MAY refuse to start ("runtime root is not a private directory of ours") depending
///   only on which feature ran first: a stock `%LOCALAPPDATA%` DACL (SYSTEM, Administrators, the user) passes that
///   check, while a profile whose folder carries extra principals — a domain or capability SID, an inherited
///   `CREATOR OWNER` — fails it. Two different folders were meant, so they get two different names.
/// - Linux and macOS: `$XDG_DATA_HOME/abito`, else `$HOME/.local/share/abito`. The macOS-specific store belongs to
///   the Mac session (L12); this keeps the folder dictation, the flow store and the helper already use.
///
/// A relative folder is refused on every OS: relative to what is never knowable from here.
pub fn data_dir_for(os: Os, var: impl Fn(&str) -> Option<OsString>) -> Result<PathBuf, NoDataDir> {
    let absolute = |name: &str| var(name).map(PathBuf::from).filter(|p| p.is_absolute());
    let (base, leaf) = match os {
        Os::Windows => (
            absolute("LOCALAPPDATA")
                .or_else(|| absolute("USERPROFILE").map(|profile| profile.join("AppData").join("Local"))),
            WINDOWS_DATA_LEAF,
        ),
        Os::Linux | Os::MacOs => (
            absolute("XDG_DATA_HOME").or_else(|| absolute("HOME").map(|home| home.join(".local/share"))),
            DATA_LEAF,
        ),
    };
    base.map(|base| base.join(leaf)).ok_or(NoDataDir)
}

/// Abito's data folder for this process, or `NoDataDir`. The transcription helper uses this one: it answers a JSON
/// error instead of panicking.
pub fn try_data_dir() -> Result<PathBuf, NoDataDir> {
    data_dir_for(Os::current(), |name| std::env::var_os(name))
}

/// Abito's data folder: `$XDG_DATA_HOME/abito` (default `~/.local/share/abito`) on Linux and macOS,
/// `%LOCALAPPDATA%\abito-data` (default `%USERPROFILE%\AppData\Local\abito-data`) on Windows.
///
/// Panics when the environment has no absolute folder at all, and only then: silently continuing under a
/// `<cwd>/.local/share` is the bug this replaced. Startup callers must not panic: they check `try_data_dir` first and
/// disable the feature (voice, dictation) with a log line instead, and the read-only queries use `try_models_dir`.
pub fn data_dir() -> PathBuf {
    try_data_dir().unwrap_or_else(|error| {
        panic!("abito: cannot locate the data folder ({error}); refusing to use a path relative to the working directory")
    })
}

pub fn models_dir() -> PathBuf {
    data_dir().join("Models")
}

/// The model store, or `None` when the environment names no absolute data folder. Read-only callers (`status`,
/// `is_ready`, the Settings list, the Silero detector) answer "nothing installed" from this one instead of panicking:
/// a missing data folder must never take the app down, and it must never be resolved relative to the working folder.
pub fn try_models_dir() -> Option<PathBuf> {
    try_data_dir().ok().map(|dir| dir.join("Models"))
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

/// The verified download of one catalog set, run to the end on the calling thread (the `koda-transcribe download`
/// command: an explicit user action, like the picker's click). Same pins, same store, same checks as `download_model`.
pub fn download_set_now(set: &ModelSet, progress: &dyn Fn(f64)) -> Result<(), String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(fetch_set(set, progress, &|| false))
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

pub(crate) fn threads() -> i32 {
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
    let config = offline_config(entry, &language, &models_dir());
    let r = OfflineRecognizer::create(&config).map(Arc::new);
    *recognizer_slot().lock().unwrap() = r.clone();
    r
}

/// The recognizer configuration of one catalog model whose files live under `root` (the shared model store). Used by
/// dictation and by the Minikodas' batch transcription (`koda-transcribe`), so both load a model the same way.
pub(crate) fn offline_config(entry: &catalog::Entry, language: &str, root: &Path) -> OfflineRecognizerConfig {
    let dir = entry.set.dir_in(root);
    let path = |name: &str| dir.join(name).to_string_lossy().to_string();
    let mut config = OfflineRecognizerConfig::default();
    match entry.engine {
        catalog::Engine::Parakeet => {
            config.model_config.transducer = OfflineTransducerModelConfig {
                encoder: Some(path("encoder.int8.onnx")),
                decoder: Some(path("decoder.int8.onnx")),
                joiner: Some(path("joiner.int8.onnx")),
            };
            config.model_config.tokens = Some(path("tokens.txt"));
            config.model_config.model_type = Some("nemo_transducer".into());
        }
        catalog::Engine::Whisper => {
            let file = |suffix: &str| entry.set.files.iter().find(|f| f.name.ends_with(suffix)).map(|f| path(f.name));
            config.model_config.whisper = OfflineWhisperModelConfig {
                encoder: file("-encoder.int8.onnx"),
                decoder: file("-decoder.int8.onnx"),
                // Fixed language when the user chose one; empty lets Whisper guess.
                language: Some(catalog::effective_language(entry, language).unwrap_or("").to_string()),
                task: Some("transcribe".into()),
                ..Default::default()
            };
            config.model_config.tokens = file("-tokens.txt");
            config.model_config.model_type = Some("whisper".into());
        }
    }
    config.model_config.num_threads = threads();
    config
}

/// Loads the model in the background, so the first dictation is not slowed down.
pub fn preload() {
    if !is_ready() || recognizer_slot().lock().unwrap().is_some() {
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
    fn the_windows_store_is_localappdata_or_userprofile_and_is_never_relative() {
        // Windows: %LOCALAPPDATA%\abito-data. EVERY path here comes from `temp_dir()`, which is absolute on every OS
        // this test binary runs on: a literal like `/home/u` is not absolute on Windows, so the resolver would refuse
        // it there and these assertions would be Linux-only.
        let at = |name: &str| {
            let path = std::env::temp_dir().join(name);
            assert!(path.is_absolute(), "{path:?}");
            path
        };
        let env = |pairs: Vec<(&'static str, PathBuf)>| {
            move |name: &str| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| value.clone().into_os_string())
        };
        let (local, profile, home, xdg) = (at("abito-test-Local"), at("abito-test-profile"), at("abito-test-home"), at("abito-test-xdg"));
        assert_eq!(data_dir_for(Os::Windows, env(vec![("LOCALAPPDATA", local.clone())])).unwrap(), local.join(WINDOWS_DATA_LEAF));
        // No LOCALAPPDATA: %USERPROFILE%\AppData\Local — never the Linux XDG chain, even when HOME is set.
        assert_eq!(
            data_dir_for(
                Os::Windows,
                env(vec![("USERPROFILE", profile.clone()), ("HOME", home.clone()), ("XDG_DATA_HOME", xdg.clone())])
            )
            .unwrap(),
            profile.join("AppData").join("Local").join(WINDOWS_DATA_LEAF)
        );
        // Neither: an error, not a working-directory path (a Windows GUI app has no HOME at all).
        assert_eq!(data_dir_for(Os::Windows, env(vec![("HOME", home.clone())])), Err(NoDataDir));
        assert_eq!(data_dir_for(Os::Windows, env(vec![("XDG_DATA_HOME", xdg)])), Err(NoDataDir));
        assert_eq!(data_dir_for(Os::Windows, env(vec![])), Err(NoDataDir));
        // A relative folder is refused, never joined: the helper's working directory is its temp work folder.
        assert_eq!(data_dir_for(Os::Windows, env(vec![("LOCALAPPDATA", PathBuf::from("AppData/Local"))])), Err(NoDataDir));
        assert_eq!(data_dir_for(Os::Windows, env(vec![("USERPROFILE", PathBuf::from("."))])), Err(NoDataDir));
        // And the leaf is NOT one of the island roots' names: on case-insensitive NTFS `koda` and `Koda`, and `abito`
        // and `Abito`, are the same folder each.
        // Compared lowercased on purpose: the two strings differ in case anyway, so comparing them as they are would
        // pass even if the leaf went back to `koda` — that is exactly the collision this guards.
        assert_ne!(
            data_dir_for(Os::Windows, env(vec![("LOCALAPPDATA", at("abito-test-Local"))])).unwrap().to_string_lossy().to_lowercase(),
            at("abito-test-Local").join("Koda").to_string_lossy().to_lowercase()
        );
        // Same check on the leaf itself, which no case difference can hide: not the current island root (`Koda`), and
        // not the Koda 0.1 island root (`Abito`), which the update deliberately leaves on disk.
        assert_ne!(WINDOWS_DATA_LEAF.to_lowercase(), "koda");
        assert_ne!(WINDOWS_DATA_LEAF.to_lowercase(), "abito");
    }

    #[test]
    fn the_linux_and_macos_store_keeps_the_xdg_folders_and_refuses_a_relative_one() {
        let at = |name: &str| {
            let path = std::env::temp_dir().join(name);
            assert!(path.is_absolute(), "{path:?}");
            path
        };
        let env = |pairs: Vec<(&'static str, PathBuf)>| {
            move |name: &str| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| value.clone().into_os_string())
        };
        let (xdg, home) = (at("abito-test-xdg"), at("abito-test-home"));
        for os in [Os::Linux, Os::MacOs] {
            assert_eq!(
                data_dir_for(os, env(vec![("XDG_DATA_HOME", xdg.clone()), ("HOME", home.clone())])).unwrap(),
                xdg.join(DATA_LEAF)
            );
            assert_eq!(data_dir_for(os, env(vec![("HOME", home.clone())])).unwrap(), home.join(".local/share").join(DATA_LEAF));
            assert_eq!(
                data_dir_for(os, env(vec![("XDG_DATA_HOME", PathBuf::from(".local/share"))])),
                Err(NoDataDir),
                "a relative XDG_DATA_HOME is not used"
            );
            assert_eq!(data_dir_for(os, env(vec![])), Err(NoDataDir), "nothing is invented when the environment is empty");
        }
    }

    #[test]
    fn this_machine_resolves_an_absolute_data_folder() {
        // The real resolver (injected env is covered above): whatever the OS, never `Path::is_relative`.
        let dir = try_data_dir().expect("the test environment has an absolute data folder (HOME/XDG_DATA_HOME or LOCALAPPDATA)");
        assert!(dir.is_absolute(), "{dir:?}");
        let leaf = if cfg!(windows) { WINDOWS_DATA_LEAF } else { DATA_LEAF };
        assert!(dir.ends_with(leaf), "{dir:?}");
    }

    #[test]
    fn without_a_data_folder_the_read_only_queries_answer_missing_instead_of_panicking() {
        // `try_models_dir` is what status/is_ready/the Settings list use: with no absolute folder it answers None, so
        // the app says «nothing installed» and never resolves a path relative to its working folder. The panicking
        // `data_dir()` stays reserved for the explicit actions (download, recognition) a startup guard already
        // disabled (voicehost::start, dictationhost::start).
        let none = |_: &str| None;
        assert_eq!(data_dir_for(Os::Windows, none), Err(NoDataDir));
        assert_eq!(data_dir_for(Os::Linux, none), Err(NoDataDir));
        assert!(try_data_dir().is_ok(), "this machine does have one");
        assert!(try_models_dir().is_some_and(|root| root.ends_with("Models")));
    }

    #[test]
    fn nothing_is_present_in_an_empty_folder_and_status_is_missing() {
        let dir = std::env::temp_dir().join(format!("abito-models-{}", std::process::id()));
        assert!(!PARAKEET.files.iter().all(|f| std::fs::metadata(PARAKEET.dir_in(&dir).join(f.name)).is_ok()));
        // Nothing starts a download by itself: status() only reads.
        assert!(!downloads().lock().unwrap().running);
    }
}

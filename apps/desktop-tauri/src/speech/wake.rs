//! «OK Abito», the NotchBuddy way on Linux: a voice-activity detector (Silero, through
//! sherpa-onnx) gates the microphone; each speech segment goes to the Parakeet recognizer
//! that dictation already uses, and the transcript is matched against «OK Abito» with a
//! tolerant normalisation. What follows the phrase in the same segment is the command;
//! otherwise the next segment is. CPU is only spent while someone speaks.
//!
//! Adapted from Coucou NotchBuddy Voice/{WakePhrase,WakeSpotter,EnergyVAD,VoiceEngine}.swift
//! @71b773f, Copyright (c) 2026 Louis Raillé, MIT. Silero VAD (MIT) is fetched from the
//! official k2-fsa release, on the user's click, checked against a pinned SHA-256.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::SyncSender;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::train::Learned;
use super::{models_dir, ModelFile, ModelState, Verifier, SAMPLE_RATE};
use crate::voiceintent::normalise;

// ── The pinned VAD model ──────────────────────────────────────────────────────

pub struct VadSpec {
    pub id: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// Silero VAD as packaged by k2-fsa for sherpa-onnx (MIT).
pub static VAD: VadSpec = VadSpec {
    id: "silero-vad",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    size: 643_854,
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
};

const VAD_FILE: &str = "silero_vad.onnx";

impl VadSpec {
    pub fn dir_in(&self, root: &Path) -> PathBuf {
        root.join(self.id)
    }
    pub fn path_in(&self, root: &Path) -> PathBuf {
        self.dir_in(root).join(VAD_FILE)
    }
    pub fn is_present_in(&self, root: &Path) -> bool {
        std::fs::metadata(self.path_in(root))
            .map(|m| m.len() == self.size)
            .unwrap_or(false)
    }
    pub fn is_present(&self) -> bool {
        self.is_present_in(&models_dir())
    }
    pub fn path(&self) -> PathBuf {
        self.path_in(&models_dir())
    }
}

fn sha256_file(path: &Path) -> std::io::Result<(String, u64)> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut n = 0u64;
    loop {
        let r = f.read(&mut buf)?;
        if r == 0 {
            break;
        }
        h.update(&buf[..r]);
        n += r as u64;
    }
    Ok((h.finalize().iter().map(|b| format!("{b:02x}")).collect(), n))
}

/// Checks the downloaded file against the pin and moves it into place; the file is
/// removed when it is not the expected one.
pub fn install_vad(part: &Path, root: &Path) -> Result<(), String> {
    let (hash, size) = sha256_file(part).map_err(|e| e.to_string())?;
    if size != VAD.size || hash != VAD.sha256 {
        let _ = std::fs::remove_file(part);
        return Err(
            "The voice detector that came in is not the expected file; it was discarded.".into(),
        );
    }
    std::fs::create_dir_all(VAD.dir_in(root)).map_err(|e| e.to_string())?;
    std::fs::rename(part, VAD.path_in(root)).map_err(|e| e.to_string())
}

struct Dl {
    running: bool,
    fraction: f64,
    error: Option<String>,
}

fn dl() -> &'static Mutex<Dl> {
    static D: OnceLock<Mutex<Dl>> = OnceLock::new();
    D.get_or_init(|| {
        Mutex::new(Dl {
            running: false,
            fraction: 0.0,
            error: None,
        })
    })
}

pub fn status() -> ModelState {
    let d = dl().lock().unwrap();
    if d.running {
        ModelState::Downloading {
            fraction: d.fraction,
        }
    } else if VAD.is_present() {
        ModelState::Ready
    } else if let Some(error) = &d.error {
        ModelState::Failed {
            error: error.clone(),
        }
    } else {
        ModelState::Missing
    }
}

/// Downloads the detector (about 0.6 MB) on a background thread. ONLY from an explicit user action.
pub fn download(on_change: impl Fn(ModelState) + Send + 'static) {
    if VAD.is_present() {
        on_change(status());
        return;
    }
    {
        let mut d = dl().lock().unwrap();
        if d.running {
            return;
        }
        d.running = true;
        d.fraction = 0.0;
        d.error = None;
    }
    on_change(status());
    let spawned = std::thread::Builder::new()
        .name("abito-vad-download".into())
        .spawn(move || {
            let result = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())
                .and_then(|rt| rt.block_on(fetch(&on_change)));
            {
                let mut d = dl().lock().unwrap();
                d.running = false;
                if let Err(e) = result {
                    d.error = Some(e);
                }
            }
            on_change(status());
        });
    if let Err(e) = spawned {
        let mut d = dl().lock().unwrap();
        d.running = false;
        d.error = Some(e.to_string());
    }
}

async fn fetch(on_change: &impl Fn(ModelState)) -> Result<(), String> {
    use futures_util::StreamExt;
    let root = models_dir();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let part = root.join(format!(".{}.part", VAD.id));
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .user_agent(concat!("Abito/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(VAD.url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let file = ModelFile {
        name: VAD_FILE,
        url: VAD.url,
        size: VAD.size,
        sha256: VAD.sha256,
    };
    let mut verifier = Verifier::new(&file);
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut last = Instant::now();
    let mut ok = true;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if !verifier.update(&chunk) {
            ok = false;
            break;
        }
        out.write_all(&chunk).map_err(|e| e.to_string())?;
        if last.elapsed() > Duration::from_millis(250) {
            last = Instant::now();
            dl().lock().unwrap().fraction = verifier.bytes() as f64 / VAD.size as f64;
            on_change(status());
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    if !ok || !verifier.finish() {
        let _ = std::fs::remove_file(&part);
        return Err(
            "The voice detector that came in is not the expected file; it was discarded.".into(),
        );
    }
    install_vad(&part, &root)
}

pub fn remove() {
    let _ = std::fs::remove_dir_all(VAD.dir_in(&models_dir()));
    dl().lock().unwrap().error = None;
}

// ── Sensitivity ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Params {
    /// Silero speech probability needed to open a segment (0.65 strict … 0.25 loose).
    pub vad_threshold: f32,
    /// Edit distance allowed between the heard name and «abito».
    pub tolerance: usize,
}

pub fn params(sensitivity: u8) -> Params {
    let s = sensitivity.min(100);
    Params {
        vad_threshold: 0.65 - 0.4 * (s as f32 / 100.0),
        tolerance: if s < 34 {
            0
        } else if s < 67 {
            1
        } else {
            2
        },
    }
}

// ── Matching «OK Abito» in a transcript ───────────────────────────────────────

pub(crate) const OK_WORDS: &[&str] = &[
    "ok", "okey", "okay", "oka", "oca", "okei", "okai", "hey", "oye",
];
/// Longest first, so «okey» is not read as «ok» + «ey».
const OK_PREFIXES: &[&str] = &["okey", "okay", "okei", "okai", "oka", "oca", "ok"];
/// Spellings the recognizer is known to give; they never need tolerance.
pub(crate) const NAMES: &[&str] = &["koda", "kodá", "qoda", "kouda", "kodda"];
/// Spellings that are not words but are too ambiguous to wake on their own: only the vocative reading counts (the FIRST word, a comma
/// right after it and a command following). «coda» is NOT here on purpose: it is a real word («coda, la sección final…») and the old
/// «Habito,» trick would wake the app by mistake; a person whose recogniser writes «coda» for «Koda» teaches it in Entrenamiento de voz
/// (`Learned.names`), which is already supported. Measured in `koda_word_tests`.
pub(crate) const NAMES_VOCATIVE_ONLY: &[&str] = &["kota", "cota"];
/// Mishearings seen from Parakeet. Only accepted right after an «ok» word, never alone.
const NAMES_AFTER_OK: &[&str] = &["kota", "goda"];

pub(crate) fn levenshtein(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut prev = row[0];
        row[0] = i;
        for j in 1..=b.len() {
            let t = row[j];
            row[j] = if a[i - 1] == b[j - 1] {
                prev
            } else {
                prev.min(row[j]).min(row[j - 1]) + 1
            };
            prev = t;
        }
    }
    row[b.len()]
}

fn is_name(s: &str, _tolerance: usize, learned: &Learned) -> bool {
    // «Koda» is a four-letter word with many real neighbours (toda, soda, moda, boda, cola…): NO edit distance here, only the
    // exact spellings the recogniser is known to give plus what this person trained (human 30-oct: «solo koda»).
    NAMES.contains(&s) || learned.names.iter().any(|n| n == s)
}

/// «Koda, ¿qué hora es?»: Parakeet sometimes drops the «OK» (or hears it as a separate
/// «Yes.» segment). The name then still counts as a wake, but only when it is a KNOWN spelling,
/// the FIRST word, written with a comma right after it, and followed by a command.
fn vocative_end(words: &[&str], learned: &Learned) -> Option<usize> {
    let first = words.first()?;
    if words.len() < 2 || !first.ends_with(',') {
        return None;
    }
    let first = normalise(first);
    (NAMES.contains(&first.as_str()) || NAMES_VOCATIVE_ONLY.contains(&first.as_str()) || learned.names.contains(&first)).then_some(1)
}

/// Finds «ok abito» (or «hey/oye abito») in `raw` and returns what follows the LAST
/// occurrence, in its original spelling. None when the phrase is absent.
pub fn match_wake(raw: &str, tolerance: usize) -> Option<String> {
    match_wake_with(raw, tolerance, &Learned::default())
}

/// Same, plus what this person trained: extra spellings of the name, extra «OK» lead words
/// right before a name, and the complete trained phrases (alone in a segment: a bare wake).
pub fn match_wake_with(raw: &str, tolerance: usize, learned: &Learned) -> Option<String> {
    if !learned.phrases.is_empty() && learned.phrases.contains(&normalise(raw)) {
        return Some(String::new());
    }
    let words: Vec<&str> = raw.split_whitespace().collect();
    let norm: Vec<(usize, String)> = words
        .iter()
        .enumerate()
        .map(|(i, w)| (i, normalise(w)))
        .filter(|(_, n)| !n.is_empty())
        .collect();
    let tolerance = tolerance.min(2);
    let mut end: Option<usize> = None;
    let mut i = 0;
    while i < norm.len() {
        let (_, tok) = &norm[i];
        // Glued: «okabito», «okeyabito».
        let glued = OK_PREFIXES.iter().any(|p| {
            tok.strip_prefix(p)
                .is_some_and(|rest| !rest.is_empty() && is_name(rest, tolerance, learned))
        });
        if glued {
            end = Some(norm[i].0 + 1);
            i += 1;
            continue;
        }
        if (OK_WORDS.contains(&tok.as_str()) || learned.leads.contains(tok)) && i + 1 < norm.len() {
            if is_name(&norm[i + 1].1, tolerance, learned)
                || NAMES_AFTER_OK.contains(&norm[i + 1].1.as_str())
            {
                end = Some(norm[i + 1].0 + 1);
                i += 2;
                continue;
            }
            // «a vito» → «avito»
            if i + 2 < norm.len()
                && is_name(&format!("{}{}", norm[i + 1].1, norm[i + 2].1), tolerance, learned)
            {
                end = Some(norm[i + 2].0 + 1);
                i += 3;
                continue;
            }
            // «Ok ya Vito»: the first syllable heard as a short word of its own.
            if i + 2 < norm.len()
                && norm[i + 1].1.chars().count() <= 2
                && (is_name(&norm[i + 2].1, tolerance, learned) || NAMES_AFTER_OK.contains(&norm[i + 2].1.as_str()))
            {
                end = Some(norm[i + 2].0 + 1);
                i += 3;
                continue;
            }
        }
        i += 1;
    }
    let end = end.or_else(|| vocative_end(&words, learned))?;
    let tail = words[end..].join(" ");
    Some(
        tail.trim_start_matches([',', '.', ':', ';', '!', '-', '–', '—', '…', ' '])
            .to_string(),
    )
}

// ── The flow: transcripts in, events out ──────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum FlowEvent {
    /// The phrase was heard.
    Wake,
    /// What was said after it (or the answer to a follow-up question).
    Command(String),
    /// Nothing was said after the wake.
    Timeout,
}

/// Samples of silence after a bare wake before giving up (5 s).
const COMMAND_TIMEOUT: usize = 5 * SAMPLE_RATE as usize;

pub struct WakeFlow {
    armed: bool,
    idle: usize,
    in_flight: bool,
    learned: Learned,
}

impl Default for WakeFlow {
    fn default() -> Self {
        Self::new()
    }
}

impl WakeFlow {
    pub fn new() -> Self {
        Self {
            armed: false,
            idle: 0,
            in_flight: false,
            learned: Learned::default(),
        }
    }

    /// What this person trained (replaces the previous training; empty forgets it).
    pub fn set_learned(&mut self, learned: Learned) {
        self.learned = learned;
    }

    pub fn armed(&self) -> bool {
        self.armed
    }

    /// Listen for a command right away, with no wake phrase (a follow-up answer).
    pub fn arm(&mut self) {
        self.armed = true;
        self.idle = 0;
    }

    /// A segment went to the recognizer: its transcript is on the way.
    pub fn segment_sent(&mut self) {
        self.in_flight = true;
    }

    /// The segment was not transcribed (dropped or failed).
    pub fn segment_lost(&mut self) {
        self.in_flight = false;
    }

    /// Time passes (samples heard).
    pub fn advance(&mut self, samples: usize) -> Vec<FlowEvent> {
        if !self.armed || self.in_flight {
            return vec![];
        }
        self.idle += samples;
        if self.idle >= COMMAND_TIMEOUT {
            self.armed = false;
            self.idle = 0;
            return vec![FlowEvent::Timeout];
        }
        vec![]
    }

    pub fn on_transcript(&mut self, text: &str, tolerance: usize) -> Vec<FlowEvent> {
        self.in_flight = false;
        let wake = match_wake_with(text, tolerance, &self.learned);
        if self.armed {
            let command = wake.unwrap_or_else(|| text.to_string());
            let command = command.trim();
            if command.is_empty() {
                return vec![];
            }
            self.armed = false;
            return vec![FlowEvent::Command(command.to_string())];
        }
        match wake {
            None => vec![],
            Some(rest) if rest.trim().is_empty() => {
                self.arm();
                vec![FlowEvent::Wake]
            }
            Some(rest) => vec![FlowEvent::Wake, FlowEvent::Command(rest.trim().to_string())],
        }
    }
}

// ── Segmenting ────────────────────────────────────────────────────────────────

/// A segment is never longer than this; longer speech is cut by the detector.
pub const MAX_SEGMENT_SECONDS: f32 = 5.0;
const MIN_SEGMENT: usize = SAMPLE_RATE as usize * 3 / 10;

pub fn usable(segment: &[f32]) -> bool {
    segment.len() >= MIN_SEGMENT
}

pub fn clip(segment: &[f32]) -> &[f32] {
    &segment[..segment
        .len()
        .min((MAX_SEGMENT_SECONDS * SAMPLE_RATE as f32) as usize)]
}

/// Hands a segment to the recognizer thread; false (dropped) while it is still busy.
pub fn offer(tx: &SyncSender<Vec<f32>>, segment: Vec<f32>) -> bool {
    tx.try_send(segment).is_ok()
}

/// Silero VAD over sherpa-onnx: samples in, finished speech segments out.
pub struct SileroGate {
    vad: sherpa_onnx::VoiceActivityDetector,
}

impl SileroGate {
    pub fn create(model: &Path, params: Params) -> Option<Self> {
        let config = sherpa_onnx::VadModelConfig {
            silero_vad: sherpa_onnx::SileroVadModelConfig {
                model: Some(model.to_string_lossy().to_string()),
                threshold: params.vad_threshold,
                min_silence_duration: 0.5,
                min_speech_duration: 0.25,
                window_size: 512,
                max_speech_duration: MAX_SEGMENT_SECONDS,
            },
            sample_rate: SAMPLE_RATE as i32,
            num_threads: 1,
            ..Default::default()
        };
        sherpa_onnx::VoiceActivityDetector::create(&config, 30.0).map(|vad| Self { vad })
    }

    pub fn feed(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        self.vad.accept_waveform(samples);
        let mut out = vec![];
        while !self.vad.is_empty() {
            if let Some(seg) = self.vad.front() {
                let s = seg.samples().to_vec();
                if usable(&s) {
                    out.push(s);
                }
            }
            self.vad.pop();
        }
        out
    }

    pub fn reset(&mut self) {
        self.vad.reset();
    }
}

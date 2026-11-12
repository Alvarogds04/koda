//! K2-13 (S8, S15, S16): batch transcription for the Minikodas, run by the `abito-transcribe` helper binary that the
//! daemon spawns (option A1). Same engine, catalog, model store and Silero VAD as dictation: no second engine and no
//! second model store.
//!
//! Input: an absolute path to a 16 kHz mono WAV (16-bit PCM or 32-bit float), as the daemon's bundled ffmpeg writes
//! it. The file must be a regular file opened without following a symlink. The audio is streamed in blocks: the
//! Silero detector cuts it into speech segments and every segment is cut again so that no stretch longer than
//! `MAX_SEGMENT_SECONDS` (25 s) ever reaches the model (sherpa's Whisper silently drops audio after 30 s, and
//! Silero's own `max_speech_duration` is not a strict limit; evidence odd/evidence/k2-13-stt).
//!
//! Models: Parakeet v3 int8 (default, S16) and Whisper turbo int8 (the user's alternative; its language is always
//! fixed, never guessed). Nothing here touches the network: a missing model is the error `model_missing`. Only the
//! separate `download` command fetches a model, through the catalog's pinned, size- and SHA-256-checked download.
//!
//! Output: ONE JSON line on stdout, `{text, segments:[{start,end,text}], model, language, durationSec}`, or ONE JSON
//! line `{error:<code>, message}` with a closed code. Memory is bounded by the block size, the detector's buffer and
//! the 25 s segment cap; time by `--timeout-sec` and the audio length by `--max-seconds`.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::{audio, catalog, SAMPLE_RATE};

/// The models a Minikoda may transcribe with: Parakeet v3 (default) and Whisper turbo.
pub const MODELS: [&str; 2] = [catalog::DEFAULT_MODEL, "whisper-turbo"];
/// No stretch longer than this reaches the model (S16).
pub const MAX_SEGMENT_SECONDS: f64 = 25.0;
/// Stretches shorter than this are not decoded (same floor as dictation).
const MIN_DECODE_SAMPLES: usize = SAMPLE_RATE as usize / 4;
/// The detector's own segment cap; segments are cut again at `MAX_SEGMENT_SECONDS` afterwards.
const VAD_MAX_SPEECH_SECONDS: f32 = 20.0;
const VAD_BUFFER_SECONDS: f32 = 60.0;
const BLOCK_SAMPLES: usize = 512 * 32;
pub const DEFAULT_TIMEOUT_SECONDS: u64 = 3600;
pub const MAX_TIMEOUT_SECONDS: u64 = 4 * 3600;
pub const DEFAULT_MAX_AUDIO_SECONDS: u64 = 3 * 3600;
pub const MAX_AUDIO_SECONDS: u64 = 6 * 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    Usage,
    UnknownModel,
    LanguageRequired,
    ModelMissing,
    BadInput,
    BadAudio,
    TooLong,
    Timeout,
    EngineFailed,
    DownloadFailed,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::Usage => "usage",
            Code::UnknownModel => "unknown_model",
            Code::LanguageRequired => "language_required",
            Code::ModelMissing => "model_missing",
            Code::BadInput => "bad_input",
            Code::BadAudio => "bad_audio",
            Code::TooLong => "too_long",
            Code::Timeout => "timeout",
            Code::EngineFailed => "engine_failed",
            Code::DownloadFailed => "download_failed",
        }
    }

    /// Process exit code: 2 for a bad command line, 1 for everything else.
    pub fn exit_code(self) -> i32 {
        if self == Code::Usage {
            2
        } else {
            1
        }
    }
}

/// A failure with a closed code and a fixed message (never an echoed path, never upstream text).
#[derive(Debug, Clone)]
pub struct Failure {
    pub code: Code,
    pub message: &'static str,
}

impl Failure {
    pub fn new(code: Code, message: &'static str) -> Self {
        Self { code, message }
    }
}

fn fail<T>(code: Code, message: &'static str) -> Result<T, Failure> {
    Err(Failure::new(code, message))
}

pub struct Request {
    pub entry: &'static catalog::Entry,
    /// The language handed to the model (Whisper: always set; Parakeet: informational only).
    pub language: Option<&'static str>,
    pub input: PathBuf,
    pub timeout: Duration,
    pub max_seconds: u64,
}

pub enum Command {
    Transcribe(Request),
    Download { entry: &'static catalog::Entry },
    Status { entry: &'static catalog::Entry },
}

pub const USAGE: &str = "usage: abito-transcribe transcribe [--model parakeet-tdt-0.6b-v3-int8|whisper-turbo] [--language es|en|fr|de|it|pt|ca] [--timeout-sec N] [--max-seconds N] <absolute 16 kHz mono WAV>\n       abito-transcribe status [--model ID]\n       abito-transcribe download [--model ID]";

fn model_entry(id: &str) -> Result<&'static catalog::Entry, Failure> {
    if !MODELS.contains(&id) {
        return fail(Code::UnknownModel, "the model is not one of the transcription models");
    }
    catalog::find(id).ok_or(Failure::new(Code::UnknownModel, "the model is not in the catalog"))
}

fn bounded(value: &str, max: u64) -> Result<u64, Failure> {
    match value.parse::<u64>() {
        Ok(n) if n >= 1 && n <= max => Ok(n),
        _ => fail(Code::Usage, "a numeric option is out of range"),
    }
}

/// Parses the command line (argv without the program name).
pub fn parse_args(args: &[String]) -> Result<Command, Failure> {
    let Some((command, rest)) = args.split_first() else { return fail(Code::Usage, USAGE) };
    let mut model = catalog::DEFAULT_MODEL.to_string();
    let mut language: Option<String> = None;
    let mut timeout = DEFAULT_TIMEOUT_SECONDS;
    let mut max_seconds = DEFAULT_MAX_AUDIO_SECONDS;
    let mut input: Option<PathBuf> = None;
    let mut it = rest.iter();
    while let Some(arg) = it.next() {
        let mut value = || it.next().cloned().ok_or(Failure::new(Code::Usage, "an option is missing its value"));
        match arg.as_str() {
            "--model" => model = value()?,
            "--language" => language = Some(value()?),
            "--timeout-sec" => timeout = bounded(&value()?, MAX_TIMEOUT_SECONDS)?,
            "--max-seconds" => max_seconds = bounded(&value()?, MAX_AUDIO_SECONDS)?,
            a if a.starts_with('-') => return fail(Code::Usage, "unknown option"),
            a => {
                if input.is_some() {
                    return fail(Code::Usage, "only one input file is accepted");
                }
                input = Some(PathBuf::from(a));
            }
        }
    }
    let entry = model_entry(&model)?;
    let language = match language.as_deref() {
        None => None,
        Some(l) if catalog::valid_language(l) => catalog::LANGUAGES.iter().copied().find(|x| *x == l),
        Some(_) => return fail(Code::Usage, "unknown language"),
    };
    match command.as_str() {
        "transcribe" => {
            let Some(input) = input else { return fail(Code::Usage, "the input file is missing") };
            if !input.is_absolute() {
                return fail(Code::Usage, "the input path must be absolute");
            }
            let language = if entry.forces_language {
                // Whisper never guesses the language here: it must be fixed (S16).
                match language.and_then(|l| catalog::effective_language(entry, l)) {
                    Some(l) => Some(l),
                    None => return fail(Code::LanguageRequired, "whisper needs a fixed language"),
                }
            } else {
                language.filter(|l| *l != "auto")
            };
            Ok(Command::Transcribe(Request { entry, language, input, timeout: Duration::from_secs(timeout), max_seconds }))
        }
        "download" | "status" if input.is_some() => fail(Code::Usage, "this command takes no file"),
        "download" => Ok(Command::Download { entry }),
        "status" => Ok(Command::Status { entry }),
        _ => fail(Code::Usage, USAGE),
    }
}

#[derive(Serialize)]
struct ErrorLine<'a> {
    error: &'a str,
    message: &'a str,
}

pub fn error_json(f: &Failure) -> String {
    serde_json::to_string(&ErrorLine { error: f.code.as_str(), message: f.message }).unwrap_or_else(|_| "{\"error\":\"engine_failed\"}".into())
}

// ── The input file ────────────────────────────────────────────────────────────

/// Opens the input only when it is a regular file; a symlink (the last component) is refused without being followed,
/// and the opened handle itself is checked again (no swap between the check and the open).
pub fn open_input(path: &Path) -> Result<std::fs::File, Failure> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| Failure::new(Code::BadInput, "the input file cannot be read"))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return fail(Code::BadInput, "the input is not a regular file");
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| Failure::new(Code::BadInput, "the input file cannot be read"))?;
    let opened = file.metadata().map_err(|_| Failure::new(Code::BadInput, "the input file cannot be read"))?;
    if !opened.is_file() {
        return fail(Code::BadInput, "the input is not a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.ino() != meta.ino() || opened.dev() != meta.dev() {
            return fail(Code::BadInput, "the input file changed while it was opened");
        }
    }
    Ok(file)
}

// ── The WAV reader (streaming; 16 kHz mono PCM16 or float32 only) ─────────────

#[derive(Clone, Copy)]
enum SampleFormat {
    Pcm16,
    Float32,
}

pub struct WavReader<R> {
    inner: R,
    format: SampleFormat,
    /// Bytes of sample data left (u64::MAX: until the end of the file, for a streamed header).
    remaining: u64,
    buf: Vec<u8>,
}

fn read_exact_or<R: Read>(r: &mut R, buf: &mut [u8]) -> Result<(), Failure> {
    r.read_exact(buf).map_err(|_| Failure::new(Code::BadAudio, "the audio is not a complete 16 kHz mono WAV"))
}

fn skip<R: Read>(r: &mut R, mut n: u64) -> Result<(), Failure> {
    let mut sink = [0u8; 4096];
    while n > 0 {
        let take = n.min(sink.len() as u64) as usize;
        read_exact_or(r, &mut sink[..take])?;
        n -= take as u64;
    }
    Ok(())
}

impl<R: Read> WavReader<R> {
    /// Reads the header up to the `data` chunk. Anything but 16 kHz mono 16-bit PCM or 32-bit float is `bad_audio`.
    pub fn new(mut inner: R) -> Result<Self, Failure> {
        let mut head = [0u8; 12];
        read_exact_or(&mut inner, &mut head)?;
        if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
            return fail(Code::BadAudio, "the audio is not a WAV file");
        }
        let mut format: Option<SampleFormat> = None;
        // At most a few dozen chunks before `data`: a file of endless chunks is refused.
        for _ in 0..64 {
            let mut chunk = [0u8; 8];
            read_exact_or(&mut inner, &mut chunk)?;
            let size = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) as u64;
            match &chunk[0..4] {
                b"fmt " => {
                    if !(16..=64).contains(&size) {
                        return fail(Code::BadAudio, "the WAV format chunk is malformed");
                    }
                    let mut fmt = vec![0u8; size as usize];
                    read_exact_or(&mut inner, &mut fmt)?;
                    if size % 2 == 1 {
                        skip(&mut inner, 1)?;
                    }
                    let tag = u16::from_le_bytes([fmt[0], fmt[1]]);
                    let channels = u16::from_le_bytes([fmt[2], fmt[3]]);
                    let rate = u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]);
                    let bits = u16::from_le_bytes([fmt[14], fmt[15]]);
                    // WAVE_FORMAT_EXTENSIBLE carries the real tag in its sub-format GUID.
                    let tag = if tag == 0xFFFE && fmt.len() >= 26 { u16::from_le_bytes([fmt[24], fmt[25]]) } else { tag };
                    if channels != 1 || rate != SAMPLE_RATE {
                        return fail(Code::BadAudio, "the audio must be 16 kHz mono");
                    }
                    format = match (tag, bits) {
                        (1, 16) => Some(SampleFormat::Pcm16),
                        (3, 32) => Some(SampleFormat::Float32),
                        _ => return fail(Code::BadAudio, "the audio must be 16-bit PCM or 32-bit float"),
                    };
                }
                b"data" => {
                    let Some(format) = format else { return fail(Code::BadAudio, "the WAV data comes before its format") };
                    // A streamed header leaves the size at 0 or 0xFFFFFFFF: read to the end of the file then.
                    let remaining = if size == 0 || size == u32::MAX as u64 { u64::MAX } else { size };
                    return Ok(Self { inner, format, remaining, buf: Vec::new() });
                }
                _ => skip(&mut inner, size + (size % 2))?,
            }
        }
        fail(Code::BadAudio, "the WAV file has no data chunk")
    }

    /// Reads up to `max` samples into `out` (cleared first); returns how many (0 at the end).
    pub fn read_block(&mut self, max: usize, out: &mut Vec<f32>) -> Result<usize, Failure> {
        out.clear();
        let width = match self.format {
            SampleFormat::Pcm16 => 2,
            SampleFormat::Float32 => 4,
        };
        let want = (max as u64 * width as u64).min(self.remaining) as usize;
        let want = want - want % width;
        if want == 0 {
            return Ok(0);
        }
        self.buf.resize(want, 0);
        let mut got = 0;
        while got < want {
            match self.inner.read(&mut self.buf[got..want]) {
                Ok(0) => break,
                Ok(n) => got += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return fail(Code::BadAudio, "the audio could not be read"),
            }
        }
        let got = got - got % width;
        if self.remaining != u64::MAX {
            self.remaining -= got as u64;
        }
        if got == 0 {
            self.remaining = 0;
            return Ok(0);
        }
        match self.format {
            SampleFormat::Pcm16 => out.extend(self.buf[..got].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)),
            SampleFormat::Float32 => out.extend(self.buf[..got].chunks_exact(4).map(|b| {
                let v = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                if v.is_finite() {
                    v.clamp(-1.0, 1.0)
                } else {
                    0.0
                }
            })),
        }
        Ok(out.len())
    }
}

// ── The segment loop ──────────────────────────────────────────────────────────

/// Cuts audio into speech segments: (offset of the first sample in the whole audio, samples).
pub trait Segmenter {
    fn feed(&mut self, samples: &[f32]) -> Vec<(usize, Vec<f32>)>;
    fn flush(&mut self) -> Vec<(usize, Vec<f32>)>;
}

/// Turns one stretch (at most `MAX_SEGMENT_SECONDS`) into text.
pub trait Decoder {
    fn decode(&mut self, samples: &[f32]) -> Result<String, Failure>;
}

pub struct Limits {
    pub max_samples: u64,
    pub deadline: Instant,
}

#[derive(Debug, Serialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub text: String,
    pub segments: Vec<Segment>,
    pub model: String,
    pub language: Option<String>,
    pub duration_sec: f64,
}

fn seconds(samples: usize) -> f64 {
    samples as f64 / SAMPLE_RATE as f64
}

fn decode_segment(offset: usize, samples: &[f32], decoder: &mut dyn Decoder, limits: &Limits, out: &mut Vec<Segment>) -> Result<(), Failure> {
    for (at, piece) in audio::split_for_model(samples, SAMPLE_RATE, MAX_SEGMENT_SECONDS) {
        if Instant::now() >= limits.deadline {
            return fail(Code::Timeout, "the transcription took too long");
        }
        if piece.len() < MIN_DECODE_SAMPLES {
            continue;
        }
        let text = decoder.decode(piece)?;
        let text = text.trim();
        if !text.is_empty() {
            let start = seconds(offset + at);
            out.push(Segment { start, end: start + seconds(piece.len()), text: text.to_string() });
        }
    }
    Ok(())
}

/// Streams the whole WAV through the detector and the recognizer.
pub fn transcribe_stream<R: Read>(wav: &mut WavReader<R>, segmenter: &mut dyn Segmenter, decoder: &mut dyn Decoder, limits: &Limits, model: &str, language: Option<&str>) -> Result<Output, Failure> {
    let mut total: u64 = 0;
    let mut segments = Vec::new();
    let mut block = Vec::with_capacity(BLOCK_SAMPLES);
    loop {
        if Instant::now() >= limits.deadline {
            return fail(Code::Timeout, "the transcription took too long");
        }
        let n = wav.read_block(BLOCK_SAMPLES, &mut block)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > limits.max_samples {
            return fail(Code::TooLong, "the audio is longer than allowed");
        }
        for (offset, seg) in segmenter.feed(&block) {
            decode_segment(offset, &seg, decoder, limits, &mut segments)?;
        }
    }
    for (offset, seg) in segmenter.flush() {
        decode_segment(offset, &seg, decoder, limits, &mut segments)?;
    }
    let text = segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
    Ok(Output { text, segments, model: model.to_string(), language: language.map(str::to_string), duration_sec: seconds(total as usize) })
}

pub fn output_json(out: &Output) -> String {
    serde_json::to_string(out).unwrap_or_else(|_| error_json(&Failure::new(Code::EngineFailed, "the result could not be written")))
}

// ── The real detector and recognizer (sherpa-onnx) ────────────────────────────

/// Silero VAD over sherpa-onnx, the same pinned model dictation uses.
pub struct SileroSegmenter {
    vad: sherpa_onnx::VoiceActivityDetector,
}

impl SileroSegmenter {
    pub fn create(model: &Path) -> Result<Self, Failure> {
        let config = sherpa_onnx::VadModelConfig {
            silero_vad: sherpa_onnx::SileroVadModelConfig {
                model: Some(model.to_string_lossy().to_string()),
                threshold: 0.5,
                min_silence_duration: 0.5,
                min_speech_duration: 0.25,
                window_size: 512,
                max_speech_duration: VAD_MAX_SPEECH_SECONDS,
            },
            sample_rate: SAMPLE_RATE as i32,
            num_threads: 1,
            ..Default::default()
        };
        sherpa_onnx::VoiceActivityDetector::create(&config, VAD_BUFFER_SECONDS).map(|vad| Self { vad }).ok_or(Failure::new(Code::EngineFailed, "the voice detector could not be loaded"))
    }

    fn drain(&mut self) -> Vec<(usize, Vec<f32>)> {
        let mut out = vec![];
        while !self.vad.is_empty() {
            if let Some(seg) = self.vad.front() {
                out.push((seg.start().max(0) as usize, seg.samples().to_vec()));
            }
            self.vad.pop();
        }
        out
    }
}

impl Segmenter for SileroSegmenter {
    fn feed(&mut self, samples: &[f32]) -> Vec<(usize, Vec<f32>)> {
        let mut out = vec![];
        for window in samples.chunks(512) {
            self.vad.accept_waveform(window);
            out.extend(self.drain());
        }
        out
    }

    fn flush(&mut self) -> Vec<(usize, Vec<f32>)> {
        self.vad.flush();
        self.drain()
    }
}

pub struct SherpaDecoder {
    recognizer: sherpa_onnx::OfflineRecognizer,
}

impl SherpaDecoder {
    pub fn create(entry: &catalog::Entry, language: Option<&str>, root: &Path) -> Result<Self, Failure> {
        let config = super::offline_config(entry, language.unwrap_or(""), root);
        sherpa_onnx::OfflineRecognizer::create(&config).map(|recognizer| Self { recognizer }).ok_or(Failure::new(Code::EngineFailed, "the speech model could not be loaded"))
    }
}

impl Decoder for SherpaDecoder {
    fn decode(&mut self, samples: &[f32]) -> Result<String, Failure> {
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(SAMPLE_RATE as i32, samples);
        self.recognizer.decode(&stream);
        Ok(stream.get_result().map(|r| r.text).unwrap_or_default())
    }
}

/// What `status` reports: whether the model and the detector are in the shared store.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub model: &'static str,
    pub present: bool,
    pub vad: bool,
    pub download_mb: u64,
}

pub fn status_in(entry: &'static catalog::Entry, root: &Path) -> Status {
    Status {
        model: entry.id,
        present: catalog::state_in(entry, root) == catalog::Installed::Yes,
        vad: super::wake::VAD.is_present_in(root),
        download_mb: (entry.set.total_size() + if super::wake::VAD.is_present_in(root) { 0 } else { super::wake::VAD.size }) / 1_000_000,
    }
}

/// Runs one transcription from the shared model store `root`. Never downloads anything.
pub fn run_transcribe(req: &Request, root: &Path) -> Result<Output, Failure> {
    let started = Instant::now();
    let file = open_input(&req.input)?;
    let status = status_in(req.entry, root);
    if !status.present || !status.vad {
        return fail(Code::ModelMissing, "the model or the voice detector is not downloaded");
    }
    let mut wav = WavReader::new(std::io::BufReader::with_capacity(1 << 16, file))?;
    let mut segmenter = SileroSegmenter::create(&super::wake::VAD.path_in(root))?;
    let mut decoder = SherpaDecoder::create(req.entry, req.language, root)?;
    let limits = Limits { max_samples: req.max_seconds * SAMPLE_RATE as u64, deadline: started + req.timeout };
    transcribe_stream(&mut wav, &mut segmenter, &mut decoder, &limits, req.entry.id, req.language)
}

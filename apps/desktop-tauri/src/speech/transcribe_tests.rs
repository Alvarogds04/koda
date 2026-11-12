//! K2-13 (S15, S16): the batch transcription helper's pure parts: arguments, the input file, the WAV reader and the
//! segment loop (with a fake detector and a fake recognizer; the real models are exercised by tests/transcribe_cli.rs).
use std::io::Cursor;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::transcribe::*;
use super::SAMPLE_RATE;

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// An absolute input path that need not exist (parsing never opens it). Built from `temp_dir()` because a literal like
/// `/tmp/a.wav` is NOT absolute on Windows, where `parse_args` refuses it as a relative input and every assertion
/// below would fail for the wrong reason.
fn absolute(name: &str) -> String {
    let path = std::env::temp_dir().join(name);
    assert!(path.is_absolute(), "{path:?}");
    path.to_string_lossy().into_owned()
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("abito-transcribe-unit-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A canonical RIFF/WAVE file: `fmt ` (+ optional extra chunk) + `data`.
fn wav_bytes(format: u16, channels: u16, rate: u32, bits: u16, data: &[u8], extra_chunk: bool) -> Vec<u8> {
    let mut fmt = Vec::new();
    fmt.extend_from_slice(&format.to_le_bytes());
    fmt.extend_from_slice(&channels.to_le_bytes());
    fmt.extend_from_slice(&rate.to_le_bytes());
    let block = channels * bits / 8;
    fmt.extend_from_slice(&(rate * block as u32).to_le_bytes());
    fmt.extend_from_slice(&block.to_le_bytes());
    fmt.extend_from_slice(&bits.to_le_bytes());
    let mut body = Vec::new();
    body.extend_from_slice(b"WAVE");
    if extra_chunk {
        // An odd-sized chunk before fmt: it is skipped, with its pad byte.
        body.extend_from_slice(b"LIST");
        body.extend_from_slice(&3u32.to_le_bytes());
        body.extend_from_slice(b"abc\0");
    }
    body.extend_from_slice(b"fmt ");
    body.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
    body.extend_from_slice(&fmt);
    body.extend_from_slice(b"data");
    body.extend_from_slice(&(data.len() as u32).to_le_bytes());
    body.extend_from_slice(data);
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

fn pcm16(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

fn read_all(bytes: Vec<u8>) -> Result<Vec<f32>, Failure> {
    let mut wav = WavReader::new(Cursor::new(bytes))?;
    let mut all = Vec::new();
    let mut block = Vec::new();
    while wav.read_block(1000, &mut block)? > 0 {
        all.extend_from_slice(&block);
    }
    Ok(all)
}

// ── Arguments ─────────────────────────────────────────────────────────────────

#[test]
fn parakeet_v3_is_the_default_model_and_whisper_turbo_the_alternative() {
    assert_eq!(MODELS, ["parakeet-tdt-0.6b-v3-int8", "whisper-turbo"]);
    let input = absolute("a.wav");
    match parse_args(&args(&["transcribe", &input])).unwrap() {
        Command::Transcribe(r) => {
            assert_eq!(r.entry.id, "parakeet-tdt-0.6b-v3-int8");
            assert_eq!(r.input, PathBuf::from(&input));
            assert_eq!(r.language, None);
        }
        _ => panic!("transcribe expected"),
    }
    match parse_args(&args(&["transcribe", "--model", "whisper-turbo", "--language", "es", &input])).unwrap() {
        Command::Transcribe(r) => {
            assert_eq!(r.entry.id, "whisper-turbo");
            assert_eq!(r.language, Some("es"));
        }
        _ => panic!("transcribe expected"),
    }
}

#[test]
fn whisper_needs_a_fixed_language_and_other_catalog_models_are_refused() {
    let code = |a: &[&str]| parse_args(&args(a)).err().map(|f| f.code);
    let input = absolute("a.wav");
    assert_eq!(code(&["transcribe", "--model", "whisper-turbo", &input]), Some(Code::LanguageRequired));
    assert_eq!(code(&["transcribe", "--model", "whisper-turbo", "--language", "auto", &input]), Some(Code::LanguageRequired));
    assert_eq!(code(&["transcribe", "--model", "whisper-small", &input]), Some(Code::UnknownModel));
    assert_eq!(code(&["transcribe", "--model", "nope", &input]), Some(Code::UnknownModel));
    assert_eq!(code(&["transcribe", "--language", "xx", &input]), Some(Code::Usage));
}

#[test]
fn bad_command_lines_are_usage_errors() {
    let code = |a: &[&str]| parse_args(&args(a)).err().map(|f| f.code);
    let (a, b) = (absolute("a.wav"), absolute("b.wav"));
    assert_eq!(code(&[]), Some(Code::Usage));
    assert_eq!(code(&["transcribe"]), Some(Code::Usage));
    assert_eq!(code(&["transcribe", "relative.wav"]), Some(Code::Usage), "the input path must be absolute");
    assert_eq!(code(&["transcribe", &a, &b]), Some(Code::Usage));
    assert_eq!(code(&["transcribe", "--bogus", &a]), Some(Code::Usage));
    assert_eq!(code(&["transcribe", "--timeout-sec", "0", &a]), Some(Code::Usage));
    assert_eq!(code(&["transcribe", "--timeout-sec", "999999", &a]), Some(Code::Usage));
    assert_eq!(code(&["download"]).is_none(), true, "download defaults to Parakeet");
    assert_eq!(code(&["status", "--model", "whisper-base"]), Some(Code::UnknownModel));
    assert_eq!(code(&["play"]), Some(Code::Usage));
}

#[test]
fn errors_are_one_json_line_with_a_closed_code() {
    let line = error_json(&Failure::new(Code::ModelMissing, "the model is not downloaded"));
    let v: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["error"], "model_missing");
    assert!(v["message"].is_string());
    assert!(!line.contains('\n'));
    for (c, s) in [(Code::Usage, "usage"), (Code::UnknownModel, "unknown_model"), (Code::LanguageRequired, "language_required"), (Code::ModelMissing, "model_missing"), (Code::BadInput, "bad_input"), (Code::BadAudio, "bad_audio"), (Code::TooLong, "too_long"), (Code::Timeout, "timeout"), (Code::EngineFailed, "engine_failed"), (Code::DownloadFailed, "download_failed")] {
        assert_eq!(c.as_str(), s);
    }
}

// ── The input file ────────────────────────────────────────────────────────────

#[cfg(unix)]
#[test]
fn only_a_regular_file_is_opened_never_a_symlink_a_directory_or_a_fifo() {
    let d = scratch("input");
    let real = d.join("a.wav");
    std::fs::write(&real, wav_bytes(1, 1, SAMPLE_RATE, 16, &pcm16(&[0; 10]), false)).unwrap();
    assert!(open_input(&real).is_ok());
    let link = d.join("link.wav");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    assert_eq!(open_input(&link).err().map(|f| f.code), Some(Code::BadInput));
    assert_eq!(open_input(&d).err().map(|f| f.code), Some(Code::BadInput));
    assert_eq!(open_input(&d.join("missing.wav")).err().map(|f| f.code), Some(Code::BadInput));
    let fifo = d.join("fifo.wav");
    let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    assert_eq!(open_input(&fifo).err().map(|f| f.code), Some(Code::BadInput));
    let _ = std::fs::remove_dir_all(&d);
}

// ── The WAV reader ────────────────────────────────────────────────────────────

#[test]
fn a_16khz_mono_pcm16_wav_is_read_as_scaled_samples_skipping_other_chunks() {
    let samples = read_all(wav_bytes(1, 1, SAMPLE_RATE, 16, &pcm16(&[0, 16384, -32768, 32767]), true)).unwrap();
    assert_eq!(samples.len(), 4);
    assert_eq!(samples[0], 0.0);
    assert!((samples[1] - 0.5).abs() < 1e-6);
    assert!((samples[2] + 1.0).abs() < 1e-6);
    assert!(samples[3] > 0.999);
}

#[test]
fn a_float32_wav_is_read_too() {
    let data: Vec<u8> = [0.25f32, -0.5].iter().flat_map(|s| s.to_le_bytes()).collect();
    assert_eq!(read_all(wav_bytes(3, 1, SAMPLE_RATE, 32, &data, false)).unwrap(), vec![0.25, -0.5]);
}

#[test]
fn anything_but_16khz_mono_pcm_is_refused_as_bad_audio() {
    let code = |b: Vec<u8>| read_all(b).err().map(|f| f.code);
    assert_eq!(code(wav_bytes(1, 1, 44_100, 16, &pcm16(&[0; 4]), false)), Some(Code::BadAudio), "wrong rate");
    assert_eq!(code(wav_bytes(1, 2, SAMPLE_RATE, 16, &pcm16(&[0; 4]), false)), Some(Code::BadAudio), "stereo");
    assert_eq!(code(wav_bytes(1, 1, SAMPLE_RATE, 8, &[0; 4], false)), Some(Code::BadAudio), "8-bit");
    assert_eq!(code(wav_bytes(2, 1, SAMPLE_RATE, 16, &pcm16(&[0; 4]), false)), Some(Code::BadAudio), "ADPCM");
    assert_eq!(code(b"OggS\0\0\0\0\0\0\0\0\0\0\0\0".to_vec()), Some(Code::BadAudio), "not RIFF");
    assert_eq!(code(b"RIFF".to_vec()), Some(Code::BadAudio), "truncated");
    let mut no_data = wav_bytes(1, 1, SAMPLE_RATE, 16, &[], false);
    no_data.truncate(no_data.len() - 8);
    assert_eq!(code(no_data), Some(Code::BadAudio), "no data chunk");
}

// ── The segment loop ──────────────────────────────────────────────────────────

/// Fake detector: every `every` samples of input become one «speech» segment.
struct Chunker {
    every: usize,
    pending: Vec<f32>,
    at: usize,
}

impl Segmenter for Chunker {
    fn feed(&mut self, samples: &[f32]) -> Vec<(usize, Vec<f32>)> {
        self.pending.extend_from_slice(samples);
        let mut out = vec![];
        while self.pending.len() >= self.every {
            let rest = self.pending.split_off(self.every);
            out.push((self.at, std::mem::replace(&mut self.pending, rest)));
            self.at += self.every;
        }
        out
    }
    fn flush(&mut self) -> Vec<(usize, Vec<f32>)> {
        if self.pending.is_empty() {
            return vec![];
        }
        let at = self.at;
        self.at += self.pending.len();
        vec![(at, std::mem::take(&mut self.pending))]
    }
}

/// Fake recognizer: records every stretch it is given and «hears» its length.
#[derive(Default)]
struct Recorder {
    lengths: Vec<usize>,
    silent: bool,
}

impl Decoder for Recorder {
    fn decode(&mut self, samples: &[f32]) -> Result<String, Failure> {
        self.lengths.push(samples.len());
        Ok(if self.silent { String::new() } else { format!("w{}", samples.len()) })
    }
}

fn wav_of_seconds(seconds: usize) -> Vec<u8> {
    wav_bytes(1, 1, SAMPLE_RATE, 16, &pcm16(&vec![1000i16; seconds * SAMPLE_RATE as usize]), false)
}

fn limits(max_seconds: u64) -> Limits {
    Limits { max_samples: max_seconds * SAMPLE_RATE as u64, deadline: Instant::now() + Duration::from_secs(60) }
}

#[test]
fn no_stretch_longer_than_25_seconds_ever_reaches_the_model() {
    // One 70 s «speech» segment (the detector's own cap is not strict): the helper cuts it to <= 25 s pieces.
    let mut wav = WavReader::new(Cursor::new(wav_of_seconds(70))).unwrap();
    let mut seg = Chunker { every: 70 * SAMPLE_RATE as usize, pending: vec![], at: 0 };
    let mut dec = Recorder::default();
    let out = transcribe_stream(&mut wav, &mut seg, &mut dec, &limits(3600), "parakeet-tdt-0.6b-v3-int8", None).unwrap();
    assert!(dec.lengths.len() >= 3, "{:?}", dec.lengths);
    assert!(dec.lengths.iter().all(|&n| n as f64 <= MAX_SEGMENT_SECONDS * SAMPLE_RATE as f64), "{:?}", dec.lengths);
    assert_eq!(dec.lengths.iter().sum::<usize>(), 70 * SAMPLE_RATE as usize, "nothing is dropped");
    assert!(MAX_SEGMENT_SECONDS <= 25.0);
    assert_eq!(out.segments.len(), dec.lengths.len());
    assert_eq!(out.segments[0].start, 0.0);
    for pair in out.segments.windows(2) {
        assert!((pair[0].end - pair[1].start).abs() < 1e-9, "pieces are contiguous: {:?}", out.segments);
    }
    assert!((out.duration_sec - 70.0).abs() < 1e-9);
    assert_eq!(out.model, "parakeet-tdt-0.6b-v3-int8");
}

#[test]
fn segments_carry_their_time_and_the_text_is_their_join() {
    let mut wav = WavReader::new(Cursor::new(wav_of_seconds(10))).unwrap();
    let mut seg = Chunker { every: 4 * SAMPLE_RATE as usize, pending: vec![], at: 0 };
    let mut dec = Recorder::default();
    let out = transcribe_stream(&mut wav, &mut seg, &mut dec, &limits(3600), "whisper-turbo", Some("es")).unwrap();
    let times: Vec<(f64, f64)> = out.segments.iter().map(|s| (s.start, s.end)).collect();
    assert_eq!(times, vec![(0.0, 4.0), (4.0, 8.0), (8.0, 10.0)]);
    assert_eq!(out.text, "w64000 w64000 w32000");
    assert_eq!(out.language.as_deref(), Some("es"));
    let json: serde_json::Value = serde_json::from_str(&output_json(&out)).unwrap();
    assert_eq!(json["text"], "w64000 w64000 w32000");
    assert_eq!(json["durationSec"], 10.0);
    assert_eq!(json["segments"][1]["start"], 4.0);
    assert_eq!(json["model"], "whisper-turbo");
}

#[test]
fn silence_and_tiny_stretches_produce_no_segment() {
    let mut wav = WavReader::new(Cursor::new(wav_of_seconds(3))).unwrap();
    let mut seg = Chunker { every: SAMPLE_RATE as usize / 10, pending: vec![], at: 0 };
    let mut dec = Recorder::default();
    let out = transcribe_stream(&mut wav, &mut seg, &mut dec, &limits(3600), "parakeet-tdt-0.6b-v3-int8", None).unwrap();
    assert!(dec.lengths.is_empty(), "stretches under 0.25 s are not decoded");
    assert_eq!(out.text, "");
    assert!(out.segments.is_empty());
    let mut wav = WavReader::new(Cursor::new(wav_of_seconds(3))).unwrap();
    let mut seg = Chunker { every: SAMPLE_RATE as usize, pending: vec![], at: 0 };
    let mut dec = Recorder { silent: true, ..Default::default() };
    let out = transcribe_stream(&mut wav, &mut seg, &mut dec, &limits(3600), "parakeet-tdt-0.6b-v3-int8", None).unwrap();
    assert_eq!(dec.lengths.len(), 3);
    assert!(out.segments.is_empty(), "an empty transcript is not a segment");
}

#[test]
fn audio_over_the_limit_stops_with_too_long() {
    let mut wav = WavReader::new(Cursor::new(wav_of_seconds(5))).unwrap();
    let mut seg = Chunker { every: SAMPLE_RATE as usize, pending: vec![], at: 0 };
    let mut dec = Recorder::default();
    let err = transcribe_stream(&mut wav, &mut seg, &mut dec, &limits(2), "parakeet-tdt-0.6b-v3-int8", None).err().unwrap();
    assert_eq!(err.code, Code::TooLong);
}

#[test]
fn a_passed_deadline_stops_with_timeout() {
    let mut wav = WavReader::new(Cursor::new(wav_of_seconds(5))).unwrap();
    let mut seg = Chunker { every: SAMPLE_RATE as usize, pending: vec![], at: 0 };
    let mut dec = Recorder::default();
    let past = Limits { max_samples: u64::MAX, deadline: Instant::now() - Duration::from_millis(1) };
    let err = transcribe_stream(&mut wav, &mut seg, &mut dec, &past, "parakeet-tdt-0.6b-v3-int8", None).err().unwrap();
    assert_eq!(err.code, Code::Timeout);
}

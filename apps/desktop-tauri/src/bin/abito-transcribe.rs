//! abito-transcribe — K2-13 (S8, S15, S16): batch speech-to-text for the Minikodas, spawned by the daemon with
//! `shell:false` and a fixed argv. It reuses dictation's sherpa-onnx engine, model catalog, model store
//! (`$XDG_DATA_HOME/abito/Models`) and Silero VAD; see `abito_island::speech::transcribe` for the contract.
//!
//!   abito-transcribe transcribe [--model ID] [--language L] [--timeout-sec N] [--max-seconds N] <abs.wav>
//!   abito-transcribe status   [--model ID]   -> {model, present, vad, downloadMb}
//!   abito-transcribe download [--model ID]   -> the catalog's pinned, SHA-256-checked download (explicit action)
//!
//! stdout carries exactly ONE JSON line: the result, or `{error, message}` with a closed code. Only `download`
//! touches the network. No GUI, no logging of audio or text to stderr.
use std::io::Write as _;

use abito_island::speech::{self, transcribe as t};

fn print_line(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn run(args: &[String]) -> Result<String, t::Failure> {
    let root = speech::models_dir();
    match t::parse_args(args)? {
        t::Command::Status { entry } => Ok(serde_json::to_string(&t::status_in(entry, &root)).unwrap_or_default()),
        t::Command::Download { entry } => {
            let progress = |f: f64| {
                let _ = writeln!(std::io::stderr(), "{{\"progress\":{:.3}}}", f.clamp(0.0, 1.0));
            };
            speech::download_set_now(entry.set, &progress).map_err(|_| t::Failure::new(t::Code::DownloadFailed, "the model download failed or was not the expected file"))?;
            speech::wake::download_now().map_err(|_| t::Failure::new(t::Code::DownloadFailed, "the voice detector download failed or was not the expected file"))?;
            Ok(serde_json::to_string(&t::status_in(entry, &root)).unwrap_or_default())
        }
        t::Command::Transcribe(req) => t::run_transcribe(&req, &root).map(|out| t::output_json(&out)),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(line) => print_line(&line),
        Err(f) => {
            print_line(&t::error_json(&f));
            std::process::exit(f.code.exit_code());
        }
    }
}

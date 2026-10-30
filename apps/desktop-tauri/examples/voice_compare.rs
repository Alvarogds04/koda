//! Dev-only: compare the speech models on YOUR voice.
//!   voice_compare download whisper-small     explicit, pinned SHA-256, official source
//!   voice_compare [N]                        say «OK Abito, ¿qué hora es?» N times (default 5)
//! The clips stay in memory only and are gone when the program ends. Nothing is sent anywhere.
use abito_island::speech::{self, audio, catalog, wake, ModelState};
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("download") {
        let id = args.get(1).map(String::as_str).unwrap_or("");
        let e = catalog::find(id).unwrap_or_else(|| panic!("unknown model {id}; one of {:?}", catalog::entries().iter().map(|e| e.id).collect::<Vec<_>>()));
        println!("{} — {} MB, {} — {}", e.name, e.size_mb(), e.license, e.set.files[0].url);
        speech::download_model(id, |s| {
            if let ModelState::Downloading { fraction } = s { eprint!("\r{:.0} %   ", fraction * 100.0) }
        })
        .unwrap();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            match speech::model_state(id) {
                ModelState::Downloading { .. } => {}
                s => {
                    println!("\n{s:?}");
                    return;
                }
            }
        }
    }
    if args.first().map(String::as_str) == Some("selftest") {
        // Loads each installed model and decodes 2 s of silence: proves the configuration is valid.
        for e in catalog::entries().iter().filter(|e| speech::model_state(e.id) == ModelState::Ready) {
            speech::set_active(e.id, "es");
            let t = Instant::now();
            println!("{}: {:?} in {:?}", e.name, speech::transcribe_raw(&vec![0.0; 32_000]), t.elapsed());
        }
        return;
    }
    let n: usize = args.first().and_then(|a| a.parse().ok()).unwrap_or(5);
    assert!(wake::VAD.is_present(), "the voice detector is not installed (turn on OK Abito in Ajustes first)");
    let mut vad = wake::SileroGate::create(&wake::VAD.path(), wake::params(50)).expect("vad");
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let capture = audio::Capture::start(audio::Source::Mic(None), move |s| {
        let _ = tx.send(s.to_vec());
    })
    .expect("microphone");
    let mut clips: Vec<Vec<f32>> = vec![];
    println!("Decí «OK Abito, ¿qué hora es?» {n} veces, con una pausa entre cada una.");
    let deadline = Instant::now() + Duration::from_secs(30 * n as u64);
    while clips.len() < n && Instant::now() < deadline {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
            for seg in vad.feed(&chunk) {
                clips.push(wake::clip(&seg).to_vec());
                println!("  clip {}/{n} ({:.1} s)", clips.len(), seg.len() as f32 / speech::SAMPLE_RATE as f32);
            }
        }
    }
    drop(capture);
    println!();
    for e in catalog::entries() {
        if speech::model_state(e.id) != ModelState::Ready {
            println!("== {} — no descargado, se omite", e.name);
            continue;
        }
        speech::set_active(e.id, "es");
        println!("== {} (idioma {})", e.name, if e.forces_language { "es fijo" } else { "automático" });
        let (mut hits_raw, mut hits_fixed) = (0, 0);
        for (i, clip) in clips.iter().enumerate() {
            let t = Instant::now();
            let raw = speech::transcribe_raw(clip).unwrap_or_default();
            let ms = t.elapsed().as_millis();
            let fixed = speech::words::correct(&raw, &[]);
            let (wr, wf) = (wake::match_wake(&raw, 1).is_some(), wake::match_wake(&fixed, 1).is_some());
            hits_raw += wr as usize;
            hits_fixed += wf as usize;
            println!("  {}. {:?} -> con «Abito» corregido {:?} | despierta: {} / {} | {} ms", i + 1, raw, fixed, wr, wf, ms);
        }
        println!("  despertó {hits_raw}/{} sin corrección, {hits_fixed}/{} con corrección\n", clips.len(), clips.len());
    }
}

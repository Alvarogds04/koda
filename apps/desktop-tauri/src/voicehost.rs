//! «OK Abito» host: the one closed `voice_action` command (status | set_prefs |
//! download_model | remove_model) and the wake loop. The microphone is only open
//! while the Voice switch is on AND the keyword model is installed.
//!
//! Adapted from Coucou NotchBuddy Voice/VoiceEngine.swift @71b773f, Copyright (c) 2026
//! Louis Raillé, MIT. Events for the island (the hook is wired by the island worker):
//! `voice-wake` {} when the phrase is heard, then `voice-command` {text} with what was
//! said after it (or `voice-timeout` {} when nothing was).
use crate::{now_ms, AppState};
use abito_island::bridge::{self, BridgeError};
use abito_island::speech::{self, audio, catalog, train, wake};
use abito_island::prefs::Command as PrefsCommand;
use abito_island::voicecmd::{self, Command, VoicePrefs};
use abito_island::voiceintent::{self, Effect, Hands, MusicOp, Outcome, Session, World};
use abito_island::voicespeak::{self, Engine, Voices};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::{mpsc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// Runs voice effects against the real app. Every effect is one of the closed
/// `voiceintent::Effect` values; URLs are https and built by the planner.
struct AppHands {
    app: AppHandle,
}

impl Hands for AppHands {
    fn world(&self) -> World {
        let p = crate::settingshost::voice_prefs_snapshot(&self.app);
        let (running, playing, volume, now) = music_state(&self.app);
        World { main: p.main_pill().to_string(), active: p.declared_pills(), music_running: running, playing, volume, now_playing: now }
    }

    fn apply(&self, effect: &Effect) -> bool {
        match effect {
            Effect::Music(op) => music_control(&self.app, op),
            Effect::TogglePill(id) => crate::settingshost::voice_prefs_command(&self.app, &PrefsCommand::ToggleDeclaredPill(id.clone())).is_some(),
            Effect::SetMainPill(id) => crate::settingshost::voice_prefs_command(&self.app, &PrefsCommand::SetMainPill(id.clone())).is_some(),
            Effect::OpenUrl(url) => url.starts_with("https://") && spawn_detached("xdg-open", Some(url)),
            Effect::OpenApp(bin) => spawn_detached(bin, None),
            Effect::AskChat(text) => self.app.emit("voice-ask", json!({ "text": text })).is_ok(),
        }
    }
}

fn spawn_detached(program: &str, arg: Option<&str>) -> bool {
    let mut c = std::process::Command::new(program);
    if let Some(a) = arg {
        c.arg(a);
    }
    c.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    match c.spawn() {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            true
        }
        Err(_) => false,
    }
}

#[cfg(target_os = "linux")]
fn music_state(app: &AppHandle) -> (bool, bool, u8, Option<(String, Option<String>)>) {
    let s = crate::spotifyhost::state_of(app);
    (s.0, s.1, s.2, s.3)
}
#[cfg(not(target_os = "linux"))]
fn music_state(_app: &AppHandle) -> (bool, bool, u8, Option<(String, Option<String>)>) {
    (false, false, 50, None)
}

fn music_control(app: &AppHandle, op: &MusicOp) -> bool {
    let action = match op {
        MusicOp::PlayPause => abito_island::spotify::Action::PlayPause,
        MusicOp::Next => abito_island::spotify::Action::Next,
        MusicOp::Previous => abito_island::spotify::Action::Previous,
        MusicOp::Volume(v) => abito_island::spotify::Action::Volume(*v),
    };
    crate::spotifyhost::control(app, action)
}

/// Real sound. The system voice is `spd-say`; ElevenLabs is the user's own key, asked only
/// when they chose it, with raw PCM played through `aplay`. Never used by tests.
struct RealVoices;

impl Voices for RealVoices {
    fn system(&self, text: &str, lang: voiceintent::Lang, gender: voicecmd::Gender) -> bool {
        std::process::Command::new("spd-say")
            .args(voicespeak::spd_args(text, lang, gender))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn eleven(&self, text: &str, gender: voicecmd::Gender) -> bool {
        use abito_island::secrets::{Keychain, SecretStore};
        let Some(key) = Keychain.read(voicespeak::KEY_NAME).ok().flatten().filter(|k| !k.is_empty()) else { return false };
        let run = async {
            let client = reqwest::Client::builder()
                .https_only(true)
                .timeout(std::time::Duration::from_secs(8))
                .user_agent(concat!("Abito/", env!("CARGO_PKG_VERSION")))
                .build()
                .ok()?;
            let list = client.get("https://api.elevenlabs.io/v1/voices").header("xi-api-key", &key).send().await.ok()?;
            if !list.status().is_success() {
                return None;
            }
            let voices: Value = serde_json::from_str(&list.text().await.ok()?).ok()?;
            let (id, _) = voicespeak::pick_voice(&voices, gender)?;
            let (url, body) = voicespeak::tts_request(&id, text);
            let r = client.post(url).header("xi-api-key", &key).header("content-type", "application/json").body(body).send().await.ok()?;
            if !r.status().is_success() {
                return None;
            }
            r.bytes().await.ok().filter(|b| !b.is_empty())
        };
        let audio = tokio::runtime::Builder::new_current_thread().enable_all().build().ok().and_then(|rt| rt.block_on(run));
        let Some(audio) = audio else { return false };
        let Ok(mut child) = std::process::Command::new("aplay")
            .args(voicespeak::PLAY_RAW_ARGS)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        else {
            return false;
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(&audio);
        }
        child.wait().map(|s| s.success()).unwrap_or(false)
    }
}

struct Listener {
    capture: Option<audio::Capture>,
    threads: Vec<std::thread::JoinHandle<()>>,
}
impl Drop for Listener {
    fn drop(&mut self) {
        // Closing the device drops the sender, which ends the worker.
        self.capture.take();
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

pub struct Host {
    prefs: VoicePrefs,
    listener: Option<Listener>,
    last_error: Option<String>,
    /// How this person's «OK Abito» is transcribed (text only), and the training in progress.
    learned: train::Learned,
    trainer: train::Trainer,
    speech: catalog::SpeechPrefs,
}

/// Hears ONE phrase through the same path as the live listener: microphone, Silero VAD, Parakeet.
/// The audio lives only in memory and is dropped as soon as it is transcribed.
struct MicRecorder {
    sensitivity: u8,
}

impl train::Recorder for MicRecorder {
    fn hear(&self) -> Result<Option<String>, String> {
        let params = wake::params(self.sensitivity);
        let mut vad = wake::SileroGate::create(&wake::VAD.path(), params).ok_or("the voice detector could not be loaded")?;
        let (tx, rx) = mpsc::channel::<Vec<f32>>();
        let capture = audio::Capture::start(audio::Source::Mic(None), move |s| {
            let _ = tx.send(s.to_vec());
        })?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let mut segment = None;
        while segment.is_none() {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                break;
            }
            match rx.recv_timeout(left) {
                Ok(chunk) => segment = vad.feed(&chunk).into_iter().next(),
                Err(_) => break,
            }
        }
        drop(capture);
        Ok(segment.and_then(|seg| speech::transcribe_raw(wake::clip(&seg))))
    }
}

fn training_json(h: &Host) -> Value {
    json!({ "recorded": h.trainer.recorded(), "target": train::TARGET, "active": h.trainer.active(), "last": h.trainer.last(), "learned": h.learned })
}

fn slot_prefs(app: &AppHandle) -> VoicePrefs {
    app.state::<Mutex<Host>>().lock().expect("voice host").prefs
}

/// Wake-phrase diagnostics are opt-in: the heard text is private and is logged only when
/// Abito was started with `ABITO_VOICE_DEBUG=1`.
fn voice_debug() -> bool {
    voice_debug_from(std::env::var("ABITO_VOICE_DEBUG").ok().as_deref())
}

fn voice_debug_from(value: Option<&str>) -> bool {
    value == Some("1")
}

#[cfg(test)]
mod voice_debug_tests {
    use super::voice_debug_from;

    #[test]
    fn heard_text_is_logged_only_when_explicitly_enabled() {
        assert!(voice_debug_from(Some("1")));
        for off in [None, Some(""), Some("0"), Some("true"), Some("yes")] {
            assert!(!voice_debug_from(off), "{off:?} must keep the heard text out of the log");
        }
    }
}

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo completar la acción de voz.".into() }
}

fn command_reply(handle: &AppHandle, session: &mut Session, hands: &AppHands, text: &str, speaking: &AtomicBool, segments: &mpsc::Receiver<Vec<f32>>) -> bool {
    let _ = handle.emit("voice-command", json!({ "text": text }));
    let reply = session.handle(text, hands);
    let outcome = match &reply.outcome {
        Outcome::Success => "success",
        Outcome::Failure => "failure",
        Outcome::Question(_) => "question",
    };
    let _ = handle.emit("voice-result", json!({ "outcome": outcome, "message": reply.message, "lang": if reply.lang == voiceintent::Lang::En { "en" } else { "es" } }));
    let prefs = slot_prefs(handle);
    let engine = {
        use abito_island::secrets::{Keychain, SecretStore};
        let has_key = Keychain.read(voicespeak::KEY_NAME).ok().flatten().is_some_and(|k| !k.is_empty());
        voicespeak::engine_for(prefs.output, has_key)
    };
    if engine != Engine::None {
        speaking.store(true, Ordering::Relaxed);
        voicespeak::speak(&RealVoices, &reply.message, reply.lang, prefs.gender, engine);
        // A short gap, then drop what the room echoed while it talked.
        std::thread::sleep(std::time::Duration::from_millis(250));
        while segments.try_recv().is_ok() {}
        speaking.store(false, Ordering::Relaxed);
    }
    reply.rearm
}

/// Two threads: the first runs the voice-activity detector over the microphone and offers
/// each finished speech segment; the second owns the recognizer, drops nothing it is given
/// but is only given one segment at a time (a busy recognizer means the segment is dropped).
fn start_listener(app: &AppHandle, sensitivity: u8) -> Result<Listener, String> {
    let params = wake::params(sensitivity);
    let mut gate_vad = wake::SileroGate::create(&wake::VAD.path(), params).ok_or("the voice detector could not be loaded")?;
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let (seg_tx, seg_rx) = mpsc::sync_channel::<Vec<f32>>(1);
    // The microphone is ignored while Abito speaks, so it never hears itself.
    let speaking = Arc::new(AtomicBool::new(false));
    let gate = speaking.clone();
    let handle = app.clone();
    let vad_thread = std::thread::Builder::new()
        .name("abito-vad".into())
        .spawn(move || {
            while let Ok(chunk) = rx.recv() {
                for seg in gate_vad.feed(&chunk) {
                    if !wake::offer(&seg_tx, seg) {
                        eprintln!("abito voice: recognizer busy, segment dropped");
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
    let recognizer_thread = std::thread::Builder::new()
        .name("abito-wake".into())
        .spawn(move || {
            let mut flow = wake::WakeFlow::new();
            let hands = AppHands { app: handle.clone() };
            let mut session = Session::default();
            let mut last = std::time::Instant::now();
            loop {
                match seg_rx.recv_timeout(std::time::Duration::from_millis(250)) {
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let samples = (last.elapsed().as_secs_f64() * speech::SAMPLE_RATE as f64) as usize;
                        last = std::time::Instant::now();
                        for ev in flow.advance(samples) {
                            if ev == wake::FlowEvent::Timeout {
                                session.timeout();
                                let _ = handle.emit("voice-timeout", json!({}));
                            }
                        }
                    }
                    Ok(seg) => {
                        let started = std::time::Instant::now();
                        let text = speech::transcribe(wake::clip(&seg)).unwrap_or_default();
                        eprintln!("abito voice: {:.1}s segment transcribed in {:?}", seg.len() as f32 / speech::SAMPLE_RATE as f32, started.elapsed());
                        let tolerance = wake::params(slot_prefs(&handle).sensitivity).tolerance;
                        // Diagnostics for wake-phrase tests only: the heard text is private, so it is
                        // logged ONLY when the developer starts Abito with ABITO_VOICE_DEBUG=1.
                        if voice_debug() {
                            eprintln!("abito voice: heard {:?} (normalised {:?}, tolerance {})", text, voiceintent::normalise(&text), tolerance);
                        }
                        flow.set_learned(handle.state::<Mutex<Host>>().lock().expect("voice host").learned.clone());
                        for ev in flow.on_transcript(&text, tolerance) {
                            match ev {
                                wake::FlowEvent::Wake => {
                                    let _ = handle.emit("voice-wake", json!({}));
                                }
                                wake::FlowEvent::Timeout => {
                                    session.timeout();
                                    let _ = handle.emit("voice-timeout", json!({}));
                                }
                                wake::FlowEvent::Command(cmd) => {
                                    if command_reply(&handle, &mut session, &hands, &cmd, &speaking, &seg_rx) {
                                        flow.arm();
                                    }
                                }
                            }
                        }
                        last = std::time::Instant::now();
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
    let capture = audio::Capture::start(audio::Source::Mic(None), move |s| {
        if !gate.load(Ordering::Relaxed) {
            let _ = tx.send(s.to_vec());
        }
    })?;
    Ok(Listener { capture: Some(capture), threads: vec![vad_thread, recognizer_thread] })
}

/// Applies the preference and the model state: decide under the lock, open/close outside it.
fn sync(app: &AppHandle) {
    let slot = app.state::<Mutex<Host>>();
    let (want, running) = {
        let h = slot.lock().expect("voice host");
        // abito-pausa: «OK Abito» is paused in this version — the microphone listener never starts (the stored preference is kept)
        (abito_island::paused::effective(abito_island::paused::Feature::Voice, h.prefs.enabled) && wake::VAD.is_present() && speech::is_ready(), h.listener.is_some())
    };
    if want && !running {
        let sens = slot.lock().expect("voice host").prefs.sensitivity;
        let result = start_listener(app, sens);
        let mut h = slot.lock().expect("voice host");
        match result {
            Ok(l) if abito_island::paused::effective(abito_island::paused::Feature::Voice, h.prefs.enabled) => {
                h.listener = Some(l);
                h.last_error = None;
            }
            Ok(l) => {
                drop(h);
                drop(l);
            }
            Err(e) => {
                // #503 S1: a local failure record with a CLOSED class only; the error text (`e`) is never passed on.
                let class = if wake::VAD.is_present() { abito_island::failure::ModelError::Other } else { abito_island::failure::ModelError::MissingFile };
                abito_island::failure::report("voice", "model-load-failed", abito_island::failure::Reason::ModelLoadFailed(class), None);
                h.last_error = Some(e);
            }
        }
    } else if !want && running {
        let old = slot.lock().expect("voice host").listener.take();
        std::thread::spawn(move || drop(old));
    }
}

fn speech_json(h: &Host) -> Value {
    let root = speech::models_dir();
    let models: Vec<Value> = catalog::entries()
        .iter()
        .map(|e| json!({
            "id": e.id, "name": e.name, "sizeMb": e.size_mb(), "languages": e.languages, "forcesLanguage": e.forces_language,
            "license": e.license, "note": e.note, "state": speech::model_state(e.id), "installed": catalog::state_in(e, &root) == catalog::Installed::Yes,
            "active": e.id == h.speech.model,
        }))
        .collect();
    json!({ "language": h.speech.language, "model": h.speech.model, "words": h.speech.words, "languages": catalog::LANGUAGES, "models": models })
}

pub fn start(app: &AppHandle) {
    let speech_prefs = catalog::load_prefs_in(&voicecmd::prefs_dir());
    speech::set_active(&speech_prefs.model, &speech_prefs.language);
    speech::set_custom_words(&speech_prefs.words);
    app.manage(Mutex::new(Host { prefs: voicecmd::load_prefs_in(&voicecmd::prefs_dir()), listener: None, last_error: None, learned: train::load_in(&voicecmd::prefs_dir()), trainer: train::Trainer::default(), speech: speech_prefs }));
    let app = app.clone();
    std::thread::spawn(move || sync(&app));
}

fn status_json(app: &AppHandle) -> Value {
    let h = app.state::<Mutex<Host>>();
    let h = h.lock().expect("voice host");
    json!({
        "prefs": h.prefs,
        "vad": wake::status(),
        "downloadMb": 1,
        "parakeet": speech::status().parakeet,
        "listening": h.listener.is_some(),
        "error": h.last_error,
        "training": training_json(&h),
        "speech": speech_json(&h),
    })
}

#[tauri::command]
pub async fn voice_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let command = voicecmd::parse_command(&payload).ok_or_else(|| err("invalid_schema"))?;
    tauri::async_runtime::spawn_blocking(move || match command.clone() {
        Command::Status => Ok(status_json(&app)),
        Command::SetPrefs(prefs) => {
            voicecmd::save_prefs_in(&voicecmd::prefs_dir(), &prefs).map_err(|_| err("save_failed"))?;
            let old = {
                let slot = app.state::<Mutex<Host>>();
                let mut h = slot.lock().expect("voice host");
                let changed = h.prefs.sensitivity != prefs.sensitivity;
                h.prefs = prefs;
                // The threshold is fixed when the spotter loads: reopen with the new one.
                if changed { h.listener.take() } else { None }
            };
            drop(old);
            sync(&app);
            Ok(status_json(&app))
        }
        Command::Download => {
            let a = app.clone();
            wake::download(move |_| {
                let _ = a.emit("voice-model", status_json(&a));
                sync(&a);
            });
            Ok(status_json(&app))
        }
        Command::TrainRecord => {
            // The microphone belongs to the training while it hears: pause the wake listener, then restore it.
            let (old, sensitivity, mut trainer) = {
                let slot = app.state::<Mutex<Host>>();
                let mut h = slot.lock().expect("voice host");
                (h.listener.take(), h.prefs.sensitivity, std::mem::take(&mut h.trainer))
            };
            drop(old);
            let result = trainer.record(&MicRecorder { sensitivity });
            {
                let slot = app.state::<Mutex<Host>>();
                let mut h = slot.lock().expect("voice host");
                h.trainer = trainer;
                h.last_error = result.as_ref().err().cloned();
            }
            sync(&app);
            Ok(status_json(&app))
        }
        Command::TrainUndo | Command::TrainCancel => {
            let slot = app.state::<Mutex<Host>>();
            let mut h = slot.lock().expect("voice host");
            if command == Command::TrainUndo { h.trainer.undo() } else { h.trainer.cancel() }
            drop(h);
            Ok(status_json(&app))
        }
        Command::TrainFinish => {
            let slot = app.state::<Mutex<Host>>();
            let mut h = slot.lock().expect("voice host");
            match h.trainer.finish() {
                Ok(learned) => {
                    train::save_in(&voicecmd::prefs_dir(), &learned).map_err(|_| err("save_failed"))?;
                    h.learned = learned;
                    h.last_error = None;
                }
                Err(e) => h.last_error = Some(e),
            }
            drop(h);
            Ok(status_json(&app))
        }
        Command::TrainReset => {
            train::reset_in(&voicecmd::prefs_dir()).map_err(|_| err("save_failed"))?;
            let slot = app.state::<Mutex<Host>>();
            let mut h = slot.lock().expect("voice host");
            h.learned = train::Learned::default();
            h.trainer.cancel();
            drop(h);
            Ok(status_json(&app))
        }
        Command::SetSpeech { language, model, words } => {
            let prefs = catalog::SpeechPrefs { language, model, words }.sanitised();
            // Only a downloaded model can be put in use.
            if catalog::find(&prefs.model).is_some_and(|e| !e.set.is_present()) {
                return Err(err("model_missing"));
            }
            catalog::save_prefs_in(&voicecmd::prefs_dir(), &prefs).map_err(|_| err("save_failed"))?;
            speech::set_active(&prefs.model, &prefs.language);
            speech::set_custom_words(&prefs.words);
            app.state::<Mutex<Host>>().lock().expect("voice host").speech = prefs;
            // The loaded model changed: reopen the listener on the new one.
            let old = app.state::<Mutex<Host>>().lock().expect("voice host").listener.take();
            drop(old);
            sync(&app);
            Ok(status_json(&app))
        }
        Command::ModelDownload(id) => {
            let a = app.clone();
            speech::download_model(&id, move |_| {
                let _ = a.emit("voice-model", status_json(&a));
            })
            .map_err(|_| err("unavailable"))?;
            Ok(status_json(&app))
        }
        Command::ModelCancel(id) => {
            speech::cancel_model(&id);
            Ok(status_json(&app))
        }
        Command::ModelDelete(id) => {
            speech::delete_model(&id).map_err(|_| err("in_use"))?;
            Ok(status_json(&app))
        }
        Command::Remove => {
            let old = app.state::<Mutex<Host>>().lock().expect("voice host").listener.take();
            drop(old);
            wake::remove();
            Ok(status_json(&app))
        }
    })
    .await
    .map_err(|_| err("unavailable"))?
}

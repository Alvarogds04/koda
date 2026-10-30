//! Dictation: hold a key, speak, let go, and the words wait on the clipboard.
//!
//! Adapted from Coucou src-tauri/src/flow/mod.rs @434d6a2b,
//! Copyright (c) 2026 Louis Raillé, MIT. Differences by design:
//! - OFF until the user turns it on; nothing here starts a model download;
//! - the key comes from the desktop's GlobalShortcuts portal (`portal.rs`),
//!   never from a global keyboard listener;
//! - no window or pill in this module: it reports through a `Notify` callback;
//! - the optional clean-up (`cleanup.rs`) runs only with `prefs.cleanup` on AND a
//!   provider supplied by the host through `Backend::cleanup_provider`.
//!
//! One thread owns the dictation. Key events go through `KeyLogic`; the
//! microphone opens on the first press; on release the words go to the local
//! model, then the dictionary and snippets, then the clipboard. The thread
//! sleeps on its channel while nothing happens.

pub mod cleanup;
pub mod claude;
pub mod logic;
pub mod paste;
pub mod portal;
pub mod store;
pub mod text;

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::speech::audio;
use logic::{Action, KeyLogic};
use store::Store;

/// What reaches the dictation thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEvent {
    Down,
    Up,
    /// Another key while the dictation key is held: a shortcut.
    Other,
    Escape,
    /// The pill's microphone: hands-free straight away.
    HandsFree,
    /// The pill's ✓: paste now.
    Finish,
    /// The pill's ✕.
    Cancel,
    Quit,
}

/// What the pill (or any UI) shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Listening,
    Locked,
    Thinking,
    /// The words are on the clipboard: press Ctrl+V.
    Copied,
    Failed,
}

/// Something the user has to be told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Note {
    /// The voice model is not downloaded: the user must ask for it in Settings.
    NeedModel,
    NoMicrophone,
    ClipboardRefused,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    Phase(Phase),
    Bands([f32; audio::BAND_COUNT]),
    /// The input level, 0..1 (see `audio::LevelMeter`): what the Dictado page's meter shows.
    Level(f32),
    Note(Note),
}

pub type Notify = Arc<dyn Fn(Update) + Send + Sync>;

/// A microphone take in progress.
pub trait Recording: Send {
    /// Stops and returns (16 kHz samples, loudest sample).
    fn finish(self: Box<Self>) -> (Vec<f32>, f32);
    fn levels(&self) -> [f32; audio::BAND_COUNT];
    /// The level of the input since the last call, None when no frames arrived.
    fn level(&self) -> Option<f32> {
        None
    }
}

/// Everything the thread needs from the machine; fakes in the tests.
pub trait Backend: Send + Sync + 'static {
    fn foreground_app(&self) -> Option<(String, String)> { None }
    fn model_ready(&self) -> bool;
    fn record(&self, mic: &str) -> Result<Box<dyn Recording>, String>;
    fn transcribe(&self, samples: &[f32]) -> Option<String>;
    fn deliver(&self, text: &str) -> paste::Outcome;
    /// The host's language-model link for the optional clean-up. None by default.
    fn cleanup_provider(&self) -> Option<&dyn cleanup::CleanupProvider> {
        None
    }
}

/// The real machine: cpal microphone, Parakeet, `wl-copy`.
pub struct System;

struct MicTake {
    capture: audio::Capture,
    take: Arc<Mutex<audio::Take>>,
}

impl Recording for MicTake {
    fn finish(mut self: Box<Self>) -> (Vec<f32>, f32) {
        self.capture.stop();
        let mut t = self.take.lock().unwrap_or_else(|e| e.into_inner());
        (std::mem::take(&mut t.samples), t.peak)
    }
    fn levels(&self) -> [f32; audio::BAND_COUNT] {
        self.take.lock().unwrap_or_else(|e| e.into_inner()).meter.levels
    }
    fn level(&self) -> Option<f32> {
        self.take.lock().unwrap_or_else(|e| e.into_inner()).level.take()
    }
}

/// Ten minutes at most: a dictation left open by mistake stops growing.
const MAX_SAMPLES: usize = 16_000 * 600;

impl Backend for System {
    fn model_ready(&self) -> bool {
        crate::speech::is_ready()
    }
    fn record(&self, mic: &str) -> Result<Box<dyn Recording>, String> {
        let take = Arc::new(Mutex::new(audio::Take::default()));
        let sink = take.clone();
        let source = audio::Source::Mic(if mic.is_empty() { None } else { Some(mic.to_string()) });
        let capture = audio::Capture::start(source, move |samples| {
            let mut t = sink.lock().unwrap_or_else(|e| e.into_inner());
            if t.samples.len() < MAX_SAMPLES {
                t.samples.extend_from_slice(samples);
            }
            t.peak = samples.iter().fold(t.peak, |m, &s| m.max(s.abs()));
            t.meter.feed(samples);
            t.level.feed(samples);
        })?;
        Ok(Box::new(MicTake { capture, take }))
    }
    fn transcribe(&self, samples: &[f32]) -> Option<String> {
        crate::speech::transcribe(samples)
    }
    fn deliver(&self, text: &str) -> paste::Outcome {
        paste::copy(text)
    }
    fn foreground_app(&self) -> Option<(String, String)> {
        context_apps(true).into_iter().next()
    }
}

/// System services plus the opt-in provider; building this never accesses the keychain.
pub struct ClaudeSystem;
impl Backend for ClaudeSystem {
    fn model_ready(&self) -> bool { System.model_ready() }
    fn record(&self, mic: &str) -> Result<Box<dyn Recording>, String> { System.record(mic) }
    fn transcribe(&self, samples: &[f32]) -> Option<String> { System.transcribe(samples) }
    fn deliver(&self, text: &str) -> paste::Outcome { System.deliver(text) }
    fn foreground_app(&self) -> Option<(String, String)> { System.foreground_app() }
    fn cleanup_provider(&self) -> Option<&dyn cleanup::CleanupProvider> { Some(&claude::AnthropicCleanup) }
}

pub fn running_apps() -> Vec<(String, String)> { context_apps(false) }

// Both the picker and capture-start use the same stable app id. No title is retained
// or passed to cleanup. A successful empty extension reply is authoritative.
fn context_apps(foreground: bool) -> Vec<(String, String)> {
    #[cfg(target_os = "linux")]
    if let Some(rows) = crate::contextwin::dbus::recent_windows(None) {
        let mut apps = Vec::new();
        for row in rows {
            if crate::contextwin::is_abito(&row) { continue; }
            let id = row.app_id.trim().to_lowercase();
            let id = id.strip_suffix(".desktop").unwrap_or(&id).to_string();
            let name = row.app_name.trim().to_string();
            if id.is_empty() || name.is_empty() || id.chars().count() > 80 || name.chars().count() > 80
                || id.chars().any(char::is_control) || name.chars().any(char::is_control) { continue; }
            if !apps.iter().any(|(existing, _)| existing == &id) { apps.push((id, name)); }
            if foreground || apps.len() == 64 { break; }
        }
        return apps;
    }
    x11_apps(foreground)
}

#[cfg(not(target_os = "linux"))]
fn x11_apps(_foreground: bool) -> Vec<(String, String)> { Vec::new() }

// Adapted from Coucou flow/os_linux.rs (MIT, Louis Raillé): class, never window title.
#[cfg(target_os = "linux")]
fn x11_apps(foreground: bool) -> Vec<(String, String)> {
    use x11rb::{connection::Connection, protocol::xproto::{AtomEnum, ConnectionExt}};
    let read = || -> Option<Vec<(String, String)>> {
        if std::env::var("XDG_SESSION_TYPE").ok().as_deref() == Some("wayland") { return None; }
        let (conn, screen) = x11rb::connect(None).ok()?;
        let root = conn.setup().roots[screen].root;
        let name = if foreground { "_NET_ACTIVE_WINDOW" } else { "_NET_CLIENT_LIST" };
        let atom = conn.intern_atom(false, name.as_bytes()).ok()?.reply().ok()?.atom;
        let windows = conn.get_property(false, root, atom, AtomEnum::WINDOW, 0, if foreground { 1 } else { 1024 }).ok()?.reply().ok()?;
        let mut out: Vec<(String, String)> = Vec::new();
        for window in windows.value32()? {
            if window == 0 { continue; }
            let Ok(cookie) = conn.get_property(false, window, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 256) else { continue };
            let Ok(class) = cookie.reply() else { continue };
            if let Some(app) = app_class(&class.value) {
                if !out.iter().any(|(id, _)| *id == app.0) { out.push(app); }
                if out.len() == 64 { break; }
            }
        }
        Some(out)
    };
    read().unwrap_or_default()
}
fn app_class(bytes: &[u8]) -> Option<(String, String)> {
    let class = bytes.split(|b| *b == 0).filter(|p| !p.is_empty()).next_back()?;
    let class = String::from_utf8_lossy(class);
    let id = class.to_lowercase();
    if id == "abito" { return None; }
    let name = store::default_app_styles().into_iter().find(|s| s.id == id).map(|s| s.name)
        .unwrap_or_else(|| { let mut chars = class.chars(); chars.next().unwrap().to_uppercase().chain(chars).collect() });
    Some((id, name))
}

/// A running dictation. Dropping it (or `stop`) ends the thread.
pub struct Dictation {
    tx: Sender<(KeyEvent, Instant)>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Dictation {
    pub fn start(store: Arc<Mutex<Store>>, backend: impl Backend, notify: Notify) -> Dictation {
        let (tx, rx) = mpsc::channel();
        let thread = std::thread::Builder::new().name("abito-dictation".into()).spawn(move || run(store, backend, notify, rx)).ok();
        Dictation { tx, thread }
    }

    pub fn sender(&self) -> Sender<(KeyEvent, Instant)> {
        self.tx.clone()
    }

    pub fn send(&self, event: KeyEvent) {
        let _ = self.tx.send((event, Instant::now()));
    }

    pub fn stop(&mut self) {
        let _ = self.tx.send((KeyEvent::Quit, Instant::now()));
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Dictation {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 20 level events a second at most.
const LEVEL_EVERY: Duration = Duration::from_millis(50);

struct Listening {
    rec: Box<dyn Recording>,
    started: Instant,
    app: Option<(String, String)>,
}

fn run<B: Backend>(store: Arc<Mutex<Store>>, backend: B, notify: Notify, rx: mpsc::Receiver<(KeyEvent, Instant)>) {
    let backend = Arc::new(backend);
    let epoch = Instant::now();
    let secs = |at: Instant| at.saturating_duration_since(epoch).as_secs_f64();
    let mut logic = KeyLogic::default();
    let mut listening: Option<Listening> = None;
    let mut last_level: Option<Instant> = None;
    let begin = |listening: &mut Option<Listening>, logic: &mut KeyLogic| {
        *listening = begin(&*backend, &store, &notify);
        if listening.is_none() {
            logic.reset();
        }
    };
    loop {
        let active = listening.is_some() || logic.is_active();
        let received = if active {
            match rx.recv_timeout(Duration::from_millis(33)) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => break,
            }
        };
        let action = match received {
            Some((KeyEvent::Quit, _)) => break,
            Some((KeyEvent::Down, at)) => logic.key_down(secs(at)),
            Some((KeyEvent::Up, at)) => logic.key_up(secs(at)),
            Some((KeyEvent::Other, _)) => logic.other_key(),
            Some((KeyEvent::Escape, _)) => logic.escape(),
            Some((KeyEvent::HandsFree, _)) => {
                if !logic.is_active() {
                    logic.lock();
                    if listening.is_none() {
                        begin(&mut listening, &mut logic);
                    }
                    if listening.is_some() {
                        notify(Update::Phase(Phase::Locked));
                    }
                }
                Action::None
            }
            Some((KeyEvent::Finish, _)) => {
                if logic.is_active() || listening.is_some() {
                    logic.reset();
                    Action::Finish
                } else {
                    Action::None
                }
            }
            Some((KeyEvent::Cancel, _)) => {
                logic.reset();
                Action::Cancel
            }
            None => logic.tick(secs(Instant::now())),
        };
        match action {
            Action::None => {}
            Action::Start => begin(&mut listening, &mut logic),
            Action::Restart => {
                drop(listening.take());
                begin(&mut listening, &mut logic);
            }
            Action::Lock => notify(Update::Phase(Phase::Locked)),
            Action::Cancel => {
                drop(listening.take());
                notify(Update::Phase(Phase::Idle));
            }
            Action::Finish => match listening.take() {
                Some(l) => finish(&backend, &store, &notify, l),
                None => notify(Update::Phase(Phase::Idle)),
            },
        }
        if let Some(l) = &listening {
            notify(Update::Bands(l.rec.levels()));
            // The level meter: only while listening, and at most 20 a second (the loop itself turns every 33 ms).
            let now = Instant::now();
            if last_level.is_none_or(|at| now.duration_since(at) >= LEVEL_EVERY) {
                if let Some(level) = l.rec.level() {
                    notify(Update::Level(level));
                }
                last_level = Some(now);
            }
        } else {
            last_level = None;
        }
    }
    drop(listening);
    notify(Update::Phase(Phase::Idle));
}

/// Opens the microphone, unless the model is missing (never downloads it).
fn begin(backend: &dyn Backend, store: &Mutex<Store>, notify: &Notify) -> Option<Listening> {
    if !backend.model_ready() {
        notify(Update::Note(Note::NeedModel));
        return None;
    }
    let app = backend.foreground_app();
    let mic = store.lock().unwrap_or_else(|e| e.into_inner()).prefs.mic.clone();
    match backend.record(&mic) {
        Ok(rec) => {
            notify(Update::Phase(Phase::Listening));
            Some(Listening { rec, started: Instant::now(), app })
        }
        Err(err) => {
            eprintln!("abito dictation: microphone: {err}");
            notify(Update::Phase(Phase::Failed));
            notify(Update::Note(Note::NoMicrophone));
            None
        }
    }
}

/// Stops listening and turns what was said into clipboard text on a worker
/// thread, so the key works again at once.
fn finish<B: Backend>(backend: &Arc<B>, store: &Arc<Mutex<Store>>, notify: &Notify, l: Listening) {
    let seconds = l.started.elapsed().as_secs_f64();
    let (samples, peak) = l.rec.finish();
    // Too short or silent: nothing to send to the model.
    if samples.len() < 16_000 / 4 || peak < 0.004 {
        notify(Update::Phase(Phase::Idle));
        return;
    }
    notify(Update::Phase(Phase::Thinking));
    let (backend, store, notify) = (backend.clone(), store.clone(), notify.clone());
    let worker = std::thread::Builder::new().name("abito-dictation-job".into()).spawn(move || process(&*backend, &store, &notify, &samples, seconds, l.app.as_ref()));
    if worker.is_err() {
        eprintln!("abito dictation: could not start the worker");
    }
}

pub fn process(backend: &dyn Backend, store: &Mutex<Store>, notify: &Notify, samples: &[f32], seconds: f64, app: Option<&(String, String)>) {
    let raw = backend.transcribe(samples).unwrap_or_default().trim().to_string();
    if raw.is_empty() {
        notify(Update::Phase(Phase::Idle));
        return;
    }
    let (prepared, style, enabled, words) = {
        let st = store.lock().unwrap_or_else(|e| e.into_inner());
        (st.prepare(&raw), st.style_for(app.map(|a| a.0.as_str())), st.prefs.cleanup, st.words.words.clone())
    };
    let mut written = prepared.text.clone();
    let cleaned = cleanup::clean(backend.cleanup_provider(), enabled, &prepared.text, style, app.map(|a| a.1.as_str()), &words);
    // A clean-up that lost a snippet mark is dropped: the words stay as heard.
    if text::keeps_marks(&cleaned, &prepared.snippets) {
        written = cleaned;
    }
    let final_text = text::finish(&written, &prepared.snippets);
    match backend.deliver(&final_text) {
        paste::Outcome::Failed => {
            notify(Update::Phase(Phase::Failed));
            notify(Update::Note(Note::ClipboardRefused));
        }
        outcome => {
            store.lock().unwrap_or_else(|e| e.into_inner()).record(&final_text, app.map(|a| a.1.as_str()), seconds, store::today(), store::now_ms());
            notify(Update::Phase(if outcome == paste::Outcome::Copied { Phase::Copied } else { Phase::Idle }));
        }
    }
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;

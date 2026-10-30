use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct FakeRec;
impl Recording for FakeRec {
    fn finish(self: Box<Self>) -> (Vec<f32>, f32) {
        (vec![0.1; 16_000], 0.1)
    }
    fn levels(&self) -> [f32; audio::BAND_COUNT] {
        [0.0; audio::BAND_COUNT]
    }
    fn level(&self) -> Option<f32> {
        Some(0.5)
    }
}

struct Fake {
    focus: Arc<Mutex<Option<(String, String)>>>,
    ready: bool,
    mic_ok: bool,
    said: &'static str,
    outcome: paste::Outcome,
    delivered: Arc<Mutex<Vec<String>>>,
    recorded: Arc<AtomicUsize>,
    downloads: Arc<AtomicUsize>,
    provider: Option<Box<dyn cleanup::CleanupProvider>>,
}

impl Backend for Fake {
    fn foreground_app(&self) -> Option<(String, String)> { self.focus.lock().unwrap().clone() }
    fn cleanup_provider(&self) -> Option<&dyn cleanup::CleanupProvider> {
        self.provider.as_deref()
    }
    fn model_ready(&self) -> bool {
        self.ready
    }
    fn record(&self, _mic: &str) -> Result<Box<dyn Recording>, String> {
        self.recorded.fetch_add(1, Ordering::SeqCst);
        if self.mic_ok { Ok(Box::new(FakeRec)) } else { Err("none".into()) }
    }
    fn transcribe(&self, _samples: &[f32]) -> Option<String> {
        Some(self.said.to_string())
    }
    fn deliver(&self, text: &str) -> paste::Outcome {
        self.delivered.lock().unwrap().push(text.to_string());
        self.outcome
    }
}

struct Rig {
    d: Dictation,
    log: Arc<Mutex<Vec<Update>>>,
    delivered: Arc<Mutex<Vec<String>>>,
    recorded: Arc<AtomicUsize>,
    downloads: Arc<AtomicUsize>,
    store: Arc<Mutex<Store>>,
}

fn rig(ready: bool, mic_ok: bool, said: &'static str, outcome: paste::Outcome) -> Rig {
    let dir = std::env::temp_dir().join(format!("abito-flow-run-{}-{}", std::process::id(), text::new_id()));
    let store = Arc::new(Mutex::new(Store::load_from(dir)));
    let log = Arc::new(Mutex::new(Vec::new()));
    let (delivered, recorded, downloads) = (Arc::new(Mutex::new(Vec::new())), Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let l = log.clone();
    let notify: Notify = Arc::new(move |u| l.lock().unwrap().push(u));
    let backend = Fake { focus: Arc::new(Mutex::new(None)), ready, mic_ok, said, outcome, delivered: delivered.clone(), recorded: recorded.clone(), downloads: downloads.clone(), provider: None };
    Rig { d: Dictation::start(store.clone(), backend, notify), log, delivered, recorded, downloads, store }
}

fn wait_for(f: impl Fn() -> bool) -> bool {
    for _ in 0..200 {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

fn has(r: &Rig, u: Update) -> bool {
    r.log.lock().unwrap().contains(&u)
}

#[test]
fn hold_speak_release_puts_the_words_on_the_clipboard_and_in_the_history() {
    let r = rig(true, true, "hola mundo", paste::Outcome::Copied);
    r.d.send(KeyEvent::Down);
    std::thread::sleep(Duration::from_millis(400));
    r.d.send(KeyEvent::Up);
    assert!(wait_for(|| has(&r, Update::Phase(Phase::Copied))));
    assert_eq!(*r.delivered.lock().unwrap(), vec!["hola mundo".to_string()]);
    assert_eq!(r.store.lock().unwrap().history.len(), 1);
    assert!(has(&r, Update::Phase(Phase::Thinking)));
}

#[test]
fn without_the_model_nothing_is_recorded_and_nothing_is_downloaded() {
    let r = rig(false, true, "x", paste::Outcome::Copied);
    r.d.send(KeyEvent::Down);
    assert!(wait_for(|| has(&r, Update::Note(Note::NeedModel))));
    assert_eq!(r.recorded.load(Ordering::SeqCst), 0);
    assert_eq!(r.downloads.load(Ordering::SeqCst), 0);
    assert!(r.delivered.lock().unwrap().is_empty());
}

#[test]
fn a_missing_microphone_is_told_and_delivers_nothing() {
    let r = rig(true, false, "x", paste::Outcome::Copied);
    r.d.send(KeyEvent::Down);
    assert!(wait_for(|| has(&r, Update::Note(Note::NoMicrophone))));
    assert!(r.delivered.lock().unwrap().is_empty());
}

#[test]
fn a_shortcut_or_escape_cancels_and_nothing_is_delivered() {
    let r = rig(true, true, "x", paste::Outcome::Copied);
    r.d.send(KeyEvent::Down);
    assert!(wait_for(|| has(&r, Update::Phase(Phase::Listening))));
    r.d.send(KeyEvent::Escape);
    assert!(wait_for(|| has(&r, Update::Phase(Phase::Idle))));
    std::thread::sleep(Duration::from_millis(100));
    assert!(r.delivered.lock().unwrap().is_empty());
}

#[test]
fn a_refused_clipboard_is_a_failure_and_is_not_recorded() {
    let r = rig(true, true, "hola", paste::Outcome::Failed);
    r.d.send(KeyEvent::HandsFree);
    assert!(wait_for(|| has(&r, Update::Phase(Phase::Locked))));
    r.d.send(KeyEvent::Finish);
    assert!(wait_for(|| has(&r, Update::Note(Note::ClipboardRefused))));
    assert!(r.store.lock().unwrap().history.is_empty());
}

#[test]
fn stopping_ends_the_thread() {
    let mut r = rig(true, true, "x", paste::Outcome::Copied);
    r.d.stop();
    assert!(r.d.thread.is_none());
}

struct Upper(Arc<AtomicUsize>);
impl cleanup::CleanupProvider for Upper {
    fn clean(&self, r: &cleanup::Request<'_>) -> Result<String, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(r.text.to_uppercase())
    }
}

fn run_with_provider(cleanup_on: bool) -> (Vec<String>, usize) {
    let dir = std::env::temp_dir().join(format!("abito-flow-clean-{}-{}", std::process::id(), text::new_id()));
    let store = Arc::new(Mutex::new(Store::load_from(dir)));
    store.lock().unwrap().prefs.cleanup = cleanup_on;
    let calls = Arc::new(AtomicUsize::new(0));
    let delivered = Arc::new(Mutex::new(Vec::new()));
    let backend = Fake {
        focus: Arc::new(Mutex::new(None)),
        ready: true, mic_ok: true, said: "uno dos tres cuatro", outcome: paste::Outcome::Copied,
        delivered: delivered.clone(), recorded: Arc::new(AtomicUsize::new(0)), downloads: Arc::new(AtomicUsize::new(0)),
        provider: Some(Box::new(Upper(calls.clone()))),
    };
    let notify: Notify = Arc::new(|_| {});
    process(&backend, &store, &notify, &[0.1; 16_000], 1.0, None);
    let out = delivered.lock().unwrap().clone();
    (out, calls.load(Ordering::SeqCst))
}

#[test]
fn the_cleanup_runs_only_when_the_user_turned_it_on() {
    let (out, calls) = run_with_provider(false);
    assert_eq!((out, calls), (vec!["uno dos tres cuatro".to_string()], 0));
    let (out, calls) = run_with_provider(true);
    assert_eq!((out, calls), (vec!["UNO DOS TRES CUATRO".to_string()], 1));
}

#[test]
fn sampled_app_style_survives_focus_change_before_transcription() {
    struct Check(store::Style, &'static str, Arc<AtomicUsize>);
    impl cleanup::CleanupProvider for Check {
        fn clean(&self, r: &cleanup::Request<'_>) -> Result<String, String> {
            assert_eq!(r.style, self.0);
            assert_eq!(r.app, Some(self.1));
            self.2.fetch_add(1, Ordering::SeqCst);
            Ok(r.text.to_uppercase())
        }
    }
    for (id, name, style, expected_calls) in [("slack", "Slack", store::Style::Natural, 1),
        ("claude", "Claude", store::Style::Verbatim, 0), ("outlook", "Outlook", store::Style::Polished, 1)] {
        let (mut st, _) = store::tests::temp_store(); st.prefs.cleanup = true;
        let shared = Arc::new(Mutex::new(st));
        let focus = Arc::new(Mutex::new(Some((id.into(), name.into()))));
        let calls = Arc::new(AtomicUsize::new(0));
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::new(Mutex::new(Vec::new())); let updates = log.clone();
        let backend = Fake { focus: focus.clone(), ready: true, mic_ok: true,
            said: "hello there my good friend", outcome: paste::Outcome::Copied,
            delivered: delivered.clone(), recorded: Arc::new(AtomicUsize::new(0)), downloads: Arc::new(AtomicUsize::new(0)),
            provider: Some(Box::new(Check(style, name, calls.clone()))) };
        let d = Dictation::start(shared.clone(), backend, Arc::new(move |u| updates.lock().unwrap().push(u)));
        d.send(KeyEvent::HandsFree);
        assert!(wait_for(|| log.lock().unwrap().contains(&Update::Phase(Phase::Locked))));
        *focus.lock().unwrap() = Some(("other-app".into(), "Other App".into()));
        d.send(KeyEvent::Finish);
        assert!(wait_for(|| log.lock().unwrap().contains(&Update::Phase(Phase::Copied))));
        assert_eq!(calls.load(Ordering::SeqCst), expected_calls);
        assert_eq!(delivered.lock().unwrap()[0], if expected_calls == 0 { "hello there my good friend" } else { "HELLO THERE MY GOOD FRIEND" });
        assert_eq!(shared.lock().unwrap().history[0].app.as_deref(), Some(name));
    }
}

#[test]
fn x11_class_uses_class_not_instance_and_skips_own_window() {
    assert_eq!(app_class(b"instance\0Slack\0"), Some(("slack".into(), "Slack".into())));
    assert_eq!(app_class(b"instance\0AbItO\0"), None);
    assert_eq!(app_class(b"\0\0"), None);
    assert_eq!(app_class(b"instance\0customApp\0"), Some(("customapp".into(), "CustomApp".into())));
}

fn levels_in(r: &Rig) -> usize {
    r.log.lock().unwrap().iter().filter(|u| matches!(u, Update::Level(_))).count()
}

#[test]
fn the_level_is_published_only_while_listening_and_at_most_20_times_a_second() {
    let r = rig(true, true, "x", paste::Outcome::Copied);
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(levels_in(&r), 0, "idle: no level, nothing is measured");
    r.d.send(KeyEvent::HandsFree);
    assert!(wait_for(|| has(&r, Update::Phase(Phase::Locked))));
    std::thread::sleep(Duration::from_millis(1000));
    let during = levels_in(&r);
    assert!(during >= 5, "while listening the level arrives ({during})");
    assert!(during <= 21, "at most 20 a second ({during} in about a second)");
    assert!(has(&r, Update::Level(0.5)), "the value is the recording's own level");
    r.d.send(KeyEvent::Cancel);
    assert!(wait_for(|| has(&r, Update::Phase(Phase::Idle))));
    let at_stop = levels_in(&r);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(levels_in(&r), at_stop, "once it stops listening, no more levels");
}

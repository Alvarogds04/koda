//! K2-09 (S1, S3, S5): Spotify on Windows, through the system media transport controls (SMTC).
//!
//! Spotify publishes what it plays to the same overlay the media keys show, and Windows hands that
//! session to any app through `GlobalSystemMediaTransportControlsSessionManager`: track, status,
//! timeline, shuffle and repeat as properties with change events, and play/pause, skip and the rest
//! as requests. The same [`PlayerState`] the MPRIS client fills therefore reaches the island, from
//! events instead of D-Bus signals: a song changed inside Spotify shows up without the user doing
//! anything in Abito (S3).
//!
//! Adapted from Coucou windows/src-tauri/src/spotify.rs @434d6a2b, Copyright (c) 2026 Louis Raillé,
//! MIT (the session lookup, the media-properties/timeline reading and the event-driven listener are
//! Coucou's; the state, the sink and the command surface are Abito's). Deliberately left out of the
//! port: Coucou's per-session volume, which reads Spotify's Windows mixer through Win32 Core Audio —
//! the island's card has no volume control any more, so `volume` keeps its documented default. The
//! cover is not read either: `art_url` is `None` and the card paints its own note.
//!
//! The pure parts (a session id → Spotify?, 100 ns ticks → seconds and Unix time, tags → track) live
//! outside `cfg(windows)` so they are unit-tested on Linux; only the WinRT calls are Windows-only.

use crate::spotify::{short_artist, short_title, Track};

#[cfg(windows)]
use crate::spotify::{now_ms, Action, PlayerState};

/// The media session ids Spotify registers: `Spotify.exe` (the installer from spotify.com) or
/// `SpotifyAB.SpotifyMusic_…!Spotify` (the Microsoft Store build). Both contain "spotify".
pub fn is_spotify_app(app_id: &str) -> bool {
    app_id.to_ascii_lowercase().contains("spotify")
}

/// SMTC durations and timeline positions are 100 ns ticks → seconds.
pub fn ticks_to_secs(ticks: i64) -> f64 {
    ticks.max(0) as f64 / 10_000_000.0
}

/// A Windows `DateTime` (100 ns ticks since 1601) → Unix milliseconds. Zero is "never updated".
pub fn windows_time_to_unix_ms(universal: i64) -> Option<f64> {
    const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;
    (universal > 0).then(|| (universal - UNIX_EPOCH_TICKS) as f64 / 10_000.0)
}

/// The media session's tags → the track, or `None` when nothing is loaded. Windows gives no Spotify
/// URI, so the id is made from the tags with FNV-1a: the same tags always give the same id, which is
/// all the card needs (it never builds a link from it). A title with no artist and no album is an ad,
/// and gets an ad id, exactly as the Mac does.
pub fn windows_track(title: &str, artist: &str, album: &str, duration: f64) -> Option<Track> {
    let title = title.trim();
    if title.is_empty() {
        return None;
    }
    let artist = artist.trim();
    let album = album.trim();
    let kind = if artist.is_empty() && album.is_empty() { "ad" } else { "track" };
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in [artist, album, title].join("\u{1f}").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    Some(Track {
        id: format!("spotify:{kind}:{hash:016x}"),
        title: short_title(title),
        artist: short_artist(artist),
        album: album.to_string(),
        duration: duration.max(0.0),
        art_url: None,
        object_path: String::new(),
    })
}

#[cfg(windows)]
pub use win::{control, refresh, start, state, stop};

// ── Windows: WinRT ────────────────────────────────────────────────────────────

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::sync::{Arc, Mutex, OnceLock};
    use windows::Foundation::TypedEventHandler;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status, MediaPropertiesChangedEventArgs,
        PlaybackInfoChangedEventArgs, SessionsChangedEventArgs, TimelinePropertiesChangedEventArgs,
    };
    use windows::Media::MediaPlaybackAutoRepeatMode;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    type Sink = Arc<dyn Fn(&PlayerState) + Send + Sync>;

    /// What wakes the listener. Nothing polls.
    enum Wake {
        /// The session's track, status or timeline moved.
        Changed,
        /// A player appeared or went away: find Spotify's session again.
        Sessions,
        /// The card went away.
        Stop,
    }

    struct Shared {
        /// Bumped on every start and stop: a listener from an older one quits.
        generation: u64,
        active: bool,
        wake: Option<Sender<Wake>>,
        sink: Option<Sink>,
        state: PlayerState,
    }

    fn shared() -> &'static Mutex<Shared> {
        static SHARED: OnceLock<Mutex<Shared>> = OnceLock::new();
        SHARED.get_or_init(|| {
            Mutex::new(Shared {
                generation: 0,
                active: false,
                wake: None,
                sink: None,
                state: PlayerState::default(),
            })
        })
    }

    /// WinRT hands every call back as an `IAsyncOperation`, which `windows` 0.62 exposes as a future
    /// (0.61's blocking `get` is gone). One current-thread runtime waits for it; the completion
    /// callback WinRT runs on its own thread is what wakes this one, so nothing is spun on.
    fn wait<T>(op: impl std::future::IntoFuture<Output = windows::core::Result<T>>) -> Option<T> {
        let runtime = tokio::runtime::Builder::new_current_thread().build().ok()?;
        runtime.block_on(std::future::IntoFuture::into_future(op)).ok()
    }

    /// The same, for the `bool` answers every transport request gives (`Ok(false)` = Spotify said no).
    fn asked(op: windows::core::Result<impl std::future::IntoFuture<Output = windows::core::Result<bool>>>) -> bool {
        op.ok().and_then(wait).unwrap_or(false)
    }

    /// WinRT needs COM on the calling thread. A thread that already has it, in either model, keeps it.
    fn com() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    fn current(generation: u64) -> bool {
        let s = shared().lock().expect("spotify smtc lock");
        s.active && s.generation == generation
    }

    fn sessions() -> Option<Manager> {
        com();
        wait(Manager::RequestAsync().ok()?)
    }

    fn find_session(manager: &Manager) -> Option<Session> {
        let sessions = manager.GetSessions().ok()?;
        (0..sessions.Size().ok()?)
            .filter_map(|i| sessions.GetAt(i).ok())
            .find(|s| s.SourceAppUserModelId().is_ok_and(|id| is_spotify_app(&id.to_string_lossy())))
    }

    // ── Start / stop ──────────────────────────────────────────────────────────

    /// Starts the listener (a no-op when it already runs) and reports every change into `sink`.
    pub fn start(sink: impl Fn(&PlayerState) + Send + Sync + 'static) {
        let (tx, rx) = mpsc::channel();
        let (old, generation) = {
            let mut s = shared().lock().expect("spotify smtc lock");
            if s.active {
                return;
            }
            s.active = true;
            s.generation += 1;
            s.state = PlayerState::default();
            s.sink = Some(Arc::new(sink));
            let old = s.wake.replace(tx.clone());
            (old, s.generation)
        };
        if let Some(old) = old {
            let _ = old.send(Wake::Stop);
        }
        let spawned = std::thread::Builder::new()
            .name("abito-spotify-smtc".into())
            .spawn(move || listen(generation, tx, rx));
        if spawned.is_err() {
            let mut s = shared().lock().expect("spotify smtc lock");
            s.active = false;
            s.wake = None;
        }
    }

    /// Ends the listener; the island is told there is nothing running.
    pub fn stop() {
        let (wake, state, sink) = {
            let mut s = shared().lock().expect("spotify smtc lock");
            if !s.active {
                return;
            }
            s.active = false;
            s.generation += 1;
            s.state = PlayerState::default();
            (s.wake.take(), s.state.clone(), s.sink.clone())
        };
        if let Some(wake) = wake {
            let _ = wake.send(Wake::Stop);
        }
        if let Some(sink) = sink {
            sink(&state);
        }
    }

    pub fn state() -> PlayerState {
        shared().lock().expect("spotify smtc lock").state.clone()
    }

    /// Reads the session again. `None` while the listener is not started.
    pub fn refresh() -> Option<PlayerState> {
        let generation = {
            let s = shared().lock().expect("spotify smtc lock");
            if !s.active {
                return None;
            }
            s.generation
        };
        let session = sessions().as_ref().and_then(find_session);
        read_and_emit(generation, session.as_ref());
        Some(state())
    }

    // ── Reading ───────────────────────────────────────────────────────────────

    /// Everything the session says, as it is now.
    struct Snapshot {
        track: Option<Track>,
        playing: bool,
        position: f64,
        /// When Windows last updated the position (Unix ms), if it says.
        updated_at: Option<f64>,
        shuffle: bool,
        repeat: bool,
    }

    fn snapshot(session: &Session) -> Option<Snapshot> {
        let props = wait(session.TryGetMediaPropertiesAsync().ok()?)?;
        let title = props.Title().map(|h| h.to_string_lossy()).unwrap_or_default();
        let artist = props.Artist().map(|h| h.to_string_lossy()).unwrap_or_default();
        let album = props.AlbumTitle().map(|h| h.to_string_lossy()).unwrap_or_default();
        let timeline = session.GetTimelineProperties().ok()?;
        let start = timeline.StartTime().ok()?.Duration;
        let duration = ticks_to_secs(timeline.EndTime().ok()?.Duration - start);
        let track = windows_track(&title, &artist, &album, duration);
        let info = session.GetPlaybackInfo().ok()?;
        Some(Snapshot {
            playing: info.PlaybackStatus().ok()? == Status::Playing && track.is_some(),
            track,
            position: ticks_to_secs(timeline.Position().ok()?.Duration - start),
            updated_at: timeline.LastUpdatedTime().ok().and_then(|t| windows_time_to_unix_ms(t.UniversalTime)),
            shuffle: info.IsShuffleActive().ok().and_then(|r| r.Value().ok()).unwrap_or(false),
            repeat: info
                .AutoRepeatMode()
                .ok()
                .and_then(|r| r.Value().ok())
                .is_some_and(|mode| mode != MediaPlaybackAutoRepeatMode::None),
        })
    }

    fn read_and_emit(generation: u64, session: Option<&Session>) {
        let read = session.and_then(snapshot);
        let now = now_ms();
        let (state, sink) = {
            let mut s = shared().lock().expect("spotify smtc lock");
            if !(s.active && s.generation == generation) {
                return;
            }
            match read {
                Some(snap) => {
                    s.state.running = true;
                    s.state.track = snap.track;
                    s.state.playing = snap.playing;
                    // The position was true when Windows last updated it; while playing the page runs
                    // it on from there.
                    let at = snap.updated_at.filter(|t| *t <= now).unwrap_or(now);
                    s.state.position = snap.position.max(0.0);
                    s.state.position_at = at;
                    s.state.shuffle = snap.shuffle;
                    s.state.repeat = snap.repeat;
                }
                None => {
                    s.state.running = false;
                    s.state.clear(now);
                }
            }
            (s.state.clone(), s.sink.clone())
        };
        if let Some(sink) = sink {
            sink(&state);
        }
    }

    // ── Commands ──────────────────────────────────────────────────────────────

    /// Plays one transport/mode action against Spotify. False when the card is not open, Spotify is
    /// not running, the action is not a control, or Spotify said no.
    pub fn control(action: Action) -> bool {
        {
            let s = shared().lock().expect("spotify smtc lock");
            if !(s.active && s.state.running) {
                return false;
            }
        }
        let Some(session) = sessions().as_ref().and_then(find_session) else {
            return false;
        };
        match action {
            Action::PlayPause => asked(session.TryTogglePlayPauseAsync()),
            Action::Next => asked(session.TrySkipNextAsync()),
            Action::Previous => asked(session.TrySkipPreviousAsync()),
            Action::Seek(secs) => {
                let Some(track) = state().track else { return false };
                let Ok(timeline) = session.GetTimelineProperties() else { return false };
                let Ok(start) = timeline.StartTime() else { return false };
                let target = secs.clamp(0.0, (track.duration - 1.0).max(0.0));
                let position = start.Duration + (target * 10_000_000.0) as i64;
                asked(session.TryChangePlaybackPositionAsync(position))
            }
            Action::Shuffle(on) => asked(session.TryChangeShuffleActiveAsync(on)),
            Action::Repeat(on) => asked(session.TryChangeAutoRepeatModeAsync(if on {
                MediaPlaybackAutoRepeatMode::List
            } else {
                MediaPlaybackAutoRepeatMode::None
            })),
            // No volume in the card, no per-session volume here (see the module note), and the
            // permission link is macOS only.
            Action::Volume(_) | Action::View | Action::Stop | Action::OpenPermission => false,
        }
    }

    // ── The listener ──────────────────────────────────────────────────────────

    /// Waits on the session's events and tells the island what changed. Nothing runs between events.
    fn listen(generation: u64, tx: Sender<Wake>, rx: Receiver<Wake>) {
        com();
        let Some(manager) = sessions() else { return };
        let sessions_token = {
            let tx = tx.clone();
            let handler = TypedEventHandler::<Manager, SessionsChangedEventArgs>::new(move |_, _| {
                let _ = tx.send(Wake::Sessions);
                Ok(())
            });
            manager.SessionsChanged(&handler).ok()
        };

        let mut bound: Option<Bound> = None;
        let mut rebind = true;
        while current(generation) {
            if rebind {
                if let Some(previous) = bound.take() {
                    previous.unbind();
                }
                bound = find_session(&manager).and_then(|session| Bound::bind(session, &tx));
                rebind = false;
            }
            read_and_emit(generation, bound.as_ref().map(|b| &b.session));

            // Events arrive in bursts (a new track moves everything): one read per burst.
            let mut stop = false;
            match rx.recv() {
                Ok(Wake::Changed) => {}
                Ok(Wake::Sessions) => rebind = true,
                Ok(Wake::Stop) | Err(_) => stop = true,
            }
            while let Ok(more) = rx.try_recv() {
                match more {
                    Wake::Changed => {}
                    Wake::Sessions => rebind = true,
                    Wake::Stop => stop = true,
                }
            }
            if stop {
                break;
            }
        }

        if let Some(previous) = bound {
            previous.unbind();
        }
        if let Some(token) = sessions_token {
            let _ = manager.RemoveSessionsChanged(token);
        }
    }

    /// Spotify's session, with the handlers that wake the listener.
    struct Bound {
        session: Session,
        tokens: [Option<i64>; 3],
    }

    impl Bound {
        fn bind(session: Session, tx: &Sender<Wake>) -> Option<Bound> {
            let tokens = [
                {
                    let tx = tx.clone();
                    let handler = TypedEventHandler::<Session, MediaPropertiesChangedEventArgs>::new(move |_, _| {
                        let _ = tx.send(Wake::Changed);
                        Ok(())
                    });
                    session.MediaPropertiesChanged(&handler).ok()
                },
                {
                    let tx = tx.clone();
                    let handler = TypedEventHandler::<Session, PlaybackInfoChangedEventArgs>::new(move |_, _| {
                        let _ = tx.send(Wake::Changed);
                        Ok(())
                    });
                    session.PlaybackInfoChanged(&handler).ok()
                },
                {
                    let tx = tx.clone();
                    let handler = TypedEventHandler::<Session, TimelinePropertiesChangedEventArgs>::new(move |_, _| {
                        let _ = tx.send(Wake::Changed);
                        Ok(())
                    });
                    session.TimelinePropertiesChanged(&handler).ok()
                },
            ];
            Some(Bound { session, tokens })
        }

        fn unbind(self) {
            let [media, playback, timeline] = self.tokens;
            if let Some(token) = media {
                let _ = self.session.RemoveMediaPropertiesChanged(token);
            }
            if let Some(token) = playback {
                let _ = self.session.RemovePlaybackInfoChanged(token);
            }
            if let Some(token) = timeline {
                let _ = self.session.RemoveTimelinePropertiesChanged(token);
            }
        }
    }
}

// ── Tests: the pure parts, which run on Linux ─────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spotify_sessions_are_recognised_by_their_app_id() {
        assert!(is_spotify_app("Spotify.exe"));
        assert!(is_spotify_app("spotify.exe"));
        assert!(is_spotify_app("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"));
        assert!(!is_spotify_app(""));
        assert!(!is_spotify_app("chrome.exe"));
        assert!(!is_spotify_app("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"));
    }

    #[test]
    fn spotify_smtc_ticks_become_seconds_and_never_go_negative() {
        assert_eq!(ticks_to_secs(0), 0.0);
        assert_eq!(ticks_to_secs(10_000_000), 1.0);
        assert_eq!(ticks_to_secs(2_370_000_000), 237.0);
        assert_eq!(ticks_to_secs(-5), 0.0);
    }

    #[test]
    fn spotify_smtc_windows_time_is_unix_milliseconds_and_zero_means_never() {
        // 2021-01-01T00:00:00Z in 100 ns ticks since 1601.
        assert_eq!(windows_time_to_unix_ms(116_444_736_000_000_000), Some(0.0));
        assert_eq!(windows_time_to_unix_ms(116_444_736_010_000_000), Some(1000.0));
        assert_eq!(windows_time_to_unix_ms(0), None);
        assert_eq!(windows_time_to_unix_ms(-1), None);
    }

    #[test]
    fn spotify_smtc_tags_become_a_track_with_a_stable_id() {
        let track = windows_track("DtMF - Remastered", "Bad Bunny feat. X", "DeBÍ TiRAR MáS FOToS", 237.4).unwrap();
        assert_eq!(track.title, "DtMF");
        assert_eq!(track.artist, "Bad Bunny");
        assert_eq!(track.album, "DeBÍ TiRAR MáS FOToS");
        assert_eq!(track.duration, 237.4);
        assert!(track.id.starts_with("spotify:track:"));
        assert_eq!(track.art_url, None, "no cover is read: the card paints its own note");
        // The same tags give the same id, a different track another one.
        assert_eq!(windows_track("DtMF - Remastered", "Bad Bunny feat. X", "DeBÍ TiRAR MáS FOToS", 237.4).unwrap().id, track.id);
        assert_ne!(windows_track("Other", "Bad Bunny feat. X", "DeBÍ TiRAR MáS FOToS", 237.4).unwrap().id, track.id);
    }

    #[test]
    fn spotify_smtc_an_untitled_session_has_no_track_and_a_bare_title_is_an_ad() {
        assert!(windows_track("", "A", "B", 10.0).is_none());
        assert!(windows_track("   ", "", "", 0.0).is_none());
        let ad = windows_track("Advertisement", "", "", 0.0).unwrap();
        assert!(ad.id.starts_with("spotify:ad:"), "{}", ad.id);
        assert_eq!(ad.duration, 0.0);
        assert_eq!(windows_track("Song", "", "Album", -3.0).unwrap().duration, 0.0);
    }
}

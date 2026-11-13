//! K2-09 (S1, S3, S5, S6): Spotify on macOS, driven with AppleScript — no Swift, no new crate.
//!
//! Spotify on the Mac publishes no media session, so it is read the way its own dictionary allows:
//! one `/usr/bin/osascript` call returns the player state and the current track in a single
//! tab-separated line, and the transport verbs go back the same way. The state is the same
//! [`PlayerState`] the MPRIS client fills, so the island's card does not know which system it is on.
//!
//! Two rules, both from the plan (design 08):
//! - **Spotify is never launched.** Every script is wrapped in `if application id "com.spotify.client"
//!   is running then …`: with Spotify closed the card simply says it is not open (S2).
//! - **The Automation permission is asked, never assumed.** The first read is what makes macOS show
//!   the prompt; if the user refuses, `osascript` exits with -1743 (errAEEventNotPermitted) and the
//!   state carries `needsPermission`, which the card turns into design 08 F7 with one button that
//!   opens Ajustes del Sistema › Privacidad y seguridad › Automatización.
//!
//! Nothing is event-driven here (Spotify's distributed notification would need Swift), so the card
//! polls: one read every 1.5 s, only between `view` and `stop`, and an event is emitted only when what
//! the card shows actually changed (S3). Windows and Linux keep their event-driven backends.
//!
//! Reference: Coucou NotchBuddy/Sources/App/SpotifyController.swift @434d6a2b, Copyright (c) 2026
//! Louis Raillé, MIT (the script shape and the -1743 handling are Coucou's; the state, the sink and
//! the command surface are Abito's).
//!
//! The pure parts (the line → [`PlayerState`] parse, the -1743 detection, "did what the card shows
//! move?") live outside `cfg(target_os = "macos")` so they are unit-tested on Linux.

use crate::spotify::{short_artist, short_title, PlayerState, Track};

#[cfg(target_os = "macos")]
use crate::spotify::{now_ms, Action};

/// Ajustes del Sistema › Privacidad y seguridad › Automatización. It lives here and nowhere else:
/// the page sends `open_permission`, never a URL (design 08, notes).
pub const PERMISSION_URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

/// One read of the player: state, track id, name, artist, album, duration (ms), position (s),
/// shuffling and repeating, tab-separated on one line. Every read is guarded, and the whole body
/// only runs while Spotify is already open.
pub const SCRIPT: &str = r#"
set ps to "off"
set tid to ""
set n to ""
set ar to ""
set al to ""
set du to 0
set pp to 0
set sh to "0"
set rp to "0"
if application id "com.spotify.client" is running then
	set ps to "stopped"
	tell application id "com.spotify.client"
		try
			set ps to player state as string
		end try
		if ps is not "stopped" then
			try
				set tr to current track
				set tid to (id of tr) as string
				set n to (name of tr) as string
			on error
				set ps to "stopped"
			end try
		end if
		if ps is not "stopped" then
			try
				set ar to (artist of tr) as string
			end try
			try
				set al to (album of tr) as string
			end try
			try
				set du to duration of tr
			end try
			try
				set pp to player position
			end try
			try
				if shuffling then
					set sh to "1"
				end if
			end try
			try
				if repeating then
					set rp to "1"
				end if
			end try
		end if
	end tell
end if
return ps & tab & tid & tab & n & tab & ar & tab & al & tab & (du as integer) & tab & (pp as integer) & tab & sh & tab & rp
"#;

/// A refused Apple Event: -1743 (`errAEEventNotPermitted`, "Not authorized to send Apple events").
pub fn permission_denied(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    text.contains("-1743") || text.contains("erraeeventnotpermitted") || text.contains("not authorized to send apple events")
}

/// The script's one line → the state the island is told, or `None` when the output is not ours.
/// `now_ms` anchors the position, so the page can run it on while playing.
pub fn parse_state(stdout: &str, now_ms: f64) -> Option<PlayerState> {
    let line = stdout.lines().next().unwrap_or("").trim_end_matches('\r');
    if line.is_empty() {
        return None;
    }
    let field: Vec<&str> = line.split('\t').collect();
    if field.len() < 9 {
        return None;
    }
    let state = field[0].trim().to_ascii_lowercase();
    let number = |i: usize| field.get(i).and_then(|v| v.trim().parse::<f64>().ok());
    let mut out = PlayerState { position_at: now_ms, ..PlayerState::default() };
    if state == "off" {
        return Some(out);
    }
    out.running = true;
    let title = short_title(field[2].trim());
    if state == "stopped" || title.is_empty() {
        return Some(out);
    }
    out.playing = state == "playing";
    out.shuffle = field.get(7).map(|v| v.trim() == "1").unwrap_or(false);
    out.repeat = field.get(8).map(|v| v.trim() == "1").unwrap_or(false);
    out.position = number(6).map(|s| s.max(0.0)).unwrap_or(0.0);
    out.track = Some(Track {
        id: field[1].trim().to_string(),
        title,
        artist: short_artist(field[3].trim()),
        album: field[4].trim().to_string(),
        duration: number(5).map(|ms| (ms / 1000.0).max(0.0)).unwrap_or(0.0),
        art_url: None,
        object_path: String::new(),
    });
    Some(out)
}

/// Did what the card shows move? The position is not part of it: the page runs it on from
/// `position_at`, so a moved position alone is not worth an event (one every 1.5 s would be noise).
pub fn same(before: &PlayerState, after: &PlayerState) -> bool {
    if before.running != after.running
        || before.playing != after.playing
        || before.shuffle != after.shuffle
        || before.repeat != after.repeat
        || before.needs_permission != after.needs_permission
    {
        return false;
    }
    match (&before.track, &after.track) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.id == b.id && a.title == b.title && a.artist == b.artist && a.album == b.album && a.duration == b.duration
        }
        _ => false,
    }
}

#[cfg(target_os = "macos")]
pub use mac::{control, refresh, start, state, stop};

// ── macOS: osascript ──────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::Duration;

    const OSASCRIPT: &str = "/usr/bin/osascript";
    const OPEN: &str = "/usr/bin/open";
    /// How often the card's own reading is refreshed while it is open.
    const POLL: Duration = Duration::from_millis(1500);

    /// Why a script failed: the user refused the Apple Event, or something else broke.
    enum Failure {
        Denied,
        Failed,
    }

    type Sink = Arc<dyn Fn(&PlayerState) + Send + Sync>;

    struct Shared {
        generation: u64,
        active: bool,
        sink: Option<Sink>,
        state: PlayerState,
    }

    fn shared() -> &'static Mutex<Shared> {
        static SHARED: OnceLock<Mutex<Shared>> = OnceLock::new();
        SHARED.get_or_init(|| {
            Mutex::new(Shared { generation: 0, active: false, sink: None, state: PlayerState::default() })
        })
    }

    fn current(generation: u64) -> bool {
        let s = shared().lock().expect("spotify mac lock");
        s.active && s.generation == generation
    }

    fn run_script(source: &str) -> Result<String, Failure> {
        let output = Command::new(OSASCRIPT)
            .arg("-e")
            .arg(source)
            .stdin(Stdio::null())
            .output()
            .map_err(|_| Failure::Failed)?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).to_string());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(if permission_denied(&stderr) { Failure::Denied } else { Failure::Failed })
    }

    /// One transport/mode verb. Single-line `if`, so Spotify is never launched by mistake.
    fn verb(words: &str) -> bool {
        let source = format!(
            "if application id \"com.spotify.client\" is running then tell application id \"com.spotify.client\" to {words}"
        );
        run_script(&source).is_ok()
    }

    // ── Start / stop ──────────────────────────────────────────────────────────

    /// Starts polling (a no-op when it already runs) and reports every change into `sink`.
    pub fn start(sink: impl Fn(&PlayerState) + Send + Sync + 'static) {
        let generation = {
            let mut s = shared().lock().expect("spotify mac lock");
            if s.active {
                return;
            }
            s.active = true;
            s.generation += 1;
            s.state = PlayerState::default();
            s.sink = Some(Arc::new(sink));
            s.generation
        };
        let spawned = std::thread::Builder::new()
            .name("abito-spotify-mac".into())
            .spawn(move || poll(generation));
        if spawned.is_err() {
            shared().lock().expect("spotify mac lock").active = false;
        }
    }

    /// Ends the polling; the island is told there is nothing running.
    pub fn stop() {
        let (state, sink) = {
            let mut s = shared().lock().expect("spotify mac lock");
            if !s.active {
                return;
            }
            s.active = false;
            s.generation += 1;
            s.state = PlayerState::default();
            (s.state.clone(), s.sink.clone())
        };
        if let Some(sink) = sink {
            sink(&state);
        }
    }

    pub fn state() -> PlayerState {
        shared().lock().expect("spotify mac lock").state.clone()
    }

    /// Reads Spotify again. `None` while the card is not open.
    pub fn refresh() -> Option<PlayerState> {
        let generation = {
            let s = shared().lock().expect("spotify mac lock");
            if !s.active {
                return None;
            }
            s.generation
        };
        read_once(generation);
        Some(state())
    }

    // ── Commands ──────────────────────────────────────────────────────────────

    /// Plays one transport/mode action. False when Spotify is not running, the action is not a
    /// control, or it refused. `open_permission` is the one action that does not need Spotify.
    pub fn control(action: Action) -> bool {
        match action {
            Action::OpenPermission => Command::new(OPEN)
                .arg(PERMISSION_URL)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false),
            Action::PlayPause => verb("playpause"),
            Action::Next => verb("next track"),
            Action::Previous => verb("previous track"),
            Action::Seek(seconds) => {
                let duration = state().track.map(|t| t.duration).unwrap_or(0.0);
                let target = if duration > 0.0 { seconds.clamp(0.0, (duration - 1.0).max(0.0)) } else { seconds.max(0.0) };
                verb(&format!("set player position to {}", target.round() as i64))
            }
            Action::Shuffle(on) => verb(&format!("set shuffling to {on}")),
            Action::Repeat(on) => verb(&format!("set repeating to {on}")),
            Action::Volume(level) => verb(&format!("set sound volume to {level}")),
            Action::View | Action::Stop => false,
        }
    }

    // ── Reading ───────────────────────────────────────────────────────────────

    /// One read, told to the island only when what the card shows moved (S3).
    fn read_once(generation: u64) {
        let next = match run_script(SCRIPT) {
            Ok(stdout) => parse_state(&stdout, now_ms()),
            // The user said no: say how to say yes (S3/S6, design 08 F7).
            Err(Failure::Denied) => Some(PlayerState { needs_permission: true, ..PlayerState::default() }),
            // Anything else: keep what we had. Never invent a state.
            Err(Failure::Failed) => None,
        };
        let Some(next) = next else { return };
        let (emit, state, sink) = {
            let mut s = shared().lock().expect("spotify mac lock");
            if !(s.active && s.generation == generation) {
                return;
            }
            let emit = !same(&s.state, &next);
            if emit {
                s.state = next;
            }
            (emit, s.state.clone(), s.sink.clone())
        };
        if emit {
            if let Some(sink) = sink {
                sink(&state);
            }
        }
    }

    /// Polls while the card is open, waking ten times a second to notice `stop` promptly.
    fn poll(generation: u64) {
        loop {
            if !current(generation) {
                return;
            }
            read_once(generation);
            let mut waited = Duration::ZERO;
            while waited < POLL {
                if !current(generation) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
                waited += Duration::from_millis(100);
            }
        }
    }
}

// ── Tests: the pure parts, which run on Linux ─────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn line(state: &str, id: &str, name: &str, artist: &str, album: &str, ms: &str, pos: &str, sh: &str, rp: &str) -> String {
        format!("{state}\t{id}\t{name}\t{artist}\t{album}\t{ms}\t{pos}\t{sh}\t{rp}\n")
    }

    #[test]
    fn spotify_mac_a_playing_track_line_becomes_the_player_state() {
        let out = line("playing", "spotify:track:ID1", "DtMF", "Bad Bunny", "DeBÍ TiRAR MáS FOToS", "237000", "102", "1", "0");
        let state = parse_state(&out, 7000.0).unwrap();
        assert!(state.running && state.playing);
        assert_eq!((state.position, state.position_at), (102.0, 7000.0));
        assert_eq!((state.shuffle, state.repeat), (true, false));
        let track = state.track.unwrap();
        assert_eq!([track.id.as_str(), track.title.as_str(), track.artist.as_str()], ["spotify:track:ID1", "DtMF", "Bad Bunny"]);
        assert_eq!(track.album, "DeBÍ TiRAR MáS FOToS");
        assert_eq!(track.duration, 237.0);
        assert!(!state.needs_permission);
    }

    #[test]
    fn spotify_mac_off_stopped_and_untitled_are_not_a_track_but_are_a_running_spotify() {
        let off = parse_state(&line("off", "", "", "", "", "0", "0", "0", "0"), 1.0).unwrap();
        assert!(!off.running && off.track.is_none() && !off.playing);
        let stopped = parse_state(&line("stopped", "", "", "", "", "0", "0", "0", "0"), 1.0).unwrap();
        assert!(stopped.running && stopped.track.is_none() && !stopped.playing, "no track, like MPRIS NoTrack");
        let untitled = parse_state(&line("paused", "spotify:ad:1", "", "", "", "30000", "4", "0", "0"), 1.0).unwrap();
        assert!(untitled.running && untitled.track.is_none(), "a title-less read is not shown");
    }

    #[test]
    fn spotify_mac_damaged_output_is_refused_not_guessed() {
        for bad in ["", "\n", "playing", "playing\tonly-four\tfields\there", "\t\t\t\t\t\t\t\t"] {
            let parsed = parse_state(bad, 1.0);
            if let Some(state) = parsed {
                assert!(state.track.is_none(), "{bad:?} must not invent a track");
            }
        }
        assert_eq!(parse_state("", 1.0), None);
        // Odd numbers never panic and never go negative.
        let weird = parse_state(&line("playing", "id", "Song", "A", "B", "not-a-number", "-5", "yes", "1"), 1.0).unwrap();
        assert_eq!(weird.position, 0.0);
        assert_eq!(weird.track.unwrap().duration, 0.0);
        assert!(!weird.shuffle);
        assert!(weird.repeat);
    }

    #[test]
    fn spotify_mac_the_a_refused_apple_event_is_recognised() {
        assert!(permission_denied("execution error: Not authorized to send Apple events to Spotify. (-1743)"));
        assert!(permission_denied("0:42: execution error: errAEEventNotPermitted (-1743)"));
        assert!(!permission_denied("0:42: execution error: Spotify got an error: Can't get current track. (-1728)"));
        assert!(!permission_denied(""));
    }

    #[test]
    fn spotify_mac_only_a_real_change_is_worth_an_event() {
        let base = parse_state(&line("playing", "id1", "Song", "Band", "Album", "200000", "10", "0", "0"), 1.0).unwrap();
        // The page runs the position on from positionAt: a moved position alone is not a change.
        let moved = parse_state(&line("playing", "id1", "Song", "Band", "Album", "200000", "42", "0", "0"), 2.0).unwrap();
        assert!(same(&base, &moved));
        for other in [
            line("paused", "id1", "Song", "Band", "Album", "200000", "10", "0", "0"),
            line("playing", "id2", "Song", "Band", "Album", "200000", "10", "0", "0"),
            line("playing", "id1", "Other", "Band", "Album", "200000", "10", "0", "0"),
            line("playing", "id1", "Song", "Other", "Album", "200000", "10", "0", "0"),
            line("playing", "id1", "Song", "Band", "Other", "200000", "10", "0", "0"),
            line("playing", "id1", "Song", "Band", "Album", "210000", "10", "0", "0"),
            line("playing", "id1", "Song", "Band", "Album", "200000", "10", "1", "0"),
            line("playing", "id1", "Song", "Band", "Album", "200000", "10", "0", "1"),
            line("off", "", "", "", "", "0", "0", "0", "0"),
        ] {
            assert!(!same(&base, &parse_state(&other, 2.0).unwrap()), "{other:?} is a change");
        }
        let denied = PlayerState { needs_permission: true, ..PlayerState::default() };
        assert!(!same(&base, &denied));
        assert!(same(&denied, &denied));
    }

    #[test]
    fn spotify_mac_the_permission_deep_link_is_the_only_copy_of_it() {
        assert_eq!(PERMISSION_URL, "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation");
        assert!(SCRIPT.contains("is running"), "the read never launches Spotify");
        assert!(SCRIPT.contains("com.spotify.client"));
        assert!(SCRIPT.contains("tab"));
    }
}

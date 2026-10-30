use super::*;
use serde_json::json;

fn s(v: &str) -> Value {
    Value::Str(v.into())
}

fn metadata(trackid: &str, title: &str) -> Value {
    Value::Map(vec![
        ("mpris:trackid".into(), s(trackid)),
        ("xesam:title".into(), s(title)),
        ("xesam:artist".into(), Value::Strs(vec!["Daft Punk".into(), "Pharrell Williams".into()])),
        ("xesam:album".into(), s("Random Access Memories")),
        ("mpris:length".into(), Value::Int(369_000_000)),
        ("mpris:artUrl".into(), s("https://i.scdn.co/image/abc")),
    ])
}

#[test]
fn titles_and_artists_are_trimmed() {
    assert_eq!(short_title("Song - Remastered 2011"), "Song");
    assert_eq!(short_title("Song (Live) [Mono]"), "Song");
    assert_eq!(short_title("(Intro)"), "(Intro)");
    assert_eq!(short_title(""), "");
    assert_eq!(short_title("Plain"), "Plain");
    assert_eq!(short_artist("Artist feat. Someone"), "Artist");
    assert_eq!(short_artist("Artist FT. Someone"), "Artist");
    assert_eq!(short_artist("Solo"), "Solo");
}

#[test]
fn mpris_track_ids_become_spotify_ids() {
    assert_eq!(spotify_id("/com/spotify/track/ABC", None), "spotify:track:ABC");
    assert_eq!(spotify_id("/com/spotify/episode/XYZ", None), "spotify:episode:XYZ");
    assert_eq!(spotify_id("spotify:track:ABC", None), "spotify:track:ABC");
    assert_eq!(
        spotify_id("/org/mpris/x", Some("https://open.spotify.com/track/QQQ?si=1")),
        "spotify:track:QQQ"
    );
    assert_eq!(spotify_id("/org/mpris/x", None), "/org/mpris/x");
}

#[test]
fn metadata_parses_and_an_empty_player_has_no_track() {
    let Value::Map(map) = metadata("/com/spotify/track/ID1", "Get Lucky - Radio Edit") else { unreachable!() };
    let track = parse_metadata(&map).unwrap();
    assert_eq!(track.id, "spotify:track:ID1");
    assert_eq!(track.title, "Get Lucky");
    assert_eq!(track.artist, "Daft Punk, Pharrell Williams");
    assert_eq!(track.album, "Random Access Memories");
    assert_eq!(track.duration, 369.0);
    assert_eq!(track.art_url.as_deref(), Some("https://i.scdn.co/image/abc"));
    assert_eq!(parse_metadata(&[]), None);
    assert_eq!(parse_metadata(&[("mpris:trackid".into(), s("/org/mpris/MediaPlayer2/TrackList/NoTrack"))]), None);
}

#[test]
fn the_position_runs_on_while_playing_and_freezes_on_pause() {
    let mut state = PlayerState::default();
    state.apply(
        &[
            ("Metadata".into(), metadata("/com/spotify/track/ID1", "Get Lucky")),
            ("PlaybackStatus".into(), s("Playing")),
            ("Position".into(), Value::Int(10_000_000)),
        ],
        1_000.0,
    );
    assert_eq!(state.position_at_time(3_500.0), 12.5);
    assert_eq!(state.position_at_time(0.0), 10.0, "a clock that went backwards never moves it back");
    assert_eq!(state.position_at_time(1_000.0 + 1_000_000.0), 369.0, "capped at the track's length");
    let applied = state.apply(&[("PlaybackStatus".into(), s("Paused"))], 5_000.0);
    assert!(applied.status_changed && !applied.track_changed);
    assert_eq!(state.position, 14.0);
    assert_eq!(state.position_at_time(60_000.0), 14.0);
}

#[test]
fn a_new_track_restarts_the_clock_and_stopped_clears_it() {
    let mut state = PlayerState::default();
    state.apply(
        &[
            ("PlaybackStatus".into(), s("Playing")),
            ("Metadata".into(), metadata("/com/spotify/track/ID1", "One")),
            ("Position".into(), Value::Int(50_000_000)),
        ],
        0.0,
    );
    assert!(state.playing, "the status after the metadata, whatever the order");
    let applied = state.apply(&[("Metadata".into(), metadata("/com/spotify/track/ID2", "Two"))], 2_000.0);
    assert!(applied.track_changed);
    assert_eq!(state.position, 0.0);
    let applied = state.apply(&[("Metadata".into(), metadata("/com/spotify/track/ID2", "Two"))], 3_000.0);
    assert!(!applied.track_changed, "the same track again is not a change");
    let applied = state.apply(&[("PlaybackStatus".into(), s("Stopped"))], 4_000.0);
    assert!(applied.track_changed);
    assert_eq!(state.track, None);
    assert!(!state.playing);
}

#[test]
fn shuffle_loop_and_volume() {
    let mut state = PlayerState::default();
    assert_eq!(state.volume, 50);
    state.apply(
        &[("Shuffle".into(), Value::Bool(true)), ("LoopStatus".into(), s("Playlist")), ("Volume".into(), Value::Float(1.4))],
        0.0,
    );
    assert!(state.shuffle && state.repeat);
    assert_eq!(state.volume, 100);
    state.apply(&[("LoopStatus".into(), s("None")), ("Volume".into(), Value::Float(0.004))], 0.0);
    assert!(!state.repeat);
    assert_eq!(state.volume, 0);
}

#[test]
fn the_state_reaches_the_page_in_camel_case_without_the_object_path() {
    let mut state = PlayerState { running: true, ..PlayerState::default() };
    state.apply(&[("Metadata".into(), metadata("/com/spotify/track/ID1", "One"))], 7.0);
    let json = serde_json::to_value(&state).unwrap();
    assert_eq!(json["positionAt"], 7.0);
    assert_eq!(json["track"]["artUrl"], "https://i.scdn.co/image/abc");
    assert_eq!(json["track"]["id"], "spotify:track:ID1");
    assert!(json["track"].get("objectPath").is_none());
}

#[test]
fn the_closed_command_set_parses_exactly() {
    assert_eq!(parse_command(&json!({"action": "view"})), Some(Action::View));
    assert_eq!(parse_command(&json!({"action": "stop"})), Some(Action::Stop));
    assert_eq!(parse_command(&json!({"action": "play_pause"})), Some(Action::PlayPause));
    assert_eq!(parse_command(&json!({"action": "next"})), Some(Action::Next));
    assert_eq!(parse_command(&json!({"action": "previous"})), Some(Action::Previous));
    assert_eq!(parse_command(&json!({"action": "shuffle", "value": true})), Some(Action::Shuffle(true)));
    assert_eq!(parse_command(&json!({"action": "repeat", "value": false})), Some(Action::Repeat(false)));
    assert_eq!(parse_command(&json!({"action": "volume", "value": 100})), Some(Action::Volume(100)));
    assert_eq!(parse_command(&json!({"action": "volume", "value": 0})), Some(Action::Volume(0)));
    assert_eq!(parse_command(&json!({"action": "seek", "value": 12.5})), Some(Action::Seek(12.5)));
}

#[test]
fn anything_outside_the_closed_set_is_refused() {
    for bad in [
        json!(null),
        json!("next"),
        json!({}),
        json!({"action": "dance"}),
        json!({"action": 3}),
        json!({"action": "next", "value": 1}),
        json!({"action": "next", "extra": true}),
        json!({"action": "view", "value": true}),
        json!({"action": "shuffle"}),
        json!({"action": "shuffle", "value": 1}),
        json!({"action": "repeat", "value": "yes"}),
        json!({"action": "volume", "value": 101}),
        json!({"action": "volume", "value": -1}),
        json!({"action": "volume", "value": 50.5}),
        json!({"action": "volume", "value": "50"}),
        json!({"action": "seek", "value": -1}),
        json!({"action": "seek", "value": "3"}),
        json!({"action": "seek", "value": 3, "x": 1}),
        json!({"action": "volume", "val": 3}),
    ] {
        assert_eq!(parse_command(&bad), None, "{bad}");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn dbus_variants_become_plain_values() {
    use super::client::value_of;
    use zbus::zvariant::{ObjectPath, Value as Z};
    assert_eq!(value_of(&Z::from("Playing")), s("Playing"));
    assert_eq!(value_of(&Z::from(true)), Value::Bool(true));
    assert_eq!(value_of(&Z::from(0.5f64)), Value::Float(0.5));
    assert_eq!(value_of(&Z::from(42u64)), Value::Int(42));
    assert_eq!(value_of(&Z::from(-7i64)), Value::Int(-7));
    assert_eq!(value_of(&Z::from(3i32)), Value::Int(3));
    assert_eq!(
        value_of(&Z::from(ObjectPath::try_from("/com/spotify/track/abc").unwrap())),
        s("/com/spotify/track/abc")
    );
    assert_eq!(
        value_of(&Z::from(vec!["A".to_string(), "B".to_string()])),
        Value::Strs(vec!["A".into(), "B".into()])
    );
    // Variant-wrapped, as it arrives in a{sv}.
    assert_eq!(value_of(&Z::Value(Box::new(Z::from(7u32)))), Value::Int(7));
}

#[test]
fn local_artwork_is_bounded_sniffed_and_remote_urls_are_never_loaded() {
    let dir = std::env::temp_dir().join(format!("abito-artwork-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("cover.png");
    std::fs::write(&file, b"\x89PNG\r\n\x1a\nfixture").unwrap();
    let url = tauri::Url::from_file_path(&file).unwrap().to_string();
    let art = local_artwork(&url).unwrap();
    assert_eq!(art["mime"], "image/png");
    assert_eq!(art["artUrl"], url);
    for bad in ["https://i.scdn.co/image/fixture", "http://example.com/cover.png", "file://elsewhere/cover.png", "data:image/png;base64,aA=="] {
        assert!(local_artwork(bad).is_none(), "unsupported scheme/host");
    }
    std::fs::write(&file, b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
    assert!(local_artwork(&url).is_none(), "SVG/HTML cannot enter the renderer");
    std::fs::write(&file, vec![0u8; 2 * 1024 * 1024 + 1]).unwrap();
    assert!(local_artwork(&url).is_none(), "bounded input");
}

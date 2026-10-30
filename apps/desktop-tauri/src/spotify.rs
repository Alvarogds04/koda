//! #470 Spotify control over MPRIS (D-Bus), Linux only. Abito's own `zbus` (blocking), no new
//! crate. A closed command set (`parse_command`) drives Spotify; the player's state is pushed
//! through a sink the host turns into an island event.
//!
//! Adapted from Coucou src-tauri/src/spotify.rs @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
//! (The state model, metadata parsing and title/artist trimming are Coucou's; the transport is
//! rewritten from the `dbus` crate to `zbus`, and the command surface is Abito's.)
//!
//! Nothing runs on a timer: while declared, one thread blocks on the bus and wakes only for
//! Spotify's `PropertiesChanged` / `Seeked` and the bus's `NameOwnerChanged`. `Position` is not
//! signalled, so it is read when the status or track moves; the page runs it on from
//! `position_at` while playing.
use serde::Serialize;
use serde_json::Value as Json;

#[cfg(test)]
#[path = "spotify_tests.rs"]
mod tests;

/// Island event carrying the whole [`PlayerState`].
pub const STATE_EVENT: &str = "spotify:state";

// ── Values ────────────────────────────────────────────────────────────────────

/// A D-Bus value as far as MPRIS needs it, so parsing is plain Rust testable without a bus.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Str(String),
    Strs(Vec<String>),
    Int(i64),
    Float(f64),
    Bool(bool),
    Map(Vec<(String, Value)>),
    Other,
}

impl Value {
    fn str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
    fn int(&self) -> Option<i64> {
        match self {
            Value::Int(n) => Some(*n),
            Value::Float(f) => Some(*f as i64),
            _ => None,
        }
    }
    /// Text, or a list of texts joined (`xesam:artist` is a list).
    fn text(&self) -> String {
        match self {
            Value::Str(s) => s.clone(),
            Value::Strs(list) => list
                .iter()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", "),
            _ => String::new(),
        }
    }
}

fn find<'a>(map: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    map.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

// ── State ─────────────────────────────────────────────────────────────────────

/// The track Spotify has loaded.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// `spotify:track:…`, `spotify:episode:…`, `spotify:ad:…`.
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Seconds.
    pub duration: f64,
    pub art_url: Option<String>,
    /// `mpris:trackid` as Spotify gave it, for `SetPosition`. Never sent to the page.
    #[serde(skip)]
    pub object_path: String,
}

/// What the island is told, whenever it changes.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    /// Spotify owns its name on the bus.
    pub running: bool,
    pub track: Option<Track>,
    pub playing: bool,
    /// Seconds at `position_at`; while playing the real position runs on from there.
    pub position: f64,
    /// Unix milliseconds.
    pub position_at: f64,
    pub shuffle: bool,
    /// `LoopStatus` is not `None`.
    pub repeat: bool,
    /// 0…100.
    pub volume: i32,
}

impl Default for PlayerState {
    fn default() -> Self {
        PlayerState {
            running: false,
            track: None,
            playing: false,
            position: 0.0,
            position_at: 0.0,
            shuffle: false,
            repeat: false,
            volume: 50,
        }
    }
}

/// What a change touched, so the caller knows what to read next.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Applied {
    pub track_changed: bool,
    pub status_changed: bool,
    pub position_set: bool,
}

impl PlayerState {
    /// Where playback is at `now_ms`, extrapolated from the last anchor, capped at the end.
    pub fn position_at_time(&self, now_ms: f64) -> f64 {
        let elapsed = if self.playing { ((now_ms - self.position_at) / 1000.0).max(0.0) } else { 0.0 };
        let p = self.position + elapsed;
        match &self.track {
            Some(t) if t.duration > 0.0 => p.min(t.duration),
            _ => p,
        }
    }

    fn anchor(&mut self, position: f64, now_ms: f64) {
        self.position = position.max(0.0);
        self.position_at = now_ms;
    }

    /// Spotify is gone: nothing is playing.
    pub fn clear(&mut self, now_ms: f64) {
        self.track = None;
        self.playing = false;
        self.anchor(0.0, now_ms);
    }

    /// Applies Player properties (`GetAll` or a `PropertiesChanged`): metadata first, position
    /// last, whatever order they came in.
    pub fn apply(&mut self, props: &[(String, Value)], now_ms: f64) -> Applied {
        let mut applied = Applied::default();
        let rank = |k: &str| match k {
            "Metadata" => 0,
            "PlaybackStatus" => 1,
            "Position" => 3,
            _ => 2,
        };
        let mut ordered: Vec<&(String, Value)> = props.iter().collect();
        ordered.sort_by_key(|(k, _)| rank(k));
        let mut stopped = false;
        for (key, value) in ordered {
            match key.as_str() {
                "Metadata" => {
                    let track = match value {
                        Value::Map(map) => parse_metadata(map),
                        _ => None,
                    };
                    let same = match (&self.track, &track) {
                        (Some(a), Some(b)) => a.id == b.id && a.object_path == b.object_path,
                        (None, None) => true,
                        _ => false,
                    };
                    if !same {
                        applied.track_changed = true;
                        self.anchor(0.0, now_ms);
                    }
                    self.track = track;
                }
                "PlaybackStatus" => {
                    let Some(status) = value.str() else { continue };
                    stopped = status == "Stopped";
                    let playing = status == "Playing";
                    if playing != self.playing {
                        // Freeze or restart the clock where it is now.
                        let at = self.position_at_time(now_ms);
                        self.anchor(at, now_ms);
                        self.playing = playing;
                        applied.status_changed = true;
                    }
                }
                "Shuffle" => {
                    if let Value::Bool(on) = value {
                        self.shuffle = *on;
                    }
                }
                "LoopStatus" => {
                    if let Some(s) = value.str() {
                        self.repeat = s != "None";
                    }
                }
                "Volume" => {
                    if let Value::Float(v) = value {
                        self.volume = (v * 100.0).round().clamp(0.0, 100.0) as i32;
                    }
                }
                "Position" => {
                    if let Some(us) = value.int() {
                        self.anchor(us as f64 / 1_000_000.0, now_ms);
                        applied.position_set = true;
                    }
                }
                _ => {}
            }
        }
        if stopped && self.track.is_some() {
            self.clear(now_ms);
            applied.track_changed = true;
        }
        if self.track.is_none() {
            self.playing = false;
        }
        applied
    }
}

/// xesam / mpris metadata → the track, or None when nothing is loaded.
pub fn parse_metadata(map: &[(String, Value)]) -> Option<Track> {
    let object_path = find(map, "mpris:trackid").map(Value::text).unwrap_or_default();
    let title = find(map, "xesam:title").map(Value::text).unwrap_or_default();
    if object_path.is_empty() && title.is_empty() {
        return None;
    }
    // An unloaded player says /org/mpris/MediaPlayer2/TrackList/NoTrack.
    if object_path.ends_with("/NoTrack") {
        return None;
    }
    let duration = find(map, "mpris:length")
        .and_then(Value::int)
        .map(|us| us.max(0) as f64 / 1_000_000.0)
        .unwrap_or(0.0);
    let art_url = find(map, "mpris:artUrl").map(Value::text).filter(|s| !s.is_empty());
    let id = spotify_id(&object_path, find(map, "xesam:url").map(Value::text).as_deref());
    Some(Track {
        id,
        title: short_title(&title),
        artist: short_artist(&find(map, "xesam:artist").map(Value::text).unwrap_or_default()),
        album: find(map, "xesam:album").map(Value::text).unwrap_or_default(),
        duration,
        art_url,
        object_path,
    })
}

/// `/com/spotify/track/ID` → `spotify:track:ID`. Older builds already gave `spotify:track:ID`;
/// failing both, the page URL.
pub fn spotify_id(trackid: &str, url: Option<&str>) -> String {
    if trackid.starts_with("spotify:") {
        return trackid.to_string();
    }
    if let Some(rest) = trackid.strip_prefix("/com/spotify/") {
        let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        if parts.len() >= 2 {
            return format!("spotify:{}:{}", parts[0], parts[1..].join(":"));
        }
    }
    if let Some(rest) = url.and_then(|u| u.strip_prefix("https://open.spotify.com/")) {
        let parts: Vec<&str> = rest.split(['/', '?']).collect();
        if parts.len() >= 2 && !parts[0].is_empty() && !parts[1].is_empty() {
            return format!("spotify:{}:{}", parts[0], parts[1]);
        }
    }
    trackid.to_string()
}

/// "Song - Remastered 2011 (Live) [Mono]" → "Song".
pub fn short_title(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let mut s: &str = raw;
    if let Some(i) = s.find(" - ") {
        s = &s[..i];
    }
    loop {
        let t = s.trim();
        let Some(last) = t.chars().last() else { break };
        if last != ')' && last != ']' {
            break;
        }
        let open = if last == ')' { '(' } else { '[' };
        let Some(idx) = t.rfind(open) else { break };
        let candidate = t[..idx].trim();
        if candidate.is_empty() {
            break;
        }
        s = candidate;
    }
    let result = s.trim();
    if result.is_empty() { raw.to_string() } else { result.to_string() }
}

/// "Artist feat. Someone" → "Artist".
pub fn short_artist(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let lower = raw.to_lowercase();
    for tag in [" feat.", " ft."] {
        if let Some(i) = lower.find(tag) {
            // Lowercasing can move byte offsets; only cut where it lines up.
            if lower.len() == raw.len() && raw.is_char_boundary(i) {
                let result = raw[..i].trim();
                return if result.is_empty() { raw.to_string() } else { result.to_string() };
            }
        }
    }
    raw.to_string()
}

// ── The closed command set ────────────────────────────────────────────────────

/// What the page may ask. `View` starts the listener and answers the state; `Stop` ends it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    View,
    Stop,
    PlayPause,
    Next,
    Previous,
    /// Seconds from the start.
    Seek(f64),
    Shuffle(bool),
    Repeat(bool),
    /// 0…=100.
    Volume(u8),
}

/// `{action}` for view/stop/play_pause/next/previous; `{action, value}` for seek (finite
/// number ≥ 0, seconds), shuffle/repeat (bool) and volume (integer 0..=100). Exact keys,
/// nothing else is accepted.
pub fn parse_command(payload: &Json) -> Option<Action> {
    let obj = payload.as_object()?;
    let action = obj.get("action")?.as_str()?;
    let bare = |a| (obj.len() == 1).then_some(a);
    let valued = |f: &dyn Fn(&Json) -> Option<Action>| {
        if obj.len() == 2 { obj.get("value").and_then(f) } else { None }
    };
    match action {
        "view" => bare(Action::View),
        "stop" => bare(Action::Stop),
        "play_pause" => bare(Action::PlayPause),
        "next" => bare(Action::Next),
        "previous" => bare(Action::Previous),
        "shuffle" => valued(&|v| v.as_bool().map(Action::Shuffle)),
        "repeat" => valued(&|v| v.as_bool().map(Action::Repeat)),
        "seek" => valued(&|v| v.as_f64().filter(|s| s.is_finite() && *s >= 0.0).map(Action::Seek)),
        "volume" => valued(&|v| v.as_u64().filter(|n| *n <= 100).map(|n| Action::Volume(n as u8))),
        _ => None,
    }
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

// ── Linux: MPRIS over zbus ────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
pub use client::Client;

#[cfg(target_os = "linux")]
mod client {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use zbus::blocking::fdo::DBusProxy;
    use zbus::blocking::proxy::Builder as ProxyBuilder;
    use zbus::blocking::{Connection, MessageIterator, Proxy};
    use zbus::proxy::CacheProperties;
    use zbus::zvariant::{ObjectPath, OwnedValue, Value as ZValue};
    use zbus::MatchRule;

    const BUS: &str = "org.mpris.MediaPlayer2.spotify";
    const PATH: &str = "/org/mpris/MediaPlayer2";
    const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
    const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
    const DBUS: &str = "org.freedesktop.DBus";
    const WAKE_IFACE: &str = "org.abito.SpotifyWake";

    /// A D-Bus value as a plain [`Value`] (variants unwrapped).
    pub fn value_of(v: &ZValue<'_>) -> Value {
        match v {
            ZValue::Value(inner) => value_of(inner),
            ZValue::Str(s) => Value::Str(s.to_string()),
            ZValue::ObjectPath(p) => Value::Str(p.to_string()),
            ZValue::Signature(s) => Value::Str(s.to_string()),
            ZValue::Bool(b) => Value::Bool(*b),
            ZValue::F64(f) => Value::Float(*f),
            ZValue::U8(n) => Value::Int(i64::from(*n)),
            ZValue::I16(n) => Value::Int(i64::from(*n)),
            ZValue::U16(n) => Value::Int(i64::from(*n)),
            ZValue::I32(n) => Value::Int(i64::from(*n)),
            ZValue::U32(n) => Value::Int(i64::from(*n)),
            ZValue::I64(n) => Value::Int(*n),
            ZValue::U64(n) => Value::Int((*n).min(i64::MAX as u64) as i64),
            ZValue::Dict(d) => Value::Map(
                d.iter()
                    .filter_map(|(k, v)| match value_of(k) {
                        Value::Str(k) => Some((k, value_of(v))),
                        _ => None,
                    })
                    .collect(),
            ),
            ZValue::Array(a) => Value::Strs(
                a.iter()
                    .filter_map(|v| match value_of(v) {
                        Value::Str(s) => Some(s),
                        _ => None,
                    })
                    .collect(),
            ),
            _ => Value::Other,
        }
    }

    pub fn props_of(map: &HashMap<String, OwnedValue>) -> Vec<(String, Value)> {
        map.iter().map(|(k, v)| (k.clone(), value_of(v))).collect()
    }

    struct Shared {
        /// Bumped on every start and stop: a listener from an older one quits.
        generation: u64,
        active: bool,
        /// The listener's unique bus name, to wake it when it has to stop.
        listener: Option<String>,
        /// Spotify's unique name while it runs.
        owner: Option<String>,
        state: PlayerState,
    }

    type Sink = Arc<dyn Fn(&PlayerState) + Send + Sync>;

    /// One Spotify controller: a listener thread plus a connection for commands.
    #[derive(Clone)]
    pub struct Client {
        shared: Arc<Mutex<Shared>>,
        /// `None` = the user's session bus; `Some(addr)` = a private bus (tests).
        bus: Option<String>,
        sink: Sink,
        control: Arc<Mutex<Option<Connection>>>,
    }

    fn connect(bus: Option<&str>) -> zbus::Result<Connection> {
        match bus {
            Some(addr) => zbus::blocking::connection::Builder::address(addr)?.build(),
            None => Connection::session(),
        }
    }

    fn player_proxy<'a>(conn: &'a Connection, iface: &'static str) -> zbus::Result<Proxy<'a>> {
        // No property cache: a stale Position/Volume would defeat the point.
        ProxyBuilder::new(conn)
            .destination(BUS)?
            .path(PATH)?
            .interface(iface)?
            .cache_properties(CacheProperties::No)
            .build()
    }

    fn rules() -> Vec<MatchRule<'static>> {
        let signal = || MatchRule::builder().msg_type(zbus::message::Type::Signal);
        let build = || -> zbus::Result<Vec<MatchRule<'static>>> {
            Ok(vec![
                signal().sender(DBUS)?.interface(DBUS)?.member("NameOwnerChanged")?.arg(0, BUS)?.build(),
                signal().sender(BUS)?.path(PATH)?.interface(PROPERTIES)?.member("PropertiesChanged")?.build(),
                signal().sender(BUS)?.path(PATH)?.interface(PLAYER)?.member("Seeked")?.build(),
            ])
        };
        build().unwrap_or_default()
    }

    fn name_owner(conn: &Connection) -> Option<String> {
        let dbus = DBusProxy::new(conn).ok()?;
        let name = zbus::names::BusName::try_from(BUS).ok()?;
        dbus.get_name_owner(name).ok().map(|o| o.to_string())
    }

    fn get_all(conn: &Connection) -> Option<Vec<(String, Value)>> {
        let p = Proxy::new(conn, BUS, PATH, PROPERTIES).ok()?;
        let map: HashMap<String, OwnedValue> = p.call("GetAll", &(PLAYER,)).ok()?;
        Some(props_of(&map))
    }

    fn get_property(conn: &Connection, name: &str) -> Option<Value> {
        let v: OwnedValue = player_proxy(conn, PLAYER).ok()?.get_property(name).ok()?;
        Some(value_of(&v))
    }

    impl Client {
        pub fn new(bus: Option<&str>, sink: impl Fn(&PlayerState) + Send + Sync + 'static) -> Client {
            Client {
                shared: Arc::new(Mutex::new(Shared {
                    generation: 0,
                    active: false,
                    listener: None,
                    owner: None,
                    state: PlayerState::default(),
                })),
                bus: bus.map(str::to_owned),
                sink: Arc::new(sink),
                control: Arc::new(Mutex::new(None)),
            }
        }

        pub fn active(&self) -> bool {
            self.shared.lock().expect("spotify lock").active
        }

        pub fn state(&self) -> PlayerState {
            self.shared.lock().expect("spotify lock").state.clone()
        }

        fn current(&self, generation: u64) -> bool {
            let s = self.shared.lock().expect("spotify lock");
            s.active && s.generation == generation
        }

        /// Starts the listener (a no-op when already running).
        pub fn start(&self) {
            let generation = {
                let mut s = self.shared.lock().expect("spotify lock");
                if s.active {
                    return;
                }
                s.active = true;
                s.generation += 1;
                s.owner = None;
                s.state = PlayerState::default();
                s.generation
            };
            let me = self.clone();
            let spawned = std::thread::Builder::new()
                .name("abito-spotify".into())
                .spawn(move || me.listen(generation));
            if spawned.is_err() {
                self.shared.lock().expect("spotify lock").active = false;
            }
        }

        /// Ends the listener; it leaves the bus at once.
        pub fn stop(&self) {
            let wake = {
                let mut s = self.shared.lock().expect("spotify lock");
                if !s.active {
                    return;
                }
                s.active = false;
                s.generation += 1;
                s.owner = None;
                s.state = PlayerState::default();
                s.listener.take()
            };
            if let Some(name) = wake {
                self.with_control(|c| c.emit_signal(Some(name.as_str()), "/", WAKE_IFACE, "Wake", &()));
            }
            (self.sink)(&PlayerState::default());
        }

        /// Runs `f` on the control connection, made (again) when it is missing or fails.
        fn with_control<R>(&self, f: impl Fn(&Connection) -> zbus::Result<R>) -> Option<R> {
            let mut slot = self.control.lock().expect("spotify control lock");
            for _ in 0..2 {
                if slot.is_none() {
                    *slot = connect(self.bus.as_deref()).ok();
                }
                let conn = slot.as_ref()?;
                match f(conn) {
                    Ok(r) => return Some(r),
                    Err(zbus::Error::MethodError(..)) => return None,
                    Err(_) => *slot = None,
                }
            }
            None
        }

        fn publish(&self) {
            (self.sink)(&self.state());
        }

        fn listen(&self, generation: u64) {
            let Ok(conn) = connect(self.bus.as_deref()) else { return };
            {
                let mut s = self.shared.lock().expect("spotify lock");
                if !(s.active && s.generation == generation) {
                    return;
                }
                s.listener = conn.unique_name().map(|n| n.to_string());
            }
            if let Ok(dbus) = DBusProxy::new(&conn) {
                for rule in rules() {
                    let _ = dbus.add_match_rule(rule);
                }
            }
            // Spotify may have started before the pill was declared.
            self.read_everything(&conn, generation);
            for msg in MessageIterator::from(conn.clone()) {
                if !self.current(generation) {
                    break;
                }
                let Ok(msg) = msg else { break };
                self.handle(&conn, generation, &msg);
            }
        }

        fn handle(&self, conn: &Connection, generation: u64, msg: &zbus::Message) {
            let header = msg.header();
            if header.message_type() != zbus::message::Type::Signal {
                return;
            }
            let interface = header.interface().map(|i| i.to_string()).unwrap_or_default();
            let member = header.member().map(|m| m.to_string()).unwrap_or_default();
            let sender = header.sender().map(|s| s.to_string());
            match (interface.as_str(), member.as_str()) {
                (DBUS, "NameOwnerChanged") => {
                    let Ok((name, _old, new)) = msg.body().deserialize::<(String, String, String)>() else { return };
                    if name != BUS {
                        return;
                    }
                    if new.is_empty() {
                        {
                            let mut s = self.shared.lock().expect("spotify lock");
                            if !(s.active && s.generation == generation) {
                                return;
                            }
                            s.owner = None;
                            s.state.running = false;
                            s.state.clear(now_ms());
                        }
                        self.publish();
                    } else {
                        self.read_everything(conn, generation);
                    }
                }
                (PROPERTIES, "PropertiesChanged") => {
                    if !self.sent_by_owner(sender.as_deref()) {
                        return;
                    }
                    let Ok((iface, changed, invalidated)) =
                        msg.body().deserialize::<(String, HashMap<String, OwnedValue>, Vec<String>)>()
                    else {
                        return;
                    };
                    if iface != PLAYER {
                        return;
                    }
                    let mut props = props_of(&changed);
                    for name in invalidated {
                        if let Some(v) = get_property(conn, &name) {
                            props.push((name, v));
                        }
                    }
                    self.apply_and_emit(conn, generation, &props);
                }
                (PLAYER, "Seeked") => {
                    if !self.sent_by_owner(sender.as_deref()) {
                        return;
                    }
                    let Ok(us) = msg.body().deserialize::<i64>() else { return };
                    self.apply_and_emit(conn, generation, &[("Position".into(), Value::Int(us))]);
                }
                _ => {}
            }
        }

        /// Only the unique name that owns Spotify's well-known name is believed.
        fn sent_by_owner(&self, sender: Option<&str>) -> bool {
            let s = self.shared.lock().expect("spotify lock");
            matches!((&s.owner, sender), (Some(owner), Some(sender)) if owner == sender)
        }

        /// Applies a change; when the status or track moved, reads the position (never
        /// signalled), then tells the island.
        fn apply_and_emit(&self, conn: &Connection, generation: u64, props: &[(String, Value)]) {
            let applied = {
                let mut s = self.shared.lock().expect("spotify lock");
                if !(s.active && s.generation == generation) {
                    return;
                }
                s.state.apply(props, now_ms())
            };
            if (applied.status_changed || applied.track_changed) && !applied.position_set {
                if let Some(position) = get_property(conn, "Position") {
                    let mut s = self.shared.lock().expect("spotify lock");
                    if s.active && s.generation == generation {
                        s.state.apply(&[("Position".into(), position)], now_ms());
                    }
                }
            }
            self.publish();
        }

        fn read_everything(&self, conn: &Connection, generation: u64) {
            let owner = name_owner(conn);
            let props = owner.as_ref().and_then(|_| get_all(conn));
            {
                let mut s = self.shared.lock().expect("spotify lock");
                if !(s.active && s.generation == generation) {
                    return;
                }
                s.owner = owner.clone();
                s.state.running = owner.is_some();
                let now = now_ms();
                match props {
                    Some(props) => {
                        s.state.apply(&props, now);
                    }
                    None => s.state.clear(now),
                }
            }
            self.publish();
        }

        /// The player as it is now, read again (seeks made in Spotify's own window are never
        /// signalled). None while the client is not started.
        pub fn refresh(&self) -> Option<PlayerState> {
            let generation = {
                let s = self.shared.lock().expect("spotify lock");
                if !s.active {
                    return None;
                }
                s.generation
            };
            let read = self.with_control(|c| Ok((name_owner(c), get_all(c))));
            if let Some((owner, props)) = read {
                let mut s = self.shared.lock().expect("spotify lock");
                if !(s.active && s.generation == generation) {
                    return None;
                }
                s.owner = owner.clone();
                s.state.running = owner.is_some();
                let now = now_ms();
                match props {
                    Some(props) if owner.is_some() => {
                        s.state.apply(&props, now);
                    }
                    _ => s.state.clear(now),
                }
            }
            self.publish();
            Some(self.state())
        }

        /// Plays one transport/mode action against Spotify. False when not started, Spotify
        /// is not running, the action is not a control, or Spotify refused.
        pub fn control(&self, action: Action) -> bool {
            let (ready, state) = {
                let s = self.shared.lock().expect("spotify lock");
                (s.active && s.owner.is_some(), s.state.clone())
            };
            if !ready {
                return false;
            }
            let now = now_ms();
            let done = self
                .with_control(|c| {
                    let p = player_proxy(c, PLAYER)?;
                    match action {
                        Action::PlayPause => p.call::<_, _, ()>("PlayPause", &()),
                        Action::Next => p.call::<_, _, ()>("Next", &()),
                        Action::Previous => p.call::<_, _, ()>("Previous", &()),
                        Action::Seek(secs) => {
                            let Some(track) = state.track.as_ref() else {
                                return Err(zbus::Error::Failure("no track".into()));
                            };
                            let target = secs.clamp(0.0, (track.duration - 1.0).max(0.0));
                            let us = (target * 1_000_000.0) as i64;
                            match ObjectPath::try_from(track.object_path.as_str()) {
                                Ok(path) => p.call::<_, _, ()>("SetPosition", &(path, us)),
                                // Not an object path (old builds): seek by the difference.
                                Err(_) => {
                                    let from = (state.position_at_time(now) * 1_000_000.0) as i64;
                                    p.call::<_, _, ()>("Seek", &(us - from,))
                                }
                            }
                        }
                        Action::Shuffle(on) => p.set_property("Shuffle", on).map_err(zbus::Error::from),
                        Action::Repeat(on) => p.set_property("LoopStatus", if on { "Playlist" } else { "None" }).map_err(zbus::Error::from),
                        Action::Volume(v) => p.set_property("Volume", f64::from(v) / 100.0).map_err(zbus::Error::from),
                        Action::View | Action::Stop => Err(zbus::Error::Failure("not a control".into())),
                    }
                })
                .is_some();
            if !done {
                return false;
            }
            // Spotify doesn't always signal these: show them at once.
            let optimistic: Option<(String, Value)> = match action {
                Action::Seek(secs) => state.track.as_ref().map(|t| {
                    let target = secs.clamp(0.0, (t.duration - 1.0).max(0.0));
                    ("Position".into(), Value::Int((target * 1_000_000.0) as i64))
                }),
                Action::Shuffle(on) => Some(("Shuffle".into(), Value::Bool(on))),
                Action::Repeat(on) => {
                    Some(("LoopStatus".into(), Value::Str(if on { "Playlist" } else { "None" }.into())))
                }
                Action::Volume(v) => Some(("Volume".into(), Value::Float(f64::from(v) / 100.0))),
                _ => None,
            };
            if let Some(prop) = optimistic {
                self.shared.lock().expect("spotify lock").state.apply(&[prop], now_ms());
                self.publish();
            }
            true
        }
    }
}

/// Only local regular raster files. No URL is ever fetched, followed or rendered as HTML/SVG.
pub fn local_artwork(raw: &str) -> Option<Json> {
    use base64::Engine;
    use std::io::Read;
    let url = tauri::Url::parse(raw).ok()?;
    if url.scheme() != "file" || url.host_str().is_some_and(|h| h != "localhost") ||
        !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() { return None; }
    let path = url.to_file_path().ok()?;
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.file_type().is_file() || meta.len() > 2 * 1024 * 1024 { return None; }
    let mut options = std::fs::OpenOptions::new(); options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    if !file.metadata().ok()?.is_file() { return None; }
    let mut bytes = Vec::new();
    file.take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 2 * 1024 * 1024 { return None; }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { "image/png" }
        else if bytes.starts_with(&[0xff, 0xd8, 0xff]) { "image/jpeg" }
        else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") { "image/webp" }
        else { return None; };
    Some(serde_json::json!({"artUrl":raw,"mime":mime,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}))
}

/// Native-only enrichment: the WebView receives bytes, never permission to fetch a file/URL.
pub fn with_artwork(state: &PlayerState) -> Json {
    let mut value = serde_json::to_value(state).unwrap_or(Json::Null);
    value["artwork"] = state.track.as_ref().and_then(|t| t.art_url.as_deref())
        .and_then(local_artwork).unwrap_or(Json::Null);
    value
}

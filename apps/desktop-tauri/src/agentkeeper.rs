//! K3-09 M5a: who reconnects the settings/agents `AgentConn` after it is lost.
//!
//! The chat connection has had a keeper since K2-05 (`chathost.rs`, a fixed 2 s gap); the settings connection had none: it
//! only reconnected on the next page action, so a restarted engine left Ajustes → Agentes «lost» until someone clicked.
//! This module is the policy only (no thread, no clock, no socket): a [`Backoff`] that spaces the attempts, and [`tick`],
//! one keeper step over anything that can say «am I connected» and «connect». The Tauri side (`settingshost.rs`) owns the
//! thread and feeds it the real `AgentConn`; the tests here feed it a fake and a fixed clock.
//!
//! The delays are 2, 4, 8, 15 and 30 s, then 30 s for ever: an engine that is simply not installed must not turn into a
//! reconnect storm that reads `session.json` twice a second (every attempt hits the disk), and an engine that restarts
//! comes back in a couple of seconds, so the first retry is the chat's own 2 s. A successful connection starts over.
use std::path::Path;
use std::time::{Duration, Instant};

/// The delay before attempt n+1 once n attempts failed (the last step repeats).
pub const STEPS: [Duration; 5] = [
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(15),
    Duration::from_secs(30),
];

/// When the next attempt is due. `next_at == None` means «now» (the first attempt, or the human asked to retry).
#[derive(Debug, Default, Clone)]
pub struct Backoff {
    failed: u32,
    next_at: Option<Instant>,
}

impl Backoff {
    pub const fn new() -> Backoff {
        Backoff { failed: 0, next_at: None }
    }

    /// Consecutive attempts that did not connect.
    pub fn failed(&self) -> u32 {
        self.failed
    }

    pub fn due(&self, now: Instant) -> bool {
        self.next_at.is_none_or(|at| now >= at)
    }

    /// Time left until the next attempt; `None` when it is due (or nothing is scheduled).
    pub fn remaining(&self, now: Instant) -> Option<Duration> {
        self.next_at.and_then(|at| at.checked_duration_since(now)).filter(|d| !d.is_zero())
    }

    /// An attempt just ran and did NOT connect: schedule the next one.
    pub fn failed_at(&mut self, now: Instant) {
        let step = STEPS[(self.failed as usize).min(STEPS.len() - 1)];
        self.failed = self.failed.saturating_add(1);
        self.next_at = Some(now + step);
    }

    /// Connected: the next loss starts from the first, short delay.
    pub fn connected(&mut self) {
        self.failed = 0;
        self.next_at = None;
    }

    /// The human pressed «Reintentar»: the next tick tries at once. The failure count stays, so a still-missing engine
    /// keeps backing off afterwards instead of resetting to the 2 s storm.
    pub fn retry_now(&mut self) {
        self.next_at = None;
    }
}

/// What the keeper needs from a connection.
pub trait Link {
    fn is_connected(&self) -> bool;
    fn connect(&self, island_root: &Path);
}

impl Link for crate::agentconn::AgentConn {
    fn is_connected(&self) -> bool {
        self.view().get("connection").and_then(serde_json::Value::as_str) == Some("connected")
    }
    fn connect(&self, island_root: &Path) {
        crate::agentconn::AgentConn::connect(self, island_root);
    }
}

/// What one keeper step did.
#[derive(Debug, PartialEq, Eq)]
pub enum Tick {
    /// Already connected: nothing to do (the backoff starts over).
    Connected,
    /// Not connected and the next attempt is not due yet.
    Waiting,
    /// An attempt ran; `true` when it connected.
    Tried(bool),
}

/// One keeper step: connect when the link is down and the backoff says it is due.
pub fn tick(link: &impl Link, island_root: &Path, backoff: &mut Backoff, now: Instant) -> Tick {
    if link.is_connected() {
        backoff.connected();
        return Tick::Connected;
    }
    if !backoff.due(now) {
        return Tick::Waiting;
    }
    link.connect(island_root);
    if link.is_connected() {
        backoff.connected();
        Tick::Tried(true)
    } else {
        backoff.failed_at(now);
        Tick::Tried(false)
    }
}

/// Whole seconds until the next attempt, rounded UP (a wait that is left never reads «0 s»); `None` when nothing is scheduled.
pub fn countdown_secs(remaining: Option<Duration>) -> Option<u64> {
    remaining.map(|d| d.as_secs() + u64::from(d.subsec_nanos() > 0))
}

/// Put the countdown on an agent view: `retry_in` is the seconds to the keeper's next attempt while the connection is down,
/// and an explicit `null` otherwise (so a page that merges partial states drops an older number). Anything that is not a
/// JSON object is left alone.
pub fn decorate(view: &mut serde_json::Value, secs: Option<u64>) {
    let Some(map) = view.as_object_mut() else { return };
    let down = map.get("connection").and_then(serde_json::Value::as_str) != Some("connected");
    map.insert("retry_in".into(), if down { secs.map_or(serde_json::Value::Null, Into::into) } else { serde_json::Value::Null });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::path::PathBuf;

    /// A link that connects only when `engine_up` is set; counts the attempts.
    struct Fake {
        up: Cell<bool>,
        engine_up: Cell<bool>,
        attempts: Cell<u32>,
    }
    impl Fake {
        fn new(engine_up: bool) -> Fake {
            Fake { up: Cell::new(false), engine_up: Cell::new(engine_up), attempts: Cell::new(0) }
        }
    }
    impl Link for Fake {
        fn is_connected(&self) -> bool {
            self.up.get()
        }
        fn connect(&self, _root: &Path) {
            self.attempts.set(self.attempts.get() + 1);
            self.up.set(self.engine_up.get());
        }
    }
    fn root() -> PathBuf {
        PathBuf::from("/island")
    }

    #[test]
    fn the_first_attempt_is_immediate_and_the_delays_grow_to_a_cap() {
        let t0 = Instant::now();
        let mut b = Backoff::new();
        assert!(b.due(t0), "nothing scheduled: the first attempt is due at once");
        let mut now = t0;
        let mut seen = vec![];
        for _ in 0..7 {
            b.failed_at(now);
            let wait = b.remaining(now).expect("an attempt is scheduled");
            seen.push(wait.as_secs());
            now += wait;
            assert!(b.due(now));
        }
        assert_eq!(seen, [2, 4, 8, 15, 30, 30, 30], "2, 4, 8, 15, 30 s and then 30 s for ever");
    }

    #[test]
    fn a_lost_engine_comes_back_by_itself_without_a_click() {
        let t0 = Instant::now();
        let link = Fake::new(false);
        let mut b = Backoff::new();
        assert_eq!(tick(&link, &root(), &mut b, t0), Tick::Tried(false), "engine absent: one attempt, no connection");
        assert_eq!(tick(&link, &root(), &mut b, t0 + Duration::from_millis(500)), Tick::Waiting, "no storm: the gap holds");
        assert_eq!(link.attempts.get(), 1);
        link.engine_up.set(true); // the engine restarts
        assert_eq!(tick(&link, &root(), &mut b, t0 + Duration::from_secs(1)), Tick::Waiting, "still inside the 2 s gap");
        assert_eq!(tick(&link, &root(), &mut b, t0 + Duration::from_secs(2)), Tick::Tried(true), "reconnected on its own");
        assert_eq!(b.failed(), 0, "a connection starts the backoff over");
        assert_eq!(tick(&link, &root(), &mut b, t0 + Duration::from_secs(3)), Tick::Connected);
        assert_eq!(link.attempts.get(), 2, "a live connection is never touched");
    }

    #[test]
    fn an_absent_engine_backs_off_instead_of_spinning() {
        let t0 = Instant::now();
        let link = Fake::new(false);
        let mut b = Backoff::new();
        let mut now = t0;
        for _ in 0..200 {
            tick(&link, &root(), &mut b, now);
            now += Duration::from_millis(500); // the keeper's tick
        }
        // 100 s of ticks: attempts at 0, 2, 6, 14, 29, 59, 89 s = 7, never 200
        assert_eq!(link.attempts.get(), 7);
    }

    #[test]
    fn retry_now_tries_at_once_but_keeps_the_backoff_for_a_still_missing_engine() {
        let t0 = Instant::now();
        let link = Fake::new(false);
        let mut b = Backoff::new();
        tick(&link, &root(), &mut b, t0);
        tick(&link, &root(), &mut b, t0 + Duration::from_secs(2));
        assert_eq!(b.failed(), 2);
        b.retry_now();
        assert!(b.due(t0 + Duration::from_secs(3)), "«Reintentar» is due immediately");
        assert_eq!(tick(&link, &root(), &mut b, t0 + Duration::from_secs(3)), Tick::Tried(false));
        assert_eq!(b.failed(), 3, "the count was kept");
        assert_eq!(b.remaining(t0 + Duration::from_secs(3)), Some(Duration::from_secs(8)), "and the next wait is the 3rd step, not 2 s");
    }

    #[test]
    fn the_countdown_is_whole_seconds_rounded_up_and_absent_when_nothing_is_scheduled() {
        assert_eq!(countdown_secs(None), None);
        assert_eq!(countdown_secs(Some(Duration::from_millis(1))), Some(1), "never shows 0 s while a wait is left");
        assert_eq!(countdown_secs(Some(Duration::from_millis(1500))), Some(2));
        assert_eq!(countdown_secs(Some(Duration::from_secs(30))), Some(30));
    }

    #[test]
    fn a_view_carries_the_countdown_only_while_it_is_not_connected() {
        let mut down = serde_json::json!({"connection": "lost", "last_error": null});
        decorate(&mut down, Some(4));
        assert_eq!(down["retry_in"], serde_json::json!(4));
        let mut gone = serde_json::json!({"connection": "no_daemon"});
        decorate(&mut gone, None);
        assert_eq!(gone["retry_in"], serde_json::Value::Null, "nothing scheduled: an explicit null clears an older number");
        let mut up = serde_json::json!({"connection": "connected"});
        decorate(&mut up, Some(4));
        assert_eq!(up["retry_in"], serde_json::Value::Null, "a live connection never shows a countdown");
        let mut odd = serde_json::json!("not an object");
        decorate(&mut odd, Some(4)); // must not panic or invent a shape
        assert_eq!(odd, serde_json::json!("not an object"));
    }
}

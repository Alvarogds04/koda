//! Auth retry decision — pure module, unit M3 (test-first, RED → GREEN).
//!
//! The legacy rule, verbatim (`main.cjs authenticated`, 204, with the
//! comment at 217):
//!
//! > Only known rejected requests may be retried. Never retry a network
//! > failure.
//!
//! So a retry ladder rung is pulled ONLY by a response the host actually
//! saw and identified as `403`. Every other outcome is terminal for that
//! attempt: delivered statuses go to the caller, transport failures
//! (connect refused, EOF, timeout, oversized/malformed body, quit) propagate
//! as failures WITHOUT touching the ladder, and `401`/`3xx` never reach this
//! module at all — the request layer already stopped authentication for them
//! (`main.cjs request`, 171).
//!
//! The ladder itself (`main.cjs authenticated` 208-217):
//! 1. first `403` → switch to `explicit` (re-validate the session cookie),
//! 2. second `403` → remint (at most `MAX_MINTS` mints in the process),
//! 3. third `403` → stop authentication for good (`stopped`, poll cleared).

use serde::Serialize;

/// `main.cjs authMode`: `none` (initial/stopped), `jar` (the cookie jar
/// attaches what it has), `explicit` (the host re-reads and validates the
/// cookie itself before every request).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub enum AuthMode {
    #[default]
    None,
    Jar,
    Explicit,
}

impl AuthMode {
    /// The exact string `main.cjs mode()` prints — the mode name and
    /// nothing else (auth diagnostics carry no values).
    pub const fn as_str(self) -> &'static str {
        match self {
            AuthMode::None => "none",
            AuthMode::Jar => "jar",
            AuthMode::Explicit => "explicit",
        }
    }
}

/// `main.cjs mints >= 2` (195): at most TWO `GET /` mints ever happen in
/// one process (the startup mint plus, at most, one ladder remint).
pub const MAX_MINTS: u32 = 2;

/// The recovery rung a known `403` pulls (`main.cjs authenticated`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// First rejection: latch `explicitUsed`, validate the stored cookie,
    /// retry the SAME request with the explicit `Cookie` header.
    Explicit,
    /// Second rejection: latch `remintUsed`, remint (bounded by
    /// [`MAX_MINTS`]), retry the same request.
    Remint,
    /// Third rejection (or a cookie that cannot be validated): stop
    /// authentication — `mode('none')`, `status('stopped')`, poll cleared.
    Stop,
}

/// What the caller does with one observed request outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    /// A known response that is not `403`: hand it to the caller as-is.
    Delivered(u16),
    /// A known `403`: the ladder may run (subject to its own state).
    Recover,
    /// No response was ever identified (`Err`): fail this attempt WITHOUT
    /// retrying — this is the "never retry a network failure" rule.
    Fatal,
}

/// `main.cjs authenticated`'s per-response decision, pure half. `Ok(403)`
/// alone may pull a recovery rung; `Err` never does.
pub fn classify<E>(result: &Result<u16, E>) -> Flow {
    match result {
        Ok(403) => Flow::Recover,
        Ok(status) => Flow::Delivered(*status),
        Err(_) => Flow::Fatal,
    }
}

/// The ladder state (`main.cjs` lines 56 + `explicitUsed`/`remintUsed`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthLadder {
    pub mode: AuthMode,
    pub explicit_used: bool,
    pub remint_used: bool,
    pub mints: u32,
    pub stopped: bool,
}

impl AuthLadder {
    pub const fn new() -> Self {
        AuthLadder {
            mode: AuthMode::None,
            explicit_used: false,
            remint_used: false,
            mints: 0,
            stopped: false,
        }
    }

    /// `main.cjs mode(value)` (110): change the mode and answer the name to
    /// print, or `None` when nothing changed (already there / quitting).
    pub fn set_mode(&mut self, mode: AuthMode) -> Option<&'static str> {
        if self.mode == mode {
            return None; // `if (authMode === value) return` — no reprint
        }
        self.mode = mode;
        Some(mode.as_str())
    }

    /// `main.cjs startBridge` mode('jar') (298).
    pub fn begin(&mut self) -> Option<&'static str> {
        self.set_mode(AuthMode::Jar)
    }

    /// `main.cjs mint` (194): `if (mints >= 2) throw` BEFORE incrementing —
    /// a refused mint is not a stop (the caller decides that), it is simply
    /// no mint.
    pub fn try_mint(&mut self) -> bool {
        if self.mints >= MAX_MINTS {
            return false;
        }
        self.mints += 1;
        true
    }

    /// `main.cjs stopAuth` (118): latch `stopped`, mode → `none` (printed
    /// only on change).
    pub fn stop(&mut self) -> Option<&'static str> {
        self.stopped = true;
        self.set_mode(AuthMode::None)
    }

    /// One rung of `main.cjs authenticated`'s `403` ladder. Once stopped,
    /// every further rejection answers `Stop` (no rung may fire again).
    pub fn recovery_after_403(&mut self) -> Recovery {
        if self.stopped {
            return Recovery::Stop;
        }
        if !self.explicit_used {
            self.explicit_used = true;
            // legacy branch: `explicitUsed = true; mode('explicit');` — the
            // mode flips BEFORE the cookie is re-validated (so a failed
            // validation then prints `none` right after, as legacy does)
            self.set_mode(AuthMode::Explicit);
            return Recovery::Explicit;
        }
        if !self.remint_used {
            self.remint_used = true;
            return Recovery::Remint;
        }
        self.stop(); // third known rejection: stopAuth() + throw
        Recovery::Stop
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `authenticated` loop, pure transcription for ladder arithmetic:
    /// `rejects` known 403s are served, then the outcome. Network failures
    /// are `Err` and must exit before any rung.
    fn run(ladder: &mut AuthLadder, outcomes: &[Result<u16, ()>]) -> (u32, Flow) {
        let mut sends = 0u32;
        for outcome in outcomes {
            sends += 1;
            match classify(outcome) {
                Flow::Delivered(status) => return (sends, Flow::Delivered(status)),
                Flow::Fatal => return (sends, Flow::Fatal),
                Flow::Recover => match ladder.recovery_after_403() {
                    Recovery::Explicit => continue,
                    Recovery::Remint => {
                        assert!(ladder.try_mint(), "the remint rung mints");
                        continue;
                    }
                    Recovery::Stop => return (sends, Flow::Recover),
                },
            }
        }
        panic!("script exhausted")
    }

    // --- mode()/status printing (main.cjs 110) ----------------------------

    #[test]
    fn mode_prints_only_on_change_in_the_legacy_order() {
        let mut ladder = AuthLadder::new();
        assert_eq!(ladder.mode, AuthMode::None);
        assert_eq!(ladder.begin(), Some("jar")); // startBridge prints `jar`
        assert_eq!(ladder.begin(), None, "same mode never reprints");
        assert_eq!(ladder.set_mode(AuthMode::Explicit), Some("explicit"));
        assert_eq!(ladder.set_mode(AuthMode::Explicit), None);
        assert_eq!(ladder.stop(), Some("none"));
        assert_eq!(ladder.stop(), None);
        assert!(ladder.stopped);
    }

    // --- mint bound (main.cjs 194) ----------------------------------------

    #[test]
    fn at_most_two_mints_ever() {
        let mut ladder = AuthLadder::new();
        assert!(ladder.try_mint());
        assert_eq!(ladder.mints, 1);
        assert!(ladder.try_mint());
        assert_eq!(ladder.mints, 2);
        assert!(!ladder.try_mint(), "third mint refused");
        assert_eq!(ladder.mints, 2, "refused mint does not count");
    }

    // --- the 403 ladder (main.test.cjs `auth 403 ladder`) -----------------

    #[test]
    fn first_403_takes_explicit_then_delivers() {
        let mut ladder = AuthLadder::new();
        ladder.begin();
        assert!(ladder.try_mint()); // startup mint
        let (sends, flow) = run(&mut ladder, &[Ok(403), Ok(200)]);
        assert_eq!(sends, 2);
        assert_eq!(flow, Flow::Delivered(200));
        assert_eq!(ladder.mode, AuthMode::Explicit);
        assert_eq!(ladder.mints, 1, "startup mint only");
        assert!(!ladder.stopped);
    }

    #[test]
    fn second_403_reMints_once_then_delivers() {
        let mut ladder = AuthLadder::new();
        ladder.begin();
        assert!(ladder.try_mint()); // startup mint
        let (sends, flow) = run(&mut ladder, &[Ok(403), Ok(403), Ok(200)]);
        assert_eq!(sends, 3);
        assert_eq!(flow, Flow::Delivered(200));
        assert_eq!(ladder.mints, 2, "one remint, never more");
        assert!(!ladder.stopped);
    }

    #[test]
    fn third_403_stops_after_exactly_two_mints_and_never_runs_again() {
        let mut ladder = AuthLadder::new();
        ladder.begin();
        assert!(ladder.try_mint()); // startup mint
        let (sends, flow) = run(&mut ladder, &[Ok(403), Ok(403), Ok(403)]);
        assert_eq!(sends, 3, "the third known rejection ends the ladder");
        assert_eq!(flow, Flow::Recover);
        assert!(ladder.stopped);
        assert_eq!(ladder.mode, AuthMode::None, "stopAuth prints `none`");
        assert_eq!(ladder.mints, 2);
        // once stopped, a further 403 may not pull any rung
        assert_eq!(ladder.recovery_after_403(), Recovery::Stop);
        assert_eq!(ladder.mints, 2);
    }

    #[test]
    fn repeated_403s_with_mints_exhausted_stop() {
        // `healthy polling never uses more than two mints`: startup mint,
        // one healthy stretch, then rejections — explicit already used,
        // remint already used → the very first later 403 stops.
        let mut ladder = AuthLadder::new();
        ladder.begin();
        assert!(ladder.try_mint());
        assert_eq!(ladder.recovery_after_403(), Recovery::Explicit);
        assert_eq!(ladder.recovery_after_403(), Recovery::Remint);
        assert!(ladder.try_mint()); // the remint itself
        assert_eq!(ladder.recovery_after_403(), Recovery::Stop);
        assert_eq!(ladder.mints, 2);
        // and a mint refused by the cap does not stop by itself
        let mut ladder = AuthLadder::new();
        ladder.begin();
        assert!(ladder.try_mint());
        assert!(ladder.try_mint());
        assert!(!ladder.try_mint());
        assert!(!ladder.stopped, "the cap is not a stop");
    }

    // --- never retry a network failure (main.cjs 204-217) -----------------

    #[test]
    fn a_network_failure_is_fatal_and_never_touches_the_ladder() {
        let mut ladder = AuthLadder::new();
        ladder.begin();
        assert!(ladder.try_mint());
        let (sends, flow) = run(&mut ladder, &[Err(()), Ok(200)]);
        assert_eq!(sends, 1, "the failed attempt is not retried");
        assert_eq!(flow, Flow::Fatal);
        assert_eq!(ladder.mints, 1);
        assert!(!ladder.stopped, "a transport failure is not a stop either");
        assert_eq!(ladder.mode, AuthMode::Jar, "ladder untouched");
        assert_eq!(classify::<()>(&Ok(403)), Flow::Recover);
        assert_eq!(classify::<()>(&Ok(404)), Flow::Delivered(404));
        assert_eq!(classify::<()>(&Ok(500)), Flow::Delivered(500));
        assert_eq!(classify::<()>(&Ok(401)), Flow::Delivered(401), "401 never reaches here");
        assert_eq!(classify(&Err::<u16, ()>(())), Flow::Fatal);
    }
}

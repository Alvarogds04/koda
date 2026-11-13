use super::*;

const NOW: u64 = 1_700_000_000_000;

#[test]
fn a_new_session_is_idle() {
    assert!(!Session::default().is_active(NOW));
}

#[test]
fn a_grant_lasts_thirty_minutes_and_then_expires() {
    let mut session = Session::default();
    session.grant(NOW);
    assert_eq!(SESSION_MS, 30 * 60 * 1000);
    assert!(session.is_active(NOW + SESSION_MS - 1));
    assert!(!session.is_active(NOW + SESSION_MS));
}

#[test]
fn ending_the_session_stops_it_at_once() {
    let mut session = Session::default();
    session.grant(NOW);
    session.end();
    assert!(!session.is_active(NOW + 1));
}

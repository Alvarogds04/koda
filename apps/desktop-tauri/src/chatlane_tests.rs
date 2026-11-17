//! K2-05 U5a — the direct Rust chat lane is gone; these tests cover only the
//! shared vocabulary left behind for the local registry and the manual
//! specialists (U5b/U5d, K2-05 L59).

use super::*;

#[test]
fn a_fresh_lane_reports_an_unchecked_availability() {
    let lane = Lane::new("c-island");
    let lane = lane.lock().expect("lane lock");
    assert_eq!(lane.availability.state, "unchecked");
    assert!(!lane.availability.can_send(), "nothing is known before the first metadata read");
}

#[test]
fn only_ready_and_busy_allow_a_send() {
    for state in ["ready", "busy"] {
        let a = Availability { state, message: String::new() };
        assert!(a.can_send(), "{state} accepts a send");
    }
    for state in ["unchecked", "unavailable", "blocked"] {
        let a = Availability { state, message: String::new() };
        assert!(!a.can_send(), "{state} refuses a send");
    }
}

#[test]
fn the_shared_prompts_stay_the_koda_identity() {
    assert!(SYSTEM_PROMPT.starts_with("Te llamas Koda"));
    assert!(SYSTEM_PROMPT.contains("Funcionas con un modelo local de esta máquina. "));
    assert!(CLOUD_MODEL_PROMPT.contains("proveedor de nube"));
    // the specialists' cloud rewrite relies on this exact substring
    assert!(SYSTEM_PROMPT.contains("Funcionas con un modelo local de esta máquina. "));
}

#[test]
fn gigabytes_is_spanish_and_one_decimal() {
    assert_eq!(gigabytes(18_200_000_000), "18,2 GB");
    assert_eq!(gigabytes(0), "0,0 GB");
    assert_eq!(gigabytes(999), "0,0 GB");
}

#[test]
fn the_output_cap_and_the_preflight_deadline_are_bounded() {
    assert_eq!(ISLAND_MAX_OUTPUT_TOKENS, 1024);
    assert_eq!(PREFLIGHT_DEADLINE_MS, 1_500);
}

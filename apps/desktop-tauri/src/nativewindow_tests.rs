use super::{defer, logical_size};

#[test]
fn physical_requests_use_actual_scale_and_round_like_tao() {
    for scale in [1.0, 1.25, 2.0] {
        for (w, h) in [(288, 32), (752, 200), (752, 280)] {
            let physical = (
                (w as f64 * scale).round() as i32,
                (h as f64 * scale).round() as i32,
            );
            assert_eq!(logical_size(physical.0, physical.1, scale), Ok((w, h)));
        }
    }
    assert_eq!(logical_size(1279, 65, 2.0), Ok((640, 33)));
}

#[test]
fn invalid_or_unrepresentable_requests_fail_closed() {
    for scale in [
        0.0,
        -1.0,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::MIN_POSITIVE,
        f64::MAX,
    ] {
        assert!(logical_size(608, 88, scale).is_err());
    }
    for (w, h) in [(0, 88), (608, 0), (-1, 88), (608, -1)] {
        assert!(logical_size(w, h, 2.0).is_err());
    }
}

#[test]
fn idle_never_reenters_the_admission_guard() {
    use std::sync::{Arc, Mutex};
    let context = gtk::glib::MainContext::default();
    let _owner = context.acquire().unwrap();
    let admission = Arc::new(Mutex::new(false));
    let guard = admission.lock().unwrap();
    let observed = admission.clone();
    defer(move || {
        *observed
            .try_lock()
            .expect("admission must be released before GTK job") = true
    });
    assert!(!*guard, "enqueue must not execute inline");
    drop(guard);
    while !*admission.lock().unwrap() {
        context.iteration(false);
    }
}

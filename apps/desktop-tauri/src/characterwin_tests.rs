use super::*;

#[test]
fn drop_decision_prioritizes_home_then_explicit_context_over_install() {
    for from in ["island", "desktop"] {
        assert_eq!(drop_outcome(true, true, from), DropOutcome::Home);
        assert_eq!(drop_outcome(true, false, from), DropOutcome::Home);
        assert_eq!(drop_outcome(false, true, from), DropOutcome::AttachAndReturn);
        assert_eq!(drop_outcome(false, false, from), DropOutcome::Install);
    }
}

// Mirrors Coucou's desktop.rs tests (isOverBody, clampOrigin, spots, flights).

#[test]
fn is_over_body() {
    let s = 120.0;
    let r = s * BODY_RADIUS_FRACTION;
    assert!(super::is_over_body((60.0, 60.0), s));
    assert!(super::is_over_body((60.0 + r - 0.5, 60.0), s));
    assert!(!super::is_over_body((60.0 + r + 0.5, 60.0), s));
    assert!(!super::is_over_body((0.0, 0.0), s));
}

#[test]
fn clamp_origin_keeps_it_inside_the_work_area() {
    let work = Rect { x: 0.0, y: 0.0, w: 1440.0, h: 860.0 };
    let (s, m) = (120.0, 24.0);
    assert_eq!(clamp_origin((600.0, 400.0), s, work, m), (600.0, 400.0));
    assert_eq!(clamp_origin((-50.0, 400.0), s, work, m).0, m);
    assert_eq!(clamp_origin((2000.0, 400.0), s, work, m).0, 1440.0 - s - m);
    assert_eq!(clamp_origin((400.0, -50.0), s, work, m).1, m);
    assert_eq!(clamp_origin((400.0, 2000.0), s, work, m).1, 860.0 - s - m);
}

fn two_displays() -> Vec<Display> {
    let a = Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 };
    let b = Rect { x: 1920.0, y: -200.0, w: 3840.0, h: 2160.0 };
    vec![
        Display { frame: a, work: Rect { h: 1032.0, ..a }, scale: 1.0 },
        Display { frame: b, work: Rect { h: 2064.0, ..b }, scale: 2.0 },
    ]
}

#[test]
fn a_spot_on_a_connected_display_is_kept() {
    let d = two_displays();
    assert_eq!(restore_spot((800.0, 600.0), &d, 120.0, 24.0), Some((800.0, 600.0)));
    assert_eq!(restore_spot((3000.0, 1000.0), &d, 120.0, 24.0), Some((3000.0, 1000.0)));
}

#[test]
fn a_spot_on_a_display_that_is_gone_brings_it_home() {
    let d = two_displays();
    assert_eq!(restore_spot((-1500.0, 300.0), &d, 120.0, 24.0), None);
    assert_eq!(restore_spot((800.0, 600.0), &[], 120.0, 24.0), None);
    assert_eq!(restore_spot((3000.0, 1000.0), &d[..1], 120.0, 24.0), None);
}

#[test]
fn a_spot_that_a_taller_panel_now_covers_moves_up() {
    let d = two_displays();
    let (x, y) = restore_spot((800.0, 1000.0), &d, 120.0, 24.0).unwrap();
    assert_eq!((x, y), (800.0, 1032.0 - 120.0 - 24.0));
    let (_, y) = restore_spot((3000.0, 1700.0), &d, 120.0, 24.0).unwrap();
    assert_eq!(y, -200.0 + 2064.0 - 240.0 - 48.0);
}

#[test]
fn a_drop_settles_on_the_display_under_it() {
    let d = two_displays();
    assert_eq!(settle((1800.0, 500.0), &d, 120.0, 24.0), (1920.0 - 120.0 - 24.0, 500.0));
    assert_eq!(settle((1870.0, 500.0), &d, 120.0, 24.0), (1920.0 + 48.0, 500.0));
    assert_eq!(settle((1000.0, -150.0), &d, 120.0, 24.0), (1000.0, 24.0));
}

#[test]
fn first_visit_is_the_bottom_right_corner() {
    let d = two_displays();
    assert_eq!(default_spot(&d[0], 120.0, 24.0), (1920.0 - 144.0, 1032.0 - 144.0));
    assert_eq!(default_spot(&d[1], 120.0, 24.0), (1920.0 + 3840.0 - 288.0, -200.0 + 2064.0 - 288.0));
}

#[test]
fn dropping_on_the_island_is_home() {
    let island = Rect { x: 816.0, y: 0.0, w: 288.0, h: 32.0 };
    assert!(is_home_drop((900.0, 10.0), island));
    assert!(!is_home_drop((900.0, 40.0), island));
    assert!(!is_home_drop((100.0, 10.0), island));
}

#[test]
fn it_leaves_and_returns_under_the_top_centre() {
    assert_eq!(island_spot(960.0, 0.0, 120.0, 1.0), (900.0, 0.0));
    assert_eq!(island_spot(2880.0, -200.0, 120.0, 2.0), (2760.0, -200.0));
}

#[test]
fn flights_start_and_end_where_asked() {
    for ease in [ease_in_out as fn(f64) -> f64, ease_out_back] {
        assert!(ease(0.0).abs() < 1e-9);
        assert!((ease(1.0) - 1.0).abs() < 1e-9);
    }
    assert!(ease_out_back(0.7) > 1.0, "the landing overshoots a little");
    assert_eq!(lerp((0.0, 10.0), (100.0, 20.0), 0.5), (50.0, 15.0));
}

#[test]
fn constants_are_coucous() {
    assert_eq!((SIZE, TICK_MS, FLIGHT_MS, SNAP_MS), (120.0, 16, 450, 250));
}

#[test]
fn a_drag_moves_in_physical_pixels() {
    assert_eq!(drag_top_left((100.0, 200.0), (510.0, 320.0), (500.0, 300.0), 2.0), (120.0, 240.0));
}

#[test]
fn only_the_exact_character_page_and_label_may_call_the_drag_verbs() {
    assert!(character_sender_ok("character", "tauri://localhost/desktop-character.html").is_ok());
    for (label, url) in [
        ("main", "tauri://localhost/desktop-character.html"),
        ("settings", "tauri://localhost/desktop-character.html"),
        ("character", "tauri://localhost/index.html"),
        ("character", "tauri://localhost/desktop-character.html?x=1"),
        ("character", "tauri://localhost/desktop-character.html#a"),
        ("character", "https://evil.example/desktop-character.html"),
        ("Character", "tauri://localhost/desktop-character.html"),
        ("character ", "tauri://localhost/desktop-character.html"),
        ("", ""),
    ] {
        assert!(character_sender_ok(label, url).is_err(), "{label:?} {url:?}");
    }
}

#[test]
fn only_finite_bounded_points_are_accepted() {
    assert_eq!(valid_point(10.5, -20.0), Some((10.5, -20.0)));
    for (x, y) in [(f64::NAN, 0.0), (0.0, f64::INFINITY), (1e9, 0.0), (0.0, -1e9)] {
        assert_eq!(valid_point(x, y), None, "{x} {y}");
    }
}

#[test]
fn a_saved_spot_is_rounded_to_whole_physical_pixels() {
    assert_eq!(spot_to_pref((1500.4, -300.6)), (1500, -301));
    assert_eq!(pref_to_spot((7, -9)), (7.0, -9.0));
}

#[test]
fn the_cursor_reaches_the_page_in_window_local_logical_pixels() {
    // window at (1000, 500) physical, scale 2: a cursor 120 physical px right and 60 down is (60, 30) css.
    assert_eq!(cursor_local((1120.0, 560.0), (1000.0, 500.0), 2.0), (60.0, 30.0));
    assert_eq!(cursor_local((10.0, 10.0), (0.0, 0.0), 0.0), (10.0, 10.0), "a bad scale reads as 1");
}

#[test]
fn a_pick_up_centres_the_window_on_the_pointer() {
    assert_eq!(centred_on((500.0, 400.0), 120.0, 1.0), (440.0, 340.0));
    assert_eq!(centred_on((500.0, 400.0), 120.0, 2.0), (380.0, 280.0));
}

#[test]
fn island_client_points_map_to_screen_physical_pixels() {
    assert_eq!(client_to_screen((10.0, 5.0), (800.0, 0.0), 2.0), (820.0, 10.0));
}

#[test]
fn the_island_may_push_only_known_states_and_emotes() {
    for s in ["idle", "listen", "think", "speak", "reject", "confirm", "error", "working", "searching", "approval", "question", "finished", "ratelimit", "sleeping", "dizzy"] {
        assert!(valid_state(s), "{s}");
    }
    for s in ["", "Idle", "idle ", "<script>", "sleeping\n", "x".repeat(64).as_str()] {
        assert!(!valid_state(s), "{s:?}");
    }
    for e in ["love", "surprised", "proud", "wink", "yawn", "happy", "annoyed"] {
        assert!(valid_emote(e), "{e}");
    }
    assert!(!valid_emote("greeting") && !valid_emote("") && !valid_emote("Happy"));
}

fn covered(rects: &[(i16, i16, u16, u16)], p: (i16, i16)) -> bool {
    rects.iter().any(|&(x, y, w, h)| p.0 >= x && p.0 < x + w as i16 && p.1 >= y && p.1 < y + h as i16)
}

#[test]
fn the_input_shape_is_the_round_body_only() {
    // 120 css px at scale 1: centre (60,60), radius 28.8.
    let r = body_input_rects(120.0, 1.0);
    assert!(!r.is_empty() && r.len() <= 64, "a bounded list of rectangles: {}", r.len());
    assert!(covered(&r, (60, 60)) && covered(&r, (60, 35)) && covered(&r, (85, 60)), "inside the body takes the mouse");
    for p in [(0, 0), (119, 119), (60, 5), (60, 115), (5, 60), (115, 60), (88, 88)] {
        assert!(!covered(&r, p), "{p:?} is click-through");
    }
    // every rectangle stays inside the window
    assert!(r.iter().all(|&(x, y, w, h)| x >= 0 && y >= 0 && x + w as i16 <= 120 && y + h as i16 <= 120));
}

#[test]
fn the_shape_follows_the_scale() {
    let r = body_input_rects(120.0, 2.0);
    assert!(covered(&r, (120, 120)) && !covered(&r, (10, 10)));
    assert!(r.iter().all(|&(x, y, w, h)| x + w as i16 <= 240 && y + h as i16 <= 240));
    assert_eq!(body_input_rects(120.0, 0.0), body_input_rects(120.0, 1.0), "a bad scale reads as 1");
}

#[test]
fn the_gaze_thread_ends_as_soon_as_anything_says_so() {
    // current generation == mine, app alive, window there and shown: keep going
    assert!(gaze_should_run(3, 3, false, true, true));
    assert!(!gaze_should_run(4, 3, false, true, true), "a newer show took over");
    assert!(!gaze_should_run(3, 3, true, true, true), "quitting");
    assert!(!gaze_should_run(3, 3, false, false, true), "the window is gone");
    assert!(!gaze_should_run(3, 3, false, true, false), "the window is hidden: nothing to feed");
}

#[test]
fn the_navigation_lock_admits_exactly_the_two_pages_of_the_two_windows() {
    assert!(navigation_allowed("character", "tauri://localhost/desktop-character.html"));
    assert!(navigation_allowed("character-highlight", "tauri://localhost/desktop-highlight.html"));
    for (l, u) in [
        ("character", "tauri://localhost/desktop-highlight.html"),
        ("character-highlight", "tauri://localhost/desktop-character.html"),
        ("character", "tauri://localhost/index.html"),
        ("character", "https://evil.example/desktop-character.html"),
        ("character", "tauri://localhost/desktop-character.html?x=1"),
        ("main", "tauri://localhost/desktop-character.html"),
        ("settings", "tauri://localhost/desktop-highlight.html"),
        ("Character", "tauri://localhost/desktop-character.html"),
    ] {
        assert!(!navigation_allowed(l, u), "{l} {u}");
    }
}

#[test]
fn main_rs_navigation_lock_still_uses_the_sender_gate_and_adds_the_character_pages() {
    let src = include_str!("main.rs");
    let at = src.find("fn navigation_lock()").unwrap();
    let body = &src[at..];
    let body = &body[..body.find("\n}\n").unwrap()];
    assert!(body.contains("bridge::sender_ok(webview.label(), url.as_str()).is_ok()"));
    assert!(body.contains("characterwin::navigation_allowed("));
}

/// #503 T1: the Windows origin for the two character pages is exact and label-bound; it reaches the real gates only on Windows.
#[test]
fn windows_origin_pages_are_exact_and_label_bound() {
    assert!(windows_page("character", "http://tauri.localhost/desktop-character.html"));
    assert!(windows_page("character-highlight", "http://tauri.localhost/desktop-highlight.html"));
    for (l, u) in [
        ("character", "http://tauri.localhost/desktop-highlight.html"), ("character-highlight", "http://tauri.localhost/desktop-character.html"),
        ("main", "http://tauri.localhost/desktop-character.html"), ("character", "http://tauri.localhost.evil.com/desktop-character.html"),
        ("character", "http://tauri.localhost@evil.com/desktop-character.html"), ("character", "http://tauri.localhost:81/desktop-character.html"),
        ("character", "https://tauri.localhost/desktop-character.html"), ("character", "http://tauri.localhost/desktop-character.html?x=1"),
    ] {
        assert!(!windows_page(l, u), "{l} {u}");
    }
    let win = cfg!(windows);
    assert_eq!(navigation_allowed("character", "http://tauri.localhost/desktop-character.html"), win);
    assert_eq!(character_sender_ok("character", "http://tauri.localhost/desktop-character.html").is_ok(), win);
    assert!(navigation_allowed("character", "tauri://localhost/desktop-character.html"));
}

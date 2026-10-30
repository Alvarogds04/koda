//! Closed input-shape reports for the fixed island window.
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Report { pub w: i32, pub h: i32, pub settled: bool }

pub(crate) fn parse(payload: &Value) -> Option<Report> {
    let object = payload.as_object()?;
    if object.len() != 3 { return None; }
    Some(Report {
        w: i32::try_from(object.get("w")?.as_i64()?).ok()?,
        h: i32::try_from(object.get("h")?.as_i64()?).ok()?,
        settled: object.get("settled")?.as_bool()?,
    })
}

/// `{"h": <integer>}` and nothing else: the page asks for a height, Rust decides the size (geometry::clamp_window_height).
pub(crate) fn parse_window_height(payload: &Value) -> Option<i32> {
    let object = payload.as_object()?;
    if object.len() != 1 { return None; }
    i32::try_from(object.get("h")?.as_i64()?).ok()
}

// Only the compact strip may be shorter than the normal compact bar.
fn input_rect(report: Report, window: (i32, i32), protected: bool) -> (i32,i32,i32,i32) {
    // The hidden strip (S1): only the compact pill's two widths, 288 or 440 (session rows / a pending ask), can be one.
    if !protected && abito_island::geometry::COMPACT_WIDTHS.contains(&report.w) && (4..32).contains(&report.h) && report.settled {
        let w = report.w.min(window.0.max(0));
        return ((window.0-w)/2, 0, w, report.h.min(window.1.max(0)));
    }
    abito_island::geometry::island_shape_rect((report.w,report.h), window)
}

/// S29 + HU-057: the compact pill is a rounded box (r16, all four corners); the expanded island is the Nusa notch (square top corners,
/// bottom corners r26: island.js rTop 0 / rBottom OVERVIEW.r). So the transparent corner pixels inside the
/// reported rectangle must pass clicks. The input region is that box as horizontal bands: per pixel row the corner arc's inset
/// is rounded UP, so no pixel outside the drawn shell ever takes a click (at most one drawn pixel per side per row is given up).
/// Only a settled report that IS one island box is rounded: a transition (union of two endpoints plus spring air) and the question
/// toast under the compact pill are not a single box and stay one rectangle, exactly as before.
pub(crate) fn input_rects(report: Report, window: (i32, i32), protected: bool) -> Vec<(i32, i32, i32, i32)> {
    use abito_island::geometry::{COMPACT_BAR, COMPACT_WIDTHS};
    let (x, y, w, h) = input_rect(report, window, protected);
    let compact = COMPACT_WIDTHS.contains(&report.w);
    // (radius, box top): the hidden strip shows only the bottom `h` px of a 32 px pill that sits 32-h px above the window
    let (radius_top, radius_bottom, top) = if report.settled && compact && report.h <= COMPACT_BAR.1 {
        (16.0, 16.0, if protected || report.h >= COMPACT_BAR.1 || h >= COMPACT_BAR.1 { 0 } else { report.h - COMPACT_BAR.1 })
    } else if report.settled && report.w >= 640 && h == report.h.clamp(COMPACT_BAR.1, window.1.max(0)) {
        (0.0, 26.0, 0)
    } else { return vec![(x, y, w, h)] };
    let box_h = if top < 0 { COMPACT_BAR.1 } else { h };
    let mut rects: Vec<(i32, i32, i32, i32)> = Vec::new();
    for row in y.max(0)..(y + h) {
        let centre = f64::from(row - top) + 0.5;                    // the row's centre, in the box
        let (edge, radius) = if centre <= f64::from(box_h) / 2.0 { (centre, radius_top) } else { (f64::from(box_h) - centre, radius_bottom) };
        let inset = if edge >= radius { 0 } else {
            let dy = radius - edge;
            (radius - (radius * radius - dy * dy).max(0.0).sqrt()).ceil() as i32
        };
        let (rx, rw) = (x + inset, w - 2 * inset);
        if rw <= 0 { continue; }
        match rects.last_mut() {
            Some(last) if last.0 == rx && last.2 == rw && last.1 + last.3 == row => last.3 += 1,
            _ => rects.push((rx, row, rw, 1)),
        }
    }
    rects
}

/// A request, an approval card or a question is on screen: such a card must never lose clicks (Linux refuses the thin hidden strip;
/// Windows/macOS never become click-through while it is shown). Main thread only: it takes the host locks the snapshot takes.
pub(crate) fn is_protected(app: &tauri::AppHandle, state: &crate::AppState) -> bool {
    let snap = crate::build_snapshot(app, state);
    let question = crate::questionhost::question_view(state);
    !snap["request"].is_null() || snap["card"]["state"] == "pending" || !question["pending"].is_null()
}

/// The remembered last report (Windows/macOS click-through). Linux keeps the same pair inside its own `SHAPE`.
#[cfg(not(target_os = "linux"))]
static LAST: std::sync::Mutex<((i32, i32), Report)> = std::sync::Mutex::new(((288, 32), Report { w: 288, h: 32, settled: true }));

/// Windows/macOS: remember the page's report (`apply` is called from `island_shape`), and read the current rects for the click-through.
#[cfg(not(target_os = "linux"))]
pub(crate) fn current_rects(window: (i32, i32), protected: bool) -> Vec<(i32, i32, i32, i32)> {
    let mut state = LAST.lock().expect("island shape lock");
    shape_rects(&mut state, None, window, protected)
}

/// The island's input rects for the current report, shared by every platform. `state` = (the last SETTLED destination, the last report):
/// a settled report is remembered; while moving the rects are the union of the previous and the next shape (plus spring air).
pub(crate) fn shape_rects(state: &mut ((i32, i32), Report), report: Option<Report>, window: (i32, i32), protected: bool) -> Vec<(i32, i32, i32, i32)> {
    use abito_island::geometry;
    if let Some(report) = report { state.1 = report; }
    let report = state.1;
    let destination = geometry::clamp_island_shape(report.w, report.h, window);
    let shape = if report.settled {
        state.0 = destination;
        destination
    } else { geometry::transition_shape(state.0, destination, window) };
    input_rects(if report.settled { report } else { Report { w: shape.0, h: shape.1, settled: false } }, window, protected)
}

#[cfg(target_os = "linux")]
static SHAPE: std::sync::Mutex<((i32, i32), Report)> = std::sync::Mutex::new(
    ((288, 32), Report { w: 288, h: 32, settled: true }));

/// GDK consumes logical pixels and must only be called on GTK's event thread.
/// An idle follows nativewindow's queued size request; realize before obtaining GdkWindow.
#[cfg(target_os = "linux")]
pub(crate) fn apply(app: &tauri::AppHandle, report: Option<Report>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        gtk::glib::idle_add_local_once(move || {
            use gtk::prelude::*;
            use tauri::Manager;
            let Some(win) = crate::main_window(&handle) else { return };
            let Ok(gtk_win) = win.gtk_window() else { return };
            gtk_win.realize();
            let Some(gdk) = gtk_win.window() else { return };
            let window = gtk_win.size();
            let mut state = SHAPE.lock().expect("island shape lock");
            let app_state = handle.state::<crate::AppState>();
            let protected = is_protected(&handle, &app_state);
            let rects: Vec<_> = shape_rects(&mut state, report, window, protected)
                .into_iter().map(|(x, y, w, h)| gtk::cairo::RectangleInt::new(x, y, w, h)).collect();
            let region = gtk::cairo::Region::create_rectangles(&rects);
            gdk.input_shape_combine_region(&region, 0, 0);
        });
    });
}

/// Windows/macOS: only REMEMBER the page's report; the click-through poller (islandclick) reads it on its own cadence.
#[cfg(not(target_os = "linux"))]
pub(crate) fn apply(_app: &tauri::AppHandle, report: Option<Report>) {
    if let Some(report) = report {
        let mut state = LAST.lock().expect("island shape lock");
        state.1 = report;
        // a settled report also fixes the destination the next transition starts from (same bookkeeping as shape_rects)
        if report.settled { state.0 = abito_island::geometry::clamp_island_shape(report.w, report.h, abito_island::geometry::ISLAND_WINDOW); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn window_height_payload_is_exactly_one_integer_named_h() {
        assert_eq!(parse_window_height(&json!({"h":600})), Some(600));
        assert_eq!(parse_window_height(&json!({"h":-5})), Some(-5), "Rust clamps; the parser only checks the shape");
        for bad in [json!(null), json!({}), json!(600), json!({"h":600.5}), json!({"h":"600"}), json!({"h":null}),
            json!({"h":600,"w":672}), json!({"height":600}), json!({"h":2147483648_i64}), json!([600])] {
            assert_eq!(parse_window_height(&bad), None, "{bad}");
        }
    }
    #[test]
    fn reports_are_exactly_two_integers_and_a_boolean() {
        assert_eq!(parse(&json!({"w":640,"h":160,"settled":false})), Some(Report { w:640,h:160,settled:false }));
        assert_eq!(parse(&json!({"w":-1,"h":i32::MAX,"settled":true})), Some(Report { w:-1,h:i32::MAX,settled:true }));
        for bad in [json!(null), json!({}), json!({"w":640,"h":160}),
            json!({"w":640.5,"h":160,"settled":true}), json!({"w":640,"h":"160","settled":true}),
            json!({"w":640,"h":160,"settled":1}), json!({"w":640,"h":160,"settled":true,"x":0}),
            json!({"w":2147483648_i64,"h":160,"settled":true})] {
            assert_eq!(parse(&bad), None, "{bad}");
        }
    }
}

#[cfg(test)]
#[test]
fn edge_input_tracks_four_pixel_strip_and_protected_cards_refuse_it() {
    let strip = Report { w:288, h:4, settled:true };
    assert_eq!(input_rect(strip, (752,340), false), (232,0,288,4));
    assert_eq!(input_rect(strip, (752,340), true), (232,0,288,32));
    assert_eq!(input_rect(Report {h:-1,..strip}, (752,340), false), (232,0,288,32));
}

#[cfg(test)]
#[test]
fn the_hidden_strip_input_zone_is_the_drawn_8px_at_every_compact_width_and_never_wider_than_the_pill() {
    // S1: the hidden strip is 24 px up, leaving an 8 px activation zone. The pill is 288 wide, or 440 once there are session rows or a
    // pending ask (COMPACT_WIDE), or 560 for the «Responder» pill (COMPACT_ASK), so the zone must be 8 px tall at BOTH widths (it used to be 32 at 440).
    for w in abito_island::geometry::COMPACT_WIDTHS {
        let strip = Report { w, h: 8, settled: true };
        let (x, y, rw, rh) = input_rect(strip, (752, 340), false);
        assert_eq!((rw, rh), (w, 8), "zone {w} wide, 8 px tall");
        assert_eq!((x, y), ((752 - w) / 2, 0), "centred, at the very top");
        assert_eq!(input_rect(strip, (752, 340), true), (x, 0, w, 32), "a protected ask refuses the thin strip at {w} too");
        assert_eq!(input_rect(Report { settled: false, ..strip }, (752, 340), false).3, 32, "moving: never the thin zone");
    }
    // a pill or card that is NOT a strip keeps today's rule
    assert_eq!(input_rect(Report { w: 440, h: 32, settled: true }, (752, 340), false), (156, 0, 440, 32));
    assert_eq!(input_rect(Report { w: 560, h: 8, settled: true }, (752, 340), false), (96, 0, 560, 8), "the ask pill is a strip too (hidden)");
    assert_eq!(input_rect(Report { w: 560, h: 8, settled: true }, (752, 340), true), (96, 0, 560, 32), "but with a protected ask pending it refuses the thin zone");
    assert_eq!(input_rect(Report { w: 720, h: 8, settled: true }, (752, 340), false).3, 32, "only compact widths can be a strip");
    assert_eq!(input_rect(Report { w: 300, h: 8, settled: true }, (752, 340), false).3, 32, "an unknown width is not a strip");
}

#[cfg(test)]
#[test]
fn the_input_region_covers_exactly_what_is_drawn_for_every_native_size_of_the_island() {
    // The island's full size list (logical px, inside the fixed 752x340 window): compact pill 288/440/560 x 32; hidden strip: same
    // widths x 8; expanded 720x184, 720x220 with the «terminó»/problem band; question 224; recap 208; chat 720 x 240..300.
    let window = (752, 340);
    let centred = |w: i32| (window.0 - w) / 2;
    for w in abito_island::geometry::COMPACT_WIDTHS {
        assert_eq!(input_rect(Report { w, h: 32, settled: true }, window, false), (centred(w), 0, w, 32), "compact {w}x32");
        assert_eq!(input_rect(Report { w, h: 8, settled: true }, window, false), (centred(w), 0, w, 8), "hidden strip {w}x8");
        // a click just BELOW the drawn strip (y = 8) is outside the region, so it passes through to the app underneath
        let (_, y, _, h) = input_rect(Report { w, h: 8, settled: true }, window, false);
        assert!(8 >= y + h, "y=8 is below the {w} strip's zone");
    }
    for (w, h) in [(720, 150), (720, 220), (720, 224), (720, 208), (720, 240), (720, 270), (720, 300)] {
        assert_eq!(input_rect(Report { w, h, settled: true }, window, false), (centred(w), 0, w, h), "expanded {w}x{h} is fully clickable and nothing more");
        assert_eq!(input_rect(Report { w, h, settled: true }, window, true), (centred(w), 0, w, h), "a protected ask changes nothing for a drawn card");
    }
    // whatever the page reports is clamped into the window: never an input region bigger than the native window
    assert_eq!(input_rect(Report { w: 10_000, h: 10_000, settled: true }, window, false), (0, 0, 752, 340));
    // placement: the logical window is 752x340 at every scale, the input region is in LOGICAL px (GDK scales it with the window)
    for (scale, monitor_w) in [(1.0, 1920), (2.0, 3072), (2.0, 3840)] {
        let monitor = abito_island::geometry::Rect { x: 0, y: 0, w: monitor_w, h: monitor_w * 9 / 16 };
        let r = abito_island::geometry::island_window_rect_for(Some(monitor), monitor, scale, 340).unwrap();
        assert_eq!((r.w as f64 / scale, r.h as f64 / scale), (752.0, 340.0), "scale {scale}");
        assert_eq!(r.x + r.w / 2, monitor_w / 2, "centred at scale {scale}");
    }
}

// ── S29: the transparent corner pixels of the rounded shell pass clicks (#503) ──
#[cfg(test)]
mod corners {
    use super::*;
    const W: (i32, i32) = (752, 340);
    fn covers(rects: &[(i32, i32, i32, i32)], x: i32, y: i32) -> bool { rects.iter().any(|&(rx, ry, rw, rh)| x >= rx && x < rx + rw && y >= ry && y < ry + rh) }
    /// Is the CENTRE of pixel (x, y) inside the box (bx, by, bw, bh) with radius rt on the top corners and rb on the bottom ones?
    fn inside(x: i32, y: i32, (bx, by, bw, bh): (i32, i32, i32, i32), (rt_r, rb_r): (f64, f64)) -> bool {
        let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
        let (l, t, rt, b) = (bx as f64, by as f64, (bx + bw) as f64, (by + bh) as f64);
        if px < l || px > rt || py < t || py > b { return false; }
        let top_half = py < (t + b) / 2.0;
        let r = if top_half { rt_r } else { rb_r };
        if r <= 0.0 { return true; }
        let cx = if px < l + r { l + r } else if px > rt - r { rt - r } else { return true };
        let cy = if top_half { if py < t + r { t + r } else { return true } } else if py > b - r { b - r } else { return true };
        (px - cx).powi(2) + (py - cy).powi(2) <= r * r
    }
    /// (report, the drawn box in window px, its radius): what the page draws for each size of the island.
    fn sizes() -> Vec<(Report, (i32, i32, i32, i32), (f64, f64))> {
        let centred = |w: i32| (W.0 - w) / 2;
        let mut out = vec![];
        for w in abito_island::geometry::COMPACT_WIDTHS { out.push((Report { w, h: 32, settled: true }, (centred(w), 0, w, 32), (16.0, 16.0))); }
        for (w, h) in [(720, 150), (720, 220), (720, 208), (720, 224), (720, 240), (720, 300)] { out.push((Report { w, h, settled: true }, (centred(w), 0, w, h), (0.0, 26.0))); }
        // hidden: the pill (32 tall) sits 24 px up, so only its bottom 8 px (with its rounded bottom corners) show
        for w in abito_island::geometry::COMPACT_WIDTHS { out.push((Report { w, h: 8, settled: true }, (centred(w), -24, w, 32), (16.0, 16.0))); }
        out
    }

    #[test]
    fn no_pixel_outside_the_drawn_rounded_shape_takes_a_click_and_almost_none_inside_is_lost() {
        for (report, box_, r) in sizes() {
            let rects = input_rects(report, W, false);
            assert!(!rects.is_empty(), "{report:?}");
            for y in 0..W.1 { for x in 0..W.0 {
                let hit = covers(&rects, x, y);
                if hit { assert!(inside(x, y, box_, r), "{report:?}: pixel ({x},{y}) takes clicks but is outside the rounded shell"); }
            } }
            // coverage: per row at most one pixel per side is given up by rounding the inset UP
            for y in 0..(box_.1 + box_.3).min(W.1) {
                if y < 0 { continue; }
                let missing = (0..W.0).filter(|&x| inside(x, y, box_, r) && !covers(&rects, x, y)).count();
                assert!(missing <= 2, "{report:?}: row {y} loses {missing} drawn pixels");
            }
        }
    }

    /// The expanded notch is square on top (HU-057): only the pill's top corners are rounded.
    fn h_top_round(report: &Report) -> bool { report.h <= 32 }

    #[test]
    fn the_four_corners_of_every_size_pass_clicks_and_the_middle_does_not() {
        for (report, (bx, by, bw, bh), _) in sizes() {
            let rects = input_rects(report, W, false);
            let (top, bottom) = (by.max(0), by + bh - 1);
            if by >= 0 && h_top_round(&report) { for (x, y) in [(bx, top), (bx + bw - 1, top)] { assert!(!covers(&rects, x, y), "{report:?}: top corner ({x},{y}) must pass clicks"); } }
            for (x, y) in [(bx, bottom), (bx + bw - 1, bottom)] { assert!(!covers(&rects, x, y), "{report:?}: bottom corner ({x},{y}) must pass clicks"); }
            let (mx, my) = (bx + bw / 2, (top + bottom) / 2);
            assert!(covers(&rects, mx, my), "{report:?}: the middle takes clicks");
            assert!(covers(&rects, bx + bw / 2, bottom), "{report:?}: the middle of the bottom edge takes clicks");
            assert!(!covers(&rects, bx - 1, my) && !covers(&rects, bx + bw, my), "{report:?}: nothing outside the box");
        }
    }

    #[test]
    fn what_is_not_one_island_box_stays_rectangular() {
        let window = W;
        // a transition (unsettled) holds both endpoints plus spring air: a plain rectangle, as before
        let moving = input_rects(Report { w: 640, h: 160, settled: false }, window, false);
        assert_eq!(moving.len(), 1, "one rectangle while it moves");
        // a question toast under the compact pill (350 or 440/560 wide, 128 tall) is not a single rounded box: rectangular
        for w in [350, 440, 560] { assert_eq!(input_rects(Report { w, h: 128, settled: true }, window, false).len(), 1, "toast shape {w}x128"); }
        // the bounding rectangle is what it always was
        assert_eq!(input_rect(Report { w: 720, h: 150, settled: true }, window, false), (16, 0, 720, 150));
    }

    #[test]
    fn a_protected_ask_keeps_the_rounded_pill_and_never_the_thin_strip() {
        let rects = input_rects(Report { w: 440, h: 8, settled: true }, W, true);
        assert!(covers(&rects, 156 + 220, 31), "the whole 32 px pill takes clicks when an ask is pending");
        assert!(!covers(&rects, 156, 0), "its corner still passes clicks");
    }

    #[test]
    fn the_shape_is_the_same_logical_one_at_any_scale_because_gdk_scales_the_region_with_the_window() {
        // the region is in LOGICAL px (GDK applies the window scale), so the numbers do not depend on the scale
        let a = input_rects(Report { w: 720, h: 150, settled: true }, W, false);
        assert_eq!(a, input_rects(Report { w: 720, h: 150, settled: true }, W, false));
        assert!(a.len() < 120, "a handful of row bands, not a pixel list ({})", a.len());
    }
}

// ── HU-043: ONE computation of the island's input rects for every platform ──
// Linux applies them as a GDK input region; Windows and macOS use them to decide when the window ignores the mouse (islandhit). The
// state machine (settled → remember the destination; moving → union of both endpoints) used to live only inside the Linux `apply`.
#[cfg(test)]
mod shared_rects {
    use super::*;
    const W: (i32, i32) = (752, 340);
    /// What the Linux `apply` computed inline before this change, kept verbatim as the reference.
    fn reference(state: &mut ((i32, i32), Report), report: Option<Report>, protected: bool) -> Vec<(i32, i32, i32, i32)> {
        use abito_island::geometry;
        if let Some(report) = report { state.1 = report; }
        let report = state.1;
        let destination = geometry::clamp_island_shape(report.w, report.h, W);
        let shape = if report.settled { state.0 = destination; destination } else { geometry::transition_shape(state.0, destination, W) };
        input_rects(if report.settled { report } else { Report { w: shape.0, h: shape.1, settled: false } }, W, protected)
    }
    #[test]
    fn the_shared_computation_is_exactly_what_the_linux_apply_computed_inline() {
        let start = ((288, 32), Report { w: 288, h: 32, settled: true });
        let sequence = [
            (Some(Report { w: 288, h: 32, settled: true }), false), (Some(Report { w: 440, h: 32, settled: true }), false),
            (Some(Report { w: 640, h: 160, settled: false }), false), (Some(Report { w: 720, h: 150, settled: true }), false),
            (None, false), (Some(Report { w: 288, h: 8, settled: true }), false), (Some(Report { w: 288, h: 8, settled: true }), true),
            (Some(Report { w: 560, h: 128, settled: false }), true), (Some(Report { w: 10_000, h: 10_000, settled: true }), false), (None, true),
        ];
        let (mut shared, mut expected) = (start, start);
        for (report, protected) in sequence {
            assert_eq!(shape_rects(&mut shared, report, W, protected), reference(&mut expected, report, protected), "{report:?} protected={protected}");
            assert_eq!(shared, expected, "the remembered state evolves identically");
        }
    }
    #[test]
    fn a_report_is_remembered_so_a_repaint_without_one_keeps_the_last_shape() {
        let mut state = ((288, 32), Report { w: 288, h: 32, settled: true });
        let first = shape_rects(&mut state, Some(Report { w: 440, h: 32, settled: true }), W, false);
        assert_eq!(shape_rects(&mut state, None, W, false), first);
    }
}

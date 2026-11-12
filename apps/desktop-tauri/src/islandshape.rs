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

/// The island stands on the window's bottom edge (geometry::Edge::Bottom, isla-cualquier-lado S1/T6b: an island in the lower half
/// of its screen grows up and hangs its toast up). The SAME rule folds and opens: in the lower half the whole window — the open
/// card's column and the folded disc with the toast above it — stands on its bottom edge, in the upper half on its top. Read from
/// the core on the threads that already take it for `is_protected` (build_snapshot locks the core too).
pub(crate) fn anchor_bottom(state: &crate::AppState) -> bool {
    let core = state.core.lock().expect("core lock");
    core.edge == abito_island::geometry::Edge::Bottom
}

/// The rect for the top anchor, moved to the bottom of the window when the card stands on it.
fn anchored(rect: (i32, i32, i32, i32), window: (i32, i32), bottom: bool) -> (i32, i32, i32, i32) {
    if bottom { (rect.0, (window.1.max(0) - rect.3).max(0), rect.2, rect.3) } else { rect }
}

// Only the compact strip may be shorter than the disc.
fn input_rect(report: Report, window: (i32, i32), protected: bool) -> (i32,i32,i32,i32) {
    // The hidden strip (S1): only the compact DISC's own width (island-free-drag S3: compact is the disc, nothing else) can be one.
    if !protected && report.w == abito_island::geometry::COMPACT_DOT.0 && (4..32).contains(&report.h) && report.settled {
        let w = report.w.min(window.0.max(0));
        return ((window.0-w)/2, 0, w, report.h.min(window.1.max(0)));
    }
    abito_island::geometry::island_shape_rect((report.w,report.h), window)
}

/// S29 + HU-057 + island-free-drag S3: the compact island is Koda's disc (40x32, r16 on all four corners — the same box, so it also
/// covers the hidden strip); isla-cualquier-lado S1: the expanded island is the floating card, r26 on all four corners (island.js
/// OVERVIEW.r), at the window top or, anchored on its bottom edge, at the window bottom. T6b: the folded disc and the question toast
/// above it follow the same anchor. So the transparent corner pixels inside the reported rectangle must pass clicks. The input region
/// is that box as horizontal bands: per pixel row the corner arc's inset is rounded UP, so no pixel outside the drawn shell ever
/// takes a click (at most one drawn pixel per side per row is given up). Only a settled report that IS one island box is rounded: a
/// transition (union of two endpoints plus spring air) and the question toast with the compact disc are not a single box and stay
/// one rectangle, exactly as before.
#[cfg(test)]
pub(crate) fn input_rects(report: Report, window: (i32, i32), protected: bool) -> Vec<(i32, i32, i32, i32)> {
    input_rects_anchored(report, window, protected, false)
}
/// `input_rects` for the island anchored on the window's top (`bottom` false) or bottom edge. The whole island moves with the
/// anchor — the open card, the folded disc and the question toast above it (geometry::island_window_rect_placed decides it, and
/// the page puts `#island` on the same edge).
pub(crate) fn input_rects_anchored(report: Report, window: (i32, i32), protected: bool, bottom: bool) -> Vec<(i32, i32, i32, i32)> {
    let compact = report.w == abito_island::geometry::COMPACT_DOT.0;
    let (x, y, w, h) = anchored(input_rect(report, window, protected), window, bottom);
    // (radius, box top): the hidden strip shows only the bottom `h` px of the disc's own 32 px box, so its box top is above it
    let (radius_top, radius_bottom, top) = if report.settled && compact && report.h <= abito_island::geometry::COMPACT_DOT.1 {
        (16.0, 16.0, if protected || report.h >= abito_island::geometry::COMPACT_DOT.1 || h >= abito_island::geometry::COMPACT_DOT.1 { 0 } else { report.h - abito_island::geometry::COMPACT_DOT.1 })
    } else if report.settled && report.w >= 640 && h == report.h.clamp(abito_island::geometry::COMPACT_DOT.1, window.1.max(0)) {
        (26.0, 26.0, 0)
    } else { return vec![(x, y, w, h)] };
    let box_h = if top < 0 { abito_island::geometry::COMPACT_DOT.1 } else { h };
    let mut rects: Vec<(i32, i32, i32, i32)> = Vec::new();
    for row in y.max(0)..(y + h) {
        let centre = f64::from(row - y - top) + 0.5;                // the row's centre, in the box (the box starts at y + top)
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

/// The height of the box the page DRAWS when it is an open card, from the last SETTLED report: island_move_end feeds it to
/// geometry::visible_card_height so a dropped card keeps the height that is laid out (a 240 chat, a taller take-over) instead of a
/// guess. A report that is not a card (the seeded 288x32 bar, the folded 40x32 disc, a transition) answers None.
fn report_height(state: &((i32, i32), Report)) -> Option<i32> {
    let (_, report) = state;
    (report.settled && report.h > abito_island::geometry::COMPACT_DOT.1).then_some(report.h)
}

/// The page's last settled report of the island it draws, as the open card's visible height (see `report_height`).
pub(crate) fn last_visible_height() -> Option<i32> {
    #[cfg(target_os = "linux")] { report_height(&*SHAPE.lock().expect("island shape lock")) }
    #[cfg(not(target_os = "linux"))] { report_height(&*LAST.lock().expect("island shape lock")) }
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
pub(crate) fn current_rects(window: (i32, i32), protected: bool, bottom: bool) -> Vec<(i32, i32, i32, i32)> {
    let mut state = LAST.lock().expect("island shape lock");
    shape_rects_anchored(&mut state, None, window, protected, bottom)
}

/// The island's input rects for the current report, shared by every platform. `state` = (the last SETTLED destination, the last report):
/// a settled report is remembered; while moving the rects are the union of the previous and the next shape (plus spring air).
#[cfg(test)]
pub(crate) fn shape_rects(state: &mut ((i32, i32), Report), report: Option<Report>, window: (i32, i32), protected: bool) -> Vec<(i32, i32, i32, i32)> {
    shape_rects_anchored(state, report, window, protected, false)
}
/// `shape_rects` with the card's anchor (see `anchor_bottom`).
pub(crate) fn shape_rects_anchored(state: &mut ((i32, i32), Report), report: Option<Report>, window: (i32, i32), protected: bool, bottom: bool) -> Vec<(i32, i32, i32, i32)> {
    use abito_island::geometry;
    if let Some(report) = report { state.1 = report; }
    let report = state.1;
    let destination = geometry::clamp_island_shape(report.w, report.h, window);
    let shape = if report.settled {
        state.0 = destination;
        destination
    } else { geometry::transition_shape(state.0, destination, window) };
    input_rects_anchored(if report.settled { report } else { Report { w: shape.0, h: shape.1, settled: false } }, window, protected, bottom)
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
            let bottom = anchor_bottom(&app_state);
            let rects: Vec<_> = shape_rects_anchored(&mut state, report, window, protected, bottom)
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
    // island-free-drag S3: the compact strip is the DISC's width (40), centred in the fixed 752 window
    let w = abito_island::geometry::COMPACT_DOT.0;
    let x = (752 - w) / 2;
    let strip = Report { w, h:4, settled:true };
    assert_eq!(input_rect(strip, (752,340), false), (x,0,w,4));
    assert_eq!(input_rect(strip, (752,340), true), (x,0,w,32));
    assert_eq!(input_rect(Report {h:-1,..strip}, (752,340), false), (x,0,w,32));
}

#[cfg(test)]
#[test]
fn the_hidden_strip_input_zone_is_the_drawn_8px_of_the_disc_and_never_wider_than_it() {
    // S1 + island-free-drag S3: the compact island is the DISC (40x32 in every compact state); the hidden strip is 24 px up, leaving
    // an 8 px activation zone exactly as wide as the disc.
    let w = abito_island::geometry::COMPACT_DOT.0;
    let strip = Report { w, h: 8, settled: true };
    let (x, y, rw, rh) = input_rect(strip, (752, 340), false);
    assert_eq!((rw, rh), (w, 8), "zone {w} wide, 8 px tall");
    assert_eq!((x, y), ((752 - w) / 2, 0), "centred, at the very top");
    assert_eq!(input_rect(strip, (752, 340), true), (x, 0, w, 32), "a protected ask refuses the thin strip too");
    assert_eq!(input_rect(Report { settled: false, ..strip }, (752, 340), false).3, 32, "moving: never the thin zone");
    // a box that is NOT the disc keeps the ordinary rule; the retired bar widths are NOT strips any more
    assert_eq!(input_rect(Report { w: 40, h: 32, settled: true }, (752, 340), false), (356, 0, 40, 32));
    assert_eq!(input_rect(Report { w: 720, h: 8, settled: true }, (752, 340), false).3, 32, "only the disc's width can be a strip");
    assert_eq!(input_rect(Report { w: 288, h: 8, settled: true }, (752, 340), false).3, 32, "the old 288 bar is gone: not a strip");
    assert_eq!(input_rect(Report { w: 440, h: 8, settled: true }, (752, 340), false).3, 32, "the old 440 bar is gone: not a strip");
    assert_eq!(input_rect(Report { w: 560, h: 8, settled: true }, (752, 340), false).3, 32, "the old 560 «Responder» pill is gone: not a strip");
}

#[cfg(test)]
#[test]
fn the_input_region_covers_exactly_what_is_drawn_for_every_native_size_of_the_island() {
    // The island's full size list (logical px, inside the fixed 752x340 window): the compact disc 40x32 (S3: in every compact
    // state); hidden strip: 40x8; expanded 720x184, 720x220 with the «terminó»/problem band; question 224; chat 720 x 240..300.
    let window = (752, 340);
    let centred = |w: i32| (window.0 - w) / 2;
    let (w, h) = abito_island::geometry::COMPACT_DOT;
    assert_eq!(input_rect(Report { w, h, settled: true }, window, false), (centred(w), 0, w, h), "compact disc {w}x{h}");
    assert_eq!(input_rect(Report { w, h: 8, settled: true }, window, false), (centred(w), 0, w, 8), "hidden strip {w}x8");
    // a click just BELOW the drawn strip (y = 8) is outside the region, so it passes through to the app underneath
    let (_, y, _, hh) = input_rect(Report { w, h: 8, settled: true }, window, false);
    assert!(8 >= y + hh, "y=8 is below the {w} strip's zone");
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
        let (dw, dh) = abito_island::geometry::COMPACT_DOT;
        out.push((Report { w: dw, h: dh, settled: true }, (centred(dw), 0, dw, dh), (16.0, 16.0))); // the disc: r16 on all four corners
        // isla-cualquier-lado S1: the floating card is r26 on ALL four corners (was the notch: square on top, r26 at the bottom)
        for (w, h) in [(720, 150), (720, 220), (720, 208), (720, 224), (720, 240), (720, 300)] { out.push((Report { w, h, settled: true }, (centred(w), 0, w, h), (26.0, 26.0))); }
        // hidden: the disc (32 tall) sits 24 px up, so only its bottom 8 px (with its rounded bottom corners) show
        out.push((Report { w: dw, h: 8, settled: true }, (centred(dw), -24, dw, dh), (16.0, 16.0)));
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

    #[test]
    fn the_four_corners_of_every_size_pass_clicks_and_the_middle_does_not() {
        for (report, (bx, by, bw, bh), _) in sizes() {
            let rects = input_rects(report, W, false);
            let (top, bottom) = (by.max(0), by + bh - 1);
            // every drawn box is round on all four corners (the disc r16, the card r26); the hidden strip's top is off the window
            if by >= 0 { for (x, y) in [(bx, top), (bx + bw - 1, top)] { assert!(!covers(&rects, x, y), "{report:?}: top corner ({x},{y}) must pass clicks"); } }
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

    /// isla-cualquier-lado S1: a card in the lower half of its screen stands on the window's BOTTOM edge and grows up, so its click
    /// region is the same rounded r26 box, mirrored to the bottom of the window; nothing above it takes a click.
    #[test]
    fn a_bottom_anchored_card_takes_clicks_at_the_bottom_of_the_window_and_nowhere_else() {
        for (w, h) in [(720, 150), (720, 186), (720, 240), (720, 300)] {
            let report = Report { w, h, settled: true };
            let rects = input_rects_anchored(report, W, false, true);
            let box_ = ((W.0 - w) / 2, W.1 - h, w, h);
            for y in 0..W.1 { for x in 0..W.0 {
                if covers(&rects, x, y) { assert!(inside(x, y, box_, (26.0, 26.0)), "{w}x{h}: ({x},{y}) takes clicks outside the card at the window bottom"); }
            } }
            let (bx, by) = (box_.0, box_.1);
            assert!(covers(&rects, bx + w / 2, by + h / 2), "{w}x{h}: the card's middle takes clicks");
            assert!(covers(&rects, bx + w / 2, W.1 - 1), "{w}x{h}: the middle of the window's bottom row takes clicks");
            assert!(!covers(&rects, bx + w / 2, by - 1), "{w}x{h}: the row above the card passes clicks");
            for (x, y) in [(bx, by), (bx + w - 1, by), (bx, W.1 - 1), (bx + w - 1, W.1 - 1)] { assert!(!covers(&rects, x, y), "{w}x{h}: corner ({x},{y}) passes clicks"); }
        }
        // the top anchor is the ordinary region; a transition stays one plain rectangle, also at the bottom
        let card = Report { w: 720, h: 150, settled: true };
        assert_eq!(input_rects_anchored(card, W, false, false), input_rects(card, W, false));
        assert_eq!(input_rects_anchored(Report { w: 752, h: 166, settled: false }, W, false, true), vec![(0, W.1 - 166, 752, 166)]);
        // a window grown for a long question keeps the card on its bottom edge
        let tall = input_rects_anchored(Report { w: 720, h: 255, settled: true }, (752, 500), false, true);
        assert!(tall.iter().all(|r| r.1 >= 500 - 255 && r.1 + r.3 <= 500), "{tall:?}");
    }
    /// isla-cualquier-lado T6b: the folded island follows the SAME edge rule as the open card, so in the lower half its disc sits
    /// on the window's bottom edge and the toast hangs above it. The input region must follow, or the disc and the toast would be
    /// painted where nothing takes a click.
    #[test]
    fn a_folded_disc_on_its_bottom_edge_takes_clicks_at_the_window_bottom_and_nowhere_else() {
        let report = Report { w: abito_island::geometry::COMPACT_DOT.0, h: abito_island::geometry::COMPACT_DOT.1, settled: true };
        let top = input_rects_anchored(report, W, false, false);
        assert!(covers(&top, W.0 / 2, 0), "upper half: the disc hangs from the window's top");
        assert!(!covers(&top, W.0 / 2, W.1 - 1), "and nothing at the bottom takes a click");
        let bottom = input_rects_anchored(report, W, false, true);
        assert!(covers(&bottom, W.0 / 2, W.1 - 1), "lower half: the disc stands on the window's bottom");
        assert!(covers(&bottom, W.0 / 2, W.1 - 16), "its whole r16 box is clickable");
        assert!(!covers(&bottom, W.0 / 2, 0), "the window's top row passes clicks");
        let x = (W.0 - abito_island::geometry::COMPACT_DOT.0) / 2;
        for (cx, cy) in [(x, W.1 - 1), (x + 39, W.1 - 1)] { assert!(!covers(&bottom, cx, cy), "the disc's rounded corner ({cx},{cy}) passes clicks"); }
        assert!(!covers(&bottom, x - 1, W.1 - 16) && !covers(&bottom, x + 40, W.1 - 16), "nothing outside the disc");
    }

    /// R3-hidden-strip-bottom-untested (T7): the hidden strip is a 40 x 4..32 report that shows only the bottom of the disc's own
    /// 32 px box, and since T6b the folded island follows the edge rule, so in the lower half that strip has to land on the WINDOW's
    /// bottom edge with the disc's rounded corners, exactly as the top-anchored one does at the top. Untested before.
    #[test]
    fn the_hidden_strip_on_its_bottom_edge_takes_clicks_in_the_discs_bottom_rows_and_nowhere_else() {
        let (dw, dh) = abito_island::geometry::COMPACT_DOT;
        let x = (W.0 - dw) / 2;
        let strip = Report { w: dw, h: 8, settled: true };
        let top = input_rects_anchored(strip, W, false, false);
        let bottom = input_rects_anchored(strip, W, false, true);
        assert!(!bottom.is_empty(), "the strip on its bottom edge has a region");
        // it occupies only the 8 rows it draws, at the window's bottom, and nothing above them
        for (rx, ry, _rw, rh) in &bottom {
            assert!(*ry >= W.1 - 8, "({rx},{ry},{rh}) starts above the 8 px it draws");
            assert!(ry + rh <= W.1, "({rx},{ry},{rh}) reaches past the window bottom");
        }
        for px in (x - 4)..(x + dw + 4) { assert!(!covers(&bottom, px, W.1 - 9), "the row above the strip passes clicks at {px}"); }
        assert!(covers(&bottom, W.0 / 2, W.1 - 1), "the middle of the bottom row takes clicks");
        // the disc's rounded bottom corners pass clicks, like the whole disc on its bottom edge
        for (cx, cy) in [(x, W.1 - 1), (x + dw - 1, W.1 - 1)] { assert!(!covers(&bottom, cx, cy), "the disc's rounded corner ({cx},{cy}) passes clicks"); }
        assert!(!covers(&bottom, x - 1, W.1 - 4) && !covers(&bottom, x + dw, W.1 - 4), "nothing outside the disc's width takes a click");
        // the SAME rows as the top-anchored strip mirrored to the bottom: one rule, two edges
        for row in 0..8 {
            for px in 0..W.0 {
                assert_eq!(covers(&bottom, px, W.1 - 8 + row), covers(&top, px, row), "row {row} of the strip differs between the two edges at x={px}");
            }
        }
        // a protected ask still refuses the thin strip: the WHOLE disc box takes clicks, rounded r16 (never the 8 px zone)
        let protected_bottom = input_rects_anchored(strip, W, true, true);
        for (rx, ry, _rw, rh) in &protected_bottom { assert!(*ry >= W.1 - dh && ry + rh <= W.1, "({rx},{ry},{rh}) leaves the disc's box at the window bottom"); }
        assert!(covers(&protected_bottom, W.0 / 2, W.1 - dh), "with an ask pending the disc's top row takes clicks, not just the 8 px");
        assert!(!covers(&protected_bottom, x, W.1 - dh), "its corner still passes clicks");
        // and a moving (unsettled) report is never the thin zone at the bottom either
        assert_eq!(input_rects_anchored(Report { settled: false, ..strip }, W, false, true), vec![(x, W.1 - dh, dw, dh)]);
    }

    #[test]
    fn a_folded_disc_with_its_toast_above_covers_the_toast_and_the_disc_and_nothing_else() {
        // what the page reports while the toast shows above the folded disc (question-toast.js shapeWithToast): 350 wide, 96 tall
        // toast + the 32 px disc, flush (gap 0)
        let report = Report { w: 350, h: 96 + abito_island::geometry::COMPACT_DOT.1, settled: true };
        let rects = input_rects_anchored(report, W, false, true);
        assert_eq!(rects, vec![((W.0 - 350) / 2, W.1 - 128, 350, 128)], "one rectangle from the toast's top to the disc's bottom");
        assert!(covers(&rects, W.0 / 2, W.1 - 128), "the toast's top row takes clicks");
        assert!(!covers(&rects, W.0 / 2, W.1 - 129), "nothing above the toast");
        assert!(covers(&rects, W.0 / 2, W.1 - 1), "the disc's bottom row takes clicks");
        assert!(!covers(&rects, (W.0 - 350) / 2 - 1, W.1 - 100), "nothing left of the toast");
        // and with the disc in the upper half the same region is anchored at the window top: one rule, two edges
        assert_eq!(input_rects_anchored(report, W, false, false), vec![((W.0 - 350) / 2, 0, 350, 128)]);
        // a window grown for a long question keeps the whole region on its bottom edge
        let tall = input_rects_anchored(report, (752, 500), false, true);
        assert_eq!(tall, vec![((W.0 - 350) / 2, 500 - 128, 350, 128)]);
    }

    #[test]
    fn only_a_settled_report_that_is_a_card_tells_the_drop_spot_its_height() {
        // island_move_end asks for the height the page DRAWS; the shipped default report (288x32, the retired bar) is not a card
        let bar = ((288, 32), Report { w: 288, h: 32, settled: true });
        assert_eq!(report_height(&bar), None, "the seeded bar height is not a card");
        let card = ((720, 150), Report { w: 720, h: 240, settled: true });
        assert_eq!(report_height(&card), Some(240), "a 240 chat card");
        let moving = ((720, 150), Report { w: 640, h: 300, settled: false });
        assert_eq!(report_height(&moving), None, "a transition is not a laid-out card");
    }

    #[test]
    fn the_anchor_is_read_from_the_shared_state_so_every_platform_follows_the_edge() {
        let mut state = ((40, 32), Report { w: 40, h: 32, settled: true });
        let at_bottom = shape_rects_anchored(&mut state, Some(Report { w: 720, h: 150, settled: true }), W, false, true);
        assert!(at_bottom.iter().all(|r| r.1 >= W.1 - 150), "bottom-anchored card: {at_bottom:?}");
        assert!(shape_rects_anchored(&mut state, None, W, false, false).iter().all(|r| r.1 + r.3 <= 150), "the same report, top anchor");
    }

    #[test]
    fn a_protected_ask_keeps_the_round_disc_and_never_the_thin_strip() {
        let x = (W.0 - 40) / 2;
        let rects = input_rects(Report { w: 40, h: 8, settled: true }, W, true);
        assert!(covers(&rects, x + 20, 31), "the whole 32 px disc takes clicks when an ask is pending");
        assert!(!covers(&rects, x, 0), "its corner still passes clicks");
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

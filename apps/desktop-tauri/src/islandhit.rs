//! HU-043 (human, verbatim: «la hitbox de cuando abito esta compactado es muy grande en windows» and «¿las correcciones de windows
//! están implementadas para mac también?»). On Windows and macOS the island window is a fixed 752x340 transparent rectangle that took
//! EVERY click while the compact pill is 288x32. Linux already limits input to the drawn shape (a GDK input region built from
//! `islandshape::input_rects`). Elsewhere the window is made click-through (`set_ignore_cursor_events`) whenever the cursor is NOT over
//! that same shape. This module is the pure decision: no window, no thread, no OS call, so it is tested on every platform.
// On Linux the click-through poller (islandclick) is not started (Linux uses the GDK input region), so these items are only exercised by tests there.
#![cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
use std::time::Duration;

pub(crate) type Rect = (i32, i32, i32, i32);

/// The cursor is within this many PHYSICAL pixels of the window: poll fast so a click on the pill is never delayed.
pub(crate) const NEAR_MARGIN_PX: f64 = 160.0;
pub(crate) const NEAR_POLL: Duration = Duration::from_millis(25);
/// Cursor far from the window: a slower poll saves energy. The cost is up to this much latency when the cursor arrives from far away.
pub(crate) const FAR_POLL: Duration = Duration::from_millis(100);
/// While the island window is hidden nothing is read or set; the poller only re-checks the cached visibility this often.
pub(crate) const HIDDEN_RECHECK: Duration = Duration::from_millis(500);

/// The cursor (desktop physical px) in the window's LOGICAL pixels, the unit of `input_rects`. A scale that is not a positive finite
/// number, or a cursor that is not finite, is "unknown" (`None`), never a guess.
pub(crate) fn cursor_in_window(cursor: (f64, f64), origin: (i32, i32), scale: f64) -> Option<(f64, f64)> {
    if !scale.is_finite() || scale <= 0.0 || !cursor.0.is_finite() || !cursor.1.is_finite() { return None; }
    Some(((cursor.0 - f64::from(origin.0)) / scale, (cursor.1 - f64::from(origin.1)) / scale))
}

/// Half-open: a rect covers `x..x+w` and `y..y+h`, like the pixels it describes.
pub(crate) fn covers(rects: &[Rect], point: (f64, f64)) -> bool {
    rects.iter().any(|&(x, y, w, h)| point.0 >= f64::from(x) && point.0 < f64::from(x) + f64::from(w) && point.1 >= f64::from(y) && point.1 < f64::from(y) + f64::from(h))
}

/// Should the window ignore the mouse right now? `true` ONLY when it is certain that the cursor is over transparent window area. Everything
/// uncertain is `false` (the window stays clickable): an unknown cursor, no rects, a hidden window, a drag in progress, and — explicitly —
/// while a question or approval card is on screen (`protected`): those never become click-through, wherever the cursor is.
pub(crate) fn click_through(cursor: Option<(f64, f64)>, rects: &[Rect], protected: bool, dragging: bool, visible: bool) -> bool {
    if !visible || protected || dragging || rects.is_empty() { return false; }
    match cursor { Some(point) => !covers(rects, point), None => false }
}

/// How long to wait before the next look. `None` = do not poll at all (the island is hidden). Near or over the window: fast; far: slow.
/// `outer` is the window's outer rect in physical px (x, y, w, h).
pub(crate) fn next_poll(visible: bool, cursor: Option<(f64, f64)>, outer: Rect) -> Option<Duration> {
    if !visible { return None; }
    let Some((cx, cy)) = cursor.filter(|c| c.0.is_finite() && c.1.is_finite()) else { return Some(FAR_POLL) };
    let (x, y, w, h) = (f64::from(outer.0), f64::from(outer.1), f64::from(outer.2), f64::from(outer.3));
    let near = cx >= x - NEAR_MARGIN_PX && cx < x + w + NEAR_MARGIN_PX && cy >= y - NEAR_MARGIN_PX && cy < y + h + NEAR_MARGIN_PX;
    Some(if near { NEAR_POLL } else { FAR_POLL })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::islandshape::{input_rects, Report};
    const WINDOW: (i32, i32) = (752, 340);
    fn pill() -> Vec<Rect> { input_rects(Report { w: 288, h: 32, settled: true }, WINDOW, false) }

    #[test]
    fn the_cursor_is_converted_to_the_windows_logical_pixels_and_an_unusable_scale_is_unknown() {
        assert_eq!(cursor_in_window((300.0, 150.0), (100, 50), 2.0), Some((100.0, 50.0)));
        assert_eq!(cursor_in_window((10.0, 10.0), (20, 20), 1.0), Some((-10.0, -10.0)), "left of the window is negative, not clamped");
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] { assert_eq!(cursor_in_window((1.0, 1.0), (0, 0), scale), None, "{scale}"); }
        assert_eq!(cursor_in_window((f64::NAN, 1.0), (0, 0), 1.0), None);
        assert_eq!(cursor_in_window((1.0, f64::INFINITY), (0, 0), 1.0), None);
    }

    #[test]
    fn rects_are_half_open_like_the_pixels_they_describe() {
        let r = [(10, 20, 5, 4)];
        assert!(covers(&r, (10.0, 20.0)) && covers(&r, (14.9, 23.9)));
        assert!(!covers(&r, (15.0, 20.0)) && !covers(&r, (10.0, 24.0)) && !covers(&r, (9.9, 20.0)) && !covers(&r, (10.0, 19.9)));
        assert!(!covers(&[], (0.0, 0.0)));
    }

    /// The bug itself. The compact pill is a small box at the top centre of a 752x340 window: a click anywhere else in that window must
    /// reach whatever is below, and a click on the pill must stay with Abito.
    #[test]
    fn a_click_on_the_compact_pill_stays_and_a_click_anywhere_else_in_the_window_passes_through() {
        let rects = pill();
        let centre = (376.0, 16.0);
        assert!(!click_through(Some(centre), &rects, false, false, true), "the pill takes the click");
        for point in [(5.0, 5.0), (376.0, 100.0), (376.0, 339.0), (700.0, 16.0), (10.0, 330.0), (231.0, 16.0), (520.0, 16.0)] {
            assert!(click_through(Some(point), &rects, false, false, true), "{point:?} is transparent window area: the click goes to the app below");
        }
        // the rounded corners of the pill (r16) are transparent too, exactly like the Linux input region (#503 S29)
        assert!(click_through(Some((232.5, 0.5)), &rects, false, false, true), "top-left corner pixel of the pill passes clicks");
        // the rounded edge gives up at most one drawn pixel per row (inset rounded UP, islandshape S29), so probe one pixel inside it
        assert!(!click_through(Some((234.5, 16.5)), &rects, false, false, true), "the middle of its left edge takes them");
    }

    #[test]
    fn the_wider_compact_pills_and_the_expanded_island_are_covered_exactly() {
        for w in [440, 560] {
            let rects = input_rects(Report { w, h: 32, settled: true }, WINDOW, false);
            assert!(!click_through(Some((376.0, 16.0)), &rects, false, false, true), "{w}");
            assert!(click_through(Some((376.0, 40.0)), &rects, false, false, true), "{w}: below the pill is transparent");
        }
        let expanded = input_rects(Report { w: 720, h: 150, settled: true }, WINDOW, false);
        assert!(!click_through(Some((376.0, 100.0)), &expanded, false, false, true), "an open island takes clicks on its body");
        assert!(click_through(Some((376.0, 250.0)), &expanded, false, false, true), "below an open island is transparent");
    }

    /// Condition 2 of the approval: questions and approval cards must never become click-through while shown.
    #[test]
    fn a_protected_question_or_approval_card_is_never_click_through_wherever_the_cursor_is() {
        let rects = pill();
        for y in (0..=WINDOW.1).step_by(10) { for x in (-40..=WINDOW.0 + 40).step_by(10) {
            assert!(!click_through(Some((f64::from(x), f64::from(y))), &rects, true, false, true), "protected: ({x},{y}) must stay clickable");
        } }
        assert!(!click_through(None, &rects, true, false, true));
        // and the same position IS click-through once the card is gone, so the test above proves the protection, not an always-false verdict
        assert!(click_through(Some((5.0, 300.0)), &rects, false, false, true));
    }

    #[test]
    fn everything_uncertain_keeps_the_window_clickable() {
        let rects = pill();
        let outside = Some((5.0, 300.0));
        assert!(click_through(outside, &rects, false, false, true), "control: this position passes clicks");
        assert!(!click_through(None, &rects, false, false, true), "unknown cursor");
        assert!(!click_through(outside, &[], false, false, true), "no rects reported yet");
        assert!(!click_through(outside, &rects, false, true, true), "a drag is in progress");
        assert!(!click_through(outside, &rects, false, false, false), "a hidden window is left clickable for when it comes back");
    }

    #[test]
    fn polling_stops_when_hidden_is_slow_when_far_and_fast_only_near_or_over_the_window() {
        let outer = (1000, 0, 1880, 850); // 752x340 at 2.5x, top of a big screen
        assert_eq!(next_poll(false, Some((1500.0, 100.0)), outer), None, "hidden: no polling at all");
        assert_eq!(next_poll(true, Some((1500.0, 100.0)), outer), Some(NEAR_POLL), "over the window");
        assert_eq!(next_poll(true, Some((1000.0 - NEAR_MARGIN_PX + 1.0, 100.0)), outer), Some(NEAR_POLL), "just inside the margin");
        assert_eq!(next_poll(true, Some((1000.0 - NEAR_MARGIN_PX - 1.0, 100.0)), outer), Some(FAR_POLL), "just outside the margin");
        assert_eq!(next_poll(true, Some((100.0, 2000.0)), outer), Some(FAR_POLL), "far away");
        assert_eq!(next_poll(true, None, outer), Some(FAR_POLL), "unreadable cursor: slow but alive");
        assert_eq!(next_poll(true, Some((f64::NAN, 0.0)), outer), Some(FAR_POLL));
        assert!(FAR_POLL >= NEAR_POLL * 4 && HIDDEN_RECHECK >= FAR_POLL, "the cadences are ordered: near < far < hidden re-check");
    }
}

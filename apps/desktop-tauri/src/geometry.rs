//! Pure island geometry. Native rectangles are physical pixels; page/input-shape
//! dimensions are logical pixels. Every view shares one top-centred native window.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect { pub x: i32, pub y: i32, pub w: i32, pub h: i32 }
impl Rect {
    pub fn right(&self) -> i32 { self.x + self.w }
    pub fn bottom(&self) -> i32 { self.y + self.h }
}

/// The page always hangs from Top. Bottom remains part of the read-back vocabulary.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Edge { #[default] Top, Bottom }

pub const COMPACT_BAR: (i32, i32) = (288, 32);
/// The compact pill's widths in logical px: at rest, and widened for session rows, or 560 for a pending question/permission (island-layout.js COMPACT_W / COMPACT_WIDE / COMPACT_ASK; a test keeps the two in step).
pub const COMPACT_WIDTHS: [i32; 3] = [288, 440, 560];
pub const OVERVIEW_VISIBLE: (i32, i32) = (720, 150);
/// One logical native window for compact, overview, question/recap and chat.
pub const ISLAND_WINDOW: (i32, i32) = (752, 340);
pub const CHAT_COLUMN_W: i32 = 720;
pub const CHAT_MIN_H: i32 = 240;
pub const CHAT_MAX_H: i32 = 300;
pub const CHAT_GROWTH_PER_MESSAGE: i32 = 40;
pub const CHAT_FAR_GAP: i32 = 40;
const CHAT_BOTTOM_AIR: i32 = 16;
pub const CLICK_THRESHOLD_PX: f64 = 6.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View { Compact, Overview, Chat }

/// `(native window, visible island)` in logical pixels. Settings has its own window.
pub fn view_sizes(view: View, _area_w_phys: i32, area_h_phys: i32, scale: f64) -> ((i32, i32), (i32, i32)) {
    let visible = match view {
        View::Compact => COMPACT_BAR,
        View::Overview => OVERVIEW_VISIBLE,
        View::Chat => chat_visible(area_h_phys, scale),
    };
    (ISLAND_WINDOW, visible)
}

pub fn chat_prompt_height(messages: u32) -> i32 {
    let grown = i64::from(CHAT_MIN_H) + i64::from(messages) * i64::from(CHAT_GROWTH_PER_MESSAGE);
    grown.min(i64::from(CHAT_MAX_H)) as i32
}
fn valid_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 { scale } else { 1.0 }
}
pub fn clamp_chat_height(desired: i32, area_h_phys: i32, scale: f64) -> i32 {
    let room = (area_h_phys as f64 / valid_scale(scale)).floor() as i32 - CHAT_FAR_GAP - CHAT_BOTTOM_AIR;
    desired.clamp(CHAT_MIN_H, CHAT_MAX_H).min(room).max(CHAT_MIN_H)
}
pub fn chat_visible(area_h_phys: i32, scale: f64) -> (i32, i32) {
    chat_visible_for(area_h_phys, scale, CHAT_MIN_H)
}
pub fn chat_visible_for(area_h_phys: i32, scale: f64, desired: i32) -> (i32, i32) {
    (CHAT_COLUMN_W, clamp_chat_height(desired, area_h_phys, scale))
}
pub fn scaled_size(size: (i32, i32), scale: f64) -> (i32, i32) {
    let scale = valid_scale(scale);
    ((size.0 as f64 * scale).round() as i32, (size.1 as f64 * scale).round() as i32)
}
pub fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let right = a.right().min(b.right());
    let bottom = a.bottom().min(b.bottom());
    (right > x && bottom > y).then_some(Rect { x, y, w: right - x, h: bottom - y })
}
pub fn clamp_x(x: i32, w: i32, area: Rect) -> i32 {
    x.max(area.x).min((area.right() - w).max(area.x))
}
/// Being on screen wins over the preferred size on a smaller work area.
pub fn clamp_rect(rect: Rect, area: Rect) -> Rect {
    let w = rect.w.max(1).min(area.w);
    let h = rect.h.max(1).min(area.h);
    Rect { x: clamp_x(rect.x, w, area), y: rect.y.max(area.y).min((area.y + area.h - h).max(area.y)), w, h }
}
pub fn initial_position(area: Rect, w: i32, h: i32) -> Rect {
    Rect { x: clamp_x(area.x + (area.w - w) / 2, w, area), y: area.y, w, h }
}
pub fn island_window_rect(area: Rect, scale: f64) -> Rect {
    island_window_rect_h(area, scale, ISLAND_WINDOW.1)
}
/// The same top-centred window, `height` logical pixels tall (grown on demand for a long question). Width and the top anchor
/// never change; a work area shorter than the request wins (clamp_rect keeps the window on screen).
pub fn island_window_rect_h(area: Rect, scale: f64, height: i32) -> Rect {
    island_window_rect_on(area, area, scale, height)
}
/// Horizontally centred on `monitor` (the island hangs from the top centre of the SCREEN, like a notch), vertically from `area`
/// (a top panel pushes it down) and kept inside `area`. A side dock shrinks the work area asymmetrically, so centring on the work
/// area put the island 23 px off to one side on a 46 px dock.
pub fn island_window_rect_on(monitor: Rect, area: Rect, scale: f64, height: i32) -> Rect {
    let (w, h) = scaled_size((ISLAND_WINDOW.0, height), scale);
    let centred = Rect { x: monitor.x + (monitor.w - w) / 2, y: area.y, w, h };
    clamp_rect(centred, area)
}
/// The scale to lay the island out with, or None while no monitor backs it. Under XWayland native scaling the X screen is drawn
/// at an integer multiple of the logical one (GNOME 125 %: root 3072x1728 for a 1920x1080 monitor, GDK scale 2) and GDK reports it
/// only through a monitor; with no RandR output at all (the virtual screen-share monitor removed) GDK answers 1 while the root keeps
/// its native geometry, and that 1 is a fallback, not a reading: placing from it made the island half size and off-centre.
pub fn effective_scale(reported: f64, monitor: Option<Rect>) -> Option<f64> {
    monitor.filter(|m| m.w > 0 && m.h > 0)?;
    Some(valid_scale(reported))
}
/// `island_window_rect_on` for a monitor that may not exist: None means «keep the last placement and wait» (the caller places again
/// when the monitor appears or the scale changes). The size, the centre and the input region all use the one `effective_scale`.
pub fn island_window_rect_for(monitor: Option<Rect>, area: Rect, reported_scale: f64, height: i32) -> Option<Rect> {
    let scale = effective_scale(reported_scale, monitor)?;
    Some(island_window_rect_on(monitor?, area, scale, height))
}
/// A long question may grow the native window up to this share of the work-area height (human: «abito se ajusta al tamaño»).
pub const WINDOW_GROWTH_PERCENT: i32 = 70;
/// The page asks for a logical height; Rust decides: never below the fixed window, never above 70% of the work area.
pub fn clamp_window_height(desired: i32, area_h_phys: i32, scale: f64) -> i32 {
    let area_h = (f64::from(area_h_phys.max(0)) / valid_scale(scale)).floor() as i32;
    let cap = (i64::from(area_h) * i64::from(WINDOW_GROWTH_PERCENT) / 100) as i32;
    desired.max(ISLAND_WINDOW.1).min(cap.max(ISLAND_WINDOW.1))
}
/// Page-reported logical dimensions are bounded by the bar and the actual window.
pub fn clamp_island_shape(w: i32, h: i32, window: (i32, i32)) -> (i32, i32) {
    (w.max(COMPACT_BAR.0).min(window.0.max(0)), h.max(COMPACT_BAR.1).min(window.1.max(0)))
}
/// GDK input rectangle in window-local logical pixels.
pub fn island_shape_rect(shape: (i32, i32), window: (i32, i32)) -> (i32, i32, i32, i32) {
    let (w, h) = clamp_island_shape(shape.0, shape.1, window);
    ((window.0 - w) / 2, 0, w, h)
}
/// Union of the centred endpoints plus 16 pixels of spring air on every exposed
/// edge. Top stays at zero; all air is clipped to the fixed window.
pub fn transition_shape(previous: (i32, i32), destination: (i32, i32), window: (i32, i32)) -> (i32, i32) {
    let previous = clamp_island_shape(previous.0, previous.1, window);
    let destination = clamp_island_shape(destination.0, destination.1, window);
    clamp_island_shape(previous.0.max(destination.0).saturating_add(32), previous.1.max(destination.1).saturating_add(16), window)
}
/// NaN fails closed to cancellation, never an accidental toggle.
pub fn is_click(movement: f64, threshold: f64) -> bool { movement < threshold }

#[cfg(test)]
mod tests {
    use super::*;
    fn area() -> Rect { Rect { x: 0, y: 32, w: 1920, h: 1048 } }

    #[test]
    fn scaled_size_applies_scale_factor() {
        assert_eq!(scaled_size(COMPACT_BAR, 1.0), (288, 32));
        assert_eq!(scaled_size(ISLAND_WINDOW, 1.0), (752, 340));
        assert_eq!(scaled_size(COMPACT_BAR, 2.0), (576, 64));
        assert_eq!(scaled_size(COMPACT_BAR, 1.25), (360, 40));
        assert_eq!(scaled_size((304, 44), 1.25), (380, 55));
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(scaled_size(COMPACT_BAR, bad), COMPACT_BAR);
        }
    }
    #[test]
    fn intersect_overlaps_and_rejects() {
        let a = Rect { x:0, y:0, w:100, h:100 };
        assert_eq!(intersect(a, Rect { x:50,y:50,w:100,h:100 }), Some(Rect { x:50,y:50,w:50,h:50 }));
        assert_eq!(intersect(a, Rect { x:200,y:0,w:10,h:10 }), None);
        let inner = Rect { x:10,y:10,w:50,h:50 };
        assert_eq!(intersect(a, inner), Some(inner));
    }
    #[test]
    fn clamp_x_keeps_window_inside_work_area() {
        assert_eq!(clamp_x(500,304,area()),500);
        assert_eq!(clamp_x(1900,304,area()),1920-304);
        assert_eq!(clamp_x(-20,304,area()),0);
        assert_eq!(clamp_x(9999,4000,area()),0);
    }
    #[test]
    fn clamp_rect_ports_electron_clamp_bounds() {
        let negative = Rect { x:-1920,y:-200,w:1920,h:1080 };
        assert_eq!(clamp_rect(Rect { x:-4000,y:-600,w:520,h:720 },negative), Rect { x:-1920,y:-200,w:520,h:720 });
        let tiny = Rect { x:-20,y:-30,w:80,h:60 };
        assert_eq!(clamp_rect(Rect { x:1000,y:1000,w:520,h:720 },tiny),tiny);
        for width in (1..700).step_by(19) {
            let work = Rect { x:-1700,y:-100,w:width,h:width+10 };
            let r = clamp_rect(Rect { x:500,y:900,w:520,h:720 },work);
            assert!(r.x >= work.x && r.y >= work.y && r.right() <= work.right() && r.bottom() <= work.bottom());
        }
        let inside = Rect { x:100,y:100,w:304,h:44 };
        assert_eq!(clamp_rect(inside,area()),inside);
    }
    #[test]
    fn initial_position_is_top_center() {
        assert_eq!(initial_position(area(),304,44),Rect { x:808,y:32,w:304,h:44 });
    }
    #[test]
    fn is_click_threshold_boundary() {
        assert!(is_click(0.0,CLICK_THRESHOLD_PX)); assert!(is_click(5.99,CLICK_THRESHOLD_PX));
        assert!(!is_click(6.0,CLICK_THRESHOLD_PX)); assert!(!is_click(42.0,CLICK_THRESHOLD_PX));
        assert!(!is_click(f64::NAN,CLICK_THRESHOLD_PX));
    }
    #[test]
    fn chat_column_width_is_fixed_and_every_view_uses_the_same_native_window() {
        assert_eq!(CHAT_COLUMN_W,720); assert_eq!(CHAT_COLUMN_W,OVERVIEW_VISIBLE.0);
        assert_eq!(view_sizes(View::Chat,1920,1048,1.0),(ISLAND_WINDOW,(720,240)));
    }
    #[test]
    fn chat_height_follows_coucous_prompt_rule() {
        assert_eq!((CHAT_MIN_H, CHAT_MAX_H), (240, 300));
        for (messages, expected) in [(0,240),(1,280),(2,300),(3,300),(50,300),(u32::MAX,300)] {
            assert_eq!(chat_prompt_height(messages),expected);
        }
        assert_eq!(chat_visible(1048,1.0),(720,240));
    }
    #[test]
    fn the_desired_chat_height_is_clamped_in_rust_to_coucous_min_and_max() {
        for (desired,expected) in [(-5,240),(0,240),(239,240),(240,240),(270,270),(300,300),(301,300),(656,300),(i32::MAX,300)] {
            assert_eq!(chat_visible_for(1048,1.0,desired),(720,expected));
        }
        assert_eq!(chat_visible_for(320,1.0,300).1,264);
        assert_eq!(chat_visible_for(100,1.0,300).1,240);
        assert_eq!(chat_visible_for(2096,2.0,280),chat_visible_for(1048,1.0,280));
    }
    #[test]
    fn chat_height_shrinks_with_the_work_area_and_leaves_air_at_the_far_edge() {
        for area_h in [900,768,700,600,500,330] {
            let (_,h) = chat_visible_for(area_h,1.0,CHAT_MAX_H);
            assert!(h+16 <= area_h-CHAT_FAR_GAP || h == CHAT_MIN_H); assert!(h >= CHAT_MIN_H);
        }
        assert_eq!(chat_visible_for(320,1.0,CHAT_MAX_H).1,264);
        assert_eq!(chat_visible_for(768,1.0,CHAT_MAX_H).1,CHAT_MAX_H);
        let mut last = 0;
        for h in (300..1300).step_by(7) { let height = chat_visible_for(h,1.0,CHAT_MAX_H).1; assert!(height >= last); last = height; }
    }
    #[test]
    fn chat_is_never_shorter_than_the_old_horizontal_chat() {
        assert_eq!(CHAT_MIN_H,240);
        for h in [0,1,100,240,300,400] { assert!(chat_visible(h,1.0).1 >= CHAT_MIN_H); }
        assert_eq!(chat_visible(100,1.0).1,240);
    }
    #[test]
    fn chat_size_is_in_logical_px_whatever_the_scale() {
        assert_eq!(chat_visible(2096,2.0),chat_visible(1048,1.0));
        assert_eq!(chat_visible(1310,1.25),chat_visible(1048,1.0));
        assert_eq!(scaled_size(ISLAND_WINDOW,2.0),(1504,680));
        for bad in [0.0,-1.0,f64::NAN,f64::INFINITY] { assert_eq!(chat_visible(1048,bad),chat_visible(1048,1.0)); }
    }
    #[test]
    fn approved_overview_and_compact_are_untouched_by_the_chat_view() {
        assert_eq!(OVERVIEW_VISIBLE,(720, 150)); assert_eq!(COMPACT_BAR,(288,32));
        assert_eq!(CHAT_COLUMN_W,OVERVIEW_VISIBLE.0); assert!(CHAT_MIN_H > OVERVIEW_VISIBLE.1);
    }
    #[test]
    fn the_view_table_agrees_with_the_per_view_functions() {
        assert_eq!(view_sizes(View::Compact,1920,1048,1.0),(ISLAND_WINDOW,COMPACT_BAR));
        assert_eq!(view_sizes(View::Overview,1920,1048,1.0),(ISLAND_WINDOW,OVERVIEW_VISIBLE));
        assert_eq!(view_sizes(View::Chat,1920,1048,1.0),(ISLAND_WINDOW,chat_visible(1048,1.0)));
    }
    #[test]
    fn the_view_table_derived_views_follow_the_work_area_and_scale() {
        for h in [1048,768,600,400] {
            let (window,visible) = view_sizes(View::Chat,1920,h,1.0);
            assert_eq!(window,ISLAND_WINDOW); assert_eq!(visible.1,chat_visible(h,1.0).1); assert!(window.1 >= visible.1);
        }
        for scale in [1.0,1.25,2.0,0.0,f64::NAN] {
            for view in [View::Compact,View::Overview,View::Chat] {
                assert_eq!(view_sizes(view,1920,1048,scale).0,ISLAND_WINDOW);
            }
        }
    }
    #[test]
    fn transition_input_shape_holds_both_endpoints_and_spring_air() {
        assert_eq!(transition_shape((288, 32), (720, 150), ISLAND_WINDOW), (752, 166));
        assert_eq!(transition_shape((720, 300), (288, 32), ISLAND_WINDOW), (752, 316));
        assert_eq!(transition_shape((752, 340), (720, 300), ISLAND_WINDOW), ISLAND_WINDOW);
        assert_eq!(transition_shape((720, 300), (288, 32), (500, 200)), (500, 200));
        assert_eq!(transition_shape((720, 150), (288, 32), ISLAND_WINDOW),
            transition_shape((288, 32), (720, 150), ISLAND_WINDOW));
    }

    // --- #493 step B (human: «Fija arriba al centro, como Coucou»): ONE fixed window ------------------------------------

    #[test]
    fn the_island_window_is_one_fixed_size_for_every_view() {
        assert_eq!(ISLAND_WINDOW, (752, 340), "island 720 + 16 of air each side; chat max 300 + 16 + the spring's overshoot");
        for view in [View::Compact, View::Overview, View::Chat] {
            let (window, visible) = view_sizes(view, 1920, 1048, 1.0);
            assert_eq!(window, ISLAND_WINDOW, "{view:?}: the native window never changes with the view");
            assert!(visible.0 <= window.0 && visible.1 <= window.1 - 16, "{view:?}: the visible island fits inside with air");
        }
        assert_eq!(view_sizes(View::Compact, 1920, 1048, 1.0).1, COMPACT_BAR);
        assert_eq!(view_sizes(View::Overview, 1920, 1048, 1.0).1, OVERVIEW_VISIBLE);
        assert_eq!(view_sizes(View::Chat, 1920, 1048, 1.0).1, (720, 240));
    }

    #[test]
    fn the_island_window_sits_top_centre_of_the_work_area_and_is_clamped_to_it() {
        let a = area();
        let r = island_window_rect(a, 1.0);
        assert_eq!((r.w, r.h), (752, 340));
        assert_eq!(r.y, a.y, "stuck to the top edge");
        assert_eq!(r.x + r.w / 2, a.x + a.w / 2, "centred on the work area");
        // physical px at another scale
        let big = Rect { x: 0, y: 64, w: 3840, h: 2096 };
        let r2 = island_window_rect(big, 2.0);
        assert_eq!((r2.w, r2.h, r2.y), (1504, 680, 64));
        // a work area smaller than the window shrinks it onto the screen, never off it
        let tiny = Rect { x: 10, y: 20, w: 500, h: 300 };
        let r3 = island_window_rect(tiny, 1.0);
        assert_eq!((r3.x, r3.y, r3.w, r3.h), (10, 20, 500, 300));
        assert!(clamp_rect(r3, tiny) == r3);
    }

    #[test]
    fn the_input_shape_is_the_visible_island_clamped_between_the_bar_and_the_window() {
        // the page reports what it draws; Rust never lets it make the island unclickable (below the bar) or larger than the window
        for (asked, expected) in [((288, 32), (288, 32)), ((720, 150), (720, 150)), ((720, 300), (720, 300)), ((0, 0), (288, 32)), ((-5, 9), (288, 32)),
            ((10_000, 10_000), (752, 340)), ((720, 5_000), (720, 340)), ((100, 200), (288, 200))] {
            assert_eq!(clamp_island_shape(asked.0, asked.1, ISLAND_WINDOW), expected, "{asked:?}");
        }
        // a window clamped by a small screen bounds it too
        assert_eq!(clamp_island_shape(720, 300, (500, 300)), (500, 300));
        // and the rect inside the window: horizontally centred, glued to the top
        assert_eq!(island_shape_rect((720, 150), ISLAND_WINDOW), (16, 0, 720, 150));
        assert_eq!(island_shape_rect((288, 32), ISLAND_WINDOW), (232, 0, 288, 32));
        assert_eq!(island_shape_rect((752, 340), ISLAND_WINDOW), (0, 0, 752, 340));
    }

    #[test]
    fn window_height_grows_on_demand_up_to_70_percent_of_the_work_area_and_never_below_the_fixed_window() {
        // 1048 logical px of work area at scale 1 -> cap floor(1048 * 0.70) = 733
        assert_eq!(clamp_window_height(300, 1048, 1.0), ISLAND_WINDOW.1, "never shorter than the fixed window");
        assert_eq!(clamp_window_height(340, 1048, 1.0), 340);
        assert_eq!(clamp_window_height(500, 1048, 1.0), 500);
        assert_eq!(clamp_window_height(733, 1048, 1.0), 733);
        assert_eq!(clamp_window_height(900, 1048, 1.0), 733, "capped at 70% of the work area");
        assert_eq!(clamp_window_height(i32::MAX, 1048, 1.0), 733);
        assert_eq!(clamp_window_height(i32::MIN, 1048, 1.0), ISLAND_WINDOW.1);
        // physical work area is divided by the scale: 2096 phys at 2.0 is the same 1048 logical px
        assert_eq!(clamp_window_height(900, 2096, 2.0), 733);
        // a short screen never pushes the window below its fixed size (clamp_rect keeps it on screen)
        assert_eq!(clamp_window_height(900, 400, 1.0), ISLAND_WINDOW.1);
        // junk scale falls back to 1
        for bad in [0.0, -2.0, f64::NAN, f64::INFINITY] { assert_eq!(clamp_window_height(900, 1048, bad), 733, "{bad}"); }
    }
    #[test]
    fn a_taller_window_keeps_the_top_anchor_the_width_and_the_screen() {
        let area = area();
        let base = island_window_rect(area, 1.0);
        assert_eq!(island_window_rect_h(area, 1.0, ISLAND_WINDOW.1), base, "the default height is the fixed window");
        let tall = island_window_rect_h(area, 1.0, 600);
        assert_eq!((tall.x, tall.y, tall.w, tall.h), (base.x, base.y, base.w, 600));
        // too tall for the area: clamp_rect keeps it on screen
        let huge = island_window_rect_h(area, 1.0, 5000);
        assert_eq!((huge.y, huge.h), (area.y, area.h));
        assert_eq!(island_window_rect_h(area, 2.0, 500).h, 1000, "the height is logical, scaled to physical");
    }

    #[test]
    fn the_window_is_centred_on_the_monitor_not_on_a_work_area_a_side_dock_has_shifted() {
        // 1920x1080 monitor, a 46 px dock on the LEFT: GNOME's work area is x=46, w=1874, so its centre is 983 (23 px right of the
        // screen centre 960). The island hangs from the top centre of the SCREEN (like a notch), not of what a dock left over.
        let monitor = Rect { x: 0, y: 0, w: 1920, h: 1080 };
        let work = Rect { x: 46, y: 0, w: 1874, h: 1080 };
        let r = island_window_rect_on(monitor, work, 1.0, ISLAND_WINDOW.1);
        assert_eq!(r.x + r.w / 2, 960, "window centre = monitor centre");
        assert_eq!((r.x, r.w), (584, 752));
        assert_eq!(r.y, work.y, "the top still honours the work area (a top panel pushes it down)");
        // a top panel: y comes from the work area, x from the monitor
        let top = island_window_rect_on(monitor, Rect { x: 0, y: 32, w: 1920, h: 1048 }, 1.0, ISLAND_WINDOW.1);
        assert_eq!((top.x, top.y), (584, 32));
        // a second monitor to the right keeps its own centre
        let second = Rect { x: 1920, y: 0, w: 2560, h: 1440 };
        let r2 = island_window_rect_on(second, second, 1.0, ISLAND_WINDOW.1);
        assert_eq!(r2.x + r2.w / 2, 1920 + 1280);
        // the dock on the RIGHT shifts the other way: still the monitor centre
        let right = island_window_rect_on(monitor, Rect { x: 0, y: 0, w: 1874, h: 1080 }, 1.0, ISLAND_WINDOW.1);
        assert_eq!(right.x + right.w / 2, 960);
        // a monitor narrower than the window clamps inside the work area (being on screen wins)
        let tiny = island_window_rect_on(Rect { x: 0, y: 0, w: 500, h: 400 }, Rect { x: 0, y: 0, w: 500, h: 400 }, 1.0, ISLAND_WINDOW.1);
        assert!(tiny.x >= 0 && tiny.right() <= 500);
        // without a monitor the work area is the only truth: today's behaviour
        assert_eq!(island_window_rect_h(work, 1.0, ISLAND_WINDOW.1), island_window_rect_on(work, work, 1.0, ISLAND_WINDOW.1));
    }

    // ── The display scale under XWayland native scaling (#503, handoff «isla escala 125») ──
    // GNOME at 125 %: the logical screen is 1536x864 and Xwayland draws it at an integer 2x, so the X root is 3072x1728 and the
    // monitor the island sees is 3072x1728 PHYSICAL px with GDK scale 2. With NO RandR output (the virtual screen-share monitor
    // removed) GDK falls back to scale 1 while the root keeps its native geometry: reading that 1 as a measurement drew the island
    // at half size and off-centre. A scale is only a measurement while a monitor backs it.
    fn native_125() -> Rect { Rect { x: 0, y: 0, w: 3072, h: 1728 } }

    #[test]
    fn a_scale_is_a_reading_only_while_a_monitor_backs_it() {
        assert_eq!(effective_scale(2.0, Some(native_125())), Some(2.0));
        assert_eq!(effective_scale(1.0, Some(Rect { x: 0, y: 0, w: 1920, h: 1080 })), Some(1.0));
        assert_eq!(effective_scale(1.0, None), None, "no monitor: GDK's 1 is a fallback, not a reading");
        assert_eq!(effective_scale(2.0, None), None);
        assert_eq!(effective_scale(2.0, Some(Rect { x: 0, y: 0, w: 0, h: 0 })), None, "a 0-wide monitor is no monitor");
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(effective_scale(bad, Some(native_125())), Some(1.0), "a junk reading with a monitor falls back to 1 like valid_scale");
        }
    }

    #[test]
    fn the_island_keeps_its_logical_size_and_the_screen_centre_at_1_1_25_native_and_2() {
        // (monitor in X px, GDK scale, expected window in X px, expected centre x)
        for (monitor, scale, size, centre) in [
            (Rect { x: 0, y: 0, w: 1920, h: 1080 }, 1.0, (752, 340), 960),
            (native_125(), 2.0, (1504, 680), 1536),
            (Rect { x: 0, y: 0, w: 3840, h: 2160 }, 2.0, (1504, 680), 1920),
        ] {
            let r = island_window_rect_for(Some(monitor), monitor, scale, ISLAND_WINDOW.1).expect("a monitor is there");
            assert_eq!((r.w, r.h), size, "logical 752x340 at scale {scale}");
            assert_eq!(r.x + r.w / 2, centre, "centred on the monitor's X geometry at scale {scale}");
            assert_eq!(r.y, monitor.y);
            assert_eq!(r.w as f64 / scale, 752.0, "the same LOGICAL width whatever the scale");
        }
    }

    #[test]
    fn without_a_monitor_nothing_is_placed_and_the_decision_does_not_depend_on_launch_timing() {
        let stale_area = Rect { x: 94, y: 64, w: 2978, h: 1664 };
        for scale in [1.0, 2.0, 1.25] {
            assert_eq!(island_window_rect_for(None, stale_area, scale, ISLAND_WINDOW.1), None, "no monitor at scale {scale}: keep the last placement");
            assert_eq!(island_window_rect_for(Some(Rect { x: 0, y: 0, w: 0, h: 0 }), stale_area, scale, ISLAND_WINDOW.1), None);
        }
        // launching with no monitor and the monitor arriving later gives EXACTLY what launching with it present gives
        let present = island_window_rect_for(Some(native_125()), native_125(), 2.0, ISLAND_WINDOW.1);
        let waited = [None, None].into_iter().chain([Some(native_125())]).fold(None, |last, m| island_window_rect_for(m, native_125(), 2.0, ISLAND_WINDOW.1).or(last));
        assert_eq!(waited, present);
    }


    #[test]
    fn every_compact_width_the_island_page_declares_is_known_here() {
        // One source of truth: island-layout.js declares the compact pill's widths (COMPACT_W, COMPACT_WIDE, COMPACT_ASK, ...); the
        // hidden strip's input zone in islandshape.rs only recognises the widths listed in COMPACT_WIDTHS. A width added on the page
        // and not here silently gave the strip a 32 px input zone instead of the drawn 8 (it happened with 440).
        let js = include_str!("../frontend/island-layout.js");
        let mut declared: Vec<i32> = Vec::new();
        for (at, _) in js.match_indices("COMPACT_") {
            let rest = &js[at + "COMPACT_".len()..];
            let name_end = rest.find(|c: char| !(c.is_ascii_uppercase() || c == '_')).unwrap_or(0);
            let after = rest[name_end..].trim_start();
            if name_end == 0 || !after.starts_with('=') || after.starts_with("==") { continue; }
            let digits: String = after[1..].trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(w) = digits.parse::<i32>() { declared.push(w); }
        }
        declared.sort_unstable();
        declared.dedup();
        assert!(declared.len() >= 3, "the page declares its compact widths as COMPACT_* = N constants: found {declared:?}");
        let mut known = COMPACT_WIDTHS.to_vec();
        known.sort_unstable();
        assert_eq!(declared, known, "island-layout.js compact widths vs geometry::COMPACT_WIDTHS");
        assert!(COMPACT_WIDTHS.iter().all(|&w| w <= ISLAND_WINDOW.0), "every compact pill fits the window");
    }
}

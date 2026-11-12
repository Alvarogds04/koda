//! Pure island geometry. Native rectangles are physical pixels; page/input-shape
//! dimensions are logical pixels. Every view shares one native window, placed top-centre until the human drags it.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect { pub x: i32, pub y: i32, pub w: i32, pub h: i32 }
impl Rect {
    pub fn right(&self) -> i32 { self.x + self.w }
    pub fn bottom(&self) -> i32 { self.y + self.h }
}

/// The edge the expanded card is anchored on (isla-cualquier-lado S1, design/isla-cualquier-lado/02-tarjeta-flotante.html): Top grows
/// down, Bottom grows up. There are no Left/Right edges: horizontal placement never changes the card's shape.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Edge { #[default] Top, Bottom }

/// Logical px the expanded card keeps from every work-area edge (artboard 02: «margen mínimo 12 a los bordes»). The compact disc
/// is exempt: it may touch any edge (island-free-drag S3).
pub const EDGE_GAP: i32 = 12;

/// The growth rule of artboard 02: a card whose centre is in the upper half of its monitor's work area hangs from its top edge
/// and grows down; in the lower half it stands on its bottom edge and grows up. The exact midpoint is Top. Same unit for both
/// rectangles (physical px); compared doubled so a half-pixel centre is exact.
pub fn growth_edge(card: Rect, area: Rect) -> Edge {
    let centre2 = 2 * i64::from(card.y) + i64::from(card.h);
    let middle2 = 2 * i64::from(area.y) + i64::from(area.h);
    if centre2 <= middle2 { Edge::Top } else { Edge::Bottom }
}

/// `area` shrunk by `gap` on every side, or `area` itself when it is too small to give the gap up (being on screen wins).
fn inset(area: Rect, gap: i32) -> Rect {
    if gap <= 0 || area.w <= 2 * gap || area.h <= 2 * gap { return area; }
    Rect { x: area.x + gap, y: area.y + gap, w: area.w - 2 * gap, h: area.h - 2 * gap }
}
fn edge_gap(scale: f64) -> i32 { (f64::from(EDGE_GAP) * valid_scale(scale)).round() as i32 }

/// Where a released drag leaves the island (island_move_end), as the disc spot to save and the edge to lay the card out for.
/// `window` is the native window the human released (physical px); `edge` the one it was laid out for; `card_h` the open card's
/// logical height. Compact, the window's top-left is the spot. Open, the CARD stays exactly where it was seen: it is read from the
/// window for `edge`, the growth rule picks the edge for that card, and the spot is its top (Top) or one disc above its bottom
/// (Bottom), so placing the open island at the spot rebuilds the released card without a jump. The edge returned is the one the
/// placement derives from the spot (growth_edge_at), so the two never disagree.
pub fn drop_spot(window: Rect, expanded: bool, edge: Edge, card_h: i32, area: Rect, scale: f64) -> ((i32, i32), Edge) {
    let y = if expanded {
        let (cw, ch) = scaled_size((OVERVIEW_VISIBLE.0, card_h.max(COMPACT_DOT.1)), scale);
        let top = match edge { Edge::Top => window.y, Edge::Bottom => window.bottom() - ch };
        match growth_edge(Rect { x: window.x, y: top, w: cw, h: ch }, area) {
            Edge::Top => top,
            Edge::Bottom => top + ch - scaled_size(COMPACT_DOT, scale).1,
        }
    } else { window.y };
    ((window.x, y), growth_edge_at(y, area, scale))
}
/// The growth edge of the island whose disc spot (the window's top-left while compact) is at `origin_y`: the overview card
/// opened downward from there is the reference, so the answer depends on where the human dropped the island and never flips
/// between the plans of one expanded card (physical px).
pub fn growth_edge_at(origin_y: i32, area: Rect, scale: f64) -> Edge {
    let (w, h) = scaled_size(OVERVIEW_VISIBLE, scale);
    growth_edge(Rect { x: area.x, y: origin_y, w, h }, area)
}
/// The disc spot of a native window laid out for `edge`: compact and Top windows start at it; a Bottom window stands on the
/// disc's bottom edge, so its spot is one disc above the window's bottom.
pub fn disc_origin_y(window: Rect, edge: Edge, scale: f64) -> i32 {
    match edge { Edge::Top => window.y, Edge::Bottom => window.bottom() - scaled_size(COMPACT_DOT, scale).1 }
}

/// The whole compact island, in logical px: Koda's DISC and nothing else — no bar, no activity line, no mini mascots, no «Responder»
/// pill, in NO compact state (island-free-drag S3/S5: the human's «que no aparezca la barra y que directamente sea nada más el
/// circulito»). A pending question/permission rides it as a state signal and is read when the island is opened. The page draws this
/// box (island-layout.js COMPACT_DOT_W / COMPACT_DOT_H) and a test keeps the two declarations in step.
pub const COMPACT_DOT: (i32, i32) = (40, 32);
pub const OVERVIEW_VISIBLE: (i32, i32) = (720, 150);
/// One logical native window for compact, overview, question and chat.
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
        View::Compact => COMPACT_DOT,
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
/// Horizontally centred on `monitor` (the default spot is the top centre of the SCREEN), vertically EDGE_GAP below the top of `area`
/// (a top panel pushes it down; isla-cualquier-lado S1: the floating card no longer touches the edge) and kept inside `area`. A side
/// dock shrinks the work area asymmetrically, so centring on the work area put the island 23 px off to one side on a 46 px dock.
pub fn island_window_rect_on(monitor: Rect, area: Rect, scale: f64, height: i32) -> Rect {
    let (w, h) = scaled_size((ISLAND_WINDOW.0, height), scale);
    let centred = Rect { x: monitor.x + (monitor.w - w) / 2, y: area.y + edge_gap(scale), w, h };
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
/// Where the human dragged the island: the window's top-left in physical px, and whether it is expanded now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placed { pub origin: (i32, i32), pub expanded: bool }
/// The island at the spot the human dragged it to, kept usable inside `area`. Compact, only the DISC (hanging centred from the
/// window's top) has to stay on screen, so the transparent rest of the window may leave it and the disc reaches every edge.
/// Expanded, the card grows toward the free half of the screen (growth_edge_at): in the upper half the window hangs from the disc
/// spot, in the lower half it stands on the disc's bottom edge so the card opens upward. Its column (the window's full height, the
/// card's width) keeps EDGE_GAP from every work-area edge: near an edge it shifts just enough, and collapsing returns it to `origin`.
pub fn island_window_rect_placed(placed: Placed, area: Rect, scale: f64, height: i32) -> Rect {
    let (w, h) = scaled_size((ISLAND_WINDOW.0, height), scale);
    let (keep, room, y) = if placed.expanded {
        let y = match growth_edge_at(placed.origin.1, area, scale) {
            Edge::Top => placed.origin.1,
            Edge::Bottom => placed.origin.1 + scaled_size(COMPACT_DOT, scale).1 - h,
        };
        ((scaled_size(OVERVIEW_VISIBLE, scale).0, h), inset(area, edge_gap(scale)), y)
    } else { (scaled_size(COMPACT_DOT, scale), area, placed.origin.1) };
    let (kw, kh) = (keep.0.min(w), keep.1.min(h));
    let side = (w - kw) / 2;
    let kept = clamp_rect(Rect { x: placed.origin.0 + side, y, w: kw, h: kh }, room);
    Rect { x: kept.x - side, y: kept.y, w, h }
}
/// `island_window_rect_for`, or the dragged placement when the human moved the island. No monitor still means «wait».
pub fn island_window_rect_where(monitor: Option<Rect>, area: Rect, reported_scale: f64, height: i32, placed: Option<Placed>) -> Option<Rect> {
    let scale = effective_scale(reported_scale, monitor)?;
    Some(match placed {
        Some(placed) => island_window_rect_placed(placed, area, scale, height),
        None => island_window_rect_on(monitor?, area, scale, height),
    })
}
/// A long question may grow the native window up to this share of the work-area height (human: «abito se ajusta al tamaño»).
pub const WINDOW_GROWTH_PERCENT: i32 = 70;
/// The page asks for a logical height; Rust decides: never below the fixed window, never above 70% of the work area.
pub fn clamp_window_height(desired: i32, area_h_phys: i32, scale: f64) -> i32 {
    let area_h = (f64::from(area_h_phys.max(0)) / valid_scale(scale)).floor() as i32;
    let cap = (i64::from(area_h) * i64::from(WINDOW_GROWTH_PERCENT) / 100) as i32;
    desired.max(ISLAND_WINDOW.1).min(cap.max(ISLAND_WINDOW.1))
}
/// Page-reported logical dimensions are bounded by the DISC (the smallest compact island) and the actual window.
pub fn clamp_island_shape(w: i32, h: i32, window: (i32, i32)) -> (i32, i32) {
    (w.max(COMPACT_DOT.0).min(window.0.max(0)), h.max(COMPACT_DOT.1).min(window.1.max(0)))
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
    fn a_dragged_island_stays_where_it_was_released() {
        let placed = Placed { origin: (100, 500), expanded: false };
        assert_eq!(island_window_rect_placed(placed, area(), 1.0, ISLAND_WINDOW.1), Rect { x: 100, y: 500, w: 752, h: 340 });
        // expanded at the same spot in the upper half: the whole window fits, so nothing moves either
        let open = Placed { origin: (100, 300), expanded: true };
        assert_eq!(island_window_rect_placed(open, area(), 1.0, ISLAND_WINDOW.1), Rect { x: 100, y: 300, w: 752, h: 340 });
        // isla-cualquier-lado S1: in the lower half the window stands on the disc's bottom edge (500 + 32) and the card grows up
        let low = Placed { origin: (100, 500), expanded: true };
        assert_eq!(island_window_rect_placed(low, area(), 1.0, ISLAND_WINDOW.1), Rect { x: 100, y: 500 + 32 - 340, w: 752, h: 340 });
    }
    #[test]
    fn a_compact_island_may_reach_any_edge_while_the_disc_stays_on_screen() {
        // S3: compact is only the disc, so the DISC (not a bar) is what placement keeps inside the work area
        let side = (ISLAND_WINDOW.0 - COMPACT_DOT.0) / 2; // transparent air beside the disc
        let compact = |origin| island_window_rect_placed(Placed { origin, expanded: false }, area(), 1.0, ISLAND_WINDOW.1);
        assert_eq!(compact((-5000, 500)), Rect { x: -side, y: 500, w: 752, h: 340 }, "left edge");
        assert_eq!(compact((5000, 500)), Rect { x: 1920 - 752 + side, y: 500, w: 752, h: 340 }, "right edge");
        assert_eq!(compact((500, 5000)), Rect { x: 500, y: 1080 - COMPACT_DOT.1, w: 752, h: 340 }, "bottom edge: the disc, not the window");
        assert_eq!(compact((500, -5000)), Rect { x: 500, y: 32, w: 752, h: 340 }, "never above the top panel");
    }
    #[test]
    fn an_expanded_island_near_an_edge_shifts_just_enough_to_show_everything() {
        // isla-cualquier-lado S1: the card keeps EDGE_GAP (12) from the edges; the window's 16 px of side air may leave the screen
        let open = |origin| island_window_rect_placed(Placed { origin, expanded: true }, area(), 1.0, ISLAND_WINDOW.1);
        assert_eq!(open((500, 1060)), Rect { x: 500, y: 1080 - 12 - 340, w: 752, h: 340 });
        assert_eq!(open((-300, 300)), Rect { x: 12 - 16, y: 300, w: 752, h: 340 });
        assert_eq!(open((1900, 300)), Rect { x: 1920 - 12 - 720 - 16, y: 300, w: 752, h: 340 });
        // a scaled screen keeps physical origins and scales the kept box
        let hidpi = island_window_rect_placed(Placed { origin: (5000, 5000), expanded: false }, area(), 2.0, ISLAND_WINDOW.1);
        // compact at scale 2: the 80x64 disc is what stays on screen; the 1504-wide window may hang off it
        assert_eq!(hidpi, Rect { x: 1920 - 80 - (1504 - 80) / 2, y: 1080 - 64, w: 1504, h: 680 });
    }
    #[test]
    fn without_a_dragged_origin_the_island_is_placed_top_centre_as_before() {
        let monitor = Rect { x: 0, y: 0, w: 1920, h: 1080 };
        assert_eq!(island_window_rect_where(Some(monitor), area(), 1.0, ISLAND_WINDOW.1, None), island_window_rect_for(Some(monitor), area(), 1.0, ISLAND_WINDOW.1));
        let placed = Placed { origin: (100, 500), expanded: false };
        assert_eq!(island_window_rect_where(Some(monitor), area(), 1.0, ISLAND_WINDOW.1, Some(placed)), Some(Rect { x: 100, y: 500, w: 752, h: 340 }));
        assert_eq!(island_window_rect_where(None, area(), 1.0, ISLAND_WINDOW.1, Some(placed)), None, "no monitor: keep the last placement");
    }

    // --- isla-cualquier-lado S1/S5 (T5): the expanded island is a floating card that grows toward the free half of its screen ----------

    #[test]
    fn a_card_in_the_upper_half_grows_down_and_one_in_the_lower_half_grows_up() {
        // work area y 32..1080: midpoint 556
        let card = |y| Rect { x: 600, y, w: 720, h: 150 };
        assert_eq!(growth_edge(card(44), area()), Edge::Top, "near the top: anchored on its top edge, grows down");
        assert_eq!(growth_edge(card(300), area()), Edge::Top);
        assert_eq!(growth_edge(card(700), area()), Edge::Bottom, "lower half: anchored on its bottom edge, grows up");
        assert_eq!(growth_edge(card(1080 - 12 - 150), area()), Edge::Bottom);
        // only the vertical centre counts: horizontal placement never changes the shape
        for x in [-5000, 0, 1500, 5000] { assert_eq!(growth_edge(Rect { x, ..card(700) }, area()), Edge::Bottom); }
    }
    #[test]
    fn a_card_centred_exactly_on_the_work_area_midpoint_grows_down() {
        // centre 481 + 75 = 556 = 32 + 1048 / 2: the tie is pinned to Top (today's behaviour); one pixel lower is Bottom
        assert_eq!(growth_edge(Rect { x: 600, y: 481, w: 720, h: 150 }, area()), Edge::Top);
        assert_eq!(growth_edge(Rect { x: 600, y: 482, w: 720, h: 150 }, area()), Edge::Bottom);
        // an odd height puts the centre on a half pixel: exact, no rounding toward either half
        let odd = Rect { x: 0, y: 0, w: 100, h: 101 }; // midpoint 50.5
        assert_eq!(growth_edge(Rect { x: 0, y: 0, w: 40, h: 101 }, odd), Edge::Top, "centre 50.5 == midpoint 50.5");
        assert_eq!(growth_edge(Rect { x: 0, y: 1, w: 40, h: 100 }, odd), Edge::Bottom, "centre 51 > 50.5");
    }
    #[test]
    fn the_growth_edge_is_read_on_the_cards_own_monitor_even_with_a_negative_origin() {
        // a secondary monitor above-left of the primary: work area y -1080..0, midpoint -540
        let second = Rect { x: -1920, y: -1080, w: 1920, h: 1040 }; // a 40 px bottom panel: midpoint -560
        let card = |y| Rect { x: -1500, y, w: 720, h: 150 };
        assert_eq!(growth_edge(card(-1068), second), Edge::Top);
        assert_eq!(growth_edge(card(-635), second), Edge::Top, "centre -560 is the midpoint");
        assert_eq!(growth_edge(card(-634), second), Edge::Bottom);
        assert_eq!(growth_edge(card(-200), second), Edge::Bottom, "near its own bottom, although above the primary's midpoint");
        // a physical-pixel monitor at scale 2 to the right: the rule is the same on physical px
        let hidpi = Rect { x: 1920, y: 0, w: 3840, h: 2096 };
        assert_eq!(growth_edge(Rect { x: 2400, y: 1500, w: 1440, h: 300 }, hidpi), Edge::Bottom);
        assert_eq!(growth_edge(Rect { x: 2400, y: 24, w: 1440, h: 300 }, hidpi), Edge::Top);
    }
    #[test]
    fn an_expanded_card_keeps_12px_from_every_work_area_edge_while_the_disc_may_touch_them() {
        assert_eq!(EDGE_GAP, 12);
        let open = |origin| island_window_rect_placed(Placed { origin, expanded: true }, area(), 1.0, ISLAND_WINDOW.1);
        let side = (ISLAND_WINDOW.0 - OVERVIEW_VISIBLE.0) / 2; // 16 px of transparent air each side of the 720 card
        for origin in [(-5000, -5000), (5000, 5000), (-5000, 5000), (5000, -5000), (500, 32), (500, 1060), (0, 500), (1200, 500)] {
            let w = open(origin);
            let (left, right) = (w.x + side, w.right() - side);
            assert!(left >= 12 && right <= 1920 - 12, "{origin:?}: card x {left}..{right} keeps 12 px from the sides");
            assert!(w.y >= 32 + 12 && w.bottom() <= 1080 - 12, "{origin:?}: window y {}..{} keeps 12 px from the top and bottom", w.y, w.bottom());
        }
        assert_eq!(open((-5000, -5000)), Rect { x: 12 - side, y: 44, w: 752, h: 340 }, "top-left corner: the card is exactly 12 px in");
        assert_eq!(open((5000, 5000)), Rect { x: 1920 - 12 - 720 - side, y: 1080 - 12 - 340, w: 752, h: 340 });
        // well inside the work area nothing moves (upper half: the window hangs from the disc spot)
        assert_eq!(open((100, 300)), Rect { x: 100, y: 300, w: 752, h: 340 });
        // the gap is logical: 24 physical px at scale 2
        let hidpi = island_window_rect_placed(Placed { origin: (-5000, -5000), expanded: true }, area(), 2.0, ISLAND_WINDOW.1);
        assert_eq!((hidpi.x + 32, hidpi.y), (24, 32 + 24));
        // compact: the disc still reaches every edge (island-free-drag S3)
        let compact = island_window_rect_placed(Placed { origin: (500, -5000), expanded: false }, area(), 1.0, ISLAND_WINDOW.1);
        assert_eq!(compact.y, 32);
    }
    #[test]
    fn a_card_dropped_in_the_lower_half_opens_upward_from_the_discs_bottom_edge() {
        let open = |y| island_window_rect_placed(Placed { origin: (100, y), expanded: true }, area(), 1.0, ISLAND_WINDOW.1);
        // the disc's bottom edge (y + 32) is where the card stands: the window bottom
        for y in [520, 700, 900] { assert_eq!(open(y).bottom(), y + 32, "disc at {y}"); }
        // a disc on the bottom edge: the card keeps its 12 px
        assert_eq!(open(1080 - 32).bottom(), 1080 - 12);
        // the edge is the same function of the spot both ways: Top hangs from the spot, Bottom ends one disc below it
        for y in [100, 481, 482, 700] {
            let edge = growth_edge_at(y, area(), 1.0);
            assert_eq!(disc_origin_y(open(y), edge, 1.0), y, "spot {y} ({edge:?}) round-trips");
        }
        assert_eq!(growth_edge_at(481, area(), 1.0), Edge::Top); assert_eq!(growth_edge_at(482, area(), 1.0), Edge::Bottom);
        // a taller (question) window still stands on the disc's bottom edge
        assert_eq!(island_window_rect_placed(Placed { origin: (100, 900), expanded: true }, area(), 1.0, 500).bottom(), 932);
        // scale 2: 64 px disc, 680 px window
        let hidpi = island_window_rect_placed(Placed { origin: (100, 1500), expanded: true }, Rect { x: 0, y: 0, w: 3840, h: 2160 }, 2.0, ISLAND_WINDOW.1);
        assert_eq!((hidpi.y, hidpi.bottom()), (1500 + 64 - 680, 1564));
    }
    #[test]
    fn dropping_an_open_card_keeps_it_where_it_was_released_and_round_trips_through_the_placement() {
        // island_move_end: the window the human released, laid out for `edge`, gives back the disc spot to save; placing the open
        // island at that spot rebuilds exactly the released window (no jump), and the edge it reports is the one to lay out for.
        let h = ISLAND_WINDOW.1;
        let again = |spot: (i32, i32), height| island_window_rect_placed(Placed { origin: spot, expanded: true }, area(), 1.0, height);
        // compact: the window's top-left IS the spot
        assert_eq!(drop_spot(Rect { x: 300, y: 900, w: 752, h }, false, Edge::Top, 150, area(), 1.0), ((300, 900), Edge::Bottom));
        assert_eq!(drop_spot(Rect { x: 300, y: 100, w: 752, h }, false, Edge::Bottom, 150, area(), 1.0), ((300, 100), Edge::Top));
        // an open lower-half card dragged within the lower half: the spot is one disc above the window bottom, nothing moves
        let low = Rect { x: 300, y: 600, w: 752, h };
        let (spot, edge) = drop_spot(low, true, Edge::Bottom, 150, area(), 1.0);
        assert_eq!((spot, edge), ((300, 600 + h - 32), Edge::Bottom));
        assert_eq!(spot.1, disc_origin_y(low, Edge::Bottom, 1.0));
        assert_eq!(again(spot, h), low, "lower half: the released window comes back unchanged");
        // an open upper-half card: the spot is the window top
        let high = Rect { x: 300, y: 200, w: 752, h };
        assert_eq!(drop_spot(high, true, Edge::Top, 150, area(), 1.0), ((300, 200), Edge::Top));
        assert_eq!(again((300, 200), h), high);
        // dragged ACROSS the midpoint: the card stays where it was seen and the edge flips. A bottom-anchored card dropped high
        // (card 150 at y 100..250) now hangs from its own top; a top-anchored card dropped low stands on its own bottom.
        let (spot, edge) = drop_spot(Rect { x: 300, y: 250 - h, w: 752, h }, true, Edge::Bottom, 150, area(), 1.0);
        assert_eq!((spot, edge), ((300, 100), Edge::Top));
        assert_eq!(again(spot, h).y, 100, "the card's top stays at 100");
        let (spot, edge) = drop_spot(Rect { x: 300, y: 800, w: 752, h }, true, Edge::Top, 150, area(), 1.0);
        assert_eq!((spot, edge), ((300, 800 + 150 - 32), Edge::Bottom));
        assert_eq!(again(spot, h).bottom(), 950, "the card's bottom stays at 950");
        // the open card's real height (a 240 chat) is what stays put when it crosses
        let (spot, edge) = drop_spot(Rect { x: 300, y: 700, w: 752, h }, true, Edge::Top, 240, area(), 1.0);
        assert_eq!((spot, edge), ((300, 700 + 240 - 32), Edge::Bottom));
        // scale 2: the disc is 64 physical px
        let big = Rect { x: 0, y: 0, w: 3840, h: 2160 };
        let w2 = Rect { x: 100, y: 1200, w: 1504, h: 680 };
        assert_eq!(drop_spot(w2, true, Edge::Bottom, 150, big, 2.0), ((100, 1880 - 64), Edge::Bottom));
    }
    #[test]
    fn the_default_placement_leaves_12px_between_the_work_area_top_and_the_card() {
        assert_eq!(island_window_rect(area(), 1.0).y, 32 + 12);
        assert_eq!(island_window_rect(Rect { x: 0, y: 64, w: 3840, h: 2096 }, 2.0).y, 64 + 24, "12 logical px at scale 2");
        let monitor = Rect { x: 0, y: 0, w: 1920, h: 1080 };
        assert_eq!(island_window_rect_for(Some(monitor), monitor, 1.0, ISLAND_WINDOW.1).map(|r| r.y), Some(12));
    }

    #[test]
    fn scaled_size_applies_scale_factor() {
        assert_eq!(scaled_size(COMPACT_DOT, 1.0), (40, 32));
        assert_eq!(scaled_size(ISLAND_WINDOW, 1.0), (752, 340));
        assert_eq!(scaled_size(COMPACT_DOT, 2.0), (80, 64));
        assert_eq!(scaled_size(COMPACT_DOT, 1.25), (50, 40));
        assert_eq!(scaled_size((304, 44), 1.25), (380, 55));
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(scaled_size(COMPACT_DOT, bad), COMPACT_DOT);
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
        assert_eq!(OVERVIEW_VISIBLE,(720, 150)); assert_eq!(COMPACT_DOT,(40,32));
        assert_eq!(CHAT_COLUMN_W,OVERVIEW_VISIBLE.0); assert!(CHAT_MIN_H > OVERVIEW_VISIBLE.1);
    }
    #[test]
    fn the_view_table_agrees_with_the_per_view_functions() {
        assert_eq!(view_sizes(View::Compact,1920,1048,1.0),(ISLAND_WINDOW,COMPACT_DOT));
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
        assert_eq!(transition_shape((40, 32), (720, 150), ISLAND_WINDOW), (752, 166));
        assert_eq!(transition_shape((720, 300), (40, 32), ISLAND_WINDOW), (752, 316));
        assert_eq!(transition_shape((752, 340), (720, 300), ISLAND_WINDOW), ISLAND_WINDOW);
        assert_eq!(transition_shape((720, 300), (40, 32), (500, 200)), (500, 200));
        assert_eq!(transition_shape((720, 150), (40, 32), ISLAND_WINDOW),
            transition_shape((40, 32), (720, 150), ISLAND_WINDOW));
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
        assert_eq!(view_sizes(View::Compact, 1920, 1048, 1.0).1, COMPACT_DOT);
        assert_eq!(view_sizes(View::Overview, 1920, 1048, 1.0).1, OVERVIEW_VISIBLE);
        assert_eq!(view_sizes(View::Chat, 1920, 1048, 1.0).1, (720, 240));
    }

    #[test]
    fn the_island_window_sits_top_centre_of_the_work_area_and_is_clamped_to_it() {
        let a = area();
        let r = island_window_rect(a, 1.0);
        assert_eq!((r.w, r.h), (752, 340));
        assert_eq!(r.y, a.y + EDGE_GAP, "isla-cualquier-lado S1: 12 px below the top edge (was flush)");
        assert_eq!(r.x + r.w / 2, a.x + a.w / 2, "centred on the work area");
        // physical px at another scale
        let big = Rect { x: 0, y: 64, w: 3840, h: 2096 };
        let r2 = island_window_rect(big, 2.0);
        assert_eq!((r2.w, r2.h, r2.y), (1504, 680, 64 + 24));
        // a work area smaller than the window shrinks it onto the screen, never off it
        let tiny = Rect { x: 10, y: 20, w: 500, h: 300 };
        let r3 = island_window_rect(tiny, 1.0);
        assert_eq!((r3.x, r3.y, r3.w, r3.h), (10, 20, 500, 300));
        assert!(clamp_rect(r3, tiny) == r3);
    }

    #[test]
    fn the_input_shape_is_the_visible_island_clamped_between_the_bar_and_the_window() {
        // the page reports what it draws; Rust never lets it make the island unclickable (below the DISC) or larger than the window
        for (asked, expected) in [((40, 32), (40, 32)), ((720, 150), (720, 150)), ((720, 300), (720, 300)), ((0, 0), (40, 32)), ((-5, 9), (40, 32)),
            ((10_000, 10_000), (752, 340)), ((720, 5_000), (720, 340)), ((100, 200), (100, 200))] {
            assert_eq!(clamp_island_shape(asked.0, asked.1, ISLAND_WINDOW), expected, "{asked:?}");
        }
        // a window clamped by a small screen bounds it too
        assert_eq!(clamp_island_shape(720, 300, (500, 300)), (500, 300));
        // and the rect inside the window: horizontally centred, glued to the top — the disc's own box in compact
        assert_eq!(island_shape_rect((720, 150), ISLAND_WINDOW), (16, 0, 720, 150));
        assert_eq!(island_shape_rect(COMPACT_DOT, ISLAND_WINDOW), ((752 - COMPACT_DOT.0) / 2, 0, COMPACT_DOT.0, COMPACT_DOT.1));
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
        assert_eq!(r.y, work.y + EDGE_GAP, "the top still honours the work area (a top panel pushes it down), 12 px below it");
        // a top panel: y comes from the work area, x from the monitor
        let top = island_window_rect_on(monitor, Rect { x: 0, y: 32, w: 1920, h: 1048 }, 1.0, ISLAND_WINDOW.1);
        assert_eq!((top.x, top.y), (584, 32 + 12));
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
            assert_eq!(r.y, monitor.y + (f64::from(EDGE_GAP) * scale) as i32, "12 logical px below the top at scale {scale}");
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
    fn the_disc_the_island_page_declares_is_the_one_geometry_keeps_on_screen() {
        // One source of truth: island-layout.js declares the disc's box as COMPACT_DOT_W / COMPACT_DOT_H, and geometry::COMPACT_DOT
        // (the native input shape, the placement keep-box and the hidden strip's activation zone) is exactly that box. A page disc
        // that moved without this constant silently shrank the clickable island (or kept a bar on screen that is not drawn).
        let js = include_str!("../frontend/island-layout.js");
        let declared = |name: &str| -> i32 {
            let at = js.find(&format!("const {name} = ")).unwrap_or_else(|| panic!("island-layout.js declares {name}"));
            js[at..].split_once('=').expect("a value").1.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect::<String>()
                .parse::<i32>().unwrap_or_else(|_| panic!("{name} is a decimal constant"))
        };
        assert_eq!((declared("COMPACT_DOT_W"), declared("COMPACT_DOT_H")), COMPACT_DOT,
            "island-layout.js COMPACT_DOT_W / COMPACT_DOT_H vs geometry::COMPACT_DOT");
        assert!(COMPACT_DOT.0 <= ISLAND_WINDOW.0 && COMPACT_DOT.1 <= ISLAND_WINDOW.1, "the disc fits the window");
    }
}

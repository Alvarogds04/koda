//! Island interaction policy. Pointer travel distinguishes clicks from cancelled gestures;
//! every view lives in the same top-centred native window.
use crate::geometry::{self, Edge, Rect};

pub trait WindowIo {
    fn outer_position(&self) -> (i32, i32);
    fn size(&self) -> (i32, i32);
    fn scale(&self) -> f64;
    fn set_outer_position(&self, x: i32, y: i32);
}

pub fn screen_at(io: &dyn WindowIo, client: (f64, f64)) -> (f64, f64) {
    let (x, y) = io.outer_position();
    (x as f64 + client.0 * io.scale(), y as f64 + client.1 * io.scale())
}

#[derive(Debug)]
struct Press { last: (f64, f64), movement: f64 }

#[derive(Debug, PartialEq)]
pub enum ReleaseOutcome {
    Toggle(TogglePlan),
    Cancelled,
}

impl ReleaseOutcome {
    /// Island gestures no longer produce placements to persist.
    pub fn saved_position(&self) -> Option<(i32, i32)> { None }
}

#[derive(Debug, PartialEq)]
pub enum TogglePlan {
    Expand { size: (i32, i32), rect: Rect, edge: Edge },
    Collapse { size: (i32, i32), rect: Rect, edge: Edge },
}
impl TogglePlan {
    pub fn size(&self) -> (i32, i32) {
        match self { Self::Expand { size, .. } | Self::Collapse { size, .. } => *size }
    }
    pub fn rect(&self) -> Rect {
        match self { Self::Expand { rect, .. } | Self::Collapse { rect, .. } => *rect }
    }
    pub fn edge(&self) -> Edge { Edge::Top }
    pub fn is_expand(&self) -> bool { matches!(self, Self::Expand { .. }) }
}

#[derive(Debug, PartialEq)]
pub struct ViewPlan {
    pub chat: bool,
    pub size: (i32, i32),
    pub rect: Rect,
    /// Compatibility read-back: the stage is always the fixed window too.
    pub stage: Rect,
    pub visible: (i32, i32),
    pub edge: Edge,
}

#[derive(Debug, Default)]
pub struct Core {
    pub edge: Edge,
    pub expanded: bool,
    pub chat: bool,
    press: Option<Press>,
    chat_height: i32,
}
impl Core {
    pub fn new() -> Self { Self::default() }
    pub fn press(&mut self, io: &dyn WindowIo, client: (f64, f64)) {
        self.press = Some(Press { last: screen_at(io, client), movement: 0.0 });
    }
    pub fn press_active(&self) -> bool { self.press.is_some() }
    /// Track travel only. The character's independent host owns desktop dragging.
    pub fn drag(&mut self, io: &dyn WindowIo, _area: Rect, client: (f64, f64)) -> Option<(i32, i32)> {
        let press = self.press.as_mut()?;
        let next = screen_at(io, client);
        press.movement += (next.0 - press.last.0).hypot(next.1 - press.last.1);
        press.last = next;
        None
    }
    pub fn release(&mut self, io: &dyn WindowIo, area: Rect, client: (f64, f64), cancelled: bool) -> ReleaseOutcome {
        let Some(press) = self.press.take() else { return ReleaseOutcome::Cancelled };
        let next = screen_at(io, client);
        let movement = press.movement + (next.0 - press.last.0).hypot(next.1 - press.last.1);
        // Pointer releases only open the compact bar. Collapse remains an
        // explicit/non-press action, even for stale or direct IPC callers.
        if self.expanded || cancelled || !geometry::is_click(movement, geometry::CLICK_THRESHOLD_PX) {
            return ReleaseOutcome::Cancelled;
        }
        ReleaseOutcome::Toggle(self.toggle(io, area))
    }
    pub fn toggle(&mut self, io: &dyn WindowIo, area: Rect) -> TogglePlan {
        let rect = geometry::island_window_rect(area, io.scale());
        let size = (rect.w, rect.h);
        self.edge = Edge::Top;
        self.expanded = !self.expanded;
        self.chat = false;
        if self.expanded { TogglePlan::Expand { size, rect, edge: Edge::Top } }
        else { TogglePlan::Collapse { size, rect, edge: Edge::Top } }
    }
    pub fn plan_view(&mut self, io: &dyn WindowIo, area: Rect, chat: bool) -> Option<ViewPlan> {
        if !self.expanded || self.chat == chat { return None; }
        let visible = if chat {
            self.chat_height = geometry::clamp_chat_height(self.chat_height(), area.h, io.scale());
            geometry::chat_visible_for(area.h, io.scale(), self.chat_height)
        } else { geometry::OVERVIEW_VISIBLE };
        self.chat = chat;
        Some(self.view_plan(io, area, visible))
    }
    pub fn chat_height(&self) -> i32 {
        self.chat_height.clamp(geometry::CHAT_MIN_H, geometry::CHAT_MAX_H)
    }
    pub fn plan_chat_height(&mut self, io: &dyn WindowIo, area: Rect, desired: i32) -> Option<ViewPlan> {
        if !self.expanded || !self.chat { return None; }
        let height = geometry::clamp_chat_height(desired, area.h, io.scale());
        if height == self.chat_height() { return None; }
        self.chat_height = height;
        Some(self.view_plan(io, area, (geometry::CHAT_COLUMN_W, height)))
    }
    fn view_plan(&self, io: &dyn WindowIo, area: Rect, visible: (i32, i32)) -> ViewPlan {
        let rect = geometry::island_window_rect(area, io.scale());
        ViewPlan { chat: self.chat, size: (rect.w, rect.h), rect, stage: rect, visible, edge: Edge::Top }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    fn area() -> Rect { Rect { x: 0, y: 32, w: 1920, h: 1048 } }
    struct FakeIo { pos: Cell<(i32, i32)>, size: Cell<(i32, i32)>, scale: f64 }
    impl FakeIo {
        fn compact_top() -> Self {
            Self { pos: Cell::new((624, 32)), size: Cell::new(geometry::ISLAND_WINDOW), scale: 1.0 }
        }
        fn apply(&self, plan: &TogglePlan) {
            self.size.set(plan.size()); self.pos.set((plan.rect().x, plan.rect().y));
        }
    }
    impl WindowIo for FakeIo {
        fn outer_position(&self) -> (i32, i32) { self.pos.get() }
        fn size(&self) -> (i32, i32) { self.size.get() }
        fn scale(&self) -> f64 { self.scale }
        fn set_outer_position(&self, x: i32, y: i32) { self.pos.set((x, y)); }
    }
    fn expanded_top() -> (Core, FakeIo) {
        let io = FakeIo::compact_top(); let mut core = Core::new(); io.apply(&core.toggle(&io, area())); (core, io)
    }
    #[test]
    fn every_view_plan_keeps_the_fixed_window_and_chat_reports_are_idempotent() {
        for scale in [1.0, 1.25, 2.0] {
            let mut io = FakeIo::compact_top(); io.scale = scale;
            let rect = geometry::island_window_rect(area(), scale);
            io.pos.set((rect.x, rect.y)); io.size.set((rect.w, rect.h));
            let mut core = Core::new();
            assert_eq!(core.toggle(&io, area()).rect(), rect);
            let chat = core.plan_view(&io, area(), true).unwrap();
            assert_eq!((chat.rect, chat.stage, chat.size), (rect, rect, (rect.w, rect.h)));
            assert!(core.plan_chat_height(&io, area(), 240).is_none());
            let grown = core.plan_chat_height(&io, area(), 300).unwrap();
            assert_eq!((grown.rect, grown.stage, grown.size), (rect, rect, (rect.w, rect.h)));
            assert!(core.plan_chat_height(&io, area(), i32::MAX).is_none());
            assert_eq!(core.plan_view(&io, area(), false).unwrap().rect, rect);
            assert_eq!(core.toggle(&io, area()).rect(), rect);
        }
    }
    #[test]
    fn dragging_the_island_never_moves_it_or_produces_a_saved_position() {
        for expanded in [false, true] {
            let io = FakeIo::compact_top(); let mut core = Core::new(); core.expanded = expanded;
            let original = io.outer_position(); core.press(&io, (20.0, 16.0));
            assert_eq!(core.drag(&io, area(), (200.0, 800.0)), None);
            let released = core.release(&io, area(), (200.0, 800.0), false);
            assert_eq!(released, ReleaseOutcome::Cancelled); assert_eq!(released.saved_position(), None);
            assert_eq!(io.outer_position(), original); assert_eq!(core.expanded, expanded);
        }
    }
    #[test]
    fn an_expanded_press_never_toggles_even_without_a_question_or_movement() {
        let (mut core, io) = expanded_top();
        core.plan_view(&io, area(), true).unwrap();
        core.press(&io, (20.0, 16.0));
        assert_eq!(core.release(&io, area(), (20.0, 16.0), false), ReleaseOutcome::Cancelled);
        assert!(core.expanded && core.chat);
        assert!(!core.press_active());
    }

    #[test]
    fn drag_without_press_is_ignored() {
        assert_eq!(Core::new().drag(&FakeIo::compact_top(), area(), (10.0, 10.0)), None);
    }
    #[test]
    fn short_click_toggles_to_overview_anchored_at_top() {
        let io = FakeIo::compact_top(); let mut core = Core::new();
        core.press(&io, (50.0, 20.0)); core.drag(&io, area(), (53.0, 20.0));
        let ReleaseOutcome::Toggle(plan) = core.release(&io, area(), (53.0, 20.0), false) else { panic!("short click"); };
        assert!(plan.is_expand()); assert_eq!(plan.rect(), geometry::island_window_rect(area(), 1.0));
        assert!(core.expanded); assert_eq!(core.edge, Edge::Top);
    }
    #[test]
    fn cancelled_release_never_toggles() {
        let io = FakeIo::compact_top(); let mut core = Core::new(); core.press(&io, (50.0, 20.0));
        core.drag(&io, area(), (53.0, 20.0));
        assert_eq!(core.release(&io, area(), (53.0, 20.0), true), ReleaseOutcome::Cancelled);
        assert!(!core.expanded); assert!(!core.press_active());
    }
    #[test]
    fn press_without_movement_and_cancelled_is_cancelled() {
        let io = FakeIo::compact_top(); let mut core = Core::new(); core.press(&io, (50.0, 20.0));
        assert_eq!(core.release(&io, area(), (50.0, 20.0), true), ReleaseOutcome::Cancelled);
        assert!(!core.expanded);
    }
    #[test]
    fn press_without_release_state_is_kept_for_the_next_move() {
        let io = FakeIo::compact_top(); let mut core = Core::new(); core.press(&io, (50.0, 20.0));
        assert!(core.press_active()); assert_eq!(core.drag(&io, area(), (50.0, 60.0)), None);
        assert!(core.press_active()); assert!(!core.expanded);
    }
    #[test]
    fn chat_view_needs_the_overview_first() {
        let mut core = Core::new(); assert_eq!(core.plan_view(&FakeIo::compact_top(), area(), true), None); assert!(!core.chat);
    }
    #[test]
    fn overview_to_chat_becomes_the_column_and_back() {
        let (mut core, io) = expanded_top(); let open = core.plan_view(&io, area(), true).unwrap();
        assert!(open.chat && core.expanded); assert_eq!(open.visible, (720, 240));
        assert_eq!(core.plan_view(&io, area(), true), None);
        let back = core.plan_view(&io, area(), false).unwrap(); assert!(!back.chat);
        assert_eq!(back.visible, (720, 150)); assert_eq!(back.rect, open.rect);
    }
    #[test]
    fn the_chat_fits_the_work_area_height() {
        for h in [1048, 768, 560, 300] {
            let a = Rect { h, ..area() }; let (mut core, io) = expanded_top();
            let plan = core.plan_view(&io, a, true).unwrap(); assert!(plan.rect.bottom() <= a.bottom());
        }
    }
    #[test]
    fn the_chat_height_grows_with_what_the_page_reports_and_only_inside_the_chat() {
        let (mut core, io) = expanded_top(); assert_eq!(core.plan_chat_height(&io, area(), 280), None);
        assert_eq!(core.plan_view(&io, area(), true).unwrap().visible.1, 240);
        assert_eq!(core.plan_chat_height(&io, area(), 280).unwrap().visible.1, 280);
        assert_eq!(core.plan_chat_height(&io, area(), 280), None);
        assert_eq!(core.plan_chat_height(&io, area(), 9999).unwrap().visible.1, 300);
        assert_eq!(core.plan_chat_height(&io, area(), 300), None);
        assert_eq!(core.plan_chat_height(&io, area(), -1).unwrap().visible.1, 240);
    }
    #[test]
    fn the_wanted_height_survives_a_view_switch_and_a_short_screen_still_wins() {
        let (mut core, io) = expanded_top(); core.plan_view(&io, area(), true).unwrap();
        core.plan_chat_height(&io, area(), 300).unwrap(); core.plan_view(&io, area(), false).unwrap();
        assert_eq!(core.plan_view(&io, area(), true).unwrap().visible.1, 300);
        core.plan_view(&io, area(), false).unwrap();
        let short = Rect { h: 320, ..area() };
        let plan = core.plan_view(&io, short, true).unwrap(); assert_eq!(plan.visible.1, 264);
        assert!(plan.rect.bottom() <= short.bottom());
    }
    #[test]
    fn collapsing_from_chat_lands_compact_and_forgets_the_chat_view() {
        let (mut core, io) = expanded_top(); core.plan_view(&io, area(), true).unwrap();
        let collapse = core.toggle(&io, area()); assert!(!collapse.is_expand()); assert!(!core.chat && !core.expanded);
        io.apply(&collapse); assert!(core.toggle(&io, area()).is_expand()); assert!(!core.chat);
    }
    #[test]
    fn release_threshold_counts_travel_and_the_final_segment() {
        for (moves, end) in [(vec![], (26.0, 16.0)), (vec![(24.0, 16.0)], (20.0, 16.0)), (vec![], (f64::NAN, 16.0))] {
            let io = FakeIo::compact_top(); let mut core = Core::new(); core.press(&io, (20.0, 16.0));
            for at in moves { core.drag(&io, area(), at); }
            assert_eq!(core.release(&io, area(), end, false), ReleaseOutcome::Cancelled);
        }
    }
}

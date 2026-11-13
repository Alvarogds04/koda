'use strict';
/* isla-cualquier-lado T5b + T6b, the wiring the pure tests cannot see: ONE rule decides where the native window stands, the folded
   island follows the same edge as the open card (so a toast above the disc is inside the window and takes clicks), one drop decides
   the spot, the stored edge and the page's data-edge together, and the drop-spot arithmetic uses the card height the page DRAWS.
   The behaviour is pinned by the Rust unit tests (geometry::tests, core::tests, islandshape::corners) and the real layout by
   question-toast-center-check; this check pins that the shipped wiring is the tested one.
   Run: node test-node/island-drop-edge-check.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const geometry = fs.readFileSync(path.join(__dirname, '../src/geometry.rs'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../src/main.rs'), 'utf8');
const shape = fs.readFileSync(path.join(__dirname, '../src/islandshape.rs'), 'utf8');
const core = fs.readFileSync(path.join(__dirname, '../src/core.rs'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../frontend/island.js'), 'utf8');
const between = (text, from, to) => {
  const a = text.indexOf(from), b = text.indexOf(to, a + from.length);
  return a < 0 ? '' : b < 0 ? text.slice(a) : text.slice(a, b);
};

test('T6b: the folded window stands on the disc in the lower half, from the same growth rule as the open card', () => {
  const placed = between(geometry, 'pub fn island_window_rect_placed(', 'pub fn island_window_rect_where(');
  assert.match(placed, /let edge = growth_edge_at\(placed\.origin\.1, area, scale\);/, 'the placement reads the one growth edge');
  assert.match(placed, /if edge == Edge::Bottom \{ kept\.bottom\(\) - h \} else \{ kept\.y \}/,
    'the kept box — the card column or the folded disc — stands on the window bottom in the lower half');
  // the folded and the open branch share the placement: the folded one only supplies the kept DISC box
  assert.match(placed, /\} else \{ \(disc, area, placed\.origin\.1\) \}/, 'the folded branch supplies the kept disc box only');
  // the folded release reads the DISC back for the edge the window was laid out with, never the window's top-left
  const drop = between(geometry, 'pub fn drop_spot(', '/// The growth edge of the island');
  assert.match(drop, /\} else \{ disc_origin_y\(window, edge, scale\) \};/, 'folded: the spot is the disc, read back for its edge');
  // core reads the disc through the same function, folded or open
  const growth = between(core, 'fn growth_edge(&self', '///');
  assert.match(growth, /geometry::disc_origin_y\(Rect \{ x, y, w, h \}, self\.edge, io\.scale\(\)\)/, 'core reads the disc, not the window top');
});

test('T6b: the click region and the page stand on the edge the placement used, folded or open', () => {
  assert.match(shape, /pub\(crate\) fn anchor_bottom\(state: &crate::AppState\) -> bool \{[\s\S]{0,170}core\.edge == (?:abito|koda)_island::geometry::Edge::Bottom/,
    'anchor_bottom follows the edge for the folded disc too');
  assert.doesNotMatch(shape, /core\.expanded && core\.edge == (?:abito|koda)_island::geometry::Edge::Bottom/, 'the folded disc is not pinned to the window top');
  const rects = between(shape, 'pub(crate) fn input_rects_anchored(', '/// The height of the box the page DRAWS');
  assert.match(rects, /let \(x, y, w, h\) = anchored\(input_rect\(report, window, protected\), window, bottom\);/, 'the whole box moves with the anchor');
  assert.doesNotMatch(rects, /bottom && !\(report\.settled && compact && report\.h <=/, 'a settled disc is not excluded from the anchor');
  assert.match(source, /const anchorBottom = edge === 'bottom';/, 'the page puts the whole island on the edge Rust placed it on');
  assert.doesNotMatch(source, /anchorBottom = edge === 'bottom' && target === 1/, 'the folded disc is not pinned to the capsule top');
});

test('T5b R3-drop-card-height: the drop spot uses the height the page DRAWS, not a guess', () => {
  assert.match(geometry, /pub fn visible_card_height\(reported: Option<i32>, chat: bool, chat_height: i32\) -> i32 \{/,
    'one pure rule for the card height');
  assert.match(geometry, /Some\(h\) if h > COMPACT_DOT\.1 => h/, 'a real card report wins (150 mail, 240 chat, a taller take-over)');
  const end = between(main, 'fn island_move_end(', 'fn open_chat_url');
  assert.match(end, /geometry::visible_card_height\(reported, core\.chat, core\.chat_height\(\)\)/, 'island_move_end asks that rule');
  assert.doesNotMatch(end, /core\.chat_height\(\) \} else \{ geometry::OVERVIEW_VISIBLE\.1 \}/, 'the old 150 guess is gone');
  assert.match(shape, /pub\(crate\) fn last_visible_height\(\) -> Option<i32>/, 'the page report is the source');
  assert.match(shape, /fn report_height\(state: &\(\(i32, i32\), Report\)\) -> Option<i32>/, 'and only a settled card report counts');
  // the shape lock is never taken under the core lock (islandshape::apply takes SHAPE, then the core)
  const readAt = end.indexOf('islandshape::last_visible_height()'), lockAt = end.indexOf('state.core.lock()');
  assert.ok(readAt > 0 && readAt < lockAt, 'the page report is read BEFORE the core lock');
});

test('T5b R3-drop-edge-ordering: one read of the final spot decides the spot, the edge and the page', () => {
  const end = between(main, 'fn island_move_end(', 'fn open_chat_url');
  assert.match(end, /let \(spot, edge\) = geometry::drop_spot\(Rect \{ x, y, w, h \}, expanded, edge, card_h, area, io\.scale\(\)\)/,
    'the drop returns the spot and the edge it derives from that same spot');
  assert.doesNotMatch(end, /let \(spot, _\) = geometry::drop_spot/, 'the edge the placement derives is never dropped');
  let last = -1;
  for (const step of [
    'state.core.lock().expect("core lock").edge = edge',
    'settingshost::save_island_position(&app, spot)',
    'let safe = ensure_island_window(&app)',
    'push_phase(&app, "compact", edge)',
  ]) {
    const at = end.indexOf(step);
    assert.ok(at > last, `island_move_end applies «${step}» after the step before it`);
    last = at;
  }
  assert.doesNotMatch(end, /state\.core\.lock\(\)\.expect\("core lock"\)\.edge = geometry::growth_edge_at/,
    'the edge is never recomputed after the save');
  // a folded drop that crosses the midpoint moves the disc's window: the page must be told, not only when the island is open
  assert.match(end, /push_phase\(&app, "overview", edge\)[\s\S]{0,120}push_phase\(&app, "compact", edge\)/,
    'the page follows the new edge folded and open');
});

test('T6b: a restored lower-half island tells the page its edge as soon as the page runs', () => {
  assert.match(main, /\.on_page_load\(\|webview, _payload\| \{[\s\S]{0,1000}push_phase\(webview\.app_handle\(\)/,
    'on_page_load pushes the phase with the stored edge');
  assert.match(main, /if webview\.label\(\) == "main" \{[\s\S]{0,300}push_phase\(webview\.app_handle\(\)/, 'main window only');
  assert.doesNotMatch(main, /ensure_island_window has cached the chosen work area already\.\s*\n\s*state\.core\.lock\(\)\.expect\("core lock"\)\.edge = Edge::Top;/,
    'the restored edge is not overwritten with Top');
  const ensure = between(main, 'fn ensure_island_window(', 'fn quit_clean(');
  assert.match(ensure, /let edge = geometry::growth_edge_at\(placed\.origin\.1, area, io\.scale\(\)\);/, 'the placement edge is read once');
  assert.match(ensure, /push_phase\(app, if expanded \{ "overview" \} else \{ "compact" \}, edge\)/,
    'a monitor, work-area or scale change that flips the edge tells the page');
});

console.log('PASS island-drop-edge: one edge rule for the folded and open island, one drop, the page drawn height');

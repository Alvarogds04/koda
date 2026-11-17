'use strict';
/* compact-anywhere T2 (S4/S5), the host wiring the pure tests cannot see. The folded window stays inside the work area and the DISC
   shifts inside it (geometry::compact_disc_shift / folded_drag_x, pinned by geometry::tests). This check pins that the shipped host
   uses them: one shift is kept, the drag moves the disc on past the edge, the release saves the VIRTUAL window left (window + shift,
   or the disc snaps back), and the page learns the shift.
   Run: node test-node/island-disc-shift-check.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '../src/main.rs'), 'utf8');
const between = (text, from, to) => {
  const a = text.indexOf(from), b = text.indexOf(to, a + from.length);
  return a < 0 ? '' : b < 0 ? text.slice(a) : text.slice(a, b);
};

test('T2: the host keeps one disc shift, physical for the drag and logical for the page and the click region', () => {
  const state = between(main, 'struct AppState {', '\n}\n');
  assert.match(state, /disc_shift_px: AtomicI32,/, 'physical shift');
  assert.match(state, /disc_shift: AtomicI32,/, 'logical shift');
  const setter = between(main, 'fn set_disc_shift(', '\n}\n');
  assert.match(setter, /geometry::logical_shift\(/, 'the logical value comes from the one conversion');
  assert.match(setter, /push_shift\(/, 'a changed shift is pushed to the page');
});

test('T2: placing the folded island computes the shift from the same placement', () => {
  const ensure = between(main, 'fn ensure_island_window(', '\n}\n');
  assert.match(ensure, /geometry::compact_disc_shift\(/, 'the placement shift');
  assert.match(ensure, /set_disc_shift\(/, 'is kept and published');
  assert.match(ensure, /if !dragging \{[\s\S]{0,700}set_disc_shift/, 'mid-drag the drag owns the shift');
});

test('T2: the drag moves the disc on past the edge and the release saves the virtual window left', () => {
  const begin = between(main, 'fn island_move_begin(', '\n}\n');
  assert.match(begin, /disc_shift_px\.load/, 'the drag starts from the virtual window (window + shift)');
  const moving = between(main, 'fn island_move(', '\n}\n');
  assert.match(moving, /geometry::folded_drag_x\(/, 'folded, the window stops at the edge and the disc goes on');
  assert.match(moving, /set_disc_shift\(/, 'and the page follows mid-drag');
  const end = between(main, 'fn island_move_end(', '\n}\n');
  assert.match(end, /disc_shift_px\.load/, 'the release reads the shift');
  assert.match(end, /geometry::drop_spot\(Rect \{ x: x \+ shift, y, w, h \}/, 'and saves the virtual window left');
});

test('T2: a page that (re)loads learns the current shift', () => {
  const load = between(main, '.on_page_load(', '.on_window_event(');
  assert.match(load, /push_shift\(/);
});

test('T6: the page gets the disc and the card offsets in EVERY phase, so opening and folding grow out of the disc', () => {
  const state = between(main, 'struct AppState {', '\n}\n');
  assert.match(state, /card_shift: AtomicI32,/, 'the card offset is kept next to the disc offset');
  const ensure = between(main, 'fn ensure_island_window(', '\n}\n');
  assert.match(ensure, /geometry::island_shift_pair\(/, 'both offsets come from the one placement rule');
  assert.doesNotMatch(ensure, /island_open[\s\S]{0,120}set_disc_shift|expanded[\s\S]{0,60}\(0, 0\)/, 'the open island is NOT given zero offsets: the disc is still where it was');
  assert.match(ensure, /placed\.map_or\(\(0, 0\), \|placed\| geometry::island_shift_pair\(placed,/, 'only a island with no saved spot (top centre) has none');
  const setter = between(main, 'fn set_disc_shift(', '\n}\n');
  assert.match(setter, /card_shift/, 'a change of either offset reaches the page');
  const push = between(main, 'fn push_shift(', '\n}\n');
  assert.match(push, /__islandSetShift\(\{disc\},\s*\{card\}\)/, 'the page gets both numbers');
  const moving = between(main, 'fn island_move(', '\n}\n');
  assert.match(moving, /geometry::island_shift_pair\(/, 'mid-drag the page follows both offsets too');
});

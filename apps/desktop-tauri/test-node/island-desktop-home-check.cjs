'use strict';
/* isla-cualquier-lado T6c (S1, S5): the desktop pet flies to the ISLAND'S VISIBLE TOP, never to the top of its transparent native
   window. Since T5 (open card) and T6b (folded disc) the island stands on the window's BOTTOM edge in the lower half, so a pet aimed
   at `window.y` landed ~308 px above the disc. The arithmetic is geometry::visible_top (one rule, the same one geometry::disc_origin_y
   is one case of) and characterhost::island_origin asks the core for the edge and the height of what is actually drawn.
   Run: node test-node/island-desktop-home-check.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const slice = (text, from, to) => {
  const a = text.indexOf(from);
  if (a < 0) return '';
  const b = text.indexOf(to, a + from.length);
  return b < 0 ? text.slice(a) : text.slice(a, b);
};

test('T6c: one pure rule for the visible top, and the folded disc is one case of it', () => {
  const geo = read('src/geometry.rs');
  assert.match(geo, /pub fn visible_top\(window: Rect, edge: Edge, visible_h: i32\) -> i32 \{/, 'geometry::visible_top is the one rule');
  const disc = slice(geo, 'pub fn disc_origin_y(', 'pub fn island_rect_placed(') || slice(geo, 'pub fn disc_origin_y(', '#[cfg(test)]');
  assert.match(disc, /visible_top\(window, edge, scaled_height\(COMPACT_DOT\.1, scale\)\)/,
    'the folded disc reads through the same rule instead of a second one');
  assert.match(geo, /pub fn scaled_height\(h: i32, scale: f64\) -> i32 \{/, 'logical visible height -> physical px');
});

test('T6c: characterhost aims the pet at the visible top of the disc or the card, never at the window top', () => {
  const host = read('src/characterhost.rs');
  const origin = slice(host, 'fn island_origin(', 'fn apply_shape(');
  assert.ok(origin.length > 0, 'island_origin still exists');
  assert.match(origin, /geometry::visible_top\(/, 'the pet asks the pure rule for the top');
  // the edge is read from the core, like every other island placement
  const core = slice(origin, 'core.lock()', 'geometry::visible_top(');
  assert.match(core, /core\.edge/, 'the edge comes from the core');
  assert.match(core, /core\.expanded/, 'folded or open decides what is visible');
  // the height is the one the page DRAWS: the disc folded, the card open
  assert.match(origin, /geometry::visible_card_height\(reported, chat, chat_height\)/, 'the open card uses the drawn height');
  assert.match(origin, /geometry::COMPACT_DOT\.1/, 'folded: the disc');
  assert.match(origin, /islandshape::last_visible_height\(\)/, 'the report is the source of that height');
  const reportedAt = origin.indexOf('islandshape::last_visible_height()'), lockAt = origin.indexOf('core.lock()');
  assert.ok(reportedAt > 0 && reportedAt < lockAt, 'the shape report is read BEFORE the core lock (SHAPE -> core order)');
  assert.doesNotMatch(origin, /island_spot\(r\.x \+ r\.w \/ 2\.0, r\.y,/, 'never the transparent window top again');
});

test('T6c: island_spot says what it centres under, and the stored position is the disc spot', () => {
  const win = read('src/characterwin.rs');
  const spot = slice(win, '/// Window top-left when the character sits', 'pub fn ease_in_out(');
  assert.match(spot, /centred under the island's VISIBLE top edge/, 'island_spot documents the visible top it is given');
  // T5b/T6c doc drift: the saved position is the disc's spot, not the window's top-left (the value is identical for every file
  // written before T6b, so this is comments only, no format change)
  const settings = read('src/settingshost.rs');
  assert.match(settings, /disc'?s spot/, 'settingshost::island_position says which spot is stored');
  assert.doesNotMatch(slice(settings, 'pub fn island_position(', 'pub fn save_island_position('), /window top-left/i, 'not the window top-left');
  const prefs = read('src/prefs.rs');
  assert.match(prefs, /disc'?s spot/, 'prefs::POSITION says which spot is stored');
});

console.log('PASS island-desktop-home: the pet flies to the visible top of the disc or the card');

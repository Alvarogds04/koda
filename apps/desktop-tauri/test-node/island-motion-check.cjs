'use strict';
/* #493 (human L38: «no lo noto fluido como lo es coucou») — step A, the quick wins in the island's own animation loop.
   Pure parts run for real (overview-view.js springStep); the loop's wiring is pinned at source level. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const O = require(path.join(frontend, 'overview-view.js'));
const read = f => fs.readFileSync(path.join(frontend, f), 'utf8');
let failed = 0;
const test = (n, f) => { try { f(); console.log('PASS ' + n); } catch (e) { failed++; console.error('FAIL ' + n + ': ' + e.message); } };

const W0 = 2 * Math.PI / 0.5, ZETA = 0.72;
const run = (frameDt, seconds, from = 0, target = 1) => {
  let s = { p: from, v: 0 };
  for (let t = 0; t < seconds; t += frameDt) s = O.springStep(s.p, s.v, target, frameDt, W0, ZETA);
  return s;
};

test('springStep: Coucou\'s Spring (anim.ts) — a frame is advanced in 1/240 s sub-steps and a frame longer than 50 ms counts as 50 ms', () => {
  assert.equal(typeof O.springStep, 'function');
  assert.equal(O.SPRING_MAX_DT, 0.05); assert.equal(O.SPRING_SUBSTEP, 1 / 240);
  // one 16.7 ms frame = 4 sub-steps; a 40 ms frame = 10; a 1 s stall is clamped to 50 ms = 12
  assert.equal(O.springSubsteps(1 / 60), 4); assert.equal(O.springSubsteps(0.04), 10); assert.equal(O.springSubsteps(1), 12);
  assert.equal(O.springSubsteps(1 / 144), 2, 'a 6.9 ms frame is spent in two 3.5 ms steps (never a longer one, never an extra millisecond)');
  assert.equal(O.springSubsteps(0), 0); assert.equal(O.springSubsteps(-1), 0); assert.equal(O.springSubsteps(NaN), 0);
});

test('springStep converges to the target and overshoots a little (damping .72), at any frame rate', () => {
  for (const dt of [1 / 144, 1 / 60, 1 / 30, 1 / 20]) {
    const end = run(dt, 2);
    assert.ok(Math.abs(end.p - 1) < 1e-3, `dt ${dt}: p ${end.p}`);
  }
  let peak = 0, s = { p: 0, v: 0 };
  for (let i = 0; i < 240; i++) { s = O.springStep(s.p, s.v, 1, 1 / 60, W0, ZETA); peak = Math.max(peak, s.p); }
  assert.ok(peak > 1.01 && peak < 1.08, `overshoot ${peak}: the spring that Abito's contract describes (~1.5-4 %)`);
});

test('frame-rate independence: after the same wall time a 60 Hz, a 30 Hz and a 144 Hz loop are at the same place (the old 1/30 clamp with one big step was not)', () => {
  const at = dt => run(dt, 0.3).p;
  const ref = at(1 / 240);
  for (const dt of [1 / 144, 1 / 60, 1 / 30]) assert.ok(Math.abs(at(dt) - ref) < 0.01, `dt ${dt}: ${at(dt)} vs ${ref}`);
});

test('a stalled frame (the tab was busy for 400 ms) never explodes: the step is bounded and finite, and keeps moving toward the target', () => {
  const s = O.springStep(0, 0, 1, 0.4, W0, ZETA);
  assert.ok(Number.isFinite(s.p) && Number.isFinite(s.v)); assert.ok(s.p > 0 && s.p < 1);
  assert.deepEqual(O.springStep(0.3, 0.2, 1, 0, W0, ZETA), { p: 0.3, v: 0.2 }, 'no time = no movement');
});

test('island.js uses it for both springs (the island and the chat channel) instead of its own explicit-Euler single step', () => {
  const src = read('island.js');
  assert.equal((src.match(/O\.springStep\(/g) || []).length, 2);
  assert.doesNotMatch(src, /Math\.min\(1 \/ 30,/, 'the 1/30 cap is gone');
  assert.doesNotMatch(src, /const a = -2 \* ZETA \* W0/, 'no hand-rolled step left in the loop');
});

test('#island does not promote layout properties: no will-change: width, height (it cannot be composited and it keeps a layer alive)', () => {
  const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /will-change:\s*[^;}]*\b(width|height|left|top)\b/);
  const isl = read('vendor/coucou/island/island.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(isl, /#island[^{]*\{[^}]*will-change:\s*[^;}]*\b(width|height)\b/);
});

test('render() writes the island and the character only when a value changed (a constant viewBox is not rewritten 60 times a second)', () => {
  const src = read('island.js');
  assert.match(src, /const put = \(el, key, value\) =>/, 'one memoised writer');
  assert.match(src, /put\(clayEl, 'viewBox', /);
  assert.doesNotMatch(src, /clayEl\.setAttribute\('viewBox', BASE_VB\.map/, 'no unconditional viewBox write in render');
});

// ---- T3: the controller can HOLD an explicit pose for a transient surface (the Sileo toast) -----------------------------------
test('character controller hold(): shows exactly the held pose, ignores sleep/greeting decorations, releases back to the producer, stops on destroy', () => {
  const { clock } = require('./character-harness.cjs');
  const C = require(path.join(frontend, 'character-motion.js')), clk = clock(), applied = [];
  const clay = { state: 'idle', setState(s) { this.state = s; applied.push(s); }, cancelReaction() {}, greet() { applied.push('GREET'); return true; }, triggerEmote() { applied.push('EMOTE'); return true; } };
  const c = C.create({ clay, choosePose: () => 'idle', validCard: () => false, notification: () => null, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, blocked: () => true });
  c.hold('finished'); assert.equal(clay.state, 'finished', 'held even when blocked (static pose under reduced motion)');
  clk.advance(C.SLEEP_MS * 3); assert.equal(clay.state, 'finished', 'never falls asleep while held');
  c.hold('question'); assert.equal(clay.state, 'question');
  c.hold('not-a-pose-with space'); assert.equal(clay.state, 'question', 'an invalid name keeps the previous pose');
  c.hold(null); assert.equal(clay.state, 'idle', 'released: the normal producer decides again');
  assert.ok(!applied.includes('GREET') && !applied.includes('EMOTE'), 'a held pose triggers no decoration');
  c.hold('error'); c.destroy(); const n = applied.length; clk.advance(C.SLEEP_MS * 3); assert.equal(applied.length, n); assert.equal(clk.count(), 0, 'no timer left after destroy');
});
if (failed) process.exit(1);

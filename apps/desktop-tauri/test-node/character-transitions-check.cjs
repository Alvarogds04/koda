'use strict';
// Human report: "entre animaciones hay movimientos raros". Switching state or cutting an emote
// must not move the body by more than a steady frame of motion in a single 60 fps frame.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { engine } = require('./character-harness.cjs');

// A pop is 1.5-4 px in one frame (measured before the fix: up to 2.24 px on a state change, 4.06 px on
// a cut emote). The exponential pose blend legitimately starts at ~0.7 px/frame between far poses, and
// a state may move faster on its own (speech changes syllable abruptly, ~1.1 px/frame), so a switch is
// allowed what either of its two states already does by itself. The blend between the two farthest
// poses (approval <-> sleeping) starts at ~0.9 px/frame, so the cap sits just above that and well
// below every real pop.
const JUMP_CAP_PX = 1.0;
const nums = d => (d.match(/-?\d+\.?\d*/g) || []).map(Number);
const maxd = (a, b) => { let m = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const make = state => { const h = engine(); h.api.setManual(true); return { api: h.api, inst: h.api.create(h.svg, { seed: 7, state }) }; };
const body = inst => nums(inst.sample().d);

function intrinsic(state) { // fastest per-frame body motion the state produces by itself over 10 s
  const { inst } = make(state); inst.step(240);
  let prev = body(inst), mx = 0;
  for (let k = 0; k < 600; k++) { inst.step(1); const b = body(inst); mx = Math.max(mx, maxd(prev, b)); prev = b; }
  return mx;
}

test('switching state never pops the body by more than the jump cap in one frame', () => {
  const { api } = make('idle');
  const states = Object.keys(api.STATES);
  const own = Object.fromEntries(states.map(s => [s, intrinsic(s)]));
  const worst = [];
  for (const from of states) for (const to of states) {
    if (from === to) continue;
    const { inst } = make(from); inst.step(240);
    const before = body(inst);
    inst.setState(to); inst.step(1);
    const jump = maxd(before, body(inst)), cap = Math.max(JUMP_CAP_PX, 1.1 * own[from], 1.1 * own[to]);
    if (jump > cap) worst.push(`${from}->${to}: ${jump.toFixed(2)}px > ${cap.toFixed(2)}`);
  }
  assert.deepEqual(worst, [], `state switches that pop: ${worst.slice(0, 6).join(', ')}`);
});

test('cutting an emote mid-envelope fades it out instead of snapping it off', () => {
  const { api } = make('idle');
  const bad = [];
  for (const name of api.EMOTES) {
    const { inst } = make('idle'); inst.step(240);
    assert.ok(inst.triggerEmote(name), name);
    inst.step(20);
    const before = body(inst);
    inst.cancelReaction(); inst.step(1);
    assert.equal(inst.reaction, null, 'the reaction is reported cancelled at once');
    const jump = maxd(before, body(inst));
    if (jump > JUMP_CAP_PX) bad.push(`${name}: ${jump.toFixed(2)}px`);
  }
  assert.deepEqual(bad, [], `emote cuts that pop: ${bad.join(', ')}`);
});

test('after the fade-out no trace of a cancelled emote is left on the body', () => {
  for (const name of make('idle').api.EMOTES) {
    const a = make('idle'), b = make('idle');
    a.inst.step(240); b.inst.step(240);
    assert.ok(a.inst.triggerEmote(name), name);
    a.inst.step(20); b.inst.step(20);
    a.inst.cancelReaction();
    a.inst.step(90); b.inst.step(90); // 1.5 s later
    assert.ok(maxd(body(a.inst), body(b.inst)) < 0.01, `${name} left a residue`);
  }
});

test('under reduced motion a state change still lands on its exact static pose, with no fading leftover', () => {
  const reduced = engine(true);
  const inst = reduced.api.create(reduced.svg, { seed: 7, state: 'idle' });
  inst.setState('error');
  const h2 = engine(true);
  const direct = h2.api.create(h2.svg, { seed: 7, state: 'error' });
  assert.equal(inst.state, 'error');
  assert.ok(maxd(body(inst), body(direct)) < 0.01, 'static pose equals a fresh instance in that state');
  assert.equal(inst.S.knead, direct.S.knead);
  assert.equal(inst.S.ghost, null);
});

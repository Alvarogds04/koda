'use strict';
// T9.2/S13: actual engine, actual scheduled frames/geometry; no preview or preferences involved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { engine } = require('./character-harness.cjs');
const advance = (h, n = 12) => { for (let i = 0; i < n; i++) h.frame(); };

for (const type of ['error', 'unhandledrejection']) {
  test(`S13 unrelated global ${type} stays diagnostic and does not stop real clay frames`, () => {
    const h = engine(), clay = h.api.create(h.svg);
    advance(h); const before = clay.sample(), frames = h.api.frames;
    let prevented = false;
    h.emitWindow(type, { error: new Error('unrelated component failed'), reason: new Error('unrelated component failed'), preventDefault() { prevented = true; } });
    advance(h);
    assert.equal(h.api.error, null, 'global event is not evidence of an engine-frame failure');
    assert.ok(h.api.frames > frames, 'the real shared frame clock advances');
    assert.ok(clay.sample().t > before.t);
    assert.notEqual(clay.sample().d, before.d, 'real SVG contour keeps moving');
    assert.equal(h.api.externalError, 'unrelated component failed');
    assert.equal(prevented, false, 'browser error reporting is never suppressed');
    assert.equal(h.api.statusKind()[0], 'animating');
  });
}

test('S13 actual engine-owned render failure still halts the shared loop and retains its cause', () => {
  const h = engine(), clay = h.api.create(h.svg);
  advance(h);
  const body = h.svg.children.find(n => Object.hasOwn(n.attrs, 'data-abito-body'));
  assert.ok(body, 'actual engine body path');
  body.setAttribute = () => { throw new Error('owned SVG write failed'); };
  h.frame();
  assert.equal(h.api.error, 'owned SVG write failed');
  assert.equal(h.api.statusKind()[0], 'error');
  assert.equal(h.pending(), 0);
  const frames = h.api.frames, time = clay.sample().t;
  h.emitWindow('error', { message: 'later unrelated error' });
  advance(h);
  assert.equal(h.api.frames, frames); assert.equal(clay.sample().t, time);
  assert.equal(h.api.error, 'owned SVG write failed', 'a global event cannot overwrite the engine cause');
});

test('S13 scheduled geometry still respects reduced motion, explicit force, pause and visibility', () => {
  const h = engine(), clay = h.api.create(h.svg);
  advance(h); const moving = clay.sample();
  h.os(true); const reduced = clay.sample(); advance(h);
  assert.equal(h.api.statusKind()[0], 'reduced'); assert.equal(h.pending(), 0);
  assert.equal(clay.sample().d, reduced.d); assert.equal(clay.sample().t, reduced.t);
  h.api.setForced(true); advance(h);
  assert.ok(clay.sample().t > moving.t); assert.notEqual(clay.sample().d, reduced.d);
  h.api.setPaused(true); const paused = clay.sample(); advance(h);
  assert.equal(clay.sample().t, paused.t); assert.equal(h.pending(), 0);
  h.api.setPaused(false); h.hide(true); const hidden = clay.sample(); advance(h);
  assert.equal(clay.sample().t, hidden.t); assert.equal(h.pending(), 0);
  h.hide(false); advance(h);
  assert.ok(clay.sample().t > hidden.t); assert.notEqual(clay.sample().d, hidden.d);
  assert.equal(h.api.error, null);
});

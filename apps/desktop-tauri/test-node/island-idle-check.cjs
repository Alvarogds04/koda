'use strict';
/* S31: the EXPANDED island (any view, pinned or not) folds to the compact pill after 30 s with no interaction. Pure rule + fake-clock timer. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let I; try { I = require('../frontend/island-idle.js'); } catch (e) { console.error('FAIL island-idle.js missing:', e.message); process.exit(1); }
function clock() {
  let t = 0, id = 0; const timers = new Map();
  return { now: () => t, schedule: (fn, ms) => { timers.set(++id, { at: t + ms, fn }); return id; }, cancel: i => timers.delete(i),
    advance(ms) { const end = t + ms; for (;;) { const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; t = due[1].at; timers.delete(due[0]); due[1].fn(); } t = end; } };
}
const make = (over = {}) => { const c = clock(); const calls = []; const idle = I.create({ now: c.now, schedule: c.schedule, cancel: c.cancel, collapse: () => { calls.push(c.now()); return Promise.resolve(); }, ...over }); return { c, idle, calls }; };
let passed = 0; const test = (n, fn) => { fn(); passed += 1; };

test('the rule: only an expanded island past 30 s collapses; a focused field with the pointer over the island never does', () => {
  assert.equal(I.IDLE_MS, 30000);
  const f = (o = {}) => ({ expanded: true, idleMs: 30000, fieldFocus: false, inside: false, ...o });
  assert.equal(I.shouldCollapse(f()), true);
  assert.equal(I.shouldCollapse(f({ idleMs: 29999 })), false);
  assert.equal(I.shouldCollapse(f({ expanded: false })), false);
  assert.equal(I.shouldCollapse(f({ fieldFocus: true, inside: true })), false, 'typing area focused AND pointer over: stays');
  assert.equal(I.shouldCollapse(f({ fieldFocus: true, inside: false })), true, 'focus alone (pointer gone) does not keep it open');
  assert.equal(I.shouldCollapse(f({ inside: true })), false, 'the pointer over the island is interaction');
  assert.equal(I.shouldCollapse(null), false);
});
test('timer: 29 s stays, 30 s collapses', () => {
  const { c, idle, calls } = make(); idle.setExpanded(true);
  c.advance(29000); assert.deepEqual(calls, []);
  c.advance(1000); assert.deepEqual(calls, [30000]);
});
test('an interaction at 20 s resets the 30 s', () => {
  const { c, idle, calls } = make(); idle.setExpanded(true);
  c.advance(20000); idle.touch(); c.advance(29999); assert.deepEqual(calls, []);
  c.advance(1); assert.deepEqual(calls, [50000]);
});
test('folded or stopped: no timer, no call; expanding again restarts the clock', () => {
  const { c, idle, calls } = make(); idle.setExpanded(true); c.advance(10000); idle.setExpanded(false); c.advance(60000); assert.deepEqual(calls, []);
  idle.setExpanded(true); c.advance(29999); assert.deepEqual(calls, []); c.advance(1); assert.equal(calls.length, 1);
  const s = make(); s.idle.setExpanded(true); s.idle.stop(); s.c.advance(60000); assert.deepEqual(s.calls, []);
});
test('pointer inside keeps it open and the 30 s counts from when it leaves; field focus + inside blocks, field focus alone does not', () => {
  const { c, idle, calls } = make(); idle.setExpanded(true);
  idle.setInside(true); c.advance(90000); assert.deepEqual(calls, [], 'a pointer parked on the island is interaction');
  idle.setInside(false); c.advance(29999); assert.deepEqual(calls, []); c.advance(1); assert.equal(calls.length, 1);
  const k = make(); k.idle.setExpanded(true); k.idle.setFieldFocus(true); k.idle.setInside(true); k.c.advance(120000); assert.deepEqual(k.calls, []);
  k.idle.setInside(false); k.c.advance(30000); assert.equal(k.calls.length, 1, 'focus alone: folds');
});
test('a refused collapse (a pending question the host protects) retries after another full 30 s, never in a loop', () => {
  const c = clock(); const calls = []; const idle = I.create({ now: c.now, schedule: c.schedule, cancel: c.cancel, collapse: () => { calls.push(c.now()); return Promise.reject(new Error('pendiente')); } });
  idle.setExpanded(true); c.advance(30000); assert.deepEqual(calls, [30000]);
  return Promise.resolve().then(() => { c.advance(29999); assert.deepEqual(calls, [30000]); c.advance(1); assert.deepEqual(calls, [30000, 60000]); });
});
test('wiring: loaded before island.js, packaged, listens to real interaction only (trusted events), never reads or clears a draft', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  const tags = [...html.matchAll(/<script defer src="([^"]+)"/g)].map(m => m[1]);
  assert.equal(tags.filter(f => f === 'island-idle.js').length, 1); assert.ok(tags.indexOf('island-idle.js') < tags.indexOf('island.js'));
  assert.match(fs.readFileSync(path.join(__dirname, '../packaging/lib.cjs'), 'utf8'), /'island-idle\.js'/);
  const isl = fs.readFileSync(path.join(__dirname, '../frontend/island.js'), 'utf8');
  assert.match(isl, /AbitoIslandIdle\??\.create\(/); assert.match(isl, /isTrusted/);
  const src = fs.readFileSync(path.join(__dirname, '../frontend/island-idle.js'), 'utf8');
  assert.doesNotMatch(src, /localStorage|\.value\s*=|draft/i, 'the module never touches a draft');
});
Promise.resolve().then(() => console.log(`island-idle-check: ${passed} checks ok`));

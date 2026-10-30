'use strict';
/* HU-070: the 16 unused Koda animations get a real moment. One test per trigger (input → animation through the public brain),
   priority state > transition/reaction > ambient life, bounded movement, reduced motion. */
const assert = require('node:assert/strict');
const K = require('../frontend/koda-logic.js'), C = require('../frontend/koda-catalog.js');
let passed = 0; const test = (n, fn) => { fn(); passed += 1; };
const base = { pose: 'idle', reaction: null, phase: 'compact', hidden: false, view: 'overview', noticeView: null, noticeAttention: false, noticeError: false,
  engineBad: false, running: false, composerFocused: false, pointerOver: false, progress: null, reduced: false };
function make(seed = 0) { let t = 1000; const b = K.createBrain({ now: () => t, rand: () => seed });
  return { b, adv(ms) { t += ms; }, at: () => t, step(o = {}) { return b.step({ ...base, ...o }); } }; }
const fresh = o => make().step(o);

test('S1 muy-feliz: a run of >= 2 min that ends with no errors celebrates, then the state mapping resumes', () => {
  const m = make(); m.step({ running: true }); m.adv(121000); m.step({ running: true });
  assert.equal(m.step({ running: false }), 'muy-feliz');
  m.adv(3200); assert.equal(m.step({ running: false }), 'respirar');
});
test('S1 muy-feliz: not for a short run, nor for a run that had an error', () => {
  let m = make(); m.step({ running: true }); m.adv(60000); m.step({ running: true });
  assert.notEqual(m.step({ running: false }), 'muy-feliz');
  m = make(); m.step({ running: true }); m.adv(30000); m.step({ running: true, engineBad: true }); m.adv(100000); m.step({ running: true });
  assert.notEqual(m.step({ running: false }), 'muy-feliz');
});
test('S2 saltar: progress reaching N of N jumps once', () => {
  const m = make(); m.step({ progress: { done: 3, total: 5 } });
  assert.equal(m.step({ progress: { done: 5, total: 5 } }), 'saltar');
  m.adv(1600); assert.notEqual(m.step({ progress: { done: 5, total: 5 } }), 'saltar');
  m.adv(100); const m2 = make(); m2.step({ progress: { done: 4, total: 5 } }); assert.notEqual(m2.step({ progress: { done: 4, total: 5 } }), 'saltar');
});
test('S3 curioso: a plain notice entering with the island open → curioso, then «terminó»', () => {
  const m = make(); m.step({ phase: 'open' }); m.adv(2000); m.step({ phase: 'open' });
  assert.equal(m.step({ phase: 'open', noticeView: 'notices' }), 'curioso');
  m.adv(1300); assert.equal(m.step({ phase: 'open', noticeView: 'notices' }), 'termino');
});
test('S3 curioso: not with the island closed', () => {
  const m = make(); m.step(); assert.notEqual(m.step({ noticeView: 'notices' }), 'curioso');
});
test('S4 asustado: the engine dropping startles, then error', () => {
  const m = make(); m.step();
  assert.equal(m.step({ engineBad: true }), 'asustado');
  m.adv(1500); assert.equal(m.step({ engineBad: true }), 'error');
});
test('S5 ronronear on hover, amasar on click; both yield to a working state', () => {
  const m = make(); m.step();
  assert.equal(m.step({ pointerOver: true }), 'ronronear');
  m.b.click(); assert.equal(m.step({ pointerOver: true }), 'amasar');
  m.adv(2100); assert.equal(m.step({ pointerOver: true }), 'ronronear');
  assert.equal(m.step({ pointerOver: false }), 'respirar');
  assert.equal(fresh({ pointerOver: true, running: true }), 'trabaja');
  const w = make(); w.step({ running: true }); w.b.click(); assert.equal(w.step({ running: true }), 'trabaja');
});
test('S6 travesura: after 20 s of calm with no agent, once a minute at most', () => {
  const m = make(); m.step(); m.adv(21000);
  const a = m.step(); assert.ok(['jugueton', 'perseguir-cola'].includes(a), a);
  m.adv(3000); assert.notEqual(['jugueton', 'perseguir-cola'].includes(m.step()), true);
  const r = make(); r.step({ running: true }); r.adv(21000); assert.equal(r.step({ running: true }), 'trabaja');
  const q = make(); q.step(); q.adv(19000); assert.notEqual(['jugueton', 'perseguir-cola'].includes(q.step()), true);
});
test('S6 travesura: a second one waits a full minute', () => {
  const m = make(); m.step(); m.adv(21000); m.step(); m.adv(3000);
  let seen = 0; for (let i = 0; i < 40; i++) { m.adv(500); m.b.poke(); m.adv(21000); if (['jugueton', 'perseguir-cola'].includes(m.step())) seen++; }
  assert.ok(seen <= 14, 'rate limited: ' + seen);
});
test('S7 variety: awake rest also stretches, licks and sits, never sleeping rows', () => {
  const seen = new Set();
  for (const seed of [0, .15, .3, .45, .6, .75, .9]) { const m = make(seed); m.step(); for (let i = 0; i < 25; i++) { m.adv(1000); seen.add(m.step()); } }
  for (const a of ['estirarse', 'lamerse', 'sentarse']) assert.ok(seen.has(a), a + ' appears: ' + [...seen].join());
  assert.ok(!seen.has('dormir'));
});
test('S8 ovillo between somnoliento and dormir', () => {
  const m = make(); m.step(); m.adv(30500); m.step(); m.adv(2000); assert.equal(m.step(), 'somnoliento');
  m.adv(9000); assert.equal(m.step(), 'ovillo');
  m.adv(4000); assert.equal(m.step(), 'dormir');
});
test('S9 correr then saludar when the island opens; caminar when the tab changes', () => {
  const m = make(); m.step(); m.adv(100);
  assert.equal(m.step({ phase: 'open' }), 'correr');
  m.adv(900); assert.equal(m.step({ phase: 'open' }), 'saludar');
  m.adv(1500); m.step({ phase: 'open' }); m.adv(100);
  assert.equal(m.step({ phase: 'open', view: 'chat' }), 'caminar');
  m.adv(1100); assert.notEqual(m.step({ phase: 'open', view: 'chat' }), 'caminar');
});
test('S10 desaparecer when the island closes, then aparecer in the compact pill', () => {
  const m = make(); m.step({ phase: 'open' }); m.adv(5000); m.step({ phase: 'open' });
  assert.equal(m.step({ phase: 'compact' }), 'desaparecer');
  m.adv(900); assert.equal(m.step({ phase: 'compact' }), 'aparecer');
  m.adv(1000); assert.equal(m.step({ phase: 'compact' }), 'respirar');
});
test('S11 attention and error states are never covered by the new animations', () => {
  for (const o of [{ pose: 'question' }, { pose: 'approval' }, { engineBad: true }, { pose: 'error' }, { noticeView: 'notices', noticeAttention: true }, { noticeView: 'notices', noticeError: true }]) {
    const want = fresh(o);
    for (const extra of [{ pointerOver: true }, { phase: 'open' }]) {
      const m = make(); m.step(o); m.b.click(); m.adv(21000);
      const got = m.step({ ...o, ...extra });
      assert.ok(got === want || got === 'asustado', JSON.stringify(o) + JSON.stringify(extra) + ' → ' + got);
    }
  }
  const m = make(); m.step({ phase: 'open' }); m.step({ phase: 'open', noticeView: 'notices', noticeAttention: true });
  assert.equal(m.step({ phase: 'open', noticeView: 'notices', noticeAttention: true }), 'espera');
});
test('S11 existing mapping still holds (trabaja, espera, error, termino, escucha, piensa)', () => {
  assert.equal(fresh({ running: true }), 'trabaja'); assert.equal(fresh({ pose: 'question' }), 'espera');
  assert.equal(fresh({ noticeView: 'notices' }), 'termino'); assert.equal(fresh({ pose: 'think' }), 'piensa');
  assert.equal(fresh({ view: 'chat', composerFocused: true }), 'escucha');
});
test('S9 movement: bounded inside the island, zero when settled, zero with reduced motion', () => {
  for (const id of ['caminar', 'correr']) {
    for (let t = 0; t <= 1500; t += 50) {
      const x = K.moveOffset(id, t, false, 40); assert.ok(Math.abs(x) <= 40, id + t);
      assert.equal(K.moveOffset(id, t, true, 40), 0);
    }
    assert.equal(K.moveOffset(id, 5000, false, 40), 0, 'ends in place');
    assert.equal(K.moveOffset(id, 100, false, 0), 0, 'no room → no move');
  }
  assert.equal(K.moveOffset('respirar', 100, false, 40), 0);
});
test('S12 reduced motion: no chained or ambient animations, only the state', () => {
  const R = { reduced: true };
  const m = make(); m.step(R); m.adv(100);
  assert.notEqual(m.step({ ...R, phase: 'open' }), 'correr');
  m.adv(30000); const seen = new Set(); for (let i = 0; i < 40; i++) { m.adv(1000); seen.add(m.step({ ...R, phase: 'open', pointerOver: true })); }
  for (const a of ['jugueton', 'perseguir-cola', 'estirarse', 'lamerse', 'sentarse', 'ovillo', 'ronronear', 'caminar', 'correr', 'asustado', 'muy-feliz', 'saltar', 'curioso']) assert.ok(!seen.has(a), a);
  const e = make(); e.step(R); assert.equal(e.step({ ...R, engineBad: true }), 'error');
});
test('catalog: every animation this story uses exists', () => {
  for (const a of ['muy-feliz', 'saltar', 'curioso', 'asustado', 'ronronear', 'amasar', 'jugueton', 'perseguir-cola', 'estirarse', 'lamerse', 'sentarse', 'ovillo', 'caminar', 'correr', 'desaparecer']) assert.ok(C.CATALOG[a], a);
});
// ---- HU-070 review follow-ups (RDD review-ceb5a2aba1bc4355) ----
test('R3 muy-feliz: a long run that ENDS with a failure never celebrates (error at the very step the run stops)', () => {
  for (const fail of [{ engineBad: true }, { pose: 'error' }, { noticeView: 'notices', noticeError: true }]) {
    const m = make(); m.step({ running: true }); m.adv(121000); m.step({ running: true });
    const got = m.step({ running: false, ...fail });
    assert.notEqual(got, 'muy-feliz', JSON.stringify(fail)); m.adv(200);
    assert.notEqual(m.step({ running: false, ...fail }), 'muy-feliz', JSON.stringify(fail));
    m.adv(200); assert.notEqual(m.step({ running: false }), 'muy-feliz', 'recovered right after: still no celebration');
  }
});
test('R3 saltar: only on the focused session transitioning to N of N, not on re-render or a focus change to a finished session', () => {
  const p = (id, done, total) => ({ id, done, total });
  let m = make(); m.step({ progress: p('a', 4, 5) });
  assert.equal(m.step({ progress: p('a', 5, 5) }), 'saltar');
  m.adv(1700); m.step({ progress: p('a', 5, 5) }); m.adv(100);
  assert.notEqual(m.step({ progress: p('a', 5, 5) }), 'saltar', 're-render of the same finished session');
  m = make(); m.step({ progress: p('a', 3, 5) });
  assert.notEqual(m.step({ progress: p('b', 5, 5) }), 'saltar', 'focus moved to an already-finished session');
  m = make(); m.step({ progress: null });
  assert.notEqual(m.step({ progress: p('b', 5, 5) }), 'saltar', 'a session that appears already complete');
});
test('R3 mover: layout is measured once per walk/run, the transform is rewritten only when it changes, nothing with reduced motion', () => {
  let measures = 0; const mv = K.createMover(); const room = () => { measures++; return 40; };
  const out = []; for (let t = 0; t <= 1000; t += 16) { const css = mv.update('correr', t, false, room); if (css !== null) out.push(css); }
  assert.equal(measures, 1, 'one layout read for the whole run');
  assert.ok(out.length > 1 && out.length <= 1000 / 16 + 1);
  assert.equal(new Set(out).size, out.length, 'only changed values are written');
  assert.equal(out[out.length - 1], '', 'settled: transform cleared');
  assert.equal(mv.update('correr', 2000, false, room), null, 'nothing to write once settled');
  assert.equal(mv.update('respirar', 2100, false, room), null); assert.equal(measures, 1, 'a non-moving animation never measures');
  const r = K.createMover(); let rm = 0; assert.equal(r.update('caminar', 100, true, () => { rm++; return 40; }), null); assert.equal(rm, 0);
  const again = K.createMover(); again.update('caminar', 0, false, room); again.update('respirar', 1, false, room); again.update('caminar', 0, false, room); assert.equal(measures, 3, 'a new walk measures again');
});
console.log(`koda-anim-check: ${passed} tests passed`);

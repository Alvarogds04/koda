'use strict';
/* HU-056 (C1, C2): Koda's pure rules. State → animation, awake idle, 30 s yawn / 45 s sleep, integer-scale sheets, reduced motion. */
const assert = require('node:assert/strict');
let K, C;
try { K = require('../frontend/koda-logic.js'); C = require('../frontend/koda-catalog.js'); } catch (e) { console.error('FAIL koda modules missing:', e.message); process.exit(1); }
let passed = 0; const test = (n, fn) => { fn(); passed += 1; };
const base = { pose: 'idle', reaction: null, phase: 'compact', hidden: false, view: 'overview', noticeView: null, noticeAttention: false, engineBad: false, running: false, composerFocused: false };
function make(seed = 0) { let t = 1000; const b = K.createBrain({ now: () => t, rand: () => seed }); return { b, at: () => t, adv(ms) { t += ms; }, step(o = {}) { return b.step({ ...base, ...o }); } }; }

test('catalog: 42 animations, every id a row of the 32 px sheet; the 24 px sheet only holds the seven Abito states', () => {
  assert.equal(Object.keys(C.CATALOG).length, 42);
  assert.deepEqual(C.SMALL, ['reposo', 'escucha', 'piensa', 'trabaja', 'espera', 'termino', 'error']);
  assert.equal(C.SHEETS[32].h, 42 * 32); assert.equal(C.SHEETS[24].h, 7 * 24);
  for (const a of Object.values(C.CATALOG)) for (const f of a.sequence) assert.ok(f < a.frames);
});

test('C1: calm compact idle is AWAKE (respirar), never the sleeping «reposo» sheet row', () => {
  const m = make(); assert.equal(m.step(), 'respirar');
  m.adv(10000); assert.notEqual(m.step(), 'reposo'); assert.notEqual(m.step(), 'dormir');
});
test('C1: idle blinks / flicks an ear / waves the tail now and then, then returns to breathing', () => {
  const m = make(0); m.step(); const seen = new Set();
  for (let i = 0; i < 25; i++) { m.adv(1000); seen.add(m.step()); }
  assert.ok(seen.has('parpadear') || seen.has('tic-oreja') || seen.has('cola'), [...seen].join());
  assert.ok(seen.has('respirar'));
  for (const a of seen) assert.ok(['respirar', 'parpadear', 'tic-oreja', 'cola', 'estirarse', 'lamerse', 'sentarse', 'jugueton', 'perseguir-cola'].includes(a), a); // HU-070 widened the awake variety; still never a sleeping row
});

test('C2: app states map to Koda animations', () => {
  const m = { step: o => make().step(o) };
  assert.equal(m.step({ running: true }), 'trabaja');
  assert.equal(m.step({ pose: 'question' }), 'espera');
  assert.equal(m.step({ pose: 'approval' }), 'espera');
  assert.equal(m.step({ noticeView: 'notices', noticeAttention: true }), 'espera');
  assert.equal(m.step({ noticeView: 'notices' }), 'termino');
  assert.equal(m.step({ noticeView: 'notices', noticeError: true }), 'error');
  assert.equal(m.step({ noticeView: 'notices', noticeError: true, noticeAttention: true }), 'error');
  assert.equal(m.step({ noticeView: 'notices', noticeError: false }), 'termino');
  assert.equal(m.step({ noticeView: 'notices', noticeError: undefined, noticeAttention: true }), 'espera');
  assert.equal(m.step({ noticeView: null, noticeError: true }), 'respirar');
  assert.equal(m.step({ engineBad: true }), 'error');
  assert.equal(m.step({ pose: 'error' }), 'error');
  assert.equal(m.step({ view: 'chat', composerFocused: true }), 'escucha');
  assert.equal(m.step({ pose: 'think' }), 'piensa');
  assert.equal(m.step({ pose: 'speak' }), 'piensa');
  assert.equal(m.step({ pose: 'reject' }), 'triste');
  assert.equal(m.step({ pose: 'ratelimit' }), 'aburrido');
  assert.equal(m.step({ pose: 'dizzy' }), 'confundido');
});
test('C2: needing the user outranks decoration (engine down beats running; question beats running)', () => {
  const m = { step: o => make().step(o) };
  assert.equal(m.step({ engineBad: true, running: true }), 'error');
  assert.equal(m.step({ pose: 'question', running: true }), 'espera');
});
test('HU-075: the «Recibida» confirm pose is happy even while a greeting reaction runs (an explicit confirm outranks a decorative emote)', () => {
  const m = { step: o => make().step(o) };
  assert.equal(m.step({ pose: 'confirm', reaction: 'greeting', phase: 'open' }), 'feliz');
  assert.equal(m.step({ pose: 'confirm' }), 'feliz');
  const g = make(); g.step({ phase: 'compact' }); g.adv(100); assert.equal(g.step({ phase: 'open' }), 'correr'); assert.equal(g.step({ phase: 'open', pose: 'confirm' }), 'feliz'); // a running greeting beat does not hide it
  assert.equal(m.step({ pose: 'idle', reaction: 'greeting' }), 'saludar'); // a greeting alone still waves
  assert.equal(m.step({ pose: 'reject', reaction: 'greeting' }), 'saludar'); // problem poses keep their current animation
});
test('C2: Dot emotes map (greeting, yawn, love, surprised, proud, wink, happy, annoyed)', () => {
  const m = { step: o => make().step(o) }; const e = { greeting: 'saludar', yawn: 'bostezar', love: 'carinoso', surprised: 'sorprendido', proud: 'orgulloso', wink: 'timido', happy: 'feliz', annoyed: 'enojado' };
  for (const [r, a] of Object.entries(e)) assert.equal(m.step({ reaction: r }), a, r);
});
test('C2: beats — opening the island greets, answering/recovering is happy, hiding/appearing at the edge', () => {
  let m = make(); m.step(); m.adv(100);
  assert.equal(m.step({ phase: 'open' }), 'correr'); m.adv(900); assert.equal(m.step({ phase: 'open' }), 'saludar'); m.adv(1500); assert.notEqual(m.step({ phase: 'open' }), 'saludar'); // HU-070: run in, then wave
  const r = make(); r.step({ reduced: true }); r.adv(100); assert.equal(r.step({ phase: 'open', reduced: true }), 'saludar'); // reduced motion: straight to the wave
  m = make(); m.step({ view: 'chat', pose: 'think' }); m.adv(100);
  assert.equal(m.step({ view: 'chat', pose: 'idle' }), 'feliz'); m.adv(2700); assert.notEqual(m.step({ view: 'chat' }), 'feliz');
  m = make(); m.step({ engineBad: true }); m.adv(100); assert.equal(m.step(), 'feliz');
  m = make(); m.step(); m.adv(100); assert.equal(m.step({ hidden: true }), 'esconderse'); m.adv(1200);
  m.step({ hidden: true }); m.adv(100); assert.equal(m.step({ hidden: false }), 'asomarse');
});

test('C2: 30 s without activity → yawn; 45 s → asleep; never earlier; the Dot sleeping early does NOT put Koda to sleep', () => {
  assert.equal(K.YAWN_MS, 30000); assert.equal(K.SLEEP_MS, 45000);
  const m = make(); m.step(); m.adv(29000); assert.notEqual(m.step({ pose: 'sleeping' }), 'dormir');
  assert.notEqual(m.step({ pose: 'sleeping' }), 'bostezar');
  m.adv(1500); assert.equal(m.step({ pose: 'sleeping' }), 'bostezar');
  m.adv(1500); assert.equal(m.step({ pose: 'sleeping' }), 'somnoliento');
  m.adv(14000); assert.equal(m.step({ pose: 'sleeping' }), 'dormir');
});
test('C2: the same clock without the Dot sleeping (pose idle) also yawns at 30 s and sleeps at 45 s', () => {
  const m = make(); m.step(); m.adv(30500); assert.equal(m.step(), 'bostezar'); m.adv(15000); assert.equal(m.step(), 'dormir');
});
test('C2: activity (poke) wakes it: appears, then awake idle; the clock restarts', () => {
  const m = make(); m.step(); m.adv(46000); assert.equal(m.step(), 'dormir');
  m.b.poke(); m.adv(50); assert.equal(m.step(), 'aparecer'); m.adv(1000); assert.equal(m.step(), 'respirar');
  m.adv(29000); assert.notEqual(m.step(), 'dormir');
});
test('C2: a running agent or pending question is activity: no yawn while it works', () => {
  const m = make(); m.step({ running: true }); m.adv(60000); assert.equal(m.step({ running: true }), 'trabaja');
});

test('sheets: integer scale only, 24 px sheet only for the Abito states and small boxes', () => {
  assert.deepEqual(K.layoutFor('espera', 'small', 28), { cell: 24, k: 1 });
  assert.deepEqual(K.layoutFor('respirar', 'small', 28), { cell: 32, k: 1 });
  assert.deepEqual(K.layoutFor('respirar', 'auto', 80), { cell: 32, k: 2 });
  assert.deepEqual(K.layoutFor('respirar', 'auto', 40), { cell: 32, k: 1 });
  for (const b of [10, 28, 55.9, 56, 90, 200]) assert.ok(Number.isInteger(K.layoutFor('respirar', 'auto', b).k));
});
test('frames: loops cycle the sequence at fps, one-shots hold their last frame, reduced motion shows frame 0', () => {
  const a = C.CATALOG.trabaja; // fps 8, sequence 0,0,1,1,2,2,3,3
  assert.equal(K.frameAt('trabaja', 0, false), 0);
  assert.equal(K.frameAt('trabaja', 2 * 125, false), 1);
  assert.equal(K.frameAt('trabaja', a.sequence.length * 125, false), 0);
  const s = C.CATALOG.parpadear; assert.equal(K.frameAt('parpadear', 60000, false), s.sequence[s.sequence.length - 1]);
  assert.equal(K.frameAt('trabaja', 700, true), a.sequence[0]);
  assert.equal(K.isDone('parpadear', 60000), true); assert.equal(K.isDone('trabaja', 60000), false);
});

console.log(`koda-logic-check: ${passed} tests passed`);

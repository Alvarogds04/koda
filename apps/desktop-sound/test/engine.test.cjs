'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHarness, createSoftContext, createFakeTime } = require('./support/soft-audio.cjs');
const AbitoSound = require('../sound-engine.js');

const IDS = ['snd.notice', 'snd.attention', 'snd.confirm', 'snd.reject', 'snd.error', 'snd.sent', 'snd.think', 'snd.reply', 'snd.listen', 'snd.expired', 'snd.open', 'snd.close', 'snd.peek', 'snd.hover', 'snd.pop', 'snd.tick', 'snd.love'];

test('samples replace notes with the same gain, gates and limiter; clearing restores synthesis', async () => {
  const time = createFakeTime();
  const c = createSoftContext();
  const samples = [];
  c.createBufferSource = () => {
    const n = { connect() {}, disconnect() {}, start(t) { this.startAt = t; }, stop() {} };
    samples.push(n); return n;
  };
  const e = AbitoSound.createSoundEngine({ enabled: false, coalesceMs: 0, now: time.now,
    setTimer: time.setTimer, clearTimer: time.clearTimer, createContext: () => c });
  const buffer = { duration: 0.4, getChannelData() {} };
  assert.equal(e.setSample('snd.notice', buffer), true);
  assert.equal(e.setSample('__proto__', buffer), false);
  assert.equal(e.setSample('snd.notice', { duration: NaN }), false);
  assert.equal((await e.play('snd.notice')).reason, 'disabled');
  assert.equal(samples.length, 0);
  e.ready(); e.setEnabled(true); e.setGain(0.1);
  e.quiet(100); assert.equal((await e.play('snd.notice')).reason, 'quiet'); time.advance(101);
  assert.equal((await e.play('snd.notice')).played, true);
  assert.equal(samples[0].buffer, buffer);
  assert.equal(c.oscillators.length, 0);
  assert.equal(c.gains[0].gain.events[0].v, 0.1 * AbitoSound.CUES['snd.notice'].level);
  assert.equal((await e.play('snd.notice')).reason, 'duplicate');
  assert.equal((await e.play('snd.error')).reason, 'rate_limited');
  e.setEnabled(false); assert.equal(samples[0].onended, null);
  e.setEnabled(true); e.clearSamples(); time.advance(3000);
  assert.equal((await e.play('snd.notice')).played, true);
  assert.equal(c.oscillators.length, 2);
  e.setSample('snd.notice', buffer); e.setSample('snd.notice', null); time.advance(3000);
  assert.equal((await e.play('snd.notice')).played, true);
  assert.equal(c.oscillators.length, 4);
  const hostile = { get duration() { throw Error('bad'); } };
  assert.doesNotThrow(() => e.setSample('snd.notice', hostile));
  e.close(); assert.equal(e.setSample('snd.notice', buffer), false);
});

test('samples obey outranking, inactive and three-voice limits', async () => {
  const time = createFakeTime(), c = createSoftContext(), played = [];
  c.createBufferSource = () => ({ connect() {}, disconnect() {}, stop() {}, start() { played.push(this.buffer); } });
  let active = false;
  const e = AbitoSound.createSoundEngine({ enabled: true, isActive: () => active, now: time.now,
    setTimer: time.setTimer, clearTimer: time.clearTimer, createContext: () => c });
  const buffer = { duration: 10, getChannelData() {} };
  for (const id of IDS) e.setSample(id, buffer);
  assert.equal((await e.play('snd.notice')).reason, 'not_ready'); e.ready();
  assert.equal((await e.play('snd.notice')).reason, 'inactive'); active = true;
  const low = e.play('snd.notice'), high = e.play('snd.error'); time.advance(30);
  assert.equal((await low).reason, 'outranked'); assert.equal((await high).played, true);
  for (const id of ['snd.attention', 'snd.confirm']) {
    time.advance(300); const p = e.play(id); time.advance(30); assert.equal((await p).played, true);
  }
  time.advance(300); const p = e.play('snd.reject'); time.advance(30);
  assert.equal((await p).reason, 'rate_limited'); assert.equal(played.length, 3);
  e.close();
});

test('catalog: 17 cues, frozen exports, closed reasons', () => {
  assert.deepEqual([...AbitoSound.CUE_IDS].sort(), [...IDS].sort());
  assert.ok(Object.isFrozen(AbitoSound) && Object.isFrozen(AbitoSound.CUES) && Object.isFrozen(AbitoSound.CUE_IDS));
  assert.ok(Object.isFrozen(AbitoSound.CUES['snd.notice']) && Object.isFrozen(AbitoSound.CUES['snd.notice'].notes) && Object.isFrozen(AbitoSound.CUES['snd.notice'].notes[0]));
  assert.ok(Object.isFrozen(AbitoSound.PRIORITY) && Object.isFrozen(AbitoSound.REASONS));
  assert.equal(AbitoSound.DEFAULT_GAIN, 0.12);
  assert.equal(AbitoSound.MAX_GAIN, 0.2);
  assert.deepEqual([...AbitoSound.REASONS], ['played', 'disabled', 'not_ready', 'quiet', 'inactive', 'unknown_cue', 'rate_limited', 'duplicate', 'outranked', 'no_audio', 'closed']);
  assert.throws(() => { AbitoSound.CUES['snd.notice'].level = 1; });
});

test('disabled: zero context creation and zero nodes for every cue', async () => {
  const h = makeHarness({ engine: { enabled: false } });
  for (const id of IDS) {
    const r = await h.settle(id);
    assert.deepEqual(r, { played: false, reason: 'disabled', id });
    h.time.advance(3000);
  }
  assert.equal(h.ctxs.length, 0);
  // default is also disabled
  let created = 0;
  const e = AbitoSound.createSoundEngine({ createContext: () => { created++; return createSoftContext(); } });
  e.ready();
  assert.equal((await e.play('snd.notice')).reason, 'disabled');
  assert.equal(created, 0);
});

test('unknown and prototype ids', async () => {
  const h = makeHarness();
  for (const id of ['nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', null, undefined, 5, {}, [], ['snd.notice']]) {
    const r = await h.settle(id);
    assert.equal(r.reason, 'unknown_cue');
    assert.equal(r.played, false);
    assert.equal(r.id, null);
  }
  assert.equal(h.ctxs.length, 0);
});

test('applyPrefs strict matrix', () => {
  const e = AbitoSound.createSoundEngine({});
  for (const p of [undefined, null, {}, { v: 1 }, { v: 1, sound: 'true' }, { v: 2, sound: true }, { v: 1, sound: 1 }, { v: '1', sound: true }, [], [{ v: 1, sound: true }], 'x', 7, true, { v: 1, sound: false }]) {
    assert.equal(e.applyPrefs(p), false, JSON.stringify(p));
    assert.equal(e.isEnabled(), false);
  }
  assert.equal(e.applyPrefs({ v: 1, sound: true }), true);
  assert.equal(e.isEnabled(), true);
  assert.equal(e.applyPrefs({ v: 1, sound: true, extra: 1 }), true);
  assert.equal(e.applyPrefs(null), false); // corrupt after valid => OFF again
  assert.equal(e.isEnabled(), false);
  assert.equal(e.applyPrefs(JSON.parse('{"v":1,"sound":true}')), true);
});

test('setEnabled is strict boolean', () => {
  const e = AbitoSound.createSoundEngine({});
  e.setEnabled(true); assert.equal(e.isEnabled(), true);
  for (const v of ['true', 1, {}, null, undefined, [], 'yes']) { e.setEnabled(true); e.setEnabled(v); assert.equal(e.isEnabled(), false); }
});

test('not ready / quiet / inactive silence, in order', async () => {
  const h = makeHarness({ ready: false });
  assert.equal((await h.settle('snd.notice')).reason, 'not_ready');
  assert.equal(h.ctxs.length, 0);
  h.engine.ready();
  h.engine.quiet(5000);
  assert.equal((await h.settle('snd.notice')).reason, 'quiet');
  h.time.advance(5001);
  let active = false;
  const h2 = makeHarness({ engine: { isActive: () => active } });
  assert.equal((await h2.settle('snd.notice')).reason, 'inactive');
  assert.equal(h2.ctxs.length, 0);
  active = true;
  assert.equal((await h2.settle('snd.notice')).reason, 'played');
  // quiet expires
  assert.equal((await h.settle('snd.error')).reason, 'played');
  // throwing isActive => inactive, never throws
  const h3 = makeHarness({ engine: { isActive: () => { throw new Error('x'); } } });
  assert.equal((await h3.settle('snd.notice')).reason, 'inactive');
});

test('quiet clamps and state() reports', () => {
  const t = createFakeTime(1000);
  const e = AbitoSound.createSoundEngine({ now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
  e.quiet(10 ** 9); assert.equal(e.state().quietUntil, 1000 + 60000);
  const e2 = AbitoSound.createSoundEngine({ now: t.now });
  e2.quiet(-5); e2.quiet(NaN); e2.quiet('x'); assert.ok(e2.state().quietUntil <= 1000);
  assert.deepEqual(Object.keys(e.state()).sort(), ['closed', 'enabled', 'gain', 'quietUntil', 'ready']);
});

test('check order: closed beats unknown beats disabled beats not_ready', async () => {
  const h = makeHarness({ ready: false, engine: { enabled: false } });
  assert.equal((await h.settle('zzz')).reason, 'unknown_cue');
  assert.equal((await h.settle('snd.notice')).reason, 'disabled');
  h.engine.setEnabled(true);
  assert.equal((await h.settle('snd.notice')).reason, 'not_ready');
  h.engine.close();
  assert.equal((await h.settle('zzz')).reason, 'closed');
});

test('transition semantics', async () => {
  const h = makeHarness();
  const { engine, time } = h;
  // first observation is only a baseline, even if already active
  assert.equal(engine.transition('model', true, 'snd.error'), undefined);
  time.advance(30);
  assert.equal(h.ctxs.length, 0);
  // persistent true: no sound
  assert.equal(engine.transition('model', true, 'snd.error'), undefined);
  // true -> false re-arms
  assert.equal(engine.transition('model', false, 'snd.error'), undefined);
  // false -> true plays once
  const p = engine.transition('model', true, 'snd.error');
  time.advance(30);
  assert.deepEqual(await p, { played: true, reason: 'played', id: 'snd.error' });
  assert.equal(engine.transition('model', true, 'snd.error'), undefined);
  // non-boolean active counts as false
  assert.equal(engine.transition('model', 'yes', 'snd.error'), undefined);
  const p2 = engine.transition('model', true, 'snd.error');
  time.advance(30);
  assert.equal((await p2).reason, 'duplicate'); // same cue within 2 s => dropped
  // baseline first-false: next true plays
  engine.transition('q', false, 'snd.attention');
  time.advance(3000);
  const p3 = engine.transition('q', true, 'snd.attention');
  time.advance(30);
  assert.equal((await p3).reason, 'played');
  // resetTransitions => next observation is a baseline again
  time.advance(3000);
  engine.resetTransitions();
  assert.equal(engine.transition('q', false, 'snd.attention'), undefined);
  assert.equal(engine.transition('z', true, 'snd.attention'), undefined);
  time.advance(30);
  // bad keys ignored
  for (const k of ['', 5, null, undefined, 'x'.repeat(65), {}]) assert.equal(engine.transition(k, true, 'snd.notice'), undefined);
  assert.equal(engine.transition('x'.repeat(64), false, 'snd.notice'), undefined);
});

test('transition map is bounded (oldest evicted => baseline again)', () => {
  const h = makeHarness();
  const { engine } = h;
  engine.transition('k0', false, 'snd.notice');
  for (let i = 1; i <= 256; i++) engine.transition('k' + i, false, 'snd.notice'); // evicts k0
  // k0 evicted: observing true is a fresh baseline, no sound
  assert.equal(engine.transition('k0', true, 'snd.notice'), undefined);
  assert.equal(h.ctxs.length, 0);
  // a recent key is still tracked: false->true plays
  const p = engine.transition('k256', true, 'snd.notice');
  assert.ok(p && typeof p.then === 'function');
  h.time.advance(30);
});

test('gain clamp and NaN', () => {
  const g = (v) => AbitoSound.createSoundEngine({ gain: v }).state().gain;
  assert.equal(g(undefined), 0.12);
  assert.equal(g(NaN), 0.12);
  assert.equal(g(Infinity), 0.12);
  assert.equal(g('0.1'), 0.12);
  assert.equal(g(null), 0.12);
  assert.equal(g(-1), 0);
  assert.equal(g(5), 0.2);
  assert.equal(g(0.05), 0.05);
  const e = AbitoSound.createSoundEngine({});
  e.setGain(0.5); assert.equal(e.state().gain, 0.2);
  e.setGain(-0.5); assert.equal(e.state().gain, 0);
  e.setGain(NaN); assert.equal(e.state().gain, 0.12);
});

test('gain 0 is silent without creating a context', async () => {
  const h = makeHarness({ engine: { gain: 0 } });
  assert.equal((await h.settle('snd.notice')).reason, 'disabled');
  assert.equal(h.ctxs.length, 0);
});

test('context lazily created once; failure => no_audio, retry only after 10 s', async () => {
  let calls = 0, fail = true;
  const h = makeHarness({ engine: { createContext: () => { calls++; if (fail) throw new Error('boom'); return createSoftContext(); } } });
  assert.equal(calls, 0);
  assert.deepEqual(await h.settle('snd.notice'), { played: false, reason: 'no_audio', id: 'snd.notice' });
  assert.equal(calls, 1);
  h.time.advance(5000);
  assert.equal((await h.settle('snd.error')).reason, 'no_audio');
  assert.equal(calls, 1, 'no retry inside 10 s');
  h.time.advance(6000);
  fail = false;
  assert.equal((await h.settle('snd.attention')).reason, 'played');
  assert.equal(calls, 2);
  h.time.advance(3000);
  assert.equal((await h.settle('snd.error')).reason, 'played');
  assert.equal(calls, 2, 'created once');
  // a factory returning garbage is also no_audio
  const h2 = makeHarness({ engine: { createContext: () => null } });
  assert.equal((await h2.settle('snd.notice')).reason, 'no_audio');
});

test('no AudioContext available at all => no_audio', async () => {
  const t = createFakeTime();
  const e = AbitoSound.createSoundEngine({ enabled: true, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
  e.ready();
  const p = e.play('snd.notice'); t.advance(30);
  assert.equal((await p).reason, 'no_audio');
});

test('suspended context is resumed (bounded) and still scheduled', async () => {
  const h = makeHarness({ ctx: { state: 'suspended' } });
  assert.equal((await h.settle('snd.notice')).reason, 'played');
  assert.equal(h.ctxs[0].resumeCalls, 1);
  assert.ok(h.ctxs[0].oscillators.length > 0);
  // resume never settles: bounded by the 250 ms timer
  const h2 = makeHarness({ ctx: { state: 'suspended', neverResume: true } });
  const p = h2.engine.play('snd.notice');
  h2.time.advance(30);
  h2.time.advance(300);
  assert.equal((await p).reason, 'played');
  assert.ok(h2.ctxs[0].oscillators.length > 0);
  // resume throwing
  const h3 = makeHarness({ ctx: { state: 'suspended' } });
  const c = createSoftContext({ state: 'suspended' }); c.resume = () => { throw new Error('x'); };
  const e3 = AbitoSound.createSoundEngine({ enabled: true, now: h3.time.now, setTimer: h3.time.setTimer, clearTimer: h3.time.clearTimer, createContext: () => c });
  e3.ready();
  const p3 = e3.play('snd.notice'); h3.time.advance(30);
  assert.equal((await p3).reason, 'played');
});

test('close(): stops everything, closes context, further play => closed', async () => {
  const h = makeHarness();
  assert.equal((await h.settle('snd.notice')).reason, 'played');
  h.time.advance(300);
  const pending = h.engine.play('snd.error'); // inside the coalesce window
  h.engine.close();
  assert.equal((await pending).reason, 'closed');
  assert.equal(h.ctxs[0].closeCalls, 1);
  assert.equal(h.engine.state().closed, true);
  assert.equal((await h.settle('snd.notice')).reason, 'closed');
  assert.equal(h.engine.transition('a', false, 'snd.notice'), undefined);
  h.engine.close(); // idempotent
  assert.equal(h.ctxs[0].closeCalls, 1);
});

test('disabling mid-burst drops the pending request; no sound later', async () => {
  const h = makeHarness();
  const p = h.engine.play('snd.error');
  h.engine.setEnabled(false);
  h.time.advance(30);
  assert.equal((await p).reason, 'disabled');
  h.time.advance(5000);
  assert.equal(h.ctxs.length, 0);
});

test('play never rejects nor throws even when the context throws at every call', async () => {
  const boom = () => { throw new Error('boom'); };
  const hostile = new Proxy({}, { get() { return boom; }, set() { throw new Error('set'); } });
  const h = makeHarness({ engine: { createContext: () => hostile } });
  for (const id of IDS) {
    const r = await h.settle(id);
    assert.equal(r.played, false);
    assert.ok(AbitoSound.REASONS.includes(r.reason));
    h.time.advance(11000);
  }
  // context whose nodes throw at start()
  const mk = () => { const c = createSoftContext(); const o = c.createOscillator.bind(c); c.createOscillator = () => { const n = o(); n.start = boom; return n; }; return c; };
  const h2 = makeHarness({ engine: { createContext: mk } });
  const r = await h2.settle('snd.notice');
  assert.equal(r.played, false); assert.equal(r.reason, 'no_audio');
  // hostile injections
  const h3 = makeHarness({ engine: { now: boom, setTimer: boom, clearTimer: boom } });
  assert.ok(h3.engine.play('snd.notice') instanceof Promise);
  await h3.engine.play('snd.notice');
  assert.doesNotThrow(() => { h3.engine.transition('a', true, 'snd.notice'); h3.engine.quiet(5); h3.engine.close(); });
});

test('diagnostics: closed-set strings only; throwing onDiagnostic is swallowed', async () => {
  const seen = [];
  const h = makeHarness({ engine: { createContext: () => { throw new Error('x'); }, onDiagnostic: (r) => seen.push(r), cues: { 'snd.notice': { level: 5 }, __proto__x: 1 } } });
  await h.settle('snd.notice');
  assert.ok(seen.length >= 2);
  for (const r of seen) assert.ok(AbitoSound.DIAGNOSTICS.includes(r), r);
  assert.ok(seen.includes('invalid_cue_override') && seen.includes('no_audio'));
  const h2 = makeHarness({ engine: { createContext: () => { throw new Error('x'); }, onDiagnostic: () => { throw new Error('diag'); }, cues: { 'snd.notice': { level: 5 } } } });
  assert.equal((await h2.settle('snd.notice')).reason, 'no_audio');
});

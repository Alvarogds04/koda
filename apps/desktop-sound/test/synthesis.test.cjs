'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHarness } = require('./support/soft-audio.cjs');
const AbitoSound = require('../sound-engine.js');
const { CUES, CUE_IDS, MAX_GAIN } = AbitoSound;

async function renderCue(id, engineOpts = {}, setGain) {
  const h = makeHarness({ engine: engineOpts });
  if (setGain !== undefined) h.engine.setGain(setGain);
  const r = await h.settle(id);
  assert.equal(r.reason, 'played', id);
  return { ...h.ctxs[0].render(44100), ctx: h.ctxs[0], h };
}

test('cue table shape and bounds', () => {
  for (const id of CUE_IDS) {
    const c = CUES[id];
    assert.equal(c.id, id);
    assert.ok(c.name && c.trigger);
    assert.ok(c.durationMs >= 80 && c.durationMs <= 600, id);
    assert.ok(c.level > 0 && c.level <= 1);
    assert.ok(c.notes.length >= 1 && c.notes.length <= 6);
    let end = 0;
    for (const n of c.notes) {
      assert.ok(n.f >= 40 && n.f <= 4000 && (n.f2 === undefined || (n.f2 >= 40 && n.f2 <= 4000)));
      assert.ok(n.dur >= 0.02 && n.dur <= 0.6);
      assert.ok(['sine', 'triangle'].includes(n.type));
      assert.ok(n.peak > 0 && n.peak <= 1);
      assert.ok(n.attack >= 0.005 && n.release >= 0.015 && n.attack + n.release <= n.dur + 1e-9);
      end = Math.max(end, n.t + n.dur);
    }
    assert.equal(Math.round(end * 1000), c.durationMs, id + ' durationMs matches notes');
    assert.ok(end <= 0.9);
  }
  const max = Math.max(...CUE_IDS.map((i) => CUES[i].level));
  assert.equal(CUES['snd.attention'].level, max);
  assert.equal(CUE_IDS.filter((i) => CUES[i].level === max).length, 1, 'attention is strictly the loudest');
});

test('PRIORITY order', () => {
  const P = AbitoSound.PRIORITY;
  assert.ok(P['snd.error'] > P['snd.attention'] && P['snd.attention'] > P['snd.confirm']);
  assert.equal(P['snd.confirm'], P['snd.reject']);
  assert.ok(P['snd.reject'] > P['snd.notice']);
  assert.equal(P['snd.notice'], P['snd.expired']);
  assert.ok(P['snd.expired'] > P['snd.sent'] && P['snd.sent'] > P['snd.think']);
  assert.equal(P['snd.think'], P['snd.reply']); assert.equal(P['snd.reply'], P['snd.listen']);
});

test('every cue: duration, peak, no clicks, non-silent, no DC, deterministic', async () => {
  for (const id of CUE_IDS) {
    const a = await renderCue(id);
    const b = await renderCue(id);
    assert.ok(a.durationMs >= 80 && a.durationMs <= 600 + 12, `${id} duration ${a.durationMs}`);
    assert.ok(a.durationMs <= 900);
    assert.ok(Math.abs(a.durationMs - CUES[id].durationMs) <= 12, `${id} ${a.durationMs} vs ${CUES[id].durationMs}`);
    assert.ok(a.peak <= 0.2 * 1.001, `${id} peak ${a.peak}`);
    assert.ok(a.peak <= 0.12 * 1.001);
    assert.ok(a.peak > 0.005, `${id} audible`);
    assert.ok(a.rms > 0.001);
    assert.ok(a.firstAbs < 0.002 && a.lastAbs < 0.002, `${id} edges ${a.firstAbs} ${a.lastAbs}`);
    assert.ok(a.maxStep < 0.03, `${id} maxStep ${a.maxStep}`);
    assert.ok(Math.abs(a.mean) < 0.005, `${id} DC ${a.mean}`);
    assert.equal(a.samples.length, b.samples.length);
    assert.ok(Buffer.from(a.samples.buffer).equals(Buffer.from(b.samples.buffer)), id + ' deterministic');
  }
});

test('MAX_GAIN: no clipping; other gains bound the peak; peak scales linearly with setGain', async () => {
  for (const id of CUE_IDS) {
    const m = await renderCue(id, {}, 1); // clamps to MAX_GAIN
    assert.ok(m.peak <= MAX_GAIN * 1.001 && m.peak < 1, id);
    for (const g of [0.01, 0.05, 0.12, 0.2]) {
      const r = await renderCue(id, {}, g);
      assert.ok(r.peak <= g * 1.001, `${id}@${g}: ${r.peak}`);
    }
    const lo = await renderCue(id, {}, 0.05);
    const hi = await renderCue(id, {}, 0.1);
    assert.ok(Math.abs(hi.peak / lo.peak - 2) < 0.01, `${id} linear ${hi.peak / lo.peak}`);
  }
});

test('attention is the loudest (rms and peak)', async () => {
  const att = await renderCue('snd.attention');
  for (const id of CUE_IDS) {
    if (id === 'snd.attention') continue;
    const o = await renderCue(id);
    assert.ok(att.rms > o.rms, `${id} rms ${o.rms} vs ${att.rms}`);
    assert.ok(att.peak >= o.peak);
  }
});

test('gain envelope hygiene on every node: attack >= 5 ms, release >= 15 ms, never ramps from/to 0', async () => {
  for (const id of CUE_IDS) {
    const { ctx } = await renderCue(id);
    for (const g of ctx.gains) {
      const ev = g.gain.events;
      assert.equal(ev[0].type, 'set'); assert.ok(ev[0].v > 0);
      const lin = ev.find((e) => e.type === 'lin');
      assert.ok(lin.t - ev[0].t >= 0.005 - 1e-9, id + ' attack');
      const exp = ev.find((e) => e.type === 'exp');
      const holdSet = ev[ev.length - 2];
      assert.equal(holdSet.type, 'set');
      assert.ok(exp.t - holdSet.t >= 0.015 - 1e-9, id + ' release');
      assert.ok(exp.v > 0 && exp.v <= 0.0001 + 1e-12);
      for (const e of ev) assert.ok(e.v > 0, 'no zero values');
    }
    for (const o of ctx.oscillators) {
      assert.ok(['sine', 'triangle'].includes(o.type));
      assert.ok(o.stopAt > o.startAt);
      for (const e of o.frequency.events) assert.ok(e.v >= 40 && e.v <= 4000);
    }
  }
});

test('uses only the allowed WebAudio subset (strict context)', async () => {
  const seen = new Set();
  const { createSoftContext, createFakeTime } = require('./support/soft-audio.cjs');
  const t = createFakeTime();
  const c = createSoftContext();
  const strict = new Proxy(c, { get(tg, k) { if (typeof k === 'string') seen.add(k); return tg[k]; } });
  const e = AbitoSound.createSoundEngine({ enabled: true, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer, createContext: () => strict });
  e.ready();
  const p = e.play('snd.reply'); t.advance(30); await p;
  const allowed = new Set(['createOscillator', 'createGain', 'destination', 'currentTime', 'state', 'resume', 'close']);
  for (const k of seen) assert.ok(allowed.has(k), 'unexpected context member ' + k);
});

test('glide cue uses exponential ramp on frequency', async () => {
  const { ctx } = await renderCue('snd.reply');
  const o = ctx.oscillators[0];
  assert.deepEqual(o.frequency.events.map((e) => e.type), ['set', 'exp']);
});

test('interaction cues are distinct, soft, and subordinate to semantic cues', async () => {
  const ids = ['open', 'close', 'peek', 'hover', 'pop', 'tick', 'love'].map(s => 'snd.' + s);
  const shapes = new Set();
  for (const id of ids) {
    const c = CUES[id]; assert.ok(c, id);
    assert.ok(c.level <= 0.3 && c.durationMs <= 300);
    assert.ok(AbitoSound.PRIORITY[id] < AbitoSound.PRIORITY['snd.think']);
    shapes.add(JSON.stringify(c.notes));
    for (const semantic of ['notice', 'attention', 'confirm', 'reject', 'error', 'sent', 'think', 'reply']) {
      const h = makeHarness();
      const low = h.engine.play(id), high = h.engine.play('snd.' + semantic); h.time.advance(30);
      assert.equal((await low).reason, 'outranked'); assert.equal((await high).played, true);
    }
  }
  assert.equal(shapes.size, 7);
  assert.deepEqual(CUES['snd.open'].notes.map(n => n.f), [...CUES['snd.close'].notes.map(n => n.f)].reverse());
  assert.ok(CUES['snd.pop'].notes[0].f2 > CUES['snd.pop'].notes[0].f);
  assert.equal(CUES['snd.love'].notes.length, 3);
});

// ---- overrides ----
const note = (o = {}) => ({ t: 0, f: 440, dur: 0.2, type: 'sine', peak: 0.8, attack: 0.01, release: 0.05, ...o });

test('valid override is applied', async () => {
  const diag = [];
  const h = makeHarness({ engine: { onDiagnostic: (r) => diag.push(r), cues: { 'snd.notice': { level: 0.3, notes: [note({ f: 500 })] } } } });
  assert.equal((await h.settle('snd.notice')).reason, 'played');
  assert.equal(h.ctxs[0].oscillators.length, 1);
  assert.equal(h.ctxs[0].oscillators[0].frequency.events[0].v, 500);
  assert.deepEqual(diag, []);
  // static table untouched
  assert.equal(CUES['snd.notice'].notes.length, 2);
});

test('partial override (level only / notes with defaults)', async () => {
  const h = makeHarness({ engine: { cues: { 'snd.sent': { level: 0.1 }, 'snd.think': { notes: [{ f: 300, dur: 0.1 }] } } } });
  const a = await h.settle('snd.sent');
  assert.equal(a.reason, 'played');
  const peakSent = h.ctxs[0].gains[0].gain.events.find((e) => e.type === 'lin').v;
  assert.ok(Math.abs(peakSent - 0.12 * 0.1 * CUES['snd.sent'].notes[0].peak) < 1e-9);
  h.time.advance(300);
  assert.equal((await h.settle('snd.think')).reason, 'played');
});

test('override validation matrix: each invalid override is ignored, reported, never throws', async () => {
  const bad = {
    unknownCue: ['snd.nope', { level: 0.5 }],
    levelHigh: ['snd.notice', { level: 1.5 }],
    levelNeg: ['snd.notice', { level: -0.1 }],
    levelNaN: ['snd.notice', { level: NaN }],
    levelStr: ['snd.notice', { level: '0.5' }],
    extraKey: ['snd.notice', { gain: 1 }],
    notNotesArray: ['snd.notice', { notes: {} }],
    emptyNotes: ['snd.notice', { notes: [] }],
    sevenNotes: ['snd.notice', { notes: Array.from({ length: 7 }, (_, i) => note({ t: i * 0.1, dur: 0.1 })) }],
    fLow: ['snd.notice', { notes: [note({ f: 39 })] }],
    fHigh: ['snd.notice', { notes: [note({ f: 4001 })] }],
    f2High: ['snd.notice', { notes: [note({ f2: 5000 })] }],
    f2Low: ['snd.notice', { notes: [note({ f2: 10 })] }],
    fNaN: ['snd.notice', { notes: [note({ f: NaN })] }],
    fMissing: ['snd.notice', { notes: [{ dur: 0.2 }] }],
    durLow: ['snd.notice', { notes: [note({ dur: 0.01, attack: 0.005, release: 0.005 })] }],
    durHigh: ['snd.notice', { notes: [note({ dur: 0.7 })] }],
    totalLong: ['snd.notice', { notes: [note({ dur: 0.5 }), note({ t: 0.5, dur: 0.5 })] }],
    tNeg: ['snd.notice', { notes: [note({ t: -0.1 })] }],
    typeBad: ['snd.notice', { notes: [note({ type: 'square' })] }],
    typeProto: ['snd.notice', { notes: [note({ type: '__proto__' })] }],
    peakHigh: ['snd.notice', { notes: [note({ peak: 1.1 })] }],
    peakNeg: ['snd.notice', { notes: [note({ peak: -1 })] }],
    attackLow: ['snd.notice', { notes: [note({ attack: 0.004 })] }],
    releaseLow: ['snd.notice', { notes: [note({ release: 0.01 })] }],
    attackReleaseTooLong: ['snd.notice', { notes: [note({ dur: 0.1, attack: 0.08, release: 0.08 })] }],
    overlapSum: ['snd.notice', { notes: [note({ peak: 0.8 }), note({ peak: 0.8 })] }],
    noteExtraKey: ['snd.notice', { notes: [note({ detune: 5 })] }],
    noteNotObject: ['snd.notice', { notes: [5] }],
    noteArray: ['snd.notice', { notes: [[]] }],
    overrideNotObject: ['snd.notice', 5],
    overrideArray: ['snd.notice', []],
    overrideNull: ['snd.notice', null],
    protoNote: ['snd.notice', { notes: [JSON.parse('{"f":440,"dur":0.2,"__proto__":{"x":1}}')] }],
  };
  for (const [name, [id, ov]] of Object.entries(bad)) {
    const diag = [];
    let h;
    assert.doesNotThrow(() => { h = makeHarness({ engine: { onDiagnostic: (r) => diag.push(r), cues: { [id]: ov } } }); }, name);
    assert.deepEqual(diag, ['invalid_cue_override'], name);
    if (id === 'snd.notice') {
      assert.equal((await h.settle(id)).reason, 'played', name);
      assert.equal(h.ctxs[0].oscillators.length, 2, name + ': default notes kept');
    }
  }
  // __proto__ as an own key (JSON) and non-object cues
  for (const cues of [JSON.parse('{"__proto__":{"level":1}}'), 5, 'x', [], null]) {
    const diag = [];
    assert.doesNotThrow(() => AbitoSound.createSoundEngine({ cues, onDiagnostic: (r) => diag.push(r) }));
    assert.ok(diag.every((d) => d === 'invalid_cue_override'));
  }
  assert.equal(({}).level, undefined, 'Object.prototype not polluted');
});

test('boundary values are accepted', async () => {
  const diag = [];
  const ok = [
    note({ f: 40 }), note({ f: 4000 }), note({ dur: 0.6, attack: 0.3, release: 0.3 }), note({ attack: 0.005 }), note({ release: 0.015 }), note({ peak: 1 }),
    note({ peak: 0.5 }),
  ];
  for (const n of ok) AbitoSound.createSoundEngine({ cues: { 'snd.notice': { notes: [n], level: 1 } }, onDiagnostic: (r) => diag.push(r) });
  assert.deepEqual(diag, []);
  AbitoSound.createSoundEngine({ cues: { 'snd.notice': { notes: [note({ dur: 0.45 }), note({ t: 0.45, dur: 0.45 })] } }, onDiagnostic: (r) => diag.push(r) });
  assert.deepEqual(diag, []);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const AbitoSound = require('../sound-engine.js');
const R = require('../scripts/render-wav.cjs');
const { createSoftContext, createFakeTime } = require('./support/soft-audio.cjs');

function suspendedHarness(options = {}) {
  const time = createFakeTime(0);
  const ctx = createSoftContext({ state: 'suspended', neverResume: true });
  const engine = AbitoSound.createSoundEngine({
    enabled: true, coalesceMs: 0, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    createContext: () => ctx, ...options,
  });
  engine.ready();
  return { time, ctx, engine };
}

async function microtasks(n = 8) { for (let i = 0; i < n; i++) await Promise.resolve(); }

function tempDir(name) { return path.join(os.tmpdir(), `abito-sound-${name}-${process.pid}-${Date.now()}-${Math.random()}`); }
const throwingGetter = (name) => ({ get() { throw new Error(`getter:${name}`); } });
const audioOptions = () => ({ enabled: true, createContext: () => createSoftContext() });

test('re-check every gate after bounded resume and report its closed-set reason', async () => {
  const cases = [
    ['quiet', 'quiet'],
    ['inactive', 'inactive'],
    ['gain', 'disabled'],
    ['enabled', 'disabled'],
    ['prefs', 'disabled'],
    ['close', 'closed'],
  ];
  for (const [mutation, expected] of cases) {
    let active = true;
    const h = suspendedHarness({ isActive: () => active });
    const p = h.engine.play('snd.notice');
    if (mutation === 'quiet') h.engine.quiet(5000);
    if (mutation === 'inactive') active = false;
    if (mutation === 'gain') h.engine.setGain(0);
    if (mutation === 'enabled') h.engine.setEnabled(false);
    if (mutation === 'prefs') h.engine.applyPrefs({ v: 1, sound: false });
    if (mutation === 'close') h.engine.close();
    h.time.advance(300);
    const result = await p;
    assert.equal(result.reason, expected, mutation);
    assert.equal(h.ctx.oscillators.filter((o) => o.startAt !== undefined).length, 0, mutation);
  }
  // A synchronous resume must also observe quiet() called before its continuation runs.
  const time = createFakeTime(0);
  const ctx = createSoftContext({ state: 'suspended' });
  const engine = AbitoSound.createSoundEngine({ enabled: true, coalesceMs: 0, now: time.now, setTimer: time.setTimer,
    clearTimer: time.clearTimer, createContext: () => ctx });
  engine.ready();
  const p = engine.play('snd.notice'); engine.quiet(5000);
  assert.equal((await p).reason, 'quiet');
  assert.equal(ctx.oscillators.length, 0);
});

test('limiter stamps at graph commit when resume crosses the request window', async () => {
  const time = createFakeTime(0);
  const ctx = createSoftContext({ state: 'suspended' });
  ctx.resume = () => new Promise((resolve) => time.setTimer(() => { ctx.state = 'running'; resolve(); }, 200));
  const commits = [];
  const createOscillator = ctx.createOscillator.bind(ctx);
  ctx.createOscillator = () => {
    const osc = createOscillator();
    const start = osc.start.bind(osc);
    osc.start = (at) => { commits.push(time.now()); start(at); };
    return osc;
  };
  const engine = AbitoSound.createSoundEngine({ enabled: true, coalesceMs: 0, now: time.now, setTimer: time.setTimer,
    clearTimer: time.clearTimer, createContext: () => ctx });
  engine.ready();
  const first = engine.play('snd.notice');
  time.advance(200);
  assert.equal((await first).reason, 'played');
  time.advance(60);
  assert.equal((await engine.play('snd.sent')).reason, 'rate_limited');
  assert.deepEqual(commits, [200, 200]); // notice has two oscillators in one graph commit
});

test('held commits serialize; requests resolved after an intervening gate close stay silent', async () => {
  const h = suspendedHarness();
  const first = h.engine.play('snd.notice');
  h.time.advance(100);
  const second = h.engine.play('snd.sent');
  h.time.advance(150);
  await microtasks();
  assert.equal((await first).reason, 'played');
  h.time.advance(100);
  assert.equal((await second).reason, 'rate_limited');
  assert.equal(h.ctx.oscillators.filter((o) => o.startAt !== undefined).length, 2);
});

test('caller option and cue getters or proxy traps never escape the engine', () => {
  const optionNames = ['now', 'setTimer', 'clearTimer', 'createContext', 'isActive', 'coalesceMs', 'onDiagnostic', 'gain', 'enabled', 'cues', 'then', 'constructor', '__proto__x'];
  for (const name of optionNames) {
    const options = { enabled: true };
    Object.defineProperty(options, name, throwingGetter(name));
    let engine;
    assert.doesNotThrow(() => { engine = AbitoSound.createSoundEngine(options); }, `options.${name}`);
    if (name === 'gain') assert.equal(engine.state().gain, AbitoSound.DEFAULT_GAIN);
    if (name === 'enabled') assert.equal(engine.isEnabled(), false);
  }
  const cueOptionDiagnostics = [];
  const badCueOption = { onDiagnostic: (d) => cueOptionDiagnostics.push(d) };
  Object.defineProperty(badCueOption, 'cues', throwingGetter('cues'));
  assert.doesNotThrow(() => AbitoSound.createSoundEngine(badCueOption));
  assert.deepEqual(cueOptionDiagnostics, ['invalid_cue_override']);
  assert.doesNotThrow(() => AbitoSound.createSoundEngine(new Proxy({}, { getPrototypeOf() { throw Error('proto'); } })));
  assert.doesNotThrow(() => AbitoSound.createSoundEngine(new Proxy({}, { get(_t, key) { if (key === 'gain') throw Error('gain'); return undefined; } })));

  const cases = [];
  const badCueValue = {}; Object.defineProperty(badCueValue, 'snd.notice', { ...throwingGetter('cue-value'), enumerable: true });
  cases.push({ cues: badCueValue });
  const badLevel = {}; Object.defineProperty(badLevel, 'level', throwingGetter('level')); badLevel.notes = undefined;
  cases.push({ cues: { 'snd.notice': badLevel } });
  const badNotes = {}; Object.defineProperty(badNotes, 'notes', throwingGetter('notes'));
  cases.push({ cues: { 'snd.notice': badNotes } });
  const note = { t: 0, f: 440, dur: 0.2, type: 'sine', peak: 1, attack: 0.01, release: 0.05 };
  const hostileNotes = [note]; Object.defineProperty(hostileNotes, 0, throwingGetter('note-element'));
  cases.push({ cues: { 'snd.notice': { notes: hostileNotes } } });
  const hostileField = { ...note }; Object.defineProperty(hostileField, 'f', throwingGetter('frequency'));
  cases.push({ cues: { 'snd.notice': { notes: [hostileField] } } });
  cases.push({ cues: new Proxy({}, { ownKeys() { throw Error('ownKeys'); } }) });
  cases.push({ cues: new Proxy({}, { getPrototypeOf() { throw Error('proto'); } }) });
  cases.push({ cues: { 'snd.notice': new Proxy({}, { getPrototypeOf() { throw Error('proto'); } }) } });
  cases.push({ cues: new Proxy({ 'snd.notice': {} }, { get(_target, key) { if (key === 'snd.notice') throw Error('cue get'); return undefined; } }) });
  cases.push({ cues: { 'snd.notice': new Proxy({ level: 1 }, { get(_target, key) { if (key === 'level') throw Error('level get'); return undefined; } }) } });
  const ownProtoCue = {}; Object.defineProperty(ownProtoCue, '__proto__', { value: { level: 1 }, enumerable: true });
  cases.push({ cues: ownProtoCue });
  for (const cues of cases) {
    const diagnostics = [];
    assert.doesNotThrow(() => AbitoSound.createSoundEngine({ ...cues, onDiagnostic: (d) => diagnostics.push(d) }));
    assert.ok(diagnostics.every((d) => d === 'invalid_cue_override'));
    assert.ok(diagnostics.includes('invalid_cue_override'));
  }
  const hostileArray = new Proxy([note], { get(target, key, receiver) { if (key === 'length') throw Error('length'); return Reflect.get(target, key, receiver); } });
  const diagnostics = [];
  assert.doesNotThrow(() => AbitoSound.createSoundEngine({ cues: { 'snd.notice': { notes: hostileArray } }, onDiagnostic: (d) => diagnostics.push(d) }));
  assert.deepEqual(diagnostics, ['invalid_cue_override']);
});

test('applyPrefs exceptions fail closed for throwing getters and proxies', () => {
  const engine = AbitoSound.createSoundEngine(audioOptions());
  for (const prefs of [
    { get v() { throw Error('v'); } },
    { v: 1, get sound() { throw Error('sound'); } },
    new Proxy({}, { getPrototypeOf() { throw Error('proto'); } }),
    new Proxy({ v: 1, sound: true }, { get(_t, key) { if (key === 'sound') throw Error('sound'); return 1; } }),
  ]) {
    engine.setEnabled(true);
    assert.doesNotThrow(() => assert.equal(engine.applyPrefs(prefs), false));
    assert.equal(engine.isEnabled(), false);
  }
});

test('hostile method arguments and state reads also stay inside the engine boundary', async () => {
  const engine = AbitoSound.createSoundEngine({ enabled: true, coalesceMs: 0, createContext: () => createSoftContext() });
  engine.ready();
  const play = engine.play({ get toString() { throw Error('stringify'); } });
  assert.ok(play && typeof play.then === 'function');
  assert.equal((await play).reason, 'unknown_cue');
  assert.doesNotThrow(() => engine.transition({ get length() { throw Error('length'); } }, true, 'snd.notice'));
  assert.doesNotThrow(() => engine.quiet({ get valueOf() { throw Error('valueOf'); } }));
  assert.doesNotThrow(() => engine.setGain({ get valueOf() { throw Error('valueOf'); } }));
  assert.doesNotThrow(() => engine.state());
});

test('plain overrides from another realm are accepted, custom class instances rejected', () => {
  const foreign = vm.runInNewContext('({ level: 0.4, notes: [{ t: 0, f: 500, dur: 0.2 }] })');
  const diagnostics = [];
  const engine = AbitoSound.createSoundEngine({ cues: { 'snd.notice': foreign }, onDiagnostic: (d) => diagnostics.push(d) });
  assert.deepEqual(diagnostics, []);
  assert.equal(engine.state().gain, AbitoSound.DEFAULT_GAIN);
  class Custom { constructor() { this.level = 0.4; } }
  const badDiagnostics = [];
  AbitoSound.createSoundEngine({ cues: { 'snd.notice': new Custom() }, onDiagnostic: (d) => badDiagnostics.push(d) });
  assert.deepEqual(badDiagnostics, ['invalid_cue_override']);
});

test('close reports a throwing or rejected context close once and remains closed', async () => {
  for (const close of [() => { throw Error('close'); }, () => Promise.reject(Error('close'))]) {
    const diagnostics = [];
    const ctx = createSoftContext(); ctx.close = close;
    const time = createFakeTime();
    const engine = AbitoSound.createSoundEngine({ enabled: true, now: time.now, setTimer: time.setTimer,
      clearTimer: time.clearTimer, createContext: () => ctx, onDiagnostic: (d) => diagnostics.push(d) });
    engine.ready();
    const p = engine.play('snd.notice'); time.advance(30); assert.equal((await p).reason, 'played');
    engine.close(); await microtasks(); engine.close();
    assert.equal(engine.state().closed, true);
    assert.deepEqual(diagnostics, ['context_error']);
  }
});

test('render validation happens before creating an output directory and never overwrites WAVs', () => {
  const missing = tempDir('invalid-gain');
  try {
    assert.throws(() => R.writeAll(missing, 0), { message: 'gain must be a finite number greater than zero' });
    assert.equal(fs.existsSync(missing), false);
  } finally { if (fs.existsSync(missing)) fs.rmSync(missing, { recursive: true, force: true }); }

  const existing = tempDir('exclusive'); fs.mkdirSync(existing);
  try {
    const file = path.join(existing, `${AbitoSound.CUE_IDS[0]}.wav`);
    fs.writeFileSync(file, 'keep');
    assert.throws(() => R.writeAll(existing), { message: 'output file already exists' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(existing), [path.basename(file)]);
  } finally { if (fs.existsSync(existing)) fs.rmSync(existing, { recursive: true, force: true }); }
  assert.throws(() => R.wavBuffer([], 0), { message: 'sample rate must be a positive integer' });
  assert.throws(() => R.renderCue('snd.notice', undefined, 0), { message: 'sample rate must be a positive integer' });
});

test('README lists exact method return contracts', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  for (const method of ['ready()', 'quiet(ms)', 'setEnabled(v)', 'setGain(n)', 'resetTransitions()', 'close()']) {
    assert.match(md, new RegExp('`' + method.replace(/[()]/g, '\\$&') + '`.*`undefined`'));
  }
  for (const phrase of [
    'applyPrefs(prefs)` devuelve `boolean`', 'isEnabled()` devuelve `boolean`', 'state()` devuelve un `object`',
    'play(id)` siempre devuelve `Promise<{played, reason, id}>`',
    'transition(key, active, id)` devuelve `Promise<{played, reason, id}>` cuando solicita un cue; en otro caso devuelve `undefined`',
  ]) assert.ok(md.includes(phrase), phrase);
});

test('seeded fake-audio stress preserves limiter and gate invariants across 1500 sequences', async () => {
  let rng = 0x31a2b3c4;
  const random = () => { rng = (Math.imul(rng, 1103515245) + 12345) & 0x7fffffff; return rng / 0x80000000; };
  const ids = AbitoSound.CUE_IDS;
  const reasons = new Set(AbitoSound.REASONS);
  const steps = [0, 1, 5, 20, 30, 120, 260, 500, 2100];

  for (let sequence = 0; sequence < 1500; sequence++) {
    let clock = 0;
    let timerId = 0;
    const timers = new Map();
    let ctx = null;
    const model = { enabled: true, gain: 0.12, ready: false, quietUntil: 0, active: true, closed: false };
    const commits = [];
    const playedResults = [];
    const resolutions = [];
    const requests = [];
    const kind = sequence % 6;
    const setTimer = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: clock + Math.max(0, ms || 0) }); return id; };
    const clearTimer = (id) => { timers.delete(id); };
    const syncContext = () => {
      if (ctx && clock / 1000 > ctx.currentTime) ctx.advance(clock / 1000 - ctx.currentTime);
    };
    const advance = async (ms) => {
      const target = clock + ms;
      for (let guard = 0; guard < 2000; guard++) {
        let next = null;
        for (const [id, entry] of timers) if (entry.at <= target && (!next || entry.at < next.entry.at)) next = { id, entry };
        if (!next) break;
        timers.delete(next.id);
        clock = Math.max(clock, next.entry.at);
        syncContext();
        next.entry.fn();
        await microtasks(5);
        syncContext();
      }
      clock = target;
      syncContext();
      await microtasks(5);
    };
    const createContext = () => {
      if (kind === 5) throw Error('factory');
      ctx = createSoftContext({ state: kind === 0 || kind === 4 ? 'running' : 'suspended' });
      if (kind === 1) ctx.resume = () => new Promise((resolve) => setTimer(() => { ctx.state = 'running'; resolve(); }, 80));
      else if (kind === 2) ctx.resume = () => new Promise(() => {});
      else if (kind === 3) ctx.resume = () => { throw Error('resume'); };
      else ctx.resume = () => { ctx.state = 'running'; return Promise.resolve(); };
      if (kind === 4) ctx.createOscillator = () => { throw Error('oscillator'); };
      else {
        const makeOscillator = ctx.createOscillator.bind(ctx);
        ctx.createOscillator = () => {
          const osc = makeOscillator();
          const start = osc.start.bind(osc);
          osc.start = (at) => {
            start(at);
            if (Math.abs(at - (ctx.currentTime + 0.005)) < 1e-8) {
              const freq = osc.frequency.events[0].v;
              const id = ids.find((candidate) => AbitoSound.CUES[candidate].notes[0].f === freq);
              commits.push({ id, at: clock, gatesOpen: !model.closed && model.enabled && model.gain > 0 && model.ready && clock >= model.quietUntil && model.active });
              const live = commits.filter((entry) => clock - entry.at < AbitoSound.CUES[entry.id].durationMs + 12).length;
              assert.ok(live <= 3, `sequence ${sequence}: ${live} simultaneous voices`);
            }
          };
          return osc;
        };
      }
      return ctx;
    };
    const engine = AbitoSound.createSoundEngine({
      enabled: model.enabled, coalesceMs: [0, 5, 25, 120][sequence % 4],
      now: () => clock, setTimer, clearTimer, createContext, isActive: () => model.active,
    });
    const track = (id) => {
      let promise;
      try { promise = engine.play(id); } catch (error) { assert.fail(`sequence ${sequence}: sync throw ${error.message}`); }
      assert.ok(promise && typeof promise.then === 'function');
      const record = { count: 0 };
      requests.push(promise);
      resolutions.push(record);
      promise.then((value) => {
        record.count++;
        assert.equal(record.count, 1);
        assert.ok(value && reasons.has(value.reason), `unknown reason ${value && value.reason}`);
        if (value.played) playedResults.push(value);
      });
    };

    for (let operation = 0; operation < 20; operation++) {
      await advance(steps[Math.floor(random() * steps.length)]);
      const action = random();
      if (action < 0.09) { model.enabled = !model.enabled; engine.setEnabled(model.enabled); }
      else if (action < 0.18) { model.ready = true; engine.ready(); }
      else if (action < 0.28) { const ms = Math.floor(random() * 5000); model.quietUntil = Math.max(model.quietUntil, clock + ms); engine.quiet(ms); }
      else if (action < 0.37) { model.active = !model.active; }
      else if (action < 0.45) { model.gain = random() < 0.25 ? 0 : 0.12; engine.setGain(model.gain); }
      else if (action < 0.48 && !model.closed) { model.closed = true; engine.close(); }
      else {
        track(ids[Math.floor(random() * ids.length)]);
        if (random() < 0.12) track(ids[Math.floor(random() * ids.length)]);
      }
    }
    await advance(30000);
    await Promise.all(requests);
    await microtasks(8);
    for (const record of resolutions) assert.equal(record.count, 1, `sequence ${sequence}: request unresolved or resolved more than once`);
    assert.equal(commits.length, playedResults.length, `sequence ${sequence}: commit/result count mismatch`);
    for (let i = 0; i < commits.length; i++) {
      assert.equal(commits[i].id, playedResults[i].id, `sequence ${sequence}: commit id mismatch`);
      assert.ok(commits[i].gatesOpen, `sequence ${sequence}: graph commit while gate closed`);
      if (i > 0) assert.ok(commits[i].at - commits[i - 1].at >= 250, `sequence ${sequence}: spacing ${commits[i].at - commits[i - 1].at} ms`);
    }
    const lastById = new Map();
    for (const commit of commits) {
      const previous = lastById.get(commit.id);
      if (previous !== undefined) assert.ok(commit.at - previous >= 2000, `sequence ${sequence}: ${commit.id} repeated too soon`);
      lastById.set(commit.id, commit.at);
    }
  }
});

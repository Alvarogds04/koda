'use strict';
// Deterministic software AudioContext (tests only). Implements exactly the WebAudio subset the
// engine may use: oscillators (sine/triangle), gain nodes with setValueAtTime / linear / exponential
// ramps, destination, currentTime, state, resume(), close(). Nothing here touches real audio.

class SoftParam {
  constructor(v) { this.value0 = v; this.events = []; }
  get value() { return this.value0; }
  set value(v) { this.value0 = v; }
  _add(ev) {
    if (!Number.isFinite(ev.t) || !Number.isFinite(ev.v)) throw new TypeError('non-finite automation');
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].t > ev.t) i--;
    this.events.splice(i, 0, ev);
    return this;
  }
  setValueAtTime(v, t) { return this._add({ type: 'set', v, t }); }
  linearRampToValueAtTime(v, t) { return this._add({ type: 'lin', v, t }); }
  exponentialRampToValueAtTime(v, t) {
    if (!(v > 0)) throw new RangeError('exponential ramp target must be > 0');
    return this._add({ type: 'exp', v, t });
  }
  at(t) {
    const ev = this.events;
    let idx = -1;
    for (let i = 0; i < ev.length; i++) if (ev[i].t <= t) idx = i;
    if (idx < 0) return this.value0;
    const prev = ev[idx];
    const next = ev[idx + 1];
    if (next && next.type !== 'set' && next.t > prev.t) {
      const f = (t - prev.t) / (next.t - prev.t);
      if (next.type === 'lin') return prev.v + (next.v - prev.v) * f;
      if (!(prev.v > 0)) throw new RangeError('exponential ramp from <= 0');
      return prev.v * Math.pow(next.v / prev.v, f);
    }
    return prev.v;
  }
}

class SoftNode {
  constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.disconnected = 0; }
  connect(dest) { this.ctx.edges.push([this, dest]); return dest; }
  disconnect() { this.disconnected++; this.ctx.disconnects++; } // graph record is kept for render()
}

function createSoftContext(opts = {}) {
  const ctx = {
    currentTime: opts.currentTime || 0,
    state: opts.state || 'running',
    edges: [], oscillators: [], gains: [], disconnects: 0,
    resumeCalls: 0, closeCalls: 0,
    destination: null,
    createOscillator() {
      const n = new SoftNode(ctx, 'osc');
      n.type = 'sine'; n.frequency = new SoftParam(440);
      n.startAt = undefined; n.stopAt = undefined; n.onended = null; n.ended = false;
      n.start = (t) => { if (n.startAt !== undefined) throw new Error('already started'); n.startAt = t; };
      n.stop = (t) => { n.stopAt = t; };
      ctx.oscillators.push(n);
      return n;
    },
    createGain() {
      const n = new SoftNode(ctx, 'gain');
      n.gain = new SoftParam(1);
      ctx.gains.push(n);
      return n;
    },
    resume() { ctx.resumeCalls++; if (opts.neverResume) return new Promise(() => {}); ctx.state = 'running'; return Promise.resolve(); },
    close() { ctx.closeCalls++; ctx.state = 'closed'; return Promise.resolve(); },
    // test control: move the clock and fire onended for finished oscillators
    advance(sec) {
      ctx.currentTime += sec;
      for (const o of ctx.oscillators) {
        if (!o.ended && o.stopAt !== undefined && o.stopAt <= ctx.currentTime) {
          o.ended = true;
          if (typeof o.onended === 'function') o.onended();
        }
      }
    },
    nodeCount() { return ctx.oscillators.length + ctx.gains.length; },
    render(sampleRate = 44100) { return renderContext(ctx, sampleRate); },
  };
  ctx.destination = new SoftNode(ctx, 'dest');
  return ctx;
}

function wave(type, p) {
  const s = Math.sin(2 * Math.PI * p);
  return type === 'triangle' ? (2 / Math.PI) * Math.asin(s) : s;
}

function renderContext(ctx, sr) {
  const oscs = ctx.oscillators.filter((o) => o.startAt !== undefined);
  if (!oscs.length) return { samples: new Float32Array(0), peak: 0, rms: 0, durationMs: 0, firstAbs: 0, lastAbs: 0, maxStep: 0, mean: 0 };
  const inputs = new Map();
  for (const [a, b] of ctx.edges) { if (!inputs.has(b)) inputs.set(b, []); inputs.get(b).push(a); }
  const t0 = Math.min(...oscs.map((o) => o.startAt));
  const t1 = Math.max(...oscs.map((o) => (o.stopAt === undefined ? o.startAt : o.stopAt)));
  const n = Math.max(1, Math.round((t1 - t0) * sr));
  const samples = new Float32Array(n);
  const phase = new Map(oscs.map((o) => [o, 0]));
  const out = (node, t) => {
    if (node.kind === 'osc') {
      if (node.startAt === undefined || t < node.startAt || t >= node.stopAt) return 0;
      return wave(node.type, phase.get(node));
    }
    let sum = 0;
    for (const src of inputs.get(node) || []) sum += out(src, t);
    return node.kind === 'gain' ? sum * node.gain.at(t) : sum;
  };
  for (let i = 0; i < n; i++) {
    const t = t0 + i / sr;
    samples[i] = out(ctx.destination, t);
    for (const o of oscs) if (t >= o.startAt && t < o.stopAt) phase.set(o, phase.get(o) + o.frequency.at(t) / sr);
  }
  let peak = 0, sq = 0, sum = 0, maxStep = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    sq += samples[i] * samples[i]; sum += samples[i];
    if (i) maxStep = Math.max(maxStep, Math.abs(samples[i] - samples[i - 1]));
  }
  return {
    samples, peak, rms: Math.sqrt(sq / n), mean: sum / n, durationMs: (t1 - t0) * 1000,
    firstAbs: Math.abs(samples[0]), lastAbs: Math.abs(samples[n - 1]), maxStep,
  };
}

// Fake clock + timers: advance(ms) fires due timers in order.
function createFakeTime(start = 100000) {
  let t = start, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { at: t + (ms || 0), fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let best = null;
        for (const [id, x] of timers) if (x.at <= end && (!best || x.at < best.x.at)) best = { id, x };
        if (!best) break;
        timers.delete(best.id);
        t = Math.max(t, best.x.at);
        best.x.fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

// Engine + fake time + soft contexts, ready() already called. play() helper settles the coalesce window.
function makeHarness(opts = {}) {
  const AbitoSound = require('../../sound-engine.js');
  const time = createFakeTime();
  const ctxs = [];
  const engine = AbitoSound.createSoundEngine({
    enabled: true, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    createContext: () => { const c = createSoftContext(opts.ctx || {}); ctxs.push(c); return c; },
    ...(opts.engine || {}),
  });
  if (opts.ready !== false) engine.ready();
  // request + let the coalesce window elapse + await the verdict
  const settle = async (id) => { const p = engine.play(id); time.advance(30); return p; };
  return { AbitoSound, engine, time, ctxs, settle };
}

module.exports = { createSoftContext, createFakeTime, SoftParam, makeHarness };

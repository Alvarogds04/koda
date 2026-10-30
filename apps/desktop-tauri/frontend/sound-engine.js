'use strict';
/* Abito island sound engine (#313). Dependency-free UMD, loaded as a CLASSIC script
   (global AbitoSound) and by node tests. Built-in cues are synthesized with a WebAudio
   subset (oscillator + gain); optional decoded samples can be injected. No file access, DOM or network. Catalog and rules:
   docs/desktop-sound-catalog.md. Integration contract: README.md. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoSound = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const DEFAULT_GAIN = 0.12;
  const MAX_GAIN = 0.2;
  const FLOOR = 0.0001; // never ramp from/to 0
  const LEAD_S = 0.005; // scheduling lead after currentTime
  const WINDOW_MS = 250; // any cue vs any cue
  const SAME_ID_MS = 2000; // same cue
  const MAX_VOICES = 3;
  const NO_AUDIO_RETRY_MS = 10000;
  const RESUME_BOUND_MS = 250;
  const MAX_KEYS = 256;
  const MAX_KEY_LEN = 64;

  const REASONS = ['played', 'disabled', 'not_ready', 'quiet', 'inactive', 'unknown_cue', 'rate_limited', 'duplicate', 'outranked', 'no_audio', 'closed'];
  const DIAGNOSTICS = ['invalid_cue_override', 'no_audio', 'context_error', 'is_active_error'];

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const k of Object.keys(o)) deepFreeze(o[k]);
    }
    return o;
  }
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function isPlain(o) {
    if (o === null || typeof o !== 'object') return false;
    try {
      if (Object.prototype.toString.call(o) !== '[object Object]') return false;
      const p = Object.getPrototypeOf(o);
      return p === null || Object.getPrototypeOf(p) === null;
    } catch (e) { return false; }
  }
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  // ---- cue table (the human tunes these by ear later: everything lives here) ---------------
  const note = (t, f, dur, type, peak, attack, release, f2) => {
    const n = { t, f, dur, type, peak, attack, release };
    if (f2 !== undefined) n.f2 = f2;
    return n;
  };
  const cue = (id, name, trigger, level, notes) => ({
    id, name, trigger, level, notes,
    durationMs: Math.round(Math.max(...notes.map((n) => n.t + n.dur)) * 1000),
  });
  const CUES = deepFreeze({
    'snd.open': cue('snd.open', 'Abrir', 'La isla se expande desde compact', 0.22, [
      note(0, 480, 0.08, 'sine', 1, 0.005, 0.05), note(0.08, 720, 0.08, 'sine', 1, 0.005, 0.05)]),
    'snd.close': cue('snd.close', 'Cerrar', 'La isla expandida se contrae u oculta', 0.22, [
      note(0, 720, 0.08, 'sine', 1, 0.005, 0.05), note(0.08, 480, 0.08, 'sine', 1, 0.005, 0.05)]),
    'snd.peek': cue('snd.peek', 'Asomar', 'La isla reaparece desde hidden', 0.16, [
      note(0, 280, 0.1, 'sine', 1, 0.01, 0.07)]),
    'snd.hover': cue('snd.hover', 'Rozar', 'El puntero entra en el personaje', 0.08, [
      note(0, 1560, 0.08, 'sine', 1, 0.005, 0.07)]),
    'snd.pop': cue('snd.pop', 'Elegir', 'Selección de opción mediante abito:cue', 0.28, [
      note(0, 580, 0.1, 'sine', 1, 0.005, 0.07, 1160)]),
    'snd.tick': cue('snd.tick', 'Paso', 'Progreso de adjunto mediante abito:cue', 0.1, [
      note(0, 3000, 0.08, 'triangle', 1, 0.005, 0.07)]),
    'snd.love': cue('snd.love', 'Cariño', 'El puntero permanece 1900 ms sobre el personaje', 0.2, [
      note(0, 600, 0.09, 'sine', 1, 0.01, 0.06), note(0.1, 750, 0.09, 'sine', 1, 0.01, 0.06),
      note(0.2, 900, 0.09, 'sine', 1, 0.01, 0.06)]),
    'snd.notice': cue('snd.notice', 'Aviso', 'Aviso nuevo del transporte (settled)', 0.6, [
      note(0, 880, 0.12, 'sine', 1, 0.008, 0.06), note(0.13, 660, 0.12, 'sine', 1, 0.008, 0.07)]),
    'snd.attention': cue('snd.attention', 'Atención', 'Tarjeta de aprobación pendiente o pregunta nueva', 1, [
      note(0, 660, 0.18, 'triangle', 1, 0.01, 0.07), note(0.2, 990, 0.2, 'triangle', 1, 0.01, 0.1)]),
    'snd.confirm': cue('snd.confirm', 'Confirmado', 'Acción aprobada confirmada por el host', 0.6, [
      note(0, 1320, 0.2, 'sine', 1, 0.005, 0.15)]),
    'snd.reject': cue('snd.reject', 'Rechazado', 'Acción rechazada confirmada por el host', 0.7, [
      note(0, 220, 0.2, 'triangle', 1, 0.008, 0.14)]),
    'snd.error': cue('snd.error', 'Error', 'Modelo no disponible o bloqueado, o turno con error', 0.75, [
      note(0, 520, 0.17, 'triangle', 1, 0.01, 0.07), note(0.18, 390, 0.17, 'triangle', 1, 0.01, 0.1)]),
    'snd.sent': cue('snd.sent', 'Enviado', 'Mensaje o respuesta enviados por el humano', 0.35, [
      note(0, 2400, 0.15, 'sine', 1, 0.01, 0.09, 3200)]),
    'snd.think': cue('snd.think', 'Pensando', 'El modelo empieza a trabajar (una vez por turno)', 0.5, [
      note(0, 440, 0.25, 'sine', 1, 0.04, 0.14)]),
    'snd.reply': cue('snd.reply', 'Respuesta', 'Respuesta completa (streaming a completed)', 0.55, [
      note(0, 523, 0.25, 'sine', 1, 0.03, 0.12, 784)]),
    'snd.listen': cue('snd.listen', 'Escuchando', 'Se abre el micrófono (entrada de voz)', 0.55, [
      note(0, 740, 0.2, 'sine', 1, 0.01, 0.1)]),
    'snd.expired': cue('snd.expired', 'Vencido', 'Pregunta o tarjeta vencida sin respuesta', 0.3, [
      note(0, 196, 0.2, 'sine', 1, 0.03, 0.12)]),
  });
  // Abito-owned synthesized fallback for every reference cue name. These are
  // independently tunable identities, not aliases: custom greet and greeting
  // files (and all legacy Abito names) keep separate buffers and rate gates.
  const EXTRA_CUES = [
    ['blip', 'Toque', 920], ['slap', 'Golpe', 180], ['annoyed', 'Molestia', 210],
    ['dizzy', 'Mareo', 330], ['greet', 'Saludo', 760], ['work', 'Trabajo', 400],
    ['finish', 'Terminado', 1040], ['approval', 'Aprobación pendiente', 620],
    ['question', 'Pregunta', 840], ['approve', 'Aprobado', 1240], ['gulp', 'Recibir', 260],
    ['send', 'Enviar', 2200], ['proud', 'Orgullo', 980], ['wink', 'Guiño', 1450],
    ['yawn', 'Bostezo', 290], ['attach', 'Adjuntar', 1100], ['search', 'Buscar', 560],
    ['rate', 'Valorar', 1300], ['sleep', 'Dormir', 200], ['greeting', 'Bienvenida', 680],
  ];
  const ALL_CUES = deepFreeze(Object.assign({}, CUES, Object.fromEntries(EXTRA_CUES.map(([stem, name, f]) => [
    'snd.' + stem, cue('snd.' + stem, name, 'Evento abito:cue explícito', 0.2,
      [note(0, f, 0.16, 'sine', 1, 0.01, 0.1, f * 1.25)]),
  ]))));
  const CUE_IDS = deepFreeze(Object.keys(ALL_CUES));
  const PRIORITY = deepFreeze({
    ...Object.fromEntries(EXTRA_CUES.map(([stem]) => ['snd.' + stem, -2])),
    'snd.approval': 4, 'snd.question': 4, 'snd.approve': 3, 'snd.finish': 2, 'snd.send': 1,
    'snd.open': -2, 'snd.close': -2, 'snd.peek': -2, 'snd.hover': -2,
    'snd.tick': -2, 'snd.love': -2, 'snd.pop': -1,
    'snd.error': 5, 'snd.attention': 4, 'snd.confirm': 3, 'snd.reject': 3,
    'snd.notice': 2, 'snd.expired': 2, 'snd.sent': 1, 'snd.think': 0, 'snd.reply': 0, 'snd.listen': 0,
  });

  // ---- override validation ----------------------------------------------------------------
  const NOTE_KEYS = ['t', 'f', 'f2', 'dur', 'type', 'peak', 'attack', 'release'];
  function validNote(n) {
    try {
      if (!isPlain(n)) return null;
      for (const k of Object.keys(n)) if (!NOTE_KEYS.includes(k)) return null;
      const f = n.f;
      const dur = n.dur;
      if (!isNum(f) || f < 40 || f > 4000) return null;
      if (!isNum(dur) || dur < 0.02 || dur > 0.6) return null;
      const out = { t: 0, f, dur, type: 'sine', peak: 1, attack: 0.01, release: Math.min(0.05, dur - 0.01) };
      if (hasOwn(n, 't')) { const t = n.t; if (!isNum(t) || t < 0 || t > 0.9) return null; out.t = t; }
      if (hasOwn(n, 'f2')) { const f2 = n.f2; if (!isNum(f2) || f2 < 40 || f2 > 4000) return null; out.f2 = f2; }
      if (hasOwn(n, 'type')) { const type = n.type; if (type !== 'sine' && type !== 'triangle') return null; out.type = type; }
      if (hasOwn(n, 'peak')) { const peak = n.peak; if (!isNum(peak) || peak <= 0 || peak > 1) return null; out.peak = peak; }
      if (hasOwn(n, 'attack')) { const attack = n.attack; if (!isNum(attack) || attack < 0.005 || attack > 0.3) return null; out.attack = attack; }
      if (hasOwn(n, 'release')) { const release = n.release; if (!isNum(release) || release < 0.015 || release > 0.3) return null; out.release = release; }
      if (out.release < 0.015 || out.attack + out.release > out.dur + 1e-9) return null;
      return out;
    } catch (e) { return null; }
  }
  function validNotes(list) {
    try {
      if (!Array.isArray(list)) return null;
      const length = list.length;
      if (length < 1 || length > 6) return null;
      const notes = [];
      for (let i = 0; i < length; i++) { const v = validNote(list[i]); if (!v) return null; notes.push(v); }
      const end = Math.max(...notes.map((n) => n.t + n.dur));
      if (end > 0.9 + 1e-9 || end < 0.08 - 1e-9) return null;
      // simultaneous notes must not sum past full scale
      for (const a of notes) {
        let sum = 0;
        for (const b of notes) if (b.t <= a.t + 1e-9 && b.t + b.dur > a.t + 1e-9) sum += b.peak;
        if (sum > 1 + 1e-9) return null;
      }
      return notes;
    } catch (e) { return null; }
  }
  function resolveCues(overrides, diag) {
    const table = Object.create(null);
    for (const id of CUE_IDS) table[id] = ALL_CUES[id];
    if (overrides === undefined) return table;
    if (!isPlain(overrides)) { diag('invalid_cue_override'); return table; }
    let ids;
    try { ids = Object.keys(overrides); } catch (e) { diag('invalid_cue_override'); return table; }
    for (const id of ids) {
      let ok = false;
      let level = ALL_CUES[id] && ALL_CUES[id].level;
      let notes = ALL_CUES[id] && ALL_CUES[id].notes;
      try {
        const ov = overrides[id];
        const overrideKeys = isPlain(ov) ? Object.keys(ov) : null;
        ok = CUE_IDS.includes(id) && overrideKeys !== null && overrideKeys.every((k) => k === 'level' || k === 'notes');
        if (ok && hasOwn(ov, 'level')) {
          const value = ov.level;
          if (isNum(value) && value > 0 && value <= 1) level = value; else ok = false;
        }
        if (ok && hasOwn(ov, 'notes')) { notes = validNotes(ov.notes); if (!notes) ok = false; }
      } catch (e) { ok = false; }
      if (!ok) { diag('invalid_cue_override'); continue; }
      table[id] = deepFreeze(cue(id, ALL_CUES[id].name, ALL_CUES[id].trigger, level, notes.map((n) => ({ ...n }))));
    }
    return table;
  }

  const clampGain = (g) => (isNum(g) ? Math.min(MAX_GAIN, Math.max(0, g)) : DEFAULT_GAIN);
  const result = (played, reason, id) => ({ played, reason, id });

  function createSoundEngine(options) {
    const source = options !== null && (typeof options === 'object' || typeof options === 'function') ? options : {};
    const readOption = (key) => { try { return { value: source[key], failed: false }; } catch (e) { return { value: undefined, failed: true }; } };
    const nowOption = readOption('now').value;
    const setTimerOption = readOption('setTimer').value;
    const clearTimerOption = readOption('clearTimer').value;
    const contextOption = readOption('createContext').value;
    const activeOption = readOption('isActive').value;
    const coalesceOption = readOption('coalesceMs').value;
    const diagnosticOption = readOption('onDiagnostic').value;
    const gainOption = readOption('gain').value;
    const enabledOption = readOption('enabled').value;
    const cuesOption = readOption('cues');
    let lastNow = 0;
    const nowFn = typeof nowOption === 'function' ? nowOption : Date.now;
    const now = () => { try { const v = nowFn(); if (isNum(v)) lastNow = v; } catch (e) { /* keep last */ } return lastNow; };
    const setTimerFn = typeof setTimerOption === 'function' ? setTimerOption : (fn, ms) => setTimeout(fn, ms);
    const clearTimerFn = typeof clearTimerOption === 'function' ? clearTimerOption : (h) => clearTimeout(h);
    const setT = (fn, ms) => { try { const h = setTimerFn(fn, ms); if (h && typeof h.unref === 'function') h.unref(); return { ok: true, h }; } catch (e) { return { ok: false }; } };
    const clearT = (t) => { if (t && t.ok) { try { clearTimerFn(t.h); } catch (e) { /* ignore */ } } };
    const createContextFn = typeof contextOption === 'function' ? contextOption : () => {
      const C = typeof AudioContext !== 'undefined' ? AudioContext : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null); // eslint-disable-line no-undef
      if (!C) throw new Error('no AudioContext');
      return new C();
    };
    const isActiveFn = typeof activeOption === 'function' ? activeOption : () => true;
    const coalesceMs = isNum(coalesceOption) && coalesceOption >= 0 ? coalesceOption : 25;
    const diagFn = typeof diagnosticOption === 'function' ? diagnosticOption : null;
    const diag = (reason) => { if (!diagFn || !DIAGNOSTICS.includes(reason)) return; try { diagFn(reason); } catch (e) { /* swallowed */ } };

    let gain = clampGain(gainOption);
    let enabled = enabledOption === true;
    let ready = false;
    let closed = false;
    let quietUntil = 0;
    let ctx = null;
    let noRetryUntil = 0;
    let lastStart = -Infinity;
    const byId = new Map();
    const voices = new Set();
    const samples = new Map();
    const trans = new Map();
    let pending = null;
    const cues = cuesOption.failed ? (diag('invalid_cue_override'), resolveCues(undefined, diag)) : resolveCues(cuesOption.value, diag);

    function active() {
      try { return isActiveFn() !== false; } catch (e) { diag('is_active_error'); return false; }
    }
    // closed-set gate, in the contract order
    function gate(id) {
      if (closed) return 'closed';
      if (typeof id !== 'string' || !hasOwn(cues, id)) return 'unknown_cue';
      if (!enabled || gain <= 0) return 'disabled';
      if (!ready) return 'not_ready';
      if (now() < quietUntil) return 'quiet';
      if (!active()) return 'inactive';
      return null;
    }
    function verdict(id, t) {
      if (byId.has(id) && t - byId.get(id) < SAME_ID_MS) return 'duplicate';
      if (t - lastStart < WINDOW_MS) return 'rate_limited';
      return null;
    }

    function endVoice(v) {
      if (v.done) return;
      v.done = true;
      clearT(v.timer);
      voices.delete(v);
      for (const p of v.parts) {
        try { p.osc.onended = null; } catch (e) { /* ignore */ }
        if (!p.ended) { try { p.osc.stop(); } catch (e) { /* ignore */ } }
        if (!p.ended) {
          try { p.osc.disconnect(); } catch (e) { /* ignore */ }
          try { p.g.disconnect(); } catch (e) { /* ignore */ }
        }
      }
    }

    function ensureContext(t) {
      if (ctx) return ctx;
      if (t < noRetryUntil) return null;
      try {
        const c = createContextFn();
        if (!c || typeof c !== 'object') throw new Error('bad context');
        ctx = c;
        return ctx;
      } catch (e) {
        noRetryUntil = t + NO_AUDIO_RETRY_MS;
        diag('no_audio');
        return null;
      }
    }

    function resumeBounded(c) {
      return new Promise((resolve) => {
        let done = false;
        let timer = null;
        const fin = () => { if (!done) { done = true; clearT(timer); resolve(); } };
        timer = setT(fin, RESUME_BOUND_MS);
        try {
          const p = c.resume();
          if (p && typeof p.then === 'function') p.then(fin, fin); else fin();
        } catch (e) { fin(); }
      });
    }

    function schedule(c, cueDef, onCommit) {
      const base = (isNum(c.currentTime) ? c.currentTime : 0) + LEAD_S;
      const v = { parts: [], done: false, timer: null };
      let totalS = 0;
      let committed = false;
      try {
        const sample = samples.get(cueDef.id);
        const notes = sample ? [{ t: 0, dur: sample.duration, peak: 1 }] : cueDef.notes;
        for (const n of notes) {
          const s = base + n.t;
          const end = s + n.dur;
          const osc = sample ? c.createBufferSource() : c.createOscillator();
          const g = c.createGain();
          const part = { osc, g, ended: false };
          v.parts.push(part);
          const amp = Math.max(FLOOR, gain * cueDef.level * n.peak);
          if (sample) {
            osc.buffer = sample;
            g.gain.setValueAtTime(amp, s);
          } else {
            osc.type = n.type;
            osc.frequency.setValueAtTime(n.f, s);
            if (n.f2 !== undefined) osc.frequency.exponentialRampToValueAtTime(n.f2, end);
            g.gain.setValueAtTime(FLOOR, s);
            g.gain.linearRampToValueAtTime(amp, s + n.attack);
            g.gain.setValueAtTime(amp, end - n.release);
            g.gain.exponentialRampToValueAtTime(FLOOR, end);
          }
          osc.connect(g);
          g.connect(c.destination);
          osc.onended = () => {
            part.ended = true;
            try { osc.disconnect(); } catch (e) { /* ignore */ }
            try { g.disconnect(); } catch (e) { /* ignore */ }
            if (v.parts.every((p) => p.ended)) endVoice(v);
          };
          osc.start(s);
          if (!committed) { committed = true; onCommit(); }
          osc.stop(end + LEAD_S);
          totalS = Math.max(totalS, n.t + n.dur);
        }
      } catch (e) {
        endVoice(v);
        throw e;
      }
      voices.add(v);
      v.timer = setT(() => endVoice(v), (totalS + 0.25) * 1000);
    }

    // Resume continuations run serially; this also blocks synchronous re-entry from host audio nodes.
    let committing = false;
    async function start(item, c) {
      try {
        if (c.state === 'suspended') await resumeBounded(c);
        // Gates and limiter state may have changed while resume was pending.
        const g = gate(item.id);
        if (g) return result(false, g, item.id);
        const t = now();
        const vd = verdict(item.id, t);
        if (vd) return result(false, vd, item.id);
        for (const v of [...voices]) if (v.done) voices.delete(v);
        if (voices.size >= MAX_VOICES || committing) return result(false, 'rate_limited', item.id);
        committing = true;
        try {
          schedule(c, cues[item.id], () => {
            const committedAt = now();
            lastStart = committedAt;
            byId.set(item.id, committedAt);
            if (byId.size > 32) byId.delete(byId.keys().next().value);
          });
          return result(true, 'played', item.id);
        } finally { committing = false; }
      } catch {
        noRetryUntil = now() + NO_AUDIO_RETRY_MS;
        diag('context_error');
        return result(false, 'no_audio', item.id);
      }
    }

    function flush() {
      const p = pending;
      if (!p) return;
      pending = null;
      clearT(p.timer);
      let win = p.items[0];
      for (const it of p.items) if (PRIORITY[it.id] > PRIORITY[win.id]) win = it;
      for (const it of p.items) {
        if (it !== win) it.resolve(result(false, it.id === win.id ? 'duplicate' : 'outranked', it.id));
      }
      const t = now();
      const g = gate(win.id);
      if (g) return win.resolve(result(false, g, win.id));
      const vd = verdict(win.id, t);
      if (vd) return win.resolve(result(false, vd, win.id));
      for (const v of [...voices]) if (v.done) voices.delete(v);
      if (voices.size >= MAX_VOICES) return win.resolve(result(false, 'rate_limited', win.id));
      if (!ensureContext(t)) return win.resolve(result(false, 'no_audio', win.id));
      start(win, ctx).then(win.resolve, () => win.resolve(result(false, 'no_audio', win.id)));
    }

    function request(id) {
      const t = now();
      if (!pending) {
        const vd = verdict(id, t);
        if (vd) return Promise.resolve(result(false, vd, id));
      }
      return new Promise((resolve) => {
        let immediate = coalesceMs <= 0;
        if (!pending) {
          pending = { items: [], timer: null };
          if (!immediate) {
            pending.timer = setT(flush, coalesceMs);
            if (!pending.timer.ok) immediate = true;
          }
        }
        pending.items.push({ id, resolve });
        if (immediate) flush();
      });
    }

    function play(id) {
      try {
        const g = gate(id);
        if (g) return Promise.resolve(result(false, g, typeof id === 'string' && hasOwn(cues, id) ? id : null));
        return request(id).catch(() => result(false, 'no_audio', id));
      } catch {
        return Promise.resolve(result(false, 'no_audio', null));
      }
    }

    function stopAll() { for (const v of [...voices]) endVoice(v); }

    const engine = {
      // Ready AudioBuffer-like values only: decoding and file access belong to the host.
      setSample(id, buffer) {
        try {
          if (closed || typeof id !== 'string' || !hasOwn(cues, id)) return false;
          if (buffer === null) { samples.delete(id); return true; }
          if (!buffer || !isNum(buffer.duration) || buffer.duration <= 0
              || typeof buffer.getChannelData !== 'function') return false;
          samples.set(id, buffer);
          return true;
        } catch { return false; }
      },
      clearSamples() { samples.clear(); },
      ready() { ready = true; },
      quiet(ms) {
        const n = isNum(ms) ? Math.min(60000, Math.max(0, ms)) : 0;
        quietUntil = Math.max(quietUntil, now() + n);
      },
      setEnabled(v) { enabled = v === true; if (!enabled) stopAll(); },
      applyPrefs(prefs) {
        let on = false;
        try { on = isPlain(prefs) && prefs.v === 1 && prefs.sound === true; } catch { on = false; }
        enabled = on;
        if (!enabled) stopAll();
        return enabled;
      },
      setGain(n) { gain = clampGain(n); },
      isEnabled() { return enabled; },
      state() { return { enabled, gain, ready, quietUntil, closed }; },
      play,
      transition(key, activeNow, id) {
        try {
          if (typeof key !== 'string' || key.length < 1 || key.length > MAX_KEY_LEN) return undefined;
          const a = activeNow === true;
          const had = trans.has(key);
          const prev = trans.get(key);
          trans.delete(key);
          trans.set(key, a);
          while (trans.size > MAX_KEYS) trans.delete(trans.keys().next().value);
          if (had && !prev && a) return play(id);
        } catch { /* never throws */ }
        return undefined;
      },
      resetTransitions() { trans.clear(); },
      close() {
        if (closed) return;
        closed = true;
        samples.clear();
        if (pending) {
          const p = pending; pending = null; clearT(p.timer);
          for (const it of p.items) it.resolve(result(false, 'closed', it.id));
        }
        stopAll();
        if (ctx) {
          let reported = false;
          const reportCloseError = () => { if (!reported) { reported = true; diag('context_error'); } };
          try {
            const r = ctx.close();
            if (r && typeof r.catch === 'function') r.catch(reportCloseError);
          } catch { reportCloseError(); }
          ctx = null;
        }
      },
    };
    return Object.freeze(engine);
  }

  return Object.freeze({
    createSoundEngine, CUES: ALL_CUES, CUE_IDS, PRIORITY, DEFAULT_GAIN, MAX_GAIN,
    REASONS: deepFreeze(REASONS.slice()), DIAGNOSTICS: deepFreeze(DIAGNOSTICS.slice()),
  });
});

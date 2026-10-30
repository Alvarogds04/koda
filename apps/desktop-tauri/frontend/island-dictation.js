'use strict';
/* S10 (L30) — the dictation pill in the island, as Coucou's Flow pill (windows/src/pill/main.ts + pill.css @434d6a2b,
   Copyright (c) 2026 Louis Raillé, MIT; stroke icon paths from hub/ui.ts). Adapted for Abito: Coucou draws it in its own
   transparent window on a screen edge; Abito has one island window, so the pill sits in the EXPANDED island's header,
   centred. Mochi is not copied (LICENSE-ASSETS.md): the small character in the pill is Abito's clay engine.
   What it shows comes whole from Rust: `dictation:phase {phase}`, `dictation:bands {bands:[9]}` (about 30×/s while you
   speak) and `dictation:note {note}`; it sends only the closed verbs of `dictation_action`: status, hands_free, finish,
   cancel. It never starts the microphone by itself. #479 (human L32): when a dictation STARTS on a folded or hidden island it
   opens it (the closed host verb `expand`, like a new notice does) so the pill shows, and when the dictation ends it gives the
   island back with `close` — but only if THIS page opened it and the human has not pressed on the island since. A folded island
   that is not opened (dictation off) still shows a live dictation as a ring on the dot (island.css).
   Pure view-model first (Node-testable), then the browser-only mount at the tail (house pattern). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoIslandDictation = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const BANDS = 9;
  const PHASES = Object.freeze(['idle', 'listening', 'locked', 'thinking', 'copied', 'failed']);
  const NOTES = Object.freeze({
    needModel: 'Falta el modelo de voz: descargalo en Ajustes.',
    noMicrophone: 'No se encontró un micrófono.',
    clipboardRefused: 'El portapapeles no aceptó el texto.',
  });
  const NOTE_MS = 6000; // how long an announcement bubble stays (Coucou keeps it until dismissed; there is no host-side id here)
  /** A `dictation:phase` payload → a phase, or null (an unknown phase never changes anything). */
  const phaseOf = p => (isObject(p) && PHASES.includes(p.phase) ? p.phase : null);
  /** A `dictation:note` payload → its closed text, or null. Never echoes the payload. */
  const noteOf = p => (isObject(p) && typeof p.note === 'string' && Object.hasOwn(NOTES, p.note) ? NOTES[p.note] : null);
  /** A `dictation:bands` payload → exactly 9 numbers in 0..1 (missing/garbage = 0), or null when it is not a bands frame. */
  function bandsOf(p) {
    if (!isObject(p) || !Array.isArray(p.bands)) return null;
    return Array.from({ length: BANDS }, (_, i) => { const v = p.bands[i]; return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; });
  }
  /** Coucou's `look()`: which capsule the phase draws. «resting» is the thin idle capsule; «toolbar» is that capsule hovered. */
  function lookOf(phase, hovered) {
    switch (phase) {
      case 'locked': return 'handsFree';
      case 'listening': case 'thinking': return 'live';
      case 'copied': case 'failed': return 'message';
      default: return hovered ? 'toolbar' : 'resting';
    }
  }
  function messageOf(phase) {
    return phase === 'copied' ? 'Copiado · pegalo con Ctrl+V' : phase === 'failed' ? 'Micrófono no disponible' : null;
  }
  /** Coucou's `openLength`, horizontal only (the island header is horizontal). */
  function lengthOf(look, message) {
    switch (look) {
      case 'toolbar': return 150;
      case 'handsFree': return 158;
      case 'message': return Math.ceil((message || '').length * 6.4) + 22 + 9 + 26 + 2;
      case 'resting': return 44;
      default: return 118;
    }
  }
  /** The height of a dot for a level 0..1 (Coucou: 3.4 + 16 × level). */
  const barSize = level => 3.4 + 16 * Math.max(0, Math.min(1, level));
  /** The dot goal each frame: the voice while listening/locked, a slow wave while thinking. */
  function dotGoal(phase, now, i, target) {
    if (phase === 'thinking') return 0.25 + 0.25 * Math.sin(now / 160 - i * 0.7);
    if (phase === 'listening' || phase === 'locked') return target[i] || 0;
    return 0;
  }
  /** `dictation_action status` → whether the pill exists at all: only with the feature on. */
  const enabledIgnoringPause = s => isObject(s) && isObject(s.prefs) && s.prefs.enabled === true;
  // abito-pausa 0.1.2: a paused dictation has no pill (hidden, not grey); the stored preference is never rewritten.
  const pausedNow = () => { const P = typeof module === 'object' && module.exports ? require('./paused.js') : (typeof window !== 'undefined' ? window.AbitoPaused : null); return !!(P && P.paused('dictation')); };
  const enabledOf = s => !pausedNow() && enabledIgnoringPause(s);
  const LIVE = Object.freeze(['listening', 'locked', 'thinking']);
  /** #479: should this phase change open the island? Only the START of a dictation (idle/copied/failed → listening or locked)
      on a folded or hidden island, with dictation on. Same closed host verb as the notice reveal (`expand`). */
  function revealPlan({ phase, was, enabled, island }) {
    if (!enabled || !isObject(island)) return 'none';
    if (phase !== 'listening' && phase !== 'locked') return 'none';
    if (LIVE.includes(was)) return 'none';
    return island.state === 'hidden' || island.phase === 'compact' ? 'expand' : 'none';
  }
  /** #479: should this phase change give the island back? Only when WE opened it, the dictation is over (`idle`), the human has
      not touched the island since, and it still shows the plain overview (no chat, card, question or open settings). */
  function restorePlan({ phase, was, weExpanded, touched, island, noteEnded = false }) {
    if (!weExpanded || touched || phase !== 'idle' || !isObject(island)) return 'none';
    if (!LIVE.includes(was) && was !== 'copied' && was !== 'failed' && !noteEnded) return 'none';
    const calm = island.phase === 'expanded' && island.view === 'overview' && !island.card && island.settings !== 'open' && !['pending', 'expired', 'outcome'].includes(island.question);
    return calm ? 'collapse' : 'none';
  }
  /** The verbs the pill sends (closed). */
  const VERBS = Object.freeze({ handsFree: 'hands_free', finish: 'finish', cancel: 'cancel', status: 'status' });
  return { revealPlan, restorePlan, BANDS, PHASES, NOTES, NOTE_MS, VERBS, phaseOf, noteOf, bandsOf, lookOf, messageOf, lengthOf, barSize, dotGoal, enabledOf, enabledIgnoringPause };
});

function mount(api) {
  const doc = typeof document === 'object' ? document : null;
  const root = typeof window === 'object' ? window : null;
  if (!doc || !root) return;
  const capsuleEl = doc.getElementById('capsule');
  const header = doc.getElementById('island-header');
  if (!capsuleEl || !header) return;
  const internals = root.__TAURI_INTERNALS__;
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  const invoke = (root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.invoke) || (internals && internals.invoke);
  const listen = root.__TAURI__ && root.__TAURI__.event && root.__TAURI__.event.listen;
  if (!invoke || !listen || label === 'settings') return;

  const ICON = {
    mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3',
    x: 'M6.5 6.5l11 11M17.5 6.5l-11 11', check: 'M5 12.5 9.5 17 19 7.5',
    copy: 'M8.5 8.5h11v11.5h-11zM5 15.5V4h11', lock: 'M6.5 11h11v9h-11zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
    download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  };
  const NS = 'http://www.w3.org/2000/svg';
  const svgIcon = name => {
    const s = doc.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    const p = doc.createElementNS(NS, 'path'); p.setAttribute('d', ICON[name] || ''); s.append(p); return s;
  };
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };

  let enabled = false, phase = 'idle', hovered = false, note = null, noteTimer = null, unhover = null, frame = 0, last = 0;
  const target = new Array(api.BANDS).fill(0), levels = new Array(api.BANDS).fill(0);
  const host = el('div', 'dpill'); host.hidden = true; host.setAttribute('role', 'group'); host.setAttribute('aria-label', 'Dictado');
  const live = el('p', 'sr-only'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
  header.append(host, live);
  let capsule = null, lastKey = '', bars = null, clay = null;

  const say = verb => invoke('dictation_action', { payload: { action: verb } }).catch(() => {});
  // Enabling the shortcut does not start a dictation. Keep the header empty
  // until a host phase announces recording or a pending result; idle hides it again.
  const shown = () => enabled && (phase !== 'idle' || note !== null) && capsuleEl.dataset.phase === 'expanded' && capsuleEl.dataset.view !== 'chat';
  function pbtn(icon, name, action, opts = {}) {
    const b = el('button', ['pbtn', opts.small ? 'small' : '', opts.filled ? 'filled' : ''].filter(Boolean).join(' '));
    b.type = 'button'; b.setAttribute('aria-label', name); b.title = name; b.append(svgIcon(icon));
    b.addEventListener('click', e => { if (e.isTrusted !== true) return; e.stopPropagation(); action(); });
    return b;
  }
  function barsEl() { const s = el('span', 'bars'); s.setAttribute('aria-hidden', 'true'); for (let i = 0; i < api.BANDS; i++) s.append(el('i')); return s; }
  function claySlot() {
    const slot = el('span', 'dclay'); slot.setAttribute('aria-hidden', 'true');
    const svg = doc.createElementNS(NS, 'svg'); svg.setAttribute('class', 'dclay-svg'); svg.setAttribute('width', '22'); svg.setAttribute('height', '22'); slot.append(svg);
    queueMicrotask(() => { try { if (typeof AbitoClay !== 'undefined') { clay?.destroy(); clay = AbitoClay.create(svg, { state: phase === 'thinking' ? 'thinking' : 'idle', live: doc.documentElement.dataset.motion !== 'reduce', viewBox: '36 32 128 128', shadow: false }); } } catch { /* the character is decoration */ } });
    return slot;
  }
  function content(look) {
    const c = el('div', 'dcontent');
    switch (look) {
      case 'toolbar': c.append(claySlot(), pbtn('mic', 'Dictar con manos libres', () => say(api.VERBS.handsFree))); break;
      case 'handsFree': bars = barsEl(); c.append(pbtn('x', 'Cancelar', () => say(api.VERBS.cancel), { small: true }), bars, pbtn('check', 'Pegar', () => say(api.VERBS.finish), { small: true, filled: true })); break;
      case 'message': c.append(claySlot(), el('span', 'dmessage', api.messageOf(phase) || '')); break;
      case 'live': bars = barsEl(); c.append(claySlot(), bars); break;
      default: break;
    }
    return c;
  }
  function render() {
    const show = shown(); // `enabled` is part of shown(): the pill does not exist while dictation is off
    host.hidden = !show;
    // the folded dot wears a ring while a dictation is live (island.css); only a LIVE phase, never `idle`/the result messages
    if (enabled && (phase === 'listening' || phase === 'locked' || phase === 'thinking')) capsuleEl.dataset.dictation = phase; else delete capsuleEl.dataset.dictation;
    if (!show) { cancelAnimationFrame(frame); frame = 0; return; }
    const look = api.lookOf(phase, hovered), open = look !== 'resting';
    const key = `${look}|${phase === 'thinking'}`;
    if (!capsule || key !== lastKey) {
      lastKey = key; bars = null; clay?.destroy(); clay = null;
      const next = el('div', 'dcapsule'); next.append(content(look));
      if (capsule) { next.style.width = capsule.style.width; next.style.height = capsule.style.height; }
      capsule?.remove(); capsule = next;
      host.replaceChildren(...(note ? [bubble()] : []), capsule);
    } else if (Boolean(host.querySelector('.dbubble')) !== Boolean(note)) host.replaceChildren(...(note ? [bubble()] : []), capsule);
    capsule.classList.toggle('open', open); capsule.classList.toggle('handsfree', look === 'handsFree');
    requestAnimationFrame(() => { if (capsule) { capsule.style.width = api.lengthOf(look, api.messageOf(phase)) + 'px'; capsule.style.height = (open ? 34 : 8) + 'px'; } });
    wake();
  }
  function bubble() {
    const b = el('div', 'dbubble'); const icon = el('span', 'dicon'); icon.append(svgIcon(note.icon)); b.append(icon, el('span', 'dtext', note.text));
    const close = el('button', 'dclose'); close.type = 'button'; close.setAttribute('aria-label', 'Cerrar aviso'); close.append(svgIcon('x'));
    close.addEventListener('click', e => { if (e.isTrusted === true) setNote(null); }); b.append(close); return b;
  }
  function setNote(text, icon) {
    clearTimeout(noteTimer); noteTimer = null;
    note = text ? { text, icon: icon || 'mic' } : null;
    live.textContent = text || '';
    if (text) {
      noteTimer = setTimeout(() => setNote(null), api.NOTE_MS);
      // A missing model emits only a note, never a listening phase. Reveal that
      // feedback too, without making the idle microphone toolbar permanent.
      if (enabled && (island().phase === 'compact' || island().state === 'hidden')) {
        touched = false;
        hostCall('expand', ok => { if (ok) weExpanded = true; render(); });
      }
    } else if (api.restorePlan({ phase, was: phase, weExpanded, touched, island: island(), noteEnded: true }) === 'collapse') {
      weExpanded = false;
      hostCall('close');
    }
    render();
  }
  function tick(now) {
    frame = 0;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (bars) for (let i = 0; i < api.BANDS; i++) {
      levels[i] += (api.dotGoal(phase, now, i, target) - levels[i]) * Math.min(1, dt * 14);
      bars.children[i].style.height = api.barSize(levels[i]) + 'px';
    }
    if (shown() && (phase === 'listening' || phase === 'locked' || phase === 'thinking') && !doc.hidden) frame = requestAnimationFrame(tick);
  }
  function wake() { if (!frame && bars && shown() && !doc.hidden) { last = performance.now(); frame = requestAnimationFrame(tick); } }

  function setHovered(inside) {
    if (inside) { clearTimeout(unhover); unhover = null; if (!hovered) { hovered = true; render(); } }
    else if (hovered && unhover === null) unhover = setTimeout(() => { unhover = null; hovered = false; render(); }, 250);
  }
  host.addEventListener('pointerenter', () => setHovered(true));
  host.addEventListener('pointerleave', () => setHovered(false));

  // #479: a dictation that starts on a folded island opens it so the pill shows; when it ends, the island goes back to what it
  // was — but only if WE opened it and the human has not taken it since (a trusted press on the island).
  let weExpanded = false, touched = false, flight = false, current = null;
  const island = () => ({ phase: capsuleEl.dataset.phase, view: capsuleEl.dataset.view, card: capsuleEl.dataset.card, question: capsuleEl.dataset.question, settings: capsuleEl.dataset.settings, state: current && current.state });
  const desktop = () => root.desktop;
  try {
    if (desktop()?.snapshot) desktop().snapshot().then(s => { current = s; }, () => {});
    if (desktop()?.onState) desktop().onState(s => { current = s; });
  } catch { /* the facade is optional */ }
  capsuleEl.addEventListener('pointerdown', e => { if (e.isTrusted === true) touched = true; }, true);
  function hostCall(verb, done) {
    if (flight) return; const d = desktop();
    if (!d || typeof d[verb] !== 'function') return;
    flight = true;
    d[verb]().then(snap => { if (snap) current = snap; flight = false; if (done) done(true); }, () => { flight = false; if (done) done(false); });
  }
  listen('dictation:phase', e => {
    const next = api.phaseOf(e && e.payload);
    if (next === null) return;
    if (next === 'listening') target.fill(0);
    if (api.revealPlan({ phase: next, was: phase, enabled, island: island() }) === 'expand') {
      touched = false;
      hostCall('expand', ok => { if (ok) weExpanded = true; });
    } else if (api.restorePlan({ phase: next, was: phase, weExpanded, touched, island: island() }) === 'collapse') {
      weExpanded = false;
      hostCall('close');
    } else if (next === 'idle') weExpanded = weExpanded && capsuleEl.dataset.phase === 'expanded' && !touched;
    phase = next; render();
  }).catch(() => {});
  listen('dictation:bands', e => { const b = api.bandsOf(e && e.payload); if (!b) return; for (let i = 0; i < api.BANDS; i++) target[i] = b[i]; wake(); }).catch(() => {});
  listen('dictation:note', e => {
    const text = api.noteOf(e && e.payload);
    if (text) setNote(text, e.payload.note === 'needModel' ? 'download' : e.payload.note === 'clipboardRefused' ? 'copy' : 'mic');
  }).catch(() => {});
  // `status` also lists the microphones, so it is asked at boot and when the island opens (at most every 5 s), not on a timer
  let askedAt = 0;
  const refresh = () => {
    if (Date.now() - askedAt < 5000) return; askedAt = Date.now();
    invoke('dictation_action', { payload: { action: api.VERBS.status } }).then(s => { enabled = api.enabledOf(s); render(); }, () => { enabled = false; render(); });
  };
  if (typeof MutationObserver !== 'undefined') new MutationObserver(() => { if (capsuleEl.dataset.phase === 'expanded') refresh(); render(); }).observe(capsuleEl, { attributes: true, attributeFilter: ['data-phase', 'data-view'] });
  doc.addEventListener('visibilitychange', render);
  refresh();
}

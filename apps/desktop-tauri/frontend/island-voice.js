'use strict';
/* #488 — «OK Abito» in the island. Listens to the voice host's events and uses only the island's
   existing public verbs (`window.desktop.expand` / `close`), like island-dictation.js. It never starts
   the microphone: the host does, and only while Settings → OK Abito is on.
   Events (all from Rust, `voicehost.rs`): `voice-wake {}`, `voice-command {text}`, `voice-timeout {}`,
   `voice-result {outcome, message, lang}`, `voice-ask {text}`.
   Adapted from Coucou NotchBuddy Voice/{VoiceIslandView,VoiceResultView}.swift @71b773f,
   Copyright (c) 2026 Louis Raillé, MIT. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoIslandVoice = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const OUTCOMES = Object.freeze(['success', 'failure', 'question']);
  const FADE_MS = 200;
  const RESULT_MS = 2000; // NotchBuddy shows the result for about 2 s
  const MAX_TEXT = 400;
  const clean = s => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_TEXT) : '');
  /** `voice-command {text}` → the words heard, or null. */
  const heardOf = p => (isObject(p) && typeof p.text === 'string' ? clean(p.text) : null);
  /** `voice-result {…}` → {outcome, message} or null (an unknown outcome changes nothing). */
  function resultOf(p) {
    if (!isObject(p) || !OUTCOMES.includes(p.outcome)) return null;
    return { outcome: p.outcome, message: clean(p.message) };
  }
  /** `voice-ask {text}` → the question for the chat, or null. */
  const askOf = p => { const t = isObject(p) && typeof p.text === 'string' ? clean(p.text).trim() : ''; return t || null; };
  /** Open the island on a wake only when it is folded or hidden. */
  const revealPlan = island => (island && (island.state === 'hidden' || island.phase === 'compact') ? 'expand' : 'none');
  return { OUTCOMES, FADE_MS, RESULT_MS, MAX_TEXT, heardOf, resultOf, askOf, revealPlan };
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
  const listen = root.__TAURI__ && root.__TAURI__.event && root.__TAURI__.event.listen;
  if (!listen || label === 'settings') return;

  const bar = doc.createElement('div');
  bar.className = 'voicebar'; bar.hidden = true; bar.setAttribute('role', 'status'); bar.setAttribute('aria-live', 'polite');
  header.append(bar);
  let timer = 0, weExpanded = false, flight = false;
  let fade = 0;
  // Fade in/out in 0.2 s (island-voice.css); `hidden` only after the fade-out ends.
  const show = (text, kind) => {
    clearTimeout(fade);
    if (!text) { bar.classList.remove('on'); fade = setTimeout(() => { bar.hidden = true; }, api.FADE_MS); return; }
    bar.textContent = text; bar.dataset.kind = kind || ''; bar.hidden = false;
    void bar.offsetWidth; bar.classList.add('on');
  };
  const hide = () => { clearTimeout(timer); timer = 0; show('', ''); };
  const later = ms => { clearTimeout(timer); timer = setTimeout(() => { hide(); giveBack(); }, ms); };
  const desktop = () => root.desktop;
  function hostCall(verb, done) {
    const d = desktop();
    if (flight || !d || typeof d[verb] !== 'function') return;
    flight = true;
    d[verb]().then(() => { flight = false; done && done(true); }, () => { flight = false; done && done(false); });
  }
  function giveBack() {
    if (weExpanded && capsuleEl.dataset.phase === 'expanded') hostCall('close');
    weExpanded = false;
  }
  const island = () => ({ state: capsuleEl.dataset.state, phase: capsuleEl.dataset.phase });
  capsuleEl.addEventListener('pointerdown', e => { if (e.isTrusted === true) weExpanded = false; }, true);

  listen('voice-wake', () => {
    if (api.revealPlan(island()) === 'expand') hostCall('expand', ok => { if (ok) weExpanded = true; });
    show('Te escucho…', 'listening');
  }).catch(() => {});
  listen('voice-command', e => { const t = api.heardOf(e && e.payload); if (t) show(t, 'heard'); }).catch(() => {});
  listen('voice-timeout', () => { hide(); giveBack(); }).catch(() => {});
  listen('voice-result', e => {
    const r = api.resultOf(e && e.payload);
    if (!r) return;
    show(r.message, r.outcome);
    // A question keeps the bar until the answer or the host's timeout; the rest fades after ~2 s.
    if (r.outcome === 'question') clearTimeout(timer); else later(api.RESULT_MS);
  }).catch(() => {});
}

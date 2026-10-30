'use strict';
/* S10 (L22) — the island header of Coucou, in every expanded state: home / chat / «+» on the left,
   gear / mute on the right (Adapted from Coucou windows/src/views/views.ts buildHeader @434d6a2b,
   Copyright (c) 2026 Louis Raillé, MIT; the icon paths are Coucou's views/icons.ts, vendored).
   Abito's own functions sit in Coucou's slots:
     «+»  Coucou: the Drop tab. Abito: a NEW conversation in the chat (the chat already takes attachments).
     mute Coucou: toggleSound. Abito: the existing `prefs_action` sound_on / sound_off (the same pref as Ajustes).
     gear Coucou: settings view. Abito: the settings window (settings.js owns that click).
   Pure view-model first (Node-testable), then the browser-only mount at the tail (house pattern). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoIslandHeader = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  /** The mute button for a prefs snapshot. Anything off-shape reads as «sound on» (the default, never a guess of mute). */
  function soundView(prefs) {
    const on = !isObject(prefs) || prefs.sound !== false;
    return on
      ? { on: true, icon: 'speakerOn', label: 'Silenciar', pressed: false, action: 'sound_off' }
      : { on: false, icon: 'speakerOff', label: 'Activar sonido', pressed: true, action: 'sound_on' };
  }
  /** The closed icon names the header may draw (the paths come from the vendored module, never from the page). */
  const ICON_NAMES = Object.freeze(['house', 'bubble', 'plus', 'gear', 'speakerOn', 'speakerOff', 'chevronUp']);
  /** Coucou draws chevrons as strokes (views.ts foldButton: svg(ICONS.chevronUp, 8, {stroke: 2.4})); every other glyph is a fill. */
  const STROKE = Object.freeze({ chevronUp: 2.4 });
  return { soundView, ICON_NAMES, STROKE };
});

function mount(api) {
  const doc = typeof document === 'object' ? document : null;
  const root = typeof window === 'object' ? window : null;
  if (!doc || !root) return;
  const header = doc.getElementById('island-header');
  if (!header) return;
  const internals = root.__TAURI_INTERNALS__;
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  const invoke = (root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.invoke) || (internals && internals.invoke);
  const listen = root.__TAURI__ && root.__TAURI__.event && root.__TAURI__.event.listen;
  const NS = 'http://www.w3.org/2000/svg';
  let ICONS = null;

  function draw(slot, name, size) {
    if (!ICONS || !api.ICON_NAMES.includes(name) || typeof ICONS[name] !== 'string') return;
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size)); svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(NS, 'path'); path.setAttribute('d', ICONS[name]);
    if (api.STROKE[name]) { path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', String(api.STROKE[name])); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); }
    else path.setAttribute('fill', 'currentColor');
    svg.append(path); slot.replaceChildren(svg);
  }
  const SIZE = { house: 13, bubble: 13, plus: 13, gear: 14, speakerOn: 14, speakerOff: 14, chevronUp: 8 };
  const paint = () => { for (const slot of doc.querySelectorAll('[data-cc-icon]')) draw(slot, slot.dataset.ccIcon, SIZE[slot.dataset.ccIcon] || 14); };

  const mute = doc.getElementById('toggle-sound');
  let view = api.soundView(null);
  function paintSound() {
    if (!mute) return;
    mute.setAttribute('aria-label', view.label); mute.setAttribute('aria-pressed', view.pressed ? 'true' : 'false'); mute.title = view.label;
    const slot = mute.querySelector('[data-cc-icon]'); if (slot) { slot.dataset.ccIcon = view.icon; draw(slot, view.icon, 14); }
  }
  const apply = prefs => { view = api.soundView(prefs); paintSound(); };

  import('./vendor/coucou/views/icons.js').then(m => { ICONS = m.ICONS; paint(); paintSound(); }).catch(() => {});

  if (label !== 'settings' && invoke) {
    let soundChanges = Promise.resolve();
    const toggleSound = () => {
      soundChanges = soundChanges.then(async () => {
        // Serialize clicks/global presses and re-read the same persisted pref
        // used by Settings; two presses must not both apply a stale action.
        apply(await invoke('prefs_action', { payload: { action: 'view' } }));
        apply(await invoke('prefs_action', { payload: { action: view.action } }));
      }).catch(() => {
        const live = doc.getElementById('notice-live');
        if (live) live.textContent = 'No se pudo cambiar el sonido.';
      });
    };
    if (mute) mute.addEventListener('click', e => {
      if (e.isTrusted !== true) return;
      toggleSound();
    });
    if (listen) listen('global-shortcut', e => { if (e && e.payload === 'muteToggle') toggleSound(); }).catch(() => {});
    invoke('prefs_action', { payload: { action: 'view' } }).then(apply, () => {});
    if (listen) listen('prefs:state', e => apply(e && e.payload)).catch(() => {});
  }
  // «+»: open the chat and start a new conversation there (the buttons' own handlers do the work).
  const plus = doc.getElementById('open-new');
  if (plus) plus.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    const chat = doc.getElementById('open-chat'), create = doc.getElementById('chat-create');
    if (chat) chat.click();
    if (create) setTimeout(() => create.click(), 0);
  });
}

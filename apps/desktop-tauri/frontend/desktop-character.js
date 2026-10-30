'use strict';
/* #486 desktop character page. Adapted from Coucou windows/src/desktop/main.ts @71b773f,
   Copyright (c) 2026 Louis Raillé, MIT. Draws Abito's clay character and forwards the pointer to
   the closed Rust verbs; where the window is, and what happens on a drop, is Rust's decision. */
(() => {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) || null;
  const svg = document.getElementById('clay');
  const call = (name, args) => (invoke ? invoke(name, args).catch(() => undefined) : Promise.resolve(undefined));
  let clay = null;
  try {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    clay = window.AbitoClay.create(svg, { state: 'idle', live: !reduce, viewBox: '36 32 128 128', shadow: false });
  } catch { /* the character is decoration; the window still drags */ }
  const DRAG_THRESHOLD = 3; // Coucou DRAG_THRESHOLD
  let press = null;
  let dragging = false;
  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    press = { x: e.screenX, y: e.screenY, id: e.pointerId };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', e => {
    if (!press || e.pointerId !== press.id) return;
    if (!dragging) {
      if (Math.hypot(e.screenX - press.x, e.screenY - press.y) <= DRAG_THRESHOLD) return;
      dragging = true;
      svg.classList.add('dragging');
      call('character_drag_begin', { x: press.x, y: press.y });
    }
    call('character_drag_move', { x: e.screenX, y: e.screenY });
  });
  const release = e => {
    if (!press || e.pointerId !== press.id) return;
    const was = dragging;
    press = null;
    dragging = false;
    svg.classList.remove('dragging');
    if (was) call('character_drag_end', {});
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);
  svg.addEventListener('dblclick', () => call('character_home', {}));
  // The island tells the page what to draw (state, emotes); Rust feeds the pointer for the eyes.
  const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
  if (listen) {
    const L = window.AbitoCharacterDesktop;
    listen('desktop-character-state', e => {
      const next = e && e.payload && e.payload.state;
      if (clay && typeof next === 'string' && clay.state !== next) clay.setState(next);
    });
    listen('desktop-character-emote', e => {
      const name = e && e.payload && e.payload.emote;
      if (clay && typeof name === 'string') clay.triggerEmote(name);
    });
    listen('desktop-character-cursor', e => {
      const p = e && e.payload;
      if (!clay || !L || !p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
      const g = L.gaze({ x: L.PANEL_SIZE / 2, y: L.PANEL_SIZE / 2 }, { x: p.x, y: p.y });
      // Coucou lookY is up-positive; the clay engine's gazeT.y is down-positive.
      clay.S.gazeT = { x: g.lookX, y: -g.lookY };
      clay.S.nextGaze = clay.S.t + 1.2;
    });
  }
  window.addEventListener('beforeunload', () => { try { if (clay) clay.destroy(); } catch { /* ignore */ } });
})();

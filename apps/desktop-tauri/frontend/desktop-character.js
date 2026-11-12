'use strict';
/* #486 desktop character page. Adapted from Coucou windows/src/desktop/main.ts @71b773f,
   Copyright (c) 2026 Louis Raillé, MIT. Draws Koda (island-free-drag S7: the Koda cat only, never the clay blob) and forwards
   the pointer to the closed Rust verbs; where the window is, and what happens on a drop, is Rust's decision. */
(() => {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) || null;
  const svg = document.getElementById('clay'); // the transparent hit area the pointer handlers below listen on
  const call = (name, args) => (invoke ? invoke(name, args).catch(() => undefined) : Promise.resolve(undefined));
  // S7: Koda is painted from the island's own spritesheet (koda-catalog.js) with the island's frame rules (koda-logic.js).
  const KC = window.KodaCatalog, KL = window.KodaLogic;
  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const now = () => performance.now();
  const BOX = 120, CELL = 32, K = Math.min(3, Math.floor(BOX / CELL)); // 32 px x3 = 96 px: the largest integer scale, crisp
  const koda = { el: null, anim: null, t0: 0, pose: 'idle', emote: null, emoteUntil: 0 };
  if (KC && KL && KC.SHEETS[CELL]) {
    const el = document.createElement('div');
    el.className = 'koda-sprite'; el.setAttribute('aria-hidden', 'true');
    const px = CELL * K, sh = KC.SHEETS[CELL], st = el.style;
    st.width = st.height = px + 'px';
    st.left = st.top = Math.round((BOX - px) / 2) + 'px';
    st.backgroundImage = `url(${sh.file})`;
    st.backgroundSize = `${sh.w * K}px ${sh.h * K}px`;
    document.body.appendChild(el);
    koda.el = el;
  }
  const animFor = () => {
    if (koda.emote && now() < koda.emoteUntil) return koda.emote;
    const a = KL && KL.POSE_TO_ANIM[koda.pose];
    return a && KC.CATALOG[a] ? a : 'respirar'; // idle = the awake, breathing Koda (koda-skin.js flowAnim), not the sleepy «reposo» with its z
  };
  function paint() {
    if (!koda.el) return;
    const id = animFor(), a = KC.CATALOG[id];
    if (koda.anim !== id) { koda.anim = id; koda.t0 = now(); koda.el.dataset.anim = id; }
    const px = CELL * K, frame = KL.frameAt(id, now() - koda.t0, reduced);
    koda.el.style.backgroundPosition = `${-frame * px}px ${-a.row * px}px`;
  }
  function tick() { try { paint(); } catch { /* the character is decoration; the window still drags */ } if (!reduced) requestAnimationFrame(tick); }
  requestAnimationFrame(tick);
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
  // The island tells the page what to draw (state, emotes). Koda's pixel art has no eyes to steer, so the cursor feed is unused.
  const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
  if (listen) {
    listen('desktop-character-state', e => {
      const next = e && e.payload && e.payload.state;
      if (typeof next === 'string') { koda.pose = next; if (reduced) paint(); }
    });
    listen('desktop-character-emote', e => {
      const name = e && e.payload && e.payload.emote, a = KL && KL.REACTION_TO_ANIM[name];
      if (!a || !KC.CATALOG[a]) return;
      const c = KC.CATALOG[a];
      koda.emote = a; koda.emoteUntil = now() + (c.loop ? 1500 : c.sequence.length / c.fps * 1000);
      if (reduced) paint();
    });
  }
})();

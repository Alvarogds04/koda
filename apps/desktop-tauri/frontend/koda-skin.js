'use strict';
/* HU-056: Koda Chibi replaces the Dot wherever the app draws ABITO ITSELF (compact bar, overview card, question/approval/notice cards,
   chat companion = the #clay svg; the Sileo question toast; the principal «Abito» pill). Other agents' avatars are untouched.
   Additive: clay-engine.js stays byte-identical (R6 pin). We wrap AbitoClay.create only to observe the Dot's own pose, and hide the Dot
   with opacity 0 so layout and hit areas do not change. Rules live in koda-logic.js (pure, tested); this file only reads the DOM and paints. */
(function () {
  if (typeof AbitoClay === 'undefined' || !window.KodaLogic || window.__kodaSkinLoaded) return;
  window.__kodaSkinLoaded = true;
  const { CATALOG, SHEETS } = window.KodaCatalog, L = window.KodaLogic;
  document.documentElement.dataset.koda = '1';
  const now = () => performance.now();
  const reducedNow = () => document.documentElement.dataset.motion === 'reduce' || AbitoClay.reducedNow();

  const tracked = { main: null, toast: null, pill: null };
  const origCreate = AbitoClay.create.bind(AbitoClay);
  AbitoClay.create = function (svg, opts) {
    const inst = origCreate(svg, opts);
    try {
      if (svg && svg.id === 'clay') tracked.main = inst;
      else if (svg && svg.classList) {
        if (svg.classList.contains('q-toast-abito')) tracked.toast = inst;
        else if (svg.classList.contains('island-agent-clay') && svg.parentNode && svg.parentNode.dataset && svg.parentNode.dataset.pillId === 'abito') tracked.pill = inst;
      }
    } catch { /* decoration only */ }
    return inst;
  };

  function makeSlot(kind, pref) {
    const el = document.createElement('div');
    el.className = 'koda-sprite'; el.dataset.kodaSlot = kind; el.setAttribute('aria-hidden', 'true');
    return { el, pref, anim: null, t0: 0, cell: 0, k: 0 };
  }
  function draw(slot, id, boxPx) {
    if (!CATALOG[id]) return 0;
    if (slot.anim !== id) { slot.anim = id; slot.t0 = now(); }
    const lay = L.layoutFor(id, slot.pref, boxPx), sh = SHEETS[lay.cell], st = slot.el.style, px = lay.cell * lay.k;
    if (slot.cell !== lay.cell || slot.k !== lay.k) {
      slot.cell = lay.cell; slot.k = lay.k;
      st.width = st.height = px + 'px';
      st.backgroundImage = `url(${sh.file})`;
      st.backgroundSize = `${sh.w * lay.k}px ${sh.h * lay.k}px`;
    }
    const frame = L.frameAt(id, now() - slot.t0, reducedNow());
    st.backgroundPosition = `${-frame * px}px ${-CATALOG[id].row * px}px`;
    slot.el.dataset.anim = id;
    return px;
  }

  const ctx = { running: false, progress: null, pointerOver: false };
  document.addEventListener('abito:sessions-view', e => {
    const v = e.detail && e.detail.view, focusId = e.detail && e.detail.focusId;
    ctx.running = !!(v && v.state === 'ready' && Array.isArray(v.rows) && v.rows.some(r => r && r.state === 'running'));
    // HU-070 S2: the focused session's «n/N» tool counter; every step in the window done and total > 0 = N of N
    const row = v && v.state === 'ready' && Array.isArray(v.rows) ? v.rows.find(r => r && r.id === focusId) : null, tl = row && row.tools;
    ctx.progress = tl && Number.isSafeInteger(tl.total) && tl.total > 0 && Array.isArray(tl.steps) && tl.steps.length
      ? { id: focusId, done: tl.steps.every(x => x.state === 'done') ? tl.total : tl.total - 1, total: tl.total } : null;
  });
  const brain = L.createBrain({ now });
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel']) document.addEventListener(ev, () => brain.poke(), { passive: true, capture: true });
  // HU-070 S5: pointer over / click on Koda. The sprite is pointer-events:none (layout and hit areas stay the app's), so test its box.
  const overKoda = e => { const el = mainSlot.el; if (!el.parentNode || el.hidden) return false; const r = el.getBoundingClientRect();
    return r.width > 0 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; };
  document.addEventListener('pointermove', e => { ctx.pointerOver = overKoda(e); }, { passive: true, capture: true });
  document.addEventListener('pointerleave', () => { ctx.pointerOver = false; }, { passive: true, capture: true });
  document.addEventListener('pointerdown', e => { if (overKoda(e)) brain.click(); }, { passive: true, capture: true });

  const cap = () => document.getElementById('capsule');
  const visible = el => !!el && !el.hidden && getComputedStyle(el).display !== 'none';
  function inputs() {
    const d = cap() ? cap().dataset : {}, inst = tracked.main, band = document.getElementById('engine-band'), flag = document.getElementById('compact-flag');
    const title = document.getElementById('notice-title'), ci = document.getElementById('chat-input'), nc = document.getElementById('notice-card');
    return {
      pose: inst ? inst.state : 'idle', reaction: inst ? inst.reaction : null,
      phase: d.phase === 'expanded' || d.phase === 'expanding' ? 'open' : 'compact', hidden: d.edgeHidden === 'true', view: d.view || null,
      noticeView: d.noticeView || null, noticeAttention: !!(title && /permiso|pide|respond/i.test(title.textContent)),
      noticeError: !!nc && nc.dataset.severity === 'error',
      engineBad: visible(band) || (visible(flag) && flag.dataset.tone === 'red'),
      progress: ctx.progress, pointerOver: ctx.pointerOver, reduced: reducedNow(),
      running: ctx.running, composerFocused: d.view === 'chat' && !!ci && document.activeElement === ci,
    };
  }

  // Opaque-pixel bounds of an animation (union of its frames) on its sheet, measured once: the sprites are bottom-aligned, so the cell's
  // centre is NOT where Koda is drawn. The fitted compact pill centres the DRAWN pixels (human, 29-oct: «esto no esta centrado koda»).
  const inkCache = new Map(), sheetPix = new Map();
  function inkOf(id, lay) {
    const key = lay.cell + ':' + id; if (inkCache.has(key)) return inkCache.get(key);
    try {
      const sh = SHEETS[lay.cell]; let pix = sheetPix.get(lay.cell);
      if (!pix) {
        const img = new Image(); img.src = sh.file; if (!img.complete || !img.naturalWidth) return null;
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0); pix = { x }; sheetPix.set(lay.cell, pix);
      }
      const a = CATALOG[id], n = lay.cell; let t = n, b = -1, l = n, r = -1;
      for (let f = 0; f < a.frames; f++) {
        const d = pix.x.getImageData(f * n, a.row * n, n, n).data;
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (d[(j * n + i) * 4 + 3] > 40) { if (j < t) t = j; if (j > b) b = j; if (i < l) l = i; if (i > r) r = i; }
      }
      const ink = b < 0 ? null : { t, b: b + 1, l, r: r + 1 };
      inkCache.set(key, ink); return ink;
    } catch { inkCache.set(key, null); return null; }
  }
  const mainSlot = makeSlot('main', 'auto'), toastSlot = makeSlot('toast', 'small'), pillSlot = makeSlot('pill', 'small');
  function placeMain(id) {
    const clayEl = document.getElementById('clay'), island = document.getElementById('island');
    if (!clayEl || !island) return;
    const nusa = document.getElementById('nusa'), right = document.getElementById('nusa-right');
    if (nusa && right && getComputedStyle(nusa).display !== 'none') { // HU-057: expanded idle overview = Nusa notch, Koda x2 beside the state chip
      if (mainSlot.el.parentNode !== right) right.prepend(mainSlot.el);
      mainSlot.pref = 'nusa'; mainSlot.el.hidden = false; mainSlot.el.dataset.kodaSlot = 'nusa';
      let box = 64;
      const tk = cap() && cap().dataset.takeover; // an engine band alone (takeover error in the overview) keeps the Inicio x2 on the right
      if (tk && !(tk === 'error' && cap().dataset.view === 'overview')) { // take-over cards: Koda is big, on the left, the largest integer scale that fits the column (width and height)
        const col = document.getElementById('nusa-body'), cb = col ? col.getBoundingClientRect() : null;
        mainSlot.pref = 'nusa-big'; box = cb && cb.width > 0 ? Math.min(cb.width, cb.height) : 64;
      }
      draw(mainSlot, id, box);
      return;
    }
    const body = document.getElementById('chat-body');
    if (body && cap() && cap().dataset.view === 'chat' && cap().dataset.phase === 'expanded') { // chat: BIG Koda centred in the free left column (the chat content is padded right in island-nusa.css)
      if (mainSlot.el.parentNode !== island) clayEl.after(mainSlot.el);
      mainSlot.pref = 'nusa-chat'; mainSlot.el.dataset.kodaSlot = 'nusa-chat';
      const ir = island.getBoundingClientRect(), br = body.getBoundingClientRect();
      const colR = br.left + (parseFloat(getComputedStyle(body).paddingLeft) || 0), colW = colR - ir.left, colH = br.height;
      mainSlot.el.hidden = !(colW > 0 && colH > 0);
      const px = draw(mainSlot, id, Math.min(colW, colH));
      if (!px || mainSlot.el.hidden) return;
      mainSlot.el.style.left = Math.round((ir.left + colR) / 2 - ir.left - px / 2) + 'px';
      mainSlot.el.style.top = Math.round(br.top + br.height / 2 - ir.top - px / 2) + 'px';
      return;
    }
    mainSlot.el.dataset.kodaSlot = 'main';
    if (mainSlot.el.parentNode !== island) clayEl.after(mainSlot.el);
    const r = clayEl.getBoundingClientRect(), ir = island.getBoundingClientRect();
    const box = parseFloat(clayEl.style.width) || r.width;
    mainSlot.pref = box < 28 ? 'small' : 'auto';
    const shown = r.width > 0 && getComputedStyle(clayEl).display !== 'none';
    mainSlot.el.hidden = !shown;
    const px = draw(mainSlot, id, box);
    if (!px || !shown) return;
    mainSlot.el.style.left = Math.round(r.left + r.width / 2 - ir.left - px / 2) + 'px';
    mainSlot.el.style.top = Math.round(r.top + r.height / 2 - ir.top - px / 2) + 'px';
    if (cap() && cap().dataset.pillFit === 'true' && cap().dataset.phase === 'compact') { // fitted pill: the drawn pixels, not the cell, are centred
      const k = mainSlot.k || 1, ink = inkOf(id, { cell: mainSlot.cell }), N = window.AbitoNusa;
      if (ink) {
        mainSlot.el.style.top = Math.round(ir.height / 2 - (ink.t + ink.b) / 2 * k) + 'px';
        const bare = cap().dataset.pillBare === 'true', pad = N && N.COMPACT ? N.COMPACT.padLeft : 8;
        mainSlot.el.style.left = Math.round(bare ? ir.width / 2 - (ink.l + ink.r) / 2 * k : pad - ink.l * k) + 'px';
      }
    }
  }
  const flowAnim = (inst, fallback) => { const a = inst ? L.POSE_TO_ANIM[inst.state] || (inst.state === 'idle' ? 'respirar' : fallback) : fallback; return a; };
  function placeFlow(main) {
    const toastSvg = document.querySelector('.q-toast-badge .q-toast-abito');
    if (toastSvg) { if (toastSvg.nextSibling !== toastSlot.el) toastSvg.after(toastSlot.el); draw(toastSlot, flowAnim(tracked.toast, 'respirar'), 28); }
    else if (toastSlot.el.parentNode) toastSlot.el.remove();
    const pillSvg = document.querySelector('.pill-choice[data-pill-id="abito"] svg.island-agent-clay');
    if (pillSvg) { if (pillSvg.nextSibling !== pillSlot.el) pillSvg.after(pillSlot.el); draw(pillSlot, main, 28); }
    else if (pillSlot.el.parentNode) pillSlot.el.remove();
  }
  // HU-070 S9: caminar/correr slide Koda in from the left, bounded by the room left inside the island; nothing with reduced motion.
  const mover = L.createMover ? L.createMover() : null;
  function applyMove(id) {
    const el = mainSlot.el, island = document.getElementById('island');
    if (!mover || !el.parentNode || !island) return;
    const css = mover.update(id, now() - mainSlot.t0, reducedNow(), () => el.getBoundingClientRect().left - island.getBoundingClientRect().left - 4);
    if (css !== null) el.style.transform = css;
  }
  function frame() {
    requestAnimationFrame(frame);
    try { const id = brain.step(inputs()); placeMain(id); applyMove(id); placeFlow(id); document.documentElement.dataset.kodaAnim = id; } catch (e) { if (!frame.warned) { frame.warned = true; console.warn('[koda]', e && e.message); } }
  }
  for (const s of Object.values(SHEETS)) { const i = new Image(); i.src = s.file; }
  requestAnimationFrame(frame);
  window.__koda = { get current() { return document.documentElement.dataset.kodaAnim || null; } };
})();

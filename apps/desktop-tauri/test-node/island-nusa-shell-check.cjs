'use strict';
/* HU-063 follow-up (human comment 8 of the canvas replica, 29-oct: «que la isla sea mucho mas como Nusa en su background en todas las fases,
   notificaciones, chat y eso, solo en el background a nivel de esquema»). The island's BACKGROUND and SHAPE are the same in EVERY phase and
   BOTH themes: pure #000 (never translucent, never the light sand). Compact (island-free-drag S3) is Koda's DISC: round on all four corners,
   40x32 in every compact state, with a .1 white hairline ring so it reads on a black wallpaper.
   isla-cualquier-lado S1/S5 (human: «El nocth ya no será anclado como sale en la release 0.2»; design/isla-cualquier-lado/02-tarjeta-flotante.html):
   expanded, the island is the FLOATING CARD, not a notch hanging from the top: r26 on all four corners, no concave ears, a .1 hairline plus a
   centred drop shadow (0 12px 40px), and no light halo. The side it grows to follows data-edge (geometry::growth_edge): with data-edge="bottom"
   the veil washes from the top, the notice band sits ABOVE the card and the size scale is anchored on the card's bottom edge.
   ONLY the background/shape: the box sizes are frozen, so each phase's size is pinned here to what it measured BEFORE (SIZES).
   Real layout (island-geometry-harness), Playwright. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-shell-check: no playwright — NOT a pass'); process.exit(0); }

const ERR = { id: '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b', title: 'Pi falló', detail: 'Error al compilar', severity: 'error', kind: 'settled', expiresAt: Date.now() + 600000, agent: 'codex', projectName: 'api' };
const NOTICE = t => ({ id: 'n-pill', title: t, detail: 'Listo', severity: 'info', kind: 'settled', expiresAt: Date.now() + 600000, agent: 'pi', projectName: 'workspace' });
const snap = (s, notices) => ({ state: s, notices, card: null, request: null, revision: Date.now(), motionOverride: false, unavailable: false, connections: 1 });
const compact = p => p.evaluate(() => window.__islandSetState('compact'));
const tab = id => async p => { await p.click('#nusa-tab-' + id, { force: true }); await p.waitForTimeout(800); };
const none = async () => {};

// kind: 'expanded' (the floating card) | 'pill' (compact disc). w/h: measured on the tree BEFORE this change (720x150 notch, etc.).
const PHASES = [
  { name: 'compact idle', kind: 'pill', sc: { quick: true, sessions: [] }, drive: compact, w: 40, h: 32 },
  { name: 'compact with a finished notice', kind: 'pill', sc: { quick: true, sessions: [] }, w: 40, h: 32, drive: async p => { await compact(p); await p.evaluate(s => window.__emit('desktop:state', s), snap('compact', [])); await p.waitForTimeout(500); await p.evaluate(s => window.__emit('desktop:state', s), snap('compact', [NOTICE('Pi terminó su turno')])); await p.waitForTimeout(1200); } },
  { name: 'expanded Inicio', kind: 'expanded', sc: {}, drive: none, w: 720, h: 150 },
  { name: 'expanded Agentes', kind: 'expanded', sc: {}, drive: tab('agentes'), w: 720, h: 150 },
  { name: 'expanded Avisos', kind: 'expanded', sc: { notices: 2 }, drive: tab('avisos'), w: 720, h: 186 },
  { name: 'question', kind: 'expanded', sc: { question: 'plain' }, drive: none, w: 720, h: 255 },
  { name: 'permission', kind: 'expanded', sc: { question: 'approvalPi' }, drive: none, w: 720, h: 243 },
  { name: 'finished', kind: 'expanded', sc: { finishedCard: 'pi', sessions: [], quick: true }, drive: none, w: 720, h: 148 },
  { name: 'error notice', kind: 'expanded', sc: { noticeRows: [ERR], sessions: [], quick: true, windowCap: 340 }, w: 720, h: 148, drive: async p => { await p.evaluate(id => window.__emit('desktop:notice-open', { id, kind: 'finished' }), ERR.id); await p.waitForTimeout(1500); } },
  { name: 'chat', kind: 'expanded', sc: { chat: true }, drive: none, w: 720, h: 240 },
  { name: 'chat + pending question (dimmed, inert)', kind: 'expanded', sc: { question: 'plain' }, w: 720, h: 240, drive: async p => { await p.evaluate(() => window.__islandSetView('chat', 720, 240)); await p.waitForTimeout(1200); } },
];
// island-free-drag S3: the compact island carries no text in any state, so there is no text pill to measure under another font:
// the two compact phases above are exactly 40x32 whatever the system font or what is waiting.

const probe = page => page.evaluate(() => {
  const isl = document.getElementById('island'), cap = document.getElementById('capsule');
  const s = getComputedStyle(isl), b = isl.getBoundingClientRect(), cb = cap.getBoundingClientRect();
  // an ear is anything that paints a concave corner: the old #nusa-ear sibling, or a radial-gradient pseudo-element on the island itself
  const pseudo = ['::before', '::after'].map(w => getComputedStyle(isl, w)).filter(p => p.content !== 'none' && /radial-gradient/.test(p.backgroundImage));
  const e = document.getElementById('nusa-ear') || pseudo.length ? { sibling: !!document.getElementById('nusa-ear'), pseudo: pseudo.length } : null;
  const act = document.getElementById('compact-activity'), rg = document.createRange(); if (act) rg.selectNodeContents(act);
  const textW = act && act.textContent ? rg.getBoundingClientRect().width : 0;
  return { w: b.width, h: b.height, l: b.left, t: b.top, bg: s.backgroundColor, tl: parseFloat(s.borderTopLeftRadius), tr: parseFloat(s.borderTopRightRadius),
    bl: parseFloat(s.borderBottomLeftRadius), br: parseFloat(s.borderBottomRightRadius), shadow: s.boxShadow, ear: e || null, textW, cap: { l: cb.left, t: cb.top, r: cb.right, b: cb.bottom }, phase: cap.dataset.phase, view: cap.dataset.view };
});
// outer (non-inset) shadow layers must be a DARK drop shadow; the inset state veil/ring is the colour of the state, not a halo. The one light
// layer allowed is the designed hairline: a 1px spread ring, no blur, white at .1 (design/system.md --win-line), which draws an edge, not a glow.
const HAIRLINE = 'rgba(255, 255, 255, 0.1) 0px 0px 0px 1px';
const CARD_DROP = 'rgba(0, 0, 0, 0.45) 0px 12px 40px 0px';
const layersOf = sh => (!sh || sh === 'none') ? [] : sh.split(/,(?![^(]*\))/).map(x => x.trim());
function outerShadowsDark(sh) {
  return layersOf(sh).every(l => l.includes('inset') || l === HAIRLINE || (() => { const m = /rgba?\(([^)]+)\)/.exec(l); const p = m[1].split(/[ ,/]+/).map(Number); return Math.max(p[0], p[1], p[2]) <= 40; })());
}
const isBlack = bg => /^rgb\(0, 0, 0\)$/.test(bg) || /^rgba\(0, 0, 0, 1\)$/.test(bg);

(async () => {
  let ran = 0; const bad = [];
  for (const theme of ['dark', 'light']) for (const ph of PHASES) {
    const r = await H.open({ ...ph.sc, theme });
    const tag = `${theme}/${ph.name}`;
    try {
      await ph.drive(r.page); await r.page.waitForTimeout(700);
      const m = await probe(r.page); ran++;
      const fail = msg => bad.push(`${tag}: ${msg}`);
      if (!isBlack(m.bg)) fail(`background ${m.bg} is not opaque #000`);
      if (ph.kind === 'pill') {
        // the disc is round on all four corners (it floats free now), r16 = COMPACT.r, ringed by the .1 hairline
        if (!(m.tl === 16 && m.tr === 16 && m.bl === 16 && m.br === 16)) fail(`disc corners ${m.tl}/${m.tr}/${m.bl}/${m.br} are not 16 all round`);
        if (!layersOf(m.shadow).includes(HAIRLINE)) fail(`the disc has no .1 hairline ring: ${m.shadow}`);
      } else {
        // the floating card: r26 on ALL four corners (it no longer hangs from the top edge)
        if (!(m.tl === 26 && m.tr === 26 && m.bl === 26 && m.br === 26)) fail(`card corners ${m.tl}/${m.tr}/${m.bl}/${m.br} are not 26 all round`);
        // the shadow has no direction: the hairline plus a centred 0 12px 40px drop (was the notch's 0 18px 40px)
        const ls = layersOf(m.shadow);
        if (!ls.includes(HAIRLINE) || !ls.includes(CARD_DROP)) fail(`card shadow is not hairline + 0 12px 40px: ${m.shadow}`);
      }
      if (!outerShadowsDark(m.shadow)) fail(`light halo in box-shadow: ${m.shadow}`);
      // island-free-drag S3: every phase keeps its frozen box; compact is ALWAYS the disc (40x32) and it never carries text, so the
      // measurable text width must stay zero there (a text pill would be the old wide bar).
      if (ph.kind === 'pill' && m.textW > 0) fail(`the compact disc drew a text line (${m.textW}px)`);
      if (Math.abs(m.w - ph.w) > 0.5 || Math.abs(m.h - ph.h) > 0.5) fail(`box ${m.w}x${m.h} differs from the frozen ${ph.w}x${ph.h}`);
      // no concave ears anywhere: neither the old #nusa-ear sibling nor a radial-gradient pseudo-element on the island
      if (m.ear) fail(`concave ears are still painted: ${JSON.stringify(m.ear)}`);
      await r.screenshot(`/tmp/nusa-shell-${ph.name.replace(/[^a-z]+/gi, '-').toLowerCase()}-${theme}.png`);
    } catch (e) { bad.push(`${tag}: ${e.message.split('\n')[0]}`); } finally { await r.close(); }
  }
  // growth side (geometry::growth_edge -> data-edge): the veil washes from the edge the card is anchored on, the notice band sits on the side
  // that faces the screen centre and the size scale keeps the anchored edge still. Top: as before (veil from the bottom, band below, origin at
  // the card top). Bottom: veil from the top, band ABOVE the card content, origin at the card bottom.
  for (const edge of ['top', 'bottom']) {
    const r = await H.open({ notices: 2, quick: true });
    try {
      await r.page.evaluate(e => window.__islandSetState('overview', e), edge); await r.page.waitForTimeout(900);
      const m = await r.page.evaluate(() => {
        const cap = document.getElementById('capsule'), isl = document.getElementById('island'), band = document.getElementById('notices');
        const box = el => { const b = el.getBoundingClientRect(); return { t: b.top, b: b.bottom }; };
        const cb = cap.getBoundingClientRect(), ib = isl.getBoundingClientRect();
        const origin = getComputedStyle(cap).transformOrigin.split(' ').map(parseFloat);
        return { edge: cap.dataset.edge, strip: cap.dataset.noticeStrip, veil: getComputedStyle(document.getElementById('nusa-veil')).backgroundImage,
          band: box(band), head: box(document.getElementById('nusa-head')), panel: box(document.getElementById('nusa-body')), island: { t: ib.top - cb.top, b: ib.bottom - cb.top }, originY: origin[1] };
      });
      const fail = msg => bad.push(`edge ${edge}: ${msg}`);
      if (m.edge !== edge) fail(`data-edge is ${m.edge}: __islandSetState(phase, edge) does not carry the edge to the page`);
      if (m.strip !== 'on') fail(`the notice strip is not on (${m.strip}): the band scenario did not run`);
      const fromTop = !/^linear-gradient\(to top\b/.test(m.veil);
      if (edge === 'top' && fromTop) fail(`the veil must wash from the bottom: ${m.veil}`);
      if (edge === 'bottom' && (!fromTop || /\bto (left|right)\b/.test(m.veil))) fail(`the veil must wash from the top: ${m.veil}`);
      if (edge === 'top' && !(m.band.t >= m.panel.b - 0.5)) fail(`the band must sit below the card (band ${m.band.t}, card body ends ${m.panel.b})`);
      if (edge === 'bottom' && !(m.band.b <= m.head.t + 0.5)) fail(`the band must sit above the card (band ends ${m.band.b}, card header starts ${m.head.t})`);
      const want = edge === 'top' ? m.island.t : m.island.b;
      if (Math.abs(m.originY - want) > 1) fail(`the size scale is anchored at y ${m.originY}, not on the card's ${edge} edge (${want})`);
    } catch (e) { bad.push(`edge ${edge}: ${e.message.split('\n')[0]}`); } finally { await r.close(); }
  }
  // the Sileo toast: same black body/neck/pill with the concave neck junction; geometry untouched (question-toast-sileo owns the numbers)
  const toastCss = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'question-toast.css'), 'utf8');
  if (!/\.q-toast-neck, \.q-toast-pill, \.q-toast-bodyrect \{ fill: #000; \}/.test(toastCss)) bad.push('toast: neck/pill/body are not filled #000');
  const toastJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'question-toast.js'), 'utf8');
  if (!/q-toast-neck/.test(toastJs) || !/NECK_H\s*=\s*12/.test(toastJs)) bad.push('toast: the concave neck junction (NECK_H 12) is gone');
  assert.deepEqual(bad, [], `the island is not the Nusa shape everywhere:\n${bad.join('\n')}`);
  console.log(`island-nusa-shell: ${ran} phase/theme scenarios ok`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

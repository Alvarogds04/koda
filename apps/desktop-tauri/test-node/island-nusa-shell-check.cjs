'use strict';
/* HU-063 follow-up (human comment 8 of the canvas replica, 29-oct: «que la isla sea mucho mas como Nusa en su background en todas las fases,
   notificaciones, chat y eso, solo en el background a nivel de esquema»). The island's BACKGROUND and SHAPE are the Nusa notch in EVERY phase and
   BOTH themes: pure #000 (never translucent, never the light sand), square top corners (it hangs from the top edge), only the bottom corners round,
   the concave ears present in every expanded phase, and no light halo. ONLY the background/shape: the box sizes are frozen, so each phase's size is
   pinned here to what it measured BEFORE this change (SIZES). Real layout (island-geometry-harness), Playwright. */
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

// kind: 'expanded' (ears required) | 'pill' (compact capsule hanging from the edge). w/h: measured on the tree BEFORE this change (720x150 notch, etc.).
const PHASES = [
  { name: 'compact idle', kind: 'pill', sc: { quick: true, sessions: [] }, drive: compact, w: 40, h: 32 },
  { name: 'compact text', kind: 'pill', sc: { quick: true, sessions: [] }, w: 168, h: 32, drive: async p => { await compact(p); await p.evaluate(s => window.__emit('desktop:state', s), snap('compact', [])); await p.waitForTimeout(500); await p.evaluate(s => window.__emit('desktop:state', s), snap('compact', [NOTICE('Pi terminó su turno')])); await p.waitForTimeout(1200); } },
  { name: 'expanded Inicio', kind: 'expanded', sc: {}, drive: none, w: 720, h: 150 },
  { name: 'expanded Agentes', kind: 'expanded', sc: {}, drive: tab('agentes'), w: 720, h: 150 },
  { name: 'expanded Avisos', kind: 'expanded', sc: { notices: 2 }, drive: tab('avisos'), w: 720, h: 186 },
  { name: 'question', kind: 'expanded', sc: { question: 'plain' }, drive: none, w: 720, h: 255 },
  { name: 'permission', kind: 'expanded', sc: { question: 'approvalPi' }, drive: none, w: 720, h: 243 },
  { name: 'finished', kind: 'expanded', sc: { finishedCard: 'pi', sessions: [], quick: true }, drive: none, w: 720, h: 148 },
  { name: 'error notice', kind: 'expanded', sc: { noticeRows: [ERR], sessions: [], quick: true, windowCap: 340 }, w: 720, h: 148, drive: async p => { await p.evaluate(id => window.__emit('desktop:notice-open', { id, kind: 'finished' }), ERR.id); await p.waitForTimeout(1500); } },
  { name: 'chat', kind: 'expanded', sc: { chat: true }, drive: none, w: 720, h: 240 },
  { name: 'chat + pending question (dimmed, inert)', kind: 'expanded', sc: { question: 'plain' }, w: 720, h: 240, drive: async p => { await p.evaluate(() => window.__islandSetView('chat', 720, 240)); await p.waitForTimeout(1200); } },
  { name: 'recap (island grown for it)', kind: 'expanded', sc: {}, w: 720, h: 208, drive: async p => { await p.evaluate(() => document.dispatchEvent(new CustomEvent('abito:recap', { detail: { show: true } }))); await p.waitForTimeout(1200); } },
  { name: 'hidden strip (island concealed)', kind: 'pill', sc: { quick: true }, w: 137, h: 32, drive: async p => { await compact(p); await p.waitForTimeout(800); await p.evaluate(() => window.__islandConceal(true)); await p.waitForTimeout(1200); } },
];

const probe = page => page.evaluate(() => {
  const isl = document.getElementById('island'), cap = document.getElementById('capsule'), ear = document.getElementById('nusa-ear');
  const s = getComputedStyle(isl), b = isl.getBoundingClientRect(), cb = cap.getBoundingClientRect();
  const e = ear && { op: +getComputedStyle(ear).opacity, on: ear.dataset.on, box: ear.getBoundingClientRect(), kids: ear.children.length };
  return { w: b.width, h: b.height, l: b.left, t: b.top, bg: s.backgroundColor, tl: parseFloat(s.borderTopLeftRadius), tr: parseFloat(s.borderTopRightRadius),
    bl: parseFloat(s.borderBottomLeftRadius), br: parseFloat(s.borderBottomRightRadius), shadow: s.boxShadow, ear: e || null, cap: { l: cb.left, t: cb.top, r: cb.right, b: cb.bottom }, phase: cap.dataset.phase, view: cap.dataset.view };
});
// outer (non-inset) shadow layers must be a DARK drop shadow; the inset state veil/ring is the colour of the state, not a halo
function outerShadowsDark(sh) {
  if (!sh || sh === 'none') return true;
  const layers = sh.split(/,(?![^(]*\))/).map(x => x.trim());
  return layers.every(l => l.includes('inset') || (() => { const m = /rgba?\(([^)]+)\)/.exec(l); const p = m[1].split(/[ ,/]+/).map(Number); return Math.max(p[0], p[1], p[2]) <= 40; })());
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
      if (m.tl !== 0 || m.tr !== 0) fail(`top corners ${m.tl}/${m.tr} are not square`);
      if (!(m.bl > 0 && m.br > 0)) fail(`bottom corners ${m.bl}/${m.br} must be rounded`);
      if (!outerShadowsDark(m.shadow)) fail(`light halo in box-shadow: ${m.shadow}`);
      if (Math.abs(m.w - ph.w) > 0.5 || Math.abs(m.h - ph.h) > 0.5) fail(`box ${m.w}x${m.h} differs from the frozen ${ph.w}x${ph.h}`);
      if (ph.kind === 'expanded') {
        const e = m.ear;
        if (!e) fail('the ear element #nusa-ear is missing');
        else {
          if (!(e.op === 1 && e.on === 'true' && e.kids === 2)) fail(`ears not visible (opacity ${e.op}, data-on ${e.on})`);
          if (Math.abs(e.box.left - (m.l - 12)) > 1 || Math.abs(e.box.top - m.t) > 1 || Math.abs(e.box.width - (m.w + 24)) > 1) fail(`ears are not on the island box: ${JSON.stringify(e.box)} vs island ${m.l},${m.t},${m.w}`);
          if (e.box.left < m.cap.l - 0.5 || e.box.right > m.cap.r + 0.5) fail('the ears leave the capsule');
        }
      }
      await r.screenshot(`/tmp/nusa-shell-${ph.name.replace(/[^a-z]+/gi, '-').toLowerCase()}-${theme}.png`);
    } catch (e) { bad.push(`${tag}: ${e.message.split('\n')[0]}`); } finally { await r.close(); }
  }
  // the ears follow the island box through the spring (chat grows from the compact pill)
  for (const theme of ['dark', 'light']) {
    const r = await H.open({ quick: true, sessions: [], theme });
    try {
      await compact(r.page); await r.page.waitForTimeout(800);
      const drift = await r.page.evaluate(() => new Promise(res => {
        window.__islandSetState('overview'); window.__islandSetView('chat', 720, 240);
        const isl = document.getElementById('island'), ear = document.getElementById('nusa-ear'); let worst = 0, frames = 0, seen = 0; const t0 = performance.now();
        const tick = () => { const a = isl.getBoundingClientRect(), b = ear.getBoundingClientRect(); if (ear.dataset.on === 'true') { seen++; worst = Math.max(worst, Math.abs(b.left - (a.left - 12)), Math.abs(b.top - a.top), Math.abs(b.width - (a.width + 24))); } frames++;
          if (performance.now() - t0 < 900) requestAnimationFrame(tick); else res({ worst, frames, seen }); };
        requestAnimationFrame(tick);
      }));
      if (drift.seen < 10) bad.push(`${theme}: ears not shown while the chat springs open (${JSON.stringify(drift)})`);
      else if (drift.worst > 1.5) bad.push(`${theme}: ears drift ${drift.worst}px from the island box while it animates`);
    } finally { await r.close(); }
  }
  // the Sileo toast: same black body/neck/pill with the concave neck junction; geometry untouched (question-toast-sileo owns the numbers)
  const toastCss = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'question-toast.css'), 'utf8');
  if (!/\.q-toast-neck, \.q-toast-pill, \.q-toast-bodyrect \{ fill: #000; \}/.test(toastCss)) bad.push('toast: neck/pill/body are not filled #000');
  const toastJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'question-toast.js'), 'utf8');
  if (!/q-toast-neck/.test(toastJs) || !/NECK_H\s*=\s*12/.test(toastJs)) bad.push('toast: the concave neck junction (NECK_H 12) is gone');
  assert.deepEqual(bad, [], `the island is not the Nusa shape everywhere:\n${bad.join('\n')}`);
  console.log(`island-nusa-shell: ${ran} phase/theme scenarios ok`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

'use strict';
/* HU-075 «Recibida»: answering a question shows ONE clear confirmation in the Nusa notch (human, v0.3.0-preview.4:
   «cuando se la mando y manda recibido sale muy mal el UI UX»). Real layout (island-geometry-harness), dark and light, REAL mouse click.
   Pure parts live in island-nusa-takeover-check (takeoverTitle); this file measures what the human sees.
   Tolerances: centre x ±2px, centre y ±3px; exit pixels: max channel diff <= 40 (the veil's own 0.4→0 opacity fade is still running, measured 28; a beige/white ghost panel is >100) over the former card's top band (the black notch is #000; the veil follows the island state). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-recibida-check: no playwright — NOT a pass'); process.exit(0); }

const SNAP = () => {
  const b = e => { if (!e) return null; const x = e.getBoundingClientRect(); return { l: x.left, t: x.top, r: x.right, b: x.bottom, w: x.width, h: x.height }; };
  const vis = e => { if (!e) return false; for (let n = e; n && n !== document.body; n = n.parentElement) { const s = getComputedStyle(n); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity < .05) return false; } const x = e.getBoundingClientRect(); return x.width > 0 && x.height > 0; };
  const $ = id => document.getElementById(id), c = $('capsule').dataset, q = $('question'), st = $('question-state'), note = $('question-state-note');
  const k = document.querySelector('.koda-sprite[data-koda-slot="nusa"]');
  return { q: c.question, oc: c.outcome, isl: b($('island')), qBox: b(q), qVis: vis(q), state: vis(st) ? { box: b(st), text: st.textContent.trim() } : null,
    note: vis(note) ? { box: b(note), text: note.textContent.trim() } : null, title: $('nusa-title').textContent, koda: k && vis(k) ? { box: b(k), anim: k.dataset.anim } : null,
    askerDot: vis(document.querySelector('#question-asker .dot')) };
};
const grab = async (page, file) => { const buf = await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 752, height: 270 } }); return buf; };
async function sequence(theme, pre = {}) {
  const r = await H.open({ question: 'plain', sessions: [], theme, ...pre });
  try {
    await r.page.waitForTimeout(2600); // the island's own greeting beat (saludar) is over before the human answers
    const pendingH = await r.page.evaluate(() => Math.round(document.getElementById('island').getBoundingClientRect().height));
    const opt = await r.page.$('#question-options .q-option'); const bb = await opt.boundingBox();
    const t0 = Date.now(); await r.page.mouse.click(bb.x + bb.width / 2, bb.y + 10);
    const rows = []; const shots = {}; let exitShot = null, lastOutcomeShot = null, firstAfter = null;
    for (let i = 0; i < 46; i++) {
      await r.page.waitForTimeout(100);
      const s = await r.page.evaluate(SNAP); s.ms = Date.now() - t0; rows.push(s);
      if (s.q === 'outcome') {
        if (!shots.a && s.ms >= 280) shots.a = await grab(r.page, `/tmp/recibida-${theme}-300ms.png`);
        if (!shots.b && s.ms >= 1500) shots.b = await grab(r.page, `/tmp/recibida-${theme}-1500ms.png`);
        lastOutcomeShot = await r.page.screenshot({ clip: { x: 0, y: 0, width: 752, height: 270 } });
      } else if (rows.some(x => x.q === 'outcome') && !firstAfter) { firstAfter = await grab(r.page, `/tmp/recibida-${theme}-exit-first.png`); fs.writeFileSync(`/tmp/recibida-${theme}-last-outcome.png`, lastOutcomeShot); }
    }
    // Koda painted: the same box with and without the sprite must differ (sampled while the outcome shows)
    await r.page.waitForTimeout(0);
    const steady = await r.page.screenshot({ clip: { x: 0, y: 0, width: 752, height: 270 } });
    return { rows, pendingH, firstAfter, steady, r: null };
  } finally { await r.close(); }
}
async function kodaPainted(theme) {
  const r = await H.open({ question: 'plain', sessions: [], theme });
  try {
    await r.page.waitForTimeout(2600);
    const opt = await r.page.$('#question-options .q-option'); const bb = await opt.boundingBox(); await r.page.mouse.click(bb.x + bb.width / 2, bb.y + 10);
    await r.page.waitForFunction(() => document.getElementById('capsule').dataset.question === 'outcome' && document.getElementById('capsule').dataset.outcome === 'answered', null, { timeout: 3000 });
    await r.page.waitForTimeout(300);
    const k = await r.page.evaluate(() => { const e = document.querySelector('.koda-sprite[data-koda-slot="nusa"]'); const x = e.getBoundingClientRect(); return { x: x.left, y: x.top, width: x.width, height: x.height }; });
    const a = await r.page.screenshot({ clip: k });
    await r.page.evaluate(() => { document.querySelector('.koda-sprite[data-koda-slot="nusa"]').style.visibility = 'hidden'; });
    const b = await r.page.screenshot({ clip: k });
    return Buffer.compare(a, b) !== 0;
  } finally { await r.close(); }
}

(async () => {
  const bad = [];
  for (const theme of ['dark', 'light']) {
    const { rows, pendingH, firstAfter, steady } = await sequence(theme);
    const oc = rows.filter(x => x.q === 'outcome' && x.oc === 'answered' && x.state);
    assert.ok(oc.length >= 10, `${theme}: the «Recibida» outcome must show for a while (${oc.length} samples)`);
    // (1) the card spans the notch
    for (const s of oc) if (s.qBox.w < s.isl.w - 24) { bad.push(`${theme}: card ${Math.round(s.qBox.w)}px wide in a ${s.isl.w}px notch @${s.ms}ms`); break; }
    // (2) text group centred right of Koda's column, vertically in the body
    for (const s of oc) {
      const g = [s.state.box, s.note && s.note.box].filter(Boolean);
      const l = Math.min(...g.map(x => x.l)), rr = Math.max(...g.map(x => x.r)), t = Math.min(...g.map(x => x.t)), bt = Math.max(...g.map(x => x.b));
      const cx = (l + rr) / 2, wantX = (s.isl.l + 112 + s.isl.r - 16) / 2, cy = (t + bt) / 2, wantY = (s.isl.t + 34 + s.isl.b) / 2;
      if (Math.abs(cx - wantX) > 2) { bad.push(`${theme}: text centre x ${cx.toFixed(1)} want ${wantX.toFixed(1)} ±2 @${s.ms}ms`); break; }
      if (Math.abs(cy - wantY) > 3) { bad.push(`${theme}: text centre y ${cy.toFixed(1)} want ${wantY.toFixed(1)} ±3 @${s.ms}ms`); break; }
    }
    // (3) Koda: inside the island and happy
    for (const s of oc) {
      if (!s.koda) { bad.push(`${theme}: no visible Koda in the outcome @${s.ms}ms`); break; }
      const k = s.koda.box, i = s.isl;
      if (k.l < i.l || k.t < i.t || k.r > i.r || k.b > i.b) { bad.push(`${theme}: Koda outside the island`); break; }
    }
    if (!oc.filter(s => s.ms >= 300).every(s => s.koda && s.koda.anim === 'feliz')) bad.push(`${theme}: Koda not 'feliz' once Recibida is under way (saw ${[...new Set(oc.map(s => s.koda && s.koda.anim))]})`);
    if (!(await kodaPainted(theme))) bad.push(`${theme}: Koda paints nothing during Recibida (covered)`);
    // (4) header and phrase
    for (const s of oc) { if (s.title !== 'Recibida') { bad.push(`${theme}: header «${s.title}» during Recibida`); break; } }
    if (!oc.some(s => s.note && s.note.text.includes('Pi sigue con tu respuesta'))) bad.push(`${theme}: no «Pi sigue con tu respuesta» phrase (${JSON.stringify(oc[oc.length - 1].note)})`);
    // (5) height: pending height, then 150, once
    const hs = []; for (const s of rows) { const h = Math.round(s.isl.h); if (hs[hs.length - 1] !== h) hs.push(h); }
    if (hs.length !== 2 || hs[0] !== pendingH || hs[1] !== 150) bad.push(`${theme}: island heights ${hs.join('→')} (want ${pendingH}→150)`);
    // (6) exit: no ghost from the first sample after the outcome
    const ex = rows.findIndex((s, i) => i > 0 && s.q === '' && rows.slice(0, i).some(x => x.q === 'outcome'));
    assert.ok(ex > 0, `${theme}: the outcome must end by itself`);
    for (const s of rows.slice(ex)) { if (s.qVis) { bad.push(`${theme}: #question still visible after the outcome (@${s.ms}ms)`); break; } if (s.askerDot) { bad.push(`${theme}: loose dot after the outcome`); break; } }
    // pixels: the former card region equals the steady Inicio (Koda/clock animate, so compare the card region right of the gutter, below the header)
    const diff = await pixelDiff(firstAfter, steady, theme);
    if (diff > 40) bad.push(`${theme}: first frame after exit differs from steady Inicio by ${diff} (max channel) in the former card's top band`);
    console.log(`  ${theme}: pending ${pendingH}, heights ${hs.join('→')}, ${oc.length} outcome samples, exit diff ${diff}`);
  }
  // (7) the other outcomes render the same centred word in the same full-width card
  for (const word of ['busy', 'expired', 'cancelled', 'disconnected', 'human_cancelled', 'rejected']) {
    const r = await H.open({ question: 'plain', sessions: [], theme: 'dark' });
    try {
      await r.page.waitForTimeout(1500);
      await r.page.evaluate(w => window.__emit('question:state', { available: true, pending: null, queued: [], queued_count: 0, deliveries: [], notice: w }), word);
      await r.page.waitForFunction(() => document.getElementById('capsule').dataset.question === 'outcome', null, { timeout: 3000 });
      await r.page.waitForTimeout(300);
      const s = await r.page.evaluate(SNAP);
      if (!s.state) { bad.push(`${word}: no outcome word shown`); continue; }
      if (s.qBox.w < s.isl.w - 24) bad.push(`${word}: card ${Math.round(s.qBox.w)}px wide`);
      const cx = (s.state.box.l + s.state.box.r) / 2, wantX = (s.isl.l + 112 + s.isl.r - 16) / 2;
      if (Math.abs(cx - wantX) > 2) bad.push(`${word}: word centre x ${cx.toFixed(1)} want ${wantX.toFixed(1)}`);
      if (s.note) bad.push(`${word}: phrase shown (only «Recibida» has one)`);
      if (s.title !== s.state.text) bad.push(`${word}: header «${s.title}» != word «${s.state.text}»`);
    } finally { await r.close(); }
  }
  assert.deepEqual(bad, [], `Recibida:\n${bad.join('\n')}`);
  console.log('island-nusa-recibida-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

// decode two PNG screenshots in a throwaway page canvas and return the max per-channel diff over the former card's top band (x 20..600, y 36..76: past the header, left of the Inicio Koda, above the veil gradient)
async function pixelDiff(a, b, theme) {
  const { chromium } = H.findPlaywright();
  const br = await chromium.launch(); const p = await br.newPage();
  try {
    return await p.evaluate(async ([x, y]) => {
      const load = u => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = u; });
      const g = async u => { const i = await load(u); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const t = c.getContext('2d'); t.drawImage(i, 0, 0); return t.getImageData(20, 36, 580, 40).data; };
      const A = await g('data:image/png;base64,' + x), B = await g('data:image/png;base64,' + y); let m = 0;
      for (let i = 0; i < A.length; i++) m = Math.max(m, Math.abs(A[i] - B[i])); return m;
    }, [a.toString('base64'), b.toString('base64')]);
  } finally { await br.close(); }
}

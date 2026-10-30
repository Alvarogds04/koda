'use strict';
/* Koda must really PAINT (not just have a rect) in every take-over / Inicio state (human on v0.3.0-preview.4: «cuando sale la pregunta no sale koda»).
   Technique: screenshot Koda's box with the sprite visible and with it visibility:hidden; identical bytes = Koda paints nothing (something opaque covers it).
   Real layout, dark and light. «Recibida» (HU-075) is a scenario below: after a REAL click on the first option. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-koda-painted-check: no playwright — NOT a pass'); process.exit(0); }
const SEL = '.koda-sprite[data-koda-slot="nusa"],.koda-sprite[data-koda-slot="nusa-chat"]';
const SCEN = [['inicio', {}, null], ['pregunta simple', { question: 'plain' }, 'simple'], ['pregunta varias', { question: 'multi' }, 'varias'], ['cuestionario', { question: 'form' }, 'cuestionario'], ['permiso Pi', { question: 'approvalPi' }, 'permiso'], ['permiso harness', { question: 'approval' }, null], ['termino', { finishedCard: 'pi', sessions: [], quick: true }, null], ['puente', { bridgeCard: true, sessions: [] }, null], ['motor caido', { engine: 'down' }, null], ['Recibida', { question: 'plain', answer: true }, 'recibida']];
(async () => {
  const bad = [];
  for (const theme of ['dark', 'light']) for (const [name, sc, shot] of SCEN) {
    const r = await H.open({ sessions: [], ...sc, theme });
    try {
      await r.page.waitForTimeout(1400);
      if (sc.answer) { // HU-075: answer for real, then measure during the «Recibida» outcome
        const opt = await r.page.$('#question-options .q-option'); const bb = await opt.boundingBox(); await r.page.mouse.click(bb.x + bb.width / 2, bb.y + 10);
        await r.page.waitForFunction(() => document.getElementById('capsule').dataset.question === 'outcome', null, { timeout: 3000 }); await r.page.waitForTimeout(400);
      }
      const k = await r.page.evaluate(sel => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(), i = document.getElementById('island').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height, inside: b.left >= i.left - .5 && b.top >= i.top - .5 && b.right <= i.right + .5 && b.bottom <= i.bottom + .5 }; }, SEL);
      if (!k || k.width < 1) { bad.push(`${name}/${theme}: no Koda sprite`); continue; }
      if (!k.inside) bad.push(`${name}/${theme}: Koda box not inside #island`);
      const clip = { x: k.x, y: k.y, width: k.width, height: k.height };
      const a = await r.page.screenshot({ clip });
      await r.page.evaluate(sel => { document.querySelector(sel).style.visibility = 'hidden'; }, SEL);
      const b = await r.page.screenshot({ clip });
      await r.page.evaluate(sel => { document.querySelector(sel).style.visibility = ''; }, SEL);
      if (Buffer.compare(a, b) === 0) bad.push(`${name}/${theme}: Koda paints nothing (covered)`);
      if (shot) await r.page.locator('#island').screenshot({ path: `/tmp/koda-painted-${shot}-${theme}.png` }).catch(() => {});
    } finally { await r.close(); }
  }
  assert.deepEqual(bad, [], `Koda not painted:\n${bad.join('\n')}`);
  console.log('island-nusa-koda-painted-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

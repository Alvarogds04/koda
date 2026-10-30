'use strict';
/* S10 (10 «Pi terminó», B) — RE-POINTED by HU-057: the finished notice is a take-over card that sizes the 720px notch (36 + card + 16, <= 324); the message is not cut,
   buttons [Ver] [OK] receive their clicks, and while that agent runs again there is no finished card, only the 186px Avisos strip. Real layout. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s10-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  {
    const r = await H.open({ finishedCard: 'pi', finishedText: 'Migración aplicada, 14 tests pasan y el despliegue de staging quedó verificado sin errores.' });
    try {
      // HU-057 RE-POINT (odd/tasks/isla-nusa.md): the finished notice is now a TAKE-OVER of the 720-wide notch, not a 32px band under a 184px overview (that design,
      // the 220px island and the visible legacy overview are gone on purpose). The intent holds on real layout: the island is exactly as tall as its card
      // (36 head + card + 16 air, fitFinished, never past the 324 cap), the card sits whole inside it, the message is not cut, and [Ver] [OK] receive their clicks.
      const isl = (await r.measure('#island'))[0];
      const band = (await r.measure('#notices'))[0], card = (await r.measure('#notice-card'))[0];
      assert.ok(band.shown && card.shown, 'the finished card is drawn');
      assert.ok(isl.h <= 324.5, `finished take-over never exceeds the 324 cap (${isl.h})`);
      assert.ok(Math.abs(isl.h - (36 + card.h + 16)) <= 1.5, `island height fits its card: 36 + ${card.h} + 16 = ${36 + card.h + 16}, measured ${isl.h}`);
      assert.ok(card.top >= 36 - 1 && card.bottom <= isl.bottom - 14 && card.left >= isl.left && card.right <= isl.right, `the card is whole inside the island: ${JSON.stringify({ card, isl })}`);
      assert.ok(band.top >= 0 && band.bottom <= isl.bottom + 0.5, 'the notices box is inside the island');
      assert.ok(!(await r.measure('#overview-view'))[0].shown, 'the take-over replaces the legacy overview (it is not drawn under the card)');
      assert.equal((await r.measure('#nusa-head'))[0].shown, true); assert.equal(await r.page.evaluate(() => document.getElementById('capsule').dataset.takeover), 'finished');
      const msg = await r.page.evaluate(() => { const m = document.getElementById('notice-card-message'), b = m.getBoundingClientRect(), c = document.getElementById('notice-card').getBoundingClientRect(); return { cut: m.scrollHeight > m.clientHeight + 1, inCard: b.bottom <= c.bottom + 0.5 && b.top >= c.top - 0.5, h: b.height }; });
      assert.ok(!msg.cut && msg.inCard, `the message is not cut and stays inside its card (${JSON.stringify(msg)})`);
      const ok = await r.hit('#notice-card-ok, #notice-card-terminal'); assert.equal(ok.length, 2); assert.deepEqual(ok.filter(h => !h.ok), [], 'buttons get their click');
      const btnH = await r.page.evaluate(() => [...document.querySelectorAll('#notice-card .btn')].map(b => b.getBoundingClientRect().height)); assert.ok(btnH.every(h => h >= 24), 'targets >= 24px');
    } finally { await r.close(); }
  }
  {
    // the agent that finished is RUNNING again -> the band is gone and the island is back to the overview height
    const r = await H.open({ finishedCard: 'claude-code' });
    try {
      const isl = (await r.measure('#island'))[0];
      // The finished BAND is gone while the agent runs. The retained notice itself is still listed as the «Avisos · N» strip under the 150px notch (HU-057: 150 + 36 = 186, was 184 + 36 = 220).
      assert.equal(Math.round(isl.h), 186, 'claude-code runs (api): no finished band, only the Avisos strip slot (150 + 36)');

      assert.equal(await r.page.locator('#notice-title').textContent(), 'Avisos · 1', 'the retained notice is the Avisos strip');
      assert.ok(!(await r.measure('#notice-card'))[0].shown, 'the band is hidden while it runs');
    } finally { await r.close(); }
  }
  {
    // R14: retained history uses the Avisos entry; only native-confirmed detail keeps the S10 band.
    const BOILER = 'No confirma que la tarea haya salido bien ni que las pruebas hayan pasado.';
    const r = await H.open({ finishedCard: 'pi', noLane: true, finishedText: BOILER });
    try {
      const m = await r.page.evaluate(() => { const vis = e => { const b = e.getBoundingClientRect(), c = getComputedStyle(e); return b.width > 0 && b.height > 0 && c.visibility !== 'hidden' && +c.opacity > 0 && c.display !== 'none'; };
        const n = document.getElementById('notices').getBoundingClientRect(), isl = document.getElementById('island').getBoundingClientRect(), msg = document.getElementById('notice-card-message');
        return { h: isl.height, band: [n.top - isl.top, n.height, n.width], capsule: ['notice-row', 'notice-pill', 'notice-list'].filter(id => document.getElementById(id) && vis(document.getElementById(id))), card: vis(document.getElementById('notice-card')),
          msg: msg.textContent, fits: msg.scrollWidth <= msg.clientWidth + 1, tip: msg.getAttribute('data-tip') }; });
      // 150 (HU-057 notch, was 184) + the 36px Avisos strip (abito-avisos-ux S1, edb3bd76) = 186: no finished BAND, the strip is the one thing in that slot
      assert.equal(Math.round(m.h), 186, 'retained history does not add a competing finished band');
      assert.ok(m.capsule.includes('notice-pill')); assert.equal(m.card, false);
      assert.equal(await r.page.locator('#notice-title').textContent(), 'Avisos · 1');
      await r.page.locator('#notice-action').click();
      assert.equal(await r.page.locator('#notice-list-title').textContent(), 'Avisos · 1');
      assert.equal(await r.page.locator('.notice-list-row').count(), 1);
    } finally { await r.close(); }
  }
  console.log('island-s10-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });

'use strict';
/* S3 (03 compacta con pregunta, A): in the compact pill a Pi question widens the pill to 560, shows its first line and «Responder»; there is
   no separate toast; «Responder» opens the island on the question. Real layout. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s3-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  const r = await H.open({ question: 'plain', quick: true });
  try {
    await r.page.evaluate(() => window.__islandSetState('compact'));
    await r.page.waitForTimeout(1500);
    const isl = (await r.measure('#island'))[0];
    assert.equal(Math.round(isl.w), 560, 'the pill widens to 560');
    const act = (await r.measure('#compact-activity'))[0];
    assert.match(act.text, /¿Qué editor preferís\?/);
    const ov = await r.page.evaluate(() => { const e = document.getElementById('compact-activity'); return e.scrollWidth <= e.clientWidth; });
    assert.ok(ov, 'the question fits on one line');
    const btn = (await r.measure('#compact-reply'))[0];
    assert.ok(btn && btn.shown && btn.w >= 44 && btn.h >= 24, 'Responder is a 44x24 target');
    assert.ok((await r.hit('#compact-reply'))[0].ok, 'Responder receives its own click');
    const toast = (await r.measure('#question-toast'))[0];
    assert.ok(!toast || !toast.shown, 'no separate toast over the compact pill');
    await r.page.mouse.click(btn.left + btn.w / 2, btn.top + btn.h / 2);
    await r.page.waitForTimeout(1500);
    const phase = await r.page.evaluate(() => document.getElementById('capsule').dataset.phase);
    assert.equal(phase, 'expanded', 'Responder opens the island on the question (phase ' + phase + ')');
  } finally { await r.close(); }
  console.log('island-s3-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

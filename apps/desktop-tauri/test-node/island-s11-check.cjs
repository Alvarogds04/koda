'use strict';
/* S11 (11 error/sin motor, B + human note): a 32px band UNDER the overview (island 184+36) only while the engine/account needs attention;
   «Omitir» hides it for that problem (and it comes back if the problem resolves and returns); no duplicate engine row inside the centre. Real layout. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s11-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  {
    const r = await H.open({ engine: 'down' });
    try {
      const isl = (await r.measure('#island'))[0]; assert.equal(Math.round(isl.h), 186, 'band zone: 150 + 36 (HU-057 L4/L5: Nusa notch is 150 high, was 184 -> 220)');
      const b = (await r.measure('#engine-band'))[0]; assert.ok(b && b.shown, 'the band is drawn');
      assert.equal(Math.round(b.h), 32); assert.equal(Math.round(b.top - isl.top), 144) /* HU-057: 150-6, was 184-6 */; assert.ok(b.bottom <= isl.bottom + 0.5);
      const t = await r.page.evaluate(() => ({ label: document.getElementById('engine-band-label').textContent, link: document.getElementById('engine-band-link').textContent, skip: document.getElementById('engine-band-skip').textContent,
        fits: ['engine-band-label'].every(id => { const e = document.getElementById(id); return e.scrollWidth <= e.clientWidth + 1; }), old: [...document.querySelectorAll('.engine-row')].filter(e => e.getBoundingClientRect().width > 0).length }));
      assert.deepEqual([t.label, t.link, t.skip, t.fits, t.old], ['Sin motor', 'Revisar', 'Omitir', true, 0], 'one band; the old in-centre engine rows are not drawn');
      assert.deepEqual((await r.hit('#engine-band-link, #engine-band-skip')).filter(h => !h.ok), [], 'buttons get their click');
      const sk = (await r.measure('#engine-band-skip'))[0]; await r.page.mouse.click(sk.left + sk.w / 2, sk.top + sk.h / 2); await r.page.waitForTimeout(1200);
      assert.equal(Math.round((await r.measure('#island'))[0].h), 150, 'Omitir: the island goes back to 150 (HU-057 L4/L5, was 184)');
      assert.ok(!(await r.measure('#engine-band'))[0].shown, 'Omitir: no band');
    } finally { await r.close(); }
  }
  {
    const r = await H.open({ engine: 'account' });
    try {
      const k = await r.page.evaluate(() => [document.getElementById('engine-band').dataset.kind, document.getElementById('engine-band-label').textContent]);
      assert.deepEqual(k, ['account', 'Sin cuenta']);
    } finally { await r.close(); }
  }
  {
    // healthy engine: no band at all
    const r = await H.open({ engine: 'ok' });
    try { assert.equal(Math.round((await r.measure('#island'))[0].h), 150 /* HU-057: was 184 */); assert.ok(!(await r.measure('#engine-band'))[0].shown); } finally { await r.close(); }
  }
  console.log('island-s11-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });

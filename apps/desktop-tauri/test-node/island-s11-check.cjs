'use strict';
/* S11 (11 error/sin motor, B + human note): a 32px band UNDER the overview (island 184+36) only while the engine/account needs attention;
   «Omitir» hides it for that problem (and it comes back if the problem resolves and returns); no duplicate engine row inside the centre. Real layout. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s11-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  // welcome-home (human, 16-nov): the island never draws the engine band: with the engine down or no account, on every tab, there is no band, the island stays
  // 150 and the old in-centre engine rows are not drawn either. The notice is shown inside the chat (chat-engine-note-check.cjs).
  for (const engine of ['down', 'account']) {
    const r = await H.open({ engine });
    try {
      for (const tab of ['inicio', 'agentes', 'avisos']) {
        if (tab !== 'inicio') await H.goTab(r.page, tab); await r.page.waitForTimeout(800);
        assert.ok(!(await r.measure('#engine-band'))[0].shown, `${engine}/${tab}: the island draws no engine band`);
        assert.equal(Math.round((await r.measure('#island'))[0].h), 150, `${engine}/${tab}: the island stays 150`);
        assert.equal(await r.page.evaluate(() => [...document.querySelectorAll('.engine-row')].filter(e => e.getBoundingClientRect().width > 0).length), 0, `${engine}/${tab}: no in-centre engine row`);
      }
    } finally { await r.close(); }
  }
  {
    // healthy engine: no band at all
    const r = await H.open({ engine: 'ok' });
    try { assert.equal(Math.round((await r.measure('#island'))[0].h), 150 /* HU-057: was 184 */); assert.ok(!(await r.measure('#engine-band'))[0].shown); } finally { await r.close(); }
  }
  console.log('island-s11-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });

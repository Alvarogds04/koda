'use strict';
/* S12 (12 «Ver todas», B), updated for HU-057 L4/L5.
   Before: «Todas» anchored to the blobs card opened a GRID of coloured mascots (cells >= 44x44, names on one line, click focuses a session).
   HU-057: the idle overview is the Nusa notch; #blobs, its «Todas» link and the mascot grid entry point are hidden BY DESIGN (no equivalent:
   Nusa has no mascots; the Agentes tab lists the first 3 agents as rows). So this test now asserts:
   1. «Todas» is NOT shown in the idle overview (hidden by design) and the grid stays closed;
   2. the Nusa Agentes tab shows whole rows inside the notch, each receiving its own click: with MORE than 3 sessions it shows 2 rows + the «Ver todas (N)»
      link (HU-057, human option A: 3 rows + the link do not fit the 104px panel), with 3 or fewer it shows them all and no link;
   3. a long project name no longer shows whole in a tip (that tip came from the grid cell, gone by design): the Nusa model truncates it with «…»
      (island-nusa.js agentRows) and it never overflows the row. The full-name tip has NO Nusa equivalent — reported as a gap to the parent.
   Real layout. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s12-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  {
    const r = await H.open({ manyPi: true });
    try {
      const sa = (await r.measure('#blobs-links .see-all'))[0];
      assert.ok(!sa || !sa.shown, '«Todas» is hidden in the Nusa idle overview (HU-057: no mascot grid by design)');
      assert.equal(await r.page.evaluate(() => document.querySelector('.sessions-all').hidden), true, 'the mascot grid stays closed');
      await r.page.click('[data-tab=agentes]'); await r.page.waitForTimeout(300);
      const isl = (await r.measure('#island'))[0];
      const rows = (await r.measure('.nusa-agent')).filter(b => b.shown);
      assert.equal(rows.length, 2, 'Nusa Agentes: 2 whole rows when «Ver todas (N)» is needed (14 sessions)');
      const all = (await r.measure('.nusa-all')).filter(b => b.shown);
      assert.equal(all.length, 1, 'the «Ver todas (N)» link is shown with many sessions');
      assert.ok(all[0].left >= isl.left - 0.5 && all[0].right <= isl.right + 0.5 && all[0].bottom <= isl.bottom + 0.5, 'the link sits inside the notch');
      assert.ok(rows.every(b => b.left >= isl.left - 0.5 && b.right <= isl.right + 0.5 && b.bottom <= isl.bottom + 0.5), 'rows sit inside the notch');
      assert.deepEqual((await r.hit('.nusa-agent')).filter(h => !h.ok), [], 'rows receive their own click');
    } finally { await r.close(); }
  }
  {
    const long = 'isla-expandida-con-un-nombre-muy-largo';
    const r = await H.open({ sessions: [{ id: 's-00000001', kind: 'pi', cwd: long, state: 'running', origin: null }, { id: 's-00000002', kind: 'pi', cwd: 'settings-pantalla-ajustes-generales', state: 'sleeping', origin: null }] });
    try {
      await r.page.click('[data-tab=agentes]'); await r.page.waitForTimeout(300);
      const m = await r.page.evaluate(() => [...document.querySelectorAll('.nusa-agent')].map(row => { const n = row.querySelector('.nusa-agent-name'), b = row.getBoundingClientRect(), nb = n.getBoundingClientRect(); return { aria: row.getAttribute('aria-label'), inside: nb.left >= b.left - 0.5 && nb.right <= b.right + 0.5, ellipsis: getComputedStyle(n).textOverflow === 'ellipsis' }; }));
      assert.equal(m.length, 2);
      assert.ok(m[0].aria.includes('…') && !m[0].aria.includes(long), `the long name is truncated with «…» by the Nusa model: ${m[0].aria}`);
      assert.ok(m.every(x => x.inside && x.ellipsis), `names ellipsise inside their rows: ${JSON.stringify(m)}`);
    } finally { await r.close(); }
  }
  console.log('island-s12-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });

'use strict';
/* v8 S1 drew a coloured thread for the island hidden 24px up at the screen edge. isla-cualquier-lado S2 (human: «solo el círculo con
   koda pero sin que esté oculto») retired that hide: in the real layout the folded island is the full 40x32 disc, on screen, and it
   stays so with no thread and no hidden state, whatever is waiting. Real layout. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  for (const [name, sc] of [['rest', {}], ['question', { question: 'plain' }]]) {
    const r = await H.open({ ...sc, quick: true });
    try {
      await r.page.evaluate(() => { window.__islandSetState('compact'); });
      await r.page.waitForTimeout(1500);
      const m = await r.page.evaluate(() => { const i = document.getElementById('island').getBoundingClientRect(), cap = document.getElementById('capsule');
        return { top: i.top, bottom: i.bottom, w: i.width, op: +getComputedStyle(document.getElementById('island')).opacity, strip: !!document.getElementById('edge-strip'),
          hidden: cap.dataset.edgeHidden, conceal: typeof window.__islandConceal, phase: cap.dataset.phase }; });
      assert.equal(m.phase, 'compact', `${name}: folded`);
      assert.equal(m.hidden, undefined, `${name}: never marked hidden`);
      assert.equal(m.strip, false, `${name}: no edge thread`);
      assert.equal(m.conceal, 'undefined', `${name}: no page-side conceal hook left`);
      assert.ok(m.top >= -0.5 && Math.abs(m.bottom - m.top - 32) < 0.6 && m.w >= 38 && m.w <= 42, `${name}: the whole 40x32 disc is on screen [${m.top},${m.bottom}] w ${m.w}`);
      assert.ok(m.op > 0.9, `${name}: the disc is drawn (${m.op})`);
      const hit = await r.page.evaluate(() => { const b = document.getElementById('island').getBoundingClientRect(); const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!el && document.getElementById('capsule').contains(el); });
      assert.ok(hit, `${name}: the disc is the hit target at its centre`);
    } finally { await r.close(); }
  }
  console.log('island-v8-s1-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });

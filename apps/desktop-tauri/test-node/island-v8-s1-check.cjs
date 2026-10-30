'use strict';
/* v8 S1: the hidden island's coloured thread must be VISIBLE in the real window: the island sits 24px up, so the thread has to be in
   the last 8px of the island (window y 0..8), not at the island's own top (which is off screen). Real layout. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  for (const [name, sc] of [['rest', {}], ['question', { question: 'plain' }]]) {
    const r = await H.open({ ...sc, quick: true });
    try {
      await r.page.evaluate(() => { window.__islandSetState('compact'); window.__islandConceal(true); });
      await r.page.waitForTimeout(1500);
      const m = await r.page.evaluate(() => { const s = document.getElementById('edge-strip'), b = s.getBoundingClientRect(), c = getComputedStyle(s); const i = document.getElementById('island').getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, w: b.width, op: +c.opacity, bg: c.backgroundColor, islandBottom: i.bottom, hidden: document.getElementById('capsule').dataset.edgeHidden, state: s.dataset.state }; });
      assert.equal(m.hidden, 'true', `${name}: hidden`);
      assert.ok(Math.abs(m.islandBottom - 8) < 0.6, `${name}: island bottom is 8 (${m.islandBottom})`);
      assert.ok(m.top >= -0.5 && m.bottom <= 8.5 && m.w >= 150, `${name}: the thread is on screen inside the 8px zone [${m.top},${m.bottom}] w ${m.w}`);
      assert.ok(m.op >= 0.4 && !/rgba\(0, 0, 0, 0\)/.test(m.bg), `${name}: opaque enough (${m.op} ${m.bg})`);
      if (name === 'question') assert.equal(m.state, 'question');
      const hit = await r.page.evaluate(() => { const b = document.getElementById('edge-strip').getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, Math.max(0.5, b.top + 1.5)) !== null; });
      assert.ok(hit);
    } finally { await r.close(); }
  }
  console.log('island-v8-s1-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });

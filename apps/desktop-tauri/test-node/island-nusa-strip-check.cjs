'use strict';
/* HU-057 regression: after the finished/notices lane closes, the island height must go back to what the notice STRIP needs (150 notch + 36 band = 186),
   not stay at the lane's 148 (finishedH was never reset by the paths that clear the lane), or the 32px strip hangs ~28px outside the black notch.
   Real layout via the geometry harness; 2 notices arrive while expanded (no sessions, so the finished card is allowed). */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-strip-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  for (const theme of ['dark', 'light']) {
    const r = await H.open({ sessions: [], quick: true, theme });
    try {
      const notes = [1, 2].map(i => ({ id: `0b3a5c9e-8f27-4d11-9a0e-00000000009${i}`, kind: 'settled', severity: 'info', title: `Codex terminó ${i}`, agent: 'codex', projectName: 'abito', at: Date.now(), expiresAt: Date.now() + 600000 }));
      await r.page.evaluate(n => window.__emit('desktop:state', { state: 'expanded', notices: n, card: null, request: null, revision: 9, connections: 1 }), notes);
      const seen = [];
      for (const wait of [600, 2500, 3000]) {                       // ~0.6 s (lane open), ~3 s and ~6 s (lane closed, strip left)
        await r.page.waitForTimeout(wait);
        const m = await r.page.evaluate(() => { const b = id => { const e = document.getElementById(id); if (!e) return null; const x = e.getBoundingClientRect(); return { top: x.top, bottom: x.bottom, h: x.height, w: x.width }; };
          return { isl: b('island'), pill: b('notice-pill'), strip: document.getElementById('capsule').dataset.noticeStrip, view: document.getElementById('capsule').dataset.noticeView || null }; });
        seen.push(m);
        if (m.strip === 'on' && m.pill && m.pill.h > 0 && !m.view) {
          assert.ok(m.pill.bottom <= m.isl.bottom + 1, `${theme}: the strip stays INSIDE the black notch (pill bottom ${m.pill.bottom} vs island bottom ${m.isl.bottom})`);
          assert.ok(m.pill.top - m.isl.top >= 140 && m.pill.top - m.isl.top <= 160, `${theme}: the strip sits just under the 150px notch body (${m.pill.top - m.isl.top})`);
          assert.equal(Math.round(m.isl.h), 186, `${theme}: island = 150 notch + 36 band`);
        }
      }
      const last = seen[seen.length - 1];
      assert.ok(last.strip === 'on' && !last.view && last.pill.h > 0, `${theme}: the scenario really reached «lane closed, strip on»: ${JSON.stringify(last)}`);
    } finally { await r.close(); }
  }
  console.log('island-nusa-strip-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

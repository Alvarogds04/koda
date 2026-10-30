'use strict';
/* HU-057/HU-063 + release's accessibility decision (island-question-spacing): in the Nusa notch the question card's option / Omitir / nav targets are REAL
   boxes >= 44px high (getBoundingClientRect, not an ::after), option rows do not overlap (0px gap: touching 44px boxes, 8px of air between the 36px fills; release's 6px does not fit the frozen 340 window and island-s7's third-row click), the visible fill (::after inset 4px) is 36px, and the
   island stays at the frozen height. A long body scrolls inside 3 lines; the options scroll; Omitir + nav are never pushed out of the island. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-spacing-check: no Playwright — NOT a pass'); process.exit(0); }
(async () => {
  let failed = 0;
  const test = async (name, fn) => { try { await fn(); console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } };
  for (const kind of ['plain', 'multi', 'form']) {
    const r = await H.open({ question: kind, described: true, manyPi: true, windowCap: 340, quick: true });
    try {
      await test(kind + ': real boxes >= 44, visible fill 36, rows not overlapping, 8px of visible air', async () => {
        const m = await r.page.evaluate(() => {
          const out = { boxes: [], fill: [], gaps: [] };
          const opts = [...document.querySelectorAll('.q-option')].filter(e => e.getBoundingClientRect().height);
          for (const el of document.querySelectorAll('.q-option, #question-skip, #question-nav button')) {
            const b = el.getBoundingClientRect(); if (!b.height) continue;
            const a = getComputedStyle(el, '::after');
            out.boxes.push({ id: el.id || el.className, h: b.height, w: b.width }); out.fill.push(b.height - parseFloat(a.top) - parseFloat(a.bottom));
          }
          for (let i = 1; i < opts.length; i++) out.gaps.push(opts[i].getBoundingClientRect().top - opts[i - 1].getBoundingClientRect().bottom);
          out.isl = document.getElementById('island').getBoundingClientRect().height;
          return out;
        });
        assert.ok(m.boxes.length >= 3, JSON.stringify(m));
        for (const b of m.boxes) assert.ok(b.h >= 43.99 && b.w >= 43.99, JSON.stringify(b));
        for (const f of m.fill) assert.ok(f >= 35.99, 'visible fill ' + f);
        for (const g of m.gaps) assert.ok(g >= -0.01, 'boxes overlap: gap ' + g);
        assert.ok(m.isl <= 332.5, 'island ' + m.isl);
        const blocked = (await r.hit('.q-option, #question-skip, #question-nav button')).filter(h => !h.ok);
        assert.deepEqual(blocked, []);
      });
    } finally { await r.close(); }
  }
  if (failed) process.exitCode = 1; else console.log('island-nusa-spacing-check: ok');
})().catch(e => { console.error(e); process.exitCode = 1; });

'use strict';
/* S28 — RE-POINTED by HU-057 S1 (odd/tasks/isla-nusa.md, human decision: the notch is a solid black shape, no see-through glass in either theme):
   the expanded idle island is 720x150 (it was 720x184 and translucent alpha 0.6-0.8), its background is OPAQUE #000 in dark AND light, text, controls and the
   mascot stay fully opaque, single-line texts fit on one line, and the Avisos strip adds 36px (186). Real css/scripts in Chromium. Run: node test-node/island-s28-check.cjs */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s28-check: playwright is not installed here — NOT a pass'); process.exit(0); }

const ONE_LINE = ['.nusa-input', '.nusa-agent', '.nusa-link', '#nusa-head span', '#nusa-state', '#nusa-sub', '.col-status span', '.centre-state', '.centre-steps li', '.centre-empty-title', '.centre-empty-sub', '#centre-cta', '.card-left > .who', '.pill-choice span:not(.ico)', '#blobs-footer span', '#island-header .tab'];
const alpha = c => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return 1; const p = m[1].split(/[ ,\/]+/).filter(Boolean); return p.length > 3 ? +p[3] : 1; };

(async () => {
  for (const theme of ['dark', 'light']) {
    // S28 is the BASE island (720x150 since HU-057). Retained notices add the Avisos strip (+36 => 186), so the base size is measured with no notices.
    const r = await H.open({ github: true, notices: 0, theme, engine: 'ok' });
    try {
      const isl = (await r.measure('#island'))[0];
      assert.equal(Math.round(isl.w), 720, `${theme}: island width`);
      assert.equal(Math.round(isl.h), 150, `${theme}: island height (HU-057 notch)`);
      assert.equal(Math.round(isl.left), 16, `${theme}: centred in the 752 window`);
      const a = await r.page.evaluate(() => {
        const bg = getComputedStyle(document.getElementById("island")).backgroundColor;
        const op = ['#island', '#clay', '#nusa-head', '#nusa-panel', '.nusa-input'].map(s => { const e = document.querySelector(s); return e ? [s, getComputedStyle(e).opacity] : null; }).filter(Boolean);
        return { bg, op };
      });
      assert.equal(a.bg, 'rgb(0, 0, 0)', `${theme}: the notch is OPAQUE #000 in both themes (HU-057 S1; it was alpha 0.6-0.8), got ${a.bg}`);
      assert.equal(alpha(a.bg), 1, `${theme}: no alpha channel`);
      for (const [s, o] of a.op) if (s !== '#island-header' || +o) assert.equal(+o, 1, `${theme}: ${s} stays fully opaque (opacity ${o})`);
      const bad = await r.page.evaluate(sels => sels.flatMap(sel => [...document.querySelectorAll(sel)].filter(el => {
        const b = el.getBoundingClientRect(), s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && el.scrollWidth > el.clientWidth + 1;
      }).map(el => `${sel} «${el.textContent.trim().slice(0, 30)}» ${el.scrollWidth}>${el.clientWidth}`)), ONE_LINE);
      assert.deepEqual(bad, [], `${theme}: texts overflow their line: ${bad.join(' | ')}`);
      // the notch body: the panel sits whole inside the 150px island, under the 36px head (the legacy 132px card row is hidden by design)
      const panel = (await r.measure('#nusa-panel'))[0];
      assert.ok(panel && panel.shown && panel.top >= 30 && panel.bottom <= isl.bottom + 0.5 && panel.left >= isl.left && panel.right <= isl.right, `${theme}: the Nusa panel is inside the island: ${JSON.stringify(panel)}`);
      assert.ok(!(await r.measure('.card-left'))[0].shown, `${theme}: the legacy card row is not drawn`);
    } finally { await r.close(); }
  }
  {
    const r = await H.open({ github: true, notices: 2, theme: 'dark', engine: 'ok' });
    try {
      const isl = (await r.measure('#island'))[0];
      assert.equal(Math.round(isl.w), 720, 'with notices: width unchanged');
      assert.equal(Math.round(isl.h), 186, 'with notices: the Avisos strip adds 36px (150 + 36, abito-avisos-ux S1 on the HU-057 notch)');
    } finally { await r.close(); }
  }
  console.log('island-s28-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

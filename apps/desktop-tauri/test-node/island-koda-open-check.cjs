'use strict';
/* welcome-home: Koda must never cross the island on its way in or out. While the island grows or shrinks, #nusa is not on screen yet
   (island-nusa.css shows it only in the settled `expanded` phase), so koda-skin.js placeMain used to leave Koda following the Dot to its
   OLD place on the right and then snap to the centre of the new Inicio (found on the human's screen: «Koda salta de lugar al abrir»).
   This test folds the island with the real button, reopens it with a REAL click on the disc, and samples EVERY animation frame:
   whenever the sprite is visible it must be near the centre of the island, and once settled it must sit at the Inicio's spot. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-koda-open-check: no playwright — NOT a pass'); process.exit(0); }
const SAMPLER = ms => new Promise(res => { const out = []; const t0 = performance.now();
  (function f() { const k = document.querySelector('.koda-sprite[data-koda-slot]'), c = document.getElementById('capsule'), i = document.getElementById('island').getBoundingClientRect();
    const b = k && k.getBoundingClientRect(); const vis = !!k && !k.hidden && b.width > 0 && getComputedStyle(k).visibility !== 'hidden' && getComputedStyle(k).display !== 'none';
    out.push({ t: Math.round(performance.now() - t0), phase: c.dataset.phase, vis, slot: k && k.dataset.kodaSlot, cx: b ? Math.round((b.left + b.right) / 2) : null, cy: b ? Math.round((b.top + b.bottom) / 2) : null, w: b ? Math.round(b.width) : null, icx: Math.round((i.left + i.right) / 2) });
    if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(out); })(); });
(async () => {
  const r = await H.open({ sessions: [], engine: 'account', closeFolds: true });
  try {
    await r.page.waitForTimeout(900);
    const bad = [];
    const judge = (name, frames, centred) => {
      for (const f of frames) if (f.vis && Math.abs(f.cx - f.icx) > 40) bad.push(`${name}: @${f.t}ms phase=${f.phase} slot=${f.slot} Koda cx=${f.cx} (island cx=${f.icx}) cy=${f.cy} w=${f.w}`);
      if (centred) { const last = frames[frames.length - 1]; if (!(last.vis && Math.abs(last.cx - last.icx) <= 3 && last.slot === 'nusa')) bad.push(`${name}: settled Koda is not centred in the Inicio: ${JSON.stringify(last)}`); }
    };
    // folding: real click on «Minimizar Koda»
    const folding = r.page.evaluate(SAMPLER, 1400);
    await r.page.click('#header-fold');
    const f1 = await folding;
    assert.equal(f1[f1.length - 1].phase, 'compact', 'the island folded: ' + JSON.stringify(f1[f1.length - 1]));
    judge('folding', f1, false);
    await r.page.waitForTimeout(400);
    // reopening: a REAL mouse click on the disc
    const box = await r.page.evaluate(() => { const b = document.getElementById('island').getBoundingClientRect(); return { x: (b.left + b.right) / 2, y: 16 }; });
    const opening = r.page.evaluate(SAMPLER, 1800);
    await r.page.mouse.click(box.x, box.y);
    const f2 = await opening;
    assert.equal(f2[f2.length - 1].phase, 'expanded', 'the island reopened: ' + JSON.stringify(f2[f2.length - 1]));
    judge('opening', f2, true);
    console.log(`  frames: folding ${f1.length}, opening ${f2.length}; visible far from the centre: ${bad.length}`);
    assert.deepEqual(bad.slice(0, 6), [], 'Koda never crosses the island while it opens or folds');
  } finally { await r.close(); }
  console.log('island-koda-open-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

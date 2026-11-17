'use strict';
/* compact-anywhere T4 (S7), the real page in a real layout engine: the folded disc is drawn `--disc-shift` px from its window's centre
   (the host's logical shift, window.__islandSetShift), so at a screen edge it reaches the window's edge while the window itself stays inside
   the work area. Only the folded disc moves: the open card is laid out as before.
   Run: node test-node/island-disc-shift-page-check.cjs */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-disc-shift-page-check: playwright is not installed here (no real layout engine) — NOT a pass'); process.exit(0); }

const SIDE = (752 - 40) / 2; // 356: the transparent air beside the centred disc

(async () => {
  const r = await H.open({ quick: true });
  try {
    const { page } = r;
    const box = () => page.evaluate(() => { const b = document.getElementById('island').getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width }; });
    const fold = async () => { await page.evaluate(() => window.__islandSetState('compact')); await page.waitForFunction(() => document.getElementById('capsule').dataset.phase === 'compact'); await page.waitForTimeout(900); };
    await fold();
    assert.deepEqual(await box(), { left: SIDE, right: SIDE + 40, width: 40 }, 'no shift: the disc is centred');
    await page.evaluate(s => window.__islandSetShift(s), -SIDE); await page.waitForTimeout(50);
    assert.deepEqual(await box(), { left: 0, right: 40, width: 40 }, 'shift -356: the disc stands at the window\'s left edge');
    await page.evaluate(s => window.__islandSetShift(s), SIDE); await page.waitForTimeout(50);
    assert.deepEqual(await box(), { left: 752 - 40, right: 752, width: 40 }, 'shift +356: at the right edge');
    // the disc takes its own clicks where it is drawn (the native input region follows the same shift, islandshape::shifted)
    const top = await page.evaluate(() => { const b = document.getElementById('island').getBoundingClientRect(); const el = document.elementFromPoint(b.left + 20, b.top + 16); return !!el && document.getElementById('island').contains(el); });
    assert.ok(top, 'the shifted disc is the element under its own centre');
    for (const junk of [NaN, 'x', null, undefined]) {
      await page.evaluate(s => window.__islandSetShift(s), junk); await page.waitForTimeout(30);
      assert.equal((await box()).left, SIDE, `a junk shift (${junk}) reads as 0`);
    }
    // the open card ignores the shift: it keeps itself inside the window (EDGE_GAP) and the host sends 0 for it anyway
    await page.evaluate(s => window.__islandSetShift(s), -SIDE);
    await page.evaluate(() => window.__islandSetState('overview')); await page.waitForTimeout(1500);
    const card = await box();
    assert.equal(Math.round(card.left + card.width / 2), 376, 'the open card stays centred in its window');
    console.log('island-disc-shift-page-check: ok');
  } finally { await r.close(); }
})().catch(e => { console.error(e); process.exit(1); });

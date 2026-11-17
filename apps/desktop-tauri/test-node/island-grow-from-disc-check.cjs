'use strict';
/* compact-anywhere T6 (human, 17-nov: «al abrir la animacion no sale desde donde esta el koda compactado ... que se sienta fluida»).
   The real page in a real layout engine: while the island opens and folds, the box of #island is sampled every frame with the disc at the
   window's left side, in the middle and at the right side. What is MEASURED: the box starts exactly on the disc, ends exactly on the card,
   every frame is between the two and a frame never moves the box's centre by more than a smooth step (no jump), the card never leaves the
   window, and with prefers-reduced-motion it lands at once. What is NOT measured: how fluid it FEELS (frame pacing on a real screen).
   Run: node test-node/island-grow-from-disc-check.cjs */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-grow-from-disc-check: playwright is not installed here (no real layout engine) — NOT a pass'); process.exit(0); }

const WIN = 752;
// the host's two offsets from the window's centre: the folded window sits inside the area (disc far from the centre), the open one is centred on the card
const CASES = [
  { name: 'left edge', folded: [-356, -4], open: [-352, 0] },
  { name: 'middle', folded: [0, 0], open: [0, 0] },
  { name: 'right edge', folded: [356, 4], open: [352, 0] },
];
const SAMPLE = `(() => { const rows = []; const t0 = performance.now(); const el = document.getElementById('island');
  return new Promise(done => { const frame = () => { const b = el.getBoundingClientRect();
    rows.push({ t: Math.round(performance.now() - t0), left: b.left, right: b.right, width: b.width }); if (performance.now() - t0 < WAIT) requestAnimationFrame(frame); else done(rows); };
    requestAnimationFrame(frame); }); })()`;
const centre = r => (r.left + r.right) / 2;

(async () => {
  for (const motion of ['no-preference', 'reduce']) {
    const r = await H.open({ quick: true });
    try {
      const { page } = r;
      await page.emulateMedia({ reducedMotion: motion });
      for (const c of CASES) {
        const run = async (phase, [disc, card], wait) => {
          await page.evaluate(([d, k]) => window.__islandSetShift(d, k), [disc, card]);
          const sampling = page.evaluate(SAMPLE.replace('WAIT', String(wait)));
          await page.evaluate(ph => window.__islandSetState(ph), phase);
          return sampling;
        };
        await page.evaluate(() => window.__islandSetState('compact')); await page.waitForTimeout(1000);
        await page.evaluate(([d, k]) => window.__islandSetShift(d, k), c.folded);
        await page.waitForTimeout(100);
        const folded = await page.evaluate(() => { const b = document.getElementById('island').getBoundingClientRect(); return { left: b.left, right: b.right }; });
        assert.equal(Math.round(centre(folded)), WIN / 2 + c.folded[0], `${c.name}: the folded disc is where the host said`);

        // OPEN: the host moves the window and sends the offsets of the OPEN window first, then the phase (apply_plan's order)
        const open = await run('overview', c.open, 1800);
        const first = open[0], last = open.at(-1);
        const card = { centre: WIN / 2 + c.open[1], width: last.width };
        // with prefers-reduced-motion nothing animates: the box lands on the card at once, so there is no start to measure
        if (motion === 'no-preference') assert.ok(Math.abs(centre(first) - (WIN / 2 + c.open[0])) <= 1.5, `${c.name}/${motion}: the box starts on the disc (${centre(first)} vs ${WIN / 2 + c.open[0]})`);
        assert.ok(Math.abs(centre(last) - card.centre) <= 1, `${c.name}/${motion}: it ends on the card`);
        assert.ok(last.left >= -0.5 && last.right <= WIN + 0.5, `${c.name}/${motion}: the card stays inside its window`);
        const ahead = Math.abs(c.open[0] - c.open[1]);
        // the spring (ZETA .72) overshoots 1 a little, as the width already did: allow 4% of the way beyond either end
        const slack = 2 + ahead * 0.04;
        const lo = Math.min(WIN / 2 + c.open[0], card.centre) - slack, hi = Math.max(WIN / 2 + c.open[0], card.centre) + slack;
        let biggest = 0;
        for (let i = 1; i < open.length; i += 1) {
          assert.ok(centre(open[i]) >= lo && centre(open[i]) <= hi, `${c.name}/${motion}: the box never leaves the disc-to-card path (${centre(open[i])})`);
          biggest = Math.max(biggest, Math.abs(centre(open[i]) - centre(open[i - 1])));
        }
        if (motion === 'no-preference') {
          assert.ok(open.length > 8, `${c.name}: it is animated over several frames (${open.length})`);
          // a smooth step: never more than a third of the whole way in one frame (the old jump was the whole way at once)
          assert.ok(biggest <= Math.max(6, ahead / 3), `${c.name}: no frame moves the centre by ${biggest.toFixed(1)}px (whole way ${ahead})`);
        } else {
          assert.ok(Math.abs(centre(open.at(-1)) - card.centre) <= 1 && open.length >= 1, `${c.name}/reduce: it lands at once on the card`);
        }

        // FOLD: the host sends the offsets of the FOLDED window with the phase
        const fold = await run('compact', c.folded, 1500);
        const end = fold.at(-1);
        assert.ok(Math.abs(centre(end) - (WIN / 2 + c.folded[0])) <= 1.5, `${c.name}/${motion}: it folds back onto the disc (${centre(end)})`);
        let jump = 0;
        for (let i = 1; i < fold.length; i += 1) jump = Math.max(jump, Math.abs(centre(fold[i]) - centre(fold[i - 1])));
        if (motion === 'no-preference') assert.ok(jump <= Math.max(6, ahead / 2), `${c.name}: folding has no jump (biggest step ${jump.toFixed(1)}px)`);
        console.log(`${motion} ${c.name}: open ${open.length} frames, biggest step ${biggest.toFixed(1)}px; fold ${fold.length} frames, biggest step ${jump.toFixed(1)}px`);
      }
    } finally { await r.close(); }
  }
  console.log('island-grow-from-disc-check: ok');
})().catch(e => { console.error(e); process.exit(1); });

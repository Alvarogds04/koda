'use strict';
/* S31 real layout: the expanded island folds to the compact pill after 30 s idle through the host's autoClose verb; interaction resets it;
   typing with the pointer over keeps it; a chat draft survives the fold; a refused fold (pending question) is retried only 30 s later. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  {
    const r = await H.open({ quick: true, fakeClock: true });
    try {
      const phase = () => r.page.evaluate(() => document.getElementById('capsule').dataset.phase);
      assert.equal(await phase(), 'expanded');
      await r.page.mouse.move(300, 100); await r.page.mouse.move(5, 330); // a real interaction NOW (restarts the 30 s), pointer then away
      await r.page.clock.runFor(29000); assert.equal(await phase(), 'expanded', '29 s: still expanded');
      await r.page.clock.runFor(2500); await r.page.waitForTimeout(400);
      assert.equal(await phase(), 'compact', '30 s: folded to the pill');
      assert.equal(await r.page.evaluate(() => (window.__autoCloses || []).length), 1, 'through the host autoClose verb, once');
    } finally { await r.close(); }
  }
  {
    const r = await H.open({ quick: true, fakeClock: true });
    try {
      await r.page.mouse.move(300, 100); await r.page.mouse.move(5, 330);
      await r.page.clock.runFor(20000);
      await r.page.mouse.move(300, 100); await r.page.mouse.move(5, 330); // real interaction at 20 s
      await r.page.clock.runFor(29000);
      assert.equal(await r.page.evaluate(() => document.getElementById('capsule').dataset.phase), 'expanded', 'interaction at 20 s reset the clock (49 s total, still open)');
      await r.page.clock.runFor(2500); await r.page.waitForTimeout(400);
      assert.equal(await r.page.evaluate(() => document.getElementById('capsule').dataset.phase), 'compact');
    } finally { await r.close(); }
  }
  {
    // the pointer parked over the island, even with a typing field focused, never folds it
    const r = await H.open({ quick: true, fakeClock: true });
    try {
      await r.page.mouse.move(300, 100); await r.page.mouse.move(310, 105);
      await r.page.clock.runFor(95000);
      assert.equal(await r.page.evaluate(() => document.getElementById('capsule').dataset.phase), 'expanded', 'a pointer over the island is interaction');
    } finally { await r.close(); }
  }
  {
    // a refused fold (the host protects a pending question) retries only after another full 30 s
    const r = await H.open({ question: 'plain', quick: true, fakeClock: true });
    try {
      await r.page.evaluate(() => { window.__refuseClose = true; });
      await r.page.mouse.move(300, 100); await r.page.mouse.move(5, 330);
      await r.page.clock.runFor(31000); const n1 = await r.page.evaluate(() => window.__autoCloses.length);
      await r.page.clock.runFor(20000); const n2 = await r.page.evaluate(() => window.__autoCloses.length);
      assert.equal(n1, 1); assert.equal(n2, 1, 'no retry loop inside the next 30 s');
      assert.equal(await r.page.evaluate(() => document.getElementById('capsule').dataset.phase), 'expanded', 'a refused fold leaves the question on screen');
    } finally { await r.close(); }
  }
  console.log('island-s31-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });

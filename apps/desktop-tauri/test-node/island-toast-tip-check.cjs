'use strict';
/* R23: (1) in CHAT the question card itself is visible and clickable, with no toast; (2) the GitHub row carries
   NO native title (a second tooltip), only data-tip + aria-label, and the island tip hides on leave. Real layout. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');

// HU-072: GitHub is paused (frontend/paused.js) and the HU-057 notch has no GitHub surface yet; flip to true when HU-072 lands.
const GITHUB_ON_ISLAND = false;
if (!GITHUB_ON_ISLAND) {
  // Deliberate pause, not a skip: run only what is true today (island-github-paused-check) and say plainly that this is NOT a pass.
  const r = require('node:child_process').spawnSync(process.execPath, [require('node:path').join(__dirname, 'island-github-paused-check.cjs')], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('FAIL island-toast-tip-check: the paused-GitHub verification failed'); process.exit(r.status || 1); }
  console.log('PAUSED island-toast-tip-check: GitHub on the island is paused (HU-072); 9 assertions kept but not run — NOT a pass of the GitHub geometry, see HU-072');
  process.exit(0);
}
if (!H.findPlaywright()) { console.log('SKIPPED island-toast-tip-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  {
    const r = await H.open({ question: 'plain', chat: true });
    try {
      const view0 = await r.page.evaluate(() => document.getElementById('capsule').dataset.view);
      assert.equal(view0, 'chat', 'precondition: chat view');
      assert.equal((await r.measure('#question-toast'))[0].shown, false, 'visible card needs no toast');
      assert.ok((await r.measure('#question'))[0].shown, 'card is drawn above chat');
      const hits = await r.hit('#question-options button');
      assert.ok(hits.length >= 2 && hits[0].ok, 'first answer button wins over chat: ' + JSON.stringify(hits));
      const b = (await r.measure('#question-options button'))[0];
      await r.page.mouse.click(b.left + b.w / 2, b.top + b.h / 2);
      await r.page.waitForTimeout(300);
      assert.equal(await r.page.evaluate(() => window.__answered), true, 'card can answer directly from chat');
    } finally { await r.close(); }
  }
  {
    const r = await H.open({ github: true, githubData: 'real', notices: 0, quick: true });
    try {
      const gh = (await r.measure('#pill-choice-integration_github'))[0];
      await r.page.mouse.click(gh.left + gh.w / 2, gh.top + gh.h / 2); await r.page.waitForTimeout(1200);
      const n = await r.page.evaluate(() => [...document.querySelectorAll('.gh-row, .gh-card [title], .pill-choice[title]')].filter(e => e.hasAttribute('title')).map(e => e.className));
      await r.page.waitForSelector('.gh-row', { timeout: 5000 }).catch(() => {}); const info = await r.page.evaluate(() => ({ rows: document.querySelectorAll('.gh-row').length, card: !!document.querySelector('.gh-card'), view: document.getElementById('capsule').dataset.view })); assert.ok(info.rows > 0, 'precondition: GitHub rows drawn ' + JSON.stringify(info)); await r.page.hover('.gh-row', { timeout: 5000 }); await r.page.waitForTimeout(600);
      const after = await r.page.evaluate(() => ({ native: (() => { const b = document.querySelector('.gh-row').getBoundingClientRect(); let c = 0; for (let e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); e && e.id !== 'island'; e = e.parentElement) if (e.hasAttribute('title')) c++; return c; })(), tip: !document.getElementById('island-tip').hidden, text: document.getElementById('island-tip').textContent }));
      assert.equal(after.native, 0, 'the element under the pointer and its ancestors carry no native title');
      assert.ok(after.tip && after.text.length > 3, 'the island tip shows on hover');
      await r.page.mouse.move(5, 300); await r.page.waitForTimeout(300);
      assert.equal(await r.page.evaluate(() => document.getElementById('island-tip').hidden), true, 'the tip hides when the pointer leaves');
      void n;
    } finally { await r.close(); }
  }
  console.log('island-toast-tip-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

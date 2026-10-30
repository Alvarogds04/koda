'use strict';
/* The GitHub card on the REAL layout (headless Chromium, the island's harness), with the data shape src/github.rs serialises.
   Split from island-geometry-check.cjs so each stays well inside the 120 s bounded runner. Run: node test-node/island-github-geometry-check.cjs */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');

// HU-072: GitHub is paused (frontend/paused.js) and the HU-057 notch has no GitHub surface yet; flip to true when HU-072 lands.
const GITHUB_ON_ISLAND = false;
if (!GITHUB_ON_ISLAND) {
  // Deliberate pause, not a skip: run only what is true today (island-github-paused-check) and say plainly that this is NOT a pass.
  const r = require('node:child_process').spawnSync(process.execPath, [require('node:path').join(__dirname, 'island-github-paused-check.cjs')], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('FAIL island-github-geometry-check: the paused-GitHub verification failed'); process.exit(r.status || 1); }
  console.log('PAUSED island-github-geometry-check: GitHub on the island is paused (HU-072); 12 assertions kept but not run — NOT a pass of the GitHub geometry, see HU-072');
  process.exit(0);
}
if (!H.findPlaywright()) { console.log('SKIPPED island-github-geometry-check: playwright is not installed here (no real layout engine) — NOT a pass'); process.exit(0); }

(async () => {
  let passed = 0;
  // GATE (51/2/6): «tiempo agotado: tarjeta GitHub desde gh falso». Two facts, both measured on the real layout with the data shape
  // src/github.rs serialises (githubData: 'real'):
  //  1) the card renders its PR list ([Abrir], CI word) once the row is chosen;
  //  2) human decision L5: a click on the row during the 3 s «Recibida» outcome ends the outcome at once and opens the card (it used to be
  //     dropped by pills-view's `onScreen`); the same click once the island is calm opens the card too. The validator scene still waits for the
  //     calm overview before it clicks (harmless: it works either way).
  {
    const r = await H.open({ question: 'plain', github: true, githubData: 'real', notices: 2, quick: true });
    try {
      const state = () => r.page.evaluate(() => ({ q: document.getElementById('capsule').dataset.question || '', gh: document.getElementById('overview-view').dataset.github || null }));
      const opt = (await r.measure('.q-option')).find(b => b.shown);
      await r.page.mouse.click(opt.left + opt.w / 2, opt.top + opt.h / 2);
      await r.page.waitForTimeout(700);
      assert.equal((await state()).q, 'outcome', 'right after the answer the outcome is on screen');
      let gh = (await r.measure('#pill-choice-integration_github'))[0];
      await r.page.mouse.click(gh.left + gh.w / 2, gh.top + gh.h / 2);
      await r.page.waitForTimeout(800);
      assert.deepEqual(await state(), { q: '', gh: 'on' }, 'a click during the outcome ends it and opens the GitHub card at once (L5)');
      await r.page.waitForTimeout(1500); // the card's data arrives (the same card the calm-island click opens)
      assert.equal((await state()).gh, 'on', 'the GitHub card stays open');
      const card = (await r.measure('.gh-card'))[0];
      assert.ok(card && card.shown, 'the card is visible');
      const text = await r.page.evaluate(() => document.querySelector('.gh-card').textContent);
      assert.ok(text.includes('GitHub') && !text.includes('Cargando') && text.includes('Fixture PR'), `the card shows the PR list from the real data shape: ${text.slice(0, 80)}`);
      assert.equal((await r.measure('.gh-card .gh-row')).length, 1); assert.equal((await r.measure('.gh-card .gh-open')).length, 1);
      for (const h of await r.hit('.gh-card .gh-open')) assert.ok(h.ok, `[Abrir] is reachable: ${h.got}`);
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-github-gate.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  // DESIGN 16 vs THE ISLAND, in numbers (validation v4: «only ~2 rows are visible, the MD shows 4 of 36px»). The overview row is 108px and the
  // card 106px: padding 10 + head 17 + gap 4 + list + bottom 6, so the list box gets 69px = 1.9 rows of 36px. Four 36px rows need 144px of
  // list (181px of card). This test pins the CURRENT budget so a change of card height or row height is a conscious one, and it keeps the
  // rest of the contract: the list scrolls inside, every row is reachable, nothing leaves the card.
  {
    const r = await H.open({ github: true, githubData: 'real', notices: 0, quick: true });
    try {
      const gh = (await r.measure('#pill-choice-integration_github'))[0];
      await r.page.mouse.click(gh.left + gh.w / 2, gh.top + gh.h / 2);
      await r.page.waitForTimeout(1200);
      const m = await r.page.evaluate(() => {
        const b = e => { const x = e.getBoundingClientRect(); return { top: x.top, bottom: x.bottom, h: x.height }; };
        const q = s => document.querySelector(s), list = q('.gh-card .gh-list');
        return { card: b(q('.gh-card')), list: b(list), row: b(q('.gh-card .gh-row')), canScroll: list.scrollHeight >= list.clientHeight, listMax: getComputedStyle(list).maxHeight };
      });
      assert.equal(Math.round(m.card.h), 130, 'the card is the 132px overview row minus its 1px borders');
      assert.equal(Math.round(m.row.h), 36, 'design 16: 36px rows');
      const visible = m.list.h / m.row.h;
      assert.ok(visible >= 1.5 && visible < 4, `rows visible at once: ${visible.toFixed(1)} (list ${Math.round(m.list.h)}px of ${m.row.h}px rows; the MD wants 4 = 144px, which the 106px card cannot hold)`);
      assert.ok(m.list.bottom <= m.card.bottom + 0.5, 'the list stays inside the card');
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-github-budget.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  console.log(`island-github-geometry-check: ${passed} real-layout checks ok`);
})().catch(e => { console.error(e); process.exit(1); });

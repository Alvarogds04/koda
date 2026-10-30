'use strict';
/* GitHub on the island is a PAUSED feature in 0.1.2 (HU-072 will design it on the HU-057 notch). This check is a normal passing check
   that pins what IS true today, so the paused GitHub checks (island-github-geometry, island-toast-tip, gated behind GITHUB_ON_ISLAND)
   cannot hide a different regression:
   1) production pause list: frontend/paused.js (the real module, required) lists `integrations` — the pause feature id that switches
      GitHub off (pills-view.js returns no rows when paused('integrations')). `github` has no id of its own there. Source-level, not page-level.
   2) the REAL page with the production paused.js (no github scenario) has AbitoPaused.paused('integrations') === true;
   3) the notch (idle expanded overview), dark and light, with GitHub un-paused for the harness: no visible [data-pill-id*="github"],
      #pill-choice-integration_github, .gh-card, .gh-row or #blobs; the legacy blobs column is hidden by design (visibility hidden +
      pointer-events none). Run: node test-node/island-github-paused-check.cjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-github-paused-check: playwright is not installed here (no real layout engine) — NOT a pass'); process.exit(0); }

const surface = () => {
  const vis = e => { const s = getComputedStyle(e), b = e.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0 && b.width > 0 && b.height > 0 && s.pointerEvents !== 'none'; };
  const sel = '[data-pill-id*="github"], #pill-choice-integration_github, .gh-card, .gh-row, #blobs';
  const all = [...document.querySelectorAll(sel)];
  const blobs = document.getElementById('blobs'), bs = blobs && getComputedStyle(blobs);
  return {
    shown: all.filter(vis).map(e => e.id || e.className),
    blobs: bs ? { visibility: bs.visibility, pointerEvents: bs.pointerEvents } : null,
    view: document.getElementById('capsule').dataset.view, phase: document.getElementById('capsule').dataset.phase, card: document.getElementById('capsule').dataset.card || null,
    ghBlob: [...document.querySelectorAll('#blobs [id*="github"], #blobs [data-pill-id*="github"]')].map(e => ({ v: getComputedStyle(e).visibility, p: getComputedStyle(e).pointerEvents })),
  };
};

(async () => {
  let passed = 0;
  const { PAUSED, paused } = require(path.join(__dirname, '..', 'frontend', 'paused.js'));
  assert.ok(PAUSED.includes('integrations') && paused('integrations'), `production paused.js lists integrations (the GitHub pause id): ${PAUSED}`);
  passed += 1;
  { // production paused.js served as-is
    const r = await H.open({ notices: 0, quick: true });
    try { assert.equal(await r.page.evaluate(() => window.AbitoPaused.paused('integrations')), true, 'the page runs with integrations (GitHub) paused'); passed += 1; }
    finally { await r.close(); }
  }
  for (const theme of ['dark', 'light']) {
    const r = await H.open({ github: true, githubData: 'real', notices: 0, quick: true, theme });
    try {
      const s = await r.page.evaluate(surface);
      assert.equal(s.phase, 'expanded', `${theme}: the notch is expanded ${JSON.stringify(s)}`);
      assert.equal(s.view, 'overview', `${theme}: idle overview ${JSON.stringify(s)}`);
      assert.deepEqual(s.shown, [], `${theme}: the notch renders no visible GitHub row/card/blob ${JSON.stringify(s)}`);
      assert.ok(s.blobs && s.blobs.visibility === 'hidden' && s.blobs.pointerEvents === 'none', `${theme}: legacy #blobs hidden by design ${JSON.stringify(s.blobs)}`);
      for (const g of s.ghBlob) assert.equal(g.v, 'hidden', `${theme}: legacy GitHub blob hidden by design (its #blobs parent also has pointer-events none) ${JSON.stringify(g)}`);
      assert.equal((await r.measure('.gh-card')).filter(b => b.shown).length, 0, `${theme}: no GitHub card measured on the notch`);
      passed += 1;
    } catch (e) { await r.screenshot(`/tmp/geo-fail-github-paused-${theme}.png`).catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  console.log(`island-github-paused-check: ${passed} checks ok (GitHub paused in 0.1.2; no GitHub surface on the HU-057 notch, dark+light; see HU-072)`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });

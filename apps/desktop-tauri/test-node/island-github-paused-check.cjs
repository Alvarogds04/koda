'use strict';
/* K2-11 S3/S6 — the GitHub surface of the island after K2-11. GitHub used to be paused (0.1.2) and painted in the overview's
   left card; now it has its OWN pause entry and its card is the shortcuts row of the island (island-shortcuts.js, built by
   K2-09). This check pins what is true today, in three parts:
   1) the pause: frontend/paused.js and src/paused.rs keep GitHub's own, ACTIVE entry — and the 0.3 service cards
      (`integrations`) stay paused, so nothing here un-pauses them;
   2) the module: island-github.js registers one card with AbitoShortcuts, wires nothing into the pill column nor the left card,
      and an answer that is not `available:true` (or an older one without the `issues` of S1) paints nothing — criterion 3;
   3) the REAL page with the production paused.js and a host that answers «no»: no .gh-card, no .gh-row, no GitHub pill row and
      no shortcuts card — the card only exists when the host really answers (never sample data).
   Run: node apps/desktop-tauri/test-node/island-github-paused-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const H = require('./island-geometry-harness.cjs');
const P = require(path.join(frontend, 'paused.js'));
const G = require(path.join(frontend, 'island-github.js'));
const read = f => fs.readFileSync(path.join(frontend, f), 'utf8');

const surface = () => {
  const vis = e => { const s = getComputedStyle(e), b = e.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0 && b.width > 0 && b.height > 0 && s.pointerEvents !== 'none'; };
  const sel = '[data-pill-id*="github"], #pill-choice-integration_github, .gh-card, .gh-row, .gh-tile, #nusa-apps [data-go="github"]';
  return {
    shown: [...document.querySelectorAll(sel)].filter(vis).map(e => e.id || e.className),
    apps: document.getElementById('nusa') ? document.getElementById('nusa').dataset.apps || null : null,
    view: document.getElementById('capsule').dataset.view, phase: document.getElementById('capsule').dataset.phase,
  };
};

(async () => {
  let passed = 0;
  // 1) the pause: GitHub's own entry is active; the 0.3 services keep theirs
  assert.equal(P.paused('integrations'), true, 'the service cards stay paused in this version');
  assert.equal(P.paused('github'), false, 'GitHub has its own entry and is not paused (S6)');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'paused.rs'), 'utf8'), /Feature::Github => false/);
  passed += 1;

  // 2) the module: one card in the shortcuts row, nothing else, and no card without a real answer
  const src = read('island-github.js');
  assert.match(src, /registerCard\(\{/);
  assert.match(src, /id: 'github'/);
  // the only trace of the focused-pill path left is a data-attribute mirror (island-geometry-check pins it): no pill row and
  // no «seen» news stock any more
  assert.doesNotMatch(src, /pill-choice|abito:integration-seen|abito:integration-badge|card-left/, 'the pill column and the left card are not its surface any more');
  assert.equal(G.available({ available: false, reason: 'gh_missing' }), false);
  assert.equal(G.available({ available: true, pulse: { login: 'me', myPRs: [], toReview: [], mainCI: [], fetchedAt: 1 } }), false,
    'an answer without the issues of S1 is not a card: never a half card, never an invented row');
  passed += 1;

  // 3) the real page, dark and light, with the production paused.js
  if (!H.findPlaywright()) { console.log('SKIPPED island-github-paused-check: playwright is not installed here (no real layout engine) — NOT a pass'); process.exit(0); }
  for (const theme of ['dark', 'light']) {
    const r = await H.open({ notices: 0, quick: true, theme });
    try {
      const s = await r.page.evaluate(surface);
      assert.equal(s.phase, 'expanded', `${theme}: the notch is expanded ${JSON.stringify(s)}`);
      assert.equal(s.view, 'overview', `${theme}: idle overview ${JSON.stringify(s)}`);
      assert.deepEqual(s.shown, [], `${theme}: no GitHub card, row or pill while the host answers «no» ${JSON.stringify(s)}`);
      assert.equal((await r.measure('.gh-card')).filter(b => b.shown).length, 0, `${theme}: no GitHub card measured on the notch`);
      assert.equal((await r.measure('.gh-tile')).filter(b => b.shown).length, 0, `${theme}: and no pulse tile either`);
      passed += 1;
    } catch (e) { await r.screenshot(`/tmp/geo-fail-github-after-k2-11-${theme}.png`).catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  console.log(`island-github-paused-check: ${passed} checks ok (GitHub has its own active pause entry; its card is the shortcuts row; nothing painted while the host answers «no», dark+light)`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });

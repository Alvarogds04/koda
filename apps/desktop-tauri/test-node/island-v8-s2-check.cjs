'use strict';
/* v8 S2 (02 compacta A) — RE-POINTED by HU-057 (odd/tasks/isla-nusa.md, human decision: «only Koda», no mini-characters/blobs for agents).
   The old contract (up to 3 coloured minis on the compact bar, «+N», the «•••» badge) is gone BY DESIGN. What this check protects now, on the REAL layout:
     1. NO agent mini-character / blob is visible anywhere: compact pill, expanded Inicio, expanded Agentes (#minibots, #mini-grid, #blobs, .mini, .mini-more);
     2. the agents are still reachable: the Agentes tab lists the session rows (.nusa-agent) and «Ver todas (N)» for the rest (14 Pi sessions here);
     3. the compact pill still tells the focused session is working, now through its own state dot (HU-057 S12 pill-dot glow, the «•••» badge is hidden),
        and that signal is NOT there when nothing works. Real layout (island-geometry-harness). */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED: no playwright — NOT a pass'); process.exit(0); }
// «visible» = what a human could see: rendered, not visibility:hidden, not transparent, with a box
const visibleMinis = page => page.evaluate(() => [...document.querySelectorAll('#minibots, #mini-grid, #blobs, .mini, .mini-more, #minibots *, #mini-grid *, #blobs *')].filter(e => {
  const s = getComputedStyle(e), b = e.getBoundingClientRect();
  for (let p = e; p; p = p.parentElement) { const c = getComputedStyle(p); if (c.display === 'none' || c.visibility === 'hidden' || +c.opacity === 0) return false; }
  return b.width > 0 && b.height > 0;
}).map(e => e.id || String(e.className.baseVal ?? e.className)));
const glow = page => page.evaluate(() => getComputedStyle(document.getElementById('island')).boxShadow);
(async () => {
  const r = await H.open({ manyPi: true, quick: true });
  try {
    // expanded Inicio: Koda only
    assert.deepEqual(await visibleMinis(r.page), [], 'HU-057: no mini-characters / blobs in the expanded Inicio');
    // expanded Agentes: no minis, but the sessions are reachable (rows + «Ver todas (14)»)
    await r.page.click('#nusa-tab-agentes', { force: true }); await r.page.waitForTimeout(800);
    assert.deepEqual(await visibleMinis(r.page), [], 'HU-057: no mini-characters / blobs in the Agentes tab');
    const rows = (await r.measure('.nusa-agent')).filter(b => b.shown);
    assert.ok(rows.length >= 2, `the Agentes tab lists the sessions as rows (.nusa-agent): ${rows.length}`);
    assert.ok(rows.some(b => /Pi · proyecto-0/.test(b.text)) && rows.some(b => /Trabaja/.test(b.text)), 'the working session is a row with its state: ' + JSON.stringify(rows.map(b => b.text)));
    const all = (await r.measure('.nusa-all')).filter(b => b.shown);
    assert.equal(all.length, 1); assert.equal(all[0].text, 'Ver todas (14)', 'the rest of the 14 sessions is one click away, no «+11» mini');
    // compact pill: no minis, no «+N», badge not drawn, the pill dot carries the working state
    await r.page.evaluate(() => window.__islandSetState('compact')); await r.page.waitForTimeout(1800);
    assert.deepEqual(await visibleMinis(r.page), [], 'HU-057: no mini-characters in the compact pill');
    const compact = await r.page.evaluate(() => ({ more: (document.querySelector('.mini-more') || {}).textContent, minis: [...document.querySelectorAll('#mini-grid .mini')].filter(e => e.getBoundingClientRect().width > 0).length,
      badge: document.getElementById('compact-badge').getBoundingClientRect().width, fit: document.getElementById('capsule').dataset.pillFit }));
    assert.equal(compact.minis, 0, 'zero rendered minis on the pill'); assert.equal(compact.badge, 0, 'the «•••» badge is not drawn on the fitted pill'); assert.equal(compact.fit, 'true');
    const working = await glow(r.page);
    assert.match(working, /rgb\(\d+, \d+, \d+\) 0px -12px 14px -12px inset/, 'a working session lights the pill dot: ' + working);
  } finally { await r.close(); }
  // contrast: with nothing running the pill dot must not claim «working» (so the check above cannot pass vacuously)
  const idle = await H.open({ sessions: [], quick: true });
  try {
    await idle.page.evaluate(() => window.__islandSetState('compact')); await idle.page.waitForTimeout(1800);
    const g = await glow(idle.page);
    assert.doesNotMatch(g, /rgb\(45, 255, 172\)/, 'no session working: the pill dot is not the working green: ' + g);
  } finally { await idle.close(); }
  console.log('island-v8-s2-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });

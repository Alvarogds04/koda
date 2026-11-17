'use strict';
/* S5 (05 vacía, A): empty island = «Todo tranquilo» + one primary «Preguntar a Abito», Abito asleep; text fits on one line. Real layout.
   HU-057 L4/L5: the empty legacy view (#centre-empty, «Todo tranquilo», CTA «Preguntar a Abito») is hidden in the Nusa notch by design.
   Equivalent on Nusa Inicio (welcome-home): sub-line «Koda · en reposo», no ask field, three icon buttons (Chat, Agentes, Avisos) that receive their click,
   text fits, Koda asleep. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s5-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  const r = await H.open({ sessions: [], engine: 'account' });
  try {
    const legacy = await r.page.evaluate(() => ['centre-empty', 'centre-cta'].map(id => getComputedStyle(document.getElementById(id)).visibility));
    assert.deepEqual(legacy, ['hidden', 'hidden'], 'HU-057: the legacy empty view and its CTA are hidden in the Nusa state');
    const t = await r.page.evaluate(() => ({ sub: document.getElementById('nusa-panel').innerText.trim(),
      fits: [...document.querySelectorAll('#nusa-panel .nusa-sub')].every(e => e.scrollWidth <= e.clientWidth + 1),
      field: document.querySelectorAll('#nusa-panel .nusa-field, #nusa-panel .nusa-input, #nusa-panel .nusa-send').length }));
    assert.ok(t.sub.startsWith('Koda · en reposo'), 'Nusa empty sub-line: ' + t.sub); // Koda 0.1 T2
    assert.ok(t.fits, 'text fits on one line'); assert.ok(t.sub.split('\n')[0].length <= 34, 'one short line: ' + t.sub);
    // welcome-home: the CTA that replaced «Preguntar» (the ask field) is gone too; the empty Inicio is Koda and three icon buttons (Hoy and Ajustes are the header's), each receiving its click
    assert.equal(t.field, 0, 'no ask field in the empty Inicio');
    const hits = await r.hit('#nusa-panel .nusa-dock button'); assert.equal(hits.length, 3, 'three icon buttons');
    for (const h of hits) assert.ok(h.ok, 'the icon button receives its click: ' + JSON.stringify(h));
    const st = await r.page.evaluate(() => window.__clayState && window.__clayState());
    if (st !== undefined) assert.equal(st, 'sleeping');
  } finally { await r.close(); }
  console.log('island-s5-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

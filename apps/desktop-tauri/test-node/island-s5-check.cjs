'use strict';
/* S5 (05 vacía, A): empty island = «Todo tranquilo» + one primary «Preguntar a Abito», Abito asleep; text fits on one line. Real layout.
   HU-057 L4/L5: the empty legacy view (#centre-empty, «Todo tranquilo», CTA «Preguntar a Abito») is hidden in the Nusa notch by design.
   Equivalent on Nusa Inicio: sub-line «Abito · en reposo», the one prompt field «Pedile algo a Abito…» (replaces the CTA) receives its click,
   a single send action, text fits, Abito asleep. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s5-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  const r = await H.open({ sessions: [], engine: 'account' });
  try {
    const legacy = await r.page.evaluate(() => ['centre-empty', 'centre-cta'].map(id => getComputedStyle(document.getElementById(id)).visibility));
    assert.deepEqual(legacy, ['hidden', 'hidden'], 'HU-057: the legacy empty view and its CTA are hidden in the Nusa state');
    const t = await r.page.evaluate(() => { const i = document.querySelector('.nusa-input'); return { sub: document.getElementById('nusa-panel').innerText.trim(), ph: i.placeholder,
      fits: [...document.querySelectorAll('#nusa-panel .nusa-sub, .nusa-input')].every(e => e.scrollWidth <= e.clientWidth + 1) }; });
    assert.ok(t.sub.startsWith('Koda · en reposo'), 'Nusa empty sub-line: ' + t.sub); // Koda 0.1 T2
    assert.equal(t.ph, 'Pedile algo a Koda… (o dictalo)'); assert.ok(t.fits, 'text fits on one line');
    assert.ok(t.sub.length <= 34, 'one short line: ' + t.sub);
    const hit = (await r.hit('.nusa-input'))[0]; assert.ok(hit && hit.ok, 'the Nusa prompt field receives its click');
    const sends = await r.page.evaluate(() => [...document.querySelectorAll('#nusa-panel .nusa-send')].filter(e => e.getBoundingClientRect().width > 0).length);
    assert.equal(sends, 1, 'a single send action');
    const st = await r.page.evaluate(() => window.__clayState && window.__clayState());
    if (st !== undefined) assert.equal(st, 'sleeping');
  } finally { await r.close(); }
  console.log('island-s5-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

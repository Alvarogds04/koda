'use strict';
/* nusa-home (human, 16-nov: «cuando este navegando por pantallas de koda que tenga el boton home en el medio»; chose «Abajo al centro»):
   away from the Inicio (Agentes, Avisos, or Hoy open) the island shows a house disc, bottom and CENTRED, that goes back to the Inicio. The pager dots
   (same spot) step to its left, so nothing overlaps. On the Inicio itself there is no home button. Real layout, real clicks. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-home-check: no playwright — NOT a pass'); process.exit(0); }
const read = r => r.page.evaluate(() => {
  const box = e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height, cx: (b.left + b.right) / 2 }; };
  const home = document.getElementById('nusa-home'), isl = box(document.getElementById('island')), dots = document.getElementById('nusa-dots');
  const shown = !!home && getComputedStyle(home).display !== 'none' && getComputedStyle(home).visibility !== 'hidden' && home.getBoundingClientRect().width > 0;
  let hit = false; if (shown) { const b = home.getBoundingClientRect(), t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); hit = t === home || home.contains(t); }
  const dotBoxes = [...dots.querySelectorAll('[role="tab"]')].map(box);
  return { shown, hit, home: home && box(home), label: home && home.getAttribute('aria-label'), isl, dotsRight: dotBoxes.length ? Math.max(...dotBoxes.map(d => d.r)) : null,
    tab: document.getElementById('nusa').dataset.tab, hoy: document.getElementById('capsule').dataset.hoy || null };
});
(async () => {
  const r = await H.open({ sessions: [], engine: 'ok', hoy: [] });
  try {
    await r.page.waitForTimeout(600);
    let m = await read(r);
    assert.equal(m.shown, false, 'no home button on the Inicio itself: ' + JSON.stringify(m.home));
    for (const tab of ['agentes', 'avisos']) {
      await H.goTab(r.page, tab); await r.page.waitForTimeout(500);
      m = await read(r);
      assert.equal(m.tab, tab, 'on ' + tab);
      assert.ok(m.shown, `${tab}: the home button is shown`);
      assert.equal(m.label, 'Inicio', `${tab}: it is named «Inicio»`);
      assert.ok(Math.abs(m.home.cx - m.isl.cx) <= 3, `${tab}: centred ${m.home.cx} vs ${m.isl.cx}`);
      assert.ok(m.home.b <= m.isl.b && m.home.t >= m.isl.t + 60, `${tab}: at the bottom, inside the island ${JSON.stringify(m.home)}`);
      assert.ok(m.home.w >= 24 && m.home.h >= 24, `${tab}: at least a 24px disc`);
      assert.ok(m.hit, `${tab}: it receives the click (nothing covers it)`);
      assert.ok(m.dotsRight <= m.home.l, `${tab}: the pager dots step to its left, no overlap (${m.dotsRight} vs ${m.home.l})`);
      await r.page.click('#nusa-home'); await r.page.waitForTimeout(500);
      m = await read(r);
      assert.equal(m.tab, 'inicio', `${tab}: a real click goes back to the Inicio`);
      assert.equal(m.shown, false, `${tab}: and the button goes away on the Inicio`);
    }
    // Hoy open: the same button, and it closes Hoy and lands on the Inicio
    await r.page.click('#open-hoy'); await r.page.waitForTimeout(600);
    m = await read(r);
    assert.equal(m.hoy, 'open', 'Hoy is open');
    assert.ok(m.shown && m.hit, 'Hoy: the home button is shown and clickable');
    assert.ok(Math.abs(m.home.cx - m.isl.cx) <= 3, 'Hoy: centred');
    await r.page.click('#nusa-home'); await r.page.waitForTimeout(600);
    m = await read(r);
    assert.equal(m.hoy, null, 'Hoy: the click closes Hoy');
    assert.equal(m.tab, 'inicio', 'Hoy: and lands on the Inicio');
    assert.equal(m.shown, false, 'Hoy: and the button goes away');
  } finally { await r.close(); }
  // a script's click is not a decision: a synthetic click does nothing
  const f = await H.open({ sessions: [], engine: 'ok' });
  try {
    await f.page.waitForTimeout(500); await H.goTab(f.page, 'agentes'); await f.page.waitForTimeout(400);
    await f.page.evaluate(() => document.getElementById('nusa-home').click()); await f.page.waitForTimeout(300);
    assert.equal(await f.page.evaluate(() => document.getElementById('nusa').dataset.tab), 'agentes', 'a synthetic click (isTrusted false) does not move the island');
  } finally { await f.close(); }
  console.log('island-nusa-home-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

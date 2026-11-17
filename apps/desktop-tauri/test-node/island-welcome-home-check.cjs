'use strict';
/* welcome-home (odd/tasks/welcome-home.md S1-S8): the Inicio is Koda alone, centred, with «Koda · en reposo» under it and five icon
   buttons below. No ask field. Real layout, notch height unchanged (150). Each icon is clicked FOR REAL and its outcome is measured.
   16-nov (human, on his screen): the engine band («Sin motor», «Sin cuenta») is NOT shown in the Inicio (it confuses a new user: it belongs to the
   conversations), the dock has no icon that repeats a header disc (Hoy and Ajustes are in the header), and Koda is not stuck in the error pose. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-welcome-home-check: no playwright — NOT a pass'); process.exit(0); }
const DOCK = [['Conversar con Koda'], ['Agentes'], ['Avisos']];
(async () => {
  const r = await H.open({ sessions: [], engine: 'account' });
  try {
    await r.page.waitForTimeout(500);
    const m = await r.page.evaluate(() => {
      const box = e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
      const dock = document.querySelector('#nusa-panel .nusa-dock'), k = document.querySelector('.koda-sprite[data-koda-slot="nusa"]');
      const band = document.getElementById('engine-band'), disc = id => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { w: b.width, shown: getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' }; };
      return { band: band ? { hidden: band.hidden, display: getComputedStyle(band).display } : null, kodaAnim: window.__koda && window.__koda.current, headerHoy: disc('open-hoy'), headerAjustes: disc('open-settings'),
        sub: document.getElementById('nusa-panel').innerText, field: document.querySelectorAll('#nusa-panel .nusa-field, #nusa-panel .nusa-input, #nusa-panel .nusa-send').length,
        notch: box(document.getElementById('nusa')), island: box(document.getElementById('island')), right: box(document.getElementById('nusa-right')),
        dock: dock && box(dock), koda: k && box(k), kodaIn: !!k && document.getElementById('nusa-right').contains(k),
        labels: dock ? [...dock.querySelectorAll('button')].map(b => b.getAttribute('aria-label')) : null,
        btns: dock ? [...dock.querySelectorAll('button')].map(b => box(b)) : [] };
    });
    assert.equal(m.field, 0, 'S4: no ask field in the Inicio');
    assert.ok(m.sub.includes('Koda · en reposo'), 'S3: the real state text stays: ' + JSON.stringify(m.sub));
    assert.equal(m.notch.h, 150, 'S5: the notch stays 150');
    // the engine band is a conversation matter: with no account it must not appear on the welcome, and the island stays 150 (it used to grow to 186)
    assert.ok(m.band && m.band.display === 'none', 'the engine band is not shown in the Inicio: ' + JSON.stringify(m.band));
    assert.equal(Math.round(m.island.h), 150, 'with no engine band the island stays 150, not 186: ' + m.island.h);
    assert.ok(!['error', 'asustado'].includes(m.kodaAnim), 'Koda is not stuck in the error pose on the welcome: ' + m.kodaAnim);
    // Hoy and Ajustes live in the header; the dock must not repeat them
    assert.ok(m.headerHoy && m.headerHoy.shown && m.headerAjustes && m.headerAjustes.shown, 'the header keeps its Hoy and Ajustes discs: ' + JSON.stringify([m.headerHoy, m.headerAjustes]));
    assert.ok(m.dock, 'S2: a dock of icon buttons exists'); if (!m.dock) throw new Error('no dock');
    assert.deepEqual(m.labels, DOCK.map(d => d[0]), 'S2: three buttons (Chat, Agentes, Avisos), real names, in order; Hoy and Ajustes are the header\'s');
    assert.ok(m.dock.b <= m.notch.b - 4, `S5: the dock is inside the 150 notch ${JSON.stringify(m.dock)}`);
    assert.deepEqual([m.koda.w, m.koda.h], [64, 64], 'S5/S6: Koda stays x2 = 64');
    assert.ok(m.kodaIn, 'S6: Koda is still drawn inside #nusa-right');
    assert.ok(Math.abs((m.koda.l + m.koda.r) / 2 - (m.island.l + m.island.r) / 2) <= 3, `S1: Koda is centred ${JSON.stringify(m.koda)} vs ${JSON.stringify(m.island)}`);
    assert.ok(m.koda.b <= m.dock.t + 1, 'Koda sits above the dock, no overlap');
    for (const b of m.btns) assert.ok(b.w >= 24 && b.h >= 24, 'S8: each icon is at least 24px');
    const hits = await r.hit('#nusa-panel .nusa-dock button'); assert.equal(hits.length, 3); for (const h of hits) assert.ok(h.ok, 'S8: each icon receives its click: ' + JSON.stringify(h));
    // the label shows on focus only: take the mouse away (a hovered icon shows its label too) and let the 150ms fade finish before reading
    // a key press puts the page in keyboard modality: after a mouse click a script focus() does not match :focus-visible, which is the intended rule
    await r.page.mouse.move(2, 2); await r.page.keyboard.press('Shift');
    await r.page.evaluate(() => document.querySelectorAll('#nusa-panel .nusa-dock button')[1].focus());
    await r.page.waitForTimeout(400);
    const tip = await r.page.evaluate(() => [...document.querySelectorAll('#nusa-panel .nusa-dock button')].map(b => { return +getComputedStyle(b, '::after').opacity; }));
    assert.deepEqual(tip.map(o => o > 0), [false, true, false], 'S2/S8: the label appears on the focused icon only');
    const h2 = await r.page.evaluate(() => document.getElementById('nusa').getBoundingClientRect().height); assert.equal(h2, 150, 'focus does not grow the notch');
    // Each icon must WORK, not merely fire: the destinations ignore a synthetic click (isTrusted), so this section makes REAL clicks and measures the
    // outcome with no spy and no preventDefault. The harness already records every host command in window.__allCalls.
    const st = () => r.page.evaluate(() => ({ tab: document.getElementById('nusa').dataset.tab, hoy: document.getElementById('capsule').dataset.hoy || null, inv: (window.__allCalls || []).map(c => c.cmd + ':' + (c.payload && c.payload.action)) }));
    const dock = label => r.page.click(`#nusa-panel .nusa-dock button[aria-label="${label}"]`);
    const home = async () => { await r.page.click('#nusa-tab-inicio'); await r.page.waitForTimeout(300); assert.equal((await st()).tab, 'inicio', 'back on the Inicio'); };
    await dock('Avisos'); await r.page.waitForTimeout(300); assert.equal((await st()).tab, 'avisos', 'S2: «Avisos» really opens Avisos'); await home();
    await dock('Agentes'); await r.page.waitForTimeout(300); assert.equal((await st()).tab, 'agentes', 'S2: «Agentes» really opens Agentes'); await home();
    await dock('Conversar con Koda'); await r.page.waitForTimeout(300); assert.ok((await st()).inv.includes('chat_action:open'), 'S2: «Conversar con Koda» really asks the host to open the chat: ' + JSON.stringify((await st()).inv));
  } finally { await r.close(); }
  // The dock asks for a tab with an event, and an event dispatched by a script is never trusted: the listener must only act when the plain
  // idle Inicio (the one that has the dock) is showing. With a question waiting for an answer it must do nothing.
  const q = await H.open({ question: 'plain', sessions: [], engine: 'account' });
  try {
    await q.page.waitForTimeout(900);
    const before = await q.page.evaluate(() => ({ q: document.getElementById('capsule').dataset.question || '', tab: document.getElementById('nusa').dataset.tab, hoy: document.getElementById('capsule').dataset.hoy || null }));
    assert.equal(before.q, 'pending', 'a question is waiting: ' + JSON.stringify(before));
    await q.page.evaluate(() => { window.__allCalls = []; for (const [n, d] of [['abito:nusa-go', { tab: 'agentes' }], ['abito:nusa-go', { tab: 'avisos' }]]) document.dispatchEvent(new CustomEvent(n, d ? { detail: d } : undefined)); });
    await q.page.waitForTimeout(500);
    const after = await q.page.evaluate(() => ({ tab: document.getElementById('nusa').dataset.tab, hoy: document.getElementById('capsule').dataset.hoy || null, inv: (window.__allCalls || []).map(c => c.cmd + ':' + (c.payload && c.payload.action)) }));
    assert.equal(after.tab, before.tab, 'a forged abito:nusa-go does not move the tabs behind a pending question');
  } finally { await q.close(); }
  console.log('island-welcome-home-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

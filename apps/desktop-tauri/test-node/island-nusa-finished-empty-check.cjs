'use strict';
/* «Un "Terminó" nunca debe mostrarse sin contenido» (human + parent decision).
   When the agent of the open notice runs again, the card hides; the Terminó/Error take-over (shell, title, Koda, veil) must go with it
   and the island returns to the plain overview. Real layout via the geometry harness, dark + light. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-finished-empty-check: no playwright — NOT a pass'); process.exit(0); }
const UUID = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b';
const snap = r => r.page.evaluate(() => {
  const c = document.getElementById('capsule'), card = document.getElementById('notice-card'), nz = document.getElementById('notices');
  const box = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { w: b.width, h: b.height }; };
  return { takeover: c.dataset.takeover || null, view: c.dataset.view, noticeView: c.dataset.noticeView || null, title: (document.getElementById('nusa-title') || {}).textContent || '',
    island: box(document.getElementById('island')), card: box(card), cardHidden: !!card && card.hidden, notices: box(nz), strip: c.dataset.noticeStrip || null,
    veil: (document.getElementById('nusa') || {}).dataset?.veil || null, cardText: card ? card.textContent : '' };
});
const cardVisible = s => s.card && !s.cardHidden && s.card.w > 100 && s.card.h > 40;
const noEmpty = (s, why) => {
  const lane = s.view === 'notices';
  if ((s.takeover === 'finished' || s.takeover === 'error') && lane) assert.ok(cardVisible(s), `${why}: take-over without a card ${JSON.stringify(s)}`);
};
const notEmptyShell = (s, why) => {
  assert.notEqual(s.takeover, 'finished', `${why}: takeover finished ${JSON.stringify(s)}`);
  assert.notEqual(s.takeover, 'error', `${why}: takeover error ${JSON.stringify(s)}`);
  assert.ok(!/Terminó|Error/.test(s.title), `${why}: title «${s.title}»`);
  assert.notEqual(s.view, 'notices', `${why}: lane still open`);
  assert.ok(!s.notices || s.notices.h === 0 || s.notices.h > 20, `${why}: 2px #notices sliver ${JSON.stringify(s.notices)}`);
  if (s.strip === 'on') assert.equal(Math.round(s.island.h), 186, why); else assert.equal(Math.round(s.island.h), 150, `${why}: island is the 150 overview ${JSON.stringify(s.island)}`);
};
(async () => {
  for (const theme of ['dark', 'light']) {
    // (a) Claude Code running + its own finished notice -> no empty take-over
    let r = await H.open({ finishedCard: 'claude-code', quick: true, theme });
    try {
      await r.screenshot(`/tmp/finished-empty-${process.env.FE_TAG || 'run'}-${theme}.png`);
      for (const wait of [0, 2500]) { await r.page.waitForTimeout(wait ? wait : 0); notEmptyShell(await snap(r), `${theme} (a) +${wait}`); }
    } finally { await r.close(); }
    // (b) control: card shown
    r = await H.open({ finishedCard: 'pi', sessions: [], quick: true, theme });
    try {
      const s = await snap(r);
      assert.equal(s.takeover, 'finished'); assert.match(s.title, /Terminó/);
      assert.equal(Math.round(s.card.w), 570); assert.equal(Math.round(s.card.h), 96);
      const btn = await r.measure('#notice-card-terminal, #notice-card-ok, #notice-card button');
      assert.ok(btn.some(b => b.shown), `${theme} (b) Ver/OK present`);
    } finally { await r.close(); }
    // (c) error notice, agent running
    r = await H.open({ noticeRows: [{ id: UUID, title: 'Claude Code falló', detail: 'Boom', severity: 'error', kind: 'settled', expiresAt: Date.now() + 600000, agent: 'claude-code', projectName: 'api' }], noLane: true, finishedCard: undefined, quick: true, theme });
    try {
      await r.page.evaluate(id => window.__emit('desktop:notice-open', { id, kind: 'finished' }), UUID); await r.page.waitForTimeout(2000);
      const s = await snap(r); notEmptyShell(s, `${theme} (c)`);
    } finally { await r.close(); }
    // (d) invariant sweep
    const scenarios = [];
    for (const a of ['pi', 'claude-code', 'codex']) { scenarios.push({ finishedCard: a, quick: true, theme }); scenarios.push({ finishedCard: a, sessions: [], quick: true, theme }); }
    for (const n of [1, 2, 3]) scenarios.push({ notices: n, quick: true, theme });
    for (const sc of scenarios) {
      r = await H.open(sc);
      try { noEmpty(await snap(r), `${theme} (d) ${JSON.stringify({ ...sc, theme: 0 })}`); } finally { await r.close(); }
    }
  }
  console.log('island-nusa-finished-empty-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

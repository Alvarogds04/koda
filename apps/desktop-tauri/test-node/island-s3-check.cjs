'use strict';
/* island-free-drag S3 + S5 (human: «que no aparezca la barra y que directamente sea nada más el circulito. Y si le hacés clic al
   circulito, te abre» / pending question = a signal on the circle): on the REAL layout, with a pending Pi question in compact,
    1. the island is ONLY the disc (40x32) — the old 560 «Responder» bar is gone, so is its text and its button;
    2. the disc DOES carry the signal: its own state dot is painted in the waiting role colour (and its accessible name says what waits);
    3. a click on the disc opens the island, where the question card is readable.
   Run: node apps/desktop-tauri/test-node/island-s3-check.cjs */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s3-check: no playwright — NOT a pass'); process.exit(0); }
const discDot = page => page.evaluate(() => {
  const isl = document.getElementById('island');
  const dot = getComputedStyle(isl, '::after');
  const flag = document.getElementById('compact-flag');
  const cap = document.getElementById('capsule');
  const act = document.getElementById('compact-activity');
  const b = isl.getBoundingClientRect();
  return { w: Math.round(b.width), h: Math.round(b.height), dotContent: dot.content, dotBg: dot.backgroundColor,
    flagName: flag.getAttribute('aria-label'), flagClipped: getComputedStyle(flag).clipPath, activity: act.textContent,
    activityShown: getComputedStyle(act).display !== 'none', reply: document.getElementById('compact-reply'), phase: cap.dataset.phase };
});
(async () => {
  const r = await H.open({ question: 'plain', quick: true });
  try {
    // the host tells the page the island is compact (the page never invents its own phase: Rust owns the toggle)
    const compactState = await r.page.evaluate(() => ({ state: 'compact', notices: [], card: null, request: null, revision: 99, motionOverride: false, unavailable: false, connections: 1 }));
    await r.page.evaluate(() => window.__islandSetState('compact'));
    await r.page.evaluate(s => window.__emit('desktop:state', s), compactState);
    await r.page.waitForTimeout(1500);
    const m = await discDot(r.page);
    assert.equal(m.phase, 'compact');
    assert.deepEqual([m.w, m.h], [40, 32], 'S3: compact is ONLY the disc (40x32), in a pending-question state too');
    assert.equal(m.reply, null, 'S3: the «Responder» pill of the old wide compact bar is gone from the DOM');
    assert.equal(m.activity, '', 'S3: no compact text line');
    assert.equal(m.activityShown, false, 'S3: and it is never drawn');
    // S5: the pending question is a VISIBLE signal on the circle: the disc's own dot, in the waiting role colour
    assert.notEqual(m.dotContent, 'none', 'S5: the disc paints its state dot');
    const sun = await r.page.evaluate(() => { const p = document.createElement('i'); document.getElementById('capsule').append(p); p.style.background = 'var(--sun)'; const c = getComputedStyle(p).backgroundColor; p.remove(); return c; });
    assert.equal(m.dotBg, sun, `S5: the dot is the waiting colour (${m.dotBg} vs ${sun})`);
    assert.match(String(m.flagName), /Pi espera tu respuesta/, 'S5: the signal still has an accessible name while compact');
    assert.match(m.flagClipped, /inset\(/, 'S5: the loose flag is visually hidden, only the disc dot is seen');
    // S3: a click on the disc opens the island, and the question is READ there (S5: «el question UI is shown when opened»)
    const box = await r.page.evaluate(() => { const b = document.getElementById('island').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await r.page.mouse.click(box.x, box.y);
    await r.page.waitForTimeout(1800);
    const open = await r.page.evaluate(() => ({ phase: document.getElementById('capsule').dataset.phase,
      question: !document.getElementById('question').hidden, body: document.getElementById('question-body').textContent }));
    assert.equal(open.phase, 'expanded', 'S3: the click on the disc opens the island');
    assert.equal(open.question, true, 'S5: the pending question is shown once the island is open, never dropped');
    assert.match(open.body, /¿Qué editor preferís\?/);
  } finally { await r.close(); }
  console.log('island-s3-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

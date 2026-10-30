'use strict';
/* S13 (13 Sileo, A): the question toast has a progress bar and an 8 s timer; hover/focus PAUSE both; role=status announces it once;
   it closes by itself when the time is up. Real layout on the hidden strip (R23: chat now shows the card). */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s13-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  const r = await H.open({ question: 'plain', chat: true });
  try {
    await r.page.evaluate(() => {
      window.__islandSetState('compact');
      document.getElementById('capsule').dataset.edgeHidden = 'true';
    });
    await r.page.waitForTimeout(900);
    const st = () => r.page.evaluate(() => { const b = document.querySelector('.q-toast-progress'), t = document.getElementById('question-toast'); return { bar: !!b, play: b && getComputedStyle(b).animationPlayState, hidden: t.hidden || getComputedStyle(t).display === 'none', live: document.getElementById('question-toast-live') && document.getElementById('question-toast-live').textContent, role: document.getElementById('question-toast-live') && document.getElementById('question-toast-live').getAttribute('role') }; });
    let s = await st();
    assert.ok(s.bar, 'progress bar exists'); assert.equal(s.play, 'running'); assert.equal(s.role, 'status'); assert.match(s.live, /pregunta/i, 'announced politely');
    const t = (await r.measure('#question-toast'))[0];
    await r.page.mouse.move(t.left + 20, t.top + 20); await r.page.waitForTimeout(600);
    s = await st(); assert.equal(s.play, 'paused', 'hover pauses the bar');
    await r.page.waitForTimeout(9000); s = await st(); assert.equal(s.hidden, false, 'still here after 9 s while hovered');
    await r.page.mouse.move(5, 330); await r.page.waitForTimeout(1500); s = await st(); assert.equal(s.play, 'running', 'leaving resumes it');
    await r.page.waitForTimeout(9000); s = await st(); assert.equal(s.hidden, false, 'v8: the toast is the ONLY click target to the question here (hidden strip), so the timer folds its body but never removes it');
    const exp = await r.page.evaluate(() => document.getElementById('question-toast').dataset.expanded); assert.equal(exp, 'false', 'the timer collapsed the expanded body');
    const t2 = (await r.measure('#question-toast'))[0]; assert.ok(t2.shown && t2.h >= 30, 'the pill is still drawn and clickable');
    assert.ok((await r.hit('#question-toast'))[0].ok);
  } finally { await r.close(); }
  console.log('island-s13-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });

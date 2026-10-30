'use strict';
/* HU-063 bug, human decision A: with the chat open over a pending question the QUESTION wins. #question stays visible and clickable;
   #chat stays visible but dimmed and inert (inert + aria-hidden + opacity<1 + not hit-testable); no take-over shell under the chat.
   When the question is gone the chat is fully usable again and its draft is untouched. Real layout (island-geometry-harness). */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-chat-over-question-check: no playwright — NOT a pass'); process.exit(0); }
const snap = () => {
  const q = document.getElementById('question'), c = document.getElementById('chat'), cap = document.getElementById('capsule'), cs = getComputedStyle(c);
  const at = el => { const b = el.getBoundingClientRect(), t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!t && el.contains(t); };
  const i = document.getElementById('chat-input'), ib = i.getBoundingClientRect(), it = document.elementFromPoint(ib.left + ib.width / 2, ib.top + ib.height / 2);
  const cb = c.getBoundingClientRect(), ct = document.elementFromPoint(cb.left + cb.width / 2, cb.top + cb.height / 2);
  return { view: cap.dataset.view, take: cap.dataset.takeover || null, qVis: getComputedStyle(q).visibility, qInert: q.inert, qHit: at(q),
    inert: c.hasAttribute('inert'), aria: c.getAttribute('aria-hidden'), op: +cs.opacity, chatHit: !!ct && c.contains(ct), inputHit: !!it && i.contains(it),
    draft: i.value, active: document.activeElement && (c.contains(document.activeElement) ? 'chat' : q.contains(document.activeElement) ? 'question' : 'other') };
};
(async () => {
  const r = await H.open({ question: 'plain' });
  try {
    await r.page.waitForTimeout(500);
    await r.page.evaluate(() => { window.__islandSetView('chat', 720, 240); document.getElementById('chat-input').value = 'borrador'; document.getElementById('chat-input').focus(); });
    await r.page.waitForTimeout(900);
    let s = await r.page.evaluate(snap);
    assert.equal(s.view, 'chat'); assert.equal(s.take, null, 'no take-over shell under the chat');
    assert.ok(s.qVis === 'visible' && !s.qInert && s.qHit, `the question stays visible, active and clickable: ${JSON.stringify(s)}`);
    assert.ok(s.inert && s.aria === 'true' && s.op < 1 && !s.chatHit && !s.inputHit, `the chat is dimmed and inert: ${JSON.stringify(s)}`);
    assert.notEqual(s.active, 'chat', 'focus is not trapped in the inert chat');
    // failed back: the view stays chat; the chat stays inert while the question is pending
    await r.page.waitForTimeout(800);
    s = await r.page.evaluate(snap);
    assert.ok(s.view === 'chat' && s.inert && s.aria === 'true' && s.qHit, `still inert while the question is pending: ${JSON.stringify(s)}`);
    // answered/cleared: the chat is usable again, draft kept
    await r.page.evaluate(() => window.__emit('question:state', { available: true, native_transition: 'idle', pending: null, queued: [], queued_count: 0, deliveries: [] }));
    await r.page.waitForTimeout(900);
    s = await r.page.evaluate(snap);
    assert.equal(s.view, 'chat');
    assert.ok(!s.inert && s.aria === null && s.op === 1 && s.chatHit && s.inputHit, `the chat is usable again: ${JSON.stringify(s)}`);
    assert.equal(s.draft, 'borrador', 'draft preserved');
    await r.page.focus('#chat-input');
    assert.equal(await r.page.evaluate(() => document.activeElement.id), 'chat-input', 'chat input focusable');
  } finally { await r.close(); }
  console.log('island-nusa-chat-over-question-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

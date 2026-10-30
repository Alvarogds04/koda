'use strict';
/* Human 29-oct (by0kwvcp): «quiero koda sea mas grande y ocupe toda la parte vacia de la izquierda» — in the CHAT view Koda is BIG (integer
   scale x2..x4 of the 32 px cell), centred in the free left column, never under chat content. Pure layout + real layout (Playwright). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const K = require('../frontend/koda-logic.js');
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };
test('nusa-chat: largest integer scale of the 32 px cell that fits the column box, x2..x4', () => {
  for (const [box, k] of [[0, 2], [40, 2], [64, 2], [96, 3], [127, 3], [128, 4], [200, 4]]) assert.deepEqual(K.layoutFor('respirar', 'nusa-chat', box), { cell: 32, k }, 'box ' + box);
  assert.equal(K.layoutFor('reposo', 'nusa-chat', 128).cell, 32);
});
test('skin source: placeMain has a chat branch that never writes transform', () => {
  const s = fs.readFileSync(__dirname + '/../frontend/koda-skin.js', 'utf8');
  const pm = s.slice(s.indexOf('function placeMain'), s.indexOf('const flowAnim'));
  assert.match(pm, /nusa-chat/); assert.match(pm, /dataset\.view === 'chat'/); assert.doesNotMatch(pm, /style\.transform/);
});
console.log(`koda-chat-check (pure): ${passed} passed`);

const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED koda-chat-check (layout): no playwright — NOT a pass'); process.exit(0); }
const CTRL = 'button, a[href], input, textarea, select, [role="button"], [tabindex="0"], #chat-log, #chat-log *';
const measure = r => r.page.evaluate(sel => {
  const rect = e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
  const k = document.querySelector('.koda-sprite:not([hidden])[data-koda-slot="nusa-chat"]');
  const isl = rect(document.getElementById('island')), body = rect(document.getElementById('chat-body')), inp = document.getElementById('chat-input');
  const vis = [...document.querySelectorAll(sel)].filter(el => {
    if (!el.closest('#capsule') || el.closest('.koda-sprite')) return false;
    const b = el.getBoundingClientRect(), s = getComputedStyle(el);
    return b.width > 0 && b.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0 && !el.closest('[hidden]');
  }).map(el => ({ id: el.id || el.className || el.tagName, box: rect(el) }));
  const ib = inp.getBoundingClientRect(), top = document.elementFromPoint(ib.left + ib.width / 2, ib.top + ib.height / 2);
  return { k: k ? { ...rect(k), tf: k.style.transform, ir: getComputedStyle(k).imageRendering, parent: k.parentNode.id } : null, isl, body, vis, inputHit: top === inp, inputW: ib.width,
    anim: window.__koda && window.__koda.current, slots: [...document.querySelectorAll('.koda-sprite:not([hidden])')].map(e => e.dataset.kodaSlot) };
}, CTRL);
(async () => {
  for (const theme of ['dark', 'light']) {
    const r = await H.open({ chat: true, theme, sessions: [] });
    try {
      let m = await measure(r);
      assert.ok(m.k, `${theme}: Koda in the chat slot (slots: ${m.slots})`);
      // the free column ends where the chat CONTENT starts: the left-most visible chat-* element that is inside the body (explicit grouping: `&&` binds tighter than `||`,
  // so the old filter let any chat-log/chat-input through without the position tests, and a stray element left of the island could set the edge)
  const leftEdge = Math.min(...m.vis.filter(x => (/chat-/.test(x.id) || /chat-(log|input)/.test(x.id)) && x.box.l > m.isl.l + 5 && x.box.t > m.body.t - 1).map(x => x.box.l));
  assert.ok(Number.isFinite(leftEdge), `${theme}: the chat content left edge was found`);
      const k = m.k, colW = leftEdge - m.isl.l, colH = m.body.b - m.body.t;
      console.log(`${theme}: column ${Math.round(colW)}x${Math.round(colH)}, Koda ${k.w}x${k.h} at x=${Math.round(k.l)} y=${Math.round(k.t)}`);
      assert.ok(k.w === k.h && k.w % 32 === 0 && k.w / 32 >= 3, `${theme}: integer multiple of 32, k>=3: ${k.w}`);
      assert.ok(k.l >= m.isl.l && k.r <= m.isl.r && k.t >= m.isl.t && k.b <= m.isl.b, `${theme}: inside #island`);
      const hit = m.vis.filter(x => x.box.l < k.r && x.box.r > k.l && x.box.t < k.b && x.box.b > k.t).map(x => x.id);
      assert.deepEqual(hit, [], `${theme}: Koda intersects visible chat controls`);
      assert.ok(Math.abs((k.l + k.r) / 2 - (m.isl.l + leftEdge) / 2) <= 2, `${theme}: horizontally centred in the free column`);
      assert.ok(Math.abs((k.t + k.b) / 2 - (m.body.t + m.body.b) / 2) <= 2, `${theme}: vertically centred in the chat body`);
      assert.equal(k.ir, 'pixelated'); assert.equal(k.tf, '', 'no inline transform'); assert.equal(k.parent, 'island');
      assert.ok(m.inputHit, `${theme}: input hit-testable`); assert.ok(m.inputW >= 160, `${theme}: input width ${m.inputW}`);
      await r.page.screenshot({ path: `/tmp/koda-chat-idle-${theme}.png` });
      // animation: resting without a turn, thinking with one
      const rest = await r.page.evaluate(() => window.__koda.current);
      await r.page.evaluate(() => document.dispatchEvent(new CustomEvent('abito:pose', { detail: 'think' })));
      await r.page.waitForTimeout(700);
      const think = await r.page.evaluate(() => window.__koda.current);
      assert.equal(think, K.POSE_TO_ANIM.think, `${theme}: running turn -> thinking animation`); assert.notEqual(rest, think);
      console.log(`${theme}: rest=${rest} think=${think}`);
      await r.page.screenshot({ path: `/tmp/koda-chat-running-${theme}.png` });
      m = await measure(r); assert.ok(m.k && m.k.tf === '', `${theme}: still in slot while thinking`);
      await r.page.evaluate(() => document.dispatchEvent(new CustomEvent('abito:pose', { detail: null })));
      await r.page.screenshot({ path: `/tmp/koda-chat-messages-${theme}.png` });
      // back to overview: the sprite leaves the chat slot
      await r.page.evaluate(() => window.__islandSetView('overview'));
      await r.page.waitForTimeout(1500);
      m = await measure(r); assert.equal(m.k, null, `${theme}: left the chat slot`);
      assert.ok(!m.slots.includes('nusa-chat'), 'no nusa-chat sprite visible');
    } finally { await r.close(); }
  }
  console.log('koda-chat-check: layout OK');
})().catch(e => { console.error(e); process.exit(1); });

'use strict';
/* S9 (09 permiso, A): the command in a mono box (wrapped, never truncated), Rechazar N / Aprobar Y at least 8px apart, Aprobar is the primary,
   shortcuts visible, the card stays inside the island. Real layout. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s9-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  const r = await H.open({ question: 'approvalPi' });
  try {
    const m = await r.page.evaluate(() => {
      const box = document.getElementById('question-approval-cmd'), cs = getComputedStyle(box);
      const btns = [...document.querySelectorAll('#question .q-approval-btn')].filter(e => e.getBoundingClientRect().width > 0).map(e => { const b = e.getBoundingClientRect(); return { t: e.textContent.trim(), l: b.left, r: b.right, t0: b.top, b0: b.bottom, cls: e.className, bg: getComputedStyle(e, '::after').backgroundColor }; });
      const isl = document.getElementById('island').getBoundingClientRect(), q = document.getElementById('question').getBoundingClientRect();
      return { mono: /mono|Consolas|Cascadia/i.test(cs.fontFamily), wrap: cs.whiteSpace, trunc: cs.textOverflow, over: box.scrollWidth > box.clientWidth + 1, btns, inside: q.bottom <= isl.bottom + 0.5 && q.right <= isl.right + 0.5,
        title: document.getElementById('question-approval-title').textContent };
    });
    assert.ok(m.mono, 'the command uses the mono font'); assert.notEqual(m.trunc, 'ellipsis', 'not truncated'); assert.equal(m.over, false);
    assert.match(m.title, /^Ejecutar/); assert.ok(m.inside, 'inside the island');
    assert.equal(m.btns.length, 2);
    assert.match(m.btns[0].t, /^Rechazar\s*N/, 'MD order: Rechazar N first'); assert.match(m.btns[1].t, /^Aprobar\s*Y/, 'then Aprobar Y');
    assert.ok(/q-approve/.test(m.btns[1].cls) && !/q-approve/.test(m.btns[0].cls), 'Aprobar is the primary'); const [rej, app] = m.btns[0].t.startsWith('Rechazar') ? m.btns : m.btns.reverse();
    assert.match(rej.t, /Rechazar\s*N/); assert.match(app.t, /Aprobar\s*Y/);
    const gap = Math.max(app.l - rej.r, rej.l - app.r); assert.ok(gap >= 8, `buttons are ${gap}px apart (>= 8)`);
    assert.deepEqual((await r.hit('.q-approval-btn')).filter(h => !h.ok), [], 'buttons receive their own click');
  } finally { await r.close(); }
  console.log('island-s9-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });

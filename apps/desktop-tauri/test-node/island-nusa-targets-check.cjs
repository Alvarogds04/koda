'use strict';
/* Accessibility (human rule: 44px touch targets): every control of the Nusa question card has a REAL box (getBoundingClientRect, not an ::after)
   >= 40px wide and tall, is not covered, and Omitir + the nav row stay visible inside the island without scrolling. Only the options may scroll
   (inside #question-options). Island <= 332 (frozen QUESTION_MAX_ISLAND_H: 340 window minus 8 air; not 324); Koda overlaps no control. Approval look keeps >= 40 too. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-targets-check: no playwright — NOT a pass'); process.exit(0); }
const MIN = 40;

function measure(page) {
  return page.evaluate(() => {
    const q = document.getElementById('question'), isl = document.getElementById('island').getBoundingClientRect();
    const opts = document.getElementById('question-options');
    const vis = el => { const b = el.getBoundingClientRect(), s = getComputedStyle(el); return b.width > 2 && b.height > 2 && s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0 && !el.closest('[hidden], .sr-only'); };
    const k = document.querySelector('.koda-sprite[data-koda-slot="nusa"]'), kb = k && k.getBoundingClientRect();
    const controls = [...q.querySelectorAll('button, textarea, input')].filter(vis).filter(el => el.id !== 'question-fold').map(el => {
      const b = el.getBoundingClientRect(), top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2), inOpts = opts.contains(el);
      const ob = opts.getBoundingClientRect();
      return { name: (el.id || el.className || el.tagName) + ':' + (el.textContent || '').trim().slice(0, 14), w: +b.width.toFixed(1), h: +b.height.toFixed(1), inOpts,
        covered: !(top && (top === el || el.contains(top))) && !(inOpts && (b.bottom > ob.bottom || b.top < ob.top)),
        inside: b.left >= isl.left && b.right <= isl.right && b.top >= isl.top && b.bottom <= isl.bottom,
        koda: !!kb && b.left < kb.right && b.right > kb.left && b.top < kb.bottom && b.bottom > kb.top };
    });
    return { controls, islH: isl.height, optsVisibleRows: Math.floor(opts.clientHeight / 40), optsCh: opts.clientHeight, optsSh: opts.scrollHeight, vh: innerHeight };
  });
}
function verify(name, m) {
  assert.ok(m.controls.length >= 3, `${name}: controls found`);
  for (const c of m.controls) {
    assert.ok(c.w >= MIN && c.h >= MIN, `${name}: «${c.name}» real box ${c.w}x${c.h} < ${MIN}`);
    if (!c.inOpts) { assert.ok(c.inside, `${name}: «${c.name}» not inside the island`); assert.ok(!c.covered, `${name}: «${c.name}» covered`); }
    assert.ok(!c.koda, `${name}: Koda overlaps «${c.name}»`);
  }
  assert.ok(m.islH <= 332.5, `${name}: island ${m.islH} > 332 (QUESTION_MAX_ISLAND_H = 340 window - 8 air, frozen in notify-view)`);
  assert.ok(m.optsCh >= 2 * 40 - 1 || m.optsSh <= m.optsCh + 1, `${name}: options area ${m.optsCh} shows < 2 rows`);
}
(async () => {
  const cases = [['plain', 'plain'], ['multi', 'multi'], ['form', 'form'], ['long', 'plain']];
  for (const [label, kind] of cases) {
    const r = await H.open({ question: kind, windowCap: 340 });
    try {
      await r.page.waitForTimeout(500);
      if (label === 'long') {
        await r.page.evaluate(() => { const o = document.getElementById('question-options'), t = o.querySelector('.q-option'); for (let i = 0; i < 8 - o.children.length; i++) { const c = t.cloneNode(true); c.querySelector('.q-label').textContent = 'extra ' + i; o.append(c); } });
        await r.page.waitForTimeout(200);
      }
      for (const theme of ['dark', 'light']) {
        await r.page.evaluate(t => { if (t === 'light') document.documentElement.dataset.theme = 'light'; }, theme); await r.page.waitForTimeout(150);
        { const mm = await measure(r.page); if (process.env.DUMP) console.log(label, theme, JSON.stringify({ isl: mm.islH, opts: [mm.optsCh, mm.optsSh], c: mm.controls.map(c => c.name + ' ' + c.w + 'x' + c.h) })); verify(`${label}/${theme}`, mm); }
        await r.page.screenshot({ path: `/tmp/nusa-targets-${label}-${theme}.png` });
      }
      if (kind === 'multi' || kind === 'form') { // free-text row + send button
        await r.page.evaluate(() => [...document.querySelectorAll('.q-option')].at(-1).click()); await r.page.waitForTimeout(200);
        verify(`${label}+text`, await measure(r.page));
      }
    } finally { await r.close(); }
  }
  { const r = await H.open({ question: 'approval', windowCap: 340 });
    try { await r.page.waitForTimeout(500); const m = await measure(r.page); verify('approval', m); } finally { await r.close(); } }
  console.log('island-nusa-targets-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

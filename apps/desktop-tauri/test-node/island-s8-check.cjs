'use strict';
/* S8 (08 cuestionario, A): progress dots + the text «Paso N de M» + «Atrás» that keeps the answers. Real layout. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s8-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  const r = await H.open({ question: 'form' });
  try {
    const read = () => r.page.evaluate(() => ({ head: document.getElementById('question-step-header').textContent, dots: [...document.querySelectorAll('#question-dots i')].map(i => i.dataset.state), prev: document.getElementById('question-prev').textContent.trim(), prevDisabled: document.getElementById('question-prev').disabled || document.getElementById('question-prev').hidden,
      fit: ['question-step-header', 'question-body'].every(id => { const e = document.getElementById(id); return !e || e.scrollWidth <= e.clientWidth + 1; }) }));
    let s = await read();
    assert.match(s.head, /^Paso 1 de 2/); assert.deepEqual(s.dots, ['current', 'todo']); assert.equal(s.prev, 'Atrás'); assert.ok(s.fit);
    const opt = (await r.measure('.q-option')).find(b => b.shown);
    await r.page.mouse.click(opt.left + opt.w / 2, opt.top + opt.h / 2);
    await r.page.click('#question-primary'); await r.page.waitForTimeout(400);
    s = await read(); assert.match(s.head, /^Paso 2 de 2/); assert.deepEqual(s.dots, ['done', 'current']);
    await r.page.click('#question-prev'); await r.page.waitForTimeout(400);
    s = await read(); assert.match(s.head, /^Paso 1 de 2/);
    assert.equal(await r.page.evaluate(() => !!document.querySelector('.q-option[aria-checked="true"], .q-option[data-selected="true"], .q-option[aria-pressed="true"]')), true, 'Atrás keeps the previous answer');
  } finally { await r.close(); }
  console.log('island-s8-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

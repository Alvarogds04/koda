'use strict';
/* S7 (07 varias opciones, A): vertical checkboxes with rows >= 40px, «Hecho» disabled with a visible reason at 0, «Hecho (N)» counts, space toggles. Real layout. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s7-check: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  const r = await H.open({ question: 'multi' });
  try {
    const q = () => r.page.evaluate(() => { const p = document.getElementById('question-primary'); return { label: p.textContent.trim(), disabled: p.disabled, reason: p.title || p.getAttribute('aria-description') || '' }; });
    let s = await q(); assert.deepEqual([s.label, s.disabled], ['Hecho', true]); assert.ok(s.reason.length > 3, 'a reason is attached to the disabled button');
    // v8: the reason is VISIBLE TEXT next to the disabled button (not only title/aria)
    const why = await r.page.evaluate(() => { const e = document.getElementById('question-reason'); if (!e) return null; const b = e.getBoundingClientRect(), p = document.getElementById('question-primary').getBoundingClientRect(), q = document.getElementById('island').getBoundingClientRect();
      return { text: e.textContent.trim(), shown: b.width > 0 && getComputedStyle(e).visibility !== 'hidden' && +getComputedStyle(e).opacity > 0, fits: e.scrollWidth <= e.clientWidth + 1, near: Math.abs(b.right - p.left) < 24 || Math.abs(b.bottom - p.top) < 24, inside: b.right <= q.right && b.bottom <= q.bottom }; });
    assert.ok(why && why.shown && why.text === 'Marcá al menos una' && why.fits && why.near && why.inside, 'the reason is visible text beside the disabled «Hecho»: ' + JSON.stringify(why));
    const rows = (await r.measure('.q-option')).filter(b => b.shown);
    assert.ok(rows.length >= 3 && rows.every(b => b.h >= 40 - 0.5 || b.h >= 32), `rows are whole and tall enough (${rows.map(b => Math.round(b.h))})`);
    const firstBox = await r.page.evaluate(() => document.querySelector('.q-option[role="checkbox"]') && 1); assert.ok(firstBox, 'rows are checkboxes');
    await r.page.mouse.click(rows[0].left + rows[0].w / 2, rows[0].top + rows[0].h / 2);
    await r.page.mouse.click(rows[2].left + rows[2].w / 2, rows[2].top + rows[2].h / 2);
    s = await q(); assert.deepEqual([s.label, s.disabled], ['Hecho (2)', false]);
    assert.equal(await r.page.evaluate(() => { const e = document.getElementById('question-reason'); return !e || e.hidden || e.getBoundingClientRect().width === 0; }), true, 'the reason disappears once something is marked');
    await r.page.focus('.q-option[role="checkbox"]'); await r.page.keyboard.press('Space');
    assert.ok((await q()).label.startsWith('Hecho'), 'space toggles the focused row');
    const blocked = (await r.hit('.q-option, #question-primary')).filter(h => !h.ok);
    assert.deepEqual(blocked, [], 'controls receive their own click');
  } finally { await r.close(); }
  console.log('island-s7-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

'use strict';
/* S4 (04 expandida general, A): the focused session's name is a 15px / 600 title, the steps are dimmed except the current one (still >= 4.5:1
   against the card), nothing overflows, the jump button has an accessible name. Real layout, dark and light. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s4-check: no playwright — NOT a pass'); process.exit(0); }
const lum = c => { const v = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
(async () => {
  for (const theme of ['dark', 'light']) {
    const r = await H.open({ theme });
    try {
      const m = await r.page.evaluate(() => {
        const cs = s => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null; };
        const n = cs('.centre-name'), li = cs('.centre-steps li:not([data-current="true"])'), cur = cs('.centre-steps li[data-current="true"]'), card = cs('.card-left');
        return { name: n && [n.fontSize, n.fontWeight], dim: li && li.color, cur: cur && cur.color, bg: card && card.backgroundColor, jump: (document.getElementById('session-jump') || {}).ariaLabel || (document.getElementById('session-jump') && document.getElementById('session-jump').getAttribute('aria-label')) };
      });
      assert.deepEqual(m.name, ['15px', '600'], `${theme}: the title is 15px/600`);
      if (m.dim) assert.ok(ratio(m.dim, m.bg.startsWith('rgba(0, 0, 0, 0)') ? (theme === 'dark' ? 'rgb(20,21,24)' : 'rgb(247,242,231)') : m.bg) >= 4.5, `${theme}: dimmed steps keep 4.5:1 (${m.dim} on ${m.bg})`);
      if (m.dim && m.cur) assert.notEqual(m.dim, m.cur, `${theme}: current step differs from dimmed ones`);
      assert.match(String(m.jump || ''), /terminal/i, `${theme}: jump button has an accessible name`);
      const bad = await r.page.evaluate(() => [...document.querySelectorAll('.centre-name, .centre-steps li, .centre-state')].filter(e => e.getBoundingClientRect().width > 0 && e.scrollWidth > e.clientWidth + 1).map(e => e.className));
      assert.deepEqual(bad, [], `${theme}: nothing overflows: ${bad}`);
    } finally { await r.close(); }
  }
  console.log('island-s4-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

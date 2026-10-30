'use strict';
/* S6 (06 pregunta simple, B): options with a title (13px) and a grey one-line description (11px, >= 4.5:1), whole rows, nothing overflows,
   every option clickable, and the card fits the island. Real layout, dark and light. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-s6-check: no playwright — NOT a pass'); process.exit(0); }
const lum = c => { const v = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const toRgb = c => { const n = c.match(/[\d.]+/g).map(Number); return /^color\(srgb/.test(c) ? `rgb(${n.slice(0, 3).map(x => Math.round(x * 255)).join(',')})` : c; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// EFFECTIVE painted background behind each description: hide its text, screenshot its box, take the LIGHTEST pixel (worst case for light text; includes the veil).
async function descBackgrounds(page) {
  const n = await page.evaluate(() => [...document.querySelectorAll('.q-desc')].filter(e => e.getBoundingClientRect().width > 0).length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const info = await page.evaluate(i => { const el = [...document.querySelectorAll('.q-desc')].filter(e => e.getBoundingClientRect().width > 0)[i]; const b = el.getBoundingClientRect(); el.dataset.keepColor = el.style.color; el.style.color = 'transparent'; return { text: el.textContent.slice(0, 28), color: getComputedStyle(el, null).color, clip: { x: b.left, y: b.top, width: b.width, height: b.height } }; }, i);
    const png = await page.screenshot({ clip: info.clip });
    const color = await page.evaluate(i => { const el = [...document.querySelectorAll('.q-desc')].filter(e => e.getBoundingClientRect().width > 0)[i]; el.style.color = el.dataset.keepColor; delete el.dataset.keepColor; return getComputedStyle(el).color; }, i);
    const bg = await page.evaluate(async b64 => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data, f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      let best = null, bl = -1; for (let k = 0; k < d.length; k += 4) { const l = 0.2126 * f(d[k]) + 0.7152 * f(d[k + 1]) + 0.0722 * f(d[k + 2]); if (l > bl) { bl = l; best = [d[k], d[k + 1], d[k + 2]]; } }
      return best;
    }, png.toString('base64'));
    out.push({ text: info.text, color, bg: `rgb(${bg.join(',')})` });
  }
  return out;
}
(async () => {
  for (const theme of ['dark', 'light']) {
    const r = await H.open({ question: 'plain', described: true, theme });
    try {
      const m = await r.page.evaluate(() => {
        const l = getComputedStyle(document.querySelector('.q-label')), d = document.querySelector('.q-desc');
        const isl = document.getElementById('island').getBoundingClientRect(), q = document.getElementById('question').getBoundingClientRect();
        const opts = [...document.querySelectorAll('.q-option')].filter(e => e.getBoundingClientRect().width > 0).map(e => { const b = e.getBoundingClientRect(); return [b.top, b.bottom]; });
        return { label: [l.fontSize, l.fontWeight], desc: d && getComputedStyle(d).fontSize, descColor: d && getComputedStyle(d).color, descs: document.querySelectorAll('.q-desc').length,
          descOverflow: [...document.querySelectorAll('.q-desc')].some(e => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().height > 16), inside: q.bottom <= isl.bottom + 0.5, opts };
      });
      assert.equal(m.label[0], '13px', `${theme}: option title 13px`);
      assert.equal(m.desc, '11px', `${theme}: description 11px`);
      assert.ok(m.descs >= 2, `${theme}: descriptions drawn`);
      assert.equal(m.descOverflow, false, `${theme}: each description is ONE line`);
      assert.ok(m.inside, `${theme}: the card stays inside the island`);
      await r.page.waitForTimeout(700);
      const bgs = await descBackgrounds(r.page);
      assert.ok(bgs.length >= 2, `${theme}: descriptions measured`);
      for (const x of bgs) assert.ok(ratio(x.color, x.bg) >= 4.5, `${theme}: description contrast «${x.text}» ${x.color} on painted ${x.bg}`);
      const blocked = (await r.hit('.q-option')).filter(h => !h.ok);
      assert.deepEqual(blocked, [], `${theme}: options receive their own click`);
    } finally { await r.close(); }
  }
  console.log('island-s6-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

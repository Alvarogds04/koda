'use strict';
/* «Sin motor» / «Sin cuenta» band (canvas comments ag1ar9cu + 3ixt6n59): (A) Koda is there (k=2, error, inside the island, touching no control or the band);
   (B) the two band buttons have air: >=8px between visual boxes, 44px hit area, uncovered, and clear of the tab dots. Real layout, Playwright. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-engine-check: no playwright — NOT a pass'); process.exit(0); }
const measure = r => r.page.evaluate(async () => {
  const box = el => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
  const hitH = el => { const a = getComputedStyle(el, '::after'), b = el.getBoundingClientRect(); if (a.content === 'none' || a.position !== 'absolute') return b.height;
    const ps = el.getBoundingClientRect(); const top = parseFloat(a.top), bot = parseFloat(a.bottom); return Number.isFinite(top) && Number.isFinite(bot) ? ps.height - top - bot : parseFloat(a.height); };
  const band = document.getElementById('engine-band'), ids = [...band.querySelectorAll('button')], i = document.getElementById('island');
  const k = document.querySelector('.koda-sprite[data-koda-slot="nusa"]'), dots = document.getElementById('nusa-dots');
  const vis = el => { const s = getComputedStyle(el), b = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0; };
  const controls = [...document.querySelectorAll('#capsule button, #capsule a[href], #capsule input')].filter(vis).filter(e => !e.disabled && !(k && k.contains(e)) && (() => { const b = e.getBoundingClientRect(), t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return t && (t === e || e.contains(t)); })());
  // Koda's cell has transparent padding: controls are tested against the PAINTED pixels of the current frame (alpha > 128), the cell itself must still sit inside island and #nusa-right
  let pix = null; const kb = k && k.getBoundingClientRect();
  if (k) { const cs = getComputedStyle(k), m = /url\(["']?(.*?)["']?\)/.exec(cs.backgroundImage);
    if (m) { const img = new Image(); img.src = m[1]; await img.decode().catch(() => {}); const w = Math.round(kb.width), h = Math.round(kb.height), c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.imageSmoothingEnabled = false; const [bw, bh] = cs.backgroundSize.split(' ').map(parseFloat), [px, py] = cs.backgroundPosition.split(' ').map(parseFloat);
      g.drawImage(img, px, py, bw, bh); pix = g.getImageData(0, 0, w, h).data; } }
  const hitInk = e => { const b = e.getBoundingClientRect(); if (!kb) return false;
    if (!pix) return b.left < kb.right && b.right > kb.left && b.top < kb.bottom && b.bottom > kb.top;
    const w = Math.round(kb.width), h = Math.round(kb.height);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pix[(y * w + x) * 4 + 3] > 128 && kb.left + x + 1 > b.left && kb.left + x < b.right && kb.top + y + 1 > b.top && kb.top + y < b.bottom) return true;
    return false; };
  return { inkFound: !!pix, band: box(band), island: (() => { const b = box(i); b.b = b.t + b.h; return b; })(), dots: box(dots), right: box(document.getElementById('nusa-right')), kodaVis: !!k && vis(k), koda: k && box(k), kodaOp: k && +getComputedStyle(k).opacity,
    btns: ids.map(b => { const cx = b.getBoundingClientRect(); const top = document.elementFromPoint(cx.left + cx.width / 2, cx.top + cx.height / 2);
      return { id: b.id, text: b.textContent.trim(), vis: box(b), hitH: hitH(b), ok: top === b || b.contains(top) }; }),
    tabs: [...dots.querySelectorAll('.nd')].map(box),
    kodaHits: k ? controls.filter(hitInk).map(c => c.id || c.textContent.trim()) : [],
    bandHit: k ? hitInk(band) : null };
});
function koda(m, name) {
  assert.ok(m.inkFound, `${name}: Koda painted pixels measurable`);
  assert.ok(m.kodaVis, `${name}: Koda visible`); assert.deepEqual([m.koda.w, m.koda.h], [64, 64], `${name}: Koda k=2`);
  const i = m.island, rr = m.right;
  assert.ok(m.koda.l >= i.l && m.koda.r <= i.r && m.koda.t >= i.t && m.koda.b <= i.b, `${name}: Koda inside the island ${JSON.stringify(m.koda)} vs ${JSON.stringify(i)}`);
  assert.ok(m.koda.l >= rr.l - 0.5 && m.koda.r <= rr.r + 0.5 && m.koda.t >= rr.t - 0.5 && m.koda.b <= rr.b + 0.5, `${name}: Koda inside #nusa-right ${JSON.stringify(m.koda)} vs ${JSON.stringify(rr)}`);
}
(async () => {
  for (const theme of ['dark', 'light']) for (const [engine, words] of [['down', ['Revisar', 'Omitir']], ['account', ['Configurar', 'Omitir']]]) {
    const name = `${engine}/${theme}`, r = await H.open({ engine, theme });
    try {
      await r.page.waitForTimeout(600);
      // welcome-home (human, 16-nov): the Inicio is Koda's welcome; the engine band must NOT be there (it confuses a new user), the island stays 150
      // and Koda is not stuck in the error pose. The band stays on the other tabs and is measured there exactly as before.
      const w = await measure(r);
      assert.equal(await r.page.evaluate(() => getComputedStyle(document.getElementById('engine-band')).display), 'none', `${name}: no engine band on the Inicio`);
      assert.equal(w.island.h, 150, `${name}: the Inicio island stays 150`);
      assert.notEqual(await r.page.evaluate(() => window.__koda.current), 'error', `${name}: Koda is not in the error pose on the Inicio`);
      assert.ok(w.kodaOp > 0, `${name}: Koda visible`); assert.deepEqual([w.koda.w, w.koda.h], [64, 64], `${name}: Koda k=2`); koda(w, name);
      await H.goTab(r.page, 'agentes'); await r.page.waitForTimeout(600);
      const m = await measure(r);
      assert.deepEqual(m.btns.map(b => b.text), words, `${name}: band buttons`);
      assert.equal(m.island.h, 186, `${name}: island height frozen`); assert.equal(m.band.h, 32, `${name}: band height frozen`);
      assert.ok(m.band.t >= m.island.t && m.band.b <= m.island.t + m.island.h && m.band.l >= m.island.l && m.band.r <= m.island.r, `${name}: band inside the island`);
      const [a, b] = m.btns; assert.ok(b.vis.l - a.vis.r >= 8, `${name}: gap ${b.vis.l - a.vis.r}px between buttons < 8`);
      for (const x of m.btns) {
        assert.ok(x.ok, `${name}: ${x.text} covered`); assert.ok(x.hitH >= 44, `${name}: ${x.text} hit area ${x.hitH}px < 44`);
        assert.ok(x.vis.r <= m.island.r - 8 && x.vis.b <= m.island.t + m.island.h, `${name}: ${x.text} clipped by the island edge`);
        const air = x.vis.t - m.dots.b; assert.ok(air >= 8, `${name}: ${x.text} only ${air}px below the dots box (dots ${m.dots.t}-${m.dots.b}, button ${x.vis.t}-${x.vis.b})`);
      }
      // the band appears when the human leaves the Inicio, and Koda startles («asustado») for a moment before it settles into the error pose: measure the settled frame, as on the Inicio before
      await H.goTab(r.page, 'avisos'); await r.page.waitForTimeout(2500); const t = await measure(r); koda(t, `${name}/avisos`, false); assert.deepEqual(t.kodaHits, [], `${name}/avisos: Koda overlaps controls`);
      await r.page.click('#nusa-tab-inicio'); await r.page.waitForTimeout(300);
      await r.screenshot(`/tmp/nusa-engine-${engine === 'down' ? 'down' : 'no-account'}-${theme}.png`);
    } finally { await r.close(); }
  }
  console.log('island-nusa-engine-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

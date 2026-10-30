'use strict';
/* HU-063 T5 (human, 28-oct: «corregir el contraste del texto chico de las tarjetas en take-over a WCAG AA sobre negro»):
   every VISIBLE text node inside the take-over card surfaces (#question, #permission, #notices, #engine-band, the Nusa header strip)
   must reach contrast >= 4.5:1 (>= 3:1 for large text, >= 24px or >= 18.66px bold) against the notch's own black. Real layout, Playwright.
   The effective colour is the computed colour composited with its ancestors' opacity over #000 (the shell is opaque black, S1). */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-contrast-check: no playwright — NOT a pass'); process.exit(0); }
const SURFACES = '#question, #permission, #notices, #engine-band, #nusa-head';
const CHAT_SURFACES = '#chat, #island-header';
// comment 8 (human, 29-oct): the chat view sits on the Nusa black too; rows the real chat.js builds are injected so bubbles / notes / errors are measured as well
const CHAT_ROWS = () => { const log = document.getElementById('chat-log'); log.textContent = '';
  for (const [cls, text] of [['user', 'Hola Abito, ¿qué hay pendiente hoy?'], ['assistant', 'Tenés dos avisos y una pregunta esperando respuesta.'], ['note', 'Conversación nueva'], ['error', 'No se pudo enviar el mensaje']]) { const li = document.createElement('li'); li.className = cls; li.textContent = text; log.append(li); } };
async function measure(r, surfaces = SURFACES) {
  return r.page.evaluate(sel => {
    const parse = c => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue.trim(); if (!text) continue;
      const el = n.parentElement; if (!el || !el.closest(sel) || el.closest('[hidden], [inert], .sr-only')) continue;
      const s = getComputedStyle(el), b = el.getBoundingClientRect();
      if (s.display === 'none' || s.visibility === 'hidden' || b.width < 1 || b.height < 1) continue;
      if (el.closest('button:disabled, [aria-disabled="true"]')) continue; // inactive controls are exempt from WCAG 1.4.3
      const fg = parse(s.color); if (!fg) continue;
      // Real compositing, outermost first, starting from the notch black: each element's own fill and its ::after fill (the buttons' visible
      // face) go over the backdrop, then the element's opacity blends that group back toward the backdrop; the text is composited the same way.
      const chain = []; for (let e = el; e; e = e.parentElement) chain.unshift(e);
      const over = (top, base) => top && top.a > 0 ? { r: top.r * top.a + base.r * (1 - top.a), g: top.g * top.a + base.g * (1 - top.a), b: top.b * top.a + base.b * (1 - top.a) } : base;
      const lerp = (from, to, o) => ({ r: from.r + (to.r - from.r) * o, g: from.g + (to.g - from.g) * o, b: from.b + (to.b - from.b) * o });
      let bg = { r: 0, g: 0, b: 0 }, tc = null;
      for (const e of chain) {
        const cs = getComputedStyle(e), o = +cs.opacity, before = bg;
        let group = bg;
        if (e.closest(sel)) { group = over(parse(cs.backgroundColor), group); const af = getComputedStyle(e, '::after'); if (af.content !== 'none' && af.position === 'absolute') group = over(parse(af.backgroundColor), group); }
        if (e === el) tc = lerp(before, over(fg, group), o);
        bg = lerp(before, group, o);
      }
      const L1 = lum(tc), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const px = parseFloat(s.fontSize), bold = +s.fontWeight >= 700, large = px >= 24 || (px >= 18.66 && bold);
      out.push({ text: text.slice(0, 28), ratio: Math.round(ratio * 100) / 100, need: large ? 3 : 4.5, px });
    }
    return out;
  }, surfaces);
}

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
  const scenarios = [
    ['permission', { question: 'approvalPi' }],
    ['question', { question: 'plain' }],
    ['question multi', { question: 'multi', windowCap: 340 }],
    ['question form', { question: 'form', windowCap: 340 }],
    ['question multi picked', { question: 'multi', windowCap: 340, pick: true }], // «Hecho» enabled: its face must pass too
    ['question form picked', { question: 'form', windowCap: 340, pick: true }], // «Siguiente» enabled
    ['finished', { finishedCard: 'pi', sessions: [], quick: true }],
    ['engine band', { engine: 'down' }],
  ];
  const bad = [];
  for (const theme of ['dark', 'light']) for (const [name, sc] of [['chat', { chat: true }]]) {
    const r = await H.open({ ...sc, theme });
    try {
      await r.page.waitForTimeout(900); await r.page.evaluate(CHAT_ROWS); await r.page.waitForTimeout(300);
      const m = await measure(r, CHAT_SURFACES); assert.ok(m.length > 4, `${name}/${theme}: chat text measured (${m.length})`);
      for (const x of m) if (x.ratio < x.need) bad.push(`${name}/${theme}: «${x.text}» ${x.ratio}:1 < ${x.need}:1 (${x.px}px)`);
      if (process.env.NUSA_SHOTS) await r.page.screenshot({ path: `/tmp/nusa-contrast-${name.replace(/ /g, '-')}-${theme}.png` });
    } finally { await r.close(); }
  }
  for (const theme of ['dark', 'light']) for (const [name, sc] of scenarios) {
    const r = await H.open({ ...sc, theme });
    try { await r.page.waitForTimeout(700); if (sc.pick) { await r.page.click('.q-option'); await r.page.waitForTimeout(400); } const m = await measure(r); assert.ok(m.length > 0, `${name}/${theme}: some text measured`); for (const x of m) if (x.ratio < x.need) bad.push(`${name}/${theme}: «${x.text}» ${x.ratio}:1 < ${x.need}:1 (${x.px}px)`);
      if (process.env.NUSA_SHOTS) await r.page.screenshot({ path: `/tmp/nusa-contrast-${name.replace(/ /g, '-')}-${theme}.png` }); }
    finally { await r.close(); }
  }
  // HU-063: question option descriptions (.q-desc) against the REAL painted background: effective painted pixels (lightest) behind the text, veil included
  for (const theme of ['dark', 'light']) {
    const r = await H.open({ question: 'plain', described: true, theme });
    try {
      await r.page.waitForTimeout(700);
      const bgs = await descBackgrounds(r.page);
      const rgb = c => c.match(/[\d.]+/g).slice(0, 3).map(Number);
      const L = c => { const v = rgb(c).map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
      const m = bgs.map(x => { const a = L(x.color), b = L(x.bg); return { text: x.text, ratio: Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100 }; });
      assert.ok(m.length >= 2, `option descriptions/${theme}: descriptions measured (${m.length})`);
      for (const x of m) if (x.ratio < 4.5) bad.push(`option description/${theme}: «${x.text}» ${x.ratio}:1 < 4.5:1`);
    } finally { await r.close(); }
  }
  assert.deepEqual(bad, [], `contrast below WCAG AA on black:\n${bad.join('\n')}`);
  console.log('island-nusa-contrast-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

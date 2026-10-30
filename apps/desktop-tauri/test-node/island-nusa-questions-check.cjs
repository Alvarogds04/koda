'use strict';
/* HU-057/HU-063 scope extension (human, 28-oct): the QUESTION cards in the notch (simple, multi-option, questionnaire).
   Real layout (island-geometry-harness, Playwright) with the window pinned to the FROZEN 340 (windowCap: ISLAND_WINDOW is a Rust contract):
   - every option, the free-text row (when shown), the nav (Atrás/Siguiente/Hecho/Enviar) and Omitir sit inside the island box and are not
     covered (elementFromPoint); nothing is cut silently: if the content is taller than the card, the OPTIONS list scrolls (overflow-y auto);
   - the type is the notch's scale: every visible text in the card is 13 / 12 / 11 px;
   - Koda stays in the mascot column where Permiso / Terminó put it (LEFT of the card, big, inside the island, intersecting no control box). */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-questions-check: no playwright — NOT a pass'); process.exit(0); }
const CONTROLS = 'button, a[href], input, textarea, select, [role="button"]';
const SCALE = new Set([13, 12, 11]);

async function inspect(r) {
  return r.page.evaluate(({ CONTROLS }) => {
    const q = document.getElementById('question'), isl = document.getElementById('island').getBoundingClientRect();
    const vis = el => { const b = el.getBoundingClientRect(), s = getComputedStyle(el); return b.width > 2 && b.height > 2 && s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0 && !el.closest('[hidden], .sr-only'); };
    const clipped = el => { // a control scrolled out of a clipping ancestor that is NOT a scroller (cut silently)
      const b = el.getBoundingClientRect();
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowY, pb = p.getBoundingClientRect();
        if (o === 'visible') continue;
        if (b.bottom > pb.bottom + 0.5 || b.top < pb.top - 0.5) return o === 'auto' || o === 'scroll' ? 'scrollable' : 'cut';
      }
      return null;
    };
    const controls = [...q.querySelectorAll(CONTROLS)].filter(vis).filter(el => el.id !== 'question-fold').map(el => {
      const b = el.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, top = document.elementFromPoint(x, y);
      return { id: el.id || el.className || el.tagName, text: (el.textContent || '').trim().slice(0, 24), inside: b.left >= isl.left && b.right <= isl.right && b.top >= isl.top && b.bottom <= isl.bottom,
        box: { l: b.left, r: b.right, t: b.top, b: b.bottom }, ok: !!top && (top === el || el.contains(top)), clip: clipped(el), h: Math.round(b.height), bottom: Math.round(b.bottom) };
    });
    const sizes = [];
    const walker = document.createTreeWalker(q, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue.trim(); if (!t) continue; const el = n.parentElement;
      if (!vis(el) || el.closest('.ico, svg')) continue;
      sizes.push({ text: t.slice(0, 24), px: parseFloat(getComputedStyle(el).fontSize) });
    }
    for (const el of q.querySelectorAll('textarea, input')) if (vis(el)) sizes.push({ text: '<' + el.tagName + '>', px: parseFloat(getComputedStyle(el).fontSize) });
    const opts0 = document.getElementById('question-options'), opts = opts0, os = getComputedStyle(opts);
    const k = document.querySelector('.koda-sprite[data-koda-slot="nusa"]'), kb = k && k.getBoundingClientRect();
    const reach = [...opts0.querySelectorAll('.q-option')].every(l => { l.scrollIntoView({ block: 'nearest' }); const b = l.getBoundingClientRect(), t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2), ob = opts0.getBoundingClientRect(); return (l === t || l.contains(t)) && b.top >= ob.top - 0.5 && b.bottom <= ob.bottom + 0.5; });
    opts0.scrollTop = 0;
    return { reach, controls, sizes, isl: { top: isl.top, bottom: isl.bottom, left: isl.left, right: isl.right, w: isl.width },
      opts: { sh: opts.scrollHeight, ch: opts.clientHeight, oy: os.overflowY }, root: { sh: q.scrollHeight, ch: q.clientHeight },
      koda: kb ? { l: kb.left, r: kb.right, t: kb.top, b: kb.bottom } : null, vh: innerHeight,
      qLeft: Math.min(...[...q.querySelectorAll('#question-options, #question-body')].map(e => e.getBoundingClientRect().left)) };
  }, { CONTROLS });
}
function verify(name, m) {
  assert.ok(m.controls.length >= 3, `${name}: controls found: ${JSON.stringify(m.controls.map(c => c.text))}`);
  for (const c of m.controls) {
    // 40px rows (accessibility, island-nusa-targets) make the options area scroll sooner: an option below the fold is fine ONLY when it is
    // inside the scrolling #question-options (reachability by scrolling is asserted below); anything else must be inside, uncut and uncovered
    if (c.clip === 'scrollable') { assert.ok(/auto|scroll/.test(m.opts.oy), `${name}: «${c.text}» below the fold but the options do not scroll`); continue; }
    assert.ok(c.inside, `${name}: «${c.text}» (${c.id}) inside the island box (bottom ${c.bottom}, island ${m.isl.bottom})`);
    assert.equal(c.clip, null, `${name}: «${c.text}» is cut by a clipping ancestor, not scrollable`);
    assert.ok(c.ok, `${name}: «${c.text}» is covered`);
  }
  assert.ok(m.reach, `${name}: every option reachable by scrolling the options`);
  const bad = m.sizes.filter(s => !SCALE.has(s.px));
  assert.deepEqual(bad, [], `${name}: type outside 13/12/11: ${JSON.stringify(bad)}`);
  if (m.opts.sh > m.opts.ch + 1) assert.ok(/auto|scroll/.test(m.opts.oy), `${name}: options taller than their box must scroll (overflow-y ${m.opts.oy})`);
  assert.ok(m.root.sh <= m.root.ch + 1, `${name}: the card itself overflows silently (${m.root.sh} > ${m.root.ch})`);
  assert.ok(m.koda, `${name}: Koda in the mascot column`);
  assert.ok(m.koda.r <= m.isl.left + m.isl.w / 2 && m.koda.l >= m.isl.left && m.koda.t >= m.isl.top && m.koda.b <= m.isl.bottom,
    `${name}: Koda sits LEFT of the card, inside the island: ${JSON.stringify(m.koda)}`);
  const kw = m.koda.r - m.koda.l, kh = m.koda.b - m.koda.t;
  assert.ok(kw === kh && kw % 32 === 0 && kw / 32 >= 3, `${name}: Koda is big, an integer multiple of 32 (k>=3): ${kw}x${kh}`);
  assert.ok(m.qLeft >= m.koda.r - 1, `${name}: the options column (left edge ${m.qLeft}) starts right of Koda (${m.koda.r})`);
  const hit = m.controls.filter(c => c.box.l < m.koda.r && c.box.r > m.koda.l && c.box.t < m.koda.b && c.box.b > m.koda.t).map(c => c.text);
  assert.deepEqual(hit, [], `${name}: Koda box intersects visible controls`);
}
(async () => {
  for (const kind of ['plain', 'multi', 'form']) {
    const r = await H.open({ question: kind, windowCap: 340 });
    try {
      await r.page.waitForTimeout(500);
      const m = await inspect(r); verify(kind, m);
      if (kind === 'multi' || kind === 'form') { // free-text row: choose «Otra cosa…» so the textarea shows, still inside
        await r.page.evaluate(() => [...document.querySelectorAll('.q-option')].at(-1).click());
      }
      await r.page.screenshot({ path: `/tmp/nusa-q-${kind}-dark.png` });
      await r.page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await r.page.waitForTimeout(200);
      await r.page.screenshot({ path: `/tmp/nusa-q-${kind}-light.png` });
    } finally { await r.close(); }
  }
  { // a question taller than the window allows: the options SCROLL inside the card, nothing is cut, the last one is reachable
    const r = await H.open({ question: 'plain', windowCap: 340 });
    try {
      await r.page.waitForTimeout(400);
      await r.page.evaluate(() => { const o = document.getElementById('question-options'), t = o.querySelector('.q-option'); for (let i = 0; i < 8; i++) { const c = t.cloneNode(true); c.querySelector('.q-label').textContent = 'extra ' + i; o.append(c); } });
      await r.page.waitForTimeout(200);
      const m = await inspect(r);
      assert.ok(m.opts.sh > m.opts.ch + 1, `overflow case really overflows: ${JSON.stringify(m.opts)}`);
      assert.ok(/auto|scroll/.test(m.opts.oy), `options scroll when taller than the card (overflow-y ${m.opts.oy})`);
      assert.ok(m.root.sh <= m.root.ch + 1, 'the card itself does not overflow');
      // headless Chromium hides scrollbars, so assert the rule that draws the visible bar (always-on 6px track + thumb) instead of pixels
      const bar = await r.page.evaluate(() => { const o = document.getElementById('question-options'); return { w: getComputedStyle(o, '::-webkit-scrollbar').width, sw: getComputedStyle(o).scrollbarWidth, thumb: getComputedStyle(o, '::-webkit-scrollbar-thumb').backgroundColor }; });
      assert.ok(bar.w === '6px' && bar.sw !== 'none' && /rgba?\(255, 255, 255/.test(bar.thumb), `a visible scrollbar affordance: ${JSON.stringify(bar)}`);
      const nav = m.controls.filter(c => !/^extra|vim|emacs|vscode|Otra/.test(c.text));
      for (const c of m.controls.filter(c => c.clip === null)) assert.ok(c.inside && c.ok, `fixed control «${c.text}» inside and uncovered`);
      assert.ok(nav.length >= 1, 'Omitir stays visible while the options scroll');
      const last = await r.page.evaluate(() => { const l = [...document.querySelectorAll('.q-option')].at(-1); l.scrollIntoView({ block: 'nearest' }); const b = l.getBoundingClientRect(), t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2), i = document.getElementById('island').getBoundingClientRect(); return { ok: l === t || l.contains(t), inside: b.bottom <= i.bottom && b.top >= i.top }; });
      assert.deepEqual(last, { ok: true, inside: true }, 'the last option is reachable by scrolling');
      await r.page.screenshot({ path: '/tmp/nusa-q-scroll-dark.png' });
    } finally { await r.close(); }
  }
  console.log('island-nusa-questions-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

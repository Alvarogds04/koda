'use strict';
/* HU-063 follow-up: in every Nusa take-over card (permission, finished, error notice, plain question), dark and light, no two VISIBLE
   glyph-bearing things overlap (text rects, dots, badges, notice ring, svg icons, pseudo-element glyphs «i»/«!»), Koda's box overlaps none of
   them, every pseudo glyph is the only glyph at its own centre, and the permission card's content starts near the island's left padding edge.
   Real layout, Playwright. Screenshots: /tmp/nusa-fix-<state>-<theme>.png */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-overlap-check: no playwright — NOT a pass'); process.exit(0); }
const ERR = { id: '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b', title: 'Pi falló', detail: 'Error al compilar', severity: 'error', kind: 'settled', expiresAt: Date.now() + 600000, agent: 'codex', projectName: 'api' };
const scan = r => r.page.evaluate(() => {
  const visible = el => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0 || e.hidden) return false; } return true; };
  const rect = b => ({ l: b.left, r: b.right, t: b.top, b: b.bottom }), items = [];
  const root = document.getElementById('capsule'), isl = document.getElementById('island');
  const skip = el => el.closest('#nusa-body, #nusa-veil, #nusa-ear, .koda-sprite, .sr-only, #nusa-dots');
  const name = el => el.id || (typeof el.className === 'string' && el.className) || el.tagName;
  const walker = document.createTreeWalker(isl.parentElement, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    const el = n.parentElement; if (!n.textContent.trim() || !el || skip(el) || el.closest('script, style') || !visible(el)) continue;
    const eb = el.getBoundingClientRect(); if (eb.width <= 1 || eb.height <= 1) continue; /* 1px visually-hidden live text */
    const g = document.createRange(); g.selectNodeContents(n); const b = g.getBoundingClientRect(); if (b.width < 1 || b.height < 1) continue;
    items.push({ el, kind: 'text', name: name(el) + ':' + n.textContent.trim().slice(0, 14), box: rect(b) });
  }
  for (const el of root.querySelectorAll('.dot, #clay-badge, #notice-ring, svg, *')) {
    if (skip(el) || !visible(el)) continue;
    const isIcon = el.matches('.dot, #clay-badge, #notice-ring') || (el.tagName.toLowerCase() === 'svg' && !el.parentElement.closest('svg'));
    const pseudo = ['::before', '::after'].map(p => ({ p, c: getComputedStyle(el, p).content })).filter(x => /^"[^"]+"$/.test(x.c) && !/^"\s*"$/.test(x.c) && getComputedStyle(el, x.p).display !== 'none');
    if (!isIcon && !pseudo.length) continue;
    const b = el.getBoundingClientRect(); if (b.width < 1 || b.height < 1) continue;
    items.push({ el, kind: pseudo.length ? 'pseudo' : 'icon', name: name(el) + (pseudo.length ? pseudo.map(x => x.p + x.c).join('') : ''), box: rect(b) });
  }
  const rel = (a, b) => a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el);
  const ov = (a, b) => a.l < b.r - .5 && a.r > b.l + .5 && a.t < b.b - .5 && a.b > b.t + .5;
  const overlaps = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (!rel(items[i], items[j]) && ov(items[i].box, items[j].box)) overlaps.push(items[i].name + ' × ' + items[j].name);
  const kEl = document.querySelector('.koda-sprite[data-koda-slot="nusa"]'), kb = kEl && kEl.getBoundingClientRect(), k = kb && rect(kb);
  const kodaHit = k ? items.filter(i => ov(i.box, k)).map(i => i.name) : [];
  const pseudoStacks = items.filter(i => i.kind === 'pseudo').map(i => {
    const x = (i.box.l + i.box.r) / 2, y = (i.box.t + i.box.b) / 2;
    const stack = document.elementsFromPoint(x, y).filter(e => items.some(o => o.el === e && o !== i && !rel(o, i)) || items.some(o => o.kind !== 'pseudo' && o.el === e && !rel(o, i)));
    return { name: i.name, others: stack.map(name) };
  });
  const cs = getComputedStyle(isl), ib = isl.getBoundingClientRect();
  const q = items.filter(i => i.el.closest('#question, #permission'));
  return { overlaps, kodaHit, pseudoStacks, items: items.map(i => i.name), hasKoda: !!k,
    firstLeft: q.length ? Math.min(...q.map(i => i.box.l)) - ib.left - parseFloat(cs.paddingLeft) - parseFloat(cs.borderLeftWidth) : null };
});
async function probe(label, r, tag, theme, opts = {}) {
  try {
    const s = await scan(r);
    await r.screenshot(`/tmp/nusa-fix-${tag}-${theme}.png`);
    assert.deepEqual(s.overlaps, [], `${label}/${theme}: glyph overlap (${s.items.join(' | ')})`);
    assert.ok(s.hasKoda, `${label}/${theme}: Koda present`);
    assert.deepEqual(s.kodaHit, [], `${label}/${theme}: Koda overlaps glyphs`);
    for (const p of s.pseudoStacks) assert.deepEqual(p.others, [], `${label}/${theme}: pseudo glyph ${p.name} shares its centre with ${p.others}`);
    if (opts.leftEdge) assert.ok(s.firstLeft <= 40 && s.firstLeft >= 0, `${label}/${theme}: first content left edge ${s.firstLeft}px from island padding edge (<= 40)`);
  } finally { await r.close(); }
}
(async () => {
  for (const theme of ['dark', 'light']) {
    await probe('permission', await H.open({ question: 'approvalPi', theme }), 'permission', theme, { leftEdge: true });
    await probe('plain', await H.open({ question: 'plain', theme }), 'plain', theme);
    await probe('finished', await H.open({ finishedCard: 'pi', sessions: [], quick: true, theme }), 'finished', theme);
    const r = await H.open({ noticeRows: [ERR], sessions: [], quick: true, theme });
    await r.page.evaluate(() => window.__emit('desktop:notice-open', { id: '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b', kind: 'finished' })); await r.page.waitForTimeout(1500);
    await probe('error', r, 'error', theme);
  }
  console.log('island-nusa-overlap-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });

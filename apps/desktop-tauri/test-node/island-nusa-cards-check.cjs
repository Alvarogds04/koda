'use strict';
/* HU-063 follow-up (human, 29-oct, canvas replica): Koda BIG on the left in the take-over cards; permission buttons with air; the finished
   card makes the island fit its content; the band under the island reads as one piece with it. Real layout (Playwright), windowCap 340.
   Screenshots: /tmp/nusa-cards-<name>-<theme>.png */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-cards-check: no playwright — NOT a pass'); process.exit(0); }
const LONG = 'Migración aplicada, 14 tests pasan, el despliegue de staging quedó verificado sin errores y el informe de cobertura se guardó en la carpeta de resultados del proyecto.';
const ERR = { id: '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b', title: 'Pi falló', detail: 'Error al compilar', severity: 'error', kind: 'settled', expiresAt: Date.now() + 600000, agent: 'codex', projectName: 'api' };
async function shots(r, name) {
  for (const th of ['dark', 'light']) { await r.page.evaluate(t => { document.documentElement.dataset.theme = t; }, th); await r.page.waitForTimeout(250); await r.page.screenshot({ path: `/tmp/nusa-cards-${name}-${th}.png` }); }
}
const kodaBox = r => r.page.evaluate(() => { const k = document.querySelector('.koda-sprite[data-koda-slot="nusa"]'), i = document.getElementById('island').getBoundingClientRect(), b = k.getBoundingClientRect();
  return { w: b.width, h: b.height, l: b.left - i.left, r: b.right - i.left, iw: i.width, t: b.top - i.top, b: b.bottom - i.top, ih: i.height }; });
function bigLeft(k, name) {
  assert.ok(k.w === k.h && k.w % 32 === 0 && k.w / 32 >= 3, `${name}: Koda k>=3 integer: ${k.w}x${k.h}`);
  assert.ok(k.l >= 0 && k.r <= k.iw / 2 && k.t >= 0 && k.b <= k.ih, `${name}: Koda in the left half, inside: ${JSON.stringify(k)}`);
}
(async () => {
  { // B) permission buttons
    const r = await H.open({ question: 'approvalPi', windowCap: 340 });
    try {
      await r.page.waitForTimeout(500);
      const m = await r.page.evaluate(() => {
        const isl = document.getElementById('island').getBoundingClientRect(), cmd = document.getElementById('question-approval-cmd').getBoundingClientRect();
        const btns = [...document.querySelectorAll('#question-approval-actions .q-approval-btn')].map(b => {
          const x = b.getBoundingClientRect(), a = getComputedStyle(b, '::after'), ins = parseFloat(a.top) + parseFloat(a.bottom), top = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2);
          return { t: x.top, b: x.bottom, l: x.left, r: x.right, h: x.height, visH: x.height - ins, ok: top === b || b.contains(top), word: b.textContent };
        }).sort((p, q) => p.l - q.l);
        return { btns, cmdB: cmd.bottom, islB: isl.bottom, islT: isl.top, nav: document.getElementById('question-approval-actions').getBoundingClientRect().bottom };
      });
      assert.ok(m.btns.length === 2, 'two approval buttons');
      assert.ok(m.btns[1].l - m.btns[0].r >= 12, `gap between buttons >= 12 (got ${m.btns[1].l - m.btns[0].r})`);
      for (const b of m.btns) {
        assert.ok(b.h >= 44, `hit area >= 44 (${b.h})`); assert.ok(b.visH >= 40, `visual height >= 40 (${b.visH})`); assert.ok(b.ok, `${b.word} not covered`);
        assert.ok(b.t + (b.h - b.visH) / 2 - m.cmdB >= 8, `air above buttons >= 8 from the command box (${b.t + (b.h - b.visH) / 2 - m.cmdB})`);
        assert.ok(m.islB - (b.b - (b.h - b.visH) / 2) >= 12, `air below buttons >= 12 to the island edge (${m.islB - (b.b - (b.h - b.visH) / 2)})`);
        assert.ok(b.b <= m.islB && b.t >= m.islT, 'inside the island (not clipped)');
      }
      bigLeft(await kodaBox(r), 'permission');
      await shots(r, 'permission');
    } finally { await r.close(); }
    const css = fs.readFileSync(__dirname + '/../frontend/island-nusa.css', 'utf8');
    assert.match(css, /#permission #card-actions[^{]*\{[^}]*gap: *(1[2-9]|[2-9]\d)px/, 'legacy #permission action row (Permitir/Rechazar/Espera tu respuesta) gets the same >= 12px gap');
    assert.match(css, /#permission #card-actions[^{]*\{[^}]*margin-top: *(1[0-9]|[2-9]\d)px|#permission #operation[^{]*\{[^}]*margin-bottom/, '#permission: air between the command and the actions');
  }
  for (const kind of ['plain', 'multi', 'form']) {
    const r = await H.open({ question: kind, windowCap: 340 });
    try { await r.page.waitForTimeout(500); bigLeft(await kodaBox(r), kind); await shots(r, kind); } finally { await r.close(); }
  }
  // C) finished: the island fits the content
  const fin = async (text, name) => {
    const r = await H.open({ finishedCard: 'pi', finishedText: text, sessions: [], quick: true, windowCap: 340 });
    try {
      await r.page.waitForTimeout(600);
      const m = await r.page.evaluate(() => {
        const isl = document.getElementById('island').getBoundingClientRect(), msg = document.getElementById('notice-card-message'), cs = getComputedStyle(msg);
        const bs = ['notice-card-terminal', 'notice-card-ok'].map(id => document.getElementById(id).getBoundingClientRect()).sort((a, b) => a.left - b.left);
        const range = document.createRange(); range.selectNodeContents(msg); const tr = range.getBoundingClientRect();
        return { islB: isl.bottom, islH: isl.height, btnB: Math.max(...bs.map(b => b.bottom)), gap: bs[1].left - bs[0].right, ws: cs.whiteSpace, to: cs.textOverflow, fs: cs.fontSize, sh: msg.scrollHeight, ch: msg.clientHeight, msgB: msg.getBoundingClientRect().bottom, textB: tr.bottom, text: msg.textContent };
      });
      const pad = m.islB - m.btnB;
      assert.ok(pad >= 12 && pad <= 24, `${name}: island bottom padding below the buttons 12..24 (got ${pad}, island ${m.islH})`);
      assert.ok(m.ws !== 'nowrap' && m.to !== 'ellipsis', `${name}: message wraps, no «…» (${m.ws}/${m.to})`);
      assert.equal(m.fs, '15px', `${name}: message is 15px`);
      assert.ok(m.sh <= m.ch + 1 && m.textB <= m.msgB + 1, `${name}: whole message visible (${m.sh} > ${m.ch})`);
      assert.ok(m.gap >= 8, `${name}: Ver/OK spacing >= 8 (${m.gap})`);
      assert.ok(m.islH <= 340, `${name}: island within the frozen 340 window`);
      bigLeft(await kodaBox(r), name);
      await shots(r, name); return m.islH;
    } finally { await r.close(); }
  };
  const hs = await fin('Migración aplicada, 14 tests pasan.', 'finished-short'), hl = await fin(LONG, 'finished-long');
  assert.ok(hl > hs, `the island grows with a longer message (${hs} -> ${hl})`);
  { // error notice
    const r = await H.open({ noticeRows: [ERR], sessions: [], quick: true, windowCap: 340 });
    try { await r.page.evaluate(() => window.__emit('desktop:notice-open', { id: '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b', kind: 'finished' })); await r.page.waitForTimeout(1500); bigLeft(await kodaBox(r), 'error'); await shots(r, 'error'); } finally { await r.close(); }
  }
  // D) the band under the island is ONE piece with it: the island's black, concave ears, >= 10px (frozen) of island black below
  for (const [name, sc, sel] of [['band-engine', { engine: 'down' }, '#engine-band'], ['band-notices', { notices: 2 }, '#notices']]) {
    const r = await H.open({ ...sc, windowCap: 340 });
    try {
      await r.page.waitForTimeout(300);
      const m = await r.page.evaluate(sel => {
        const b = document.querySelector(sel), x = b.getBoundingClientRect(), cs = getComputedStyle(b), isl = document.getElementById('island').getBoundingClientRect();
        const ear = p => { const c = getComputedStyle(b, p); return { content: c.content, bg: c.backgroundImage, w: parseFloat(c.width) }; };
        return { bg: cs.backgroundColor, air: isl.bottom - x.bottom, before: ear('::before'), after: ear('::after') };
      }, sel);
      assert.equal(m.bg, 'rgb(0, 0, 0)', `${name}: band is the island's black (${m.bg})`);
      assert.ok(m.air >= 10, `${name}: the island's own black shows below the band (>= 10px; 12 would move frozen R6 numbers) (${m.air})`);
      for (const e of [m.before, m.after]) assert.ok(e.content !== 'none' && /radial-gradient/.test(e.bg) && e.w >= 8, `${name}: concave ear present: ${JSON.stringify(e)}`);
      await shots(r, name);
    } finally { await r.close(); }
  }
  console.log('island-nusa-cards-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

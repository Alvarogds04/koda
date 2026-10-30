'use strict';
/* HU-057: the «Avisos · N» list (#notices[data-list=open]) lives INSIDE the 150px notch. Real layout (island-geometry-harness).
   - list box inside the island box; when its rows are taller than the box the ROWS area scrolls (overflow-y auto, visible 6px scrollbar);
   - every row reachable (scrolled into view, centre uncovered), rows >= 44px, dismiss + «Descartar todos» uncovered;
   - the list is above #nusa (z-order); text AA; dark + light; the island height is unchanged. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-noticelist-check: no playwright — NOT a pass'); process.exit(0); }
const uuid = n => `${n}f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b`;
const mk = (i, title) => ({ id: uuid(i), kind: 'settled', title, detail: 'Resultado', severity: 'info', at: Date.now(), expiresAt: Date.now() + 600000 });
const long = 'Codex terminó: ' + 'resultado largo que pasa a la línea siguiente '.repeat(3);
const scenarios = {
  1: [mk(3, 'Pi terminó su turno')],
  3: [mk(3, 'Pi terminó su turno'), mk(4, long), { ...mk(5, 'Conexión caída'), kind: 'transport' }],
  8: Array.from({ length: 8 }, (_, i) => mk(i, i === 2 ? long : `Aviso número ${i + 1}`)),
};
const lum = c => { const v = c.map(x => { x /= 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }); return .2126 * v[0] + .7152 * v[1] + .0722 * v[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
(async () => {
  for (const theme of ['dark', 'light']) for (const n of [1, 3, 8]) {
    const r = await H.open({ theme, noticeRows: scenarios[n], quick: true });
    const tag = `${theme}/${n}`;
    try {
      await r.page.locator('#notice-action').click();
      await r.page.waitForTimeout(150);
      const info = await r.page.evaluate(() => {
        const isl = document.getElementById('island').getBoundingClientRect(), L = document.getElementById('notice-list').getBoundingClientRect();
        const rowsEl = document.getElementById('notice-rows'), rs = getComputedStyle(rowsEl), rb = rowsEl.getBoundingClientRect();
        const sb = getComputedStyle(rowsEl, '::-webkit-scrollbar');
        const nusa = document.getElementById('nusa'), z = el => { const s = getComputedStyle(el); return s.zIndex; };
        const open = document.getElementById('notices');
        const hid = id => { const el = document.getElementById(id); if (!el) return true; const s = getComputedStyle(el), b = el.getBoundingClientRect(); return s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0 || b.width === 0 || s.pointerEvents === 'none'; };
        return { isl: { l: isl.left, t: isl.top, r: isl.right, b: isl.bottom, h: isl.height }, L: { l: L.left, t: L.top, r: L.right, b: L.bottom },
          rows: { t: rb.top, b: rb.bottom, oy: rs.overflowY, sh: rowsEl.scrollHeight, ch: rowsEl.clientHeight, sbw: sb.width, sw: rs.scrollbarWidth, cw: rowsEl.offsetWidth - rowsEl.clientWidth },
          noticesZ: z(open), nusaZ: z(nusa), nusaDisplay: getComputedStyle(nusa).display, nusaZIndexParent: z(nusa.parentElement),
          covers: ['nusa-dots', 'nusa-prev', 'nusa-next', 'nusa-clock'].filter(id => !hid(id)),
          bg: getComputedStyle(document.getElementById('island')).backgroundColor };
      });
      assert.equal(info.isl.h, 150, `${tag}: the expanded island stays 150px with the list open`);
      assert.ok(info.L.l >= info.isl.l && info.L.r <= info.isl.r && info.L.t >= info.isl.t && info.L.b <= info.isl.b, `${tag}: list box inside the island ${JSON.stringify(info)}`);
      assert.ok(info.rows.b <= info.isl.b - 8, `${tag}: rows leave the island bottom padding ${info.rows.b} vs ${info.isl.b}`);
      if (info.rows.sh > info.rows.ch + 1) {
        assert.ok(info.rows.oy === 'auto' || info.rows.oy === 'scroll', `${tag}: taller rows scroll (overflow-y ${info.rows.oy})`);
        assert.equal(info.rows.sbw, '6px', `${tag}: visible 6px scrollbar`);
        assert.notEqual(info.rows.sw, 'none', `${tag}: scrollbar-width none would hide it (headless Chromium passes --hide-scrollbars, so the width cannot be measured)`);
      }
      if (n === 8) assert.ok(info.rows.sh > info.rows.ch, '8 notices overflow the list so it must scroll');
      assert.deepEqual(info.covers, [], `${tag}: dots/arrows/clock hidden while the list is open`);
      // every row reachable
      const count = await r.page.locator('.notice-list-row').count();
      assert.equal(count, n);
      for (let i = 0; i < count; i++) {
        const row = r.page.locator('.notice-list-row').nth(i);
        await row.scrollIntoViewIfNeeded();
        const hit = await r.page.evaluate(i => {
          const isl = document.getElementById('island').getBoundingClientRect(), list = document.getElementById('notice-rows').getBoundingClientRect();
          const row = document.querySelectorAll('.notice-list-row')[i], out = {};
          for (const sel of ['button.notice-list-open', '.notice-list-dismiss']) {
            const el = row.querySelector(sel); if (!el) continue; const b = el.getBoundingClientRect(), top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
            out[sel] = { ok: !!top && (top === el || el.contains(top)), h: b.height, inList: b.top >= list.top - .5 && b.bottom <= list.bottom + .5, inIsland: b.bottom <= isl.bottom && b.top >= isl.top };
          }
          return out;
        }, i);
        for (const [sel, h] of Object.entries(hit)) {
          assert.ok(h.ok, `${tag}: row ${i} ${sel} is covered`);
          assert.ok(h.h >= 44, `${tag}: row ${i} ${sel} hit height ${h.h}`);
          assert.ok(h.inList && h.inIsland, `${tag}: row ${i} ${sel} fully in view after scroll ${JSON.stringify(h)}`);
        }
      }
      const clear = await r.page.evaluate(() => { const el = document.getElementById('notice-clear'), b = el.getBoundingClientRect(), top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return { ok: !!top && (top === el || el.contains(top)), b: b.bottom }; });
      assert.ok(clear.ok, `${tag}: «Descartar todos» covered`);
      const title = await r.page.evaluate(() => { const el = document.getElementById('notice-list-title'), b = el.getBoundingClientRect(), top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return top === el || el.contains(top); });
      assert.ok(title, `${tag}: list title covered by #nusa`);
      assert.deepEqual((await r.hitEdges('button.notice-list-open')).filter(h => !h.ok), [], `${tag}: row edges`);
      // AA: text against the black island
      const colors = await r.page.evaluate(() => [...document.querySelectorAll('#notice-list-title, #notice-clear, .notice-list-title, .notice-list-time')].map(el => ({ c: getComputedStyle(el).color, px: parseFloat(getComputedStyle(el).fontSize) })));
      const rgb = s => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const bg = rgb(info.bg);
      for (const c of colors) assert.ok(contrast(rgb(c.c), bg) >= 4.5, `${tag}: AA ${c.c} on ${info.bg}`);
      assert.deepEqual(bg, [0, 0, 0], `${tag}: island is black`);
      await r.screenshot(`/tmp/nusa-noticelist-${theme}-${n}.png`);
    } finally { await r.close(); }
  }
  console.log('PASS island-nusa-noticelist: list inside the 150px notch, scrollable, every row reachable, above #nusa, AA, dark+light, 1/3/8 notices');
})().catch(e => { console.error(e); process.exitCode = 1; });

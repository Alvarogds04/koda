'use strict';
/* «Ver todas (N)» in the Nusa Agentes tab opens the existing sessions overlay (human decision A, 28-oct). Real layout (Playwright).
   Run: node test-node/island-nusa-sessions-all-check.cjs */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-sessions-all-check: no playwright — NOT a pass'); process.exit(0); }
const shot = process.env.NUSA_SHOTS === '1';
const inIsland = (b, isl) => b.left >= isl.left - 0.5 && b.right <= isl.right + 0.5 && b.top >= isl.top - 0.5 && b.bottom <= isl.bottom + 0.5;
(async () => {
  for (const theme of ['dark', 'light']) {
    const r = await H.open({ manyPi: true, theme });
    try {
      const { page } = r;
      await page.click('[data-tab=agentes]'); await page.waitForTimeout(300);
      const isl = (await r.measure('#island'))[0];
      const link = (await r.measure('.nusa-all')).filter(b => b.shown);
      assert.equal(link.length, 1, 'one link');
      assert.equal(link[0].text, 'Ver todas (14)');
      assert.ok(inIsland(link[0], isl), 'link inside the island');
      const panel = (await r.measure('#nusa-panel'))[0];
      assert.ok(link[0].bottom <= panel.bottom + 0.5, 'link inside the panel (not clipped)');
      assert.deepEqual((await r.hit('.nusa-all')).filter(h => !h.ok), [], 'link uncovered');
      const rows = (await r.measure('.nusa-agent')).filter(b => b.shown);
      assert.equal(rows.length, 2, '2 rows + link');
      assert.ok(rows.every(b => b.bottom <= link[0].top + 0.5), 'rows above the link');
      if (shot) await page.screenshot({ path: `/tmp/nusa-all-agentes-${theme}.png` });
      // untrusted click: nothing
      await page.evaluate(() => document.querySelector('.nusa-all').click()); await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.querySelector('.sessions-all').hidden), true, 'synthetic click does not open');
      assert.equal(await page.evaluate(() => document.getElementById('capsule').dataset.nusaSessions || ''), '');
      // untrusted event dispatch by anyone else still goes through the ticker's own canFocus (page script): not our gate; only check our link
      // trusted click
      const b = link[0]; await page.mouse.click((b.left + b.right) / 2, (b.top + b.bottom) / 2); await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => document.querySelector('.sessions-all').hidden), false, 'real click opens');
      const ov = (await r.measure('.sessions-all'))[0];
      assert.ok(ov.shown && inIsland(ov, isl), `overlay visible and inside the island ${JSON.stringify(ov)}`);
      assert.ok(ov.h <= 104.5 && ov.top >= 29.5, 'overlay is the notch body');
      const vis = await page.evaluate(() => { const o = document.querySelector('.sessions-all'), b = o.getBoundingClientRect(); const top = document.elementFromPoint(b.left + b.width / 2, b.top + 4); return { reach: !!top && o.contains(top), panel: getComputedStyle(document.getElementById('nusa-panel')).visibility, bg: getComputedStyle(o).backgroundColor }; });
      assert.ok(vis.reach, 'overlay receives pointer at its head'); assert.equal(vis.panel, 'hidden', 'Agentes chrome hidden behind'); assert.equal(vis.bg, 'rgb(0, 0, 0)');
      const back = (await r.measure('.sessions-all-back'))[0];
      assert.ok(back.shown && inIsland(back, isl) && back.h >= 20, 'Volver visible');
      // every row reachable by scrolling, none outside the island box
      const reach = await page.evaluate(async () => {
        const list = document.querySelector('.sessions-all-list'), lb = list.getBoundingClientRect(), out = [];
        const picks = [...document.querySelectorAll('.sessions-all-pick')];
        for (const p of picks) { p.scrollIntoView({ block: 'nearest' }); await new Promise(res => requestAnimationFrame(res)); const b = p.getBoundingClientRect(); const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          out.push(b.top >= lb.top - 0.5 && b.bottom <= lb.bottom + 0.5 && !!top && p.contains(top)); }
        list.scrollTop = 0; return { n: picks.length, ok: out.every(Boolean), scrolls: list.scrollHeight > list.clientHeight };
      });
      assert.equal(reach.n, 14); assert.ok(reach.ok, 'every row reachable and uncovered after scrolling'); assert.ok(reach.scrolls, 'list scrolls');
      if (shot) await page.screenshot({ path: `/tmp/nusa-all-overlay-${theme}.png` });
      if (theme === 'dark') {
        // Volver closes, Agentes tab again
        await page.mouse.click((back.left + back.right) / 2, (back.top + back.bottom) / 2); await page.waitForTimeout(300);
        const st = await page.evaluate(() => ({ hidden: document.querySelector('.sessions-all').hidden, flag: document.getElementById('capsule').dataset.nusaSessions || '', agents: !!document.querySelector('#nusa-panel .nusa-agents'), pv: getComputedStyle(document.getElementById('nusa-panel')).visibility, tab: document.getElementById('nusa-tab-agentes').getAttribute('aria-selected') }));
        assert.deepEqual(st, { hidden: true, flag: '', agents: true, pv: 'visible', tab: 'true' }, 'Volver returns to Agentes');
        // Escape closes
        const l2 = (await r.measure('.nusa-all'))[0]; await page.mouse.click((l2.left + l2.right) / 2, (l2.top + l2.bottom) / 2); await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => document.querySelector('.sessions-all').hidden), false);
        await page.keyboard.press('Escape'); await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => document.querySelector('.sessions-all').hidden), true, 'Escape closes');
        assert.equal(await page.evaluate(() => document.getElementById('capsule').dataset.nusaSessions || ''), '');
        assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.className), 'nusa-link nusa-all', 'focus back on the link');
        // pick a session
        const l3 = (await r.measure('.nusa-all'))[0]; await page.mouse.click((l3.left + l3.right) / 2, (l3.top + l3.bottom) / 2); await page.waitForTimeout(300);
        await page.evaluate(() => { window.__sel = []; document.addEventListener('abito:session-focused', e => window.__sel.push(e.detail.id)); });
        const pk = (await r.measure('.sessions-all-pick'))[2]; await page.mouse.click((pk.left + pk.right) / 2, (pk.top + pk.bottom) / 2); await page.waitForTimeout(300);
        const sel = await page.evaluate(() => ({ sel: window.__sel, hidden: document.querySelector('.sessions-all').hidden }));
        assert.equal(sel.sel.length, 1, 'a row click selects a session'); assert.equal(sel.hidden, true);
      }
    } finally { await r.close(); }
  }
  for (const n of [3, 2, 0]) {
    const sessions = Array.from({ length: n }, (_, i) => ({ id: 's-' + (0x200 + i).toString(16).padStart(8, '0'), kind: 'pi', cwd: 'p' + i, state: 'sleeping', origin: null }));
    const r = await H.open({ sessions });
    try {
      await r.page.click('[data-tab=agentes]'); await r.page.waitForTimeout(300);
      assert.equal(await r.page.evaluate(() => document.querySelectorAll('.nusa-all').length), 0, `${n} sessions: no link`);
      assert.equal((await r.measure('.nusa-agent')).filter(b => b.shown).length, n);
    } finally { await r.close(); }
  }
  console.log('island-nusa-sessions-all-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });

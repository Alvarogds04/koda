'use strict';
/* Nusa Agentes rows are controls: a trusted click selects the session, the «↗» jump opens THAT session's terminal through the
   existing closed focus_host verb. Real layout (Playwright); host calls are recorded by the harness fake as window.__focusCalls.
   Run: node test-node/island-nusa-agent-actions-check.cjs */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-agent-actions-check: no playwright — NOT a pass'); process.exit(0); }
const shot = process.env.NUSA_SHOTS === '1';
const SESS = [
  { id: 's-000000a1', kind: 'pi', cwd: 'alfa', state: 'running', origin: null },
  { id: 's-000000a2', kind: 'codex', cwd: 'beta', state: 'sleeping', origin: null },
];
const inIsland = (b, isl) => b.left >= isl.left - 0.5 && b.right <= isl.right + 0.5 && b.top >= isl.top - 0.5 && b.bottom <= isl.bottom + 0.5;
const mid = b => [(b.left + b.right) / 2, (b.top + b.bottom) / 2];
(async () => {
  for (const theme of ['dark', 'light']) {
    const r = await H.open({ sessions: SESS, theme });
    try {
      const { page } = r;
      await page.click('[data-tab=agentes]'); await page.waitForTimeout(300);
      await page.evaluate(() => { window.__sel = []; document.addEventListener('abito:session-focused', e => window.__sel.push(e.detail.id)); });
      const isl = (await r.measure('#island'))[0];
      const rows = (await r.measure('.nusa-agent')).filter(b => b.shown), jumps = (await r.measure('.nusa-jump')).filter(b => b.shown);
      assert.equal(rows.length, 2); assert.equal(jumps.length, 2, 'a jump per row');
      assert.ok([...rows, ...jumps].every(b => inIsland(b, isl)), 'inside the island');
      assert.deepEqual((await r.hit('.nusa-agent')).filter(h => !h.ok), [], 'rows hit-testable');
      assert.deepEqual((await r.hit('.nusa-jump')).filter(h => !h.ok), [], 'jumps hit-testable');
      const attrs = await page.evaluate(() => [...document.querySelectorAll('.nusa-agent')].map(x => ({ role: x.getAttribute('role'), tab: x.tabIndex, aria: x.getAttribute('aria-label'), name: x.querySelector('.nusa-agent-name').scrollWidth <= x.querySelector('.nusa-agent-name').clientWidth + 1, j: x.querySelector('.nusa-jump').getAttribute('aria-label'), jt: x.querySelector('.nusa-jump').title, jb: x.querySelector('.nusa-jump').getBoundingClientRect().width, hit: getComputedStyle(x.querySelector('.nusa-jump'), '::after').content })));
      for (const a of attrs) { assert.equal(a.role, 'button'); assert.equal(a.tab, 0); assert.match(a.aria, / — seleccionar$/); assert.match(a.j, /^Abrir la terminal de /); assert.equal(a.jt, a.j); assert.ok(a.jb >= 14); assert.notEqual(a.hit, 'none'); }
      // untrusted clicks do nothing
      await page.evaluate(() => { for (const x of document.querySelectorAll('.nusa-agent')) x.click(); for (const j of document.querySelectorAll('.nusa-jump')) j.click(); });
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => ({ sel: window.__sel, calls: window.__focusCalls || [] })), { sel: [], calls: [] }, 'synthetic clicks do nothing');
      // trusted row click selects
      const r2 = rows[1]; await page.mouse.click(r2.left + 60, (r2.top + r2.bottom) / 2); await page.waitForTimeout(300);
      let st = await page.evaluate(() => ({ sel: window.__sel, focus: [...document.querySelectorAll('.nusa-agent')].map(x => x.dataset.focus), calls: window.__focusCalls || [] }));
      assert.deepEqual(st.sel, ['s-000000a2'], 'row click selects that id'); assert.deepEqual(st.focus, ['false', 'true']); assert.deepEqual(st.calls, [], 'select does not jump');
      // trusted jump: exactly one closed call for THAT row
      const j1 = (await r.measure('.nusa-jump')).filter(b => b.shown)[0]; await page.mouse.click(...mid(j1)); await page.waitForTimeout(300);
      st = await page.evaluate(() => ({ sel: window.__sel, calls: window.__focusCalls || [], focus: [...document.querySelectorAll('.nusa-agent')].map(x => x.dataset.focus) }));
      assert.deepEqual(st.calls, [{ target: 'terminal', session: 's-000000a1' }], 'one focus_host for that row');
      assert.equal(st.sel[st.sel.length - 1], 's-000000a1', 'jump selects first'); assert.deepEqual(st.focus, ['true', 'false']);
      // keyboard: Enter / Space on a focused row selects
      await page.evaluate(() => document.querySelectorAll('.nusa-agent')[1].focus()); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.__sel[window.__sel.length - 1]), 's-000000a2', 'Enter selects');
      await page.evaluate(() => document.querySelectorAll('.nusa-agent')[0].focus()); await page.keyboard.press('Space'); await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.__sel[window.__sel.length - 1]), 's-000000a1', 'Space selects');
      assert.equal(await page.evaluate(() => (window.__focusCalls || []).length), 1, 'keys never jump');
      // Enter on the jump button jumps once (native button), not twice
      await page.evaluate(() => document.querySelectorAll('.nusa-jump')[1].focus()); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
      assert.deepEqual(await page.evaluate(() => window.__focusCalls), [{ target: 'terminal', session: 's-000000a1' }, { target: 'terminal', session: 's-000000a2' }]);
      if (shot) await page.screenshot({ path: `/tmp/nusa-agent-actions-${theme}.png` });
    } finally { await r.close(); }
  }
  // a malformed id never reaches the host, even if the event is forced
  const r = await H.open({ sessions: [{ id: 'weird id', kind: 'pi', cwd: 'x', state: 'running', origin: null }, { id: 's-000000b1', kind: 'codex', cwd: 'y', state: 'sleeping', origin: null }] });
  try {
    const { page } = r;
    await page.click('[data-tab=agentes]'); await page.waitForTimeout(300);
    const n = await page.evaluate(() => [...document.querySelectorAll('.nusa-agent')].map(x => !!x.querySelector('.nusa-jump')));
    assert.ok(n.every(Boolean) && n.length <= 2, 'every shown row has a jump (the view already drops malformed ids)');
    await page.evaluate(() => { for (const id of ['weird id', '../x', 'S-000000B1', null]) document.dispatchEvent(new CustomEvent('abito:session-jump', { detail: { id } })); });
    await page.waitForTimeout(200);
    assert.deepEqual(await page.evaluate(() => window.__focusCalls || []), [], 'the ticker refuses malformed ids');
  } finally { await r.close(); }
  console.log('island-nusa-agent-actions-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });

'use strict';
// D1: an idle session's expanded overview shows «En reposo» exactly once (centre card OR status column, never both). (real layout, playwright)
// HU-057 L4/L5: the idle overview is the Nusa notch; the legacy #overview-view (where «En reposo» lived) is hidden, so:
//  - legacy: «En reposo» appears 0 times in the (hidden) legacy overview — hidden by design;
//  - Nusa: the word appears exactly once, in the Agentes row chip (Inicio carries the lowercase sentence «Pi · en reposo · repo», a different string).
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-idle-word-check: no Playwright — NOT a pass'); process.exit(0); }
(async () => {
  let passed = 0, failed = 0;
  const test = async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } };
  const visibleWords = (r, root) => r.page.evaluate(sel => [...document.querySelectorAll(sel + ' *')].filter(el => {
    if (el.children.length || (el.textContent || '').trim() !== 'En reposo') return false;
    const b = el.getBoundingClientRect(), s = getComputedStyle(el);
    return b.width > 0 && b.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0;
  }).map(el => el.className || el.parentElement.className), root);
  const scenario = { sessions: [{ id: 's-0000000c', kind: 'pi', cwd: 'repo', state: 'sleeping', origin: null }], quick: true };
  const r = await H.open(scenario);
  try {
    await test('idle session: legacy overview is hidden by design in the Nusa state (HU-057), «En reposo» appears 0 times there', async () => assert.equal((await visibleWords(r, '#overview-view')).length, 0));
    await test('idle session: Nusa Inicio says «Pi · en reposo · repo» once and no bare «En reposo» element', async () => {
      assert.equal(await r.page.evaluate(() => document.getElementById('nusa-panel').innerText.trim()), 'Pi · en reposo · repo');
      assert.equal((await visibleWords(r, '#nusa')).length, 0);
    });
    await test('idle session: «En reposo» appears 1 time(s) in the Nusa Agentes tab (one row chip)', async () => {
      await r.page.click('[data-tab=agentes]'); await r.page.waitForTimeout(300);
      assert.equal((await visibleWords(r, '#nusa')).length, 1, JSON.stringify(await visibleWords(r, '#nusa')));
    });
  } finally { await r.close(); }
  console.log(`island-idle-word-check: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });

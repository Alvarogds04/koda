'use strict';
// Ajustes page header (human comments 4/5/6/7, 29-oct): no big Abito illustration, a compact title row (<= 64px), hero actions untouched,
// and every «Instalar…» button reads «Instalar» (additive rewrite in settings-nusa-mount.js; vendor untouched). Real layout, headless Chromium.
const assert = require('node:assert/strict');
const { open } = require('./settings-layout-harness.cjs');

const PAGES = [['General', 'general'], ['Agentes', 'agents'], ['Chat', 'chat'], ['Atajos', 'shortcuts'], ['Privacidad', 'privacy'], ['Isla', 'isla']];
const snap = () => {
  const hero = document.querySelector('#hub .hub-panel .hub-hero');
  const vis = el => { const b = el.getBoundingClientRect(), s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0; };
  const art = [...document.querySelectorAll('#hub .hub-panel svg.troupe, #hub .hub-panel .hub-hero svg')].filter(vis).length;
  const actions = hero ? [...hero.querySelectorAll('.actions *')] : [];
  const h1 = hero && hero.querySelector('h1');
  const ell = [...document.querySelectorAll('#hub .hub-panel button')].filter(b => vis(b) && /(…|\.\.\.)\s*$/.test((b.textContent || '').trim()) && /^Instalar/.test((b.textContent || '').trim())).map(b => b.textContent);
  const labels = [...document.querySelectorAll('#hub .hub-panel button')].filter(vis).map(b => (b.textContent || '').trim());
  return { hero: !!hero, h: hero ? hero.getBoundingClientRect().height : 0, art, title: h1 ? { text: h1.textContent, shown: vis(h1) } : null,
    actionsShown: actions.filter(vis).length, actionsTotal: actions.length, ell, labels };
};

(async () => {
  const H = await open({ agentsOk: true });
  if (!H) { console.log('SKIPPED: playwright is not installed (dev tool)'); process.exit(0); }
  const shots = process.env.HDR_SHOTS === '1';
  try {
    await H.shellAfter();
    for (const [title, id] of PAGES) {
      await H.go(title);
      const s = await H.page.evaluate(snap);
      assert.ok(s.hero, `${id}: hero band exists`);
      assert.equal(s.art, 0, `${id}: no visible hero illustration (svg.troupe)`);
      assert.ok(s.h > 0 && s.h <= 64, `${id}: hero band ${s.h}px must be <= 64px`);
      assert.ok(s.title && s.title.shown && s.title.text.trim().length > 0, `${id}: page title still visible`);
      assert.equal(s.actionsShown, s.actionsTotal, `${id}: every hero action stays visible`);
      if (shots) for (const theme of ['dark', 'light']) {
        await H.page.emulateMedia({ colorScheme: theme }); await H.page.waitForTimeout(250);
        await H.screenshot(`/tmp/settings-hdr-${id}-${theme}.png`);
      }
    }
    // Agentes: Instalar without ellipsis, same host call as before the rewrite, idempotent across re-renders
    await H.go('Agentes');
    let s = await H.page.evaluate(snap);
    const installs = s.labels.filter(l => /^Instalar/.test(l));
    assert.ok(installs.length >= 1, 'Agentes shows install buttons');
    assert.deepEqual([...new Set(installs)], ['Instalar'], 'install buttons read exactly «Instalar»');
    assert.deepEqual(s.labels.filter(l => /(…|\.\.\.)$/.test(l) && /^Instalar/.test(l)), [], 'no Instalar… left');
    await H.go('General'); await H.go('Agentes'); // render twice
    const again = await H.page.evaluate(snap);
    assert.deepEqual(again.labels.filter(l => /^Instalar/.test(l)), again.labels.filter(l => /^Instalar/.test(l)).map(() => 'Instalar'), 'idempotent after re-render');
    assert.ok(again.labels.filter(l => /^Instalar/.test(l)).length >= 1);
    const before = (await H.calls()).length;
    await H.page.locator('#hub .hub-panel button', { hasText: /^Instalar$/ }).first().click(); // trusted click
    await H.page.waitForTimeout(600);
    const after = (await H.calls()).slice(before);
    assert.ok(after.some(c => c[0] === 'agent_action' && c[1] === 'agent_connect'), `click keeps its host call (agent_connect); got ${JSON.stringify(after)}`);
    console.log('settings-nusa-header-check: ok');
  } finally { await H.close(); }
})().catch(e => { console.error(e); process.exit(1); });

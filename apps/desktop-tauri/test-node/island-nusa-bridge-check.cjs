'use strict';
/* HU-063 RDD fix (canvas comment blwr8o57), two visible defects of the replica gallery, real layout (island-geometry-harness):
   (1) the DESKTOP bridge approval card (#permission, #allow/#deny/#card-fold/#card-wait) is not cut by the island bottom: the island ADJUSTS
       to the card like the Terminó card (header + card + 16px air, capped at the frozen 340 window less 16px), buttons keep a 44px hit area
       and >= 8px between them; the other states keep their frozen sizes (pinned in island-nusa-shell-check.cjs).
   (2) no STRAY dot: the legacy #compact-flag never shows outside the pill (compact question, compact card, idle, hidden strip, toast); the
       pill's own dot (--pill-dot) carries the state (sun for question/card). Playwright; SKIPPED loudly when absent. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-bridge-check: no playwright — NOT a pass'); process.exit(0); }
const CARD = () => ({ operation: 'bash: npm run build', reason: null, state: 'pending', expires_at: new Date(Date.now() + 600000).toISOString() });
const snap = (state, card) => ({ state, notices: [], card, request: null, revision: Date.now(), motionOverride: false, unavailable: false, connections: 1 });
const bad = []; let ran = 0;

// every element inside #capsule (and its pseudo ::after/::before) that paints a yellow/sun/red fill, with its box
const strays = page => page.evaluate(() => {
  const cap = document.getElementById('capsule'), isl = document.getElementById('island').getBoundingClientRect();
  const toast = document.getElementById('question-toast')?.getBoundingClientRect() || document.querySelector('[id*="toast"]')?.getBoundingClientRect();
  const inside = (b, r) => r && b.left >= r.left - 1 && b.right <= r.right + 1 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1;
  const warm = c => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return false; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).map(Number); return a > 0.05 && r > 150 && g < 235 && b < 140 && r - b > 90; };
  const out = [];
  for (const el of cap.querySelectorAll('*')) {
    const s = getComputedStyle(el), b = el.getBoundingClientRect();
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0 || b.width <= 0 || b.height <= 0) continue;
    const paints = warm(s.backgroundColor) || (el.id === 'compact-flag' && warm(s.color));
    if (!paints) continue;
    if (inside(b, isl) || inside(b, toast)) continue;
    out.push(`${el.id || el.className}[${[b.left, b.top, b.width, b.height].map(Math.round)}]`);
  }
  return out;
});
const flagBox = page => page.evaluate(() => { const f = document.getElementById('compact-flag'), s = getComputedStyle(f), b = f.getBoundingClientRect(); return { shown: s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0, hidden: f.hidden, box: [b.left, b.top, b.width, b.height].map(Math.round) }; });

(async () => {
  // ── (1) expanded bridge card, both themes
  const sizes = {};
  for (const theme of ['dark', 'light']) {
    const r = await H.open({ bridgeCard: true, sessions: [], quick: true, theme });
    try {
      await r.page.evaluate(s => window.__emit('desktop:state', s), snap('expanded', CARD())); await r.page.waitForTimeout(1500); ran++;
      const t = `${theme}/bridge card`;
      const [isl] = await r.measure('#island'); const [allow] = await r.measure('#allow'), [deny] = await r.measure('#deny'), [fold] = await r.measure('#card-fold'), [wait] = await r.measure('#card-wait');
      const state = await r.page.evaluate(() => document.getElementById('capsule').dataset.card);
      if (state !== 'pending') bad.push(`${t}: capsule data-card=${state}, expected pending`);
      sizes[theme] = Math.round(isl.h);
      for (const [n, e] of [['#allow', allow], ['#deny', deny], ['#card-fold', fold], ['#card-wait', wait]]) {
        if (!e.shown) { bad.push(`${t}: ${n} not shown`); continue; }
        if (e.bottom > isl.bottom - 8 + 0.5 || e.top < isl.top || e.left < isl.left || e.right > isl.right) bad.push(`${t}: ${n} not inside the island by 8px (${Math.round(e.bottom)} vs ${isl.bottom})`);
      }
      for (const [n, e] of [['#allow', allow], ['#deny', deny]]) if (e.h < 44 - 0.5) bad.push(`${t}: ${n} hit area ${e.h} < 44`);
      const gap = allow.left >= deny.right ? allow.left - deny.right : deny.left - allow.right;
      if (gap < 8) bad.push(`${t}: gap ${gap} < 8`);
      const pad = isl.bottom - Math.max(allow.bottom, deny.bottom);
      if (pad < 12 || pad > 24) bad.push(`${t}: bottom padding ${pad.toFixed(1)} not in 12..24`);
      if (isl.h > 340 - 16) bad.push(`${t}: island ${isl.h} > 324`);
      for (const h of await r.hit('#allow, #deny, #card-fold')) if (!h.ok) bad.push(`${t}: ${h.id} covered by ${h.got}`);
      await r.screenshot(`/tmp/bridge-fix-card-${theme}.png`);
    } finally { await r.close(); }
  }
  // other states keep their frozen size: without the card the overview is 150, a question 255 (island-nusa-shell-check PHASES)
  { const r = await H.open({ sessions: [], quick: true }); try { const [i] = await r.measure('#island'); ran++; if (Math.round(i.h) !== 150) bad.push(`overview island ${i.h} != 150`); } finally { await r.close(); } }
  { const r = await H.open({ question: 'approvalPi' }); try { const [i] = await r.measure('#island'); ran++; if (Math.round(i.h) !== 243) bad.push(`permission (question) island ${i.h} != 243`); } finally { await r.close(); } }
  { const r = await H.open({ question: 'plain' }); try { const [i] = await r.measure('#island'); ran++; if (Math.round(i.h) !== 255) bad.push(`question island ${i.h} != 255`); } finally { await r.close(); } }

  // ── (2) the stray yellow dot
  const compact = p => p.evaluate(() => window.__islandSetState('compact'));
  const SCEN = [
    ['compact question', { question: 'plain', sessions: [] }, async p => { await compact(p); await p.waitForTimeout(1500); }, true],
    ['compact bridge card', { bridgeCard: true, sessions: [], quick: true }, async p => { await p.evaluate(s => window.__emit('desktop:state', s), snap('expanded', CARD())); await p.waitForTimeout(800); await compact(p); await p.evaluate(s => window.__emit('desktop:state', s), snap('compact', CARD())); await p.waitForTimeout(1500); }, true],
    ['idle', { sessions: [], quick: true }, async p => { await compact(p); await p.waitForTimeout(1200); }, false],
    ['hidden strip', { quick: true }, async p => { await compact(p); await p.waitForTimeout(800); await p.evaluate(() => window.__islandConceal(true)); await p.waitForTimeout(1200); }, false],
    ['toast (concealed + question)', { question: 'plain', sessions: [] }, async p => { await compact(p); await p.waitForTimeout(800); await p.evaluate(() => window.__islandConceal(true)); await p.waitForTimeout(1500); }, true],
  ];
  for (const theme of ['dark', 'light']) for (const [name, sc, drive, warmDot] of SCEN) {
    const r = await H.open({ ...sc, theme }); const t = `${theme}/${name}`;
    try {
      await drive(r.page); ran++;
      const f = await flagBox(r.page); if (f.shown) bad.push(`${t}: #compact-flag visible at ${f.box}`);
      const s = await strays(r.page); if (s.length) bad.push(`${t}: stray warm element(s) outside island/toast: ${s.join(' ')}`);
      const dot = await r.page.evaluate(() => { const c = document.getElementById('capsule'); return { pill: c.style.getPropertyValue('--pill-dot'), fit: c.dataset.pillFit, aft: getComputedStyle(document.getElementById('island'), '::after').content }; });
      if (warmDot && !/sun/i.test(dot.pill)) bad.push(`${t}: pill dot is '${dot.pill}', expected the sun colour`);
      if (!theme.startsWith('x') && dot.fit === 'true' && dot.aft === 'none') bad.push(`${t}: fitted pill lost its own dot`);
      await r.screenshot(`/tmp/bridge-fix-${name.replace(/[^a-z]+/g, '-')}-${theme}.png`);
      if (theme === 'dark') console.log(`  ${t}: pill-dot='${dot.pill}' fit=${dot.fit} flag=${JSON.stringify(f)}`);
    } finally { await r.close(); }
  }
  console.log(`island heights with the bridge card: ${JSON.stringify(sizes)}; scenarios run: ${ran}`);
  if (bad.length) { console.error('FAIL island-nusa-bridge-check:\n - ' + bad.join('\n - ')); process.exit(1); }
  console.log('ok island-nusa-bridge-check');
})().catch(e => { console.error(e); process.exit(1); });

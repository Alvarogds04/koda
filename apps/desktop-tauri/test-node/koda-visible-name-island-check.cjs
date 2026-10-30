'use strict';
/* Koda 0.1 T2 (human: «Vamosa a cerrar esta version cambiar el nombre del repo por Koda…»; «Todo se llama Koda, repo nuevo desde 0.1»; «Solo lo visible»).
   The VISIBLE product name is «Koda» in the island, chat, toasts and notices. Real layout (island-geometry-harness), dark AND light.
   Scans every text node (outside script/style) + aria-label/title/placeholder/alt/data-tip/aria-description/aria-roledescription/value + document.title
   and FAILS on /abito/i, except ALLOW (exact strings that are never product copy: user/gateway data). Internal ids/classes/files stay «abito». */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED koda-visible-name-island-check: no playwright — NOT a pass'); process.exit(0); }

// Exact tokens only (removed from a string before testing it): fixture project names (user data) and the model id (comes from the user's gateway). Nothing else.
const ALLOW = new Set(['abito-web', 'abito-docs', 'Abito-gpt']);
const SCAN = allow => {
  const out = [], seen = new Set();
  const add = (kind, text) => { let t = text; for (const a of allow) t = t.split(a).join(''); if (!/abito/i.test(t)) return; const k = kind + '|' + text; if (seen.has(k)) return; seen.add(k); out.push({ kind, text: text.trim().slice(0, 100) }); };
  const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { const p = n.parentElement; if (!p || /^(SCRIPT|STYLE)$/.test(p.tagName)) continue; add('text', n.nodeValue); }
  for (const el of document.querySelectorAll('*')) for (const a of ['aria-label', 'title', 'placeholder', 'alt', 'data-tip', 'aria-description', 'aria-roledescription', 'value']) { const v = el.getAttribute(a); if (v) add('attr:' + a, v); }
  add('document.title', document.title || '');
  return out;
};
const click = async (page, sel) => { const bb = await (await page.$(sel)).boundingBox(); await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(300); };
const SCENES = [
  ['inicio', {}, async () => {}],
  ['agentes', {}, async p => click(p, '#nusa-next')],
  ['avisos', {}, async p => { await click(p, '#nusa-next'); await click(p, '#nusa-next'); }],
  ['pregunta', { question: 'plain' }, async () => {}],
  ['permiso', { question: 'approvalPi' }, async () => {}],
  ['terminó', { finishedCard: 'pi', sessions: [], quick: true }, async () => {}],
  ['puente', { bridgeCard: true, sessions: [] }, async () => {}],
  ['motor caído', { engine: 'down' }, async () => {}],
  ['sin cuenta', { engine: 'account' }, async () => {}],
  ['compacta', {}, async p => { await p.evaluate(() => window.__islandSetState('compact')); await p.waitForTimeout(900); }],
  ['toast con la isla oculta', { question: 'plain' }, async p => { await p.evaluate(() => { window.__islandSetState('compact'); document.getElementById('capsule').dataset.edgeHidden = 'true'; }); await p.waitForTimeout(900); }],
  ['recibida', { question: 'plain' }, async p => { await p.waitForTimeout(2600); await click(p, '#question-options .q-option'); await p.waitForTimeout(500); }],
  ['chat', {}, async p => {
    await p.evaluate(() => window.__islandSetView('chat', 720, 240)); await p.waitForTimeout(900);
    const input = await p.$('#chat-input'); if (input) { await input.fill('hola'); await p.keyboard.press('Enter'); await p.waitForTimeout(900); }
  }],
];
(async () => {
  const hits = new Map(); let titles = {};
  for (const theme of ['dark', 'light']) for (const [name, sc, act] of SCENES) {
    const r = await H.open({ sessions: [], ...sc, theme });
    try {
      await r.page.waitForTimeout(900); await act(r.page);
      for (const h of await r.page.evaluate(SCAN, [...ALLOW])) { const k = h.kind + '|' + h.text; hits.set(k, { ...h, where: [...(hits.get(k)?.where || []), `${name}/${theme}`] }); }
      if (name === 'inicio' && theme === 'dark') titles = await r.page.evaluate(() => ({
        doc: document.title,
        toggle: document.getElementById('island-toggle').textContent.trim(),
        text: document.body.innerText,
        field: [...document.querySelectorAll('[placeholder]')].map(e => e.getAttribute('placeholder')),
      }));
    } finally { await r.close(); }
  }
  const list = [...hits.values()];
  assert.equal(list.length, 0, `visible «Abito» left (${list.length}):\n` + list.map(h => `  ${h.kind}: «${h.text}» [${h.where.join(', ')}]`).join('\n'));
  // targeted: the main titles read «Koda»
  assert.equal(titles.doc, 'Koda', 'document.title');
  assert.equal(titles.toggle, 'Abrir Koda', 'island toggle');
  assert.match(titles.text, /Koda · en reposo/, 'Inicio sub-line «Koda · en reposo»');
  const r = await H.open({ sessions: [], theme: 'dark' });
  try {
    await r.page.waitForTimeout(700); await r.page.evaluate(() => window.__islandSetView('chat', 720, 240)); await r.page.waitForTimeout(900);
    const ph = await r.page.evaluate(() => [...document.querySelectorAll('[placeholder]')].map(e => e.getAttribute('placeholder')));
    assert.ok(ph.includes('Pedile algo a Koda… (o dictalo)'), `field placeholder: ${JSON.stringify(ph)}`);
  } finally { await r.close(); }
  console.log('koda-visible-name-island-check: ok');
})().catch(e => { console.error(e.message || e); process.exit(1); });

'use strict';
/* #357 F042/F043 — pure checks for frontend/integrations-notion.js (Notion pages list + page card).
   FAKE data only: no network, no accounts, no tokens.
   Run: node apps/desktop-tauri/test-node/integrations-notion-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const N = require(path.join(frontend, 'integrations-notion.js'));

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
};
const NOW = 1700000000000 + 6 * 3600 * 1000;
const okFrame = () => ({ type: 'notion', schema: N.SCHEMA, fake: true,
  pages: [{ id: 'a', title: 'Roadmap', snippet: 'Q4 plan', updatedAt: NOW - 5 * 60000 },
    { id: 'b', title: 'Notas', snippet: 'x', updatedAt: NOW - 3 * 3600000 }] });

test('fake provider: loud, closed shape, bounded, deterministic', () => {
  const f = N.fakeFrame();
  assert.equal(f.fake, true);
  assert.equal(f.type, 'notion');
  assert.ok(f.pages.length > 0 && f.pages.length <= N.MAX_PAGES);
  for (const p of f.pages) assert.deepEqual(Object.keys(p).sort(), ['id', 'snippet', 'title', 'updatedAt']);
  assert.deepEqual(N.fakeFrame(), f);
  assert.ok(N.storeFromFrame(f));
});

test('storeFromFrame: valid frame builds a frozen list-mode store', () => {
  const s = N.storeFromFrame(okFrame());
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.pages));
  assert.equal(s.pages.length, 2);
  assert.equal(s.selected, null);
  assert.equal(s.fake, true);
});

test('storeFromFrame: malformed frames are refused whole', () => {
  const ok = okFrame();
  const page = ok.pages[0];
  const bads = [null, [], 'x', {}, { ...ok, type: 'x' }, { ...ok, schema: 'foreign/1' }, { ...ok, fake: 1 },
    { ...ok, pages: 'x' }, { ...ok, extra: 1 },
    { ...ok, pages: [{ ...page, url: 'https://x' }] },
    { ...ok, pages: [{ ...page, id: '' }] }, { ...ok, pages: [{ ...page, id: 'A B' }] },
    { ...ok, pages: [{ ...page, title: '' }] }, { ...ok, pages: [{ ...page, title: 'x'.repeat(N.MAX_TITLE + 1) }] },
    { ...ok, pages: [{ ...page, snippet: 'x'.repeat(N.MAX_SNIPPET + 1) }] },
    { ...ok, pages: [{ ...page, updatedAt: 'now' }] }, { ...ok, pages: [{ ...page, updatedAt: NaN }] },
    { ...ok, pages: Array.from({ length: N.MAX_PAGES + 1 }, (_, i) => ({ ...page, id: `p${i}` })) }];
  for (const bad of bads) assert.equal(N.storeFromFrame(bad), null, JSON.stringify(bad));
});

test('storeFromFrame: duplicate ids resolve to the first row', () => {
  const f = okFrame();
  f.pages.push({ ...f.pages[0], title: 'Otro' });
  const s = N.storeFromFrame(f);
  assert.equal(s.pages.length, 2);
  assert.equal(s.pages[0].title, 'Roadmap');
});

test('select/back: pure navigation; unknown ids leave the store untouched', () => {
  const s = N.storeFromFrame(okFrame());
  const sel = N.select(s, 'b');
  assert.equal(sel.selected, 'b');
  assert.equal(s.selected, null, 'the old store is never mutated');
  assert.equal(N.back(sel).selected, null);
  for (const bad of ['nope', '', null, 7, '__proto__', 'constructor']) assert.equal(N.select(s, bad), null, String(bad));
  assert.equal(N.select(null, 'a'), null);
  assert.equal(N.back(s), null, 'nothing to go back from the list');
});

test('view: list mode lists pages in order with Spanish relative ages and a loud banner', () => {
  const v = N.view(N.storeFromFrame(okFrame()), NOW);
  assert.equal(v.mode, 'list');
  assert.equal(v.card, null);
  assert.deepEqual(v.rows.map(r => r.id), ['a', 'b']);
  assert.equal(v.rows[0].updatedLabel, 'hace 5 min');
  assert.equal(v.rows[1].updatedLabel, 'hace 3 h');
  assert.match(v.banner, /datos de ejemplo/i);
  assert.equal(v.count, 2);
});

test('view: card mode carries the page; a real frame has no banner; bad input yields null', () => {
  const s = N.select(N.storeFromFrame(okFrame()), 'a');
  const v = N.view(s, NOW);
  assert.equal(v.mode, 'card');
  assert.equal(v.card.title, 'Roadmap');
  assert.equal(v.card.snippet, 'Q4 plan');
  assert.equal(N.view(N.storeFromFrame({ ...okFrame(), fake: false }), NOW).banner, null);
  assert.equal(N.view(null, NOW), null);
  assert.equal(N.view(s, 'now'), null);
});

test('ageLabel: closed Spanish buckets, future and junk are honest', () => {
  assert.equal(N.ageLabel(30000), 'hace un momento');
  assert.equal(N.ageLabel(2 * 86400000), 'hace 2 d');
  assert.equal(N.ageLabel(-5), 'hace un momento');
  assert.equal(N.ageLabel('x'), null);
});

test('hygiene: frozen API, textContent only, no network, no credentials, guarded trusted mount', () => {
  assert.ok(Object.isFrozen(N));
  const src = fs.readFileSync(path.join(frontend, 'integrations-notion.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|window\.open/);
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|WebSocket|localStorage/);
  assert.doesNotMatch(src, /(api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{8,}/i);
  assert.match(src, /Datos de ejemplo/);
  assert.match(src, /getElementById\('integrations-notion'\)/);
  assert.match(src, /if \(!host\) return/);
  assert.match(src, /e\.isTrusted !== true/);
});

test('render: textContent only; list rows and card are keyboard buttons (browser only)', () => {
  if (typeof document === 'undefined') return;
  const host = document.createElement('div');
  N.render(host, N.view(N.storeFromFrame(okFrame()), NOW));
  assert.ok(host.querySelector('.intn-fake').textContent.includes('datos de ejemplo'));
  const rows = [...host.querySelectorAll('button[data-action="select"]')];
  assert.deepEqual(rows.map(b => b.dataset.id), ['a', 'b']);
  N.render(host, N.view(N.select(N.storeFromFrame(okFrame()), 'a'), NOW));
  assert.ok(host.querySelector('[data-action="back"]'));
  N.render(host, null);
  assert.equal(host.hidden, true);
});

console.log(`integrations-notion-check: ${passed} checks ok`);

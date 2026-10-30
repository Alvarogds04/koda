'use strict';
/* #353 F037 — pure checks for frontend/integrations-github.js (GitHub service card:
   own PRs, reviews, CI state, activity grid with per-day detail). No DOM, no network,
   no accounts: FAKE data only, fed by the #352 store.
   Run: node apps/desktop-tauri/test-node/integrations-github-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const V = require(path.join(frontend, 'integrations-view.js'));
const G = require(path.join(frontend, 'integrations-github.js'));

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
};
const NOW = Date.UTC(2026, 4, 20, 12, 0, 0);
const store = (state, enabled = true) => V.storeFromFrame({ type: 'integrations', schema: V.SCHEMA, fake: true,
  services: [{ id: 'github', enabled, state }] });

test('vocabularies are closed, frozen and Spanish', () => {
  assert.deepEqual(G.CI_STATES, ['pass', 'fail', 'pending']);
  assert.deepEqual(G.PR_STATES, ['open', 'draft', 'merged']);
  assert.equal(G.ciLabel('pass'), 'CI verde');
  assert.equal(G.ciLabel('fail'), 'CI roto');
  assert.equal(G.ciLabel('pending'), 'CI en curso');
  assert.equal(G.prLabel('draft'), 'borrador');
  for (const bad of ['', 'ok', null, undefined, 'constructor', '__proto__']) {
    assert.equal(G.ciLabel(bad), null, String(bad));
    assert.equal(G.prLabel(bad), null, String(bad));
  }
  assert.ok(Object.isFrozen(G));
  assert.ok(Object.isFrozen(G.CI_STATES));
});

test('fake dataset: loud, deterministic, bounded and frozen', () => {
  const d = G.fakeDataset();
  assert.equal(d.fake, true);
  assert.equal(d.schema, G.SCHEMA);
  assert.deepEqual(G.fakeDataset(), d, 'deterministic: no randomness');
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.prs) && Object.isFrozen(d.days));
  assert.ok(d.prs.length > 0 && d.prs.length <= G.MAX_PRS);
  assert.ok(d.reviews.length > 0 && d.reviews.length <= G.MAX_REVIEWS);
  assert.equal(d.days.length, G.GRID_DAYS);
  assert.equal(G.isDataset(d), true);
  for (const pr of d.prs) {
    assert.ok(G.PR_STATES.includes(pr.state), pr.state);
    assert.ok(G.CI_STATES.includes(pr.ci), pr.ci);
  }
  assert.doesNotMatch(JSON.stringify(d), /https?:|@|token|secret/i, 'no URLs, accounts or credentials');
});

test('isDataset refuses anything off-shape', () => {
  const d = G.fakeDataset();
  for (const bad of [null, {}, [], 'x', { ...d, fake: 'yes' }, { ...d, schema: 'x/1' },
    { ...d, prs: 'x' }, { ...d, days: d.days.slice(1) },
    { ...d, prs: [{ ...d.prs[0], ci: 'green' }] },
    { ...d, prs: [{ ...d.prs[0], state: 'closed' }] },
    { ...d, days: d.days.map((x, i) => (i === 0 ? { ...x, commits: -1 } : x)) },
    { ...d, prs: Array.from({ length: G.MAX_PRS + 1 }, () => d.prs[0]) },
    { ...d, extra: 1 }]) {
    assert.equal(G.isDataset(bad), false, JSON.stringify(bad).slice(0, 60));
  }
});

test('view: only an enabled, connected GitHub row feeds the card', () => {
  const d = G.fakeDataset();
  assert.ok(G.view(store('connected'), d, NOW));
  for (const s of [store('disconnected'), store('error'), store('paused'), store('connected', false), V.createStore()]) {
    assert.equal(G.view(s, d, NOW), null);
  }
  assert.equal(G.view(null, d, NOW), null);
  assert.equal(G.view(store('connected'), null, NOW), null);
  assert.equal(G.view(store('connected'), d, 'now'), null);
});

test('view: PRs, review queue and CI summary are honest and carry the loud banner', () => {
  const d = G.fakeDataset();
  const v = G.view(store('connected'), d, NOW);
  assert.equal(v.fake, true);
  assert.match(v.banner, /datos de ejemplo/i);
  assert.equal(v.prs.length, d.prs.length);
  assert.equal(v.prs[0].ciLabel, G.ciLabel(d.prs[0].ci));
  assert.equal(v.prs[0].stateLabel, G.prLabel(d.prs[0].state));
  assert.equal(v.reviews.length, d.reviews.length);
  const total = d.prs.filter(p => p.state !== 'merged').length;
  assert.equal(v.ci.pass + v.ci.fail + v.ci.pending, total, 'CI counters cover open+draft PRs only');
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.prs));
});

test('view: the activity grid has 35 days ending today, ISO dates, levels 0..4', () => {
  const v = G.view(store('connected'), G.fakeDataset(), NOW);
  assert.equal(v.grid.days.length, G.GRID_DAYS);
  assert.equal(v.grid.days[G.GRID_DAYS - 1].date, '2026-05-20');
  assert.equal(v.grid.days[0].date, '2026-04-16');
  for (const [i, day] of v.grid.days.entries()) {
    assert.equal(day.index, i);
    assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isInteger(day.count) && day.count >= 0);
    assert.ok([0, 1, 2, 3, 4].includes(day.level));
  }
  assert.equal(v.grid.total, v.grid.days.reduce((n, x) => n + x.count, 0));
});

test('day detail: per-day breakdown, refuses bad indexes, selection rides in the view', () => {
  const d = G.fakeDataset();
  const detail = G.dayDetail(d, 3, NOW);
  assert.equal(detail.date, '2026-04-19');
  assert.equal(detail.count, d.days[3].commits + d.days[3].prs + d.days[3].reviews);
  assert.deepEqual(detail.items.map(i => i.kind), ['commits', 'prs', 'reviews']);
  assert.match(detail.label, /contribuci/);
  for (const bad of [-1, G.GRID_DAYS, 1.5, '3', null, undefined, NaN]) {
    assert.equal(G.dayDetail(d, bad, NOW), null, String(bad));
  }
  assert.equal(G.dayDetail(null, 3, NOW), null);
  assert.equal(G.dayDetail(d, 3, 'now'), null);
  const v = G.view(store('connected'), d, NOW, 3);
  assert.equal(v.detail.date, '2026-04-19');
  assert.equal(G.view(store('connected'), d, NOW).detail, null, 'no selection, no detail');
  assert.equal(G.view(store('connected'), d, NOW, 99).detail, null, 'bad selection never shows detail');
});

test('module hygiene: textContent only, no network, no window.open, no credentials', () => {
  const src = fs.readFileSync(path.join(frontend, 'integrations-github.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|window\.open|EventSource/);
  assert.doesNotMatch(src, /(api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{8,}/i);
  assert.match(src, /Datos de ejemplo/, 'the loud marker lives in the module');
  assert.match(src, /getElementById\('integrations-github'\)/, 'mount contract container');
  assert.match(src, /if \(!host\) return/, 'inert until wired');
  assert.match(src, /e\.isTrusted !== true/, 'synthetic clicks never change anything');
});

test('render: builds PRs, reviews, CI and the keyboard-reachable grid (browser only)', () => {
  if (typeof document === 'undefined') return;
  const host = document.createElement('div');
  G.render(host, G.view(store('connected'), G.fakeDataset(), NOW, 3));
  assert.ok(host.querySelector('.ig-fake').textContent.includes('Datos de ejemplo'));
  const cells = [...host.querySelectorAll('button[data-action="day"]')];
  assert.equal(cells.length, G.GRID_DAYS);
  for (const c of cells) assert.ok(c.getAttribute('aria-label'));
  assert.ok(host.querySelector('.ig-detail'));
  G.render(host, null);
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
});

console.log(`integrations-github-check: ${passed} checks ok`);

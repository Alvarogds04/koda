'use strict';
/* #354 F038/F039 — pure checks for frontend/integrations-deployments.js (Deployments
   service card: status, list, detail). No DOM, no network, no accounts: FAKE data
   only, fed by the #352 store.
   Run: node apps/desktop-tauri/test-node/integrations-deployments-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const V = require(path.join(frontend, 'integrations-view.js'));
const D = require(path.join(frontend, 'integrations-deployments.js'));

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
};
const NOW = Date.UTC(2026, 4, 20, 12, 0, 0);
const store = (state, enabled = true) => V.storeFromFrame({ type: 'integrations', schema: V.SCHEMA, fake: true,
  services: [{ id: 'deployments', enabled, state }] });

test('vocabularies are closed, frozen and Spanish', () => {
  assert.deepEqual(D.STATUSES, ['queued', 'building', 'ready', 'error']);
  assert.deepEqual(D.ENVS, ['production', 'preview']);
  assert.equal(D.statusLabel('queued'), 'en cola');
  assert.equal(D.statusLabel('building'), 'construyendo');
  assert.equal(D.statusLabel('ready'), 'listo');
  assert.equal(D.statusLabel('error'), 'con error');
  assert.equal(D.envLabel('production'), 'producción');
  assert.equal(D.envLabel('preview'), 'vista previa');
  for (const bad of ['', 'ok', 'READY', null, undefined, 'constructor', '__proto__']) {
    assert.equal(D.statusLabel(bad), null, String(bad));
    assert.equal(D.envLabel(bad), null, String(bad));
  }
  assert.ok(Object.isFrozen(D) && Object.isFrozen(D.STATUSES));
});

test('fake dataset: loud, deterministic, bounded, frozen, no URLs or credentials', () => {
  const d = D.fakeDataset();
  assert.equal(d.fake, true);
  assert.equal(d.schema, D.SCHEMA);
  assert.deepEqual(D.fakeDataset(), d, 'deterministic: no randomness');
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.items));
  assert.ok(d.items.length > 0 && d.items.length <= D.MAX_ITEMS);
  assert.equal(new Set(d.items.map(i => i.id)).size, d.items.length, 'unique ids');
  assert.equal(D.isDataset(d), true);
  assert.ok(new Set(d.items.map(i => i.status)).size >= 3, 'the sample shows several statuses');
  assert.doesNotMatch(JSON.stringify(d), /https?:|@|token|secret/i);
});

test('isDataset refuses anything off-shape', () => {
  const d = D.fakeDataset();
  const it = d.items[0];
  for (const bad of [null, {}, [], 'x', { ...d, fake: 'yes' }, { ...d, schema: 'x/1' }, { ...d, items: 'x' },
    { ...d, items: [{ ...it, status: 'done' }] }, { ...d, items: [{ ...it, env: 'staging' }] },
    { ...d, items: [{ ...it, sha: 'zzzzzzz' }] }, { ...d, items: [{ ...it, durationSec: -1 }] },
    { ...d, items: [{ ...it, url: 'https://x' }] }, { ...d, items: [it, it] },
    { ...d, items: Array.from({ length: D.MAX_ITEMS + 1 }, (_, i) => ({ ...it, id: `dpl-${i}` })) },
    { ...d, extra: 1 }]) {
    assert.equal(D.isDataset(bad), false, JSON.stringify(bad).slice(0, 60));
  }
});

test('view: only an enabled, connected Deployments row feeds the card', () => {
  const d = D.fakeDataset();
  assert.ok(D.view(store('connected'), d, NOW));
  for (const s of [store('disconnected'), store('error'), store('paused'), store('connected', false), V.createStore()]) {
    assert.equal(D.view(s, d, NOW), null);
  }
  assert.equal(D.view(null, d, NOW), null);
  assert.equal(D.view(store('connected'), null, NOW), null);
  assert.equal(D.view(store('connected'), d, 'now'), null);
});

test('view: status summary, list and loud banner are honest', () => {
  const d = D.fakeDataset();
  const v = D.view(store('connected'), d, NOW);
  assert.equal(v.fake, true);
  assert.match(v.banner, /datos de ejemplo/i);
  assert.equal(v.items.length, d.items.length);
  const sum = v.counts.queued + v.counts.building + v.counts.ready + v.counts.error;
  assert.equal(sum, d.items.length, 'counters cover every deployment');
  assert.equal(v.items[0].id, d.items[0].id);
  assert.equal(v.items[0].statusLabel, D.statusLabel(d.items[0].status));
  assert.equal(v.items[0].envLabel, D.envLabel(d.items[0].env));
  assert.match(v.items[0].ageLabel, /^hace /);
  assert.ok(['queued', 'building', 'ready', 'error'].includes(v.headline.status));
  assert.equal(v.headline.statusLabel, D.statusLabel(v.headline.status));
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.items) && Object.isFrozen(v.counts));
});

test('detail: one deployment in full; unknown ids and bad input are refused', () => {
  const d = D.fakeDataset();
  const it = d.items[1];
  const det = D.detail(d, it.id);
  assert.equal(det.id, it.id);
  assert.equal(det.project, it.project);
  assert.equal(det.branch, it.branch);
  assert.equal(det.sha, it.sha);
  assert.equal(det.statusLabel, D.statusLabel(it.status));
  assert.match(det.durationLabel, /\d/);
  for (const bad of ['nope', '', null, undefined, 3, 'constructor', '__proto__']) {
    assert.equal(D.detail(d, bad), null, String(bad));
  }
  assert.equal(D.detail(null, it.id), null);
  assert.equal(D.view(store('connected'), d, NOW, it.id).detail.id, it.id, 'selection rides in the view');
  assert.equal(D.view(store('connected'), d, NOW).detail, null, 'no selection, no detail');
  assert.equal(D.view(store('connected'), d, NOW, 'nope').detail, null, 'bad selection never shows detail');
});

test('module hygiene: textContent only, no network, no window.open, no credentials', () => {
  const src = fs.readFileSync(path.join(frontend, 'integrations-deployments.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|window\.open|EventSource/);
  assert.doesNotMatch(src, /(api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{8,}/i);
  assert.match(src, /Datos de ejemplo/, 'the loud marker lives in the module');
  assert.match(src, /getElementById\('integrations-deployments'\)/, 'mount contract container');
  assert.match(src, /if \(!host\) return/, 'inert until wired');
  assert.match(src, /e\.isTrusted !== true/, 'synthetic clicks never change anything');
});

test('render: status, keyboard-reachable list and detail (browser only)', () => {
  if (typeof document === 'undefined') return;
  const host = document.createElement('div');
  const d = D.fakeDataset();
  D.render(host, D.view(store('connected'), d, NOW, d.items[0].id));
  assert.ok(host.querySelector('.id-fake').textContent.includes('Datos de ejemplo'));
  const rows = [...host.querySelectorAll('button[data-action="select"]')];
  assert.equal(rows.length, d.items.length);
  assert.ok(host.querySelector('.id-detail'));
  D.render(host, null);
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
});

console.log(`integrations-deployments-check: ${passed} checks ok`);

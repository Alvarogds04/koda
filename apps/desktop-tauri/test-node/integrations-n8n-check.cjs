'use strict';
/* #358 F044 — pure checks for frontend/integrations-n8n.js (n8n workflow runs, run detail, open-instance
   action from a closed allowlist). FAKE data only: no network, no accounts, no tokens.
   Run: node apps/desktop-tauri/test-node/integrations-n8n-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const N = require(path.join(frontend, 'integrations-n8n.js'));

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
};
const NOW = 1700000000000;
const run = (o = {}) => ({ id: 'r1', workflow: 'Alta de clientes', status: 'success', startedAt: NOW - 120000, durationMs: 2400, message: '', ...o });
const okFrame = (o = {}) => ({ type: 'n8n', schema: N.SCHEMA, fake: true, state: 'connected',
  runs: [run(), run({ id: 'r2', workflow: 'Backup', status: 'error', durationMs: 65000, message: 'Timeout en el nodo HTTP' })], ...o });

test('closed vocabularies in Spanish', () => {
  assert.deepEqual(N.STATUSES, ['success', 'error', 'running', 'waiting']);
  assert.deepEqual(N.STATUSES.map(N.statusLabel), ['correcta', 'con error', 'en curso', 'en espera']);
  assert.equal(N.statusLabel('nope'), null);
  assert.deepEqual(N.STATES, ['disconnected', 'connected', 'error']);
});

test('fake provider: loud, closed shape, bounded, deterministic', () => {
  const f = N.fakeFrame();
  assert.equal(f.fake, true);
  assert.ok(f.runs.length > 0 && f.runs.length <= N.MAX_RUNS);
  for (const r of f.runs) assert.deepEqual(Object.keys(r).sort(), ['durationMs', 'id', 'message', 'startedAt', 'status', 'workflow']);
  assert.deepEqual(N.fakeFrame(), f);
  assert.ok(N.storeFromFrame(f));
});

test('storeFromFrame: valid frame builds a frozen list-mode store', () => {
  const s = N.storeFromFrame(okFrame());
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.runs));
  assert.equal(s.runs.length, 2);
  assert.equal(s.selected, null);
  assert.equal(s.state, 'connected');
});

test('storeFromFrame: malformed frames are refused whole', () => {
  const ok = okFrame();
  const r = run();
  const bads = [null, [], 'x', {}, { ...ok, type: 'x' }, { ...ok, schema: 'foreign/1' }, { ...ok, fake: 'yes' },
    { ...ok, state: 'on' }, { ...ok, runs: 'x' }, { ...ok, extra: 1 }, { ...ok, url: 'https://evil.example' },
    { ...ok, runs: [{ ...r, url: 'https://x' }] },
    { ...ok, runs: [{ ...r, id: 'A B' }] }, { ...ok, runs: [{ ...r, workflow: '' }] },
    { ...ok, runs: [{ ...r, workflow: 'x'.repeat(N.MAX_WORKFLOW + 1) }] },
    { ...ok, runs: [{ ...r, status: 'ok' }] }, { ...ok, runs: [{ ...r, startedAt: 'now' }] },
    { ...ok, runs: [{ ...r, durationMs: -1 }] }, { ...ok, runs: [{ ...r, durationMs: NaN }] },
    { ...ok, runs: [{ ...r, message: 'x'.repeat(N.MAX_MESSAGE + 1) }] },
    { ...ok, runs: Array.from({ length: N.MAX_RUNS + 1 }, (_, i) => ({ ...r, id: `r${i}` })) }];
  for (const bad of bads) assert.equal(N.storeFromFrame(bad), null, JSON.stringify(bad));
});

test('select/back: pure navigation; unknown ids leave the store untouched', () => {
  const s = N.storeFromFrame(okFrame());
  const sel = N.select(s, 'r2');
  assert.equal(sel.selected, 'r2');
  assert.equal(s.selected, null);
  assert.equal(N.back(sel).selected, null);
  for (const bad of ['nope', '', null, 3, '__proto__']) assert.equal(N.select(s, bad), null, String(bad));
  assert.equal(N.back(s), null);
  assert.equal(N.select(null, 'r1'), null);
});

test('view: run list in order with Spanish status, age and duration; loud banner', () => {
  const v = N.view(N.storeFromFrame(okFrame()), NOW);
  assert.equal(v.mode, 'list');
  assert.deepEqual(v.rows.map(r => r.id), ['r1', 'r2']);
  assert.equal(v.rows[0].statusLabel, 'correcta');
  assert.equal(v.rows[1].statusLabel, 'con error');
  assert.equal(v.rows[0].startedLabel, 'hace 2 min');
  assert.equal(v.rows[0].durationLabel, '2 s');
  assert.equal(v.rows[1].durationLabel, '1 min 5 s');
  assert.match(v.banner, /datos de ejemplo/i);
  assert.equal(N.view(N.storeFromFrame(okFrame({ fake: false })), NOW).banner, null);
});

test('view: run detail carries the failure message; bad input yields null', () => {
  const v = N.view(N.select(N.storeFromFrame(okFrame()), 'r2'), NOW);
  assert.equal(v.mode, 'detail');
  assert.equal(v.detail.workflow, 'Backup');
  assert.equal(v.detail.message, 'Timeout en el nodo HTTP');
  assert.equal(N.view(null, NOW), null);
  assert.equal(N.view(N.storeFromFrame(okFrame()), 'now'), null);
});

test('duration label: closed formats', () => {
  assert.equal(N.durationLabel(400), '0 s');
  assert.equal(N.durationLabel(3600000), '1 h 0 min');
  assert.equal(N.durationLabel(-1), null);
  assert.equal(N.durationLabel('x'), null);
});

test('open-instance: closed allowlist satisfying the host open_chat_url rules; only when connected', () => {
  assert.ok(Object.isFrozen(N.ALLOWLIST));
  assert.deepEqual(Object.keys(N.ALLOWLIST), ['instance']);
  const raw = N.ALLOWLIST.instance;
  assert.ok(raw.length > 0 && raw.length <= 2000);
  assert.doesNotMatch(raw, /[\s\u0000-\u001f\u007f-\u009f]/);
  const url = new URL(raw);
  assert.ok(['http:', 'https:'].includes(url.protocol));
  assert.ok(url.hostname.length > 0);
  assert.equal(url.username + url.password, '');
  assert.equal(N.openTarget(N.storeFromFrame(okFrame())), raw);
  for (const state of ['disconnected', 'error']) assert.equal(N.openTarget(N.storeFromFrame(okFrame({ state }))), null, state);
  assert.equal(N.openTarget(null), null);
  assert.equal(N.openTarget({}), null);
  assert.equal(N.view(N.storeFromFrame(okFrame()), NOW).canOpen, true);
  assert.equal(N.view(N.storeFromFrame(okFrame({ state: 'error' })), NOW).canOpen, false);
});

test('hygiene: frozen API, textContent only, no network, no window.open, guarded trusted mount via open_chat_url', () => {
  assert.ok(Object.isFrozen(N));
  const src = fs.readFileSync(path.join(frontend, 'integrations-n8n.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|window\.open/);
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|WebSocket|localStorage/);
  assert.doesNotMatch(src, /(api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{8,}/i);
  assert.match(src, /Datos de ejemplo/);
  assert.match(src, /getElementById\('integrations-n8n'\)/);
  assert.match(src, /if \(!host\) return/);
  assert.match(src, /e\.isTrusted !== true/);
  assert.match(src, /open_chat_url/);
});

test('render: rows and detail are keyboard buttons; Abrir only when allowed (browser only)', () => {
  if (typeof document === 'undefined') return;
  const host = document.createElement('div');
  N.render(host, N.view(N.storeFromFrame(okFrame()), NOW));
  assert.ok(host.querySelector('.intw-fake').textContent.includes('datos de ejemplo'));
  assert.deepEqual([...host.querySelectorAll('button[data-action="select"]')].map(b => b.dataset.id), ['r1', 'r2']);
  assert.ok(host.querySelector('[data-action="open"]'));
  N.render(host, N.view(N.storeFromFrame(okFrame({ state: 'error' })), NOW));
  assert.equal(host.querySelector('[data-action="open"]'), null);
  N.render(host, N.view(N.select(N.storeFromFrame(okFrame()), 'r2'), NOW));
  assert.ok(host.querySelector('[data-action="back"]'));
  N.render(host, null);
  assert.equal(host.hidden, true);
});

console.log(`integrations-n8n-check: ${passed} checks ok`);

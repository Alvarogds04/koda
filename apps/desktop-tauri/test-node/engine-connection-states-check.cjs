'use strict';
/* K3-09 M5c (U1): the visible connection states of the engine — absent, reconnecting with a countdown, restarting,
   stopped — and the «Reintentar» action. Pure view-model checks (settings-view connectionView / retryView, overview-view
   engineRowView); the keeper that produces `retry_in` is tested in src/agentkeeper.rs.
   Run: node apps/desktop-tauri/test-node/engine-connection-states-check.cjs */
const assert = require('node:assert/strict');
const S = require('../frontend/settings-view.js');
const O = require('../frontend/overview-view.js');
let passed = 0;
const test = (name, fn) => { try { fn(); passed += 1; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };

test('engine absent: «Sin motor», says jesscore plainly, shows the automatic retry and offers «Reintentar»', () => {
  const v = S.connectionView({ connection: 'no_daemon', retry_in: 8 });
  assert.equal(v.word, 'Sin motor');
  assert.match(v.aria, /jesscore/);
  assert.match(v.aria, /Reintento automático en 8 s/);
  assert.doesNotMatch(v.aria, /Node/);
  assert.deepEqual(v.retry, { label: 'Reintentar', aria: 'Reintentar la conexión con el motor ahora' });
  // without a schedule (the very first read) there is no countdown sentence, and still the same word and action
  const first = S.connectionView({ connection: 'no_daemon' });
  assert.equal(first.word, 'Sin motor');
  assert.doesNotMatch(first.aria, /Reintento automático/);
  assert.equal(first.retry.label, 'Reintentar');
});

test('reconnecting after a loss: «Reconectando…» with the countdown in whole seconds, a live tone, «Reintentar»', () => {
  const v = S.connectionView({ connection: 'lost', retry_in: 3 });
  assert.equal(v.word, 'Reconectando… 3 s');
  assert.deepEqual([v.icon, v.tone], ['ring', 'live']);
  assert.equal(v.aria, 'Reconectando… 3 s: Se perdió la conexión con el motor; reintento automático en 3 s.');
  assert.equal(v.retry.label, 'Reintentar');
  // a loss before the keeper scheduled anything keeps the honest red word
  const unscheduled = S.connectionView({ connection: 'lost' });
  assert.equal(unscheduled.word, 'Motor caído');
  assert.equal(unscheduled.tone, 'red');
  assert.equal(unscheduled.retry.label, 'Reintentar');
  // a countdown that is not a plain count never reaches the screen
  for (const bad of [-1, 1.5, '3', NaN, Infinity, 99999, null]) assert.equal(S.connectionView({ connection: 'lost', retry_in: bad }).word, 'Motor caído', String(bad));
});

test('restarting is its own word, a wait without «Reintentar»; starting keeps «Arrancando…»', () => {
  const r = S.connectionView({ connection: 'connected', engine: 'restarting' });
  assert.equal(r.word, 'Reiniciando…');
  assert.equal(r.aria, 'Reiniciando…: El motor se está reiniciando…');
  assert.deepEqual([r.icon, r.tone], ['ring', 'live']);
  assert.equal(r.retry, undefined, 'a restart in progress is not retried by hand');
  assert.equal(r.starting, true, 'the vendor banner keeps its quiet look');
  const s = S.connectionView({ connection: 'connected', engine: 'starting' });
  assert.equal(s.word, 'Arrancando…');
  assert.equal(s.retry, undefined);
});

test('stopped: a connected daemon whose engine stopped or is unavailable says «Motor detenido» and offers «Reintentar»', () => {
  for (const engine of ['stopped', 'unavailable']) {
    const v = S.connectionView({ connection: 'connected', engine });
    assert.equal(v.word, 'Motor detenido', engine);
    assert.equal(v.tone, 'red', engine);
    assert.equal(v.aria, 'Motor detenido: El motor se detuvo; probá reintentar.', engine);
    assert.equal(v.retry.label, 'Reintentar', engine);
  }
  for (const engine of ['ready', null, undefined, 'nope']) assert.equal(S.connectionView({ connection: 'connected', engine }), null, String(engine));
});

test('the install problems keep their own words and get no retry (a retry cannot fix them)', () => {
  for (const code of ['node_missing', 'pi_missing', 'bundled_runtime_invalid']) {
    const v = S.connectionView({ connection: 'no_daemon', last_error: { code, n: 1 }, retry_in: 5 });
    assert.notEqual(v.word, 'Sin motor', code);
    assert.equal(v.retry, undefined, code);
  }
});

test('retryView: the page action is the closed `refresh` of the agent connection, and nothing else', () => {
  assert.deepEqual(S.retryPayload(), { action: 'refresh' });
});

test('island row: a lost engine with a countdown reads «Reconectando…» and still points to Ajustes → Motor', () => {
  const row = O.engineRowView({ kind: 'down' }, { connection: 'lost', retry_in: 2 });
  assert.equal(row.label, 'Reconectando…');
  assert.equal(row.target, 'accounts:motor');
  assert.equal(O.engineRowView({ kind: 'down' }, { connection: 'lost' }).label, 'Motor caído');
  assert.equal(O.engineRowView({ kind: 'down' }, { connection: 'no_daemon', retry_in: 2 }).label, 'Sin motor');
});

console.log(`engine-connection-states-check: ${passed} passed`);

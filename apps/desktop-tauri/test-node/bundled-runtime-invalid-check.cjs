'use strict';
/* K2-02 D1 (human decision «2a»): a broken bundled runtime (code bundled_runtime_invalid) shows its own word and the
   exact sentence in the same place «Falta el motor de Koda…» and «Falta Node.js…» appear, on Linux, macOS and Windows
   alike: Ajustes (settings-view connectionView). The node_missing / no_daemon views are unchanged; K2-05 (S1, S4)
   reworded pi_missing to Koda's own bundled engine with the daemon host's incomplete-install sentence, no npm advice.
   Run: node apps/desktop-tauri/test-node/bundled-runtime-invalid-check.cjs */
const assert = require('node:assert/strict');
const S = require('../frontend/settings-view.js');
const O = require('../frontend/overview-view.js');

const SENTENCE = 'La instalación de Koda está dañada: volvé a instalar Koda.';
const state = (code) => ({ connection: 'no_daemon', last_error: { code, n: 1 } });
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
};

test('Ajustes: bundled_runtime_invalid reads «Instalación dañada» with the exact reinstall sentence, no install advice', () => {
  assert.deepEqual(S.connectionView(state('bundled_runtime_invalid')),
    { kind: 'no_daemon', word: 'Instalación dañada', icon: 'plug-off', tone: 'faint', aria: `Instalación dañada: ${SENTENCE}` });
});
test('Ajustes: node_missing, pi_missing (Koda\'s own engine, no npm advice) and a plain no_daemon keep their own words', () => {
  assert.deepEqual(S.connectionView(state('node_missing')),
    { kind: 'no_daemon', word: 'Falta Node.js', icon: 'plug-off', tone: 'faint', aria: 'Falta Node.js: instalalo desde nodejs.org.' });
  assert.deepEqual(S.connectionView(state('pi_missing')),
    { kind: 'no_daemon', word: 'Falta el motor de Koda', icon: 'plug-off', tone: 'faint', aria: 'Falta el motor de Koda: La instalación de Koda está incompleta: falta el motor propio de Koda; volvé a instalar Koda.' });
  assert.equal(S.connectionView(state(null)).word, 'Sin motor');
  assert.equal(S.connectionView({ connection: 'lost', last_error: { code: 'bundled_runtime_invalid' } }).word, 'Motor caído', 'only a no_daemon start failure is a broken install');
  assert.equal(S.connectionView({ connection: 'connected', last_error: { code: 'bundled_runtime_invalid' } }), null);
});
test('island row: bundled_runtime_invalid mirrors «Falta Node.js» — label «Instalación dañada», the sentence, the generic «Revisar» link to Ajustes → Motor', () => {
  const row = O.engineRowView({ kind: 'down' }, state('bundled_runtime_invalid'));
  assert.deepEqual(row, { kind: 'engine', label: 'Instalación dañada', link: 'Revisar', target: 'accounts:motor',
    aria: `Instalación dañada: ${SENTENCE} Revisar: abrir Ajustes → Motor` });
});
test('island row: node_missing, pi_missing (Koda\'s own engine) and a plain no_daemon keep their own words', () => {
  assert.deepEqual(O.engineRowView({ kind: 'down' }, state('node_missing')), { kind: 'engine', label: 'Falta Node.js', link: 'Revisar', target: 'accounts:motor',
    aria: 'Falta Node.js: instalalo desde nodejs.org. Revisar: abrir Ajustes → Motor' });
  assert.equal(O.engineRowView({ kind: 'down' }, state('pi_missing')).label, 'Falta el motor de Koda');
  assert.equal(O.engineRowView({ kind: 'down' }, state(null)).label, 'Sin motor');
});
console.log(`bundled-runtime-invalid-check: ${passed} passed`);

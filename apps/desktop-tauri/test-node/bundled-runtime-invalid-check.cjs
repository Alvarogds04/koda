'use strict';
/* K2-02 D1 (human decision «2a»): a broken bundled runtime (code bundled_runtime_invalid) shows its own word and the
   exact sentence in the same place «Falta Pi…» and «Falta Node.js…» appear, on Linux, macOS and Windows alike: Ajustes
   (settings-view connectionView). The existing node_missing / pi_missing / no_daemon views are unchanged.
   Run: node apps/desktop-tauri/test-node/bundled-runtime-invalid-check.cjs */
const assert = require('node:assert/strict');
const S = require('../frontend/settings-view.js');

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
test('Ajustes: node_missing, pi_missing and a plain no_daemon are unchanged', () => {
  assert.deepEqual(S.connectionView(state('node_missing')),
    { kind: 'no_daemon', word: 'Falta Node.js', icon: 'plug-off', tone: 'faint', aria: 'Falta Node.js: instalalo desde nodejs.org.' });
  assert.deepEqual(S.connectionView(state('pi_missing')),
    { kind: 'no_daemon', word: 'Falta Pi', icon: 'plug-off', tone: 'faint', aria: 'Falta Pi: instalalo con npm install -g @earendil-works/pi-coding-agent.' });
  assert.equal(S.connectionView(state(null)).word, 'Sin motor');
  assert.equal(S.connectionView({ connection: 'lost', last_error: { code: 'bundled_runtime_invalid' } }).word, 'Motor caído', 'only a no_daemon start failure is a broken install');
  assert.equal(S.connectionView({ connection: 'connected', last_error: { code: 'bundled_runtime_invalid' } }), null);
});
console.log(`bundled-runtime-invalid-check: ${passed} passed`);

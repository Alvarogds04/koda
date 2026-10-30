'use strict';
/* HU-057 S9/N8: island size setting (S/M/L/Auto) — settings segments, closed pref wire, island applies the scale variable.
   Run: node test-node/island-nusa-size-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fe = path.join(__dirname, '..', 'frontend');
const V = require(path.join(fe, 'settings-view.js'));
const read = f => fs.readFileSync(path.join(fe, f), 'utf8');
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };

test('settings: four segments S/M/L/Auto, default Auto, foreign value reads as Auto', () => {
  assert.deepEqual(V.islandSizeSegments(undefined).map(s => s.label), ['S', 'M', 'L', 'Auto']);
  assert.deepEqual(V.islandSizeSegments(undefined).filter(s => s.selected).map(s => s.id), ['auto']);
  assert.deepEqual(V.islandSizeSegments('l').filter(s => s.selected).map(s => s.id), ['l']);
  assert.deepEqual(V.islandSizeSegments('XL').filter(s => s.selected).map(s => s.id), ['auto']);
  assert.equal(V.islandSizeProblem('xl') !== '', true);
  for (const ok of ['s', 'm', 'l', 'auto']) assert.equal(V.islandSizeProblem(ok), '');
});
test('settings.js renders the «Tamaño de la isla» control and saves through prefs_action set_island_size', () => {
  const s = read('settings.js');
  assert.match(s, /Tamaño de la isla/);
  assert.match(s, /action: 'set_island_size', island_size:/);
  assert.match(s, /islandSizeSegments\(/);
});
test('island reads the pref and applies the clamped scale variable', () => {
  const i = read('island.js');
  assert.match(i, /islandSize/);
  assert.match(i, /sizeScale\(/);
  assert.match(i, /--nusa-size/);
  assert.match(i, /availWidth/);
  const c = read('island-nusa.css');
  assert.match(c, /var\(--nusa-size/);
});
console.log(`island-nusa-size-check: ${passed} passed`);

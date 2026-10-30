'use strict';
/* HU-056/HU-057: Koda in the Nusa notch is forced to integer scale x2 on the 32 px sheet (64 px), only while #nusa is the active view. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const K = require('../frontend/koda-logic.js'), C = require('../frontend/koda-catalog.js');
let passed = 0; const test = (n, fn) => { fn(); passed += 1; };

test('nusa slot: always 32 px cell x2, even for ids that exist on the 24 px sheet and for any box size', () => {
  for (const id of Object.keys(C.CATALOG)) for (const box of [0, 20, 64]) assert.deepEqual(K.layoutFor(id, 'nusa', box), { cell: 32, k: 2 }, id);
  assert.equal(K.layoutFor('respirar', 'nusa', 64).cell * K.layoutFor('respirar', 'nusa', 64).k, 64);
});
test('nusa-big (take-over cards): largest INTEGER scale of the 32 px cell that fits the column box, never fractional, never below x2', () => {
  for (const [box, k] of [[0, 2], [63, 2], [64, 2], [95, 2], [96, 3], [104, 3], [127, 3], [128, 4], [400, 4]]) assert.deepEqual(K.layoutFor('respirar', 'nusa-big', box), { cell: 32, k }, 'box ' + box);
  for (const id of Object.keys(C.CATALOG)) assert.equal(K.layoutFor(id, 'nusa-big', 104).cell, 32, id);
});
test('other slots unchanged', () => {
  assert.deepEqual(K.layoutFor('reposo', 'small', 28), { cell: 24, k: 1 });
  assert.deepEqual(K.layoutFor('respirar', 'small', 28), { cell: 32, k: 1 });
  assert.deepEqual(K.layoutFor('respirar', 'auto', 64), { cell: 32, k: 2 });
  assert.deepEqual(K.layoutFor('respirar', 'auto', 40), { cell: 32, k: 1 });
});
test('skin source: placeMain uses the nusa slot only when #nusa is displayed, parents into #nusa-right, else restores the island path', () => {
  const s = fs.readFileSync(__dirname + '/../frontend/koda-skin.js', 'utf8');
  const pm = s.slice(s.indexOf('function placeMain'), s.indexOf('const flowAnim'));
  assert.match(pm, /getElementById\('nusa-right'\)/);
  assert.match(pm, /getElementById\('nusa'\)/);
  assert.match(pm, /pref = 'nusa'/);
  assert.match(pm, /nusa-big/);
  assert.match(pm, /dataset\.takeover/);
  assert.match(pm, /clayEl\.after\(mainSlot\.el\)/);
  assert.match(pm, /!== 'none'/);
  const css = fs.readFileSync(__dirname + '/../frontend/koda-skin.css', 'utf8');
  assert.match(css, /data-koda-slot="nusa"/);
});
console.log(`koda-nusa-check: ${passed} passed`);

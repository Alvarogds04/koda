'use strict';
// K2-09 S4/S6 (design 08): the shortcuts shell of the island — registry, icon row, focus keys. Public API only.
const assert = require('node:assert/strict');
const path = require('node:path');
const S = require(path.join(__dirname, '..', 'frontend', 'island-shortcuts.js'));
let passed = 0;
const test = (_n, fn) => { S._reset(); fn(); passed += 1; };
const card = (id, on = true, extra = {}) => ({ id, label: id.toUpperCase(), icon: id, available: () => on, mount: () => () => {}, ...extra });

test('S6: with no available app there is no row (the usual Nusa), never sample data', () => {
  assert.deepEqual(S.row(), []);
  S.registerCard(card('gmail', false)); S.registerCard(card('github', false));
  assert.deepEqual(S.row(), [], 'registered but not connected: no icon');
  assert.equal(S.rowWidth(0), 0);
});
test('S4: «Hablar con Koda» first, then the apps in design order, numbered for Ctrl+1…N', () => {
  S.registerCard(card('cal')); S.registerCard(card('spotify')); S.registerCard(card('extra')); S.registerCard(card('gmail'));
  const r = S.row();
  assert.deepEqual(r.map(it => it.id), ['koda', 'spotify', 'gmail', 'cal', 'extra']);
  assert.equal(r[0].label, 'Hablar con Koda');
  assert.deepEqual(r.map(it => it.num), [1, 2, 3, 4, 5]);
  assert.equal(S.rowWidth(5), 224, '5 × 44 + 4 (design 08 geometry)');
  assert.equal(S.rowWidth(3), 136, '3 × 44 + 4 (frame 6)');
});
test('S4: a card that throws or answers non-true is not available; badges are whole and non-negative', () => {
  S.registerCard(card('spotify', true, { badge: () => 3.7 }));
  S.registerCard({ ...card('gmail'), available: () => { throw new Error('boom'); } });
  S.registerCard({ ...card('github'), available: () => 'yes' });
  S.registerCard(card('cal', true, { badge: () => { throw new Error('boom'); } }));
  assert.deepEqual(S.row().map(it => [it.id, it.badge]), [['koda', 0], ['spotify', 3], ['cal', 0]]);
});
test('S4: registerCard refuses bad definitions and duplicates; the returned function unregisters', () => {
  for (const bad of [null, 1, {}, card('Bad Id'), card('koda'), { ...card('a'), label: ' ' }, { ...card('a'), icon: '' },
    { ...card('a'), mount: 1 }, { ...card('a'), available: true }, { ...card('a'), badge: 2 }]) assert.throws(() => S.registerCard(bad));
  const off = S.registerCard(card('spotify'));
  assert.throws(() => S.registerCard(card('spotify')), /already registered/);
  let n = 0; S.onChange(() => { n += 1; });
  off();
  assert.deepEqual(S.row(), []);
  assert.equal(n, 1, 'listeners hear the change');
});
test('focus: leaving a vanished card goes back to Koda; arrows stop at the ends', () => {
  const ids = ['koda', 'spotify', 'gmail'];
  assert.equal(S.focusAfter('github', ids), 'koda');
  assert.equal(S.focusAfter('gmail', ids), 'gmail');
  assert.equal(S.stepFocus('koda', ids, -1), 'koda');
  assert.equal(S.stepFocus('koda', ids, 1), 'spotify');
  assert.equal(S.stepFocus('gmail', ids, 1), 'gmail');
  assert.equal(S.stepFocus('nope', ids, 1), 'koda');
});
test('keys: Ctrl on Linux/Windows, Cmd on macOS; untrusted or other modifiers do nothing', () => {
  const ids = ['koda', 'spotify', 'gmail'];
  const ev = (name, mods = {}) => ({ isTrusted: true, key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(S.keyFocus(ev('2', { ctrlKey: true }), ids, 'linux'), 'spotify');
  assert.equal(S.keyFocus(ev('4', { ctrlKey: true }), ids, 'windows'), null, 'beyond the row');
  assert.equal(S.keyFocus(ev('ArrowRight', { ctrlKey: true }), ids, 'linux'), 1);
  assert.equal(S.keyFocus(ev('ArrowLeft', { metaKey: true }), ids, 'macos'), -1);
  assert.equal(S.keyFocus(ev('ArrowLeft', { ctrlKey: true }), ids, 'macos'), null, 'Ctrl+arrows switch Spaces on macOS');
  assert.equal(S.keyFocus({ ...ev('2', { ctrlKey: true }), isTrusted: false }, ids, 'linux'), null);
  assert.equal(S.keyFocus(ev('2', { ctrlKey: true, shiftKey: true }), ids, 'linux'), null);
});
console.log(`island-shortcuts-check: ${passed} checks ok`);

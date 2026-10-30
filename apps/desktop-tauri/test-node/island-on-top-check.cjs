'use strict';
// Human L56: «no veo a abito y las teclas no sirven». Live evidence: after a hide → show
// (the toggle shortcut), GNOME/Mutter remapped the island WITHOUT _NET_WM_STATE_ABOVE
// (EWMH clears the state of a withdrawn window), so it sat behind every other window:
// mapped, invisible, and the shortcut looked dead. Every path that shows the island must
// re-assert always-on-top after show(). Source-level pin: the effect is native-only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '../src/main.rs'), 'utf8');
const bare = main.split('\n').filter(l => /\bwin\.show\(\)/.test(l) && !/fn show_on_top/.test(l));
assert.deepEqual(bare.filter(l => !/\/\/ show_on_top body/.test(l)), [], 'every island show() goes through show_on_top');
const helper = main.slice(main.indexOf('fn show_on_top('));
assert.ok(main.includes('fn show_on_top('), 'show_on_top helper exists');
const body = helper.slice(0, helper.indexOf('\n}\n'));
assert.ok(body.indexOf('.show()') >= 0 && body.indexOf('set_always_on_top(true)') > body.indexOf('.show()'),
  'always-on-top is re-asserted AFTER the window is mapped again');
console.log('island-on-top-check: 2 passed');

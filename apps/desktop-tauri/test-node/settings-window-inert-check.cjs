'use strict';
/* #366 F093 — the settings window runs the SAME page, so the island's own scripts must be inert there:
   no desktop facade (zero desktop_action), no pointer/hover/timer handlers, no drag_* invoke.
   Executed in a vm with a spying IPC; label 'main' keeps the facade unchanged.
   Run: node apps/desktop-tauri/test-node/settings-window-inert-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frontend = path.join(__dirname, '..', 'frontend');
let passed = 0;
const test = (_name, fn) => { fn(); passed += 1; };

function run(file, label) {
  const calls = [], listeners = [], timers = [];
  const trap = what => new Proxy({}, { get(_t, k) { if (k === 'addEventListener') return () => listeners.push(what); throw new Error(`${what}.${String(k)} touched`); } });
  const win = {
    __TAURI_INTERNALS__: { metadata: { currentWindow: { label } }, invoke: (cmd, args) => { calls.push([cmd, args]); return Promise.resolve({}); } },
    addEventListener: () => listeners.push('window'),
  };
  const ctx = vm.createContext({
    window: win, document: label === 'settings' ? trap('document') : { getElementById: () => null, addEventListener: () => listeners.push('document') },
    setTimeout: () => timers.push('timeout'), setInterval: () => timers.push('interval'), clearTimeout() {}, matchMedia: () => trap('matchMedia'), console,
  });
  vm.runInContext(fs.readFileSync(path.join(frontend, file), 'utf8'), ctx, { filename: file });
  const plain = v => JSON.parse(JSON.stringify(v));
  return { get calls() { return plain(calls); }, listeners: plain(listeners), timers: plain(timers), win: ctx.window };
}

test('settings window: island.js registers no listener, timer or invoke (zero drag_* / desktop_action)', () => {
  const r = run('island.js', 'settings');
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.listeners, []);
  assert.deepEqual(r.timers, []);
});

test('settings window: no window.desktop facade exists, so no desktop_action verb can be sent', () => {
  const r = run('desktop.js', 'settings');
  assert.equal(r.win.desktop, undefined);
  assert.deepEqual(r.calls, []);
});

test('main window: the desktop facade is unchanged and still routes through desktop_action', () => {
  const r = run('desktop.js', 'main');
  for (const verb of ['snapshot', 'expand', 'close', 'hide', 'quit', 'dismiss', 'allow', 'deny', 'animateAnyway', 'respectSystemMotion', 'autoClose']) {
    assert.equal(typeof r.win.desktop[verb], 'function', verb);
  }
  r.win.desktop.expand();
  assert.deepEqual(r.calls, [['desktop_action', { payload: { action: 'expand' } }]]);
});

test('main window: island.js is not short-circuited (the guard is label-exact)', () => {
  const src = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(src, /__label === 'settings'\) return;/);
  assert.match(src, /const capsule = \$\('capsule'\);/);
});

test('#455 window mounts settings outside the island without duplicate placement controls', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /document\.body\.append\(panel\)/);
  assert.doesNotMatch(src, /sw-settings-window|settings-window-open/);
  assert.match(src, /Todos los ajustes.*openSettingsWindow/);
});

console.log(`settings-window-inert-check: ${passed} passed`);

'use strict';
// K2-06 B1-R1: the REAL extension.js and token.js run against fakes of the Shell and of the bus, to prove
// what the Rust tests can only assume about the fake extension: nothing is picked or captured while nobody
// is bound, a second Register is refused while a live owner holds the binding, the binding is released
// when the owner's bus name vanishes, and the bus name watches never outgrow the live owners.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const dir = path.join(__dirname, '..', 'gnome-extension', 'abito-context@abito');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

const ctx = { logError() {}, WeakRef, WeakMap, Map, Number, Math };
vm.createContext(ctx);
// token.js is pure JavaScript: the real gate, with its `export`s taken off.
vm.runInContext(read('token.js').replace(/^export /gm, '') + '\nglobalThis.TokenGate = TokenGate;', ctx);

// ---- fakes: the bus name watches, the Variant, the tracker ----
const watches = new Map(); // id -> {name, vanished}
const unwatched = [];
let nextWatch = 1;
let alreadyGone = false;
ctx.Gio = {
  _promisify() {},
  DBus: { session: 'session-bus' },
  BusNameOwnerFlags: { NONE: 0 },
  BusNameWatcherFlags: { NONE: 0 },
  DBusExportedObject: { wrapJSObject: () => ({ export() {}, unexport() {} }) },
  bus_own_name_on_connection: () => 1,
  bus_unown_name() {},
  bus_watch_name_on_connection(conn, name, flags, appeared, vanished) {
    const id = nextWatch++;
    watches.set(id, { name, vanished });
    if (alreadyGone) vanished(); // the owner left while the watch was being set up
    return id;
  },
  bus_unwatch_name(id) { assert.ok(watches.has(id), `watch ${id} exists`); watches.delete(id); unwatched.push(id); },
};
ctx.GLib = { Variant: class { constructor(sig, vals) { this.sig = sig; this.vals = vals; } }, random_int_range: (a, b) => a + Math.floor(Math.random() * (b - a)) };
const windowApp = { get_id: () => 'firefox', get_name: () => 'Firefox' };
ctx.Shell = { WindowTracker: { get_default: () => ({ get_window_app: () => windowApp }) }, Screenshot: {} };
ctx.Extension = class {};
ctx.global = { display: { connect: () => 1, disconnect() {}, focus_window: null }, get_window_actors: () => [] };
vm.runInContext(read('extension.js').replace(/^import .*;$/gm, '').replace('export default class', 'globalThis.Ext = class'), ctx);

const window = { is_skip_taskbar: () => false, get_wm_class: () => 'firefox', get_title: () => 'a page', connect: () => 1, disconnect() {} };
const fresh = () => {
  watches.clear(); unwatched.length = 0; alreadyGone = false;
  const ext = new ctx.Ext();
  ext.enable();
  ext._remember(window);
  return ext;
};
const call = (ext, method, params, sender = ':1.5') => {
  const out = { returned: null, error: null };
  ext[`${method}Async`](params, {
    get_sender: () => sender,
    return_value: (v) => { out.returned = v; },
    return_dbus_error: (name) => { out.error = name; },
  });
  return out;
};
const TOKEN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const NOT_ALLOWED = 'org.abito.Context.NotAllowed';
let spied = 0;
const spy = (ext) => { ext._captureWindow = async () => { spied++; return '/x'; }; };

// 1. Nobody is bound (enable, before Koda's first registration): every token is refused, nothing is painted.
{
  const ext = fresh(); spy(ext);
  for (const token of [TOKEN, '', undefined, 1234]) {
    assert.strictEqual(call(ext, 'PickWindow', [token]).error, NOT_ALLOWED, `unbound pick ${String(token)}`);
    assert.strictEqual(call(ext, 'CaptureWindow', [1, token]).error, NOT_ALLOWED, `unbound capture ${String(token)}`);
  }
  assert.strictEqual(spied, 0, 'no window was painted while nobody was bound');
}

// 2. Bound: the right token works, a wrong one is refused.
{
  const ext = fresh(); spy(ext);
  assert.deepStrictEqual(Array.from(call(ext, 'Register', [TOKEN]).returned.vals), [true]);
  const picked = call(ext, 'PickWindow', [TOKEN]);
  assert.strictEqual(picked.error, null);
  assert.strictEqual(picked.returned.vals[1], 'firefox');
  assert.ok(picked.returned.vals[0] > 0, 'an opaque, non-zero window id');
  assert.strictEqual(call(ext, 'PickWindow', [OTHER]).error, NOT_ALLOWED, 'wrong token, pick');
  assert.strictEqual(call(ext, 'CaptureWindow', [picked.returned.vals[0], OTHER]).error, NOT_ALLOWED, 'wrong token, capture');
  assert.strictEqual(spied, 0);
}

// 3. A second Register while a live owner holds the binding is refused, from anybody, with any token, and
//    adds no watch.
{
  const ext = fresh();
  assert.deepStrictEqual(Array.from(call(ext, 'Register', [TOKEN], ':1.5').returned.vals), [true]);
  assert.strictEqual(watches.size, 1);
  assert.deepStrictEqual(Array.from(call(ext, 'Register', [OTHER], ':1.6').returned.vals), [false], 'another caller');
  assert.deepStrictEqual(Array.from(call(ext, 'Register', [TOKEN], ':1.6').returned.vals), [false], 'the live token, from another caller');
  assert.deepStrictEqual(Array.from(call(ext, 'Register', [TOKEN], ':1.5').returned.vals), [false], 'the owner twice');
  assert.strictEqual(watches.size, 1, 'still one watch for the one live owner');
  assert.strictEqual(call(ext, 'PickWindow', [OTHER]).error, NOT_ALLOWED, 'the intruder never got in');
  assert.strictEqual(call(ext, 'PickWindow', [TOKEN]).error, null, 'the live owner still works');
}

// 4. The owner's bus name vanishing releases the binding, and its watch goes with it.
{
  const ext = fresh();
  call(ext, 'Register', [TOKEN], ':1.5');
  const [[id, watch]] = [...watches.entries()];
  assert.strictEqual(watch.name, ':1.5', 'the watch is on the owner');
  watch.vanished();
  assert.strictEqual(call(ext, 'PickWindow', [TOKEN]).error, NOT_ALLOWED, 'released: the old token is refused');
  assert.strictEqual(watches.size, 0, 'the watch was removed on release');
  assert.deepStrictEqual(unwatched, [id]);
  assert.strictEqual(ext._watches.size, 0);
  assert.deepStrictEqual(Array.from(call(ext, 'Register', [OTHER], ':1.9').returned.vals), [true], 'a new owner can bind');
  assert.strictEqual(call(ext, 'PickWindow', [OTHER]).error, null);
}

// 5. Many registrations over the extension's life never leave more than one live watch.
{
  const ext = fresh();
  for (let i = 0; i < 50; i++) {
    const owner = `:1.${100 + i}`;
    assert.deepStrictEqual(Array.from(call(ext, 'Register', [TOKEN], owner).returned.vals), [true]);
    assert.ok(ext._watches.size <= 1 && watches.size <= 1, `at most one watch (round ${i})`);
    [...watches.values()][0].vanished();
    assert.strictEqual(watches.size, 0);
    assert.strictEqual(ext._watches.size, 0);
  }
  assert.strictEqual(unwatched.length, 50, 'every watch was removed');
}

// 6. An owner that is already gone by the time the watch is set up leaves no watch and no binding.
{
  const ext = fresh();
  alreadyGone = true;
  call(ext, 'Register', [TOKEN], ':1.7');
  alreadyGone = false;
  assert.strictEqual(watches.size, 0);
  assert.strictEqual(ext._watches.size, 0);
  assert.strictEqual(call(ext, 'PickWindow', [TOKEN]).error, NOT_ALLOWED);
}

// 7. disable() removes the live watch and forgets the binding.
{
  const ext = fresh();
  call(ext, 'Register', [TOKEN], ':1.5');
  ext.disable();
  assert.strictEqual(watches.size, 0, 'disable removed the live watch');
}
console.log('context-extension-gate-check ok (7 scenarios)');

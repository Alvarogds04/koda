'use strict';
// #486: island side of the desktop character: the host adapter, and the island.js drag hook.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const read = f => fs.readFileSync(path.join(frontend, f), 'utf8');
const D = require('../frontend/island-desktop.js');

function fakes({ info = { mode: 'window', onDesktop: false } } = {}) {
  const calls = [], handlers = {};
  const invoke = async (cmd, args) => { calls.push([cmd, args]); return cmd === 'character_info' ? info : cmd === 'character_pick_up' ? true : true; };
  const listen = async (name, fn) => { handlers[name] = fn; return () => {}; };
  const clayEl = { style: {} };
  const timers = [];
  const d = D.create({ invoke, listen, clayEl, getClayState: () => 'idle', setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => {}, reveal: () => calls.push(['reveal']) });
  return { d, calls, handlers, clayEl, timers };
}

test('unavailable without a host: the island keeps moving as today', async () => {
  const d = D.create({ invoke: null, listen: null, clayEl: { style: {} }, getClayState: () => 'idle', setTimer() {}, clearTimer() {} });
  await d.init();
  assert.equal(d.canPickUp(), false);
});

test('unavailable when the host answers nothing', async () => {
  const f = fakes({ info: null });
  await f.d.init();
  assert.equal(f.d.canPickUp(), false);
});

test('available once the host answers: a pick-up carries, then the drop installs it', async () => {
  const f = fakes();
  await f.d.init();
  assert.equal(f.d.canPickUp(), true);
  f.d.pickUp(10, 4);
  assert.equal(f.d.carrying(), true);
  assert.equal(f.clayEl.style.visibility, 'hidden', 'the island character hides while it is out');
  await Promise.resolve();
  f.d.carry(12, 6); f.d.carryEnd(14, 8);
  assert.deepEqual(f.calls.map(c => c[0]).filter(n => n.startsWith('character_') && n !== 'character_push'), ['character_info', 'character_pick_up', 'character_carry', 'character_carry_end']);
  f.handlers['desktop-character-dropped']({ payload: { from: 'island', home: false } });
  assert.equal(f.d.carrying(), false);
  assert.equal(f.d.phase(), 'onDesktop');
  assert.equal(f.d.canPickUp(), false, 'already out');
});

test('dropped back on the island: it is simply there again', async () => {
  const f = fakes();
  await f.d.init();
  f.d.pickUp(1, 1);
  f.handlers['desktop-character-dropped']({ payload: { from: 'island', home: true } });
  assert.equal(f.clayEl.style.visibility, '');
  assert.equal(f.d.phase(), 'home');
});

test('an alert in the snapshot sends it home', async () => {
  const f = fakes();
  await f.d.init();
  f.d.pickUp(1, 1);
  f.handlers['desktop-character-dropped']({ payload: { from: 'island', home: false } });
  f.d.snapshot({ card: { state: 'pending' } });
  assert.equal(f.d.phase(), 'retracting');
  assert.equal(f.timers.at(-1).ms, 450);
});

test('malformed events are ignored', async () => {
  const f = fakes();
  await f.d.init();
  for (const p of [null, {}, { payload: null }, { payload: { from: 'x', home: 'yes' } }]) f.handlers['desktop-character-dropped'](p);
  assert.equal(f.d.phase(), 'home');
});

test('explicit window drop: island returns without install, desktop stays out without another home flight', async () => {
  const island = fakes();
  await island.d.init();
  island.d.pickUp(1, 1);
  island.handlers['desktop-character-dropped']({ payload: { from: 'island', home: true } });
  assert.equal(island.d.carrying(), false);
  assert.equal(island.d.canPickUp(), true);
  assert.equal(island.clayEl.style.visibility, '');
  const desktop = fakes({ info: { mode: 'window', onDesktop: true } });
  await desktop.d.init();
  desktop.handlers['desktop-character-dropped']({ payload: { from: 'desktop', home: false } });
  assert.equal(desktop.calls.filter(([cmd]) => cmd === 'character_fly_home').length, 0);
});

test('highlight is host-owned and input-free before show, with stale-scan guards and quit cleanup', () => {
  const host = fs.readFileSync(path.join(__dirname, '../src/characterhost.rs'), 'utf8');
  assert.ok(host.includes('"character-highlight"'));
  const paint = host.slice(host.indexOf('fn paint_highlight('), host.indexOf('fn start_highlight('));
  assert.ok(paint.indexOf('input_shape_combine_region(&gtk::cairo::Region::create()') < paint.indexOf('w.show()'));
  for (const flag of ['.focusable(false)', '.focused(false)', '.skip_taskbar(true)', '.transparent(true)']) assert.ok(paint.includes(flag));
  assert.ok(host.includes('Duration::from_millis(250)') && host.includes('>= 2.0'));
  assert.ok(host.includes('guard.highlight.load(Ordering::SeqCst) == id'));
  const main = fs.readFileSync(path.join(__dirname, '../src/main.rs'), 'utf8');
  assert.equal((main.match(/characterhost::shutdown\(/g) || []).length, 2);
});

// ---- island.js hook ----
const src = read('island.js');

test('desktop toggle event flies out or home and is safe without the adapter', () => {
  const hook = src.match(/listen\('desktop-character-toggle',\s*\(\)\s*=>\s*\{([\s\S]*?)\}\)/);
  assert.ok(hook, 'island subscribes to the desktop shortcut event');
  let presses = 0;
  const run = new Function('desktopCharacter', hook[1]);
  run(null);
  run({ flyOutOrHome() { presses++; } });
  assert.equal(presses, 1);
});

test('index.html loads the logic and the adapter before island.js', () => {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script\s+defer\s+src="([^"]+)"/g)].map(m => m[1]);
  for (const f of ['character-desktop-logic.js', 'island-desktop.js']) {
    assert.equal(scripts.filter(x => x === f).length, 1, f);
    assert.ok(scripts.indexOf(f) < scripts.indexOf('island.js'), f);
  }
  assert.ok(scripts.indexOf('character-desktop-logic.js') < scripts.indexOf('island-desktop.js'));
});

test('island.js: only a press ON the character, with the feature available, is held back from drag_press', () => {
  const down = src.slice(src.indexOf("window.addEventListener('pointerdown'"), src.indexOf('// §9.2 hover on the character'));
  assert.match(down, /onCharacter\(e\)/);
  assert.match(down, /canPickUp\(\)/);
  // the island drag verb is still sent for every other press
  assert.match(down, /else send\('drag_press'/);
});

test('island.js: the pinned release line is untouched and the pick-up never reaches drag_move', () => {
  assert.ok(src.includes("send('drag_release', { x: pt.x, y: pt.y, cancelled });"));
  const move = src.slice(src.indexOf("window.addEventListener('pointermove'"), src.indexOf("document.addEventListener('pointerleave'"));
  assert.ok(move.indexOf('botPress') < move.indexOf("send('drag_move'"), 'a held press returns before drag_move');
  assert.match(move, /return;/);
});

test('behaviour: the hook decides pick-up vs island drag', () => {
  // Evaluate just the pure decision the hook shares with the adapter.
  assert.equal(D.pickUpDecision({ onCharacter: true, available: true }), 'pickup');
  assert.equal(D.pickUpDecision({ onCharacter: true, available: false }), 'island');
  assert.equal(D.pickUpDecision({ onCharacter: false, available: true }), 'island');
  assert.equal(D.pickUpDecision({ onCharacter: false, available: false }), 'island');
});

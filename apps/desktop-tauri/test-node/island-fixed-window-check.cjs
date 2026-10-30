'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/island.js'), 'utf8');

test('shape reports destination at transition boundaries, then rendered size at rest, never every frame', () => {
  const start = source.indexOf('function shapeReporter(');
  const end = source.indexOf('  const reportShape =', start);
  assert.ok(start >= 0 && end > start, 'production shape reporter exists');
  const calls = [];
  const context = vm.createContext({ invoke: (command, args) => { calls.push([command, JSON.parse(JSON.stringify(args))]); return Promise.resolve(); } });
  vm.runInContext(source.slice(start, end) + '\nthis.report = shapeReporter(invoke);', context);
  const report = context.report;
  report([288, 32], [288, 32], true);
  report([640, 160], [288, 32], false);
  for (let i = 0; i < 30; i++) report([640, 160], [300 + i, 40 + i], false);
  report([640, 200], [600, 170], false);
  report([640, 200], [640, 200], true);
  report([640, 200], [640, 200], true);
  assert.deepEqual(calls.map(c => c[1].payload), [
    { w: 288, h: 32, settled: false }, { w: 288, h: 32, settled: true },
    { w: 640, h: 160, settled: false }, { w: 640, h: 200, settled: false },
    { w: 640, h: 200, settled: true },
  ]);
  assert.ok(calls.every(c => c[0] === 'island_shape'));
});

test('island_shape is registered and gated before parsing, rate limiting and GDK application', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.rs'), 'utf8');
  const command = main.slice(main.indexOf('fn island_shape('), main.indexOf('fn drag_press('));
  const order = ['settingswindow::main_window_only(', 'bridge::sender_ok(', 'islandshape::parse(', '.check(now_ms())', 'islandshape::apply('].map(s => command.indexOf(s));
  assert.ok(order.every(i => i >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(main, /drag_release,\s+island_shape,/);
  const capabilities = JSON.parse(fs.readFileSync(path.join(__dirname, '../capabilities/main.json'), 'utf8'));
  assert.deepEqual(capabilities.permissions, ['core:event:allow-listen', 'core:event:allow-unlisten']);
});

test('a press on #clay picks up and carries the desktop character without sending island drag IPC', () => {
  const start = source.indexOf('  let pressed = false;');
  const end = source.indexOf('  // ---- #336 F003/F004:', start);
  assert.ok(start >= 0 && end > start);
  const handlers = {}, picked = [], carried = [], ended = [], commands = [];
  const context = vm.createContext({
    window: { addEventListener: (name, fn) => { handlers[name] = fn; } },
    document: { body: { classList: { add() {}, remove() {} } }, addEventListener() {} },
    character: { dragStart() {}, dragEnd() {}, dragMove() {} },
    desktopCharacter: { canPickUp: () => true, pickUp: (...p) => picked.push(p), carry: (...p) => carried.push(p), carryEnd: (...p) => ended.push(p) },
    interaction: null, O: null, syncInteraction() {},
    invoke: (cmd, args) => { commands.push([cmd, args]); return Promise.resolve(); }, console,
  });
  vm.runInContext(source.slice(start, end), context);
  const target = { closest: selector => selector === '#clay' ? target : null, setPointerCapture() {} };
  handlers.pointerdown({ button: 0, isPrimary: true, clientX: 200, clientY: 16, screenX: 824, target });
  handlers.pointermove({ clientX: 205, clientY: 20, screenX: 829 });
  handlers.pointermove({ clientX: 240, clientY: 80, screenX: 864 });
  handlers.pointerup({ clientX: 240, clientY: 80 });
  assert.deepEqual(picked, [[200, 16]]); assert.deepEqual(carried, [[240, 80]]); assert.deepEqual(ended, [[240, 80]]);
  assert.deepEqual(commands, []);
});

test('island_window_height is registered and gated like island_shape: main window only, sender, closed payload, rate limit, THEN Rust clamps and resizes', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.rs'), 'utf8');
  const command = main.slice(main.indexOf('fn island_window_height('), main.indexOf('fn drag_press('));
  assert.ok(command.length > 20, 'the command exists');
  const order = ['settingswindow::main_window_only(', 'bridge::sender_ok(', 'islandshape::parse_window_height(', '.check(now_ms())', 'geometry::clamp_window_height(', 'ensure_island_window('].map(s => command.indexOf(s));
  assert.ok(order.every(i => i >= 0), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(main, /island_shape,\s+island_window_height,/);
  assert.match(main, /geometry::island_window_rect_for\(monitor, area, io\.scale\(\), state\.window_h\.load\(Ordering::SeqCst\)\)/, 'the single native size funnel honours the requested height AND centres on the monitor, and places nothing while no monitor backs the scale');
  assert.match(main, /monitor: Mutex<Rect>,/, 'the monitor the island centres on is part of the app state');
  assert.match(main, /window_h: AtomicI32::new\(geometry::ISLAND_WINDOW\.1\)/);
  const capabilities = JSON.parse(fs.readFileSync(path.join(__dirname, '../capabilities/main.json'), 'utf8'));
  assert.deepEqual(capabilities.permissions, ['core:event:allow-listen', 'core:event:allow-unlisten'], 'no new capability is granted to the webview');
});

test('the page asks for a window height from the measured question layout and shrinks it back when the question closes', () => {
  const view = fs.readFileSync(path.join(__dirname, '../frontend/notify-view.js'), 'utf8');
  assert.match(view, /windowHeightFor/);
  const notify = fs.readFileSync(path.join(__dirname, '../frontend/notify.js'), 'utf8');
  assert.match(notify, /invoke\('island_window_height', \{ payload: \{ h: /);
  assert.match(notify, /N\.windowHeightFor\(/);
  assert.match(notify, /maxIslandH/);
  const isl = source;
  assert.doesNotMatch(isl, /Math\.min\(h, 332\)/, 'the island trusts the layout; the cap now comes from Rust');
});

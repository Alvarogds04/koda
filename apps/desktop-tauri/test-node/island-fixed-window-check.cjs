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

test('island-free-drag S4: a press on #clay pulls the pet out ONLY on the open island, and never sends island drag IPC', () => {
  const start = source.indexOf('  let pressed = false;');
  const end = source.indexOf('  // ---- #336 F003/F004:', start);
  assert.ok(start >= 0 && end > start);
  const run = state => {
    const handlers = {}, picked = [], carried = [], ended = [], commands = [];
    const context = vm.createContext({
      window: { addEventListener: (name, fn) => { handlers[name] = fn; } },
      document: { body: { classList: { add() {}, remove() {} } }, addEventListener() {} },
      character: { dragStart() {}, dragEnd() {}, dragMove() {} },
      desktopCharacter: { canPickUp: () => true, pickUp: (...p) => picked.push(p), carry: (...p) => carried.push(p), carryEnd: (...p) => ended.push(p) },
      interaction: null, O: null, syncInteraction() {}, capsule: { dataset: {} }, current: { state },
      invoke: (cmd, args) => { commands.push(cmd); return Promise.resolve(); }, console,
    });
    vm.runInContext(source.slice(start, end), context);
    const target = { closest: selector => selector === '#clay' ? target : null, setPointerCapture() {} };
    handlers.pointerdown({ button: 0, isPrimary: true, clientX: 200, clientY: 16, screenX: 824, screenY: 16, target });
    handlers.pointermove({ clientX: 205, clientY: 20, screenX: 829, screenY: 20 });
    handlers.pointermove({ clientX: 240, clientY: 80, screenX: 864, screenY: 80 });
    handlers.pointerup({ clientX: 240, clientY: 80 });
    return { picked, carried, ended, commands };
  };
  const open = run('expanded');
  assert.deepEqual(open.picked, [[200, 16]]); assert.deepEqual(open.carried, [[240, 80]]); assert.deepEqual(open.ended, [[240, 80]]);
  assert.deepEqual(open.commands, [], 'the pet never sends a drag press');
  // S4: compact is the disc: the same press is the island's own handle, so the pet never leaves
  const compact = run('compact');
  assert.deepEqual([compact.picked, compact.carried, compact.ended], [[], [], []], 'compact never pulls the pet out');
  assert.deepEqual(compact.commands, ['island_move_begin', 'island_move', 'island_move', 'island_move_end'], 'the disc is what moves');
});

test('island_window_height is registered and gated like island_shape: main window only, sender, closed payload, rate limit, THEN Rust clamps and resizes', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.rs'), 'utf8');
  const command = main.slice(main.indexOf('fn island_window_height('), main.indexOf('fn drag_press('));
  assert.ok(command.length > 20, 'the command exists');
  const order = ['settingswindow::main_window_only(', 'bridge::sender_ok(', 'islandshape::parse_window_height(', '.check(now_ms())', 'geometry::clamp_window_height(', 'ensure_island_window('].map(s => command.indexOf(s));
  assert.ok(order.every(i => i >= 0), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(main, /island_shape,\s+island_window_height,/);
  assert.match(main, /geometry::island_window_rect_where\(monitor, area, io\.scale\(\), state\.window_h\.load\(Ordering::SeqCst\), placed\)/, 'the single native size funnel honours the requested height, centres on the monitor unless the human dragged the island (Koda), and places nothing while no monitor backs the scale');
  assert.match(main, /monitor: Mutex<Rect>,/, 'the monitor the island centres on is part of the app state');
  assert.match(main, /window_h: AtomicI32::new\(geometry::ISLAND_WINDOW\.1\)/);
  const capabilities = JSON.parse(fs.readFileSync(path.join(__dirname, '../capabilities/main.json'), 'utf8'));
  assert.deepEqual(capabilities.permissions, ['core:event:allow-listen', 'core:event:allow-unlisten'], 'no new capability is granted to the webview');
});

test('Koda: every native expand path tells placement the island is open, so a dragged island near an edge never hangs off screen', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.rs'), 'utf8');
  const branch = name => { const at = main.indexOf(name); assert.ok(at >= 0, name + ' missing'); return main.slice(at, main.indexOf('ensure_island_window(', at)); };
  for (const name of ['desktop::ClickPlan::Expand(plan) => {', 'desktop::ClickPlan::Overview(plan) => {']) {
    assert.match(branch(name), /island_open\.store\(true, Ordering::SeqCst\)/, name + ' must mark the island open before placing it');
  }
  assert.match(branch('fn apply_plan('), /island_open\.store\(plan\.is_expand\(\), Ordering::SeqCst\)/);
  // a press of the character or a fresh pill press clears a pill drag whose release never arrived
  assert.match(branch('fn drag_press('), /island_drag\.lock\(\)[^;]*\.take\(\)/);
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

test('Koda: a press inside a scrolling area never moves the island; the bare pill does', () => {
  const start = source.indexOf('  let pressed = false;');
  const end = source.indexOf('  // ---- #336 F003/F004:', start);
  const run = scrolls => {
    const handlers = {}, commands = [];
    const pill = { nodeType: 1, parentElement: null, scrollHeight: 32, clientHeight: 32, scrollWidth: 288, clientWidth: 288, style: { overflowY: 'visible', overflowX: 'visible' } };
    const list = { nodeType: 1, parentElement: pill, scrollHeight: scrolls ? 900 : 120, clientHeight: 120, scrollWidth: 300, clientWidth: 300, style: { overflowY: 'auto', overflowX: 'hidden' } };
    const row = { nodeType: 1, parentElement: list, scrollHeight: 20, clientHeight: 20, scrollWidth: 300, clientWidth: 300, style: { overflowY: 'visible', overflowX: 'visible' },
      closest: () => null, setPointerCapture() {} };
    const context = vm.createContext({
      window: { addEventListener: (name, fn) => { handlers[name] = fn; } },
      document: { body: { classList: { add() {}, remove() {} } }, addEventListener() {} },
      getComputedStyle: el => ({ userSelect: 'none', webkitUserSelect: 'none', ...el.style }),
      character: { dragStart() {}, dragEnd() {}, dragMove() {} }, desktopCharacter: null,
      interaction: null, O: null, syncInteraction() {}, current: { state: 'expanded' },
      invoke: (cmd, args) => { commands.push(cmd); return Promise.resolve(); }, console,
    });
    vm.runInContext(source.slice(start, end), context);
    handlers.pointerdown({ button: 0, isPrimary: true, clientX: 10, clientY: 10, screenX: 500, screenY: 300, target: row });
    handlers.pointermove({ clientX: 10, clientY: 80, screenX: 500, screenY: 370 });
    handlers.pointerup({ clientX: 10, clientY: 80 });
    return commands;
  };
  assert.deepEqual(run(true), [], 'the scroll owns the press');
  assert.deepEqual(run(false), ['island_move_begin', 'island_move', 'island_move_end'], 'a list that does not scroll is still part of the pill');
});

// ---- island-free-drag S3/S5: compact Koda is ONLY the disc ----------------------------------------------------------------
// One source of truth: island-layout.js declares the disc's box as COMPACT_DOT_W / COMPACT_DOT_H, geometry.rs declares
// COMPACT_DOT and everything native (the GDK input shape, placement) keeps exactly that box on screen.
const L = require(path.join(__dirname, '../frontend/island-layout.js'));
const layoutSrc = fs.readFileSync(path.join(__dirname, '../frontend/island-layout.js'), 'utf8');
const geometry = fs.readFileSync(path.join(__dirname, '../src/geometry.rs'), 'utf8');
const dotValue = name => {
  const m = layoutSrc.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(m, `island-layout.js declares ${name}`);
  return Number(m[1]);
};

test('S3: compact is ONLY the disc in EVERY compact state: no bar, no activity line, no minis, no «Responder»', () => {
  const dot = { w: dotValue('COMPACT_DOT_W'), h: dotValue('COMPACT_DOT_H') };
  assert.equal(L.COMPACT_DOT.w, dot.w, 'the model exports the disc width');
  assert.equal(L.COMPACT_DOT.h, dot.h, 'the model exports the disc height');
  const running = [{ id: 's-0000000a', kindLabel: 'Pi', cwd: 'workspace', state: 'running',
    tools: { total: 2, steps: [{ index: 1, name: 'read', state: 'done' }, { index: 2, name: 'bash', state: 'running' }] }, color: 'green' }];
  const pending = { kind: 'question', agent: 'pi', text: '¿Qué editor preferís?' };
  const permission = { kind: 'question', agent: 'claude-code', text: 'Claude Code asks permission: Bash: rm -rf build/',
    options: [{ index: 0, label: 'Allow once' }, { index: 1, label: 'Deny' }] };
  const notice = { kind: 'settled', title: 'Pi terminó su turno' };
  const cases = [
    ['idle', { rows: [], pending: null }, ''],
    ['sessions working', { rows: running, focusId: 's-0000000a', pending: null }, 'working'],
    ['finished notice', { rows: [], pending: null, notice }, 'finished'],
    ['attention notice', { rows: [], pending: null, notice: { kind: 'attention', title: 'Codex te pide permiso' } }, 'attention'],
    ['pending question', { rows: running, pending }, 'question'],
    ['pending permission', { rows: [], pending: permission }, 'approval'],
  ];
  for (const [name, input, badge] of cases) {
    const v = L.compactView(input);
    assert.deepEqual([v.width, v.activity, v.reply, v.minis, v.more], [dot.w, '', false, [], 0],
      `${name}: the disc is the whole compact island (no widened bar, no text, no «Responder») — got ${JSON.stringify(v)}`);
    assert.equal(v.badge, badge, `${name}: the state signal rides the disc (S5)`);
  }
  assert.equal(L.compactView(null).width, dot.w, 'even a missing model keeps the disc box');
});

test('S3: geometry.rs keeps exactly the disc as the native input shape and as what placement keeps on screen', () => {
  const w = dotValue('COMPACT_DOT_W'), h = dotValue('COMPACT_DOT_H');
  assert.match(geometry, new RegExp(`pub const COMPACT_DOT: \\(i32, i32\\) = \\(${w}, ${h}\\);`),
    'geometry::COMPACT_DOT is the page disc (island-layout.js COMPACT_DOT_W / COMPACT_DOT_H)');
  assert.doesNotMatch(geometry, /\bCOMPACT_BAR\b|\bCOMPACT_WIDTHS\b/, 'the bar and its three widths are gone');
  // the input shape: never bigger than the drawn box, never smaller than the disc
  const clamp = geometry.slice(geometry.indexOf('pub fn clamp_island_shape('), geometry.indexOf('pub fn island_shape_rect('));
  assert.match(clamp, /w\.max\(COMPACT_DOT\.0\)/, 'the smallest compact input box is the disc width');
  assert.match(clamp, /h\.max\(COMPACT_DOT\.1\)/, 'and the disc height');
  // placement: compact keeps the DISC box inside the work area, so the disc (not a 560 px bar) reaches every edge
  const placed = geometry.slice(geometry.indexOf('pub fn island_window_rect_placed('), geometry.indexOf('pub fn island_window_rect_where('));
  assert.match(placed, /scaled_size\(COMPACT_DOT, scale\)/, 'compact keeps the disc box on screen');
  // the page's disc and the native report agree: 40x32 is a compact report at rest, not clamped away (the Rust unit test pins
  // the exact table: `the_input_shape_is_the_visible_island_clamped_...` expects ((40, 32), (40, 32))
  assert.match(geometry, /\(\(40, 32\), \(40, 32\)\)/, 'a settled 40x32 report IS the input region');
});

test('S5: the compact disc, and nothing else, carries the pending signal; the flag stays readable for AT', () => {
  const nusa = fs.readFileSync(path.join(__dirname, '../frontend/island-nusa.css'), 'utf8');
  // the state dot rides the disc in every compact state (role colour from --pill-dot, set from the live state)
  assert.match(nusa, /#capsule:is\(\[data-phase="compact"\], \[data-compact-disc="true"\]\) #island::after \{/, 'the disc draws its own state dot');
  const dot = nusa.slice(nusa.indexOf(':is([data-phase="compact"], [data-compact-disc="true"]) #island::after {'));
  assert.match(dot.slice(0, dot.indexOf('}')), /pointer-events: none/, 'decoration never intercepts a press');
  assert.doesNotMatch(nusa, /data-pill-bare/, 'a bare disc still shows its signal');
  // the «» 14px flag is not drawn, but it no longer disappears from the accessibility tree with its aria-label
  assert.doesNotMatch(nusa, /#capsule\[data-phase="compact"\] #compact-flag, #capsule\[data-edge-hidden="true"\] #compact-flag \{ display: none !important; \}/,
    'a display:none flag loses the pending question\'s accessible name');
  assert.match(nusa, /#capsule\[data-phase="compact"\] #compact-flag[^{]*\{[^}]*clip-path: inset\(50%\)/, 'visually hidden, still in the AT tree');
  assert.doesNotMatch(nusa, /#capsule\[data-phase="compact"\] #compact-flag, #capsule\[data-edge-hidden="true"\] #compact-flag \{ display: none !important; \}/, 'never display:none');
  // no compact question UI in the markup any more: the question is read when the island is opened
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  assert.doesNotMatch(html, /id="compact-reply"/, 'the «Responder» pill was the wide compact bar; the disc has no room for it');
});

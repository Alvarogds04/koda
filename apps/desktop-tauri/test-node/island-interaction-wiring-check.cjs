'use strict';
/* #336 T1b-b — wiring contract (S3-S5): index.html loads the T1a module
   BEFORE island.js, and island.js feeds the module the live facts/events and
   calls back ONLY through the existing desktop facade verbs. Source-level
   contract: no DOM execution, no native app, no gesture proof — isTrusted
   rejection stays pinned by the module's own public test
   (island-interaction-check.cjs), never claimed here.
   Run: node apps/desktop-tauri/test-node/island-interaction-wiring-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const read = file => fs.readFileSync(path.join(frontend, file), 'utf8');
// the stub below serves the REAL pure phase view (#439): the island's render
// loop delegates dataset.phase to O.viewPhase, so the fixture must too
const OV = require(path.join(frontend, 'overview-view.js'));
let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed += 1; } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); } };

test('#336 index.html loads island-interaction.js exactly once, defer, before island.js', () => {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script\s+defer\s+src="([^"]+)"/g)].map(m => m[1]);
  assert.equal(scripts.filter(f => f === 'island-interaction.js').length, 1, 'exactly one script tag');
  const at = scripts.indexOf('island-interaction.js');
  assert.ok(at >= 0, 'the module must be in the curated script list');
  assert.ok(at < scripts.indexOf('island.js'), 'defer keeps document order: the module must run first');
  assert.ok(html.indexOf('src="island-interaction.js"') < html.indexOf('src="island.js"'), 'document order');
});

test('#336 island.js creates exactly ONE controller with the six required callbacks and hosted timers', () => {
  const src = read('island.js');
  assert.equal((src.match(/createController\(/g) || []).length, 1, 'one owned scheduler, never two');
  assert.match(src, /AbitoIslandInteraction\s*\?\s*window\.AbitoIslandInteraction\.createController\(\{/, 'the controller comes from the loaded module');
  for (const cb of ['now:', 'schedule:', 'cancel:', 'open:', 'autoClose:', 'onCountdown:']) {
    assert.ok(new RegExp(`\\b${cb}`).test(src), `callback ${cb}`);
  }
  assert.match(src, /schedule: \(fn, ms\) => setTimeout\(fn, ms\)/, 'hosted relative timers only');
  assert.match(src, /cancel: id => clearTimeout\(id\)/, 'the owned timer is cancellable');
});

test('#336 the effects go through the facade verbs and the adapter never moves focus', () => {
  const src = read('island.js');
  assert.match(src, /window\.desktop \? window\.desktop\.expand\(\)/, 'hover open requests the existing expand');
  assert.match(src, /window\.desktop \? window\.desktop\.autoClose\(\)/, 'the close is the new atomic verb');
  assert.match(src, /Promise\.reject\(new Error\('host unavailable'\)\)/, 'a missing host fails honestly');
  // scope the no-focus rule to the #336 adapter block: the file's own
  // pre-existing focus handling (Escape/focusAfterPhase) is not ours to touch.
  const start = src.indexOf('the inactivity interaction feed');
  const end = src.indexOf('---- notices (M2)');
  assert.ok(start >= 0 && end > start, 'the adapter block must exist between the pointer section and notices');
  assert.doesNotMatch(src.slice(start, end), /\.focus\(|set_focus/, 'the adapter never moves focus');
});

test('#336 the feed: facts update on native state/phase/view/DOM changes, prefs feed the typed pair', () => {
  const src = read('island.js');
  assert.match(src, /function syncInteraction\(/, 'one sync entry point');
  assert.match(src, /interaction\.update\(interactionFacts\(\)\)/, 'facts reach the module');
  assert.match(src, /function interactionFacts\(/, 'facts are built in one place');
  // every blocker of the public contract is fed explicitly (fail closed on absence)
  for (const key of ['question:', 'approval:', 'request:', 'decision:', 'card:', 'dragging:', 'editing:', 'composing:', 'draft:', 'settings:']) {
    assert.ok(src.includes(key), `blocker fact ${key}`);
  }
  for (const key of ['state:', 'view:', 'settled:', 'nativeReady:']) assert.ok(src.includes(key), `host fact ${key}`);
  // native snapshot + phase/view + focus/draft + IME + prefs are the feed points
  assert.match(src, /syncInteraction\(\);/, 'sync is called from the feeds');
  assert.match(src, /attributeFilter: \['data-phase', 'data-view', 'data-settings', 'data-question', 'data-card'\]/, 'the capsule attributes are observed');
  assert.match(src, /compositionstart/, 'an IME session is a blocker');
  assert.match(src, /interaction\.enter\(/, 'pointer entry feeds the module');
  assert.match(src, /interaction\.leave\(/, 'pointer leave feeds the module');
  assert.match(src, /interaction\.engage\(/, 'a deliberate click/keyboard engagement feeds the module');
  assert.match(src, /setPreferences\(/, 'preferences reach the module');
  assert.match(src, /applyInteractionPrefs\(/, 'the typed pair goes through one guarded adapter');
  assert.match(src, /autoCloseSeconds/, 'the projection field is read');
  assert.match(src, /pagehide.*interaction\.stop\(\)|interaction\.stop\(\)/, 'teardown stops the scheduler');
});

test('#336 no innerHTML is reintroduced in island.js (#411) and the adapter owns no geometry', () => {
  const src = read('island.js');
  assert.doesNotMatch(src, /innerHTML/, 'icons stay DOM nodes, text stays textContent');
  assert.doesNotMatch(src, /requestAnimationFrame\(.*syncInteraction/, 'no frame loop feeds the scheduler');
  // The scheduler (island-interaction.js) never polls. The adapter has exactly ONE bounded re-read of the live :hover hit-test, only
  // while the controller believes the pointer is inside: a swallowed pointerleave sends no event, so nothing else would notice it.
  const polls = src.match(/setInterval\([^\n]*interaction[^\n]*/g) || [];
  assert.equal(polls.length, 1, 'one hover re-read, no other interaction polling');
  assert.match(polls[0], /interaction\.snapshot\(\)\.inside && !document\.hidden\) syncInteraction\(\)/, 'guarded by «inside» and a visible page');
  assert.match(polls[0], /, 1000\)/, 'once a second');
  assert.doesNotMatch(fs.readFileSync(path.join(frontend, 'island-interaction.js'), 'utf8'), /setInterval/, 'the module itself owns only the one hosted timer');
});

// ---- #336 L18: the engagement press through the facade spy ------------------
// Executes the REAL island.js + the REAL interaction module in a VM with a
// minimal host fixture; window.desktop and invoke are SPIES. isTrusted:true
// here is HANDLER SIMULATION ONLY — no native gesture, focus or geometry is
// proven (the module's own isTrusted rules stay pinned in
// island-interaction-check.cjs).
function engagementFixture(openOnHover, options) {
  const vm = require('node:vm');
  // island-free-drag S4: the desktop-character adapter is optional; the spies record a real pick-up/carry/end when it is present
  const pet = options && options.pet ? { picked: [], carried: [], ended: [] } : null;
  let hovering = false;
  const intervalsList = [];
  const moduleApi = require(path.join(frontend, 'island-interaction.js'));
  const invocations = [];
  const desktopCalls = [], dismissed = [];
  const byId = new Map();
  const windowListeners = Object.create(null);
  const documentListeners = Object.create(null);
  const observers = [];
  const resolved = value => ({
    then(ok) { ok(value); return this; },
    catch() { return this; },
    finally(fn) { fn(); return this; },
  });
  const timers = new Map(); let nextTimer = 0, clock = 0;
  const makeEl = () => {
    const listeners = Object.create(null), attrs = new Map();
    return {
      hidden: true, inert: false, disabled: false, value: '', textContent: '', tabIndex: 0,
      dataset: {}, matches() { return false; },
      style: { width: '', height: '', top: '', bottom: '', left: '', borderRadius: '',
        setProperty() {}, getPropertyValue() { return '1'; }, removeProperty() {} },
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(k, v) { attrs.set(k, v); }, getAttribute(k) { return attrs.get(k) ?? null; }, removeAttribute() {}, appendChild() {},
      before(el) { byId.set(el.id, el); },
      replaceChildren() {},
      addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
      removeEventListener() {},
      fire(type, ev) { for (const fn of listeners[type] || []) fn(ev); },
      focus() {}, click() { this.fire('click',{isTrusted:false,preventDefault(){}}); },
      querySelectorAll() { return []; }, querySelector() { return null; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; },
      closest() { return null; },
    };
  };
  byId.set('capsule', Object.assign(makeEl(), { matches: sel => (sel === ':hover' ? hovering : false) }));
  byId.set('island', Object.assign(makeEl(), { matches: sel => (sel === ':hover' ? hovering : false) }));
  const documentStub = {
    documentElement: makeEl(),
    body: makeEl(),
    activeElement: makeEl(), // not a text field, so editing stays false
    getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl()); return byId.get(id); },
    querySelectorAll() { return []; }, querySelector() { return null; },
    createElement() { return makeEl(); }, importNode(n) { return n; },
    addEventListener(name, fn) { (documentListeners[name] ||= []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) { for (const fn of documentListeners[ev.type] || []) fn(ev); return true; },
  };
  let snapshotState = { state: 'compact', notices: [], card: null, request: null,
    revision: 1, motionOverride: false, unavailable: false };
  const desktopHandlers = [];
  const desktop = {
    onState(fn) { desktopHandlers.push(fn); return () => {}; },
    snapshot() { return resolved(snapshotState); },
    expand() { desktopCalls.push('expand'); return resolved(snapshotState); },
    close() { desktopCalls.push('close'); return resolved(snapshotState); },
    autoClose() { desktopCalls.push('autoClose'); return resolved(snapshotState); },
    dismiss(id) { desktopCalls.push('dismiss'); dismissed.push(id); return resolved(snapshotState); },
    click() { return resolved(snapshotState); },
    allow() { return resolved(snapshotState); },
    deny() { return resolved(snapshotState); },
  };
  const sandbox = {
    console,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    performance: { now: () => clock },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, {fn, ms, due:clock+ms}); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval(fn, ms) { intervalsList.push({ fn, ms }); return intervalsList.length; }, clearInterval() {},
    requestAnimationFrame() { return 1; },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    DOMParser: class { parseFromString() { return { documentElement: { nodeName: 'svg' } }; } },
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} },
    AbitoNotify: require('../frontend/notify-view.js'),
    AbitoOverview: {
      viewPhase: OV.viewPhase,
      motionState: () => 'full', honorSystemMotion: () => false, choosePose: () => 'idle',
      hostPoseView: () => ({ tracker: { failing: false, since: 0 }, pose: null }),
      connectionView: () => ({ word: '', detail: '', tone: '', aria: '', icon: '' }),
      bridgeView: () => null, noticeView: () => null, hotkeyView: () => null,
      noticeBandView: OV.noticeBandView, finishedCardView: OV.finishedCardView,
      noticeListView: OV.noticeListView,
      cardConnection: () => null, engineRowView: () => null, expiryLabel: () => '', expiryAria: () => '',
      cardView: () => ({ kind: 'inert', tone: '', icon: null, word: '', aria: '' }),
      infoLabel: a => a, hoverScale: () => 1,
    },
    AbitoCharacter: { create: () => ({ chat() {}, dragStart() {}, dragMove() {}, dragEnd() {},
      hover() {}, busy() {}, activity() {}, question() {}, snapshot() {}, destroy() {}, motionChanged() {} }) },
    AbitoIcons: { svg: () => '', ring: () => '' },
    AbitoIslandInteraction: moduleApi,
    __TAURI__: { core: { invoke(cmd, args) {
      invocations.push({ cmd, args });
      if (cmd === 'prefs_action') return resolved({ sound: false, avatarColors: {}, autoCloseSeconds: 15, openOnHover, ...(options && options.prefs) });
      if (cmd === 'hotkey_action') return resolved({ status: 'disabled' });
      if (cmd === 'question_action') return resolved({ available: false, pending: null });
      return resolved({});
    } } },
    desktop,
    document: documentStub,
  };
  if (pet) {
    sandbox.AbitoIslandDesktop = {
      canPickUp: () => (options.pet.canPickUp ? options.pet.canPickUp() : true),
      pickUp: (x, y) => pet.picked.push([x, y]),
      carry: (x, y) => pet.carried.push([x, y]),
      carryEnd: (x, y) => pet.ended.push([x, y]),
      flyOutOrHome() {},
      attach() {},
      snapshot() {},
      init: () => Promise.resolve(),
      ready: Promise.resolve(),
    };
  }
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.addEventListener = (name, fn) => { (windowListeners[name] ||= []).push(fn); };
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = ev => { for (const fn of windowListeners[ev.type] || []) fn(ev); return true; };
  vm.runInNewContext(read('island.js'), sandbox, { filename: 'island.js' });
  const fire = (bag, type, ev) => { for (const fn of bag[type] || []) fn(ev); };
  const pointer = extra => Object.assign({ isTrusted: true, pointerType: 'mouse', buttons: 0,
    clientX: 5, clientY: 5, isPrimary: true, button: 0 }, extra);
  return {
    invocations, desktopCalls, dismissed,
    ok() { byId.get('notice-card-ok').fire('click',{isTrusted:true}); },
    view() { return byId.get('capsule').dataset.view; },
    noticeName() { return byId.get('notice-card-name').textContent; },
    permission() { return byId.get('permission'); },
    windowHover(on) { byId.get('capsule').matches = sel => sel === ':hover' && on; },
    pillHover(on) { byId.get('island').matches = sel => sel === ':hover' && on; },
    update(extra) { snapshotState={...snapshotState,...extra}; for(const fn of desktopHandlers) fn(snapshotState); },
    advance(ms) { const end=clock+ms; for(;;) { const next=[...timers].sort((a,b)=>a[1].due-b[1].due)[0]; if(!next||next[1].due>end) break; clock=next[1].due; timers.delete(next[0]); next[1].fn(); } clock=end; },
    pin() { const el = byId.get('island-pin'); assert.ok(el, 'accessible manual pin control exists'); el.fire('click', {isTrusted:true,type:'click',button:0}); return el.getAttribute('aria-pressed'); },
    // the boot render mutates the observed attributes: fire them once
    mutate() { for (const o of observers) o.cb([]); },
    capsule() { return byId.get('capsule'); },
    intervals() { return intervalsList; },
    tickIntervals() { for (const i of intervalsList) i.fn(); },
    seed(state) {
      snapshotState = { ...snapshotState, state };
      for (const fn of desktopHandlers) fn(snapshotState);
      byId.get('capsule').dataset.phase = state === 'expanded' ? 'expanded' : 'compact';
      for (const o of observers) o.cb([]);
    },
    enter() { hovering = true; byId.get('capsule').fire('pointerenter', pointer({ type: 'pointerenter' })); byId.get('island').fire('pointerenter', pointer({ type: 'pointerenter' })); },
    leave() { hovering = false; byId.get('capsule').fire('pointerleave', pointer({ type: 'pointerleave' })); byId.get('island').fire('pointerleave', pointer({ type: 'pointerleave' })); },
    press() { fire(windowListeners, 'pointerdown', pointer({ type: 'pointerdown', target: { closest: () => null } })); },
    // Koda: a press on the bare pill at a screen point, then pointer travel in screen px
    pressAt(screenX, screenY) { fire(windowListeners, 'pointerdown', pointer({ type: 'pointerdown', screenX, screenY, target: { closest: () => null } })); },
    moveTo(screenX, screenY, buttons = 1) { fire(windowListeners, 'pointermove', pointer({ type: 'pointermove', screenX, screenY, buttons })); },
    blur() { fire(windowListeners, 'blur', { type: 'blur' }); },
    cancel() { fire(windowListeners, 'pointercancel', pointer({ type: 'pointercancel' })); },
    moves() { return invocations.filter(i => /^island_move/.test(i.cmd)); },
    // a press on an element that matches the real selector list (e.g. a link): closest honours the selector
    pressOn(tag) { fire(windowListeners, 'pointerdown', pointer({ type: 'pointerdown', ctrlKey: true,
      target: { closest: sel => (String(sel).split(',').map(x => x.trim()).includes(tag) ? {} : null) } })); },
    // island-free-drag S3/S4: a press on the character itself (as a real hit-test on #clay reports it)
    pressCharacter(clientX, clientY, screenX, screenY) {
      const target = { closest: sel => (String(sel).split(',').map(x => x.trim()).includes('#clay') ? {} : null), setPointerCapture() {} };
      fire(windowListeners, 'pointerdown', pointer({ type: 'pointerdown', clientX, clientY, screenX, screenY, target })); },
    // T7: under the Koda skin #clay is hidden; the character a human sees and grabs is the .koda-sprite drawn beside it
    pressSprite(clientX, clientY, screenX, screenY) {
      const target = { classList: { contains: c => c === 'koda-sprite' }, closest: sel => (String(sel).split(',').map(x => x.trim()).includes('.koda-sprite') ? {} : null), setPointerCapture() {} };
      fire(windowListeners, 'pointerdown', pointer({ type: 'pointerdown', clientX, clientY, screenX, screenY, target })); },
    movePointer(clientX, clientY, screenX, screenY, buttons = 1) {
      fire(windowListeners, 'pointermove', pointer({ type: 'pointermove', clientX, clientY, screenX, screenY, buttons })); },
    pet() { return pet; },
    island() { return byId.get('island'); },
    shapes() { return invocations.filter(i => i.cmd === 'island_shape').map(i => i.args.payload); },
    // island-free-drag S3: the layout model publishes what the compact island should show (abito:compact-view)
    compactView(detail) { fire(documentListeners, 'abito:compact-view', { type: 'abito:compact-view', detail }); },
    release() { fire(windowListeners, 'pointerup', pointer({ type: 'pointerup' })); },
    click() { fire(documentListeners, 'click', pointer({ type: 'click' })); },
    // Execute the shipped global pointer handlers around an independently owned
    // control callback. This models DOM bubbling, not native/trusted input.
    activateControl(_name, button) {
      const el = makeEl(); let actions = 0;
      el.closest = selector => button && selector.split(',').map(s => s.trim()).includes('button') ? el : null;
      el.onclick = () => { actions++; };
      const event = pointer({ target: el, type: 'pointerdown', defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; } });
      fire(windowListeners, 'pointerdown', event);
      fire(windowListeners, 'pointerup', { ...event, type: 'pointerup' });
      if (!event.defaultPrevented) el.onclick();
      return actions;
    },
    dragReleases() { return invocations.filter(i => i.cmd === 'drag_release'); },
    // WebKit's live pill hit-test: the truth when a pointerleave was swallowed
    hover(on) { hovering = on; },
    // the focused element: { tag, type, hidden } as the live DOM would report it
    focus(spec) {
      const el = makeEl();
      el.type = spec.type; el.tagName = String(spec.tag).toUpperCase();
      el.matches = sel => String(sel).split(',').map(x => x.trim()).includes(spec.tag); // faithful: ANY <input> matches «input»
      el.hidden = !!spec.hidden; el.closest = () => (spec.hidden ? { hidden: true, inert: true } : null);
      el.getClientRects = () => (spec.hidden ? [] : [{}]); el.offsetParent = spec.hidden ? null : {};
      documentStub.activeElement = el;
    },
  };
}

// isla-cualquier-lado S2 (human: «solo el círculo con koda pero sin que esté oculto»): the folded island is Koda's disc and it
// NEVER hides at the screen edge any more, whatever the time spent folded, the sound setting or an old stored absence preference.
for (const [name, prefs] of [
  ['muted (was: hidden after 1 s)', { sound: false }],
  ['sound on, old 10 s default', { sound: true, absenceSeconds: 10 }],
  ['old 300 s maximum', { sound: true, absenceSeconds: 300 }],
]) test('S2 a folded island is never concealed at the edge: ' + name, () => {
  const f = engagementFixture(false, { prefs }); f.mutate(); f.seed('compact');
  for (let i = 0; i < 3; i++) { f.advance(301000); f.mutate(); }
  assert.equal(f.capsule().dataset.edgeHidden, undefined, 'data-edge-hidden is never written');
  assert.doesNotMatch(String(f.island().style.top), /^-/, 'the disc is never slid up out of the screen');
  for (const shape of f.shapes()) assert.ok(shape.h >= 32, 'the native island never shrinks into the edge: ' + JSON.stringify(shape));
});
test('S2 the island no longer wires an edge-hide timer', () => {
  assert.doesNotMatch(read('island.js'), /createEdgeController|setConcealed|__islandConceal|edgeHidden|absenceSeconds/, 'no edge-hide wiring is left');
  assert.doesNotMatch(read('island-interaction.js'), /createEdgeController|EDGE_ABSENCE/, 'the module no longer exports the edge-hide timer');
});

for (const [name, card, blocked] of [
  ['expired', {state:'pending',reason:null,expires_at:'2000-01-01T00:00:00Z'}, false],
  ['pending', {state:'pending',reason:null,expires_at:'2099-01-01T00:00:00Z'}, true],
  ['inert', {state:'inert',reason:'closed',expires_at:'2099-01-01T00:00:00Z'}, false],
  ['invalid expiry', {state:'pending',reason:null,expires_at:'invalid'}, false],
]) test('compact card gate: ' + name, () => {
  const f=engagementFixture(false); f.update({card:{operation:'Read files',...card}}); f.seed('compact');
  assert.equal(f.permission().hidden, name === 'invalid expiry', 'expired/inert cards remain visible; invalid shape stays hidden');
  // isla-cualquier-lado S2: pending (blocked) or not, the folded island is never concealed at the edge
  f.advance(301000); assert.equal(f.capsule().dataset.edgeHidden, undefined, blocked ? 'pending card' : 'no pending card');
});

for (const [surface, button] of [
  ['header home tab', true], ['header chat tab', true], ['gear', true], ['mute', true],
  ['pill', false], ['pill choice', false], ['Spotify np-pill', false],
  ['usage stat card', false], ['GitHub row', false], ['GitHub control', true],
  ['notice band', false], ['notice open button', true], ['notice dismiss button', true], ['notice clear button', true],
  ['session row', false], ['session ticker', false],
]) test('expanded press preserves the ' + surface + ' action without toggling or collapsing', () => {
  const f = engagementFixture(false); f.mutate(); f.seed('expanded');
  assert.equal(f.activateControl(surface, button), 1, 'the independently owned control action runs once');
  assert.equal(f.invocations.filter(i => /^drag_/.test(i.cmd)).length, 0, 'no island press/release IPC');
  assert.deepEqual(f.desktopCalls, [], 'no expand, close or auto-close');
});

test('a click on the collapsed bar expands on release without a release toggle', () => {
  const f = engagementFixture(false); f.mutate();
  f.press();
  assert.deepEqual(f.desktopCalls, [], 'a press alone may still become a move');
  f.release();
  assert.deepEqual(f.desktopCalls, ['expand']);
  assert.equal(f.dragReleases().length, 0);
  assert.deepEqual(f.moves(), [], 'a click never moves the island');
});

test('Koda: dragging the collapsed bar moves the island and does not expand it', () => {
  const f = engagementFixture(false); f.mutate();
  f.pressAt(900, 40); f.moveTo(903, 42);
  assert.deepEqual(f.moves(), [], 'under 6 px it is still a click');
  f.moveTo(950, 300); f.moveTo(20, 1000); f.release();
  assert.deepEqual(JSON.parse(JSON.stringify(f.moves().map(i => [i.cmd, i.args]))), [
    ['island_move_begin', { x: 900, y: 40 }],
    ['island_move', { x: 950, y: 300 }],
    ['island_move', { x: 20, y: 1000 }],
    ['island_move_end', {}],
  ]);
  assert.deepEqual(f.desktopCalls, [], 'a move never expands');
  assert.equal(f.invocations.filter(i => /^drag_/.test(i.cmd)).length, 0, 'the pill drag never reaches the character/click path');
});

test('Koda: the expanded island moves from its pill too; the window moving under the pointer (pointercancel/blur) never ends the move', () => {
  const f = engagementFixture(false); f.mutate(); f.seed('expanded');
  f.pressAt(500, 100); f.moveTo(500, 400); f.cancel(); f.blur(); f.moveTo(520, 420);
  assert.deepEqual(f.moves().map(i => i.cmd), ['island_move_begin', 'island_move', 'island_move'], 'still moving after cancel/blur');
  f.release();
  assert.deepEqual(f.moves().map(i => i.cmd), ['island_move_begin', 'island_move', 'island_move', 'island_move_end']);
  assert.deepEqual(f.desktopCalls, [], 'no expand, close or auto-close');
  f.press(); f.cancel();
  assert.deepEqual(f.desktopCalls, [], 'a cancelled click on a compact or expanded pill does nothing');
});

test('Koda: a lost release ends the move on the next pointer move seen without the button, so the island never sticks to the mouse', () => {
  const f = engagementFixture(false); f.mutate();
  f.pressAt(900, 40); f.moveTo(950, 300); f.moveTo(960, 310, 0); f.moveTo(1200, 900, 0);
  assert.deepEqual(f.moves().map(i => i.cmd), ['island_move_begin', 'island_move', 'island_move_end']);
  assert.deepEqual(f.desktopCalls, [], 'a lost release never expands');
});

test('Koda: a control or a link inside the island never starts a move', () => {
  const f = engagementFixture(false); f.mutate(); f.seed('expanded');
  f.pressOn('a'); f.moveTo(800, 800); f.release();
  assert.deepEqual(f.moves(), []);
});

test('#421 a Ctrl+click press on a link never starts a drag: no drag_press, no toggle, no collapse verb (facade spy)', () => {
  const f = engagementFixture(false);
  f.mutate();
  f.seed('expanded');
  f.pressOn('#settings a');
  f.release();
  assert.equal(f.invocations.filter(i => i.cmd === 'drag_press').length, 0, 'the link owns its click: no native drag press');
  assert.equal(f.dragReleases().length, 0, 'no release to toggle the island');
  assert.deepEqual(f.desktopCalls.filter(c => c !== 'expand'), [], 'no collapse verb after the click');
});

test('#421 expanded links and the bare capsule never start an island press', () => {
  const f = engagementFixture(false);
  f.mutate(); f.seed('expanded');
  f.pressOn('a'); f.release(); f.press(); f.release();
  assert.equal(f.invocations.filter(i => /^drag_/.test(i.cmd)).length, 0);
  assert.deepEqual(f.desktopCalls, []);
});

test('#336 hover-open engagement and later presses never collapse the expanded island', () => {
  const f = engagementFixture(true);
  f.mutate(); f.enter();
  assert.deepEqual(f.desktopCalls, ['expand']);
  f.seed('expanded');
  f.press(); f.release(); f.click();
  f.press(); f.release(); f.click();
  assert.equal(f.dragReleases().length, 0);
  assert.deepEqual(f.desktopCalls, ['expand'], 'the click feed retains non-press auto-close policy');
});

test('#336 with hover-open off a compact press requests expansion, not a native toggle', () => {
  const f = engagementFixture(false);
  f.mutate(); f.enter();
  assert.deepEqual(f.desktopCalls, []);
  f.press(); f.release(); f.click();
  assert.deepEqual(f.desktopCalls, ['expand']);
  assert.equal(f.dragReleases().length, 0);
});

test('A04a shipped pin button toggles and resets when native collapse settles', () => {
  const f = engagementFixture(false); f.mutate(); f.seed('expanded');
  assert.equal(f.pin(), 'true'); assert.equal(f.pin(), 'false'); assert.equal(f.pin(), 'true');
  f.seed('compact'); f.seed('expanded'); assert.equal(f.pin(), 'true', 'collapse cleared the old pin');
});

// ---- #419: the approved countdown decoration surface -----------------------

test('#419 index.html carries exactly one aria-hidden hidden countdown element inside #island', () => {
  const html = read('index.html');
  assert.equal((html.match(/id="island-countdown"/g) || []).length, 1, 'exactly one countdown element');
  const el = html.match(/<div id="island-countdown"[^>]*><\/div>/);
  assert.ok(el, 'the element is an empty decoration div');
  assert.match(el[0], /aria-hidden="true"/, 'pure decoration: hidden from the tree');
  assert.match(el[0], / hidden/, 'starts hidden; only the view shows it');
  const island = html.indexOf('<div id="island">');
  const at = html.indexOf('id="island-countdown"');
  const header = html.indexOf('<header id="island-header"');
  assert.ok(island >= 0 && island < at && at < header, 'the bar lives inside #island, before the header');
  assert.doesNotMatch(el[0], /style=|onclick|on\w+=/, 'strict CSP: no inline style or handlers');
});

test('#419 island.js wires the published countdown into the guarded view (two spots only)', () => {
  const src = read('island.js');
  assert.equal((src.match(/createCountdownView\(/g) || []).length, 1, 'the view is created exactly once');
  assert.match(src, /document\.getElementById\('island-countdown'\)/, 'the approved element is the only surface');
  // guarded creation: a missing module, export or element keeps everything a no-op
  const creation = src.match(/const countdownView = [\s\S]*?;/);
  assert.ok(creation, 'one guarded view creation');
  assert.match(creation[0], /window\.AbitoIslandInteraction\s*&&/, 'module present');
  assert.match(creation[0], /createCountdownView/, 'export present');
  assert.match(creation[0], /countdownEl/, 'element present');
  assert.match(src, /onCountdown: value => \{ if \(countdownView\) countdownView\.update\(value\); \}/,
    'the hook renders the published value and nothing else');
  assert.doesNotMatch(src, /innerHTML/, 'no innerHTML anywhere (#411 unchanged)');
});

test('#419 style.css rules: theme tokens, transform token, reduced motion, no system media query', () => {
  const css = read('style.css');
  assert.ok(/#island-countdown \{/.test(css), 'the bar has rules');
  assert.match(css, /transform: scaleX\(var\(--island-countdown-fraction/, 'the fraction drives the shrink');
  const reduce = css.match(/html\[data-motion="reduce"\] #island-countdown[^{]*\{[^}]*\}/);
  assert.ok(reduce && /transition:\s*none/.test(reduce[0]), 'Abito owns reduced motion: reduce removes the transition');
  const block = css.match(/#island-countdown \{[^}]*\}/)[0];
  assert.match(block, /position:\s*absolute/, 'no layout shift: the bar never reflows the island');
  assert.match(block, /pointer-events:\s*none/, 'decoration never intercepts input');
  assert.match(block, /var\(--faint\)/, 'track uses an existing theme token');
  assert.match(block, /height:\s*3px/, '#437 D11: the design draws a 3 px countdown bar at the bottom (was 2 px)');
  assert.ok(/#island-countdown::before \{[^}]*var\(--island-live\)/.test(css), 'fill uses an existing theme token');
  assert.doesNotMatch(css.slice(css.indexOf('#island-countdown')), /@media[^{]*prefers-reduced-motion/,
    'no system media query: island.js paints data-motion');
});

const finishedNotice=id=>({id,kind:'settled',title:'Pi terminó',agent:'pi',projectName:id,detail:'No confirma éxito',at:Date.now(),expiresAt:Date.now()+60000});
test('A04c shipped finished opens its lane, holds 5200ms, then folds without dismissing (a HIDDEN island it revealed itself)',()=>{
  const f=engagementFixture(false); f.mutate(); f.seed('hidden'); f.update({notices:[finishedNotice('fresh')]});
  assert.equal(f.view(),'notices'); assert.ok(f.desktopCalls.includes('expand'),'a hidden island is revealed through the host verb');
  f.seed('expanded'); f.advance(5199); assert.equal(f.desktopCalls.includes('autoClose'),false);
  f.advance(1); assert.equal(f.view(),'overview'); assert.equal(f.desktopCalls.filter(x=>x==='autoClose').length,1); assert.equal(f.desktopCalls.includes('dismiss'),false);
});
// HU-006 (human: «que salga en la isla compactada y que no me lo agrande»; S4/S6): a compact island never grows by itself, and an
// island the human opens afterwards is theirs: the finished timer never folds it.
test('A04c HU-006: a finished notice on a compact island does not expand it, and a human-opened island is never auto-folded',()=>{
  const f=engagementFixture(false); f.mutate(); f.seed('compact'); f.update({notices:[finishedNotice('fresh')]});
  assert.equal(f.desktopCalls.includes('expand'),false,'S4: no automatic expand while compact');
  f.seed('expanded'); f.advance(5200);
  assert.equal(f.desktopCalls.includes('autoClose'),false,'S6: the human opened it; it is not folded for them');
  assert.equal(f.desktopCalls.includes('dismiss'),false);
});
for(const [name,protect] of [['human engagement',f=>f.click()],['pending request',f=>f.update({request:{}})],['transport failure',f=>f.update({unavailable:true})]]) test('A04c '+name+' prevents the finished timer collapsing the island',()=>{
  const f=engagementFixture(false); f.mutate(); f.seed('hidden'); f.update({notices:[finishedNotice('fresh')]}); f.seed('expanded'); protect(f); f.advance(5200);
  assert.equal(f.view(),'overview'); assert.equal(f.desktopCalls.includes('autoClose'),false);
});
test('A04c the finished pane selects the new tail, not the oldest retained notice',()=>{
  const f=engagementFixture(false); f.mutate(); f.seed('compact'); const old=finishedNotice('old'); f.update({notices:[old]}); f.seed('expanded');
  f.update({notices:[old,finishedNotice('fresh')]}); assert.equal(f.noticeName(),'fresh');
  f.ok(); assert.deepEqual(f.dismissed,['fresh'],'OK dismisses the displayed exact notice, never the oldest row');
});
test('A04c a user-opened overview returns from finished without auto-fold',()=>{
  const f=engagementFixture(false); f.mutate(); f.seed('expanded'); f.update({notices:[finishedNotice('fresh')]}); f.advance(5200);
  assert.equal(f.view(),'overview'); assert.equal(f.desktopCalls.includes('autoClose'),false);
});
// ---- auto-minimize (human: «abito se minimice después de un tiempo y no lo hace») ----------------------------------------------
test('B0 control: a quiet expanded island folds after Ajustes -> auto_close_seconds (15 s)', () => {
  const f = engagementFixture(false); f.mutate(); f.seed('expanded');
  f.advance(14999); assert.equal(f.desktopCalls.includes('autoClose'), false);
  f.advance(1); assert.equal(f.desktopCalls.filter(x => x === 'autoClose').length, 1);
});
test('B1 the pointer that left WITHOUT a pointerleave (input-shape change swallowed it) does not hold the island open', () => {
  const f = engagementFixture(false); f.mutate(); f.seed('expanded');
  f.enter();                      // the pointer was over the island...
  f.hover(false);                 // ...and WebKit now reports it is NOT hovering (no pointerleave was delivered)
  f.mutate();                     // any DOM/phase change re-feeds the facts
  f.advance(15000);
  assert.equal(f.desktopCalls.filter(x => x === 'autoClose').length, 1, 'the live :hover hit-test wins over a missed leave');
});
test('B2 a pointer that really is still over the island keeps it open (no regression)', () => {
  const f = engagementFixture(false); f.mutate(); f.seed('expanded');
  f.enter(); f.hover(true); f.mutate();
  f.advance(60000);
  assert.equal(f.desktopCalls.includes('autoClose'), false);
  f.leave(); f.hover(false); f.advance(15000);
  assert.equal(f.desktopCalls.filter(x => x === 'autoClose').length, 1, 'leaving restarts the full delay');
});
test('B3 a focused radio/checkbox of a structured question is not «editing text»; a text field still is', () => {
  const f = engagementFixture(false); f.mutate(); f.seed('expanded');
  f.focus({ type: 'checkbox', tag: 'input' }); f.mutate(); f.advance(15000);
  assert.equal(f.desktopCalls.filter(x => x === 'autoClose').length, 1, 'a checkbox holds no text');
});
test('B4 a text field that is hidden or inert (a closed question card) no longer holds the island open', () => {
  const f = engagementFixture(false); f.mutate(); f.seed('expanded');
  f.focus({ type: 'text', tag: 'textarea', hidden: true }); f.mutate(); f.advance(15000);
  assert.equal(f.desktopCalls.filter(x => x === 'autoClose').length, 1);
  const g = engagementFixture(false); g.mutate(); g.seed('expanded');
  g.focus({ type: 'text', tag: 'textarea' }); g.mutate(); g.advance(60000);
  assert.equal(g.desktopCalls.includes('autoClose'), false, 'a visible text field still protects what is being typed');
});
test('B5 the retired edge-hide delay is gone from the host too (isla-cualquier-lado S2)', () => {
  const prefs = fs.readFileSync(path.join(__dirname, '../src/prefs.rs'), 'utf8');
  assert.doesNotMatch(prefs, /ABSENCE_SECONDS|SetAbsenceSeconds|"set_absence_seconds"/, 'no stored edge-hide delay nor its command');
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../src/settingshost.rs'), 'utf8'), /absenceSeconds/, 'the settings view no longer projects it');
  assert.doesNotMatch(read('island.js'), /notice: !!\(current\?\.notices/, 'status notices do not feed the interaction guard');
});

// ---- live diagnosis: the controller's «why» is published on the capsule so the preview can be READ (human: «no se cumple») -------
test('C1 syncInteraction publishes capsule.dataset.autoClose = the controller\'s why, and the hover re-read, on every sync', () => {
  const f = engagementFixture(false); f.mutate(); f.seed('expanded');
  assert.match(f.capsule().dataset.autoClose, /^armado:\d+s$/);
  f.enter(); f.mutate(); assert.equal(f.capsule().dataset.autoClose, 'puntero-dentro');
  f.leave(); f.hover(false); f.mutate(); assert.match(f.capsule().dataset.autoClose, /^armado:/);
  f.advance(16000);
  assert.ok(f.desktopCalls.includes('autoClose'));
});
test('C2 the 1 s hover re-read is armed (setInterval) and runs only while the controller believes the pointer is inside', () => {
  const f = engagementFixture(false); f.mutate(); f.seed('expanded');
  assert.equal(f.intervals().length, 1, 'one interval');
  assert.equal(f.intervals()[0].ms, 1000);
  f.enter(); f.hover(false);
  f.tickIntervals();
  assert.match(f.capsule().dataset.autoClose, /^armado:/, 'the re-read cleared the stale «inside» without any other event');
});

// ---- island-free-drag S3/S4: compact Koda is ONLY the disc — it opens on a click, moves on a drag, and never pulls the pet ----
// isTrusted:true is HANDLER SIMULATION ONLY (the module's own rules stay in island-interaction-check.cjs); what is proven here is
// WHICH branch of the shipped handlers runs for a press on the character / on the disc.
test('S3: a press on the compact disc opens it on a click and moves it on a drag, through the host verbs only', () => {
  const click = engagementFixture(false); click.mutate(); click.seed('compact');
  click.pressAt(960, 16); click.release();
  assert.deepEqual(click.desktopCalls, ['expand'], 'a click opens the island');
  assert.deepEqual(click.moves(), [], 'a click never moves it');
  assert.equal(click.invocations.filter(i => /^drag_/.test(i.cmd)).length, 0, 'the compact press no longer reaches the native click path');
  const drag = engagementFixture(false); drag.mutate(); drag.seed('compact');
  drag.pressAt(960, 16); drag.moveTo(1000, 200); drag.release();
  assert.deepEqual(drag.moves().map(i => i.cmd), ['island_move_begin', 'island_move', 'island_move_end']);
  assert.deepEqual(drag.desktopCalls, [], 'a drag never opens it');
});

test('S3: a (legacy) wide compact view can never widen the disc, and the «Responder» pill is gone', () => {
  const f = engagementFixture(false); f.mutate(); f.seed('compact');
  f.compactView({ width: 560, activity: '¿Qué editor preferís?', reply: true, badge: 'question' });
  assert.equal(f.island().style.width, '40px', 'the disc is the whole compact island');
  assert.equal(f.island().style.height, '32px');
  const shape = f.shapes().at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(shape)), { w: 40, h: 32, settled: true }, 'the native input shape is the disc box');
  assert.doesNotMatch(read('index.html'), /id="compact-reply"/, 'no «Responder» control exists on the disc');
});

test('S4: dragging the CHARACTER of the compact disc moves the island; the pet never leaves while compact', () => {
  const f = engagementFixture(false, { pet: true }); f.mutate(); f.seed('compact');
  f.pressCharacter(20, 16, 960, 16);
  f.movePointer(120, 220, 1060, 220);
  f.release();
  assert.deepEqual(f.pet().picked, [], 'S4: compact never pulls the desktop character out');
  assert.deepEqual(f.moves().map(i => i.cmd), ['island_move_begin', 'island_move', 'island_move_end'], 'the disc is a handle');
  assert.deepEqual(f.desktopCalls, [], 'a move never expands');
  assert.equal(f.invocations.filter(i => /^drag_/.test(i.cmd)).length, 0, 'nor does it reach the native click path');
});

test('S4: on the OPEN island, dragging the character pulls the pet out and never moves the island', () => {
  const f = engagementFixture(false, { pet: true }); f.mutate(); f.seed('expanded');
  f.pressCharacter(60, 80, 800, 80);
  f.movePointer(200, 160, 940, 160);
  assert.deepEqual(f.pet().picked, [[60, 80]], 'the pet leaves only from the open island');
  assert.deepEqual(f.moves(), [], 'a pet pull-out never moves the island');
  f.movePointer(240, 200, 980, 200);
  assert.deepEqual(f.pet().carried, [[240, 200]], 'it follows the pointer');
  f.release();
  assert.equal(f.pet().ended.length, 1, 'and the release ends the carry');
  assert.deepEqual(f.desktopCalls, [], 'no expand/close while carrying the pet');
});

test('S4: with no pet available (already out / feature off) the character of the open island is a handle again', () => {
  const f = engagementFixture(false, { pet: { canPickUp: () => false } }); f.mutate(); f.seed('expanded');
  f.pressCharacter(60, 80, 800, 80); f.movePointer(200, 160, 940, 160); f.release();
  assert.deepEqual(f.pet().picked, []);
  assert.deepEqual(f.moves().map(i => i.cmd), ['island_move_begin', 'island_move', 'island_move_end']);
});

test('T7: on the OPEN island the visible Koda sprite is the character: dragging it pulls the pet out', () => {
  const f = engagementFixture(false, { pet: true }); f.mutate(); f.seed('expanded');
  f.pressSprite(60, 80, 800, 80); f.movePointer(200, 160, 940, 160);
  assert.deepEqual(f.pet().picked, [[60, 80]], 'grabbing the sprite of the open island pulls the pet out');
  assert.deepEqual(f.moves(), [], 'and never moves the island');
  f.release();
});

test('T7: on the compact disc the sprite is still the disc: dragging it moves the island, never the pet', () => {
  const f = engagementFixture(false, { pet: true }); f.mutate();
  f.pressSprite(20, 16, 960, 16); f.movePointer(20, 16, 1000, 300); f.release();
  assert.deepEqual(f.pet().picked, []);
  assert.deepEqual(f.moves().map(i => i.cmd), ['island_move_begin', 'island_move', 'island_move_end']);
});

test('T7: a focus blip (blur/pointercancel) while carrying the pet never drops it; the button release does, and a lost release ends it on the next move', () => {
  const f = engagementFixture(false, { pet: true }); f.mutate(); f.seed('expanded');
  f.pressSprite(60, 80, 800, 80); f.movePointer(200, 160, 940, 160);
  f.cancel(); f.blur();
  assert.equal(f.pet().ended.length, 0, 'the character window mapping under the pointer must not end the carry');
  f.movePointer(400, 300, 1140, 300);
  assert.deepEqual(f.pet().carried.slice(-1), [[400, 300]], 'it keeps following the pointer');
  f.release();
  assert.equal(f.pet().ended.length, 1, 'the real release ends it');
  const g = engagementFixture(false, { pet: true }); g.mutate(); g.seed('expanded');
  g.pressSprite(60, 80, 800, 80); g.movePointer(200, 160, 940, 160); g.movePointer(220, 180, 960, 180, 0);
  assert.equal(g.pet().ended.length, 1, 'a move without the button ends a carry whose release was lost');
});

console.log(`island-interaction-wiring-check: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

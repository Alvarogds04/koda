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
  for (const key of ['question:', 'approval:', 'request:', 'decision:', 'card:', 'dragging:', 'editing:', 'composing:', 'draft:', 'settings:', 'models:']) {
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
function engagementFixture(openOnHover) {
  const vm = require('node:vm');
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
        setProperty() {}, getPropertyValue() { return '1'; } },
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
      if (cmd === 'prefs_action') return resolved({ sound: false, avatarColors: {}, autoCloseSeconds: 15, openOnHover });
      if (cmd === 'hotkey_action') return resolved({ status: 'disabled' });
      if (cmd === 'question_action') return resolved({ available: false, pending: null });
      return resolved({});
    } } },
    desktop,
    document: documentStub,
  };
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
    // a press on an element that matches the real selector list (e.g. a link): closest honours the selector
    pressOn(tag) { fire(windowListeners, 'pointerdown', pointer({ type: 'pointerdown', ctrlKey: true,
      target: { closest: sel => (String(sel).split(',').map(x => x.trim()).includes(tag) ? {} : null) } })); },
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

for (const [name, card, blocked] of [
  ['expired', {state:'pending',reason:null,expires_at:'2000-01-01T00:00:00Z'}, false],
  ['pending', {state:'pending',reason:null,expires_at:'2099-01-01T00:00:00Z'}, true],
  ['inert', {state:'inert',reason:'closed',expires_at:'2099-01-01T00:00:00Z'}, false],
  ['invalid expiry', {state:'pending',reason:null,expires_at:'invalid'}, false],
]) test('edge card gate: ' + name, () => {
  const f=engagementFixture(false); f.update({card:{operation:'Read files',...card}}); f.seed('compact');
  assert.equal(f.permission().hidden, name === 'invalid expiry', 'expired/inert cards remain visible; invalid shape stays hidden');
  assert.equal(f.capsule().dataset.edgeWhy, blocked ? 'approval' : 'clear');
  f.advance(1000); assert.equal(f.capsule().dataset.edgeHidden, blocked ? undefined : 'true');
});
test('edge diagnostic is mirrored and transparent window hover is not pill hover', () => {
  const f=engagementFixture(false); f.seed('compact'); f.windowHover(true); f.pillHover(false); f.mutate();
  assert.equal(f.capsule().dataset.edgeWhy,'clear');
  f.pillHover(true); f.mutate(); assert.equal(f.capsule().dataset.edgeWhy,'pointer');
  f.pillHover(false); f.mutate(); assert.equal(f.capsule().dataset.edgeWhy,'clear');
});

for (const [surface, button] of [
  ['header home tab', true], ['header chat tab', true], ['gear', true], ['mute', true],
  ['pill', false], ['pill choice', false], ['Spotify np-pill', false],
  ['usage stat card', false], ['GitHub row', false], ['GitHub control', true], ['recap card', false], ['recap control', true],
  ['notice band', false], ['notice open button', true], ['notice dismiss button', true], ['notice clear button', true],
  ['session row', false], ['session ticker', false],
]) test('expanded press preserves the ' + surface + ' action without toggling or collapsing', () => {
  const f = engagementFixture(false); f.mutate(); f.seed('expanded');
  assert.equal(f.activateControl(surface, button), 1, 'the independently owned control action runs once');
  assert.equal(f.invocations.filter(i => /^drag_/.test(i.cmd)).length, 0, 'no island press/release IPC');
  assert.deepEqual(f.desktopCalls, [], 'no expand, close or auto-close');
});

test('a press on the collapsed bar expands immediately without a release toggle', () => {
  const f = engagementFixture(false); f.mutate();
  f.press();
  assert.deepEqual(f.desktopCalls, ['expand']);
  f.release();
  assert.equal(f.dragReleases().length, 0);
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
test('B5 the edge-hide setting is SECONDS (Ajustes -> General -> «Ocultar tras», absence_seconds 5..300, default 10; old minutes migrate)', () => {
  const prefs = fs.readFileSync(path.join(__dirname, '../src/prefs.rs'), 'utf8');
  assert.match(prefs, /ABSENCE_SECONDS: std::ops::RangeInclusive<u16> = 5\.\.=300/);
  assert.match(prefs, /ABSENCE_DEFAULT_SECONDS: u16 = 10/);
  assert.match(prefs, /\(minutes \* 60\)\.min\(\*ABSENCE_SECONDS\.end\(\)\)/);
  assert.match(read('island.js'), /absenceSeconds:p\.absenceSeconds \?\? 10/);
  assert.doesNotMatch(read('island.js'), /notice: !!\(current\?\.notices/, 'status notices no longer feed the edge guard');
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

console.log(`island-interaction-wiring-check: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

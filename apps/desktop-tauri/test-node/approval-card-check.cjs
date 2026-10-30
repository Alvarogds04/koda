'use strict';
// F013/F014 (#338) approval-card contracts at the public boundary: the fold
// control folds a waiting card to the compact island WITHOUT deciding it, and
// the card keeps its honest expiry/decision rendering. Host retirement rules
// (empty pending list / expired candidate) are pinned by Cargo in src/card.rs.
// No live sockets, browser or native window: the real controller runs on a
// minimal DOM and its public buttons only.
// Run: node apps/desktop-tauri/test-node/approval-card-check.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frontend = path.join(__dirname, '..', 'frontend');
const O = require(path.join(frontend, 'overview-view.js'));
const N = require(path.join(frontend, 'notify-view.js'));
const read = file => fs.readFileSync(path.join(frontend, file), 'utf8');
let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
};

const EXPIRES = '2099-01-01T00:00:00Z';
const pendingCard = () => ({ state: 'pending', reason: null, operation: 'git push --force', expires_at: EXPIRES });
const coveredCard = () => ({ state: 'inert', reason: 'Abrí la tarjeta para decidir.', operation: 'git push --force', expires_at: EXPIRES });

// Minimal DOM at the public event boundary: the real island controller, real
// desktop facade calls recorded, real buttons fired through its handlers.
function boot() {
  const nodes = new Map();
  class Element {
    constructor(id) { this.id = id; this.dataset = {}; this.style = { setProperty() {} }; this.attrs = {}; this.handlers = {}; this.hidden = false; this.inert = false; this.disabled = false; this.textContent = ''; this.classList = { add() {}, remove() {}, toggle() {} }; }
    before(el) { nodes.set(el.id, el); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] || null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(k, fn) { (this.handlers[k] ||= []).push(fn); }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 50, height: 50 }; }
    fire(kind, fields = {}) { for (const fn of this.handlers[kind] || []) fn({ preventDefault() {}, ...fields }); }
    focus() {}
    // #411: the shipped island writes icon NODES with replaceChildren, never markup.
    replaceChildren(...children) { this.children = children; }
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); };
  const events = {}, native = {}, calls = [], windowEvents = {}, timers = new Map();
  let timerId = 0;
  const setTimer = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; };
  const clearTimer = id => timers.delete(id);
  const doc = { getElementById: get, querySelectorAll: () => [], createElement: tag => new Element(tag), body: new Element('body'), documentElement: new Element('html'), addEventListener(k, fn) { (events[k] ||= []).push(fn); }, dispatchEvent(e) { for (const fn of events[e.type] || []) fn(e); } };
  const stateHandlers = [];
  const resolved = value => ({ then(fn) { if (fn) fn(value); return { catch() {} }; } });
  const window = {
    AbitoOverview: O, AbitoNotify: N, AbitoIcons: { svg: () => '', ring: () => '' },
    addEventListener(name, fn) { (windowEvents[name] ||= []).push(fn); },
    desktop: {
      onState(fn) { stateHandlers.push(fn); },
      snapshot() { return resolved(null); },
      click(payload) { calls.push(['click', payload]); return resolved(null); },
      dismiss() { calls.push(['dismiss']); return resolved(null); },
      expand() { calls.push(['expand']); return resolved(null); },
      close() { calls.push(['close']); return resolved(null); },
      allow() { calls.push(['allow']); return resolved(null); },
      deny() { calls.push(['deny']); return resolved(null); },
      choose(index) { calls.push(['choose', index]); return resolved(null); },
    },
    __TAURI__: { event: { listen(name, fn) { native[name] = fn; return { catch() {} }; } } },
  };
  window.AbitoCharacter = require(path.join(frontend, 'character-motion.js'));
  const h = require('./character-harness.cjs').engine();
  const clay = h.api.create(h.svg);
  const AbitoClay = { create: () => clay, get forced() { return h.api.forced; }, setForced: value => h.api.setForced(value), onChange: fn => h.api.onChange(fn) };
  get('capsule').dataset = { phase: 'compact', view: 'overview' };
  // #411: the shipped island parses its closed-registry icons, so the vm gets the
  // same DOMParser stub convention as test-node/pills-check.cjs:91.
  vm.runInNewContext(read('island.js'), { AbitoClay, window, document: doc,
    DOMParser: class { parseFromString() { const n = new Element('svg'); n.nodeName = 'svg'; return { documentElement: n }; } }, matchMedia: () => ({ matches: true, addEventListener() {} }), performance: { now: () => 0 }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: setTimer, clearTimeout: clearTimer, setInterval() {}, MutationObserver: class { observe() {} }, CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts.detail; } }, console });
  return { get, calls, window, native, clay, timers,
    fireWindow(name, event = {}) { for (const fn of windowEvents[name] || []) fn(event); },
    state(s) { for (const fn of stateHandlers) fn(s); } };
}

test('F014 R3: the pending card carries a fold control inside #permission', () => {
  const html = read('index.html');
  const permission = html.slice(html.indexOf('<div id="permission"'), html.indexOf('<div id="question"'));
  assert.ok(permission.length > 0, '#permission exists');
  assert.match(permission, /<button id="card-fold" class="icon-btn" type="button" aria-label="[^"]+"/, 'fold is a labelled icon button');
  assert.doesNotMatch(permission, /id="card-fold"[^>]*\son\w+=/, 'no inline handler: wiring stays in island.js');
  // hit area: .icon-btn is >=44x44, the fold control must ride that rule
  assert.match(read('style.css'), /\.icon-btn \{[^}]*min-width: 44px[^}]*min-height: 44px/s, 'icon buttons keep the 44px hit area');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]);
  assert.equal(new Set(ids).size, ids.length, 'binding IDs are unique');
});

test('F014 R3: fold collapses the island and never decides, drops, or answers', () => {
  const b = boot();
  b.state({ state: 'expanded', revision: 1, notices: [], card: pendingCard() });
  assert.equal(b.get('permission').hidden, false, 'the pending card is on screen');
  b.get('card-fold').fire('click', { isTrusted: false });
  assert.deepEqual(b.calls, [], 'an untrusted click reaches no host verb');
  b.get('card-fold').fire('click', { isTrusted: true });
  assert.equal(JSON.stringify(b.calls), JSON.stringify([['close']]), 'fold asks for collapse ONLY');
  assert.equal(b.get('permission').hidden, false, 'fold itself never drops the card');
  assert.equal(b.get('allow').disabled, b.get('deny').disabled, 'fold does not change the decision controls');
});

test('F014 R3: fold is inert while the island is not expanded', () => {
  const b = boot();
  b.state({ state: 'compact', revision: 1, notices: [], card: coveredCard() });
  b.get('card-fold').fire('click', { isTrusted: true });
  assert.deepEqual(b.calls, [], 'nothing to fold when the card is already compact');
});

test('F014 R3: a folded request keeps waiting and reopens with the same card', () => {
  const b = boot();
  b.state({ state: 'expanded', revision: 1, notices: [], card: pendingCard() });
  b.get('card-fold').fire('click', { isTrusted: true });
  // host answers the fold with the compact snapshot of the SAME request
  b.state({ state: 'compact', revision: 2, notices: [], card: coveredCard() });
  assert.equal(b.get('compact-flag').hidden, false, 'the folded request still shows the waiting flag');
  assert.equal(b.get('compact-flag').dataset.tone, 'sun');
  // reopening the island brings the same card back
  b.state({ state: 'expanded', revision: 3, notices: [], card: pendingCard() });
  assert.equal(b.get('permission').hidden, false, 'reopen brings the card back');
  assert.equal(b.get('operation').textContent, 'git push --force');
  assert.equal(JSON.stringify(b.calls), JSON.stringify([['close']]), 'reopen never decides anything either');
});

test('F013: an expired card keeps the honest reason with both verbs locked', () => {
  const b = boot();
  b.state({ state: 'expanded', revision: 1, notices: [], card: { state: 'inert', reason: 'Propuesta vencida.', operation: 'git push --force', expires_at: '2000-01-01T00:00:00Z' } });
  assert.equal(b.get('permission').hidden, false, 'the expired card stays honest and visible');
  assert.equal(b.get('card-reason').textContent, 'Propuesta vencida.');
  assert.equal(b.get('allow').disabled, true, 'no verb on an expired card');
  assert.equal(b.get('deny').disabled, true, 'no verb on an expired card');
  b.get('allow').fire('click', { isTrusted: true });
  b.get('deny').fire('click', { isTrusted: true });
  assert.deepEqual(b.calls, [], 'an expired card answers nothing');
});

test('decision lane untouched: allow/deny keep the zero-argument trusted-click contract', () => {
  const island = read('island.js');
  assert.match(island, /window\.desktop\[verb\]\(\)/, 'the card verb still sends zero arguments');
  assert.match(island, /event\.isTrusted !== true/, 'the trusted-click guard is intact');
  assert.doesNotMatch(island, /card-fold[^]{0,400}allow\(|card-fold[^]{0,400}deny\(/, 'fold never routes into the decision verbs');
});

console.log(`approval-card-check: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

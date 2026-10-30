'use strict';
// Production presentation contracts. No live sockets, browser or producer state.
// Run: node apps/desktop-tauri/test-node/coucou-presentation-check.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const frontend = path.join(__dirname, '..', 'frontend');
const O = require(path.join(frontend, 'overview-view.js'));
const N = require(path.join(frontend, 'notify-view.js'));
const read = file => fs.readFileSync(path.join(frontend, file), 'utf8');
const ID = '3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
};

test('approved live composition retains every existing binding and host script', () => {
  const html = read('index.html');
  for (const id of ['capsule', 'island', 'clay', 'island-toggle', 'open-chat', 'open-settings', 'notices', 'notice-open', 'notice-dismiss', 'permission', 'allow', 'deny', 'question', 'question-options', 'chat', 'models', 'settings', 'home-tab', 'overview-view'])
    assert.match(html, new RegExp(`id="${id}"`), id);
  for (const file of ['clay-engine.js', 'desktop.js', 'notify.js', 'chat.js', 'models.js', 'settings.js'])
    assert.match(html, new RegExp(`src="${file.replace('.', '\\.')}"`));
  assert.doesNotMatch(html, /preview\.js|harness-nav|data-permission-choice|style="/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]);
  assert.equal(new Set(ids).size, ids.length, 'binding IDs are unique');
});

test('Coucou tokens and card composition are present without replacing native sizing', () => {
  const css = read('style.css');
  assert.match(css, /--card-bg:\s*#141518/);
  assert.match(css, /--muted:\s*#8E939C/);
  assert.match(css, /#overview-view/);
  assert.match(css, /#notice-open/);
  assert.match(css, /#models-search/);
  assert.doesNotMatch(css, /transition:\s*all/);
  const island = read('island.js');
  assert.match(island, /CHAT\.w = vw; CHAT\.h = vh/);
  assert.match(island, /const W0 = 2 \* Math\.PI \/ 0\.5/);
  assert.match(island, /const ZETA = 0\.72/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(frontend, 'clay-engine.js'))).digest('hex'), '40625d7f968be882964e5b20b276921a99071b34ab4be75cfa4fdc35aac54fc7');
});

test('opener derives only strict UUID+kind from trusted input; legacy display remains', () => {
  const notice = { id: ID, title: 'Pi terminó su turno', expiresAt: Date.now() + 60000 };
  assert.deepEqual(N.openPayload({ isTrusted: true }, notice, 'finished'), { id: ID, kind: 'finished' });
  assert.deepEqual(N.openPayload({ isTrusted: true }, { id: ID }, 'question'), { id: ID, kind: 'question' });
  for (const event of [null, {}, { isTrusted: false }, { isTrusted: 1 }]) assert.equal(N.openPayload(event, notice, 'finished'), null);
  for (const id of ['catalogo-turno', ` ${ID}`, ID.toUpperCase(), '', null]) assert.equal(N.openPayload({ isTrusted: true }, { id }, 'finished'), null);
  assert.equal(N.openPayload({ isTrusted: true }, notice, 'approval'), null);
  assert(O.noticeView([{ ...notice, id: 'catalogo-turno' }], Date.now()), 'legacy notices still display');
  assert.equal(O.noticeOpenView({ id: ID, kind: 'question' }), 'question');
  assert.equal(O.noticeOpenView({ id: ID, kind: 'finished' }), 'notices');
  assert.equal(O.noticeOpenView({ id: ID, kind: 'approval' }), null);
  assert.equal(O.noticeOpenView({ id: 'catalogo-turno', kind: 'finished' }), null);
});

// ---- Visual correction V1 (VISUAL-AUDIT.md): sizing/placement contracts, source-level ----------
test('V1 D1: a question outcome is a 2-4s confirmation that returns to the previous view by itself', () => {
  const src = read('notify.js');
  const [ms] = /const OUTCOME_MS = (\d+)/.exec(src).slice(1).map(Number);
  const [problem] = /OUTCOME_PROBLEM_MS = (\d+)/.exec(src).slice(1).map(Number);
  assert(ms >= 2000 && ms <= 4000, `outcome ${ms}ms`);
  assert(problem >= ms && problem <= 4000, `problem outcome ${problem}ms`);
  assert.match(src, /view\.kind === 'outcome' && Date\.now\(\) >= outcomeUntil\) return \{ kind: 'none'/);
  assert.match(src, /trackOutcome\(previous, next\)/);
});

test('S10 header on top (replaces the V1 gutter): 720x34 header above the cards; the chat keeps it at 720; 44px hit tabs', () => {
  const css = read('style.css');
  const v1 = css.slice(css.indexOf('Visual correction V1'));
  const isl = read('vendor/coucou/island/island.css');
  assert.match(isl, /#island-header \{[^}]*top: 8px;[^}]*width: 720px; height: 34px;[^}]*flex-direction: row/);
  assert.match(isl, /#overview-view \{[^}]*width: 700px;[^}]*top: 42px;[^}]*height: 132px/);
  assert.match(isl, /#notices \{[^}]*width: 288px;[^}]*top: 42px;[^}]*height: 44px/);
  assert.match(isl, /#permission, #question \{[^}]*width: 700px;[^}]*top: 42px;[^}]*height: 132px/);
  assert.doesNotMatch(v1 + isl, /(#island-header|#overview-view|#notices|#question, #permission|#permission, #question)[^{}]*\{[^}]*(right: 72px|width: 56px)/, 'no rail gutter any more');
  // L32 #480: the chat now keeps the island's header (home / chat / «+», gear / mute) instead of hiding it
  assert.match(isl, /\[data-view="chat"\] #island-header \{\s*opacity: 1; visibility: visible; pointer-events: auto; left: calc\(50% - 360px\); width: 720px;/, 'the chat shows the shared header at the island width (640)');
  assert.match(isl, /#island-header \.tab, #island-header \.hdr-action \{[^}]*height: 44px/);
});

test('V1 dot: a panel left open can never move the dot character (scoped to the expanded chat view)', () => {
  const css = read('style.css');
  assert.doesNotMatch(css, /#capsule\[data-models="open"\] #clay, #capsule\[data-settings="open"\] #clay/);
  assert.match(css, /#capsule\[data-phase="expanded"\]\[data-view="chat"\]\[data-models="open"\] #clay/);
  assert.match(read('island.js'), /new CustomEvent\('island:view', \{ detail: 'overview' \}\)/);
});

test('V1 type ramp: roles are tokens (>=12px floor) and the V1 block declares no raw px font-size', () => {
  const full = read('style.css');
  // T6.1 (design §1): the ramp is declared EARLY (top of file, before any rule that uses it) and
  // comes with the spacing scale. Exact tokens and exact numbers, pinned:
  const tokens = /:root \{ --fs-title: (\d+)px; --fs-body: (\d+)px; --fs-label: (\d+)px; --fs-caption: (\d+)px; --space-4: (\d+)px; --space-8: (\d+)px; --space-12: (\d+)px; --space-16: (\d+)px; --space-20: (\d+)px; --space-24: (\d+)px; --space-32: (\d+)px; \}/.exec(full);
  assert(tokens, 'early token declaration: --fs-title/body/label/caption + --space-4..32, one block');
  assert.deepEqual(tokens.slice(1, 5).map(Number), [16, 14, 13, 12], 'type ramp 12/13/14/16 only');
  assert.deepEqual(tokens.slice(5).map(Number), [4, 8, 12, 16, 20, 24, 32], 'spacing scale 4·8·12·16·24·32 (+16)');
  for (const v of tokens.slice(1, 5).map(Number)) assert(v >= 12, `token ${v}px`);
  assert(full.indexOf('--fs-title') < full.indexOf('#capsule'), 'the ramp is declared before the rules that use it');
  const css = full.slice(full.indexOf('Visual correction V1 (TaskView'));
  assert.doesNotMatch(css, /font-size:\s*\d/, 'raw px font-size in the V1 block');
  assert(/var\(--fs-body\)/.test(css) && /var\(--fs-label\)/.test(css) && /var\(--fs-caption\)/.test(css));
});

test('S10 island type scale: Coucou\'s exact sizes (windows/src/style.css @434d6a2b) on island surfaces; chat and settings keep the V1 ramp', () => {
  const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const literal = read('vendor/coucou/island/island.css').replace(/\/\*[\s\S]*?\*\//g, '');
  // Adapted from Coucou windows/src/style.css @434d6a2b: .who .name 12, .who .tool 11, .chip 11.5, .btn / .bubble 12.5, .diff-note 10.5, status 13.
  const scale = { '--cc-fs-name': '12px', '--cc-fs-detail': '11px', '--cc-fs-chip': '11.5px', '--cc-fs-body': '12.5px', '--cc-fs-state': '13px', '--cc-fs-note': '10.5px' };
  const block = /:root \{ --cc-fs-name: ([\d.]+)px; --cc-fs-detail: ([\d.]+)px; --cc-fs-chip: ([\d.]+)px; --cc-fs-body: ([\d.]+)px; --cc-fs-state: ([\d.]+)px; --cc-fs-note: ([\d.]+)px; \}/.exec(css);
  assert(block, 'one :root block declares the Coucou scale');
  assert.deepEqual(block.slice(1).map(Number), [12, 11, 11.5, 12.5, 13, 10.5].map(Number));
  assert.deepEqual(Object.values(scale).length, 6);
  const from = css.lastIndexOf('.agentline { font-size: var(--cc-fs-name)');
  const tail = css.slice(from, css.indexOf('#settings-body[data-screen="accounts"]', from));
  for (const sel of ['.agentline', '.overview-detail', '.pill-summary', '#notice-row .chip', '#notice-title', '#notice-sub', '#notice-action', '#notice-list-title', '.notice-list-title', '.notice-list-time', '#card-head .chip', '#question-asker', '#question-body', '#question-skip', '.q-option', '#permission #operation', '#allow, #deny', '#card-wait', '.minibot', '.pill-choice'])
    assert((tail + literal).includes(sel), `${sel} is on the Coucou scale`);
  assert.doesNotMatch(tail, /font-size:\s*\d|font:\s*\d+\s+\d/, 'the block uses only the --cc-fs-* tokens');
  assert.match(literal, /\.agentline strong \{ font: 600 12px/); assert.match(literal, /\.overview-detail \{[^}]*font: 500 13px/); assert.match(literal, /\.btn|#allow, #deny, \.q-option \{[^}]*font: 500 12\.5px/);
  for (const chat of ['#chat', '#settings', '#models']) assert(!tail.includes(chat), `${chat} untouched (S10: chat stays Abito's)`);
});

test('V1 icon: the settings glyph is a cog (closed 8-tooth outline + hub), stroke-only, not the old sun/asterisk', () => {
  const I = require(path.join(frontend, 'icons.js'));
  const svg = I.svg('gear');
  assert.match(svg, /viewBox="0 0 20 20"/);
  assert.match(svg, /fill="none"/);
  assert.match(svg, /<path d="M[^"]*z"\/>/, 'closed outline');
  assert.equal((svg.match(/L/g) || []).length, 31, '8 teeth x 4 points, one move');
  assert.match(svg, /<circle cx="10" cy="10" r="2\.6"\/>/, 'hub');
  assert.doesNotMatch(svg, /M10 2\.5v2/, 'the old radiating strokes are gone');
  assert(!/fill="(?!none)/.test(svg), 'no filled shapes');
});

// Minimal DOM at the public event boundary: execute the real island controller,
// deliver desktop snapshots/native-open events and activate its real buttons.
function boot() {
  const nodes = new Map();
  class Element {
    constructor(id) { this.id = id; this.dataset = {}; this.style = { setProperty() {} }; this.attrs = {}; this.handlers = {}; this.hidden = false; this.inert = false; this.disabled = false; this.classList = { add() {}, remove() {}, toggle() {} }; }
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
  const window = { AbitoOverview: O, AbitoNotify: N, AbitoIcons: { svg: () => '', ring: () => '' }, addEventListener(name, fn) { (windowEvents[name] ||= []).push(fn); }, desktop: { onState(fn) { stateHandlers.push(fn); }, snapshot() { return resolved(null); }, click(payload) { calls.push(['click', payload]); return resolved(null); }, dismiss() { calls.push(['dismiss']); return resolved(null); }, expand() { calls.push(['expand']); return resolved(null); }, close() { calls.push(['close']); return resolved(null); }, allow() { calls.push(['allow']); return resolved(null); }, deny() { calls.push(['deny']); return resolved(null); } }, __TAURI__: { event: { listen(name, fn) { native[name] = fn; return { catch() {} }; } } } };
  window.AbitoCharacter = require(path.join(frontend, 'character-motion.js'));
  const h = require('./character-harness.cjs').engine();
  const clay = h.api.create(h.svg);
  const AbitoClay = { create: () => clay, get forced() { return h.api.forced; }, setForced: value => h.api.setForced(value), onChange: fn => h.api.onChange(fn) };
  get('capsule').dataset = { phase: 'compact', view: 'overview' };
  // #411: the shipped island parses its closed-registry icons, so the vm gets the
  // same DOMParser stub convention as test-node/pills-check.cjs:91.
  vm.runInNewContext(read('island.js'), { AbitoClay, window, document: doc,
    DOMParser: class { parseFromString() { const n = new Element('svg'); n.nodeName = 'svg'; return { documentElement: n }; } }, matchMedia: () => ({ matches: true, addEventListener() {} }), performance: { now: () => 0 }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: setTimer, clearTimeout: clearTimer, setInterval() {}, clearInterval() {}, MutationObserver: class { observe() {} }, CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts.detail; } }, console });
  return { get, calls, window, native, clay, timers,
    fireWindow(name, event = {}) { for (const fn of windowEvents[name] || []) fn(event); },
    state(s) { for (const fn of stateHandlers) fn(s); } };
}

test('R7 live public producer routing uses isolated capped timers, cancels on pagehide, preserves 2099 expiry', () => {
  const b = boot();
  b.state({ state: 'expanded', motionOverride: true, revision: 1, notices: [],
    card: { state: 'pending', reason: null, operation: 'live operation', expires_at: '2099-01-01T00:00:00Z' } });
  assert.equal(b.clay.state, 'approval');
  assert.ok([...b.timers.values()].some(t => t.ms === 2147483647));
  b.native['question:state']({ payload: { available: true, pending: { id: ID, kind: 'question', text: 'Real question',
    options: [{ index: 0, label: 'Choice' }], expires_at: Date.now() + 60000 } } });
  assert.equal(b.clay.state, 'approval', 'backend card still wins');
  b.state({ state: 'expanded', revision: 2, notices: [] }); assert.equal(b.clay.state, 'question');
  b.native['question:state']({ payload: { available: true, pending: null } }); assert.equal(b.clay.state, 'idle');
  b.state({ state: 'expanded', motionOverride: true, revision: 3, notices: [],
    card: { state: 'pending', reason: null, operation: 'live operation', expires_at: '2099-01-01T00:00:00Z' } });
  b.fireWindow('pagehide'); assert.ok(![...b.timers.values()].some(t => t.ms === 2147483647));
  assert.deepEqual(b.calls, [], 'producer observation never answers/approves or navigates');
});

test('trusted opener and separate dismiss never answer, approve, or fall back to expand', () => {
  const b = boot();
  b.state({ state: 'expanded', connections: 1, revision: 1, notices: [{ id: ID, title: 'Pi terminó su turno', detail: 'live', expiresAt: Date.now() + 60000 }] });
  b.get('notice-open').fire('click', { isTrusted: false });
  assert.deepEqual(b.calls, []);
  b.get('notice-open').fire('click', { isTrusted: true });
  assert.deepEqual(b.calls, [], 'Avisos opens a local inbox, not native detail');
  assert.equal(b.get('capsule').dataset.noticeList, 'open');
  b.get('notice-dismiss').fire('click', { isTrusted: true });
  assert.equal(JSON.stringify(b.calls), JSON.stringify([['dismiss']]));
  assert.equal(b.get('capsule').dataset.noticeView, undefined, 'request itself does not change view: native approval is required');
});

test('native confirmed open suppresses unrelated approval; question stays above finished', () => {
  const b = boot();
  b.state({ state: 'expanded', motionOverride: false, connections: 1, revision: 1, notices: [{ id: ID, title: 'done', expiresAt: Date.now() + 60000 }], card: { state: 'pending', reason: null, operation: 'unrelated', expires_at: '2099-01-01T00:00:00Z' } });
  b.window.__islandSetState('overview', 'top');
  assert.equal(typeof b.native['desktop:notice-open'], 'function');
  for (const payload of [{ id: ID, kind: 'approval' }, { id: 'catalogo-turno', kind: 'finished' }, null]) {
    b.native['desktop:notice-open']({ payload });
    assert.equal(b.get('capsule').dataset.noticeView, undefined, 'malformed native display intent changes nothing');
    assert.equal(b.get('permission').hidden, false);
    assert.deepEqual(b.calls, []);
  }
  b.native['desktop:notice-open']({ payload: { id: ID, kind: 'finished' } });
  assert.equal(b.get('capsule').dataset.view, 'notices');
  assert.equal(b.get('permission').hidden, true);
  assert.equal(b.get('permission').inert, true);
  assert.equal(b.get('allow').disabled, true);
  assert.equal(N.onScreen(b.get('capsule').dataset), true, 'R23: questions paint above notices too');
  b.get('allow').fire('click', { isTrusted: true });
  b.get('deny').fire('click', { isTrusted: true });
  assert.deepEqual(b.calls, []);
  b.native['desktop:notice-open']({ payload: { id: ID, kind: 'question' } });
  assert.equal(b.get('capsule').dataset.view, 'overview', 'existing live question controller view contract');
  assert.equal(b.get('capsule').dataset.noticeView, 'question');
  assert.equal(b.get('capsule').dataset.card, undefined, 'unrelated approval cannot cover live question');
  assert.equal(N.onScreen(b.get('capsule').dataset), true);
  assert.deepEqual(b.calls, []);
  b.window.__islandSetView('chat', 380, 500);
  assert.equal(b.get('capsule').dataset.noticeView, undefined, 'ordinary navigation exits the notice lane');
  assert.equal(b.get('capsule').dataset.view, 'chat');
});
test('vertical Model search filters live rows without selecting, refreshing, or changing readiness', () => {
  const b = boot();
  const ready = b.get('ready-row'), unavailable = b.get('unavailable-row');
  ready.textContent = 'Qwen listo'; unavailable.textContent = 'Llama No disponible';
  ready.dataset.ready = 'true'; unavailable.dataset.ready = 'false';
  b.get('models-list').querySelectorAll = () => [ready, unavailable];
  b.get('models-search').value = ' qWeN ';
  b.get('models-search').fire('input');
  assert.equal(ready.hidden, false); assert.equal(unavailable.hidden, true);
  assert.equal(ready.dataset.ready, 'true'); assert.equal(unavailable.dataset.ready, 'false');
  b.get('models-search').value = '';
  b.get('models-search').fire('input');
  assert.equal(ready.hidden, false); assert.equal(unavailable.hidden, false);
  assert.deepEqual(b.calls, []);
});
console.log(`coucou-presentation-check: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

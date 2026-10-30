'use strict';
// #345 production scripts at the DOM/event boundary. Local fake DOM/IPC only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const frontend = path.join(__dirname, '../frontend');
const M = require(path.join(frontend, 'pills.js'));
const read = file => fs.readFileSync(path.join(frontend, file), 'utf8');
const clone = value => {
  try { return JSON.parse(JSON.stringify(value)); }
  catch (cause) { throw new Error('test fixture must be JSON serializable', { cause }); }
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function boot({ prefs = {}, failView = false, deferView = false, store = null, specs = [], extraPrefs = {}, settingsLabel = 'settings', github = false } = {}) {
  const nodes = new Map(), events = {}, native = {}, calls = [], observers = [], frames = new Map();
  let frameAt = 0, nextFrame = 1;
  let doc;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.nodeName = this.tagName;
      this.children = []; this.dataset = {}; this.attrs = {}; this.handlers = {};
      this.style = { setProperty() {} }; this.hidden = false; this.disabled = false;
      this.inert = false; this.value = ''; this.scrollTop = 0; this._text = '';
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    set textContent(text) { this._text = String(text); this.children = []; }
    get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
    append(...items) { for (const item of items) { const n = typeof item === 'string' ? Object.assign(new Element('#text'), { textContent: item }) : item; this.children.push(n); n.parentNode = this; } }
    appendChild(item) { this.append(item); return item; }
    replaceChildren(...items) { this.replaceCalls = (this.replaceCalls || 0) + 1; this.textContent = ''; this.append(...items); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(k, fn) { (this.handlers[k] ||= []).push(fn); }
    contains(node) { return this === node || this.children.some(x => x.contains(node)); }
    querySelectorAll(selector) {
      const found = [];
      const matches = n => selector === 'button' ? n.tagName === 'BUTTON' : selector === '[data-icon]' ? !!n.dataset.icon : /^#/.test(selector) ? n.id === selector.slice(1) : n.getAttribute('role') === /role="([^"]+)/.exec(selector)?.[1];
      const visit = n => { for (const c of n.children) { if (matches(c)) found.push(c); visit(c); } };
      visit(this); return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { doc.activeElement = this; }
    fire(type, extra = {}) { const event = { type, target: this, isTrusted: true, preventDefault() {}, stopPropagation() {}, ...extra }; for (const fn of this.handlers[type] || []) fn(event); }
  }
  const root = new Element();
  for (const match of read('index.html').matchAll(/id="([^"]+)"/g)) {
    const node = new Element(); node.id = match[1]; nodes.set(node.id, node); root.append(node);
  }
  const get = id => nodes.get(id) || root.querySelector(`#${id}`);
  doc = { activeElement: null, body: root, documentElement: new Element(), getElementById: get,
    createElement: tag => Object.assign(new Element(tag), { ownerDocument: doc }), importNode: node => node, createElementNS: (_ns, tag) => Object.assign(new Element(tag), { ownerDocument: doc }),
    addEventListener(type, fn) { (events[type] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of events[event.type] || []) fn(event); }, querySelectorAll: () => [] };
  const backend = { specs: { v: 1, active: null, persisted: true, load_error: false, specialists: specs.map(x => ({ space: null, spaces: [], permissions: ['read'], model: null, ...x })) },
    prefs: { sound: false, gain: 0.12, avatarColors: {}, islandAgents: null, abitoInstructions: null, ...M.normalize(prefs), ...extraPrefs }, rejectNext: false, rejectSpec: false, specCalls: [], pendingView: null, writes: 0, publications: 0 };
  const window = { addEventListener() {}, __TAURI__: {
    core: { invoke(cmd, { payload }) {
      calls.push({ cmd, payload: clone(payload) });
      if (cmd === 'github_action' && github) {
        const answer = backend.githubAvailable === false ? { available: false, reason: 'gh_not_signed_in' } : { available: true,
          pulse: { login: 'me', myPRs: [], toReview: [], mainCI: [] }, activity: { weeks: [], total: 17 } };
        return Promise.resolve(clone(answer));
      }
      if (cmd === 'prefs_action') {
        if (payload.action === 'view') {
          if (deferView) return new Promise(resolve => { backend.pendingView = resolve; });
          return failView ? Promise.reject(new Error('no ipc')) : Promise.resolve(clone(backend.prefs));
        }
        if (backend.rejectNext) { backend.rejectNext = false; return Promise.reject(new Error('save_failed')); }
        if (backend.holdGain && payload.action === 'set_sound_gain') {
          backend.holdGain = false; backend.writes++;
          return new Promise(resolve => { backend.releaseGain = () => { backend.prefs.gain = payload.gain; resolve(clone(backend.prefs)); }; });
        }
        const before = JSON.stringify(backend.prefs);
        const next = payload.action === 'set_main_pill' ? M.chooseMain(backend.prefs, payload.id) : payload.action === 'toggle_declared_pill' ? M.toggle(backend.prefs, payload.id) : payload.action === 'set_pill_color' ? M.setColor(backend.prefs, payload.id, payload.color) : payload.action === 'clear_pill_color' ? M.clearColor(backend.prefs, payload.id) : payload.action === 'create_blob' ? M.createBlob(backend.prefs, payload.name, payload.color || '') : payload.action === 'delete_blob' ? M.deleteBlob(backend.prefs, payload.name) : payload.action === 'set_blob_color' ? M.setBlobColor(backend.prefs, payload.name, payload.color) : payload.action === 'reorder_declared_pills' ? M.reorderDeclared(backend.prefs, payload.order) : payload.action === 'reorder_blobs' ? M.reorderBlobs(backend.prefs, payload.order) : null;
        if (next) Object.assign(backend.prefs, next);
        else if (payload.action === 'sound_on') backend.prefs.sound = true;
        else if (payload.action === 'sound_off') backend.prefs.sound = false;
        else if (payload.action === 'set_sound_gain') backend.prefs.gain = payload.gain;
        else if (payload.action === 'set_display_name') backend.prefs.displayName = payload.display_name.trim();
        else if (payload.action === 'set_avatar_color') backend.prefs.avatarColors[payload.identity] = payload.color;
        else if (payload.action === 'set_island_agents') {
          if (!Array.isArray(payload.order) || payload.order.length > 3 || new Set(payload.order).size !== payload.order.length) return Promise.reject(new Error('invalid_schema'));
          backend.prefs.islandAgents = payload.order;
        }
        else if (payload.action === 'set_abito_instructions') backend.prefs.abitoInstructions = payload.text.trim() || null;
        else if (payload.action === 'set_island_interaction') { backend.prefs.autoCloseSeconds = payload.auto_close_seconds; backend.prefs.openOnHover = payload.open_on_hover; }
        else if (payload.action === 'set_settings_window') backend.prefs.settingsWindow = payload.settings_window === true;
        else return Promise.reject(new Error('invalid_schema'));
        if (JSON.stringify(backend.prefs) !== before) {
          backend.writes++; backend.publications++;
          const snapshot = clone(backend.prefs);
          queueMicrotask(() => { for (const fn of native['prefs:state'] || []) fn({ payload: snapshot }); });
        }
        return Promise.resolve(clone(backend.prefs));
      }
      if (cmd === 'specialists_action') {
        const sp = backend.specs;
        if (payload.action === 'view') return Promise.resolve(clone(sp));
        if (backend.rejectSpec) { backend.rejectSpec = false; return Promise.reject(new Error('invalid_specialist')); }
        if (payload.action === 'create') sp.specialists.push({ id: payload.id, name: payload.name, instructions: payload.instructions, model: payload.model, space: null, spaces: [], permissions: ['read'] });
        else if (payload.action === 'update') Object.assign(sp.specialists.find(x => x.id === payload.id), { name: payload.name, instructions: payload.instructions, model: payload.model });
        else if (payload.action === 'select') sp.active = payload.id;
        else if (payload.action === 'delete') { if (sp.active === payload.id) sp.active = null; sp.specialists = sp.specialists.filter(x => x.id !== payload.id); if (backend.prefs.islandAgents) backend.prefs.islandAgents = backend.prefs.islandAgents.filter(x => x !== payload.id); }
        else return Promise.reject(new Error('invalid_schema'));
        backend.specCalls.push(clone(payload));
        return Promise.resolve(clone(sp));
      }
      if (cmd === 'models_action') return payload.action === 'list' ? Promise.resolve({ profiles: [{ profile_id: 'gpt-5.1', alias: 'gpt-5.1 · ChatGPT', selectable: true }], selected: backend.model || 'gpt-5.1' })
        : (backend.model = payload.profile_id, Promise.resolve({ profiles: [{ profile_id: 'gpt-5.1', alias: 'gpt-5.1 · ChatGPT', selectable: true }], selected: backend.model }));
      if (cmd === 'agent_action' && payload.action === 'abito_account_remove' && store) return store.remove(payload.accountId);
      if (cmd === 'agent_action' && store && ['abito_account_create', 'abito_account_save', 'abito_account_endpoint_set'].includes(payload.action)) return Promise.resolve({ ownedAccounts: store.apply(payload) });
      if (cmd === 'agent_action' && payload.action === 'view') return Promise.resolve({ connection: 'no_daemon', ownedAccounts: store ? store.view() : undefined });
      if (cmd === 'agent_action' && payload.action === 'sessions_list') return Promise.resolve({ connection: 'connected', sessions: { rows: backend.sessionRows || [], truncated: false } });
      if (cmd === 'focus_host') return Promise.resolve({ focused: false, reason: 'No se encontró una terminal.' });
      if (cmd === 'hotkey_action' && payload.action === 'view') return Promise.resolve({ enabled: false });
      return Promise.reject(new Error('unexpected IPC'));
    } },
    event: { listen(name, fn) { (native[name] ||= []).push(fn); return Promise.resolve(() => {}); } },
  } };
  window.AbitoSessionsTicker = require('../frontend/sessions-ticker.js');
  const intervals = new Map(); let nextInterval = 1;
  const leftCard = new Element();
  get('overview-view').querySelector = selector => selector === '.card-left' ? leftCard : null;
  window.testGithubView = { hooks: {}, githubPulseCard: (_p, _e, activity) => {
    const card = new Element(); card.textContent = 'GitHub ' + (activity?.total ?? ''); return card;
  } };
  const ctx = vm.createContext({ setInterval(fn) { const id = nextInterval++; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); }, MutationObserver: class { constructor(fn) { this.fn = fn; } observe(target) { observers.push({ target, fn: this.fn }); } }, matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, performance: { now: () => frameAt }, cancelAnimationFrame(id) { frames.delete(id); }, window, self: window, document: doc, navigator: { userAgent: 'Linux' },
    DOMParser: class { parseFromString() { const n = new Element('svg'); n.nodeName = 'svg'; return { documentElement: n }; } },
    crypto: require('node:crypto').webcrypto, requestAnimationFrame: fn => { const id = nextFrame++; if (fn.name === 'frame') frames.set(id, fn); else fn(frameAt); return id; }, setTimeout: () => 1, clearTimeout() {}, queueMicrotask,
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    Event: class { constructor(type) { this.type = type; } }, console });
  const load = file => {
    if (file === 'settings.js') window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: settingsLabel } } };
    const source = file === 'island-github.js' ? read(file).replace("import('./vendor/coucou/views/github.js')", 'Promise.resolve(window.testGithubView)') : file === 'sessions-ticker.js' ? read(file).replace("import('./vendor/coucou/views/ticker.js')", 'Promise.resolve({Ticker:class {constructor(){this.el=document.createElement("div");this.animating=false;} sync(task){this.task=task;} tick(){} }})') : read(file);
    return vm.runInContext(source, ctx, { filename: file });
  };
  for (const file of ['clay-engine.js', 'pill-catalog.js', 'avatar-colors.js', 'pills.js', 'icons.js', 'pills-view.js', 'specialists-view.js']) load(file);
  vm.runInContext(`const testedClays = []; const realCreate = AbitoClay.create; AbitoClay.create = (...args) => { const instance = realCreate(...args); testedClays.push(instance); const destroy = instance.destroy; instance.destroy = () => { instance.testDestroyed = true; destroy(); }; return instance; };`, ctx);
  get('capsule').dataset = { phase: 'expanded', view: 'overview' };
  const emit = value => { backend.prefs = { ...backend.prefs, ...value }; for (const fn of native['prefs:state'] || []) fn({ payload: clone(backend.prefs) }); };
  return { leftCard, intervals, advanceFrames(n = 1) { for (let i = 0; i < n; i++) { frameAt += 17; const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(frameAt); } }, mutate(target) { for (const o of observers) if (o.target === target) o.fn([]); }, clayStatus: () => vm.runInContext('testedClays', ctx), get, calls, backend, doc, events, load, window, emit, click(id, fields) { assert.ok(get(id), id); if (id === 'open-screen-settings') doc.dispatchEvent({ type: 'abito:settings-select', detail: 'open' }); else get(id).fire('click', fields); } };
}

test('A02b session pills focus projects without changing the conversation target; main preference selects its live source', async () => {
  const b = boot({ extraPrefs: { mainPill: 'integration_claude', declaredPills: ['agent_codex'], pillColors: { agent_codex: '#2DD4BF' } } }); await flush();
  const T = b.window.AbitoSessionsTicker;
  const view = T.sessionsView({ type: 'sessions', schema: T.SCHEMA, truncated: false, sessions: [
    { id: 's-11111111', kind: 'claude-code', cwd: 'alpha', origin: null, state: 'running' },
    { id: 's-22222222', kind: 'codex', cwd: 'beta', origin: null, state: 'sleeping' },
  ] });
  const requests = [];
  b.doc.addEventListener('abito:session-select', e => requests.push(e.detail.id));
  const publish = id => b.doc.dispatchEvent({ type: 'abito:sessions-view', detail: { view, focusId: id } });
  publish('s-11111111');
  assert.ok(b.get('pill-choice-s-22222222'), 'the other project appears in the grid');
  // A+E: the focused session STAYS a row of the blobs column (marked pressed): the centre shows it and the human needs the row to know
  // which one it is. (Never pass a DOM node to assert.equal: a failing diff of a node graph exhausts the heap.)
  assert.ok(b.get('pill-choice-s-11111111') !== null, 'the focused session keeps its row');
  assert.equal(b.get('pill-choice-s-11111111').getAttribute('aria-pressed'), 'true', 'and it is the pressed one');
  b.click('pill-choice-s-22222222', { isTrusted: false }); assert.equal(requests.length, 0);
  b.click('pill-choice-s-22222222'); assert.equal(requests.at(-1), 's-22222222');
  publish('s-22222222');
  assert.equal(b.get('pill-name').textContent, 'beta');
  assert.equal(b.backend.specCalls.length, 0, 'focusing a project never changes chat destination');
  b.emit({ mainPill: 'integration_claude' });
  b.emit({ mainPill: 'agent_codex' });
  assert.equal(requests.at(-1), 's-22222222');
  assert.equal(b.get('pill-choices').children.length <= 4, true);
});

test('A02b trusted mini/pill focus updates the card; jump always opens a terminal', async () => {
  const b = boot({ extraPrefs: { mainPill: 'integration_claude', declaredPills: ['agent_codex', 'integration_n8n'] } }); await flush();
  b.backend.sessionRows = [
    { id: 's-11111111', kind: 'pi', cwd: 'alpha', origin: null, state: 'running', tools: { total: 1, steps: [{ index: 1, name: 'read', state: 'done' }] } },
    { id: 's-22222222', kind: 'codex', cwd: 'beta', origin: null, state: 'sleeping' },
  ];
  b.load('sessions-ticker.js'); await flush(); await flush();
  const who = () => b.leftCard.children.find(n => n.className === 'who').children[1].textContent;
  const jump = b.leftCard.children.find(n => n.id === 'session-jump');
  assert.equal(who(), 'alpha');
  b.doc.dispatchEvent({ type: 'abito:integration-seen', detail: { ids: ['integration_n8n'] } });
  b.click('pill-choice-integration_n8n');
  assert.equal(jump.hidden, true);
  assert.equal(b.get('mini-grid').getAttribute('aria-hidden'), 'false', 'interactive minis must be exposed to assistive technology');
  const mini = b.get('mini-grid').children[1];
  assert.equal(mini.style.pointerEvents, 'auto', 'mini controls must override the decorative grid hit mask');
  mini.fire('click', { isTrusted: false }); assert.equal(who(), 'alpha');
  mini.fire('click'); assert.equal(who(), 'beta');
  assert.equal(jump.hidden, false, 'mini clears service focus');
  assert.equal(b.get('pill-name').textContent, 'beta');
  b.click('pill-choice-s-11111111'); assert.equal(who(), 'alpha');
  assert.ok(jump); assert.match(jump.getAttribute('aria-label'), /Abrir una terminal/); assert.doesNotMatch(jump.getAttribute('aria-label') + jump.title, /por clase/);
  assert.equal(jump.style.pointerEvents, 'auto', 'jump must override the overview display-only hit mask');
  jump.fire('click', { isTrusted: false }); await flush();
  assert.equal(b.calls.filter(c => c.cmd === 'focus_host').length, 0);
  jump.fire('click'); await flush();
  // the focused session's own key travels (the daemon's row id): Rust finds THAT session's terminal from /proc
  assert.deepEqual(b.calls.find(c => c.cmd === 'focus_host').payload, { target: 'terminal', session: 's-11111111' });
  b.emit({ mainPill: 'agent_codex' }); assert.equal(who(), 'beta');
  assert.equal(b.backend.specCalls.length, 0);
});

test('the ↗ jump button is never a dead click: a visible, enabled button always asks for a terminal, only trusted clicks', async () => {
  const b = boot(); await flush();
  b.backend.sessionRows = [{ id: 's-11111111', kind: 'pi', cwd: 'alpha', origin: null, state: 'running' }];
  b.load('sessions-ticker.js'); await flush(); await flush();
  const jump = b.leftCard.children.find(n => n.id === 'session-jump');
  assert.equal(jump.hidden, false);
  for (const fields of [{ phase: 'expanded', view: 'overview', card: 'approval' }, { phase: 'expanded', view: 'overview', settings: 'open' }, { phase: 'expanded', view: 'overview', question: 'pending' }]) {
    b.get('capsule').dataset = fields;
    const before = b.calls.filter(c => c.cmd === 'focus_host').length;
    jump.fire('click', { isTrusted: false }); await flush();
    assert.equal(b.calls.filter(c => c.cmd === 'focus_host').length, before, 'synthetic click stays refused');
    jump.fire('click'); await flush();
    assert.equal(b.calls.filter(c => c.cmd === 'focus_host').length, before + 1, JSON.stringify(fields));
    assert.deepEqual(b.calls.filter(c => c.cmd === 'focus_host').at(-1).payload, { target: 'terminal', session: 's-11111111' });
  }
});

test('a failed terminal launch shows a short message without «por clase»', async () => {
  const b = boot(); await flush();
  b.backend.sessionRows = [{ id: 's-11111111', kind: 'pi', cwd: 'alpha', origin: null, state: 'running' }];
  b.load('sessions-ticker.js'); await flush(); await flush();
  const src = fs.readFileSync(path.join(__dirname, '../frontend/sessions-ticker.js'), 'utf8');
  assert.match(src, /No se pudo abrir una terminal\.'/);
  assert.doesNotMatch(src.match(/jump\.addEventListener\('click'[\s\S]*?\n  \}\);/)[0], /por clase/);
});

test('#442 overview starts with Abito only; legacy defaults never become agents', async () => {
  const b = boot(); await flush();
  assert.equal(b.get('pill-name').textContent, 'Koda'); // Koda 0.1 T2: the principal reads «Koda»
  assert.equal(b.get('pill-state').textContent, 'En reposo');
  assert.deepEqual(b.get('pill-choices').children.map(n => n.dataset.pillId), ['abito']);
  assert.equal(writes(b).length, 0);
});

test('#442 target selection uses the existing role command; synthetic, covered and failed gestures do not change it', async () => {
  const b = boot({ specs: SPECS }); b.load('specialists.js'); await flush();
  const id = 'pill-choice-esp-a';
  b.click(id, { isTrusted: false }); await flush();
  assert.equal(b.get('pill-name').textContent, 'Koda');
  for (const fields of [{ phase: 'compact' }, { phase: 'expanded', view: 'chat' },
    { phase: 'expanded', view: 'overview', card: 'pending' },
    { phase: 'expanded', view: 'overview', settings: 'open' },
    ...['pending', 'expired', 'outcome'].map(question => ({ phase: 'expanded', view: 'overview', question })),
    { phase: 'expanded', view: 'overview', noticeView: 'notices' }]) {
    b.get('capsule').dataset = fields; b.click(id); await flush();
    assert.equal(b.get('pill-name').textContent, 'Koda');
  }
  assert.equal(b.backend.specCalls.length, 0);
  b.get('capsule').dataset = { phase: 'expanded', view: 'overview' };
  b.backend.rejectSpec = true; b.click(id); await flush();
  assert.equal(b.get('pill-name').textContent, 'Koda');
  assert.match(b.get('pill-live').textContent, /No se pudo/);
  b.click(id); await flush();
  assert.equal(b.get('pill-name').textContent, 'Revisor');
  assert.deepEqual(b.backend.specCalls.at(-1), { action: 'select', id: 'esp-a' });
  b.click('pill-choice-abito'); await flush();
  assert.equal(b.get('pill-name').textContent, 'Koda');
  assert.deepEqual(b.backend.specCalls.at(-1), { action: 'select', id: null });
  assert.match(b.get('pill-detail').textContent, /no inicia tareas/);
});

test('#442 membership reconciliation preserves motor controls and the actual conversation target', async () => {
  const b = boot({ specs: SPECS }); b.load('specialists.js'); await flush();
  b.get('overview-status').textContent = 'Motor caído'; b.get('overview-detail').textContent = 'Conexión previa';
  b.click('pill-choice-esp-a'); await flush(); b.get('pill-choice-esp-a').focus();
  b.emit({ islandAgents: ['esp-b'] });
  assert.deepEqual(b.get('pill-choices').children.map(n => n.dataset.pillId), ['abito', 'esp-b']);
  assert.equal(b.get('pill-name').textContent, 'Revisor');
  assert.equal(b.get('pill-state').textContent, 'Fuera de la isla');
  assert.equal(b.doc.activeElement.id, 'pill-choice-abito');
  assert.equal(b.get('overview-status').textContent, 'Motor caído');
  assert.equal(b.get('overview-detail').textContent, 'Conexión previa');
});

test('#442 unknown legacy inputs never become island markup or invented agents', async () => {
  const b = boot(); await flush();
  b.emit({ mainPill: '<img>', declaredPills: ['__proto__', '<img>'], islandAgents: ['esp-missing'] });
  assert.deepEqual(b.get('pill-choices').children.map(n => n.dataset.pillId), ['abito']);
  assert.equal(b.get('pill-choices').textContent.includes('<img>'), false);
  assert.equal(writes(b).length, 0);
});

test('#442 failed preference read says so and shows Abito without writing', async () => {
  const b = boot({ failView: true }); await flush();
  assert.match(b.get('pill-live').textContent, /no se pudieron leer/i);
  assert.equal(b.get('pill-name').textContent, 'Koda');
  assert.equal(writes(b).length, 0);
});

test('#442 initial prefs read cannot overwrite newer pushed island membership', async () => {
  const b = boot({ deferView: true, specs: SPECS }); b.load('specialists.js');
  b.emit({ islandAgents: ['esp-b'] });
  b.backend.pendingView({ islandAgents: [] }); await flush();
  assert.deepEqual(b.get('pill-choices').children.map(n => n.dataset.pillId), ['abito', 'esp-b']);
});


const allByClass = (root, cls) => {
  const hits = [];
  const visit = n => { for (const c of n.children || []) { if (String(c.className || '').split(/\s+/).includes(cls)) hits.push(c); visit(c); } };
  visit(root); return hits;
};

async function settingsBoot(options, tab = 'pills') {
  const b = boot(options); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js', 'specialists.js']) b.load(file);
  await flush();
  b.click('open-screen-settings'); await flush();
  b.click('settings-tab-' + tab); await flush(); // #408: every section lives in its sub-tab
  return b;
}
const writes = b => b.calls.filter(x => x.cmd === 'prefs_action' && x.payload.action !== 'view');

test('#455 main gears and native selection request only the window; IPC failure never falls back', async () => {
  for (const settingsWindow of [false, true]) {
    const b = boot({ settingsLabel: 'main', extraPrefs: { settingsWindow } });
    b.load('settings-view.js'); b.load('settings.js'); await flush();
    b.get('open-settings').fire('click', { isTrusted: false });
    assert.equal(b.calls.filter(c => c.cmd === 'settings_window_action').length, 0);
    b.get('open-settings').fire('click');
    b.get('open-screen-settings').fire('click');
    b.doc.dispatchEvent({ type: 'abito:settings-select', detail: 'open' });
    await flush(); // the fixture rejects window IPC: exercise the negative path too
    assert.equal(b.calls.filter(c => c.cmd === 'settings_window_action').length, 3);
    assert.equal(b.get('settings').dataset.open, undefined);
    assert.equal(b.calls.filter(c => c.cmd === 'settings_view').length, 0);
    assert.match(b.get('chat-live').textContent, /No se pudo abrir Ajustes/);
    assert.equal(writes(b).length, 0);
  }
});

test('S6 actual legacy sound/gain/name/avatar handlers still retain pill choices', async () => {
  const b=await settingsBoot({prefs:{mainPill:'agent_codex',declaredPills:['ai_google']}}, 'general');
  b.click('sw-sound'); await flush(); assert.equal(b.backend.prefs.sound,true);
  // T6.3 #434: the gain field became a slider committed on change (before: number input + form submit)
  const gain=b.get('settings-sound-gain'); gain.value='0.1'; gain.fire('change'); await flush();
  assert.equal(b.backend.prefs.gain,0.1);
  // T6.3 #434: the display name lives in PERFIL on the General tab now (before: appearance tab)
  const name=b.get('settings-display-name'); name.value='Bea'; name.fire('input'); name.parentNode.fire('submit'); await flush();
  assert.equal(b.backend.prefs.displayName,'Bea');
  b.click('settings-tab-appearance'); await flush();
  b.click('dot-color-abito-blue'); await flush(); assert.equal(b.backend.prefs.avatarColors.abito,'blue');
  assert.equal(b.backend.prefs.mainPill,'agent_codex'); assert.deepEqual(b.backend.prefs.declaredPills,['ai_google']);
  assert.deepEqual(writes(b).map(x=>x.payload.action),['sound_on','set_sound_gain','set_display_name','set_avatar_color']);
  assert.equal(b.get('pill-name').textContent,'Koda');
  assert.ok(!b.get('open-screen-accounts'), '#408: no separate Cuentas/Conectores header buttons'); assert.ok(b.get('settings-tab-accounts')); assert.ok(!b.get('settings-tab-connectors'), 'S8: merged into Conexiones');
});

// T6.3 #434: the volume control is a slider (design ajustes-ventana-general-*): native range
// 0..0.2, keyboard accessible, value shown as text too, committed through the same closed
// command with the same honest failure.
test('T6.3 #434 volume slider: range 0..0.2, aria + percent text, commit on change, honest failure', async () => {
  const b = await settingsBoot({}, 'general');
  const gain = b.get('settings-sound-gain');
  assert.equal(gain.tagName, 'INPUT');
  assert.equal(gain.type, 'range');
  assert.equal(gain.min, '0'); assert.equal(gain.max, '0.2'); assert.equal(gain.step, '0.01');
  assert.equal(gain.getAttribute('aria-valuemin'), '0');
  assert.equal(gain.getAttribute('aria-valuemax'), '0.2');
  assert.equal(gain.getAttribute('aria-valuenow'), '0.12');
  assert.equal(gain.getAttribute('aria-valuetext'), '60%', 'the percent is the position inside 0..0.2');
  assert.equal(gain.getAttribute('aria-label'), 'Volumen');
  assert.equal(b.get('settings-sound-gain-value').textContent, '60%', 'the value is shown as text too');
  // commit on change through the same closed command
  gain.value = '0.05'; gain.fire('change'); await flush();
  assert.equal(b.backend.prefs.gain, 0.05);
  assert.deepEqual(writes(b).map(x => x.payload.action), ['set_sound_gain']);
  // honest failure: nothing saved, the issue is shown, focus returns to the slider
  b.backend.rejectNext = true;
  const retry = b.get('settings-sound-gain'); retry.value = '0.1'; retry.fire('change'); await flush();
  assert.equal(b.backend.prefs.gain, 0.05, 'a failed save keeps the previous gain');
  assert.equal(b.get('settings-sound-gain').getAttribute('aria-invalid'), 'true', 'the re-rendered slider is marked invalid');
  assert.match(b.get('settings-gain-error').textContent, /No se pudo guardar/);
  assert.equal(b.doc.activeElement && b.doc.activeElement.id, 'settings-sound-gain');
});

// RDD U10: a slider change that arrives while a save is in flight used to be dropped silently, so the
// slider showed a value that was never stored. The latest value is kept and saved once the save ends.
test('RDD U10 a volume change made while a save is in flight is saved afterwards, not dropped', async () => {
  const b = await settingsBoot({}, 'general');
  const gain = b.get('settings-sound-gain');
  b.backend.holdGain = true;
  gain.value = '0.05'; gain.fire('change'); await flush();
  gain.value = '0.1'; gain.fire('change'); await flush();
  assert.equal(writes(b).filter(x => x.payload.action === 'set_sound_gain').length, 1, 'only one save is in flight');
  b.backend.releaseGain(); await flush(); await flush();
  const sent = writes(b).filter(x => x.payload.action === 'set_sound_gain').map(x => x.payload.gain);
  assert.deepEqual(sent, [0.05, 0.1], 'the later value is sent after the first save ends');
  assert.equal(b.backend.prefs.gain, 0.1, 'the stored volume is what the slider shows');
  assert.equal(b.get('settings-sound-gain').value, '0.1');
});

// #460 E2: MIT General row pattern; windows/src/settings/main.ts (generalSection).
// Copyright (c) 2026 Louis Raillé, MIT. Abito keeps its own controls and copy.
test('#460 E2 General groups: Perfil / Isla / Sonido / Atajo global, name in Perfil, no hint walls', async () => {
  const b = await settingsBoot({}, 'general');
  const text = b.get('settings-body').textContent;
  for (const word of ['Perfil', 'Isla', 'Sonido', 'Nombre', 'Auto-cierre', 'Abrir al pasar el mouse', 'Volumen', 'Atajo global']) {
    assert.ok(text.includes(word), word);
  }
  const name = b.get('settings-display-name');
  assert.ok(name, 'the display name moved into PERFIL on the General tab');
  assert.equal(name.getAttribute('placeholder'), 'Tu nombre (opcional)');
  assert.ok(b.get('sw-settings-window') === null, '#455: the window replaces placement choices');
  assert.equal(b.doc.body.dataset.window, 'settings');
  assert.equal(b.get('settings-tabs').getAttribute('aria-orientation'), 'vertical');
  assert.equal(b.get('settings-tab-general').tabIndex, 0);
  b.get('settings-tab-general').fire('keydown', { key: 'End' });
  assert.equal(b.doc.activeElement.id, 'settings-tab-appearance');
  assert.equal(b.get('settings-tab-appearance').tabIndex, 0);
  b.get('settings-tab-appearance').fire('keydown', { key: 'Home' });
  assert.ok(!text.includes('Abrir Ajustes en ventana'));
  assert.equal(b.get('sw-island-hover').getAttribute('aria-label'), 'Abrir al pasar el mouse');
  // the hint walls are gone; the ONE allowed hint is the limited-shortcut note
  assert.ok(!text.includes('Avisos sonoros de la isla'));
  assert.ok(!text.includes('Se cierra sola después'));
  // the name is no longer on the appearance tab
  b.click('settings-tab-appearance'); await flush();
  assert.ok(!b.get('settings-display-name'), 'the name lives in PERFIL (General) now');
});

// T6.3 #434, #438: segmented Auto-cierre «8 s / 15 s / 30 s / Nunca» on the {0} ∪ 5..=120
// contract: presets save through the closed pair, a stored non-preset stays honest, and
// «Nunca» is a real enabled choice that stores 0 through the same closed pair.
test('T6.3 #434 auto-close segmented: presets save, custom value stays honest, Nunca stores 0', async () => {
  const b = await settingsBoot({}, 'general');
  const group = b.get('settings-autoclose-options');
  assert.equal(group.getAttribute('role'), 'radiogroup');
  assert.equal(group.getAttribute('aria-label'), 'Auto-cierre');
  const seg = id => b.get('autoclose-' + id);
  for (const id of ['8', '15', '30']) {
    assert.equal(seg(id).getAttribute('role'), 'radio', id);
    assert.equal(seg(id).getAttribute('aria-checked'), id === '15' ? 'true' : 'false', id);
  }
  const never = seg('never');
  assert.equal(never.disabled, false, '#438: «Nunca» is a real choice now');
  assert.equal(never.getAttribute('title'), null);
  assert.equal(never.getAttribute('aria-checked'), 'false');
  // «Nunca» saves 0 through the same closed pair, and the projection keeps it as 0
  const beforeNever = writes(b).length;
  b.click('autoclose-never'); await flush();
  assert.equal(b.backend.prefs.autoCloseSeconds, 0);
  assert.equal(writes(b).length, beforeNever + 1, 'exactly one save');
  assert.equal(writes(b).at(-1).payload.action, 'set_island_interaction');
  assert.equal(writes(b).at(-1).payload.auto_close_seconds, 0);
  assert.equal(writes(b).at(-1).payload.open_on_hover, false, 'the closed pair always carries both fields');
  await flush();
  assert.equal(b.get('autoclose-never').getAttribute('aria-checked'), 'true', 'a stored 0 selects «Nunca»');
  // a preset saves through the closed pair
  b.click('autoclose-8'); await flush();
  assert.equal(b.backend.prefs.autoCloseSeconds, 8);
  assert.equal(writes(b).length, beforeNever + 2, 'exactly one more save');
  assert.equal(writes(b).at(-1).payload.auto_close_seconds, 8);
  assert.equal(writes(b).at(-1).payload.open_on_hover, false, 'the closed pair always carries both fields');
  // a stored non-preset value renders as its own selected segment, never rewritten
  b.emit({ autoCloseSeconds: 20 }); await flush();
  const custom = b.get('autoclose-20');
  assert.ok(custom, 'the custom value gets its own segment');
  assert.equal(custom.getAttribute('aria-checked'), 'true');
  assert.match(custom.textContent, /20 s/);
  assert.equal(b.get('autoclose-15').getAttribute('aria-checked'), 'false');
  // honest failure keeps the stored value
  b.backend.rejectNext = true;
  b.click('autoclose-30'); await flush();
  assert.equal(b.backend.prefs.autoCloseSeconds, 20);
  assert.match(b.get('settings-autoclose-error').textContent, /No se pudo guardar\. La interacción sigue sin cambios/);
  // #438: a stored «Nunca» (0) renders selected after the custom-value flow too
  b.emit({ autoCloseSeconds: 0 }); await flush();
  assert.equal(b.get('autoclose-never').getAttribute('aria-checked'), 'true');
  assert.ok(!b.get('autoclose-20'), '0 is not a foreign value: no extra segment is invented');
});

test('#408 Cuentas renders the provider-list section (and tab selection follows the click) without an engine', async () => {
  const b = await settingsBoot({}, 'accounts');
  assert.ok(b.get('provider-list'), 'one provider list');
  assert.equal(b.get('settings-tab-accounts').getAttribute('aria-selected'), 'true');
  assert.equal(b.get('settings-tab-pills').getAttribute('aria-selected'), 'false');
  assert.equal(b.get('settings-tab-pills').tabIndex, -1, 'roving tabindex');
  b.click('settings-tab-pills'); await flush();
  assert.equal(b.get('settings-tab-pills').getAttribute('aria-selected'), 'true');
  assert.ok(!b.get('provider-list'), 'only the selected tab is rendered');
});

test('#455 opening and closing the settings window never resizes the island', async () => {
  const b = await settingsBoot({}, 'general');
  const sizes = () => b.calls.filter(x => x.cmd === 'settings_view').map(x => x.payload);
  assert.deepEqual(sizes(), []);
  b.click('settings-close'); await flush();
  assert.deepEqual(sizes(), []);
  assert.deepEqual(b.calls.filter(x => x.cmd === 'settings_window_action').at(-1).payload, { action: 'close' });
  b.click('settings-close'); await flush();
  assert.equal(sizes().length, 0, 'closing never sizes the island');
});

test('#455 Escape closes the own window without moving island focus', async () => {
  const b = await settingsBoot({}, 'general');
  b.get('settings-close').focus();
  const keydown = b.events.keydown || [];
  assert.ok(keydown.length, 'settings.js listens for keydown');
  for (const fn of keydown) fn({ key: 'Escape', isComposing: false, preventDefault() {}, stopPropagation() {} });
  await flush();
  assert.equal(b.get('settings').inert, true, 'panel closed');
  assert.equal(b.doc.activeElement.id, 'settings-close', 'no island focus manipulation');
  assert.deepEqual(b.calls.filter(x => x.cmd === 'settings_view'), []);
});

test('#408 S8 Conexiones holds providers, agents and services together; the old connectors deep link lands there', async () => {
  const b = await settingsBoot({}, 'accounts');
  assert.ok(b.get('provider-list'), 'providers group');
  assert.ok(b.get('connections-agents'), 'agents group');
  assert.ok(b.get('connections-services'), 'services group');
  b.click('settings-tab-pills'); await flush();
  for (const fn of b.events['abito:settings-select'] || []) fn({ detail: 'connectors' });
  await flush();
  assert.equal(b.get('settings-tab-accounts').getAttribute('aria-selected'), 'true');
});

// #409: the Abito-owned account store only — nothing reads Pi's files any more.
function fakeStore({ accounts = [], failRemove = false } = {}) {
  let owned = accounts.map(a => clone(a));
  const view = () => ({ accounts: owned.map(a => clone(a)) });
  return { view, removes: [], saves: [],
    apply(payload) { // the masked host's account verbs: remember the command, never a raw key
      this.saves.push(payload);
      const cfg = payload.config || {};
      const at = owned.findIndex(a => a.accountId === payload.accountId);
      const prev = at >= 0 ? owned[at] : null;
      const hasCredential = Object.hasOwn(cfg, 'apiKey')
        ? typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0
        : (prev ? prev.hasCredential : false);
      const record = { accountId: payload.accountId, provider: payload.provider, hasCredential,
        config: { nombre: cfg.nombre || (prev && prev.config.nombre), baseUrl: cfg.baseUrl, api: cfg.api,
          compat: cfg.compat || {}, models: cfg.models || [], defaultModel: cfg.defaultModel } };
      if (at >= 0) owned[at] = record; else owned.push(record);
      return { accounts: owned.map(a => clone(a)) };
    },
    remove(accountId) {
      this.removes.push(accountId);
      if (failRemove) return Promise.reject({ code: 'save_failed' });
      owned = owned.filter(a => a.accountId !== accountId);
      return Promise.resolve({ ownedAccounts: view() });
    } };
}
const allText = node => node.textContent || '';

test('#409 T1 «Sacarlo»: Conexiones renders no Pi card, sends no pi_connection IPC, keeps the owned nan row', async () => {
  const store = fakeStore({ accounts: [{ accountId: 'nan', provider: 'nan', hasCredential: true, config: { nombre: 'nan (Pi)', baseUrl: 'https://api.nan.builders/v1', api: 'openai-completions', compat: {}, models: ['m0', 'm1'], defaultModel: 'm0' } }] });
  const b = boot({ store }); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) b.load(file);
  b.click('open-screen-settings'); await flush();
  // #442 T7.4: Ajustes opens on General now; these Conexiones rows need the tab opened explicitly
  b.click('settings-tab-accounts'); await flush();
  assert.ok(!b.get('pi-connection'), 'no Pi card, even with an owned nan account');
  const text = allText(b.get('settings-body'));
  assert.ok(!text.includes('Usar la conexión de Pi'), 'no offer label anywhere');
  assert.ok(!text.includes('Volver a copiar desde Pi'), 'no re-copy label anywhere');
  assert.ok(!b.calls.some(c => c.cmd === 'pi_connection'), 'the page never asks the host about Pi');
  assert.ok(text.includes('nan (Pi)'), 'the manual owned-account row still renders');
});

test('#409 T2 «Quitar conexión» lives on the owned-account row: exact sentences, no mutation on failure', async () => {
  const account = { accountId: 'nan', provider: 'nan', hasCredential: true, config: { nombre: 'nan (Pi)', baseUrl: 'https://api.nan.builders/v1', api: 'openai-completions', compat: {}, models: ['m0'], defaultModel: 'm0' } };
  const buttons = b => (b.get('owned-accounts') ? b.get('owned-accounts').querySelectorAll('button') : []).map(x => allText(x));
  // success: the row sends the closed verb, hears back and says the existing sentence
  const store = fakeStore({ accounts: [account] });
  const b = boot({ store }); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) b.load(file);
  b.click('open-screen-settings'); await flush();
  // #442 T7.4: Ajustes opens on General now; these Conexiones rows need the tab opened explicitly
  b.click('settings-tab-accounts'); await flush();
  assert.ok(buttons(b).includes('Quitar conexión'), 'the owned-account row offers deletion'); // RED before T2
  b.get('owned-accounts').querySelectorAll('button').find(x => allText(x) === 'Quitar conexión').fire('click'); await flush();
  assert.deepEqual(store.removes, ['nan'], 'abito_account_remove carries the accountId');
  assert.equal(b.get('settings-live').textContent, 'Conexión quitada. La clave se borró del almacén de Abito.');
  assert.ok(!buttons(b).includes('Quitar conexión'), 'the row is gone after a successful removal');
  // failure: OUR sentence, the store untouched, the row still there
  const failing = fakeStore({ accounts: [account], failRemove: true });
  const c = boot({ store: failing }); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) c.load(file);
  c.click('open-screen-settings'); await flush();
  c.click('settings-tab-accounts'); await flush();
  c.get('owned-accounts').querySelectorAll('button').find(x => allText(x) === 'Quitar conexión').fire('click'); await flush();
  assert.equal(failing.view().accounts.length, 1, 'the store did not change');
  assert.ok(buttons(c).includes('Quitar conexión'), 'the row is still there');
  assert.match(allText(c.get('owned-accounts')), /No se pudo quitar la conexión\. No se cambió nada\./);
});

test('HU-041 deferred: new accounts offer no custom endpoint preset; a saved custom account still renders', async () => {
  const store = fakeStore({ accounts: [{ accountId: 'mine', provider: 'custom', hasCredential: false, config: { nombre: 'Mio', baseUrl: 'https://llm.example/v1', api: 'openai-completions', compat: {}, models: [], defaultModel: '' } }] });
  const b = boot({ store }); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) b.load(file);
  b.click('open-screen-settings'); await flush(); b.click('settings-tab-accounts'); await flush();
  const values = () => b.get('account-provider').children.map(x => x.value);
  b.click('account-add'); await flush();
  assert.ok(!values().includes('custom'), 'new account: no custom endpoint preset');
  assert.ok(values().includes('openai'));
  b.get('account-form').querySelectorAll('button').find(x => allText(x) === 'Cancelar').fire('click'); await flush();
  b.get('owned-accounts').querySelectorAll('button').find(x => allText(x) === 'Editar').fire('click'); await flush();
  assert.ok(values().includes('custom'), 'saved custom account keeps its provider option');
  assert.equal(b.get('account-provider').value, 'custom');
  assert.equal(b.get('account-url').value, 'https://llm.example/v1');
});

test('#409 T3 the manual masked editor: full field set, credential options, write-only secret, closed verbs', async () => {
  const KEY = ['synthetic', 'manual', 'key', '0042'].join('-');
  const store = fakeStore({ accounts: [{ accountId: 'nan', provider: 'nan', hasCredential: true, config: { nombre: 'nan (Pi)', baseUrl: 'https://api.nan.builders/v1', api: 'openai-completions', compat: {}, models: ['m0'], defaultModel: 'm0' } }] });
  const b = boot({ store }); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) b.load(file);
  b.click('open-screen-settings'); await flush();
  // #442 T7.4: Ajustes opens on General now; these Conexiones rows need the tab opened explicitly
  b.click('settings-tab-accounts'); await flush();
  const openEditor = async () => {
    b.get('owned-accounts').querySelectorAll('button').find(x => allText(x) === 'Editar').fire('click'); await flush();
    const form = b.get('account-form'); assert.ok(form, 'the masked editor opens from the row'); return form;
  };
  // S4: every field of makeAccountForm, the identity locked for a saved account, the credential options
  const form = await openEditor();
  for (const id of ['account-provider', 'account-name', 'account-url', 'account-api', 'account-models', 'account-default', 'account-credential', 'account-secret', 'account-save', 'account-endpoint']) {
    assert.ok(b.get(id), `field ${id} exists`);
  }
  assert.equal(b.get('account-provider').disabled, true, 'provider identity cannot be rewritten for a saved account');
  const credential = b.get('account-credential');
  assert.deepEqual(credential.children.map(x => allText(x)), ['Conservar', 'Establecer clave', 'Borrar clave']);
  const secret = b.get('account-secret');
  assert.equal(secret.type, 'password');
  assert.equal(secret.disabled, true, 'the secret stays masked and inert until Establecer clave');
  // «Establecer clave»: the key crosses in the save IPC only, is cleared from the field immediately,
  // and never reaches any rendered text
  credential.value = 'set'; credential.fire('change');
  assert.equal(secret.disabled, false, 'Establecer clave enables the masked field');
  secret.value = KEY;
  form.fire('submit'); await flush();
  const save = b.calls.find(c => c.cmd === 'agent_action' && c.payload.action === 'abito_account_save');
  assert.ok(save, 'saved through the closed verb');
  assert.equal(save.payload.accountId, 'nan');
  assert.equal(save.payload.config.apiKey, KEY, 'the key travels once, in the save request');
  assert.equal(secret.value, '', 'the field is cleared BEFORE the IPC, on every path');
  assert.ok(!b.get('account-form'), 'the editor closes after a save');
  assert.ok(!allText(b.get('settings-body')).includes(KEY), 'the key is nowhere on the page');
  assert.ok(allText(b.get('owned-accounts')).includes('Clave guardada'), 'the row reports the stored credential');
  // «Conservar»: no apiKey in the payload, the stored credential survives
  await openEditor();
  b.get('account-credential').value = 'keep'; b.get('account-form').fire('submit'); await flush();
  const keep = b.calls.filter(c => c.cmd === 'agent_action' && c.payload.action === 'abito_account_save').pop();
  assert.ok(!Object.hasOwn(keep.payload.config, 'apiKey'), 'Conservar sends no key at all');
  assert.ok(allText(b.get('owned-accounts')).includes('Clave guardada'), 'Conservar keeps the stored key');
  // «Borrar clave»: apiKey null clears the stored credential, the row says so
  await openEditor();
  b.get('account-credential').value = 'clear'; b.get('account-form').fire('submit'); await flush();
  const clear = b.calls.filter(c => c.cmd === 'agent_action' && c.payload.action === 'abito_account_save').pop();
  assert.equal(clear.payload.config.apiKey, null, 'Borrar clave sends an explicit null');
  assert.ok(allText(b.get('owned-accounts')).includes('Sin clave'), 'the row reports the cleared credential');
  // the endpoint verb stays reachable from the same editor
  await openEditor();
  b.get('account-endpoint').fire('click'); await flush();
  assert.ok(b.calls.some(c => c.cmd === 'agent_action' && c.payload.action === 'abito_account_endpoint_set'), 'endpoint_set sent from the editor');
  // write-only, not never-sent: the manual path crosses the IPC exactly once, in its own save —
  // and the earlier assertions proved it reaches no rendered text and no reply
  const withKey = b.calls.filter(c => JSON.stringify(c.payload).includes(KEY));
  assert.equal(withKey.length, 1, 'the synthetic key crosses the IPC exactly once, in its own save');
  assert.equal(withKey[0].payload.action, 'abito_account_save');
});

// #410 Conexiones compacta (S2/S3): the compaction is scoped by a public DOM attribute, and the one
// plain-text status of the owned-account row rides a chip from the closed icon registry.
const findWhere = (node, pred) => {
  if (!node) return null;
  if (pred(node)) return node;
  for (const child of node.children || []) { const hit = findWhere(child, pred); if (hit) return hit; }
  return null;
};

test('#410 the open sub-tab is published on the tabpanel: only Conexiones carries the compact screen', async () => {
  const b = await settingsBoot({}, 'accounts');
  assert.equal(b.get('settings-body').dataset.screen, 'accounts', 'Conexiones marks the tabpanel');
  b.click('settings-tab-pills'); await flush();
  assert.equal(b.get('settings-body').dataset.screen, 'pills', 'another tab carries its own screen, so its look is untouched');
  for (const fn of b.events['abito:settings-select'] || []) fn({ detail: 'connectors' });
  await flush();
  assert.equal(b.get('settings-body').dataset.screen, 'accounts', 'the old connectors deep link marks Conexiones again');
  assert.equal(b.get('settings-tab-accounts').getAttribute('aria-selected'), 'true');
});

test('#410 the credential state is an icon chip from the closed registry (same words as before)', async () => {
  const account = { accountId: 'nan', provider: 'nan', hasCredential: true, config: { nombre: 'nan (Pi)', baseUrl: 'https://api.nan.builders/v1', api: 'openai-completions', compat: {}, models: ['m0'], defaultModel: 'm0' } };
  const b = boot({ store: fakeStore({ accounts: [account] }) }); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) b.load(file);
  b.click('open-screen-settings'); await flush();
  // #442 T7.4: Ajustes opens on General now; these Conexiones rows need the tab opened explicitly
  b.click('settings-tab-accounts'); await flush();
  const chip = findWhere(b.get('owned-accounts'), n => String(n.className || '').split(/\s+/).includes('chip'));
  assert.ok(chip, 'the row says the credential state with a chip, not a bare line of text');
  assert.equal(allText(chip), 'Clave guardada', 'the words are unchanged');
  assert.ok(findWhere(chip, n => String(n.className || '').split(/\s+/).includes('ico') && n.children.length),
    'the icon comes from the closed registry (an unknown name renders nothing)');
  // cleared credential: same row, the other registry icon
  const store = fakeStore({ accounts: [account] });
  const c = boot({ store }); await flush();
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) c.load(file);
  c.click('open-screen-settings'); await flush();
  c.click('settings-tab-accounts'); await flush();
  c.get('owned-accounts').querySelectorAll('button').find(x => allText(x) === 'Editar').fire('click'); await flush();
  c.get('account-credential').value = 'clear'; c.get('account-form').fire('submit'); await flush();
  const cleared = findWhere(c.get('owned-accounts'), n => String(n.className || '').split(/\s+/).includes('chip'));
  assert.equal(allText(cleared), 'Sin clave', 'the cleared state keeps its exact word');
  assert.ok(findWhere(cleared, n => String(n.className || '').split(/\s+/).includes('ico') && n.children.length), 'registry icon for «Sin clave»');
});

// #346 F033 — per-pill colours at the DOM/event boundary: validated name in, painted name out.
test('#442 overview avatar palette rejects hostile values and repaints the same stable identity', async () => {
  const b = boot({ specs: SPECS, extraPrefs: { avatarColors: { abito: 'blue', 'esp-a': 'mint', 'esp-b': '<img>' } } });
  b.load('specialists.js'); await flush();
  assert.equal(b.get('pill-choice-abito').dataset.color, 'blue');
  assert.equal(b.get('pill-choice-esp-a').dataset.color, 'mint');
  assert.notEqual(b.get('pill-choice-esp-b').dataset.color, '<img>');
  b.emit({ avatarColors: { abito: 'purple', 'esp-a': 'expression(alert(1))' } });
  assert.equal(b.get('pill-choice-abito').dataset.color, 'purple');
  assert.notEqual(b.get('pill-choice-esp-a').dataset.color, 'expression(alert(1))');
  assert.equal(b.get('pill-choices').textContent.includes('<img'), false);
});

// ---- #415 WU2: created blobs (label + colour + order entries, prefs-persisted) ----

test('#415 the blob model creates the human examples and refuses bad names, duplicates, the principal and the ninth blob', () => {
  assert.deepEqual(M.normalize({}).blobs, [], 'a file without blobs reads as none');
  let state = M.normalize({});
  for (const [name, color] of [['Abito GitHub', 'green'], ['Abito Reviewer', ''], ['Abito correo', '']]) {
    const next = M.createBlob(state, name, color);
    assert.ok(next, `${name} must be accepted`);
    state = M.normalize(next);
  }
  assert.deepEqual(state.blobs, [
    { name: 'Abito GitHub', color: 'green' }, { name: 'Abito Reviewer', color: '' }, { name: 'Abito correo', color: '' },
  ]);
  const before = clone(state);
  for (const [name, color] of [
    ['abito github', ''], [' Abito correo ', ''], ['Abito', ''], ['ABITO', ''], ['Koda', ''], ['koda', ''], ['KODA', ''], // Koda 0.1 T2: duplicates + the principal, by either name
    ['', ''], ['Abito\u{0007}', ''], ['A'.repeat(41), ''], ['Abito GitHub', ''],
    ['Nuevo', 'teal'], ['Nuevo', 42],
  ]) assert.equal(M.createBlob(state, name, color), null, `«${name}» must be refused`);
  assert.deepEqual(state, before, 'a refusal mutates nothing');
  let grown = state;
  for (let i = grown.blobs.length; i < 8; i++) grown = M.normalize(M.createBlob(grown, `B${i}`, ''));
  assert.equal(grown.blobs.length, 8);
  assert.equal(M.createBlob(grown, 'B9', ''), null, 'the ninth blob is refused');
  assert.equal(grown.blobs.length, 8);
  // deletion removes exactly the named entry; unknown names are refused
  const removed = M.deleteBlob(grown, 'B3');
  assert.ok(removed);
  assert.equal(removed.blobs.some(x => x.name === 'B3'), false);
  assert.equal(removed.blobs.length, 7);
  assert.equal(M.deleteBlob(grown, 'Nunca existió'), null);
  assert.equal(M.deleteBlob(grown, 'b3'), null, 'matching is exact, not case-folded');
  assert.deepEqual(grown.blobs.length, 8);
  // the created colour stays inside the closed palette on read
  assert.equal(M.colorOfBlob(grown, 'Abito GitHub'), 'green');
  assert.equal(M.colorOfBlob(grown, 'Abito Reviewer'), '');
});

test('#442 legacy custom blobs stay stored and only appear through explicit Settings conversion', async () => {
  const blobs = [{ name: 'Abito GitHub', color: 'mint' }, { name: 'Abito Reviewer', color: '' }];
  const b = boot({ extraPrefs: { customBlobs: blobs } }); await flush();
  assert.deepEqual(b.get('pill-choices').children.map(n => n.dataset.pillId), ['abito']);
  assert.deepEqual(b.backend.prefs.customBlobs, blobs);
  assert.equal(writes(b).length, 0);
});

// #435 D4: «Principal» promotes a blob AND feeds the island character colour through
// the existing typed pref (avatarColors['abito'] via set_avatar_color) — no new wire
// field. A colourless promotion changes nothing about the character.

// ---- #442 T7.4: Blobs = agents, through the real settings.js wiring ------------------------------------
const SPECS = [{ id: 'esp-a', name: 'Revisor', instructions: 'Revisa tus PRs' }, { id: 'esp-b', name: 'Notas', instructions: 'Ordena notas' }];
const specWrites = b => b.backend.specCalls;
const swatchOf = (b, color) => allByClass(b.get('blob-editor'), 'swatch').find(x => x.dataset.color === color);

test('#442 Ajustes → Blobs paints the principal (Abito), the agent tiles from the specialist store and the island strip; nothing is written by opening it', async () => {
  const b = await settingsBoot({ specs: SPECS });
  await flush();
  assert.equal(b.get('blob-principal-card').getAttribute('aria-label'), 'Koda: siempre en la isla');
  assert.deepEqual(allByClass(b.get('blob-agent-grid'), 'blob-tile').map(x => x.dataset.agentId), ['esp-a', 'esp-b']);
  assert.equal(b.get('blob-count').textContent, '2/3');
  assert.ok(b.get('pill-principal-card') === null, 'the old principal card is gone');
  assert.ok(b.get('pill-editor-main') === null, 'the per-tile «Principal» button is removed (design §4)');
  assert.deepEqual(writes(b), []); assert.deepEqual(b.backend.specCalls, []); assert.equal(b.backend.writes, 0);
  const scripts = [...read('index.html').matchAll(/src="([^"]+\.js)"/g)].map(x => x[1]);
  assert.ok(scripts.indexOf('pills.js') < scripts.indexOf('pill-settings.js'));
  assert.ok(scripts.indexOf('specialists-view.js') < scripts.indexOf('pill-settings.js'), 'the view-model loads before the renderer reads it');
  assert.ok(scripts.indexOf('pill-settings.js') < scripts.indexOf('settings.js'));
});

test('#442 the Especialistas tab is gone and its deep link lands on Blobs', async () => {
  const b = await settingsBoot({ specs: SPECS });
  assert.equal(b.get('settings-tab-specialists'), null);
  assert.deepEqual(['general', 'accounts', 'models', 'pills', 'appearance'].map(id => !!b.get('settings-tab-' + id)), [true, true, true, true, true]);
});

test('#442 editing an agent sends the closed specialists update with the unchanged fields; a refusal keeps the previous one and says so', async () => {
  const b = await settingsBoot({ specs: SPECS });
  const name = b.get('blob-editor-name'); name.value = 'Revisora'; name.fire('change'); await flush();
  assert.deepEqual(specWrites(b), [{ action: 'update', id: 'esp-a', name: 'Revisora', instructions: 'Revisa tus PRs', model: null, space: null, spaces: [], permissions: ['read'] }]);
  assert.equal(b.backend.specs.specialists[0].name, 'Revisora');
  b.backend.rejectSpec = true;
  const what = b.get('blob-editor-what'); what.value = 'Otra cosa'; what.fire('change'); await flush();
  assert.equal(b.backend.specs.specialists[0].instructions, 'Revisa tus PRs', 'a refused update changes nothing');
  assert.equal(b.get('blob-settings-error').textContent, 'No se pudo guardar el agente; se mantuvo el anterior.');
});

test('#442 colour is the avatar colour of the SAME id; the principal colour is avatarColors.abito (D4)', async () => {
  const b = await settingsBoot({ specs: SPECS });
  swatchOf(b, 'purple').fire('click'); await flush();
  assert.deepEqual(writes(b).map(x => x.payload), [{ action: 'set_avatar_color', identity: 'esp-a', color: 'purple' }]);
  assert.equal(b.backend.prefs.avatarColors['esp-a'], 'purple');
  b.click('blob-principal-card'); await flush();
  swatchOf(b, 'orange').fire('click'); await flush();
  assert.deepEqual(writes(b).slice(-1).map(x => x.payload), [{ action: 'set_avatar_color', identity: 'abito', color: 'orange' }]);
  assert.equal(b.backend.prefs.avatarColors.abito, 'orange', 'the island character follows');
  assert.equal(b.backend.prefs.mainPill, M.DEFAULT_MAIN, 'the main pill is untouched');
});

test('#442 «Activo» and the arrows write ONE closed set_island_agents (≤3); the third slot refuses a fourth', async () => {
  const b = await settingsBoot({ specs: [...SPECS, { id: 'esp-c', name: 'Correo', instructions: 'Correo' }, { id: 'esp-d', name: 'Cuarto', instructions: 'Cuarto' }] });
  assert.equal(b.get('blob-count').textContent, '3/3'); assert.ok(b.get('blob-tile-new') === null, 'lleno 3/3');
  assert.ok(b.get('blob-stored'), 'the fourth is kept and reachable');
  b.click('blob-editor-right'); await flush();
  assert.deepEqual(writes(b).map(x => x.payload), [{ action: 'set_island_agents', order: ['esp-b', 'esp-a', 'esp-c'] }]);
  b.click('blob-editor-active'); await flush(); // esp-a leaves the island
  assert.deepEqual(writes(b).slice(-1).map(x => x.payload), [{ action: 'set_island_agents', order: ['esp-b', 'esp-c'] }]);
  assert.equal(b.backend.specs.specialists.length, 4, 'nothing stored is deleted');
  assert.ok(b.get('blob-tile-new'), 'a slot is free again');
  assert.equal(b.backend.prefs.mainPill, M.DEFAULT_MAIN);
});

test('#442 «Nuevo agente · Propio» creates the specialist, its colour and its island place, in that order, and selects it', async () => {
  const b = await settingsBoot({ specs: SPECS });
  b.click('blob-tile-new'); await flush(); b.click('create-kind-custom'); await flush();
  b.get('blob-create-input').value = 'Música'; b.get('blob-create-input').fire('input');
  swatchOf(b, 'orange').fire('click'); await flush();
  b.get('blob-create-what').value = 'Pone música'; b.get('blob-create-what').fire('input');
  b.click('blob-create-button'); await flush(); await flush();
  const made = b.backend.specs.specialists[2];
  assert.equal(made.name, 'Música'); assert.equal(made.instructions, 'Pone música'); assert.match(made.id, /^esp-[0-9a-f]{16}$/);
  // with no stored island order the default (first three stored) already includes it: no extra write
  assert.deepEqual(writes(b).map(x => x.payload), [{ action: 'set_avatar_color', identity: made.id, color: 'orange' }]);
  assert.equal(b.get('blob-editor-name').value, 'Música', 'the new agent is selected');
  assert.equal(b.get('blob-count').textContent, '3/3');
});

for (const existing of [0, 1]) {
  test(`#451 creating an agent with ${existing} existing and no stored island order never sends a duplicate island order`, async () => {
    const b = await settingsBoot({ specs: SPECS.slice(0, existing) });
    b.click('blob-tile-new'); await flush();
    if (b.get('create-kind-custom')) { b.click('create-kind-custom'); await flush(); }
    b.get('blob-create-input').value = 'Música'; b.get('blob-create-input').fire('input');
    swatchOf(b, 'orange').fire('click'); await flush();
    b.get('blob-create-what').value = 'Pone música'; b.get('blob-create-what').fire('input');
    b.click('blob-create-button'); await flush(); await flush();
    const made = b.backend.specs.specialists.find(x => x.name === 'Música');
    assert.ok(made, 'the specialist is created');
    const orders = writes(b).filter(x => x.payload.action === 'set_island_agents').map(x => x.payload.order);
    for (const o of orders) assert.equal(new Set(o).size, o.length, 'no duplicate ids in a set_island_agents order');
    assert.ok(!b.get('blob-error') || !/No se pudo crear/.test(b.get('blob-error').textContent || ''), 'no creation failure is reported');
    assert.equal(b.get('blob-editor-name').value, 'Música', 'the new agent is selected');
    assert.equal(b.get('blob-count').textContent, `${existing + 1}/3`);
  });
}

test('abito-pausa 0.1.2: the island «Del catálogo» chooser hides paused services (GitHub, n8n, …, Spotify); stored declarations are untouched', async () => {
  const b = boot({ prefs: { declaredPills: ['integration_resend'] }, specs: SPECS }); await flush();
  b.load('paused.js');
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js', 'specialists.js']) b.load(file);
  await flush(); b.click('open-screen-settings'); await flush(); b.click('settings-tab-pills'); await flush();
  b.click('blob-tile-new'); await flush();
  const rows = () => b.get('pill-catalog-list').children.map(r => r.dataset.pillId);
  const shown = rows();
  assert.ok(shown.length > 0, 'the chooser still lists the active ones');
  for (const id of ['integration_github', 'integration_n8n', 'integration_vercel', 'integration_stripe', 'integration_resend', 'integration_notion', 'integration_calcom', 'integration_spotify'])
    assert.ok(!shown.includes(id), `${id} is paused: not offered on the island`);
  b.get('pill-catalog-search').value = 'n8n'; b.get('pill-catalog-search').fire('input');
  assert.deepEqual(rows().filter(Boolean), [], 'searching does not bring a paused one back');
  assert.deepEqual(b.backend.prefs.declaredPills, ['integration_resend'], 'the stored declaration is never rewritten');
  assert.deepEqual(writes(b), [], 'nothing is written');
});

test('#442 «Del catálogo» keeps today\'s declaration gates AND creates the prefilled agent; deleting it quits the declaration (remove/re-add regression)', async () => {
  const b = await settingsBoot({ prefs: { declaredPills: ['integration_resend'] }, specs: SPECS });
  b.click('blob-tile-new'); await flush();
  assert.equal(b.get('create-kind-catalog').getAttribute('aria-pressed'), 'true');
  b.get('pill-catalog-search').value = 'n8n'; b.get('pill-catalog-search').fire('input');
  b.get('pill-catalog-row-integration_n8n').fire('click');
  b.click('pill-catalog-add'); await flush(); await flush();
  const acts = writes(b).map(x => x.payload.action);
  assert.deepEqual(acts.slice(0, 1), ['toggle_declared_pill'], 'the SAME public toggle command declares it');
  assert.deepEqual(writes(b)[0].payload, { action: 'toggle_declared_pill', id: 'integration_n8n' });
  const made = b.backend.specs.specialists.find(x => x.name === 'n8n');
  assert.ok(made && made.instructions.includes('n8n'), 'the agent is created pre-filled from the catalog');
  assert.ok(b.backend.prefs.declaredPills.includes('integration_n8n'));
  // remove ...
  b.click('blob-editor-delete'); await flush(); b.click('blob-delete-confirm'); await flush(); await flush();
  assert.ok(!b.backend.specs.specialists.some(x => x.name === 'n8n'));
  assert.ok(!b.backend.prefs.declaredPills.includes('integration_n8n'), 'the declaration leaves with the agent');
  assert.ok(!/n8n/.test(b.get('blob-saved-before') ? b.get('blob-saved-before').textContent : ''), 'it does not come back as «Guardado de antes»');
  // ... and re-add through the same chooser
  b.click('blob-tile-new'); await flush();
  b.get('pill-catalog-row-integration_n8n').fire('click'); b.click('pill-catalog-add'); await flush(); await flush();
  assert.equal(writes(b).filter(x => x.payload.action === 'toggle_declared_pill' && x.payload.id === 'integration_n8n').length, 3, 'declare, quit, declare again');
  assert.ok(b.backend.prefs.declaredPills.includes('integration_n8n'));
});

test('#442 «Guardados de antes»: a stored custom blob becomes an agent only on the explicit action; the original entry stays', async () => {
  const b = await settingsBoot({ prefs: { declaredPills: [] }, extraPrefs: { customBlobs: [{ name: 'Música', color: 'purple' }] }, specs: SPECS });
  assert.deepEqual(b.backend.specs.specialists.map(x => x.name), ['Revisor', 'Notas'], 'nothing converts by itself');
  allByClass(b.get('blob-saved-before'), 'blob-convert')[0].fire('click'); await flush(); await flush();
  const made = b.backend.specs.specialists[2];
  assert.equal(made.name, 'Música');
  assert.deepEqual(writes(b).map(x => x.payload).slice(0, 1), [{ action: 'set_avatar_color', identity: made.id, color: 'purple' }]);
  assert.deepEqual(b.backend.prefs.customBlobs.map(x => x.name), ['Música'], 'the original stored entry is NOT removed');
  assert.ok(b.get('blob-saved-before') === null, 'it is no longer offered once it has an agent');
});

test('#442 deleting an agent needs the inline confirmation; synthetic gestures and a failed delete change nothing', async () => {
  const b = await settingsBoot({ specs: SPECS });
  b.click('blob-editor-delete'); await flush();
  assert.deepEqual(b.backend.specCalls, [], 'the first click only asks');
  b.get('blob-delete-confirm').fire('click', { isTrusted: false }); await flush();
  assert.deepEqual(b.backend.specCalls, []);
  b.backend.rejectSpec = true;
  b.click('blob-delete-confirm'); await flush();
  assert.equal(b.backend.specs.specialists.length, 2, 'a refused delete keeps the agent');
  assert.match(b.get('blob-settings-error').textContent, /No se pudo guardar el agente/);
  b.click('blob-editor-delete'); await flush(); // the failure returns to the editor: ask again
  b.click('blob-delete-confirm'); await flush();
  assert.deepEqual(b.backend.specCalls.map(x => x.action), ['delete']);
  assert.deepEqual(b.backend.specs.specialists.map(x => x.id), ['esp-b']);
});

test('#442 principal «Qué hace» uses set_abito_instructions and «Modelo» the existing models_action select; no new model key', async () => {
  const b = await settingsBoot({ specs: SPECS });
  b.click('blob-principal-card'); await flush();
  assert.equal(b.get('blob-editor-name').disabled, true);
  const what = b.get('blob-editor-what'); what.value = 'Mi asistente'; what.fire('change'); await flush();
  assert.deepEqual(writes(b).map(x => x.payload), [{ action: 'set_abito_instructions', text: 'Mi asistente' }]);
  assert.equal(b.backend.prefs.abitoInstructions, 'Mi asistente');
  assert.ok(b.get('blob-declarativo'));
  const model = b.get('blob-editor-model'); model.value = 'gpt-5.1'; model.fire('change'); await flush();
  assert.deepEqual(b.calls.filter(c => c.cmd === 'models_action' && c.payload.action === 'select').map(c => c.payload), [{ action: 'select', profile_id: 'gpt-5.1' }]);
});

test('#442 an identical state push neither rebuilds the Blobs screen nor restarts a character; leaving the tab disposes them', async () => {
  const b = await settingsBoot({ specs: SPECS });
  const grid = b.get('blob-agent-grid');
  b.emit({}); b.emit({}); await flush();
  assert.equal(b.get('blob-agent-grid'), grid, 'the very same node: no rebuild on identical pushes');
  b.click('settings-tab-general'); await flush();
  b.click('settings-tab-pills'); await flush();
  assert.ok(b.get('blob-agent-grid'));
});


test('#442 settings uses the lexical clay engine and destroys all characters when closed', async () => {
  const b = await settingsBoot({ specs: SPECS });
  assert.ok(b.clayStatus().length > 0, 'the engine is lexical AbitoClay, not window.AbitoClay');
  let destroyed = 0;
  const instances = b.clayStatus().filter(i => !b.get('pill-choices').contains(i.svg));
  for (const instance of instances) { const destroy = instance.destroy; instance.destroy = () => { destroyed++; destroy(); }; }
  b.click('settings-close'); await flush();
  assert.equal(destroyed, instances.length, 'all mounted real characters stop on close');
});

// #439 T7.1: the portal pushes state about every 400 ms. A push that changes
// nothing the panel renders must NOT rebuild the DOM: every rebuild replays the
// view transitions and blinks Ajustes while the human navigates.
const nodesStable = (body, before) => before.length === body.children.length && before.every((n, i) => body.children[i] === n);

test('#439 an identical state push keeps the Ajustes DOM: same nodes, no rebuild; a changed input rebuilds', async () => {
  const b = boot(); await flush();
  // wrap the harness listener registry so the test can push agent:state too
  const pushed = {};
  const origListen = b.window.__TAURI__.event.listen;
  b.window.__TAURI__.event.listen = (name, fn) => { (pushed[name] ||= []).push(fn); return origListen(name, fn); };
  for (const file of ['avatar-colors.js', 'settings-view.js', 'pill-settings.js', 'settings.js']) b.load(file);
  b.click('open-screen-settings'); await flush();
  const body = b.get('settings-body');
  assert.ok(body.children.length, 'the panel rendered');
  // prefs: an identical push preserves node identity (no transition replay),
  // a changed pref rebuilds
  let before = [...body.children];
  b.emit({}); await flush();
  assert.ok(nodesStable(body, before), 'identical prefs push: node identity preserved');
  b.emit({ sound: true }); await flush();
  assert.ok(!nodesStable(body, before), 'a changed pref rebuilds the panel');
  // agent state: identical push preserves, a changed connection rebuilds
  before = [...body.children];
  for (const fn of pushed['agent:state'] || []) fn({ payload: { connection: 'no_daemon' } });
  await flush();
  assert.ok(nodesStable(body, before), 'identical agent push: node identity preserved');
  for (const fn of pushed['agent:state'] || []) fn({ payload: { connection: 'lost' } });
  await flush();
  assert.ok(!nodesStable(body, before), 'a changed agent state rebuilds the panel');
});

test('#439 a screen switch rebuilds; a typed draft survives an identical push and rides the next rebuild', async () => {
  const b = await settingsBoot(undefined, 'general');
  const body = b.get('settings-body');
  const before = [...body.children];
  b.click('settings-tab-accounts'); await flush(); // screen is a key input: the push category must rebuild
  assert.ok(!nodesStable(body, before), 'a screen switch rebuilds the panel');
  // a draft typed into the live field renders identically from live state: an
  // identical push must not rebuild, and the keystrokes must survive the next one
  b.click('settings-tab-general'); await flush();
  const field = b.get('settings-display-name');
  assert.ok(field, 'the name field renders on General');
  const typed = field;
  typed.value = 'Ana'; typed.fire('input'); // sets the draft, renders nothing
  const kids = [...body.children];
  b.emit({}); await flush();
  assert.ok(nodesStable(body, kids), 'identical push while typing: no rebuild, keystrokes stay');
  assert.equal(b.get('settings-display-name').value, 'Ana');
  b.emit({ sound: true }); await flush();
  assert.ok(!nodesStable(body, kids), 'a real change rebuilds the panel');
  assert.equal(b.get('settings-display-name').value, 'Ana', 'the draft rides the rebuild (never stale)');
  // the failure chip clears through its own timer: the 6 s callback must reset
  // the key bit BEFORE rendering, or a skipped render would freeze the chip
  const src = read('settings.js');
  assert.match(src, /failureTimer = 0; render\(\)/, 'the failure timer re-arms the key before rendering');
});


test('#442 island consumes stored specialist projection, ordered membership, stale removal and unchanged legacy data', async () => {
  const b = boot({ specs: SPECS, extraPrefs: { islandAgents: ['esp-b', 'esp-a'], avatarColors: { 'esp-b': 'purple' } } });
  b.load('specialists.js'); await flush();
  const ids = () => b.get('pill-choices').children.map(n => n.dataset.pillId);
  assert.deepEqual(ids(), ['abito', 'esp-b', 'esp-a']);
  assert.match(b.get('pill-choice-esp-b').textContent, /Notas/);
  assert.equal(b.get('pill-choice-esp-b').dataset.color, 'purple');
  const legacy = clone({ mainPill: b.backend.prefs.mainPill, declaredPills: b.backend.prefs.declaredPills, customBlobs: b.backend.prefs.customBlobs });
  for (const order of [[], ['esp-a'], ['esp-b', 'esp-a'], ['esp-a', 'esp-b', 'esp-missing']]) {
    b.emit({ islandAgents: order });
    assert.deepEqual(ids(), ['abito', ...order.filter(x => x !== 'esp-missing')]);
  }
  assert.deepEqual(clone({ mainPill: b.backend.prefs.mainPill, declaredPills: b.backend.prefs.declaredPills, customBlobs: b.backend.prefs.customBlobs }), legacy);
  assert.equal(writes(b).length, 0, 'reading membership never migrates legacy storage');
});


test('#442 off-island active target stays honest, Abito stays reachable, deleted target follows backend null projection', async () => {
  const b = boot({ specs: SPECS }); b.load('specialists.js'); await flush();
  b.click('pill-choice-esp-a'); await flush();
  b.emit({ islandAgents: ['esp-b'] });
  assert.equal(b.backend.specs.active, 'esp-a');
  assert.equal(b.get('pill-name').textContent, 'Revisor');
  assert.equal(b.get('pill-state').textContent, 'Fuera de la isla');
  assert.equal(b.get('pill-choice-abito').getAttribute('aria-pressed'), 'false');
  b.click('pill-choice-abito'); await flush();
  assert.deepEqual(b.backend.specCalls.at(-1), { action: 'select', id: null });
  assert.equal(b.backend.specs.active, null);
  assert.equal(b.get('pill-name').textContent, 'Koda');
  b.emit({ islandAgents: ['esp-a', 'esp-b'] });
  b.click('pill-choice-esp-a'); await flush();
  await b.window.AbitoSpecialistsPanel.act({ action: 'delete', id: 'esp-a' });
  assert.equal(b.backend.specs.active, null, 'the backend deletion projection clears target');
  assert.equal(b.get('pill-name').textContent, 'Koda');
  assert.equal(b.get('pill-choice-esp-a'), null);
});

test('#442 all 0..3 slots follow saved order and unchanged pushes preserve real clay instances', async () => {
  const b = boot({ specs: [...SPECS, { id: 'esp-c', name: 'Correo', instructions: 'Correo', model: null }] });
  b.load('specialists.js'); await flush();
  for (const order of [[], ['esp-c'], ['esp-b', 'esp-c'], ['esp-c', 'esp-a', 'esp-b']]) {
    b.emit({ islandAgents: order });
    assert.deepEqual(b.get('pill-choices').children.map(n => n.dataset.pillId), ['abito', ...order]);
  }
  const count = b.clayStatus().length;
  b.emit({ islandAgents: ['esp-c', 'esp-a', 'esp-b'] });
  assert.equal(b.clayStatus().length, count, 'no real engine recreation on unchanged push');
  const css = read('style.css');
  for (const color of b.window.AbitoAvatarColors.PALETTE) {
    for (let n = 1; n <= 3; n++) assert.ok(css.includes(`.island-agent-clay[data-color="${color}"] radialGradient[id$="skin"] stop:nth-child(${n}) { stop-color: var(--dot-${color}-${n}); }`), `${color} stop ${n} really tinted`);
  }
});


test('#442 merged render skip observes specialist content and remounts Settings clay after close/reopen', async () => {
  const b = await settingsBoot({ specs: SPECS });
  b.click('blob-tile-esp-a'); await flush();
  await b.window.AbitoSpecialistsPanel.act({ action: 'update', id: 'esp-a', name: 'Revisor', instructions: 'Changed specialty', model: null });
  assert.equal(b.get('blob-editor-what').value, 'Changed specialty');
  b.click('settings-close'); await flush();
  const before = b.clayStatus().length;
  b.click('open-screen-settings'); await flush();
  assert.ok(b.clayStatus().length > before, 'real clay remounts after reopen, even if source snapshots stayed identical');
});


test('#442 unchanged island rows never detach surviving real clay SVG nodes', async () => {
  const b = boot({ specs: SPECS }); b.load('specialists.js'); await flush();
  const host = b.get('pill-choices'), before = host.replaceCalls;
  const nodes = [...host.children];
  const instances = b.clayStatus().length;
  b.emit({ gain: 0.1 });
  assert.equal(host.replaceCalls, before, 'no DOM detach/reinsert on an unrelated prefs push');
  assert.deepEqual(host.children, nodes);
  assert.equal(b.clayStatus().length, instances);
});

test('#442 real island characters stop outside overview and use static poses for the actual data-motion setting', async () => {
  const b = boot({ specs: SPECS }); b.load('specialists.js'); await flush();
  const islandClays = () => b.clayStatus().filter(i => b.get('pill-choices').contains(i.svg) && !i.testDestroyed);
  assert.equal(islandClays().length, 3);
  for (const covered of [{ phase: 'compact', view: 'overview' }, { phase: 'expanded', view: 'chat' },
    { phase: 'expanded', view: 'overview', settings: 'open' },
    { phase: 'expanded', view: 'overview', card: 'pending' },
    { phase: 'expanded', view: 'overview', noticeView: 'notices' }]) {
    b.get('capsule').dataset = covered; b.mutate(b.get('capsule'));
    assert.equal(islandClays().length, 0, 'invisible characters unregister from the real engine loop');
    b.get('capsule').dataset = { phase: 'expanded', view: 'overview' }; b.mutate(b.get('capsule'));
    assert.equal(islandClays().length, 3);
  }
  b.doc.documentElement.dataset.motion = 'reduce'; b.mutate(b.doc.documentElement);
  assert.equal(islandClays().length, 3);
  assert.ok(islandClays().every(i => i.live === false), 'staticPose instances are never registered in the real shared loop');
  assert.ok(islandClays().every(i => i.sample().d), 'reduced mode still draws real engine geometry');
  b.doc.documentElement.dataset.motion = 'full'; b.mutate(b.doc.documentElement);
  assert.ok(islandClays().every(i => i.live === true));
});


test('S13 unrelated prefs preserve Blobs nodes, editor caret and actual continuing engine frames', async () => {
  const b = await settingsBoot({ specs: SPECS });
  b.click('blob-tile-esp-a'); await flush();
  const tile = b.get('blob-tile-esp-a'), what = b.get('blob-editor-what');
  what.value = 'Unsent draft'; what.selectionStart = 3; what.selectionEnd = 7; what.focus();
  const clay = b.clayStatus().findLast(i => !i.testDestroyed && tile.contains(i.svg));
  b.advanceFrames(12); const before = clay.sample(); const created = b.clayStatus().length;
  b.emit({ gain: 0.08, sound: true, displayName: 'Someone', autoCloseSeconds: 30 });
  assert.ok(b.get('blob-tile-esp-a') === tile, 'no re-created DOM tile');
  assert.ok(b.get('blob-editor-what') === what, 'same editor and selection');
  assert.equal(what.value, 'Unsent draft'); assert.equal(what.selectionStart, 3); assert.equal(what.selectionEnd, 7);
  assert.equal(b.clayStatus().length, created, 'no re-created engine instances');
  assert.equal(clay.testDestroyed, undefined);
  b.advanceFrames(12); const after = clay.sample();
  assert.ok(after.t > before.t); assert.notEqual(after.d, before.d, 'actual scheduled frames change the live SVG geometry');
});

test('S13 Blobs disposes real instances on Models and Connections exits and remounts on return', async () => {
  const b = await settingsBoot({ specs: SPECS });
  for (const tab of ['models', 'accounts']) {
    const instances = b.clayStatus().filter(i => !i.testDestroyed && b.get('settings-body').contains(i.svg));
    assert.ok(instances.length > 0);
    b.advanceFrames(8);
    b.click('settings-tab-' + tab); await flush();
    assert.ok(instances.every(i => i.testDestroyed), tab + ' exit unregisters every Blobs instance');
    const stopped = instances.map(i => i.sample().t);
    b.advanceFrames(12);
    assert.deepEqual(instances.map(i => i.sample().t), stopped, 'detached characters stop receiving frames');
    b.click('settings-tab-pills'); await flush();
    const resumed = b.clayStatus().filter(i => !i.testDestroyed && b.get('settings-body').contains(i.svg));
    assert.ok(resumed.length > 0);
    const before = resumed[0].sample(); b.advanceFrames(12);
    assert.ok(resumed[0].sample().t > before.t); assert.notEqual(resumed[0].sample().d, before.d);
  }
});

test('#489 declared integration pills with a live poller show with their colour; click focuses the card, leaves the grid and never selects a target', async () => {
  const b = boot({ specs: SPECS, prefs: { declaredPills: ['integration_n8n', 'integration_vercel', 'integration_github'], pillColors: { integration_n8n: 'orange' } } }); b.load('specialists.js'); await flush();
  const ids = () => b.get('pill-choices').children.map(n => n.dataset.pillId);
  const base = ids(); assert.deepEqual(base, ['abito', 'esp-a', 'esp-b'], 'no poller answer yet: specialists only (unchanged)');
  b.doc.dispatchEvent({ type: 'abito:integration-seen', detail: { ids: ['integration_n8n', '__proto__'] } });
  assert.deepEqual(ids(), [...base, 'integration_n8n'], 'only declared + card-capable + answered');
  const n8n = b.get('pill-choices').children[3];
  assert.equal(n8n.dataset.color, 'orange');
  const focus = []; b.events['abito:integration-focus'] = [e => focus.push(e.detail.id)];
  n8n.fire('click', { isTrusted: false }); assert.deepEqual(focus, []);
  n8n.fire('click'); assert.deepEqual(focus, ['integration_n8n']);
  assert.deepEqual(ids(), [...base, 'integration_n8n'], 'design 16: the focused pill is the card AND stays a marked row of the column');
  assert.equal(b.get('pill-choice-integration_n8n').getAttribute('aria-pressed'), 'true'); assert.equal(b.get('pill-choice-integration_n8n').dataset.centre, 'true');
  assert.equal(b.backend.specCalls.length, 0, 'never a chat target');
  assert.equal(b.get('pill-name').textContent, 'Koda');
  b.click('pill-choice-esp-a'); await flush();
  assert.deepEqual(focus, ['integration_n8n', null], 'choosing a chat target releases the integration card');
  assert.deepEqual(ids(), [...base, 'integration_n8n'], 'and the pill returns to the grid');
  n8n.fire('click');
  b.doc.dispatchEvent({ type: 'abito:integration-seen', detail: { ids: [] } });
  assert.equal(focus.at(-1), null, 'a vanished service releases the card');
  assert.deepEqual(ids(), base);
});

test('GitHub declared + connected shows a pill; trusted focus opens its card without changing the chat target', async () => {
  const b = boot({ github: true, prefs: { declaredPills: ['integration_github', 'integration_n8n'] } });
  b.load('island-github.js'); await flush();
  const ids = () => b.get('pill-choices').children.map(n => n.dataset.pillId);
  const card = b.leftCard.children[0];
  assert.deepEqual(ids(), ['abito', 'integration_github'], 'a gh pulse discovers the declared integration without mainPill');
  assert.equal(card.hidden, true, 'discovery does not focus');
  b.doc.dispatchEvent({ type: 'abito:integration-seen', detail: { ids: ['integration_n8n'] } });
  assert.deepEqual(ids(), ['abito', 'integration_github', 'integration_n8n'], 'the other poller snapshot must not erase GitHub');
  b.click('pill-choice-integration_github', { isTrusted: false }); assert.equal(card.hidden, true);
  b.click('pill-choice-integration_github'); await flush();
  assert.equal(card.hidden, false); assert.match(card.textContent, /GitHub 17/);
  assert.equal(b.get('overview-view').dataset.github, 'on');
  assert.deepEqual(ids(), ['abito', 'integration_github', 'integration_n8n'], 'the focused pill is the left card and its row stays IN PLACE, marked active');
  assert.equal(b.get('pill-choice-integration_github').getAttribute('aria-pressed'), 'true'); assert.equal(b.get('pill-choice-integration_github').dataset.centre, 'true');
  assert.equal(b.backend.specCalls.length, 0); assert.equal(b.backend.writes, 0);
  b.click('pill-choice-integration_n8n'); assert.equal(card.hidden, true, 'focusing another integration hides GitHub');
  b.click('pill-choice-integration_github');
  b.get('capsule').dataset.view = 'chat'; b.mutate(b.get('capsule')); assert.equal(card.hidden, true);
  b.get('capsule').dataset.view = 'overview'; b.mutate(b.get('capsule')); await flush();
  assert.equal(card.hidden, false);
  b.click('pill-choice-abito'); await flush(); assert.equal(card.hidden, true, 'chat target releases focus');
  b.click('pill-choice-integration_github'); b.backend.githubAvailable = false;
  for (const refresh of [...b.intervals.values()]) refresh(); await flush();
  assert.equal(card.hidden, true, 'lost gh connection releases the focused card');
  assert.deepEqual(ids(), ['abito', 'integration_n8n'], 'disconnect only removes GitHub');
  b.backend.githubAvailable = true;
  for (const refresh of [...b.intervals.values()]) refresh(); await flush();
  assert.ok(ids().includes('integration_github'), 'polling discovers reconnection');
  b.click('pill-choice-integration_github');
  b.emit({ declaredPills: ['integration_n8n'] }); await flush();
  assert.equal(card.hidden, true, 'undeclaring hides the card');
  assert.deepEqual(ids(), ['abito', 'integration_n8n']);
  assert.equal(b.intervals.size, 0, 'undeclared GitHub stops polling');
  assert.ok(b.calls.filter(c => c.cmd === 'github_action').every(c => c.payload.action === 'refresh' && ['pulse', 'activity'].includes(c.payload.section)));
});

test('GitHub without a declaration or a successful gh answer never enters the grid', async () => {
  for (const declared of [false, true]) {
    const b = boot({ github: true, prefs: { declaredPills: declared ? ['integration_github'] : [] } });
    b.backend.githubAvailable = false; b.load('island-github.js'); await flush();
    assert.deepEqual(b.get('pill-choices').children.map(n => n.dataset.pillId), ['abito']);
    assert.equal(b.leftCard.children[0].hidden, true);
    if (!declared) assert.equal(b.calls.filter(c => c.cmd === 'github_action').length, 0);
  }
});

test('A+E: the right column has NO four-cell cap (every declared pill stays); the focused one still moves to the card', async () => {
  const b = boot({ github: true, specs: SPECS, prefs: { declaredPills: ['integration_github', 'integration_n8n', 'integration_vercel'] } });
  b.load('specialists.js'); b.load('island-github.js'); await flush();
  b.doc.dispatchEvent({ type: 'abito:integration-seen', detail: { ids: ['integration_n8n', 'integration_vercel'] } });
  // human (A+E): «las sesiones empujan las pastillas declaradas» — the column scrolls instead of dropping anything
  assert.deepEqual(b.get('pill-choices').children.map(n => n.dataset.pillId), ['abito', 'esp-a', 'esp-b', 'integration_github', 'integration_n8n', 'integration_vercel']);
  b.click('pill-choice-integration_github');
  assert.deepEqual(b.get('pill-choices').children.map(n => n.dataset.pillId), ['abito', 'esp-a', 'esp-b', 'integration_github', 'integration_n8n', 'integration_vercel'], 'design 16: the focused pill is the card AND keeps its (marked) row');
  assert.equal(b.leftCard.children[0].hidden, false, 'the focused card still shows');
});

test('#489 an unseen event puts a badge on an unfocused integration pill; focusing clears it', async () => {
  const b = boot({ prefs: { declaredPills: ['integration_vercel'] } }); await flush();
  b.doc.dispatchEvent({ type: 'abito:integration-seen', detail: { ids: ['integration_vercel'] } });
  const pill = () => b.get('pill-choices').children[1];
  assert.equal(pill().dataset.badge, 'false');
  b.doc.dispatchEvent({ type: 'abito:integration-badge', detail: { id: 'integration_vercel' } });
  assert.equal(pill().dataset.badge, 'true');
  assert.match(pill().getAttribute('aria-label'), /con novedades/);
  pill().fire('click');
  b.doc.dispatchEvent({ type: 'abito:integration-focus', detail: { id: null } });
  assert.equal(b.get('pill-choices').children.length, 2, 'focused: still a marked row of the column');
  b.click('pill-choice-abito'); await flush();
  assert.equal(pill().dataset.badge, 'false', 'focusing cleared it');
});

test('A+E: five declared integrations all stay in the right column (it scrolls; the old 2x2 cap of four is gone); the focused one is the card', async () => {
  const b = boot({ specs: SPECS, prefs: { declaredPills: ['integration_n8n', 'integration_vercel', 'integration_stripe', 'integration_resend'] } }); b.load('specialists.js'); await flush();
  b.doc.dispatchEvent({ type: 'abito:integration-seen', detail: { ids: ['integration_n8n', 'integration_vercel', 'integration_stripe', 'integration_resend'] } });
  const ids = () => b.get('pill-choices').children.map(n => n.dataset.pillId);
  assert.deepEqual(ids(), ['abito', 'esp-a', 'esp-b', 'integration_n8n', 'integration_vercel', 'integration_stripe', 'integration_resend'], 'nothing is dropped');
  b.get('pill-choices').children[3].fire('click');
  assert.deepEqual(ids(), ['abito', 'esp-a', 'esp-b', 'integration_n8n', 'integration_vercel', 'integration_stripe', 'integration_resend'], 'the focused one is the card and keeps its marked row');
  assert.doesNotMatch(read('style.css'), /#pill-choices \.pill-choice:nth-child\(n\+5\)\s*\{\s*display:\s*none/, 'the CSS belt that hid the fifth is gone');
});

test('A+E: EVERY live session is a blob in the right column (not only those with tool steps or a declared source); the column scrolls', async () => {
  const b = boot({ specs: SPECS, prefs: {} }); b.load('specialists.js'); await flush();
  b.backend.sessionRows = [
    { id: 's-11111111', kind: 'pi', cwd: 'alpha', origin: null, state: 'sleeping' },
    { id: 's-22222222', kind: 'claude-code', cwd: 'beta', origin: null, state: 'running' },
    { id: 's-33333333', kind: 'codex', cwd: 'gamma', origin: null, state: 'sleeping' },
    { id: 's-44444444', kind: 'gemini', cwd: 'delta', origin: null, state: 'sleeping' },
  ];
  b.load('sessions-ticker.js'); await flush(); await flush();
  const ids = b.get('pill-choices').children.map(n => n.dataset.pillId);
  for (const id of ['s-11111111', 's-22222222', 's-33333333', 's-44444444']) assert.ok(ids.includes(id), `${id} is a blob row: ${ids}`);
  assert.deepEqual(ids.slice(0, 3), ['abito', 'esp-a', 'esp-b'], 'declared first, sessions after');
});

test('the session key sent for the terminal is always the well-formed row id, else none (never page text)', async () => {
  const b = boot(); await flush();
  b.backend.sessionRows = [{ id: 's-11111111', kind: 'pi', cwd: 'alpha', origin: null, state: 'running' }];
  b.load('sessions-ticker.js'); await flush(); await flush();
  const src = fs.readFileSync(path.join(__dirname, '../frontend/sessions-ticker.js'), 'utf8');
  assert.match(src, /\/\^s-\[0-9a-f\]\{8\}\$\/\.test\(/, 'the key is checked against the daemon id grammar before it is sent');
  const island = fs.readFileSync(path.join(__dirname, '../frontend/island.js'), 'utf8');
  assert.match(island, /focusedSessionKey/, 'the Ctrl+Alt+T shortcut uses the same focused session');
  assert.match(island, /abito:sessions-view/);
});

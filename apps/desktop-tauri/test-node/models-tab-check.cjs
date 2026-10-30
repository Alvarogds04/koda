'use strict';
/* #414 — Ajustes → Modelos: the provider groups models.js renders inside the
   `#models` panel, driven through the REAL production script with a minimal
   fake DOM (the convention of chat-model-picker-check.cjs). No browser, no
   Tauri, no network.

   What is REAL: production `frontend/models.js` (the panel, the provider
   section, the toggle payloads) and production `frontend/chat-view.js`
   (the view-model contract models.js already consumes). What is FAKE: the
   DOM, the IPC and the fixtures — all local to this file.

   Observables: the group rows the panel shows (one per engine provider,
   models only for the CONNECTED ones, a hint for the rest), and the closed
   `prefs_action` payload a toggle sends (the WHOLE list of that provider).

   Run: node apps/desktop-tauri/test-node/models-tab-check.cjs
*/
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const FRONTEND = path.join(__dirname, '..', 'frontend');

// ---- fixtures (the shapes the Rust hosts really publish) ---------------------

const AGENT_VIEW = {
  connection: 'connected',
  providers: [
    { id: 'anthropic', name: 'Anthropic', methods: ['oauth'], configured: true },
    { id: 'openai', name: 'OpenAI', methods: ['oauth', 'api_key'], configured: false },
  ],
  accounts: [], // openai is fully disconnected here: no configured row, so only the hint may show
  // the folded `models` frame (agentclient), bounded closed rows
  models: [
    { provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', reasoning: true, contextWindow: 200000 },
    { provider: 'anthropic', id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true, contextWindow: 200000 },
    { provider: 'openai', id: 'gpt-5.2', name: 'GPT-5.2', reasoning: false, contextWindow: 128000 },
  ],
};
const PREFS = { v: 1, sound: false, chosenModels: { anthropic: ['claude-opus-4-6'] } };
const LOCAL_LISTING = { revision: 1, selected: null, profiles: [] };

// ---- fake DOM (the convention of chat-model-picker-check.cjs) -----------------

function makeDom() {
  const elements = new Map();
  const documentListeners = {};
  function fire(target, ev) {
    if (!ev || !ev.type) return;
    ev.target = ev.target || target;
    ev.currentTarget = target;
    if (typeof ev.preventDefault !== 'function') ev.preventDefault = function () {};
    for (const fn of (target.listeners[ev.type] || []).slice()) fn.call(target, ev);
  }
  function El(id, tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      children: [], dataset: {}, style: {}, listeners: {},
      hidden: false, disabled: false, inert: false, value: '',
      textContent: '', innerHTML: '', className: '',
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      setAttribute(k, v) { el.attributes[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : null; },
      removeAttribute(k) { delete el.attributes[k]; },
      addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
      removeEventListener() {},
      append(...nodes) { for (const n of nodes) el.children.push(n); },
      appendChild(n) { el.children.push(n); return n; },
      replaceChildren(...nodes) { el.children = [...nodes]; },
      insertBefore(node, ref) {
        const at = ref ? el.children.indexOf(ref) : -1;
        if (at < 0) el.children.push(node); else el.children.splice(at, 0, node);
        return node;
      },
      remove() {},
      focus() {},
      click() { fire(el, { type: 'click', detail: 0 }); },
      querySelector() { return null; },
      querySelectorAll(sel) { return sel === '[data-icon]' ? [] : []; },
      closest() { return null; },
      contains() { return false; },
    };
    // `id` is an accessor: scripts assign ids to detached nodes (provSection.id = …) and
    // getElementById must find them afterwards, exactly like the real DOM.
    let _id = id || null;
    Object.defineProperty(el, 'id', {
      get: () => _id,
      set(v) { _id = v; if (v) elements.set(String(v), el); },
      enumerable: true, configurable: true,
    });
    el.attributes = {};
    return el;
  }
  const document = {
    activeElement: null,
    listeners: documentListeners,
    importNode(node) { return node; },
    addEventListener(type, fn) { (documentListeners[type] = documentListeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) { fire(document, ev); return true; },
    getElementById(id) { if (!elements.has(id)) elements.set(id, El(id)); return elements.get(id); },
    createElement(tag) { return El(null, tag); },
  };
  return {
    document, documentListeners, el: id => document.getElementById(id),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    DOMParser: class { parseFromString(text) { return /^\s*<svg[\s>]/.test(text) ? { documentElement: { nodeName: 'svg' } } : { documentElement: null }; } },
  };
}

// Static fixture shapes only; a clone failure is a harness bug, so it is re-raised with context
// (never silently swallowed) instead of throwing raw from JSON.parse.
const clone = value => {
  try { return JSON.parse(JSON.stringify(value)); }
  catch (err) { throw new Error(`models-tab-check fixture clone failed: ${err.message}`); }
};

async function loadPage(opts) {
  const o = opts || {};
  const dom = makeDom();
  const invocations = [];
  const listeners = {};
  let agentView = clone(o.agentView !== undefined ? o.agentView : AGENT_VIEW);
  const prefs = Object.assign(clone(PREFS), o.prefs !== undefined ? clone(o.prefs) : {});

  const emit = (name, payload) => { for (const cb of (listeners[name] || [])) cb({ payload: clone(payload) }); };
  const settle = () => new Promise(resolve => setImmediate(resolve));

  const invoke = (cmd, args) => {
    const payload = args && args.payload;
    invocations.push({ cmd, payload: clone(payload) });
    if (cmd === 'models_action') return Promise.resolve(clone(o.localListing !== undefined ? o.localListing : LOCAL_LISTING));
    if (cmd === 'agent_action') {
      if (payload && payload.action === 'view') return Promise.resolve(clone(agentView));
      // any command's reply is the connection state; the frames arrive as events
      return Promise.resolve(clone(agentView));
    }
    if (cmd === 'prefs_action') {
      // What the host does on a write: validate (here: trust the closed shape), persist, reply
      // with the projection — so the next toggle reads what this one stored.
      if (payload && payload.action === 'set_chosen_models') {
        const map = Object.assign({}, prefs.chosenModels || {});
        if (Array.isArray(payload.models) && payload.models.length) map[payload.provider] = clone(payload.models);
        else delete map[payload.provider];
        prefs.chosenModels = map;
      }
      return Promise.resolve(clone(prefs));
    }
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  };
  const listen = (name, cb) => { (listeners[name] = listeners[name] || []).push(cb); return Promise.resolve(() => {}); };

  const sandbox = {
    window: null, self: null, document: dom.document,
    requestAnimationFrame: cb => { cb(0); return 0; }, setTimeout: () => 0, clearTimeout: () => {},
    CustomEvent: dom.CustomEvent, DOMParser: dom.DOMParser, console,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.window.AbitoIcons = { svg: name => `<svg data-name="${name}"></svg>`, meter: () => '<svg></svg>' };
  sandbox.window.__TAURI__ = { core: { invoke }, event: { listen } };
  vm.createContext(sandbox);
  for (const file of ['chat-view.js', 'settings-view.js', 'models.js']) {
    vm.runInContext(fs.readFileSync(path.join(FRONTEND, file), 'utf8'), sandbox, { filename: file });
  }

  // index.html ships the panel closed; mirror its initial state
  dom.el('models').inert = true;
  dom.el('models-list').setAttribute('aria-busy', 'true');

  const openModelsTab = async () => {
    dom.document.dispatchEvent(new dom.CustomEvent('abito:settings-tab', { detail: 'models' }));
    await settle(); await settle();
  };

  return {
    dom, invocations, settle, openModelsTab, emit,
    agentView: () => agentView,
    setAgentView(next) { agentView = clone(next); },
    prefs: () => prefs,
    panel: () => dom.el('models'),
    section: () => dom.el('models-providers'),
    listEl: () => dom.el('models-providers').children.find(n => n.tagName === 'UL'),
    rows: () => { const ul = dom.el('models-providers').children.find(n => n.tagName === 'UL'); return ul ? ul.children : []; },
    toggles: () => {
      const ul = dom.el('models-providers').children.find(n => n.tagName === 'UL');
      return ul ? ul.children.flatMap(li => li.children.filter(n => n.tagName === 'BUTTON')) : [];
    },
  };
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  const n = passed + failures.length + 1;
  try {
    await fn();
    passed += 1;
    console.log(`ok ${n} - ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL ${n} - ${name}\n       ${String((err && err.message) || err).split('\n')[0]}`);
  }
}

// The fake DOM keeps textContent as a flat field, so gathering text must recurse into
// children and concatenate — exactly what a real textContent reports for a subtree.
const text = node => {
  if (!node) return '';
  if (node.children && node.children.length) return node.children.map(text).join('');
  return node.textContent || '';
};

async function main() {
  await check('#414 markup: the Models panel is a tabpanel models.js fills; the providers section lives inside it', async () => {
    const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
    assert.match(html, /<div id="models" inert role="tabpanel"/);
    assert.match(html, /id="models-list"/, 'the local picker list is still there');
    // the provider section ships with the page: the flat radio-row list rules, the «Locales»
    // group label and the shared choose control. T7.2: the disconnected-provider hint is gone
    // (the design draws no disconnected group; was: .models-prov-hint + «Conectá … en Conexiones»).
    const css = fs.readFileSync(path.join(FRONTEND, 'style.css'), 'utf8');
    assert.match(css, /#models-list \.choose, \.models-prov \.choose/, 'the toggle reuses the local picker circle control');
    assert.match(css, /\.models-prov-title/, 'the group label «Cuentas conectadas»');
    assert.match(css, /\.models-prov-model \{[^}]*min-height: 44px/, 'radio rows keep the 44px row');
    assert.ok(!css.includes('.models-prov-hint'), 'the provider hint styles are gone');
    assert.match(css, /\.models-local-label/, 'the «Locales» group label above the local picker');
  });

  const rowTitles = row => row.children.find(n => n.className === 'model-titles');
  const rowTitle = row => { const w = rowTitles(row); const t = w && w.children.find(n => n.className === 'model-title'); return t ? text(t) : ''; };
  const rowSub = row => { const w = rowTitles(row); const t = w && w.children.find(n => n.className === 'model-sub'); return t ? text(t) : ''; };
  const rowProvider = row => { const c = row.children.find(n => n.className === 'chip models-prov-chip'); return c ? text(c) : ''; };
  const rowCaps = row => { const c = row.children.find(n => n.className === 'model-chips'); return c ? text(c) : ''; };

  await check('T7.2 design: one flat radio-row list under «Cuentas conectadas»; disconnected providers draw nothing', async () => {
    const page = await loadPage();
    await page.openModelsTab();
    const section = page.section();
    const head = section.children.find(n => n.tagName === 'H3');
    assert.match(text(head), /Cuentas conectadas/, 'the group label of the design');
    const rows = page.rows();
    // openai is fully disconnected: the design draws no row and no hint for it
    assert.deepEqual(rows.map(rowTitle), ['Claude Sonnet 4.5', 'Claude Opus 4.6'], 'only the models of the connected accounts, engine order');
    for (const row of rows) assert.equal(rowProvider(row), 'Anthropic', 'each row names its provider (design chip)');
    assert.ok(rows.every(row => /200k/.test(rowCaps(row))), 'context capability chip from the engine frame');
    assert.ok(rows.every(row => /Razonamiento/.test(rowCaps(row))), 'reasoning capability chip from the engine frame');
    // the toggle state comes from the typed pref
    const chosen = page.toggles().find(b => b.getAttribute('aria-pressed') === 'true');
    assert.ok(chosen, 'the chosen model of the pref is marked');
    assert.match(chosen.getAttribute('aria-label'), /Claude Opus 4\.6/);
  });

  await check('#414 a toggle sends the CLOSED prefs_action payload with the WHOLE list of that provider', async () => {
    const page = await loadPage();
    await page.openModelsTab();
    const before = page.invocations.filter(i => i.cmd === 'prefs_action').length;
    const sonnet = page.toggles().find(b => /Claude Sonnet 4\.5/.test(b.getAttribute('aria-label')));
    assert.ok(sonnet && sonnet.getAttribute('aria-pressed') === 'false');
    sonnet.click();
    await page.settle();
    const sent = page.invocations.filter(i => i.cmd === 'prefs_action').slice(before);
    assert.equal(sent.length, 1, 'one invoke per toggle');
    assert.deepEqual(sent[0].payload,
      { action: 'set_chosen_models', provider: 'anthropic', models: ['claude-opus-4-6', 'claude-sonnet-4-5'] },
      'the whole list of the provider replaces what is stored');
    // unchoosing the marked one sends the list without it
    const opus = page.toggles().find(b => /Claude Opus 4\.6/.test(b.getAttribute('aria-label')));
    const at = page.invocations.length;
    opus.click();
    await page.settle();
    assert.deepEqual(page.invocations[at].payload,
      { action: 'set_chosen_models', provider: 'anthropic', models: ['claude-sonnet-4-5'] });
  });

  await check('T7.2 «Guardado · sin probar» sub only for a provider whose only account is a locally saved key', async () => {
    const view = clone(AGENT_VIEW);
    view.providers[0].configured = false;
    view.accounts = [{ accountId: 'l1', provider: 'anthropic', local: true, configured: true }];
    const page = await loadPage({ agentView: view });
    await page.openModelsTab();
    assert.deepEqual(page.rows().map(rowSub), ['Guardado · sin probar', 'Guardado · sin probar']);
    const bare = await loadPage();
    await bare.openModelsTab();
    assert.deepEqual(bare.rows().map(rowSub), ['', ''], 'an engine-configured provider stays bare');
  });

  await check('T7.2 the section re-renders from the streams: agent:state and prefs:state, no engine text, no secrets', async () => {
    const page = await loadPage({ agentView: { connection: 'connecting' } });
    await page.openModelsTab();
    assert.ok(/Conectando/.test(text(page.section())), 'no engine yet is a wait, in our words');
    page.setAgentView(AGENT_VIEW);
    page.emit('agent:state', AGENT_VIEW);
    await page.settle();
    assert.deepEqual(page.rows().map(rowTitle), ['Claude Sonnet 4.5', 'Claude Opus 4.6'], 'the state stream fills the rows');
    // a prefs push marks the new choice without a reload
    page.emit('prefs:state', { v: 1, sound: false, chosenModels: { anthropic: ['claude-sonnet-4-5'] } });
    await page.settle();
    const chosen = page.toggles().filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.getAttribute('aria-label'));
    assert.equal(chosen.length, 1);
    assert.match(chosen[0], /Claude Sonnet 4\.5/);
    // nothing the engine sent is ever shown as text beyond the closed fields
    const all = JSON.stringify({ s: text(page.section()) });
    assert.ok(!all.includes('sk-') && !all.includes('token'), 'no secret material');
    // the local picker below keeps working: the models_action list verb still ran
    assert.ok(page.invocations.some(i => i.cmd === 'models_action' && i.payload.action === 'list'));
  });

  console.log(`models-tab-check: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`FAILED: ${f.name}: ${(f.err && f.err.message) || f.err}`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

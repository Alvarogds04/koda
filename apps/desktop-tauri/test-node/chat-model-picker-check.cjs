'use strict';
/* F024 — the model row above the composer, driven through the REAL chat wiring
   (`frontend/chat.js`) with a minimal fake DOM. No browser, no Tauri, no
   network, no npm: `vm` + plain Node objects, the same convention as
   `tests/composer-ime-check.cjs`.

   Run: node apps/desktop-tauri/test-node/chat-model-picker-check.cjs
   Also run by `cargo test` (tests/frontend_chat_view.rs).

   Spec: F024 "Click model name above composer" (odd/tasks/model-selector-339.md
   S3, rules R1-R5 approved in L4).

   What is REAL: production `frontend/chat.js` (the row, the picker's
   open/close, Escape, the disabled state, the payloads it sends) and
   production `frontend/chat-view.js` (modelButtonLabel / modelButtonAria /
   modelButtonEnabled / modelRoleNote / modelRows). What is FAKE: the DOM, the
   IPC and the fixtures — all local to this file.

   The fake DOM never parses HTML, so the row's initial state is set below
   exactly as `frontend/index.html` declares it; check 1 pins that markup
   against the real file.

   Observables per check: the payloads that reach `chat_action`,
   `models_action` and `specialists_action` (the public IPC contract), the
   label and accessible name the row announces, and whether the picker is open.
*/
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const FRONTEND = path.join(__dirname, '..', 'frontend');

// ---- fixtures (shapes the Rust host really publishes) ------------------------

const TARGET = {
  origin: 'http://127.0.0.1:11002', alias: 'Abito-gpt',
  profile_id: 'local-abito-gpt', profile_revision: 1, max_output_tokens: 1024,
};
const CHAT_VIEW = {
  conversation_id: 'c1', active_turn: null, turns: [], evicted: 0,
  queue_note: null, availability: { state: 'ready', message: 'Modelo local listo.' },
  history_before: null, history_skipped: 0, history_problem: null, history_persisted: true,
  conversation_specialist: null, display_name: '', view: 'chat', chat_visible: [640, 656],
  target: TARGET, producer: { pi: 'not_connected', note: 'Chat con el modelo local.' },
};
const LISTING = {
  revision: 1, selected: 'local-abito-gpt', persisted: true,
  choice_note: 'Modelos verificados de esta máquina.',
  remote: 'Sin nube y sin claves: sólo modelos de esta máquina.',
  profiles: [
    { profile_id: 'local-abito-gpt', revision: 1, alias: 'Abito-gpt', origin: 'http://127.0.0.1:11002',
      selectable: true, gate: { state: 'ready', message: '' }, context_tokens: 8192 },
    { profile_id: 'local-otro', revision: 1, alias: 'Otro-local', origin: 'http://127.0.0.1:11003',
      selectable: true, gate: { state: 'ready', message: '' }, context_tokens: 4096 },
    { profile_id: 'diag-x', revision: 1, alias: 'Diagnóstico', origin: 'http://127.0.0.1:19999',
      selectable: false, gate: { state: 'unknown', message: '' } },
  ],
};
const SPECIALISTS = { v: 1, active: null, specialists: [], persisted: true, load_error: false };

// The closed `chat_action` set with EXACTLY its keys (src/chat.rs parse_command):
// nothing model-shaped may ever ride on it.
const CHAT_KEYS = Object.freeze({
  view: ['action'], open: ['action'], back: ['action'], check: ['action'],
  new: ['action'], list: ['action'],
  restore: ['action', 'conversation_id'], history: ['action', 'conversation_id', 'before'],
  submit: ['action', 'text', 'client_request_id'], cancel: ['action', 'turn_id'],
});

// ---- fake DOM (convention of tests/composer-ime-check.cjs) -------------------

function makeDom() {
  const elements = new Map();

  function El(id, tag) {
    const el = {
      id: id || null, tagName: String(tag || 'div').toUpperCase(),
      children: [], dataset: {}, style: {}, attributes: {}, listeners: {},
      hidden: false, disabled: false, inert: false, value: '',
      textContent: '', innerHTML: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      setAttribute(k, v) { el.attributes[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : null; },
      removeAttribute(k) { delete el.attributes[k]; },
      addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
      removeEventListener(type, fn) {
        const l = el.listeners[type] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
      },
      dispatchEvent(ev) { fire(el, ev); return true; },
      append(...nodes) { for (const n of nodes) el.children.push(n); },
      appendChild(n) { el.children.push(n); return n; },
      replaceChildren(...nodes) { el.children = [...nodes]; },
      remove() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      focus() { document.activeElement = el; },
      blur() { if (document.activeElement === el) document.activeElement = null; },
      click() { fire(el, { type: 'click', detail: 0 }); },
      requestSubmit() {
        const ev = { type: 'submit', timeStamp: 0, defaultPrevented: false };
        fire(el, ev);
        el.submitted = !ev.defaultPrevented;
      },
    };
    Object.defineProperty(el, 'lastElementChild', { get: () => el.children[el.children.length - 1] || null });
    return el;
  }

  function fire(target, ev) {
    if (!ev || !ev.type) return;
    ev.target = ev.target || target;
    ev.currentTarget = target;
    if (typeof ev.preventDefault !== 'function') ev.preventDefault = function () { ev.defaultPrevented = true; };
    if (ev.defaultPrevented === undefined) ev.defaultPrevented = false;
    for (const fn of (target.listeners[ev.type] || []).slice()) fn.call(target, ev);
  }

  class FakeCustomEvent {
    constructor(type, init) { this.type = type; this.detail = init && init.detail; }
  }
  /* Only the closed icon-registry shape chat.js parses is recognised: an `<svg>`
     string yields an svg element, everything else yields no documentElement. */
  class FakeDomParser {
    parseFromString(text) {
      const isSvg = typeof text === 'string' && /^\s*<svg[\s>]/.test(text);
      return { documentElement: isSvg ? { nodeName: 'svg' } : null };
    }
  }

  const document = {
    activeElement: null,
    listeners: {},
    importNode(node) { return node; },
    addEventListener(type, fn) { (document.listeners[type] = document.listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) { fire(document, ev); return true; },
    getElementById(id) { if (!elements.has(id)) elements.set(id, El(id)); return elements.get(id); },
    createElement(tag) { return El(null, tag); },
  };

  return { document, CustomEvent: FakeCustomEvent, DOMParser: FakeDomParser, el: id => document.getElementById(id) };
}

const clone = value => JSON.parse(JSON.stringify(value));

/* One fresh island page per check: the production scripts are evaluated
   against a sandbox whose `window` is the sandbox itself, exactly like the page. */
async function loadPage(opts) {
  const o = opts || {};
  const dom = makeDom();
  const invocations = [];
  const listeners = {};
  const chat = clone(CHAT_VIEW);
  const listing = clone(LISTING);
  const specialists = clone(SPECIALISTS);
  // #414: the typed prefs the host publishes (chosenModels arrives with it)
  const prefs = Object.assign({ v: 1, sound: false }, o.prefs ? clone(o.prefs) : {});
  if (Array.isArray(o.extraProfiles)) listing.profiles.push(...clone(o.extraProfiles));

  const emit = (name, payload) => { for (const cb of (listeners[name] || [])) cb({ payload: clone(payload) }); };

  const invoke = (cmd, args) => {
    const payload = args && args.payload;
    invocations.push({ cmd, payload: clone(payload) });
    if (cmd === 'chat_action') return Promise.resolve(clone(chat));
    if (cmd === 'models_action') {
      if (payload && payload.action === 'select') {
        const chosen = listing.profiles.find(p => p.profile_id === payload.profile_id);
        if (chosen && chosen.selectable) {
          listing.selected = chosen.profile_id;
          // What Rust does on a selection: republish models:state and the chat
          // view with the target the NEXT turn will use (modelshost::select →
          // chathost::publish_chat), unless a role owns the target.
          const ownsModel = specialists.specialists
            .some(s => s.id === specialists.active && s.model);
          if (!ownsModel) {
            chat.target = {
              origin: chosen.origin, alias: chosen.alias, profile_id: chosen.profile_id,
              profile_revision: chosen.revision, max_output_tokens: 1024,
            };
          }
          Promise.resolve().then(() => { emit('models:state', listing); emit('chat:state', chat); });
        }
      }
      return Promise.resolve(clone(listing));
    }
    if (cmd === 'specialists_action') return Promise.resolve(clone(specialists));
    if (cmd === 'prefs_action') return Promise.resolve(clone(prefs));
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  };
  const listen = (name, cb) => {
    (listeners[name] = listeners[name] || []).push(cb);
    return Promise.resolve(() => {});
  };

  const sandbox = {
    window: null, self: null, document: dom.document, crypto: {
      getRandomValues(bytes) { for (let i = 0; i < bytes.length; i += 1) bytes[i] = i + 1; return bytes; },
    },
    requestAnimationFrame: cb => { cb(0); return 0; }, setTimeout: () => 0, clearTimeout: () => {},
    CustomEvent: dom.CustomEvent, DOMParser: dom.DOMParser, console,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox; // chat-view.js UMD writes window.AbitoChatView here
  sandbox.window.__TAURI__ = { core: { invoke }, event: { listen } };
  vm.createContext(sandbox);
  for (const file of ['chat-view.js', 'chat.js']) {
    vm.runInContext(fs.readFileSync(path.join(FRONTEND, file), 'utf8'), sandbox, { filename: file });
  }

  // The fake DOM does not parse HTML: mirror the shipped markup's initial
  // state so the page must actually set every value it promises.
  const btn = dom.el('chat-model-btn');
  btn.disabled = true;
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'chat-model-picker');
  dom.el('chat-model-picker').hidden = true;
  dom.el('chat-model-name').textContent = '';
  dom.el('conversations').hidden = true; // index.html: the conversations dialog starts closed,
  // otherwise its Escape branch would swallow the picker's Escape.

  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle(); // the page asks for its first view and role snapshot on load

  const byAction = cmd => invocations.filter(i => i.cmd === cmd).map(i => i.payload);
  const escape = () => {
    const ev = {
      type: 'keydown', key: 'Escape', keyCode: 27, isComposing: false, repeat: false,
      shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
      timeStamp: 0, defaultPrevented: false,
      preventDefault() { ev.defaultPrevented = true; },
    };
    dom.document.dispatchEvent(ev);
    return ev;
  };
  const pushChat = async next => {
    Object.assign(chat, next);
    emit('chat:state', chat);
    await settle();
  };
  const pushSpecialists = async next => {
    Object.assign(specialists, next);
    emit('specialists:state', specialists);
    await settle();
  };
  const pushPrefs = async next => {
    Object.assign(prefs, next);
    emit('prefs:state', prefs);
    await settle();
  };

  return { dom, invocations, byAction, settle, escape, pushChat, pushSpecialists, pushPrefs,
    V: sandbox.window.AbitoChatView,
    btn: () => dom.el('chat-model-btn'),
    name: () => dom.el('chat-model-name'),
    note: () => dom.el('chat-model-note'),
    picker: () => dom.el('chat-model-picker') };
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

const pickerRows = page => page.picker().children.filter(n => n.tagName === 'BUTTON');
const rowNames = rows => rows.map(r => (r.children.find(c => c.className === 'picker-name') || {}).textContent);

async function main() {
  await check('credentialed cloud models share the picker and select IPC', async () => {
    const page = await loadPage({ extraProfiles: [{ profile_id: 'cloud-openai-gpt-4o', revision: 1, alias: 'gpt-4o', origin: 'https://api.openai.com', cloud: true, provider: 'OpenAI', selectable: true, gate: { state: 'ready' } }] });
    page.btn().click(); await page.settle();
    const row = pickerRows(page).find(r => r.getAttribute('aria-label').includes('gpt-4o'));
    assert.ok(row);
    assert.match(row.getAttribute('aria-label'), /OpenAI/);
    assert.match(row.getAttribute('aria-label'), /nube/i);
    assert.doesNotMatch(row.getAttribute('aria-label'), /local/i);
    row.click(); await page.settle();
    assert.ok(page.byAction('models_action').some(p => p.action === 'select' && p.profile_id === 'cloud-openai-gpt-4o'));
    assert.match(page.btn().getAttribute('aria-label'), /nube/);
  });
  await check('F024 markup: the row and its named controls sit above the composer', async () => {
    const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
    for (const id of ['chat-model-row', 'chat-model-btn', 'chat-model-name', 'chat-model-picker', 'chat-model-note']) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
    assert.ok(html.indexOf('id="chat-new"') < html.indexOf('id="chat-model-row"'), 'after «Respuesta nueva»');
    assert.ok(html.indexOf('id="chat-model-row"') < html.indexOf('id="chat-composer"'), 'above the composer');
    assert.match(/id="chat-model-picker"[^>]*/.exec(html)[0], /hidden/, 'the picker starts closed');
  });

  await check('R1: the row shows the effective local model as text, with its origin as the accessible name', async () => {
    const page = await loadPage();
    assert.equal(page.name().textContent, 'Abito-gpt', 'the label is the target alias, written as text');
    const aria = page.btn().getAttribute('aria-label');
    assert.match(aria, /Abito-gpt/);
    assert.match(aria, /127\.0\.0\.1:11002/, 'the origin identifies where the model runs');
    assert.doesNotMatch(aria, /https?:\/\//, 'no scheme in the accessible name');
    assert.equal(page.btn().disabled, false, 'ready and no turn: the row is interactive');
  });

  await check('R2: clicking the row opens the picker with the local models and the current one marked', async () => {
    const page = await loadPage();
    page.btn().click();
    await page.settle();
    assert.equal(page.btn().getAttribute('aria-expanded'), 'true');
    assert.equal(page.picker().hidden, false);
    const lists = page.byAction('models_action').filter(p => p.action === 'list');
    assert.equal(lists.length, 1, 'the picker reads the models_action list verb');
    const rows = pickerRows(page);
    assert.deepEqual(rowNames(rows), ['Abito-gpt', 'Otro-local', 'Diagnóstico'], 'every profile is visible');
    const current = rows.find(r => r.getAttribute('aria-pressed') === 'true');
    assert.match(current.getAttribute('aria-label'), /^Elegido/, 'the current model says it is the chosen one');
    const diag = rows[rows.length - 1];
    assert.equal(diag.disabled, true, 'a non-selectable profile cannot be chosen');
  });

  await check('R2: a second click closes the picker, and Escape closes it back to the row', async () => {
    const page = await loadPage();
    page.btn().click();
    await page.settle();
    page.btn().click();
    await page.settle();
    assert.equal(page.picker().hidden, true, 'the second click toggles it shut');
    assert.equal(page.btn().getAttribute('aria-expanded'), 'false');
    page.btn().click();
    await page.settle();
    page.btn().focus();
    const ev = page.escape();
    await page.settle();
    assert.equal(page.picker().hidden, true, 'Escape closes the picker first');
    assert.equal(ev.defaultPrevented, true, 'the island does not also collapse');
    assert.equal(page.dom.document.activeElement, page.btn(), 'focus stays on the row');
  });

  await check('R2: a running turn freezes the row and closes an open picker', async () => {
    const page = await loadPage();
    page.btn().click();
    await page.settle();
    assert.equal(page.picker().hidden, false);
    await page.pushChat({
      active_turn: 't-1',
      turns: [{ turn_id: 't-1', state: 'thinking', seq: 1, request_id: 'req-x', user_text: 'hola',
        reply: '', finish_reason: null, error: null, trimmed_turns: 0,
        profile_id: 'local-abito-gpt', profile_revision: 1 }],
    });
    assert.equal(page.btn().disabled, true, 'the frozen target of a running turn is not switchable');
    assert.equal(page.picker().hidden, true, 'and the picker does not stay open under a busy row');
    await page.pushChat({ active_turn: null, turns: [] });
    assert.equal(page.btn().disabled, false, 'the row comes back when the turn ends');
  });

  await check('R2/R3: choosing a model goes through models_action select and republishes the row; chat_action stays closed', async () => {
    const page = await loadPage();
    page.btn().click();
    await page.settle();
    const otro = pickerRows(page).find(r => rowNames([r])[0] === 'Otro-local');
    otro.click();
    await page.settle();
    await page.settle();
    const selects = page.byAction('models_action').filter(p => p.action === 'select');
    assert.equal(selects.length, 1, 'exactly one selection');
    assert.deepEqual(Object.keys(selects[0]).sort(), ['action', 'profile_id'], 'the select payload is only the closed pair');
    assert.equal(selects[0].profile_id, 'local-otro');
    assert.equal(page.name().textContent, 'Otro-local', 'the row shows the new effective target');
    assert.equal(page.picker().hidden, true, 'the picker closes on a choice (upstream parity)');

    for (const payload of page.byAction('chat_action')) {
      const expected = CHAT_KEYS[payload.action];
      assert.ok(expected, `unknown chat_action: ${payload.action}`);
      assert.deepEqual(Object.keys(payload).sort(), [...expected].sort(), `keys of ${payload.action}`);
      assert.equal(Object.keys(payload).some(k => /model|provider|endpoint|alias|key/i.test(k)), false,
        `nothing model-shaped rides on chat_action: ${JSON.stringify(payload)}`);
    }
  });

  await check('R4: the role that fixes the model is named on the row and in the picker note, and is never edited from here', async () => {
    const page = await loadPage();
    await page.pushSpecialists({
      active: 'inv',
      specialists: [{ id: 'inv', name: 'Investigación', instructions: 'x', model: 'local-abito-gpt' }],
    });
    assert.equal(page.name().textContent, 'Abito-gpt · Investigación', 'the row names the role that owns the model');
    page.btn().click();
    await page.settle();
    assert.match(page.note().textContent, /Investigación/, 'the picker carries the one-line note');
    assert.equal(page.note().textContent.includes('\n'), false, 'one line');
    for (const payload of page.byAction('specialists_action')) {
      assert.deepEqual(Object.keys(payload).sort(), ['action'], 'only a read');
      assert.equal(payload.action, 'view', 'the page reads the role, it never writes one');
    }
  });

  await check('R5: no credential or endpoint ever travels in a payload this row sends', async () => {
    const page = await loadPage();
    page.btn().click();
    await page.settle();
    pickerRows(page).find(r => rowNames([r])[0] === 'Otro-local').click();
    await page.settle();
    const wire = JSON.stringify(page.invocations.map(i => ({ cmd: i.cmd, payload: i.payload })));
    assert.doesNotMatch(wire, /api[_-]?key|Bearer|accounts\.json|auth_reply|"token"/i, wire);
    assert.doesNotMatch(wire, /anthropic|openai|openrouter|lmstudio/i, 'no daemon provider name reaches the page');
    for (const payload of page.byAction('chat_action')) {
      assert.doesNotMatch(JSON.stringify(payload), /https?:\/\//, 'no endpoint on the chat lane wire');
    }
  });

  await check('R2: the row follows the target and the availability — turn, down target, no target, unchecked', async () => {
    const page = await loadPage();
    assert.equal(page.btn().disabled, false, 'ready + chosen target + no turn: interactive');
    await page.pushChat({ availability: { state: 'unavailable', message: 'Modelo local caído.' } });
    assert.equal(page.btn().disabled, true, 'a CHOSEN target that is down disables the row (the same refusal Send shows)');
    await page.pushChat({ availability: { state: 'blocked', message: 'El modelo local está dormido.' } });
    assert.equal(page.btn().disabled, true, 'a CHOSEN blocked target disables the row too');
    await page.pushChat({ target: null, availability: { state: 'blocked', message: 'No hay un modelo local elegido.' } });
    assert.equal(page.btn().disabled, false, 'no target chosen: opening the row is what lets the human choose (no dead end)');
    await page.pushChat({ target: TARGET, availability: { state: 'unchecked', message: 'Todavía no se comprobó el modelo local.' } });
    assert.equal(page.btn().disabled, false, 'no preflight verdict yet: nothing to protect');
    await page.pushChat({
      active_turn: 't-9',
      turns: [{ turn_id: 't-9', state: 'queued', seq: 1, request_id: 'req-y', user_text: 'hola',
        reply: '', finish_reason: null, error: null, trimmed_turns: 0,
        profile_id: 'local-abito-gpt', profile_revision: 1 }],
    });
    assert.equal(page.btn().disabled, true, 'a running turn freezes the row');
  });

  await check('#414 filterChosen: the allowlist keeps local rows and only the CHOSEN provider rows; none chosen = all', async () => {
    const page = await loadPage();
    const F = page.V.filterChosen;
    const rows = [
      { id: 'local-1', title: 'L1' },
      { id: 'prov-a', title: 'PA', provider: 'anthropic' },
      { id: 'prov-b', title: 'PB', provider: 'anthropic' },
    ];
    const ids = (out, chosen) => [...F(out, chosen)].map(r => r.id); // spread: vm-realm arrays compare by structure
    assert.deepEqual(ids(rows, {}), ['local-1', 'prov-a', 'prov-b'], 'empty allowlist: the fallback is ALL of them');
    assert.deepEqual(ids(rows, null), ['local-1', 'prov-a', 'prov-b']);
    assert.deepEqual(ids(rows, 'junk'), ['local-1', 'prov-a', 'prov-b'], 'a hostile stored value reads as nothing chosen');
    assert.deepEqual(ids(rows, { anthropic: ['prov-b'] }), ['local-1', 'prov-b'],
      'a local row is never a provider choice; the unchosen provider row is gone');
    assert.deepEqual(ids(rows, { anthropic: [42, null] }), ['local-1', 'prov-a', 'prov-b'], 'non-string entries choose nothing');
    assert.deepEqual([...F(null, { anthropic: ['x'] })], []);
  });

  await check('#414 allowlist wiring: the picker offers only the chosen provider models, falling back to all when none chosen', async () => {
    const page = await loadPage({
      prefs: { chosenModels: { anthropic: ['claude-sonnet-4-5'] } },
      extraProfiles: [
        { profile_id: 'claude-sonnet-4-5', revision: 1, alias: 'Claude Sonnet', provider: 'anthropic', origin: 'https://api.anthropic.com', selectable: true, gate: { state: 'ready' } },
        { profile_id: 'claude-opus-4-6', revision: 1, alias: 'Claude Opus', provider: 'anthropic', origin: 'https://api.anthropic.com', selectable: true, gate: { state: 'ready' } },
      ],
    });
    const viewInvoked = page.byAction('prefs_action');
    assert.ok(viewInvoked.some(p => p.action === 'view'), 'the row reads the typed prefs once, read-only');
    page.btn().click();
    await page.settle();
    assert.ok(/Otro-local/.test(rowNames(pickerRows(page)).join('|')), 'sanity: the picker opened with the local rows');
    assert.ok(rowNames(pickerRows(page)).includes('Claude Sonnet'), 'a chosen provider model is offered');
    assert.ok(!rowNames(pickerRows(page)).includes('Claude Opus'), 'an unchosen provider model is not offered');
    // none chosen: the fallback is ALL of them, provider rows included
    await page.pushPrefs({ chosenModels: {} });
    assert.ok(rowNames(pickerRows(page)).includes('Claude Opus'), 'no allowlist: every row comes back');
    assert.ok(rowNames(pickerRows(page)).includes('Abito-gpt'), 'local rows are always offered');
  });

  await check('contract: chat.js may invoke chat_action, open_chat_url, models_action {list,select}, specialists_action {view} and prefs_action {view} — nothing else', async () => {
    const src = fs.readFileSync(path.join(FRONTEND, 'chat.js'), 'utf8');
    const invoked = new Set();
    for (const m of src.matchAll(/\b(?:call|invoke)\('([a-z_]+)'/g)) invoked.add(m[1]);
    assert.deepEqual([...invoked].sort(),
      // #343: chat_attach (dropped path) and chat_attach_data (picked bytes)
      // are part of the closed set now — same gate (sender + rate) in Rust.
      // #414: prefs_action joins it READ-ONLY (view) so the row can honour the
      // Ajustes → Modelos allowlist; a listen to prefs:state keeps it current.
      // Design 14 (S14): dictation_action joins it for the composer's microphone; the verbs are pinned just below.
      ['chat_action', 'chat_attach', 'chat_attach_data', 'dictation_action', 'models_action', 'open_chat_url', 'prefs_action', 'specialists_action'],
      'the closed set of commands this file may put on the wire');
    const actionsOf = name => {
      const sites = src.match(new RegExp(`\\b${name}\\(`, 'g')) || [];
      const literals = [...src.matchAll(new RegExp(`\\b${name}\\(\\{\\s*action:\\s*'([a-z_]+)'[^}]*\\}`, 'g'))].map(m => m[1]).sort();
      assert.equal(literals.length, sites.length, `every ${name} call site must be a literal { action: … } object, not a variable`);
      return literals;
    };
    assert.deepEqual(actionsOf('modelsAction'), ['list', 'select'], 'models_action may only list and select (the Ajustes → Modelos verbs)');
    assert.deepEqual(actionsOf('specialistsAction'), ['view'], 'specialists_action may only read the role');
    const dictation = [...src.matchAll(/\bsay\('([a-z_]+)'\)/g)].map(m => m[1]).sort();
    assert.deepEqual(dictation, ['hands_free', 'status'], 'the microphone may only ask the status and start hands-free (never finish/cancel another flow)');
    assert.equal((src.match(/call\('dictation_action', \{ action: verb \}\)/g) || []).length, 1, 'dictation_action has exactly one call site, fed only by those two literals');
    const prefsSites = src.match(/\bprefs_action', \{\s*action:\s*'([a-z_]+)'/g) || [];
    assert.equal(prefsSites.length, 1, `prefs_action has exactly one call site, a literal { action: … } (got ${prefsSites.length})`);
    assert.ok(/action:\s*'view'/.test(prefsSites[0]), 'prefs_action may only READ the prefs (view)');
  });

  console.log(`chat-model-picker-check: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`FAILED: ${f.name}: ${(f.err && f.err.message) || f.err}`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

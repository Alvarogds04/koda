'use strict';
/* #372 — the composer's keyboard contract, driven through the REAL chat wiring
   (`frontend/chat.js`) with a minimal fake DOM. No browser, no Tauri, no
   network, no npm: `vm` + plain Node objects.

   Run: node apps/desktop-tauri/tests/composer-ime-check.cjs

   Spec: "Enter sends, Shift+Enter adds a newline, and IME composition is not
   prematurely submitted" (handoff HANDOFF-composer-ime-372.md, S1/OD005).

   What the guard may consume, and what it cannot: IDENTITY signals only —
   `isComposing`, and the legacy `keyCode === 229` sentinel that the confirming
   keydown carries on Safari 26. A keydown that confirms a candidate but arrives
   AFTER `compositionend` with a plain `keyCode` 13 (WebKit bug 165004, older
   reports) carries no signal that tells it apart from an intentional Enter. This
   file does NOT assert a guarantee there: that sequence is printed as a known gap,
   because the only shortcut proposed for it — a time window — swallows real Enters
   (parent decision, 2026-10-13, TaskView #372). Every other Enter sends.

   What is REAL here: the production `frontend/chat.js` IIFE (its keydown,
   composition, input and submit handlers) and the production
   `frontend/chat-view.js` (canSend/draftProblem/turnRows). What is FAKE: the
   DOM, the clock and the Tauri IPC, all local to this file. The keyboard
   events are dispatched on `#chat-input` and do not bubble: in the island the
   document-level Enter handler only acts in the overview view, never in chat.

   Observables per check: the payloads that reach `chat_action` (the public
   IPC contract), whether the keydown's default was cancelled (a textarea
   inserts the newline itself; cancelling is what suppresses it), the draft
   left in memory and the fact that a refused key changes nothing.
*/
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const FRONTEND = path.join(__dirname, '..', 'frontend');
const T0 = 1000; // ms; the only time source the page sees is event.timeStamp

function makeDom() {
  const elements = new Map();
  let clock = T0;

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
      // 0.2's chat.js renders the closed icon registry with DOMParser nodes and
      // replaces a node's children wholesale (never message bytes, never markup
      // built from input). Both are part of the DOM this fake stands in for.
      replaceChildren(...nodes) { el.children = [...nodes]; },
      remove() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      focus() { document.activeElement = el; },
      blur() { if (document.activeElement === el) document.activeElement = null; },
      click() { fire(el, { type: 'click', detail: 0 }); },
      // what the browser does for `form.requestSubmit()`: fire `submit` (cancelable).
      // chat.js always cancels it and calls the IPC itself, so `submitted` stays false.
      requestSubmit() {
        const ev = { type: 'submit', timeStamp: clock, defaultPrevented: false };
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

  /* The 0.2 renderer parses the closed, trusted icon registry with DOMParser
     instead of assigning innerHTML (frontend/chat.js `svgParser`/`iconNode`),
     so the merged chat.js needs this global just to load. Only that one input
     shape is recognised: an `<svg>` string yields an svg element, everything
     else yields no documentElement — message bytes never reach it. */
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

  return {
    document,
    CustomEvent: FakeCustomEvent,
    DOMParser: FakeDomParser,
    el: id => document.getElementById(id),
    now: () => clock,
    advance(ms) { clock += ms; return clock; },
    // a frame callback runs synchronously: the page uses it only to write text
    raf: cb => { cb(clock); return 0; },
  };
}

/* One fresh island page per check: the production scripts are evaluated against
   a sandbox whose `window` is the sandbox itself, exactly like the page. */
async function loadPage(overrides) {
  const dom = makeDom();
  const invocations = [];
  const stateListeners = {};
  let state = Object.assign({
    target: { alias: 'Abito-gpt', origin: 'http://127.0.0.1:11002' },
    availability: { state: 'ready', message: 'Modelo local listo.' },
    active_turn: null, queue_note: null, turns: [],
  }, overrides || {});
  const snapshot = () => JSON.parse(JSON.stringify(state));
  let deferView = false, releaseView = null;
  const deferNextView = () => {
    deferView = true;
    return () => { assert.ok(releaseView, 'the view RPC was captured'); releaseView(); };
  };

  const invoke = (cmd, args) => {
    const payload = args && args.payload;
    invocations.push({ cmd, payload });
    if (cmd === 'chat_action' && payload.action === 'view' && deferView) {
      deferView = false;
      const captured = snapshot();
      return new Promise(resolve => { releaseView = () => resolve(captured); });
    }
    return Promise.resolve(snapshot());
  };
  const listen = (name, cb) => {
    (stateListeners[name] = stateListeners[name] || []).push(cb);
    return Promise.resolve(() => {});
  };

  const sandbox = {
    window: null, self: null, document: dom.document, crypto: {
      getRandomValues(bytes) { for (let i = 0; i < bytes.length; i += 1) bytes[i] = i + 1; return bytes; },
    },
    requestAnimationFrame: dom.raf, setTimeout: () => 0, clearTimeout: () => {},
    CustomEvent: dom.CustomEvent, DOMParser: dom.DOMParser, console,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox; // chat-view.js UMD writes window.AbitoChatView here
  sandbox.window.__TAURI__ = { core: { invoke }, event: { listen } };
  vm.createContext(sandbox);
  for (const file of ['chat-view.js', 'chat.js']) {
    vm.runInContext(fs.readFileSync(path.join(FRONTEND, file), 'utf8'), sandbox, { filename: file });
  }

  const input = dom.el('chat-input');
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle(); // the page asks for its first view on load

  const sends = () => invocations.filter(i => i.payload && i.payload.action === 'submit');
  const type = async text => {
    input.value = text;
    input.dispatchEvent({ type: 'input', timeStamp: dom.now() });
    await settle();
  };
  const key = (over) => {
    const ev = Object.assign({
      type: 'keydown', key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13,
      repeat: false, ctrlKey: false, altKey: false, metaKey: false,
      timeStamp: dom.now(), defaultPrevented: false,
      preventDefault() { ev.defaultPrevented = true; },
    }, over || {});
    input.dispatchEvent(ev);
    return ev;
  };
  const composition = type => { input.dispatchEvent({ type, timeStamp: dom.now() }); };
  const pushState = async next => {
    state = next;
    for (const cb of (stateListeners['chat:state'] || [])) cb({ payload: snapshot() });
    await settle();
  };

  return { dom, input, invocations, sends, settle, type, key, composition, pushState, deferNextView };
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

/* KNOWN GAP — printed, never counted as a pass or a fail. A keydown that confirms a
   candidate but arrives after `compositionend` with a plain `keyCode` 13 carries no
   identifying signal: the DOM exposes isComposing, keyCode and timestamps, and none
   of them tells it apart from an intentional Enter. So it sends. Recorded here as
   evidence, NOT as a guarantee; re-adding a time window is a rejected regression
   because it swallows real Enters. */
async function knownGap() {
  const page = await loadPage();
  await page.type('nihongo');
  page.composition('compositionstart');
  await page.settle();
  page.composition('compositionend'); // delivered before the confirming keydown
  const ev = page.key({ isComposing: false, keyCode: 13 });
  await page.settle();
  const sends = page.sends();
  console.log('\nknown gap (NOT a guarantee) - inverted WebKit delivery with a plain keyCode 13');
  console.log(`  observed: submits=${sends.length}, defaultPrevented=${ev.defaultPrevented}, draft='${page.input.value}'`);
  console.log('  signals on that keydown: isComposing=false, keyCode=13, timeStamp after compositionend');
  console.log(sends.length === 0
    ? '  (this sequence is suppressed again — re-derive the guarantee before claiming IME safety)'
    : '  (the composer sends: the gap is real and must not be described as IME-safe)');
}

async function main() {
  await check('Enter sends the draft: one submit, the exact text, the draft cleared', async () => {
    const page = await loadPage();
    await page.type('hola');
    const ev = page.key();
    await page.settle();
    const sends = page.sends();
    assert.equal(sends.length, 1, 'exactly one submit reached chat_action');
    assert.equal(sends[0].cmd, 'chat_action');
    assert.equal(sends[0].payload.text, 'hola');
    assert.match(sends[0].payload.client_request_id, /^req-[0-9a-f]{24}$/);
    assert.equal(ev.defaultPrevented, true, 'the textarea default is cancelled so no newline is added');
    assert.equal(page.input.value, '', 'the accepted draft is gone from the composer');
  });

  await check('Shift+Enter keeps the textarea default (the newline is inserted) and sends nothing', async () => {
    const page = await loadPage();
    await page.type('linea uno');
    const ev = page.key({ shiftKey: true });
    assert.equal(ev.defaultPrevented, false, 'the newline default must run');
    page.input.value += '\n'; // what the engine does with that default
    await page.settle();
    assert.equal(page.sends().length, 0, 'Shift+Enter never submits');
    assert.equal(page.input.value, 'linea uno\n', 'the draft keeps the line break');
    // and the multi-line draft is still sendable, unchanged
    page.key();
    await page.settle();
    const sends = page.sends();
    assert.equal(sends.length, 1);
    assert.equal(sends[0].payload.text, 'linea uno\n', 'the newline travels inside the message');
  });

  await check('an Enter that belongs to an active composition (isComposing) sends nothing and clears nothing', async () => {
    const page = await loadPage();
    await page.type('nihon');
    page.composition('compositionstart');
    await page.settle();
    page.key({ isComposing: true, keyCode: 229 });
    await page.settle();
    assert.equal(page.sends().length, 0, 'the IME owns the key');
    assert.equal(page.input.value, 'nihon', 'the draft in progress is untouched');
  });

  await check('the legacy 229 sentinel alone (isComposing already false) sends nothing', async () => {
    const page = await loadPage();
    await page.type('nihongo');
    page.composition('compositionstart');
    await page.settle();
    page.key({ isComposing: false, keyCode: 229 });
    await page.settle();
    assert.equal(page.sends().length, 0, '229 is the documented value of the confirming keydown on Safari 26');
    assert.equal(page.input.value, 'nihongo');
  });

  await check('an intentional Enter 10 ms after a composition that ended on its own still sends', async () => {
    const page = await loadPage();
    await page.type('hola');
    page.composition('compositionstart');
    await page.settle();
    page.dom.advance(10);
    page.composition('compositionend'); // the candidate was committed by a click, not by Enter
    page.dom.advance(10);
    const ev = page.key({ isComposing: false, keyCode: 13 });
    await page.settle();
    const sends = page.sends();
    assert.equal(sends.length, 1, 'the human pressed Enter: exactly one submit');
    assert.equal(sends[0].payload.text, 'hola');
    assert.equal(ev.defaultPrevented, true, 'the textarea must not insert a line instead of sending');
    assert.equal(page.input.value, '', 'the draft became a turn');
  });

  await check('the boundary: an intentional Enter in the same instant as compositionend still sends', async () => {
    const page = await loadPage();
    await page.type('hola');
    page.composition('compositionstart');
    await page.settle();
    page.composition('compositionend');
    const ev = page.key({ isComposing: false, keyCode: 13 }); // same timeStamp
    await page.settle();
    assert.equal(page.sends().length, 1, 'no window of any width may swallow an Enter nobody suppressed');
    assert.equal(ev.defaultPrevented, true);
    assert.equal(page.input.value, '');
  });

  await check('a real Enter after the composition still sends (no permanent lock)', async () => {
    const page = await loadPage();
    await page.type('nihongo');
    page.composition('compositionstart');
    await page.settle();
    page.composition('compositionend');
    page.key({ isComposing: false, keyCode: 13 }); // the IME's own key
    await page.settle();
    page.dom.advance(2000); // the human presses Enter for real
    page.key({ isComposing: false, keyCode: 13, timeStamp: page.dom.now() });
    await page.settle();
    const sends = page.sends();
    assert.equal(sends.length, 1, 'exactly the real Enter sends');
    assert.equal(sends[0].payload.text, 'nihongo');
  });

  await check('Enter with an unavailable model sends nothing and never touches the draft', async () => {
    const page = await loadPage();
    await page.type('borrador');
    await page.pushState({
      target: { alias: 'Abito-gpt', origin: 'http://127.0.0.1:11002' },
      availability: { state: 'unavailable', message: 'Modelo local caído.' },
      active_turn: null, queue_note: null, turns: [],
    });
    // design 14 (option A): the disc is grey only for an EMPTY draft; a model that is down answers when pressed instead of looking dead
    assert.equal(page.dom.el('chat-send').disabled, false, 'a non-empty draft keeps the send control live');
    const ev = page.key();
    await page.settle();
    assert.equal(page.sends().length, 0);
    assert.equal(ev.defaultPrevented, true, 'Enter adds no line either');
    assert.equal(page.input.value, 'borrador', 'the draft survives a refused Enter');
    assert.match(page.dom.el('chat-problem').textContent, /modelo/i, 'and the refusal says why');
  });

  await check('S14: an «unchecked» model while the chat is open makes the page ask the host for its metadata-only check, and the chip then says Conectado', async () => {
    const page = await loadPage({ availability: { state: 'unchecked', message: 'Todavía no se comprobó el modelo local.' } });
    page.dom.el('capsule').dataset.view = 'chat';
    await page.pushState({ target: { alias: 'Abito-gpt', origin: 'http://127.0.0.1:11002' }, availability: { state: 'unchecked', message: '' }, active_turn: null, queue_note: null, turns: [] });
    const checks = () => page.invocations.filter(i => i.cmd === 'chat_action' && i.payload && i.payload.action === 'check');
    assert.equal(checks().length, 1, 'one check is requested as soon as the chat shows «unchecked»');
    assert.deepEqual(Object.keys(checks()[0].payload), ['action'], 'the closed command, nothing model-shaped');
    assert.equal(page.dom.el('chat-state').dataset.kind, 'checking');
    await page.pushState({ target: { alias: 'Abito-gpt', origin: 'http://127.0.0.1:11002' }, availability: { state: 'ready', message: 'Modelo local listo.' }, active_turn: null, queue_note: null, turns: [] });
    assert.equal(page.dom.el('chat-state').dataset.kind, 'ready'); assert.equal(page.dom.el('chat-state').dataset.tone, 'go');
    await page.pushState({ target: { alias: 'Abito-gpt', origin: 'http://127.0.0.1:11002' }, availability: { state: 'ready', message: 'Modelo local listo.' }, active_turn: null, queue_note: null, turns: [] });
    assert.equal(checks().length, 1, 'a ready model is never re-checked');
  });

  await check('Enter on an empty draft sends nothing and changes nothing', async () => {
    const page = await loadPage();
    await page.type('   ');
    page.key();
    await page.settle();
    assert.equal(page.sends().length, 0);
    assert.equal(page.input.value, '   ');
  });

  await check('the composer is a textarea and the help text names both keys', async () => {
    const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
    assert.match(html, /<textarea id="chat-input"[^>]*aria-describedby="chat-help chat-problem"/,
      'a textarea can hold the Shift+Enter newline; a single-line input cannot');
    assert.match(html, /id="chat-help"[^>]*>Enter envía\. Mayúsculas más Enter agrega una línea\./,
      'the help text documents Enter and Shift+Enter');
  });

  await check('B4: a late thinking snapshot cannot relock the composer after the turn completed', async () => {
    const base = {
      conversation_id: 'c-ordering', target: { alias: 'Abito-gpt' },
      availability: { state: 'ready', message: 'Modelo local listo.' },
      active_turn: null, queue_note: null, turns: [],
    };
    const page = await loadPage(base);
    await page.type('hola');
    const release = page.deferNextView();
    page.key();
    const turn = { turn_id: 't-1', user_text: 'hola', reply: '', state: 'thinking', seq: 1 };
    const thinking = { ...base, active_turn: 't-1', turns: [turn] };
    await page.pushState(thinking); // the submit acknowledgement now captures its follow-up view
    assert.equal(page.sends().length, 1);
    assert.equal(page.dom.el('chat-state').dataset.kind, 'busy');
    await page.pushState({ ...base, turns: [{ ...turn, state: 'completed', seq: 3, reply: 'Hola. ¿Como va?', finish_reason: 'stop' }] });
    assert.equal(page.dom.el('chat-state').dataset.kind, 'ready');
    // Resolve the REAL post-submit view RPC after the completed event.
    release(); await page.settle();
    await page.type('seguimos');
    assert.equal(page.dom.el('chat-state').dataset.kind, 'ready', 'no loading ring after completed seq 3');
    assert.equal(page.dom.el('chat-send').disabled, false, 'same conversation accepts the next draft');
    page.key(); await page.settle();
    assert.equal(page.sends().length, 2, 'no new conversation is needed');
    assert.equal(page.sends()[1].payload.text, 'seguimos');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  await knownGap();
  if (failures.length) {
    for (const f of failures) console.log(`FAILED: ${f.name}: ${(f.err && f.err.message) || f.err}`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

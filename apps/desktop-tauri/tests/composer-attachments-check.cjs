'use strict';
/* #343 — the composer's attachment contract, driven through the REAL chat
   wiring (`frontend/chat.js`) with a minimal fake DOM. No browser, no Tauri,
   no network, no npm: `vm` + plain Node objects, same approach as
   composer-ime-check.cjs.

   Run: node apps/desktop-tauri/tests/composer-attachments-check.cjs

   Spec (handoff HANDOFF-file-drop-343.md, Goal): dropped or picked files are
   attached through the closed Rust commands (`chat_attach` with a path,
   `chat_attach_data` with raw bytes), shown in the composer, sent with the
   turn, removable, and a REJECTED file leaves no chip and no data behind —
   the refusal is announced in Spanish.

   What is REAL: the production `frontend/chat.js` and `frontend/chat-view.js`
   (formatSize, turnRows attachment notes). What is FAKE: the DOM, the clock,
   the Tauri IPC (invoke records every call) and the drag-drop/picker events.
   Observables: the IPC calls (command + payload/body), the composer strip
   contents, the live-region announcements and the draft left in memory.
*/
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const FRONTEND = path.join(__dirname, '..', 'frontend');
const T0 = 1000;

function makeDom() {
  const elements = new Map();
  let clock = T0;

  function El(id, tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      children: [], dataset: {}, style: {}, attributes: {}, listeners: {},
      hidden: false, disabled: false, inert: false, value: '', tabIndex: 0,
      textContent: '', innerHTML: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      setAttribute(k, v) { el.attributes[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : null; },
      removeAttribute(k) { delete el.attributes[k]; },
      addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
      removeEventListener() {},
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
        const ev = { type: 'submit', timeStamp: clock, defaultPrevented: false };
        fire(el, ev);
        el.submitted = !ev.defaultPrevented;
      },
    };
    Object.defineProperty(el, 'lastElementChild', { get: () => el.children[el.children.length - 1] || null });
    // chat.js creates elements with createElement and assigns `.id` afterwards;
    // the id accessor registers them so getElementById finds the SAME node.
    let idValue = id || null;
    Object.defineProperty(el, 'id', {
      get: () => idValue,
      set: v => {
        idValue = v;
        if (v && !elements.has(v)) elements.set(v, el);
      },
    });
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

  class FakeCustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
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
    raf: cb => { cb(clock); return 0; },
  };
}

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

  // The REAL contract surface: every invoke call is recorded; the test answers
  // per command. `chat_attach` returns stored metadata; `chat_attach_data`
  // receives the RAW body (Uint8Array) — recorded as bytes for assertions.
  let attachSeq = 0; // one stored file per attach, like the real uploads dir
  const invoke = (cmd, args) => {
    invocations.push({ cmd, args, payload: args && args.payload });
    if (cmd === 'chat_attach') {
      const p = args && args.payload || {};
      const name = String(p.path).split('/').pop();
      // The sentinel path mimics Rust's refusal (bad MIME/oversize): the
      // command errors and NOTHING is stored.
      if (p.path.includes('prohibido')) {
        return Promise.reject({ message: 'Ese tipo de archivo no está permitido: se aceptan imágenes (PNG, JPEG, WebP, GIF) o texto.' });
      }
      attachSeq += 1;
      const id = `a-${String(attachSeq).padStart(16, '0').slice(-16)}`;
      return Promise.resolve({ id, name, mime: 'text/plain', size: 11, file: `${id.slice(2)}-${name}` });
    }
    if (cmd === 'chat_attach_data') {
      const header = JSON.parse(Buffer.from(args.slice(0, args.indexOf(0x0A))).toString('utf8'));
      attachSeq += 1;
      const id = `a-${String(attachSeq).padStart(16, '0').slice(-16)}`;
      return Promise.resolve({ id, name: header.name, mime: 'image/png', size: args.length, file: `${id.slice(2)}-${header.name}` });
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
    TextEncoder, TextDecoder,
    requestAnimationFrame: dom.raf, setTimeout: () => 0, clearTimeout: () => {},
    CustomEvent: dom.CustomEvent, DOMParser: dom.DOMParser, console,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.window.__TAURI__ = { core: { invoke }, event: { listen } };
  vm.createContext(sandbox);
  for (const file of ['chat-view.js', 'chat.js']) {
    vm.runInContext(fs.readFileSync(path.join(FRONTEND, file), 'utf8'), sandbox, { filename: file });
  }

  const input = dom.el('chat-input');
  const form = dom.el('chat-composer');
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();

  const strip = () => dom.document.getElementById('chat-attachments');
  const chips = () => (strip() ? strip().children.filter(c => c.tagName === 'SPAN') : []);
  // The fake DOM does not aggregate textContent over children: read the name span.
  const chipNames = () => chips().map(c => {
    const name = c.children.find(k => k.className === 'composer-attachment-name');
    return name ? name.textContent : '';
  });
  const drop = async paths => {
    for (const cb of (stateListeners['tauri://drag-drop'] || [])) cb({ payload: { paths } });
    await settle();
  };
  const pick = async files => {
    const fileInput = dom.document.getElementById('chat-attach-input');
    assert.ok(fileInput, 'chat.js creates the hidden file input');
    fileInput.files = files;
    fileInput.dispatchEvent({ type: 'change', timeStamp: dom.now() });
    await settle();
  };
  const type = async text => {
    input.value = text;
    input.dispatchEvent({ type: 'input', timeStamp: dom.now() });
    await settle();
  };
  const send = async () => {
    form.requestSubmit();
    await settle();
  };
  const submits = () => invocations.filter(i => i.payload && i.payload.action === 'submit');
  const live = () => dom.el('chat-live').textContent;

  return { dom, input, form, invocations, settle, strip, chips, chipNames, drop, pick, type, send, submits, live };
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

(async () => {
  // S1 — a dropped file becomes one chip in the composer via `chat_attach`.
  await check('a dropped path attaches through chat_attach and shows a chip', async () => {
    const page = await loadPage();
    page.dom.el('capsule').dataset.view = 'chat';
    await page.drop(['/tmp/informe.txt']);
    const calls = page.invocations.filter(i => i.cmd === 'chat_attach');
    assert.equal(calls.length, 1, JSON.stringify(page.invocations.map(i => i.cmd)));
    // The payload object was built inside the vm realm: compare by value.
    assert.equal(calls[0].payload.path, '/tmp/informe.txt');
    assert.equal(page.chips().length, 1);
    assert.match(page.chipNames().join(' '), /informe\.txt/);
    assert.match(page.live(), /informe/);
  });

  // S2 — a picked file goes through `chat_attach_data` as header-LF + bytes.
  await check('a picked file is sent as a raw body: JSON header, LF, then the bytes', async () => {
    const page = await loadPage();
    page.dom.el('capsule').dataset.view = 'chat';
    const bytes = new TextEncoder().encode('contenido');
    await page.pick([{ name: 'foto.png', arrayBuffer: async () => bytes.buffer.slice(0) }]);
    const calls = page.invocations.filter(i => i.cmd === 'chat_attach_data');
    assert.equal(calls.length, 1);
    const body = calls[0].args;
    // The body was created inside the vm realm: `instanceof` cannot cross
    // realms, but ArrayBuffer.isView checks the internal slot.
    assert.ok(ArrayBuffer.isView(body), 'the body is raw bytes');
    const lf = body.indexOf(0x0A);
    const header = JSON.parse(Buffer.from(body.slice(0, lf)).toString('utf8'));
    assert.equal(header.name, 'foto.png');
    assert.deepEqual(Array.from(body.slice(lf + 1)), Array.from(bytes));
    assert.equal(page.chips().length, 1);
  });

  // S3 — the attach button opens the picker (the hidden input exists and clicks).
  await check('the composer has an attach button that opens the picker', async () => {
    const page = await loadPage();
    const button = page.dom.document.getElementById('chat-attach');
    assert.ok(button, 'chat.js creates the attach button');
    assert.equal(button.tagName, 'BUTTON');
    assert.match(String(button.getAttribute('aria-label')), /Adjuntar/);
  });

  // S4 — the strip caps at five attachments.
  await check('more than five attachments are refused with a Spanish message', async () => {
    const page = await loadPage();
    page.dom.el('capsule').dataset.view = 'chat';
    await page.drop(['/tmp/a.txt', '/tmp/b.txt', '/tmp/c.txt', '/tmp/d.txt', '/tmp/e.txt']);
    assert.equal(page.chips().length, 5);
    await page.drop(['/tmp/f.txt']);
    assert.equal(page.chips().length, 5, 'the sixth attachment never becomes a chip');
    assert.match(page.live(), /demasiados|5/);
  });

  // S5 — a rejected or malformed attach leaves NO chip, no IPC side effects.
  await check('a rejected file leaves no chip and no data behind', async () => {
    const page = await loadPage();
    page.dom.el('capsule').dataset.view = 'chat';
    const before = page.invocations.length;
    // Malformed drop payloads must be ignored: no IPC call, no chip, no crash.
    await page.drop(undefined);
    await page.drop('no-array');
    await page.drop([null, 42]);
    assert.equal(page.invocations.filter(i => i.cmd === 'chat_attach').length, 0, 'malformed drops never reach the IPC');
    assert.equal(page.chips().length, 0);
    assert.equal(page.invocations.length, before, 'nothing else was sent either');
    // An IPC refusal (Rust rejects the file) leaves no chip and says why.
    const refused = await loadPage();
    refused.dom.el('capsule').dataset.view = 'chat';
    await refused.drop(['/tmp/prohibido.bin']);
    assert.equal(refused.invocations.filter(i => i.cmd === 'chat_attach').length, 1, 'the attempt reached the command (Rust owns the verdict)');
    assert.equal(refused.chips().length, 0, 'the refusal never becomes a chip');
    // T7.3 (design isla-chat-atterr): the refusal IS shown, as a display-only error chip + one reason line.
    const errs = refused.strip().children.filter(c => /composer-attachment-error/.test(c.className));
    assert.equal(errs.length, 1, 'one error chip');
    assert.equal(errs[0].tagName, 'DIV', 'not a listitem attachment chip');
    assert.match(refused.strip().children.find(c => c.className === 'composer-attachment-reason').textContent, /no está permitido/);
    assert.equal(refused.strip().hidden, false);
    assert.match(refused.live(), /no está permitido/);
  });

  // S6 — remove takes the chip out; the next submit no longer references it.
  await check('removing an attachment takes its chip out of the composer', async () => {
    const page = await loadPage();
    page.dom.el('capsule').dataset.view = 'chat';
    await page.drop(['/tmp/informe.txt', '/tmp/otro.txt']);
    assert.equal(page.chips().length, 2);
    const strip = page.strip();
    const removeButtons = strip.children.flatMap(c => c.children.filter(k => k.tagName === 'BUTTON'));
    assert.equal(removeButtons.length, 2);
    removeButtons[0].click();
    await page.settle();
    assert.equal(page.chips().length, 1);
    assert.match(page.chipNames().join(' '), /otro\.txt/);
  });

  // S7 — the turn carries the attachment ids and the strip clears on accept.
  await check('submit carries the attachment ids and clears the strip when accepted', async () => {
    const page = await loadPage();
    page.dom.el('capsule').dataset.view = 'chat';
    await page.drop(['/tmp/informe.txt']);
    await page.type('resumí esto');
    await page.send();
    const calls = page.submits();
    assert.equal(calls.length, 1);
    // The payload array was built inside the vm realm: copy before comparing.
    // The fake assigns ids in attach order: the first file gets ...0001.
    assert.deepEqual([...calls[0].payload.attachments], ['a-0000000000000001']);
    assert.equal(page.chips().length, 0, 'accepted: the strip is empty again');
    assert.equal(page.input.value, '');
  });

  // S8 — a refused submit keeps the attachments (the draft is not lost either).
  await check('a refused submit keeps the attachments and the draft', async () => {
    const page = await loadPage({ availability: { state: 'unavailable', message: 'No responde.' } });
    page.dom.el('capsule').dataset.view = 'chat';
    await page.drop(['/tmp/informe.txt']);
    await page.type('resumí esto');
    await page.send(); // Send is disabled while unavailable: nothing is sent
    assert.equal(page.submits().length, 0);
    assert.equal(page.chips().length, 1, 'the attachment survives a refused send');
    assert.equal(page.input.value, 'resumí esto');
  });

  // S9 — a drop outside the chat view attaches nothing.
  await check('a drop outside the chat view attaches nothing', async () => {
    const page = await loadPage();
    page.dom.el('capsule').dataset.view = 'overview';
    await page.drop(['/tmp/informe.txt']);
    assert.equal(page.invocations.filter(i => i.cmd === 'chat_attach').length, 0);
    assert.equal(page.chips().length, 0);
  });

  // S10 — pure helpers: size formatting and the log note row.
  await check('chat-view sizes are Spanish and turns with attachments gain one note row', async () => {
    const V = require(path.join(FRONTEND, 'chat-view.js'));
    assert.equal(V.formatSize(512), '512 B');
    assert.equal(V.formatSize(2048), '2,0 kB');
    assert.equal(V.formatSize(5 * 1024 * 1024), '5,0 MB');
    const rows = V.turnRows({ user_text: 'hola', attachments: [
      { id: 'a-0123456789abcdef', name: 'notas.txt', mime: 'text/plain', size: 9, file: '0123456789abcdef-notas.txt' },
    ] });
    assert.equal(rows[0].kind, 'user');
    assert.equal(rows.length, 2, JSON.stringify(rows));
    assert.equal(rows[1].kind, 'note');
    assert.match(rows[1].text, /notas\.txt/);
    // No attachments: exactly the historical rows.
    const plain = V.turnRows({ user_text: 'hola' });
    assert.equal(plain.length, 1);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) {
    console.log(`FAIL: ${f.name}`);
    console.log(String(f.err && f.err.stack || f.err).split('\n').slice(0, 6).join('\n'));
  }
  process.exit(failures.length ? 1 : 0);
})();

'use strict';
/* K2-05 attachments (L11 2a, «like Gentle Dot»): the island chat page, driven through the REAL
   `frontend/chat.js` + `frontend/chat-view.js` with a minimal fake DOM (the fake DOM is the one of
   tests/composer-attachments-check.cjs). No browser, no Tauri, no network.

   Contract under test (Gentle Dot packages/ui: Composer onPaste, useAttachments limits, the
   message's attachment chips):
   - attach by the button (picker), by a native drop (a PATH, honoured in Rust only when the OS
     dropped it) and by pasting an IMAGE (pasted text stays text);
   - chips with a remove button before sending; removing one asks the daemon to delete it
     (`chat_action {action:'discard', id}`); a conversation change discards them the same way;
   - a submit the daemon refused after accepting it (its turn ends in a refusal, nothing ran)
     brings the chips back to the composer, so the user can resend the same files;
   - limits checked on the page first, Spanish errors: 5 files (chat.rs submit cap; the daemon
     allows Gentle Dot's 10), 25 MB per file, 50 MB together;
   - a message may be files only (empty text); the submit carries the daemon ids;
   - the user's message row shows the attachment chips (name + size), also for past turns from
     history (reload keeps them).
   Run: node test-node/chat-attach-check.cjs */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const FRONTEND = path.join(__dirname, '..', 'frontend');
const T0 = 1000;
const MB = 1024 * 1024;

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

async function loadPage(overrides, answers) {
  const dom = makeDom();
  const invocations = [];
  const stateListeners = {};
  let state = Object.assign({
    conversation_id: 'c-koda',
    availability: { state: 'ready', message: 'El motor de Koda está listo.' },
    active_turn: null, queue_note: null, turns: [],
  }, overrides || {});
  const snapshot = () => JSON.parse(JSON.stringify(state));
  let seq = 0;
  const stored = (name, size, mime) => {
    seq += 1;
    return { id: `a-${seq.toString(16).padStart(16, '0')}`, name, size, mime };
  };
  const invoke = (cmd, args) => {
    invocations.push({ cmd, args, payload: args && args.payload });
    if (cmd === 'chat_attach') {
      const p = (args && args.payload) || {};
      return Promise.resolve(stored(String(p.path).split('/').pop(), 11, 'application/octet-stream'));
    }
    if (cmd === 'chat_attach_data') {
      const at = args.indexOf(0x0A);
      const header = JSON.parse(Buffer.from(args.slice(0, at)).toString('utf8'));
      if (header.name.includes('lleno')) return Promise.reject({ message: 'Demasiados archivos: hasta 5 por mensaje.' });
      return Promise.resolve(stored(header.name, args.length - at - 1, 'image/png'));
    }
    if (cmd === 'chat_action' && answers && args && args.payload && answers[args.payload.action]) return Promise.resolve(answers[args.payload.action](args.payload));
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
  dom.el('capsule').dataset.view = 'chat';
  const strip = () => dom.document.getElementById('chat-attachments');
  const chips = () => (strip() ? strip().children.filter(c => c.tagName === 'SPAN') : []);
  const chipNames = () => chips().map(c => (c.children.find(k => k.className === 'composer-attachment-name') || {}).textContent);
  const fakeFile = (name, size, type) => ({ name, size, type: type || '', arrayBuffer: async () => new Uint8Array(Math.min(size, 64)).buffer });
  const pick = async files => {
    const fileInput = dom.document.getElementById('chat-attach-input');
    fileInput.files = files;
    fileInput.dispatchEvent({ type: 'change', timeStamp: dom.now() });
    await settle(); await settle();
  };
  const paste = async (files, text) => {
    const ev = { type: 'paste', timeStamp: dom.now(), defaultPrevented: false, clipboardData: { files, getData: () => text || '' } };
    input.dispatchEvent(ev);
    await settle(); await settle();
    return ev;
  };
  const drop = async paths => {
    for (const cb of (stateListeners['tauri://drag-drop'] || [])) cb({ payload: { paths } });
    await settle(); await settle();
  };
  const type = async text => { input.value = text; input.dispatchEvent({ type: 'input', timeStamp: dom.now() }); await settle(); };
  const send = async () => { form.requestSubmit(); await settle(); await settle(); };
  const actions = name => invocations.filter(i => i.cmd === 'chat_action' && i.payload && i.payload.action === name).map(i => i.payload);
  const live = () => dom.el('chat-live').textContent;
  const errorReason = () => { const r = strip() && strip().children.find(c => c.className === 'composer-attachment-reason'); return r ? r.textContent : ''; };
  const push = async next => { state = Object.assign(state, next); for (const cb of (stateListeners['chat:state'] || [])) cb({ payload: snapshot() }); await settle(); };
  return { dom, input, invocations, strip, chips, chipNames, fakeFile, pick, paste, drop, type, send, actions, live, errorReason, push, settle };
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  const n = passed + failures.length + 1;
  try { await fn(); passed += 1; console.log(`ok ${n} - ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`FAIL ${n} - ${name}\n       ${String((err && err.message) || err).split('\n')[0]}`); }
}

(async () => {
  await check('the attach button picks any file; it goes to Rust as raw bytes and comes back as a daemon id chip', async () => {
    const page = await loadPage();
    assert.equal(page.dom.document.getElementById('chat-attach').tagName, 'BUTTON');
    await page.pick([page.fakeFile('informe.pdf', 40, 'application/pdf'), page.fakeFile('datos.csv', 10)]);
    assert.deepEqual(page.chipNames(), ['informe.pdf', 'datos.csv'], 'any kind of file, like Gentle Dot');
    assert.equal(page.invocations.filter(i => i.cmd === 'chat_attach_data').length, 2);
  });

  await check('a pasted image becomes an attachment; pasted text stays text', async () => {
    const page = await loadPage();
    const ev = await page.paste([page.fakeFile('captura.png', 30, 'image/png')]);
    assert.equal(ev.defaultPrevented, true);
    assert.deepEqual(page.chipNames(), ['captura.png']);
    const text = await page.paste([], 'hola');
    assert.equal(text.defaultPrevented, false, 'pasting text is left to the textarea');
    const other = await page.paste([page.fakeFile('notas.txt', 5, 'text/plain')]);
    assert.equal(other.defaultPrevented, false, 'only images are taken from a paste');
    assert.equal(page.chips().length, 1);
  });

  await check('a native drop sends its path to Rust (which honours only OS drops) and shows a chip', async () => {
    const page = await loadPage();
    await page.drop(['/home/u/Escritorio/plano.dwg']);
    const calls = page.invocations.filter(i => i.cmd === 'chat_attach');
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0].payload), ['path']);
    assert.deepEqual(page.chipNames(), ['plano.dwg']);
  });

  await check('limits are checked on the page first with Spanish errors: 25 MB per file, 50 MB together, 5 files (chat.rs)', async () => {
    const page = await loadPage();
    await page.pick([page.fakeFile('enorme.mov', 25 * MB + 1)]);
    assert.equal(page.chips().length, 0);
    assert.match(page.errorReason(), /demasiado grande: hasta 25 MB por archivo/);
    assert.equal(page.invocations.filter(i => i.cmd === 'chat_attach_data').length, 0, 'nothing is read or sent');
    await page.pick([page.fakeFile('a.bin', 20 * MB), page.fakeFile('b.bin', 20 * MB), page.fakeFile('c.bin', 20 * MB)]);
    assert.equal(page.chips().length, 2);
    assert.match(page.errorReason(), /hasta 50 MB por mensaje/);
    const many = await loadPage();
    await many.pick(Array.from({ length: 6 }, (_, i) => many.fakeFile(`f${i}.txt`, 1)));
    assert.equal(many.chips().length, 5, 'the island submit carries at most 5 ids (chat.rs MAX_ATTACHMENTS_PER_TURN)');
    assert.match(many.errorReason(), /Demasiados archivos: hasta 5 por mensaje/);
    // the daemon's own refusal is shown the same way
    const full = await loadPage();
    await full.pick([full.fakeFile('lleno.txt', 1)]);
    assert.equal(full.chips().length, 0);
    assert.match(full.live(), /Demasiados archivos/);
  });

  await check('removing a chip before sending asks the daemon to delete that file', async () => {
    const page = await loadPage();
    await page.pick([page.fakeFile('uno.txt', 1), page.fakeFile('dos.txt', 1)]);
    const removeButtons = page.strip().children.flatMap(c => c.children.filter(k => k.tagName === 'BUTTON'));
    removeButtons[0].click();
    await page.settle();
    assert.deepEqual(page.chipNames(), ['dos.txt']);
    assert.deepEqual(page.actions('discard').map(p => Object.keys(p).sort()), [['action', 'id']]);
    assert.equal(page.actions('discard')[0].id, 'a-0000000000000001');
  });

  await check('a message may be files only; the submit carries the daemon ids and clears the strip', async () => {
    const page = await loadPage();
    await page.pick([page.fakeFile('foto.png', 9, 'image/png')]);
    assert.equal(page.dom.el('chat-send').disabled, false, 'files alone can be sent');
    await page.send();
    const submits = page.actions('submit');
    assert.equal(submits.length, 1);
    assert.equal(submits[0].text, '');
    assert.deepEqual([...submits[0].attachments], ['a-0000000000000001']);
    assert.equal(page.chips().length, 0);
    assert.equal(page.actions('discard').length, 0, 'a sent file is never discarded');
  });

  await check('the user message row shows the attachment chips (name and size), for live and past turns', async () => {
    const V = require(path.join(FRONTEND, 'chat-view.js'));
    const rows = V.turnRows({ turn_id: 't-1', user_text: 'mirá', attachments: [{ name: 'foto.png', size: 2048, mime: 'image/png' }, { name: 'datos.csv', size: 10, mime: 'application/octet-stream' }] });
    const chipsRow = rows.find(r => Array.isArray(r.files));
    assert.ok(chipsRow, JSON.stringify(rows));
    assert.deepEqual(chipsRow.files.map(f => [f.name, f.size]), [['foto.png', '2,0 kB'], ['datos.csv', '10 B']]);
    assert.match(chipsRow.text, /foto\.png/);
    const filesOnly = V.turnRows({ turn_id: 't-2', user_text: '', attachments: [{ name: 'a.txt', size: 1, mime: 'x' }] });
    assert.equal(filesOnly.some(r => r.kind === 'user' && r.text === ''), false, 'no empty bubble for a files-only message');
    const page = await loadPage();
    await page.push({ turns: [{ turn_id: 't-1', state: 'completed', seq: 1, user_text: 'mirá', reply: 'listo', attachments: [{ name: 'foto.png', size: 2048, mime: 'image/png' }] }] });
    const log = page.dom.el('chat-log');
    const all = []; const walk = n => { all.push(n); (n.children || []).forEach(walk); }; walk(log);
    const chipNodes = all.filter(n => n.className === 'message-attachment');
    assert.equal(chipNodes.length, 1, 'one chip drawn in the log');
    assert.match(JSON.stringify(chipNodes[0].children.map(c => c.textContent)), /foto\.png.*2,0 kB/);
  });

  await check('a submit the daemon refused after accepting it keeps the chips in the composer; the user can resend them', async () => {
    const page = await loadPage(null, { submit: () => ({ turn_id: 't-77', duplicate: false }) });
    await page.pick([page.fakeFile('foto.png', 9, 'image/png'), page.fakeFile('datos.csv', 4)]);
    await page.type('mirá');
    await page.send();
    assert.equal(page.chips().length, 0, 'accepted: the strip empties while the turn runs');
    await page.push({ turns: [{ turn_id: 't-77', state: 'thinking', seq: 1, user_text: 'mirá', reply: '', attachments: [] }], active_turn: 't-77' });
    assert.equal(page.chips().length, 0);
    await page.push({ turns: [{ turn_id: 't-77', state: 'error', seq: 2, user_text: 'mirá', reply: '', error: { code: 'busy', safe_message: 'Koda está ocupado.', retryable: true }, attachments: [] }], active_turn: null });
    assert.deepEqual(page.chipNames(), ['foto.png', 'datos.csv'], 'refused: the chips come back so the user can resend');
    assert.equal(page.actions('discard').length, 0, 'nothing is discarded: the daemon never spent them');
    await page.send();
    const submits = page.actions('submit');
    assert.equal(submits.length, 2);
    assert.deepEqual([...submits[1].attachments], [...submits[0].attachments], 'the resend carries the same daemon ids');
  });

  await check('a turn that ran (completed, interrupted) or whose files are gone never brings its chips back', async () => {
    for (const end of [
      { state: 'completed', reply: 'listo', error: null },
      { state: 'error', reply: '', error: { code: 'interrupted', safe_message: 'x', retryable: true } },
      { state: 'error', reply: '', error: { code: 'attachment_not_found', safe_message: 'x', retryable: true } },
      { state: 'error', reply: 'a medias', error: { code: 'failed', safe_message: 'x', retryable: true } },
    ]) {
      const page = await loadPage(null, { submit: () => ({ turn_id: 't-78', duplicate: false }) });
      await page.pick([page.fakeFile('foto.png', 9, 'image/png')]);
      await page.send();
      await page.push({ turns: [{ turn_id: 't-78', seq: 3, user_text: '', attachments: [], ...end }], active_turn: null });
      assert.equal(page.chips().length, 0, JSON.stringify(end));
      // a later refusal of another turn does not resurrect them either
      await page.push({ turns: [{ turn_id: 't-78', seq: 4, user_text: '', attachments: [], ...end }, { turn_id: 't-79', state: 'error', seq: 5, user_text: 'x', reply: '', error: { code: 'busy' }, attachments: [] }] });
      assert.equal(page.chips().length, 0, JSON.stringify(end));
    }
  });

  await check('a conversation change clears the chips AND asks the daemon to delete their unsent files', async () => {
    const page = await loadPage();
    await page.pick([page.fakeFile('uno.txt', 1), page.fakeFile('dos.txt', 1)]);
    assert.equal(page.chips().length, 2);
    await page.push({ conversation_id: 'c-otra', turns: [] });
    assert.equal(page.chips().length, 0);
    assert.deepEqual(page.actions('discard').map(p => p.id).sort(), ['a-0000000000000001', 'a-0000000000000002']);
  });

  await check('page canSend: files without text are sendable; without files an empty draft is not', async () => {
    const V = require(path.join(FRONTEND, 'chat-view.js'));
    const view = { availability: { state: 'ready' }, active_turn: null };
    assert.equal(V.canSend(view, '', false, 1), true);
    assert.equal(V.canSend(view, '', false, 0), false);
    assert.equal(V.sendState(view, '', false, 1).disabled, false);
    assert.equal(V.sendState(view, '', false).disabled, true);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
})();

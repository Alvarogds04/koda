'use strict';
// K2-05 U4b — the agent's questions (ask → ui_response) inside the island chat, the way Gentle Dot's AskCard does it:
// one card per pending ask after the turn that asked, select / confirm / input, answered once, «Omitir» cancels,
// the card closes on ask_resolved and shows the outcome. Two layers: the pure chat-view.js helpers, then the real
// chat.js + chat-view.js driven through their public DOM + IPC surface on a minimal fake DOM (no browser, no daemon).
// Run: node apps/desktop-tauri/test-node/chat-ask-check.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const frontend = path.join(__dirname, '..', 'frontend');
const V = require(path.join(frontend, 'chat-view.js'));

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed + failed} - ${name}`); }
  catch (error) { failed += 1; console.error(`not ok ${passed + failed} - ${name}\n  ${error && error.stack}`); }
}

const ASKS = [
  { id: 'a-sel', kind: 'select', title: '¿Qué rama?', message: null, placeholder: null, options: ['main', 'dev', 'prod'], answering: false },
  { id: 'a-yes', kind: 'confirm', title: '¿Borrar?', message: 'Se borra notas.md', placeholder: null, options: [], answering: false },
  { id: 'a-txt', kind: 'input', title: 'Nombre', message: null, placeholder: 'tu nombre', options: [], answering: false },
];

// ---- a minimal DOM: enough of the real API for chat.js (parentNode, closest, contains, focus, keyboard) ----------------
async function page(initial) {
  const nodes = new Map(), calls = [], listeners = {};
  let document;
  const fire = (el, event) => {
    event.preventDefault = () => { event.defaultPrevented = true; };
    event.stopPropagation = () => { event.stopped = true; };
    event.target = event.target || el;
    for (let n = el; n && !event.stopped; n = n.parentNode) for (const fn of (n.listeners[event.type] || []).slice()) fn(event);
    if (!event.stopped && el !== document) for (const fn of document.listeners[event.type] || []) fn(event);
    return event;
  };
  const make = (id = null, tag = 'div') => {
    const e = { id, tagName: tag.toUpperCase(), dataset: {}, attributes: {}, listeners: {}, children: [], hidden: false, disabled: false, value: '', type: '',
      scrollTop: 0, scrollHeight: 1000, clientHeight: 300, style: {}, parentNode: null, tabIndex: -1, className: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute(k, v) { this.attributes[k] = String(v); }, getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
      removeAttribute(k) { delete this.attributes[k]; }, hasAttribute(k) { return k in this.attributes; },
      addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); },
      append(...items) { for (const n of items) { if (typeof n === 'string') continue; if (n.parentNode) n.remove(); n.parentNode = this; this.children.push(n); } },
      appendChild(n) { this.append(n); return n; },
      prepend(...items) { for (const n of items) { if (n.parentNode) n.remove(); n.parentNode = this; } this.children.unshift(...items); },
      insertBefore(n, ref) { if (n.parentNode) n.remove(); n.parentNode = this; const at = ref ? this.children.indexOf(ref) : -1; if (at < 0) this.children.push(n); else this.children.splice(at, 0, n); return n; },
      replaceChildren(...items) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...items); },
      remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } },
      contains(other) { for (let n = other; n; n = n.parentNode) if (n === this) return true; return false; },
      closest(sel) { for (let n = this; n; n = n.parentNode) if (sel.startsWith('.') ? String(n.className).split(' ').includes(sel.slice(1)) : n.tagName === sel.toUpperCase()) return n; return null; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const out = [], match = n => sel === 'li.empty' ? n.className === 'empty' : sel.startsWith('[data-ask-control') ? n.dataset.askControl !== undefined : sel.startsWith('.') ? String(n.className).split(' ').includes(sel.slice(1)) : n.tagName === sel.toUpperCase();
        const walk = n => { for (const c of n.children) { if (match(c)) out.push(c); walk(c); } };
        walk(this); return out;
      },
      focus() { document.activeElement = this; }, blur() { if (document.activeElement === this) document.activeElement = null; },
      click() { if (this.disabled) return null; return fire(this, { type: 'click', detail: 0 }); },
      scrollIntoView() { this.scrolledIntoView = (this.scrolledIntoView || 0) + 1; },
      requestSubmit() { fire(this, { type: 'submit' }); },
    };
    let text = '';
    Object.defineProperty(e, 'textContent', { get: () => text + e.children.map(c => c.textContent).join(''), set: v => { text = String(v); for (const c of e.children) c.parentNode = null; e.children = []; } });
    Object.defineProperty(e, 'lastElementChild', { get: () => e.children.at(-1) });
    return e;
  };
  document = { ...make(), activeElement: null, body: make(), getElementById(id) { if (!nodes.has(id)) nodes.set(id, make(id)); return nodes.get(id); }, createElement: tag => make(null, tag), importNode: n => n, dispatchEvent(e) { fire(this, e); } };
  const base = { conversation_id: 'c-koda', active_turn: 't-2', availability: { state: 'busy', message: 'busy' }, history_before: null,
    turns: [{ turn_id: 't-1', user_text: 'hola', reply: 'buenas', state: 'completed', seq: 1 }, { turn_id: 't-2', user_text: 'guardá', reply: '', state: 'thinking', seq: 1 }], asks: [] };
  let state = { ...base, ...(initial || {}) };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  let answerWith = null;
  const invoke = async (_command, { payload: p }) => {
    calls.push(structuredClone(p));
    if (p.action === 'answer' && answerWith) return answerWith(p);
    if (p.action === 'answer') return { answered: true };
    return structuredClone(state);
  };
  const sandbox = { document, console, structuredClone, crypto: { getRandomValues: b => b }, Date, setTimeout: (fn, ms) => setTimeout(fn, Math.min(Number(ms) || 0, 5)), clearTimeout,
    requestAnimationFrame: f => f(), CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o.detail; } }, DOMParser: class { parseFromString() { return { documentElement: null }; } },
    __TAURI__: { core: { invoke }, event: { listen: async (k, f) => { listeners[k] = f; } } } };
  sandbox.window = sandbox; sandbox.self = sandbox; vm.createContext(sandbox);
  for (const file of ['chat-view.js', 'chat.js']) vm.runInContext(fs.readFileSync(path.join(frontend, file), 'utf8'), sandbox, { filename: file });
  const capsule = document.getElementById('capsule'); capsule.dataset.view = 'chat'; capsule.dataset.phase = 'expanded';
  await settle();
  const log = document.getElementById('chat-log');
  const cards = () => log.children.filter(li => String(li.className).split(' ').includes('ask'));
  const control = (card, name) => card.querySelectorAll('[data-ask-control]').filter(n => n.dataset.askControl === name);
  return { document, calls, fire, settle, log, cards, control,
    answers: () => calls.filter(c => c.action === 'answer'),
    setAnswer: f => { answerWith = f; },
    push: async s => { state = { ...state, ...s }; listeners['chat:state']({ payload: structuredClone(state) }); await settle(); } };
}

const answering = (asks, id) => asks.map(a => (a.id === id ? { ...a, answering: true } : a));

(async () => {
  // ---- pure helpers ------------------------------------------------------------------------------------------------
  await check('askCards keeps only well-formed asks (closed kinds, safe ids), bounded to 16, display text only', () => {
    assert.deepEqual(V.askCards(null), []);
    assert.deepEqual(V.askCards({ asks: 'x' }), []);
    const cards = V.askCards({ asks: [...ASKS, { id: 'bad id!', kind: 'select', title: 't', options: [] }, { id: 'a-ed', kind: 'editor', title: 't' }, null] });
    assert.deepEqual(cards.map(c => c.id), ['a-sel', 'a-yes', 'a-txt']);
    assert.deepEqual(cards[0], { id: 'a-sel', kind: 'select', title: '¿Qué rama?', message: '', placeholder: '', options: ['main', 'dev', 'prod'], answering: false });
    assert.equal(cards[1].message, 'Se borra notas.md');
    assert.equal(cards[2].placeholder, 'tu nombre');
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `a-${i}`, kind: 'confirm', title: 't', options: [] }));
    assert.equal(V.askCards({ asks: many }).length, 16);
    assert.equal(V.askCards({ asks: [{ id: 'a-1', kind: 'select', title: 't', options: ['x', 7] }] })[0].options.length, 1, 'a non-string option is dropped');
  });
  await check('askPayload builds exactly one closed answer verb; the typed value is sent as typed', () => {
    assert.deepEqual(V.askPayload('a-sel', { value: 'dev' }), { action: 'answer', ask_id: 'a-sel', value: 'dev' });
    assert.deepEqual(V.askPayload('a-yes', { confirmed: false }), { action: 'answer', ask_id: 'a-yes', confirmed: false });
    assert.deepEqual(V.askPayload('a-txt', { cancelled: true }), { action: 'answer', ask_id: 'a-txt', cancelled: true });
    const typed = 'mi Raspberry Pi con engram y Gentle Shell';
    assert.deepEqual(V.askPayload('a-txt', { value: typed }), { action: 'answer', ask_id: 'a-txt', value: typed }, 'never white-labelled');
  });
  await check('askOutcome says in Spanish what happened to the question', () => {
    assert.equal(V.askOutcome({ kind: 'select' }, { value: 'dev' }), 'Elegiste: dev');
    assert.equal(V.askOutcome({ kind: 'confirm' }, { confirmed: true }), 'Respondiste: Sí');
    assert.equal(V.askOutcome({ kind: 'confirm' }, { confirmed: false }), 'Respondiste: No');
    assert.equal(V.askOutcome({ kind: 'input' }, { value: 'Ana' }), 'Respondiste: Ana');
    assert.equal(V.askOutcome({ kind: 'input' }, { value: '' }), 'Respondiste sin texto.');
    assert.equal(V.askOutcome({ kind: 'input' }, { cancelled: true }), 'Omitiste la pregunta.');
    assert.equal(V.askOutcome({ kind: 'input' }, null), 'La pregunta se cerró: se respondió en otro lugar o venció.');
  });
  await check('askNextOption moves through a select with the arrows, Home and End, wrapping', () => {
    assert.equal(V.askNextOption(0, 3, 'ArrowDown'), 1);
    assert.equal(V.askNextOption(2, 3, 'ArrowDown'), 0);
    assert.equal(V.askNextOption(0, 3, 'ArrowUp'), 2);
    assert.equal(V.askNextOption(1, 3, 'ArrowRight'), 2);
    assert.equal(V.askNextOption(1, 3, 'ArrowLeft'), 0);
    assert.equal(V.askNextOption(1, 3, 'Home'), 0);
    assert.equal(V.askNextOption(1, 3, 'End'), 2);
    assert.equal(V.askNextOption(1, 3, 'a'), -1, 'any other key is not navigation');
  });

  // ---- the real page --------------------------------------------------------------------------------------------------
  await check('each pending ask is a card inside the chat, right after the turn that asked, in Spanish, with aria labels', async () => {
    const p = await page();
    await p.push({ asks: ASKS });
    const cards = p.cards();
    assert.equal(cards.length, 3);
    const items = p.log.children;
    const lastTurnRow = items.findIndex(li => li.className === 'user' && li.textContent === 'guardá');
    assert.ok(items.indexOf(cards[0]) > lastTurnRow, 'after the turn that asked');
    assert.equal(cards[0].getAttribute('role'), 'group');
    assert.equal(cards[0].getAttribute('aria-label'), 'Koda necesita tu respuesta: ¿Qué rama?');
    assert.ok(cards[0].textContent.includes('Necesita tu respuesta'));
    assert.deepEqual(p.control(cards[0], 'option').map(b => b.textContent), ['main', 'dev', 'prod']);
    assert.equal(p.control(cards[0], 'options')[0].getAttribute('aria-label'), 'Opciones');
    assert.deepEqual(p.control(cards[1], 'confirm').map(b => b.textContent), ['Sí', 'No']);
    assert.ok(cards[1].textContent.includes('Se borra notas.md'), 'the confirm shows what is approved');
    const input = p.control(cards[2], 'input')[0];
    assert.equal(input.getAttribute('aria-label'), 'Nombre');
    assert.equal(input.placeholder, 'tu nombre');
    for (const card of cards) assert.equal(p.control(card, 'skip')[0].getAttribute('aria-label'), 'Omitir la pregunta');
    // a later turn of the same chat does not move the card: it stays after the turn that asked
    await p.push({ active_turn: 't-3', turns: [...[{ turn_id: 't-1', user_text: 'hola', reply: 'buenas', state: 'completed', seq: 1 }, { turn_id: 't-2', user_text: 'guardá', reply: 'ok', state: 'completed', seq: 2 }], { turn_id: 't-3', user_text: 'otra', reply: '', state: 'thinking', seq: 1 }] });
    const after = p.log.children;
    assert.ok(after.indexOf(p.cards()[0]) < after.findIndex(li => li.className === 'user' && li.textContent === 'otra'), 'the card stays with its turn');
  });
  await check('select: a click answers once with the shown option; a double click never sends twice', async () => {
    const p = await page();
    await p.push({ asks: ASKS });
    const dev = p.control(p.cards()[0], 'option')[1];
    dev.click(); dev.click();
    await p.settle();
    assert.deepEqual(p.answers(), [{ action: 'answer', ask_id: 'a-sel', value: 'dev' }]);
    assert.ok(p.control(p.cards()[0], 'option').every(b => b.disabled), 'answering: the card is disabled');
    assert.ok(p.cards()[0].textContent.includes('Enviando respuesta…'));
    // the host says it is answering, then the daemon resolves it: the card shows the outcome
    await p.push({ asks: answering(ASKS, 'a-sel') });
    p.control(p.cards()[0], 'option')[0]?.click();
    assert.equal(p.answers().length, 1);
    await p.push({ asks: ASKS.slice(1), answered_asks: ['a-sel'] }); // the daemon accepted it
    const done = p.cards()[0];
    assert.ok(done.textContent.includes('Elegiste: dev'), done.textContent);
    assert.equal(p.control(done, 'option').length, 0, 'no controls left');
    assert.equal(done.getAttribute('aria-label'), 'Pregunta de Koda: ¿Qué rama?. Elegiste: dev');
  });
  await check('select: the arrows move between options, Enter chooses the focused one', async () => {
    const p = await page();
    await p.push({ asks: [ASKS[0]] });
    const opts = p.control(p.cards()[0], 'option');
    assert.deepEqual(opts.map(b => b.tabIndex), [0, -1, -1], 'one tab stop (roving)');
    opts[0].focus();
    p.fire(opts[0], { type: 'keydown', key: 'ArrowDown' });
    assert.equal(p.document.activeElement, opts[1]);
    p.fire(opts[1], { type: 'keydown', key: 'ArrowDown' });
    p.fire(opts[2], { type: 'keydown', key: 'ArrowDown' });
    assert.equal(p.document.activeElement, opts[0], 'wraps');
    p.fire(opts[0], { type: 'keydown', key: 'End' });
    assert.equal(p.document.activeElement, opts[2]);
    assert.deepEqual(opts.map(b => b.tabIndex), [-1, -1, 0]);
    p.fire(opts[2], { type: 'keydown', key: 'Enter' });
    await p.settle();
    assert.deepEqual(p.answers(), [{ action: 'answer', ask_id: 'a-sel', value: 'prod' }]);
  });
  await check('confirm: Sí / No send the boolean', async () => {
    const p = await page();
    await p.push({ asks: [ASKS[1]] });
    p.control(p.cards()[0], 'confirm')[1].click();
    await p.settle();
    assert.deepEqual(p.answers(), [{ action: 'answer', ask_id: 'a-yes', confirmed: false }]);
  });
  await check('input: Enter submits the typed text verbatim; the outcome shows it; Escape cancels and never collapses the island', async () => {
    const p = await page();
    await p.push({ asks: [ASKS[2]] });
    const input = p.control(p.cards()[0], 'input')[0];
    const typed = 'mi Raspberry Pi con engram y Gentle Shell';
    input.value = typed; p.fire(input, { type: 'input' });
    input.focus();
    const enter = p.fire(input, { type: 'keydown', key: 'Enter' });
    assert.equal(enter.defaultPrevented, true);
    await p.settle();
    assert.deepEqual(p.answers(), [{ action: 'answer', ask_id: 'a-txt', value: typed }]);
    await p.push({ asks: [], answered_asks: ['a-txt'] });
    assert.ok(p.cards()[0].textContent.includes(`Respondiste: ${typed}`), 'the user\'s own words, untouched');
    // Escape on a fresh card cancels it and stops there (the island stays open)
    const q = await page();
    let closed = 0; q.document.defaultView = null;
    await q.push({ asks: [ASKS[2]] });
    const field = q.control(q.cards()[0], 'input')[0];
    field.focus();
    const esc = q.fire(field, { type: 'keydown', key: 'Escape' });
    assert.equal(esc.defaultPrevented, true);
    assert.equal(esc.stopped, true, 'the island\'s own Escape never sees it');
    await q.settle();
    assert.deepEqual(q.answers(), [{ action: 'answer', ask_id: 'a-txt', cancelled: true }]);
    assert.equal(closed, 0);
    await q.push({ asks: [], answered_asks: ['a-txt'] });
    assert.ok(q.cards()[0].textContent.includes('Omitiste la pregunta.'));
  });
  await check('«Omitir» cancels the question once', async () => {
    const p = await page();
    await p.push({ asks: [ASKS[0]] });
    const skip = p.control(p.cards()[0], 'skip')[0];
    skip.click(); skip.click();
    await p.settle();
    assert.deepEqual(p.answers(), [{ action: 'answer', ask_id: 'a-sel', cancelled: true }]);
  });
  await check('an ask resolved elsewhere (another client, expired) goes away like Gentle Dot; a refused answer can be retried', async () => {
    const p = await page();
    await p.push({ asks: ASKS.slice(0, 2) });
    await p.push({ asks: [ASKS[1]] });
    assert.equal(p.cards().length, 1, 'the card of the question closed elsewhere is removed');
    p.setAnswer(() => Promise.reject({ code: 'answer_refused', message: 'No se pudo enviar la respuesta.' }));
    p.control(p.cards()[0], 'confirm')[0].click();
    await p.settle(); await p.settle();
    const card = p.cards()[0];
    assert.ok(card.textContent.includes('No se pudo enviar la respuesta.'), card.textContent);
    assert.ok(p.control(card, 'confirm').every(b => !b.disabled), 'a refused answer frees the card');
    p.setAnswer(null);
    p.control(p.cards()[0], 'confirm')[0].click();
    await p.settle();
    assert.equal(p.answers().length, 2);
    // a closed question (unknown to the daemon): the card goes away at once and the chat says why
    const q = await page();
    await q.push({ asks: [ASKS[1]] });
    q.setAnswer(() => Promise.reject({ code: 'ask_closed', message: 'Esa pregunta ya no está abierta.' }));
    q.control(q.cards()[0], 'confirm')[0].click();
    await q.settle(); await q.settle();
    assert.equal(q.cards().length, 0, 'the card is removed');
    assert.equal(q.document.getElementById('chat-live').textContent, 'Esa pregunta ya no está abierta.');
  });
  await check('F2: only an answer the daemon accepted shows its outcome; a question closed without it (expired, elsewhere, engine restart) is removed', async () => {
    // this page answered, but the question closed without the daemon accepting it (not in answered_asks)
    const p = await page();
    await p.push({ asks: ASKS });
    p.control(p.cards()[0], 'option')[1].click();
    await p.settle();
    await p.push({ asks: answering(ASKS, 'a-sel') });
    await p.push({ asks: ASKS.slice(1), answered_asks: [] });
    assert.deepEqual(p.cards().map(c => c.dataset.askCard), ['a-yes', 'a-txt'], 'no «Elegiste» for an answer the daemon never took');
    assert.ok(!p.log.textContent.includes('Elegiste'), p.log.textContent);
    // never answered here: expired or answered elsewhere
    await p.push({ asks: [ASKS[2]], answered_asks: [] });
    assert.deepEqual(p.cards().map(c => c.dataset.askCard), ['a-txt']);
    assert.ok(!p.log.textContent.includes('La pregunta se cerró'), 'no outcome for a question this page did not answer');
    // engine restart: the daemon drops every pending ask; a reconnect does not bring them back
    await p.push({ asks: [], availability: { state: 'unavailable', message: 'x' }, active_turn: null });
    assert.equal(p.cards().length, 1, 'offline: the card waits');
    await p.push({ asks: [], answered_asks: [], availability: { state: 'ready', message: 'x' } });
    assert.equal(p.cards().length, 0, 'back online without the question: the card is removed');
    // the accepted one keeps its outcome
    const q = await page();
    await q.push({ asks: [ASKS[1]] });
    q.control(q.cards()[0], 'confirm')[1].click();
    await q.settle();
    await q.push({ asks: [], answered_asks: ['a-yes'] });
    assert.ok(q.cards()[0].textContent.includes('Respondiste: No'), q.log.textContent);
  });
  await check('F3: the card never stays on «Enviando respuesta…» past the next state that shows answering:false', async () => {
    // the answer was marked, then its write failed (or the connection dropped): Rust un-marks it
    const p = await page();
    await p.push({ asks: [ASKS[1]] });
    p.control(p.cards()[0], 'confirm')[0].click();
    await p.settle();
    await p.push({ asks: answering([ASKS[1]], 'a-yes') });
    assert.ok(p.cards()[0].textContent.includes('Enviando respuesta…'));
    await p.push({ asks: [ASKS[1]] });
    assert.ok(!p.cards()[0].textContent.includes('Enviando respuesta…'), p.cards()[0].textContent);
    assert.ok(p.control(p.cards()[0], 'confirm').every(b => !b.disabled), 'answerable again');
    // the page never saw answering:true (the mark came and went between two states)
    const q = await page();
    await q.push({ asks: [ASKS[1]] });
    q.control(q.cards()[0], 'confirm')[0].click();
    await q.settle();
    await q.push({ asks: [ASKS[1]], turns: [{ turn_id: 't-1', user_text: 'hola', reply: 'buenas', state: 'completed', seq: 2 }] });
    assert.ok(!q.cards()[0].textContent.includes('Enviando respuesta…'), q.cards()[0].textContent);
    assert.ok(q.control(q.cards()[0], 'confirm').every(b => !b.disabled), 'answerable again');
    q.control(q.cards()[0], 'confirm')[1].click();
    await q.settle();
    assert.equal(q.answers().length, 2);
  });
  await check('focus: a new card takes the focus only when the human is not typing; the answer returns it to the composer', async () => {
    const p = await page();
    p.document.getElementById('chat-log').focus();
    await p.push({ asks: [ASKS[0]] });
    assert.equal(p.document.activeElement, p.control(p.cards()[0], 'option')[0], 'the first option is focused');
    assert.ok(p.cards()[0].scrolledIntoView > 0, 'a card below a long chat is scrolled into view');
    p.control(p.cards()[0], 'option')[0].click();
    await p.settle();
    await p.push({ asks: [] });
    assert.equal(p.document.activeElement, p.document.getElementById('chat-input'), 'back to the composer');
    const q = await page();
    const composer = q.document.getElementById('chat-input');
    composer.focus();
    await q.push({ asks: [ASKS[2]] });
    assert.equal(q.document.activeElement, composer, 'typing is never interrupted');
  });
  await check('a re-render keeps what the human typed in an input card and its focus', async () => {
    const p = await page();
    await p.push({ asks: [ASKS[2]] });
    const input = p.control(p.cards()[0], 'input')[0];
    input.value = 'a medias'; p.fire(input, { type: 'input' }); input.focus();
    // a state push that repaints the card (another ask arrives, the reply streams)
    await p.push({ asks: [ASKS[0], ASKS[2]], turns: [{ turn_id: 't-1', user_text: 'hola', reply: 'buenas', state: 'completed', seq: 1 }, { turn_id: 't-2', user_text: 'guardá', reply: 'parcial', state: 'streaming', seq: 2 }] });
    const again = p.control(p.cards().find(c => p.control(c, 'input').length), 'input')[0];
    assert.equal(again.value, 'a medias');
    assert.equal(p.document.activeElement, again);
  });
  await check('reconnect / reload: an offline chat keeps the pending card visible but unanswerable; the replayed ask is answerable again', async () => {
    const p = await page();
    await p.push({ asks: [ASKS[1]] });
    await p.push({ asks: [], availability: { state: 'unavailable', message: 'x' }, active_turn: null });
    const card = p.cards()[0];
    assert.ok(card, 'still visible');
    assert.ok(card.textContent.includes('Esperando la conexión con Koda…'));
    assert.ok(p.control(card, 'confirm').every(b => b.disabled));
    await p.push({ asks: [ASKS[1]], availability: { state: 'busy', message: 'x' }, active_turn: 't-2' });
    p.control(p.cards()[0], 'confirm')[0].click();
    await p.settle();
    assert.deepEqual(p.answers(), [{ action: 'answer', ask_id: 'a-yes', confirmed: true }]);
    // a page reload: a fresh page whose first view already carries the ask shows the card
    const r = await page({ asks: [ASKS[1]] });
    assert.equal(r.cards().length, 1);
  });
  await check('the card is plain text: titles and options are written with textContent, never as markup', async () => {
    const src = fs.readFileSync(path.join(frontend, 'chat.js'), 'utf8');
    const block = src.slice(src.indexOf('// ---- K2-05 U4b'), src.indexOf('// ---- end U4b'));
    assert.ok(block.length > 100, 'the ask block exists');
    assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML|outerHTML/);
    const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
    assert.match(css, /#chat-log li\.ask\b/);
  });
  console.log(`chat-ask-check: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();

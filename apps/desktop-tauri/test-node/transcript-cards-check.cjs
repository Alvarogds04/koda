'use strict';
// #371 (OD002/OD024/GD031) — chat transcript cards at the public boundary:
// per-call receipts (name, running/done/failed, bounded plain-text summary)
// and approval-decision cards that reuse the #338 card vocabulary. Field-
// driven: the rows exist only when the turn carries `tool_calls`/`approvals`;
// a plain turn renders byte-identically. No live sockets, browser or native
// window: chat-view.js pure helpers plus the chat-cards DOM builder on a
// minimal stub, then the chat.js wiring and the CSS as source contracts.
// Run: node apps/desktop-tauri/test-node/transcript-cards-check.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const read = file => fs.readFileSync(path.join(frontend, file), 'utf8');
let V = null;
try { V = require(path.join(frontend, 'chat-view.js')); } catch { /* RED keeps running */ }
let Cards = null;
try { Cards = require(path.join(frontend, 'chat-cards.js')); } catch { /* RED keeps running */ }

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
};

test('plain turns render byte-identically: no card rows without tool_calls/approvals', () => {
  const rows = V.turnRows({ turn_id: 't-1', state: 'completed', user_text: 'hola', reply: 'chau', trimmed_turns: 0 });
  assert.deepEqual(rows, [
    { kind: 'user', text: 'hola' },
    { kind: 'assistant', text: 'chau' },
  ]);
  const rich = V.turnRows({
    turn_id: 't-2', state: 'completed', user_text: 'dame', reply: 'listo', trimmed_turns: 2,
    attachments: [{ id: 'a-0123456789abcdef', name: 'a.txt', mime: 'text/plain', size: 12 }],
  });
  assert.deepEqual(rich, [
    { kind: 'user', text: 'dame' },
    { kind: 'note', short: 'Adjuntos', icon: 'info', text: 'Archivos adjuntos: a.txt' },
    { kind: 'note', short: 'Recortado', icon: 'info', text: 'Para entrar en el contexto del modelo se dejaron afuera 2 mensajes anteriores.' },
    { kind: 'assistant', text: 'listo' },
  ]);
  const states = [
    V.turnRows({ turn_id: 't-3', state: 'error', user_text: 'x', reply: '', trimmed_turns: 0, error: { safe_message: 'No disponible.' } }),
    V.turnRows({ turn_id: 't-4', state: 'completed', user_text: 'x', reply: 'r', trimmed_turns: 0, finish_reason: 'limit' }),
    V.turnRows({ turn_id: 't-5', state: 'cancelled', user_text: 'x', reply: 'me', trimmed_turns: 0 }),
  ];
  assert.deepEqual(states[0].map(r => r.kind), ['user', 'error']);
  assert.deepEqual(states[1].map(r => r.kind), ['user', 'assistant', 'note'], 'the limit note follows the reply (shipped order)');
  assert.deepEqual(states[2].map(r => r.kind), ['user', 'assistant', 'note']);
});

test('tool receipts: rows before the reply, honest state words and icons', () => {
  const rows = V.turnRows({
    turn_id: 't-1', state: 'completed', user_text: 'hola', reply: 'listo', trimmed_turns: 0,
    tool_calls: [
      { call_id: 'c-1', name: 'buscar_archivo', state: 'running' },
      { call_id: 'c-2', name: 'leer_archivo', state: 'done', summary: 'Se leyó a.txt (1,2 kB).' },
      { call_id: 'c-3', name: 'escribir_archivo', state: 'failed', summary: 'El directorio no existe.' },
    ],
  });
  const tools = rows.filter(r => r.kind === 'tool');
  assert.equal(tools.length, 3, 'one row per receipt');
  assert.deepEqual(rows.map(r => r.kind), ['user', 'tool', 'tool', 'tool', 'assistant'], 'receipts sit before the reply');
  assert.equal(tools[0].short, 'En curso');
  assert.equal(tools[0].icon, 'clock');
  assert.equal(tools[1].short, 'Listo');
  assert.equal(tools[1].icon, 'check');
  assert.equal(tools[1].summary, 'Se leyó a.txt (1,2 kB).');
  assert.equal(tools[2].short, 'Falló');
  assert.equal(tools[2].icon, 'triangle');
  for (const t of tools) assert.equal(t.name.length > 0, true, 'every receipt names its call');
  assert.ok(tools.every(t => !/\n|\r|\t/.test(t.text)), 'one line: plain text only');
});

test('tool summary is sanitized and bounded: control chars collapse, 240 scalars + ellipsis', () => {
  const rows = V.turnRows({
    turn_id: 't-1', state: 'completed', user_text: 'x', reply: '', trimmed_turns: 0,
    tool_calls: [{ call_id: 'c-1', name: 'a'.repeat(200), state: 'done', summary: `pre\u0000enta\t\r\nfin ${'b'.repeat(300)}` }],
  });
  const t = rows.find(r => r.kind === 'tool');
  assert.equal(t.name, 'a'.repeat(80) + '…', 'name capped at 80 scalars');
  assert.ok(t.summary.startsWith('pre enta fin '), 'control characters become one space');
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(t.summary), 'no control characters survive');
  assert.equal(Array.from(t.summary).length, 241, '240 scalars + the ellipsis');
  assert.ok(t.summary.endsWith('…'));
  const none = V.turnRows({
    turn_id: 't-2', state: 'done', user_text: 'x', reply: '', trimmed_turns: 0,
    tool_calls: [{ call_id: 'c-1', name: 'ok', state: 'done', summary: 42 }],
  });
  assert.equal(none.find(r => r.kind === 'tool').summary, undefined, 'a non-string summary renders as absent');
});

test('unknown tool state stays honest; malformed receipts are skipped', () => {
  const rows = V.turnRows({
    turn_id: 't-1', state: 'completed', user_text: 'x', reply: '', trimmed_turns: 0,
    tool_calls: [
      { call_id: 'c-1', name: 'misterio', state: 'teleported' },
      { call_id: 'c-2', state: 'done' },
      'garbage',
      null,
      { call_id: 'c-3', name: 'bien', state: 'done' },
    ],
  });
  const tools = rows.filter(r => r.kind === 'tool');
  assert.equal(tools.length, 2, 'nameless and malformed receipts never render');
  assert.equal(tools[0].short, 'Desconocido', 'an unmodelled state is never guessed');
  assert.equal(tools[0].icon, 'info');
  assert.equal(tools[1].name, 'bien');
});

test('approval cards reuse the #338 decision vocabulary and sit before the reply', () => {
  const rows = V.turnRows({
    turn_id: 't-1', state: 'completed', user_text: 'pusheame', reply: 'hecho', trimmed_turns: 0,
    approvals: [
      { request_id: 'r-1', operation: 'git push --force', decision: 'approved' },
      { request_id: 'r-2', operation: 'rm -rf /tmp/x', decision: 'denied' },
      { request_id: 'r-3', operation: 'instalar paquete', decision: 'expired' },
      { request_id: 'r-4', operation: 'algo más', decision: 'quizás' },
    ],
  });
  const cards = rows.filter(r => r.kind === 'approval');
  assert.deepEqual(rows.map(r => r.kind), ['user', 'approval', 'approval', 'approval', 'approval', 'assistant']);
  assert.equal(cards[0].short, 'Permitida');
  assert.equal(cards[1].short, 'Denegada');
  assert.equal(cards[2].short, 'Vencida', 'expired keeps the honest #338 expiry state');
  assert.equal(cards[3].short, 'Desconocida', 'an unmodelled decision is never guessed');
  assert.ok(cards.every(c => c.operation.length > 0 && !/\n/.test(c.operation)), 'one-line plain operation');
});

test('approval cards: malformed entries skipped, decision optional but honest', () => {
  const rows = V.turnRows({
    turn_id: 't-1', state: 'completed', user_text: 'x', reply: '', trimmed_turns: 0,
    approvals: [{ request_id: 'r-1' }, 'garbage', null, { request_id: 'r-2', operation: 'escribir config', decision: 'denied' }],
  });
  const cards = rows.filter(r => r.kind === 'approval');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].operation, 'escribir config');
  assert.equal(cards[0].short, 'Denegada');
});

test('rowKey changes when a receipt changes state, so reconcile patches in place', () => {
  const turn = state => V.turnRows({
    turn_id: 't-1', state: 'completed', user_text: 'x', reply: '', trimmed_turns: 0,
    tool_calls: [{ call_id: 'c-1', name: 'leer', state }],
  });
  const running = turn('running')[1], done = turn('done')[1];
  assert.notEqual(V.rowKey(running), V.rowKey(done), 'running → done must not be treated as the same row');
  assert.equal(V.reconcileRows([running], [done]).patch.length, 1, 'and must be patched, never rebuilt');
});

// Minimal DOM at the builder boundary: real chat-cards module, text nodes only.
function boot() {
  const made = [];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.className = ''; this.textContent = ''; this.handlers = {}; }
    append(...kids) { this.children.push(...kids); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] || null; }
    addEventListener(k, fn) { this.handlers[k] = fn; }
  }
  const document = { createElement: tag => { const el = new Element(tag); made.push(el); return el; } };
  return { document, made, Element };
}
const label = el => el.attrs['aria-label'] || '';

test('chat-cards builds a receipt card: text nodes only, state in dataset and aria', () => {
  const b = boot();
  const li = new b.Element('li');
  Cards.render(li, { kind: 'tool', name: 'leer_archivo', short: 'Listo', icon: 'check', text: 'Herramienta leer_archivo: Listo. Se leyó a.txt.', summary: 'Se leyó a.txt.', state: 'done' }, () => null, b.document);
  assert.equal(li.children.length, 1, 'one card root inside the row');
  const card = li.children[0];
  assert.equal(card.className, 'chat-card');
  assert.equal(li.dataset.state, 'done');
  assert.equal(label(li), 'Herramienta leer_archivo: Listo. Se leyó a.txt.');
  const texts = [];
  const walk = n => { if (n.textContent) texts.push(n.textContent); for (const c of n.children || []) walk(c); };
  walk(card);
  assert.deepEqual(texts, ['leer_archivo', 'Listo', 'Se leyó a.txt.'], 'the card is made of text nodes: name, state word, summary');
  assert.doesNotMatch(read('chat-cards.js'), /innerHTML|outerHTML|insertAdjacentHTML/, 'no markup path anywhere in the builder');
});

test('chat-cards builds an approval card with the decision word and no summary block', () => {
  const b = boot();
  const li = new b.Element('li');
  Cards.render(li, { kind: 'approval', operation: 'git push --force', short: 'Denegada', icon: 'cross', text: 'Aprobación git push --force: Denegada.', decision: 'denied' }, () => null, b.document);
  const card = li.children[0];
  assert.equal(li.dataset.decision, 'denied');
  assert.equal(label(li), 'Aprobación git push --force: Denegada.');
  const texts = [];
  const walk = n => { if (n.textContent) texts.push(n.textContent); for (const c of n.children || []) walk(c); };
  walk(card);
  assert.deepEqual(texts, ['git push --force', 'Denegada'], 'no invented detail: operation + decision word');
});

test('chat-cards tolerates a missing icon node and a malformed row without throwing', () => {
  const b = boot();
  const li = new b.Element('li');
  Cards.render(li, { kind: 'tool', name: 'leer', short: 'Listo', icon: 'check', text: 'Herramienta leer: Listo.', state: 'done' }, () => null, b.document);
  assert.equal(li.children.length, 1, 'icon is optional decoration');
  Cards.render(new b.Element('li'), null, () => null); // must not throw
});

test('wiring: chat.js paints card rows through chat-cards before the short branch', () => {
  const chat = read('chat.js');
  const cardsAt = chat.indexOf('Cards.render(li, row, iconNode)');
  const shortAt = chat.indexOf("} else if (row.short) {");
  assert.ok(cardsAt > 0, 'chat.js delegates card rows to the chat-cards module');
  assert.ok(shortAt > cardsAt, 'cards are checked before the icon+word note branch');
  assert.match(chat, /row\.kind === 'tool' \|\| row\.kind === 'approval'/, 'only the two card kinds route there');
  assert.match(read('index.html'), /chat-cards\.js/, 'the module ships with the island page');
});

test('css: cards are styled inside the log with theme tokens only (light and dark)', () => {
  const css = read('chat-markdown.css');
  for (const needle of ['#chat-log li.tool', '#chat-log li.approval', '.chat-card', '.chat-card-head', '.chat-card-name', '.chat-card-state', '.chat-card-summary']) {
    assert.ok(css.includes(needle), `missing rule: ${needle}`);
  }
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, ' '); // comments carry task ids like #371, not colors
  assert.doesNotMatch(cssCode, /#[0-9a-fA-F]{3,6}\b(?![^(]*\))/, 'no hardcoded hex: tokens flip with the theme');
  assert.match(css, /var\(--(surface|fill|line|island|muted)/, 'colour comes from the themed tokens');
});

console.log(`transcript-cards-check: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

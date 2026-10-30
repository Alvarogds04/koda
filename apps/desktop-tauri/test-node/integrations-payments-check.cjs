'use strict';
/* #356 F041 — pure checks for frontend/integrations-payments.js (the Payments
   service card: connection status + a read-only summary). FAKE data only, no
   network, no accounts, no money verbs. The renderer is driven through a tiny
   fake DOM so the textContent-only guarantee is observed, not assumed.
   Run: node apps/desktop-tauri/test-node/integrations-payments-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const F = require(path.join(frontend, 'integrations-view.js'));
const P = require(path.join(frontend, 'integrations-payments.js'));
const SRC = fs.readFileSync(path.join(frontend, 'integrations-payments.js'), 'utf8');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
};

// ---- tiny fake DOM ----------------------------------------------------------
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.dataset = {}; this.attrs = {}; this._text = ''; this.hidden = false; this.disabled = false; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  append(...n) { this.children.push(...n); }
  appendChild(n) { this.children.push(n); return n; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  byClass(cls) { return this.all(n => n.className.split(' ').includes(cls)); }
}
global.document = { createElement: tag => new Node(tag) };

// ---- money ------------------------------------------------------------------
test('formatMoney: integer minor units to Spanish grouping, closed currencies only', () => {
  assert.equal(P.formatMoney(123450, 'EUR'), '1.234,50 €');
  assert.equal(P.formatMoney(5, 'EUR'), '0,05 €');
  assert.equal(P.formatMoney(-250000, 'USD'), '-2.500,00 US$');
  assert.equal(P.formatMoney(0, 'EUR'), '0,00 €');
  for (const bad of [[1.5, 'EUR'], ['1', 'EUR'], [NaN, 'EUR'], [1, 'BTC'], [1, null], [2 ** 60, 'EUR']]) {
    assert.equal(P.formatMoney(...bad), null, JSON.stringify(bad));
  }
});

// ---- vocabulary -------------------------------------------------------------
test('payment statuses: closed vocabulary with Spanish labels', () => {
  assert.deepEqual(P.PAYMENT_STATUSES, ['succeeded', 'pending', 'failed', 'refunded']);
  assert.equal(P.statusLabel('succeeded'), 'cobrado');
  assert.equal(P.statusLabel('pending'), 'pendiente');
  assert.equal(P.statusLabel('failed'), 'fallido');
  assert.equal(P.statusLabel('refunded'), 'reembolsado');
  for (const bad of ['', 'paid', 'constructor', null, undefined, 3]) assert.equal(P.statusLabel(bad), null, String(bad));
  assert.ok(Object.isFrozen(P.PAYMENT_STATUSES));
});

// ---- frame -> model -----------------------------------------------------------
const frame = () => JSON.parse(JSON.stringify(P.fakeFrame()));

test('fake provider: loud, closed shape, deterministic, inside the framework vocabulary', () => {
  const f = P.fakeFrame();
  assert.equal(f.type, 'integrations-payments');
  assert.equal(f.schema, P.SCHEMA);
  assert.equal(f.fake, true);
  assert.ok(F.STATES.includes(f.state));
  assert.ok(f.payments.length > 0 && f.payments.length <= P.MAX_PAYMENTS);
  assert.deepEqual(P.fakeFrame(), P.fakeFrame());
  assert.ok(P.modelFromFrame(f), 'the fake frame passes its own validator');
  assert.equal(P.BANNER, F.view(F.storeFromFrame(F.fakeFrame()), 1).banner, 'same loud copy as the framework');
  assert.match(P.BANNER, /Datos de ejemplo/);
});

test('modelFromFrame: valid frame builds a frozen model; malformed frames are refused whole', () => {
  const m = P.modelFromFrame(frame());
  assert.equal(m.fake, true);
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.payments) && Object.isFrozen(m.payments[0]));
  const mutate = fn => { const f = frame(); fn(f); return P.modelFromFrame(f); };
  assert.equal(P.modelFromFrame(null), null);
  assert.equal(P.modelFromFrame([]), null);
  assert.equal(mutate(f => { f.type = 'integrations'; }), null);
  assert.equal(mutate(f => { f.schema = 'x'; }), null);
  assert.equal(mutate(f => { f.fake = 'yes'; }), null);
  assert.equal(mutate(f => { f.state = 'ok'; }), null);
  assert.equal(mutate(f => { f.currency = 'BTC'; }), null);
  assert.equal(mutate(f => { f.url = 'https://evil.example'; }), null, 'extra keys never pass');
  assert.equal(mutate(f => { f.payments[0].status = 'paid'; }), null);
  assert.equal(mutate(f => { f.payments[0].amountMinor = 1.5; }), null);
  assert.equal(mutate(f => { f.payments[0].amountMinor = -5; }), null, 'amounts are unsigned; refunds are a status');
  assert.equal(mutate(f => { f.payments[0].id = 'Bad Id'; }), null);
  assert.equal(mutate(f => { f.payments[0].label = 'x'.repeat(41); }), null);
  assert.equal(mutate(f => { f.payments[0].token = 'sk_live'; }), null);
  assert.equal(mutate(f => { f.payments = f.payments.concat(f.payments, f.payments).slice(0, P.MAX_PAYMENTS + 1).map((p, i) => ({ ...p, id: `p${i}` })); }), null, 'bounded size');
  assert.equal(mutate(f => { f.payments.push({ ...f.payments[0] }); }), null, 'duplicate ids refuse');
  assert.ok(mutate(f => { f.payments = []; }), 'an empty list is a valid frame');
});

// ---- view ---------------------------------------------------------------------
test('view: summary totals per status, Spanish money, honest counters, fake is loud', () => {
  const v = P.view(P.modelFromFrame({
    type: 'integrations-payments', schema: P.SCHEMA, fake: true, state: 'connected', currency: 'EUR',
    payments: [
      { id: 'a', label: 'Cuota A', amountMinor: 100000, status: 'succeeded' },
      { id: 'b', label: 'Cuota B', amountMinor: 2550, status: 'succeeded' },
      { id: 'c', label: 'Cuota C', amountMinor: 4000, status: 'pending' },
      { id: 'd', label: 'Cuota D', amountMinor: 900, status: 'failed' },
      { id: 'e', label: 'Cuota E', amountMinor: 1000, status: 'refunded' },
    ],
  }));
  assert.equal(v.fake, true);
  assert.equal(v.banner, P.BANNER);
  assert.equal(v.state, 'connected');
  assert.equal(v.stateLabel, 'conectado');
  assert.equal(v.showData, true);
  assert.deepEqual(v.summary.map(s => [s.key, s.count, s.amount]), [
    ['succeeded', 2, '1.025,50 €'], ['pending', 1, '40,00 €'], ['failed', 1, '9,00 €'], ['refunded', 1, '10,00 €'],
  ]);
  assert.deepEqual(v.rows.map(r => [r.id, r.statusLabel, r.amount]), [
    ['a', 'cobrado', '1.000,00 €'], ['b', 'cobrado', '25,50 €'], ['c', 'pendiente', '40,00 €'],
    ['d', 'fallido', '9,00 €'], ['e', 'reembolsado', '10,00 €']]);
  assert.equal(P.view(null), null);
  assert.equal(P.view({ fake: true }), null);
});

test('view: only a connected or paused card shows data; the other states say why, in Spanish', () => {
  const at = state => P.view(P.modelFromFrame({ ...frame(), state }));
  assert.equal(at('connected').showData, true);
  assert.equal(at('paused').showData, true);
  assert.match(at('paused').note, /pausa/);
  assert.equal(at('disconnected').showData, false);
  assert.match(at('disconnected').note, /sin conectar/i);
  assert.equal(at('error').showData, false);
  assert.match(at('error').note, /No se pudo/);
});

test('refresh cycle: the next state comes only from the framework fake outcomes; rejected input changes nothing', () => {
  const m = P.modelFromFrame(frame());
  const n = P.withState(m, F.fakeOutcome(2));
  assert.equal(n.state, 'error');
  assert.equal(m.state, 'connected', 'the old model is never mutated');
  assert.equal(n.payments, m.payments);
  for (const bad of ['maybe', null, 3]) assert.equal(P.withState(m, bad), null, String(bad));
  assert.equal(P.withState(null, 'connected'), null);
});

// ---- read-only: no verbs --------------------------------------------------------
test('read-only: no payment verbs exist in the API or the source', () => {
  const verbs = /(function\s+|\.|^\s*)(charge|refund|payout|transfer|send|cancel|retry|capture|pay)[A-Za-z]*\s*(\(|=>)/im;
  for (const k of Object.keys(P)) assert.doesNotMatch(k, /^(pay|charge|refund|payout|transfer|cancel|retry|send|capture)([A-Z]|$)/, k);
  assert.doesNotMatch(SRC, verbs);
  assert.doesNotMatch(SRC, /fetch\(|XMLHttpRequest|WebSocket|window\.open|open_chat_url|innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.ok(Object.isFrozen(P));
});

// ---- renderer -------------------------------------------------------------------
test('render: banner, status, summary and rows as text; the only button is the keyboard-reachable refresh', () => {
  const host = new Node('section');
  P.render(host, P.view(P.modelFromFrame(frame())));
  assert.equal(host.hidden, false);
  assert.ok(host.byClass('pay-fake')[0].textContent.includes('Datos de ejemplo'));
  assert.equal(host.byClass('pay-title')[0].textContent, 'Pagos');
  assert.equal(host.byClass('pay-state')[0].textContent, 'conectado');
  assert.ok(host.byClass('pay-state')[0].className.includes('pay-state--connected'));
  assert.equal(host.byClass('pay-sum').length, 4);
  assert.equal(host.byClass('pay-row').length, P.fakeFrame().payments.length);
  const buttons = host.all(n => n.tag === 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].dataset.action, 'refresh');
  assert.equal(buttons[0].textContent, 'Actualizar');
  assert.equal(buttons[0].type, 'button');
  // a hostile label is just text: no node is ever built from it
  const evil = frame(); evil.payments[0].label = '<img src=x onerror=alert(1)>';
  const h2 = new Node('section');
  P.render(h2, P.view(P.modelFromFrame(evil)));
  assert.ok(h2.byClass('pay-label')[0].textContent.includes('<img'));
  assert.equal(h2.all(n => n.tag === 'img').length, 0);
});

test('render: a non-data state shows the note and no rows; an invalid view clears and hides the host', () => {
  const host = new Node('section');
  P.render(host, P.view(P.modelFromFrame({ ...frame(), state: 'error' })));
  assert.equal(host.byClass('pay-row').length, 0);
  assert.equal(host.byClass('pay-sum').length, 0);
  assert.match(host.byClass('pay-note')[0].textContent, /No se pudo/);
  P.render(host, null);
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
  const real = new Node('section');
  P.render(real, P.view(P.modelFromFrame({ ...frame(), fake: false })));
  assert.equal(real.byClass('pay-fake').length, 0, 'a real view never claims to be an example');
});

test('mount is wired: guarded on its container, trusted clicks only, FAKE provider only, no IPC', () => {
  assert.match(SRC, /getElementById\('integrations-payments'\)/);
  assert.match(SRC, /if \(!host\) return/);
  assert.match(SRC, /isTrusted !== true/);
  assert.match(SRC, /fakeFrame\(\)/);
  assert.doesNotMatch(SRC, /invoke\(/);
});

test('module API is frozen and the file is listed in the packaging gate', () => {
  const lib = fs.readFileSync(path.join(__dirname, '..', 'packaging', 'lib.cjs'), 'utf8');
  assert.match(lib, /'integrations-payments\.js'/);
});

console.log(`integrations-payments-check: ${passed} checks ok`);

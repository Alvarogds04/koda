'use strict';
/* #369 F101/F102 — pure checks for frontend/integrations-finance.js (the Finance
   service card: price tiles with text sparklines, alert thresholds as a pure
   model, a read-only portfolio list). FAKE data only, no network, no trading
   verbs. Run: node apps/desktop-tauri/test-node/integrations-finance-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const F = require(path.join(frontend, 'integrations-view.js'));
const M = require(path.join(frontend, 'integrations-finance.js'));
const SRC = fs.readFileSync(path.join(frontend, 'integrations-finance.js'), 'utf8');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
};

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.dataset = {}; this._text = ''; this.hidden = false; this.type = ''; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  append(...n) { this.children.push(...n); }
  appendChild(n) { this.children.push(n); return n; }
  setAttribute(k, v) { this[`attr_${k}`] = String(v); }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  byClass(cls) { return this.all(n => n.className.split(' ').includes(cls)); }
}
global.document = { createElement: tag => new Node(tag) };

const frame = () => JSON.parse(JSON.stringify(M.fakeFrame()));

// ---- sparkline ------------------------------------------------------------------
test('sparkline: pure text, 8 block levels, min to lowest, max to highest, flat is mid', () => {
  assert.equal(M.sparkline([1, 2, 3, 4, 5, 6, 7, 8]), '▁▂▃▄▅▆▇█');
  assert.equal(M.sparkline([10, 0]), '█▁');
  assert.equal(M.sparkline([5, 5, 5]), '▄▄▄');
  assert.equal(M.sparkline([7]), '▄');
  for (const bad of [[], 'abc', null, [1, 'x'], [1.5, 2], [1, NaN], new Array(M.MAX_POINTS + 1).fill(1)]) {
    assert.equal(M.sparkline(bad), null, JSON.stringify(bad));
  }
});

// ---- money / change ---------------------------------------------------------------
test('formatMoney and formatChange: Spanish grouping, closed currencies, signed percent', () => {
  assert.equal(M.formatMoney(123450, 'EUR'), '1.234,50 €');
  assert.equal(M.formatMoney(5, 'USD'), '0,05 US$');
  assert.equal(M.formatMoney(1.5, 'EUR'), null);
  assert.equal(M.formatMoney(1, 'BTC'), null);
  assert.equal(M.formatChange(10000, 10125), '+1,25 %');
  assert.equal(M.formatChange(10000, 9500), '-5,00 %');
  assert.equal(M.formatChange(10000, 10000), '0,00 %');
  assert.equal(M.formatChange(0, 5), null, 'no base, no percentage');
  assert.equal(M.formatChange('1', 2), null);
});

// ---- vocabulary --------------------------------------------------------------------
test('account kinds: closed, Spanish', () => {
  assert.deepEqual(M.ACCOUNT_KINDS, ['account', 'wallet']);
  assert.equal(M.kindLabel('account'), 'cuenta');
  assert.equal(M.kindLabel('wallet'), 'billetera');
  for (const bad of ['', 'broker', 'constructor', null, 7]) assert.equal(M.kindLabel(bad), null, String(bad));
});

// ---- frame -> model ------------------------------------------------------------------
test('fake provider: loud, deterministic, closed shape, passes its own validator', () => {
  const f = M.fakeFrame();
  assert.equal(f.type, 'integrations-finance');
  assert.equal(f.schema, M.SCHEMA);
  assert.equal(f.fake, true);
  assert.deepEqual(M.fakeFrame(), M.fakeFrame());
  assert.ok(F.STATES.includes(f.state));
  assert.ok(M.modelFromFrame(f));
  assert.equal(M.BANNER, F.view(F.storeFromFrame(F.fakeFrame()), 1).banner);
});

test('modelFromFrame: frozen on success; malformed frames are refused whole', () => {
  const m = M.modelFromFrame(frame());
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.quotes) && Object.isFrozen(m.quotes[0]) && Object.isFrozen(m.quotes[0].series));
  assert.ok(Object.isFrozen(m.thresholds) && Object.isFrozen(m.accounts));
  const mutate = fn => { const f = frame(); fn(f); return M.modelFromFrame(f); };
  assert.equal(M.modelFromFrame(null), null);
  assert.equal(mutate(f => { f.type = 'integrations'; }), null);
  assert.equal(mutate(f => { f.schema = 'x'; }), null);
  assert.equal(mutate(f => { f.fake = 1; }), null);
  assert.equal(mutate(f => { f.state = 'ok'; }), null);
  assert.equal(mutate(f => { f.url = 'https://x.example'; }), null);
  assert.equal(mutate(f => { f.quotes[0].currency = 'BTC'; }), null);
  assert.equal(mutate(f => { f.quotes[0].priceMinor = 1.5; }), null);
  assert.equal(mutate(f => { f.quotes[0].priceMinor = -1; }), null);
  assert.equal(mutate(f => { f.quotes[0].series = []; }), null);
  assert.equal(mutate(f => { f.quotes[0].series = new Array(M.MAX_POINTS + 1).fill(1); }), null);
  assert.equal(mutate(f => { f.quotes[0].series = [1, 'x']; }), null);
  assert.equal(mutate(f => { f.quotes[0].order = 'buy'; }), null, 'no trading keys can ride along');
  assert.equal(mutate(f => { f.quotes[0].symbol = 'bad symbol'; }), null);
  assert.equal(mutate(f => { f.quotes.push({ ...f.quotes[0] }); }), null, 'duplicate symbols refuse');
  assert.equal(mutate(f => { f.quotes = new Array(M.MAX_QUOTES + 1).fill(0).map((_, i) => ({ ...f.quotes[0], symbol: `S${i}` })); }), null);
  assert.equal(mutate(f => { f.thresholds[0].symbol = 'NOPE'; }), null, 'a threshold needs a known quote');
  assert.equal(mutate(f => { f.thresholds[0] = { symbol: f.quotes[0].symbol }; }), null, 'a threshold needs a bound');
  assert.equal(mutate(f => { f.thresholds[0].above = -3; }), null);
  assert.equal(mutate(f => { f.thresholds[0].action = 'sell'; }), null);
  assert.equal(mutate(f => { f.accounts[0].kind = 'broker'; }), null);
  assert.equal(mutate(f => { f.accounts[0].balanceMinor = 0.5; }), null);
  assert.equal(mutate(f => { f.accounts[0].label = 'x'.repeat(41); }), null);
  assert.equal(mutate(f => { f.accounts.push({ ...f.accounts[0] }); }), null, 'duplicate account ids refuse');
  assert.equal(mutate(f => { f.accounts[0].iban = 'ES00'; }), null, 'no account identifiers ride along');
  assert.ok(mutate(f => { f.quotes = []; f.thresholds = []; f.accounts = []; }), 'empty lists are valid');
});

// ---- alerts: pure model ------------------------------------------------------------------
test('evaluateAlerts: pure, deterministic, above/below inclusive, in threshold order', () => {
  const quotes = [
    { symbol: 'AAA', priceMinor: 1000 }, { symbol: 'BBB', priceMinor: 500 }, { symbol: 'CCC', priceMinor: 700 },
  ];
  const thresholds = [
    { symbol: 'AAA', above: 1000 },            // inclusive: triggers
    { symbol: 'BBB', below: 499 },            // not triggered
    { symbol: 'BBB', above: 400, below: 600 }, // both sides bound: above triggers; below triggers too
    { symbol: 'CCC', above: 701 },
  ];
  const out = M.evaluateAlerts(quotes, thresholds);
  assert.deepEqual(out.map(a => [a.symbol, a.kind, a.limit]), [['AAA', 'above', 1000], ['BBB', 'above', 400], ['BBB', 'below', 600]]);
  assert.deepEqual(M.evaluateAlerts(quotes, thresholds), out, 'same input, same output');
  assert.deepEqual(M.evaluateAlerts(quotes, []), []);
  assert.deepEqual(M.evaluateAlerts([], thresholds), [], 'a threshold with no quote never fires');
  assert.equal(M.evaluateAlerts(null, []), null);
  assert.equal(M.evaluateAlerts(quotes, 'x'), null);
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out[0]));
});

// ---- view ----------------------------------------------------------------------------------
test('view: tiles with price, change and sparkline, alerts flagged, portfolio with totals per currency', () => {
  const v = M.view(M.modelFromFrame({
    type: 'integrations-finance', schema: M.SCHEMA, fake: true, state: 'connected',
    quotes: [
      { symbol: 'ABC', name: 'Alfa', currency: 'EUR', priceMinor: 10125, series: [10000, 10050, 10125] },
      { symbol: 'XYZ', name: 'Zeta', currency: 'USD', priceMinor: 9500, series: [10000, 9800, 9500] },
    ],
    thresholds: [{ symbol: 'XYZ', below: 9600 }],
    accounts: [
      { id: 'cta-1', label: 'Cuenta de ejemplo', kind: 'account', currency: 'EUR', balanceMinor: 100000 },
      { id: 'bil-1', label: 'Billetera de ejemplo', kind: 'wallet', currency: 'EUR', balanceMinor: 25050 },
      { id: 'bil-2', label: 'Otra billetera', kind: 'wallet', currency: 'USD', balanceMinor: 999 },
    ],
  }));
  assert.equal(v.banner, M.BANNER);
  assert.equal(v.showData, true);
  assert.deepEqual(v.tiles.map(t => [t.symbol, t.price, t.change, t.spark, t.alert]), [
    ['ABC', '101,25 €', '+1,25 %', '▁▄█', null],
    ['XYZ', '95,00 US$', '-5,00 %', '█▅▁', 'Bajo el piso de 96,00 US$'],
  ]);
  assert.deepEqual(v.alerts.map(a => a.symbol), ['XYZ']);
  assert.equal(v.alertCount, 1);
  assert.deepEqual(v.portfolio.map(r => [r.id, r.kindLabel, r.balance]), [
    ['cta-1', 'cuenta', '1.000,00 €'], ['bil-1', 'billetera', '250,50 €'], ['bil-2', 'billetera', '9,99 US$']]);
  assert.deepEqual(v.totals, [{ currency: 'EUR', total: '1.250,50 €' }, { currency: 'USD', total: '9,99 US$' }]);
  assert.equal(M.view(null), null);
});

test('view: only connected or paused shows data; the other states say why', () => {
  const at = state => M.view(M.modelFromFrame({ ...frame(), state }));
  assert.equal(at('connected').showData, true);
  assert.equal(at('paused').showData, true);
  assert.match(at('paused').note, /pausa/);
  const off = at('disconnected');
  assert.equal(off.showData, false);
  assert.match(off.note, /sin conectar/i);
  assert.deepEqual([off.tiles.length, off.portfolio.length, off.alerts.length], [0, 0, 0]);
  assert.match(at('error').note, /No se pudo/);
});

test('refresh cycle: only a closed state from the framework fake outcomes; rejected input changes nothing', () => {
  const m = M.modelFromFrame(frame());
  const n = M.withState(m, F.fakeOutcome(2));
  assert.equal(n.state, 'error');
  assert.equal(m.state, 'connected');
  assert.equal(n.quotes, m.quotes);
  for (const bad of ['maybe', null, 3]) assert.equal(M.withState(m, bad), null);
  assert.equal(M.withState(null, 'connected'), null);
});

// ---- read-only ---------------------------------------------------------------------------------
test('read-only: no trading verbs in the API or the source; no network, no markup writes', () => {
  for (const k of Object.keys(M)) assert.doesNotMatch(k, /^(buy|sell|trade|order|transfer|withdraw|deposit|swap|send|stake|place)([A-Z]|$)/, k);
  assert.doesNotMatch(SRC, /(function\s+|\.|^\s*)(buy|sell|trade|placeOrder|transfer|withdraw|deposit|swap|send|stake)[A-Za-z]*\s*(\(|=>)/im);
  assert.doesNotMatch(SRC, /fetch\(|XMLHttpRequest|WebSocket|window\.open|open_chat_url|invoke\(|innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.ok(Object.isFrozen(M));
});

// ---- renderer ---------------------------------------------------------------------------------------
test('render: banner, tiles with sparkline text, alert line, portfolio; the only button is refresh', () => {
  const host = new Node('section');
  M.render(host, M.view(M.modelFromFrame(frame())));
  assert.equal(host.hidden, false);
  assert.ok(host.byClass('fin-fake')[0].textContent.includes('Datos de ejemplo'));
  assert.equal(host.byClass('fin-title')[0].textContent, 'Finanzas');
  assert.equal(host.byClass('fin-state')[0].textContent, 'conectado');
  const tiles = host.byClass('fin-tile');
  assert.equal(tiles.length, M.fakeFrame().quotes.length);
  const spark = tiles[0].byClass('fin-spark')[0];
  assert.match(spark.textContent, /^[▁▂▃▄▅▆▇█]+$/);
  assert.equal(spark['attr_aria-hidden'], 'true', 'decorative: the change/price text carries the meaning');
  assert.equal(host.byClass('fin-row').length, M.fakeFrame().accounts.length);
  assert.ok(host.byClass('fin-total').length >= 1);
  const buttons = host.all(n => n.tag === 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].dataset.action, 'refresh');
  assert.equal(buttons[0].textContent, 'Actualizar');
  assert.equal(buttons[0].type, 'button');
  const evil = frame(); evil.quotes[0].name = '<img src=x onerror=alert(1)>'; evil.accounts[0].label = '<b>x</b>';
  const h2 = new Node('section');
  M.render(h2, M.view(M.modelFromFrame(evil)));
  assert.ok(h2.textContent.includes('<img'));
  assert.equal(h2.all(n => n.tag === 'img' || n.tag === 'b').length, 0);
});

test('render: a fake model that triggers an alert shows it; non-data state shows note only; invalid view hides', () => {
  const host = new Node('section');
  const f = frame(); f.thresholds = [{ symbol: f.quotes[0].symbol, above: 0 }];
  M.render(host, M.view(M.modelFromFrame(f)));
  assert.ok(host.byClass('fin-alert').length >= 1);
  M.render(host, M.view(M.modelFromFrame({ ...frame(), state: 'error' })));
  assert.equal(host.byClass('fin-tile').length, 0);
  assert.equal(host.byClass('fin-row').length, 0);
  assert.match(host.byClass('fin-note')[0].textContent, /No se pudo/);
  M.render(host, null);
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
  const real = new Node('section');
  M.render(real, M.view(M.modelFromFrame({ ...frame(), fake: false })));
  assert.equal(real.byClass('fin-fake').length, 0);
});

test('mount is wired: guarded on its container, trusted clicks only, FAKE provider only; packaged', () => {
  assert.match(SRC, /getElementById\('integrations-finance'\)/);
  assert.match(SRC, /if \(!host\) return/);
  assert.match(SRC, /isTrusted !== true/);
  assert.match(SRC, /fakeFrame\(\)/);
  const lib = fs.readFileSync(path.join(__dirname, '..', 'packaging', 'lib.cjs'), 'utf8');
  assert.match(lib, /'integrations-finance\.js'/);
});

console.log(`integrations-finance-check: ${passed} checks ok`);

'use strict';
/* K2-13 T6b-1 «Hoy»: the island's day (S2/S3/S5/S13/S17/S19). The PURE view model only — no DOM, no host.
   Run: node test-node/hoy-view-check.cjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const N = require(path.join(__dirname, '..', 'frontend', 'island-nusa.js'));
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };
const NOW = Date.parse('2026-11-06T12:00:00');
const A = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b';
const B = '11111111-2222-4333-8444-555555555555';
const C = '99999999-8888-4777-8666-555555555555';

// the folded view the Rust client hands the page (agentclient.rs `hoy`)
const proposal = (id, over = {}) => ({ id, minikoda: 'valmar', kind: 'proposal', status: 'pending', text: 'el balance sale el jueves y el precio está 8 % abajo', action: 'buy', target: '10 CEDEARs de YPF', createdAt: '2026-11-06T09:12:00', ...over });
const result = (id, over = {}) => ({ id, minikoda: 'valmar', kind: 'result', status: 'approved', text: 'Ve margen en bonos CER y avisa que el balance de YPF sale el jueves.', createdAt: '2026-11-06T09:30:00', ...over });
const error = (id, over = {}) => ({ id, minikoda: 'valmar', kind: 'error', status: 'approved', text: 'La corrida de «Valmar» falló (crash). 2 propuesta(s) de esa corrida quedaron pendientes en «Hoy».', createdAt: '2026-11-06T08:00:00', ...over });
const view = items => ({ items, truncated: false });

test('three tabs, the ones the human chose: Propuestas · Resultados · Errores', () => {
  assert.deepEqual(N.HOY_TABS.map(t => t.id), ['propuestas', 'resultados', 'errores']);
  assert.deepEqual(N.HOY_TABS.map(t => t.title), ['Propuestas', 'Resultados', 'Errores']);
});

test('counts: Propuestas counts what waits, not what happened', () => {
  const c = N.hoyCounts(view([proposal(A), proposal(B, { status: 'approved', decidedAt: '2026-11-06T09:46:00' }), result(C)]));
  assert.equal(c.pending, 1);
  assert.equal(c.propuestas, 1);
  assert.equal(c.resultados, 1);
  assert.equal(c.errores, 0);
  assert.equal(c.truncated, false);
  assert.deepEqual(N.hoyCounts(null), { pending: 0, propuestas: 0, resultados: 0, errores: 0, truncated: false }, 'no view: zero, never a guess');
  assert.equal(N.hoyCounts({ items: [], truncated: true }).truncated, true, 'the daemon cut the list');
});

test('the opening tab follows what waits: pending first, else Results', () => {
  assert.equal(N.hoyTab(N.hoyCounts(view([proposal(A)])), null), 'propuestas');
  assert.equal(N.hoyTab(N.hoyCounts(view([result(A)])), null), 'resultados');
  assert.equal(N.hoyTab(N.hoyCounts(view([])), null), 'resultados');
  assert.equal(N.hoyTab(N.hoyCounts(view([error(A)])), null), 'resultados', 'an error alone does not open on Propuestas');
  assert.equal(N.hoyTab(N.hoyCounts(view([proposal(A)])), 'errores'), 'errores', 'the human\'s tab is kept while it exists');
  assert.equal(N.hoyTab(N.hoyCounts(view([result(A)])), 'nope'), 'resultados', 'an unknown tab never sticks');
});

test('a proposal row: what + from where, its action in Spanish, and its buttons', () => {
  const rows = N.hoyRows(view([proposal(A)]), NOW);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.tab, 'propuestas');
  assert.equal(r.pending, true);
  assert.match(r.title, /^Comprar 10 CEDEARs de YPF$/);
  assert.match(r.sub, /^valmar · 09:12 · el balance sale el jueves/);
  assert.equal(r.actions, true, 'a pending proposal offers Aprobar / Rechazar');
  assert.equal(r.state, '', 'nothing was decided yet');
  assert.match(r.approve, /Aprobar: Comprar 10 CEDEARs de YPF/);
  assert.match(r.reject, /Rechazar: Comprar 10 CEDEARs de YPF/);
});

test('the action label is the closed Spanish set, never the wire word', () => {
  const label = action => N.hoyRows(view([proposal(A, { action, target: 'algo' })]), NOW)[0].title;
  assert.equal(label('buy'), 'Comprar algo');
  assert.equal(label('sell'), 'Vender algo');
  assert.equal(label('send'), 'Enviar algo');
  // the client never lets an unknown action through (agentclient.rs drops the row); this is the page's own guard: it names
  // no verb it was not given, rather than guessing «Comprar»
  assert.equal(label('delete'), 'Propuesta: algo', 'an unknown action is never turned into a verb');
});

test('an answered proposal shows its word, keeps its row and offers nothing to press', () => {
  const [ok] = N.hoyRows(view([proposal(A, { status: 'approved', decidedAt: '2026-11-06T09:46:00' })]), NOW);
  assert.equal(ok.pending, false);
  assert.equal(ok.actions, false);
  assert.match(ok.state, /^Aprobada · se ejecutó · 09:46$/);
  const [no] = N.hoyRows(view([proposal(B, { status: 'rejected', decidedAt: '2026-11-06T09:47:00' })]), NOW);
  assert.equal(no.actions, false);
  assert.match(no.state, /^Rechazada · no se hizo nada$/);
});

test('a result row reads without pressing anything and never offers an approval', () => {
  const [r] = N.hoyRows(view([result(A)]), NOW);
  assert.equal(r.tab, 'resultados');
  assert.equal(r.actions, false, 'only a proposal executes');
  assert.equal(r.state, '');
  assert.equal(r.title, 'valmar · 09:30');
  assert.match(r.sub, /^Ve margen en bonos CER/);
  assert.equal(r.chip, '', 'no provenance in the frame: no chip, never an invented one');
});

test('the provenance chip appears only when the item carries it (S19)', () => {
  const sub = prov => N.hoyRows(view([result(A, { provenance: prov })]), NOW)[0].chip;
  assert.equal(sub('youtube_subtitles'), 'subtítulos de YouTube');
  assert.equal(sub('local_transcription'), 'transcripto en esta PC');
  assert.equal(sub('downloaded_somewhere'), '', 'an unknown provenance is not shown');
  assert.equal(sub(undefined), '');
});

test('an error row says what failed and what was kept (S13)', () => {
  const [e] = N.hoyRows(view([error(A)]), NOW);
  assert.equal(e.tab, 'errores');
  assert.equal(e.actions, false, 'an error is read, it is never approved');
  assert.match(e.title, /^La corrida de «Valmar» falló \(crash\)\.$/);
  assert.match(e.sub, /2 propuesta\(s\) de esa corrida quedaron pendientes en «Hoy»/);
  assert.equal(N.hoyRows(view([error(A)]), NOW)[0].full.length > 40, true, 'the whole sentence is available to the row');
});

test('item text is untrusted: control and bidi characters never reach the page', () => {
  const nasty = `comprar\u0000\u202e YPF\u200b\u0007 ${'a'.repeat(400)}`;
  const [r] = N.hoyRows(view([proposal(A, { target: nasty, text: nasty })]), NOW);
  const all = `${r.title} ${r.sub} ${r.full}`;
  for (const bad of ['\u0000', '\u202e', '\u200b', '\u0007']) assert.ok(!all.includes(bad), `bidi/control ${JSON.stringify(bad)} must not reach the DOM`);
  assert.ok(Array.from(r.title).length <= 140, 'titles are capped');
  assert.ok(Array.from(r.sub).length <= 220, 'subs are capped');
});

test('rows keep the daemon order and only its own tab, and a hostile item is skipped', () => {
  const v = view([proposal(A), { id: B, kind: 'notice', status: 'pending' }, result(C)]);
  const rows = N.hoyRows(v, NOW);
  assert.deepEqual(rows.map(r => r.tab), ['propuestas', 'resultados'], 'unknown kinds are dropped, order kept');
  assert.deepEqual(N.hoyRows(null, NOW), []);
  assert.deepEqual(N.hoyRows({ items: 'x' }, NOW), []);
});

test('times: today is a clock, yesterday says so, older says the day', () => {
  const time = iso => { const t = N.hoyRows(view([result(A, { createdAt: iso })]), NOW)[0].title.split(' · ')[1]; return t === undefined ? '' : t; };
  assert.equal(time('2026-11-06T09:30:00'), '09:30');
  assert.equal(time('2026-11-05T22:10:00'), 'ayer');
  assert.equal(time('2026-10-30T10:00:00'), '30 oct');
  assert.equal(time('not a date'), '', 'an unreadable stamp is blank, never NaN');
});

test('an empty tab says what belongs there, in plain words', () => {
  assert.match(N.hoyEmpty('propuestas'), /Nada espera tu sí/i);
  assert.match(N.hoyEmpty('resultados'), /Todavía no hay resultados/i);
  assert.match(N.hoyEmpty('errores'), /Ningún aviso/i);
  assert.equal(N.hoyEmpty('otra'), 'Nada en esta pestaña.');
});

test('the header line counts what waits; the count agrees with the badge', () => {
  assert.equal(N.hoySummary(N.hoyCounts(view([proposal(A), result(B)]))), '1 espera tu sí · 1 resultado');
  assert.equal(N.hoySummary(N.hoyCounts(view([proposal(A), proposal(B), result(C), result(C)]))), '2 esperan tu sí · 2 resultados');
  assert.equal(N.hoySummary(N.hoyCounts(view([result(A)]))), 'Nada espera tu sí · 1 resultado');
});

test('a refusal is read by its closed code, never by free text', () => {
  assert.match(N.hoyRefusal('not_pending'), /ya no espera tu respuesta/);
  assert.match(N.hoyRefusal('unknown_item'), /ya no tiene esa propuesta/);
  assert.match(N.hoyRefusal('paused'), /pausa/);
  assert.match(N.hoyRefusal('failed'), /no pudo registrar/);
  assert.equal(N.hoyRefusal('sudo rm -rf /'), N.hoyRefusal('failed'), 'an unknown code says exactly what a failure says');
  assert.equal(typeof N.hoyRefusal(null), 'string');
});

test('the tabs answer ArrowLeft / ArrowRight / Home / End (roving focus), and nothing while typing', () => {
  const ev = key => ({ key, isTrusted: true });
  assert.equal(N.hoyTabKey(ev('ArrowRight'), 0), 1);
  assert.equal(N.hoyTabKey(ev('ArrowRight'), 2), 2, 'no wrap past the last tab');
  assert.equal(N.hoyTabKey(ev('ArrowLeft'), 1), 0);
  assert.equal(N.hoyTabKey(ev('ArrowLeft'), 0), 0);
  assert.equal(N.hoyTabKey(ev('Home'), 2), 0);
  assert.equal(N.hoyTabKey(ev('End'), 0), 2);
  for (const k of ['a', 'Enter', 'Tab', 'Escape']) assert.equal(N.hoyTabKey(ev(k), 1), null, k);
  assert.equal(N.hoyTabKey({ key: 'ArrowRight', isTrusted: false }, 0), null, 'never a synthetic event');
  assert.equal(N.hoyTabKey({ key: 'ArrowRight', isTrusted: true, metaKey: true }, 0), null, 'never with a modifier');
});

// ---- a decision in flight: the daemon's later state decides it, never the click (verifier mwdtsadz B1/B2) ----
test('a decision waits for the daemon: the command reply is the state BEFORE it', () => {
  const before = view([proposal(A)]);
  assert.equal(typeof N.hoyDecision, 'function', 'the model owns the judgement');
  assert.equal(N.HOY_WAIT_MS, 3000, 'the deadline is ~3 s');
  for (const stale of [undefined, null, {}, { hoy: before }, { hoy: before, last_error: { code: null, n: 0 } }]) {
    assert.deepEqual(N.hoyDecision(0, stale, A, 'approved'), { state: 'waiting' }, `the write-time reply never decides: ${JSON.stringify(stale)}`);
  }
});

test('the daemon shows the decision: that is the success, and nothing else is', () => {
  const after = view([proposal(A, { status: 'approved', decidedAt: '2026-11-06T09:46:00' })]);
  assert.deepEqual(N.hoyDecision(0, { hoy: after, last_error: { code: null, n: 0 } }, A, 'approved'), { state: 'ok' });
  // a still pending row is not an outcome, however many frames say so
  assert.deepEqual(N.hoyDecision(0, { hoy: view([proposal(A)]), last_error: { code: null, n: 0 } }, A, 'approved'), { state: 'waiting' });
  // the wrong status is not the wanted one either
  const rejected = view([proposal(A, { status: 'rejected' })]);
  assert.deepEqual(N.hoyDecision(0, { hoy: rejected, last_error: { code: null, n: 0 } }, A, 'approved'), { state: 'waiting' });
});

test('a refusal is the daemon\'s own closed code, recognised by its counter', () => {
  const still = view([proposal(A)]);
  assert.deepEqual(N.hoyDecision(4, { hoy: still, last_error: { code: 'not_pending', n: 5 } }, A, 'approved'), { state: 'refused', code: 'not_pending' });
  assert.deepEqual(N.hoyDecision(4, { hoy: still, last_error: { code: 'unavailable', n: 5 } }, A, 'approved'), { state: 'refused', code: 'unavailable' });
  // the SAME error that was already there when the command left is not this decision's answer
  assert.deepEqual(N.hoyDecision(5, { hoy: still, last_error: { code: 'not_pending', n: 5 } }, A, 'approved'), { state: 'waiting' });
  assert.deepEqual(N.hoyDecision(0, { hoy: still, last_error: { code: 'sudo rm -rf /', n: 1 } }, A, 'approved'), { state: 'refused', code: 'sudo rm -rf /' }, 'an unknown code is still a refusal; the refusal text maps it to `failed`');
  assert.match(N.hoyRefusal('sudo rm -rf /'), /no pudo registrar/);
});

test('a read the daemon could not answer is said, never rendered as a stale day (F5)', () => {
  assert.equal(N.hoyReadProblem(0, { connection: 'connected', hoy: view([proposal(A)]) }), '');
  assert.equal(N.hoyReadProblem(2, { connection: 'connected', hoy: view([]), last_error: { code: null, n: 2 } }), '', 'the error that was already there is not this read');
  assert.match(N.hoyReadProblem(0, { connection: 'no_daemon' }), /no está disponible/);
  assert.match(N.hoyReadProblem(0, { connection: 'lost' }), /no está disponible/);
  assert.match(N.hoyReadProblem(0, { connection: 'connected', last_error: { code: 'unavailable', n: 1 } }), /no está disponible/);
  assert.match(N.hoyReadProblem(0, null), /no está disponible/, 'no answer at all is «unavailable», never silence');
  assert.equal(N.hoyReadProblem(0, { connection: 'connected' }), '', 'a connected answer with no day yet is not a problem');
});

test('rows never move under the cursor: a decided row keeps its place while the panel is open', () => {
  assert.equal(typeof N.hoyOrder, 'function');
  const rows = list => list.map(id => ({ id }));
  // the daemon re-sorts pending-first after a decision: the page keeps its own first-seen order
  assert.deepEqual(N.hoyOrder([A, B, C], rows([B, A, C])).map(r => r.id), [A, B, C]);
  // a new pending proposal arrives: it goes after what was already on screen (nothing shifts)
  assert.deepEqual(N.hoyOrder([A, B], rows([C, A, B])).map(r => r.id), [A, B, C]);
  // a row that disappeared is simply gone, and no-remember-order is the daemon order
  assert.deepEqual(N.hoyOrder([A, B], rows([B])).map(r => r.id), [B]);
  assert.deepEqual(N.hoyOrder([], rows([B, A])).map(r => r.id), [B, A]);
  assert.deepEqual(N.hoyOrder(null, null), []);
});

test('clicks are ignored for a moment after a repaint moved rows', () => {
  assert.equal(N.HOY_CLICK_GUARD_MS, 400);
  assert.equal(typeof N.hoyGuardOpen, 'function');
  assert.equal(N.hoyGuardOpen(1000, 1000), false, 'the instant it moved: refused');
  assert.equal(N.hoyGuardOpen(1000, 1399), false);
  assert.equal(N.hoyGuardOpen(1000, 1400), true);
  assert.equal(N.hoyGuardOpen(0, 5), true, 'nothing moved yet: nothing to guard');
});

console.log(`hoy-view-check: ${passed} passed`);

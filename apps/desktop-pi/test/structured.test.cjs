'use strict';
// Structured questions on the Pi producer: multiSelect, questionnaire (one frame, one answer), larger limits,
// negotiated with `structured:1` at level 3. Levels 0-2 and every old frame are unchanged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { QuestionBroker, normalizeRequest } = require('../questions.cjs');
const { resolveQuestionConfig } = require('../config.cjs');
const { registerAdapter } = require('../adapter.cjs');
const { fakeReceiver, harness } = require('./fake-receiver.cjs');

const opt = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ value: `v${i + 1}`, label: `Opción ${i + 1}`, description: '', ...extra }));
const item = (header, over = {}) => ({ header, text: `¿${header}?`, options: opt(3), multiSelect: false, allowFreeText: false, ...over });
const T = 30000;

function fixture(structured = true) {
  let now = 1000000, expire;
  const sent = [], scope = { project: 'a'.repeat(64), sessionId: 'unit-session' };
  const broker = new QuestionBroker({ available: () => true, scope: () => scope, isCurrent: () => true, structured: () => structured,
    clock: { now: () => now, setTimer: fn => { expire = fn; return 1; }, clearTimer: () => {} },
    send: (type, extra, at = now) => { sent.push({ v: 1, ...scope, at, type, ...extra }); return true; } });
  const reply = (q, answer) => ({ v: 1, ...scope, at: now, type: 'answer', questionVersion: 1, id: q.id, source: 'human', answer });
  return { broker, sent, reply, scope };
}

test('config: level 3 is accepted (QP/1 + busyReason + structured); other values stay invalid', () => {
  assert.equal(resolveQuestionConfig({ ABITO_QUESTIONS: '3' }).questionLevel, 3);
  for (const value of ['4', '03', '-1', 'true', '']) assert.throws(() => resolveQuestionConfig({ ABITO_QUESTIONS: value }), value);
});

test('normalizeRequest: legacy limits and keys are unchanged without the capability', () => {
  const ok = { kind: 'question', text: 't'.repeat(500), options: opt(2), allowFreeText: false, timeoutMs: T };
  assert.doesNotThrow(() => normalizeRequest(ok));
  assert.throws(() => normalizeRequest({ ...ok, text: 't'.repeat(501) }));
  assert.throws(() => normalizeRequest({ ...ok, multiSelect: true }), /Invalid request/);
  assert.throws(() => normalizeRequest({ ...ok, questions: [item('A')] }), /Invalid request/);
});

test('normalizeRequest structured: limits at the boundary, multiSelect and questionnaire shapes', () => {
  const S = (r) => normalizeRequest({ kind: 'question', allowFreeText: false, timeoutMs: T, ...r }, T, true);
  assert.doesNotThrow(() => S({ text: 't'.repeat(2000), options: opt(2) }));
  assert.throws(() => S({ text: 't'.repeat(2001), options: opt(2) }));
  assert.doesNotThrow(() => S({ text: 'x', options: opt(2, { label: 'l'.repeat(120), description: 'd'.repeat(400) }) }));
  assert.throws(() => S({ text: 'x', options: opt(2, { label: 'l'.repeat(121) }) }));
  assert.throws(() => S({ text: 'x', options: opt(2, { description: 'd'.repeat(401) }) }));
  assert.equal(S({ text: 'x', options: opt(3), multiSelect: true }).multiSelect, true);
  assert.throws(() => S({ text: 'x', options: opt(1), multiSelect: true }));
  assert.throws(() => S({ kind: 'approval', text: 'x', options: opt(2), multiSelect: true }));
  assert.throws(() => S({ text: 'x', options: opt(3), multiSelect: 'yes' }));
  const form = qs => S({ text: 'Cuestionario', options: [], questions: qs });
  assert.equal(form([item('A'), item('B', { multiSelect: true, allowFreeText: true })]).questions.length, 2);
  assert.throws(() => form([])); assert.throws(() => form(Array.from({ length: 5 }, (_, i) => item(`P${i}`))));
  assert.throws(() => form([item('x'.repeat(33))])); assert.doesNotThrow(() => form([item('x'.repeat(32))]));
  assert.throws(() => form([item('A', { options: opt(1) })])); assert.throws(() => form([item('A', { options: opt(5) })]));
  assert.throws(() => form([{ ...item('A'), extra: 1 }])); assert.throws(() => form([item('')]));
  assert.throws(() => S({ text: 'x', options: opt(2), questions: [item('A')] }), /Invalid request/, 'options belong to the items');
  assert.throws(() => S({ text: 'x', options: [], allowFreeText: true, questions: [item('A')] }));
});

test('the frame carries the structured fields only when used, and is bounded by 16384 bytes', () => {
  let f = fixture(); f.broker.ask({ kind: 'question', text: 'x', options: opt(3), multiSelect: true }, {});
  assert.equal(f.sent[0].multiSelect, true);
  f = fixture(); f.broker.ask({ kind: 'question', text: 'x', options: opt(2) }, {});
  assert.equal('multiSelect' in f.sent[0], false); assert.equal('questions' in f.sent[0], false);
  f = fixture(); f.broker.ask({ kind: 'question', text: 'Q', options: [], questions: [item('A'), item('B')] }, {});
  assert.equal(f.sent[0].questions.length, 2); assert.deepEqual(f.sent[0].options, []);
  // structured request without the negotiated capability: refused before any write
  f = fixture(false);
  return f.broker.ask({ kind: 'question', text: 'x', options: opt(3), multiSelect: true }, {}).then(r => {
    assert.equal(r.status, 'invalid_request'); assert.equal(f.sent.length, 0);
    const fat = fixture(); const big = Array.from({ length: 4 }, (_, i) => item(`P${i}`, { text: '🙂'.repeat(2000), options: opt(4, { label: '🙂'.repeat(120), description: '🙂'.repeat(400) }) }));
    return fat.broker.ask({ kind: 'question', text: 'Q', options: [], questions: big }, {}).then(r2 => { assert.equal(r2.status, 'invalid_request'); assert.equal(fat.sent.length, 0); });
  });
});

test('multiSelect answers: offered values, no duplicates, canonical shape; anything else is rejected and nothing is consumed', async () => {
  for (const bad of [
    { type: 'options', values: [] }, { type: 'options', values: ['v1', 'v1'] }, { type: 'options', values: ['nope'] },
    { type: 'options', values: 'v1' }, { type: 'options', values: ['v1', 'v2', 'v3', 'v4', 'v1'] },
    { type: 'option', value: 'v1' }, { type: 'text', text: 'x' }, { type: 'options', values: ['v1'], text: 'x' }, { type: 'options', values: ['v1'], extra: 1 },
  ]) {
    const f = fixture(); const result = f.broker.ask({ kind: 'question', text: 'x', options: opt(3), multiSelect: true }, {}); const q = f.sent[0];
    f.broker.receive(f.reply(q, bad));
    assert.equal(f.broker.live === null, true, 'a malformed answer ends the call as a protocol error, never as an answer');
    assert.notEqual((await result).status, 'answered', JSON.stringify(bad));
  }
  const f = fixture(); const result = f.broker.ask({ kind: 'question', text: 'x', options: opt(3), multiSelect: true }, {}); const q = f.sent[0];
  f.broker.receive(f.reply(q, { type: 'options', values: ['v3', 'v1'] }));
  assert.deepEqual((await result).answer, { type: 'options', values: ['v3', 'v1'] });
  const g = fixture(); const r2 = g.broker.ask({ kind: 'question', text: 'x', options: opt(3), multiSelect: true, allowFreeText: true }, {});
  g.broker.receive(g.reply(g.sent[0], { type: 'options', values: [], text: 'otra' }));
  assert.deepEqual((await r2).answer, { type: 'options', values: [], text: 'otra' });
});

test('questionnaire answers are all-or-nothing: one entry per question, each valid for its own question', async () => {
  const qs = () => [item('Ruta'), item('Extras', { multiSelect: true, allowFreeText: true }), item('Libre', { allowFreeText: true })];
  const good = [{ type: 'option', value: 'v2' }, { type: 'options', values: ['v1', 'v3'], text: 'más' }, { type: 'text', text: 'libre' }];
  const run = async answers => {
    const f = fixture(); const result = f.broker.ask({ kind: 'question', text: 'Q', options: [], questions: qs() }, {});
    f.broker.receive(f.reply(f.sent[0], { type: 'form', answers })); return result;
  };
  assert.deepEqual((await run(good)).answer, { type: 'form', answers: good });
  const swap = (i, v) => good.map((a, j) => (j === i ? v : a));
  for (const bad of [good.slice(0, 2), [...good, good[0]], [], swap(0, { type: 'option', value: 'zz' }), swap(0, { type: 'text', text: 'x' }),
    swap(1, { type: 'option', value: 'v1' }), swap(1, { type: 'options', values: [] }), swap(2, { type: 'options', values: ['v1'] }), swap(2, { type: 'option', value: 'q' })]) {
    assert.notEqual((await run(bad)).status, 'answered', JSON.stringify(bad));
  }
  const f = fixture(); const result = f.broker.ask({ kind: 'question', text: 'Q', options: [], questions: [item('A')] }, {});
  f.broker.receive(f.reply(f.sent[0], { type: 'option', value: 'v1' }));
  assert.notEqual((await result).status, 'answered', 'a questionnaire takes a form answer only');
});

test('free text limit: 2000 legacy, 4000 structured', async () => {
  let f = fixture(false); let r = f.broker.ask({ kind: 'question', text: 'x', options: [], allowFreeText: true }, {});
  f.broker.receive(f.reply(f.sent[0], { type: 'text', text: 'a'.repeat(2001) })); assert.notEqual((await r).status, 'answered');
  f = fixture(true); r = f.broker.ask({ kind: 'question', text: 'x', options: [], allowFreeText: true }, {});
  f.broker.receive(f.reply(f.sent[0], { type: 'text', text: 'a'.repeat(4000) })); assert.equal((await r).status, 'answered');
  f = fixture(true); r = f.broker.ask({ kind: 'question', text: 'x', options: [], allowFreeText: true }, {});
  f.broker.receive(f.reply(f.sent[0], { type: 'text', text: 'a'.repeat(4001) })); assert.notEqual((await r).status, 'answered');
});

test('adapter level 3 negotiates busyReason + structured; level 2 keeps the exact old handshake', async t => {
  const receiver = await fakeReceiver(t, { questions: true, busyReason: true, structured: true });
  const h = harness(registerAdapter, { ...receiver, questionLevel: 3 });
  t.after(() => h.handlers.get('session_shutdown')());
  const hello = receiver.next('questions_hello'); h.handlers.get('session_start')({}, h.ctx);
  const frame = await hello;
  assert.equal(frame.busyReason, 1); assert.equal(frame.structured, 1);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(h.controller.canAsk(), true); assert.equal(h.controller.structured(), true);
  const old = await fakeReceiver(t, { questions: true, busyReason: true });
  const h2 = harness(registerAdapter, { ...old, questionLevel: 2 });
  t.after(() => h2.handlers.get('session_shutdown')());
  const hello2 = old.next('questions_hello'); h2.handlers.get('session_start')({}, h2.ctx);
  assert.equal('structured' in await hello2, false);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(h2.controller.structured(), false);
});

test('a receiver that answers a level-3 hello without structured is a protocol error: no silent downgrade', async t => {
  const receiver = await fakeReceiver(t, { questions: true, busyReason: true }); // never says structured
  const errors = [];
  const h = harness(registerAdapter, { ...receiver, questionLevel: 3, onTransportError: e => errors.push(e) });
  t.after(() => h.handlers.get('session_shutdown')());
  h.handlers.get('session_start')({}, h.ctx);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(h.controller.canAsk(), false); assert.equal(h.controller.structured(), false);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerAdapter } = require('../adapter.cjs');
const { resolveQuestionConfig } = require('../config.cjs');
const { fakeReceiver, harness } = require('./fake-receiver.cjs');
const input = { kind: 'question', text: 'Which route?', options: [
  { value: 'a', label: 'A', description: '' }, { value: 'b', label: 'B', description: '' }] };
async function setup(t, questionLevel = 2) {
  const receiver = await fakeReceiver(t, { questions: true, busyReason: true });
  const h = harness(registerAdapter, { ...receiver, questionLevel });
  t.after(() => h.handlers.get('session_shutdown')());
  h.handlers.get('session_start')({}, h.ctx); await receiver.next('heartbeat');
  return { ...h, receiver };
}
const close = (q, extra = {}) => ({ v: 1, type: 'question_closed', questionVersion: 1,
  project: q.project, sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'system', reason: 'busy', ...extra });

test('single config level enables capabilities; other values invalid', () => {
  assert.equal(resolveQuestionConfig({ ABITO_QUESTIONS: '2' }).questionLevel, 2);
  for (const value of ['4', '01', '-1', 'true', '']) assert.throws(() => resolveQuestionConfig({ ABITO_QUESTIONS: value }));
});
test('level2 negotiated reason returns immediately as busy with no answer', async t => {
  for (const reasonCode of ['native_transition_busy', 'native_transition_degraded']) {
    const { receiver, controller, ctx } = await setup(t);
    assert.equal(receiver.frames.find(f => f.type === 'questions_hello').busyReason, 1);
    const frame = receiver.next('question'); const result = controller.ask(input, ctx); const q = await frame;
    receiver.replyBusy(q, reasonCode);
    assert.deepEqual(await result, { status: 'busy', id: q.id, reasonCode });
  }
});
test('level1 declaration and busy reply keep exact previous bytes with advanced receiver', async t => {
  const { receiver, controller, ctx } = await setup(t, 1);
  const hello = receiver.frames.find(f => f.type === 'questions_hello');
  const i = receiver.frames.indexOf(hello);
  assert.equal(receiver.rawFrames[i], JSON.stringify({ v: 1, type: 'questions_hello',
    project: hello.project, sessionId: hello.sessionId, at: hello.at, questionVersion: 1 }) + '\n');
  const frame = receiver.next('question'); const result = controller.ask(input, ctx); const q = await frame;
  const [rawBusy] = receiver.replyBusy(q, 'native_transition_busy');
  const parsed = JSON.parse(rawBusy);
  assert.equal(rawBusy, JSON.stringify({ v: 1, type: 'question_closed', questionVersion: 1,
    project: q.project, sessionId: q.sessionId, at: parsed.at, id: q.id, source: 'system', reason: 'busy' }) + '\n');
  assert.deepEqual(await result, { status: 'busy', id: q.id });
});
test('level2 against minimal receiver fails explicitly without downgrade', { timeout: 2000 }, async t => {
  const receiver = await fakeReceiver(t, { questions: true });
  let report;
  const failed = new Promise(resolve => { report = resolve; });
  const { controller, handlers, ctx } = harness(registerAdapter, { ...receiver, questionLevel: 2, onTransportError: report });
  t.after(() => handlers.get('session_shutdown')());
  handlers.get('session_start')({}, ctx);
  await failed;
  assert.deepEqual(await controller.ask(input, ctx), { status: 'unsupported_receiver', runtime: receiver.runtime });
  assert.equal(receiver.frames.filter(f => f.type === 'questions_hello').length, 1);
});
test('invalid combinations and unnegotiated detail fail live tool immediately, visibly, never by deadline', { timeout: 2000 }, async t => {
  const { receiver, controller, ctx } = await setup(t);
  const cases = [
    { busyReason: 'other' }, { busyReason: null },
    { busyReason: 'native_transition_busy', reason: 'cancelled' },
    { busyReason: 'native_transition_busy', source: 'human' },
    { busyReason: 'native_transition_busy', extra: true },
  ];
  for (const extra of cases) {
    const frame = receiver.next('question'); const result = controller.ask(input, ctx); const q = await frame;
    const rejected = receiver.next('question_answer_rejected'); receiver.send(close(q, extra));
    assert.equal((await rejected).reason, 'invalid_answer');
    assert.deepEqual(await result, { status: 'protocol_error', id: q.id, reasonCode: 'invalid_answer' });
  }
  const level1 = await setup(t, 1);
  const frame = level1.receiver.next('question'); const result = level1.controller.ask(input, level1.ctx); const q = await frame;
  const rejected = level1.receiver.next('question_answer_rejected');
  level1.receiver.send(close(q, { busyReason: 'native_transition_busy' })); await rejected;
  assert.equal((await result).status, 'protocol_error');
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerAdapter } = require('../adapter.cjs');
const { fakeReceiver, harness } = require('./fake-receiver.cjs');
const input = { kind: 'question', text: 'Which route?', options: [
  { value: 'a', label: 'Route A', description: 'First route' },
  { value: 'b', label: 'Route B', description: 'Second route' }], allowFreeText: true, timeoutMs: 30000 };
async function setup(t, questions = true, extra = {}) {
  const receiver = await fakeReceiver(t, { questions });
  const h = harness(registerAdapter, { ...receiver, questionLevel: questions ? 1 : 0, ...extra });
  t.after(() => h.handlers.get('session_shutdown')());
  h.handlers.get('session_start')({}, h.ctx);
  await receiver.next('heartbeat');
  return { ...h, receiver };
}
const answer = (q, value = 'b') => ({ v: 1, type: 'answer', questionVersion: 1,
  project: q.project, sessionId: q.sessionId, at: Date.now(), id: q.id,
  source: 'human', answer: { type: 'option', value } });

test('awaited question returns exactly the selected human token once; duplicates rejected', async t => {
  const { receiver, controller, ctx } = await setup(t);
  const frame = receiver.next('question');
  const result = controller.ask(input, ctx);
  const q = await frame;
  assert.equal(q.kind, 'question'); assert.equal(q.questionVersion, 1);
  assert.equal(q.expiresAt - q.at, input.timeoutMs);
  const busy = await controller.ask(input, ctx);
  assert.equal(busy.status, 'busy');
  receiver.send(answer(q));
  assert.deepEqual(await result, { status: 'answered', id: q.id, answer: { type: 'option', value: 'b' } });
  const rejected = receiver.next('question_answer_rejected');
  receiver.send(answer(q, 'a'));
  assert.equal((await rejected).reason, 'not_live');
  assert.equal(receiver.frames.filter(f => f.type === 'question').length, 1);
});

test('legacy ready has no capability: no question emitted, notices stay alive', async t => {
  const { receiver, controller, ctx, handlers } = await setup(t, false);
  assert.equal((await controller.ask(input, ctx)).status, 'unavailable');
  const settled = receiver.next('settled');
  handlers.get('agent_settled')({}, ctx);
  await settled;
  assert.equal(receiver.frames.some(f => f.type === 'question'), false);
});

test('deadline expires without choosing a default; late response visibly rejected', async t => {
  let now = Date.now(), expire;
  const { receiver, controller, ctx } = await setup(t, true, { questionClock: {
    now: () => now, setTimer: fn => { expire = fn; return 1; }, clearTimer: () => {} } });
  const frame = receiver.next('question');
  const result = controller.ask(input, ctx);
  const q = await frame;
  const closed = receiver.next('question_cancel');
  now = q.expiresAt; expire();
  assert.deepEqual(await result, { status: 'expired', id: q.id });
  assert.equal((await closed).reason, 'expired');
  const rejected = receiver.next('question_answer_rejected'); receiver.send(answer(q));
  assert.equal((await rejected).reason, 'not_live');
});

test('abort cancels, next question has new id, stale first answer cannot decide it', async t => {
  const { receiver, controller, ctx } = await setup(t);
  const abort = new AbortController();
  let frame = receiver.next('question');
  const first = controller.ask(input, ctx, abort.signal); const q1 = await frame;
  const cancel = receiver.next('question_cancel'); abort.abort();
  assert.deepEqual(await first, { status: 'cancelled', id: q1.id }); await cancel;
  frame = receiver.next('question'); const second = controller.ask(input, ctx); const q2 = await frame;
  assert.notEqual(q1.id, q2.id);
  const rejected = receiver.next('question_answer_rejected'); receiver.send(answer(q1)); await rejected;
  receiver.send({ ...answer(q2), answer: { type: 'text', text: 'A different route' } });
  assert.deepEqual((await second).answer, { type: 'text', text: 'A different route' });
});

test('invalid option, foreign session and automated source cannot decide; human denial can', async t => {
  const { receiver, controller, ctx } = await setup(t);
  for (const mutate of [q => answer(q, 'unknown'), q => ({ ...answer(q), sessionId: 'other' }),
    q => ({ ...answer(q), source: 'timer' }), q => ({ ...answer(q), answer: { type: 'text', text: 'yes' } })]) {
    const frame = receiver.next('question');
    const result = controller.ask({ ...input, kind: 'approval', allowFreeText: false }, ctx); const q = await frame;
    const rejected = receiver.next('question_answer_rejected'); receiver.send(mutate(q)); await rejected;
    assert.equal((await result).status, 'protocol_error');
  }
  const frame = receiver.next('question');
  const result = controller.ask({ ...input, kind: 'approval', allowFreeText: false }, ctx); const q = await frame;
  receiver.send(answer(q, 'a'));
  assert.deepEqual((await result).answer, { type: 'option', value: 'a' });
  assert.equal((await controller.ask({ ...input, kind: 'approval' }, ctx)).status, 'invalid_request');
});

test('shutdown, turn end and disconnect close unanswered questions; session replacement cannot receive', async t => {
  for (const reason of ['session_shutdown', 'agent_end', 'disconnect', 'session_start']) {
    const { receiver, controller, ctx, handlers } = await setup(t);
    const frame = receiver.next('question'); const result = controller.ask(input, ctx); await frame;
    if (reason === 'disconnect') for (const c of receiver.clients) c.destroy();
    else handlers.get(reason)({}, ctx);
    const value = await result;
    assert.notEqual(value.status, 'answered'); assert.equal(value.answer, undefined);
  }
});

test('answer stamped a few ms off this process clock (cross-process skew) is accepted; beyond the tolerance it is rejected', async t => {
  for (const [name, at, status] of [['behind', q => q.at - 20, 'answered'], ['ahead', () => Date.now() + 200, 'answered'],
    ['far behind', q => q.at - 5000, 'protocol_error'], ['far ahead', () => Date.now() + 5000, 'protocol_error']]) {
    const { receiver, controller, ctx } = await setup(t);
    const frame = receiver.next('question');
    const result = controller.ask(input, ctx);
    const q = await frame;
    receiver.send({ ...answer(q), at: at(q) });
    assert.equal((await result).status, status, name);
  }
});

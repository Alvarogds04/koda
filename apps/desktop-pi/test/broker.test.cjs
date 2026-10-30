'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { QuestionBroker } = require('../questions.cjs');
const request = { kind: 'approval', text: 'Proceed?', options: [
  { value: 'yes-once', label: 'Yes', description: '' }, { value: 'no', label: 'No', description: '' }] };
function fixture() {
  let now = 1000000, current = true, expire;
  const sent = [], diagnostics = [];
  const scope = { project: 'a'.repeat(64), sessionId: 'unit-session' };
  const broker = new QuestionBroker({ available: () => true, scope: () => scope,
    isCurrent: () => current, clock: { now: () => now, setTimer: fn => { expire = fn; return 1; }, clearTimer: () => {} },
    send: (type, extra, at = now) => { sent.push({ v: 1, ...scope, at, type, ...extra }); return type !== 'question_resolved'; },
    onDiagnostic: d => diagnostics.push(d) });
  const reply = q => ({ v: 1, ...scope, at: now, type: 'answer', questionVersion: 1,
    id: q.id, source: 'human', answer: { type: 'option', value: 'no' } });
  return { broker, sent, diagnostics, reply, expire: () => expire(), advance: ms => { now += ms; },
    changeSession: () => { current = false; } };
}
test('ACK loss never rolls back consumption; exact once even when socket accepted no ACK', async () => {
  const f = fixture(); const result = f.broker.ask(request, {}); const q = f.sent[0];
  f.broker.receive(f.reply(q));
  assert.equal((await result).status, 'answered');
  f.broker.receive(f.reply(q));
  assert.equal(f.sent.filter(s => s.type === 'question_resolved').length, 1);
  assert.equal(f.sent.at(-1).reason, 'not_live');
  assert.equal(f.broker.live, null);
});
test('deadline boundary wins even before delayed timer; foreign context never accepts', async () => {
  const f = fixture(); let result = f.broker.ask(request, {}); let q = f.sent[0];
  f.advance(300000); f.broker.receive(f.reply(q));
  assert.equal((await result).status, 'expired');
  result = f.broker.ask(request, {}); q = f.sent.findLast(s => s.type === 'question');
  f.changeSession(); f.broker.receive(f.reply(q));
  assert.equal((await result).status, 'session_changed');
});
test('human No answer is distinct from system cancel; receiver cannot expire producer early', async () => {
  const f = fixture(); let result = f.broker.ask(request, {}); const q = f.sent[0];
  const close = { ...f.reply(q), type: 'question_closed', reason: 'expired', source: 'system' }; delete close.answer;
  f.broker.receive(close); assert.equal(f.broker.live, null);
  assert.equal((await result).status, 'protocol_error');
  result = f.broker.ask(request, {}); const next = f.sent.findLast(s => s.type === 'question');
  f.broker.receive({ ...close, id: next.id, reason: 'cancelled', source: 'human' });
  assert.deepEqual(await result, { status: 'human_cancelled', id: next.id });
  assert.equal(f.sent.at(-1).type, 'question_resolved');
});
test('S3: a question names Pi and the project when the adapter supplies display fields; absent otherwise', () => {
  const sent = [], scope = { project: 'a'.repeat(64), sessionId: 'unit-session' };
  const mk = display => new QuestionBroker({ available: () => true, scope: () => scope, isCurrent: () => true, display,
    clock: { now: () => 1000000, setTimer: () => 1, clearTimer: () => {} },
    send: (type, extra) => { sent.push({ type, ...extra }); return true; } });
  mk(ctx => ({ agent: 'pi', projectName: ctx.name })).ask(request, { name: 'proyecto-alfa' });
  assert.equal(sent[0].agent, 'pi'); assert.equal(sent[0].projectName, 'proyecto-alfa');
  sent.length = 0; mk(undefined).ask(request, {});
  assert.equal('agent' in sent[0], false); assert.equal('projectName' in sent[0], false);
});

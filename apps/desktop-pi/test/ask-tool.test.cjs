'use strict';
// abito_ask, extended to Claude Code's AskUserQuestion shape: questions[1..4] each with header / options / multiSelect, and a
// top-level multiSelect for one question. Pure mapping + the whole round trip against a fake structured receiver (level 3).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toRequest, runAsk } = require('../ask-tool.cjs');
const { registerAdapter } = require('../adapter.cjs');
const { fakeReceiver, harness } = require('./fake-receiver.cjs');

const label = (l, d) => ({ label: l, ...(d === undefined ? {} : { description: d }) });
const Q = (header, over = {}) => ({ header, question: `¿${header}?`, options: [label('Uno', 'a'), label('Dos', 'b'), label('Tres')], ...over });

// ---- the mapping ------------------------------------------------------------------------------------------------
test('the legacy single question passes through untouched (same keys, same values)', () => {
  const params = { kind: 'question', text: 'Which?', options: [{ value: 'a', label: 'A', description: '' }, { value: 'b', label: 'B', description: 'bee' }], allowFreeText: true, timeoutMs: 60000 };
  assert.deepEqual(toRequest(params), { request: params, shape: 'single' });
  const approval = { kind: 'approval', text: 'Go?', options: [{ value: 'yes', label: 'Yes', description: '' }, { value: 'no', label: 'No', description: '' }] };
  assert.equal(toRequest(approval).shape, 'single');
});

test('multiSelect on one question: options keep their values; the shape is «multi»', () => {
  const params = { kind: 'question', text: 'Extras?', multiSelect: true, options: [{ value: 'x', label: 'X', description: '' }, { value: 'y', label: 'Y', description: '' }, { value: 'z', label: 'Z', description: '' }] };
  const r = toRequest(params);
  assert.equal(r.shape, 'multi'); assert.equal(r.request.multiSelect, true); assert.deepEqual(r.request.options.map(o => o.value), ['x', 'y', 'z']);
});

test('a questionnaire in AskUserQuestion shape becomes ONE frame request: one item per step, values synthesised, text defaults to the headers', () => {
  const r = toRequest({ questions: [Q('Ruta'), Q('Extras', { multiSelect: true, allowFreeText: true }), Q('Libre', { options: [label('Si'), label('No')], allowFreeText: true })] });
  assert.equal(r.shape, 'form');
  assert.equal(r.request.kind, 'question'); assert.equal(r.request.text, 'Ruta · Extras · Libre'); assert.deepEqual(r.request.options, []);
  assert.equal(r.request.questions.length, 3);
  assert.deepEqual(r.request.questions[0], { header: 'Ruta', text: '¿Ruta?', multiSelect: false, allowFreeText: false,
    options: [{ value: 'o1', label: 'Uno', description: 'a' }, { value: 'o2', label: 'Dos', description: 'b' }, { value: 'o3', label: 'Tres', description: '' }] });
  assert.equal(r.request.questions[1].multiSelect, true); assert.equal(r.request.questions[1].allowFreeText, true);
  assert.deepEqual(r.request.questions[2].options.map(o => o.value), ['o1', 'o2']);
  // a title given by the model wins; a value given by the model is kept
  const t = toRequest({ text: 'Antes de seguir', questions: [Q('A', { options: [{ value: 'keep', label: 'K' }, label('L')] })] });
  assert.equal(t.request.text, 'Antes de seguir'); assert.deepEqual(t.request.questions[0].options.map(o => o.value), ['keep', 'o2']);
});

test('invalid shapes are refused before anything is sent', () => {
  const bad = [
    { questions: [] }, { questions: [Q('A'), Q('B'), Q('C'), Q('D'), Q('E')] },
    { questions: [Q('A', { options: [label('solo')] })] }, { questions: [Q('A', { options: [label('1'), label('2'), label('3'), label('4'), label('5')] })] },
    { questions: [Q('')] }, { questions: [Q('x'.repeat(33))] }, { questions: [{ ...Q('A'), question: '' }] },
    { questions: [Q('A')], options: [{ value: 'a', label: 'A', description: '' }, { value: 'b', label: 'B', description: '' }] },
    { kind: 'approval', questions: [Q('A')] }, { questions: [Q('A')], multiSelect: true }, { questions: 'x' },
    { questions: [Q('A', { options: [{ label: 'a', value: 'bad value!' }, label('b')] })] },
    { questions: [Q('A', { options: [{ label: 'a', value: 'same' }, { label: 'b', value: 'same' }] })] },
    { kind: 'question', text: 'x', multiSelect: true, options: [{ value: 'a', label: 'A', description: '' }] },
    { kind: 'approval', text: 'x', multiSelect: true, options: [{ value: 'a', label: 'A', description: '' }, { value: 'b', label: 'B', description: '' }] },
  ];
  for (const params of bad) assert.deepEqual(Object.keys(toRequest(params)), ['error'], JSON.stringify(params).slice(0, 80));
  assert.equal(toRequest({ kind: 'question' }).error, 'invalid_request');
});

// ---- the round trip -----------------------------------------------------------------------------------------------
async function rig(t, level = 3) {
  const receiver = await fakeReceiver(t, { questions: true, busyReason: true, structured: level === 3 });
  const h = harness(registerAdapter, { ...receiver, questionLevel: level });
  t.after(() => h.handlers.get('session_shutdown')());
  h.handlers.get('session_start')({}, h.ctx);
  await new Promise(r => setTimeout(r, 150));
  return { receiver, h };
}
const answer = (receiver, q, a) => receiver.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project, sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', answer: a });

test('questionnaire round trip: ONE frame with every step, one answer per step comes back with the chosen labels', async t => {
  const { receiver, h } = await rig(t);
  const frame = receiver.next('question');
  const done = runAsk(h.controller, { questions: [Q('Ruta'), Q('Extras', { multiSelect: true, allowFreeText: true }), Q('Libre', { options: [label('Si'), label('No')], allowFreeText: true })] }, h.ctx, new AbortController().signal);
  const q = await frame;
  assert.equal(q.questions.length, 3); assert.equal(q.agent, 'pi');
  answer(receiver, q, { type: 'form', answers: [{ type: 'option', value: 'o2' }, { type: 'options', values: ['o3', 'o1'], text: 'más' }, { type: 'text', text: 'abierta' }] });
  const out = await done;
  assert.equal(out.isError, false);
  assert.equal(out.details.status, 'answered');
  assert.deepEqual(out.details.answer, { type: 'form', answers: [{ type: 'option', value: 'o2' }, { type: 'options', values: ['o3', 'o1'], text: 'más' }, { type: 'text', text: 'abierta' }] });
  const body = JSON.parse(out.text);
  assert.deepEqual(body.selected, [
    { header: 'Ruta', question: '¿Ruta?', selected: ['Dos'] },
    { header: 'Extras', question: '¿Extras?', selected: ['Tres', 'Uno'], text: 'más' },
    { header: 'Libre', question: '¿Libre?', selected: [], text: 'abierta' },
  ]);
  assert.equal(body.status, 'answered');
});

test('multiSelect round trip: every ticked option is reported, in the order the human gave them', async t => {
  const { receiver, h } = await rig(t);
  const frame = receiver.next('question');
  const done = runAsk(h.controller, { kind: 'question', text: 'Extras?', multiSelect: true, options: [{ value: 'x', label: 'Equis', description: '' }, { value: 'y', label: 'Ye', description: '' }, { value: 'z', label: 'Zeta', description: '' }] }, h.ctx, new AbortController().signal);
  const q = await frame; assert.equal(q.multiSelect, true);
  answer(receiver, q, { type: 'options', values: ['z', 'x'] });
  const out = await done;
  assert.deepEqual(out.details.answer, { type: 'options', values: ['z', 'x'] });
  assert.deepEqual(JSON.parse(out.text).selected, [{ selected: ['Zeta', 'Equis'] }]);
});

test('a single legacy question keeps its exact answer text (JSON of the result, nothing added)', async t => {
  const { receiver, h } = await rig(t, 2);
  const frame = receiver.next('question');
  const done = runAsk(h.controller, { kind: 'question', text: 'Which?', options: [{ value: 'a', label: 'A', description: '' }, { value: 'b', label: 'B', description: '' }] }, h.ctx, new AbortController().signal);
  const q = await frame;
  answer(receiver, q, { type: 'option', value: 'b' });
  const out = await done;
  assert.equal(out.text, JSON.stringify(out.details)); assert.equal('selected' in JSON.parse(out.text), false);
  assert.deepEqual(out.details.answer, { type: 'option', value: 'b' });
});

test('without the structured capability a questionnaire is refused WITHOUT sending a frame and says what to do', async t => {
  const { receiver, h } = await rig(t, 2);
  const before = receiver.frames.length;
  const out = await runAsk(h.controller, { questions: [Q('A')] }, h.ctx, new AbortController().signal);
  assert.equal(out.isError, true); assert.equal(out.details.status, 'invalid_request'); assert.equal(out.details.reasonCode, 'structured_unavailable');
  assert.match(out.text, /ABITO_QUESTIONS=3/); assert.match(out.text, /normal chat/);
  assert.equal(receiver.frames.length, before, 'nothing was written');
});

test('an invalid request is an error result that sends nothing; cancel and human-cancel are errors that never carry a guessed answer', async t => {
  const { receiver, h } = await rig(t);
  const before = receiver.frames.length;
  const bad = await runAsk(h.controller, { questions: [] }, h.ctx, new AbortController().signal);
  assert.equal(bad.isError, true); assert.equal(bad.details.status, 'invalid_request'); assert.equal(receiver.frames.length, before);
  const frame = receiver.next('question');
  const done = runAsk(h.controller, { questions: [Q('A'), Q('B')] }, h.ctx, new AbortController().signal);
  const q = await frame;
  receiver.send({ v: 1, type: 'question_closed', questionVersion: 1, project: q.project, sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', reason: 'cancelled' });
  const out = await done;
  assert.equal(out.isError, true); assert.equal(out.details.status, 'human_cancelled');
  assert.match(out.text, /No human answer/); assert.doesNotMatch(out.text, /selected/);
});

test('when nobody listens (level 0 / no connection) the questionnaire says unavailable, not a structured problem', async t => {
  const receiver = await fakeReceiver(t, { questions: true, busyReason: true, structured: true });
  const h = harness(registerAdapter, { ...receiver, questionLevel: 3 }); // never started: no session_start
  const out = await runAsk(h.controller, { questions: [Q('A')] }, h.ctx, new AbortController().signal);
  assert.equal(out.isError, true); assert.equal(out.details.status, 'unavailable');
});

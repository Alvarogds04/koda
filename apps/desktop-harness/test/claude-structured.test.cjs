'use strict';
const { test } = require('node:test');
const { offlineEnv } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { plan } = require('../src/claude-ask.cjs');
const { handleClaudeHook: raw_handleClaudeHook } = require('../src/claude.cjs');
const { fakeReceiver, viaPipe } = require('./fake-receiver.cjs');
const handleClaudeHook = viaPipe(raw_handleClaudeHook);
const q = (i = 0, multiSelect = false) => ({ header: `Step ${i}`, question: `Question ${i}?`, multiSelect,
  options: [{ label: 'Alpha', description: '' }, { label: 'Beta', description: '' }] });
// S2: questions travel on PermissionRequest (allow + updatedInput), never on PreToolUse any more.
const input = questions => JSON.stringify({ cwd: path.resolve(__dirname, '..'), session_id: 'structured-test', permission_mode: 'default',
  hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions } });
const run = (questions, extra = {}) => handleClaudeHook({ event: 'permission-request', input: input(questions),
  env: offlineEnv('test'), ...extra });
const picks = { type: 'options', values: ['o1', 'o0'] };

test('multiSelect is planned and a real socket returns multiple original labels', async t => {
  const questions = [q(0, true)];
  assert.ok(plan({ questions }));
  const rcv = await fakeReceiver(t, { questions: true, structured: true });
  const reply = rcv.next('question').then(frame => {
    assert.equal(frame.multiSelect, true); assert.equal(frame.allowFreeText, false);
    rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: frame.project, sessionId: frame.sessionId,
      at: Date.now(), id: frame.id, source: 'human', answer: picks });
  });
  const result = await run(questions, { env: { ABITO_DESKTOP_SOCKET: rcv.endpoint, ABITO_SOCKET_DIR: rcv.runtime } });
  await reply;
  assert.deepEqual(JSON.parse(result.stdout).hookSpecificOutput.decision.updatedInput.answers, { 'Question 0?': 'Beta, Alpha' });
  assert.equal(rcv.frames.find(f => f.type === 'questions_hello').structured, 1);
  await rcv.seen('question_resolved');
});
for (const n of [2, 3, 4]) test(`${n} questions use ONE questionnaire in order, with mixed answer kinds`, async () => {
  const questions = Array.from({ length: n }, (_, i) => q(i, i === 1));
  assert.ok(plan({ questions }));
  const requests = [];
  const result = await run(questions, { clientFactory: () => ({ ask: async request => {
    requests.push(request);
    assert.equal(request.questions.length, n);
    assert.deepEqual(request.questions.map(s => s.header), questions.map(s => s.header));
    return { status: 'answered', answer: { type: 'form', answers: questions.map(s => s.multiSelect ? picks : { type: 'option', value: 'o0' }) } };
  } }) });
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(result.stdout).hookSpecificOutput.decision.updatedInput.answers,
    Object.fromEntries(questions.map(s => [s.question, s.multiSelect ? 'Beta, Alpha' : 'Alpha'])));
});
test('questionnaire crosses the real socket as one frame and receives positional answers', async t => {
  const questions = [q(), q(1, true), q(2), q(3)];
  const rcv = await fakeReceiver(t, { questions: true, structured: true });
  const reply = rcv.next('question').then(frame => {
    assert.deepEqual(frame.options, []); assert.equal(frame.questions.length, 4);
    assert.deepEqual(frame.questions.map(s => s.multiSelect), [false, true, false, false]);
    rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: frame.project, sessionId: frame.sessionId,
      at: Date.now(), id: frame.id, source: 'human', answer: { type: 'form', answers: [
        { type: 'option', value: 'o1' }, picks, { type: 'option', value: 'o0' }, { type: 'option', value: 'o1' }] } });
  });
  const result = await run(questions, { env: { ABITO_DESKTOP_SOCKET: rcv.endpoint, ABITO_SOCKET_DIR: rcv.runtime } });
  await reply; await rcv.seen('question_resolved');
  assert.deepEqual(JSON.parse(result.stdout).hookSpecificOutput.decision.updatedInput.answers,
    { 'Question 0?': 'Beta', 'Question 1?': 'Beta, Alpha', 'Question 2?': 'Alpha', 'Question 3?': 'Beta' });
  assert.equal(rcv.frames.filter(f => f.type === 'question').length, 1);
});
test('legacy receiver never gets a downgraded structured question', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const result = await run([q(0, true)], { env: { ABITO_DESKTOP_SOCKET: rcv.endpoint, ABITO_SOCKET_DIR: rcv.runtime } });
  assert.equal(result.stdout, ''); assert.match(result.stderr, /unsupported_receiver/);
  assert.equal(rcv.frames.filter(f => f.type === 'question').length, 0);
});
for (const mode of ['skip', 'invalid', 'incomplete']) test(`${mode} over the socket never returns partial answers`, async t => {
  const rcv = await fakeReceiver(t, { questions: true, structured: true });
  const reply = rcv.next('question').then(frame => rcv.send({ v: 1, type: mode === 'skip' ? 'question_closed' : 'answer',
    questionVersion: 1, project: frame.project, sessionId: frame.sessionId, at: Date.now(), id: frame.id, source: 'human',
    ...(mode === 'skip' ? { reason: 'cancelled' } : { answer: { type: 'form', answers: mode === 'incomplete' ? [] :
      [{ type: 'option', value: 'o0' }, { type: 'options', values: ['o9'] }] } }) }));
  const result = await run([q(), q(1, true)], { env: { ABITO_DESKTOP_SOCKET: rcv.endpoint, ABITO_SOCKET_DIR: rcv.runtime } });
  await reply;
  assert.equal(result.stdout, ''); assert.match(result.stderr, mode === 'skip' ? /human_cancelled/ : /protocol_error/);
});
const badShapes = {
  'more than four questions': Array.from({ length: 5 }, (_, i) => q(i)),
  'too many options': [{ ...q(), options: Array.from({ length: 5 }, () => ({ label: 'X' })) }],
  'too few options': [{ ...q(), options: [{ label: 'X' }] }],
  'long question': [{ ...q(), question: 'x'.repeat(2001) }],
  'long structured label': [{ ...q(0, true), options: [{ label: 'x'.repeat(121) }, { label: 'B' }] }],
  'long structured description': [{ ...q(0, true), options: [{ label: 'A', description: 'x'.repeat(401) }, { label: 'B' }] }],
  'long header': [{ ...q(), header: 'x'.repeat(33) }, q(1)],
  'multiSelect with explicit free text': [{ ...q(0, true), allowFreeText: true }],
  'multiSelect with Other': [{ ...q(0, true), options: [{ label: 'Other' }, { label: 'B' }] }],
  'malformed multiSelect': [{ ...q(), multiSelect: 'yes' }],
  'duplicate question keys': [q(), q()],
  'empty questionnaire': [],
};
for (const [name, questions] of Object.entries(badShapes)) test(`${name} falls back without asking`, async () => {
  let calls = 0;
  const result = await run(questions, { clientFactory: () => ({ ask: async () => { calls++; return { status: 'expired' }; } }) });
  assert.equal(result.stdout, ''); assert.equal(calls, 0);
});
for (const status of ['expired', 'busy', 'human_cancelled', 'unavailable', 'unsupported_receiver']) {
  test(`${status} never supplies answers for multiSelect or questionnaire`, async () => {
    for (const questions of [[q(0, true)], [q(), q(1, true)]]) {
      let calls = 0;
      const result = await run(questions, { clientFactory: () => ({ ask: async () => { calls++; return { status }; } }) });
      assert.equal(result.stdout, ''); assert.equal(calls, 1);
    }
  });
}
for (const answer of [{ type: 'options', values: [] }, { type: 'options', values: ['o0', 'o0'] },
  { type: 'options', values: ['o9'] }, { type: 'options', values: ['o0'], text: 'Other' },
  { type: 'option', value: 'o0' }, { type: 'form', answers: [] }]) {
  test(`invalid structured answer is never fabricated: ${JSON.stringify(answer)}`, async () => {
    const result = await run([q(0, true)], { clientFactory: () => ({ ask: async () => ({ status: 'answered', answer }) }) });
    assert.equal(result.stdout, '');
  });
}
test('Other in single-select stays an ordinary option, never fabricated free text', async () => {
  const question = { ...q(), options: [{ label: 'Otra cosa…' }, { label: 'Type something' }] };
  const result = await run([question], { clientFactory: () => ({ ask: async request => {
    assert.equal(request.allowFreeText, false); return { status: 'answered', answer: { type: 'option', value: 'o0' } };
  } }) });
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.decision.updatedInput.answers[question.question], 'Otra cosa…');
});
test('F5: every step reads «Claude Code pregunta:» in Spanish, and the length bound counts that exact shown text', () => {
  const opts = [{ label: 'A' }, { label: 'B' }];
  const p = plan({ questions: [{ question: '¿Cuál?', options: opts }] });
  assert.equal(p.steps[0].text, 'Claude Code pregunta: ¿Cuál?');
  const prefix = 'Claude Code pregunta: ';
  const atLimit = 'x'.repeat(500 - prefix.length), over = atLimit + 'x';
  assert.ok(plan({ questions: [{ question: atLimit, options: opts }] }), 'a question that fits the 500-char card exactly is planned');
  assert.equal(plan({ questions: [{ question: over, options: opts }] }), null, 'one char more would be cut: the terminal keeps it');
});
test('F5: a step without a header gets the Spanish «Pregunta N» shown in «Paso N de M · …»', () => {
  const opts = [{ label: 'A' }, { label: 'B' }];
  const p = plan({ questions: [{ question: '¿Uno?', options: opts }, { question: '¿Dos?', options: opts }] });
  assert.deepEqual(p.steps.map(s => s.header), ['Pregunta 1', 'Pregunta 2']);
});

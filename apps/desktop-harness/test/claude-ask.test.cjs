'use strict';
// Claude Code AskUserQuestion, answered through PermissionRequest (S2): Claude runs that hook CONCURRENTLY with
// its own terminal dialog and the first answer wins, so the question shows in the terminal immediately.
// ONE PermissionRequest handler dispatches by tool_name (see claude.cjs); the old PreToolUse question path is gone.
// Fake receiver + stub clients only; nothing here reads or writes the real ~/.claude or the live island.
const { test } = require('node:test');
const { offlineEnv, offlineDir, stubEndpoint, assertMode } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleClaudeHook: raw_handleClaudeHook } = require('../src/claude.cjs');
const { fakeReceiver, viaPipe } = require('./fake-receiver.cjs');
const handleClaudeHook = viaPipe(raw_handleClaudeHook);

const cwd = path.resolve(__dirname, '..');
const QUESTION = { question: '¿Qué base de datos usamos?', header: 'DB', multiSelect: false,
  options: [{ label: 'Postgres', description: 'Relacional' }, { label: 'SQLite', description: 'Archivo local' }, { label: 'Redis', description: 'En memoria' }] };
const perm = (over = {}, tool = {}) => JSON.stringify({ session_id: 'sess-1', cwd, permission_mode: 'default',
  hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions: [QUESTION], ...tool }, ...over });
// The documented PermissionRequest answer for AskUserQuestion: allow + updatedInput (original questions echoed, answers added).
const expected = (questions, answers) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
  decision: { behavior: 'allow', updatedInput: { questions, answers } } } });
const envOf = r => ({ ABITO_DESKTOP_SOCKET: r.endpoint, ABITO_SOCKET_DIR: r.runtime });
const answerer = (rcv, value) => rcv.next('question').then(q => rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project,
  sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value } }));
const stub = status => () => ({ ask: async () => ({ status }), notify: async () => ({ status: 'sent' }) });
const run = (input, rcv, extra = {}) => handleClaudeHook({ event: 'permission-request', input, env: envOf(rcv), argv: [], ...extra });

test('the chosen option becomes decision.allow + updatedInput.answers keyed by the question text; tool_input is echoed', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const p = answerer(rcv, 'o1');
  const r = await run(perm(), rcv); await p;
  assert.equal(r.exitCode, 0); assert.equal(r.stderr, '');
  assert.ok(r.stdout.endsWith('\n') && r.stdout.trim().split('\n').length === 1);
  assert.deepEqual(JSON.parse(r.stdout), expected([QUESTION], { [QUESTION.question]: 'SQLite' }));
});
test('the frame names who asks (claude-code + project) and offers the options verbatim', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const p = answerer(rcv, 'o0');
  await run(perm(), rcv); await p;
  const q = rcv.frames.find(f => f.type === 'question');
  assert.equal(q.agent, 'claude-code'); assert.equal(q.projectName, path.basename(cwd));
  assert.equal(q.allowFreeText, false); assert.equal(q.expiresAt - q.at, 30000);
  assert.equal(q.text, 'Claude Code pregunta: ¿Qué base de datos usamos?', 'F5: the card is Spanish; never «Claude Code asks:»');
  assert.deepEqual(q.options, [{ value: 'o0', label: 'Postgres', description: 'Relacional' }, { value: 'o1', label: 'SQLite', description: 'Archivo local' },
    { value: 'o2', label: 'Redis', description: 'En memoria' }]);
});
test('a label longer than the wire allows is shortened on screen but answers with the ORIGINAL label', async t => {
  const long = 'L'.repeat(90);
  const q = { ...QUESTION, options: [{ label: long, description: 'd'.repeat(300) }, { label: 'Otra', description: '' }] };
  const rcv = await fakeReceiver(t, { questions: true });
  const p = answerer(rcv, 'o0');
  const r = await run(perm({}, { questions: [q] }), rcv); await p;
  const frame = rcv.frames.find(f => f.type === 'question');
  assert.ok([...frame.options[0].label].length <= 60); assert.ok([...frame.options[0].description].length <= 160);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.decision.updatedInput.answers[q.question], long);
});
test('other tools keep the permission path: AskUserQuestion is dispatched by tool_name, not by a second hook entry', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const p = answerer(rcv, 'deny');
  const r = await run(JSON.stringify({ session_id: 's', cwd, permission_mode: 'default', hook_event_name: 'PermissionRequest',
    tool_name: 'Bash', tool_input: { command: 'ls' } }), rcv);
  await p;
  const q = rcv.frames.find(f => f.type === 'question');
  assert.deepEqual(q.options.map(o => o.value), ['allow', 'deny']);
  assert.equal(r.stdout, '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from the Koda island by the user."}}}\n');
});
test('S6: the pre-tool-use event is gone: no frame, no output, whatever the tool', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  for (const tool_name of ['AskUserQuestion', 'Bash']) {
    const r = await handleClaudeHook({ event: 'pre-tool-use', input: perm({ tool_name }), env: envOf(rcv), argv: [] });
    assert.deepEqual(r, { stdout: '', stderr: '', exitCode: 0 });
  }
  assert.equal(rcv.frames.length, 0);
});
test('an island option "allow"/"deny" is never a question answer', async () => {
  for (const value of ['allow', 'deny', 'terminal', 'o9']) {
    const r = await handleClaudeHook({ event: 'permission-request', input: perm(), env: stubEndpoint('x'), argv: [],
      clientFactory: () => ({ ask: async () => ({ status: 'answered', answer: { type: 'option', value } }) }) });
    assert.equal(r.stdout, '', value);
  }
});
test('unrepresentable shapes fall back to Claude\'s own dialog: duplicate question keys, 1 or 5 options, no questions', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const opt = n => Array.from({ length: n }, (_, i) => ({ label: `L${i}`, description: '' }));
  const shapes = [
    { questions: [QUESTION, QUESTION] },
    { questions: [{ ...QUESTION, options: opt(1) }] },
    { questions: [{ ...QUESTION, options: opt(5) }] },
    { questions: [] }, { questions: 'x' }, {}, { questions: [{ ...QUESTION, question: '' }] },
    { questions: [{ ...QUESTION, options: [{ label: 'a' }, { label: 'b', description: 3 }] }] },
  ];
  for (const s of shapes) {
    const r = await run(JSON.stringify({ session_id: 's', cwd, hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: s }), rcv);
    assert.equal(r.stdout, '', JSON.stringify(s)); assert.equal(r.exitCode, 0);
  }
  assert.equal(rcv.frames.length, 0);
});
test('every non-answer outcome => EMPTY stdout (never allow, never deny)', async () => {
  for (const s of ['expired', 'busy', 'cancelled', 'human_cancelled', 'unavailable', 'unsupported_receiver', 'protocol_error', 'invalid_request', 'weird']) {
    const r = await handleClaudeHook({ event: 'permission-request', input: perm(), env: stubEndpoint(), argv: [], clientFactory: stub(s) });
    assert.equal(r.stdout, '', s); assert.equal(r.exitCode, 0); assert.doesNotMatch(r.stderr, /Postgres|base de datos/);
  }
  for (const answer of [{ type: 'option', value: 'o9' }, { type: 'option', value: 'allow' }, { type: 'text', text: 'Postgres' }, undefined]) {
    const r = await handleClaudeHook({ event: 'permission-request', input: perm(), env: stubEndpoint('x'), argv: [],
      clientFactory: () => ({ ask: async () => ({ status: 'answered', answer }) }) });
    assert.equal(r.stdout, '');
  }
});
test('no island at all => empty stdout and a generic hint on stderr only', async () => {
  const r = await handleClaudeHook({ event: 'permission-request', input: perm(), env: offlineDir('nonexistent-abito-test'), argv: [] });
  assert.equal(r.stdout, ''); assert.equal(r.exitCode, 0);
});
test('bad input never produces output: wrong event name, bad JSON, bad cwd, oversize, hook timeout too short', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  assert.equal((await run(perm({ hook_event_name: 'PreToolUse' }), rcv)).stdout, '');
  assert.equal((await run('garbage', rcv)).stdout, '');
  assert.equal((await run(perm({ cwd: 'relative' }), rcv)).stdout, '');
  assert.equal((await run('x'.repeat(2 * 1024 * 1024), rcv)).stdout, '');
  assert.equal((await run(perm(), rcv, { argv: ['--timeout-sec', '20'] })).stdout, '');
  assert.equal(rcv.frames.length, 0);
});

// ---- SessionStart: cache the session title so the island can name the session ----
const tmp = t => { const d = fs.mkdtempSync(path.join(require('./platform-env.cjs').tmpBase(), 'abito-title-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const start = (over = {}) => JSON.stringify({ session_id: 'sess-1', cwd, hook_event_name: 'SessionStart', source: 'startup', session_title: 'Migrar la base', ...over });

test('SessionStart caches the title privately and prints nothing; the next question is labelled with it', async t => {
  const state = tmp(t), rcv = await fakeReceiver(t, { questions: true });
  const env = { ...envOf(rcv), ABITO_STATE_DIR: state };
  const r = await handleClaudeHook({ event: 'session-start', input: start(), env, argv: [] });
  assert.deepEqual(r, { stdout: '', stderr: '', exitCode: 0 });
  const dir = path.join(state, 'claude-titles');
  const files = fs.readdirSync(dir); assert.equal(files.length, 1);
  assertMode(dir, 0o700); // Windows twin inside assertMode: the helper reports the directory/file as private to the user
  assertMode(path.join(dir, files[0]), 0o600);
  const p = answerer(rcv, 'o0');
  await handleClaudeHook({ event: 'permission-request', input: perm(), env, argv: [] }); await p;
  assert.equal(rcv.frames.find(f => f.type === 'question').projectName, 'Migrar la base');
});
test('a missing, hostile or oversized title is ignored: the label stays the project basename', async t => {
  for (const title of [undefined, '', '   ', 5, null, '\u202e\u0000', 'x'.repeat(5000)]) {
    const state = tmp(t), rcv = await fakeReceiver(t, { questions: true });
    const env = { ...envOf(rcv), ABITO_STATE_DIR: state };
    await handleClaudeHook({ event: 'session-start', input: start({ session_title: title }), env, argv: [] });
    const p = answerer(rcv, 'o0');
    await handleClaudeHook({ event: 'permission-request', input: perm(), env, argv: [] }); await p;
    const name = rcv.frames.find(f => f.type === 'question').projectName;
    assert.ok(name === path.basename(cwd) || (typeof title === 'string' && title.startsWith('x') && name.length <= 64), String(title));
  }
});
test('titles are per session: another session id never reads it', async t => {
  const state = tmp(t), rcv = await fakeReceiver(t, { questions: true });
  const env = { ...envOf(rcv), ABITO_STATE_DIR: state };
  await handleClaudeHook({ event: 'session-start', input: start(), env, argv: [] });
  const p = answerer(rcv, 'o0');
  await handleClaudeHook({ event: 'permission-request', input: perm({ session_id: 'other' }), env, argv: [] }); await p;
  assert.equal(rcv.frames.find(f => f.type === 'question').projectName, path.basename(cwd));
});

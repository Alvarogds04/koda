'use strict';
// Copilot CLI permissionRequest hook. Output contract (docs.github.com/copilot/reference/hooks-configuration):
// {"behavior":"allow"|"deny","message"?} ; empty output or {} = Copilot's normal permission flow. Exit 2 would DENY, so we never use it.
const { test } = require('node:test');
const { offlineEnv, offlineDir, stubEndpoint } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { handleCopilotHook: raw_handleCopilotHook, COPILOT_ALLOW, COPILOT_DENY } = require('../src/copilot.cjs');
const { fakeReceiver, viaPipe } = require('./fake-receiver.cjs');
const handleCopilotHook = viaPipe(raw_handleCopilotHook);

const cwd = path.resolve(__dirname, '..');
// camelCase is the native shape; the PascalCase/VS Code shape (snake_case) must work too.
const camel = (over = {}) => JSON.stringify({ sessionId: 'cop-1', timestamp: 1, cwd, toolName: 'bash', toolInput: { command: 'ls' }, ...over });
const snake = (over = {}) => JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'cop-1', cwd, tool_name: 'bash', tool_input: { command: 'ls' }, ...over });
const envOf = r => ({ ABITO_DESKTOP_SOCKET: r.endpoint, ABITO_SOCKET_DIR: r.runtime });
const answerer = (rcv, value) => rcv.next('question').then(q => rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project,
  sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value } }));
const stub = status => () => ({ ask: async () => ({ status }), notify: async () => ({ status: 'sent' }) });
const call = (input, env, extra = {}) => handleCopilotHook({ event: 'permission-request', input, env, argv: [], ...extra });

test('allow / deny => exact decision line; both input shapes', async t => {
  for (const input of [camel, snake]) for (const [value, expected] of [['allow', COPILOT_ALLOW], ['deny', COPILOT_DENY]]) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, value);
    const r = await call(input(), envOf(rcv)); await p;
    assert.equal(r.stdout, expected); assert.equal(r.exitCode, 0); assert.equal(r.stderr, '');
  }
  assert.deepEqual(JSON.parse(COPILOT_ALLOW), { behavior: 'allow' });
  assert.deepEqual(JSON.parse(COPILOT_DENY), { behavior: 'deny', message: 'Denied from the Koda island by the user.' });
});
test('the frame names who asks: agent copilot-cli + project folder; 30 s budget at the default hook timeout', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const p = answerer(rcv, 'allow');
  await call(camel(), envOf(rcv)); await p;
  const q = rcv.frames.find(f => f.type === 'question');
  assert.equal(q.agent, 'copilot-cli'); assert.equal(q.projectName, path.basename(cwd));
  assert.equal(q.expiresAt - q.at, 30000); assert.equal(q.allowFreeText, false);
  assert.equal(q.text, 'Copilot CLI asks permission: Bash: ls');
  assert.deepEqual(q.options.map(o => o.value), ['allow', 'deny']);
});
test('a request the island cannot show whole (edit, unknown tool, extra input) never offers allow', async t => {
  for (const [toolName, toolInput] of [['edit', { path: '/etc/x', new_str: 'y' }], ['create', { path: '/a', file_text: 'z' }], ['bash', { command: 'ls', extra: 1 }], ['weird', {}], ['bash', 'ls']]) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, 'terminal');
    const r = await call(camel({ toolName, toolInput }), envOf(rcv)); await p;
    assert.deepEqual(rcv.frames.find(f => f.type === 'question').options.map(o => o.value), ['deny', 'terminal'], toolName);
    assert.equal(r.stdout, '', 'terminal => Copilot decides');
  }
});
test('a sandbox-bypass request offers only deny / terminal (Copilot ignores allow there and the human must confirm in its UI)', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const p = answerer(rcv, 'deny');
  const r = await call(camel({ toolInput: { command: 'ls', requestSandboxBypass: true } }), envOf(rcv)); await p;
  assert.deepEqual(rcv.frames.find(f => f.type === 'question').options.map(o => o.value), ['deny', 'terminal']);
  assert.equal(r.stdout, COPILOT_DENY);
});
test('every non-answer outcome => EMPTY stdout and exit 0 (never exit 2, which Copilot treats as DENY; never allow)', async () => {
  for (const s of ['expired', 'busy', 'cancelled', 'human_cancelled', 'unavailable', 'unsupported_receiver', 'protocol_error', 'invalid_request', 'weird']) {
    const r = await call(camel(), stubEndpoint(), { clientFactory: stub(s) });
    assert.equal(r.stdout, '', s); assert.equal(r.exitCode, 0); assert.doesNotMatch(r.stderr, /ls\b/);
  }
  for (const answer of [{ type: 'option', value: 'always' }, { type: 'text', text: 'allow' }, undefined]) {
    const r = await call(camel(), stubEndpoint('x'), { clientFactory: () => ({ ask: async () => ({ status: 'answered', answer }) }) });
    assert.equal(r.stdout, '');
  }
  assert.equal((await call(camel(), offlineDir('nonexistent-abito-test'))).stdout, '');
});
test('a forged allow to a question that never offered it is not a decision', async () => {
  const r = await call(camel({ toolName: 'edit', toolInput: { path: '/x' } }), stubEndpoint('x'),
    { clientFactory: () => ({ ask: async () => ({ status: 'answered', answer: { type: 'option', value: 'allow' } }) }) });
  assert.equal(r.stdout, '');
});
test('bad input => empty: junk, oversize, no cwd, no tool, wrong event, hook timeout too short', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  for (const input of ['garbage', '', 'x'.repeat(2 * 1024 * 1024), camel({ cwd: 'relative' }), camel({ toolName: undefined, tool_name: undefined }), snake({ hook_event_name: 'PreToolUse' })]) {
    assert.equal((await call(input, envOf(rcv))).stdout, '');
  }
  assert.equal((await call(camel(), envOf(rcv), { argv: ['--timeout-sec', '20'] })).stdout, '');
  assert.equal(rcv.frames.length, 0);
});
test('sessionEnd (event stop) sends ONE settled notice naming copilot-cli + project and prints nothing; no island => nothing', async t => {
  const rcv = await fakeReceiver(t, {});
  const r = await handleCopilotHook({ event: 'stop', input: JSON.stringify({ sessionId: 'cop-1', cwd, reason: 'complete' }), env: envOf(rcv), argv: [] });
  assert.deepEqual(r, { stdout: '', stderr: '', exitCode: 0 });
  for (let i = 0; i < 40 && !rcv.frames.some(f => f.type === 'settled'); i++) await new Promise(x => setTimeout(x, 25));
  const n = rcv.frames.find(f => f.type === 'settled');
  assert.equal(n.agent, 'copilot-cli'); assert.equal(n.projectName, path.basename(cwd));
  assert.deepEqual(await handleCopilotHook({ event: 'stop', input: camel(), env: offlineDir('nonexistent-abito-test'), argv: [] }), { stdout: '', stderr: '', exitCode: 0 });
  assert.deepEqual(await handleCopilotHook({ event: 'weird', input: camel(), env: {}, argv: [] }), { stdout: '', stderr: '', exitCode: 0 });
});

// HU-062 (found on Windows CI): copilot.cjs called process.getuid() unguarded, which does not exist on Windows, so every Copilot hook
// answered «invalid configuration» there. Simulate a Windows process on any OS (platform win32, no getuid) with a stub client.
test('a Windows process (no getuid) reaches the island client: ask and stop both work', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform'), getuid = process.getuid;
  Object.defineProperty(process, 'platform', { value: 'win32' }); process.getuid = undefined;
  t.after(() => { Object.defineProperty(process, 'platform', platform); process.getuid = getuid; });
  const env = { ABITO_DESKTOP_SOCKET: 'C:\\copilot-win\\endpoint.json' };
  let asked = 0, notified = 0;
  const clientFactory = () => ({ ask: async () => { asked++; return { status: 'answered', answer: { type: 'option', value: 'allow' } }; }, notify: async () => { notified++; return { status: 'sent' }; } });
  const r = await raw_handleCopilotHook({ event: 'permission-request', input: camel(), env, argv: [], clientFactory });
  assert.equal(r.stdout, COPILOT_ALLOW); assert.equal(asked, 1);
  await raw_handleCopilotHook({ event: 'stop', input: camel(), env, argv: [], clientFactory });
  assert.equal(notified, 1);
});

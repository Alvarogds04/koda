'use strict';
const { test } = require('node:test');
const { hookNodeArgs, pipeEnv } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ALLOW, DENY } = require('../src/claude.cjs');
const { fakeReceiver } = require('./fake-receiver.cjs');

const bin = path.resolve(__dirname, '../bin/abito-hook.cjs');
const cwd = path.resolve(__dirname, '..');
const permission = JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
const stop = JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'SECRETREPLY' });

function run(args, input, env, { closeStdin = true } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...hookNodeArgs, bin, ...args], { env: { PATH: process.env.PATH, ABITO_SOCKET_DIR: '/nonexistent-abito-test', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.write(input);
    if (closeStdin) child.stdin.end();
  });
}
const envOf = r => ({ ABITO_DESKTOP_SOCKET: r.endpoint, ABITO_SOCKET_DIR: r.runtime, ...pipeEnv(r) });
const oneLineOrEmpty = s => assert.ok(s === '' || (s.endsWith('\n') && s.trim().split('\n').length === 1));
const settle = async rcv => { for (let i = 0; i < 40 && !rcv.frames.some(f => f.type === 'settled'); i++) await new Promise(r => setTimeout(r, 25)); };
const answer = (rcv, value) => rcv.next('question').then(q => rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project,
  sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value } }));

test('e2e allow / deny', async t => {
  for (const [v, exp] of [['allow', ALLOW], ['deny', DENY]]) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answer(rcv, v);
    const r = await run(['claude', 'permission-request'], permission, envOf(rcv));
    await p;
    // CI diagnostics for the Windows pipe path (flaky once in 4 runs: empty stdout after ~0.5 s): what the child said and what the island saw
    assert.equal(r.code, 0, `stderr=${r.stderr}`); assert.equal(r.stdout, exp, `${v}: stderr=${JSON.stringify(r.stderr)} frames=${rcv.frames.map(f => f.type)} t=${rcv.rawFrames.length}`); oneLineOrEmpty(r.stdout);
    const q = rcv.frames.find(f => f.type === 'question');
    assert.equal(q.expiresAt - q.at, 30000);
  }
});
test('e2e no endpoint, malformed, empty stdin => exit 0 and empty stdout', async t => {
  for (const input of [permission, 'garbage', '']) {
    const r = await run(['claude', 'permission-request'], input, { ABITO_SOCKET_DIR: '/nonexistent-abito-test' });
    assert.equal(r.code, 0); assert.equal(r.stdout, '');
  }
  const rcv = await fakeReceiver(t, { questions: true });
  const r = await run(['claude', 'permission-request'], 'x'.repeat(2 * 1024 * 1024), envOf(rcv));
  assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(rcv.frames.length, 0);
});
test('e2e --timeout-sec 20 => no question frame', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const r = await run(['claude', 'permission-request', '--timeout-sec', '20'], permission, envOf(rcv));
  assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(rcv.frames.length, 0);
});
test('e2e stop: one settled frame, no reply text; stop_hook_active => none', async t => {
  let rcv = await fakeReceiver(t, {});
  let r = await run(['claude', 'stop'], stop, envOf(rcv));
  assert.equal(r.code, 0); assert.equal(r.stdout, '');
  await settle(rcv);
  assert.deepEqual(rcv.frames.map(f => f.type), ['hello', 'settled']);
  assert.doesNotMatch(rcv.rawFrames.join(''), /SECRET/);
  rcv = await fakeReceiver(t, {});
  r = await run(['claude', 'stop'], stop.replace('"stop_hook_active":false', '"stop_hook_active":true'), envOf(rcv));
  assert.equal(r.code, 0); assert.equal(rcv.frames.length, 0);
});
test('usage errors exit 64 with nothing on stdout', async () => {
  for (const args of [[], ['opencode', 'stop'], ['claude'], ['claude', 'bogus'], ['claude', 'stop', '--timeout-sec', '0'], ['claude', 'stop', '--timeout-sec', '9999'], ['claude', 'stop', '--x']]) {
    const r = await run(args, '', {});
    assert.equal(r.code, 64); assert.equal(r.stdout, ''); assert.match(r.stderr, /^usage:/);
  }
});
test('missing stdin close cannot hang: exits by itself within the stdin timeout', async () => {
  const started = Date.now();
  const r = await run(['claude', 'permission-request'], undefined, {}, { closeStdin: false });
  assert.equal(r.code, 0); assert.equal(r.stdout, '');
  assert.ok(Date.now() - started < 8000);
});
test('e2e receiver that never answers: question expires after the 30 s budget, exit 0, empty stdout, cancel sent', { timeout: 60000 }, async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const started = Date.now();
  const r = await run(['claude', 'permission-request', '--timeout-sec', '35'], permission, envOf(rcv));
  assert.equal(r.code, 0); assert.equal(r.stdout, '');
  assert.ok(Date.now() - started < 40000);
  assert.ok(rcv.frames.some(f => f.type === 'question_cancel'));
});
test('async throw inside a socket callback => exit 0, empty stdout, nothing printed', async t => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-throw-'));
  const fixture = path.join(dir, 'f.cjs');
  fs.writeFileSync(fixture, "const net=require('node:net');const o=net.createConnection;" +
    "net.createConnection=function(...a){const s=o.apply(this,a);s.once('connect',()=>{throw new Error('boom')});return s;};");
  t.after(() => { try { fs.unlinkSync(fixture); fs.rmdirSync(dir); } catch { /* ignore */ } });
  const rcv = await fakeReceiver(t, { questions: true });
  const r = await run(['claude', 'permission-request'], permission, { ...envOf(rcv), NODE_OPTIONS: `--require ${fixture}` });
  assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
});

// S2/S6: AskUserQuestion is answered on PermissionRequest (concurrent with Claude's own dialog); the old
// `claude pre-tool-use` sub-command is gone, so this is the only e2e path for a question.
const askInput = JSON.stringify({ session_id: 's1', cwd, permission_mode: 'default', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Which one?', header: 'H', multiSelect: false, options: [{ label: 'Alpha', description: 'a' }, { label: 'Beta', description: 'b' }] }] } });
test('e2e AskUserQuestion: the island answer travels in decision.allow + updatedInput.answers; no island => empty and exit 0', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const p = answer(rcv, 'o1');
  const r = await run(['claude', 'permission-request'], askInput, envOf(rcv));
  await p;
  assert.equal(r.code, 0, r.stderr); oneLineOrEmpty(r.stdout);
  assert.notEqual(r.stdout, '', `empty stdout; stderr=${r.stderr}; frames=${rcv.frames.map(f => f.type)}`); // CI diagnostics for the Windows pipe path
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PermissionRequest'); assert.equal(out.decision.behavior, 'allow');
  assert.deepEqual(out.decision.updatedInput.answers, { 'Which one?': 'Beta' });
  const none = await run(['claude', 'permission-request'], askInput, { ABITO_SOCKET_DIR: '/nonexistent-abito-test' });
  assert.equal(none.code, 0); assert.equal(none.stdout, '');
  const gone = await run(['claude', 'pre-tool-use'], askInput, envOf(rcv));
  assert.equal(gone.code, 64, 'the removed sub-command is a usage error, never a silent success');
});

// Windows twin of the fail-closed contract with the REAL transport: an island is listening but the native relay is not installed on
// this runner (it is covered by windows-transport.test.cjs and the HU-054 Windows smoke), so the unmodified hook cannot reach it and
// must stay silent: exit 0, empty stdout, nothing on the wire. Without ABITO_TEST_PIPE the preload is inert.
test('Windows no-relay: with an island listening but no relay installed the hook fails closed (exit 0, empty stdout, no frame)', { skip: process.platform !== 'win32' && 'Windows-only transport' }, async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const r = await run(['claude', 'permission-request'], permission, { ABITO_DESKTOP_SOCKET: rcv.endpoint, ABITO_SOCKET_DIR: rcv.runtime });
  assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(rcv.frames.length, 0);
});

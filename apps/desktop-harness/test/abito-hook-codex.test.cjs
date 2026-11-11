'use strict';
// K2-08 T1 e2e through the real CLI: a Codex permission request is answered from the island (allow/deny line on stdout)
// or, whatever else happens, prints nothing so Codex's own prompt asks in the terminal. Plan-mode questions stay a notice.
const { test } = require('node:test');
const { hookNodeArgs, pipeEnv } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fakeReceiver } = require('./fake-receiver.cjs');

const bin = path.resolve(__dirname, '../bin/abito-hook.cjs');
const cwd = path.resolve(__dirname, '..');
const permission = JSON.stringify({ session_id: 's1', cwd, model: 'm', turn_id: 't', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
const planQuestion = JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions: [{ question: '¿Qué alcance?' }] } });
const stop = JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'SECRETREPLY' });
const postTool = JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'SECRETOUTPUT' });

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
const silent = r => { assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, ''); };
const answerer = (rcv, value) => rcv.next('question').then(q => rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project,
  sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value } }));
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n';
const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from the Koda island by the user."}}}\n';

test('codex e2e: permission-request asks the island; allow and deny print the documented line', async t => {
  for (const [value, line] of [['allow', ALLOW], ['deny', DENY]]) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, value);
    const r = await run(['codex', 'permission-request'], permission, envOf(rcv));
    await p;
    assert.equal(r.code, 0); assert.equal(r.stderr, '');
    assert.equal(r.stdout, line);
    const q = rcv.frames.find(f => f.type === 'question');
    assert.equal(q.agent, 'codex');
    assert.equal(q.text, 'Codex pide permiso para Bash: ls');
    assert.equal(rcv.frames.filter(f => f.type === 'attention').length, 0, 'no legacy notice');
  }
});

test('codex e2e: busy island and MCP requests print nothing', async t => {
  let rcv = await fakeReceiver(t, { questions: true });
  const busy = rcv.next('question').then(q => rcv.replyBusy(q, 1));
  silent(await run(['codex', 'permission-request'], permission, envOf(rcv)));
  await busy;
  rcv = await fakeReceiver(t, { questions: true });
  const mcp = JSON.stringify({ ...JSON.parse(permission), tool_name: 'mcp__github__create_issue', tool_input: { title: 'x' } });
  silent(await run(['codex', 'permission-request'], mcp, envOf(rcv)));
  assert.equal(rcv.frames.length, 0, 'MCP stays in the terminal');
});

test('codex e2e: plan-mode questions (PreToolUse request_user_input) send «Codex te pregunta»', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const r = await run(['codex', 'pre-tool-use'], planQuestion, envOf(rcv));
  silent(r);
  const a = await rcv.seen('attention');
  assert.equal(a.title, 'Codex te pregunta');
  assert.equal(a.detail, '¿Qué alcance? · Respondé en la terminal');
});

test('codex e2e: every no-island path is silent (exit 0, empty stdout, empty stderr)', async t => {
  for (const input of [permission, 'garbage', '']) {
    silent(await run(['codex', 'permission-request'], input, { ABITO_SOCKET_DIR: '/nonexistent-abito-test' }));
  }
  const rcv = await fakeReceiver(t, { questions: true });
  silent(await run(['codex', 'permission-request'], 'x'.repeat(2 * 1024 * 1024), envOf(rcv)));
  assert.equal(rcv.frames.length, 0);
});

test('codex e2e: --timeout-sec sets the island wait (the installed 120 s => 115 s; capped at 115 s)', async t => {
  for (const [sec, budget] of [['40', 35000], ['120', 115000], ['125', 115000]]) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, 'deny');
    const r = await run(['codex', 'permission-request', '--timeout-sec', sec], permission, envOf(rcv));
    await p;
    assert.equal(r.stdout, DENY);
    const q = rcv.frames.find(f => f.type === 'question');
    assert.equal(q.expiresAt - q.at, budget);
  }
});

test('codex e2e: post-tool-use clears the pending notice at once, quietly', async t => {
  const rcv = await fakeReceiver(t, {});
  const r = await run(['codex', 'post-tool-use'], postTool, envOf(rcv));
  silent(r);
  await rcv.seen('attention_clear');
  assert.deepEqual(rcv.frames.map(f => f.type), ['hello', 'attention_clear']);
  assert.doesNotMatch(rcv.rawFrames.join(''), /SECRET/);
});

test('codex e2e stop: the finished notice plus the clearing frame, empty stdout', async t => {
  const rcv = await fakeReceiver(t, {});
  const r = await run(['codex', 'stop'], stop, envOf(rcv));
  silent(r);
  await rcv.seen('attention_clear');
  assert.deepEqual(rcv.frames.map(f => f.type), ['hello', 'settled', 'hello', 'attention_clear']);
  assert.doesNotMatch(rcv.rawFrames.join(''), /SECRET/);
});

test('codex usage errors exit 64 with nothing on stdout', async () => {
  for (const args of [['codex'], ['codex', 'bogus'], ['codex', 'notification'], ['codex', 'stop', '--timeout-sec', '0'], ['codex', 'stop', '--x'], ['codexx', 'stop']]) {
    const r = await run(args, '', {});
    assert.equal(r.code, 64); assert.equal(r.stdout, ''); assert.match(r.stderr, /^usage:/);
  }
});

test('codex missing stdin close cannot hang', async () => {
  const started = Date.now();
  const r = await run(['codex', 'permission-request'], undefined, {}, { closeStdin: false });
  silent(r);
  assert.ok(Date.now() - started < 8000);
});

test('codex async throw inside a socket callback => exit 0, nothing printed', async t => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-throw-'));
  const fixture = path.join(dir, 'f.cjs');
  fs.writeFileSync(fixture, "const net=require('node:net');const o=net.createConnection;" +
    "net.createConnection=function(...a){const s=o.apply(this,a);s.once('connect',()=>{throw new Error('boom')});return s;};");
  t.after(() => { try { fs.unlinkSync(fixture); fs.rmdirSync(dir); } catch { /* ignore */ } });
  const rcv = await fakeReceiver(t, { questions: true });
  const r = await run(['codex', 'permission-request'], permission, { ...envOf(rcv), NODE_OPTIONS: `--require ${fixture}` });
  silent(r);
});

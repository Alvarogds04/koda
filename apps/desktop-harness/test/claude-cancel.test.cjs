'use strict';
// S3 (Claude Code): the human may answer in Claude's OWN terminal dialog, which is live at the same time as the
// island card. Claude then cancels the PermissionRequest hook process. The hook holds an open QP/1 connection, so
// "the hook is gone" must mean "the connection closes": the island sees the close (adapter: broker.finish on
// 'close') and revokes the card. This file proves it against a real AF_UNIX fake receiver with a real process,
// for both the question path and the permission path: a killed hook prints nothing and leaves no connection.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fakeReceiver } = require('./fake-receiver.cjs');

const bin = path.resolve(__dirname, '../bin/abito-hook.cjs');
const cwd = path.resolve(__dirname, '..');
// One question (S2 shape): the island answers it through PermissionRequest.
const askInput = JSON.stringify({ session_id: 's1', cwd, permission_mode: 'default', hook_event_name: 'PermissionRequest',
  tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which one?', header: 'H', multiSelect: false,
    options: [{ label: 'Alpha', description: 'a' }, { label: 'Beta', description: 'b' }] }] } });
// One ordinary permission (the older path): same cancellation requirement.
const permInput = JSON.stringify({ session_id: 's1', cwd, permission_mode: 'default', hook_event_name: 'PermissionRequest',
  tool_name: 'Bash', tool_input: { command: 'ls' } });

function launch(rcv, input) {
  // The runtime is always the fake receiver, never the real one (no-live-island.test.cjs enforces it).
  const child = spawn(process.execPath, [bin, 'claude', 'permission-request'], {
    env: { PATH: process.env.PATH, ABITO_DESKTOP_SOCKET: rcv.endpoint, ABITO_SOCKET_DIR: rcv.runtime },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  child.stdin.on('error', () => {});
  child.stdin.write(input);
  child.stdin.end();
  const exited = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  return { child, exited, out: () => ({ stdout, stderr }) };
}
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); }
  return false;
}

for (const [name, input] of [['question (AskUserQuestion)', askInput], ['permission (Bash)', permInput]]) {
  test(`S3: ${name} — SIGTERM ends the hook at once and the island sees the connection close`, async t => {
    const rcv = await fakeReceiver(t, { questions: true, structured: true });
    const p = launch(rcv, input);
    t.after(() => { try { p.child.kill('SIGKILL'); } catch { /* already gone */ } });
    await rcv.next('question');
    assert.equal(rcv.clients.size, 1, 'the hook keeps one live connection while the island question waits');
    p.child.kill('SIGTERM');
    const r = await p.exited;
    assert.equal(r.signal, 'SIGTERM', 'the hook does not trap SIGTERM');
    assert.equal(await until(() => rcv.clients.size === 0), true, 'closing the connection is what revokes the card');
    assert.deepEqual(p.out(), { stdout: '', stderr: '' }, 'a cancelled hook never prints a decision');
  });
}

test('S3: answering in the island closes the connection by itself (the card is resolved, not left hanging)', async t => {
  const rcv = await fakeReceiver(t, { questions: true, structured: true });
  const p = launch(rcv, askInput);
  const answer = rcv.next('question').then(q => rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project,
    sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value: 'o1' } }));
  await answer;
  const r = await p.exited;
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(p.out().stdout).hookSpecificOutput.decision.updatedInput.answers, { 'Which one?': 'Beta' });
  assert.equal(await until(() => rcv.clients.size === 0), true, 'the hook tears the connection down after its answer');
});

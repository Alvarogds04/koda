'use strict';
// K3-05/S5: the slow lane of the hook e2e. MOVED here unchanged from abito-hook.test.cjs (same behaviour, same assertions):
// one case waits the island's REAL 30 s question budget, which IS the contract under test, so it cannot be shortened
// without weakening it. It is kept out of the default `npm test` and runs with `npm run test:slow`.
const { test } = require('node:test');
const { hookNodeArgs, pipeEnv } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fakeReceiver } = require('./fake-receiver.cjs');

const bin = path.resolve(__dirname, '../bin/koda-hook.cjs');
const cwd = path.resolve(__dirname, '..');
const permission = JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });

function run(args, input, env, { closeStdin = true } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...hookNodeArgs, bin, ...args], { env: { PATH: process.env.PATH, KODA_SOCKET_DIR: '/nonexistent-abito-test', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.write(input);
    if (closeStdin) child.stdin.end();
  });
}
const envOf = r => ({ KODA_DESKTOP_SOCKET: r.endpoint, KODA_SOCKET_DIR: r.runtime, ...pipeEnv(r) });

test('e2e receiver that never answers: question expires after the 30 s budget, exit 0, empty stdout, cancel sent', { timeout: 60000 }, async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const started = Date.now();
  const r = await run(['claude', 'permission-request', '--timeout-sec', '35'], permission, envOf(rcv));
  assert.equal(r.code, 0); assert.equal(r.stdout, '');
  assert.ok(Date.now() - started < 40000);
  assert.ok(rcv.frames.some(f => f.type === 'question_cancel'));
});

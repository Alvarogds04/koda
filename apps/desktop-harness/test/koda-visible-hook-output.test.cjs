'use strict';
// Koda 0.1 T2: what a hook prints in the user's terminal (and the denial message the model sees) names the product «Koda».
// Common failure paths of every agent: unavailable, no answer, timeout too short, invalid configuration, denied.
// Internal names (abito-hook, ABITO_* variables, paths) are NOT part of this contract.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { offlineDir, stubEndpoint } = require('./platform-env.cjs');
const { handleClaudeHook } = require('../src/claude.cjs');
const { handleCopilotHook } = require('../src/copilot.cjs');
const { handleOpencodeHook } = require('../src/opencode.cjs');
const { formatNoDecision } = require('../src/client.cjs');

const cwd = path.resolve(__dirname, '..');
const claudeIn = JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's1', cwd, tool_name: 'Bash', tool_input: { command: 'ls' } });
const copilotIn = JSON.stringify({ sessionId: 'c1', cwd, toolName: 'bash', toolInput: { command: 'ls' } });
const ocIn = JSON.stringify({ sessionID: 'ses_1', directory: cwd, type: 'bash', title: 'Run: ls', pattern: 'ls', metadata: { command: 'ls' } });
const stub = (status, answer) => () => ({ ask: async () => ({ status, answer }), notify: async () => ({ status: 'sent' }) });
const BAD_CONFIG = { ABITO_SOCKET_DIR: 'relative/dir', ABITO_DESKTOP_SOCKET: 'relative/dir/s' };
const AGENTS = [
  ['claude', handleClaudeHook, claudeIn, 'permission-request'],
  ['copilot', handleCopilotHook, copilotIn, 'permission-request'],
  ['opencode', handleOpencodeHook, ocIn, 'permission-request'],
];
const koda = text => { assert.match(text, /Koda island/); assert.doesNotMatch(text, /Abito/i); };

for (const [name, handle, input, event] of AGENTS) {
  test(`${name}: failure paths print «Koda island», never «Abito»`, async () => {
    const run = (env, extra = {}) => handle({ event, input, env, argv: [], ...extra });
    const unavailable = await run(offlineDir('nonexistent-koda-test'), { clientFactory: stub('unavailable') });
    koda(unavailable.stderr);
    const noEndpoint = await run(offlineDir('nonexistent-koda-test'));
    assert.equal(noEndpoint.stdout, ''); assert.equal(noEndpoint.exitCode, 0);
    const noAnswer = await run(stubEndpoint(), { clientFactory: stub('expired') });
    assert.equal(noAnswer.stdout, ''); koda(noAnswer.stderr);
    koda((await run(stubEndpoint(), { argv: ['--timeout-sec', '20'], clientFactory: stub('expired') })).stderr);
    koda((await run(BAD_CONFIG, { clientFactory: stub('expired') })).stderr);
  });
}
test('denied from the island: the message the model sees says «Koda island»', async () => {
  for (const [handle, input] of [[handleClaudeHook, claudeIn], [handleCopilotHook, copilotIn]]) {
    const r = await handle({ event: 'permission-request', input, env: stubEndpoint(), argv: [], clientFactory: stub('answered', { type: 'option', value: 'deny' }) });
    const msg = JSON.stringify(r.stdout);
    koda(msg); assert.match(msg, /Denied from the Koda island by the user\./);
  }
});
test('formatNoDecision names «Koda island» for every status', () => {
  for (const status of ['expired', 'busy', 'cancelled', 'unavailable', 'error']) koda(formatNoDecision({ status }));
});

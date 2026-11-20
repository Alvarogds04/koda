'use strict';
// Koda 0.1 T2: what a hook prints in the user's terminal (and the denial message the model sees) names the product «Koda».
// Common failure paths of every agent: unavailable, no answer, timeout too short, invalid configuration, denied.
// Internal names (koda-hook, KODA_* variables, paths) are NOT part of this contract.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { offlineDir, offlineEnv } = require('./platform-env.cjs');
const { handleClaudeHook } = require('../src/claude.cjs');
const { handleCopilotHook } = require('../src/copilot.cjs');
const { handleOpencodeHook } = require('../src/opencode.cjs');
const { formatNoDecision } = require('../src/client.cjs');

const cwd = path.resolve(__dirname, '..');
const claudeIn = JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's1', cwd, tool_name: 'Bash', tool_input: { command: 'ls' } });
const copilotIn = JSON.stringify({ sessionId: 'c1', cwd, toolName: 'bash', toolInput: { command: 'ls' } });
const ocIn = JSON.stringify({ sessionID: 'ses_1', directory: cwd, type: 'bash', title: 'Run: ls', pattern: 'ls', metadata: { command: 'ls' } });
const stub = (status, answer) => () => { stub.built++; return { ask: async () => ({ status, answer }), notify: async () => ({ status: 'sent' }) }; };
// How many times a stub client was built: proof a case really reached the client instead of stopping in the config branch above it.
stub.built = 0;
const BAD_CONFIG = { KODA_SOCKET_DIR: 'relative/dir', KODA_DESKTOP_SOCKET: 'relative/dir/s' };
// An endpoint override in the shape resolveConfig ACCEPTS on this platform, pointing at a runtime that does not exist: the
// handler gets PAST config resolution and reaches the client, which the test replaces. `stubEndpoint()` from platform-env.cjs is
// refused on Linux (`/nope` is not `<runtime>/p-xxxxxx/s`), so a test using it only ever reached «invalid configuration».
const validEndpoint = () => offlineEnv('nonexistent-koda-test');
const AGENTS = [
  ['claude', handleClaudeHook, claudeIn, 'permission-request'],
  ['copilot', handleCopilotHook, copilotIn, 'permission-request'],
  ['opencode', handleOpencodeHook, ocIn, 'permission-request'],
];
const koda = text => { assert.match(text, /Koda island/); assert.doesNotMatch(text, /Abito/i); };
// Each case below states the path it really exercises; the exact text is asserted so a message cannot drift into another branch.
for (const [name, handle, input, event] of AGENTS) {
  test(`${name}: failure paths print «Koda island», never «Abito»`, async () => {
    const run = (env, extra = {}) => { stub.built = 0; return handle({ event, input, env, argv: [], ...extra }); };
    // 1. no endpoint discovered at all (a runtime directory with no handoff): nothing on stdout, the CLI's prompt stays in charge
    const noEndpoint = await run(offlineDir('nonexistent-koda-test'));
    assert.equal(noEndpoint.stdout, ''); assert.equal(noEndpoint.exitCode, 0);
    assert.equal(noEndpoint.stderr, 'Koda island unavailable. Answer in the terminal.\n');
    koda(noEndpoint.stderr);
    assert.equal(stub.built, 0, 'no endpoint: the client is never built');
    // 2. the client itself reports `unavailable` for an endpoint that was discovered
    const unavailable = await run(validEndpoint(), { clientFactory: stub('unavailable') });
    assert.equal(unavailable.stdout, '');
    assert.equal(stub.built, 1, 'a discovered endpoint reaches the client');
    assert.equal(unavailable.stderr, 'Koda island unavailable. Answer in the terminal.\n');
    koda(unavailable.stderr);
    // 3. no answer: the island expired without an answer => empty stdout and the notice (client.cjs formatNoDecision)
    const noAnswer = await run(validEndpoint(), { clientFactory: stub('expired') });
    assert.equal(noAnswer.stdout, '');
    assert.equal(noAnswer.stderr, 'Koda island: no answer (expired). Answer in the terminal.\n');
    koda(noAnswer.stderr);
    // 4. a hook budget too short for a question: refused before config is even resolved (deadline.cjs computeDeadline)
    const tooShort = await run(validEndpoint(), { argv: ['--timeout-sec', '20'], clientFactory: stub('expired') });
    assert.equal(tooShort.stdout, '');
    assert.equal(tooShort.stderr, 'Koda island: hook timeout too short for a question. Answer in the terminal.\n');
    koda(tooShort.stderr);
    assert.equal(stub.built, 0, 'a budget too short is refused before any client is built');
    // 5. a configuration the resolver refuses (a relative runtime directory): still a «Koda island» message, never a stack trace
    const badConfig = await run(BAD_CONFIG, { clientFactory: stub('expired') });
    assert.equal(badConfig.stdout, '');
    assert.equal(badConfig.stderr, 'Koda island: invalid configuration.\n');
    koda(badConfig.stderr);
    assert.equal(stub.built, 0, 'a refused configuration never builds a client');
  });
}
test('denied from the island: the message the model sees says «Koda island»', async () => {
  for (const [handle, input] of [[handleClaudeHook, claudeIn], [handleCopilotHook, copilotIn]]) {
    const r = await handle({ event: 'permission-request', input, env: validEndpoint(), argv: [], clientFactory: stub('answered', { type: 'option', value: 'deny' }) });
    const msg = JSON.stringify(r.stdout);
    koda(msg); assert.match(msg, /Denied from the Koda island by the user\./);
  }
});
test('formatNoDecision names «Koda island» for every status', () => {
  for (const status of ['expired', 'busy', 'cancelled', 'unavailable', 'error']) koda(formatNoDecision({ status }));
});

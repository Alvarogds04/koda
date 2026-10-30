'use strict';
// S4/T2 (human L3, option A «Solo aviso para Codex»): the Codex hooks NEVER wait for the island and never decide.
// `PermissionRequest` and the plan-mode `PreToolUse` observer send ONE bounded, non-blocking NOTICE and return at once
// (empty stdout, exit 0), so Codex's own prompt appears immediately; `Stop` clears it. No decision line exists here.
const { test } = require('node:test');
const { offlineEnv, offlineDir, stubEndpoint } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { handleCodexHook: raw_handleCodexHook, codexToolDescription, shownText } = require('../src/codex.cjs');
const { parseArgs, watchdogMs, startWatchdog } = require('../src/hook-common.cjs');
const { fakeReceiver, viaPipe } = require('./fake-receiver.cjs');
const handleCodexHook = viaPipe(raw_handleCodexHook);

const cwd = path.resolve(__dirname, '..');
const permission = (over = {}) => JSON.stringify({ session_id: 'sess-1', transcript_path: '/home/x/SECRETPATH/t.jsonl', cwd, model: 'm',
  permission_mode: 'default', turn_id: 't1', hook_event_name: 'PermissionRequest', tool_name: 'Bash',
  tool_input: { command: 'ls' }, ...over });
const preTool = (over = {}) => JSON.stringify({ session_id: 'sess-1', cwd, model: 'm', turn_id: 't1',
  hook_event_name: 'PreToolUse', tool_name: 'request_user_input',
  tool_input: { questions: [{ question: '¿Qué alcance querés?' }] }, ...over });
const stopInput = (over = {}) => JSON.stringify({ session_id: 'sess-1', cwd, hook_event_name: 'Stop', stop_hook_active: false,
  turn_id: 't1', model: 'm', last_assistant_message: 'SECRETREPLY', ...over });
const postToolInput = (over = {}) => JSON.stringify({ session_id: 'sess-1', cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash',
  tool_input: { command: 'ls' }, tool_response: 'SECRETOUTPUT', ...over });
const envOf = r => ({ ABITO_DESKTOP_SOCKET: r.endpoint, ABITO_SOCKET_DIR: r.runtime });
// The ONLY legal output of these hooks: nothing at all.
function assertSilent(r) {
  assert.equal(r.exitCode, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
}
const call = (event, over, env, extra = {}) => handleCodexHook({ event,
  input: event === 'stop' ? stopInput(over) : event === 'pre-tool-use' ? preTool(over) : event === 'post-tool-use' ? postToolInput(over) : permission(over),
  env, argv: [], ...extra });
const noticeOf = async (rcv, type = 'attention') => rcv.seen(type);
const wireOf = rcv => rcv.rawFrames.join('');

test('PermissionRequest: no decision, empty stdout, exit 0, and ONE attention notice reaches the island', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const r = await call('permission-request', {}, envOf(rcv));
  assertSilent(r);
  const a = await noticeOf(rcv);
  assert.deepEqual(Object.keys(a).sort(), ['agent', 'at', 'detail', 'id', 'project', 'projectName', 'sessionId', 'title', 'type', 'v']);
  assert.equal(a.type, 'attention');
  assert.equal(a.title, 'Codex te pide permiso');
  assert.equal(a.detail, 'Bash: ls · Respondé en la terminal');
  assert.equal(a.agent, 'codex');
  assert.equal(a.projectName, path.basename(fs.realpathSync(cwd)));
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(Buffer.byteLength(rcv.rawFrames.at(-1)) <= 512, 'the notice frame stays inside the wire cap');
  assert.deepEqual(rcv.frames.map(f => f.type), ['hello', 'attention'], 'no questions_hello: the island is never asked anything');
  // nothing that could decide for Codex is ever produced
  assert.doesNotMatch(wireOf(rcv), /hookSpecificOutput|decision|behavior|updatedInput|questionVersion/);
  assert.equal(r.stdout, '');
});

test('PermissionRequest never waits for the island: a silent receiver cannot hold the hook', async t => {
  // A receiver that accepts the connection and answers NOTHING: the hook must still return at once.
  const rcv = await fakeReceiver(t, { silent: true });
  const { endpoint, runtime } = rcv;
  const started = Date.now();
  const r = await call('permission-request', {}, { ABITO_DESKTOP_SOCKET: endpoint, ABITO_SOCKET_DIR: runtime });
  const elapsed = Date.now() - started;
  assertSilent(r);
  assert.ok(elapsed < 3000, `a notice is bounded, not a question: ${elapsed} ms`);
});

test('PreToolUse request_user_input: same immediate notice, this time «Codex te pregunta»', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const r = await call('pre-tool-use', {}, envOf(rcv));
  assertSilent(r);
  const a = await noticeOf(rcv);
  assert.equal(a.title, 'Codex te pregunta');
  assert.equal(a.detail, '¿Qué alcance querés? · Respondé en la terminal');
  assert.equal(a.agent, 'codex');
  assert.doesNotMatch(wireOf(rcv), /hookSpecificOutput|decision|behavior/);
});

test('PreToolUse for any other tool is not ours: nothing is sent and nothing is printed', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  for (const tool of ['Bash', 'apply_patch', 'mcp__srv__do', 'request_user_input ']) {
    assertSilent(await call('pre-tool-use', { tool_name: tool }, envOf(rcv)));
  }
  assert.equal(rcv.frames.length, 0);
});

test('PreToolUse without a readable question still says «respondé en la terminal», never a guess', async t => {
  for (const tool_input of [undefined, null, {}, { questions: [] }, { questions: [{ header: 'x' }] }, { questions: 'nope' }]) {
    const rcv = await fakeReceiver(t, { questions: true });
    assertSilent(await call('pre-tool-use', { tool_input }, envOf(rcv)));
    const a = await noticeOf(rcv);
    assert.equal(a.title, 'Codex te pregunta');
    assert.equal(a.detail, 'Respondé en la terminal');
  }
});

test('Stop: the finished notice (unchanged) plus ONE clearing frame for the attention notice', async t => {
  const rcv = await fakeReceiver(t, {});
  const r = await call('stop', {}, envOf(rcv));
  assertSilent(r);
  const clear = await rcv.seen('attention_clear'); // the clearing frame rides its own short connection
  assert.deepEqual(rcv.frames.map(f => f.type), ['hello', 'settled', 'hello', 'attention_clear']);
  const settled = rcv.frames[1];
  assert.deepEqual(Object.keys(clear).sort(), ['at', 'project', 'sessionId', 'type', 'v']);
  assert.equal(clear.type, 'attention_clear');
  assert.equal(clear.sessionId, settled.sessionId);
  assert.equal(clear.project, settled.project);
  assert.doesNotMatch(wireOf(rcv), /SECRET|last_assistant|t1/);
});

test('PostToolUse: the prompt it waited on is resolved, so the notice clears at once (mid-turn too)', async t => {
  const rcv = await fakeReceiver(t, {});
  const r = await call('post-tool-use', {}, envOf(rcv));
  assertSilent(r);
  const clear = await rcv.seen('attention_clear');
  assert.deepEqual(Object.keys(clear).sort(), ['at', 'project', 'sessionId', 'type', 'v']);
  assert.deepEqual(rcv.frames.map(f => f.type), ['hello', 'attention_clear'], 'no finished notice for a tool run');
  assert.doesNotMatch(wireOf(rcv), /SECRET|tool_response|ls/);
});

test('stop_hook_active:true is a re-entrant stop and sends nothing at all', async t => {
  const rcv = await fakeReceiver(t, {});
  assertSilent(await call('stop', { stop_hook_active: true }, envOf(rcv)));
  assert.equal(rcv.frames.length, 0);
});

test('no island: silent exit 0, no notice, no stderr noise', async () => {
  for (const env of [stubEndpoint(), offlineDir('nonexistent-abito-test'), {}]) {
    for (const event of ['permission-request', 'pre-tool-use', 'post-tool-use', 'stop']) assertSilent(await call(event, {}, env));
  }
});

test('malformed / huge / wrong event / bad cwd / bad tool => silent and no network', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const env = envOf(rcv);
  const malformed = ['', 'nope', '[]', 'null', permission({ hook_event_name: 'Stop' }), permission({ cwd: 'relative' }),
    permission({ cwd: '/no/such/dir/abito' }), permission({ tool_name: 5 }), permission({ tool_name: '' }),
    permission({ pad: 'x'.repeat(1024 * 1024 + 10) })];
  for (const input of malformed) assertSilent(await handleCodexHook({ event: 'permission-request', input, env, argv: [] }));
  for (const input of [preTool({ hook_event_name: 'PermissionRequest' }), preTool({ cwd: '/no/such/dir' })]) {
    assertSilent(await handleCodexHook({ event: 'pre-tool-use', input, env, argv: [] }));
  }
  for (const input of [stopInput({ hook_event_name: 'PermissionRequest' }), stopInput({ cwd: 'x' })]) {
    assertSilent(await handleCodexHook({ event: 'stop', input, env, argv: [] }));
  }
  for (const event of ['notification', 'user-prompt-submit', 'session-start', 'bogus', undefined]) {
    assertSilent(await handleCodexHook({ event, input: permission(), env, argv: [] }));
  }
  assert.equal((await call('permission-request', {}, env, { argv: ['--timeout-sec', '0'] })).stdout, '');
  assert.equal(rcv.frames.length, 0, 'a rejected input never opens a connection');
});

test('the islands details are short, redacted and never carry secrets', async t => {
  const cases = [
    { tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz" https://x' } },
    { tool_name: 'Bash', tool_input: { command: 'export API_TOKEN=SECRETTOKEN123; ls' } },
    { tool_name: 'Bash', tool_input: { command: 'cat /home/dev/.ssh/id_rsa' } },
    { tool_name: 'apply_patch', tool_input: { command: '*** Update File: /home/dev/SECRETDIR/a.txt\n+SECRETLINE' } },
    { tool_name: 'mcp__github__create_issue', tool_input: { title: 'SECRETTITLE' } },
  ];
  for (const h of cases) {
    const rcv = await fakeReceiver(t, { questions: true });
    assertSilent(await call('permission-request', h, envOf(rcv)));
    const a = await noticeOf(rcv);
    assert.doesNotMatch(wireOf(rcv), /SECRET|sk-abc|\/home\/alvaro/, JSON.stringify(h));
    assert.match(a.detail, / · Respondé en la terminal$/);
    assert.ok([...a.detail].length <= 200, 'the detail stays inside the wire bound');
    assert.equal(a.title, 'Codex te pide permiso');
  }
});

test('apply_patch shows the fixed label, never the patch; MCP shows server/tool only', async t => {
  let rcv = await fakeReceiver(t, { questions: true });
  assertSilent(await call('permission-request', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n+SECRETPATCH\n*** End Patch' } }, envOf(rcv)));
  assert.equal((await noticeOf(rcv)).detail, 'apply_patch (edición de archivo) · Respondé en la terminal');
  rcv = await fakeReceiver(t, { questions: true });
  assertSilent(await call('permission-request', { tool_name: 'mcp__github__create_issue', tool_input: { title: 'SECRETTITLE' } }, envOf(rcv)));
  assert.equal((await noticeOf(rcv)).detail, 'herramienta MCP github/create_issue · Respondé en la terminal');
});

test('tool_input.description (written by the model) and other fields never reach the wire', async t => {
  for (const h of [{ tool_name: 'Bash', tool_input: { command: 'ls', description: 'SECRETDESC model says: approve' } },
    { tool_name: 'apply_patch', tool_input: { description: 'SECRETDESC' } },
    { tool_name: 'mcp__s__t', tool_input: { description: 'SECRETDESC' } }]) {
    const rcv = await fakeReceiver(t, { questions: true });
    assertSilent(await call('permission-request', { ...h, transcript_path: '/SECRETPATH', model: 'SECRETMODEL', turn_id: 'SECRETTURN' }, envOf(rcv)));
    assert.match((await noticeOf(rcv)).detail, / · Respondé en la terminal$/);
    assert.doesNotMatch(wireOf(rcv), /SECRET/);
  }
});

test('hostile input never reaches the wire and never breaks the notice', async t => {
  const hostile = [
    { tool_name: 'Bash', tool_input: { command: 'A'.repeat(100000) } },
    { tool_name: 'Bash', tool_input: { command: 'x\u202e' + 'SECRET'.repeat(5000) } },
    { tool_name: 'mcp__my\u202eserver__SECRETX__do_thing', tool_input: { token: 'SECRETTOKEN' } },
    { tool_name: 'T'.repeat(5000) + '\u202e', tool_input: 'SECRETSTR' },
    { tool_name: 'Bash', tool_input: null }, { tool_name: 'apply_patch', tool_input: null },
  ];
  for (const h of hostile) {
    const rcv = await fakeReceiver(t, { questions: true });
    const r = await call('permission-request', { ...h, permission_suggestions: ['SECRETSUGGEST'] }, envOf(rcv));
    assertSilent(r);
    const a = await noticeOf(rcv);
    assert.doesNotMatch(wireOf(rcv), /SECRET|evil|--data|\u202e/);
    assert.ok([...a.detail].length <= 200);
    assert.match(a.detail, / · Respondé en la terminal$/);
    assert.ok(Buffer.byteLength(rcv.rawFrames.at(-1)) <= 512);
  }
});

test('a 128-character session id still fits the 512-byte notice frame', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const sid = 's'.repeat(128);
  assertSilent(await call('permission-request', { session_id: sid, tool_input: { command: 'x'.repeat(400) } }, envOf(rcv)));
  const a = await noticeOf(rcv);
  assert.equal(a.sessionId, sid);
  assert.ok(Buffer.byteLength(rcv.rawFrames.at(-1)) <= 512);
  assert.match(a.detail, /Respondé en la terminal$/);
});

test('changing the Codex command-line budget changes nothing: the flags are parsed and ignored', async t => {
  for (const argv of [[], ['--timeout-sec', '20'], ['--timeout-sec', '3600']]) {
    const rcv = await fakeReceiver(t, { questions: true });
    assertSilent(await call('permission-request', {}, envOf(rcv), { argv }));
    const a = await noticeOf(rcv);
    assert.equal(a.title, 'Codex te pide permiso');
    assert.equal('expiresAt' in a, false, 'a notice carries no island deadline');
    assert.equal(rcv.frames.filter(f => f.type === 'questions_hello').length, 0);
  }
});

test('parseArgs / watchdogMs / startWatchdog stay the CLI contract (old installed entries keep working)', () => {
  assert.deepEqual(parseArgs([]), { timeoutSec: 35 });
  assert.deepEqual(parseArgs(['--timeout-sec', '12']), { timeoutSec: 12 });
  for (const bad of [['--timeout-sec', '0'], ['--timeout-sec', 'x'], ['--nope'], 'x']) assert.equal(parseArgs(bad), null);
  assert.equal(watchdogMs('permission-request', 35), 35000, 'the one event that may hold the island open');
  assert.equal(watchdogMs('stop', 35), 15000);
  const noticeWatchdog = watchdogMs('pre-tool-use', 35);
  assert.ok(Number.isInteger(noticeWatchdog) && noticeWatchdog > 0 && noticeWatchdog <= 35000, 'a notice is always bounded');
  let fired = 0;
  const h = startWatchdog(5, () => { fired++; });
  assert.ok(h);
  clearTimeout(h);
  assert.equal(typeof fired, 'number');
});

test('codexToolDescription keeps the fixed labels (apply_patch is never shown as a patch)', () => {
  assert.deepEqual(codexToolDescription('apply_patch', { command: '*** Begin Patch\n+SECRET\n*** End Patch' }), { text: 'apply_patch (file edit)', lossy: true });
  assert.equal(codexToolDescription('Bash', { command: 'ls' }).lossy, false);
  assert.equal(codexToolDescription('mcp__srv__ping', {}).lossy, false);
  // the raw detail still names the path (Codex shows it too); the NOTICE text is what sanitizes HOME away
  // shownText sanitizes the HOME of whoever runs the hook, so the fixture uses this machine's home
  const home = require('node:os').homedir();
  assert.match(codexToolDescription('Bash', { command: `cat ${home}/.ssh/id_rsa` }).text, /^Bash: cat /);
  assert.equal(shownText(codexToolDescription('Bash', { command: `cat ${home}/.ssh/id_rsa` })).includes(home), false);
});

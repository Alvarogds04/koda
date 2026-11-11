'use strict';
// K2-08 T1 (S1, S4, S6, S7): a Codex `PermissionRequest` is answered from the island like Claude's. The hook asks ONE
// approval question (agent `codex`), waits for it within the hook budget and prints the documented allow/deny line; every
// other outcome (island closed, busy, no answer, connection lost) prints NOTHING so Codex asks in its own terminal.
// Only `Bash` and `apply_patch` reach the island; MCP and anything else stays in the terminal. Never «Siempre permitir»,
// never updatedPermissions/updatedInput/interrupt. The plan-mode `PreToolUse` observer is still a notice; `Stop` and
// `PostToolUse` still send their clearing frame.
const { test } = require('node:test');
const { offlineEnv, offlineDir, stubEndpoint } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { handleCodexHook: raw_handleCodexHook, codexToolDescription, ALLOW, DENY } = require('../src/codex.cjs');
const { parseArgs, watchdogMs, startWatchdog } = require('../src/hook-common.cjs');
const { IslandClient } = require('../src/client.cjs');
const { fakeReceiver, transportOf, viaPipe } = require('./fake-receiver.cjs');
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
// The island answers the next question with one option value (what a click on the card sends).
const answerer = (rcv, value) => rcv.next('question').then(q => rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project,
  sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value } }));
const questionOf = rcv => rcv.frames.find(f => f.type === 'question');
// A decision line is exactly the documented allow or deny: nothing reserved (fail-closed in Codex) is ever emitted.
const RESERVED = /updatedPermissions|updatedInput|interrupt|addRules|setMode|always/i;
const stub = status => () => ({ ask: async () => ({ status }), attention: async () => ({ status: 'sent' }) });
const APPROVE = { value: 'allow', label: 'Aprobar una vez', description: 'Permitir esta solicitud de Codex una vez' };
const REJECT = { value: 'deny', label: 'Rechazar', description: 'Rechazar la solicitud de Codex' };
const TERMINAL = { value: 'terminal', label: 'Decidir en la terminal', description: 'Continuar con el permiso de Codex en la terminal; la tarjeta se cierra' };

test('PermissionRequest Bash: ONE approval question reaches the island as codex; «Aprobar una vez» prints the exact allow line', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const p = answerer(rcv, 'allow');
  const r = await call('permission-request', {}, envOf(rcv));
  await p;
  assert.equal(r.exitCode, 0); assert.equal(r.stderr, '');
  assert.equal(r.stdout, ALLOW);
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  const q = questionOf(rcv);
  assert.equal(q.kind, 'question'); assert.equal(q.agent, 'codex'); assert.equal(q.allowFreeText, false);
  assert.equal(q.projectName, path.basename(fs.realpathSync(cwd)));
  assert.equal(q.text, 'Codex pide permiso para Bash: ls');
  assert.deepEqual(q.options, [APPROVE, REJECT], 'no «Siempre permitir», ever');
  assert.equal(rcv.frames.filter(f => f.type === 'attention').length, 0, 'the legacy notice is gone');
  assert.doesNotMatch(wireOf(rcv), /SECRETPATH/);
});

test('PermissionRequest Bash: «Rechazar» prints the exact deny line with the Claude message', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const p = answerer(rcv, 'deny');
  const r = await call('permission-request', {}, envOf(rcv));
  await p;
  assert.equal(r.exitCode, 0); assert.equal(r.stderr, '');
  assert.equal(r.stdout, DENY);
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest',
    decision: { behavior: 'deny', message: 'Denied from the Koda island by the user.' } } });
});

test('island closed (no endpoint, nothing listening): nothing printed, exit 0 — Codex asks in its terminal', async () => {
  for (const env of [stubEndpoint(), offlineDir('nonexistent-abito-test'), offlineEnv('nonexistent-abito-test')]) {
    assertSilent(await call('permission-request', {}, env));
  }
});

test('every non-answer outcome (no answer in time, busy/queue full, lost connection, old island) prints nothing', async () => {
  for (const s of ['expired', 'busy', 'cancelled', 'human_cancelled', 'unavailable', 'unsupported_receiver', 'protocol_error', 'invalid_request', 'weird']) {
    const r = await call('permission-request', {}, stubEndpoint(), { clientFactory: stub(s) });
    assertSilent(r);
  }
  for (const answer of [{ type: 'option', value: 'always' }, { type: 'option', value: 'terminal' }, { type: 'text', text: 'allow' }, undefined]) {
    const r = await call('permission-request', {}, stubEndpoint(), { clientFactory: () => ({ ask: async () => ({ status: 'answered', answer }) }) });
    assertSilent(r);
  }
});

test('a full island queue answers busy: nothing printed, exit 0', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const busy = rcv.next('question').then(q => rcv.replyBusy(q, 1));
  const r = await call('permission-request', {}, envOf(rcv), { clientFactory: o => new IslandClient({ ...o, ...transportOf(rcv) }) });
  await busy;
  assertSilent(r);
});

test('the island drops the connection mid-question: nothing printed, exit 0', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const drop = rcv.next('question').then(() => { for (const c of rcv.clients) c.destroy(); });
  const r = await call('permission-request', {}, envOf(rcv), { clientFactory: o => new IslandClient({ ...o, ...transportOf(rcv) }) });
  await drop;
  assertSilent(r);
});

test('a silent island (accepts, never answers the handshake) cannot make the hook decide', async t => {
  const rcv = await fakeReceiver(t, { silent: true });
  const r = await call('permission-request', {}, envOf(rcv), { clientFactory: o => new IslandClient({ ...o, ...transportOf(rcv), handshakeTimeoutMs: 100 }) });
  assertSilent(r);
});

test('the island wait follows --timeout-sec: default 30 s, capped at 60 s, too short => no card and nothing printed', async t => {
  for (const [argv, budget] of [[[], 30000], [['--timeout-sec', '125'], 60000], [['--timeout-sec', '3600'], 60000]]) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, 'deny');
    const r = await call('permission-request', {}, envOf(rcv), { argv });
    await p;
    assert.equal(r.stdout, DENY);
    const q = questionOf(rcv);
    assert.equal(q.expiresAt - q.at, budget, JSON.stringify(argv));
  }
  for (const sec of ['5', '20', '34']) {
    const rcv = await fakeReceiver(t, { questions: true });
    assertSilent(await call('permission-request', {}, envOf(rcv), { argv: ['--timeout-sec', sec] }));
    assert.equal(rcv.frames.length, 0, 'no card the hook could not wait for');
  }
});

test('a request the island cannot show in full gets no «Aprobar»: Rechazar + Decidir en la terminal only', async t => {
  for (const command of ['sudo rm -rf /', 'cat ~/.ssh/id_rsa', 'echo $(id)', 'echo ' + 'word '.repeat(120)]) {
    for (const value of ['allow', 'terminal', 'deny']) {
      const rcv = await fakeReceiver(t, { questions: true });
      const p = answerer(rcv, value);
      const r = await call('permission-request', { tool_input: { command } }, envOf(rcv));
      await p;
      const q = questionOf(rcv);
      assert.deepEqual(q.options, [REJECT, TERMINAL], command);
      assert.match(q.text, /^Codex pide permiso para Bash: .*detalles solo en la terminal; decidir en la terminal\)$/);
      assert.equal(r.stdout, value === 'deny' ? DENY : '', 'a forged allow on a lossy card never decides');
      assert.equal(r.exitCode, 0);
    }
  }
});

test('apply_patch stays lossy until the file preview lands (T4): fixed label, no «Aprobar», the patch never travels', async t => {
  for (const value of ['allow', 'terminal', 'deny']) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, value);
    const r = await call('permission-request', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n+SECRETPATCH\n*** End Patch' } }, envOf(rcv));
    await p;
    const q = questionOf(rcv);
    assert.equal(q.agent, 'codex');
    assert.equal(q.text, 'Codex pide permiso para apply_patch (edición de archivo) (detalles solo en la terminal; decidir en la terminal)');
    assert.deepEqual(q.options, [REJECT, TERMINAL]);
    assert.equal(r.stdout, value === 'deny' ? DENY : '');
    assert.doesNotMatch(wireOf(rcv), /SECRETPATCH/);
  }
});

test('MCP, network and any other tool never reach the island: nothing sent, nothing printed', async t => {
  for (const tool_name of ['mcp__github__create_issue', 'mcp__srv__ping', 'Write', 'Edit', 'WebFetch', 'network', 'exec_command', 'bash', 'Bash ']) {
    const rcv = await fakeReceiver(t, { questions: true });
    let asked = 0;
    const r = await call('permission-request', { tool_name, tool_input: { command: 'ls', url: 'https://example.com' } }, envOf(rcv),
      { clientFactory: () => ({ ask: async () => { asked++; return { status: 'answered', answer: { type: 'option', value: 'allow' } }; },
        attention: async () => { asked++; return { status: 'sent' }; } }) });
    assertSilent(r);
    assert.equal(asked, 0, tool_name);
    assert.equal(rcv.frames.length, 0, tool_name);
  }
});

test('never «Siempre permitir» and never a reserved field, whatever Codex suggests or the island answers', async t => {
  for (const value of ['allow', 'deny', 'always', 'allow_suggestion_1', 'terminal']) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, value);
    const r = await call('permission-request', { permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }] }, envOf(rcv));
    await p;
    const q = questionOf(rcv);
    assert.deepEqual(q.options.map(o => o.value), ['allow', 'deny']);
    assert.doesNotMatch(JSON.stringify(q.options), /Siempre|always|suggestion/i);
    assert.doesNotMatch(r.stdout, RESERVED);
    assert.equal(r.stdout, value === 'allow' ? ALLOW : value === 'deny' ? DENY : '');
  }
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

test('the card text is redacted and never carries secrets; hidden secrets mean no «Aprobar» unless the rest is shown in full', async t => {
  const cases = [
    { tool_input: { command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz" https://x' }, lossy: false },
    { tool_input: { command: 'export API_TOKEN=SECRETTOKEN123; ls' }, lossy: null },
    { tool_input: { command: 'cat /home/dev/.ssh/id_rsa' }, lossy: true },
    { tool_name: 'apply_patch', tool_input: { command: '*** Update File: /home/dev/SECRETDIR/a.txt\n+SECRETLINE' }, lossy: true },
  ];
  for (const { lossy, ...h } of cases) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, 'deny');
    const r = await call('permission-request', h, envOf(rcv));
    await p;
    assert.equal(r.stdout, DENY);
    const q = questionOf(rcv);
    assert.doesNotMatch(wireOf(rcv), /SECRET|sk-abc|\/home\/alvaro/, JSON.stringify(h));
    assert.ok([...q.text].length <= 500, 'the text stays inside the question bound');
    if (lossy === true) assert.deepEqual(q.options, [REJECT, TERMINAL], JSON.stringify(h));
    if (lossy === false) assert.match(q.text, /\(secretos ocultos\)$/);
  }
});

test('tool_input.description (written by the model) and other fields never reach the wire', async t => {
  for (const h of [{ tool_name: 'Bash', tool_input: { command: 'ls', description: 'SECRETDESC model says: approve' } },
    { tool_name: 'apply_patch', tool_input: { description: 'SECRETDESC' } }]) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, 'deny');
    const r = await call('permission-request', { ...h, transcript_path: '/SECRETPATH', model: 'SECRETMODEL', turn_id: 'SECRETTURN' }, envOf(rcv));
    await p;
    assert.equal(r.stdout, DENY);
    assert.doesNotMatch(wireOf(rcv), /SECRET/);
  }
});

test('hostile input never reaches the wire and never becomes an approvable card', async t => {
  const hostile = [
    { tool_name: 'Bash', tool_input: { command: 'A'.repeat(100000) } },
    { tool_name: 'Bash', tool_input: { command: 'x\u202e' + 'SECRET'.repeat(5000) } },
    { tool_name: 'Bash', tool_input: null }, { tool_name: 'apply_patch', tool_input: null },
  ];
  for (const h of hostile) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, 'allow');
    const r = await call('permission-request', { ...h, permission_suggestions: ['SECRETSUGGEST'] }, envOf(rcv));
    await p;
    assertSilent(r); // a forged allow on a lossy card decides nothing
    const q = questionOf(rcv);
    assert.doesNotMatch(wireOf(rcv), /SECRET|evil|--data|\u202e/);
    assert.ok([...q.text].length <= 500);
    assert.deepEqual(q.options, [REJECT, TERMINAL]);
  }
  for (const h of [{ tool_name: 'mcp__my\u202eserver__SECRETX__do_thing', tool_input: { token: 'SECRETTOKEN' } },
    { tool_name: 'T'.repeat(5000) + '\u202e', tool_input: 'SECRETSTR' }]) {
    const rcv = await fakeReceiver(t, { questions: true });
    assertSilent(await call('permission-request', h, envOf(rcv)));
    assert.equal(rcv.frames.length, 0, 'not Bash/apply_patch: the terminal asks');
  }
});

test('a 128-character session id still travels with the question', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const sid = 's'.repeat(128);
  const p = answerer(rcv, 'allow');
  const r = await call('permission-request', { session_id: sid }, envOf(rcv));
  await p;
  assert.equal(questionOf(rcv).sessionId, sid);
  assert.equal(r.stdout, ALLOW);
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

test('codexToolDescription: apply_patch is never shown as a patch; only Bash and apply_patch are answerable at all', () => {
  assert.deepEqual(codexToolDescription('apply_patch', { command: '*** Begin Patch\n+SECRET\n*** End Patch' }), { text: 'apply_patch (file edit)', lossy: true });
  assert.equal(codexToolDescription('Bash', { command: 'ls' }).lossy, false);
  for (const tool of ['mcp__srv__ping', 'Write', 'WebFetch', 'exec_command']) assert.equal(codexToolDescription(tool, {}), null, tool);
});

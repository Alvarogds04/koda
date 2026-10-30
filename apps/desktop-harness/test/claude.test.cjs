'use strict';
const { test } = require('node:test');
const { offlineEnv, offlineDir, stubEndpoint } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { handleClaudeHook: raw_handleClaudeHook, parseArgs, watchdogMs, startWatchdog, ALLOW, DENY } = require('../src/claude.cjs');
const { fakeReceiver, transportOf, viaPipe } = require('./fake-receiver.cjs');
const handleClaudeHook = viaPipe(raw_handleClaudeHook);

const cwd = path.resolve(__dirname, '..');
const permission = (over = {}) => JSON.stringify({ session_id: 'sess-1', transcript_path: '/home/x/SECRETPATH/t.jsonl', cwd,
  permission_mode: 'default', hook_event_name: 'PermissionRequest', tool_name: 'Bash',
  tool_input: { command: 'ls' }, ...over });
const stopInput = (over = {}) => JSON.stringify({ session_id: 'sess-1', cwd, hook_event_name: 'Stop', stop_hook_active: false,
  last_assistant_message: 'SECRETREPLY', ...over });
// An empty env would resolve the REAL default runtime (/run/user/<uid>/abito-island) and could reach the live island.
const NO_ISLAND = offlineDir('nonexistent-abito-test');
const envOf = r => ({ ABITO_DESKTOP_SOCKET: r.endpoint, ABITO_SOCKET_DIR: r.runtime });
const stub = status => () => ({ ask: async () => ({ status }), notify: async () => ({ status: 'sent' }) });
function assertOut(r) { assert.equal(r.exitCode, 0); assert.ok(r.stdout === '' || (/\n$/.test(r.stdout) && r.stdout.trim().split('\n').length === 1 && JSON.parse(r.stdout))); }
const settle = async rcv => { for (let i = 0; i < 40 && !rcv.frames.some(f => f.type === 'settled'); i++) await new Promise(r => setTimeout(r, 25)); };
const answerer = (rcv, value) => rcv.next('question').then(q => rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project,
  sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value } }));

test('parseArgs validates --timeout-sec', () => {
  assert.deepEqual(parseArgs([]), { timeoutSec: 35 });
  assert.deepEqual(parseArgs(['--timeout-sec', '20']), { timeoutSec: 20 });
  for (const bad of [['--timeout-sec'], ['--timeout-sec', '0'], ['--timeout-sec', '3601'], ['--timeout-sec', '1.5'], ['--timeout-sec', 'x'], ['--x'], ['--timeout-sec', '-1']]) {
    assert.equal(parseArgs(bad), null);
  }
});
test('allow => exact allow JSON; deny => exact deny JSON', async t => {
  for (const [value, expected] of [['allow', ALLOW], ['deny', DENY]]) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, value);
    const r = await handleClaudeHook({ event: 'permission-request', input: permission(), env: envOf(rcv), argv: [] });
    await p; assertOut(r);
    assert.equal(r.stdout, expected); assert.equal(r.stderr, '');
  }
  assert.deepEqual(JSON.parse(ALLOW), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(JSON.parse(DENY), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from the Koda island by the user.' } } });
});
test('question frame: kind question, two options, 30 s budget, short text', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const p = answerer(rcv, 'allow');
  await handleClaudeHook({ event: 'permission-request', input: permission(), env: envOf(rcv), argv: [] });
  await p;
  const q = rcv.frames.find(f => f.type === 'question');
  assert.equal(q.kind, 'question'); assert.equal(q.expiresAt - q.at, 30000); assert.equal(q.allowFreeText, false);
  assert.deepEqual(q.options, [{ value: 'allow', label: 'Aprobar una vez', description: 'Permitir esta solicitud de Claude Code una vez' },
    { value: 'deny', label: 'Rechazar', description: 'Rechazar la solicitud de Claude' }]);
  assert.equal(q.text, 'Claude Code pide permiso para Bash: ls');
});
test('--timeout-sec 20 => no question, empty; 34 too', async t => {
  for (const sec of ['20', '34']) {
    const rcv = await fakeReceiver(t, { questions: true });
    const r = await handleClaudeHook({ event: 'permission-request', input: permission(), env: envOf(rcv), argv: ['--timeout-sec', sec] });
    assertOut(r); assert.equal(r.stdout, ''); assert.equal(rcv.frames.length, 0);
  }
});
test('every non-answer status => empty stdout, exit 0, no content on stderr', async () => {
  for (const s of ['expired', 'busy', 'cancelled', 'human_cancelled', 'unavailable', 'unsupported_receiver', 'protocol_error', 'invalid_request', 'weird']) {
    const r = await handleClaudeHook({ event: 'permission-request', input: permission(), env: stubEndpoint(), argv: [], clientFactory: stub(s) });
    assertOut(r); assert.equal(r.stdout, ''); assert.doesNotMatch(r.stderr, /SECRET|Bash|ls/);
  }
  const u = await handleClaudeHook({ event: 'permission-request', input: permission(), env: NO_ISLAND, argv: [], clientFactory: stub('unavailable') });
  assert.equal(u.stdout, '');
});
test('answer that is not allow/deny, or status answered with text => empty', async () => {
  for (const answer of [{ type: 'option', value: 'always' }, { type: 'text', text: 'allow' }, undefined]) {
    const r = await handleClaudeHook({ event: 'permission-request', input: permission(), env: stubEndpoint('x'), argv: [],
      clientFactory: () => ({ ask: async () => ({ status: 'answered', answer }) }) });
    assert.equal(r.stdout, '');
  }
});
test('no endpoint / old receiver / unavailable transport => empty with generic stderr', async t => {
  let r = await handleClaudeHook({ event: 'permission-request', input: permission(), env: NO_ISLAND, argv: [] });
  assertOut(r); assert.equal(r.stdout, '');
  const old = await fakeReceiver(t, { questions: false });
  r = await handleClaudeHook({ event: 'permission-request', input: permission(), env: envOf(old), argv: [],
    clientFactory: o => new (require('../src/client.cjs').IslandClient)({ ...o, ...transportOf(old), handshakeTimeoutMs: 100 }) });
  assertOut(r); assert.equal(r.stdout, '');
  const un = await handleClaudeHook({ event: 'permission-request', input: permission(), env: envOf(old), argv: [], clientFactory: stub('unavailable') });
  assert.match(un.stderr, /^Koda island unavailable\. Answer in the terminal\.\n$/);
});
test('malformed / huge / wrong event / bad cwd / bad tool => empty and no network', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const env = envOf(rcv);
  const cases = ['', 'nope', '[]', '"x"', 'null', permission({ hook_event_name: 'Stop' }), permission({ hook_event_name: undefined }),
    permission({ cwd: 'relative/dir' }), permission({ cwd: '/no/such/dir/abito' }), permission({ cwd: undefined }), permission({ tool_name: 5 }),
    permission({ pad: 'x'.repeat(1024 * 1024 + 10) })];
  for (const input of cases) {
    const r = await handleClaudeHook({ event: 'permission-request', input, env, argv: [] });
    assertOut(r); assert.equal(r.stdout, '');
  }
  for (const event of ['notification', 'bogus', undefined]) {
    const r = await handleClaudeHook({ event, input: permission(), env, argv: [] });
    assert.equal(r.stdout, '');
  }
  assert.equal((await handleClaudeHook({ event: 'permission-request', input: permission(), env, argv: ['--timeout-sec', '0'] })).stdout, '');
  assert.equal(rcv.frames.length, 0);
});
test('hostile input and raw permission_suggestions never reach the wire (only validated derived options may)', async t => {
  const hostile = [
    { tool_name: 'Bash', tool_input: { command: 'A'.repeat(100000) } },
    { tool_name: 'Write', tool_input: { file_path: '/home/dev/SECRETDIR/\u202egpj.exe', content: 'SECRETCONTENT' } },
    { tool_name: 'Edit', tool_input: { file_path: '/very/' + 'x'.repeat(5000) + '/SECRETDIR/file.txt', old_string: 'SECRETOLD' } },
    { tool_name: 'mcp__my\u202eserver__SECRETX__do_thing', tool_input: { token: 'SECRETTOKEN' } },
    { tool_name: 'T'.repeat(5000) + '\u202e', tool_input: 'SECRETSTR' },
    { tool_name: 'Bash', tool_input: null },
  ];
  for (const h of hostile) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, 'deny');
    const r = await handleClaudeHook({ event: 'permission-request', env: envOf(rcv), argv: [],
      input: permission({ ...h, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'SECRETSUGGEST' }] }], mcp_server: 'SECRETMCP' }) });
    await p; assertOut(r); assert.equal(r.stdout, DENY);
    const wire = rcv.rawFrames.join('');
    const q = rcv.frames.find(f => f.type === 'question');
    assert.doesNotMatch(wire, /permission_suggestions|updatedPermissions|SECRET|evil|curl https|--data|home\/alvaro|\u202e/);
    assert.ok([...q.text].length <= 500); assert.ok(Buffer.byteLength(rcv.rawFrames.find(x => x.includes('"question"') && x.includes('kind'))) <= 4096);
    assert.match(q.text, /^Claude Code pide permiso para .*\ \(.*detalles solo en la terminal; decidir en la terminal\)$/);
    assert.deepEqual(q.options.map(o => o.value), ['deny', 'terminal']);
  }
});
test('MCP tool shows server/last segment only (lossy: terminal decides)', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const p = answerer(rcv, 'deny');
  await handleClaudeHook({ event: 'permission-request', env: envOf(rcv), argv: [], input: permission({ tool_name: 'mcp__github__repos__create_issue' }) });
  await p;
  assert.equal(rcv.frames.find(f => f.type === 'question').text, 'Claude Code pide permiso para herramienta MCP github/create_issue (detalles solo en la terminal; decidir en la terminal)');
});
const LOSSY = [{ tool_name: 'Bash', tool_input: { command: 'sudo rm -rf /' } }, { tool_name: 'Write', tool_input: { file_path: '/etc/passwd', content: 'x' } },
  { tool_name: 'mcp__srv__do', tool_input: { a: 1 } }, { tool_name: 'Mystery', tool_input: { a: 1 } }];
test('lossy request: wire offers only deny/terminal, never allow', async t => {
  for (const h of LOSSY) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, 'deny');
    const r = await handleClaudeHook({ event: 'permission-request', env: envOf(rcv), argv: [], input: permission(h) });
    await p; assert.equal(r.stdout, DENY);
    const q = rcv.frames.find(f => f.type === 'question');
    assert.deepEqual(q.options, [{ value: 'deny', label: 'Rechazar', description: 'Rechazar la solicitud de Claude' },
      { value: 'terminal', label: 'Decidir en la terminal', description: 'Continuar con el permiso de Claude Code en la terminal; la tarjeta se cierra' }]);
    assert.match(q.text, /^Claude Code pide permiso para .+\ \(.*detalles solo en la terminal; decidir en la terminal\)$/);
  }
});
test('lossy request answered terminal => empty stdout, no decision', async t => {
  for (const h of LOSSY) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, 'terminal');
    const r = await handleClaudeHook({ event: 'permission-request', env: envOf(rcv), argv: [], input: permission(h) });
    await p; assertOut(r); assert.equal(r.stdout, '');
  }
});
test('receiver forging unoffered allow on a lossy question => empty stdout', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const p = answerer(rcv, 'allow');
  const r = await handleClaudeHook({ event: 'permission-request', env: envOf(rcv), argv: [], input: permission(LOSSY[0]) });
  await p; assertOut(r); assert.equal(r.stdout, '');
});
test('lossless request still offers allow/deny', async t => {
  for (const h of [{ tool_name: 'Bash', tool_input: { command: 'ls' } }, { tool_name: 'mcp__srv__ping', tool_input: {} }]) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, 'allow');
    const r = await handleClaudeHook({ event: 'permission-request', env: envOf(rcv), argv: [], input: permission(h) });
    await p; assert.equal(r.stdout, ALLOW);
    assert.deepEqual(rcv.frames.find(f => f.type === 'question').options.map(o => o.value), ['allow', 'deny']);
  }
});
test('hook island wait is capped at 60 s regardless of --timeout-sec', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const p = answerer(rcv, 'deny');
  await handleClaudeHook({ event: 'permission-request', env: envOf(rcv), argv: ['--timeout-sec', '3600'], input: permission() });
  await p;
  const q = rcv.frames.find(f => f.type === 'question');
  assert.equal(q.expiresAt - q.at, 60000);
});
test('stop: one settled frame; none when stop_hook_active; last_assistant_message never sent', async t => {
  let rcv = await fakeReceiver(t, {});
  let r = await handleClaudeHook({ event: 'stop', input: stopInput(), env: envOf(rcv), argv: [] });
  assertOut(r); assert.equal(r.stdout, '');
  await settle(rcv);
  assert.deepEqual(rcv.frames.map(f => f.type), ['hello', 'settled']);
  assert.doesNotMatch(rcv.rawFrames.join(''), /SECRET|last_assistant/);
  rcv = await fakeReceiver(t, {});
  r = await handleClaudeHook({ event: 'stop', input: stopInput({ stop_hook_active: true }), env: envOf(rcv), argv: [] });
  assert.equal(r.stdout, ''); assert.equal(rcv.frames.length, 0);
  r = await handleClaudeHook({ event: 'stop', input: stopInput({ hook_event_name: 'PermissionRequest' }), env: envOf(rcv), argv: [] });
  assert.equal(r.stdout, ''); assert.equal(rcv.frames.length, 0);
});
test('watchdog: permission-request exits at the hook timeout; stop at 15 s; timer unref', () => {
  assert.equal(watchdogMs('permission-request', 60), 60000); assert.equal(watchdogMs('stop', 60), 15000);
  let fired = 0, unref = false, ms;
  startWatchdog(60000, () => { fired++; }, (fn, m) => { ms = m; fn(); return { unref: () => { unref = true; } }; });
  assert.equal(fired, 1); assert.ok(unref); assert.equal(ms, 60000);
});

const NOINPUT = [undefined, null, [], 'x', 5, {}, { a: 1 }];
test('consent gap: MCP with non-object/missing input and non-MCP tools are lossy on the wire', async t => {
  const cases = [];
  for (const i of NOINPUT.filter(x => !(x && typeof x === 'object' && !Array.isArray(x) && !Object.keys(x).length))) cases.push({ tool_name: 'mcp__a__b', tool_input: i });
  for (const n of ['WebFetch', 'Grep', 'Task']) for (const i of NOINPUT) cases.push({ tool_name: n, tool_input: i });
  for (const h of cases) {
    for (const value of ['deny', 'allow']) {
      const rcv = await fakeReceiver(t, { questions: true });
      const p = answerer(rcv, value);
      const r = await handleClaudeHook({ event: 'permission-request', env: envOf(rcv), argv: [], input: permission(h) });
      await p;
      const q = rcv.frames.find(f => f.type === 'question');
      assert.deepEqual(q.options.map(o => o.value), ['deny', 'terminal'], JSON.stringify(h));
      assert.equal(r.stdout, value === 'deny' ? DENY : '', JSON.stringify(h));
    }
  }
});

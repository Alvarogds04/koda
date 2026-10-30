'use strict';
// Windows notice-client integration (T2/S3/S6): the hook clients never open the
// island's named pipe directly — they spawn the native stdio relay
// `abito-notice-relay.exe` (fixed installed sibling path) with the endpoint
// metadata path, and speak the exact same framing over the child's stdio.
// These tests run on Linux with explicit platform/spawn seams; they never
// contact a live island and never depend on PATH or env-chosen executables.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { IslandClient, formatNoDecision } = require('../src/client.cjs');
const { resolveConfig } = require('../src/config.cjs');
const { verifyEndpoint } = require('../src/security.cjs');
const { createWindowsConnection, relayCandidates, findRelay, RELAY_NAME } = require('../src/windows-transport.cjs');
const { projectId, sessionToken } = require('../src/identity.cjs');

const cwd = path_cwd();
function path_cwd() { return require('node:path').resolve(__dirname, '..'); }
const META = 'C:\\Users\\u\\AppData\\Local\\Abito\\notices\\endpoint.json';
const RUNTIME = 'C:\\Users\\u\\AppData\\Local\\Abito\\notices';
const LOCAL = 'C:\\Users\\u\\AppData\\Local';
const OPTS = [{ value: 'yes', label: 'SECRETLABEL yes', description: '' }, { value: 'no', label: 'No', description: 'd' }];
const REQ = { text: 'SECRETQUESTION proceed?', options: OPTS, timeoutMs: 30000 };

// A controllable fake relay child: the same surface child_process.spawn returns.
function fakeRelayChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); };
  return child;
}

// --- config (Windows branch) ------------------------------------------------

test('windows config: canonical LOCALAPPDATA metadata endpoint, no uid, no /proc', () => {
  const stat = p => p.endsWith('endpoint.json') ? { isFile: () => true, isSymbolicLink: () => false } : (() => { throw new Error('missing'); })();
  assert.deepEqual(resolveConfig({ LOCALAPPDATA: LOCAL }, undefined, { platform: 'win32', stat }),
    { runtime: `${RUNTIME}`, endpoint: META, source: 'handoff' });
  // uid is ignored on Windows: garbage owner values must not throw
  for (const owner of [undefined, NaN, -1, 'x']) {
    assert.equal(resolveConfig({ LOCALAPPDATA: LOCAL }, owner, { platform: 'win32', stat }).endpoint, META);
  }
});
test('windows config: missing or unreadable metadata is the no-island case (endpoint undefined)', () => {
  const missing = () => { throw Object.assign(new Error('enoent'), { code: 'ENOENT' }); };
  assert.deepEqual(resolveConfig({ LOCALAPPDATA: LOCAL }, undefined, { platform: 'win32', stat: missing }),
    { runtime: RUNTIME, endpoint: undefined, source: undefined });
  // a directory or symlink in the metadata slot is refused, never returned
  assert.equal(resolveConfig({ LOCALAPPDATA: LOCAL }, undefined, { platform: 'win32', stat: () => ({ isFile: () => false, isSymbolicLink: () => false }) }).endpoint, undefined);
  assert.equal(resolveConfig({ LOCALAPPDATA: LOCAL }, undefined, { platform: 'win32', stat: () => ({ isFile: () => true, isSymbolicLink: () => true }) }).endpoint, undefined);
});
test('windows config: no LOCALAPPDATA or a non-drive path yields no endpoint, never throws', () => {
  for (const local of [undefined, '', 'relative', 'C:', '\\\\srv\\share', 'C:\\with\0nul']) {
    assert.equal(resolveConfig({ LOCALAPPDATA: local }, undefined, { platform: 'win32', stat: () => { throw new Error('x'); } }).endpoint, undefined, String(local));
  }
});
test('windows config: explicit ABITO_DESKTOP_SOCKET override keeps the relay metadata shape', () => {
  const cfg = resolveConfig({ ABITO_DESKTOP_SOCKET: 'C:\\elsewhere\\endpoint.json' }, undefined, { platform: 'win32' });
  assert.deepEqual(cfg, { runtime: 'C:\\elsewhere', endpoint: 'C:\\elsewhere\\endpoint.json', source: 'env' });
  for (const bad of ['', 'relative\\endpoint.json', 'C:\\x\\other.json', 'C:\\x\\endpoint.json\\', 'C:\\x\\end\\point.json',
    '\\\\srv\\share\\endpoint.json', 'C:\\x\0\\endpoint.json', 'C:\\x\\..\\endpoint.json']) {
    assert.throws(() => resolveConfig({ ABITO_DESKTOP_SOCKET: bad }, undefined, { platform: 'win32' }), bad);
  }
});
test('linux config behaviour is unchanged (same function, default platform)', { skip: process.platform === 'win32' && 'Unix path rules use the host path module; the win32 rules are the tests above' }, () => {
  assert.deepEqual(resolveConfig({}, 4321, { procExists: () => false, platform: process.platform === 'darwin' ? 'darwin' : 'linux' }),
    { runtime: process.platform === 'darwin' ? require('node:fs').realpathSync(require('node:os').tmpdir()) + '/abito-island' : '/run/user/4321/abito-island', endpoint: undefined, source: undefined });
  assert.throws(() => resolveConfig({ ABITO_SOCKET_DIR: '/nonexistent/abito-windows-test' }, undefined, { platform: 'linux' }));
});

// --- security (Windows branch) ----------------------------------------------

test('windows verifyEndpoint: metadata shape + runtime binding, no unix socket checks', () => {
  const win = { platform: 'win32' };
  assert.deepEqual(verifyEndpoint(META, RUNTIME, win), { dev: 0, ino: 0 });
  assert.deepEqual(verifyEndpoint('C:\\elsewhere\\endpoint.json', 'C:\\elsewhere', win), { dev: 0, ino: 0 });
  for (const [endpoint, runtime] of [['C:\\x\\other.json', 'C:\\x'], [META, 'C:\\wrong\\runtime'], ['relative\\endpoint.json', '.']]) {
    assert.throws(() => verifyEndpoint(endpoint, runtime, win), `${endpoint} ${runtime}`);
  }
});
test('linux verifyEndpoint behaviour is unchanged (default platform)', () => {
  assert.throws(() => verifyEndpoint('/run/user/1000/abito-island/p-abc123/s', '/run/user/1000/abito-island', { platform: 'linux' }));
});

// --- relay adapter (windows-transport) --------------------------------------

test('relay candidates are fixed sibling locations, never PATH or env-chosen executables', () => {
  const candidates = relayCandidates({ LOCALAPPDATA: LOCAL });
  assert.ok(candidates.length >= 2);
  // installed sibling (this file ships at <install>/desktop-harness/src)
  assert.ok(candidates.includes(require('node:path').resolve(__dirname, '..', '..', RELAY_NAME)));
  // canonical installed location derived only from LOCALAPPDATA
  assert.ok(candidates.includes(`${LOCAL}\\Programs\\abito-island\\${RELAY_NAME}`));
  // development/CI build location, fixed
  assert.ok(candidates.includes(require('node:path').resolve(__dirname, '..', '..', 'desktop-tauri', 'target', 'debug', RELAY_NAME)));
  // no env knob can inject a candidate
  for (const env of [{ PATH: '\\evil', ABITO_RELAY: 'C:\\evil\\x.exe', LOCALAPPDATA: LOCAL }, { LOCALAPPDATA: 'C:\\other' }]) {
    for (const c of relayCandidates(env)) assert.doesNotMatch(c, /evil/);
  }
  assert.equal(relayCandidates({}).length, 2, 'no LOCALAPPDATA: installed sibling + dev build only');
});
test('findRelay: first existing regular file wins; a directory or symlink is refused; none -> undefined', () => {
  const calls = [];
  const stat = p => { calls.push(p); if (calls.length === 1) throw new Error('enoent'); if (calls.length === 2) return { isFile: () => false, isSymbolicLink: () => false }; return { isFile: () => true, isSymbolicLink: () => false }; };
  const found = findRelay({ stat, env: { LOCALAPPDATA: LOCAL } });
  assert.ok(found && found.includes(RELAY_NAME));
  assert.equal(findRelay({ stat: () => { throw new Error('enoent'); }, env: {} }), undefined);
});
test('relay adapter: spawn uses the relay with the metadata path as its only argument, windowsHidden', async () => {
  const child = fakeRelayChild();
  const spawned = [];
  const adapter = createWindowsConnection(META, { spawn: (exe, args, opts) => { spawned.push([exe, args, opts]); return child; }, findRelay: () => 'C:\\install\\abito-notice-relay.exe' });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(spawned, [['C:\\install\\abito-notice-relay.exe', [META], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }]]);
  adapter.destroy();
});
test('relay adapter: missing relay fails closed — error+close, spawn never called, no direct pipe fallback', async () => {
  const spawned = [];
  const events = [];
  const adapter = createWindowsConnection(META, { spawn: (...a) => { spawned.push(a); return fakeRelayChild(); }, findRelay: () => undefined });
  adapter.on('connect', () => events.push('connect'));
  adapter.on('error', () => events.push('error'));
  adapter.on('close', () => events.push('close'));
  adapter.on('data', () => events.push('data'));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(events, ['error', 'close']);
  assert.equal(spawned.length, 0);
});
test('relay adapter: spawn failure and nonzero exit surface as error then close (auth failure shape)', async () => {
  const child = fakeRelayChild();
  const events = [];
  const adapter = createWindowsConnection(META, { spawn: () => child, findRelay: () => 'r.exe' });
  for (const name of ['connect', 'error', 'close', 'data']) adapter.on(name, () => events.push(name));
  await new Promise(r => setImmediate(r));
  child.emit('error', new Error('EACCES'));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(events, ['error', 'close']);
  assert.equal(events.filter(e => e === 'close').length, 1);

  const child2 = fakeRelayChild();
  const events2 = [];
  const adapter2 = createWindowsConnection(META, { spawn: () => child2, findRelay: () => 'r.exe' });
  for (const name of ['connect', 'error', 'close', 'data']) adapter2.on(name, () => events2.push(name));
  await new Promise(r => setImmediate(r));
  child2.emit('spawn');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(events2, ['connect']);
  child2.emit('exit', 2); // relay refused the metadata/auth before any byte
  child2.stdout.destroy();
  await new Promise(r => setImmediate(r));
  assert.ok(events2.includes('error') && events2.includes('close'), String(events2));
  assert.equal(events2.filter(e => e === 'connect').length, 1);
});
test('relay adapter: stdio bridge — bytes flow both ways, data resets the idle timer, destroy kills the child', async () => {
  const child = fakeRelayChild();
  const seen = [], idle = [];
  const adapter = createWindowsConnection(META, { spawn: () => child, findRelay: () => 'r.exe' });
  adapter.on('connect', () => seen.push('connect'));
  adapter.on('data', chunk => seen.push(chunk));
  adapter.on('close', () => seen.push('close'));
  await new Promise(r => setImmediate(r));
  child.emit('spawn');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(seen, ['connect']);
  child.stdout.write(Buffer.from('{"v":1,"type":"ready"}\n'));
  await new Promise(r => setImmediate(r));
  assert.equal(seen[1].toString(), '{"v":1,"type":"ready"}\n');
  // writes land on the child's stdin
  const hello = new Promise(resolve => { child.stdin.on('data', resolve); });
  assert.equal(adapter.write('hello-frame\n'), true);
  assert.equal((await hello).toString(), 'hello-frame\n');
  // idle timer: armed by setTimeout, reset by data, fired when quiet
  adapter.setTimeout(20, () => idle.push('idle'));
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(idle, ['idle']);
  adapter.setTimeout(20, () => idle.push('idle2'));
  child.stdout.write('x');
  await new Promise(r => setTimeout(r, 10));
  child.stdout.write('y');
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(idle, ['idle', 'idle2'], 'traffic pushes the deadline back');
  adapter.setTimeout(0, () => idle.push('nope'));
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(idle, ['idle', 'idle2']);
  // writableLength delegates to the child's stdin
  assert.equal(adapter.writableLength, child.stdin.writableLength);
  adapter.destroy();
  assert.equal(adapter.destroyed, true);
  assert.equal(child.killed, true);
  adapter.destroy(); // idempotent
  adapter.write('after-destroy');
  assert.equal(adapter.write('after-destroy'), false);
  await new Promise(r => setImmediate(r));
  assert.ok(seen.includes('close'), 'destroy surfaces as close');
});

test('relay lookup uses lstat so a symlink cannot masquerade as the installed helper', t => {
  const fs = require('node:fs');
  const probe = t.mock.method(fs, 'lstatSync', () => ({ isFile: () => true, isSymbolicLink: () => true }));
  assert.equal(findRelay({ env: {} }), undefined);
  assert.equal(probe.mock.callCount(), 2);
});
test('synchronous spawn error is error+close, not a thrown connection failure', async () => {
  const events = [];
  const adapter = createWindowsConnection(META, { findRelay: () => 'r.exe', spawn: () => { throw Error('spawn failed'); } });
  adapter.on('error', () => events.push('error'));
  adapter.on('close', () => events.push('close'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['error', 'close']);
});

// --- client lifecycle over the relay (open seam; win32 simulated) -----------

function openWith(spawn, findRelay) {
  // The client's open seam is (endpoint, runtime); the adapter takes the deps as its second argument.
  return (endpoint, _runtime) => createWindowsConnection(endpoint, { spawn, findRelay });
}
test('windows client: notify + question lifecycle ride the relay stdio bridge', async () => {
  const child = fakeRelayChild();
  const client = new IslandClient({ endpoint: META, runtime: RUNTIME, cwd, sessionId: 'sess 1', platform: 'win32',
    agent: 'claude-code', open: openWith(() => child, () => 'C:\\install\\abito-notice-relay.exe') });
  const scope = { project: projectId(cwd), sessionId: sessionToken('sess 1') };
  const lines = [];
  child.stdin.on('data', chunk => lines.push(...chunk.toString().split('\n').filter(Boolean)));
  const notify = client.notify();
  await new Promise(r => setImmediate(r));
  child.emit('spawn');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(lines.map(l => JSON.parse(l).type), ['hello']);
  child.stdout.write('{"v":1,"type":"ready"}\n');
  const settled = await notify;
  assert.deepEqual(settled, { status: 'sent' });
  assert.deepEqual(lines.map(l => JSON.parse(l).type), ['hello', 'settled']);
  await new Promise(resolve => setImmediate(resolve)); // finish resolves before the final frame flushes
  assert.equal(child.killed, true);

  // question flow over a fresh relay child
  const child2 = fakeRelayChild();
  const lines2 = [];
  child2.stdin.on('data', chunk => lines2.push(...chunk.toString().split('\n').filter(Boolean)));
  const client2 = new IslandClient({ endpoint: META, runtime: RUNTIME, cwd, sessionId: 'sess 1', platform: 'win32',
    open: openWith(() => child2, () => 'r.exe') });
  const asking = client2.ask(REQ);
  await new Promise(r => setImmediate(r));
  child2.emit('spawn');
  await new Promise(r => setImmediate(r));
  child2.stdout.write('{"v":1,"type":"ready"}\n');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(lines2.map(l => JSON.parse(l).type), ['hello', 'questions_hello']);
  child2.stdout.write(JSON.stringify({ v: 1, type: 'questions_ready', questionVersion: 1 }) + '\n');
  await new Promise(r => setImmediate(r));
  const q = JSON.parse(lines2[2]);
  assert.equal(q.type, 'question');
  child2.stdout.write(JSON.stringify({ v: 1, type: 'answer', questionVersion: 1, ...scope, at: Date.now(), id: q.id,
    source: 'human', answer: { type: 'option', value: 'yes' } }) + '\n');
  assert.deepEqual(await asking, { status: 'answered', id: q.id, answer: { type: 'option', value: 'yes' } });
  await new Promise(resolve => setImmediate(resolve)); // acknowledgement flushes before teardown
  assert.equal(child2.killed, true);
  assert.deepEqual(q.options, OPTS, 'question options reach only the authenticated relay stream');
});
test('windows client: missing relay is exactly island-unavailable — never a direct connection, never approval', async () => {
  const diagnostics = [];
  const client = new IslandClient({ endpoint: META, runtime: RUNTIME, cwd, sessionId: 's', platform: 'win32',
    onDiagnostic: d => diagnostics.push(d), open: openWith(() => { throw new Error('must not spawn'); }, () => undefined) });
  assert.deepEqual(await client.notify(), { status: 'unavailable' });
  assert.deepEqual(await client.ask(REQ), { status: 'unavailable' });
  assert.ok(diagnostics.every(d => Object.keys(d).length === 1));
  assert.equal(formatNoDecision(await client.notify()), 'Koda island: no answer (unavailable). Answer in the terminal.');
});
test('windows client: relay auth refusal (nonzero exit, no ready) is unavailable, no fallback', async () => {
  const child = fakeRelayChild();
  const client = new IslandClient({ endpoint: META, runtime: RUNTIME, cwd, sessionId: 's', platform: 'win32',
    open: openWith(() => child, () => 'r.exe') });
  const result = client.ask(REQ);
  await new Promise(r => setImmediate(r));
  child.emit('spawn');
  await new Promise(r => setImmediate(r));
  child.emit('exit', 5); // server pid/SID mismatch
  child.stdout.destroy();
  assert.deepEqual(await result, { status: 'unavailable' });
});
test('windows client: an explicit socket override still rides the relay adapter', async () => {
  const opens = [];
  const child = fakeRelayChild();
  const client = new IslandClient({ endpoint: 'C:\\elsewhere\\endpoint.json', runtime: 'C:\\elsewhere', cwd, sessionId: 's', platform: 'win32',
    open: (endpoint, _runtime) => { opens.push([endpoint, _runtime]); return createWindowsConnection(endpoint,
      { spawn: () => child, findRelay: () => 'C:\\install\\abito-notice-relay.exe' }); } });
  const notify = client.notify();
  await new Promise(r => setImmediate(r));
  child.emit('spawn');
  await new Promise(r => setImmediate(r));
  child.stdout.write('{"v":1,"type":"ready"}\n');
  assert.deepEqual(await notify, { status: 'sent' });
  assert.deepEqual(opens, [['C:\\elsewhere\\endpoint.json', 'C:\\elsewhere']]);
});

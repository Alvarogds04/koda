'use strict';
// Parity with the harness hooks (apps/desktop-harness/src/config.cjs): with no explicit ABITO_DESKTOP_SOCKET, an
// ordinary Pi session finds the running island through `<runtime>/endpoint.json`, with the same closed checks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveConfig, resolveEndpoint } = require('../config.cjs');
const adapter = require('../adapter.cjs');
const { fakeReceiver, harness } = require('./fake-receiver.cjs');

const owner = process.getuid?.();
// The handoff checks below are Unix mechanisms (uid owner, 0600 mode, symlink refusal, pid probe). Windows twin: the
// final test of this file, which proves the same behaviour (an island published after Pi started is found, a restart is
// followed, an absent file means no connection) over the Windows metadata handoff and named pipe.
const unix = process.platform === 'win32' ? () => {} : test;

function put(rcv, over = {}, mode = 0o600) {
  const file = path.join(rcv.runtime, 'endpoint.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, endpoint: rcv.endpoint, pid: process.pid, ...over }));
  fs.chmodSync(file, mode);
  return file;
}
const resolve = (rcv, options, uid = owner) => resolveConfig({ ABITO_SOCKET_DIR: rcv.runtime }, uid, options);
function ownStart() {
  // macOS has no /proc: the pid start identity comes from the same `ps` probe production uses
  if (process.platform === 'darwin') return require('../config.cjs').darwinProc.start(process.pid);
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[22 - 3];
}

unix('absent ABITO_DESKTOP_SOCKET: a valid handoff endpoint is resolved', async t => {
  const rcv = await fakeReceiver(t);
  put(rcv);
  assert.deepEqual(resolve(rcv), { runtime: rcv.runtime, endpoint: rcv.endpoint, source: 'handoff' });
  assert.equal(resolveEndpoint({ ABITO_SOCKET_DIR: rcv.runtime }, owner), rcv.endpoint);
  // the island emits the key order serde_json uses, with the optional procStart identity
  const file = path.join(rcv.runtime, 'endpoint.json');
  fs.writeFileSync(file, JSON.stringify({ endpoint: rcv.endpoint, pid: process.pid, procStart: ownStart(), v: 1 }) + '\n');
  assert.equal(resolve(rcv).endpoint, rcv.endpoint);
  // a fresh call reads the file again: an island restart publishes a new endpoint
  fs.rmSync(file);
  assert.equal(resolveEndpoint({ ABITO_SOCKET_DIR: rcv.runtime }, owner), undefined);
  put(rcv);
  assert.equal(resolveEndpoint({ ABITO_SOCKET_DIR: rcv.runtime }, owner), rcv.endpoint);
});

unix('explicit ABITO_DESKTOP_SOCKET still wins and the handoff is never read', async t => {
  const rcv = await fakeReceiver(t);
  put(rcv);
  const originalOpen = fs.openSync;
  let opened = 0;
  fs.openSync = (...args) => { opened++; return originalOpen.apply(fs, args); };
  try {
    assert.deepEqual(resolveConfig({ ABITO_SOCKET_DIR: rcv.runtime, ABITO_DESKTOP_SOCKET: rcv.endpoint }, owner),
      { runtime: rcv.runtime, endpoint: rcv.endpoint, source: 'env' });
  } finally { fs.openSync = originalOpen; }
  assert.equal(opened, 0);
  assert.throws(() => resolveConfig({ ABITO_SOCKET_DIR: rcv.runtime, ABITO_DESKTOP_SOCKET: '/other/p-abc123/s' }, owner),
    /Unexpected endpoint/);
});

unix('stale, foreign or malformed handoffs yield no connection', async t => {
  const rcv = await fakeReceiver(t);
  const file = path.join(rcv.runtime, 'endpoint.json');
  const reset = () => fs.rmSync(file, { force: true });
  const refused = (label, text, options, uid) => {
    if (text !== undefined) { fs.writeFileSync(file, text); fs.chmodSync(file, 0o600); }
    assert.equal(resolve(rcv, options, uid).endpoint, undefined, label);
    reset();
  };
  refused('missing file');
  refused('stale pid', JSON.stringify({ v: 1, endpoint: rcv.endpoint, pid: 2147483646 }));
  refused('wrong owner', JSON.stringify({ v: 1, endpoint: rcv.endpoint, pid: process.pid }), undefined, owner + 1);
  fs.writeFileSync(file, JSON.stringify({ v: 1, endpoint: rcv.endpoint, pid: process.pid }));
  fs.chmodSync(file, 0o644);
  assert.equal(resolve(rcv).endpoint, undefined, 'group/other readable handoff');
  reset();
  refused('endpoint outside the runtime', JSON.stringify({ v: 1, endpoint: '/tmp/p-abc123/s', pid: process.pid }));
  refused('bad endpoint shape', JSON.stringify({ v: 1, endpoint: path.join(rcv.runtime, 'p-a/s'), pid: process.pid }));
  refused('zombie pid state', JSON.stringify({ v: 1, endpoint: rcv.endpoint, pid: process.pid }),
    { procExists: () => true, procState: () => 'Z' });
  refused('recycled pid start time', JSON.stringify({ v: 1, endpoint: rcv.endpoint, pid: process.pid,
    procStart: String(BigInt(ownStart()) + 1n) }));
  refused('extra key', JSON.stringify({ v: 1, endpoint: rcv.endpoint, pid: process.pid, extra: 1 }));
  refused('symlinked handoff', undefined);
  fs.writeFileSync(path.join(rcv.runtime, 'real.json'), JSON.stringify({ v: 1, endpoint: rcv.endpoint, pid: process.pid }));
  fs.symlinkSync(path.join(rcv.runtime, 'real.json'), file);
  assert.equal(resolve(rcv).endpoint, undefined, 'symlink is refused');
  reset();
  // the socket itself must still be the private one: removing it invalidates a valid file
  put(rcv);
  fs.unlinkSync(rcv.endpoint);
  assert.equal(resolve(rcv).endpoint, undefined, 'no socket at the published endpoint');
  // unknown runtime root stays a hard configuration error, exactly as before
  assert.throws(() => resolveConfig({ ABITO_SOCKET_DIR: 'relative' }, owner), /Invalid ABITO_SOCKET_DIR/);
  assert.equal(resolveEndpoint({ ABITO_SOCKET_DIR: 'relative' }, owner), undefined);
});

unix('an ordinary Pi session reaches an island it did not know at start, and a restarted one', async t => {
  const first = await fakeReceiver(t);
  const runtime = first.runtime;
  // no endpoint.json yet: the island is not up when Pi starts, so nothing connects
  const { handlers, ctx } = harness(adapter.registerAdapter, {
    runtime, resolveEndpoint: () => resolveEndpoint({ ABITO_SOCKET_DIR: runtime }, owner) });
  handlers.get('session_start')({}, ctx);
  assert.equal(first.frames.length, 0, 'no connection without a published endpoint');
  // the island comes up: the next retry finds the handoff, exactly like the Claude Code hook
  put(first);
  await first.next('hello');
  await first.next('heartbeat');
  handlers.get('agent_settled')({}, ctx);
  const settled = await first.next('settled');
  assert.equal(typeof settled.id, 'string');
  // island restart: it closes the socket and publishes a new endpoint; the retry must use the NEW one
  await first.close();
  const second = await fakeReceiver(t, { runtime });
  put(second);
  await second.next('hello');
  await second.next('heartbeat');
  handlers.get('agent_settled')({}, ctx);
  assert.equal(typeof (await second.next('settled')).id, 'string');
});

test('Windows twin: metadata handoff is found after Pi started, followed across an island restart, and absent means no connection', {
  skip: process.platform !== 'win32' && 'Windows-only mechanism; the Unix tests above cover the same behaviour' }, async t => {
  const local = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), '.test-local-'));
  const notices = path.join(local, 'Abito', 'notices');
  fs.mkdirSync(notices, { recursive: true });
  t.after(() => fs.rmSync(local, { recursive: true, force: true }));
  const first = await fakeReceiver(t, { runtime: notices });
  const meta = path.join(notices, 'endpoint.json');
  const published = fs.readFileSync(meta);
  fs.rmSync(meta);
  const env = { LOCALAPPDATA: local };
  assert.equal(resolveEndpoint(env, undefined), undefined, 'no metadata published: no connection');
  const { handlers, ctx } = harness(adapter.registerAdapter, {
    runtime: notices, platform: 'win32', open: first.open, resolveEndpoint: () => resolveEndpoint(env, undefined) });
  t.after(() => handlers.get('session_shutdown')());
  handlers.get('session_start')({}, ctx);
  assert.equal(first.frames.length, 0);
  fs.writeFileSync(meta, published);
  await first.next('hello');
  await first.next('heartbeat');
  handlers.get('agent_settled')({}, ctx);
  assert.equal(typeof (await first.next('settled')).id, 'string');
  // island restart: a new pipe is published under the same metadata file
  await first.close();
  const second = await fakeReceiver(t, { runtime: notices });
  handlers.get('session_shutdown')();
  const reopened = harness(adapter.registerAdapter, {
    runtime: notices, platform: 'win32', open: second.open, resolveEndpoint: () => resolveEndpoint(env, undefined) });
  t.after(() => reopened.handlers.get('session_shutdown')());
  reopened.handlers.get('session_start')({}, reopened.ctx);
  await second.next('hello');
  await second.next('heartbeat');
  reopened.handlers.get('agent_settled')({}, reopened.ctx);
  assert.equal(typeof (await second.next('settled')).id, 'string');
});

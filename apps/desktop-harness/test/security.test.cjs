'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyEndpoint } = require('../src/security.cjs');
const { fakeReceiver } = require('./fake-receiver.cjs');
// Unix socket mechanism (mode bits, uid, sun_path) does not exist on Windows. The Windows equivalent of every test gated
// here is 'windows verifyEndpoint: metadata shape + runtime binding, no unix socket checks' in windows-transport.test.cjs
// (shape and runtime binding; owner-only DACL, live pid and server SID are verified by the native relay, covered by the island's Rust tests).
const unixOnly = { skip: process.platform === 'win32' && 'Unix socket mechanism; Windows twin: windows-transport.test.cjs «windows verifyEndpoint»' };

test('accepts a private socket and returns dev/ino', async t => {
  const r = await fakeReceiver(t);
  const id = verifyEndpoint(r.endpoint, r.runtime);
  assert.ok(Number.isInteger(id.ino) && id.dev !== undefined);
});
test('rejects wrong socket mode, wrong dir mode and runtime mismatch', unixOnly, async t => {
  const r = await fakeReceiver(t);
  fs.chmodSync(r.endpoint, 0o666);
  assert.throws(() => verifyEndpoint(r.endpoint, r.runtime));
  fs.chmodSync(r.endpoint, 0o600);
  fs.chmodSync(path.dirname(r.endpoint), 0o755);
  assert.throws(() => verifyEndpoint(r.endpoint, r.runtime));
  fs.chmodSync(path.dirname(r.endpoint), 0o700);
  assert.throws(() => verifyEndpoint(r.endpoint, r.runtime + '-other'));
  verifyEndpoint(r.endpoint, r.runtime);
});
test('rejects symlinked endpoint, symlinked directory and regular files', async t => {
  const r = await fakeReceiver(t);
  const dir = path.dirname(r.endpoint);
  const link = path.join(r.runtime, 'p-link12');
  fs.mkdirSync(link, { mode: 0o700 }); fs.chmodSync(link, 0o700);
  fs.symlinkSync(r.endpoint, path.join(link, 's'));
  assert.throws(() => verifyEndpoint(path.join(link, 's'), r.runtime));
  const other = path.join(r.runtime, 'p-dirlnk');
  fs.symlinkSync(dir, other);
  assert.throws(() => verifyEndpoint(path.join(other, 's'), r.runtime));
  const file = path.join(r.runtime, 'p-file12');
  fs.mkdirSync(file, { mode: 0o700 }); fs.chmodSync(file, 0o700);
  fs.writeFileSync(path.join(file, 's'), '', { mode: 0o600 });
  assert.throws(() => verifyEndpoint(path.join(file, 's'), r.runtime));
});
test('rejects entries owned by someone else (simulated uid mismatch)', unixOnly, async t => {
  const r = await fakeReceiver(t);
  const real = process.getuid;
  process.getuid = () => real.call(process) + 12345;
  t.after(() => { process.getuid = real; });
  assert.throws(() => verifyEndpoint(r.endpoint, r.runtime));
});

// HU-062 (found on macOS CI): the Claude Code / Codex hooks refused EVERY endpoint on macOS because the check hard-coded
// `process.platform !== 'linux'`, so a hook could never reach the island there (desktop-pi already allowed darwin). The platform is
// now a seam like on win32; a private Unix socket is accepted on linux and darwin, and any other platform stays refused.
test('macOS (darwin) accepts a private Unix socket exactly like Linux; unknown platforms stay refused', unixOnly, async t => {
  const r = await fakeReceiver(t);
  const linux = verifyEndpoint(r.endpoint, r.runtime, { platform: 'linux' });
  // darwin's sun_path is 103 bytes: a checkout path long enough to exceed it is refused there, which is the rule under test.
  if (Buffer.byteLength(r.endpoint) <= 103) assert.deepEqual(verifyEndpoint(r.endpoint, r.runtime, { platform: 'darwin' }), linux);
  else assert.throws(() => verifyEndpoint(r.endpoint, r.runtime, { platform: 'darwin' }), /Unexpected endpoint/);
  for (const platform of ['freebsd', 'sunos', 'aix']) assert.throws(() => verifyEndpoint(r.endpoint, r.runtime, { platform }), /Unexpected endpoint/);
});
test('the endpoint path limit follows the platform: 103 bytes on macOS, 107 on Linux', unixOnly, () => {
  const { endpointShape } = require('../src/config.cjs');
  const runtime = '/r' + 'x'.repeat(80);
  const endpoint = `${runtime}/p-abcdef/s`;
  const length = Buffer.byteLength(endpoint);
  assert.ok(length > 90);
  const pad = n => '/r' + 'x'.repeat(80 + n);
  const at = (limit) => { const rt = pad(limit - length); return endpointShape(`${rt}/p-abcdef/s`, rt, { platform: limit === 103 ? 'darwin' : 'linux' }); };
  assert.equal(at(103), true, 'exactly 103 bytes fits on macOS');
  assert.equal(endpointShape(`${pad(104 - length)}/p-abcdef/s`, pad(104 - length), { platform: 'darwin' }), false, '104 bytes does not fit on macOS');
  assert.equal(at(107), true, 'exactly 107 bytes fits on Linux');
  assert.equal(endpointShape(`${pad(108 - length)}/p-abcdef/s`, pad(108 - length), { platform: 'linux' }), false);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveConfig } = require('../src/config.cjs');
const { unixOnly } = require('./platform-env.cjs');
// These are the Unix path rules (a pure function of the platform argument); the Windows rules are in windows-transport.test.cjs.
const unix = process.platform === 'darwin' ? 'darwin' : 'linux';

test('absent endpoint means unavailable; never scans, default root by uid', unixOnly('windows-transport.test.cjs resolveConfig win32 cases'), () => {
  // uid 4321 does not exist here: the default runtime is computed WITHOUT reading the live island's real endpoint.json
  assert.deepEqual(resolveConfig({}, 4321, { procExists: () => false, platform: unix }), { runtime: process.platform === 'darwin' ? require('node:fs').realpathSync(require('node:os').tmpdir()) + '/abito-island' : '/run/user/4321/abito-island', endpoint: undefined, source: undefined });
  assert.equal(resolveConfig({ ABITO_PROJECT_ROOT: '/x' }, 4321, { platform: unix }).endpoint, undefined);
  assert.equal(resolveConfig({ ABITO_SOCKET_DIR: '/home/u/r' }, 1000, { platform: unix }).runtime, '/home/u/r');
});
test('uid and runtime shape matrix', () => {
  for (const uid of [-1, 1.5, NaN, '1000', undefined]) assert.throws(() => resolveConfig({}, uid, { platform: unix }));
  for (const value of ['', 'relative', '/a/../b', '/a//b', '/a/', '/', '/a\0b']) {
    assert.throws(() => resolveConfig({ ABITO_SOCKET_DIR: value }, 1000, { platform: unix }));
  }
});
test('endpoint shape matrix', unixOnly('windows-transport.test.cjs resolveConfig win32 cases'), () => {
  const env = endpoint => ({ ABITO_SOCKET_DIR: '/home/u/root', ABITO_DESKTOP_SOCKET: endpoint });
  assert.equal(resolveConfig(env('/home/u/root/p-abc123/s'), 1000, { platform: unix }).endpoint, '/home/u/root/p-abc123/s');
  for (const e of ['/home/u/root/p-abc123/no', '/home/u/root/p-a/s', '/home/u/else/p-abc123/s',
    '/home/u/root/p-abc12!/s', '/home/u/root/p-abc123/s/', 'rel/p-abc123/s', '']) {
    assert.throws(() => resolveConfig(env(e), 1000, { platform: unix }), e);
  }
  assert.throws(() => resolveConfig({ ABITO_DESKTOP_SOCKET: '/home/u/root/p-abc123/s' }, 1000, { platform: unix }));
});

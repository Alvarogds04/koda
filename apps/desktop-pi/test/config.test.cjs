'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const { resolveConfig } = require('../config.cjs');
const windows = process.platform === 'win32';
const unix = windows ? () => {} : test;
// Linux: `/run/user/<uid>` (or $XDG_RUNTIME_DIR). macOS has neither: the canonical per-user temp dir (config.cjs runtimeBase).
const base = uid => process.platform === 'darwin' ? fs.realpathSync(os.tmpdir()) : `/run/user/${uid}`;

unix('the default root is the Tauri island\'s own leaf; the Electron production and Preview roots stay explicit', () => {
  // the island binds `$XDG_RUNTIME_DIR/koda` (src/transport.rs `default_runtime`): a producer with no
  // override must look THERE, not in the Electron app's `abito-desktop` leaf
  // uid 4321 does not exist here and the process probes are injected: the default runtime is computed WITHOUT
  // reading the live installed island's real endpoint.json (a live one may exist on this machine)
  const offline = { procExists: () => false };
  assert.equal(resolveConfig({}, 4321, offline).runtime, `${base(4321)}/koda`);
  if (process.platform !== 'darwin') {
    assert.equal(resolveConfig({ XDG_RUNTIME_DIR: '/run/user/1000' }, 1000).runtime, '/run/user/1000/koda');
    assert.equal(resolveConfig({ XDG_RUNTIME_DIR: '/tmp/x-run' }, 1000).runtime, '/tmp/x-run/koda', 'XDG_RUNTIME_DIR wins over the uid guess');
  } else {
    // macOS has no XDG_RUNTIME_DIR: the per-user temp dir is the base whatever the environment says
    assert.equal(resolveConfig({ XDG_RUNTIME_DIR: '/tmp/x-run' }, 1000).runtime, `${base(1000)}/koda`);
  }
  for (const bad of ['', 'relative', '/a/../b', '/a//b', '/a/', '/']) {
    assert.equal(resolveConfig({ XDG_RUNTIME_DIR: bad }, 1000).runtime, `${base(1000)}/koda`, `an unusable XDG_RUNTIME_DIR ${JSON.stringify(bad)} falls back to the uid path`);
  }
  assert.equal(resolveConfig({ KODA_SOCKET_DIR: '/run/user/1000/abito-desktop' }, 1000).runtime, '/run/user/1000/abito-desktop', 'the Electron production root is still reachable, explicitly');
  assert.equal(resolveConfig({ KODA_SOCKET_DIR: '/run/user/1000/abito-desktop-preview' }, 1000).runtime,
    '/run/user/1000/abito-desktop-preview');
  assert.equal(resolveConfig({ KODA_SOCKET_DIR: '/home/u/new-root' }, 1000).runtime, '/home/u/new-root');
  // with no handoff published (or no island running) there is no connection
  assert.deepEqual(resolveConfig({}, 4321, offline), { runtime: `${base(4321)}/koda`, endpoint: undefined, source: undefined });
});

unix('override is exact, normalized, never inferred from arbitrary endpoint', () => {
  for (const value of ['', 'relative', '/a/../b', '/a//b', '/a/', '/']) {
    assert.throws(() => resolveConfig({ KODA_SOCKET_DIR: value }, 1000));
  }
  assert.throws(() => resolveConfig({ KODA_DESKTOP_SOCKET: '/home/u/root/p-abc123/s' }, 1000));
  assert.deepEqual(resolveConfig({ KODA_SOCKET_DIR: '/home/u/root',
    KODA_DESKTOP_SOCKET: '/home/u/root/p-abc123/s' }, 1000),
    { runtime: '/home/u/root', endpoint: '/home/u/root/p-abc123/s', source: 'env' });
  for (const endpoint of ['/home/u/root/p-abc123/no', '/home/u/root/p-a/s', '/home/u/else/p-abc123/s']) {
    assert.throws(() => resolveConfig({ KODA_SOCKET_DIR: '/home/u/root', KODA_DESKTOP_SOCKET: endpoint }, 1000));
  }
});

test('Windows twin of the default root and the exact override: %LOCALAPPDATA%\\Koda\\notices, and only an absolute endpoint.json is accepted', {
  skip: !windows && 'Windows-only mechanism (metadata path, no uid); the two Unix tests above state the same rules' }, () => {
  const local = 'C:\\Users\\runner\\AppData\\Local';
  const missing = () => { throw new Error('ENOENT'); };
  assert.deepEqual(resolveConfig({ LOCALAPPDATA: local }, undefined, { platform: 'win32', stat: missing }),
    { runtime: `${local}\\Koda\\notices`, endpoint: undefined, source: undefined });
  assert.equal(resolveConfig({}, undefined, { platform: 'win32' }).runtime, undefined, 'no LOCALAPPDATA: no connection');
  const good = `${local}\\Koda\\notices\\endpoint.json`;
  assert.deepEqual(resolveConfig({ KODA_DESKTOP_SOCKET: good }, undefined, { platform: 'win32' }),
    { runtime: `${local}\\Koda\\notices`, endpoint: good, source: 'env' });
  for (const bad of ['', 'relative\\endpoint.json', `${local}\\Koda\\notices\\other.json`, `${local}\\Koda\\..\\x\\endpoint.json`, `${local}\\Koda\\notices\\`]) {
    assert.throws(() => resolveConfig({ KODA_DESKTOP_SOCKET: bad }, undefined, { platform: 'win32' }), /Unexpected endpoint/, JSON.stringify(bad));
  }
});

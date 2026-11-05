'use strict';
/* K2-01b: CI hands build-coucou.cjs the pinned esbuild's NATIVE binary for each OS (ESBUILD_BINARY_PATH), never the
   bin/esbuild JS shim, which Windows cannot execute directly (spawnSync … ENOENT). Nothing is downloaded: the resolver
   only looks at what `npm i -g esbuild@0.28.2` already installed. Run: node apps/desktop-tauri/test-node/esbuild-native-check.cjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const { nativeEsbuild } = require('../scripts/esbuild-native.cjs');
let passed = 0;
const test = (_name, fn) => { fn(); passed += 1; };
const root = path.join('npm', 'node_modules');
const only = (...hits) => (p) => hits.includes(p);

test('Windows: the native esbuild.exe of @esbuild/win32-<arch>, nested under esbuild first, never the JS shim', () => {
  const nested = path.join(root, 'esbuild', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');
  const hoisted = path.join(root, '@esbuild', 'win32-x64', 'esbuild.exe');
  const shim = path.join(root, 'esbuild', 'bin', 'esbuild');
  assert.equal(nativeEsbuild(root, { platform: 'win32', arch: 'x64', exists: only(nested, hoisted, shim) }), nested);
  assert.equal(nativeEsbuild(root, { platform: 'win32', arch: 'x64', exists: only(hoisted, shim) }), hoisted);
  assert.equal(nativeEsbuild(root, { platform: 'win32', arch: 'arm64', exists: only(path.join(root, '@esbuild', 'win32-arm64', 'esbuild.exe')) }), path.join(root, '@esbuild', 'win32-arm64', 'esbuild.exe'));
});

test('Linux and macOS: the native bin/esbuild of @esbuild/<platform>-<arch>', () => {
  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']]) {
    const native = path.join(root, '@esbuild', `${platform}-${arch}`, 'bin', 'esbuild');
    assert.equal(nativeEsbuild(root, { platform, arch, exists: only(native) }), native, `${platform}-${arch}`);
  }
});

test('nothing native installed (only the shim, or another platform): null, never a guess', () => {
  const shim = path.join(root, 'esbuild', 'bin', 'esbuild');
  assert.equal(nativeEsbuild(root, { platform: 'win32', arch: 'x64', exists: only(shim) }), null);
  assert.equal(nativeEsbuild(root, { platform: 'linux', arch: 'x64', exists: only(path.join(root, '@esbuild', 'darwin-arm64', 'bin', 'esbuild')) }), null);
});

test('the CLI prints the resolved path and exits 1 when nothing native is installed', () => {
  const cp = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esbuild-native-'));
  try {
    const script = path.join(__dirname, '..', 'scripts', 'esbuild-native.cjs');
    const none = cp.spawnSync(process.execPath, [script, tmp], { encoding: 'utf8' });
    assert.equal(none.status, 1);
    assert.equal(none.stdout, '');
    const file = process.platform === 'win32' ? ['esbuild.exe'] : ['bin', 'esbuild'];
    const native = path.join(tmp, '@esbuild', `${process.platform}-${process.arch}`, ...file);
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(native, '');
    const found = cp.spawnSync(process.execPath, [script, tmp], { encoding: 'utf8' });
    assert.equal(found.status, 0, found.stderr);
    assert.equal(found.stdout, `${native}\n`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

console.log(`esbuild-native-check: ${passed} passed`);

'use strict';
/* K2-02 T1 (S1, S2): the Node and the Pi that Koda ships are pinned, one pin per shipped OS/arch, with a sha256 for every
   download, and every place that installs Pi for Koda's checks uses the same Pi version. Reads the pin files only.
   Run: node apps/desktop-tauri/test-node/runtime-pins-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const crate = path.resolve(__dirname, '..');
const repo = path.resolve(crate, '..', '..');
const read = (p) => fs.readFileSync(p, 'utf8');
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
};

const PI = '@earendil-works/pi-coding-agent';
const nodePins = read(path.join(crate, 'packaging/runtime/node.sha256')).trim().split(/\r?\n/).map((l) => l.split(/\s+/));
// a malformed pin file must fail the check with the file named, not with a bare SyntaxError
function readJson(file) {
  try { return JSON.parse(read(file)); } catch (e) { throw new Error(`cannot read JSON ${file}: ${e.message}`); }
}
const pkg = readJson(path.join(crate, 'packaging/runtime/package.json'));
const lock = readJson(path.join(crate, 'packaging/runtime/package-lock.json'));
const piVersion = pkg.dependencies[PI];

test('one Node pin per shipped installer target: linux-x64, darwin-arm64 and win-x64, nothing else', () => {
  const names = nodePins.map(([, name]) => name).sort();
  assert.equal(names.length, 3);
  assert.match(names[0], /^node-v[\d.]+-darwin-arm64\.tar\.gz$/);
  assert.match(names[1], /^node-v[\d.]+-linux-x64\.tar\.gz$/);
  assert.match(names[2], /^node-v[\d.]+-win-x64\.zip$/);
});
test('every Node pin is a sha256 of a single Node 22 release that Pi accepts (>= 22.19.0)', () => {
  const versions = new Set();
  for (const [sha, name] of nodePins) {
    assert.match(sha, /^[0-9a-f]{64}$/, `sha256 for ${name}`);
    versions.add(/^node-v([\d.]+)-/.exec(name)[1]);
  }
  assert.equal(versions.size, 1, 'one Node version for every OS');
  const [major, minor] = [...versions][0].split('.').map(Number);
  assert.ok(major === 22 && minor >= 19, `Node ${[...versions][0]} is 22.x >= 22.19.0`);
});
test('Pi is pinned to exactly 1.4.0, and it is the only dependency', () => {
  assert.deepEqual(pkg.dependencies, { [PI]: '1.4.0' });
  assert.equal(lock.packages[`node_modules/${PI}`].version, '1.4.0');
});
test('the lockfile pins every package to the npm registry with a sha512 integrity', () => {
  assert.equal(lock.lockfileVersion, 3);
  const entries = Object.entries(lock.packages).filter(([k]) => k !== '');
  assert.ok(entries.length > 1);
  for (const [k, v] of entries) {
    assert.ok(!v.link && !v.inBundle, `${k} is a plain registry package`);
    assert.match(v.resolved, /^https:\/\/registry\.npmjs\.org\//, `${k} resolved from registry.npmjs.org`);
    assert.match(v.integrity, /^sha512-/, `${k} has a sha512 integrity`);
  }
});
test('CI installs the same Pi as the one Koda ships', () => {
  const ci = read(path.join(repo, '.github/workflows/ci.yml'));
  assert.equal(/^\s*PI_VERSION: '([^']+)'/m.exec(ci)[1], piVersion);
});
test('the Windows installed smoke installs that same pinned Pi, never an unpinned one', () => {
  const smoke = read(path.join(crate, 'ci/public/smoke-windows.ps1'));
  // an npm invocation (a command line), not a quoted message that mentions npm
  const npmInstalls = smoke.split(/\r?\n/).filter((l) => /^\s*&?\s*npm(\.cmd)?\s+(install|i)\b/.test(l));
  assert.ok(npmInstalls.length >= 1, 'the smoke installs Pi');
  for (const line of npmInstalls) assert.ok(line.includes(`'${PI}@${piVersion}'`), `pinned: ${line.trim()}`);
});
console.log(`runtime-pins-check: ${passed} passed`);

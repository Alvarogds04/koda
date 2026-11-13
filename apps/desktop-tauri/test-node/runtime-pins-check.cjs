'use strict';
/* K2-02 T1 (S1, S2) + K2-05 T1 (S1): the Node, the Pi and Gentle Shell that Koda ships are pinned, one pin per shipped
   OS/arch, with a sha256 for every download, and every place that installs Pi for Koda's checks uses the same Pi version.
   Reads the pin files only.
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
// K2-05 T1b (S5): the Engram memory engine ships as the prebuilt GitHub release binary (never built from Go),
// pinned like Node: one asset per Koda target with its sha256, from the release's own checksums.txt.
const engramPins = read(path.join(crate, 'packaging/runtime/engram.sha256')).trim().split(/\r?\n/).map((l) => l.split(/\s+/));
// a malformed pin file must fail the check with the file named, not with a bare SyntaxError
function readJson(file) {
  try { return JSON.parse(read(file)); } catch (e) { throw new Error(`cannot read JSON ${file}: ${e.message}`); }
}
const pkg = readJson(path.join(crate, 'packaging/runtime/package.json'));
const lock = readJson(path.join(crate, 'packaging/runtime/package-lock.json'));
const GENTLE = 'gentle-pi';
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
test('Pi is pinned to exactly 1.4.0, the daemon\'s Telegram client library rides along, and nothing is unpinned', () => {
  // K2-13 (L41): the daemon's own runtime dependency ships inside this folder, because this is the one npm tree every
  // installer already verifies, extracts and writes licence notices for. Exact pins only, and better-sqlite3 is the
  // stub: mtcute's native addon never enters a user's machine (telegram-deps-check.cjs holds the stub itself).
  assert.equal(pkg.dependencies[PI], '1.4.0');
  assert.equal(lock.packages[`node_modules/${PI}`].version, '1.4.0');
  assert.equal(lock.packages['node_modules/@mtcute/node'].version, '0.32.8');
});
test('one Engram pin per shipped installer target: linux-x64, darwin-arm64 and win-x64, nothing else (K2-05 T1b)', () => {
  const names = engramPins.map(([, name]) => name).sort();
  assert.deepEqual(names, ['engram_3.4.0_darwin_arm64.tar.gz', 'engram_3.4.0_linux_amd64.tar.gz', 'engram_3.4.0_windows_amd64.zip']);
});
test('every Engram pin is a sha256 of one prebuilt 3.4.0 release asset, one version for every OS (never built from Go)', () => {
  const versions = new Set();
  for (const [sha, name] of engramPins) {
    assert.match(sha, /^[0-9a-f]{64}$/, `sha256 for ${name}`);
    const m = /^engram_([\d.]+)_(linux_amd64|darwin_arm64|windows_amd64)\.(tar\.gz|zip)$/.exec(name);
    assert.ok(m, `engram release asset name: ${name}`);
    assert.match(m[3], m[2] === 'windows_amd64' ? /^zip$/ : /^tar\.gz$/, m[2]);
    versions.add(m[1]);
  }
  assert.equal(versions.size, 1, 'one Engram version for every OS');
  assert.equal([...versions][0], '3.4.0', 'pinned 3.4.0 like gentle-pi installer-downloads (K2-02: Koda pins, never floats)');
});
test('the Engram companion gentle-engram is pinned exactly 0.4.2 next to Pi (K2-05 T1b)', () => {
  assert.equal(pkg.dependencies['gentle-engram'], '0.4.2');
  const entry = lock.packages['node_modules/gentle-engram'];
  assert.equal(entry.version, '0.4.2');
  assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
  assert.match(entry.integrity, /^sha512-/);
});
test('every peer gentle-engram declares is pinned at the root to a version that satisfies it', () => {
  const engram = lock.packages['node_modules/gentle-engram'];
  assert.ok(engram.peerDependencies, 'gentle-engram declares peers');
  for (const [name] of Object.entries(engram.peerDependencies)) {
    assert.ok(pkg.dependencies[name], `the root pins gentle-engram's peer ${name}`);
  }
});
test('the runtime dependencies are exactly Pi, gentle-pi, gentle-engram, the peers gentle-pi declares and the daemon\'s own (Pi is the only agent dependency)', () => {
  // The exact set, not a subset: a new dependency must be added here deliberately, never silently.
  assert.deepEqual(Object.entries(pkg.dependencies).sort(), [
    ['@earendil-works/pi-ai', '1.4.0'],
    ['@earendil-works/pi-coding-agent', '1.4.0'],
    ['@earendil-works/pi-tui', '1.4.0'],
    // K2-13 (L41): the daemon's Telegram client and the empty better-sqlite3 stub that replaces its native addon.
    ['@mtcute/node', '0.32.8'],
    ['better-sqlite3', 'file:./stubs/better-sqlite3'],
    ['gentle-engram', '0.4.2'],
    ['gentle-pi', '4.3.0'],
    ['typebox', '1.3.27'],
  ]);
});
test('gentle-pi 4.3.0 is pinned exactly next to Pi (K2-05 T1)', () => {
  assert.equal(pkg.dependencies[GENTLE], '4.3.0');
  const entry = lock.packages[`node_modules/${GENTLE}`];
  assert.equal(entry.version, '4.3.0');
  assert.equal(entry.bin && entry.bin['gentle-shell'], 'bin/gentle-shell.mjs');
});
test('every peer gentle-pi declares is pinned at the root to the exact version the lockfile installs (npm cannot drift)', () => {
  const gentle = lock.packages[`node_modules/${GENTLE}`];
  assert.ok(gentle.peerDependencies, 'gentle-pi declares peers');
  for (const [name, range] of Object.entries(gentle.peerDependencies)) {
    const pinned = pkg.dependencies[name];
    assert.ok(pinned, `the root pins peer ${name} (${range})`);
    assert.match(pinned, /^[\d.]+$/, `peer ${name} is pinned exactly, not a range: ${pinned}`);
    assert.equal(lock.packages[`node_modules/${name}`].version, pinned, `lockfile installs ${name} at the pinned version`);
  }
});
test('the lockfile pins every package to the npm registry with a sha512 integrity', () => {
  assert.equal(lock.lockfileVersion, 3);
  const entries = Object.entries(lock.packages).filter(([k]) => k !== '');
  assert.ok(entries.length > 1);
  for (const [k, v] of entries) {
    assert.ok(!v.link && !v.inBundle, `${k} is a plain package, not a link or a bundle`);
    if (k === 'node_modules/better-sqlite3') {
      // The one deliberate exception: our own empty stub, resolved from this folder, so it has no registry integrity.
      assert.equal(v.resolved, 'file:stubs/better-sqlite3', 'the stub is resolved from packaging/runtime/stubs');
      // A `file:` entry with `resolved` (not a `link`) is the --install-links lock form: npm >= 10 refuses this lock
      // in a plain `npm ci` («Missing: better-sqlite3 … from lock file»). The build must pass the same flag.
      const builder = fs.readFileSync(path.join(__dirname, '..', 'packaging', 'runtime', 'build-runtime.cjs'), 'utf8');
      assert.match(builder, /\[npmCli\(\), 'ci', '--install-links'/, 'build-runtime runs npm ci with --install-links, matching the stub entry of the lock');
      continue;
    }
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
test('hash-pinned inputs keep their bytes on a Windows checkout (no CRLF conversion): .gitattributes marks them -text', () => {
  // CI 41733396427 (windows-latest): with core.autocrlf the licence texts got CRLF, so their pinned sha256 broke (and a
  // Windows-built runtime would ship CRLF notices). Every hash-pinned input is checked out byte-for-byte on every OS.
  const files = ['packaging/runtime/licenses/Apache-2.0.txt', 'packaging/runtime/licenses/MIT.txt', 'packaging/runtime/node.sha256', 'packaging/runtime/engram.sha256'];
  const r = require('node:child_process').spawnSync('git', ['check-attr', 'text', '--', ...files], { cwd: crate, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const seen = new Set(r.stdout.split('\n'));
  for (const f of files) assert.ok(seen.has(`${f}: text: unset`), `${f} is checked out without CRLF conversion`);
});
test('K2-13 (S9): ffmpeg is pinned once for linux-x64 and once for win-x64, BtbN LGPL builds of one FFmpeg revision, none for darwin-arm64', () => {
  const lines = read(path.join(crate, 'packaging/runtime/ffmpeg.sha256')).split(/\r?\n/).filter((l) => l.trim() !== '' && !l.startsWith('#'));
  const pins = lines.map((l) => l.trim().split(/\s+/));
  assert.equal(pins.length, 2);
  const names = pins.map(([, rel]) => rel).sort();
  const shape = /^autobuild-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\/ffmpeg-(n[\d.]+-\d+-g[0-9a-f]+)-(linux64|win64)-lgpl-[\d.]+\.(tar\.xz|zip)$/;
  const [linux, win] = names.map((n) => shape.exec(n));
  assert.ok(linux && linux[2] === 'linux64' && linux[3] === 'tar.xz', names[0]);
  assert.ok(win && win[2] === 'win64' && win[3] === 'zip', names[1]);
  assert.equal(linux[1], win[1], 'one FFmpeg revision on both OSes');
  assert.equal(names[0].split('/')[0], names[1].split('/')[0], 'one BtbN release');
  for (const [sha, rel] of pins) {
    assert.match(sha, /^[0-9a-f]{64}$/, rel);
    assert.doesNotMatch(rel, /-gpl|nonfree|darwin|macos/, rel);
  }
});
test('K2-13 (S19): yt-dlp is pinned once for linux-x64 and once for win-x64, one release, with the two licence texts it ships, none for darwin-arm64', () => {
  const lines = read(path.join(crate, 'packaging/runtime/ytdlp.sha256')).split(/\r?\n/).filter((l) => l.trim() !== '' && !l.startsWith('#')).map((l) => l.trim().split(/\s+/));
  const binaries = lines.filter(([, rel]) => !rel.startsWith('ytdlp/'));
  const licences = lines.filter(([, rel]) => rel.startsWith('ytdlp/'));
  assert.equal(binaries.length, 2, 'one asset per shipped target, and no darwin/macos/arm/x86 build');
  const shape = /^(\d{4}\.\d{2}\.\d{2})\/(yt-dlp_linux|yt-dlp\.exe)$/;
  const tags = new Set();
  const assets = [];
  for (const [sha, rel] of binaries) {
    const m = shape.exec(rel);
    assert.ok(m, `the pin names an official standalone asset: ${rel}`);
    assert.match(sha, /^[0-9a-f]{64}$/, rel);
    tags.add(m[1]);
    assets.push(m[2]);
  }
  assert.equal(tags.size, 1, 'one yt-dlp release on both OSes');
  assert.deepEqual(assets.sort(), ['yt-dlp.exe', 'yt-dlp_linux']);
  // The two licence texts travel next to the binary and are pinned by their own sha256, so what ships is what was
  // reviewed: yt-dlp's Unlicense and the release's THIRD_PARTY_LICENSES.txt (Python, GNU Readline, mutagen, …).
  assert.deepEqual(licences.map(([, rel]) => rel).sort(), ['ytdlp/third-party-licenses.txt', 'ytdlp/unlicense.txt']);
  for (const [sha, rel] of licences) {
    const bytes = fs.readFileSync(path.join(crate, 'packaging/runtime', rel));
    assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'), sha, rel);
  }
  assert.match(read(path.join(crate, 'packaging/runtime/ytdlp/unlicense.txt')), /released into the public domain/);
  assert.match(read(path.join(crate, 'packaging/runtime/ytdlp/third-party-licenses.txt')), /GNU Readline \| GPL-3\.0-or-later/);
});

test('K2-13 (S19): the hash-pinned yt-dlp inputs keep their bytes on a Windows checkout (.gitattributes marks them -text)', () => {
  const files = ['packaging/runtime/ytdlp.sha256', 'packaging/runtime/ytdlp/unlicense.txt', 'packaging/runtime/ytdlp/third-party-licenses.txt'];
  const r = require('node:child_process').spawnSync('git', ['check-attr', 'text', '--', ...files], { cwd: crate, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const seen = new Set(r.stdout.split('\n'));
  for (const f of files) assert.ok(seen.has(`${f}: text: unset`), `${f} is checked out without CRLF conversion`);
});

console.log(`runtime-pins-check: ${passed} passed`);

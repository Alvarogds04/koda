#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const L = require('../packaging/lib.cjs');
const crate = path.resolve(__dirname, '..');
const script = path.join(crate, 'packaging/windows/stage-runtime.cjs');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-win-stage-'));
const out = path.join(scratch, 'payload');
const files = [...L.DAEMON_FILES.map(f => `desktop-daemon/${f}`), ...L.HARNESS_FILES.map(f => `desktop-harness/${f}`), ...L.PI_FILES.map(f => `desktop-pi/${f}`)].sort();
const bins = ['abito-island.exe', 'abito-notice-relay.exe', 'abito-private-session.exe', 'abito-install.json'];
function run(...args) { return spawnSync(process.execPath, [script, '--out', out, ...args], { encoding: 'utf8' }); }
function entries(dir, prefix = '') { return fs.readdirSync(dir).flatMap(n => fs.statSync(path.join(dir, n)).isDirectory() ? entries(path.join(dir, n), `${prefix}${n}/`) : [`${prefix}${n}`]).sort(); }
// HU-062: test-only helpers of the harness suite (the pipe preload, fake receivers, fixtures) are never part of the shipped closed list,
// and no shipped file references the preload or its switch.
assert.ok(!files.some(f => /(^|\/)test\//.test(f) || /pipe-preload|fake-receiver|platform-env|ABITO_TEST_PIPE/.test(f)), 'test-only harness files must not be shipped');
for (const f of files.filter(f => f.endsWith('.cjs'))) assert.doesNotMatch(fs.readFileSync(path.join(crate, '..', f), 'utf8'), /pipe-preload|ABITO_TEST_PIPE/, `${f} must not reference the test preload`);
try {
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, `staged: ${files.length} runtime files\n`);
  assert.deepEqual(entries(out), [...files, 'runtime.nsh'].sort());
  for (const f of files) {
    assert.deepEqual(fs.readFileSync(path.join(out, f)), fs.readFileSync(path.join(crate, '..', f)));
    if (!f.endsWith('.cjs')) continue;
    const text = fs.readFileSync(path.join(out, f), 'utf8');
    for (const m of text.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      let target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (!path.posix.extname(target)) target += '.js';
      assert.ok(files.includes(target), `${f} requires unstaged ${target}`);
    }
  }
  const macroBytes = fs.readFileSync(path.join(out, 'runtime.nsh'));
  assert.ok(macroBytes.every(byte => byte < 128), 'generated NSIS include is BOM-free ASCII');
  const macro = macroBytes.toString('utf8');
  assert.doesNotMatch(macro, /^  SetOutPath .*\//m);
  const installed = [...macro.matchAll(/^  File "\$\{(?:BINDIR|RUNTIMEDIR)\}\\([^"]+)"$/gm)].map(m => m[1].replaceAll('\\', '/')).sort();
  assert.doesNotMatch(macro, /^  File .*\//m, 'NSIS source paths use Windows separators, including on the cross host');
  const nsis = fs.readFileSync(path.join(crate, 'packaging/windows/abito.nsi'), 'utf8');
  assert.ok(nsis.includes('!include "${RUNTIMEDIR}\\runtime.nsh"'));
  // Per-user install only into the protected default (%LOCALAPPDATA%\Programs): no directory page, so a tester can
  // never pick a folder other local users can modify (e.g. C:\Abito) and plant binaries the island trusts.
  assert.ok(nsis.includes('InstallDir "$LOCALAPPDATA\\Programs\\abito-island"'));
  assert.doesNotMatch(nsis, /MUI_PAGE_DIRECTORY/);
  assert.doesNotMatch(nsis, /^InstallDirRegKey/m);
  const deleted = [...macro.matchAll(/^  Delete "\$INSTDIR\\([^"]+)"$/gm)].map(m => m[1].replaceAll('\\', '/')).sort();
  assert.deepEqual(installed, [...files, ...bins].sort());
  assert.deepEqual(deleted, installed);
  assert.doesNotMatch(macro, /(?:Delete|RMDir).*\*|RMDir\s+\/r/i);
  // Execute the generated deletion policy against an isolated installed fixture.
  const installedRoot = path.join(scratch, 'installed');
  fs.cpSync(out, installedRoot, { recursive: true });
  for (const b of bins) fs.writeFileSync(path.join(installedRoot, b), 'native fixture');
  const unrelated = path.join(installedRoot, 'desktop-daemon/src/user-note.txt');
  fs.writeFileSync(unrelated, 'keep me');
  for (const f of deleted) fs.unlinkSync(path.join(installedRoot, f));
  for (const m of macro.matchAll(/^  RMDir "\$INSTDIR\\([^"]+)"$/gm)) {
    try { fs.rmdirSync(path.join(installedRoot, m[1].replaceAll('\\', '/'))); } catch (e) { assert.equal(e.code, 'ENOTEMPTY'); }
  }
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep me');
  assert.deepEqual(entries(installedRoot), ['desktop-daemon/src/user-note.txt', 'runtime.nsh']);
  // Repeated staging preserves the exact deterministic payload, never absorbs unknown files.
  r = run(); assert.equal(r.status, 0, r.stderr);
  const before = fs.readFileSync(path.join(out, 'runtime.nsh'));
  fs.writeFileSync(path.join(out, 'unlisted.txt'), 'unlisted');
  r = run(); assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, /unexpected staged entry: unlisted.txt/);
  assert.equal(fs.readFileSync(path.join(out, 'unlisted.txt'), 'utf8'), 'unlisted');
  assert.deepEqual(fs.readFileSync(path.join(out, 'runtime.nsh')), before);
  // HU-047: the install manifest lists the helper and every closed runtime file with sha256 (consumed by win-fs.cjs).
  const distFixture = path.join(scratch, 'dist-manifest'); fs.mkdirSync(distFixture);
  fs.writeFileSync(path.join(distFixture, 'abito-private-session.exe'), 'helper fixture');
  r = spawnSync(process.execPath, [path.join(crate, 'packaging/windows/install-manifest.cjs'), '--dist', distFixture], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(distFixture, 'abito-install.json'), 'utf8'));
  assert.equal(manifest.schema, 'abito-install/1');
  assert.deepEqual(Object.keys(manifest.files).sort(), ['abito-private-session.exe', ...files].sort());
  for (const f of files) assert.equal(manifest.files[f], require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(crate, '..', f))).digest('hex'));
  // HU-061: the daemon ships its own byte-identical copy of the helper protocol module (the harness copy is the source of truth).
  assert.ok(files.includes('desktop-daemon/src/win-fs.cjs'));
  assert.deepEqual(fs.readFileSync(path.join(crate, '../desktop-daemon/src/win-fs.cjs')), fs.readFileSync(path.join(crate, '../desktop-harness/src/win-fs.cjs')), 'daemon win-fs.cjs must be byte-identical to the harness one');
  assert.ok(files.includes('desktop-harness/src/win-fs.cjs') && files.includes('desktop-harness/src/install-pi-win.cjs'));
  // Exercise receipt generation/check through its public CLI in an isolated source tree.
  const fixture = path.join(scratch, 'source');
  const fixtureCrate = path.join(fixture, 'apps/desktop-tauri');
  const copy = (rel) => {
    const dest = path.join(fixtureCrate, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(crate, rel), dest);
  };
  for (const f of ['Cargo.toml', 'Cargo.lock', 'tauri.conf.json', 'capabilities/main.json',
    'packaging/lib.cjs', 'packaging/windows/stage-runtime.cjs', 'packaging/windows/stage-win.cjs',
    'packaging/windows/xbuild.sh', 'packaging/windows/abito.nsi', 'packaging/windows/Dockerfile',
    ...L.FRONTEND_FILES.map(f => `frontend/${f}`), ...files.map(f => `../${f}`)]) copy(f);
  for (const args of [['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture']]) {
    const git = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' }); assert.equal(git.status, 0, git.stderr);
  }
  r = spawnSync(process.execPath, [path.join(fixtureCrate, 'packaging/windows/stage-runtime.cjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const dist = path.join(fixtureCrate, 'dist');
  const version = JSON.parse(fs.readFileSync(path.join(fixtureCrate, 'tauri.conf.json'))).version;
  for (const f of [...bins, `koda-${version}-win-x64-setup.exe`]) fs.writeFileSync(path.join(dist, f), 'fixture, not a Windows executable');
  const receiptRun = (...args) => spawnSync(process.execPath, [path.join(fixtureCrate, 'packaging/windows/stage-win.cjs'), ...args], { encoding: 'utf8' });
  r = receiptRun(); assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, '');
  r = receiptRun('--check'); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, 'OK: windows artifacts match the receipt\n'); assert.equal(r.stderr, '');
  const receiptFile = path.join(dist, 'receipt-windows.json');
  const originalReceipt = fs.readFileSync(receiptFile);
  fs.appendFileSync(path.join(dist, bins[1]), 'tamper');
  r = receiptRun('--check'); assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, /files hash mismatch: abito-notice-relay.exe/);
  assert.deepEqual(fs.readFileSync(receiptFile), originalReceipt);
  fs.writeFileSync(path.join(dist, bins[1]), 'fixture, not a Windows executable');
  fs.appendFileSync(path.join(fixtureCrate, 'packaging/windows/xbuild.sh'), '\n# changed input\n');
  r = receiptRun('--check'); assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, /inputs hash mismatch: packaging\/windows\/xbuild.sh/);
  assert.deepEqual(fs.readFileSync(receiptFile), originalReceipt);
  console.log('PASS: Windows runtime closed set, require closure, NSIS equivalence, preservation, rejection and receipt CLI');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }

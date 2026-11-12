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
const bins = ['abito-island.exe', 'abito-notice-relay.exe', 'abito-private-session.exe', 'abito-transcribe.exe', 'abito-install.json'];
function run(...args) { return spawnSync(process.execPath, [script, '--out', out, ...args], { encoding: 'utf8' }); }
function runOut(dest, ...args) { return spawnSync(process.execPath, [script, '--out', dest, ...args], { encoding: 'utf8' }); }
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
  // K2-02 T2 (decision B): the Windows installer ships the bundled Node+Pi runtime as ONE
  // sha256-verified archive. Every contract line is checked as its own rule so each shows
  // its own RED/GREEN; the archive fixture is plain bytes (no extraction happens here).
  const crypto = require('node:crypto');
  const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const outArchive = path.join(scratch, 'payload-archive');
  const archiveSource = path.join(scratch, 'koda-runtime-win-x64.tar.gz');
  fs.writeFileSync(archiveSource, 'fixture runtime archive: plain bytes, not a real tar.gz');
  const stagedArchive = path.join(outArchive, 'koda-runtime.tar.gz');
  const runtimeNsh = () => fs.readFileSync(path.join(outArchive, 'runtime.nsh'), 'utf8');
  const rules = [];
  const rule = (name, fn) => rules.push([name, fn]);
  rule('stage-runtime --runtime-archive stages the archive and embeds its sha256 at stage time', () => {
    const r = runOut(outArchive, '--runtime-archive', archiveSource);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`runtime archive: koda-runtime\\.tar\\.gz sha256 ${sha256(stagedArchive)}`));
    assert.deepEqual(entries(outArchive), [...files, 'koda-runtime.tar.gz', 'runtime.nsh'].sort());
    assert.match(runtimeNsh(), new RegExp(`^!define KODA_RUNTIME_SHA256 ${sha256(stagedArchive)}$`, 'm'));
  });
  rule('runtime.nsh: the install macro Files the archive, verifies it with quoted certutil, extracts it with quoted System32 tar, aborts on any failure and never leaves the archive behind', () => {
    const nsh = runtimeNsh();
    assert.ok(nsh.includes('  File "/ONAME=koda-runtime.tar.gz" "${RUNTIMEDIR}\\koda-runtime.tar.gz"'), 'archive is File\'d under $INSTDIR');
    assert.ok(nsh.includes(`nsExec::ExecToStack 'certutil -hashfile "$INSTDIR\\koda-runtime.tar.gz" SHA256'`), 'quoted certutil hash check');
    assert.ok(nsh.includes(`nsExec::Exec '"$SYSDIR\\tar.exe" -xzf "$INSTDIR\\koda-runtime.tar.gz" -C "$INSTDIR\\runtime.new"'`), 'quoted System32 tar extraction into a fresh directory');
    assert.ok((nsh.match(/Abort "/g) || []).length >= 3, 'abort on certutil failure, hash mismatch and tar failure');
    assert.ok((nsh.match(/Delete "\$INSTDIR\\koda-runtime\.tar\.gz"/g) || []).length >= 2, 'archive deleted on mismatch and after success');
    assert.match(nsh, /Rename "\$INSTDIR\\runtime\.new" "\$INSTDIR\\runtime"\s+\$\{If\} \$\{Errors\}/, 'extracted directory is swapped into place, failing closed');
  });
  const macroBody = (nsh, name) => { const a = nsh.indexOf(`!macro ${name}`); assert.ok(a >= 0, `${name} macro exists`); return nsh.slice(a, nsh.indexOf('!macroend', a)); };
  const guardedTargets = (text) => (text.match(/!insertmacro AbitoRuntimeGuardedRmDirR "[^"]*"/g) || []).map((m) => m.split('"')[1]);
  rule('runtime.nsh: every RMDir /r is guarded — the TARGET is never empty, a drive root or outside $INSTDIR, never a reparse point or junction — and the uninstaller uses the same guarded removal (R1-001)', () => {
    const nsh = runtimeNsh();
    const start = nsh.indexOf('!macro AbitoRuntimeGuardedRmDirR');
    assert.ok(start >= 0, 'guarded removal macro exists');
    const end = nsh.indexOf('!macroend', start);
    const guard = nsh.slice(start, end);
    assert.equal((nsh.match(/RMDir \/r/g) || []).length, 1, 'the only RMDir /r lives inside the guarded macro');
    assert.ok(nsh.indexOf('RMDir /r') > start && nsh.indexOf('RMDir /r') < end);
    // the guard checks ${_dir} itself, so a future caller cannot bypass it
    assert.match(guard, /StrLen \$R0 "\$\{_dir\}"\s+\$\{If\} \$R0 <= 3/, 'refuse an empty target or a drive root (C:, C:\\)');
    assert.match(guard, /StrLen \$R2 "\$INSTDIR"\s+\$\{If\} \$R2 <= 3/, 'still refuse an empty $INSTDIR or a drive root');
    assert.match(guard, /StrCpy \$R3 "\$\{_dir\}" \$R2\s+\$\{If\} \$R3 != "\$INSTDIR"/, 'the target must start with $INSTDIR');
    assert.match(guard, /StrCpy \$R3 "\$\{_dir\}" 1 \$R2\s+\$\{If\} \$R3 != "\\"/, 'followed by a path separator (not a sibling such as $INSTDIR-evil)');
    assert.match(guard, /IntOp \$R2 \$R2 \+ 1\s+\$\{If\} \$R0 <= \$R2/, 'and a non-empty name after it (never $INSTDIR itself)');
    assert.ok(guard.indexOf('$R0 <= $R2') < guard.indexOf('GetFileAttributesW'), 'all path checks precede the attribute check');
    assert.ok(guard.indexOf('RMDir /r') > guard.indexOf('GetFileAttributesW'));
    assert.match(guard, /GetFileAttributesW/);
    assert.match(guard, /& 0x400/, 'refuse FILE_ATTRIBUTE_REPARSE_POINT');
    // every refusal restores the four pushed registers before aborting
    assert.equal((guard.match(/Push \$R\d/g) || []).length, 4);
    for (const m of guard.matchAll(/((?:    Pop \$R\d\n){4})\s+Abort/g)) assert.equal(m[1].split('\n').filter(Boolean).length, 4);
    assert.equal((guard.match(/Abort "/g) || []).length, 6, 'six refusals: empty/drive root target, bad $INSTDIR, outside $INSTDIR, no separator after it, $INSTDIR itself, reparse point');
    assert.match(nsh, /!macro AbitoUninstallRuntime\s+!insertmacro AbitoRuntimeGuardedRmDirR "\$INSTDIR\\runtime"\s+; [^\n]*\s+!insertmacro AbitoRuntimeGuardedRmDirR "\$INSTDIR\\runtime\.old"\s+!insertmacro AbitoRuntimeGuardedRmDirR "\$INSTDIR\\runtime\.new"\s+Delete "\$INSTDIR\\koda-runtime\.tar\.gz"\s+!macroend/,
      'uninstall removes the runtime and any leftover runtime.old/runtime.new/archive of a failed install, all through the guard');
    assert.deepEqual(guardedTargets(macroBody(nsh, 'AbitoInstallRuntime')),
      ['$INSTDIR\\runtime.new', '$INSTDIR\\runtime.new', '$INSTDIR\\runtime.old', '$INSTDIR\\runtime.new', '$INSTDIR\\runtime.new', '$INSTDIR\\runtime.old'],
      'stale runtime.new, failed extract, stale runtime.old, failed move-aside, failed activate and the success cleanup all use the guard');
  });
  rule('R4-upgrade-runtime-swap-not-atomic: the old runtime is renamed aside to runtime.old, never deleted before the new one is in place; a failed activation restores it', () => {
    const body = macroBody(runtimeNsh(), 'AbitoInstallRuntime');
    const aside = body.indexOf('Rename "$INSTDIR\\runtime" "$INSTDIR\\runtime.old"');
    const activate = body.indexOf('Rename "$INSTDIR\\runtime.new" "$INSTDIR\\runtime"');
    const restore = body.indexOf('Rename "$INSTDIR\\runtime.old" "$INSTDIR\\runtime"');
    assert.ok(aside > 0 && activate > aside && restore > activate, 'aside, then activate, then (on failure) restore');
    assert.doesNotMatch(body, /AbitoRuntimeGuardedRmDirR "\$INSTDIR\\runtime"\n/, 'the live runtime is never removed by the installer');
    assert.match(body, /\$\{If\} \$\{FileExists\} "\$INSTDIR\\runtime"\s+ClearErrors\s+Rename "\$INSTDIR\\runtime" "\$INSTDIR\\runtime\.old"\s+\$\{If\} \$\{Errors\}\s+Delete "\$INSTDIR\\koda-runtime\.tar\.gz"\s+!insertmacro AbitoRuntimeGuardedRmDirR "\$INSTDIR\\runtime\.new"\s+Abort "Koda: could not move the current runtime aside[^"]*"/,
      'a failed move-aside aborts with the current runtime untouched');
    assert.match(body, /ClearErrors\s+Rename "\$INSTDIR\\runtime\.new" "\$INSTDIR\\runtime"\s+\$\{If\} \$\{Errors\}\s+Delete "\$INSTDIR\\koda-runtime\.tar\.gz"\s+\$\{If\} \$\{FileExists\} "\$INSTDIR\\runtime\.old"\s+ClearErrors\s+Rename "\$INSTDIR\\runtime\.old" "\$INSTDIR\\runtime"\s+\$\{If\} \$\{Errors\}\s+Abort "Koda: could not restore the previous runtime[^"]*runtime\.old[^"]*"\s+\$\{EndIf\}\s+\$\{EndIf\}\s+!insertmacro AbitoRuntimeGuardedRmDirR "\$INSTDIR\\runtime\.new"\s+Abort "Koda: could not activate the extracted runtime directory[^"]*"/,
      'a failed activation restores runtime.old, then cleans runtime.new and aborts');
    const tail = body.slice(activate);
    assert.match(tail, /\$\{EndIf\}\s+!insertmacro AbitoRuntimeGuardedRmDirR "\$INSTDIR\\runtime\.old"\s+Delete "\$INSTDIR\\koda-runtime\.tar\.gz"\s*$/, 'on success runtime.old goes through the guard, then the archive is deleted');
    assert.ok(body.indexOf('AbitoRuntimeGuardedRmDirR "$INSTDIR\\runtime.old"') < aside, 'a stale runtime.old of an earlier failed run is cleared before moving the live runtime aside');
  });
  rule('R4-abort-after-payload-orphans-files: the archive is File\'d and hash-verified by AbitoVerifyRuntime BEFORE any payload is written; AbitoInstallRuntime only extracts and swaps', () => {
    const nsh = runtimeNsh();
    const verify = macroBody(nsh, 'AbitoVerifyRuntime');
    const install = macroBody(nsh, 'AbitoInstallRuntime');
    assert.ok(verify.includes('  File "/ONAME=koda-runtime.tar.gz" "${RUNTIMEDIR}\\koda-runtime.tar.gz"'));
    assert.ok(verify.includes(`nsExec::ExecToStack 'certutil -hashfile "$INSTDIR\\koda-runtime.tar.gz" SHA256'`));
    assert.match(verify, /Abort "Koda: the bundled runtime archive failed its SHA256 check[^"]*Nothing was changed\."/);
    assert.match(verify, /Abort "Koda: could not hash the bundled runtime archive[^"]*Nothing was changed\."/);
    assert.doesNotMatch(verify, /tar\.exe|Rename|RMDir/, 'verifying never extracts or swaps');
    assert.doesNotMatch(install, /File |certutil|KODA_RUNTIME_SHA256/, 'the install half only extracts and swaps the already verified archive');
    assert.ok(install.includes('tar.exe'));
    assert.ok(nsh.indexOf('!macro AbitoVerifyRuntime') < nsh.indexOf('!macro AbitoInstallRuntime'));
    const nsis = fs.readFileSync(path.join(crate, 'packaging/windows/abito.nsi'), 'utf8');
    const section = nsis.slice(nsis.indexOf('Section "Koda"'), nsis.indexOf('SectionEnd'));
    const at = (needle) => { const i = section.indexOf(needle); assert.ok(i >= 0, `${needle} present in Section "Koda"`); return i; };
    assert.ok(at('!insertmacro AbitoVerifyRuntime') < at('!insertmacro AbitoInstallPayload'), 'verify first: a bad archive aborts with no payload written');
    assert.ok(at('!insertmacro AbitoInstallPayload') < at('WriteUninstaller'), 'uninstaller written right after the payload');
    assert.ok(at('WriteUninstaller') < at('!insertmacro AbitoInstallRuntime'), 'and BEFORE the extract/swap, so a failed extract is still removable with uninstall.exe');
    assert.equal((section.match(/!insertmacro AbitoVerifyRuntime/g) || []).length, 1);
    assert.equal((section.match(/!insertmacro AbitoInstallRuntime/g) || []).length, 1);
  });
  rule('R3-nsi-unconditional-runtime-macro: abito.nsi fails the BUILD with a clear message when no runtime archive was staged (no KODA_RUNTIME_SHA256)', () => {
    // A Windows checkout may give abito.nsi CRLF line endings (core.autocrlf); the rule is about content.
    const nsis = fs.readFileSync(path.join(crate, 'packaging/windows/abito.nsi'), 'utf8').replace(/\r\n/g, '\n');
    const inc = nsis.indexOf('!include "${RUNTIMEDIR}\\runtime.nsh"');
    const guard = '!ifndef KODA_RUNTIME_SHA256\n!error "K2-02: the runtime archive was not staged (stage-runtime.cjs --runtime-archive)"\n!endif';
    assert.ok(nsis.includes(guard), 'ifndef/!error guard with the exact message');
    assert.ok(nsis.indexOf(guard) > inc, 'checked right after runtime.nsh is included');
    assert.ok(nsis.indexOf(guard) < nsis.indexOf('Section "Koda"'), 'and before any use of the macros');
    // Without an archive the generated include still carries no runtime macros, so the guard is what fires.
    assert.doesNotMatch(fs.readFileSync(path.join(out, 'runtime.nsh'), 'utf8'), /KODA_RUNTIME_SHA256|AbitoVerifyRuntime|AbitoInstallRuntime/);
  });
  rule('R3-stale-archive-reuse: staging WITHOUT --runtime-archive into a dir that still holds koda-runtime.tar.gz is refused (exit 1, exact message), nothing removed or rewritten', () => {
    const stale = path.join(scratch, 'payload-stale');
    let r = runOut(stale, '--runtime-archive', archiveSource);
    assert.equal(r.status, 0, r.stderr);
    const nshBefore = fs.readFileSync(path.join(stale, 'runtime.nsh'));
    const archiveBefore = fs.readFileSync(path.join(stale, 'koda-runtime.tar.gz'));
    r = runOut(stale);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `stale runtime archive in the output directory: ${path.join(stale, 'koda-runtime.tar.gz')} (stage with --runtime-archive to replace it, or remove it yourself; it is never reused silently)\n`);
    assert.deepEqual(fs.readFileSync(path.join(stale, 'runtime.nsh')), nshBefore, 'runtime.nsh untouched');
    assert.deepEqual(fs.readFileSync(path.join(stale, 'koda-runtime.tar.gz')), archiveBefore, 'archive not removed');
    // restaging WITH an archive still works, and a dir without a stale archive stages as before
    r = runOut(stale, '--runtime-archive', archiveSource); assert.equal(r.status, 0, r.stderr);
    fs.unlinkSync(path.join(stale, 'koda-runtime.tar.gz'));
    r = runOut(stale); assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(fs.readFileSync(path.join(stale, 'runtime.nsh'), 'utf8'), /KODA_RUNTIME_SHA256/);
  });
  rule('runtime.nsh: a failed extract removes the archive and the partial runtime.new before aborting; the swap clears stale errors first', () => {
    const nsh = runtimeNsh();
    const failed = nsh.slice(nsh.indexOf('-C "$INSTDIR\\runtime.new"'), nsh.indexOf('could not extract the bundled runtime'));
    assert.match(failed, /Delete "\$INSTDIR\\koda-runtime\.tar\.gz"\s+!insertmacro AbitoRuntimeGuardedRmDirR "\$INSTDIR\\runtime\.new"\s+Abort "Koda: $/);
    assert.match(nsh, /ClearErrors\s+Rename "\$INSTDIR\\runtime\.new" "\$INSTDIR\\runtime"\s+\$\{If\} \$\{Errors\}/);
  });
  rule('README documents the install order, the failure leftovers and the TOCTOU known limit of the guarded removal (R1-001, R4)', () => {
    const readme = fs.readFileSync(path.join(crate, 'packaging/windows/README.md'), 'utf8');
    assert.match(readme, /Known limit \(R1-001\)[^\n]*TOCTOU[^\n]*same-user/);
    assert.match(readme, /AbitoVerifyRuntime[^\n]*before[^\n]*payload/i);
    assert.match(readme, /runtime\.old/);
    assert.match(readme, /KODA_RUNTIME_SHA256[^\n]*fails the build|fails the build[^\n]*KODA_RUNTIME_SHA256/i);
    assert.match(readme, /stale[^\n]*koda-runtime\.tar\.gz[^\n]*refus|refus[^\n]*stale[^\n]*koda-runtime\.tar\.gz/i);
  });
  rule('nsisInclude() regenerates the staged runtime.nsh byte-for-byte (stage-win receipt equivalence)', () => {
    const { nsisInclude: include } = require('../packaging/windows/stage-runtime.cjs');
    assert.equal(include(outArchive), runtimeNsh());
  });
  rule('stage-runtime refuses a missing runtime archive with exit code 1 and an exact message', () => {
    const absent = path.join(scratch, 'absent-koda-runtime.tar.gz');
    const r = runOut(outArchive, '--runtime-archive', absent);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `not a regular file: ${path.resolve(absent)}\n`);
  });
  rule('an unexpected staged entry still fails when the archive is staged, and nothing is removed', () => {
    fs.writeFileSync(path.join(outArchive, 'unlisted.txt'), 'unlisted');
    const r = runOut(outArchive, '--runtime-archive', archiveSource);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unexpected staged entry: unlisted\.txt/);
    assert.equal(fs.readFileSync(path.join(outArchive, 'unlisted.txt'), 'utf8'), 'unlisted');
  });
  rule('abito-install.json lists runtime/node.exe with its sha256 via --runtime, and the previous entries are unchanged without it', () => {
    const distA = path.join(scratch, 'dist-manifest-runtime');
    const distB = path.join(scratch, 'dist-manifest-plain');
    const runtimeDir = path.join(scratch, 'runtime-fixture');
    fs.mkdirSync(distA); fs.mkdirSync(distB); fs.mkdirSync(runtimeDir);
    fs.writeFileSync(path.join(runtimeDir, 'node.exe'), 'pinned node fixture');
    fs.writeFileSync(path.join(runtimeDir, 'ffmpeg.exe'), 'pinned ffmpeg fixture');
    for (const d of [distA, distB]) fs.writeFileSync(path.join(d, 'abito-private-session.exe'), 'helper fixture');
    const runManifest = (dist, ...extra) => {
      const r = spawnSync(process.execPath, [path.join(crate, 'packaging/windows/install-manifest.cjs'), '--dist', dist, ...extra], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(fs.readFileSync(path.join(dist, 'abito-install.json'), 'utf8'));
    };
    const plain = runManifest(distB);
    const withRuntime = runManifest(distA, '--runtime', runtimeDir);
    assert.equal(withRuntime.schema, 'abito-install/1');
    assert.deepEqual(Object.keys(withRuntime.files).sort(), [...Object.keys(plain.files), 'runtime/node.exe', 'runtime/ffmpeg.exe'].sort());
    assert.equal(withRuntime.files['runtime/node.exe'], sha256(path.join(runtimeDir, 'node.exe')));
    // K2-13 (S9): the bundled LGPL ffmpeg the daemon spawns is pinned like node.exe.
    assert.equal(withRuntime.files['runtime/ffmpeg.exe'], sha256(path.join(runtimeDir, 'ffmpeg.exe')));
    assert.deepEqual(Object.keys(plain.files).sort(), ['abito-private-session.exe', ...files].sort());
  });
  rule('macOS /var -> /private/var (K2-01b CI): a symlinked ANCESTOR of the output dir (outside the stage) is accepted, while a symlink inside the stage is still refused', () => {
    if (process.platform === 'win32') return; // creating a POSIX symlink ancestor needs unix (the macOS layout is the case)
    const real = path.join(scratch, 'real-var');
    fs.mkdirSync(real);
    const linkedVar = path.join(scratch, 'var'); // like macOS /var: a symlink to the real directory, ABOVE the stage
    fs.symlinkSync(real, linkedVar);
    const dest = path.join(linkedVar, 'folders', 'x', 'payload');
    const ok = runOut(dest);
    assert.equal(ok.status, 0, `stdout=${ok.stdout}\nstderr=${ok.stderr}`);
    assert.match(ok.stdout, /^staged: \d+ runtime files\n/);
    // inside the stage, a symlink is still an unexpected entry (closed set, never followed)
    fs.symlinkSync(real, path.join(dest, 'desktop-daemon', 'linked'));
    const bad = runOut(dest);
    assert.equal(bad.status, 1);
    assert.equal(bad.stderr, 'unexpected staged entry: desktop-daemon/linked\n');
  });
  let failedRules = 0;
  for (const [name, fn] of rules) {
    try { fn(); console.log(`PASS: ${name}`); } catch (e) { failedRules += 1; console.log(`FAIL: ${name}\n      ${String(e.message).split('\n')[0]}`); }
  }
  if (failedRules > 0) { console.error(`FAIL: ${failedRules} runtime-archive rule(s) failed`); process.exitCode = 1; }
  console.log('PASS: Windows runtime closed set, require closure, NSIS equivalence, preservation, rejection and receipt CLI');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }

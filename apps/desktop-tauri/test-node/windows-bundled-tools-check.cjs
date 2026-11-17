'use strict';
// K2-13: on Windows the daemon finds ffmpeg.exe, yt-dlp.exe, node.exe and koda-transcribe.exe where the INSTALLER puts them.
//
// Two halves already existed and never met. The unit tests of desktop-daemon prove the lookups (bundledTools,
// bundledYtDlp, bundledNode) by writing files they named themselves; windows-runtime-check proves the installer ships
// those four files. Nothing proved that the path the installer writes is the path the daemon reads. This check builds
// the installed layout FROM THE INSTALLER'S OWN SOURCES and runs the daemon's real lookups over it:
//   * runtime\node.exe, runtime\ffmpeg.exe, runtime\yt-dlp.exe: from the manifest install-manifest.cjs writes (abito-install.json);
//   * koda-transcribe.exe and the daemon's own files: from the `Delete "$INSTDIR\..."` lines of the NSIS include that
//     stage-runtime.cjs generates (one per installed file);
//   * the install root the daemon derives: the very expression daemon.cjs uses, read from its source, applied to the
//     installed copy of desktop-daemon\src.
// If the installer moves a binary, the file lands somewhere the lookup does not read and this check fails. It runs on
// every OS: the lookups take the platform as an argument, so the win32 names are exercised on a Linux or macOS host too.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crate = path.resolve(__dirname, '..');
const daemonSrc = path.resolve(crate, '..', 'desktop-daemon', 'src');
const S = require('../packaging/windows/stage-runtime.cjs');
const M = require('../packaging/windows/install-manifest.cjs');
const { bundledTools } = require(path.join(daemonSrc, 'minikodas', 'transcribe.cjs'));
const { bundledYtDlp, bundledNode } = require(path.join(daemonSrc, 'minikodas', 'youtube.cjs'));

let passed = 0;
const rule = (name, fn) => { fn(); passed += 1; console.log(`PASS ${name}`); };

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'koda-bundled-tools-')));
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* best effort */ } });

const touch = (file, text = 'fixture') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// ---- the installer's own description of what lands where --------------------------------------------------------------
// 1. The manifest, built the way `install-manifest.cjs --runtime` builds it, over a fixture dist and runtime folder.
const dist = path.join(scratch, 'dist');
const runtimeFixture = path.join(scratch, 'runtime-fixture');
touch(path.join(dist, M.HELPER));
for (const exe of ['node.exe', 'ffmpeg.exe', 'yt-dlp.exe']) touch(path.join(runtimeFixture, exe));
const manifest = JSON.parse(M.build(dist, runtimeFixture));
// 2. The NSIS include: every installed file appears once as `Delete "$INSTDIR\<relative path with backslashes>"`.
const nsis = S.nsisInclude(path.join(scratch, 'out'));
const nsisInstalled = [...nsis.matchAll(/^\s*Delete "\$INSTDIR\\([^"]+)"/gm)].map((m) => m[1].split('\\').join('/'));

/** The installed tree: one empty file per path the installer writes. */
function installTree(root, { without = [], extra = [] } = {}) {
  for (const rel of new Set([...Object.keys(manifest.files), ...nsisInstalled, ...extra])) {
    if (without.includes(rel)) continue;
    touch(path.join(root, ...rel.split('/')), '');
  }
}

/** The install root exactly as daemon.cjs derives it, taken from its source, applied to the installed desktop-daemon\src. */
function daemonInstallRoot(instdir) {
  const text = fs.readFileSync(path.join(daemonSrc, 'daemon.cjs'), 'utf8');
  assert.match(text, /installRoot:\s*path\.resolve\(__dirname, "\.\.", "\.\."\)/, 'daemon.cjs derives the install root for bundledTools as <desktop-daemon>/src/../..');
  assert.match(text, /const installRoot = path\.resolve\(__dirname, "\.\.", "\.\."\)/, 'daemon.cjs derives the install root for yt-dlp as <desktop-daemon>/src/../..');
  const installedDaemon = path.join(instdir, 'desktop-daemon', 'src');
  assert.ok(nsisInstalled.includes('desktop-daemon/src/daemon.cjs'), 'the installer installs desktop-daemon\\src\\daemon.cjs');
  assert.ok(fs.statSync(path.join(installedDaemon, 'daemon.cjs')).isFile());
  return path.resolve(installedDaemon, '..', '..');
}

const resolveAll = (root) => ({
  ...bundledTools({ installRoot: root, platform: 'win32' }),
  ytdlp: bundledYtDlp({ installRoot: root, platform: 'win32' }),
  node: bundledNode({ installRoot: root, platform: 'win32' }),
});

// ---- the contract ------------------------------------------------------------------------------------------------------
const instdir = path.join(scratch, 'Programs', 'Koda');
installTree(instdir);
const root = daemonInstallRoot(instdir);

rule('the installer lists the four binaries, and the daemon derives the install root they sit under', () => {
  for (const rel of ['runtime/node.exe', 'runtime/ffmpeg.exe', 'runtime/yt-dlp.exe']) assert.ok(manifest.files[rel], `the manifest pins ${rel}`);
  assert.ok(nsisInstalled.includes('koda-transcribe.exe'), 'the NSIS include installs koda-transcribe.exe');
  assert.equal(root, instdir, 'desktop-daemon\\src\\..\\.. is the install directory');
});

rule('on the installed layout the daemon resolves ffmpeg.exe, yt-dlp.exe, node.exe and koda-transcribe.exe', () => {
  const found = resolveAll(root);
  assert.equal(found.ffmpeg, path.join(instdir, 'runtime', 'ffmpeg.exe'));
  assert.equal(found.ytdlp, path.join(instdir, 'runtime', 'yt-dlp.exe'));
  assert.equal(found.node, path.join(instdir, 'runtime', 'node.exe'));
  assert.equal(found.helper, path.join(instdir, 'koda-transcribe.exe'));
});

rule('every one of them is the file the installer lists, not a name the lookup invented', () => {
  const found = resolveAll(root);
  const rel = (file) => path.relative(instdir, file).split(path.sep).join('/');
  assert.ok(manifest.files[rel(found.ffmpeg)], 'ffmpeg.exe is in the manifest');
  assert.ok(manifest.files[rel(found.ytdlp)], 'yt-dlp.exe is in the manifest');
  assert.ok(manifest.files[rel(found.node)], 'node.exe is in the manifest');
  assert.ok(nsisInstalled.includes(rel(found.helper)), 'koda-transcribe.exe is one of the files the NSIS include installs');
});

// A binary that the installer moves must NOT be found (no fallback to PATH, no second location): the check bites.
for (const [label, rel, pick] of [
  ['ffmpeg.exe', 'runtime/ffmpeg.exe', (f) => f.ffmpeg],
  ['yt-dlp.exe', 'runtime/yt-dlp.exe', (f) => f.ytdlp],
  ['node.exe', 'runtime/node.exe', (f) => f.node],
  ['koda-transcribe.exe', 'koda-transcribe.exe', (f) => f.helper],
]) {
  rule(`if the installer moved ${label} elsewhere the daemon would not find it`, () => {
    const moved = path.join(scratch, `moved-${label}`, 'Koda');
    installTree(moved, { without: [rel], extra: [`bin/${path.posix.basename(rel)}`] });
    const movedRoot = daemonInstallRoot(moved);
    assert.equal(pick(resolveAll(movedRoot)), undefined, `${label} is looked up at ${rel} only`);
  });
}

console.log(`windows-bundled-tools-check: ${passed} passed`);

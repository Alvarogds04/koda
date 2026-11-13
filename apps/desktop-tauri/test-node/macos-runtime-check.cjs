'use strict';
// S1/S2/S5: exercise the public bundle generator and the rendered runtime messages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crate = path.resolve(__dirname, '..');
const S = require('../frontend/settings-view.js');
const O = require('../frontend/overview-view.js');
const L = require('../packaging/lib.cjs');
const messages = {
  node_missing: ['Falta Node.js', 'Falta Node.js: instalalo desde nodejs.org.'],
  pi_missing: ['Falta el motor de Koda', 'Falta el motor de Koda: La instalación de Koda está incompleta: falta el motor propio de Koda; volvé a instalar Koda.'],
};
for (const [code, [word, detail]] of Object.entries(messages)) {
  const state = { connection: 'no_daemon', last_error: { code, n: 1 } };
  const view = S.connectionView(state);
  assert.equal(view.word, word);
  assert.equal(view.aria, detail);
  // K2-02 (S4): the island keeps the plain label and, for a missing Pi, the «Abrir Chat» link; the pointer to
  // «Instalar Pi» (which used to live in Ajustes → Chat) is GONE — Koda ships its own Node and Pi.
  const row = O.engineRowView({ kind: 'down' }, state);
  assert.equal(row.label, word);
  assert.ok(!row.aria.includes('Instalar Pi') && !row.aria.includes('Instalar Node'), `${code}: no install pointer in the island row: ${row.aria}`);
  if (code === 'node_missing') assert.ok(row.aria.includes('instalalo desde nodejs.org.'), `${code}: the dev-build pointer stays: ${row.aria}`);
  if (code === 'pi_missing') {
    assert.equal(row.target, 'accounts:motor', 'the existing link: settings.js opens Ajustes on the Chat page for every engine deep link');
    assert.ok(!row.aria.includes('npm install'), 'the island does not ask the human to type a command');
    assert.equal(row.link, 'Abrir Chat', 'a link, not an install button');
    assert.ok(row.aria.includes('Falta el motor de Koda'), `the plain label stays: ${row.aria}`);
  }
}
assert.equal(S.connectionView({ connection: 'no_daemon' }).word, 'Sin motor');
assert.equal(S.connectionView({ connection: 'lost', last_error: { code: 'pi_missing' } }).word, 'Motor caído');
assert.equal(S.connectionView({ connection: 'connected', last_error: { code: 'pi_missing' } }), null);
assert.equal(O.engineRowView({ kind: 'down' }, { connection: 'no_daemon' }).label, 'Sin motor');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-macos-bundle-'));
// K2-02 (S1, S2): the .app carries Koda's own Node + Pi as the expanded runtime folder built by
// packaging/runtime/build-runtime.cjs --target darwin-arm64, in Contents/Resources/runtime/; the ad-hoc seal hashes every file.
const runtimes = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-macos-runtime-'));
function fakeRuntime(name, target) {
  const r = path.join(runtimes, name);
  fs.mkdirSync(r);
  fs.mkdirSync(path.join(r, 'bin'), { recursive: true });
  // K2-05 T1b fixture parity: the real build emits bin/engram and manifest keys engram/engramBin next to pi/gentleShell.
  fs.writeFileSync(path.join(r, 'koda-runtime.json'), JSON.stringify({ target, node: '22.23.4', pi: '1.4.0', piCli: 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', gentlePi: '4.3.0', gentleShell: 'node_modules/gentle-pi/bin/gentle-shell.mjs', engram: '3.4.0', engramBin: 'bin/engram' }));
  for (const f of ['node', 'pi', 'gentle-shell']) fs.writeFileSync(path.join(r, f), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(r, 'bin', 'engram'), '#!/bin/sh\n', { mode: 0o755 });
  return r;
}
const generate = (args) => cp.spawnSync(process.execPath, [path.join(crate, 'packaging/macos-config.cjs'), ...args], { cwd: dir, encoding: 'utf8' });
try {
  const runtime = fakeRuntime('darwin', 'darwin-arm64');
  assert.ok(fs.existsSync(path.join(runtime, 'bin/engram')), 'the fixture fake runtime carries bin/engram (K2-05 T1b parity)');
  const result = generate(['--runtime', runtime]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const config = JSON.parse(result.stdout);
  const expected = Object.fromEntries([
    ...L.DAEMON_FILES.map(f => [`../desktop-daemon/${f}`, `desktop-daemon/${f}`]),
    ...L.HARNESS_FILES.map(f => [`../desktop-harness/${f}`, `desktop-harness/${f}`]),
    ...L.PI_FILES.map(f => [`../desktop-pi/${f}`, `desktop-pi/${f}`]),
  ]);
  const shipped = { ...config.bundle.resources };
  // Tauri map notation: a source ending in a separator copies the whole folder recursively into the target.
  assert.equal(shipped[`${fs.realpathSync(runtime)}${path.sep}`], 'runtime/', 'the runtime folder ships as Resources/runtime/');
  delete shipped[`${fs.realpathSync(runtime)}${path.sep}`];
  assert.deepEqual(shipped, expected, 'every other resource is unchanged');
  // No runtime, or one built for another OS: refused, nothing printed on stdout (a bundle is never built without Koda's Node + Pi).
  let bad = generate([]);
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr, 'macos-config: usage: macos-config.cjs --runtime <dir> (the darwin-arm64 folder from packaging/runtime/build-runtime.cjs)\n');
  bad = generate(['--runtime', fakeRuntime('linux', 'linux-x64')]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr, `macos-config: ${fs.realpathSync(path.join(runtimes, 'linux'))} is a linux-x64 runtime, expected darwin-arm64\n`);
  bad = generate(['--runtime', path.join(runtimes, 'missing')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^macos-config: cannot read the runtime manifest .*koda-runtime\.json: /);
  const noPi = fakeRuntime('nopi', 'darwin-arm64');
  fs.rmSync(path.join(noPi, 'pi'));
  bad = generate(['--runtime', noPi]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, `macos-config: ${fs.realpathSync(noPi)} lacks the executable file pi\n`);
  // K2-05 T2 (T4/T6 follow-up): the daemon's engine is the bundled Gentle Shell and the memory
  // companion is the pinned bin/engram (T1/T1b), so a runtime without them is refused too,
  // exactly like one without pi — fail-closed, nothing is bundled without Koda's own engine.
  const noShell = fakeRuntime('noshell', 'darwin-arm64');
  fs.rmSync(path.join(noShell, 'gentle-shell'));
  bad = generate(['--runtime', noShell]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, `macos-config: ${fs.realpathSync(noShell)} lacks the executable file gentle-shell\n`);
  const noEngram = fakeRuntime('noengram', 'darwin-arm64');
  fs.rmSync(path.join(noEngram, 'bin', 'engram'));
  bad = generate(['--runtime', noEngram]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, `macos-config: ${fs.realpathSync(noEngram)} lacks the executable file bin/engram\n`);
  const noBinDir = fakeRuntime('nobindir', 'darwin-arm64');
  fs.rmSync(path.join(noBinDir, 'bin'), { recursive: true });
  bad = generate(['--runtime', noBinDir]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, `macos-config: ${fs.realpathSync(noBinDir)} lacks the real directory bin\n`);
  // A symlinked engine launcher or Engram binary is not a real install either (no symlink at any segment).
  const linked = fakeRuntime('linked', 'darwin-arm64');
  fs.rmSync(path.join(linked, 'gentle-shell'));
  fs.symlinkSync(path.join(linked, 'pi'), path.join(linked, 'gentle-shell'));
  bad = generate(['--runtime', linked]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, `macos-config: ${fs.realpathSync(linked)} lacks the executable file gentle-shell\n`);
  // K2-05 T1: the fake runtime has the manifest shape and the gentle-shell launcher + bin/engram the real
  // build emits; macos-config REFUSES a runtime without them (like one without pi): the bundle generator
  // ships the folder whole, so the engine and the memory binary travel with it or not at all.
  assert.equal(config.bundle.active, true);
  assert.equal(config.bundle.macOS.minimumSystemVersion, '12.0');
  // Ad-hoc seal of the whole bundle (no Apple account): Gatekeeper reports «unidentified developer», never «damaged».
  assert.equal(config.bundle.macOS.signingIdentity, '-');
  assert.equal(config.bundle.macOS.hardenedRuntime, false);
  // tauri-bundler only maps PNGs it has an IconType for (≤512 + @2x); ship a real .icns with every macOS size.
  assert.deepEqual(config.bundle.icon, ['icons/icon.icns']);
  const icns = fs.readFileSync(path.join(crate, 'icons/icon.icns'));
  assert.equal(icns.subarray(0, 4).toString('latin1'), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const types = []; for (let i = 8; i < icns.length; i += icns.readUInt32BE(i + 4)) types.push(icns.subarray(i, i + 4).toString('latin1'));
  for (const t of ['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']) assert.ok(types.includes(t), `icns has ${t}`);
  for (const file of Object.keys(expected)) assert.ok(fs.statSync(path.resolve(crate, file)).isFile(), file);
  assert.deepEqual(fs.readdirSync(dir), [], 'generator writes no files in its caller cwd');
} finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(runtimes, { recursive: true, force: true }); }
// The crate ships several binaries (island + Windows helpers): tauri-bundler needs the
// main one named or it refuses to bundle («failed to find main binary»).
assert.match(fs.readFileSync(path.join(crate, 'Cargo.toml'), 'utf8'), /^\[package\][\s\S]*?^default-run = "koda"$/m);
// The island is a menu-bar accessory: no Dock icon on macOS (LSUIElement), the tray keeps Mostrar/Ocultar/Salir.
const plist = fs.readFileSync(path.join(crate, 'Info.plist'), 'utf8');
assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key>/);
console.log('macos-runtime: 8 rules passed (missing runtime UI, existing states, exact bundle resources, bundled runtime folder with engine+memory refusals, ad-hoc seal, icns icon, main binary, no Dock icon)');

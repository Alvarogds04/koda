#!/usr/bin/env node
'use strict';
/* M4 format A build: OFFLINE release build + stage + receipt. Stages files
   only: it installs nothing, touches no installed app and never launches the
   binary. Usage: node packaging/build.cjs [--out <dir>] [--skip-cargo] [--smoke-variant]
   (--skip-cargo reuses target/release/abito-island, for re-staging). */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const L = require('./lib.cjs');

const crate = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outRoot = path.resolve(outIdx >= 0 ? args[outIdx + 1] : path.join(crate, 'dist'));

const prov = L.requireClean(crate);
L.requireClean(path.join(crate, '..', 'desktop-daemon')); L.requireClean(path.join(crate, '..', 'desktop-harness')); // the hook installer ships too (L42 F1) // shipped host bytes are product inputs too // fail BEFORE building when the tree has uncommitted product changes
const r6 = L.checkR6(crate);
L.checkFrontend(crate);
const cfg = L.checkConfig(crate);
// Reproducible across checkout paths: the crate dir, the cargo registry and the
// rust toolchain sources are remapped to fixed virtual paths, so no build-machine
// path ends up in the binary (the verifier also rejects $HOME/... paths).
const home = process.env.HOME || '';
const cargoHome = process.env.CARGO_HOME || path.join(home, '.cargo');
const rustSysroot = cp.spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).stdout.trim();
const remap = [[crate, '/abito/src'], [cargoHome, '/abito/cargo'], [rustSysroot, '/abito/rust'], [home, '/abito/home']]
  .map(([from, to]) => `--remap-path-prefix=${from}=${to}`).join(' ');
const env = { ...process.env, RUSTFLAGS: remap, CARGO_ENCODED_RUSTFLAGS: undefined };
function cargoBuild(extraArgs, targetDir) {
  const argv = ['build', '--release', '--locked', '--offline', ...extraArgs, '--target-dir', targetDir];
  const r = cp.spawnSync('cargo', argv, { cwd: crate, stdio: 'inherit', env });
  if (r.status !== 0) { console.error('cargo build failed (offline: no download is attempted)'); process.exit(1); }
}
// The SHIPPED binary: no `probe` feature (ABITO_PROBE/--probe do nothing, no fakes).
const shipTarget = path.join(crate, 'target-ship');
if (!args.includes('--skip-cargo')) cargoBuild(['--features', 'tauri/custom-protocol'], shipTarget);
const built = path.join(shipTarget, 'release', 'abito-island');
if (!fs.existsSync(built)) { console.error('release binary missing'); process.exit(1); }

const stage = path.join(outRoot, 'abito-island', cfg.version);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true, mode: 0o755 });
fs.copyFileSync(built, path.join(stage, 'abito-island'));
fs.chmodSync(path.join(stage, 'abito-island'), 0o755);
fs.copyFileSync(path.join(crate, 'icons', 'icon.png'), path.join(stage, 'abito-island.png'));
fs.chmodSync(path.join(stage, 'abito-island.png'), 0o644);
fs.writeFileSync(path.join(stage, 'abito-island-launcher'), L.launcherText(), { mode: 0o755 });
fs.writeFileSync(path.join(stage, `${L.IDENTIFIER}.desktop`), L.desktopText(), { mode: 0o644 });

for (const name of L.DAEMON_FILES) {
  const dest = path.join(stage, 'desktop-daemon', name);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
  fs.copyFileSync(path.join(crate, '..', 'desktop-daemon', name), dest);
  fs.chmodSync(dest, 0o644);
}

for (const name of L.HARNESS_FILES) {
  const dest = path.join(stage, 'desktop-harness', name);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
  fs.copyFileSync(path.join(crate, '..', 'desktop-harness', name), dest);
  fs.chmodSync(dest, 0o644);
}

for (const name of L.PI_FILES) {
  const dest = path.join(stage, 'desktop-pi', name);
  fs.mkdirSync(path.dirname(dest), { recursive:true, mode:0o755 });
  fs.copyFileSync(path.join(crate, '..', 'desktop-pi', name), dest); fs.chmodSync(dest, 0o644);
}

const rustc = cp.spawnSync('rustc', ['--version'], { encoding: 'utf8' }).stdout.trim();
const files = {};
for (const name of L.STAGED) files[name] = L.sha256File(path.join(stage, name));
const receipt = {
  identifier: L.IDENTIFIER, version: cfg.version, format: 'A user-local', rustc,
  r6_sha256: r6, provenance: { head: prov.head, clean: prov.clean, dirty_entries: 0 }, files,
  inputs: {
    'Cargo.lock': L.sha256File(path.join(crate, 'Cargo.lock')),
    'tauri.conf.json': L.sha256File(path.join(crate, 'tauri.conf.json')),
    'capabilities/main.json': L.sha256File(path.join(crate, 'capabilities', 'main.json')),
    frontend: Object.fromEntries(L.FRONTEND_FILES.map(f => [f, L.sha256File(path.join(crate, 'frontend', f))])),
  },
  csp: cfg.csp,
  build: { rustflags: remap, features: 'tauri/custom-protocol (no probe)' },
  note: 'Staged only. Nothing installed, no installed app touched, never launched by the build.',
};
fs.writeFileSync(path.join(stage, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o644 });
if (args.includes('--smoke-variant')) {
  // NOT shipped, NOT installed: same commit with the probe feature, for the smoke run only.
  cargoBuild(['--features', 'tauri/custom-protocol,probe'], path.join(crate, 'target-smoke'));
  const smoke = path.join(outRoot, 'smoke-variant');
  fs.mkdirSync(smoke, { recursive: true });
  fs.copyFileSync(path.join(crate, 'target-smoke', 'release', 'abito-island'), path.join(smoke, 'abito-island'));
  console.log(`smoke variant (probe feature, NOT for install): ${smoke}/abito-island`);
}
const problems = L.verifyStage(stage, { sourceCrate: crate });
if (problems.length) { console.error('verify failed:\n - ' + problems.join('\n - ')); process.exit(1); }
console.log(`staged ${stage}\nbinary sha256 ${files['abito-island']}`);

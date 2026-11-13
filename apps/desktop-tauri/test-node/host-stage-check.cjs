'use strict';
// Structural pre-commit evidence only. Toy executable; never an official build.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const L = require('../packaging/lib.cjs');
const crate = path.resolve(__dirname, '..');
// Every ./module the daemon requires, transitively from cli.cjs/daemon.cjs, must ship in DAEMON_FILES.
{
  const src = path.join(crate, '../desktop-daemon/src');
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const text = fs.readFileSync(path.join(src, name), 'utf8');
    for (const m of text.matchAll(/require\(\s*["']\.\/([\w.-]+\.(?:cjs|mjs|js))["']\s*\)/g)) walk(m[1]);
  };
  walk('cli.cjs'); walk('daemon.cjs');
  const missing = [...seen].filter((n) => !L.DAEMON_FILES.includes(`src/${n}`));
  assert.deepEqual(missing, [], 'daemon modules required but not shipped: ' + missing.join(', '));
}
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-host-stage-fixture-'));
let localDir = null; // Windows only: the private LOCALAPPDATA of the CLI probe below
try {
  fs.writeFileSync(path.join(stage, 'abito-island'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stage, 'abito-island-launcher'), L.launcherText(), { mode: 0o755 });
  fs.writeFileSync(path.join(stage, 'abito-island.png'), fs.readFileSync(path.join(crate, 'icons/icon.png')), { mode: 0o644 });
  fs.writeFileSync(path.join(stage, `${L.IDENTIFIER}.desktop`), L.desktopText(), { mode: 0o644 });
  for (const file of L.DAEMON_FILES) {
    const target = path.join(stage, 'desktop-daemon', file);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(crate, '../desktop-daemon', file), target);
    fs.chmodSync(target, 0o644);
  }
  for (const file of L.HARNESS_FILES) {
    const target = path.join(stage, 'desktop-harness', file);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(crate, '../desktop-harness', file), target);
    fs.chmodSync(target, 0o644);
  }
  for (const name of L.PI_FILES) {
    const file = path.join(stage, 'desktop-pi', name); fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o755});
    fs.copyFileSync(path.join(crate, '..', 'desktop-pi', name), file); fs.chmodSync(file, 0o644);
  }
  // K2-02 T2 (parent-approved minimal addition): the runtime archive is part of the closed staged set;
  // this structural fixture only needs its bytes present for the receipt/verifyStage hashing.
  fs.writeFileSync(path.join(stage, 'koda-runtime-linux-x64.tar.gz'), 'runtime archive fixture (structural test only; install.sh parses the real archive)\n', { mode: 0o644 });
  const receipt = {
    fixture: 'PRE-COMMIT STRUCTURAL TEST ONLY; toy executable, synthetic provenance, NOT RELEASE EVIDENCE',
    identifier: L.IDENTIFIER, version: L.checkConfig(crate).version,
    format: 'A user-local', r6_sha256: L.checkR6(crate),
    provenance: { head: 'a'.repeat(40), clean: true, dirty_entries: 0 },
    files: Object.fromEntries(L.STAGED.map(f => [f, L.sha256File(path.join(stage, f))])),
  };
  fs.writeFileSync(path.join(stage, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o644 });
  assert.deepEqual(L.verifyStage(stage), []);
  console.log(receipt.fixture);
  console.log('STAGED=' + JSON.stringify(L.STAGED));
  for (const file of [...L.STAGED, 'receipt.json']) console.log(`${(fs.lstatSync(path.join(stage, file)).mode & 0o777).toString(8)} ${file}`);
  console.log('RECEIPT=' + JSON.stringify(receipt, null, 2));
  const result = cp.spawnSync(process.execPath, [path.join(crate, 'packaging/verify.cjs'), stage], { encoding: 'utf8' });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.equal(result.status, 0);
  console.log('verify_exit=' + result.status);

  // Exercise the public CLI from the shipped tree, not the source checkout. A valid
  // receipt alone cannot prove that every transitively required module was shipped.
  // Windows (K2-01b, as in desktop-daemon/test/cli.test.cjs): the daemon refuses any island root outside the canonical
  // %LOCALAPPDATA%\Abito, so the missing island sits under a private LOCALAPPDATA (a sibling temp dir: the stage is
  // listed exactly below), and a child node needs the Windows system variables to bootstrap. Nothing
  // user-identifying leaves the temp dirs.
  const win = process.platform === 'win32';
  const local = win ? fs.mkdtempSync(path.join(os.tmpdir(), 'abito-host-stage-local-')) : null;
  localDir = local;
  const island = win ? path.join(local, 'Abito', 'missing-island') : path.join(stage, 'missing-island');
  const env = { PATH: win ? process.env.PATH : '/usr/bin:/bin', HOME: stage, ABITO_ISLAND_DIR: island };
  if (win) {
    fs.mkdirSync(path.join(local, 'Abito'));
    env.LOCALAPPDATA = local;
    for (const key of ['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
  }
  const status = () => cp.spawnSync(process.execPath, [path.join(stage, 'desktop-daemon/src/cli.cjs'), 'status'], {
    cwd: stage, encoding: 'utf8', timeout: 10000, env,
  });
  const baseline = status();
  assert.equal(baseline.error, undefined);
  assert.equal(baseline.signal, null);
  assert.equal(baseline.status, 3, baseline.stderr);
  assert.equal(baseline.stdout, '');
  assert.equal(baseline.stderr, 'abito-island-daemon: not running (stale: no_session)\n');
  assert.equal(fs.existsSync(island), false, 'status must not create or start an island');
  assert.deepEqual(L.verifyStage(stage), [], 'status must leave every shipped byte unchanged');

  // Each connector-host module is required even when no host binary is configured.
  // Removing either file from this disposable stage must fail, never use a checkout
  // fallback or quietly change the CLI's not-running baseline.
  // K2-05 attachments (R1 lesson): the upload store is required by server.cjs; a stage without it must fail too.
  for (const name of ['connector-host.cjs', 'connector-host-client.cjs', 'uploads.cjs']) {
    const file = path.join(stage, 'desktop-daemon/src', name);
    const contents = fs.readFileSync(file);
    try {
      fs.unlinkSync(file);
      const missing = status();
      assert.equal(missing.error, undefined);
      assert.equal(missing.signal, null);
      assert.equal(missing.status, 1);
      assert.equal(missing.stdout, '');
      assert.ok(missing.stderr.includes(`Error: Cannot find module './${name}'`), missing.stderr);
      assert.equal(fs.existsSync(island), false, 'missing module must not create an island');
    } finally { fs.writeFileSync(file, contents, { mode: 0o644 }); }
    assert.deepEqual(L.verifyStage(stage), [], 'omission probe must restore the exact staged files');
  }
  console.log('staged-cli: status baseline + 3 module-omission regressions passed');
} finally { fs.rmSync(stage, { recursive: true, force: true }); if (localDir) fs.rmSync(localDir, { recursive: true, force: true }); }

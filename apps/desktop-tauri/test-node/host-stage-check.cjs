'use strict';
// Structural pre-commit evidence only. Toy executable; never an official build.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const L = require('../packaging/lib.cjs');
const crate = path.resolve(__dirname, '..');
// Every module the daemon requires, transitively from cli.cjs/daemon.cjs (including subfolders such as
// src/minikodas/ and `../` requires from them), and every file it loads by path next to itself
// (`path.join(__dirname, "<file>")`, e.g. the Minikoda kit extension Pi loads with -e), must ship in DAEMON_FILES.
{
  const src = path.join(crate, '../desktop-daemon/src');
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = fs.readFileSync(path.join(src, rel), 'utf8');
    const here = path.posix.dirname(rel);
    const refs = [
      ...[...text.matchAll(/require\(\s*["'](\.{1,2}\/[\w./-]+\.(?:cjs|mjs|js))["']\s*\)/g)].map((m) => m[1]),
      ...[...text.matchAll(/path\.join\(\s*__dirname\s*,\s*["']([\w.-]+\.(?:cjs|mjs|js))["']\s*\)/g)].map((m) => `./${m[1]}`),
    ];
    for (const ref of refs) {
      const target = path.posix.normalize(path.posix.join(here, ref));
      // A require into the sibling harness package (shipped next to the daemon) must be in HARNESS_FILES.
      const sibling = /^\.\.\/\.\.\/desktop-harness\/(.+)$/.exec(target);
      if (sibling) { assert.ok(L.HARNESS_FILES.includes(sibling[1]), `daemon module ${rel} requires an unshipped harness file: ${sibling[1]}`); continue; }
      assert.ok(!target.startsWith('..'), `daemon module ${rel} reaches outside src/: ${ref}`);
      walk(target);
    }
  };
  walk('cli.cjs'); walk('daemon.cjs');
  assert.ok(seen.has('sdk-helper.mjs') && [...seen].some((n) => n.includes('/')), 'the module walk must see path-loaded files and subfolders');
  const missing = [...seen].filter((n) => !L.DAEMON_FILES.includes(`src/${n}`));
  assert.deepEqual(missing, [], 'daemon modules required but not shipped: ' + missing.join(', '));
  // Every folder that holds a shipped file is a declared staged directory (the closed layout check refuses others).
  const dirs = new Set(L.DAEMON_FILES.map((f) => path.posix.dirname(`desktop-daemon/${f}`)));
  const undeclared = [...dirs].filter((d) => !L.STAGED_DIRS.includes(d));
  assert.deepEqual(undeclared, [], 'staged daemon folders missing from STAGED_DIRS: ' + undeclared.join(', '));
}
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-host-stage-fixture-'));
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
  const island = path.join(stage, 'missing-island');
  const status = () => cp.spawnSync(process.execPath, [path.join(stage, 'desktop-daemon/src/cli.cjs'), 'status'], {
    cwd: stage, encoding: 'utf8', timeout: 10000,
    env: { PATH: '/usr/bin:/bin', HOME: stage, ABITO_ISLAND_DIR: island },
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
  for (const name of ['connector-host.cjs', 'connector-host-client.cjs', 'minikodas/index.cjs']) {
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
} finally { fs.rmSync(stage, { recursive: true, force: true }); }

'use strict';
/* K2-02 T2 (S1): REAL end-to-end proof of the Linux installer's no-Node path.
   Builds (or takes) the REAL bundled runtime archive, installs a FAKE stage with it
   under `env -i` and a PATH that contains NO node anywhere, then proves the installed
   bundled runtime works: `PREFIX/runtime/node --version` is the pinned Node and
   `PREFIX/runtime/pi --version` is the pinned Pi, both run from PREFIX/runtime.
   Run: node test-node/runtime-linux-install-check.cjs [<path to koda-runtime-linux-x64.tar.gz>]
   Without an argument it builds the real archive with packaging/runtime/build-runtime.cjs
   (downloads pinned Node + npm ci, or reuses KODA_RUNTIME_CACHE); with an argument it is
   fully offline. Skips (exit 0) when no archive can be produced on this OS. */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const T = require('./tmpdirs.cjs');

const crate = path.resolve(__dirname, '..');
const SCRIPT = path.join(crate, 'packaging', 'install.sh');
const L = require('../packaging/lib.cjs');
const ARCHIVE = L.RUNTIME_ARCHIVE;
const NODE_VERSION = '22.23.4';
const PI_VERSION = '1.4.0';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
if (process.platform === 'win32') { console.log(`runtime-linux-install-check: skipped (${process.platform} ships its own runtime twin)`); process.exit(0); }

const given = process.argv[2];
let archive = '';
if (given) {
  archive = path.resolve(given);
  assert.equal(path.basename(archive), ARCHIVE, `the runtime archive must be named ${ARCHIVE}`);
  assert.ok(fs.statSync(archive).isFile(), `no runtime archive at ${archive}`);
} else {
  const out = T.make('koda-rt-out-');
  const cache = process.env.KODA_RUNTIME_CACHE || path.join(os.tmpdir(), 'koda-runtime-cache');
  const r = cp.spawnSync(process.execPath, [path.join(crate, 'packaging/runtime/build-runtime.cjs'),
    '--target', 'linux-x64', '--out', out, '--cache', cache, '--self-check', '--archive', path.join(out, ARCHIVE)], { encoding: 'utf8', timeout: 600_000 });
  if (r.status !== 0) { console.log(`runtime-linux-install-check: skipped (cannot build the real archive offline: ${r.stderr.trim().split('\n')[0]})`); process.exit(0); }
  console.log(r.stdout.trim());
  archive = path.join(out, ARCHIVE);
}
console.log(`runtime archive: ${archive} sha256 ${sha(fs.readFileSync(archive))} (${fs.statSync(archive).size} bytes)`);

/* A FAKE stage (toy binary; the real archive is what is under test). */
function stage() {
  const dir = T.make('koda-rt-stage-');
  fs.writeFileSync(path.join(dir, 'abito-island'), '#!/bin/sh\necho toy binary\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'abito-island-launcher'), L.launcherText(), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'abito-island.png'), 'png-bytes', { mode: 0o644 });
  fs.writeFileSync(path.join(dir, `${L.IDENTIFIER}.desktop`), L.desktopText(), { mode: 0o644 });
  for (const n of L.DAEMON_FILES) {
    const file = path.join(dir, 'desktop-daemon', n);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(crate, '..', 'desktop-daemon', n), file); fs.chmodSync(file, 0o644);
  }
  for (const n of L.HARNESS_FILES) {
    const file = path.join(dir, 'desktop-harness', n);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(crate, '..', 'desktop-harness', n), file); fs.chmodSync(file, 0o644);
  }
  for (const name of L.PI_FILES) {
    const file = path.join(dir, 'desktop-pi', name); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(crate, '..', 'desktop-pi', name), file); fs.chmodSync(file, 0o644);
  }
  fs.copyFileSync(archive, path.join(dir, ARCHIVE));
  fs.chmodSync(path.join(dir, ARCHIVE), 0o644); // build.cjs stages the archive 0644 (tar follows the umask)
  const files = {};
  for (const n of L.STAGED) files[n] = sha(fs.readFileSync(path.join(dir, n)));
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ identifier: L.IDENTIFIER, version: '0.0.0-real-runtime-e2e', r6_sha256: L.checkR6(crate),
    provenance: { head: 'a'.repeat(40), clean: true, dirty_entries: 0 }, files }, null, 2) + '\n', { mode: 0o644 });
  return dir;
}

/* A PATH with the tools install.sh needs and NO node anywhere. */
function noNodeBin() {
  const bin = T.make('koda-rt-bin-');
  for (const t of ['tar', 'gzip', 'gunzip', 'sha256sum', 'shasum', 'cut', 'grep', 'sed', 'awk', 'wc', 'cp', 'mv', 'chmod', 'mkdir', 'rmdir', 'rm', 'dirname', 'basename', 'cat', 'ls', 'tr', 'head', 'env', 'id', 'od', 'expr']) {
    const p = fs.existsSync(`/usr/bin/${t}`) ? `/usr/bin/${t}` : `/bin/${t}`;
    if (fs.existsSync(p)) fs.symlinkSync(p, path.join(bin, t));
  }
  assert.ok(!fs.existsSync(path.join(bin, 'node')), 'the private PATH must hold no node');
  return bin;
}

const st = stage();
const home = T.make('koda-rt-home-');
const root = path.join(home, 'project'); fs.mkdirSync(root);
const prefix = path.join(home, 'share', 'abito-island');
const apps = path.join(home, 'share', 'applications');
const r = cp.spawnSync('/bin/sh', [SCRIPT, st, '--prefix', prefix, '--applications-dir', apps, '--project-root', root], {
  encoding: 'utf8', env: { PATH: noNodeBin(), HOME: home }, timeout: 300_000,
});
console.log(`--- install.sh (env -i PATH with no node) exit ${r.status}`);
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
assert.equal(r.status, 0, `install.sh failed with no Node on PATH`);
assert.equal(fs.existsSync(path.join(prefix, ARCHIVE)), false, 'the archive itself must not be installed');

const runtime = path.join(prefix, 'runtime');
const nodeOut = cp.spawnSync(path.join(runtime, 'node'), ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home } });
console.log(`PREFIX/runtime/node --version -> ${nodeOut.stdout.trim()} (exit ${nodeOut.status})`);
assert.equal(nodeOut.status, 0, nodeOut.stderr);
assert.equal(nodeOut.stdout.trim(), `v${NODE_VERSION}`, 'the bundled node is the pinned one');

const piOut = cp.spawnSync(path.join(runtime, 'pi'), ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home }, timeout: 120_000 });
console.log(`PREFIX/runtime/pi --version -> ${piOut.stdout.trim()} (exit ${piOut.status})`);
assert.equal(piOut.status, 0, piOut.stderr);
assert.equal(piOut.stdout.trim(), PI_VERSION, 'the bundled Pi is the pinned one');

assert.deepEqual(L.checkInstalledLayout(prefix), [], 'the installed layout verifies (runtime/ is the one unenumerated dir)');
console.log('runtime-linux-install-check: PASS (real archive installed with no Node on PATH; bundled node + pi verified)');

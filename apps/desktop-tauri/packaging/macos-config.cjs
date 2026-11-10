'use strict';
// JSON passed to tauri build --config. Paths are relative to the Tauri crate,
// not this script's cwd. Reuse the Linux packager's closed, tested source lists.
// K2-02 (S1, S2): `--runtime <dir>` is REQUIRED: the darwin-arm64 folder built by
// packaging/runtime/build-runtime.cjs (Koda's own pinned Node + Pi). It ships expanded as
// Contents/Resources/runtime/, so the bundle's code seal hashes every one of its files
// (macOS is the one OS that ships the folder, not one archive: decided by the parent, K2-02 T2).
const fs = require('node:fs');
const path = require('node:path');
const { DAEMON_FILES, HARNESS_FILES, PI_FILES } = require('./lib.cjs');

const TARGET = 'darwin-arm64';
function fail(message, code = 1) {
  process.stderr.write(`macos-config: ${message}\n`);
  process.exit(code);
}
function runtimeDir(argv) {
  if (argv.length !== 2 || argv[0] !== '--runtime' || !argv[1]) {
    fail(`usage: macos-config.cjs --runtime <dir> (the ${TARGET} folder from packaging/runtime/build-runtime.cjs)`, 2);
  }
  const manifestPath = path.join(path.resolve(argv[1]), 'koda-runtime.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { fail(`cannot read the runtime manifest ${manifestPath}: ${e.message}`); }
  const dir = fs.realpathSync(path.resolve(argv[1]));
  if (!manifest || manifest.target !== TARGET) fail(`${dir} is a ${manifest && manifest.target} runtime, expected ${TARGET}`);
  for (const name of ['node', 'pi', 'gentle-shell']) {
    const st = fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false });
    // Windows reports no execute bits at all (libuv); the bundle is only ever built on macOS, where the bit is checked.
    if (!st || !st.isFile() || (process.platform !== 'win32' && !(st.mode & 0o111))) fail(`${dir} lacks the executable file ${name}`);
  }
  // K2-05 T2 (T4/T6 follow-up): the daemon's engine is the bundled Gentle Shell, and the memory
  // companion is the pinned Engram binary (T1/T1b) at bin/engram — a runtime without them is not
  // what Koda ships. Fail closed like the launcher checks above; every path segment must be real.
  const binSt = fs.lstatSync(path.join(dir, 'bin'), { throwIfNoEntry: false });
  if (!binSt || !binSt.isDirectory() || binSt.isSymbolicLink()) fail(`${dir} lacks the real directory bin`);
  const engramSt = fs.lstatSync(path.join(dir, 'bin', 'engram'), { throwIfNoEntry: false });
  if (!engramSt || !engramSt.isFile() || engramSt.isSymbolicLink() || (process.platform !== 'win32' && !(engramSt.mode & 0o111))) fail(`${dir} lacks the executable file bin/engram`);
  return dir;
}

const runtime = runtimeDir(process.argv.slice(2));
process.stdout.write(JSON.stringify({
  bundle: {
    active: true,
    icon: ['icons/icon.icns'],
    category: 'Productivity',
    // signingIdentity '-' = ad-hoc seal of the whole .app (free, no Apple account): Gatekeeper then shows
    // «unidentified developer» instead of «damaged». Hardened runtime adds nothing without a team identity.
    macOS: { minimumSystemVersion: '12.0', signingIdentity: '-', hardenedRuntime: false },
    resources: Object.fromEntries([
      ...DAEMON_FILES.map(file => [`../desktop-daemon/${file}`, `desktop-daemon/${file}`]),
      ...HARNESS_FILES.map(file => [`../desktop-harness/${file}`, `desktop-harness/${file}`]),
      ...PI_FILES.map(file => [`../desktop-pi/${file}`, `desktop-pi/${file}`]),
      // Tauri map notation: a source ending in a separator copies the whole folder recursively.
      [`${runtime}${path.sep}`, 'runtime/'],
    ]),
  },
}) + '\n');

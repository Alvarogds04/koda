#!/usr/bin/env node
'use strict';
/* U4 receipt, windows flavor (format-A spirit, decision B: NSIS-direct).
   Pins the hashes + provenance of what `xbuild.sh package` produced in the
   gitignored dist/. `--check` re-hashes against the stored receipt.
   Nothing here installs anything or launches the binary. */
const fs = require('node:fs');
const path = require('node:path');
const L = require('../lib.cjs');
const { BINARY_FILES, RUNTIME_FILES, validateStage, nsisInclude } = require('./stage-runtime.cjs');

const crate = path.resolve(__dirname, '../..');
const dist = path.join(crate, 'dist');
const args = process.argv.slice(2);

const cfg = L.checkConfig(crate); // identifier/version/csp gate shared with linux
const r6 = L.checkR6(crate);
L.checkFrontend(crate);

const runtime = path.join(dist, 'windows-runtime');
validateStage(runtime, true);
if (fs.readFileSync(path.join(runtime, 'runtime.nsh'), 'utf8') !== nsisInclude()) throw new Error('runtime.nsh differs from the closed template');
for (const f of RUNTIME_FILES) {
  if (L.sha256File(path.join(runtime, f)) !== L.sha256File(path.join(crate, '..', f))) throw new Error(`stale runtime payload: ${f}`);
}
const artifactNames = [...BINARY_FILES, `koda-${cfg.version}-win-x64-setup.exe`,
  ...RUNTIME_FILES.map(f => `windows-runtime/${f}`), 'windows-runtime/runtime.nsh'];
const receiptPath = path.join(dist, 'receipt-windows.json');
for (const name of artifactNames) {
  const f = path.join(dist, name);
  if (!fs.existsSync(f) || !fs.lstatSync(f).isFile()) { console.error(`missing or non-regular artifact: ${f} (run: sh packaging/windows/xbuild.sh package)`); process.exit(1); }
}
const files = Object.fromEntries(artifactNames.map(f => [f, L.sha256File(path.join(dist, f))]));
const inputs = Object.fromEntries(['Cargo.lock', 'tauri.conf.json', 'capabilities/main.json',
  'packaging/lib.cjs', 'packaging/windows/Dockerfile', 'packaging/windows/abito.nsi',
  'packaging/windows/xbuild.sh', 'packaging/windows/stage-runtime.cjs', 'packaging/windows/stage-win.cjs',
  ...L.FRONTEND_FILES.map(f => `frontend/${f}`),
  ...RUNTIME_FILES.map(f => `../${f}`)].map(f => [f, L.sha256File(path.join(crate, f))]));

if (args.includes('--check')) {
  const rec = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const problems = [];
  for (const [kind, current] of Object.entries({ files, inputs })) {
    if (JSON.stringify(Object.keys(rec[kind] || {}).sort()) !== JSON.stringify(Object.keys(current).sort())) problems.push(`${kind}: different closed file set`);
    for (const [name, hash] of Object.entries(current)) {
      if (rec[kind]?.[name] !== hash) problems.push(`${kind} hash mismatch: ${name}`);
    }
  }
  if (rec.identifier !== L.IDENTIFIER || rec.version !== cfg.version || rec.r6_sha256 !== r6 || rec.csp !== cfg.csp) problems.push('receipt configuration mismatch');
  if (problems.length) { console.error('FAIL:\n - ' + problems.join('\n - ')); process.exit(1); }
  console.log('OK: windows artifacts match the receipt');
  process.exit(0);
}

const prov = L.provenance(crate);
const receipt = {
  identifier: L.IDENTIFIER,
  version: cfg.version,
  format: 'A user-local (windows, cross container)',
  toolchain: { image: 'abito-xwin-build:latest (rust 1.98 + cargo-xwin + system NSIS)', target: 'x86_64-pc-windows-msvc' },
  r6_sha256: r6,
  provenance: { head: prov.head, clean: prov.clean, dirty_entries: prov.dirty.length, ...(prov.clean ? {} : { dirty: prov.dirty }) },
  files,
  inputs,
  csp: cfg.csp,
  build: {
    profile: 'release', features: 'tauri/custom-protocol (no probe)',
    paths: 'stable by construction: the container pins the crate to /abito/src, the registry to /usr/local/cargo and one image toolchain — no remap flags needed, but the checkout path is therefore NOT part of the hash (unlike the linux build.cjs which remaps to the same /abito/src)',
    subsystem: 'windows_subsystem=windows in release (no console); debug keeps the console for U2 VM logs',
    signing: 'NONE - unsigned; the VM checklist validates the SmartScreen path explicitly',
  },
  note: 'Staged only (dist/, gitignored). Nothing installed, nothing launched. dirty_entries is the honest count at build time; a final receipt from a clean checkout must show clean:true. Measured: the cargo exe is byte-identical across rebuilds of one commit (6c2e44b9 on two runs), but makensis embeds a build timestamp in the installer PE header, so the SETUP hash is per packaging run — the receipt and its dist/ files are a matched pair; regenerating the installer invalidates --check by design.',
};
fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(`receipt: ${receiptPath}`);
for (const [name, hash] of Object.entries(files)) console.log(`${name} sha256 ${hash}`);

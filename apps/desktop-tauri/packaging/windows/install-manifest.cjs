#!/usr/bin/env node
'use strict';
// HU-047: install manifest consumed by the Windows hook/Pi installers (apps/desktop-harness/src/win-fs.cjs).
// It lists the sha256 of the native ACL helper and of every closed runtime file, so the installer only executes
// the helper and only registers scripts that are byte-identical to what this build shipped. Run after the native
// binaries are copied into dist/ and before makensis; NSIS installs it next to the binaries.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const crate = path.resolve(__dirname, '../..');
const { RUNTIME_FILES } = require('./stage-runtime.cjs');
const SCHEMA = 'abito-install/1';
const HELPER = 'abito-private-session.exe';
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function build(dist) {
  const helper = path.join(dist, HELPER);
  if (!fs.lstatSync(helper).isFile()) throw new Error(`not a regular file: ${HELPER}`);
  const files = { [HELPER]: sha(helper) };
  for (const f of RUNTIME_FILES) {
    const src = path.join(crate, '..', f);
    if (!fs.lstatSync(src).isFile()) throw new Error(`not a regular file: ${f}`);
    files[f] = sha(src);
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({ schema: SCHEMA, files: sorted }) + '\n';
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--dist' && args[1])) { console.error('Usage: install-manifest.cjs [--dist DIRECTORY]'); process.exitCode = 2; }
  else {
    try {
      const dist = path.resolve(args[1] || path.join(crate, 'dist'));
      fs.writeFileSync(path.join(dist, 'abito-install.json'), build(dist));
      console.log(`manifest: ${RUNTIME_FILES.length + 1} files`);
    } catch (e) { console.error(e.message); process.exitCode = 1; }
  }
}
module.exports = { build, SCHEMA, HELPER };

#!/usr/bin/env node
'use strict';
// HU-047: install manifest consumed by the Windows hook/Pi installers (apps/desktop-harness/src/win-fs.cjs).
// It lists the sha256 of the native ACL helper and of every closed runtime file, so the installer only executes
// the helper and only registers scripts that are byte-identical to what this build shipped. Run after the native
// binaries are copied into dist/ and before makensis; NSIS installs it next to the binaries.
// K2-02 T2: with --runtime <dir> (the build-runtime --out folder) it also pins the bundled
// runtime's node.exe as runtime/node.exe and (K2-13) its ffmpeg.exe as runtime/ffmpeg.exe (win-fs.cjs only requires hex
// sha256 values, so the extra entries need no parser change).
// K2-13 T2c-8 (S19): with --runtime it also pins the bundled runtime's yt-dlp.exe as runtime/yt-dlp.exe, like node.exe and
// ffmpeg.exe. K2-13 T2c-2 (S8): without --dist this runs on this build's own dist/, so the closed binary set is completed there from
// target/release first (completeBinaries: only what the caller did not copy, e.g. abito-transcribe.exe). A --dist
// directory is somebody else's fixture: it is hashed exactly as it is, never written to beyond the manifest.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const crate = path.resolve(__dirname, '../..');
const { RUNTIME_FILES, completeBinaries } = require('./stage-runtime.cjs');
const SCHEMA = 'abito-install/1';
const HELPER = 'abito-private-session.exe';
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function build(dist, runtime) {
  const helper = path.join(dist, HELPER);
  if (!fs.lstatSync(helper).isFile()) throw new Error(`not a regular file: ${HELPER}`);
  const files = { [HELPER]: sha(helper) };
  for (const f of RUNTIME_FILES) {
    const src = path.join(crate, '..', f);
    if (!fs.lstatSync(src).isFile()) throw new Error(`not a regular file: ${f}`);
    files[f] = sha(src);
  }
  if (runtime) {
    // K2-13 (S9): the bundled ffmpeg.exe the daemon spawns is pinned like node.exe, and so is (S19) the yt-dlp.exe it
    // spawns to read YouTube links.
    for (const exe of ['node.exe', 'ffmpeg.exe', 'yt-dlp.exe']) {
      const src = path.join(runtime, exe);
      if (!fs.lstatSync(src, { throwIfNoEntry: false })?.isFile()) throw new Error(`not a regular file: ${src}`);
      files[`runtime/${exe}`] = sha(src);
    }
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({ schema: SCHEMA, files: sorted }) + '\n';
}
if (require.main === module) {
  const args = process.argv.slice(2);
  let dist, runtime;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dist' && args[i + 1]) [dist] = [args[(i += 1)]];
    else if (args[i] === '--runtime' && args[i + 1]) [runtime] = [args[(i += 1)]];
    else { console.error('Usage: install-manifest.cjs [--dist DIRECTORY] [--runtime DIRECTORY]'); process.exitCode = 2; break; }
  }
  if (process.exitCode !== 2) {
    try {
      const distDir = path.resolve(dist || path.join(crate, 'dist'));
      if (!dist) {
        const staged = completeBinaries(distDir);
        if (staged.length > 0) console.log(`staged: ${staged.join(', ')}`);
      }
      fs.writeFileSync(path.join(distDir, 'abito-install.json'), build(distDir, runtime ? path.resolve(runtime) : undefined));
      console.log(`manifest: ${runtime ? RUNTIME_FILES.length + 4 : RUNTIME_FILES.length + 1} files`);
    } catch (e) { console.error(e.message); process.exitCode = 1; }
  }
}
module.exports = { build, SCHEMA, HELPER };

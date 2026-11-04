#!/usr/bin/env node
'use strict';
// One closed runtime list drives staging, NSIS installation/removal and receipts.
// K2-02 T2 (decision B): the bundled Node+Pi runtime additionally ships as ONE
// sha256-verified tar.gz (staged from --runtime-archive); the generated include
// hash-checks it with certutil, extracts it with System32 tar.exe and never
// leaves it behind. Everything else (daemon/harness/Pi payload) stays per-file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DAEMON_FILES, HARNESS_FILES, PI_FILES } = require('../lib.cjs');
const crate = path.resolve(__dirname, '../..');
const BINARY_FILES = ['abito-island.exe', 'abito-notice-relay.exe', 'abito-private-session.exe', 'abito-install.json'];
const RUNTIME_FILES = [...DAEMON_FILES.map(f => `desktop-daemon/${f}`), ...HARNESS_FILES.map(f => `desktop-harness/${f}`), ...PI_FILES.map(f => `desktop-pi/${f}`)].sort();
const ARCHIVE_NAME = 'koda-runtime.tar.gz';
const DEFAULT_OUT = path.join(crate, 'dist/windows-runtime');
const RUNTIME_DIRS = [...new Set(RUNTIME_FILES.flatMap(f => {
  const dirs = []; for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) dirs.push(d);
  return dirs;
}))].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
function regular(file) {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`not a regular file: ${file}`);
}
// The directory itself (when it exists) must be a real directory, never a link: it is what we write into or read
// from, and everything inside it is walked with lstat (a link there is an unexpected entry). Its ANCESTORS are system
// layout outside our closed set: they only have to resolve to directories, so a platform link such as macOS
// /var -> /private/var (every macOS temp dir) is followed instead of refused (K2-01b CI, windows-runtime-check on macOS).
function directoryChain(dir) {
  const start = path.resolve(dir);
  const own = fs.lstatSync(start, { throwIfNoEntry: false });
  if (own && !own.isDirectory()) throw new Error(`not a real directory: ${start}`);
  for (let d = path.dirname(start); ; d = path.dirname(d)) {
    const st = fs.statSync(d, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) throw new Error(`not a real directory: ${d}`);
    if (d === path.dirname(d)) break;
  }
}
function validateStage(out, complete = false) {
  directoryChain(out);
  const found = [];
  function walk(dir, prefix = '') {
    for (const n of fs.readdirSync(dir)) {
      const rel = prefix + n, stat = fs.lstatSync(path.join(dir, n));
      if (stat.isDirectory() && RUNTIME_DIRS.includes(rel)) walk(path.join(dir, n), `${rel}/`);
      else if (stat.isFile() && [...RUNTIME_FILES, 'runtime.nsh', ARCHIVE_NAME].includes(rel)) found.push(rel);
      else throw new Error(`unexpected staged entry: ${rel}`);
    }
  }
  if (fs.existsSync(out)) walk(out);
  if (complete) {
    const want = [...RUNTIME_FILES, 'runtime.nsh', ...(found.includes(ARCHIVE_NAME) ? [ARCHIVE_NAME] : [])];
    if (found.length !== want.length) throw new Error('incomplete Windows runtime stage');
  }
}
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
/* Decision B, verbatim: hash embedded at makensis time, certutil -hashfile SHA256 check,
   $SYSDIR\tar.exe extract, abort on mismatch or tar failure, archive deleted after success,
   guarded RMDir /r (never an empty $INSTDIR or a drive root, never a reparse point).
   Requires LogicLib, which abito.nsi provides through MUI2.nsh before including this file. */
function runtimeArchiveMacros(archiveSha) {
  return [
    '; K2-02, decision B: the bundled Node+Pi runtime ships as ONE tar.gz whose sha256 is',
    '; embedded below at makensis time. Install verifies it with certutil, extracts it with',
    '; System32 tar.exe into a fresh directory, swaps it into place and never leaves the',
    '; archive behind. Recursive removal is guarded: never when $INSTDIR is empty or a drive',
    '; root, never when the target is a reparse point or junction.',
    `!define KODA_RUNTIME_SHA256 ${archiveSha}`,
    '!macro AbitoRuntimeGuardedRmDirR _dir',
    '  Push $R0',
    '  Push $R1',
    '  StrLen $R0 "$INSTDIR"',
    '  ${If} $R0 <= 3',
    '    Pop $R1',
    '    Pop $R0',
    '    Abort "Koda: refusing recursive removal, the install directory is empty or a drive root."',
    '  ${EndIf}',
    '  Push "${_dir}"',
    "  System::Call 'kernel32::GetFileAttributesW(ts)i.R1'",
    '  ${If} $R1 != -1',
    '    IntOp $R0 $R1 & 0x400',
    '    ${If} $R0 != 0',
    '      Pop $R1',
    '      Pop $R0',
    '      Abort "Koda: refusing recursive removal, ${_dir} is a reparse point or junction."',
    '    ${EndIf}',
    '  ${EndIf}',
    '  RMDir /r "${_dir}"',
    '  Pop $R1',
    '  Pop $R0',
    '!macroend',
    '!macro AbitoInstallRuntime',
    '  SetOutPath "$INSTDIR"',
    `  File "/ONAME=${ARCHIVE_NAME}" "\${RUNTIMEDIR}\\${ARCHIVE_NAME}"`,
    `  nsExec::ExecToStack 'certutil -hashfile "$INSTDIR\\${ARCHIVE_NAME}" SHA256'`,
    '  Pop $R0',
    '  Pop $R1',
    '  ${If} $R0 == "error"',
    '  ${OrIf} $R0 != 0',
    `    Delete "$INSTDIR\\${ARCHIVE_NAME}"`,
    '    Abort "Koda: could not hash the bundled runtime archive (certutil reported $R0). Nothing was changed."',
    '  ${EndIf}',
    '  ; certutil prints the digest on its own line, spaced or unspaced depending on the Windows',
    '  ; version: keep the second line, drop every space, compare case-insensitively.',
    '  StrCpy $R2 ""',
    '  StrCpy $R3 0',
    '  StrCpy $R5 0',
    'abito_runtime_hash_line:',
    '  StrCpy $R4 "$R1" 1 $R3',
    '  IntOp $R3 $R3 + 1',
    '  ${If} $R4 == ""',
    '    Goto abito_runtime_hash_done',
    '  ${EndIf}',
    '  ${If} $R4 == "$\\r"',
    '  ${OrIf} $R4 == "$\\n"',
    '    ${If} $R4 == "$\\r"',
    '      StrCpy $R6 "$R1" 1 $R3',
    '      ${If} $R6 == "$\\n"',
    '        IntOp $R3 $R3 + 1',
    '      ${EndIf}',
    '    ${EndIf}',
    '    IntOp $R5 $R5 + 1',
    '    ${If} $R5 > 1',
    '      Goto abito_runtime_hash_done',
    '    ${EndIf}',
    '    Goto abito_runtime_hash_line',
    '  ${EndIf}',
    '  ${If} $R5 == 1',
    '  ${AndIf} $R4 != " "',
    '    StrCpy $R2 "$R2$R4"',
    '  ${EndIf}',
    '  Goto abito_runtime_hash_line',
    'abito_runtime_hash_done:',
    '  ${If} $R2 == "${KODA_RUNTIME_SHA256}"',
    '    DetailPrint "Koda runtime archive SHA256 verified."',
    '  ${Else}',
    `    Delete "$INSTDIR\\${ARCHIVE_NAME}"`,
    '    Abort "Koda: the bundled runtime archive failed its SHA256 check (got $R2, wanted ${KODA_RUNTIME_SHA256}). Nothing was changed."',
    '  ${EndIf}',
    '  !insertmacro AbitoRuntimeGuardedRmDirR "$INSTDIR\\runtime.new"',
    '  CreateDirectory "$INSTDIR\\runtime.new"',
    `  nsExec::Exec '"$SYSDIR\\tar.exe" -xzf "$INSTDIR\\${ARCHIVE_NAME}" -C "$INSTDIR\\runtime.new"'`,
    '  Pop $R0',
    '  ${If} $R0 == "error"',
    '  ${OrIf} $R0 != 0',
    `    Delete "$INSTDIR\\${ARCHIVE_NAME}"`,
    '    !insertmacro AbitoRuntimeGuardedRmDirR "$INSTDIR\\runtime.new"',
    '    Abort "Koda: could not extract the bundled runtime (tar reported $R0). Installation stopped."',
    '  ${EndIf}',
    '  !insertmacro AbitoRuntimeGuardedRmDirR "$INSTDIR\\runtime"',
    '  ClearErrors',
    '  Rename "$INSTDIR\\runtime.new" "$INSTDIR\\runtime"',
    '  ${If} ${Errors}',
    '    Abort "Koda: could not activate the extracted runtime directory. Installation stopped."',
    '  ${EndIf}',
    `  Delete "$INSTDIR\\${ARCHIVE_NAME}"`,
    '!macroend',
    '!macro AbitoUninstallRuntime',
    '  !insertmacro AbitoRuntimeGuardedRmDirR "$INSTDIR\\runtime"',
    '!macroend',
  ];
}
function nsisInclude(out = DEFAULT_OUT) {
  const lines = ['; Generated by stage-runtime.cjs. Do not edit.', '!macro AbitoInstallPayload', '  SetOutPath "$INSTDIR"'];
  for (const f of BINARY_FILES) lines.push(`  File "\${BINDIR}\\${f}"`);
  for (const f of RUNTIME_FILES) {
    lines.push(`  SetOutPath "$INSTDIR\\${path.posix.dirname(f).replaceAll('/', '\\')}"`, `  File "\${RUNTIMEDIR}\\${f.replaceAll('/', '\\')}"`);
  }
  lines.push('!macroend', '!macro AbitoUninstallPayload');
  for (const f of [...BINARY_FILES, ...RUNTIME_FILES]) lines.push(`  Delete "$INSTDIR\\${f.replaceAll('/', '\\')}"`);
  for (const d of [...RUNTIME_DIRS].reverse()) lines.push(`  RMDir "$INSTDIR\\${d.replaceAll('/', '\\')}"`);
  lines.push('!macroend');
  // With a staged archive, the runtime-archive macros follow; their sha256 comes from the
  // staged bytes, so nsisInclude(out) always regenerates the staged include byte-for-byte
  // (the stage-win receipt compares exactly that).
  const stagedArchive = path.join(out, ARCHIVE_NAME);
  if (fs.lstatSync(stagedArchive, { throwIfNoEntry: false })?.isFile()) lines.push(...runtimeArchiveMacros(sha256File(stagedArchive)));
  lines.push('');
  return lines.join('\n');
}
function stage(out, runtimeArchive) {
  validateStage(out);
  // Preflight every source and ancestor before changing the output.
  for (const f of RUNTIME_FILES) {
    const src = path.join(crate, '..', f); directoryChain(path.dirname(src)); regular(src);
  }
  let archiveSrc = null;
  if (runtimeArchive) { archiveSrc = path.resolve(runtimeArchive); regular(archiveSrc); }
  fs.mkdirSync(out, { recursive: true });
  for (const d of RUNTIME_DIRS) fs.mkdirSync(path.join(out, d), { recursive: true });
  for (const f of RUNTIME_FILES) fs.copyFileSync(path.join(crate, '..', f), path.join(out, f));
  let archiveSha = null;
  if (archiveSrc) {
    fs.copyFileSync(archiveSrc, path.join(out, ARCHIVE_NAME));
    archiveSha = sha256File(path.join(out, ARCHIVE_NAME)); // stage time, from the staged bytes
  }
  fs.writeFileSync(path.join(out, 'runtime.nsh'), nsisInclude(out));
  return archiveSha;
}
function parseArgs(argv) {
  const opts = {};
  const takes = { '--out': 'out', '--runtime-archive': 'runtimeArchive' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!takes[a] || i + 1 >= argv.length) throw new Error(`usage: stage-runtime.cjs [--out DIRECTORY] [--runtime-archive FILE]`);
    opts[takes[a]] = argv[(i += 1)];
  }
  return opts;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node packaging/windows/stage-runtime.cjs [--out DIRECTORY] [--runtime-archive FILE]\nStage the closed daemon/harness/Pi payload and runtime.nsh (default: dist/windows-runtime); with --runtime-archive, stage the bundled Node+Pi runtime tar.gz as koda-runtime.tar.gz and embed its sha256 in runtime.nsh. Unknown output entries are rejected; no recursive cleanup.');
  } else {
    try {
      const opts = args.length ? parseArgs(args) : {};
      const out = path.resolve(opts.out || DEFAULT_OUT);
      const archiveSha = stage(out, opts.runtimeArchive);
      console.log(`staged: ${RUNTIME_FILES.length} runtime files`);
      if (archiveSha) console.log(`runtime archive: ${ARCHIVE_NAME} sha256 ${archiveSha}`);
    } catch (e) {
      console.error(e.message);
      process.exitCode = /^usage:/.test(e.message) ? 2 : 1;
    }
  }
}
module.exports = { ARCHIVE_NAME, BINARY_FILES, RUNTIME_FILES, validateStage, nsisInclude };

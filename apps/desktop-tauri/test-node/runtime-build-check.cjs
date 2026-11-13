'use strict';
/* K2-02 T1 (S1, S2) + K2-05 T1 (S1): packaging/runtime/build-runtime.cjs, run as a user would run it (a child process),
   fully offline: the script is copied next to fixture pins (a fake Node archive with its sha256, fake Pi and gentle-pi
   tarballs pinned by sha512 in a lockfile), so no network and no real Node/Pi download is involved. The real pins are
   checked by runtime-pins-check.cjs and proven against the real downloads by the installer builds.
   Every target (linux-x64, darwin-arm64, win-x64) is built on every OS; the built Pi is run on the host target.
   Run: node apps/desktop-tauri/test-node/runtime-build-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const T = require('./tmpdirs.cjs');

const crate = path.resolve(__dirname, '..');
const BUILDER = path.join(crate, 'packaging/runtime/build-runtime.cjs');
const NODE_VERSION = '22.23.4';
const isWin = process.platform === 'win32';
const hostTarget = { linux: 'linux-x64', darwin: 'darwin-arm64', win32: 'win-x64' }[process.platform];
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
};

/* ---------- fixtures ---------- */
function tarGz(cwd, out, entries) {
  const tar = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  // macOS bsdtar stores extended attributes (e.g. com.apple.provenance) as AppleDouble `._*` members unless
  // COPYFILE_DISABLE is set; npm would install them as files. GNU tar and Windows tar ignore the variable.
  const r = cp.spawnSync(tar, ['-czf', out, ...entries], { cwd, encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  assert.equal(r.status, 0, `tar failed: ${r.stderr}`);
}
/* A stored (uncompressed) zip: enough for the extractor, and the same bytes on every OS. */
function zipStored(out, files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, data, mode] of files) {
    const n = Buffer.from(name); const crc = zlib.crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(((mode || 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(out, Buffer.concat([...locals, cd, end]));
}
// a malformed manifest must fail the check with the file named, not with a bare SyntaxError
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`cannot read JSON ${file}: ${e.message}`); }
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/* The fake Node: on the host target it really runs JS (a wrapper around this Node on Unix, a copy of this node.exe on
   Windows) and marks itself, so a test can tell it apart from a Node found on PATH. Other targets: inert bytes. */
function fakeNodeBytes(target) {
  if (target !== hostTarget) return Buffer.from(`fake node for ${target}\n`);
  if (isWin) return fs.readFileSync(process.execPath);
  return Buffer.from(`#!/bin/sh\nKODA_NODE=bundled exec ${JSON.stringify(process.execPath)} "$@"\n`);
}
function nodeArchive(dir, target) {
  const base = `node-v${NODE_VERSION}-${target}`;
  if (target === 'win-x64') {
    const file = path.join(dir, `${base}.zip`);
    zipStored(file, [[`${base}/node.exe`, fakeNodeBytes(target), 0o100755], [`${base}/LICENSE`, Buffer.from('Node licence\n')],
      [`${base}/npm.cmd`, Buffer.from('npm shim\n')], [`${base}/node_modules/npm/package.json`, Buffer.from('{}')]]);
    return file;
  }
  const root = path.join(dir, `src-${target}`);
  fs.mkdirSync(path.join(root, base, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, base, 'lib', 'node_modules', 'npm'), { recursive: true });
  fs.writeFileSync(path.join(root, base, 'bin', 'node'), fakeNodeBytes(target), { mode: 0o755 });
  fs.writeFileSync(path.join(root, base, 'bin', 'npm'), 'npm\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, base, 'LICENSE'), 'Node licence\n');
  fs.writeFileSync(path.join(root, base, 'lib', 'node_modules', 'npm', 'package.json'), '{}');
  const file = path.join(dir, `${base}.tar.gz`);
  tarGz(root, file, [base]);
  return file;
}

/* A fake Engram release archive (K2-05 T1b): the binary member (engram / engram.exe) plus the extra members the real
   release carries (tools/cloud-sync-projects.*), which must never ship. On the host target the fake binary really runs
   and prints its version (enough for `engram version`); other targets: inert bytes. opts.engramMode breaks it:
   'no-member' (the archive lacks the binary), 'symlink-member' (the binary is a symlink), 'bad-version' (prints the
   wrong version, so --self-check must fail). */
const ENGRAM_VERSION = '3.4.0';
const ENGRAM_ASSET = { 'linux-x64': 'linux_amd64.tar.gz', 'darwin-arm64': 'darwin_arm64.tar.gz', 'win-x64': 'windows_amd64.zip' };
const engramExeFor = (target) => (target === 'win-x64' ? 'engram.exe' : 'engram');
const winEngramExes = new Map(); // line -> PE bytes (compiled once per message; a .exe cannot be a script)
function compileFakeEngramExe(dir, line) {
  if (winEngramExes.has(line)) return winEngramExes.get(line);
  // Windows needs a runnable PE: compiled with the .NET Framework compiler (csc.exe) that every Windows runner and
  // desktop with .NET ships — there is no script trick for a .exe spawned directly.
  const root = process.env.SystemRoot || 'C:\\Windows';
  const csc = ['Framework64', 'Framework'].map((f) => path.join(root, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find((c) => fs.existsSync(c));
  assert.ok(csc, 'this Windows host has no .NET Framework csc.exe to compile the fake engram.exe with');
  const src = path.join(dir, 'engram-src.cs');
  fs.writeFileSync(src, `class P { static void Main() { System.Console.WriteLine(${JSON.stringify(line)}); } }`);
  const out = path.join(dir, 'engram.exe');
  const r = cp.spawnSync(csc, ['/nologo', `/out:${out}`, src], { encoding: 'utf8' });
  assert.equal(r.status, 0, `csc failed: ${r.stderr}${r.stdout}`);
  const bytes = fs.readFileSync(out);
  winEngramExes.set(line, bytes);
  return bytes;
}
function fakeEngramBytes(target, dir, mode = '') {
  if (target !== hostTarget) return Buffer.from(`fake engram for ${target}\n`);
  const line = mode === 'bad-version' ? 'engram 9.9.9' : `engram ${ENGRAM_VERSION}`;
  return isWin ? compileFakeEngramExe(dir, line) : Buffer.from(`#!/bin/sh\necho ${JSON.stringify(line)}\n`);
}
function engramArchive(dir, target, mode = '') {
  const name = `engram_${ENGRAM_VERSION}_${ENGRAM_ASSET[target]}`;
  const binName = engramExeFor(target);
  const extras = [['tools/cloud-sync-projects.sh', Buffer.from('sync tool\n')], ['tools/cloud-sync-projects.ps1', Buffer.from('sync tool\n')]];
  if (target === 'win-x64') {
    const files = mode === 'no-member' ? extras : [[binName, fakeEngramBytes(target, dir, mode), 0o100755], ...extras];
    const file = path.join(dir, name);
    zipStored(file, files);
    return file;
  }
  const src = path.join(dir, `engram-src-${target}-${mode || 'good'}-${Math.random().toString(36).slice(2)}`);
  // The real release archive has the binary and its extras at the archive ROOT (verified against engram_3.4.0's
  // assets: `engram`, `tools/cloud-sync-projects.*`), no wrapping folder — so the fixture packs the same shape.
  fs.mkdirSync(path.join(src, 'tools'), { recursive: true });
  if (mode === 'symlink-member') fs.symlinkSync('/etc/passwd', path.join(src, binName));
  else if (mode !== 'no-member') fs.writeFileSync(path.join(src, binName), fakeEngramBytes(target, dir, mode), { mode: 0o755 });
  for (const [rel, data] of extras) fs.writeFileSync(path.join(src, rel), data);
  const file = path.join(dir, name);
  const entries = ['tools', 'tools/cloud-sync-projects.sh', 'tools/cloud-sync-projects.ps1'];
  if (mode !== 'no-member') entries.unshift(binName); // 'no-member': the archive must genuinely lack the binary
  tarGz(src, file, entries);
  return file;
}
/* A builder copy next to fixture pins: the script reads its pins from its own directory. */
function fixture(targets = ['linux-x64', 'darwin-arm64', 'win-x64'], opts = {}) {
  const dir = T.make('koda-runtime-build-');
  const pins = path.join(dir, 'pins');
  fs.mkdirSync(pins);
  fs.copyFileSync(BUILDER, path.join(pins, 'build-runtime.cjs'));
  fs.cpSync(path.join(path.dirname(BUILDER), 'licenses'), path.join(pins, 'licenses'), { recursive: true });
  const archives = {};
  for (const t of targets) archives[t] = nodeArchive(dir, t);
  fs.writeFileSync(path.join(pins, 'node.sha256'), targets.map((t) => `${sha256(archives[t])}  ${path.basename(archives[t])}\n`).join(''));
  const engramArchives = {};
  for (const t of targets) engramArchives[t] = engramArchive(dir, t, opts.engramMode);
  let engramLines = targets.map((t) => `${sha256(engramArchives[t])}  ${path.basename(engramArchives[t])}\n`);
  if (opts.engramPin === 'malformed') engramLines = [`${'z'.repeat(64)}  ${path.basename(engramArchives[targets[0]])}\n`];
  if (opts.engramPin === 'duplicate') engramLines = engramLines.concat(engramLines);
  if (opts.engramPin !== 'missing') fs.writeFileSync(path.join(pins, 'engram.sha256'), engramLines.join(''));
  // A fake Pi package: its CLI prints the version, and with KODA_REPORT=1 also which Node runs it.
  const pkgSrc = path.join(dir, 'pi-src', 'package');
  fs.mkdirSync(path.join(pkgSrc, 'dist', 'bundle'), { recursive: true });
  fs.writeFileSync(path.join(pkgSrc, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.4.0', license: opts.piLicense || 'MIT', author: 'Mario Zechner', repository: { url: 'git+https://github.com/earendil-works/pi.git' }, bin: { pi: 'dist/bundle/cli.js' } }));
  fs.writeFileSync(path.join(pkgSrc, 'dist', 'bundle', 'cli.js'),
    "console.log(process.env.KODA_REPORT === '1' ? `1.4.0 node=${process.env.KODA_NODE || 'other'}` : '1.4.0');\n");
  const tgz = path.join(dir, 'pi-1.4.0.tgz');
  tarGz(path.join(dir, 'pi-src'), tgz, ['package']);
  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tgz)).digest('base64')}`;
  const spec = `file:${tgz.split(path.sep).join('/')}`;
  // A fake gentle-pi package (K2-05): its gentle-shell.mjs answers a get_state frame on stdin (RPC), and with
  // KODA_REPORT=1 also which Node runs it. opts.noGentleBin ships the bin entry without the file (fail closed);
  // opts.gentleBin replaces the bin path the package.json and lockfile declare (absolute / escaping, fail closed);
  // opts.gentleEnvAssert makes the fake REFUSE to answer unless every env var the self-check must set is exact,
  // and writes what it saw to koda-env-report.json next to its own package (a file that survives the build);
  // opts.gentleMode forces a regression-shape behavior the self-check must fail closed on:
  //   'answer-then-hang'         answers get_state and then never exits (the unbounded-wait defect)
  //   'hang-with-grandchild'     never answers, spawns a same-process-group grandchild that outlives child.kill()
  //   'exit-before-answer'       exits 3 without ever answering get_state
  //   'answer-then-exit-nonzero' answers get_state and then exits 7 after stdin is closed
  function gentleBinValue(opts = {}) {
    return opts.gentleBin !== undefined ? opts.gentleBin : 'bin/gentle-shell.mjs';
  }
  function gentleShellScript(opts = {}) {
    const head = opts.gentleEnvAssert ? [
      'import { writeFileSync } from \'node:fs\';',
      'import path from \'node:path\';',
      'import { fileURLToPath } from \'node:url\';',
      'const want = { GENTLE_SHELL_NO_AUTO_SETUP: \'1\', GENTLE_PI_SKIP_GENTLE_AI_INSTALL: \'1\', PI_OFFLINE: \'1\', PI_SKIP_VERSION_CHECK: \'1\', PI_TELEMETRY: \'0\' };',
      'const bad = Object.entries(want).filter(([k, v]) => process.env[k] !== v).map(([k]) => `${k}=${JSON.stringify(process.env[k])} (want ${JSON.stringify(v)})`);',
      'if (process.env.PI_CODING_AGENT_DIR !== undefined) bad.push(`PI_CODING_AGENT_DIR=${JSON.stringify(process.env.PI_CODING_AGENT_DIR)} (want unset)`);',
      'try { writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), \'..\', \'koda-env-report.json\'), JSON.stringify({ ok: bad.length === 0, bad, env: { ...want, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR === undefined ? null : process.env.PI_CODING_AGENT_DIR } })); } catch (e) {}',
      'if (bad.length) { process.stderr.write(\'KODA-ENV-BAD: \' + bad.join(\', \') + \'\\n\'); process.exit(0); }',
    ] : [];
    if (opts.gentleMode === 'answer-then-hang') return [...head,
      'let buffered = \'\';',
      'process.stdin.setEncoding(\'utf8\');',
      'process.stdin.on(\'data\', (chunk) => {',
      '  buffered += chunk;',
      '  if (buffered.includes(\'\\n\')) process.stdout.write(\'{"type":"response","command":"get_state","success":true}\\n\');',
      '});',
      'process.stdin.on(\'end\', () => {});',
      'setInterval(() => {}, 1000);', // answers, then never exits
    ];
    if (opts.gentleMode === 'hang-with-grandchild') return [...head,
      'import cp from \'node:child_process\';',
      'import fs from \'node:fs\';',
      'import path from \'node:path\';',
      'import { fileURLToPath } from \'node:url\';',
      // Same process group, never exits; its pid goes next to the FIXTURE (four levels up from bin/), a directory
      // that survives both the success rename and the failure cleanup, so the test can find the pid either way.
      'const grandchild = cp.spawn(process.execPath, [\'-e\', \'setInterval(() => {}, 1000)\'], { stdio: \'ignore\' });',
      'try { fs.writeFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), \'../../../..\', \'koda-grandchild-pid.txt\'), String(grandchild.pid)); } catch (e) {}',
      'setInterval(() => {}, 1000);', // never answers, never exits
    ];
    if (opts.gentleMode === 'exit-before-answer') return [...head,
      'process.stdout.write(\'noise before any answer\\n\');',
      'setTimeout(() => process.exit(3), 50);',
    ];
    if (opts.gentleMode === 'answer-then-exit-nonzero') return [...head,
      'let buffered = \'\';',
      'process.stdin.setEncoding(\'utf8\');',
      'process.stdin.on(\'data\', (chunk) => {',
      '  buffered += chunk;',
      '  if (buffered.includes(\'\\n\')) process.stdout.write(\'{"type":"response","command":"get_state","success":true}\\n\');',
      '});',
      'process.stdin.on(\'end\', () => { setTimeout(() => process.exit(7), 50); });', // exits 7 after the answer
    ];
    return [...head,
      'let buffered = \'\';',
      'process.stdin.setEncoding(\'utf8\');',
      'process.stdin.on(\'data\', (chunk) => {',
      '  buffered += chunk;',
      '  if (buffered.includes(\'\\n\')) {',
      '    if (process.env.KODA_REPORT === \'1\') process.stdout.write(`4.3.0 node=${process.env.KODA_NODE || \'other\'}` + "\\n");',
      '    else process.stdout.write(\'{"type":"response","command":"get_state","success":true}\\n\');',
      '  }',
      '});',
      'process.stdin.on(\'end\', () => {});',
    ];
  }
  const gentleSrc = path.join(dir, 'gentle-src', 'package');
  fs.mkdirSync(path.join(gentleSrc, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(gentleSrc, 'package.json'), JSON.stringify({ name: 'gentle-pi', version: '4.3.0', license: 'MIT', author: 'Gentleman Programming', repository: { url: 'git+https://github.com/Gentleman-Programming/gentle-shell.git' }, bin: { 'gentle-shell': gentleBinValue(opts) }, peerDependencies: { '@earendil-works/pi-coding-agent': '>=1.2.0', '@earendil-works/pi-ai': '*', '@earendil-works/pi-tui': '*', typebox: '*' }, peerDependenciesMeta: { '@earendil-works/pi-coding-agent': { optional: true }, '@earendil-works/pi-ai': { optional: true }, '@earendil-works/pi-tui': { optional: true }, typebox: { optional: true } } }));
  if (!opts.noGentleBin) fs.writeFileSync(path.join(gentleSrc, 'bin', 'gentle-shell.mjs'), gentleShellScript(opts).join('\n'));
  const gentleTgz = path.join(dir, 'gentle-pi-4.3.0.tgz');
  tarGz(path.join(dir, 'gentle-src'), gentleTgz, ['package']);
  const gentleIntegrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(gentleTgz)).digest('base64')}`;
  const gentleSpec = `file:${gentleTgz.split(path.sep).join('/')}`;
  // A fake native optional package (K2-05 T1 finding 3, option C): it declares the BUILD HOST's os/cpu, exactly the
  // shape npm installs for the host alone — so a cross-target build would silently ship the host's native files
  // unless the installed tree is audited against the --target.
  let nativeEntry = null;
  if (opts.native) {
    const hostOs = { linux: 'linux', darwin: 'darwin', win32: 'win32' }[process.platform];
    const hostCpu = { x64: 'x64', arm64: 'arm64' }[process.arch];
    const nativeSrc = path.join(dir, 'native-src', 'package');
    fs.mkdirSync(nativeSrc, { recursive: true });
    fs.writeFileSync(path.join(nativeSrc, 'package.json'), JSON.stringify({ name: 'fake-native', version: '1.0.0', license: 'MIT', os: opts.native.os || [hostOs], cpu: opts.native.cpu || [hostCpu] }));
    const nativeTgz = path.join(dir, 'fake-native-1.0.0.tgz');
    tarGz(path.join(dir, 'native-src'), nativeTgz, ['package']);
    const nativeIntegrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(nativeTgz)).digest('base64')}`;
    nativeEntry = {
      spec: `file:${nativeTgz.split(path.sep).join('/')}`,
      integrity: nativeIntegrity,
      os: opts.native.os || [hostOs],
      cpu: opts.native.cpu || [hostCpu],
    };
  }
  const rootDeps = { '@earendil-works/pi-coding-agent': spec, 'gentle-pi': gentleSpec, ...(nativeEntry ? { 'fake-native': nativeEntry.spec } : {}) };
  fs.writeFileSync(path.join(pins, 'package.json'), JSON.stringify({ name: 'koda-runtime', private: true, dependencies: rootDeps }));
  fs.writeFileSync(path.join(pins, 'package-lock.json'), JSON.stringify({
    name: 'koda-runtime', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'koda-runtime', dependencies: rootDeps },
      'node_modules/@earendil-works/pi-coding-agent': { version: '1.4.0', resolved: spec, integrity, bin: { pi: 'dist/bundle/cli.js' } },
      'node_modules/gentle-pi': { version: '4.3.0', resolved: gentleSpec, integrity: gentleIntegrity, bin: { 'gentle-shell': gentleBinValue(opts) }, peerDependencies: { '@earendil-works/pi-coding-agent': '>=1.2.0', '@earendil-works/pi-ai': '*', '@earendil-works/pi-tui': '*', typebox: '*' }, peerDependenciesMeta: { '@earendil-works/pi-coding-agent': { optional: true }, '@earendil-works/pi-ai': { optional: true }, '@earendil-works/pi-tui': { optional: true }, typebox: { optional: true } } },
      ...(nativeEntry ? { 'node_modules/fake-native': { version: '1.0.0', resolved: nativeEntry.spec, integrity: nativeEntry.integrity } } : {}),
    },
  }));
  return { dir, pins, archives, engramArchives, nativeEntry };
}
function build(fx, args, env = {}, spawnTimeoutMs = 120_000) {
  // Every fixture build takes its OWN fake engram archive (the GitHub download is never exercised here); tests that
  // drive the engram archive itself pass --engram-archive explicitly, which wins.
  const target = args[args.indexOf('--target') + 1];
  const all = args.includes('--engram-archive') ? args : [...args, '--engram-archive', fx.engramArchives[target]];
  return cp.spawnSync(process.execPath, [path.join(fx.pins, 'build-runtime.cjs'), ...all], {
    encoding: 'utf8', env: { ...process.env, npm_config_offline: 'true', ...env }, timeout: spawnTimeoutMs,
  });
}
/* Reads a fake gentle-shell's env report (written next to its own package inside the built runtime folder). */
function envReport(out) {
  return JSON.parse(fs.readFileSync(path.join(out, 'node_modules', 'gentle-pi', 'koda-env-report.json'), 'utf8'));
}
function tree(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix + e.name;
    if (e.isSymbolicLink()) return [`${rel} -> SYMLINK`];
    return e.isDirectory() ? tree(path.join(dir, e.name), `${rel}/`) : [rel];
  }).sort();
}

/* ---------- tests ---------- */
const builder = require(BUILDER); // the retry itself: the check proves it without needing Windows
const fx = fixture();

/* CI 43352802736 (installer smoke, windows): build-runtime: EPERM: operation not permitted, rename
   'D:\a\_temp\koda-runtime.partial-9116' -> 'D:\a\_temp\koda-runtime'. Windows answers a rename of a folder it has
   just written with a transient EPERM/EBUSY/EACCES while Defender or the indexer holds it. Both directions are proven
   here, on every OS: the retry wins the race without losing a guarantee, and a rename that never succeeds still fails
   the build with nothing half-installed. */
test('Windows: a rename refused with a transient EPERM is retried and succeeds, with no partial left behind', () => {
  const dir = T.make('koda-runtime-rename-');
  const partial = path.join(dir, 'koda-runtime.partial-1');
  const out = path.join(dir, 'koda-runtime');
  fs.mkdirSync(partial);
  fs.writeFileSync(path.join(partial, 'koda-runtime.json'), '{}\n');
  let attempts = 0;
  const rename = (from, to) => {
    attempts += 1;
    if (attempts <= 2) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
    return fs.renameSync(from, to);
  };
  builder.renameWithRetry(partial, out, { rename, platform: 'win32' });
  assert.equal(attempts, 3, 'two transient refusals, then the real rename');
  assert.equal(fs.existsSync(partial), false, 'the partial became the output: nothing is left half-written');
  assert.deepEqual(fs.readdirSync(out), ['koda-runtime.json']);
});

test('Windows: a rename that keeps failing surfaces the same error after a bounded number of attempts and moves nothing', () => {
  const dir = T.make('koda-runtime-rename-stuck-');
  const partial = path.join(dir, 'koda-runtime.partial-2');
  const out = path.join(dir, 'koda-runtime');
  fs.mkdirSync(partial);
  fs.writeFileSync(path.join(partial, 'koda-runtime.json'), '{}\n');
  let attempts = 0;
  const rename = () => { attempts += 1; throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); };
  assert.throws(() => builder.renameWithRetry(partial, out, { rename, platform: 'win32' }), /EPERM: operation not permitted/);
  assert.equal(attempts, builder.RENAME_ATTEMPTS, 'bounded: the builder never spins on a stuck folder');
  assert.equal(fs.existsSync(out), false, 'nothing was installed');
  assert.deepEqual(fs.readdirSync(partial), ['koda-runtime.json'], 'the partial is untouched (the caller removes it)');
});

test('every other OS and every other error keep a single attempt and the identical error (Linux behaviour unchanged)', () => {
  const attempts = (code, platform) => {
    let calls = 0;
    assert.throws(() => builder.renameWithRetry('/x/a', '/x/b', {
      platform, rename: () => { calls += 1; throw Object.assign(new Error(`${code}: rename`), { code }); },
    }), { code }); // the very error the rename threw: no wrapper, no new code
    return calls;
  };
  assert.equal(attempts('EPERM', 'linux'), 1, 'a transient code on Linux is not retried: same error, same attempt count');
  assert.equal(attempts('EPERM', 'darwin'), 1);
  assert.equal(attempts('ENOENT', 'win32'), 1, 'Windows retries only the three codes a held handle produces');
  assert.equal(attempts('ENOTEMPTY', 'win32'), 1);
});

test('Windows: the real build wins a commit rename refused twice with EPERM, and one that never succeeds exits 1 with no partial', () => {
  const out = path.join(fx.dir, 'out-rename-retry');
  let r = build(fx, ['--target', 'linux-x64', '--out', out, '--node-archive', fx.archives['linux-x64']], { KODA_RUNTIME_TEST_RENAME_EPERM: '2' });
  assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.match(r.stdout, new RegExp(`^runtime linux-x64: Node ${NODE_VERSION} \\+ Pi 1\\.4\\.0 \\+ gentle-pi 4\\.3\\.0 \\+ engram 3\\.4\\.0 -> `));
  assert.ok(tree(out).includes('koda-runtime.json'), 'the runtime is complete after the retried rename');
  assert.deepEqual(fs.readdirSync(fx.dir).filter((n) => n.startsWith('out-rename-retry.partial-')), [], 'the partial took the output\'s place');
  const failed = path.join(fx.dir, 'out-rename-fail');
  r = build(fx, ['--target', 'linux-x64', '--out', failed, '--node-archive', fx.archives['linux-x64']], { KODA_RUNTIME_TEST_RENAME_EPERM: '99' });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /^build-runtime: EPERM: operation not permitted, rename '/, 'the build fails with the error it kept getting');
  assert.equal(fs.existsSync(failed), false, 'no half-installed output');
  assert.deepEqual(fs.readdirSync(fx.dir).filter((n) => n.startsWith('out-rename-fail.partial-')), [], 'no partial output left behind');
});

for (const target of ['linux-x64', 'darwin-arm64', 'win-x64']) {
  test(`${target}: the runtime folder holds only the pinned Node, its licence, Pi and a manifest`, () => {
    const out = path.join(fx.dir, `out-${target}`);
    const r = build(fx, ['--target', target, '--out', out, '--node-archive', fx.archives[target]]);
    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, new RegExp(`^runtime ${target}: Node ${NODE_VERSION} \\+ Pi 1\\.4\\.0 \\+ gentle-pi 4\\.3\\.0 \\+ engram 3\\.4\\.0 -> `));
    const exe = target === 'win-x64' ? 'node.exe' : 'node';
    const engramExe = engramExeFor(target);
    const expected = [`bin/${engramExe}`, exe, 'LICENSE.node', 'THIRD-PARTY-NOTICES.md', 'koda-runtime.json',
      'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', 'node_modules/@earendil-works/pi-coding-agent/package.json',
      'node_modules/gentle-pi/bin/gentle-shell.mjs', 'node_modules/gentle-pi/package.json'];
    if (target !== 'win-x64') expected.push('pi', 'gentle-shell');
    assert.deepEqual(tree(out), expected.sort(), 'no npm, npx, corepack, .bin symlink or npm bookkeeping; the engram release\'s extra tools/ members never ship');
    assert.deepEqual(readJson(path.join(out, 'koda-runtime.json')),
      { target, node: NODE_VERSION, pi: '1.4.0', piCli: 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
        gentlePi: '4.3.0', gentleShell: 'node_modules/gentle-pi/bin/gentle-shell.mjs', engram: ENGRAM_VERSION, engramBin: `bin/${engramExe}` });
    assert.equal(fs.readFileSync(path.join(out, 'LICENSE.node'), 'utf8'), 'Node licence\n');
    if (!isWin) {
      assert.equal(fs.statSync(path.join(out, exe)).mode & 0o111, 0o111, 'node is executable');
      assert.equal(fs.statSync(path.join(out, 'bin', engramExe)).mode & 0o111, 0o111, 'engram is executable (0755)');
    }
  });
}

test(`${hostTarget} (this OS): --self-check runs the built Pi with the built Node and prints its version`, () => {
  const out = path.join(fx.dir, 'out-self');
  const r = build(fx, ['--target', hostTarget, '--out', out, '--node-archive', fx.archives[hostTarget], '--self-check']);
  assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
  assert.match(r.stdout, /, self-check ok\n$/);
  assert.equal(r.stderr, '');
});

test(`${hostTarget} (this OS): --self-check also runs the built gentle-shell offline and gets its get_state response (K2-05 T1)`, () => {
  const out = path.join(fx.dir, 'out-self-gentle');
  const r = build(fx, ['--target', hostTarget, '--out', out, '--node-archive', fx.archives[hostTarget], '--self-check']);
  assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
  assert.match(r.stdout, /, self-check ok\n$/);
  assert.equal(r.stderr, '');
});

test('a gentle-pi package whose bin/gentle-shell.mjs is missing fails closed: exit 1, exact message, no output (K2-05 T1)', () => {
  const f3 = fixture(['linux-x64'], { noGentleBin: true });
  const out = path.join(f3.dir, 'out');
  const r = build(f3, ['--target', 'linux-x64', '--out', out, '--node-archive', f3.archives['linux-x64']], { npm_config_cache: path.join(f3.dir, 'c') });
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'build-runtime: gentle-pi bin bin/gentle-shell.mjs is not a file inside the package\n');
  assert.equal(fs.existsSync(out), false);
});

test('the Pi launcher (Linux, macOS) uses the Node next to it, never the node on PATH (Windows: the daemon, T3)', () => {
  if (isWin) return; // Windows ships no launcher: the daemon starts node.exe + Pi's CLI JS, covered in desktop-daemon.
  const decoy = path.join(fx.dir, 'decoy');
  fs.mkdirSync(decoy);
  fs.writeFileSync(path.join(decoy, 'node'), '#!/bin/sh\necho decoy-node\n', { mode: 0o755 });
  const r = cp.spawnSync(path.join(fx.dir, `out-${hostTarget}`, 'pi'), ['--version'], {
    encoding: 'utf8', env: { PATH: `${decoy}:/usr/bin:/bin`, KODA_REPORT: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '1.4.0 node=bundled\n');
  // and the gentle-shell launcher (K2-05) has the same shape: THIS folder's node, never a node from PATH
  const g = cp.spawnSync(path.join(fx.dir, `out-${hostTarget}`, 'gentle-shell'), [], {
    encoding: 'utf8', input: '{"type":"get_state","id":"1"}\n', env: { PATH: `${decoy}:/usr/bin:/bin`, KODA_REPORT: '1' },
  });
  assert.equal(g.status, 0, g.stderr);
  assert.equal(g.stdout, '4.3.0 node=bundled\n');
});

test(`${hostTarget} (this OS): --archive packs the runtime folder into one tar.gz with its sha256, and it unpacks to the same tree`, () => {
  const out = path.join(fx.dir, 'out-archived');
  const archive = path.join(fx.dir, 'packed', `koda-runtime-${hostTarget}.tar.gz`);
  const r = build(fx, ['--target', hostTarget, '--out', out, '--node-archive', fx.archives[hostTarget], '--archive', archive]);
  assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], `archive ${archive} sha256 ${sha256(archive)} (${fs.statSync(archive).size} bytes)`);
  const listed = cp.spawnSync(isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.split(/\r?\n/).filter((m) => /(^|\/)\._/.test(m)), [], 'no macOS AppleDouble (._*) members in the runtime archive');
  const unpacked = path.join(fx.dir, 'unpacked');
  fs.mkdirSync(unpacked);
  const tar = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const x = cp.spawnSync(tar, ['-xzf', archive, '-C', unpacked], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
  assert.deepEqual(tree(unpacked), tree(out), 'the archive holds exactly the runtime folder, at its root');
  for (const f of tree(out)) assert.equal(sha256(path.join(unpacked, f)), sha256(path.join(out, f)), f);
  if (!isWin) assert.equal(fs.statSync(path.join(unpacked, 'node')).mode & 0o111, 0o111, 'node stays executable');
});

test('the runtime ships THIRD-PARTY-NOTICES.md: Node, then every package with its licence (a package without a licence file gets its declared author and the canonical text)', () => {
  const notices = fs.readFileSync(path.join(fx.dir, 'out-linux-x64', 'THIRD-PARTY-NOTICES.md'), 'utf8');
  assert.match(notices, /^# Third-party notices: Koda's bundled runtime\n/);
  assert.ok(notices.includes('Koda ships Node.js, Pi, Gentle Shell (gentle-pi) and Engram in this folder (K2-02, K2-05). Their licences and those of every package they include follow.\n'),
    'the header names everything the runtime bundles, including Gentle Shell (K2-05 T1 finding 6) and Engram (K2-05 T1b)');
  assert.ok(notices.includes(`## Node.js ${NODE_VERSION}\n\nLicense: MIT (with bundled components). Full text: \`LICENSE.node\` in this folder.\n`));
  assert.ok(notices.includes('## gentle-pi 4.3.0\n\nLicense: MIT\n'), 'gentle-pi ships with its licence in the notices (K2-05)');
  // RDD advisory 2: MIT keeps «the above copyright notice», so the text a package without its own file is shipped under
  // names the copyright holder that package declares, never the SPDX template placeholder.
  const mit = fs.readFileSync(path.join(path.dirname(BUILDER), 'licenses', 'MIT.txt'), 'utf8');
  const withHolder = mit.replace('Copyright (c) <year> <copyright holders>', 'Copyright (c) Mario Zechner').trimEnd();
  assert.ok(notices.includes('## @earendil-works/pi-coding-agent 1.4.0\n\nLicense: MIT\nAuthor (from package.json): Mario Zechner\nRepository: git+https://github.com/earendil-works/pi.git\n' +
    `The package ships no licence file; the MIT License text follows, with the copyright holder its package.json declares:\n\n\`\`\`text\n${withHolder}\n\`\`\`\n`));
  assert.doesNotMatch(notices, /<year>|<copyright holders>/, 'no template placeholder is shipped');
  assert.ok(mit.includes('Copyright (c) <year> <copyright holders>'), 'the pinned canonical file itself stays the verbatim SPDX text');
  // K2-05 T1b (S5): Engram ships as the prebuilt binary, which carries no licence file; its canonical MIT text (the
  // repository LICENSE at tag v3.4.0) is reproduced with the copyright holder that licence declares.
  assert.ok(notices.includes(`## Engram ${ENGRAM_VERSION}\n\nLicense: MIT\nRepository: https://github.com/Gentleman-Programming/engram\n`), 'engram has its own notice');
  const withEngram = mit.replace('Copyright (c) <year> <copyright holders>', 'Copyright (c) 2026 Alan Buscaglia').trimEnd();
  assert.ok(notices.includes(`The prebuilt engram binary ships no licence file; the MIT License text follows, with the copyright holder the repository's LICENSE (tag ${ENGRAM_VERSION}) declares:\n\n\`\`\`text\n${withEngram}\n\`\`\`\n`));
});

test('a package whose licence has no file in the package and no canonical text in licenses/ fails closed: exit 1, exact message, no output', () => {
  const f3 = fixture(['linux-x64'], { piLicense: 'WTFPL' });
  const out = path.join(f3.dir, 'out');
  const r = build(f3, ['--target', 'linux-x64', '--out', out, '--node-archive', f3.archives['linux-x64']], { npm_config_cache: path.join(f3.dir, 'c') });
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'build-runtime: @earendil-works/pi-coding-agent@1.4.0 is WTFPL, ships no licence file, and packaging/runtime/licenses/ has no WTFPL text: refusing to ship it without its licence\n');
  assert.equal(fs.existsSync(out), false);
});

test('the canonical licence texts are the official ones, byte for byte (Apache-2.0 from apache.org, MIT from the SPDX list)', () => {
  // Coverage of the real pinned tree is enforced by the build itself (it refuses a package with no file and no text);
  // the real build of every target is the evidence (odd-evidence/t4b-real-notices.txt).
  const dir = path.join(path.dirname(BUILDER), 'licenses');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Apache-2.0.txt', 'MIT.txt', 'README.md']);
  assert.equal(sha256(path.join(dir, 'Apache-2.0.txt')), 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
  assert.equal(sha256(path.join(dir, 'MIT.txt')), 'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5');
});

test('a Node archive whose sha256 differs from the pin fails closed and leaves the existing output untouched', () => {
  const out = path.join(fx.dir, 'out-keep');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'previous'), 'previous runtime');
  const bad = path.join(fx.dir, 'bad');
  fs.mkdirSync(bad);
  const tampered = path.join(bad, path.basename(fx.archives['linux-x64']));
  fs.writeFileSync(tampered, Buffer.concat([fs.readFileSync(fx.archives['linux-x64']), Buffer.from('x')]));
  const r = build(fx, ['--target', 'linux-x64', '--out', out, '--node-archive', tampered]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, new RegExp(`^build-runtime: Node archive SHA256 mismatch for node-v${NODE_VERSION}-linux-x64\\.tar\\.gz: expected [0-9a-f]{64}, got ${sha256(tampered)}\\n$`));
  assert.deepEqual(tree(out), ['previous']);
  assert.deepEqual(fs.readdirSync(fx.dir).filter((n) => n.includes('.partial-')), [], 'no partial output left behind');
});

test('an engram archive whose sha256 differs from the pin fails closed and leaves the existing output untouched (K2-05 T1b)', () => {
  const out = path.join(fx.dir, 'out-engram-keep');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'previous'), 'previous runtime');
  const bad = path.join(fx.dir, 'bad-engram');
  fs.mkdirSync(bad);
  const tampered = path.join(bad, path.basename(fx.engramArchives['linux-x64']));
  fs.writeFileSync(tampered, Buffer.concat([fs.readFileSync(fx.engramArchives['linux-x64']), Buffer.from('x')]));
  const pin = fs.readFileSync(path.join(fx.pins, 'engram.sha256'), 'utf8').trim().split(/\r?\n/)[0].split(/\s+/);
  const got = sha256(tampered);
  const r = build(fx, ['--target', 'linux-x64', '--out', out, '--node-archive', fx.archives['linux-x64'], '--engram-archive', tampered]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `build-runtime: Engram archive SHA256 mismatch for engram_3.4.0_linux_amd64.tar.gz: expected ${pin[0]}, got ${got}\n`);
  assert.deepEqual(tree(out), ['previous']);
  assert.deepEqual(fs.readdirSync(fx.dir).filter((n) => n.includes('.partial-')), [], 'no partial output left behind');
});

test('an engram archive with the wrong name for the target is refused (K2-05 T1b)', () => {
  const r = build(fx, ['--target', 'darwin-arm64', '--out', path.join(fx.dir, 'x2'), '--node-archive', fx.archives['darwin-arm64'], '--engram-archive', fx.engramArchives['linux-x64']]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'build-runtime: Engram archive must be engram_3.4.0_darwin_arm64.tar.gz, got engram_3.4.0_linux_amd64.tar.gz\n');
  assert.equal(fs.existsSync(path.join(fx.dir, 'x2')), false);
});

test('an engram archive without the binary member fails closed: exit 1, exact message, no output (K2-05 T1b)', () => {
  const f6 = fixture(['linux-x64'], { engramMode: 'no-member' });
  const out = path.join(f6.dir, 'out');
  const r = build(f6, ['--target', 'linux-x64', '--out', out, '--node-archive', f6.archives['linux-x64']]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  // The system tar's own exit code for "member not found": GNU tar (Linux) exits 2; bsdtar exits 1 (macOS tar,
  // Windows System32 tar.exe, which build-runtime calls by its full path, so its label is tar.exe). Exact per OS.
  const tarLabel = isWin ? 'tar\\.exe' : 'tar';
  const tarExit = process.platform === 'linux' ? 2 : 1;
  assert.match(r.stderr, new RegExp(`^build-runtime: Engram archive engram_3\\.4\\.0_linux_amd64\\.tar\\.gz lacks a regular file engram \\(extraction: ${tarLabel} -xf failed: exit ${tarExit}\\)\\n$`));
  assert.equal(fs.existsSync(out), false);
});

test('an engram whose binary member is a SYMLINK fails closed: never extracted, no symlink in the runtime (K2-05 T1b)', () => {
  if (isWin) return; // tar symlinks are crafted on Unix; the Windows zips in this suite carry real files
  const f6 = fixture(['linux-x64'], { engramMode: 'symlink-member' });
  const out = path.join(f6.dir, 'out');
  const r = build(f6, ['--target', 'linux-x64', '--out', out, '--node-archive', f6.archives['linux-x64']]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'build-runtime: Engram archive engram_3.4.0_linux_amd64.tar.gz lacks a regular file engram\n');
  assert.equal(fs.existsSync(path.join(out, 'bin', 'engram')), false, 'the symlink member was never extracted into bin/');
});

test('a malformed engram.sha256 line fails closed with the target named: exit 1, exact message, no output (K2-05 T1b)', () => {
  const f7 = fixture(['linux-x64'], { engramPin: 'malformed' });
  const out = path.join(f7.dir, 'out');
  const r = build(f7, ['--target', 'linux-x64', '--out', out, '--node-archive', f7.archives['linux-x64']]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'build-runtime: malformed engram.sha256 line for linux-x64\n');
  assert.equal(fs.existsSync(out), false);
});

test('engram.sha256 must pin exactly one asset per target: a duplicated entry is refused (K2-05 T1b)', () => {
  const f7 = fixture(['linux-x64'], { engramPin: 'duplicate' });
  const out = path.join(f7.dir, 'out');
  const r = build(f7, ['--target', 'linux-x64', '--out', out, '--node-archive', f7.archives['linux-x64']]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'build-runtime: engram.sha256 must pin exactly one archive for linux-x64, found 2\n');
  assert.equal(fs.existsSync(out), false);
});

test('a missing engram.sha256 fails closed before any download: Engram is always shipped (K2-05 T1b)', () => {
  const f7 = fixture(['linux-x64'], { engramPin: 'missing' });
  const out = path.join(f7.dir, 'out');
  const r = build(f7, ['--target', 'linux-x64', '--out', out, '--node-archive', f7.archives['linux-x64']]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '', 'no npm run, no network attempt');
  assert.equal(r.stderr, 'build-runtime: cannot read engram.sha256 next to this script (ENOENT)\n');
  assert.equal(fs.existsSync(out), false);
});

test(`${hostTarget} (this OS): --self-check runs the built engram version offline and requires ${ENGRAM_VERSION} (K2-05 T1b)`, () => {
  const out = path.join(fx.dir, 'out-self-engram');
  const r = build(fx, ['--target', hostTarget, '--out', out, '--node-archive', fx.archives[hostTarget], '--self-check']);
  assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
  assert.match(r.stdout, /, self-check ok\n$/);
  assert.equal(r.stderr, '');
});

test(`${hostTarget} (this OS): an engram that reports a WRONG version fails the self-check closed: exit 1, exact message, no output (K2-05 T1b)`, () => {
  const f8 = fixture([hostTarget], { engramMode: 'bad-version' });
  const out = path.join(f8.dir, 'out');
  const r = build(f8, ['--target', hostTarget, '--out', out, '--node-archive', f8.archives[hostTarget], '--self-check']);
  assert.equal(r.status, 1, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'build-runtime: self-check: built engram printed "engram 9.9.9", expected version 3.4.0\n');
  assert.equal(fs.existsSync(out), false);
});

test('a Pi tarball that does not match its lockfile integrity fails and leaves no output', () => {
  const f2 = fixture(['linux-x64']);
  const tgz = path.join(f2.dir, 'pi-1.4.0.tgz');
  fs.appendFileSync(tgz, Buffer.alloc(16));
  const out = path.join(f2.dir, 'out');
  const r = build(f2, ['--target', 'linux-x64', '--out', out, '--node-archive', f2.archives['linux-x64']], { npm_config_cache: path.join(f2.dir, 'c') });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /^build-runtime: npm ci failed: exit \d+\n/);
  assert.match(r.stderr, /EINTEGRITY/);
  assert.equal(fs.existsSync(out), false);
  assert.deepEqual(fs.readdirSync(f2.dir).filter((n) => n.includes('.partial-')), []);
});

test('an archive with the wrong name for the target is refused', () => {
  const r = build(fx, ['--target', 'darwin-arm64', '--out', path.join(fx.dir, 'x'), '--node-archive', fx.archives['linux-x64']]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `build-runtime: Node archive must be node-v${NODE_VERSION}-darwin-arm64.tar.gz, got node-v${NODE_VERSION}-linux-x64.tar.gz\n`);
  assert.equal(fs.existsSync(path.join(fx.dir, 'x')), false);
});

test('an unknown target or a missing --out is a usage error (exit 2) that builds nothing', () => {
  let r = build(fx, ['--target', 'linux-arm64', '--out', path.join(fx.dir, 'y')]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'build-runtime: unknown target linux-arm64; known: linux-x64, darwin-arm64, win-x64\n');
  r = build(fx, ['--target', 'linux-x64']);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'build-runtime: usage: build-runtime.cjs --target <target> --out <dir> (both are required)\n');
  assert.equal(fs.existsSync(path.join(fx.dir, 'y')), false);
});

test('--self-check for another OS is refused before anything is built', () => {
  const other = hostTarget === 'linux-x64' ? 'win-x64' : 'linux-x64';
  const out = path.join(fx.dir, 'out-other');
  const r = build(fx, ['--target', other, '--out', out, '--node-archive', fx.archives[other], '--self-check']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, new RegExp(`^build-runtime: --self-check runs only on ${other}; this is `));
  assert.equal(fs.existsSync(out), false);
});

test(`${hostTarget} (this OS): the gentle-shell self-check env is exactly what the build must set — the fake refuses to answer otherwise and reports what it saw (K2-05 T1)`, () => {
  const f4 = fixture([hostTarget], { gentleEnvAssert: true });
  const out = path.join(f4.dir, 'out-env');
  const r = build(f4, ['--target', hostTarget, '--out', out, '--node-archive', f4.archives[hostTarget], '--self-check']);
  assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
  assert.match(r.stdout, /, self-check ok\n$/);
  assert.equal(r.stderr, '');
  // the fake ran its env assertion (otherwise the report would not exist) and every value is exact:
  const report = envReport(out);
  assert.deepEqual(report, {
    ok: true, bad: [],
    env: {
      GENTLE_SHELL_NO_AUTO_SETUP: '1', GENTLE_PI_SKIP_GENTLE_AI_INSTALL: '1',
      PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_CODING_AGENT_DIR: null,
    },
  });
});

test(`${hostTarget} (this OS): a gentle-shell that answers get_state and then never exits fails the self-check within the bound: exit 1, exact message (K2-05 T1 finding 1)`, () => {
  const f4 = fixture([hostTarget], { gentleMode: 'answer-then-hang' });
  const out = path.join(f4.dir, 'out-hang');
  const r = build(f4, ['--target', hostTarget, '--out', out, '--node-archive', f4.archives[hostTarget], '--self-check'],
    { KODA_RUNTIME_SELF_CHECK_TIMEOUT_MS: '1500' }, 30_000);
  assert.equal(r.status, 1, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^build-runtime: self-check: built gentle-shell did not exit within 1\.5s after answering get_state \(stdout so far: /);
  assert.equal(fs.existsSync(out), false);
});

test(`${hostTarget} (this OS): a gentle-shell that never answers takes its whole process group down with it — the grandchild does not survive the self-check timeout (K2-05 T1 finding 2)`, () => {
  const f4 = fixture([hostTarget], { gentleMode: 'hang-with-grandchild' });
  const out = path.join(f4.dir, 'out-grandchild');
  try {
    const r = build(f4, ['--target', hostTarget, '--out', out, '--node-archive', f4.archives[hostTarget], '--self-check'],
      { KODA_RUNTIME_SELF_CHECK_TIMEOUT_MS: '1500' }, 30_000);
    // The fake reports its grandchild's pid as soon as it starts, in a file the fixture keeps whatever the build does.
    const grandchildPid = Number(fs.readFileSync(path.join(f4.dir, 'koda-grandchild-pid.txt'), 'utf8').trim());
    assert.ok(grandchildPid > 0, 'the fake reported its grandchild pid');
    let alive = false;
    try { process.kill(grandchildPid, 0); alive = true; } catch { /* dead: what the whole-tree kill promises */ }
    if (alive) { try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* gone */ } }
    assert.ok(!alive, `the gentle-shell grandchild (pid ${grandchildPid}) survived the self-check timeout`);
    assert.equal(r.status, 1, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /^build-runtime: self-check: built gentle-shell did not answer get_state within 1\.5s \(stdout so far: /);
    assert.equal(fs.existsSync(out), false);
  } finally {
    // RED-phase leak guard: a build killed at the spawnSync cap leaves its fake shell behind; GREEN never does.
    cp.spawnSync('pkill', ['-f', path.basename(f4.dir)], { stdio: 'ignore' });
    try { fs.rmSync(path.join(f4.dir, 'koda-grandchild-pid.txt'), { force: true }); } catch { /* best effort */ }
  }
});

test(`${hostTarget} (this OS): a gentle-shell that exits before answering fails closed: exit 1, exact message, no output (K2-05 T1)`, () => {
  const f4 = fixture([hostTarget], { gentleMode: 'exit-before-answer' });
  const out = path.join(f4.dir, 'out-early');
  const r = build(f4, ['--target', hostTarget, '--out', out, '--node-archive', f4.archives[hostTarget], '--self-check']);
  assert.equal(r.status, 1, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'build-runtime: self-check: built gentle-shell exited 3 before answering get_state (stdout: "noise before any answer\\n", stderr: "")\n');
  assert.equal(fs.existsSync(out), false);
});

test(`${hostTarget} (this OS): a gentle-shell that answers and then exits non-zero fails closed: exit 1, exact message (K2-05 T1)`, () => {
  const f4 = fixture([hostTarget], { gentleMode: 'answer-then-exit-nonzero' });
  const out = path.join(f4.dir, 'out-nonzero');
  const r = build(f4, ['--target', hostTarget, '--out', out, '--node-archive', f4.archives[hostTarget], '--self-check']);
  assert.equal(r.status, 1, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^build-runtime: self-check: built gentle-shell exited 7 after answering get_state \(stderr: /);
  assert.equal(fs.existsSync(out), false);
});

test('a gentle-pi bin that escapes the package (../outside.mjs) fails closed: exit 1, exact message, no output (K2-05 T1)', () => {
  const f4 = fixture(['linux-x64'], { gentleBin: '../outside.mjs' });
  const out = path.join(f4.dir, 'out');
  const r = build(f4, ['--target', 'linux-x64', '--out', out, '--node-archive', f4.archives['linux-x64']], { npm_config_cache: path.join(f4.dir, 'c') });
  assert.equal(r.status, 1, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, "build-runtime: gentle-pi bin ../outside.mjs is not a file inside the package\n");
  assert.equal(fs.existsSync(out), false);
});

test('a gentle-pi bin that is absolute (/etc/evil.mjs) fails closed: exit 1, exact message, no output (K2-05 T1)', () => {
  const f4 = fixture(['linux-x64'], { gentleBin: '/etc/evil.mjs' });
  const out = path.join(f4.dir, 'out');
  const r = build(f4, ['--target', 'linux-x64', '--out', out, '--node-archive', f4.archives['linux-x64']], { npm_config_cache: path.join(f4.dir, 'c') });
  assert.equal(r.status, 1, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'build-runtime: gentle-pi declares no relative "gentle-shell" bin\n');
  assert.equal(fs.existsSync(out), false);
});

test('a cross-target build refuses a native package whose os/cpu belong to the build host: exit 1, exact message, no output (K2-05 T1 finding 3, option C)', () => {
  // the other target has a DIFFERENT arch too, so both os and cpu mismatch and the message names both
  const other = hostTarget === 'darwin-arm64' ? 'linux-x64' : 'darwin-arm64';
  const f5 = fixture([hostTarget, other], { native: {} }); // fake-native declares the HOST's os/cpu
  assert.ok(f5.nativeEntry, 'the fixture ships the fake native package');
  const out = path.join(f5.dir, 'out-cross');
  const r = build(f5, ['--target', other, '--out', out, '--node-archive', f5.archives[other]], { npm_config_cache: path.join(f5.dir, 'c') });
  assert.equal(r.status, 1, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr,
    `build-runtime: fake-native@1.0.0 runs on os ["${f5.nativeEntry.os[0]}"], cpu ["${f5.nativeEntry.cpu[0]}"] — not on --target ${other} (${other}): cross-target builds ship only packages that run on the target\n`);
  assert.equal(fs.existsSync(out), false);
});

test(`a native package whose os/cpu match the --target still builds (the audit refuses only true mismatches, K2-05 T1 finding 3, option C)`, () => {
  const f5 = fixture([hostTarget], { native: {} });
  const out = path.join(f5.dir, 'out-match');
  const r = build(f5, ['--target', hostTarget, '--out', out, '--node-archive', f5.archives[hostTarget]], { npm_config_cache: path.join(f5.dir, 'c') });
  assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
  assert.ok(tree(out).includes('node_modules/fake-native/package.json'), 'the matching native package is shipped');
});

console.log(`runtime-build-check: ${passed} passed`);

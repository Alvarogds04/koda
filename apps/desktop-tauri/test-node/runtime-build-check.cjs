'use strict';
/* K2-02 T1 (S1, S2): packaging/runtime/build-runtime.cjs, run as a user would run it (a child process), fully offline:
   the script is copied next to fixture pins (a fake Node archive with its sha256, a fake Pi tarball pinned by sha512 in
   a lockfile), so no network and no real Node/Pi download is involved. The real pins are checked by
   runtime-pins-check.cjs and proven against the real downloads by the installer builds.
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
  const r = cp.spawnSync(tar, ['-czf', out, ...entries], { cwd, encoding: 'utf8' });
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

/* K2-13 T2c-2 (S9): fake BtbN LGPL ffmpeg archives for linux-x64 and win-x64 (none for darwin-arm64: out of scope). The
   binary carries an ffmpeg-like configure string, which is what build-runtime scans; the licence is the LGPL text's
   first line. The linux «.tar.xz» fixture is gzip inside: tar detects the compression from the bytes, never the name. */
const FFMPEG_TAG = 'autobuild-2026-11-11-12-39';
const FFMPEG_BASE = { 'linux-x64': 'ffmpeg-n9.0.2-49-gc179411bbb-linux64-lgpl-9.0', 'win-x64': 'ffmpeg-n9.0.2-49-gc179411bbb-win64-lgpl-9.0' };
const LGPL_HEAD = '                   GNU LESSER GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n';
function ffmpegArchive(dir, target, { config = '--prefix=/ffbuild/prefix --enable-version3 --disable-debug', license = LGPL_HEAD, name } = {}) {
  const base = FFMPEG_BASE[target];
  const bin = Buffer.from(`fake ffmpeg ${target}\0${config}\0`);
  if (target === 'win-x64') {
    const file = path.join(dir, name || `${base}.zip`);
    zipStored(file, [[`${base}/bin/ffmpeg.exe`, bin, 0o100755], [`${base}/bin/ffplay.exe`, Buffer.from('ffplay')], [`${base}/LICENSE.txt`, Buffer.from(license)]]);
    return file;
  }
  const root = path.join(dir, `ff-src-${target}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(path.join(root, base, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, base, 'bin', 'ffmpeg'), bin, { mode: 0o755 });
  fs.writeFileSync(path.join(root, base, 'bin', 'ffprobe'), 'ffprobe', { mode: 0o755 });
  fs.writeFileSync(path.join(root, base, 'LICENSE.txt'), license);
  const file = path.join(dir, name || `${base}.tar.xz`);
  tarGz(root, file, [base]);
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
  const ffmpeg = {};
  const ffDir = path.join(dir, 'ffmpeg');
  fs.mkdirSync(ffDir);
  for (const t of targets.filter((x) => FFMPEG_BASE[x])) ffmpeg[t] = ffmpegArchive(ffDir, t, opts.ffmpeg?.[t]);
  fs.writeFileSync(path.join(pins, 'ffmpeg.sha256'), `# fixture pins\n${Object.values(ffmpeg).map((f) => `${sha256(f)}  ${FFMPEG_TAG}/${path.basename(f)}\n`).join('')}`);
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
  fs.writeFileSync(path.join(pins, 'package.json'), JSON.stringify({ name: 'koda-runtime', private: true, dependencies: { '@earendil-works/pi-coding-agent': spec } }));
  fs.writeFileSync(path.join(pins, 'package-lock.json'), JSON.stringify({
    name: 'koda-runtime', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'koda-runtime', dependencies: { '@earendil-works/pi-coding-agent': spec } },
      'node_modules/@earendil-works/pi-coding-agent': { version: '1.4.0', resolved: spec, integrity, bin: { pi: 'dist/bundle/cli.js' } },
    },
  }));
  return { dir, pins, archives, ffmpeg };
}
function build(fx, args, env = {}) {
  // Offline: linux-x64 and win-x64 builds get their fixture ffmpeg archive unless the test passes its own.
  const target = args[args.indexOf('--target') + 1];
  if (args.includes('--target') && fx.ffmpeg[target] && !args.includes('--ffmpeg-archive')) args = [...args, '--ffmpeg-archive', fx.ffmpeg[target]];
  return cp.spawnSync(process.execPath, [path.join(fx.pins, 'build-runtime.cjs'), ...args], {
    encoding: 'utf8', env: { ...process.env, npm_config_offline: 'true', ...env }, timeout: 120_000,
  });
}
function tree(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix + e.name;
    if (e.isSymbolicLink()) return [`${rel} -> SYMLINK`];
    return e.isDirectory() ? tree(path.join(dir, e.name), `${rel}/`) : [rel];
  }).sort();
}

/* ---------- tests ---------- */
const fx = fixture();

for (const target of ['linux-x64', 'darwin-arm64', 'win-x64']) {
  test(`${target}: the runtime folder holds only the pinned Node, its licence, Pi and a manifest`, () => {
    const out = path.join(fx.dir, `out-${target}`);
    const r = build(fx, ['--target', target, '--out', out, '--node-archive', fx.archives[target]]);
    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    const ff = target === 'darwin-arm64' ? '' : ' \\+ ffmpeg n9\\.0\\.2-49-gc179411bbb';
    assert.match(r.stdout, new RegExp(`^runtime ${target}: Node ${NODE_VERSION} \\+ Pi 1\\.4\\.0${ff} -> `));
    const exe = target === 'win-x64' ? 'node.exe' : 'node';
    const expected = [exe, 'LICENSE.node', 'THIRD-PARTY-NOTICES.md', 'koda-runtime.json',
      'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', 'node_modules/@earendil-works/pi-coding-agent/package.json'];
    if (target !== 'win-x64') expected.push('pi');
    // K2-13 (S9): the pinned LGPL ffmpeg and its licence on linux-x64 and win-x64; nothing on darwin-arm64 (out of scope).
    if (target === 'linux-x64') expected.push('ffmpeg', 'LICENSE.ffmpeg.txt');
    if (target === 'win-x64') expected.push('ffmpeg.exe', 'LICENSE.ffmpeg.txt');
    assert.deepEqual(tree(out), expected.sort(), 'no npm, npx, corepack, .bin symlink, npm bookkeeping, ffprobe or ffplay');
    assert.deepEqual(readJson(path.join(out, 'koda-runtime.json')),
      { target, node: NODE_VERSION, pi: '1.4.0', piCli: 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
        ...(target === 'darwin-arm64' ? {} : { ffmpeg: 'n9.0.2-49-gc179411bbb' }) });
    assert.equal(fs.readFileSync(path.join(out, 'LICENSE.node'), 'utf8'), 'Node licence\n');
    if (!isWin) assert.equal(fs.statSync(path.join(out, exe)).mode & 0o111, 0o111, 'node is executable');
  });
}

test(`${hostTarget} (this OS): --self-check runs the built Pi with the built Node and prints its version`, () => {
  const out = path.join(fx.dir, 'out-self');
  const r = build(fx, ['--target', hostTarget, '--out', out, '--node-archive', fx.archives[hostTarget], '--self-check']);
  assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
  assert.match(r.stdout, /, self-check ok\n$/);
  assert.equal(r.stderr, '');
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
});

test(`${hostTarget} (this OS): --archive packs the runtime folder into one tar.gz with its sha256, and it unpacks to the same tree`, () => {
  const out = path.join(fx.dir, 'out-archived');
  const archive = path.join(fx.dir, 'packed', `koda-runtime-${hostTarget}.tar.gz`);
  const r = build(fx, ['--target', hostTarget, '--out', out, '--node-archive', fx.archives[hostTarget], '--archive', archive]);
  assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], `archive ${archive} sha256 ${sha256(archive)} (${fs.statSync(archive).size} bytes)`);
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
  assert.ok(notices.includes(`## Node.js ${NODE_VERSION}\n\nLicense: MIT (with bundled components). Full text: \`LICENSE.node\` in this folder.\n`));
  // RDD advisory 2: MIT keeps «the above copyright notice», so the text a package without its own file is shipped under
  // names the copyright holder that package declares, never the SPDX template placeholder.
  const mit = fs.readFileSync(path.join(path.dirname(BUILDER), 'licenses', 'MIT.txt'), 'utf8');
  const withHolder = mit.replace('Copyright (c) <year> <copyright holders>', 'Copyright (c) Mario Zechner').trimEnd();
  assert.ok(notices.includes('## @earendil-works/pi-coding-agent 1.4.0\n\nLicense: MIT\nAuthor (from package.json): Mario Zechner\nRepository: git+https://github.com/earendil-works/pi.git\n' +
    `The package ships no licence file; the MIT License text follows, with the copyright holder its package.json declares:\n\n\`\`\`text\n${withHolder}\n\`\`\`\n`));
  assert.doesNotMatch(notices, /<year>|<copyright holders>/, 'no template placeholder is shipped');
  assert.ok(mit.includes('Copyright (c) <year> <copyright holders>'), 'the pinned canonical file itself stays the verbatim SPDX text');
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

test('K2-13 (S9): ffmpeg comes out of the pinned archive byte for byte, executable, with its LGPL licence and notice', () => {
  for (const target of ['linux-x64', 'win-x64']) {
    const out = path.join(fx.dir, `out-${target}`);
    const exe = target === 'win-x64' ? 'ffmpeg.exe' : 'ffmpeg';
    assert.match(fs.readFileSync(path.join(out, exe), 'latin1'), /--enable-version3/);
    if (!isWin && target === 'linux-x64') assert.equal(fs.statSync(path.join(out, exe)).mode & 0o111, 0o111, 'ffmpeg is executable');
    assert.equal(fs.readFileSync(path.join(out, 'LICENSE.ffmpeg.txt'), 'utf8'), LGPL_HEAD);
    const notices = fs.readFileSync(path.join(out, 'THIRD-PARTY-NOTICES.md'), 'utf8');
    assert.ok(notices.includes(`## FFmpeg n9.0.2-49-gc179411bbb (\`${exe}\`)`), 'an FFmpeg section names the shipped binary');
    assert.match(notices, /License: LGPL-3\.0-or-later\. Full text: `LICENSE\.ffmpeg\.txt` in this folder\./);
    assert.match(notices, /built without --enable-gpl and without --enable-nonfree/);
    assert.ok(notices.includes(`https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_TAG}/${FFMPEG_BASE[target]}`), 'the exact upstream asset');
    // K2-13 (S9, item 5): the source is identified by its REVISION HASH; the version string is only a label, because a
    // describe tag is not an identity (`-g<abbrev>` can be ambiguous and carries no full commit id).
    assert.ok(notices.includes('https://github.com/FFmpeg/FFmpeg/tree/c179411bbb2864cc71323d3055acda25d5c2aace'), 'the exact FFmpeg source revision');
    assert.ok(notices.includes('the commit n9.0.2-49-gc179411bbb labels `c179411bbb`'), 'the describe string is labelled as a label');
    assert.ok(notices.includes('The version string is a label, never the identity of the source'), 'and the notice says so');
    assert.ok(notices.includes('https://github.com/BtbN/FFmpeg-Builds'), 'the build scripts');
    assert.match(notices, /Corresponding Source/);
    // K2-13 (S9, item 5): a DOWNLOADED binary owes GPL-3.0 §6(d) as incorporated by LGPL-3.0 (a designated place
    // recipients can obtain the Corresponding Source from, with clear directions next to the download), and an offer
    // on request (§6(b), the clause for a copy handed over in a physical product) is not sufficient on its own. Note
    // what the clauses are: LGPL-3.0 §6 is «Revised Versions» and combining a work with the Library is §4/§5, so
    // neither of them is the basis for a source duty.
    assert.match(notices, /GPL-3\.0 §6\(d\), incorporated by LGPL-3\.0 — the clause that applies to a downloadable installer/, 'the clause a download owes is named');
    assert.match(notices, /on its own, is NOT sufficient for a download/, 'an offer on request is not enough for a download');
    assert.match(notices, /does not mirror that Corresponding Source itself/, 'the missing mirror is still recorded');
    assert.match(notices, /three years after the release that shipped it/, 'the additional on-request offer lasts three years');
    assert.match(notices, /must exist and be linked from this notice and/, 'the designated place is required before a public release');
    assert.doesNotMatch(notices, /LGPL-3\.0 section 6/, 'never a citation of the LGPL-3.0 section that is about Revised Versions');
    assert.doesNotMatch(notices, /§6 is about combining|about combining a work with the Library/, 'and never the wrong claim that LGPL-3.0 §6 is about combining');
    assert.match(notices, /has NOT been done/, 'the notices never claim the legal review is done');
  }
  const darwin = fs.readFileSync(path.join(fx.dir, 'out-darwin-arm64', 'THIRD-PARTY-NOTICES.md'), 'utf8');
  assert.doesNotMatch(darwin, /FFmpeg/, 'darwin-arm64 ships no ffmpeg (pending for the Mac session)');
});

test('K2-13 (S9): a GPL or nonfree ffmpeg, a non-LGPL licence or a tampered archive fails closed with no output', () => {
  const cases = [
    [{ config: '--prefix=/ffbuild/prefix --enable-gpl --enable-version3' }, /ffmpeg .* was configured with --enable-gpl: only LGPL builds ship/],
    [{ config: '--prefix=/ffbuild/prefix --enable-nonfree' }, /ffmpeg .* was configured with --enable-nonfree: only LGPL builds ship/],
    [{ config: 'no configure string here' }, /ffmpeg .* carries no configure string: cannot prove it is an LGPL build/],
    [{ license: '                    GNU GENERAL PUBLIC LICENSE\n' }, /ffmpeg archive .* LICENSE\.txt is not the GNU LESSER GENERAL PUBLIC LICENSE/],
  ];
  for (const [opts, message] of cases) {
    const f = fixture(['linux-x64'], { ffmpeg: { 'linux-x64': opts } });
    const out = path.join(f.dir, 'out');
    const r = build(f, ['--target', 'linux-x64', '--out', out, '--node-archive', f.archives['linux-x64']], { npm_config_cache: path.join(f.dir, 'c') });
    assert.equal(r.status, 1, `${JSON.stringify(opts)}: ${r.stdout}`);
    assert.match(r.stderr, message);
    assert.equal(fs.existsSync(out), false);
  }
  const bad = path.join(fx.dir, 'bad-ff');
  fs.mkdirSync(bad);
  const tampered = path.join(bad, path.basename(fx.ffmpeg['win-x64']));
  fs.writeFileSync(tampered, Buffer.concat([fs.readFileSync(fx.ffmpeg['win-x64']), Buffer.from('x')]));
  const out = path.join(fx.dir, 'out-ff-tampered');
  const r = build(fx, ['--target', 'win-x64', '--out', out, '--node-archive', fx.archives['win-x64'], '--ffmpeg-archive', tampered]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^build-runtime: ffmpeg archive SHA256 mismatch for ffmpeg-n9\.0\.2-49-gc179411bbb-win64-lgpl-9\.0\.zip: expected [0-9a-f]{64}, got [0-9a-f]{64}\n$/);
  assert.equal(fs.existsSync(out), false);
  const wrong = build(fx, ['--target', 'linux-x64', '--out', out, '--node-archive', fx.archives['linux-x64'], '--ffmpeg-archive', fx.ffmpeg['win-x64']]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /ffmpeg archive must be ffmpeg-n9\.0\.2-49-gc179411bbb-linux64-lgpl-9\.0\.tar\.xz/);
  const mac = build(fx, ['--target', 'darwin-arm64', '--out', out, '--node-archive', fx.archives['darwin-arm64'], '--ffmpeg-archive', fx.ffmpeg['linux-x64']]);
  assert.equal(mac.status, 2);
  assert.match(mac.stderr, /darwin-arm64 ships no ffmpeg/);
});

test('K2-13 (S9): an ffmpeg pin that is not a BtbN LGPL asset is refused before anything is built', () => {
  const f = fixture(['linux-x64']);
  fs.writeFileSync(path.join(f.pins, 'ffmpeg.sha256'), `${'a'.repeat(64)}  ${FFMPEG_TAG}/ffmpeg-n9.0.2-49-gc179411bbb-linux64-gpl-9.0.tar.xz\n`);
  const out = path.join(f.dir, 'out');
  const r = build(f, ['--target', 'linux-x64', '--out', out, '--node-archive', f.archives['linux-x64'], '--ffmpeg-archive', f.ffmpeg['linux-x64']]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ffmpeg\.sha256 must pin exactly one BtbN LGPL archive for linux-x64/);
  assert.equal(fs.existsSync(out), false);
});

console.log(`runtime-build-check: ${passed} passed`);

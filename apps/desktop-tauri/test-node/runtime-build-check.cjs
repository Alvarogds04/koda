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
  return { dir, pins, archives };
}
function build(fx, args, env = {}) {
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
  assert.match(r.stdout, new RegExp(`^runtime linux-x64: Node ${NODE_VERSION} \\+ Pi 1\\.4\\.0 -> `));
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
    assert.match(r.stdout, new RegExp(`^runtime ${target}: Node ${NODE_VERSION} \\+ Pi 1\\.4\\.0 -> `));
    const exe = target === 'win-x64' ? 'node.exe' : 'node';
    const expected = [exe, 'LICENSE.node', 'THIRD-PARTY-NOTICES.md', 'koda-runtime.json',
      'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', 'node_modules/@earendil-works/pi-coding-agent/package.json'];
    if (target !== 'win-x64') expected.push('pi');
    assert.deepEqual(tree(out), expected.sort(), 'no npm, npx, corepack, .bin symlink or npm bookkeeping');
    assert.deepEqual(readJson(path.join(out, 'koda-runtime.json')),
      { target, node: NODE_VERSION, pi: '1.4.0', piCli: 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js' });
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

console.log(`runtime-build-check: ${passed} passed`);
